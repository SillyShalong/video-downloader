package com.sillyshalong.videodownloader

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

/**
 * 独立模式本地服务（127.0.0.1:8977）：与桌面端同协议。
 * 静态资源来自 assets/public（cap sync 拷入的 web/dist），API 走 TaskEngine。
 * WebView 加载 http://127.0.0.1:8977 → 同源 → 前端零改动。
 */
class LocalServer private constructor(port: Int, private val ctx: Context) : NanoHTTPD("127.0.0.1", port) {

    companion object {
        const val PORT = 8977
        lateinit var engine: TaskEngine
        private var instance: LocalServer? = null

        fun start(ctx: Context) {
            if (instance == null) {
                instance = LocalServer(PORT, ctx)
                instance?.start(SOCKET_READ_TIMEOUT, true)
            }
        }
    }

    private val mime = mapOf(
        "html" to "text/html; charset=utf-8",
        "js" to "text/javascript; charset=utf-8",
        "css" to "text/css; charset=utf-8",
        "svg" to "image/svg+xml",
        "png" to "image/png",
        "json" to "application/json",
        "woff2" to "font/woff2",
        "ico" to "image/x-icon",
    )

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri ?: "/"
        // CORS（远程浏览器访问场景也顺带支持）
        if (session.method == Method.OPTIONS) {
            return newFixedLengthResponse(Response.Status.NO_CONTENT, null, "").apply { cors() }
        }
        if (uri.startsWith("/api/")) return api(session, uri)
        return static(uri)
    }

    private fun Response.cors(): Response {
        addHeader("Access-Control-Allow-Origin", "*")
        addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        addHeader("Access-Control-Allow-Headers", "Content-Type")
        return this
    }

    private fun static(uri: String): Response {
        var path = uri.trimStart('/')
        if (path.isEmpty()) path = "index.html"
        val clean = path.split('?')[0].split("..").last()
        return try {
            val input = ctx.assets.open("public/$clean")
            val bytes = input.readBytes()
            input.close()
            val ext = clean.substringAfterLast('.', "")
            newFixedLengthResponse(Response.Status.OK, mime[ext] ?: "application/octet-stream", ByteArrayInputStream(bytes), bytes.size.toLong()).cors()
        } catch (_: Exception) {
            // SPA 回退
            val input = ctx.assets.open("public/index.html")
            val bytes = input.readBytes()
            input.close()
            newFixedLengthResponse(Response.Status.OK, mime["html"]!!, ByteArrayInputStream(bytes), bytes.size.toLong()).cors()
        }
    }

    private fun body(session: IHTTPSession): JSONObject {
        val map = HashMap<String, String>()
        session.parseBody(map)
        val raw = map["postData"] ?: return JSONObject()
        return if (raw.isBlank()) JSONObject() else JSONObject(raw)
    }

    private fun json(o: JSONObject): Response =
        newFixedLengthResponse(Response.Status.OK, "application/json; charset=utf-8", o.toString()).cors()

    private fun api(session: IHTTPSession, uri: String): Response {
        val e = engine
        return try {
            when {
                uri == "/api/parse" && session.method == Method.POST -> {
                    json(e.parseInput(body(session).optString("input", "")))
                }

                uri == "/api/download" && session.method == Method.POST -> {
                    val b = body(session)
                    val created = e.submit(
                        b.optString("input", ""),
                        if (b.isNull("quality")) null else b.optString("quality", null),
                        b.optBoolean("audio", false),
                    )
                    val arr = JSONArray()
                    created.forEach { arr.put(it.toJson()) }
                    json(JSONObject().put("tasks", arr))
                }

                uri == "/api/tasks" -> json(JSONObject().put("tasks", e.snapshot()))

                uri == "/api/events" -> sse()

                uri == "/api/retry" && session.method == Method.POST -> {
                    val id = body(session).optString("id", "")
                    if (!e.retry(id)) json(JSONObject().put("error", "任务不存在或进行中"))
                    else json(JSONObject().put("ok", true))
                }

                uri == "/api/pause" && session.method == Method.POST -> {
                    val id = body(session).optString("id", "")
                    if (!e.pauseOrCancel(id, "paused")) json(JSONObject().put("error", "任务不在下载中"))
                    else json(JSONObject().put("ok", true))
                }

                uri == "/api/cancel" && session.method == Method.POST -> {
                    val id = body(session).optString("id", "")
                    if (!e.pauseOrCancel(id, "cancelled")) json(JSONObject().put("error", "任务不在下载中"))
                    else json(JSONObject().put("ok", true))
                }

                uri == "/api/stats" -> json(e.stats())

                uri == "/api/config" && session.method == Method.GET -> json(e.getConfig())

                uri == "/api/config" && session.method == Method.POST -> {
                    val b = body(session)
                    if (b.has("bilibiliSessdata")) {
                        val v = b.optString("bilibiliSessdata", "")
                        if (v.isNotBlank() && !Regex("^[A-Za-z0-9%*,\\-_.]+$").matches(v)) {
                            return json(JSONObject().put("error", "SESSDATA 格式不正确"))
                        }
                        e.saveConfig("sessdata", v)
                    }
                    json(JSONObject().put("ok", true))
                }

                uri == "/api/open" && session.method == Method.POST -> {
                    val name = body(session).optString("path", "")
                    openFile(name)
                }

                uri == "/api/reveal" && session.method == Method.POST -> {
                    // 手机端：打开系统下载应用定位
                    ctx.startActivity(
                        Intent(android.app.DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                    json(JSONObject().put("ok", true))
                }

                uri == "/api/fs/list" -> json(
                    JSONObject().put("path", null).put("parent", null)
                        .put("entries", JSONArray())
                        .put("err", "手机独立模式不支持浏览电脑目录"),
                )

                uri == "/api/pick-dir" -> json(JSONObject().put("native", false))

                else -> newFixedLengthResponse(Response.Status.NOT_FOUND, "application/json", "{\"error\":\"not found\"}")
            }
        } catch (ex: Exception) {
            newFixedLengthResponse(
                Response.Status.INTERNAL_ERROR, "application/json",
                JSONObject().put("error", ex.message ?: "error").toString(),
            )
        }
    }

    /** 通过 MediaStore 按文件名定位并用系统播放器打开 */
    private fun openFile(displayPath: String): Response {
        val name = displayPath.split('/', '\\').lastOrNull() ?: return json(JSONObject().put("error", "路径无效"))
        val proj = arrayOf(MediaStore.Downloads._ID, MediaStore.Downloads.DISPLAY_NAME)
        ctx.contentResolver.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI, proj, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                if (c.getString(1) == name) {
                    val uri = Uri.withAppendedPath(MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0).toString())
                    ctx.startActivity(
                        Intent(Intent.ACTION_VIEW).setDataAndType(uri, "video/mp4")
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                    return json(JSONObject().put("ok", true))
                }
            }
        }
        return json(JSONObject().put("error", "文件不存在"))
    }

    /** SSE：任务事件流（每客户端一个阻塞队列，空闲 15s 发 keepalive 注释行） */
    private fun sse(): Response {
        val cl = SseClient()
        engine.sseClients.add(cl)
        cl.send("retry: 2000\n\n")
        cl.send("data: ${JSONObject().put("type", "init").put("tasks", engine.snapshot())}\n\n")

        val stream = object : java.io.InputStream() {
            private var buf: ByteArray? = null
            private var pos = 0
            override fun read(): Int {
                while (true) {
                    val b = buf
                    if (b != null && pos < b.size) return b[pos++].toInt() and 0xFF
                    buf = try {
                        cl.queue.poll(15, java.util.concurrent.TimeUnit.SECONDS)
                    } catch (_: InterruptedException) {
                        null
                    }
                    if (buf == null) return ':'.code // SSE 注释行 keepalive
                    pos = 0
                }
            }
        }
        val resp = newChunkedResponse(Response.Status.OK, "text/event-stream", stream)
        resp.addHeader("Cache-Control", "no-cache")
        return resp
    }
}
