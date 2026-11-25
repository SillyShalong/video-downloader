package com.sillyshalong.videodownloader

import android.content.Context
import org.json.JSONObject
import java.util.UUID

/**
 * B站取流引擎（纯 Kotlin + OkHttp，不依赖任何外部程序）。
 *
 * 走网页版的 html5 播放接口：返回「音视频合一的渐进式 MP4」，游客就有 720P，
 * 配置 SESSDATA 后同一接口按登录身份取流。实测（2026-11）游客可取 qn=64(720P)/16(360P)；
 * DASH 接口游客只有 480P，所以这里不用 DASH。
 * playurl 需要 wbi 签名，算法在 Wbi（JVM 单测覆盖官方测试向量）。
 */
object BiliEngine {
    private const val REFERER = "https://www.bilibili.com/"
    private const val API = "https://api.bilibili.com"
    private val BV = Regex("BV[0-9A-Za-z]{10}")

    class Page(val index: Int, val title: String, val duration: Long, val cid: Long)
    class Info(val bvid: String, val title: String, val pages: List<Page>, /** 短链展开后的完整视频页地址 */ val pageUrl: String)

    private const val PREFS = "config"

    /** 分 P 信息缓存（提交时的「探测多视频源」和随后的下载会连续请求同一个视频） */
    private val cache = HashMap<String, Pair<Long, Info>>()

    fun extract(ctx: Context, url: String, sessdata: String, quality: String?, flag: CancelFlag): DownloadSpec {
        val pageUrl = resolve(url, flag)
        val info = info(ctx, pageUrl, sessdata, flag)
        val page = pickPage(pageUrl, info.pages)
        val cookie = cookie(ctx, sessdata)

        // playurl：html5 渐进式 mp4（durl）
        val qn = when (quality) {
            "1080" -> 80
            "720" -> 64
            "540" -> 32
            "360" -> 16
            else -> 80
        }
        // nav：wbi 签名用的两个 key。游客调用时接口返回 code=-101「账号未登录」，但 wbi_img 照常给出，所以这里不校验 code
        val nav = api("$API/x/web-interface/nav", cookie, flag, requireOk = false)
        val wbi = nav.optJSONObject("data")?.optJSONObject("wbi_img")
            ?: throw Http.ApiException("B站: 未取到签名参数，请稍后重试")
        val signed = Wbi.sign(
            mapOf(
                "bvid" to info.bvid,
                "cid" to page.cid.toString(),
                "qn" to qn.toString(),
                "fnval" to "0",
                "fnver" to "0",
                "platform" to "html5",
                "high_quality" to "1",
            ),
            Wbi.mixinKey(fileName(wbi.optString("img_url")), fileName(wbi.optString("sub_url"))),
        )
        val data = api(
            "$API/x/player/playurl?${signed.first}&w_rid=${signed.second}",
            cookie,
            flag,
        ).optJSONObject("data")
        val durl = data?.optJSONArray("durl")
        if (durl == null || durl.length() == 0) {
            throw Http.ApiException(
                "B站: 没有可用的视频流（接口给的清晰度 ${data?.optInt("quality") ?: -1}），可在设置里配置 SESSDATA 后重试",
            )
        }

        // 每段一组等价地址：主地址 + 备用地址
        val parts = ArrayList<List<String>>()
        var total = 0L
        for (i in 0 until durl.length()) {
            val seg = durl.optJSONObject(i) ?: continue
            val urls = ArrayList<String>()
            seg.optString("url").takeIf { it.isNotBlank() }?.let(urls::add)
            seg.optJSONArray("backup_url")?.let { bk ->
                for (j in 0 until bk.length()) bk.optString(j).takeIf { it.isNotBlank() }?.let(urls::add)
            }
            if (urls.isEmpty()) continue
            parts.add(urls.distinct())
            total += seg.optLong("size", 0)
        }
        if (parts.isEmpty()) throw Http.ApiException("B站: 视频流地址为空")

        // 多 P 视频：标题和文件名都带上「P 几 + 分 P 名」，任务列表里才分得清是哪一 P
        val multi = info.pages.size > 1
        val name = buildString {
            append(Storage.sanitizeFileName(info.title))
            if (multi) {
                append(" - P").append(page.index).append(' ').append(Storage.sanitizeFileName(page.title))
            }
        }
        return DownloadSpec(
            title = name,
            fileName = Storage.sanitizeFileName("$name [${info.bvid}].mp4"),
            parts = parts,
            totalBytes = total,
            headers = mapOf("Referer" to REFERER),
        )
    }

