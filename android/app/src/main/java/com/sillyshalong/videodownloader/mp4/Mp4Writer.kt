package com.sillyshalong.videodownloader.mp4

import java.io.Closeable
import java.io.IOException
import java.io.OutputStream

/**
 * MP4 写入器（纯 Kotlin）：把若干条轨道的 sample 顺序写成一个 MP4。
 *
 * 设计目标：
 *  - 顺序写：媒体数据先写（若干个连续的 mdat），moov 最后写。因此可以直接写进
 *    「系统下载目录 / 用户所选目录」的输出流，不必先落临时文件再拷贝一遍。
 *  - 支持 B 帧：每个 sample 带解码时间（dts）和显示偏移（cts），显示顺序 ≠ 解码顺序的视频照常写入。
 *    出现负的显示偏移时自动整体后移，并用编辑列表（elst）抵消，还原出的时间线与源一致，
 *    各平台播放器都能正确还原（与 ffmpeg 默认做法相同）。
 *  - 不关心具体编码：sample entry（avcC / esds / hvcC …）由调用方给原始字节，原样放进 stsd。
 */
class Mp4Writer(private val out: OutputStream, private val movieTimescale: Long = 1000) : Closeable {

    /** 编辑列表的一项。[segmentDuration] 为 0 且 [mediaTime] 为 -1 之外的情况不会出现空编辑 */
    class Edit(val segmentDuration: Long, val segmentTimescale: Long, val mediaTime: Long) {
        companion object {
            /** 空编辑：让这条轨道的起点整体延后 [duration] */
            fun delay(duration: Long, timescale: Long) = Edit(duration, timescale, -1)
        }
    }

    class TrackSpec(
        /** "vide" 或 "soun" */
        val handler: String,
        /** stsd 里的 sample entry：含 box 头的原始字节 */
        val entries: List<ByteArray>,
        val timescale: Long,
        /** tkhd 的变换矩阵（保留源视频的旋转信息） */
        val matrix: ByteArray = IDENTITY_MATRIX,
        /** tkhd 的宽高（16.16 定点） */
        val width: Int = 0,
        val height: Int = 0,
        /** 16.16 定点，音频轨道通常为 0x0100 */
        val volume: Int = 0,
        val edits: List<Edit> = emptyList(),
        /** 最后一个 sample 的时长（媒体时间刻度）。<= 0 表示沿用前一个 sample 的时长 */
        val lastDuration: Long = -1,
    )

    private class WTrack(val index: Int, val spec: TrackSpec) {
        var count = 0
        var lastDts = 0L
        val durations = Longs() // durations[i]：第 i 个 sample 的时长；最后一个在 finish() 时补上
        val cts = Longs() // 显示偏移（显示时间 - 解码时间）
        val sizes = Longs()
        val offsets = Longs() // 相对当前 mdat 缓冲的偏移，flush() 时换算成文件偏移
        val sync = Flags()
        val chunks = Longs() // 每个 chunk 的起始偏移（同上，flush 时换算）
        val chunkSamples = Ints()
        val chunkSdi = Ints()
        var pendingFrom = 0 // offsets 里尚未换算成文件偏移的第一个下标
        var pendingChunkFrom = 0
        var contiguous = false // 上一次写入的是本轨道且之后没有 flush：新 sample 可以续在同一个 chunk 里
        var mediaDuration = 0L
        var presentationDuration = 0L
        var edits: List<Edit> = spec.edits
    }

    private val tracks = ArrayList<WTrack>()
    private var buf = ByteArray(BUFFER_SIZE)
    private var bufferPos = 0
    private val header = ByteArray(8)
    private var filePos = 0L
    private var started = false
    private var finished = false

    /** 已写出的字节数（含 box 头） */
    var bytesWritten = 0L
        private set

