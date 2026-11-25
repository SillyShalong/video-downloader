package com.sillyshalong.videodownloader

import android.content.Context
import android.net.Uri
import android.util.Log
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoHTTPD.Response.Status
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.IOException

/** 接口错误：[status] 作为 HTTP 状态码，文案以 {error} 返回给前端 */
class ApiError(val status: NanoHTTPD.Response.IStatus, message: String) : IOException(message)

/**
 * 独立模式的本地服务（只监听 127.0.0.1:8977），与桌面端 src/server.mjs 是同一套 /api 协议，
 * 前端不做区分即可复用。界面（WebView）加载 http://127.0.0.1:8977 → 与 /api 同源。
 */
class LocalServer private constructor(private val app: Context) : NanoHTTPD("127.0.0.1", PORT) {

    companion object {
        const val PORT = 8977
        private const val TAG = "LocalServer"
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val MAX_BODY = 2L * 1024 * 1024
        /** 空闲 keep-alive 连接的读超时：到点后服务端主动关掉，不泄漏线程 */
        private const val IDLE_TIMEOUT_MS = 15_000

        @Volatile private var instance: LocalServer? = null

        @Volatile var engine: TaskEngine? = null

        /** 启动服务（重复调用安全），返回已启动的实例 */
        fun start(ctx: Context): LocalServer {
            instance?.let { return it }
            synchronized(this) {
                instance?.let { return it }
                var lastErr: IOException? = null
                repeat(5) {
                    try {
                        val s = LocalServer(ctx.applicationContext)
                        s.start(IDLE_TIMEOUT_MS, true)
                        instance = s
                        return s
                    } catch (e: IOException) {
                        // 端口偶尔还被上一个进程占着：稍等重试
                        lastErr = e
                        try {
                            Thread.sleep(400)
                        } catch (_: InterruptedException) {
                        }
                    }
                }
                throw lastErr ?: IOException("本地服务启动失败")
            }
        }
    }

