package com.sillyshalong.videodownloader.mp4

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile

/**
 * MP4 写入 / 读取 / 合成的正确性测试（纯 JVM，不依赖设备）。
 *
 * 前几个用例不依赖任何媒体文件：合成时间戳 → 写入 → 读回 → 逐项比对。
 * 最后一个用例需要真实媒体文件（由 ffmpeg / yt-dlp 在电脑上生成），通过
 * `-PvdFixtures=<目录>` 传入；没有传时跳过。生成的文件由 tests/android-media-check.mjs 用 ffmpeg 逐帧校验。
 */
class Mp4MuxerTest {

    /** 合成的 sample：内容按 (轨道, 序号) 填充，读回时可以逐字节核对 */
    private class Data(val dts: Long, val cts: Long, val sync: Boolean, val bytes: ByteArray)

    private fun payload(track: Int, index: Int, size: Int): ByteArray =
        ByteArray(size) { ((track * 31 + index * 7 + it) and 0xFF).toByte() }

    @Test
    @Throws(Exception::class)
    fun `写入后读回：时间戳、大小、关键帧、数据逐字节一致，B 帧时间线不变`() {
        // 视频：两个 GOP，解码顺序 I P B B / P B B B，显示顺序 0 1 2 3 / 4 5 6 7（解码时间 0..7）
        // 其中两帧带 1024KB 的大 sample：跨过 1MB 缓冲，逼出「多个 mdat + 缓冲扩容」的路径
        val video = listOf(
            Data(0, 0, true, payload(0, 0, 300)),
            Data(1000, 2000, false, payload(0, 1, 1 shl 20)),
            Data(2000, -1000, false, payload(0, 2, 400)),
            Data(3000, -1000, false, payload(0, 3, 1 shl 20)),
            Data(4000, 3000, false, payload(0, 4, 350)),
            Data(5000, -1000, false, payload(0, 5, 300)),
            Data(6000, 0, false, payload(0, 6, 310)),
            Data(7000, 1000, false, payload(0, 7, 320)),
        )
        // 音频：40 个 sample，带 1024 个采样的编码预滚（用编辑列表跳过）
        val audio = (0 until 40).map { Data(it * 1024L, 0, true, payload(1, it, 500)) }

        val out = File.createTempFile("vd-mp4-", ".mp4").also { it.deleteOnExit() }
        FileOutputStream(out).use { fos ->
            val w = Mp4Writer(fos)
            val v = w.addTrack(Mp4Writer.TrackSpec(Mp4Writer.HANDLER_VIDEO, listOf(entry("avc1")), 30000L))
            val a = w.addTrack(
                Mp4Writer.TrackSpec(
                    Mp4Writer.HANDLER_AUDIO, listOf(entry("mp4a")), 44100L, volume = 0x0100,
                    edits = listOf(Mp4Writer.Edit(40 * 1024, 44100, 1024)),
                ),
            )
            w.start()
            var vi = 0
            var ai = 0
            while (vi < video.size || ai < audio.size) {
                // 按解码时间交错（30000 与 44100 两个时间刻度）
                val takeVideo = vi < video.size && (ai >= audio.size || video[vi].dts * 44100 <= audio[ai].dts * 30000)
                if (takeVideo) {
                    val d = video[vi++]
                    w.writeSample(v, d.bytes, 0, d.bytes.size, d.dts, d.cts, d.sync)
                } else {
                    val d = audio[ai++]
                    w.writeSample(a, d.bytes, 0, d.bytes.size, d.dts, d.cts, d.sync)
                }
            }
            w.finish()
            assertEquals(out.length(), w.bytesWritten)
        }

        // 结构：ftyp 开头，若干 mdat，moov 在最后
        RandomAccessFile(out, "r").use { raf ->
            val types = Boxes.children(raf, 0, raf.length()).map { it.type }
            assertEquals("ftyp", types.first())
            assertEquals("moov", types.last())
            assertTrue("数据应分块写成多个 mdat: $types", types.count { it == "mdat" } >= 3)
        }

        Mp4Reader(out).use { reader ->
            assertEquals(2, reader.tracks.size)
            val (v, a) = reader.tracks

            // ---- 视频 ----
            assertEquals(Mp4Writer.HANDLER_VIDEO, v.handler)
            assertEquals(30000L, v.timescale)
            assertEquals(8, v.sampleCount)
            assertArrayEquals(video.map { it.dts }.toLongArray(), v.dts)
            assertArrayEquals(video.map { it.sync }.toBooleanArray(), v.sync)
            assertArrayEquals(video.map { it.bytes.size.toLong() }.toLongArray(), v.sizes)
            assertArrayEquals("sample entry 应原样保留", entry("avc1"), v.entries.single())
            // 显示偏移整体后移了一帧（原来的最小值是 -1 帧），并用编辑列表抵消 → 每一帧的呈现时刻不变
            assertArrayEquals(video.map { it.cts + 1000 }.toLongArray(), v.cts)
            assertEquals(1, v.edits.size)
            assertEquals(1000L, v.edits[0].mediaTime)
            assertEquals(8000L, v.mediaDuration)
            // 这条编辑从后移后的位置开始、一直到最后一帧显示完：终点 = 最后一帧的显示时间 + 一帧
            assertEquals("编辑时长以影片时间刻度(1000)计", 300L, v.edits[0].segmentDuration) // (10000 - 1000) / 30000 * 1000
            for (i in 0 until 8) assertEquals("第 $i 帧的呈现时刻", video[i].dts + video[i].cts, v.pts(i) - v.edits[0].mediaTime)

            // ---- 音频 ----
            assertEquals(Mp4Writer.HANDLER_AUDIO, a.handler)
            assertEquals(44100L, a.timescale)
            assertEquals(40, a.sampleCount)
            assertEquals(1024L, a.edits.single().mediaTime)
            assertEquals("编辑时长以影片时间刻度(1000)计", 929L, a.edits.single().segmentDuration) // 40960 / 44100 * 1000
            assertEquals(40 * 1024L, a.mediaDuration)

            // ---- 数据逐字节一致（偏移、chunk 划分都正确） ----
            val buf = ByteArray(1 shl 20)
            video.forEachIndexed { i, d -> assertEquals(d.bytes.size, reader.readSample(v, i, buf)); assertArrayEquals(d.bytes, buf.copyOf(d.bytes.size)) }
            audio.forEachIndexed { i, d -> assertEquals(d.bytes.size, reader.readSample(a, i, buf)); assertArrayEquals(d.bytes, buf.copyOf(d.bytes.size)) }
        }
    }