    /** 添加一条轨道（必须在 [start] 之前）。返回轨道下标 */
    fun addTrack(spec: TrackSpec): Int {
        check(!started) { "start() 之后不能再添加轨道" }
        require(spec.handler == HANDLER_VIDEO || spec.handler == HANDLER_AUDIO) { "未知的轨道类型 ${spec.handler}" }
        require(spec.entries.isNotEmpty()) { "轨道缺少 sample entry" }
        require(spec.timescale in 1..0xFFFFFFFFL) { "timescale 非法" }
        tracks.add(WTrack(tracks.size, spec))
        return tracks.size - 1
    }

    fun start() {
        check(!started) { "start() 只能调用一次" }
        check(tracks.isNotEmpty()) { "至少要有一条轨道" }
        started = true
        val brands = listOf("isom", "iso2", "avc1", "mp41")
        val w = ByteWriter()
        w.u32((8 + 4 + 4 + 4 * brands.size).toLong())
        w.fourcc("ftyp")
        w.fourcc("isom")
        w.u32(0x200)
        for (brand in brands) w.fourcc(brand)
        val bytes = w.toBytes()
        out.write(bytes)
        filePos = bytes.size.toLong()
        bytesWritten += bytes.size
    }

    /**
     * 写入一个 sample。[dts] 必须严格递增；[cts] 是显示时间减解码时间（可以为负，写入时会自动归一化）。
     * 同一条轨道的 sample 必须按解码顺序调用（带 B 帧的视频不是显示顺序）。
     */
    fun writeSample(track: Int, data: ByteArray, off: Int, len: Int, dts: Long, cts: Long, sync: Boolean, descIndex: Int = 1) {
        val t = tracks[track]
        check(started) { "先调用 start()" }
        check(!finished) { "finish() 之后不能再写" }
        require(dts >= 0) { "dts 不能为负" }
        if (t.count > 0) require(dts > t.lastDts) { "dts 必须严格递增（轨道 $track：$dts <= ${t.lastDts}）" }

        // 先保证缓冲区放得下（必要时先把已缓冲的数据写出），再记录偏移
        if (bufferPos + len > buf.size) {
            flush()
            if (len > buf.size) buf = ByteArray(len)
        }
        val chunks = t.chunkSamples
        val continueChunk = t.contiguous && t.chunkSdi[chunks.size - 1] == descIndex
        if (!continueChunk) {
            t.chunks.add(bufferPos.toLong())
            chunks.add(0)
            t.chunkSdi.add(descIndex)
        }
        chunks.data[chunks.size - 1]++
        t.offsets.add(bufferPos.toLong())
        System.arraycopy(data, off, buf, bufferPos, len)
        bufferPos += len

        if (t.count > 0) t.durations.add(dts - t.lastDts)
        t.lastDts = dts
        t.cts.add(cts)
        t.sizes.add(len.toLong())
        t.sync.add(sync)
        t.count++
        // 被别的轨道插进来之后，本轨道下一个 sample 就不连续了，要开新的 chunk
        for (other in tracks) other.contiguous = false
        t.contiguous = true
    }

    /** 把缓冲的数据作为一个 mdat 写出，并把各轨道记录的相对偏移换算成文件偏移 */
    private fun flush() {
        if (bufferPos == 0) return
        val base = filePos + header.size
        writeU32(header, 0, (header.size + bufferPos).toLong())
        header[4] = 'm'.code.toByte()
        header[5] = 'd'.code.toByte()
        header[6] = 'a'.code.toByte()
        header[7] = 't'.code.toByte()
        out.write(header)
        out.write(buf, 0, bufferPos)
        bytesWritten += header.size + bufferPos
        filePos += header.size + bufferPos
        bufferPos = 0
        for (t in tracks) {
            for (i in t.pendingFrom until t.offsets.size) t.offsets[i] = t.offsets[i] + base
            t.pendingFrom = t.offsets.size
            for (c in t.pendingChunkFrom until t.chunks.size) t.chunks[c] = t.chunks[c] + base
            t.pendingChunkFrom = t.chunks.size
            t.contiguous = false
        }
    }

