package com.sillyshalong.videodownloader.mp4

import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

/**
 * 读取 MP4 / M4A 的结构（纯 Kotlin，不依赖平台 API，不解码）。
 *
 * 用途是把一条轨道原样搬进新文件（配合 [Mp4Writer] / [Mp4Muxer]）：
 *  - sample entry（avcC / esds / hvcC …）按原始字节整体复制，所以不需要理解具体编码；
 *  - 解码时间、显示偏移、编辑列表全部保留，带 B 帧的视频和带编码预滚的音频
 *    都能与源文件逐帧、逐采样对齐；
 *  - 渐进式 MP4（普通的 mp4 / m4a）和分片 MP4（fMP4，YouTube 的视频流就是这种）都能读，
 *    也包括两者混用的：sample 表里先放一段、后面再接分片；
 *
 * 加密的流会直接抛 IOException。
 */
class Mp4Reader(file: File) : Closeable {
    private val raf = RandomAccessFile(file, "r")

    class Track(
        val id: Int,
        /** "vide" / "soun" */
        val handler: String,
        val timescale: Long,
        /** stsd 里的 sample entry：含 box 头的原始字节 */
        val entries: List<ByteArray>,
        /** 第一个 sample entry 的类型：avc1 / hvc1 / vp09 / av01 / mp4a / opus … */
        val codec: String,
        val matrix: ByteArray,
        /** tkhd 的宽高（16.16 定点） */
        val width: Int,
        val height: Int,
        val sampleCount: Int,
        /** 解码时间（媒体时间刻度），严格递增，按解码顺序排列 */
        val dts: LongArray,
        /** 显示时间 = dts + cts；没有显示偏移时全为 0 */
        val cts: LongArray,
        val sizes: LongArray,
        /** 每个 sample 在源文件里的绝对偏移 */
        val offsets: LongArray,
        /** 关键帧标记；null 表示全是关键帧 */
        val sync: BooleanArray?,
        /** 每个 sample 的 sample description 序号（从 1 开始） */
        val descIndex: IntArray,
        /** 最后一个 sample 的时长（媒体时间刻度） */
        val lastDuration: Long,
        val edits: List<Mp4Writer.Edit>,
    ) {
        fun pts(i: Int): Long = dts[i] + cts[i]

        /** 轨道在媒体时间轴上的总时长 */
        val mediaDuration: Long get() = if (sampleCount == 0) 0 else dts[sampleCount - 1] + lastDuration

        fun timeUs(ticks: Long): Double = ticks * 1_000_000.0 / timescale
    }

    val movieTimescale: Long
    val tracks: List<Track>
    private val top: List<BoxRef>

    /** 解析过程中轨道 sample 列表的可增长形态 */
    private class Builder(
        val id: Int,
        val handler: String,
        val timescale: Long,
        val entries: List<ByteArray>,
        val codec: String,
        val matrix: ByteArray,
        val width: Int,
        val height: Int,
        val edits: List<Mp4Writer.Edit>,
    ) {
        // mvex/trex 里给的默认值（分片 MP4 用）
        var defaultDescIndex = 1
        var defaultDuration = 0L
        var defaultSize = 0L
        var defaultFlags = 0L

        val dts = Longs()
        val cts = Longs()
        val sizes = Longs()
        val offsets = Longs()
        val sync = Flags()
        val desc = Ints()
        var lastDuration = 0L

        fun build(): Track {
            val n = dts.size
            return Track(
                id, handler, timescale, entries, codec, matrix, width, height, n,
                dts.data.copyOf(n), cts.data.copyOf(n), sizes.data.copyOf(n), offsets.data.copyOf(n),
                if (sync.anyFalse) sync.data.copyOf(n) else null, desc.data.copyOf(n), lastDuration, edits,
            )
        }
    }

