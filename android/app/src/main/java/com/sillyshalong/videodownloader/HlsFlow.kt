package com.sillyshalong.videodownloader

import com.sillyshalong.videodownloader.mp4.ExtractorSampleSource
import com.sillyshalong.videodownloader.mp4.Mp4Muxer
import com.sillyshalong.videodownloader.mp4.Mp4Reader
import com.sillyshalong.videodownloader.mp4.Mp4SampleSource
import com.sillyshalong.videodownloader.mp4.Mp4Writer
import com.sillyshalong.videodownloader.mp4.TsDemuxer
import java.io.File
import java.io.RandomAccessFile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * HLS 任务的下载流程（Cloudflare 防护的流媒体站点、直接的 m3u8 链接）：
 *   1. 找到播放列表地址（网页链接要先加载页面；遇到人机验证就把网页显示给用户）
 *   2. 读播放列表、选清晰度
 *   3. 逐段下载到缓存（AES-128 解密；分段地址过期时刷新播放列表；暂停 / 失败后从断点继续）
 *   4. 合成 MP4 写进保存目标，清理缓存
 *
 * 缓存里记着「已下到第几段」，所以任务失败了再点重试、或者暂停后恢复，都从没下完的那一段接着下。
 */
internal object HlsFlow {
    private const val DOWNLOAD_FROM = 5.0
    private const val DOWNLOAD_TO = 80.0
    private const val MUX_FROM = 80.0

    fun run(engine: TaskEngine, t: Task, flag: CancelFlag) {
        val dir = engine.partDir(t)
        if (!dir.isDirectory && !dir.mkdirs()) throw Http.ApiException("无法创建缓存目录（存储空间不足？）")

        // 清晰度上限（短边像素）：没选就是不限
        val maxSide = t.quality?.toIntOrNull() ?: Int.MAX_VALUE

        // 1) 找到播放列表地址
        var found = if (Urls.isDirectPlaylist(t.url)) {
            HlsEngine.Result(t.url, t.url, null, emptyMap())
        } else {
            engine.stage(t, "打开网页查找视频地址")
            HlsEngine.extract(t.url, flag, maxSide).also { it.note?.let { n -> engine.log(t, n) } }
        }
        val headers = HashMap(found.headers)

        /** 2) 读播放列表、选清晰度（刷新分段地址时也会再调一次） */
        fun load(logQuality: Boolean = false): HlsPlaylist.Media {
            val text = Http.text(found.m3u8Url, headers, flag)
            if (!HlsPlaylist.isMaster(text)) return HlsPlaylist.parseMedia(text, found.m3u8Url)
            val variant = HlsPlaylist.pick(HlsPlaylist.parseMaster(text, found.m3u8Url), maxSide)
            if (logQuality && variant.width > 0) {
                engine.log(t, "清晰度 ${minOf(variant.width, variant.height)}p${variant.codecs?.let { "（$it）" } ?: ""}")
            }
            return HlsPlaylist.parseMedia(Http.text(variant.uri, headers, flag), variant.uri)
        }

        engine.stage(t, "读取播放列表")
        val media = load(logQuality = true)
        if (!media.ended) engine.log(t, "这个流没有结束标记（可能是直播），只能下载当前已有的 ${media.segments.size} 段")
        val title = Storage.sanitizeFileName(found.title ?: defaultName(found.pageUrl))
        engine.setTitle(t, title)

        // 3) 逐段下载到缓存
        val fmp4 = media.initUri != null
        val raw = File(dir, if (fmp4) "stream.mp4" else "stream.ts")
        val state = File(dir, "stream.done")
        engine.stage(t, "下载视频分段（共 ${media.segments.size} 段）")
        var lastBytes = raw.length()
        var lastTs = System.currentTimeMillis()
        var speed = 0L
        HlsDownloader.download(
            media,
            headers,
            raw,
            state,
            flag,
            { done, total ->
                flag.throwIfCancelled()
                val now = System.currentTimeMillis()
                val len = raw.length()
                if (now - lastTs >= 500) {
                    val inst = (len - lastBytes) * 1000 / (now - lastTs)
                    speed = if (speed > 0) (speed + inst) / 2 else inst
                    lastBytes = len
                    lastTs = now
                }
                t.update {
                    percent = DOWNLOAD_FROM + (DOWNLOAD_TO - DOWNLOAD_FROM) * done / total
                    downloaded = len
                    this.speed = if (speed > 0) speed else null
                    this.eta = null
                }
                engine.emitProgress(t)
            },
            onLog = { engine.log(t, it) },
        ) {
            // 分段地址过期时：重新读一遍播放列表换新地址
            try {
                load()
            } catch (e: Http.HttpException) {
                // 播放列表地址本身也失效了：回到网页重新找一遍（网页的 Cookie 也一并更新）
                if (Urls.isDirectPlaylist(t.url) || (e.code != 401 && e.code != 403 && e.code != 410)) throw e
                engine.log(t, "播放列表地址已失效，重新打开网页获取")
                found = HlsEngine.extract(t.url, flag, maxSide)
                headers.clear()
                headers.putAll(found.headers)
                load()
            }
        }

        // 4) 合成 MP4 写进保存目标
        engine.stage(t, "转换成 MP4")
        // 在缓存里的 TS 末尾补一个「下一帧」，让系统的 TS 解析器把最后一个真实帧交出来（见 TsTail）
        val rawLength = raw.length()
        if (!fmp4) {
            val next = ExtractorSampleSource.firstVideoSample(raw)
            if (next != null) TsTail.appendNextFrame(raw, next)
        }
        try {
            mux(engine, t, raw, fmp4, title, flag, media.totalDuration)
        } catch (e: CancelledException) {
            throw e
        } catch (e: Exception) {
            if (fmp4) {
                // 分段本身就是 MP4 却合不成：重试也是同样的结果，缓存留着只会占地方
                dir.deleteRecursively()
                throw e
            }
            // TS 里是系统认不了的编码：转不成 MP4，就把原始 TS 流直接存下来（VLC 这类播放器能放）
            engine.log(t, "无法转换成 MP4（${engine.friendly(e)}），改为保存原始的 TS 流")
            RandomAccessFile(raw, "rw").use { it.setLength(rawLength) } // 存原始文件，去掉补的收尾包
            // 用通用类型存入：系统如果认为是 video/mp2t 会把文件名改成 xxx.ts.m2ts
            engine.saveCacheFile(t, raw, "$title.ts", "application/octet-stream")
        }
        dir.deleteRecursively()
    }

