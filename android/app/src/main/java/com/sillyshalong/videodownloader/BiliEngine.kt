package com.sillyshalong.videodownloader

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * B站独立取流引擎：隐藏 WebView 加载视频页 → 页面上下文完成 wbi 签名的 playurl 请求
 * （与桌面端抖音引擎同一套「页内签名」架构，平移到 Android WebView）。
 * 返回 html5 durl 渐进式 mp4 直链（免合并、免 ffmpeg）。
 */
object BiliEngine {
    private const val DESKTOP_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

    class Result(val title: String, val fileName: String, val urls: List<String>, val totalBytes: Long)

    private val JS = """
        (async () => {
          try {
            const st = window.__INITIAL_STATE__ || {};
            const bvid = st.bvid || (location.pathname.match(/BV[0-9A-Za-z]+/) || [])[0];
            const vd = st.videoData || {};
            let cid = vd.cid;
            let title = vd.title;
            if (!cid) {
              const r = await fetch('/x/web-interface/view?bvid=' + bvid, { credentials: 'include' });
              const j = await r.json();
              cid = j.data && j.data.cid;
              title = title || (j.data && j.data.title);
            }
            if (!bvid || !cid) return JSON.stringify({ err: '未能解析 bvid/cid' });

            // ---- wbi 签名 ----
            const mixinKeyEncTab = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,
              33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
            const nav = await (await fetch('/x/web-interface/nav', { credentials: 'include' })).json();
            const wi = (nav.data && nav.data.wbi_img) || {};
            const img = (wi.img_url || '').split('/').pop().split('.')[0];
            const sub = (wi.sub_url || '').split('/').pop().split('.')[0];
            const raw = img + sub;
            const key = mixinKeyEncTab.slice(0, 32).map(i => raw[i]).join('');
            const params = {
              bvid: bvid, cid: cid, qn: 80, fnval: 1, fnver: 0, fourk: 1,
              platform: 'html5', high_quality: 1,
              ts: Math.floor(Date.now() / 1000).toString()
            };
            const chr = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            const addR = s => chr[Math.floor(Math.random() * chr.length)] + s;
            const q = Object.keys(params).sort().map(k => k + '=' + encodeURIComponent(params[k])).join('&');
            const wq = addR(q);
            const wbiSign = await crypto.subtle.digest('MD5', new TextEncoder().encode(wq + key)).then(() => '').catch(() => '');
            // WebView 无 MD5 subtle —— 用纯 JS 实现：
            function md5(s){ function rl(n,c){return(n<<c)|(n>>>(32-c));}
              function au(x,y){var l=(x&0xFFFF)+(y&0xFFFF),m=(x>>16)+(y>>16)+(l>>16);return(m<<16)|(l&0xFFFF);}
              function cmn(q,a,b,x,s,t){return au(rl(au(au(a,q),au(x,t)),s),b);}
              function ff(a,b,c,d,x,s,t){return cmn((b&c)|((~b)&d),a,b,x,s,t);}
              function gg(a,b,c,d,x,s,t){return cmn((b&d)|(c&(~d)),a,b,x,s,t);}
              function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t);}
              function ii(a,b,c,d,x,s,t){return cmn(c^(b|(~d)),a,b,x,s,t);}
              function cb(u){var i,l=u.length,bl=l*8;var a=1732584193,b=-271733879,c=-1732584194,d=271733878;
                for(i=0;i<l;i+=16){var oa=a,ob=b,oc=c,od=d;
                  a=ff(a,b,c,d,u[i]|0,7,-680876936);d=ff(d,a,b,c,u[i+1]|0,12,-389564586);c=ff(c,d,a,b,u[i+2]|0,17,606105819);b=ff(b,c,d,a,u[i+3]|0,22,-1044525330);
                  a=ff(a,b,c,d,u[i+4]|0,7,-176418897);d=ff(d,a,b,c,u[i+5]|0,12,1200080426);c=ff(c,d,a,b,u[i+6]|0,17,-1473231341);b=ff(b,c,d,a,u[i+7]|0,22,-45705983);
                  a=ff(a,b,c,d,u[i+8]|0,7,1770035416);d=ff(d,a,b,c,u[i+9]|0,12,-1958414417);c=ff(c,d,a,b,u[i+10]|0,17,-42063);b=ff(b,c,d,a,u[i+11]|0,22,-1990404162);
                  a=ff(a,b,c,d,u[i+12]|0,7,1804603682);d=ff(d,a,b,c,u[i+13]|0,12,-40341101);c=ff(c,d,a,b,u[i+14]|0,17,-1502002290);b=ff(b,c,d,a,u[i+15]|0,22,1236535329);
                  a=gg(a,b,c,d,u[i+1]|0,5,-165796510);d=gg(d,a,b,c,u[i+6]|0,9,-1069501632);c=gg(c,d,a,b,u[i+11]|0,14,643717713);b=gg(b,c,d,a,u[i]|0,20,-373897302);
                  a=gg(a,b,c,d,u[i+5]|0,5,-701558691);d=gg(d,a,b,c,u[i+10]|0,9,38016083);c=gg(c,d,a,b,u[i+15]|0,14,-660478335);b=gg(b,c,d,a,u[i+4]|0,20,-405537848);
                  a=gg(a,b,c,d,u[i+9]|0,5,568446438);d=gg(d,a,b,c,u[i+14]|0,9,-1019803690);c=gg(c,d,a,b,u[i+3]|0,14,-187363961);b=gg(b,c,d,a,u[i+8]|0,20,1163531501);
                  a=gg(a,b,c,d,u[i+13]|0,5,-1444681467);d=gg(d,a,b,c,u[i+2]|0,9,-51403784);c=gg(c,d,a,b,u[i+7]|0,14,1735328473);b=gg(b,c,d,a,u[i+12]|0,20,-1926607734);
                  a=hh(a,b,c,d,u[i+5]|0,4,-378558);d=hh(d,a,b,c,u[i+8]|0,11,-2022574463);c=hh(c,d,a,b,u[i+11]|0,16,1839030562);b=hh(b,c,d,a,u[i+14]|0,23,-35309556);
                  a=hh(a,b,c,d,u[i+1]|0,4,1530992060);d=hh(d,a,b,c,u[i+4]|0,11,-1272893353);c=hh(c,d,a,b,u[i+7]|0,16,-155497632);b=hh(b,c,d,a,u[i+10]|0,23,-1094730640);
                  a=hh(a,b,c,d,u[i+13]|0,4,681279174);d=hh(d,a,b,c,u[i]|0,11,-358537222);c=hh(c,d,a,b,u[i+3]|0,16,-722521979);b=hh(b,c,d,a,u[i+6]|0,23,76029189);
                  a=hh(a,b,c,d,u[i+9]|0,4,-640364487);d=hh(d,a,b,c,u[i+12]|0,11,-421815835);c=hh(c,d,a,b,u[i+15]|0,16,530742520);b=hh(b,c,d,a,u[i+2]|0,23,-995338651);
                  a=ii(a,b,c,d,u[i]|0,6,-198630844);d=ii(d,a,b,c,u[i+7]|0,10,1126891415);c=ii(c,d,a,b,u[i+14]|0,15,-1416354905);b=ii(b,c,d,a,u[i+5]|0,21,-57434055);
                  a=ii(a,b,c,d,u[i+12]|0,6,1700485571);d=ii(d,a,b,c,u[i+3]|0,10,-1894986606);c=ii(c,d,a,b,u[i+10]|0,15,-1051523);b=ii(b,c,d,a,u[i+1]|0,21,-2054922799);
                  a=ii(a,b,c,d,u[i+8]|0,6,1873313359);d=ii(d,a,b,c,u[i+15]|0,10,-30611744);c=ii(c,d,a,b,u[i+6]|0,15,-1560198380);b=ii(b,c,d,a,u[i+13]|0,21,1309151649);
                  a=ii(a,b,c,d,u[i+4]|0,6,-145523070);d=ii(d,a,b,c,u[i+11]|0,10,-1120210379);c=ii(c,d,a,b,u[i+2]|0,15,718787259);b=ii(b,c,d,a,u[i+9]|0,21,-343485551);
                  a=au(a,oa);b=au(b,ob);c=au(c,oc);d=au(d,od);}
                return [a,b,c,d];}
              function li(n){var s='',j;for(j=0;j<4;j++)s+=((n>>(j*8+4))&15).toString(16)+((n>>(j*8))&15).toString(16);return s;}
              var x=unescape(encodeURIComponent(s)),n=x.length,i,st=[],b=[];for(i=0;i<64;i++)st[i]=i<16?7+4*i:0;
              for(i=0;i<n*8;i+=8)st[i>>5]|=(x.charCodeAt(i/8)&255)<<(i%32);
              st[n*8>>5]|=0x80<<(n%32);st[(((n+64)>>>9)<<4)+14]=n*8;
              var o=cb(st);return li(o[0])+li(o[1])+li(o[2])+li(o[3]);}
            const sign = md5(wq + key);
            const finalQ = wq + '&w_rid=' + sign;

            // ---- playurl（html5 → durl 渐进式 mp4，免合并）----
            const pr = await fetch('/x/player/playurl?' + finalQ, { credentials: 'include' });
            const pj = await pr.json();
            if (pj.code !== 0) return JSON.stringify({ err: 'playurl ' + pj.code + ': ' + (pj.message || '') });
            const durl = pj.data && pj.data.durl;
            if (!durl || !durl.length) return JSON.stringify({ err: '无 durl 直链（尝试切换画质或登录 SESSDATA）' });
            const urls = [];
            durl.forEach(d => { if (d.url) urls.push(d.url); (d.backup_url || []).forEach(u => urls.push(u)); });
            return JSON.stringify({
              title: title || bvid,
              quality: pj.data.quality,
              urls: urls.slice(0, 6),
              size: durl[0].size || 0
            });
          } catch (e) { return JSON.stringify({ err: String(e) }); }
        })()
    """.trimIndent()