    /**
     * 不做 GZIP 压缩。NanoHTTPD 默认会对文本类（text 开头）和 JSON 响应压缩（只要客户端声明接受，
     * 而 WebView 总是声明接受），但压缩器要攒够数据才输出——实时事件流（SSE）被包进去后事件全压在
     * 缓冲里，界面因此不刷新。本地回环通信也用不着压缩。
     */
    override fun useGzipWhenAccepted(response: Response?): Boolean = false

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri ?: "/"
        val method = session.method
        return try {
            // 关键：任何应答之前先把请求体读完。keep-alive 连接上，没读完的字节会被当成下一条请求解析（→ 400），
            // 这正是之前「点下载没反应」的根因之一。
            val body = readBody(session)
            when {
                method == Method.OPTIONS -> fixed(Status.NO_CONTENT, "text/plain", "")
                uri.startsWith("/api/") -> api(uri, method, body)
                method == Method.GET || method == Method.HEAD -> static(uri)
                else -> error(Status.NOT_FOUND, "not found")
            }
        } catch (e: ApiError) {
            error(e.status, e.message ?: "error")
        } catch (e: Exception) {
            Log.e(TAG, "请求处理失败: $method $uri", e)
            error(Status.INTERNAL_ERROR, e.message ?: e.javaClass.simpleName)
        }
    }

    /** 读完并解析请求体；没有请求体时返回空对象 */
    private fun readBody(session: IHTTPSession): JSONObject {
        val len = session.headers["content-length"]?.trim()?.toLongOrNull() ?: 0L
        if (len <= 0) return JSONObject()
        // 写操作只收 JSON：带 JSON 内容类型的请求浏览器一定会先发预检，别的网页跨站伪造不了
        val type = session.headers["content-type"] ?: ""
        if (!type.startsWith("application/json")) throw ApiError(Status.UNSUPPORTED_MEDIA_TYPE, "请求必须使用 application/json")
        if (len > MAX_BODY) throw ApiError(Status.PAYLOAD_TOO_LARGE, "请求体过大")
        val files = HashMap<String, String>()
        session.parseBody(files)
        val raw = files["postData"] ?: return JSONObject()
        return try {
            JSONObject(raw)
        } catch (e: JSONException) {
            throw ApiError(Status.BAD_REQUEST, "请求体不是合法的 JSON")
        }
    }

    private fun api(uri: String, method: Method, body: JSONObject): Response {
        val e = engine ?: return error(Status.SERVICE_UNAVAILABLE, "服务尚未就绪")
        val path = uri.substringBefore('?')
        val post = method == Method.POST
        return when {
            // ---- 只读 ----
            !post && path == "/api/tasks" -> ok(JSONObject().put("tasks", e.snapshot()))
            !post && path == "/api/events" -> events(e)
            !post && path == "/api/stats" -> ok(e.stats())
            !post && path == "/api/config" -> ok(e.config())
            !post && path == "/api/fs/list" ->
                // 安卓没有「电脑目录」可浏览：目录一律走系统文件夹选择器
                ok(JSONObject().put("path", JSONObject.NULL).put("parent", JSONObject.NULL).put("entries", JSONArray()).put("err", "请用「浏览…」打开系统文件夹选择器"))

            // ---- 写操作 ----
            post && path == "/api/config" -> ok(e.saveConfig(body))
            post && path == "/api/parse" -> ok(e.parse(body.nullableString("input") ?: ""))
            post && path == "/api/inspect" -> ok(e.inspect(body.nullableString("input") ?: ""))
            post && path == "/api/download" -> {
                val quality = body.nullableString("quality")
                if (!quality.isNullOrBlank() && !Regex("^\\d{3,4}$").matches(quality)) {
                    return error(Status.BAD_REQUEST, "无效的清晰度")
                }
                val items = body.optJSONArray("playlistItems")?.let { a -> (0 until a.length()).map { a.getInt(it) } }
                val tasks = e.submit(
                    body.nullableString("input") ?: "",
                    quality?.ifBlank { null },
                    body.optBoolean("audio", false),
                    body.nullableString("outDir"),
                    items,
                )
                ok(JSONObject().put("tasks", tasks))
            }
            post && path == "/api/retry" -> ok(e.retry(body.nullableString("id") ?: ""))
            post && path == "/api/pause" -> ok(e.pause(body.nullableString("id") ?: ""))
            post && path == "/api/cancel" -> ok(e.cancel(body.nullableString("id") ?: ""))
            post && path == "/api/history/delete" -> ok(e.delete(body.nullableString("id") ?: ""))
            post && path == "/api/open" -> ok(e.open(body.nullableString("path") ?: ""))
            post && path == "/api/reveal" -> ok(e.reveal(body.nullableString("path") ?: ""))
            post && path == "/api/proxy-test" -> ok(Http.proxyTest(body.nullableString("proxy") ?: ""))
            post && path == "/api/pick-dir" -> pickDir(e, body)

            else -> error(Status.NOT_FOUND, "not found")
        }
    }

    /** 弹出系统文件夹选择器并等用户选完（只阻塞这一条连接，不影响其他请求） */
    private fun pickDir(e: TaskEngine, body: JSONObject): Response {
        val host = MainActivity.current ?: app
        // 打开时停在当前保存目录（页面传来的 outDir：用户选的目录，没选过就是默认目录），
        // 而不是系统不让选的「下载」根目录
        val current = body.nullableString("outDir")?.takeIf { it.isNotBlank() }
        val picked: Uri? = DirPickerActivity.pick(host, Storage.pickerStartUri(app, current))
        val r = JSONObject().put("native", true)
        if (picked != null) {
            e.saveOutDir(picked)
            r.put("path", picked.toString()).put("label", Storage.label(app, picked))
        } else {
            r.put("path", JSONObject.NULL) // 用户取消
        }
        return ok(r)
    }

    /** 任务事件流（SSE）：长连接，内容边产生边写出 */
    private fun events(e: TaskEngine): Response {
        val resp = newChunkedResponse(Status.OK, "text/event-stream", e.openEventStream())
        resp.addHeader("Cache-Control", "no-cache")
        return resp
    }

    private fun static(uri: String): Response {
        var rel = uri.substringBefore('?').trimStart('/')
        if (rel.isEmpty()) rel = "index.html"
        if (rel.split('/').any { it == ".." }) return error(Status.FORBIDDEN, "forbidden")
        val bytes = try {
            app.assets.open("public/$rel").use { it.readBytes() }
        } catch (_: IOException) {
            null
        }
        if (bytes == null) {
            // 找不到的路径一律回首页（单页应用的前端路由）
            if (rel != "index.html") return static("/index.html")
            return error(Status.INTERNAL_ERROR, "前端资源缺失：请重新安装应用")
        }
        val mime = MIME[rel.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"
        val resp = newFixedLengthResponse(Status.OK, mime, ByteArrayInputStream(bytes), bytes.size.toLong())
        // 带内容哈希的构建产物可以长缓存；index.html 每次都校验，保证升级后立刻生效
        resp.addHeader(
            "Cache-Control",
            if (rel.startsWith("assets/")) "public, max-age=31536000, immutable" else "no-cache",
        )
        return resp
    }

    private val MIME = mapOf(
        "html" to "text/html; charset=utf-8",
        "js" to "text/javascript; charset=utf-8",
        "mjs" to "text/javascript; charset=utf-8",
        "css" to "text/css; charset=utf-8",
        "json" to "application/json; charset=utf-8",
        "svg" to "image/svg+xml",
        "png" to "image/png",
        "jpg" to "image/jpeg",
        "webp" to "image/webp",
        "ico" to "image/x-icon",
        "woff" to "font/woff",
        "woff2" to "font/woff2",
        "map" to "application/json",
        "txt" to "text/plain; charset=utf-8",
    )

    /* ---- 响应工具 ---- */

    private fun ok(o: JSONObject): Response = fixed(Status.OK, "application/json; charset=utf-8", o.toString())

    private fun error(status: Response.IStatus, message: String): Response =
        fixed(status, "application/json; charset=utf-8", JSONObject().put("error", message).toString())

    private fun fixed(status: Response.IStatus, mime: String, text: String): Response =
        newFixedLengthResponse(status, mime, text).apply {
            // 界面与 /api 同源，本不需要跨域；只放行自己的地址，挡掉其他网页的跨站调用
            addHeader("Access-Control-Allow-Origin", ORIGIN)
            addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            addHeader("Access-Control-Allow-Headers", "Content-Type")
            addHeader("Vary", "Origin")
        }
}
