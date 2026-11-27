package com.sillyshalong.videodownloader

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 通用 HLS 引擎的第一步：从网页里找到视频的播放列表（m3u8）地址。
 *
 * 做法（与电脑端的无头浏览器一致）：加载页面，拦下播放器发出的 m3u8 请求；同时扫描页面里写着的地址兜底。
 * 遇到 Cloudflare 这类人机验证时，把网页显示出来让用户自己点一下验证 —— 通过后页面会继续加载播放器，
 * 这里抓到地址就自动关掉窗口继续下载。所以这一步必须在应用界面可见时才能进行。
 */
object HlsEngine {
    class Result(
        val m3u8Url: String,
        /** 页面地址：下载播放列表 / 分段时要作为 Referer 带上 */
        val pageUrl: String,
        val title: String?,
        /** 下载时要带的请求头（Cookie、Referer 等） */
        val headers: Map<String, String>,
        /** 找到地址的过程中值得告诉用户的一两句话（比如页面上有几档清晰度、用了哪一档），写进任务日志 */
        val note: String? = null,
    )

    /** 不显示网页时最多等多久；超过且没遇到人机验证，就认为页面里找不到视频 */
    private const val HIDDEN_TIMEOUT_MS = 15_000L

    /** 显示给用户操作之后最多等多久 */
    private const val VISIBLE_TIMEOUT_MS = 5 * 60_000L

    /**
     * 打开 [url] 并找出播放列表地址，阻塞到找到 / 失败 / 被取消（被取消时抛 CancelledException）。
     * 页面上写着好几个地址（每个清晰度一个）时，按 [maxHeight] 挑一个。
     */
    fun extract(url: String, flag: CancelFlag, maxHeight: Int = Int.MAX_VALUE): Result {
        val activity = MainActivity.current ?: throw Http.ApiException("请在应用界面打开的状态下下载这个链接（需要加载网页来找视频地址）")
        val latch = CountDownLatch(1)
        var outcome: Any? = null
        val main = Handler(Looper.getMainLooper())
        var capture: Capture? = null
        main.post {
            capture = Capture(activity, url, maxHeight) {
                if (outcome == null) outcome = it
                latch.countDown()
            }
            capture.start()
        }
        flag.onCancel { main.post { capture?.abort() } }
        latch.await(VISIBLE_TIMEOUT_MS + 15_000, TimeUnit.MILLISECONDS)
        flag.throwIfCancelled()
        return when (val o = outcome) {
            null -> throw Http.ApiException("打开网页超时，没有找到视频地址")
            is Result -> o
            is Exception -> throw o
            else -> throw Http.ApiException("没有找到视频地址")
        }
    }

    /**
     * 让「找视频地址」用的网页走应用里配置的代理——
     * 否则带防护的站点会看到两个不同的出口地址（网页一个、下载请求一个），验证就白做了。
     * 应用自己的界面（127.0.0.1）永远直连。
     */
    /** 系统要求这个回调不能在界面线程上执行，所以单独开一个线程 */
    private val proxyExecutor = Executors.newSingleThreadExecutor { r -> Thread(r, "webview-proxy").apply { isDaemon = true } }