    init {
        top = Boxes.children(raf, 0, raf.length())
        val moov = top.firstOrNull { it.type == "moov" } ?: throw IOException("不是有效的 MP4 文件（没有 moov）")
        val mvhd = Boxes.child(raf, moov, "mvhd") ?: throw IOException("MP4 缺少 mvhd")
        val mv = ByteReader(Boxes.payload(raf, mvhd))
        val mvVersion = mv.u8()
        mv.u24()
        if (mvVersion == 1) {
            mv.u64()
            mv.u64()
        } else {
            mv.u32()
            mv.u32()
        }
        movieTimescale = mv.u32()
        if (mvVersion == 1) mv.u64() else mv.u32() // duration：这里用不到，时长按 sample 表算

        // 1) moov：每条轨道的固定信息
        val parsed = ArrayList<Pair<BoxRef, Builder>>()
        for (trak in Boxes.childrenOfType(raf, moov, "trak")) {
            val b = parseTrack(trak)
            if (b.handler == Mp4Writer.HANDLER_VIDEO || b.handler == Mp4Writer.HANDLER_AUDIO) parsed.add(trak to b)
        }
        Boxes.child(raf, moov, "mvex")?.let { mvex ->
            for (trex in Boxes.childrenOfType(raf, mvex, "trex")) {
                val r = ByteReader(Boxes.payload(raf, trex))
                r.u32()
                val b = parsed.firstOrNull { it.second.id == r.u32().toInt() }?.second ?: continue
                b.defaultDescIndex = r.u32().toInt()
                b.defaultDuration = r.u32()
                b.defaultSize = r.u32()
                b.defaultFlags = r.u32()
            }
        }

        // 2) sample：渐进式全在 stbl 里；分片式在各个 moof 里 —— 但分片文件的 stbl 里也可能先放了一部分
        val fragmented = top.any { it.type == "moof" }
        for ((trak, b) in parsed) {
            val stbl = Boxes.child(raf, trak, "mdia")?.let { Boxes.child(raf, it, "minf") }?.let { Boxes.child(raf, it, "stbl") }
                ?: throw IOException("轨道缺少 sample table（stbl）")
            if (!fragmented) {
                readProgressive(b, stbl)
                continue
            }
            ensureNotEncrypted(b, stbl)
            // sample 表不一定为空：ffmpeg 用 frag_keyframe 转封装带 B 帧的视频时，开头一段放在普通的 sample 表里，
            // 分片从第 1 秒才接上（tfdt 从 1 秒起）。这部分在媒体时间轴上排在全部分片之前，必须先读，
            // 否则会整整丢掉一段画面和声音。
            if (initialSamples(stbl) > 0) readProgressive(b, stbl)
        }
        if (fragmented) for (moof in top.filter { it.type == "moof" }) readFragment(moof, parsed.map { it.second })
        tracks = parsed.map { it.second.build() }
    }

    /** stbl 的 sample 表里描述了多少个 sample（纯分片文件里是 0） */
    private fun initialSamples(stbl: BoxRef): Int =
        Boxes.child(raf, stbl, "stsz")?.let { box ->
            val r = ByteReader(Boxes.payload(raf, box))
            r.u32()
            r.u32()
            r.u32().toInt()
        } ?: 0

    /** 读取第 [i] 个 sample 的数据到 [buf]（[buf] 要不小于 [Track.sizes]），返回读取的字节数 */
    fun readSample(track: Track, i: Int, buf: ByteArray): Int {
        val n = track.sizes[i].toInt()
        if (n > buf.size) throw IllegalArgumentException("缓冲区太小：需要 $n，只有 ${buf.size}")
        raf.seek(track.offsets[i])
        raf.readFully(buf, 0, n)
        return n
    }

    override fun close() = raf.close()

    /* ---------------- moov：轨道固定信息 ---------------- */