    /** 视频信息（分 P 列表等），供「多视频源选择」用；已缓存 5 分钟 */
    fun probe(ctx: Context, url: String, sessdata: String, flag: CancelFlag): Info {
        val pageUrl = resolve(url, flag)
        return info(ctx, pageUrl, sessdata, flag)
    }

    /* ---------------- 内部 ---------------- */

    private fun pickPage(pageUrl: String, pages: List<Page>): Page {
        val p = Urls.queryParam(pageUrl, "p")?.toIntOrNull() ?: 1
        return pages.firstOrNull { it.index == p } ?: pages[0]
    }

    private fun info(ctx: Context, pageUrl: String, sessdata: String, flag: CancelFlag): Info {
        val bvid = BV.find(pageUrl)?.value ?: throw Http.ApiException("B站: 链接里没有 BV 号（$pageUrl）")
        synchronized(cache) { cache[bvid]?.let { if (System.currentTimeMillis() - it.first < 5 * 60_000) return it.second } }
        val view = api("$API/x/web-interface/view?bvid=$bvid", cookie(ctx, sessdata), flag)
        val data = view.optJSONObject("data") ?: throw Http.ApiException("B站: 视频信息为空")
        val pages = ArrayList<Page>()
        data.optJSONArray("pages")?.let { arr ->
            for (i in 0 until arr.length()) {
                val p = arr.getJSONObject(i)
                pages.add(Page(p.optInt("page", i + 1), p.optString("part", "P${i + 1}"), p.optLong("duration"), p.optLong("cid")))
            }
        }
        if (pages.isEmpty()) throw Http.ApiException("B站: 视频没有可播放的分 P")
        val result = Info(bvid, data.optString("title", bvid).ifBlank { bvid }, pages, "https://www.bilibili.com/video/$bvid")
        synchronized(cache) { cache[bvid] = System.currentTimeMillis() to result }
        return result
    }

    /** 调 B 站接口，把常见错误码翻译成看得懂的原因 */
    private fun api(url: String, cookie: String, flag: CancelFlag, requireOk: Boolean = true): JSONObject {
        val raw = Http.text(url, mapOf("Referer" to REFERER, "Cookie" to cookie), flag)
        val j = try {
            JSONObject(raw)
        } catch (e: Exception) {
            throw Http.ApiException("B站: 接口返回了无法解析的内容（可能被风控，稍后重试）", e)
        }
        val code = j.optInt("code", -1)
        if (requireOk && code != 0) throw Http.ApiException("B站: ${friendly(code, j.optString("message"))}")
        return j
    }

    private fun friendly(code: Int, message: String): String = when (code) {
        -404 -> "视频不存在（可能已删除或正在审核中）"
        -403 -> "没有访问权限（地区限制或需要登录，可在设置里配置 SESSDATA）"
        -412 -> "请求被拦截（操作太频繁），请稍后再试"
        62002 -> "稿件已失效（不可见）"
        62012 -> "稿件仅 UP 主自己可见"
        62004 -> "视频正在审核中"
        else -> message.ifBlank { "接口错误 $code" }
    }

    private fun cookie(ctx: Context, sessdata: String): String {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        var buvid = prefs.getString("buvid3", null)
        if (buvid.isNullOrBlank()) {
            buvid = UUID.randomUUID().toString().replace("-", "").uppercase() + "infoc"
            prefs.edit().putString("buvid3", buvid).apply()
        }
        return if (sessdata.isBlank()) "buvid3=$buvid" else "buvid3=$buvid; SESSDATA=$sessdata"
    }

    /** b23.tv 短链 → 完整视频页地址 */
    private fun resolve(url: String, flag: CancelFlag): String {
        if (Urls.host(url)?.endsWith("b23.tv") != true) return url
        return Http.call(url, emptyMap(), flag).use { it.request.url.toString() }
    }

    private fun fileName(url: String): String =
        url.substringBefore('?').trimEnd('/').substringAfterLast('/').substringBefore('.')
}