    private fun mux(engine: TaskEngine, t: Task, raw: File, fmp4: Boolean, title: String, flag: CancelFlag, expectedSeconds: Double) {
        val sink = engine.openSink(t, "$title.mp4", "video/mp4")
        var committed = false
        try {
            t.update { file = sink.displayPath }
            // progress() 的区间是 0~1 的比例（MUX_FROM 是百分数）：以前直接传了 80，合成阶段进度一直显示 100%
            val progress = engine.progress(t, flag, MUX_FROM / 100.0, 1.0)
            val size: Long
            if (fmp4) {
                // 分段本来就是 MP4：把各条轨道原样搬进一个普通 MP4（时间戳、编解码配置逐项保留）
                Mp4Reader(raw).use { r ->
                    val sources = r.tracks
                        .filter { it.handler == Mp4Writer.HANDLER_VIDEO || it.handler == Mp4Writer.HANDLER_AUDIO }
                        .sortedBy { if (it.handler == Mp4Writer.HANDLER_VIDEO) 0 else 1 }
                        .map { Mp4SampleSource(r, it) }
                    if (sources.isEmpty()) throw Http.ApiException("视频流里没有可用的音视频轨")
                    size = Mp4Muxer.mux(sources, sink.outputStream) { done, total -> progress.onProgress(done, total, 0) }
                }
            } else {
                // MPEG-TS：用系统 MediaExtractor 读出音视频轨。整个文件只开一个解析器实例（见 TsDemuxer）
                TsDemuxer(raw).use { demuxer ->
                    val video = demuxer.source("video")
                    val audio = try {
                        demuxer.source("audio")
                    } catch (e: Http.ApiException) {
                        null
                    }
                    // 各路轨道先读到开头（音频轨的真实起点要读过开头才确定），
                    // 再统一平移，让整份文件最早的一帧从 0 开始（TS 流常常从 1.4 秒之类的位置起算），
                    // 各路之间的相对先后保持不变
                    video.prime()
                    audio?.prime()
                    val offset = minOf(video.firstPtsUs(), audio?.firstPtsUs() ?: Long.MAX_VALUE)
                    video.shiftUs = offset
                    audio?.shiftUs = offset
                    size = Mp4Muxer.mux(listOfNotNull(video, audio), sink.outputStream) { done, total -> progress.onProgress(done, total, 0) }
                    // 系统解析器中途出错时，「读不出来」和「读完了」在接口上没有区别：
                    // 按播放列表的总时长核对一遍，别把半截文件当成成功的
                    demuxer.assertComplete(expectedSeconds)
                }
            }
            sink.outputStream.flush()
            sink.commit()
            committed = true
            engine.markSaved(t, sink, size, 100.0)
        } finally {
            sink.close()
            if (!committed) sink.abort()
        }
    }

    /** 网页没有可用标题时的文件名（精确到秒：一次加好几个链接时别都挤在同一分钟里重名） */
    private fun defaultName(pageUrl: String): String {
        val host = Urls.host(pageUrl)?.removePrefix("www.")?.take(24) ?: "video"
        val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        return "video_${host}_$stamp"
    }
}