    private fun parseTrack(trak: BoxRef): Builder {
        val tkhd = Boxes.child(raf, trak, "tkhd") ?: throw IOException("轨道缺少 tkhd")
        val tk = ByteReader(Boxes.payload(raf, tkhd))
        val version = tk.u8()
        tk.u24()
        if (version == 1) {
            tk.u64() // creation_time
            tk.u64() // modification_time
        } else {
            tk.u32()
            tk.u32()
        }
        val id = tk.u32().toInt()
        tk.u32() // reserved
        if (version == 1) tk.u64() else tk.u32() // duration（以影片时间刻度计，这里用不到）
        tk.u32()
        tk.u32() // reserved
        tk.u16() // layer
        tk.u16() // alternate_group
        tk.u16() // volume
        tk.u16()
        val matrix = tk.bytes(36)
        val width = tk.u32().toInt()
        val height = tk.u32().toInt()

        val mdia = Boxes.child(raf, trak, "mdia") ?: throw IOException("轨道缺少 mdia")
        val mdhd = Boxes.child(raf, mdia, "mdhd") ?: throw IOException("轨道缺少 mdhd")
        val md = ByteReader(Boxes.payload(raf, mdhd))
        val mdVersion = md.u8()
        md.u24()
        if (mdVersion == 1) {
            md.u64()
            md.u64()
        } else {
            md.u32()
            md.u32()
        }
        val timescale = md.u32()
        if (timescale <= 0) throw IOException("轨道的 timescale 非法")
        val handler = Boxes.child(raf, mdia, "hdlr")?.let { h ->
            val r = ByteReader(Boxes.payload(raf, h))
            r.u32()
            r.u32()
            r.fourcc()
        } ?: ""

        val stbl = Boxes.child(raf, mdia, "minf")?.let { Boxes.child(raf, it, "stbl") }
            ?: throw IOException("轨道缺少 sample table（stbl）")
        val stsd = Boxes.child(raf, stbl, "stsd") ?: throw IOException("轨道缺少 stsd")

        // elst → 编辑列表（时间刻度各自保留，交给写入方换算）
        val edits = ArrayList<Mp4Writer.Edit>()
        Boxes.child(raf, trak, "edts")?.let { edts ->
            Boxes.child(raf, edts, "elst")?.let { box ->
                val r = ByteReader(Boxes.payload(raf, box))
                val v = r.u8()
                r.u24()
                repeat(r.u32().toInt()) {
                    val duration: Long
                    val mediaTime: Long
                    if (v == 1) {
                        duration = r.u64()
                        mediaTime = r.i64()
                    } else {
                        duration = r.u32()
                        mediaTime = r.i32().toLong()
                    }
                    r.u32() // media_rate
                    edits.add(Mp4Writer.Edit(duration, movieTimescale, mediaTime))
                }
            }
        }
        val (entries, codec) = readEntries(stsd)
        return Builder(id, handler, timescale, entries, codec, matrix, width, height, edits)
    }

    /** stsd 里的 sample entry（原始字节）与第一个 entry 的类型 */
    private fun readEntries(stsd: BoxRef): Pair<List<ByteArray>, String> {
        val sd = ByteReader(Boxes.payload(raf, stsd))
        sd.u32()
        val entryCount = sd.u32().toInt()
        val entries = ArrayList<ByteArray>()
        var codec = ""
        repeat(entryCount) {
            val start = sd.p
            val size = sd.u32().toInt()
            val type = sd.fourcc()
            sd.rewind(start)
            if (size < 8) throw IOException("MP4 结构损坏：stsd entry 长度不合法")
            if (type in ENCRYPTED) throw IOException("音视频流是加密的，无法处理")
            entries.add(sd.bytes(size))
            if (codec.isEmpty()) codec = type
        }
        if (entries.isEmpty()) throw IOException("stsd 里没有任何 sample entry")
        return entries to codec
    }

    /* ---------------- 渐进式：stbl 里的 sample table ---------------- */