    @Test
    @Throws(Exception::class)
    fun `负显示偏移遇到已有编辑列表时叠加到第一条非空编辑上，各轨道开头共有的空白被去掉`() {
        val out = File.createTempFile("vd-mp4-edit-", ".mp4").also { it.deleteOnExit() }
        val data = payload(0, 0, 50)
        FileOutputStream(out).use { fos ->
            val w = Mp4Writer(fos)
            // 视频轨：前 10 个时间单位留空（空编辑），再从媒体时间 5 开始呈现
            val v = w.addTrack(
                Mp4Writer.TrackSpec(
                    Mp4Writer.HANDLER_VIDEO, listOf(entry("avc1")), 1000L,
                    edits = listOf(Mp4Writer.Edit.delay(10, 1000), Mp4Writer.Edit(50, 1000, 5)),
                ),
            )
            // 音频轨：开头留空 4 个时间单位
            val a = w.addTrack(Mp4Writer.TrackSpec(Mp4Writer.HANDLER_AUDIO, listOf(entry("mp4a")), 1000L, edits = listOf(Mp4Writer.Edit.delay(4, 1000))))
            w.start()
            var dts = 0L
            for (cts in longArrayOf(0, 3, -2, -2, 1, 0)) {
                w.writeSample(v, data, 0, data.size, dts++, cts, true)
            }
            for (i in 0 until 3) w.writeSample(a, data, 0, data.size, i.toLong(), 0, true)
            w.finish()
        }
        Mp4Reader(out).use { reader ->
            val (v, a) = reader.tracks
            // 两路开头的空白分别是 10 和 4：公共的 4 对音画相对先后没有意义，去掉后视频留 6、音频不再有空白
            assertEquals(listOf(6L to -1L, 50L to 7L), v.edits.map { it.segmentDuration to it.mediaTime }) // 原有编辑从 5 开始 + 后移量 2（最小显示偏移 -2）
            assertTrue("音频轨开头的公共空白应被去掉", a.edits.all { it.mediaTime >= 0 })
            assertArrayEquals(longArrayOf(2, 5, 0, 0, 3, 2), v.cts)
        }
    }

