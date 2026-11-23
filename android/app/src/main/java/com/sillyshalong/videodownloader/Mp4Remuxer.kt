package com.sillyshalong.videodownloader

import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File

/**
 * 无转码 MP4 封装器：把两个已完整下载的流文件（纯视频 + 纯音频，mp4/webm 容器）
 * 用平台 MediaExtractor/MediaMuxer 封装成单个 MP4。
 *
 * 实现：MediaExtractor 顺序抽取两轨的全部 sample（pts + 数据）到内存索引与临时缓冲，
 * 按 pts 交错写入 MediaMuxer。视频文件一般在几十到几百 MB，sample 数据流式读写，
 * 峰值内存 = 单个 sample 大小（<1MB）。
 */
object Mp4Remuxer {

    class Result(val durationMs: Long)

    fun mux(videoFile: File, audioFile: File, output: File): Result {
        // 阶段 1：抽取两轨全部 sample 数据到临时文件 + 元数据索引（按 pts 排序）
        val v = extractTrack(videoFile, "video")
        val a = extractTrack(audioFile, "audio")
        require(v.format != null) { "视频文件中未找到视频轨" }
        require(a.format != null) { "音频文件中未找到音频轨" }

        // 阶段 2：按 pts 交错写入 MediaMuxer
        var muxer: MediaMuxer? = null
        try {
            muxer = MediaMuxer(output.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            val vDst = try {
                muxer.addTrack(v.format!!)
            } catch (e: Exception) {
                throw RuntimeException("addTrack(video) 失败: " + v.format + " / " + e.message, e)
            }
            val aDst = try {
                muxer.addTrack(a.format!!)
            } catch (e: Exception) {
                throw RuntimeException("addTrack(audio) 失败: " + a.format + " / " + e.message, e)
            }
            muxer.start()

            val buf = ByteArray(v.maxSample.coerceAtLeast(a.maxSample).coerceAtLeast(64 * 1024))
            var vi = 0
            var ai = 0
            var last = 0L
            while (vi < v.samples.size || ai < a.samples.size) {
                val takeVideo = vi < v.samples.size &&
                    (ai >= a.samples.size || v.samples[vi].pts <= a.samples[ai].pts)
                val s: Sample
                val dataFile: File
                val dst: Int
                if (takeVideo) {
                    s = v.samples[vi]; dataFile = v.dataFile; dst = vDst; vi++
                } else {
                    s = a.samples[ai]; dataFile = a.dataFile; dst = aDst; ai++
                }
                java.io.RandomAccessFile(dataFile, "r").use { raf ->
                    raf.seek(s.offset)
                    val n = raf.read(buf, 0, s.size)
                    val info = android.media.MediaCodec.BufferInfo()
                    info.set(0, n, s.pts, s.flags)
                    muxer.writeSampleData(dst, java.nio.ByteBuffer.wrap(buf, 0, n), info)
                    last = s.pts
                }
            }

            muxer.stop()
            return Result(last / 1000)
        } catch (e: Exception) {
            if (output.exists()) output.delete()
            throw e
        } finally {
            try { muxer?.release() } catch (_: Exception) {}
            v.cleanup()
            a.cleanup()
        }
    }

    private class Sample(val pts: Long, val offset: Long, val size: Int, val flags: Int)

    private class TrackData(
        val format: MediaFormat?,
        val samples: List<Sample>,
        val dataFile: File,
        val maxSample: Int,
    ) {
        fun cleanup() = dataFile.delete()
    }

    /** 把一轨的全部 sample（数据 + 元数据）抽到临时文件，返回格式/索引 */
    private fun extractTrack(source: File, tag: String): TrackData {
        val ex = MediaExtractor()
        lateinit var dataFile: File
        try {
            ex.setDataSource(source.absolutePath)
            var track = -1
            var format: MediaFormat? = null
            var maxSample = 0
            for (i in 0 until ex.trackCount) {
                val f = ex.getTrackFormat(i)
                val mime = f.getString(MediaFormat.KEY_MIME) ?: ""
                if (mime.startsWith(tag) ) {
                    track = i
                    format = f
                    maxSample = if (f.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
                        f.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE)
                    } else 0
                    break
                }
            }
            require(track >= 0) { "未找到 ${tag} 轨" }

            ex.selectTrack(track)
            dataFile = File.createTempFile("vd-$tag-", ".bin")
            val samples = ArrayList<Sample>(4096)
            var offset = 0L
            val info = android.media.MediaCodec.BufferInfo()
            java.io.FileOutputStream(dataFile).use { out ->
                val buf = ByteArray(maxSample.coerceAtLeast(256 * 1024))
                while (true) {
                    val idx = ex.sampleTrackIndex
                    if (idx < 0) break
                    val n = ex.readSampleData(java.nio.ByteBuffer.wrap(buf), 0)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    samples.add(Sample(ex.sampleTime, offset, n, ex.sampleFlags))
                    offset += n
                    if (n > maxSample) maxSample = n
                    ex.advance()
                }
            }
            ex.unselectTrack(track)
            return TrackData(format, samples, dataFile, maxSample)
        } catch (e: Exception) {
            ex.release()
            // extractTrack 内部失败时也要清理可能已建的临时文件
            throw e
        } finally {
            ex.release()
        }
    }
}