    /** 在主线程创建隐藏 WebView 执行页面内提取（阻塞调用，带超时） */
    fun extract(ctx: Context, url: String, sessdata: String, qualityHint: String?): Result {
        // b23.tv 短链先解析
        val pageUrl = resolveShortLink(url)
        val latch = CountDownLatch(1)
        val holder = arrayOfNulls<Any>(1)
        val main = Handler(Looper.getMainLooper())
        main.post {
            val web = createWebView(ctx, sessdata)
            web.webViewClient = object : android.webkit.WebViewClient() {
                override fun onPageFinished(view: WebView?, finishedUrl: String?) {
                    view?.evaluateJavascript(JS) { res ->
                        val parsed = parseJsResult(res)
                        if (parsed != null) {
                            holder[0] = parsed
                            latch.countDown()
                        }
                        // parsed == null（页面状态未就绪/脚本未完成）时等待重试计时器
                    }
                }
            }
            web.loadUrl(pageUrl)
            // 页面就绪轮询兜底（onPageFinished 时 __INITIAL_STATE__ 可能还没注入）
            var ticks = 0
            val timer = java.util.Timer()
            timer.scheduleAtFixedRate(object : java.util.TimerTask() {
                override fun run() {
                    main.post {
                        if (latch.count == 0L) { timer.cancel(); return@post }
                        ticks++
                        if (ticks > 40) { // 40 × 500ms = 20s 超时
                            holder[0] = RuntimeException("页面解析超时（可能被风控或网络不通）")
                            latch.countDown(); timer.cancel(); return@post
                        }
                        web.evaluateJavascript("(window.__INITIAL_STATE__ && (window.__INITIAL_STATE__.videoData||window.__INITIAL_STATE__.bvid)) ? '1' : '0'") { ready ->
                            if (ready == "\"1\"") {
                                web.evaluateJavascript(JS) { res ->
                                    val parsed = parseJsResult(res)
                                    if (parsed != null) { holder[0] = parsed; latch.countDown(); timer.cancel() }
                                }
                            }
                        }
                    }
                }
            }, 1500, 500)
            // 完成后清理
            threadCleanup(main, web, latch)
        }
        latch.await(30, TimeUnit.SECONDS)
        return when (val r = holder[0]) {
            is Result -> r
            is RuntimeException -> throw r
            else -> throw RuntimeException("B站解析失败（无结果返回）")
        }
    }