    @Test
    @Throws(Exception::class)
    fun `时长为 0 的编辑表示一直到轨道结尾，且要覆盖到最后一帧显示完`() {
        val out = File.createTempFile("vd-mp4-edit0-", ".mp4").also { it.deleteOnExit() }
        val data = payload(0, 0, 40)
        FileOutputStream(out).use { fos ->
            val w = Mp4Writer(fos)
            // ffmpeg 的分片 MP4 就是这么写编辑列表的：时长为 0，从媒体时间 0 开始
            val t = w.addTrack(Mp4Writer.TrackSpec(Mp4Writer.HANDLER_VIDEO, listOf(entry("avc1")), 1000L, edits = listOf(Mp4Writer.Edit(0, 1000L, 0))))
            w.start()
            // 解码顺序 I、P、B、B：显示时间 0, 3, 1, 2 → 最后一帧到 2 才显示，3 才播完
            val cts = longArrayOf(0, 2, -1, -1)
            for (i in 0 until 4) w.writeSample(t, data, 0, data.size, i.toLong(), cts[i], i == 0)
            w.finish()
        }
        Mp4Reader(out).use { reader ->
            val v = reader.tracks.single()
            val e = v.edits.single()
            // 负的显示偏移被整体后移了 1（原最小值 -1），所以起点从 0 变成 1
            assertEquals(1L, e.mediaTime)
            // 终点 = 最后一帧的显示时间（解码 3 + 偏移 1）+ 一帧 = 5；时长 = 5 - 1 = 4（影片时间刻度也是 1000）
            assertEquals(4L, e.segmentDuration)
            // 每一帧的呈现时刻与原来一致：0, 3, 1, 2
            assertArrayEquals(longArrayOf(0, 3, 1, 2), LongArray(4) { v.pts(it.toInt()) - e.mediaTime })
        }
    }