    private fun readProgressive(b: Builder, stbl: BoxRef) {
        // stts → 每个 sample 的解码时间
        val stts = Boxes.child(raf, stbl, "stts") ?: throw IOException("轨道缺少 stts")
        val ts = ByteReader(Boxes.payload(raf, stts))
        ts.u32()
        val runCount = ts.u32().toInt()
        for (i in 0 until runCount) {
            val run = ts.u32().toInt()
            val delta = ts.u32()
            repeat(run) {
                b.dts.add(if (b.dts.size > 0) b.dts[b.dts.size - 1] + b.lastDuration else 0L)
                b.lastDuration = delta
            }
        }
        val count = b.dts.size

        // ctts → 显示偏移（没有这张表的 sample 偏移为 0）
        Boxes.child(raf, stbl, "ctts")?.let { box ->
            val r = ByteReader(Boxes.payload(raf, box))
            val version = r.u8()
            r.u24()
            repeat(r.u32().toInt()) {
                val run = r.u32().toInt()
                val offset = if (version == 1) r.i32().toLong() else r.u32()
                repeat(run) { b.cts.add(offset) }
            }
        }

        // stsz → 大小
        val stsz = Boxes.child(raf, stbl, "stsz") ?: throw IOException("轨道缺少 stsz")
        val sz = ByteReader(Boxes.payload(raf, stsz))
        sz.u32()
        val fixed = sz.u32()
        if (sz.u32().toInt() != count) throw IOException("MP4 结构损坏：stsz 与 stts 的 sample 数不一致")
        for (i in 0 until count) b.sizes.add(if (fixed != 0L) fixed else sz.u32())

        // stsc + stco → 每个 sample 的文件偏移
        val stsc = Boxes.child(raf, stbl, "stsc") ?: throw IOException("轨道缺少 stsc")
        val sc = ByteReader(Boxes.payload(raf, stsc))
        sc.u32()
        val scCount = sc.u32().toInt()
        val firstChunk = IntArray(scCount)
        val perChunk = IntArray(scCount)
        val chunkSdi = IntArray(scCount)
        for (i in 0 until scCount) {
            firstChunk[i] = sc.u32().toInt()
            perChunk[i] = sc.u32().toInt()
            chunkSdi[i] = sc.u32().toInt()
        }
        val chunkOffsets = Boxes.child(raf, stbl, "stco")?.let { box -> readLongArray(box) { r -> r.u32() } }
            ?: Boxes.child(raf, stbl, "co64")?.let { box -> readLongArray(box) { r -> r.u64() } }
            ?: throw IOException("轨道缺少 stco / co64")
        var sample = 0
        var run = 0
        if (count > 0 && scCount == 0) throw IOException("轨道缺少 stsc 条目")
        for (c in chunkOffsets.indices) {
            val chunkNo = c + 1
            while (run + 1 < scCount && firstChunk[run + 1] <= chunkNo) run++
            var off = chunkOffsets[c]
            var left = if (scCount > 0) perChunk[run] else 0
            while (left-- > 0 && sample < count) {
                b.offsets.add(off)
                b.desc.add(if (scCount > 0) chunkSdi[run] else 1)
                off += b.sizes[sample]
                sample++
            }
        }
        if (sample != count) throw IOException("MP4 结构损坏：sample table 不完整（$sample / $count）")

        // stss → 关键帧（没有这张表表示全是关键帧）
        val sync = BooleanArray(count) { true }
        Boxes.child(raf, stbl, "stss")?.let { box ->
            val r = ByteReader(Boxes.payload(raf, box))
            r.u32()
            val n = r.u32().toInt()
            if (n < count) {
                sync.fill(false)
                for (i in 0 until n) {
                    val no = r.u32().toInt()
                    if (no in 1..count) sync[no - 1] = true
                }
            }
        }
        for (i in 0 until count) b.sync.add(sync[i])
    }

    private inline fun readLongArray(box: BoxRef, read: (ByteReader) -> Long): LongArray {
        val r = ByteReader(Boxes.payload(raf, box))
        r.u32()
        return LongArray(r.u32().toInt()) { read(r) }
    }

    /* ---------------- 分片式：moof 里的 sample ---------------- */

    private fun ensureNotEncrypted(b: Builder, stbl: BoxRef) {
        if (Boxes.child(raf, stbl, "senc") != null) throw IOException("音视频流是加密的，无法处理")
    }