    /** 收尾：写出 moov。之后不能再写入 sample */
    @Throws(IOException::class)
    fun finish() {
        if (finished) return
        check(started) { "先调用 start()" }
        flush()
        for (t in tracks) {
            if (t.count == 0) throw IOException("轨道 ${t.index}（${t.spec.handler}）没有任何 sample，无法生成文件")
            // 最后一个 sample 的时长表里没有记录：用调用方给的，否则沿用前一个
            var last = if (t.spec.lastDuration > 0) t.spec.lastDuration else if (t.durations.size > 0) t.durations[t.durations.size - 1] else 1L
            if (last <= 0) last = 1
            t.durations.add(last)
            for (i in 0 until t.durations.size) t.mediaDuration += t.durations[i]
            normalizeCts(t)
            // 呈现的终点 = 最后一帧的显示时间 + 一帧的时长。带 B 帧时它会超出解码时间轴的长度
            // （最后几帧要等后面的帧解码完才显示），「一直到结尾」的编辑必须覆盖到这里
            var end = 0L
            var clock = 0L
            for (i in 0 until t.count) {
                end = maxOf(end, clock + t.cts[i])
                clock += t.durations[i]
            }
            end += last
            // 编辑时长为 0 的含义是「一直到轨道结尾」（ffmpeg 的分片 MP4 就这么写），要换成真实时长，
            // 否则播放器会把它当成空编辑，整条轨道一帧都不呈现
            val edits = t.edits.toMutableList()
            for (i in edits.indices) {
                val e = edits[i]
                if (e.mediaTime >= 0 && e.segmentDuration <= 0) edits[i] = Edit(maxOf(end - e.mediaTime, 1), t.spec.timescale, e.mediaTime)
            }
            t.edits = edits
            alignEdits(t)
        }
        trimCommonLead()

        var movieDuration = 0L
        for (t in tracks) {
            t.presentationDuration = if (t.edits.isEmpty()) {
                scale(t.mediaDuration, t.spec.timescale, movieTimescale)
            } else {
                t.edits.fold(0L) { acc, e -> acc + scale(e.segmentDuration, e.segmentTimescale, movieTimescale) }
            }
            movieDuration = maxOf(movieDuration, t.presentationDuration)
        }
        val moov = moov(movieDuration)
        out.write(moov)
        out.flush()
        bytesWritten += moov.size.toLong()
        filePos += moov.size
        finished = true
    }

    /**
     * 让每条编辑的起点正好落在某一帧的显示时间上：起点落在两帧之间时，差出来的那一小段写成「空编辑」，
     * 再从那一帧开始。按规范两种写法等价，但 ffmpeg（以及不少播放器）遇到后一种写法会直接把那一帧放在
     * 编辑起点上 —— 画面就比声音早了那么一小段。ffmpeg 自己生成的文件用的都是前一种写法。
     */
    private fun alignEdits(t: WTrack) {
        if (t.edits.isEmpty()) return
        val pts = LongArray(t.count)
        var clock = 0L
        for (i in 0 until t.count) {
            pts[i] = clock + t.cts[i]
            clock += t.durations[i]
        }
        pts.sort()
        val out = ArrayList<Edit>()
        for (e in t.edits) {
            if (e.mediaTime < 0) {
                out.add(e)
                continue
            }
            // 显示时间 >= 编辑起点的第一帧；一帧都没有的话这条编辑不呈现任何内容，丢掉
            val at = pts.binarySearch(e.mediaTime).let { if (it >= 0) it else -(it + 1) }
            if (at >= pts.size) continue
            val gap = pts[at] - e.mediaTime
            if (gap > 0) out.add(Edit(gap, t.spec.timescale, -1))
            out.add(Edit(maxOf(e.segmentDuration - scale(gap, t.spec.timescale, e.segmentTimescale), 1), e.segmentTimescale, pts[at]))
        }
        t.edits = out
    }

