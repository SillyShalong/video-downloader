package com.sillyshalong.videodownloader

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * B站独立取流引擎（纯 Kotlin + OkHttp，无 WebView）。
 * 与 yt-dlp 同款 HTTP 方案：UA + buvid3 cookie + wbi 签名的 playurl（html5 渐进式 mp4，免合并）。
 * 签名逻辑在 Wbi（JVM 单测覆盖官方测试向量）。
 */
object BiliEngine {
    private const val DESKTOP_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    private const val REFERER = "https://www.bilibili.com/"

    // 结果统一使用 DownloadSpec（与 YouTube/HLS 引擎一致）

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    /** 完整提取流程：短链解析 → view(cid/title) → nav(wbi keys) → playurl(durl 直链) */
    fun extract(ctx: Context, url: String, sessdata: String, qualityHint: String?): DownloadSpec {
        val prefs = ctx.getSharedPreferences("config", Context.MODE_PRIVATE)
        val buvid = getOrCreateBuvid(prefs)

        val pageUrl = resolveShortLink(url)
        val bvid = Regex("BV[0-9A-Za-z]+").find(pageUrl)?.value
            ?: throw RuntimeException("B站: 链接中未找到 BV 号（$pageUrl）")

        val cookie = buildString {
            append("buvid3=$buvid")
            if (sessdata.isNotBlank()) append("; SESSDATA=$sessdata")
        }

        // 1) view：cid + 标题
        val viewJson = getJson(
            "https://api.bilibili.com/x/web-interface/view?bvid=$bvid",
            cookie,
        )
        if (viewJson.optInt("code", -1) != 0) {
            throw RuntimeException("B站: view 接口 ${viewJson.optInt("code")} ${viewJson.optString("message")}")
        }
        val data = viewJson.getJSONObject("data")
        val cid = data.getLong("cid")
        val title = data.optString("title", bvid)

        // 2) nav：wbi keys（游客可用）
        val navJson = getJson("https://api.bilibili.com/x/web-interface/nav", cookie)
        val wbiImg = navJson.optJSONObject("data")?.optJSONObject("wbi_img")
            ?: throw RuntimeException("B站: nav 未返回 wbi_img")
        val imgKey = lastSeg(wbiImg.optString("img_url"))
        val subKey = lastSeg(wbiImg.optString("sub_url"))

        // 3) playurl：html5 渐进式 mp4（durl）
        val qn = qualityToQn(qualityHint)
        val signed = Wbi.sign(
            mapOf(
                "bvid" to bvid,
                "cid" to cid.toString(),
                "qn" to qn.toString(),
                "fnval" to "0",
                "fnver" to "0",
                "platform" to "html5",
                "high_quality" to "1",
            ),
            Wbi.mixinKey(imgKey, subKey),
        )
        val playJson = getJson(
            "https://api.bilibili.com/x/player/playurl?${signed.first}&w_rid=${signed.second}",
            cookie,
        )
        if (playJson.optInt("code", -1) != 0) {
            throw RuntimeException(
                "B站: playurl ${playJson.optInt("code")} ${playJson.optString("message")}（配置 SESSDATA 可提升画质）",
            )
        }
        val pdata = playJson.getJSONObject("data")
        val durl = pdata.optJSONArray("durl")
            ?: throw RuntimeException("B站: 无 durl 直链（响应 qn=${pdata.optInt("quality")}），可尝试配置 SESSDATA")
        val urls = mutableListOf<String>()
        for (i in 0 until durl.length()) {
            val d = durl.getJSONObject(i)
            d.optString("url").takeIf { it.isNotBlank() }?.let { urls.add(it) }
            d.optJSONArray("backup_url")?.let { bk ->
                for (j in 0 until bk.length()) urls.add(bk.getString(j))
            }
        }
        if (urls.isEmpty()) throw RuntimeException("B站: durl 中无可用地址")

        val safe = sanitizeName(title)
        return DownloadSpec(
            title = safe,
            fileName = "$safe [$bvid].mp4",
            urls = urls.distinct().take(6),
            totalBytes = durl.getJSONObject(0).optLong("size", 0),
        )
    }

    /* ---------------- 内部 ---------------- */

    private fun getJson(url: String, cookie: String): JSONObject {
        val req = Request.Builder().url(url)
            .header("User-Agent", DESKTOP_UA)
            .header("Referer", REFERER)
            .header("Cookie", cookie)
            .build()
        client.newCall(req).execute().use { resp ->
            val bodyStr = resp.body?.string() ?: throw RuntimeException("空响应")
            if (!resp.isSuccessful) throw RuntimeException("HTTP ${resp.code}: $bodyStr")
            return JSONObject(bodyStr)
        }
    }

    /** b23.tv 短链 → 完整视频页 URL（跟随重定向） */
    private fun resolveShortLink(url: String): String {
        if (!url.contains("b23.tv")) return url
        val req = Request.Builder().url(url).header("User-Agent", DESKTOP_UA).build()
        client.newCall(req).execute().use { resp ->
            return resp.request.url.toString()
        }
    }

    /** buvid3 持久化（首启生成，形如 yt-dlp 生成规则：uuid+infoc 后缀） */
    private fun getOrCreateBuvid(prefs: android.content.SharedPreferences): String {
        prefs.getString("buvid3", null)?.let { return it }
        val buvid = UUID.randomUUID().toString().replace("-", "").uppercase() + "infoc"
        prefs.edit().putString("buvid3", buvid).apply()
        return buvid
    }

    private fun qualityToQn(hint: String?): Int = when (hint) {
        "1080" -> 80
        "720" -> 64
        "540" -> 32
        "360" -> 16
        else -> 80
    }

    private fun lastSeg(url: String): String =
        url.substringBefore('?').trimEnd('/').substringAfterLast('/').substringBefore('.')

    private fun sanitizeName(s: String): String =
        s.replace(Regex("[\\\\/:*?\"<>|#\\r\\n\\t]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
            .take(80)
            .ifBlank { "bilibili_video" }
}