    private fun readFragment(moof: BoxRef, builders: List<Builder>) {
        for (traf in Boxes.childrenOfType(raf, moof, "traf")) {
            val tfhd = Boxes.child(raf, traf, "tfhd") ?: continue
            if (Boxes.child(raf, traf, "senc") != null) throw IOException("音视频流是加密的，无法处理")
            val r = ByteReader(Boxes.payload(raf, tfhd))
            r.u8()
            val flags = r.u24()
            // 先把轨道号读出来再查找（别把「读下一个字段」写进查找条件里：条件每比较一次就会多读一个数字）
            val trackId = r.u32().toInt()
            val b = builders.firstOrNull { it.id == trackId } ?: continue
            // sample 数据的基准位置：显式给出，否则就是这个 moof 的开头
            val base = if (flags and 0x1 != 0) r.u64() else moof.start
            val descIndex = if (flags and 0x2 != 0) r.u32().toInt() else b.defaultDescIndex
            val defDur = if (flags and 0x8 != 0) r.u32() else b.defaultDuration
            val defSize = if (flags and 0x10 != 0) r.u32() else b.defaultSize
            val defFlags = if (flags and 0x20 != 0) r.u32() else b.defaultFlags
            val baseDts = Boxes.child(raf, traf, "tfdt")?.let { box ->
                val t = ByteReader(Boxes.payload(raf, box))
                val version = t.u8()
                t.u24()
                if (version == 1) t.u64() else t.u32()
            }
            for (trun in Boxes.childrenOfType(raf, traf, "trun")) {
                val t = ByteReader(Boxes.payload(raf, trun))
                val version = t.u8()
                val tf = t.u24()
                val count = t.u32().toInt()
                val dataOffset = if (tf and 0x1 != 0) t.i32().toLong() else null
                val firstFlags = if (tf and 0x4 != 0) t.u32() else null
                var offset = dataOffset?.let { base + it } ?: nextMdatAfter(moof)
                var dts = baseDts ?: if (b.dts.size > 0) b.dts[b.dts.size - 1] + b.lastDuration else 0L
                for (i in 0 until count) {
                    val dur = if (tf and 0x100 != 0) t.u32() else defDur
                    val size = if (tf and 0x200 != 0) t.u32() else defSize
                    val sampleFlags = when {
                        i == 0 && firstFlags != null -> firstFlags
                        tf and 0x400 != 0 -> t.u32()
                        else -> defFlags
                    }
                    val cts = if (tf and 0x800 != 0) (if (version == 1) t.i32().toLong() else t.u32()) else 0L
                    // 解码时间必须严格递增：时长缺失时沿用上一个已知时长
                    val step = if (dur > 0) dur else if (b.lastDuration > 0) b.lastDuration else 1L
                    b.dts.add(dts)
                    b.cts.add(cts)
                    b.sizes.add(size)
                    b.offsets.add(offset)
                    // 关键帧：sample_flags 里表示「非关键帧」的位置了位就不是。规范把 is_non_sync_sample 写在 bit 22（0x400000），
                    // 但实测 ffmpeg 写的非关键帧是 0x01010000、YouTube 写的是 0x00010000 —— 都落在 bit 16 上，
                    // 而关键帧（0x02000000 / 0x00000000）这两位都是 0。所以两位都认。
                    // （以前认的是 bit 20：所有 sample 都落在同一边，分片来源的每一帧都被写成了关键帧，拖动进度条会花屏。）
                    val nonSync = sampleFlags and (0x00010000L or 0x00400000L) != 0L
                    b.sync.add(!nonSync)
                    b.desc.add(descIndex)
                    offset += size
                    dts += step
                    b.lastDuration = step
                }
            }
        }
    }

    /** [moof] 之后紧跟着的那个 mdat 的数据起点（trun 没给 data offset 时，sample 数据就在那里） */
    private fun nextMdatAfter(moof: BoxRef): Long {
        val idx = top.indexOfFirst { it.start == moof.start }
        return top.drop(idx + 1).firstOrNull { it.type == "mdat" }?.payload ?: moof.start
    }

    companion object {
        /** 常见的加密 sample entry 类型 */
        private val ENCRYPTED = setOf("encv", "enca", "enct", "encs", "ovcv", "ovca")
    }
}