    @Test
    @Throws(Exception::class)
    fun `解码时间不递增时拒绝写入`() {
        val w = Mp4Writer(java.io.OutputStream.nullOutputStream())
        val t = w.addTrack(Mp4Writer.TrackSpec(Mp4Writer.HANDLER_VIDEO, listOf(entry("avc1")), 1000L))
        w.start()
        val d = payload(0, 0, 10)
        w.writeSample(t, d, 0, d.size, 0, 0, true)
        try {
            w.writeSample(t, d, 0, d.size, 0, 0, true)
            throw AssertionError("应当抛出异常")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("严格递增"))
        }
    }

    @Test
    @Throws(Exception::class)
    fun `单路重封装：源文件的时间戳、关键帧、编辑列表全部保留`() {
        // 先写一个带 B 帧 + 编辑列表的文件，再经 Mp4Muxer 原样搬到新文件，两张表应完全一致
        val src = File.createTempFile("vd-mp4-src-", ".mp4").also { it.deleteOnExit() }
        val dst = File.createTempFile("vd-mp4-remux-", ".mp4").also { it.deleteOnExit() }
        val frames = (0 until 30).map { i ->
            // 显示顺序 3 帧一组倒回去：解码顺序 pts = 0, 3, 1, 2, 6, 4, 5 …
            val g = i / 4
            val r = i % 4
            val pts = when (r) {
                0 -> g * 6
                1 -> g * 6 + 3
                else -> g * 6 + r - 1
            }
            Data(i * 2L, (pts - i * 2).toLong() * 2, i % 8 == 0, payload(0, i, 100 + i))
        }
        FileOutputStream(src).use { fos ->
            val w = Mp4Writer(fos)
            val t = w.addTrack(Mp4Writer.TrackSpec(Mp4Writer.HANDLER_VIDEO, listOf(entry("hvc1")), 90000L, width = 1920 shl 16, height = 1080 shl 16))
            w.start()
            frames.forEachIndexed { _, d -> w.writeSample(t, d.bytes, 0, d.bytes.size, d.dts, d.cts, d.sync) }
            w.finish()
        }
        Mp4Reader(src).use { reader ->
            Mp4Muxer.mux(listOf(Mp4SampleSource(reader, reader.tracks.single())), FileOutputStream(dst))
        }
        Mp4Reader(src).use { a ->
            Mp4Reader(dst).use { b ->
                val x = a.tracks.single()
                val y = b.tracks.single()
                assertEquals(x.sampleCount, y.sampleCount)
                assertArrayEquals(x.dts, y.dts)
                assertArrayEquals(x.cts, y.cts)
                assertArrayEquals(x.sizes, y.sizes)
                assertEquals(x.sync?.toList(), y.sync?.toList())
                assertEquals(x.edits.map { Triple(it.segmentDuration, it.segmentTimescale, it.mediaTime) }, y.edits.map { Triple(it.segmentDuration, it.segmentTimescale, it.mediaTime) })
                assertEquals(x.mediaDuration, y.mediaDuration)
                assertEquals(1920 shl 16, y.width)
                assertArrayEquals(x.entries.single(), y.entries.single())
                assertArrayEquals(x.matrix, y.matrix)
                val buf = ByteArray(4096)
                for (i in 0 until x.sampleCount) {
                    val p = ByteArray(x.sizes[i].toInt())
                    val q = ByteArray(y.sizes[i].toInt())
                    a.readSample(x, i, p)
                    b.readSample(y, i, q)
                    assertArrayEquals(p, q)
                }
            }
        }
    }

    /**
     * 真实媒体文件的重封装。fixtures 目录里：
     *   <name>.video.mp4 + <name>.audio.m4a  → out/<name>.mp4（两路合成，等价于 ffmpeg -c copy）
     *   <name>.single.mp4                   → out/<name>.single.mp4（单文件，取其中全部音视频轨道）
     * 没有 -PvdFixtures 时跳过。
     */
    @Test
    @Throws(Exception::class)
    fun `真实媒体文件重封装`() {
        val dir = System.getProperty("vd.fixtures") ?: ""
        if (dir.isBlank()) {
            println("[跳过] 未提供 -PvdFixtures=<目录>")
            return
        }
        val fixtures = File(dir)
        val outDir = File(fixtures, "out").apply { mkdirs() }
        var produced = 0
        for (video in fixtures.listFiles().orEmpty().filter { it.name.endsWith(".video.mp4") }) {
            val name = video.name.removeSuffix(".video.mp4")
            val audio = File(fixtures, "$name.audio.m4a")
            val sources = ArrayList<SampleSource>()
            val readers = ArrayList<Mp4Reader>()
            try {
                for (f in listOf(video, audio)) {
                    val r = Mp4Reader(f)
                    readers.add(r)
                    val t = r.tracks.first { it.handler == (if (f == video) Mp4Writer.HANDLER_VIDEO else Mp4Writer.HANDLER_AUDIO) }
                    sources.add(Mp4SampleSource(r, t))
                }
                val out = File(outDir, "$name.mp4")
                FileOutputStream(out).use { fos -> Mp4Muxer.mux(sources, fos) }
                println("[合成] ${out.path} (${out.length()} 字节)")
                produced++
            } finally {
                readers.forEach { it.close() }
            }
        }
        for (single in fixtures.listFiles().orEmpty().filter { it.name.endsWith(".single.mp4") }) {
            val name = single.name.removeSuffix(".single.mp4")
            val out = File(outDir, "$name.single.mp4")
            Mp4Reader(single).use { r ->
                val tracks = r.tracks.sortedBy { if (it.handler == Mp4Writer.HANDLER_VIDEO) 0 else 1 }
                FileOutputStream(out).use { fos -> Mp4Muxer.mux(tracks.map { Mp4SampleSource(r, it) }, fos) }
                println("[单文件] ${out.path} (${out.length()} 字节) 轨道=${tracks.map { it.codec + "@" + it.timescale }}")
            }
            produced++
        }
        assertTrue("目录里没有可用的媒体文件: $dir", produced > 0)
    }

    /**
     * 分片 MP4 的 sample 表不一定为空：ffmpeg 用 frag_keyframe 转封装带 B 帧的视频时，开头一段放在普通的
     * sample 表里，分片从后面才接上（tfdt 接着表里最后一个 sample 的时间）。表里的 sample 在时间轴上排在
     * 全部分片之前，要一起读出来 —— 以前只读分片，这种文件会整整丢掉开头一段画面和声音。
     *
     * 同时核对分片里 sample 的关键帧标志：ffmpeg 写非关键帧用 0x01010000、YouTube 用 0x00010000，
     * 关键帧分别是 0x02000000 和 0x00000000。以前这里认错了位，结果所有帧都被当成关键帧。
     *
     * 这里手工拼一个最小的「sample 表 3 个 + 分片 2 个」的文件，两种写法各验一遍。
     */
    @Test
    @Throws(Exception::class)
    fun `分片文件里 sample 表不为空时，表里的 sample 排在分片前面一起读出来，关键帧标志也认得`() {
        val ftyp = box("ftyp", words(0x69736F6D, 512))
        val mvhd = box("mvhd", full(0, 0, words(0, 0, 1000, 0) + ByteArray(80)))
        val tkhd = box("tkhd", full(0, 0, words(0, 0, 1, 0, 0) + ByteArray(60)))
        val hdlr = box("hdlr", full(0, 0, ByteWriter().apply { u32(0); fourcc("vide"); zeros(12) }.toBytes()))

        // moov 里的 sample 表：3 个 sample（时长各 10），数据在紧跟着的 mdat 里；没有 stss，都算关键帧
        fun moov(firstSampleOffset: Int, defaultFlags: Int): ByteArray {
            val stbl = box(
                "stbl",
                box("stsd", full(0, 0, words(1) + entry("avc1"))) +
                    box("stts", full(0, 0, words(1, 3, 10))) +
                    box("stsz", full(0, 0, words(0, 3, 3, 4, 5))) +
                    box("stsc", full(0, 0, words(1, 1, 3, 1))) +
                    box("stco", full(0, 0, words(1, firstSampleOffset))),
            )
            val mdia = box("mdia", box("mdhd", full(0, 0, words(0, 0, 1000, 0))) + hdlr + box("minf", stbl))
            // trex：分片里 sample 的默认值 —— 时长 10、标志取 [defaultFlags]
            val mvex = box("mvex", box("trex", full(0, 0, words(1, 1, 10, 0, defaultFlags))))
            return box("moov", mvhd + box("trak", tkhd + mdia) + mvex)
        }

        val mdat1 = box("mdat", "aaa".toByteArray() + "bbbb".toByteArray() + "ccccc".toByteArray())
        val mdat2 = box("mdat", "dd".toByteArray() + "eeeeee".toByteArray())

        // 一个分片：2 个 sample，解码时间从 30 起接着表里的往下走；第一个是关键帧（first_sample_flags），第二个取默认标志
        fun moof(dataOffset: Int, firstFlags: Int): ByteArray {
            val traf = box(
                "traf",
                box("tfhd", full(0, 0x020000, words(1))) + // default-base-is-moof：数据偏移以 moof 开头为基准
                    box("tfdt", full(1, 0, ByteWriter().apply { u64(30) }.toBytes())) +
                    // trun 给了数据偏移、第一个 sample 的标志和每个 sample 的大小
                    box("trun", full(0, 0x205, words(2, dataOffset, firstFlags, 2, 6))),
            )
            return box("moof", box("mfhd", full(0, 0, words(1))) + traf)
        }

        for ((defaultFlags, firstFlags) in listOf(0x01010000 to 0x02000000, 0x00010000 to 0x00000000)) {
            val head = ftyp + moov(ftyp.size + moov(0, defaultFlags).size + 8, defaultFlags) + mdat1
            val f = File.createTempFile("hybrid-mp4", ".mp4")
            try {
                val bytes = head + moof(moof(0, firstFlags).size + 8, firstFlags) + mdat2 // 分片的数据在 moof 之后的 mdat 里
                FileOutputStream(f).use { it.write(bytes) }
                Mp4Reader(f).use { r ->
                    val t = r.tracks.single()
                    assertEquals("vide", t.handler)
                    assertEquals(5, t.sampleCount)
                    assertArrayEquals(longArrayOf(3, 4, 5, 2, 6), t.sizes)
                    assertArrayEquals(longArrayOf(0, 10, 20, 30, 40), t.dts)
                    // 表里的没有 stss（全是关键帧）；分片里第一个是关键帧，第二个取默认的非关键帧标志
                    assertTrue(
                        "关键帧标志（默认 0x%08x / 首个 0x%08x）".format(defaultFlags, firstFlags),
                        t.sync.contentEquals(booleanArrayOf(true, true, true, true, false)),
                    )
                    val buf = ByteArray(16)
                    val texts = (0 until t.sampleCount).map { i ->
                        val n = r.readSample(t, i, buf)
                        String(buf, 0, n, Charsets.ISO_8859_1)
                    }
                    assertEquals(listOf("aaa", "bbbb", "ccccc", "dd", "eeeeee"), texts)
                }
            } finally {
                f.delete()
            }
        }
    }
    private fun box(type: String, payload: ByteArray): ByteArray =
        ByteWriter(8 + payload.size).apply { u32((8 + payload.size).toLong()); fourcc(type); bytes(payload) }.toBytes()

    private fun full(version: Int, flags: Int, payload: ByteArray): ByteArray =
        ByteWriter(4 + payload.size).apply { u8(version); u24(flags); bytes(payload) }.toBytes()

    /** 每个数字写成 4 字节大端 */
    private fun words(vararg v: Int): ByteArray = ByteWriter(4 * v.size).apply { v.forEach { u32(it.toLong()) } }.toBytes()

    /** 最小可用的 sample entry（只有 box 头和类型，内容对测试无关紧要） */
    private fun entry(type: String): ByteArray = ByteWriter(16).apply { u32(16); fourcc(type); u32(0); u32(0) }.toBytes()
}
