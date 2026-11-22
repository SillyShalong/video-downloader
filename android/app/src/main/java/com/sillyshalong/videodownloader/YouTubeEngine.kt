package com.sillyshalong.videodownloader

import okhttp3.OkHttpClient
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.localization.ContentCountry
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.localization.Localization
import org.schabi.newpipe.extractor.stream.StreamInfo
import java.util.concurrent.TimeUnit

/**
 * YouTube 独立提取引擎——封装层。
 *
 * 内部依赖 NewPipeExtractor（GPLv3）：YouTube 反爬持续对抗（签名/PO token）由上游库
 * 维护跟进；本模块只做三件事：
 *   1. NewPipe 初始化（Downloader 桥接到我们的 OkHttp，统一 UA/Cookie）
 *   2. StreamInfo 提取 → 按清晰度挑选渐进式流（音视频已合并，无需 ffmpeg）
 *   3. 转成本项目统一的 DownloadSpec 交给 HttpDownloader
 *
 * 上游 API 变动时只需调整本文件。
 */
object YouTubeEngine {
    private const val DESKTOP_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    @Volatile private var initialized = false

    /** NewPipe 桥接：所有上游网络请求走我们的 OkHttp */
    @Synchronized
    private fun ensureInit() {
        if (initialized) return
        val downloader = object : Downloader() {
            override fun execute(request: Request): Response {
                val rb = okhttp3.Request.Builder().url(request.url())
                request.headers().forEach { (name, values) ->
                    values.forEach { rb.header(name, it) }
                }
                val data = request.dataToSend()
                rb.method(request.httpMethod(), data?.let { okhttp3.RequestBody.create(null, it) })
                // YouTube 需要 UA；CONSENT cookie 避免地区弹窗
                if (request.headers()["User-Agent"] == null) rb.header("User-Agent", DESKTOP_UA)
                val resp = client.newCall(rb.build()).execute()
                val body = resp.body?.string() ?: ""
                return Response(resp.code, resp.message, resp.headers.toMultimap(), body, resp.request.url.toString())
            }
        }
        NewPipe.init(downloader, Localization("en", "US"), ContentCountry("US"))
        initialized = true
    }

    /**
     * 提取并返回下载规格。
     * 独立模式（无 ffmpeg）仅支持渐进式流（音视频合一，最高 720p）。
     */
    fun extract(url: String, qualityHint: String?, audioOnly: Boolean): DownloadSpec {
        ensureInit()

        val info = StreamInfo.getInfo(ServiceList.YouTube, url)
        val title = sanitizeName(info.name)

        // 仅音频：选码率最高的 M4A（保存为 .m4a，无需 ffmpeg）
        if (audioOnly) {
            val best = info.audioStreams
                .filter { it.format?.name == "M4A" }
                .maxByOrNull { it.averageBitrate }
                ?: info.audioStreams.maxByOrNull { it.averageBitrate }
                ?: throw RuntimeException("YouTube: 未找到音频流")
            val ext = if (best.format?.name == "M4A") "m4a" else "webm"
            return DownloadSpec(
                title = title,
                fileName = "$title [${info.id}].$ext",
                urls = listOf(best.content),
                totalBytes = 0, // 大小从下载响应的 Content-Length 获取
            )
        }

        // 视频：渐进式流（!isVideoOnly），按清晰度上限挑选
        val maxHeight = qualityHint?.toIntOrNull() ?: Int.MAX_VALUE
        val progressive = info.videoStreams
            .filter { !it.isVideoOnly && it.format?.name == "MPEG_4" && it.height > 0 && it.height <= maxHeight }
            .sortedByDescending { it.height }
        val chosen = progressive.firstOrNull()
            ?: info.videoStreams.filter { !it.isVideoOnly && it.format?.name == "MPEG_4" }.minByOrNull { it.height }
            ?: throw RuntimeException("YouTube: 未找到可用的渐进式视频流（360p/720p）")
        return DownloadSpec(
            title = title,
            fileName = "$title [${info.id}].mp4",
            urls = listOf(chosen.content),
            totalBytes = 0, // 大小从下载响应的 Content-Length 获取
        )
    }

    private fun sanitizeName(s: String): String =
        s.replace(Regex("[\\\\/:*?\"<>|#\\r\\n\\t]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
            .take(80)
            .ifBlank { "youtube_video" }
}
