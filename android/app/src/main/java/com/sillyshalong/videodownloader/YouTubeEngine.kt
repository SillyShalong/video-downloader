package com.sillyshalong.videodownloader

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.exceptions.AgeRestrictedContentException
import org.schabi.newpipe.extractor.exceptions.ContentNotAvailableException
import org.schabi.newpipe.extractor.exceptions.ContentNotSupportedException
import org.schabi.newpipe.extractor.exceptions.ExtractionException
import org.schabi.newpipe.extractor.exceptions.GeographicRestrictionException
import org.schabi.newpipe.extractor.exceptions.PaidContentException
import org.schabi.newpipe.extractor.exceptions.PrivateContentException
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import org.schabi.newpipe.extractor.exceptions.SignInConfirmNotBotException
import org.schabi.newpipe.extractor.exceptions.UnsupportedContentInCountryException
import org.schabi.newpipe.extractor.localization.ContentCountry
import org.schabi.newpipe.extractor.localization.Localization
import org.schabi.newpipe.extractor.playlist.PlaylistInfo
import org.schabi.newpipe.extractor.services.youtube.ItagItem
import org.schabi.newpipe.extractor.stream.AudioStream
import org.schabi.newpipe.extractor.stream.AudioTrackType
import org.schabi.newpipe.extractor.stream.StreamInfo
import org.schabi.newpipe.extractor.stream.StreamInfoItem
import org.schabi.newpipe.extractor.stream.StreamType
import org.schabi.newpipe.extractor.stream.VideoStream
import java.io.IOException
import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread

/**
 * YouTube 取流引擎（独立运行，不依赖 yt-dlp / 电脑）。
 *
 * 适配层：YouTube 的签名反解、播放器参数等由上游库 NewPipeExtractor（GPLv3）跟进维护，
 * 这里只负责三件事——
 *   1. 把上游库的网络请求接到我们自己的 OkHttp 客户端（统一的 UA / 代理 / 取消）；
 *   2. StreamInfo → 选流策略（见 [extract]）；
 *   3. 把上游的异常翻译成用户看得懂的原因。
 * 上游 API 有变动时只需要改这一个文件（上游源码在 opt/android-dev/ref/ 对照阅读）。
 *
 * 选流策略（与桌面端「锁定 H.264 + AAC」一致，保证各平台播放器都能放）：
 *   · 仅音频：码率最高的 AAC（m4a）
 *   · 视频：不超过所选清晰度的最高 H.264 纯视频流 + AAC 音频流，下载后用 Mp4Muxer 合成一个 MP4
 *     （YouTube 现代视频的音视频是分离的；合一的渐进式流只剩老视频的 360p/720p）
 */
object YouTubeEngine {
    private const val TAG = "YouTubeEngine"

    /** 选中的一路流 */
    class Stream(val itag: Int, val url: String, val label: String)

    class Extraction(
        val id: String,
        val title: String,
        val durationSec: Long,
        /** 纯视频流（需要和 [audio] 合成）；[muxed] 为 true 时它本身已含音频 */
        val video: Stream?,
        val audio: Stream?,
        val muxed: Boolean,
    )

    @Volatile private var initialized = false
    private val currentFlag = ThreadLocal<CancelFlag?>()

    private val downloader = object : Downloader() {
        override fun execute(request: Request): Response {
            val rb = okhttp3.Request.Builder().url(request.url())
            for ((name, values) in request.headers()) for (v in values) rb.addHeader(name, v)
            if (request.headers()["User-Agent"].isNullOrEmpty()) rb.header("User-Agent", Http.UA)
            // 必须带上 method 和请求体：播放器接口是 POST，漏了会退化成 GET 而拿到 405/HTML
            val data = request.dataToSend()
            if (data != null) {
                val type = request.headers()["Content-Type"]?.firstOrNull()?.toMediaType()
                rb.method(request.httpMethod(), data.toRequestBody(type))
            }
            val call = Http.okHttpClient().newCall(rb.build())
            currentFlag.get()?.onCancel { call.cancel() }
            val resp = call.execute()
            return Response(
                resp.code,
                resp.message,
                resp.headers.toMultimap(),
                resp.body?.string() ?: "",
                resp.request.url.toString(),
            )
        }
    }

    @Synchronized
    private fun ensureInit() {
        if (initialized) return
        NewPipe.init(downloader, Localization("en", "US"), ContentCountry("US"))
        initialized = true
    }

    /** 取流信息。[quality] 是清晰度上限（"1080" / "720" / …），null 表示不限 */
    fun extract(url: String, quality: String?, audioOnly: Boolean, flag: CancelFlag): Extraction {
        ensureInit()
        val info = runCancellable(flag, "解析视频") { StreamInfo.getInfo(ServiceList.YouTube, url) }
        if (info.streamType == StreamType.LIVE_STREAM || info.streamType == StreamType.AUDIO_LIVE_STREAM) {
            throw Http.ApiException("这是正在进行的直播，暂不支持下载直播")
        }
        val maxHeight = quality?.toIntOrNull() ?: Int.MAX_VALUE
        val title = info.name.ifBlank { info.id }
        val audio = pickAudio(info.audioStreams)

        if (audioOnly) {
            val a = audio ?: throw Http.ApiException("这个视频没有可用的 AAC 音频流，无法保存为音频文件")
            return Extraction(info.id, title, info.duration, null, a, false)
        }

        val videoOnly = info.videoOnlyStreams.filter { it.isVideoOnly }
        val video = pickVideo(videoOnly, maxHeight)
        if (video != null) {
            val a = audio ?: run {
                // 没有独立音频流时退到音视频合一的流
                val muxed = pickVideo(info.videoStreams.filter { !it.isVideoOnly }, maxHeight)
                    ?: throw Http.ApiException("这个视频没有可用的音频流，无法合成 MP4")
                return Extraction(info.id, title, info.duration, muxed, null, true)
            }
            return Extraction(info.id, title, info.duration, video, a, false)
        }
        // 没有 H.264 纯视频流：用音视频合一的流（老视频）
        val muxed = pickVideo(info.videoStreams.filter { !it.isVideoOnly }, maxHeight)
        if (muxed != null) return Extraction(info.id, title, info.duration, muxed, null, true)
        throw Http.ApiException(
            "没有找到不超过 ${if (maxHeight == Int.MAX_VALUE) "所选" else "${maxHeight}p"}清晰度的 H.264 视频流（共 ${videoOnly.size + info.videoStreams.size} 条候选）",
        )
    }

