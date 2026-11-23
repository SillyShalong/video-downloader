package com.sillyshalong.videodownloader

import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.localization.ContentCountry
import org.schabi.newpipe.extractor.localization.Localization
import org.schabi.newpipe.extractor.stream.AudioStream
import org.schabi.newpipe.extractor.stream.StreamInfo
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.services.youtube.YoutubeParsingHelper
import org.schabi.newpipe.extractor.stream.VideoStream
import java.util.concurrent.TimeUnit

/**
 * YouTube 独立提取引擎——封装层。
 *
 * 内部依赖 NewPipeExtractor（GPLv3）：YouTube 反爬持续对抗（签名/PO token）由上游库
 * 维护跟进；本模块只做三件事：
 *   1. NewPipe 初始化（Downloader 桥接到我们的 OkHttp，统一 UA/Cookie）
 *   2. StreamInfo 提取 → 选流策略：
 *        · 仅音频：码率最高的 M4A
 *        · 视频：H.264 纯视频流（itag 137/136/135/134...）+ AAC 音频流，
 *          下载后由 Mp4Remuxer（MediaMuxer）封装成单个 MP4——最高支持到源的最高清晰度
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
                // YouTube 需要 UA
                if (request.headers()["User-Agent"] == null) rb.header("User-Agent", DESKTOP_UA)
                // 关键：转发 method + body（之前漏发 body，player 请求全部退化为 GET → 405/HTML）
                val data = request.dataToSend()
                if (data != null) {
                    rb.method(
                        request.httpMethod(),
                        request.dataToSend()?.let { bytes ->
                            okhttp3.RequestBody.create(
                                request.headers()["Content-Type"]?.firstOrNull()
                                    ?.let { it.toMediaTypeOrNull() } ?: "application/json".toMediaTypeOrNull(),
                                bytes,
                            )
                        },
                    )
                }
                val resp = client.newCall(rb.build()).execute()
                val body = resp.body?.string() ?: ""
                return Response(resp.code, resp.message, resp.headers.toMultimap(), body, resp.request.url.toString())
            }
        }
        NewPipe.init(downloader, Localization("en", "US"), ContentCountry("US"))
        initialized = true
    }

    /** 提取结果：可能是一路流（音频），也可能是视频+音频两路（合并后成 MP4） */
    class Extraction(
        val title: String,
        /** 主下载（视频流，或仅音频模式下的音频流） */
        val videoSpec: DownloadSpec,
        /** 需要与之合并的音频流；null = 单文件 */
        val audioSpec: DownloadSpec?,
    )

    fun extract(url: String, qualityHint: String?, audioOnly: Boolean): Extraction {
        ensureInit()

        // 诊断：先单独拉一次 visionOS player 响应，dump streamingData
        try {
            val cc = ContentCountry("US")
            val loc = Localization("en", "US")
            val cpn = YoutubeParsingHelper.generateContentPlaybackNonce()
            val raw = org.schabi.newpipe.extractor.services.youtube.YoutubeStreamHelper
                .getVisionOsPlayerResponse(cc, loc, url.substringAfter("v="), cpn)
            val sd = raw.getObject("streamingData")
            println("[YT-diag] visionOS streamingData keys=" + (sd?.keys?.joinToString(",") ?: "null"))
            println("[YT-diag] formats=" + (sd?.getArray("formats")?.size ?: 0) + " adaptive=" + (sd?.getArray("adaptiveFormats")?.size ?: 0))
            if (sd?.has("playabilityStatus") == true) {
                println("[YT-diag] playability=" + sd.getObject("playabilityStatus").get("status"))
            }
        } catch (e: Exception) {
            println("[YT-diag] visionOS 预检失败: " + e.message?.take(300))
        }
        // 诊断增强：提取器内部解析每个流时抛的异常被静默吞掉，这里手动复刻
        // buildAndAddItagInfoToList 的关键步骤（n 参数解码 + itag 表查询）定位失败点
        try {
            val cc0 = ContentCountry("US")
            val loc0 = Localization("en", "US")
            val cpn0 = YoutubeParsingHelper.generateContentPlaybackNonce()
            val raw0 = org.schabi.newpipe.extractor.services.youtube.YoutubeStreamHelper
                .getVisionOsPlayerResponse(cc0, loc0, url.substringAfter("v="), cpn0)
            val adaptive = raw0.getObject("streamingData").getArray("adaptiveFormats")
            for (i in 0 until adaptive.size) {
                val f = adaptive.getObject(i)
                val itag = f.get("itag")
                try {
                    // itag 表查询（不支持的 itag 会在这里抛）
                    val itagItem = org.schabi.newpipe.extractor.services.youtube.ItagItem.getItag(f.getInt("itag"))
                    // n 参数解码（JS 引擎失败会在这里抛）
                    var streamUrl = if (f.has("url")) f.getString("url") else "(cipher)"
                    if (streamUrl.contains("n=")) {
                        val nParam = Regex("[?&]n=([^&]+)").find(streamUrl)?.groupValues?.get(1) ?: ""
                        val decoded = org.schabi.newpipe.extractor.services.youtube.YoutubeJavaScriptPlayerManager
                            .getUrlWithThrottlingParameterDeobfuscated(url.substringAfter("v="), nParam)
                        streamUrl = streamUrl.replace("n=$nParam", "n=$decoded")
                    }
                    println("[YT-diag2] itag=$itag OK h=" + (f.get("height") ?: "?"))
                } catch (e: Exception) {
                    println("[YT-diag2] itag=$itag FAIL: " + (e.message ?: e.javaClass.simpleName).take(160))
                }
            }
        } catch (e: Exception) {
            println("[YT-diag2] 预检异常: " + e.message?.take(200))
        }
        val info = StreamInfo.getInfo(ServiceList.YouTube, url)
        // 主动试一次 n 参数解码：库在 Android 上初始化 JS 引擎失败时异常会在这里暴露
        try {
            org.schabi.newpipe.extractor.services.youtube.YoutubeJavaScriptPlayerManager
                .getUrlWithThrottlingParameterDeobfuscated(info.id, "test_n_param_value")
            println("[YT-diag] n 参数解码 OK")
        } catch (e: Exception) {
            println("[YT-diag] n 参数解码失败: " + e.message?.take(300))
            throw RuntimeException("YouTube JS 引擎初始化失败（n 参数解码）: " + e.message?.take(200), e)
        }
        // 提取器把非致命解析失败收集在 errors 里（如 n 参数解码失败会丢弃对应流）
        if (info.videoStreams.isEmpty() && info.errors.isNotEmpty()) {
            throw RuntimeException(
                "YouTube 提取失败（" + info.errors.size + " 个错误）: " +
                    info.errors.joinToString(" | ") { it.message?.take(400) ?: "" },
            )
        }
        val title = sanitizeName(info.name)
        val maxHeight = qualityHint?.toIntOrNull() ?: Int.MAX_VALUE

        if (audioOnly) {
            val best = pickBestAudio(info.audioStreams)
                ?: throw RuntimeException("YouTube: 未找到音频流")
            val ext = if (isAac(best)) "m4a" else "webm"
            return Extraction(
                title = title,
                videoSpec = DownloadSpec(
                    title = title,
                    fileName = "$title [${info.id}].$ext",
                    urls = listOf(best.content),
                    totalBytes = 0,
                ),
                audioSpec = null,
            )
        }

        // 视频：优先 H.264 纯视频流（itag 137/136/135/134 等，有 codec 元数据），
        // 因为 MediaMuxer 封装 MP4 时 H.264+AAC 兼容性最好
        val video = pickBestVideo(info.videoStreams, maxHeight)
            ?: throw RuntimeException(
                "YouTube: 未找到可用视频流（共 ${info.videoStreams.size} 条: " +
                    info.videoStreams.joinToString("; ") { "${it.height}p/" + (it.itagItem?.codec ?: it.format?.name ?: "?") } +
                    "，上限 ${maxHeight}p）",
            )
        val audio = pickBestAudio(info.audioStreams)
            ?: throw RuntimeException("YouTube: 未找到音频流（无法合成 MP4）")

        val vSpec = DownloadSpec(
            title = title,
            fileName = tempPart(video, title, info.id),
            urls = listOf(video.content),
            totalBytes = 0,
        )
        val aSpec = DownloadSpec(
            title = title,
            fileName = tempPart(audio, title, info.id),
            urls = listOf(audio.content),
            totalBytes = 0,
        )
        return Extraction(title, vSpec, aSpec)
    }

    /* ---------------- 选流 ---------------- */

    private fun isAac(s: AudioStream) = s.format?.name == "M4A"

    private fun pickBestAudio(streams: List<AudioStream>): AudioStream? =
        streams.filter { isAac(it) }.maxByOrNull { it.averageBitrate }
            ?: streams.maxByOrNull { it.averageBitrate }

    private fun pickBestVideo(streams: List<VideoStream>, maxHeight: Int): VideoStream? {
        // codec 信息在 ItagItem.codec（如 avc1.640028）；拿不到 codec 时按 itag 表兜底判断
        fun isH264(v: VideoStream): Boolean {
            val codec = v.itagItem?.codec ?: ""
            return codec.startsWith("avc1") || codec.startsWith("avc3")
        }
        val h264 = streams
            .filter { it.height > 0 && it.height <= maxHeight && isH264(it) }
            .maxByOrNull { it.height }
        if (h264 != null) return h264
        // 无 H.264：选不超过上限的最低清晰度（其他编码 MediaMuxer 可能不支持，宁小勿黑）
        return streams
            .filter { it.height > 0 && it.height <= maxHeight }
            .minByOrNull { it.height }
    }

    private fun tempPart(stream: VideoStream, title: String, id: String): String =
        "${title.take(60)} [$id].${stream.height}p.vpart"

    private fun tempPart(stream: AudioStream, title: String, id: String): String =
        "${title.take(60)} [$id].apart"

    private fun sanitizeName(s: String): String =
        s.replace(Regex("[\\\\/:*?\"<>|#\\r\\n\\t]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
            .take(80)
            .ifBlank { "youtube_video" }
}
