package com.sillyshalong.videodownloader

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 通用 HLS 引擎（独立模式）：Cloudflare 防护站点。
 * 与桌面端 missav 引擎同架构：无头 WebView 过 CF → 拦截播放器请求抓 m3u8 →
 * HlsDownloader 分段下载拼接。域名清单由 config（hlsSites）驱动，TaskEngine 路由。
 */
object HlsEngine {
    private val DESKTOP_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

    class Result(val title: String, val m3u8Url: String, val referer: String)

    private class CaptureState {
        var m3u8: String? = null
        var foundAt: Long = 0
        val startAt = System.currentTimeMillis()
    }

    /**
     * 隐藏 WebView 加载页面。m3u8 捕获双路：
     *   A) shouldInterceptRequest 拦截播放器发出的 m3u8 请求（最可靠）
     *   B) 轮询页面 JS：performance 资源 + video 元素 + script 文本
     * 拿到 m3u8 后再等 2s 提取标题收尾。阻塞至成功或超时。
     */
    fun extract(ctx: Context, url: String, timeoutSec: Long = 30): Result {
        val latch = CountDownLatch(1)
        val holder = arrayOfNulls<Any>(1)
        val main = Handler(Looper.getMainLooper())

        main.post {
            val web = createWebView(ctx)
            val state = CaptureState()

            web.webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest?,
                ): WebResourceResponse? {
                    val u = request?.url?.toString() ?: return null
                    synchronized(state) {
                        if (state.m3u8 == null && u.contains(".m3u8") && !u.contains("blob:")) {
                            state.m3u8 = u
                            state.foundAt = System.currentTimeMillis()
                        }
                    }
                    return null
                }
            }

            web.loadUrl(url)

            // 轮询：B 路 JS 扫描兜底 + 收尾（提取标题）
            var ticks = 0
            val maxTicks = (timeoutSec * 2).toInt()
            val timer = java.util.Timer()
            timer.scheduleAtFixedRate(object : java.util.TimerTask() {
                override fun run() {
                    main.post {
                        if (latch.count == 0L) { timer.cancel(); return@post }
                        ticks++
                        if (ticks > maxTicks) {
                            // 检测 Cloudflare Turnstile 挑战页（title / iframe src 特征）
                            web.evaluateJavascript(
                                "(function(){try{var t=(document.title||'')+location.href;" +
                                    "if(/just a moment|attention required|verifying/i.test(t))return 'TURNSTILE';" +
                                    "for(const f of document.querySelectorAll('iframe')){if((f.src||'').includes('challenges.cloudflare.com'))return 'TURNSTILE';}" +
                                    "return 'NONE';}catch(e){return 'NONE';}})()",
                            ) { res ->
                                val isCf = (res ?: "").contains("TURNSTILE")
                                holder[0] = RuntimeException(
                                    if (isCf) "被 Cloudflare 人机验证拦截：请用「远程模式」连接桌面端下载该链接（手机 WebView 指纹无法通过验证）"
                                    else "页面解析超时（可能被 Cloudflare 拦截或站点不支持）"
                                )
                                latch.countDown(); timer.cancel()
                            }
                            return@post
                        }
                        // B 路：页面 JS 扫描（在 A 路拦截未命中时兜底）
                        if (state.m3u8 == null && ticks % 4 == 0) {
                            web.evaluateJavascript(SCAN_JS) { res ->
                                val found = parseScanResult(res)
                                synchronized(state) {
                                    if (found != null && state.m3u8 == null) {
                                        state.m3u8 = found
                                        state.foundAt = System.currentTimeMillis()
                                    }
                                }
                            }
                        }
                        // 拿到 m3u8 且已给播放器 2s → 提取标题并收尾
                        synchronized(state) {
                            if (state.m3u8 != null && System.currentTimeMillis() - state.foundAt > 2000) {
                                val title = pageTitle(main, web)
                                holder[0] = Result(title.ifBlank { "hls_video" }, state.m3u8!!, url)
                                latch.countDown()
                                timer.cancel()
                            }
                        }
                    }
                }
            }, 2000, 500)

            // 超时后清理 WebView
            Thread {
                latch.await(timeoutSec + 10, TimeUnit.SECONDS)
                main.post {
                    try { web.stopLoading(); web.destroy() } catch (_: Exception) {}
                }
            }.start()
        }

        latch.await(timeoutSec + 15, TimeUnit.SECONDS)
        return when (val r = holder[0]) {
            is Result -> r
            is RuntimeException -> throw r
            else -> throw RuntimeException("HLS: 未能提取 m3u8（页面加载超时或站点不支持）")
        }
    }

    /** 页面标题（去站点后缀） */
    private fun pageTitle(main: Handler, web: WebView): String {
        val latch = CountDownLatch(1)
        var out = ""
        main.post {
            web.evaluateJavascript(TITLE_JS) { res ->
                out = res?.trim('"')?.replace("\\/", "/") ?: ""
                latch.countDown()
            }
        }
        latch.await(3, TimeUnit.SECONDS)
        return out
    }

    private fun parseScanResult(jsEscaped: String?): String? {
        if (jsEscaped == null || jsEscaped == "null") return null
        val s = jsEscaped.trim('"').replace("\\/", "/").replace("\\\\", "\\")
        return if (s.isNotBlank() && s != "null") s else null
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(ctx: Context): WebView {
        val web = WebView(ctx)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            userAgentString = DESKTOP_UA
            mediaPlaybackRequiresUserGesture = false
        }
        return web
    }

    private val SCAN_JS = """
        (function() {
          try {
            try {
              for (const r of performance.getEntriesByType('resource')) {
                if (r.name && r.name.includes('.m3u8') && !r.name.includes('blob:')) return r.name;
              }
            } catch (e) {}
            const v = document.querySelector('video');
            if (v && v.src && v.src.includes('.m3u8')) return v.src;
            for (const sc of document.querySelectorAll('script')) {
              const m = (sc.textContent || '').match(/https?:[^"'\s]+\.m3u8[^"'\s]*/);
              if (m) return m[0];
            }
            return null;
          } catch (e) { return null; }
        })()
    """.trimIndent()

    private val TITLE_JS = """
        (function() {
          try { return (document.title || '').replace(/\s*[|-]\s*(MissAV|ThisAV|JavHD).*$/i, '').trim(); }
          catch (e) { return document.title || ''; }
        })()
    """.trimIndent()
}
