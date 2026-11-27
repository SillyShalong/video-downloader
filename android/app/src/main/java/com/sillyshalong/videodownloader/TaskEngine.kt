package com.sillyshalong.videodownloader

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.content.FileProvider
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** 多视频源（播放列表 / 多 P）里的一集 */
class Episode(val url: String, val title: String, val duration: Long)

/** 单个下载任务（对外字段与桌面端 publicTask 对齐，前端零改动复用） */
class Task(
    val id: String,
    val url: String,
    val site: String,
    val quality: String? = null,
    val audio: Boolean = false,
    val playlistItems: List<Int>? = null,
    /** 用户所选目录的树 URI（content://…）；null = 默认下载目录 */
    val outDir: String? = null,
    var createdAt: Long = System.currentTimeMillis(),
) {
    var status = "queued" // queued|running|done|error|paused|cancelled
    var percent = 0.0
    var stage = "排队中"
    var title: String? = null
    var file: String? = null // 界面展示用路径
    var fileUri: String? = null // 已写入文件的 content:// URI
    var treeUri: String? = null // 所在目录的树 URI（仅用户所选目录）
    var error: String? = null
    var speed: Long? = null
    var eta: Long? = null
    var downloaded: Long? = null
    var totalBytes: Long? = null
    var sizeBytes: Long? = null
    val log = ArrayList<String>()
    /** 运行中用户点了暂停 / 终止 */
    var intent: String? = null

    /** 所有字段读写都在任务锁内进行（下载线程写、接口线程读） */
    @Synchronized
    fun update(block: Task.() -> Unit) = block()

    @Synchronized
    fun json(): JSONObject = JSONObject().apply {
        put("id", id)
        put("url", url)
        put("site", site)
        put("status", status)
        put("percent", percent)
        put("stage", stage)
        put("title", title ?: JSONObject.NULL)
        put("file", file ?: JSONObject.NULL)
        put("fileUri", fileUri ?: JSONObject.NULL)
        put("treeUri", treeUri ?: JSONObject.NULL)
        put("outDir", outDir ?: JSONObject.NULL)
        put("error", error ?: JSONObject.NULL)
        put("speed", speed ?: JSONObject.NULL)
        put("eta", eta ?: JSONObject.NULL)
        put("downloaded", downloaded ?: JSONObject.NULL)
        put("totalBytes", totalBytes ?: JSONObject.NULL)
        put("sizeBytes", sizeBytes ?: JSONObject.NULL)
        put("quality", quality ?: JSONObject.NULL)
        put("audio", audio)
        put("playlistItems", playlistItems?.let { JSONArray(it) } ?: JSONObject.NULL)
        put("log", JSONArray(log.takeLast(200)))
        put("createdAt", createdAt)
    }

    companion object {
        fun fromJson(o: JSONObject): Task = Task(
            id = o.getString("id"),
            url = o.getString("url"),
            site = o.optString("site", "generic"),
            quality = o.nullableString("quality"),
            audio = o.optBoolean("audio", false),
            playlistItems = o.optJSONArray("playlistItems")?.let { a -> (0 until a.length()).map { a.getInt(it) } },
            outDir = o.nullableString("outDir"),
            createdAt = o.optLong("createdAt", System.currentTimeMillis()),
        ).apply {
            status = o.optString("status", "done")
            percent = o.optDouble("percent", 0.0)
            stage = o.optString("stage", "")
            title = o.nullableString("title")
            file = o.nullableString("file")
            fileUri = o.nullableString("fileUri")
            treeUri = o.nullableString("treeUri")
            error = o.nullableString("error")
            sizeBytes = if (o.isNull("sizeBytes")) null else o.optLong("sizeBytes")
            o.optJSONArray("log")?.let { a -> for (i in 0 until a.length()) log.add(a.optString(i)) }
        }
    }
}

/**
 * 任务引擎：队列 + 各站点取流 + 落盘 + 历史持久化 + SSE 广播。
 *
 * 同时跑多个任务（上限见 [maxParallel]，默认 3 个）：每个工作线程从队列里领一个任务各下各的，互不阻塞。
 * 任务对象里的字段只在它自己的锁内读写，所以多条任务并行是安全的。
 */