    /**
     * 去掉各条轨道开头上共有的空白（空编辑）：让最早开始的那一路从 0 开始，各路之间的相对先后不变。
     * 源文件经常给音视频留不同长度的开头空白（比如视频 67ms、音频 43ms），其中公共的部分（43ms）
     * 对音画同步没有意义，只会让整个文件开头多出一段黑屏 —— ffmpeg 合成时也是这么处理的。
     * 只有至少一路有开头空白时才会处理；任何一路从 0 开始（没有空白）则什么都不动。
     */
    private fun trimCommonLead() {
        // 每条轨道开头空白的总长（微秒）；没有空白的记 0
        val leads = tracks.map { t ->
            t.edits.takeWhile { it.mediaTime < 0 }.fold(0L) { acc, e -> acc + scale(e.segmentDuration, e.segmentTimescale, 1_000_000) }
        }
        val common = leads.filter { it > 0 }.minOrNull() ?: 0L
        if (common <= 0 || leads.any { it == 0L }) return
        for ((i, t) in tracks.withIndex()) {
            var left = common.coerceAtMost(leads[i])
            val edits = ArrayList<Edit>()
            for (e in t.edits) {
                if (left > 0 && e.mediaTime < 0) {
                    val us = scale(e.segmentDuration, e.segmentTimescale, 1_000_000)
                    if (us <= left) {
                        left -= us
                        continue
                    }
                    edits.add(Edit(scale(us - left, 1_000_000, e.segmentTimescale), e.segmentTimescale, e.mediaTime))
                    left = 0
                } else {
                    edits.add(e)
                }
            }
            t.edits = edits
        }
    }

    /**
     * 显示偏移不能为负（ctts v0 只能存无符号数）。把全部显示时间后移 [shift]，
     * 同时让编辑列表从后移后的位置开始呈现——呈现时刻不变，这正是带 B 帧视频的标准做法。
     */
    private fun normalizeCts(t: WTrack) {
        var min = 0L
        for (i in 0 until t.cts.size) min = minOf(min, t.cts[i])
        if (min >= 0) return
        val shift = -min
        for (i in 0 until t.cts.size) t.cts[i] = t.cts[i] + shift
        val list = t.edits.toMutableList()
        val first = list.indexOfFirst { it.mediaTime >= 0 }
        if (first >= 0) {
            val e = list[first]
            list[first] = Edit(e.segmentDuration, e.segmentTimescale, e.mediaTime + shift)
        } else {
            // 原本没有编辑列表：加一条从后移后的位置开始的（时长先写 0，finish() 里会补成整条轨道）
            list.add(Edit(0, t.spec.timescale, shift))
        }
        t.edits = list
    }

    /* ---------------- moov 的各个 box ---------------- */

    private fun moov(movieDuration: Long): ByteArray {
        val mvhd = full("mvhd", 0) {
            u32(0) // creation_time
            u32(0) // modification_time
            u32(movieTimescale)
            u32(movieDuration)
            u32(0x00010000) // rate 1.0
            u16(0x0100) // volume 1.0
            u16(0)
            u32(0)
            u32(0) // reserved
            bytes(IDENTITY_MATRIX)
            repeat(6) { u32(0) } // pre_defined
            u32(tracks.size + 1L) // next_track_ID
        }
        val children = ArrayList<ByteArray>(tracks.size + 1)
        children.add(mvhd)
        for (t in tracks) children.add(trak(t))
        return box("moov", *children.toTypedArray())
    }