    fun applyWebViewProxy(spec: String) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) return
        val builder = ProxyConfig.Builder().addBypassRule("127.0.0.1")
        val proxy = spec.trim()
        if (proxy.isEmpty()) builder.addDirect() else builder.addProxyRule(stripCredentials(proxy))
        ProxyController.getInstance().setProxyOverride(builder.build(), proxyExecutor) {}
    }

    private fun stripCredentials(spec: String): String =
        try {
            val u = URI(spec.trim())
            val host = u.host ?: return spec.trim()
            val port = if (u.port > 0) ":${u.port}" else ""
            "${u.scheme}://$host$port"
        } catch (_: Exception) {
            spec.trim()
        }

    @SuppressLint("SetJavaScriptEnabled")
    private class Capture(
        private val activity: Activity,
        private val url: String,
        /** 清晰度上限（短边像素）；页面写着多个地址时据此挑 */
        private val maxHeight: Int,
        private val done: (Any?) -> Unit,
    ) {
        private val main = Handler(Looper.getMainLooper())
        private val web = WebView(activity)
        private val startAt = System.currentTimeMillis()
        private var m3u8: String? = null
        private var foundAt = 0L
        private var challengeTicks = 0
        private var blocked = false
        private var lastTitle: String? = null
        private var dialog: Dialog? = null
        private var status: TextView? = null
        private var finished = false
        private var pageNote: String? = null

        init {
            web.settings.javaScriptEnabled = true
            web.settings.domStorageEnabled = true
            web.settings.mediaPlaybackRequiresUserGesture = false
            web.settings.userAgentString = Http.UA
            web.webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    // 最可靠的一路：播放器自己发出的播放列表请求
                    val u = request.url.toString()
                    if (m3u8 == null && !u.startsWith("blob:") && Urls.isDirectPlaylist(u)) {
                        m3u8 = u
                        foundAt = System.currentTimeMillis()
                    }
                    return null
                }

                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                    // 被防护站点拦下时，主文档通常返回 403 / 429 / 503
                    if (request.isForMainFrame && response.statusCode in intArrayOf(403, 429, 503)) blocked = true
                }
            }
        }

        fun start() {
            web.loadUrl(url)
            main.postDelayed(::poll, 800)
        }

        private fun poll() {
            if (finished) return
            val found = m3u8
            if (found != null) {
                // 再等一小会儿，让页面把标题写好
                if (System.currentTimeMillis() - foundAt < 1200) {
                    main.postDelayed(::poll, 300)
                    return
                }
                // 收尾前再读一次标题：播放列表常常在第一次扫描之前就被抓到了，那时还没读到过标题；
                // 人机验证通过后页面会改标题，所以以这次读到的为准
                web.evaluateJavascript(TITLE_JS) { raw ->
                    if (!finished) complete(found, cleanTitle(unquote(raw)) ?: lastTitle)
                }
                return
            }
            web.evaluateJavascript(SCAN_JS) { raw ->
                if (finished) return@evaluateJavascript
                parseInfo(raw)?.let { info ->
                    // 播放器自己请求过的地址 / <video> 的 src 最可靠；都没有时用页面里写着的那些，按清晰度挑一个
                    if (m3u8 == null) {
                        m3u8 = info.nullableString("m3u8")?.takeIf { it.isNotBlank() }
                        if (m3u8 == null) {
                            info.optJSONArray("m3u8s")?.let { cands ->
                                val picked = pickPlaylist(cands, maxHeight)
                                if (picked != null && cands.length() > 1) {
                                    pageNote = if (picked.second > 0) {
                                        "网页上写着 ${cands.length()} 档清晰度，用了 ${picked.second}p 的那一路"
                                    } else {
                                        "网页上写着 ${cands.length()} 个播放列表地址，但没有标清晰度，用了第一个"
                                    }
                                }
                                m3u8 = picked?.first
                            }
                        }
                        if (m3u8 != null) foundAt = System.currentTimeMillis()
                    }
                    // 验证页的标题（如 "Just a moment..."）不是视频标题，不记
                    info.nullableString("title")?.let { cleanTitle(it) }?.let { lastTitle = it }
                    challengeTicks = if (info.optBoolean("challenge")) challengeTicks + 1 else 0
                }
                val elapsed = System.currentTimeMillis() - startAt
                when {
                    dialog == null && (challengeTicks >= 2 || blocked) -> {
                        promote()
                        main.postDelayed(::poll, 900)
                    }
                    dialog == null && elapsed > HIDDEN_TIMEOUT_MS ->
                        fail(Http.ApiException("网页里没有找到视频地址（可能需要先通过人机验证，或这个站点暂不支持）"))
                    dialog != null && elapsed > VISIBLE_TIMEOUT_MS ->
                        fail(Http.ApiException("等待超时：没有在网页里找到视频地址"))
                    else -> {
                        status?.text = if (challengeTicks > 0 || blocked) {
                            "请先在下面的网页里完成人机验证，通过后会自动开始下载"
                        } else {
                            "正在等待网页加载播放器 …（如果一直没有反应，可以点一下网页里的播放按钮）"
                        }
                        main.postDelayed(::poll, 700)
                    }
                }
            }
        }

        /** evaluateJavascript 返回的是一个 JSON 字符串字面量，里面才是我们 JSON.stringify 过的对象 */
        private fun parseInfo(raw: String?): JSONObject? {
            if (raw.isNullOrBlank() || raw == "null") return null
            return try {
                JSONObject(JSONTokener(raw).nextValue() as String)
            } catch (_: Exception) {
                null
            }
        }

        /**
         * 页面上写着好几个播放列表地址时（常常是每个清晰度一个），按清晰度上限挑一个。
         * 规则和 HlsPlaylist.pick 一致：不超过上限的最高一档；都超过就取最低的一档。
         * 旁边没写清晰度的地址只在没有任何线索时才用（页面上的第一个）。
         * @returns 地址和它的清晰度（短边像素；没标就是 0）
         */
        private fun pickPlaylist(cands: JSONArray, maxHeight: Int): Pair<String, Int>? {
            val all = (0 until cands.length()).mapNotNull { i ->
                val o = cands.optJSONObject(i) ?: return@mapNotNull null
                val u = o.nullableString("url")?.takeIf { it.isNotBlank() && Urls.isDirectPlaylist(it) } ?: return@mapNotNull null
                u to o.optInt("side", 0)
            }
            val fitting = all.filter { it.second in 1..maxHeight }
            val sized = all.filter { it.second > 0 }
            return when {
                fitting.isNotEmpty() -> fitting.maxByOrNull { it.second }
                sized.isNotEmpty() -> sized.minByOrNull { it.second }
                else -> all.firstOrNull()
            }
        }

        /** evaluateJavascript 返回的字符串字面量 → 字符串本身 */
        private fun unquote(raw: String?): String? =
            if (raw.isNullOrBlank() || raw == "null") null else runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull()

        /** 把正在加载的网页显示出来，让用户自己完成验证 */
        private fun promote() {
            val pad = (12 * activity.resources.displayMetrics.density).toInt()
            val root = LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(Color.BLACK)
            }
            val bar = LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(pad, pad / 2, pad / 2, pad / 2)
                setBackgroundColor(Color.rgb(31, 31, 31))
            }
            status = TextView(activity).apply {
                setTextColor(Color.WHITE)
                textSize = 14f
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            bar.addView(status)
            bar.addView(
                Button(activity).apply {
                    text = "取消"
                    setOnClickListener { fail(CancelledException()) }
                },
            )
            root.addView(bar)
            (web.parent as? ViewGroup)?.removeView(web)
            root.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
            val d = Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
            d.setContentView(root)
            d.setCancelable(false)
            d.show()
            dialog = d
        }

        private fun complete(m3u8: String, title: String?) {
            if (finished) return
            finished = true
            cleanup()
            val headers = buildMap {
                put("Referer", url)
                put("Origin", originOf(url))
                CookieManager.getInstance().getCookie(m3u8)?.takeIf { it.isNotBlank() }?.let { put("Cookie", it) }
            }
            done(Result(m3u8, url, cleanTitle(title), headers, pageNote))
        }

        private fun fail(e: Exception) {
            if (finished) return
            finished = true
            cleanup()
            done(e)
        }

        /** 任务被暂停 / 终止 */
        fun abort() = fail(CancelledException())

        private fun cleanup() {
            dialog?.dismiss()
            dialog = null
            status = null
            runCatching {
                web.stopLoading()
                (web.parent as? ViewGroup)?.removeView(web)
                web.destroy()
            }
        }

        private fun originOf(u: String): String =
            try {
                val uri = URI(u)
                "${uri.scheme}://${uri.host}${if (uri.port > 0) ":${uri.port}" else ""}"
            } catch (_: Exception) {
                u
            }

        /** 验证页的标题（如 "Just a moment..."）不是视频标题 */
        private fun cleanTitle(title: String?): String? {
            val t = title?.trim().orEmpty()
            if (t.isEmpty() || CHALLENGE_TITLE.containsMatchIn(t)) return null
            return t
        }
    }

    private val CHALLENGE_TITLE = Regex(
        "just a moment|attention required|verifying|checking (your )?browser|security check|ddos-guard|请稍候",
        RegexOption.IGNORE_CASE,
    )

    /** 网页的视频标题：优先页面的 og:title，其次文档标题 */
    private val TITLE_JS = """
        (function() {
          try {
            var m = document.querySelector('meta[property="og:title"]');
            return (m && m.content) || document.title || '';
          } catch (e) { return ''; }
        })()
    """

    /** 在页面里找播放列表地址、判断是不是人机验证页、读标题 */
    private val SCAN_JS = """
        (function() {
          var out = { m3u8: null, m3u8s: [], challenge: false, title: null };
          try {
            out.title = (document.title || '').slice(0, 200);
            var t = (document.title || '') + ' ' + location.href;
            if (/just a moment|attention required|verifying|checking (your )?browser|security check|ddos-guard|moment please/i.test(t)) out.challenge = true;
            var frames = document.querySelectorAll('iframe');
            for (var i = 0; i < frames.length; i++) {
              var s = frames[i].src || '';
              if (/challenges\.cloudflare\.com|recaptcha|hcaptcha|turnstile/i.test(s)) out.challenge = true;
            }
            if (document.querySelector('.cf-turnstile, #challenge-running, #challenge-form, #challenge-stage, [id^="cf-chl"]')) out.challenge = true;
            try {
              var rs = performance.getEntriesByType('resource');
              for (var j = 0; j < rs.length; j++) {
                var n = rs[j].name || '';
                if (n.indexOf('blob:') !== 0 && /\.m3u8($|[?#])/.test(n)) { out.m3u8 = n; break; }
              }
            } catch (e) {}
            if (!out.m3u8) {
              var v = document.querySelector('video');
              if (v && v.src && /\.m3u8($|[?#])/.test(v.src)) out.m3u8 = v.src;
            }
            if (!out.m3u8) {
              // 播放器还没发请求、页面上也没有 <video> 的时候，地址多半写在页面的脚本 / JSON 数据里。
              // 那里的地址是转义过的（https:\/\/…\u0026…），直接按明文去找会对不上：先把转义还原，再找。
              // 还原之后地址里不再有反斜杠，可以一路取到引号为止。
              // 有的页面每个清晰度各写一个地址，旁边带着清晰度（height / quality）：一起记下来，
              // 由引擎按用户选的清晰度挑
              var src = document.documentElement.outerHTML.replace(/\\\//g, '/').replace(/\\u002f/gi, '/').replace(/\\u0026/gi, '&');
              // .m3u8 后面不能再是路径里的字符（排除 hls.m3u8.js 这类），引号、?、#、空白、反斜杠都算到头了
              var re = /https?:\/\/[^"'\s<>]+?\.m3u8(?![\w.\/-])[^"'\s<>\\]*/g;
              var seen = {};
              var mm;
              while ((mm = re.exec(src)) !== null && out.m3u8s.length < 20) {
                var u = mm[0].replace(/&amp;/g, '&');
                if (seen[u]) continue;
                seen[u] = 1;
                var side = 0;
                var end = src.indexOf('}', mm.index);
                if (end < 0) end = mm.index + 200;
                var b = mm.index;
                // 往前找最多两层 {：清晰度可能写在地址所在的对象里，也可能在外层对象里
                for (var k = 0; k < 2 && !side; k++) {
                  b = src.lastIndexOf('{', b - 1);
                  if (b < 0 || mm.index - b > 800) break;
                  var obj = src.slice(b, end + 1);
                  var hh = /"height"\s*:\s*"?(\d{3,4})"?/.exec(obj);
                  var ww = /"width"\s*:\s*"?(\d{3,4})"?/.exec(obj);
                  var qq = /"quality"\s*:\s*"?(\d{3,4})p?"?/.exec(obj);
                  if (hh) side = parseInt(hh[1], 10);
                  if (hh && ww && parseInt(ww[1], 10) > 0) side = Math.min(side, parseInt(ww[1], 10)); // 竖屏视频：取短边
                  if (!side && qq) side = parseInt(qq[1], 10);
                }
                out.m3u8s.push({ url: u, side: side });
              }
              // 这里不往 out.m3u8 里放：那个字段只留给「播放器自己请求过的地址」，引擎按清晰度从 out.m3u8s 里挑
            }
          } catch (e) {}
          return JSON.stringify(out);
        })()
    """
}