    /** 链接是播放列表时返回全部选集，否则 null（单个视频 / 短链） */
    fun probe(url: String, flag: CancelFlag): List<Episode>? {
        val hasVideo = Urls.queryParam(url, "v") != null || Regex("youtu\\.be/[^/?#]+|/shorts/|/embed/|/live/").containsMatchIn(url)
        if (hasVideo || Urls.queryParam(url, "list") == null) return null
        ensureInit()
        val info = runCancellable(flag, "解析播放列表") { PlaylistInfo.getInfo(ServiceList.YouTube, url) }
        return info.relatedItems.filterIsInstance<StreamInfoItem>().map { Episode(it.url, it.name, it.duration) }
    }

    /* ---------------- 选流 ---------------- */

    private fun isAac(s: AudioStream) = s.format == org.schabi.newpipe.extractor.MediaFormat.M4A

    private fun pickAudio(streams: List<AudioStream>): Stream? {
        if (streams.isEmpty()) return null
        // 多音轨（配音/旁白）时优先原声
        val original = streams.filter { it.audioTrackType == AudioTrackType.ORIGINAL }
        return (original.ifEmpty { streams })
            .filter { isAac(it) }
            .maxByOrNull { it.averageBitrate }
            ?.let { Stream(it.itag, it.content, "音频 ${it.itag}") }
    }

    /** 不超过 [maxHeight] 的最高 H.264 流；竖屏视频的「清晰度」按短边算 */
    private fun pickVideo(streams: List<VideoStream>, maxHeight: Int): Stream? = streams
        .filter { it.codec?.startsWith("avc") == true && it.isUrl }
        .map { it to shortSide(it) }
        .filter { (_, side) -> side in 1..maxHeight }
        .maxWithOrNull(compareBy({ it.second }, { it.first.itagItem?.fps ?: 0 }))
        ?.let { (s, side) -> Stream(s.itag, s.content, if (side > 0) "${side}p" else "视频") }

    private fun shortSide(s: VideoStream): Int {
        val item: ItagItem? = s.itagItem
        val w = item?.width ?: 0
        val h = item?.height ?: 0
        if (w > 0 && h > 0) return minOf(w, h)
        // 尺寸未知时从 "1080p60" 这样的描述里取
        return Regex("(\\d{3,4})p").find(s.resolution ?: "")?.groupValues?.get(1)?.toIntOrNull() ?: 0
    }

    /* ---------------- 线程与取消 ---------------- */

    /** 上游库的解析是同步阻塞的：放到独立线程里跑，这样用户点「终止」能立刻响应 */
    private fun <T> runCancellable(flag: CancelFlag, what: String, block: () -> T): T {
        val done = CountDownLatch(1)
        val result = arrayOfNulls<Any>(1)
        var error: Throwable? = null
        flag.onCancel { done.countDown() }
        currentFlag.set(flag)
        try {
            val worker = thread(isDaemon = true, name = "yt-extract") {
                try {
                    result[0] = block()
                } catch (e: Throwable) {
                    error = e
                } finally {
                    done.countDown()
                }
            }
            done.await()
            flag.throwIfCancelled()
            when (val e = error) {
                null -> {
                    @Suppress("UNCHECKED_CAST")
                    return result[0] as T
                }
                is Exception -> throw translate(what, e)
                else -> throw e
            }
        } finally {
            currentFlag.remove()
        }
    }

    /** 把上游异常翻译成面向用户的原因 */
    private fun translate(what: String, e: Exception): Exception = when (e) {
        is Http.ApiException -> e
        is AgeRestrictedContentException -> Http.ApiException("这个视频有年龄限制，手机独立模式无法下载（请在电脑版登录后下载）")
        is PrivateContentException -> Http.ApiException("这是私享视频，无法下载")
        is PaidContentException -> Http.ApiException("这是付费内容，无法下载")
        is UnsupportedContentInCountryException, is GeographicRestrictionException ->
            Http.ApiException("这个视频在当前网络所在地区不可用（可在设置里配置代理后重试）")
        is ContentNotSupportedException -> Http.ApiException("暂不支持这种内容类型（直播、互动视频等）")
        is SignInConfirmNotBotException -> Http.ApiException("YouTube 要求登录以确认不是机器人：请在设置里配置代理后重试")
        is ContentNotAvailableException -> Http.ApiException("视频不可用：${e.message?.take(160) ?: "可能已删除"}")
        is ReCaptchaException -> Http.ApiException("被 YouTube 人机验证拦截：请在设置里配置代理后重试")
        is ExtractionException -> Http.ApiException("${what}失败：${e.message?.take(160) ?: e.javaClass.simpleName}")
        is IOException -> e // 网络错误交给任务引擎统一措辞
        else -> e
    }
}