    private fun threadCleanup(main: Handler, web: WebView, latch: CountDownLatch) {
        Thread {
            latch.await(35, TimeUnit.SECONDS)
            main.post {
                try { web.stopLoading(); web.destroy() } catch (_: Exception) {}
            }
        }.start()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(ctx: Context, sessdata: String): WebView {
        val web = WebView(ctx)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            userAgentString = DESKTOP_UA
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
        }
        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        if (sessdata.isNotBlank()) {
            cm.setCookie("https://www.bilibili.com", "SESSDATA=$sessdata")
        }
        // 预热 buvid3（playurl 风控所需）
        try {
            val b3 = java.util.UUID.randomUUID().toString().replace("-", "").uppercase()
            cm.setCookie("https://www.bilibili.com", "buvid3=$b3infoc")
        } catch (_: Exception) {}
        return web
    }

    private fun resolveShortLink(url: String): String {
        if (!url.contains("b23.tv")) return normalizeBvUrl(url)
        return try {
            val client = okhttp3.OkHttpClient.Builder()
                .followRedirects(true).build()
            val req = okhttp3.Request.Builder().url(url)
                .header("User-Agent", DESKTOP_UA).build()
            client.newCall(req).execute().use { it.request.url.toString() }
        } catch (_: Exception) { normalizeBvUrl(url) }
    }

    private fun normalizeBvUrl(url: String): String {
        val bv = Regex("BV[0-9A-Za-z]+").find(url)?.value ?: return url
        return "https://www.bilibili.com/video/$bv"
    }

    private fun parseJsResult(res: String?): Result? {
        if (res == null || res == "null") return null
        val json = try { JSONObject(res) } catch (_: Exception) { return null }
        if (json.has("err")) throw RuntimeException("B站: ${json.getString("err")}")
        val title = json.optString("title", "bilibili")
        val urls = json.optJSONArray("urls")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
        if (urls.isEmpty()) throw RuntimeException("B站: 未取到直链")
        val safe = title.replace(Regex("[\\\\/:*?\"<>|#\\r\\n\\t]"), " ").replace(Regex("\\s+"), " ").trim().take(80)
        val bv = Regex("BV[0-9A-Za-z]+").find(urls.firstOrNull() ?: "")?.value ?: ""
        return Result(
            title = safe,
            fileName = "$safe [$bv].mp4",
            urls = urls,
            totalBytes = json.optLong("size", 0),
        )
    }
}
