package com.sillyshalong.videodownloader.mp4

import java.io.OutputStream

/** 一个待写入的 sample */
class Sample(
    /** 解码时间（轨道时间刻度），必须严格递增 */
    val dts: Long,
    /** 显示偏移 = 显示时间 - 解码时间 */
    val cts: Long,
    val size: Int,
    val sync: Boolean,
    /** sample description 序号（从 1 开始） */
    val descIndex: Int,
    /** 解码时间换算成微秒，只用于各轨道之间的交错排序 */
    val timeUs: Double,
)

/**
 * 一路按解码顺序排好的 sample 流。两种实现：
 *  - [Mp4SampleSource]：来自现成的 MP4 / M4A 文件（时间戳、编解码配置原样搬运）
 *  - ExtractorSampleSource：来自 TS / FLV 等，经系统 MediaExtractor 读出（显示时间已知，解码时间按规则合成）
 */
interface SampleSource {
    val spec: Mp4Writer.TrackSpec

    /** 总字节数（进度用） */
    val totalBytes: Long

    /** 最大的单个 sample 的字节数（调用方据此准备缓冲区） */
    val maxSampleSize: Int

    /** 当前 sample（还没读出来的那个）；没有更多时返回 null */
    fun current(): Sample?

    /** 把当前 sample 读进 [buf] 并前进 */
    fun read(buf: ByteArray)

    fun close()
}

/** 把 MP4 / M4A 文件里的一条轨道当作 sample 流 */
class Mp4SampleSource(private val reader: Mp4Reader, val track: Mp4Reader.Track) : SampleSource {
    override val spec = Mp4Writer.TrackSpec(
        handler = track.handler,
        entries = track.entries,
        timescale = track.timescale,
        matrix = track.matrix,
        width = track.width,
        height = track.height,
        volume = if (track.handler == Mp4Writer.HANDLER_AUDIO) 0x0100 else 0,
        edits = track.edits,
        lastDuration = track.lastDuration,
    )
    override val totalBytes: Long = track.sizes.fold(0L) { acc, v -> acc + v }
    override val maxSampleSize: Int = track.sizes.fold(0L) { acc, v -> maxOf(acc, v) }.toInt()

    private var index = 0

    override fun current(): Sample? {
        val i = index
        if (i >= track.sampleCount) return null
        return Sample(
            dts = track.dts[i],
            cts = track.cts[i],
            size = track.sizes[i].toInt(),
            sync = track.sync?.get(i) ?: true,
            descIndex = track.descIndex[i],
            timeUs = track.timeUs(track.dts[i]),
        )
    }

    override fun read(buf: ByteArray) {
        reader.readSample(track, index, buf)
        index++
    }

    override fun close() {
        reader.close()
    }
}

/**
 * 把多路 sample 流交错写成一个 MP4。
 *
 * 交错策略：每次取「解码时间最早」的一路，连续写出它约 0.5 秒的 sample，再换下一路。
 * 这样既保证任意时刻音视频数据在文件里都挨得够近（播放器顺序读就能放），
 * 又不会每个 sample 都新开一个 chunk（否则 stsc 表会有几十万条）。
 */
object Mp4Muxer {
    /** 一次连续写入的时长上限（微秒） */
    private const val INTERLEAVE_WINDOW_US = 500_000.0

    /**
     * @param onProgress （已写字节数， 总字节数），在写数据阶段回调
     * @return 写出的文件大小
     */
    fun mux(sources: List<SampleSource>, out: OutputStream, onProgress: ((Long, Long) -> Unit)? = null): Long {
        if (sources.isEmpty()) throw IllegalArgumentException("至少要有一路 sample 流")
        val writer = Mp4Writer(out)
        for (s in sources) writer.addTrack(s.spec)
        writer.start()
        val total = sources.fold(0L) { acc, s -> acc + s.totalBytes }
        var buf = ByteArray(sources.fold(1) { acc, s -> maxOf(acc, s.maxSampleSize) })
        val cursors = Array(sources.size) { sources[it].current() }
        var done = 0L
        while (true) {
            var pick = -1
            for (i in cursors.indices) {
                val c = cursors[i] ?: continue
                if (pick < 0 || c.timeUs < cursors[pick]!!.timeUs) pick = i
            }
            if (pick < 0) break
            val src = sources[pick]
            val windowEnd = cursors[pick]!!.timeUs + INTERLEAVE_WINDOW_US
            while (true) {
                val s = cursors[pick] ?: break
                if (s.size > buf.size) buf = ByteArray(s.size) // 有的来源事先不知道最大的 sample 有多大
                src.read(buf)
                writer.writeSample(pick, buf, 0, s.size, s.dts, s.cts, s.sync, s.descIndex)
                done += s.size
                val next = src.current()
                cursors[pick] = next
                if (next == null || next.timeUs >= windowEnd) break
            }
            onProgress?.invoke(done, total)
        }
        onProgress?.invoke(total, total)
        writer.finish()
        return writer.bytesWritten
    }
}
