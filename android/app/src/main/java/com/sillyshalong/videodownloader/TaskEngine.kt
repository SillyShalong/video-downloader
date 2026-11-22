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
    val createdAt: Long = System.currentTimeMillis(),
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

    /** 站点识别（独立模式仅 B站 全功能） */
    private fun siteOf(url: String): String {
        val u = try { java.net.URI(url) } catch (_: Exception) { return "generic" }
        val host = (u.host ?: "").lowercase()
        return when {
            host.endsWith("bilibili.com") || host.endsWith("b23.tv") -> "bilibili"
            host.endsWith("douyin.com") -> "douyin"
            host.endsWith("xiaohongshu.com") || host.endsWith("xhslink.com") -> "xiaohongshu"
            host.endsWith("youtube.com") || host.endsWith("youtu.be") -> "youtube"
            else -> "generic"
        }
    }

    fun submit(input: String, quality: String?, audio: Boolean): List<Task> {
        val urls = parseInput(input).getJSONArray("urls")
        val created = mutableListOf<Task>()
        for (i in 0 until urls.length()) {
            val u = urls.getJSONObject(i).getString("url")
            val site = urls.getJSONObject(i).getString("site")
            if (site != "bilibili") {
                // 独立模式暂不支持：直接失败并给明确指引
                val t = Task(newId(), u, site, status = "error", error = "手机独立模式暂不支持该站点（YouTube/抖音/小红书需桌面端）；B站可直接下载")
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
        // 1) 解析（WebView 页内取流，主线程创建）
        t.stage = "解析中"; broadcast(t)
        val info = BiliEngine.extract(ctx, t.url, prefs.getString("sessdata", "") ?: "", t.quality)
        t.title = info.title
        broadcast(t)
        // 2) 下载（OkHttp → 系统下载目录）
        t.stage = "下载中"; t.file = "Download/VideoDownloader/${info.fileName}"
        broadcast(t)
        HttpDownloader.download(ctx, info, object : HttpDownloader.Progress {
            override fun onProgress(percent: Double, downloaded: Long, total: Long, speed: Long, eta: Int) {
                t.percent = percent; t.downloaded = downloaded; t.totalBytes = total
                t.speed = speed; t.eta = eta
                broadcastThrottled(t)
            }
            override fun onCancelled() {
                // 让 runTask 以中止状态收尾
                throw InterruptedException("cancelled")
            }
            override fun registerCancel(fn: () -> Unit) { currentCancel = fn }
        })
        t.sizeBytes = t.totalBytes
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
