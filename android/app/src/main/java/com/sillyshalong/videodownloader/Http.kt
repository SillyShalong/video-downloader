package com.sillyshalong.videodownloader

import fi.iki.elonen.NanoHTTPD
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

/**
 * 所有引擎共用的 HTTP 客户端：统一 UA、超时、取消钩子、重试与代理设置。
 * 代理在设置面板里配置（http / https / socks5），对所有取流与下载请求生效。
 */
object Http {
    const val UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

    class HttpException(val code: Int) : IOException("HTTP $code")

    /** 面向用户的失败原因（文案会原样显示在任务详情里） */
    class ApiException(message: String, cause: Throwable? = null) : IOException(message, cause)

    /** 代理地址不合法 */
    class InvalidProxyException(message: String) : IOException(message)

    @Volatile private var proxy: Proxy? = null
    @Volatile private var auth: Pair<String, String>? = null
    @Volatile private var client: OkHttpClient = build(proxy, auth)

    /** 去掉首尾空白后的代理串；空串表示不使用代理 */
    fun normalizeProxy(spec: String): String = spec.trim()

    /**
     * 应用代理设置（传空串 = 直连）。之后发起的请求全部走新设置。
     * @throws InvalidProxyException 地址不合法（此时保持原设置不变）
     */
    fun setProxy(spec: String) {
        val parsed = parseProxy(spec)
        proxy = parsed?.first
        auth = parsed?.second
        client = build(proxy, auth)
    }

    /** 当前是否配置了代理 */
    fun hasProxy(): Boolean = proxy != null

    /** 解析 http(s)://[user:pass@]host:port 或 socks5(h)://host:port */
    fun parseProxy(spec: String): Pair<Proxy, Pair<String, String>?>? {
        val s = spec.trim()
        if (s.isEmpty()) return null
        val lower = s.lowercase()
        if (lower.startsWith("socks4")) throw InvalidProxyException("安卓版不支持 socks4 代理，请使用 socks5:// 或 http://")
        val m = Regex("^(https?|socks5h?)://(?:([^@/\\s:]+)(?::([^@/\\s]*))?@)?(\\[[0-9a-fA-F:.]+]|[\\w.\\-]+):(\\d{1,5})/?$")
            .find(s) ?: throw InvalidProxyException("代理地址无效，应形如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080")
        val port = m.groupValues[5].toIntOrNull()
        if (port == null || port !in 1..65535) throw InvalidProxyException("代理端口无效（1–65535）")
        val type = if (m.groupValues[1].startsWith("socks")) Proxy.Type.SOCKS else Proxy.Type.HTTP
        val user = m.groupValues[2]
        val creds = if (user.isNotEmpty()) user to m.groupValues[3] else null
        return Proxy(type, InetSocketAddress.createUnresolved(m.groupValues[4], port)) to creds
    }

    private fun build(proxy: Proxy?, auth: Pair<String, String>?): OkHttpClient {
        val b = OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .followRedirects(true)
            .followSslRedirects(true)
        if (proxy != null && proxy.type() != Proxy.Type.DIRECT) {
            // 显式代理：连不上就直接失败，不会悄悄改成直连
            b.proxy(proxy)
            val creds = auth
            if (creds != null && proxy.type() == Proxy.Type.HTTP) {
                val basic = okhttp3.Credentials.basic(creds.first, creds.second)
                b.proxyAuthenticator { _, _ -> Request.Builder().header("Proxy-Authorization", basic).build() }
            }
        }
        return b.build()
    }

    /** 设置面板的「测试」：用给定代理访问一次 YouTube，返回是否可用 */
    fun proxyTest(spec: String): JSONObject {
        val t0 = System.currentTimeMillis()
        val parsed = try {
            parseProxy(spec)
        } catch (e: InvalidProxyException) {
            throw ApiError(NanoHTTPD.Response.Status.BAD_REQUEST, e.message ?: "代理地址无效")
        }
        if (parsed == null) throw ApiError(NanoHTTPD.Response.Status.BAD_REQUEST, "代理地址无效")
        val c = build(parsed.first, parsed.second).newBuilder()
            .connectTimeout(6, TimeUnit.SECONDS)
            .readTimeout(6, TimeUnit.SECONDS)
            .callTimeout(10, TimeUnit.SECONDS)
            .build()
        val result = try {
            c.newCall(Request.Builder().url("https://www.youtube.com/generate_204").build()).execute().use { r ->
                r.body?.close()
                JSONObject().put("ok", r.code in 200..399).put("message", "HTTP ${r.code}")
            }
        } catch (e: SocketTimeoutException) {
            JSONObject().put("ok", false).put("message", "连接超时")
        } catch (e: IOException) {
            JSONObject().put("ok", false).put("message", "连接失败（${e.message ?: e.javaClass.simpleName}）")
        }
        return result.put("ms", System.currentTimeMillis() - t0)
    }

    /** 给 NewPipeExtractor 等第三方库用的同一个客户端（设置一致） */
    fun okHttpClient(): OkHttpClient = client

    /**
     * 发起请求。取消信号会挂上 call.cancel()（立即中断阻塞读）；调用方负责关闭响应体。
     * 非 2xx 响应抛 HttpException。
     */
    fun call(url: String, headers: Map<String, String> = emptyMap(), flag: CancelFlag? = null): Response {
        val rb = Request.Builder().url(url).header("User-Agent", UA)
        headers.forEach { (k, v) -> rb.header(k, v) }
        val call = client.newCall(rb.build())
        flag?.onCancel { call.cancel() }
        flag?.throwIfCancelled()
        val resp = try {
            call.execute()
        } catch (e: IOException) {
            flag?.throwIfCancelled()
            throw e
        }
        if (!resp.isSuccessful) {
            resp.close()
            throw HttpException(resp.code)
        }
        return resp
    }

    /** 取回完整响应体（小文件：播放列表、密钥、接口 JSON）。网络错误重试 [attempts] 次 */
    fun bytes(url: String, headers: Map<String, String> = emptyMap(), flag: CancelFlag? = null, attempts: Int = 2): ByteArray {
        var lastErr: IOException? = null
        repeat(attempts) { attempt ->
            flag?.throwIfCancelled()
            try {
                return call(url, headers, flag).use { it.body?.bytes() ?: ByteArray(0) }
            } catch (e: CancelledException) {
                throw e
            } catch (e: HttpException) {
                throw e // 服务器明确拒绝：重试没有意义
            } catch (e: IOException) {
                lastErr = e
                if (attempt < attempts - 1) try {
                    Thread.sleep(600L * (attempt + 1))
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                }
            }
        }
        throw lastErr ?: IOException("网络错误")
    }

    fun text(url: String, headers: Map<String, String> = emptyMap(), flag: CancelFlag? = null): String =
        String(bytes(url, headers, flag), Charsets.UTF_8)
}