    private fun trak(t: WTrack): ByteArray {
        val spec = t.spec
        val tkhd = full("tkhd", 0, 3) { // flags: enabled | in movie
            u32(0)
            u32(0)
            u32(t.index + 1L)
            u32(0)
            u32(t.presentationDuration)
            u32(0)
            u32(0) // reserved
            u16(0) // layer
            u16(0) // alternate_group
            u16(spec.volume)
            u16(0)
            bytes(spec.matrix)
            u32(spec.width.toLong() and 0xFFFFFFFFL)
            u32(spec.height.toLong() and 0xFFFFFFFFL)
        }
        val mdhd = full("mdhd", 0) {
            u32(0)
            u32(0)
            u32(spec.timescale)
            u32(t.mediaDuration)
            u16(0x55C4) // language "und"
            u16(0)
        }
        val hdlr = full("hdlr", 0) {
            u32(0)
            fourcc(spec.handler)
            u32(0)
            u32(0)
            u32(0)
            val name = if (spec.handler == HANDLER_VIDEO) "VideoHandler" else "SoundHandler"
            for (c in name) u8(c.code)
            u8(0)
        }
        val mediaHeader = if (spec.handler == HANDLER_VIDEO) full("vmhd", 0, 1) { u16(0); u16(0); u16(0); u16(0) } else full("smhd", 0) { u16(0); u16(0) }
        val url = full("url ", 0, 1) {} // flags = 1：数据就在本文件里
        val dinf = box("dinf", full("dref", 0) { u32(1); bytes(url) })
        val stblChildren = ArrayList<ByteArray>()
        stblChildren.add(full("stsd", 0) {
            u32(spec.entries.size.toLong())
            for (e in spec.entries) bytes(e)
        })
        stblChildren.add(stts(t))
        val cttsBox = ctts(t)
        if (cttsBox != null) stblChildren.add(cttsBox)
        stblChildren.add(stsc(t))
        stblChildren.add(full("stsz", 0) {
            u32(0) // sample_size：每个 sample 大小不同
            u32(t.count.toLong())
            for (i in 0 until t.count) u32(t.sizes[i])
        })
        stblChildren.add(chunkOffsets(t))
        val stssBox = stss(t)
        if (stssBox != null) stblChildren.add(stssBox)
        val mdia = box("mdia", mdhd, hdlr, box("minf", mediaHeader, dinf, box("stbl", *stblChildren.toTypedArray())))
        return if (t.edits.isEmpty()) box("trak", tkhd, mdia) else box("trak", tkhd, box("edts", elst(t)), mdia)
    }

    private fun elst(t: WTrack): ByteArray {
        val edits = t.edits
        val wide = edits.any { it.segmentDuration > 0xFFFFFFFFL || it.mediaTime < Int.MIN_VALUE || it.mediaTime > Int.MAX_VALUE }
        return full("elst", if (wide) 1 else 0) {
            u32(edits.size.toLong())
            for (e in edits) {
                val duration = scale(e.segmentDuration, e.segmentTimescale, movieTimescale)
                if (wide) {
                    u64(duration)
                    i64(e.mediaTime)
                } else {
                    u32(duration)
                    i32(e.mediaTime.toInt())
                }
                i32(0x00010000) // media_rate 1.0
            }
        }
    }

    /** stts：sample 时长的游程编码 */
    private fun stts(t: WTrack): ByteArray = full("stts", 0) {
        val runs = ArrayList<IntArray>() // [count, delta]
        for (i in 0 until t.durations.size) {
            val d = t.durations[i]
            require(d > 0) { "sample 时长必须为正（第 $i 个 sample）" }
            if (runs.isNotEmpty() && runs.last()[1].toLong() == d) runs.last()[0]++ else runs.add(intArrayOf(1, d.toInt()))
        }
        u32(runs.size.toLong())
        for (r in runs) {
            u32(r[0].toLong())
            u32(r[1].toLong())
        }
    }

    /** ctts：显示偏移。全部为 0 时不写 */
    private fun ctts(t: WTrack): ByteArray? {
        var any = false
        for (i in 0 until t.cts.size) if (t.cts[i] != 0L) any = true
        if (!any) return null
        val runs = ArrayList<LongArray>() // [count, offset]
        for (i in 0 until t.cts.size) {
            val v = t.cts[i]
            if (runs.isNotEmpty() && runs.last()[1] == v) runs.last()[0]++ else runs.add(longArrayOf(1, v))
        }
        return full("ctts", 0) {
            u32(runs.size.toLong())
            for (r in runs) {
                u32(r[0])
                u32(r[1])
            }
        }
    }

