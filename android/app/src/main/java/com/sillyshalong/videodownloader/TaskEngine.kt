package com.sillyshalong.videodownloader

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.concurrent.thread

/** 单个下载任务（与桌面端 publicTask 字段对齐，前端零改动） */
class Task(
    val id: String,
    val url: String,
    val site: String,
    var status: String = "queued", // queued|running|done|error|paused|cancelled
    var percent: Double = 0.0,
    var stage: String = "排队中",
    var title: String? = null,
    var file: String? = null,
    var error: String? = null,
    var speed: Long? = null,
    var eta: Int? = null,
    var downloaded: Long? = null,
    var totalBytes: Long? = null,
    var sizeBytes: Long? = null,
    val quality: String? = null,
    val audio: Boolean = false,
    val log: MutableList<String> = mutableListOf(),
    var createdAt: Long = System.currentTimeMillis(),
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id); put("url", url); put("site", site); put("status", status)
        put("percent", percent); put("stage", stage)
        put("title", title ?: JSONObject.NULL); put("file", file ?: JSONObject.NULL)
        put("error", error ?: JSONObject.NULL)
        put("speed", speed ?: JSONObject.NULL); put("eta", eta ?: JSONObject.NULL)
        put("downloaded", downloaded ?: JSONObject.NULL); put("totalBytes", totalBytes ?: JSONObject.NULL)
        put("sizeBytes", sizeBytes ?: JSONObject.NULL)
        put("quality", quality ?: JSONObject.NULL); put("audio", audio)
        put("log", JSONArray(log)); put("createdAt", createdAt)
    }
}

/** SSE 客户端连接（事件入阻塞队列，由响应流消费；写失败标记摘除） */
class SseClient {
    val queue = java.util.concurrent.LinkedBlockingQueue<ByteArray>()
    @Volatile var failed = false
    fun send(data: String) {
        try {
            queue.put(data.toByteArray())
        } catch (_: Exception) {
            failed = true
        }
    }
}

/**
 * 任务引擎：队列 + 历史持久化 + SSE 广播（独立模式核心）。
 * 下载执行链：BiliEngine(WebView 页内取流) → HttpDownloader(OkHttp → 系统下载目录)。
 */
class TaskEngine(private val ctx: Context) {
    val tasks = LinkedHashMap<String, Task>()
    private val queue = ConcurrentLinkedQueue<String>()
    val sseClients = mutableListOf<SseClient>()
    private val historyFile = File(ctx.filesDir, "history.json")
    private val prefs = ctx.getSharedPreferences("config", Context.MODE_PRIVATE)
    @Volatile private var running = false
    @Volatile private var current: Task? = null
    @Volatile private var currentCancel: (() -> Unit)? = null

