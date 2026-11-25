package com.sillyshalong.videodownloader

import java.net.URI
import java.net.URLDecoder

/** 链接识别：抽取 URL、判断站点。规则与桌面端 src/sites.mjs 保持一致，改动请两边同步 */
object Urls {
    private val PATTERN = Regex("https?://[^\\s'\"，。,；;<>（）()【】\\[\\]]+")
    private val TAIL = Regex("[).,!?！？;；:：]+$")
    private val M3U8 = Regex("\\.m3u8(?:$|[?#])", RegexOption.IGNORE_CASE)

    /** 从任意文本（如分享口令）中抽取 URL */
    fun extract(text: String): List<String> =
        PATTERN.findAll(text).map { it.value.replace(TAIL, "") }.filter { it.length > 8 }.toList()

    /** 直接指向 m3u8 播放列表的链接 */
    fun isDirectPlaylist(url: String): Boolean = M3U8.containsMatchIn(url)

    fun host(url: String): String? =
        try {
            URI(url).host?.lowercase()
        } catch (_: Exception) {
            null
        }

    /** 查询参数（未找到返回 null） */
    fun queryParam(url: String, name: String): String? {
        val q = url.substringAfter('?', "").substringBefore('#')
        for (pair in q.split('&')) {
            val kv = pair.split('=', limit = 2)
            if (kv[0] == name) return URLDecoder.decode(kv.getOrElse(1) { "" }, "UTF-8")
        }
        return null
    }

    /** 把播放列表里的相对地址换算成绝对地址 */
    fun resolve(base: String, link: String): String {
        val l = link.trim()
        if (l.startsWith("http://") || l.startsWith("https://")) return l
        return try {
            URI(base).resolve(l).toString()
        } catch (_: Exception) {
            // 地址里有 URI 类不接受的字符（中文、空格等）时手工拼
            val schemeEnd = base.indexOf("://")
            val hostEnd = base.indexOf('/', schemeEnd + 3).let { if (it < 0) base.length else it }
            if (l.startsWith("/")) {
                base.substring(0, hostEnd) + l
            } else {
                val slash = base.lastIndexOf('/')
                if (slash > hostEnd) base.substring(0, slash + 1) + l else base.substring(0, hostEnd) + "/" + l
            }
        }
    }
}

/** 站点识别（id 与桌面端一致，前端按 id 显示标签） */
object Sites {
    const val YOUTUBE = "youtube"
    const val BILIBILI = "bilibili"
    const val HLS = "hls-generic"

    /** 安卓独立模式能自己完成下载的站点 */
    val SUPPORTED = setOf(YOUTUBE, BILIBILI, HLS)

    fun of(url: String, hlsSites: List<String>): String {
        val h = Urls.host(url) ?: return "generic"
        fun isDomain(domain: String) = h == domain || h.endsWith(".$domain")
        return when {
            isDomain("youtube.com") || isDomain("youtu.be") || isDomain("youtube-nocookie.com") -> YOUTUBE
            isDomain("bilibili.com") || isDomain("b23.tv") -> BILIBILI
            isDomain("douyin.com") -> "douyin"
            isDomain("xiaohongshu.com") || isDomain("xhslink.com") -> "xiaohongshu"
            hlsSites.any { h == it || h.endsWith(".$it") } -> HLS
            Urls.isDirectPlaylist(url) -> HLS
            else -> "generic"
        }
    }

    /** 站点在手机上不受支持时的提示 */
    fun unsupportedMessage(site: String): String = when (site) {
        "douyin", "xiaohongshu" -> "手机独立模式暂不支持${if (site == "douyin") "抖音" else "小红书"}，请在电脑版里下载（B站 / YouTube / HLS 流媒体站点可直接下载）"
        else -> "无法识别该链接对应的站点。手机独立模式支持：B站、YouTube、HLS 流媒体站点（在设置里添加域名）或直接的 .m3u8 地址"
    }
}