    /** stsc：chunk → sample 数的映射（按 相同 的连续 chunk 合并） */
    private fun stsc(t: WTrack): ByteArray = full("stsc", 0) {
        val runs = ArrayList<IntArray>() // [firstChunk, samplesPerChunk, descriptionIndex]
        for (c in 0 until t.chunkSamples.size) {
            val per = t.chunkSamples[c]
            val sdi = t.chunkSdi[c]
            if (runs.isNotEmpty() && runs.last()[1] == per && runs.last()[2] == sdi) continue
            runs.add(intArrayOf(c + 1, per, sdi))
        }
        u32(runs.size.toLong())
        for (r in runs) {
            u32(r[0].toLong())
            u32(r[1].toLong())
            u32(r[2].toLong())
        }
    }

    private fun chunkOffsets(t: WTrack): ByteArray {
        var max = 0L
        for (c in 0 until t.chunks.size) max = maxOf(max, t.chunks[c])
        return if (max <= 0xFFFFFFFFL) full("stco", 0) {
            u32(t.chunks.size.toLong())
            for (c in 0 until t.chunks.size) u32(t.chunks[c])
        } else full("co64", 0) {
            u32(t.chunks.size.toLong())
            for (c in 0 until t.chunks.size) u64(t.chunks[c])
        }
    }

    /** stss：关键帧列表。只有视频轨道、且存在非关键帧时才写 */
    private fun stss(t: WTrack): ByteArray? {
        if (t.spec.handler != HANDLER_VIDEO || !t.sync.anyFalse) return null
        var count = 0
        for (i in 0 until t.count) if (t.sync[i]) count++
        return full("stss", 0) {
            u32(maxOf(count, 1).toLong())
            if (count == 0) {
                u32(1) // 源没标关键帧：至少把第一个 sample 标成关键帧，播放器才能起播
            } else {
                for (i in 0 until t.count) if (t.sync[i]) u32(i + 1L)
            }
        }
    }

    /* ---------------- box 组装 ---------------- */

    private fun box(type: String, payload: ByteArray): ByteArray {
        val w = ByteWriter(payload.size + 8)
        w.u32(payload.size + 8L)
        w.fourcc(type)
        w.bytes(payload)
        return w.toBytes()
    }

    private fun box(type: String, vararg children: ByteArray): ByteArray {
        var size = 8L
        for (c in children) size += c.size
        val w = ByteWriter(size.toInt())
        w.u32(size)
        w.fourcc(type)
        for (c in children) w.bytes(c)
        return w.toBytes()
    }

    /** FullBox：version(1) + flags(3) + 内容 */
    private fun full(type: String, version: Int, flags: Int = 0, body: ByteWriter.() -> Unit): ByteArray {
        val w = ByteWriter()
        w.u8(version)
        w.u24(flags)
        w.body()
        return box(type, w.toBytes())
    }

    override fun close() {
        if (started && !finished) finish()
    }

    companion object {
        const val HANDLER_VIDEO = "vide"
        const val HANDLER_AUDIO = "soun"
        private const val BUFFER_SIZE = 1 shl 20 // mdat 分块大小：每攒满 1MB 写一个 mdat

        /** 单位矩阵（tkhd / mvhd 用，16.16 定点） */
        val IDENTITY_MATRIX: ByteArray = ByteWriter(36).apply {
            u32(0x00010000); u32(0); u32(0)
            u32(0); u32(0x00010000); u32(0)
            u32(0); u32(0); u32(0x40000000)
        }.toBytes()

        /** a * to / from（四舍五入） */
        internal fun scale(a: Long, from: Long, to: Long): Long = (a * to + from / 2) / from

        private fun writeU32(dst: ByteArray, off: Int, v: Long) {
            for (i in 0 until 4) dst[off + i] = (v ushr (24 - 8 * i)).toByte()
        }
    }
}