    init {
        // 启动回填历史
        try {
            if (historyFile.exists()) {
                val arr = JSONArray(historyFile.readText())
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    val t = Task(o.getString("id"), o.getString("url"), o.getString("site"))
                    t.status = "done"; t.percent = 100.0; t.stage = "完成"
                    t.title = if (o.isNull("title")) null else o.getString("title")
                    t.file = if (o.isNull("file")) null else o.getString("file")
                    t.sizeBytes = if (o.isNull("sizeBytes")) null else o.getLong("sizeBytes")
                    t.createdAt = o.getLong("createdAt")
                    tasks[t.id] = t
                }
            }
        } catch (_: Exception) {}
    }

    fun getConfig(): JSONObject = JSONObject().apply {
        put("proxy", "")
        put("bilibiliSessdata", prefs.getString("sessdata", "") ?: "")
        put("hlsSites", org.json.JSONArray(prefs.getString("hlsSites", "[]")))
    }

    fun saveConfig(key: String, value: String) {
        prefs.edit().putString(key, value).apply()
    }

    fun stats(): JSONObject {
        var bytes = 0L
        var count = 0
        try {
            if (historyFile.exists()) {
                val arr = JSONArray(historyFile.readText())
                count = arr.length()
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    if (!o.isNull("sizeBytes")) bytes += o.getLong("sizeBytes")
                }
            }
        } catch (_: Exception) {}
        return JSONObject().put("totalFiles", count).put("totalBytes", bytes)
    }

    fun parseInput(input: String): JSONObject {
        val found = Regex("https?://[^\\s'\"，。,；;<>（）()【】\\[\\]]+")
            .findAll(input).map { it.value.trimEnd('.', ',', '!', '?', '；', '：') }.distinct().toList()
        val urls = JSONArray()
        for (u in found) {
            urls.put(JSONObject().put("url", u).put("site", siteOf(u)))
        }
        return JSONObject().put("urls", urls)
    }

    /** 站点识别（独立模式：B站 / YouTube 全功能；hlsSites 域名走通用 HLS 引擎） */
    private fun siteOf(url: String): String {
        val u = try { java.net.URI(url) } catch (_: Exception) { return "generic" }
        val host = (u.host ?: "").lowercase()
        return when {
            host.endsWith("bilibili.com") || host.endsWith("b23.tv") -> "bilibili"
            host.endsWith("douyin.com") -> "douyin"
            host.endsWith("xiaohongshu.com") || host.endsWith("xhslink.com") -> "xiaohongshu"
            host.endsWith("youtube.com") || host.endsWith("youtu.be") -> "youtube"
            hlsSites().any { host == it || host.endsWith(".$it") } -> "hls"
            else -> "generic"
        }
    }

    /** config SharedPreferences 里的 hlsSites（JSON 数组字符串，与桌面 config.json 同义） */
    private fun hlsSites(): List<String> = try {
        val raw = prefs.getString("hlsSites", "[]") ?: "[]"
        val arr = org.json.JSONArray(raw)
        (0 until arr.length()).map { arr.getString(it) }
    } catch (_: Exception) { emptyList() }

    fun submit(input: String, quality: String?, audio: Boolean): List<Task> {
        val urls = parseInput(input).getJSONArray("urls")
        val created = mutableListOf<Task>()
        for (i in 0 until urls.length()) {
            val u = urls.getJSONObject(i).getString("url")
            val site = urls.getJSONObject(i).getString("site")
            // 独立模式支持：B站 / YouTube / hlsSites 域名（通用 HLS 引擎）。其余明确失败并指引走桌面端
            if (site != "bilibili" && site != "youtube" && site != "hls") {
                val t = Task(newId(), u, site, status = "error", error = "手机独立模式暂不支持该站点（抖音/小红书等需桌面端）；B站/YouTube 可直接下载")
                t.stage = ""
                tasks[t.id] = t; broadcast(t); created.add(t)
                continue
            }
            val t = Task(newId(), u, site, quality = quality, audio = audio)
            tasks[t.id] = t
            queue.add(t.id)
            broadcast(t)
            created.add(t)
        }
        pump()
        return created
    }

    fun retry(id: String): Boolean {
        val t = tasks[id] ?: return false
        if (t.status == "running" || t.status == "queued") return false
        t.status = "queued"; t.percent = 0.0; t.stage = "排队中"; t.error = null
        t.file = null; t.speed = null; t.eta = null; t.downloaded = null; t.totalBytes = null
        t.log.clear(); t.createdAt = System.currentTimeMillis()
        queue.add(id); broadcast(t); pump()
        return true
    }

    fun pauseOrCancel(id: String, intent: String): Boolean {
        val t = tasks[id] ?: return false
        if (t.status == "queued") {
            queue.remove(id)
            t.status = intent; t.stage = if (intent == "paused") "已暂停" else "已终止"
            broadcast(t); return true
        }
        if (t.status != "running" || current?.id != id) return false
        t.stage = if (intent == "paused") "已暂停" else "已终止"
        currentCancel?.invoke()
        return true
    }

    private fun pump() {
        if (running) return
        running = true
        thread(isDaemon = true, name = "task-pump") {
            while (true) {
                val id = queue.poll() ?: break
                val t = tasks[id] ?: continue
                if (t.status == "paused" || t.status == "cancelled") continue
                current = t
                t.status = "running"; t.stage = "解析中"; t.error = null
                broadcast(t)
                try {
                    runTask(t)
                    t.status = "done"; t.percent = 100.0; t.stage = "完成"
                    t.speed = null; t.eta = null
                    t.log.add("✔ ${t.file}")
                    appendHistory(t)
                    broadcast(t)
                } catch (e: Exception) {
                    val aborted = t.stage == "已暂停" || t.stage == "已终止"
                    if (!aborted) {
                        t.status = "error"
                        t.error = e.message?.take(300) ?: "下载失败"
                        t.log.add("✖ ${t.error}")
                        broadcast(t)
                    } else {
                        t.status = if (t.stage == "已暂停") "paused" else "cancelled"
                        broadcast(t)
                    }
                } finally {
                    current = null; currentCancel = null
                }
            }
            running = false
        }
    }

    private fun runTask(t: Task) {
        // 1) 解析：按站点分发到对应引擎（B站 / YouTube / 通用 HLS）
        t.stage = "解析中"; broadcast(t)

        // 通用 HLS：解析出 m3u8 后走专用分段下载（不走 downloadAndStore）
        if (t.site == "hls") {
            runHlsTask(t)
            return
        }

        val extraction = when (t.site) {
            "youtube" -> {
                val ex = YouTubeEngine.extract(t.url, t.quality, t.audio)
                // YouTube 视频模式返回两路流，包装成单规格语义
                if (ex.audioSpec != null) {
                    val audioSpec = ex.audioSpec!!
                    // 合并阶段的进度按 80%（下载两路）+ 20%（封装）折算
                    val mergedSpec = DownloadSpec(
                        title = audioSpec.title,
                        fileName = audioSpec.fileName.replace(Regex("\\.apart$"), ".mp4"),
                        urls = audioSpec.urls,
                        totalBytes = audioSpec.totalBytes,
                    )
                    return runYouTubeTwoStream(t, ex.videoSpec, audioSpec, mergedSpec)
                }
                ex.title to ex.videoSpec
            }
            else -> {
                val spec = BiliEngine.extract(ctx, t.url, prefs.getString("sessdata", "") ?: "", t.quality)
                spec.title to spec
            }
        }
        val (title, spec) = extraction
        t.title = title
        broadcast(t)
        downloadAndStore(t, spec, spec.fileName)
    }

    /** 通用 HLS 任务：WebView 过 CF 取 m3u8 → HlsDownloader 分段下载 → MediaStore */
    private fun runHlsTask(t: Task) {
        t.stage = "页面解析中（Cloudflare）"; broadcast(t)
        val r = HlsEngine.extract(ctx, t.url)
        t.title = r.title
        t.file = "Download/VideoDownloader/${r.title}.ts"
        broadcast(t)

        t.stage = "下载 HLS 分段"; broadcast(t)
        val out = File.createTempFile("hls-", ".ts", ctx.cacheDir)
        val cb = makeProgressCb(t)
        HlsDownloader.download(ctx, listOf(r.m3u8Url), r.referer, out, object : HlsDownloader.Progress {
            override fun onProgress(percent: Double, done: Int, total: Int, speed: Long, eta: Int) {
                t.percent = percent
                t.downloaded = done.toLong()
                t.totalBytes = total.toLong()
                t.speed = speed
                t.eta = eta
                broadcastThrottled(t)
            }
            override fun onCancelled() { throw InterruptedException("cancelled") }
            override fun registerCancel(fn: () -> Unit) { currentCancel = fn }
        })

        t.stage = "落盘"; broadcast(t)
        val saved = MediaStoreSaver.saveFromCache(ctx, out, "${r.title}.ts")
        out.delete()
        t.file = saved.displayPath
        t.sizeBytes = out.length().takeIf { it > 0 } ?: t.totalBytes
    }

    /** YouTube 双流：下载视频流 + 音频流 → MediaMuxer 封装 → MediaStore */
    private fun runYouTubeTwoStream(t: Task, videoSpec: DownloadSpec, audioSpec: DownloadSpec, finalSpec: DownloadSpec) {
        val cb = makeProgressCb(t)
        t.stage = "下载视频流"; broadcast(t)
        val vFile = HttpDownloader.downloadToCache(ctx, videoSpec, HttpDownloader.ProgressSpan(cb, 0.0, 0.6))
        try {
            t.stage = "下载音频流"; t.speed = null; broadcast(t)
            val aFile = HttpDownloader.downloadToCache(ctx, audioSpec, HttpDownloader.ProgressSpan(cb, 0.6, 0.2))
            try {
                t.stage = "封装 MP4"; t.speed = null; t.eta = null; broadcast(t)
                val name = finalSpec.fileName
                val outFile = File(ctx.cacheDir, name)
                Mp4Remuxer.mux(vFile, aFile, outFile)
                val saved = MediaStoreSaver.saveFromCache(ctx, outFile, name)
                outFile.delete()
                t.file = saved.displayPath
                t.sizeBytes = outFile.length()
            } finally {
                aFile.delete()
            }
        } finally {
            vFile.delete()
        }
    }

    /** 单流下载（B站 / YouTube 音频模式）：下载 → MediaStore */
    private fun downloadAndStore(t: Task, spec: DownloadSpec, displayFile: String) {
        t.stage = "下载中"; t.file = "Download/VideoDownloader/$displayFile"
        broadcast(t)
        val cb = makeProgressCb(t)
        val saved = HttpDownloader.download(ctx, spec, cb)
        t.file = saved.displayPath
        t.sizeBytes = saved.sizeBytes
    }

    /** 双流阶段的进度回调（总进度已在 ProgressSpan 内缩放） */
    private fun makeProgressCb(t: Task): HttpDownloader.Progress = object : HttpDownloader.Progress {
        override fun onProgress(percent: Double, downloaded: Long, total: Long, speed: Long, eta: Int) {
            t.percent = percent; t.downloaded = downloaded; t.totalBytes = total
            t.speed = speed; t.eta = eta
            broadcastThrottled(t)
        }
        override fun onCancelled() { throw InterruptedException("cancelled") }
        override fun registerCancel(fn: () -> Unit) { currentCancel = fn }
    }

    private var lastEmit = 0L
    @Synchronized private fun broadcastThrottled(t: Task) {
        val now = System.currentTimeMillis()
        if (now - lastEmit > 300) { lastEmit = now; broadcast(t) }
    }

    @Synchronized fun broadcast(t: Task) {
        val data = "data: ${JSONObject().put("type", "task").put("task", t.toJson())}\n\n"
        sseClients.removeAll { it.failed }
        sseClients.forEach { it.send(data) }
    }

    fun snapshot(): JSONArray {
        val arr = JSONArray()
        tasks.values.sortedByDescending { it.createdAt }.forEach { arr.put(it.toJson()) }
        return arr
    }

    private fun appendHistory(t: Task) {
        try {
            val arr = if (historyFile.exists()) JSONArray(historyFile.readText()) else JSONArray()
            for (i in (arr.length() - 1) downTo 0) if (arr.getJSONObject(i).getString("id") == t.id) arr.remove(i)
            arr.put(t.toJson())
            while (arr.length() > 500) arr.remove(0)
            historyFile.writeText(arr.toString())
        } catch (_: Exception) {}
    }

    private fun newId() = UUID.randomUUID().toString().replace("-", "").take(8)
}