class TaskEngine(ctx: Context) {
    private val app = ctx.applicationContext
    private val prefs = app.getSharedPreferences("config", Context.MODE_PRIVATE)
    private val stateFile = File(app.filesDir, "history.json")
    private val tasks = ConcurrentHashMap<String, Task>()
    private val queue = LinkedBlockingQueue<String>()
    private val clients = ConcurrentLinkedQueue<Client>()
    private val lock = Any()

    /** 正在下载的任务 → 它的取消开关（暂停 / 终止时用） */
    private val running = ConcurrentHashMap<String, CancelFlag>()

    /** 活着的工作线程数（只在 [lock] 内读写） */
    private var liveWorkers = 0

    /** SSE 客户端：每人一个有界队列，写不进去（对端假死）就丢弃该连接 */
    private class Client(val queue: LinkedBlockingQueue<ByteArray>) {
        @Volatile var dead = false

        fun offer(data: String) {
            if (dead || !queue.offer(data.toByteArray())) {
                dead = true
                queue.clear()
            }
        }
    }

    init {
        // 启动回填：上次的历史，以及被应用重启打断的任务
        try {
            if (stateFile.exists()) {
                val arr = JSONArray(stateFile.readText())
                for (i in 0 until arr.length()) {
                    val t = Task.fromJson(arr.getJSONObject(i))
                    if (t.status == "running" || t.status == "queued") {
                        t.update {
                            status = "paused"
                            stage = "已暂停"
                            percent = 0.0
                            speed = null
                            eta = null
                            log.add("⏸ 应用重启导致下载中断，点「恢复」重新下载")
                        }
                    }
                    tasks[t.id] = t
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "读取历史失败", e)
        }
        cleanOrphanParts()
    }

    /**
     * 清掉没人认领的缓存：失败 / 暂停的任务会留着已下载的部分等着续传，任务一旦被删掉、
     * 或者从历史里被挤出去，这些缓存就再也不会被用到。
     */
    private fun cleanOrphanParts() {
        val keep = HashSet<String>()
        for (t in tasks.values) synchronized(t) {
            if (t.status == "paused" || t.status == "error" || t.status == "queued") keep.add(t.id)
        }
        val root = File(app.cacheDir, "parts")
        root.listFiles()?.forEach { if (it.isDirectory && it.name !in keep) it.deleteRecursively() }
    }

    /* ================= 配置 ================= */

    fun config(): JSONObject = JSONObject().apply {
        put("proxy", proxy())
        put("bilibiliSessdata", sessdata())
        put("hlsSites", JSONArray(hlsSites()))
        put("platform", "android")
        put("maxParallel", maxParallel())
        put("outDir", prefs.getString(KEY_OUTDIR, null) ?: JSONObject.NULL)
        put(
            "outDirLabel",
            prefs.getString(KEY_OUTDIR, null)?.let { Storage.label(app, Uri.parse(it)) } ?: JSONObject.NULL,
        )
    }

    fun saveConfig(body: JSONObject): JSONObject {
        if (body.has("maxParallel")) {
            prefs.edit().putInt(KEY_PARALLEL, body.optInt("maxParallel", DEFAULT_PARALLEL).coerceIn(1, MAX_PARALLEL)).apply()
            kick() // 调大了就可以多领任务
        }
        if (body.has("proxy")) {
            val v = (body.nullableString("proxy") ?: "").trim()
            try {
                Http.setProxy(v)
            } catch (e: Http.InvalidProxyException) {
                throw ApiError(NanoHTTPD.Response.Status.BAD_REQUEST, e.message ?: "代理地址无效")
            }
            prefs.edit().putString(KEY_PROXY, v).apply()
            HlsEngine.applyWebViewProxy(v) // 用来过人机验证的网页也要走同一个代理
        }
        if (body.has("bilibiliSessdata")) {
            val v = (body.nullableString("bilibiliSessdata") ?: "").trim()
            if (v.isNotEmpty() && !Regex("^[A-Za-z0-9%*,\\-_.]+$").matches(v)) {
                throw ApiError(NanoHTTPD.Response.Status.BAD_REQUEST, "SESSDATA 格式不正确（应为浏览器 Cookie 里的纯值，不含引号或 Cookie: 前缀）")
            }
            prefs.edit().putString(KEY_SESSDATA, v).apply()
        }
        if (body.has("hlsSites")) {
            val arr = body.optJSONArray("hlsSites")
            val input: List<String> = arr?.let { a -> (0 until a.length()).map { a.optString(it) } }
                ?: (body.nullableString("hlsSites") ?: "").split(Regex("[\\n,;]+"))
            prefs.edit().putString(KEY_HLS, JSONArray(normalizeHlsSites(input)).toString()).apply()
        }
        return JSONObject().put("ok", true)
            .put("proxy", proxy())
            .put("bilibiliSessdata", sessdata())
            .put("hlsSites", JSONArray(hlsSites()))
            .put("maxParallel", maxParallel())
    }

    fun saveOutDir(tree: Uri) {
        prefs.edit().putString(KEY_OUTDIR, tree.toString()).apply()
    }

    private fun proxy(): String = prefs.getString(KEY_PROXY, "") ?: ""

    private fun sessdata(): String = prefs.getString(KEY_SESSDATA, "") ?: ""

    /** 同时下载的任务数 */
    private fun maxParallel(): Int = prefs.getInt(KEY_PARALLEL, DEFAULT_PARALLEL).coerceIn(1, MAX_PARALLEL)

    private fun hlsSites(): List<String> = try {
        val arr = JSONArray(prefs.getString(KEY_HLS, "[]") ?: "[]")
        (0 until arr.length()).map { arr.getString(it) }
    } catch (_: Exception) {
        emptyList()
    }

    /* ================= 解析 / 提交 ================= */

    fun parse(input: String): JSONObject {
        val sites = hlsSites()
        val urls = Urls.extract(input).distinct()
        return JSONObject().put(
            "urls",
            JSONArray().apply { for (u in urls) put(JSONObject().put("url", u).put("site", Sites.of(u, sites))) },
        )
    }

    /** 探测输入是否为多视频源（播放列表 / 多 P），是则返回选集列表 */
    fun inspect(input: String): JSONObject {
        val url = Urls.extract(input).firstOrNull() ?: throw ApiError(NanoHTTPD.Response.Status.BAD_REQUEST, "未在输入中找到链接")
        return try {
            val episodes = episodesOf(url, CancelFlag()) ?: emptyList()
            if (episodes.size > 1) {
                JSONObject().put("multi", true).put(
                    "entries",
                    JSONArray().apply {
                        episodes.forEachIndexed { i, e ->
                            put(
                                JSONObject().put("index", i + 1).put("id", (i + 1).toString()).put("title", e.title)
                                    .put("duration", e.duration.takeIf { it > 0 } ?: JSONObject.NULL),
                            )
                        }
                    },
                )
            } else {
                JSONObject().put("multi", false).put("entries", JSONArray())
            }
        } catch (e: Exception) {
            // 探测失败不阻塞下载：按单视频直接提交
            JSONObject().put("multi", false).put("entries", JSONArray()).put("error", friendly(e))
        }
    }

    /** 是播放列表 / 多 P 时返回全部选集，否则 null */
    private fun episodesOf(url: String, flag: CancelFlag): List<Episode>? {
        val site = Sites.of(url, hlsSites())
        return when (site) {
            Sites.BILIBILI -> {
                val info = BiliEngine.probe(app, url, sessdata(), flag)
                if (info.pages.size > 1 && Urls.queryParam(info.pageUrl, "p") == null) {
                    info.pages.map { Episode("https://www.bilibili.com/video/${info.bvid}?p=${it.index}", "P${it.index} ${it.title}", it.duration) }
                } else null
            }
            Sites.YOUTUBE -> YouTubeEngine.probe(url, flag)
            else -> null
        }
    }

    fun submit(input: String, quality: String?, audio: Boolean, outDir: String?, playlistItems: List<Int>?): JSONArray {
        val sites = hlsSites()
        val urls = Urls.extract(input).distinct().take(10)
        if (urls.isEmpty()) throw ApiError(NanoHTTPD.Response.Status.BAD_REQUEST, "未在输入中找到链接")
        val created = ArrayList<Task>()
        for (url in urls) {
            val site = Sites.of(url, sites)
            if (!Sites.SUPPORTED.contains(site)) {
                // 明确失败并说明原因，不要静默忽略
                val t = Task(newId(), url, site, quality, audio, playlistItems, outDir)
                t.update {
                    status = "error"
                    stage = ""
                    error = Sites.unsupportedMessage(site)
                    log.add("✖ $error")
                }
                tasks[t.id] = t
                created.add(t)
                continue
            }
            // 播放列表 / 多 P：展开成每集一个任务（探测失败则按单视频处理）
            val episodes = try {
                episodesOf(url, CancelFlag())
            } catch (_: Exception) {
                null
            }
            if (episodes != null && episodes.size > 1) {
                val picked = episodes.filterIndexed { i, _ -> playlistItems == null || playlistItems.contains(i + 1) }.take(MAX_EPISODES)
                for (e in picked) created.add(enqueue(e.url, site, quality, audio, outDir, e.title))
            } else {
                created.add(enqueue(url, site, quality, audio, outDir, null))
            }
        }
        for (t in created) emit(t)
        persist()
        kick()
        return JSONArray().apply { for (t in created) put(t.json()) }
    }

    private fun enqueue(url: String, site: String, quality: String?, audio: Boolean, outDir: String?, title: String?): Task {
        val t = Task(newId(), url, site, quality, audio, null, outDir)
        t.title = title
        tasks[t.id] = t
        queue.add(t.id)
        return t
    }

    /* ================= 任务操作 ================= */

    fun retry(id: String): JSONObject {
        val t = tasks[id] ?: throw ApiError(NanoHTTPD.Response.Status.NOT_FOUND, "任务不存在")
        synchronized(t) {
            if (t.status == "running" || t.status == "queued") throw ApiError(NanoHTTPD.Response.Status.BAD_REQUEST, "任务进行中，无法重试")
            // 失败的任务如果留着已下载的部分，这次是从断点接着下，而不是从头
            val resumed = t.status == "paused" || (t.status == "error" && hasPartialData(t))
            t.update {
                status = "queued"
                percent = 0.0
                stage = if (resumed) "继续中…" else "排队中"
                error = null
                file = null
                fileUri = null
                treeUri = null
                speed = null
                eta = null
                downloaded = null
                totalBytes = null
                sizeBytes = null
                createdAt = System.currentTimeMillis()
                intent = null
                log.clear()
                log.add(if (resumed) "↻ 从断点继续下载" else "↻ 重新下载")
            }
        }
        queue.add(id)
        emit(t)
        persist()
        kick()
        return JSONObject().put("ok", true).put("task", t.json())
    }

    fun pause(id: String): JSONObject = interrupt(id, "paused")

    fun cancel(id: String): JSONObject = interrupt(id, "cancelled")

    private fun interrupt(id: String, wanted: String): JSONObject {
        val t = tasks[id] ?: throw ApiError(NanoHTTPD.Response.Status.NOT_FOUND, "任务不存在")
        val verb = if (wanted == "paused") "暂停" else "终止"
        val flag: CancelFlag?
        synchronized(t) {
            when (t.status) {
                "queued" -> {
                    queue.remove(id)
                    t.status = wanted
                    t.stage = if (wanted == "paused") "已暂停" else "已终止"
                    flag = null
                }
                "running" -> {
                    val f = running[id] ?: throw ApiError(NanoHTTPD.Response.Status.BAD_REQUEST, "任务不在下载中，无法$verb")
                    t.intent = wanted
                    flag = f
                }
                else -> throw ApiError(NanoHTTPD.Response.Status.BAD_REQUEST, "任务不在下载中，无法$verb")
            }
        }
        flag?.cancel()
        emit(t)
        return JSONObject().put("ok", true)
    }

    fun delete(id: String): JSONObject {
        val t = tasks[id] ?: throw ApiError(NanoHTTPD.Response.Status.NOT_FOUND, "任务不存在")
        synchronized(t) {
            if (t.status == "running" || t.status == "queued") throw ApiError(NanoHTTPD.Response.Status.BAD_REQUEST, "任务进行中，请先终止")
        }
        tasks.remove(id)
        // 留着续传用的缓存也一并删掉
        runCatching { partDir(t).deleteRecursively() }
        persist()
        broadcast(JSONObject().put("type", "delete").put("id", id))
        return JSONObject().put("ok", true)
    }

    fun snapshot(): JSONArray = JSONArray().apply {
        tasks.values.sortedByDescending { it.createdAt }.forEach { put(it.json()) }
    }

    fun stats(): JSONObject {
        var bytes = 0L
        var count = 0
        for (t in tasks.values) synchronized(t) {
            if (t.status == "done") {
                count++
                bytes += t.sizeBytes ?: 0
            }
        }
        return JSONObject().put("totalFiles", count).put("totalBytes", bytes)
    }

    /** 用系统播放器打开已下载的文件（[path] 是任务里展示的 file 字段） */
    fun open(path: String): JSONObject {
        val t = tasks.values.firstOrNull { it.file == path && it.fileUri != null }
            ?: throw ApiError(NanoHTTPD.Response.Status.NOT_FOUND, "文件不存在（可能已被移动或删除）")
        var uri = Uri.parse(t.fileUri!!)
        if (uri.scheme == "file") {
            uri = FileProvider.getUriForFile(app, "${app.packageName}.fileprovider", File(uri.path!!))
        }
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, Storage.mimeFor(path))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            app.startActivity(intent)
        } catch (e: Exception) {
            throw ApiError(NanoHTTPD.Response.Status.INTERNAL_ERROR, "没有能打开这个文件的应用")
        }
        return JSONObject().put("ok", true)
    }

    /** 打开文件所在目录：默认目录 → 系统下载列表；用户所选目录 → 系统文件管理器定位 */
    fun reveal(path: String): JSONObject {
        val t = tasks.values.firstOrNull { it.file == path }
            ?: throw ApiError(NanoHTTPD.Response.Status.NOT_FOUND, "文件不存在")
        val tree = t.treeUri?.let { Uri.parse(it) }
        val intent = if (tree != null) {
            val doc = t.fileUri?.let { Uri.parse(it) } ?: throw ApiError(NanoHTTPD.Response.Status.NOT_FOUND, "文件不存在")
            Storage.revealIntent(app, tree, doc)
        } else {
            null
        } ?: Intent(DownloadManager.ACTION_VIEW_DOWNLOADS)
        try {
            app.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            // 系统文件管理器不认这个目录时，退回到下载列表
            runCatching { app.startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
        return JSONObject().put("ok", true)
    }

    /* ================= 事件流（SSE） ================= */

    fun openEventStream(): InputStream {
        val client = Client(LinkedBlockingQueue(4096))
        clients.add(client)
        client.offer("retry: 2000\n\n")
        client.offer("data: ${JSONObject().put("type", "init").put("tasks", snapshot())}\n\n")
        return object : InputStream() {
            private var buf = ByteArray(0)
            private var pos = 0
            @Volatile private var closed = false

            override fun read(): Int {
                val one = ByteArray(1)
                val n = read(one, 0, 1)
                return if (n <= 0) -1 else one[0].toInt() and 0xFF
            }

            // 必须实现批量读：InputStream 的默认实现会在取到第一个字节后继续逐字节等待后续数据，
            // 导致每条事件都要等到下一条到来（或 keepalive）才发得出去
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (len == 0) return 0
                while (pos >= buf.size) {
                    if (closed || client.dead) return -1
                    buf = try {
                        client.queue.poll(KEEPALIVE_SEC, TimeUnit.SECONDS)
                    } catch (_: InterruptedException) {
                        return -1
                    } ?: ": keepalive\n\n".toByteArray()
                    pos = 0
                }
                val n = minOf(len, buf.size - pos)
                System.arraycopy(buf, pos, b, off, n)
                pos += n
                return n
            }

            override fun available(): Int = buf.size - pos

            override fun close() {
                closed = true
                clients.remove(client)
            }
        }
    }

    private fun emit(t: Task) = broadcast(JSONObject().put("type", "task").put("task", t.json()))

    private val lastProgress = ConcurrentHashMap<String, Long>()

    /** 进度事件限频（每任务 300ms 一次），状态变化走不受限的 emit */
    internal fun emitProgress(t: Task) {
        val now = System.currentTimeMillis()
        val last = lastProgress[t.id] ?: 0L
        if (now - last < 300) return
        lastProgress[t.id] = now
        emit(t)
    }

    @Synchronized
    private fun broadcast(o: JSONObject) {
        if (clients.isEmpty()) return
        val data = "data: $o\n\n"
        clients.forEach { it.offer(data) }
        clients.removeAll { it.dead }
    }

    /* ================= 执行 ================= */

    /** 保证有足够的工作线程：最多 [maxParallel] 个，但也不为不存在的任务空转 */
    private fun kick() {
        synchronized(lock) {
            val wanted = minOf(maxParallel(), liveWorkers + queue.size)
            while (liveWorkers < wanted) {
                liveWorkers++
                thread(name = "task-worker", isDaemon = true) { workLoop() }
            }
        }
    }

    private fun workLoop() {
        while (true) {
            val id = queue.poll()
            if (id == null) {
                synchronized(lock) {
                    // 再次确认：取空和退出之间可能有新任务入队
                    if (queue.isEmpty()) {
                        liveWorkers--
                        return
                    }
                }
                continue
            }
            val t = tasks[id]
            // 入队之后被暂停 / 终止的任务还留在队列里，领到时跳过
            if (t == null || !synchronized(t) { t.status == "queued" }) continue
            runOne(t)
        }
    }

    private fun runOne(t: Task) {
        val flag = CancelFlag()
        running[t.id] = flag
        t.update {
            status = "running"
            stage = "解析中"
            error = null
            intent = null
            percent = 0.0
        }
        emit(t)
        try {
            runTask(t, flag)
            t.update {
                status = "done"
                percent = 100.0
                stage = "完成"
                speed = null
                eta = null
                downloaded = sizeBytes ?: downloaded
                file?.let { log.add("✔ $it") }
            }
        } catch (e: CancelledException) {
            val wanted = t.intent ?: "cancelled"
            t.update {
                status = wanted
                stage = if (wanted == "paused") "已暂停" else "已终止"
                speed = null
                eta = null
                log.add(if (wanted == "paused") "⏸ 已暂停" else "⏹ 已终止")
            }
            if (wanted == "cancelled") partDir(t).deleteRecursively()
        } catch (e: Exception) {
            Log.e(TAG, "任务失败 ${t.url}", e)
            fail(t, friendly(e))
        } catch (e: LinkageError) {
            // 系统组件在当前机型上缺失（如模拟器没有某类编解码器）
            fail(t, "当前系统缺少所需组件：${e.message}")
        } finally {
            lastProgress.remove(t.id)
            running.remove(t.id)
            persist()
            emit(t)
        }
    }

    /**
     * 任务失败。已下载的部分不删：点「重试」会从断点接着下
     * （以前失败就把缓存清掉，网络抖一下就得从头再来）。
     */
    private fun fail(t: Task, message: String) {
        val kept = hasPartialData(t)
        t.update {
            status = "error"
            stage = ""
            speed = null
            eta = null
            error = message
            log.add("✖ $message")
            if (kept) log.add("已下载的部分已保留，点「重试」会从这里继续")
        }
    }

    /** 缓存目录里有没有已下载的数据（可以接着下的那种） */
    private fun hasPartialData(t: Task): Boolean =
        runCatching { partDir(t).walkTopDown().any { it.isFile && it.length() > 0 } }.getOrDefault(false)

    private fun runTask(t: Task, flag: CancelFlag) {
        when (t.site) {
            Sites.BILIBILI -> runBili(t, flag)
            Sites.YOUTUBE -> runYouTube(t, flag)
            Sites.HLS -> runHls(t, flag)
            else -> throw Http.ApiException(Sites.unsupportedMessage(t.site))
        }
    }

    private fun runBili(t: Task, flag: CancelFlag) {
        val spec = BiliEngine.extract(app, t.url, sessdata(), t.quality, flag)
        setTitle(t, spec.title)
        // 播放地址过期（HTTP 403）时重新取一次，从断点接着下
        saveResumable(t, spec, flag) { BiliEngine.extract(app, t.url, sessdata(), t.quality, flag).also { setTitle(t, it.title) } }
    }

    private fun runYouTube(t: Task, flag: CancelFlag) = YouTubeFlow.run(this, t, flag)

    private fun runHls(t: Task, flag: CancelFlag) = HlsFlow.run(this, t, flag)

    /* ---- 供各站点流程复用的工具 ---- */

    /** 解析出标题后更新任务（任务行随即显示标题） */
    internal fun setTitle(t: Task, value: String) {
        t.update { title = value }
        emit(t)
    }

    /** 下载目录里新建目标文件 */
    internal fun openSink(t: Task, name: String, mime: String): StorageSink = Storage.open(app, t.outDir, name, mime)

    /**
     * 单文件、可续传地保存：先下到缓存（.part 断点续传 —— 暂停、失败、地址过期之后重试都从断点接着下），
     * 下完再原样存进保存目标。
     * 存储空间不够同时放两份（缓存 + 保存目标）时，退回到直接写进保存目标（这样就不能续传了）。
     * @param refresh 下载地址失效时重新取一个（返回新的 [DownloadSpec]）；null = 不重新取
     */
    internal fun saveResumable(t: Task, spec: DownloadSpec, flag: CancelFlag, refresh: (() -> DownloadSpec)? = null) {
        val dir = partDir(t)
        if (!dir.isDirectory && !dir.mkdirs()) throw Http.ApiException("无法创建缓存目录（存储空间不足？）")
        val roomForTwo = spec.totalBytes <= 0 || dir.usableSpace > spec.totalBytes * 2 + RESERVE_BYTES
        if (!roomForTwo) {
            log(t, "存储空间不够同时放缓存和目标文件，这个任务暂停后不能续传")
            saveDirect(t, spec, flag, 0.0, 1.0)
            return
        }
        val ext = spec.fileName.substringAfterLast('.', "")
        val cached = File(dir, if (ext.isEmpty()) "data" else "data.$ext")
        stage(t, "下载中")
        try {
            HttpDownloader.toFile(
                spec,
                cached,
                flag,
                progress(t, flag, 0.0, SAVE_TO),
                onResumed = { bytes -> log(t, "从断点继续（已有 ${bytes / 1048576} MB）") },
                onLog = { line -> log(t, line) },
                refresh = refresh,
            )
            stage(t, "保存中")
            saveCacheFile(t, cached, spec.fileName, spec.mime)
        } finally {
            cached.delete()
            dir.delete() // 只有空目录才删得掉；留着续传用的 .part 时会原样保留
        }
    }

    /** 单文件直存：网络流 → 保存目标 */
    internal fun saveDirect(t: Task, spec: DownloadSpec, flag: CancelFlag, from: Double, to: Double) {
        val sink = openSink(t, spec.fileName, spec.mime)
        var committed = false
        try {
            t.update { file = sink.displayPath; stage = "下载中" }
            emit(t)
            val size = HttpDownloader.write(spec, sink.outputStream, flag, progress(t, flag, from, to))
            sink.outputStream.flush()
            sink.commit()
            committed = true
            t.update {
                sizeBytes = size
                fileUri = sink.fileUri.toString()
                treeUri = sink.treeUri?.toString()
                file = sink.displayPath
                percent = to * 100
            }
        } finally {
            sink.close()
            if (!committed) sink.abort()
        }
    }

    /** 把缓存里的现成文件原样存进保存目标（网络流已经是可播放的格式，不需要再处理时用） */
    internal fun saveCacheFile(t: Task, source: File, name: String, mime: String) {
        val sink = openSink(t, name, mime)
        var committed = false
        try {
            t.update { file = sink.displayPath }
            source.inputStream().use { it.copyTo(sink.outputStream) }
            sink.outputStream.flush()
            sink.commit()
            committed = true
            markSaved(t, sink, source.length(), 100.0)
        } finally {
            sink.close()
            if (!committed) sink.abort()
        }
    }

    /** 文件已经完整写进保存目标。保存目录可能在发布时给文件改过名（重名时加 " (1)"），这里记的是最终的名字 */
    internal fun markSaved(t: Task, sink: StorageSink, size: Long, percent: Double) {
        t.update {
            sizeBytes = size
            fileUri = sink.fileUri.toString()
            treeUri = sink.treeUri?.toString()
            file = sink.displayPath
            this.percent = percent
        }
    }

    /** 把下载进度映射到任务的 [from, to] 区间 */
    internal fun progress(t: Task, flag: CancelFlag, from: Double, to: Double) = HttpDownloader.Progress { done, total, speed ->
        flag.throwIfCancelled()
        t.update {
            if (total > 0) {
                percent = (from + (to - from) * (done.toDouble() / total)).coerceIn(0.0, 1.0) * 100
                totalBytes = total
            }
            downloaded = done
            this.speed = if (speed > 0) speed else null
            eta = if (total > 0 && speed > 0) (total - done) / speed else null
        }
        emitProgress(t)
    }

    internal fun stage(t: Task, text: String) {
        t.update { stage = text; speed = null; eta = null }
        emit(t)
    }

    internal fun log(t: Task, line: String) {
        t.update { log.add(line); if (log.size > 200) log.removeAt(0) }
        emit(t)
    }

    /** YouTube / HLS 的中间文件目录（暂停时保留用于断点续传） */
    internal fun partDir(t: Task): File = File(File(app.cacheDir, "parts"), t.id)

    internal fun appContext(): Context = app

    /* ---- 错误文案 ---- */

    internal fun friendly(e: Throwable): String = when (e) {
        is Http.ApiException -> e.message ?: "下载失败"
        is Http.HttpException -> when (e.code) {
            403 -> "服务器拒绝了请求（HTTP 403）：链接可能已过期或需要登录，请重试"
            404 -> "资源不存在（HTTP 404）：可能已下架"
            in 500..599 -> "服务器出错（HTTP ${e.code}），请稍后重试"
            else -> "服务器返回 HTTP ${e.code}"
        }
        is StorageException -> e.message ?: "无法写入保存目录，请重新选择保存目录"
        is IOException -> "网络错误：${e.message ?: e.javaClass.simpleName}"
        else -> "${e.javaClass.simpleName}: ${e.message?.take(300) ?: ""}"
    }

    /* ---- 持久化 ---- */

    /** 全部任务落盘（最新的 500 条），重启后据此回填列表 */
    @Synchronized
    private fun persist() {
        try {
            val arr = JSONArray()
            tasks.values.sortedByDescending { it.createdAt }.take(MAX_RECORDS).forEach { arr.put(it.json()) }
            val tmp = File(stateFile.path + ".tmp")
            tmp.writeText(arr.toString())
            if (!tmp.renameTo(stateFile)) {
                stateFile.writeText(arr.toString())
                tmp.delete()
            }
        } catch (e: Exception) {
            Log.w(TAG, "保存历史失败", e)
        }
    }

    private fun newId(): String = UUID.randomUUID().toString().replace("-", "").take(8)

    companion object {
        private const val TAG = "TaskEngine"
        private const val KEY_SESSDATA = "sessdata"
        private const val KEY_PROXY = "proxy"
        private const val KEY_HLS = "hlsSites"
        private const val KEY_OUTDIR = "outDir"
        private const val KEY_PARALLEL = "maxParallel"
        private const val MAX_RECORDS = 500
        private const val MAX_EPISODES = 50
        private const val KEEPALIVE_SEC = 15L

        /** 同时下载的任务数：默认 3 个，设置里可调 */
        const val DEFAULT_PARALLEL = 3
        const val MAX_PARALLEL = 5

        /** 下载占任务的 97%，剩下 3% 留给「从缓存存进保存目标」这一步 */
        private const val SAVE_TO = 0.97

        /** 判断「放不放得下两份」时多留的余量 */
        private const val RESERVE_BYTES = 200L * 1024 * 1024

        /** 与桌面端 config.mjs 的 normalizeHlsSites 同规则：去 scheme / www / 路径，只留合法域名并去重 */
        fun normalizeHlsSites(input: List<String>): List<String> {
            val out = ArrayList<String>()
            for (raw in input) {
                var d = raw.trim().lowercase()
                if (d.isEmpty()) continue
                d = d.replace(Regex("^https?://"), "").replace(Regex("^www\\."), "").split(Regex("[/?#]"))[0]
                    .trim('.')
                if (Regex("^[a-z0-9-]+(\\.[a-z0-9-]+)+$").matches(d) && !out.contains(d)) out.add(d)
            }
            return out
        }
    }
}
