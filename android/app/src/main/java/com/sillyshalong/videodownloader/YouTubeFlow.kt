package com.sillyshalong.videodownloader

import com.sillyshalong.videodownloader.mp4.Mp4Muxer
import com.sillyshalong.videodownloader.mp4.Mp4Reader
import com.sillyshalong.videodownloader.mp4.Mp4SampleSource
import com.sillyshalong.videodownloader.mp4.Mp4Writer
import java.io.File

/**
 * YouTube 任务的下载流程。
 *
 * YouTube 现代视频的音视频是分离的（视频流是分片 MP4，音频流是 m4a），所以：
 *   1. 视频流、音频流分别下到应用缓存（保留 .part，暂停后恢复时从断点继续）
 *   2. 用 Mp4Muxer 把两路流合成一个 MP4，直接顺序写进保存目标（不再产生第二份临时文件）
 *   3. 删除缓存
 * 仅音频、或老视频的音视频合一流：单文件直接写入保存目标。
 */
internal object YouTubeFlow {
    /** 三个阶段各占总进度的比例：视频流 / 音频流 / 合成 */
    private const val VIDEO_FROM = 0.0
    private const val VIDEO_TO = 0.6
    private const val AUDIO_FROM = 0.6
    private const val AUDIO_TO = 0.8
    private const val MUX_FROM = 0.8

    fun run(engine: TaskEngine, t: Task, flag: CancelFlag) {
        var ex = YouTubeEngine.extract(t.url, t.quality, t.audio, flag)
        val title = Storage.sanitizeFileName(ex.title)
        engine.setTitle(t, ex.title)
        val safeId = ex.id.replace(Regex("[^A-Za-z0-9_-]"), "")

        /** 重新解析一遍（下载地址带有效期，过期后要换新的），标题也跟着更新 */
        fun reextract(): YouTubeEngine.Extraction = YouTubeEngine.extract(t.url, t.quality, t.audio, flag).also {
            ex = it
            engine.setTitle(t, it.title)
        }

        // ---- 单文件：仅音频 / 音视频合一 ----
        val audioOnly = ex.video == null
        val single = ex.video ?: ex.audio
        if (ex.muxed || audioOnly) {
            val stream = single ?: throw Http.ApiException("没有找到可下载的媒体流")
            val ext = if (audioOnly) "m4a" else "mp4"
            val mime = if (audioOnly) "audio/mp4" else "video/mp4"
            engine.stage(t, if (audioOnly) "下载音频流" else "下载视频流")
            engine.saveResumable(
                t,
                DownloadSpec(ex.title, "$title [$safeId].$ext", stream.url, mime = mime),
                flag,
            // 地址过期时重新解析一遍，换新地址从断点继续
            ) {
                val fresh = reextract()
                val s = fresh.video ?: fresh.audio ?: throw Http.ApiException("没有找到可下载的媒体流")
                DownloadSpec(fresh.title, "$title [$safeId].$ext", s.url, mime = mime)
            }
            return
        }

        // ---- 两路流：先下到缓存，再合成 ----
        val audio = ex.audio ?: throw Http.ApiException("没有找到音频流")
        val dir = engine.partDir(t)
        if (!dir.isDirectory && !dir.mkdirs()) throw Http.ApiException("无法创建缓存目录（存储空间不足？）")
        val videoFile = File(dir, "video.mp4")
        val audioFile = File(dir, "audio.m4a")

        fun specOf(url: String, name: String, mime: String) = DownloadSpec(ex.title, name, url, mime = mime)

        fun resumed(label: String): (Long) -> Unit = { bytes ->
            // 「视频流从断点继续（已有 14 MB）」：和 B站的「从断点继续（已有 N MB）」是同一种写法
            engine.log(t, if (label == "视频流") "${label}从断点继续（已有 ${bytes / 1024 / 1024} MB）" else "${label}从断点继续（已有 ${bytes / 1024} KB）")
        }

        engine.stage(t, "下载视频流（${ex.video!!.label}）")
        engine.log(t, "视频流 itag ${ex.video!!.itag}（${ex.video!!.label}）· 音频流 itag ${audio.itag}")
        val video = ex.video!!
        HttpDownloader.toFile(
            specOf(video.url, "video.mp4", "video/mp4"),
            videoFile,
            flag,
            engine.progress(t, flag, VIDEO_FROM, VIDEO_TO),
            onResumed = resumed("视频流"),
            onLog = { engine.log(t, it) },
            // 地址过期：重新解析，换新地址从断点继续
            refresh = { reextract().video?.let { specOf(it.url, "video.mp4", "video/mp4") } ?: throw Http.ApiException("重新解析后没有找到视频流") },
        )
        engine.stage(t, "下载音频流")
        HttpDownloader.toFile(
            specOf(audio.url, "audio.m4a", "audio/mp4"),
            audioFile,
            flag,
            engine.progress(t, flag, AUDIO_FROM, AUDIO_TO),
            onResumed = resumed("音频流"),
            onLog = { engine.log(t, it) },
            refresh = { reextract().audio?.let { specOf(it.url, "audio.m4a", "audio/mp4") } ?: throw Http.ApiException("重新解析后没有找到音频流") },
        )

        engine.stage(t, "合成音视频")
        t.update { percent = MUX_FROM * 100 }
        val sink = engine.openSink(t, "$title [$safeId].mp4", "video/mp4")
        var committed = false
        try {
            t.update { file = sink.displayPath }
            Mp4Reader(videoFile).use { vr ->
                Mp4Reader(audioFile).use { ar ->
                    val vTrack = vr.tracks.firstOrNull { it.handler == Mp4Writer.HANDLER_VIDEO }
                        ?: throw Http.ApiException("视频流文件里没有视频轨")
                    val aTrack = ar.tracks.firstOrNull { it.handler == Mp4Writer.HANDLER_AUDIO }
                        ?: throw Http.ApiException("音频流文件里没有音频轨")
                    val progress = engine.progress(t, flag, MUX_FROM, 1.0)
                    val size = Mp4Muxer.mux(listOf(Mp4SampleSource(vr, vTrack), Mp4SampleSource(ar, aTrack)), sink.outputStream) { done, total ->
                        progress.onProgress(done, total, 0)
                    }
                    sink.outputStream.flush()
                    sink.commit()
                    committed = true
                    engine.markSaved(t, sink, size, 100.0)
                }
            }
        } catch (e: CancelledException) {
            throw e
        } catch (e: Exception) {
            // 合成失败多半是流文件不完整或损坏：把缓存删掉，重试时重新下载（否则每次重试都在同一处失败）
            dir.deleteRecursively()
            throw e
        } finally {
            sink.close()
            if (!committed) sink.abort()
        }
        dir.deleteRecursively()
    }
}
