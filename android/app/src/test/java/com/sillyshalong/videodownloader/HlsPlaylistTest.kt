package com.sillyshalong.videodownloader

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.io.RandomAccessFile
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/** m3u8 解析、清晰度选择、AES-128 解密、TS 收尾 —— HLS 下载里所有不依赖设备的逻辑 */
class HlsPlaylistTest {
    private val base = "https://cdn.example.org/hls/index.m3u8"

    @Test
    fun `主播放列表：解析各档清晰度，带引号的 CODECS 里有逗号也要读对`() {
        // 曾经的 bug：带引号的属性值被读成空串，导致 CODECS 丢失
        val master = HlsPlaylist.parseMaster(
            """
            #EXTM3U
            #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="中文",URI="audio/playlist.m3u8"
            #EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1920x1080,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"
            1080/index.m3u8
            #EXT-X-STREAM-INF:BANDWIDTH=250000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"
            360/index.m3u8
            #EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.64001e",URI="iframe.m3u8"
            """.trimIndent(),
            base,
        )
        assertTrue(HlsPlaylist.isMaster("#EXTM3U\n#EXT-X-STREAM-INF:...\nx"))
        assertEquals(2, master.variants.size)
        val (hd, sd) = master.variants
        assertEquals("https://cdn.example.org/hls/1080/index.m3u8", hd.uri)
        assertEquals(1920, hd.width)
        assertEquals("avc1.64001f,mp4a.40.2", hd.codecs)
        assertEquals("aud", hd.audioGroup)
        assertEquals(900000L, hd.bandwidth)
        assertEquals("https://cdn.example.org/hls/360/index.m3u8", sd.uri)
        assertNull(sd.audioGroup)
        assertEquals(listOf("https://cdn.example.org/hls/audio/playlist.m3u8"), master.audioUris)
    }

    @Test
    fun `媒体播放列表：AES-128 加密、字节范围、fMP4 初始化段、时长`() {
        val media = HlsPlaylist.parseMedia(
            """
            #EXTM3U
            #EXT-X-VERSION:3
            #EXT-X-TARGETDURATION:6
            #EXT-X-MEDIA-SEQUENCE:12
            #EXT-X-KEY:METHOD=AES-128,URI="https://key.example.org/k",IV=0X1234567890abcdef0011223344556677
            #EXTINF:5.5,
            seg0.ts
            #EXT-X-KEY:METHOD=AES-128,URI="enc.key"
            #EXTINF:5.0,
            seg1.ts
            #EXT-X-KEY:METHOD=NONE
            #EXT-X-BYTERANGE:1000@500
            #EXTINF:5.0,
            all.ts
            #EXT-X-BYTERANGE:2000
            #EXTINF:5.0,
            all.ts
            #EXT-X-GAP
            #EXTINF:5.0,
            missing.ts
            #EXTINF:0.5,
            /abs/seg.ts
            #EXT-X-ENDLIST
            """.trimIndent(),
            base,
        )
        assertEquals(5, media.segments.size)
        assertTrue(media.ended)
        assertEquals(12L, media.mediaSequence)
        assertEquals(21.0, media.totalDuration, 0.001)
        assertNull(media.initUri)

        val (s0, s1, s2, s3, s4) = media.segments
        assertEquals("https://cdn.example.org/hls/seg0.ts", s0.uri)
        assertNotNull(s0.key)
        assertEquals("https://key.example.org/k", s0.key!!.uri)
        // IV 大小写不敏感
        assertArrayEquals(hex("1234567890abcdef0011223344556677"), s0.key!!.iv)
        // 没写 IV 的分段：用分段所在的媒体序号
        assertEquals("https://cdn.example.org/hls/enc.key", s1.key!!.uri)
        assertNull(s1.key!!.iv)
        assertArrayEquals(hex("0000000000000000000000000000000d"), HlsPlaylist.iv(s1.key!!, media.mediaSequence, 1))
        // 字节范围：给了偏移的照抄；没给偏移的紧接上一个范围
        assertEquals(500L until 1500L, s2.range)
        assertNull(s2.key)
        assertEquals(1500L until 3500L, s3.range)
        // 换了地址之后，没给偏移的范围从 0 开始
        assertEquals("https://cdn.example.org/abs/seg.ts", s4.uri)
        assertNull(s4.range)
    }

    @Test
    fun `fMP4 播放列表记录初始化段`() {
        val media = HlsPlaylist.parseMedia("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2,\nseg0.m4s\n", base)
        assertEquals("https://cdn.example.org/hls/init.mp4", media.initUri)
        assertFalse(media.ended)
    }

    @Test
    fun `没有分段的列表、不支持的加密方式都给出看得懂的原因`() {
        try {
            HlsPlaylist.parseMedia("#EXTM3U\n#EXT-X-TARGETDURATION:6\n", base)
            fail("应当抛出异常")
        } catch (e: Http.ApiException) {
            assertTrue(e.message!!.contains("没有"))
        }
        try {
            HlsPlaylist.parseMedia("#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"k\"\n#EXTINF:1,\na.ts\n", base)
            fail("应当抛出异常")
        } catch (e: Http.ApiException) {
            assertTrue(e.message!!.contains("SAMPLE-AES"))
        }
    }

    @Test
    fun `选清晰度：不超过上限的最高一档，同清晰度优先 H264，都超了取最低一档`() {
        fun v(uri: String, w: Int, h: Int, codecs: String?, bw: Long, group: String? = null) = HlsPlaylist.Variant(uri, bw, w, h, 0.0, codecs, group)
        val master = HlsPlaylist.Master(
            listOf(v("1080", 1920, 1080, "avc1.64", 5000000), v("720", 1280, 720, "avc1.64", 2500000), v("720hevc", 1280, 720, "hvc1", 2000000), v("360", 640, 360, "avc1.64", 800000)),
            emptyList(),
        )
        assertEquals("1080", HlsPlaylist.pick(master, Int.MAX_VALUE).uri)
        assertEquals("720", HlsPlaylist.pick(master, 720).uri)
        assertEquals("720", HlsPlaylist.pick(master, 1000).uri)
        assertEquals("360", HlsPlaylist.pick(master, 360).uri)
        assertEquals("360", HlsPlaylist.pick(master, 144).uri)
        // 竖屏视频按短边算：1080x1920 算 1080p
        val portrait = HlsPlaylist.Master(listOf(v("p", 1080, 1920, null, 1), v("q", 720, 1280, null, 1)), emptyList())
        assertEquals("q", HlsPlaylist.pick(portrait, 720).uri)
    }

    @Test
    fun `音轨单独一路的流暂时不支持，要说明原因`() {
        val master = HlsPlaylist.Master(
            listOf(HlsPlaylist.Variant("v", 1, 1280, 720, 0.0, null, "aud")),
            listOf("https://cdn.example.org/a.m3u8"),
        )
        try {
            HlsPlaylist.pick(master, 720)
            fail("应当抛出异常")
        } catch (e: Http.ApiException) {
            assertTrue(e.message!!.contains("音轨"))
        }
    }

    @Test
    fun `AES-128 解密：去掉标准填充，也认不补或补 0 的实现`() {
        val key = hex("000102030405060708090a0b0c0d0e0f")
        val iv = hex("101112131415161718191a1b1c1d1e1f")
        fun encrypt(plain: ByteArray, pad: Boolean): ByteArray {
            val c = Cipher.getInstance("AES/CBC/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
            val fill = (16 - plain.size % 16) % 16
            val data = plain + if (fill == 0) ByteArray(0) else ByteArray(fill) { if (pad) fill.toByte() else 0 }
            return c.doFinal(data)
        }
        val plain = ByteArray(1000) { it.toByte() }
        // 标准 PKCS7
        assertArrayEquals(plain, HlsDownloader.decrypt(encrypt(plain, true), key, iv))
        // 补 0（长度刚好不用补，或者补的不是 PKCS7）：解出来末尾多几个 0，原样保留
        fun rawDecrypt(enc: ByteArray): ByteArray {
            val c = Cipher.getInstance("AES/CBC/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
            return c.doFinal(enc)
        }
        val zeroPadded = encrypt(plain, false)
        assertArrayEquals(rawDecrypt(zeroPadded), HlsDownloader.decrypt(zeroPadded, key, iv))
        // 末尾不是 16 的整数倍（有的实现会带几个多余字节）：只解密完整的块
        val extra = encrypt(plain, true) + byteArrayOf(1, 2, 3)
        assertArrayEquals(plain, HlsDownloader.decrypt(extra, key, iv))
    }

    @Test
    fun `TS 收尾：解析 PAT 和 PMT 找到各路基本流`() {
        val ts = tsFile(pes = 3)
        val streams = TsTail.streams(ts)
        assertEquals(listOf(0x100 to true, 0x101 to false), streams.map { it.pid to it.video })
        // 不是 TS（没有 0x47 同步字节）
        assertTrue(TsTail.streams(ByteArray(188 * 3)).isEmpty())
    }

    @Test
    fun `PES 头里的 PTS 编码能被正确解回来，标记位必须是 1`() {
        // 曾经漏了最高一段后面的标记位，系统解析器直接把整个包丢掉
        for (pts in longArrayOf(0, 90000, 324_000_000, 0x1FFFFFFFFL, 0x1234567)) {
            val h = TsTail.pesHeader(0xE0, pts, 8)
            assertEquals(14, h.size)
            assertEquals("PTS=$pts", pts, TsTail.decodePts(h))
        }
        assertArrayEquals(byteArrayOf(0x21, 0x00, 0x01, 0x01, 0x00), TsTail.pesHeader(0xE0, 0).copyOfRange(9, 14))
        // 90000 = 0b1_0101_1111_1001_0000：高 3 位 0，中 15 位 2，低 15 位 0x5F90
        assertArrayEquals(byteArrayOf(0x21, 0x00, 0x05, 0xBF.toByte(), 0x90.toByte()), TsTail.pesHeader(0xE0, 90000).copyOfRange(9, 14))
        assertArrayEquals(byteArrayOf(0x2F.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte()), TsTail.pesHeader(0xE0, 0x1FFFFFFFFL).copyOfRange(9, 14))
        // 标记位不是 1 → 解不出来
        assertNull(TsTail.decodePts(TsTail.pesHeader(0xE0, 0).also { it[9] = 0x20 }))
        assertNull(TsTail.decodePts(TsTail.pesHeader(0xE0, 0).also { it[11] = 0x00 }))
        // 第 13 字节是 PTS 的低 8 位，没有标记位：改成 0 仍然合法
        // 包头里声明的数据长度
        assertArrayEquals(byteArrayOf(0x04, 0x08), TsTail.pesHeader(0xE0, 0, 1032).copyOfRange(4, 6))
    }

    @Test
    fun `TS 收尾包：188 字节对齐、连续计数器连续、负荷完整、声明长度与负荷一致`() {
        val payload = ByteArray(1024) { (it * 7).toByte() }
        val header = TsTail.pesHeader(0xE0, 0x1FFFFFFFFL, 8 + payload.size)
        val packets = TsTail.pesPackets(0x100, 0x0A, header, payload)
        assertEquals(0, packets.size % TsTail.PACKET_SIZE)
        val count = packets.size / TsTail.PACKET_SIZE
        val out = ArrayList<Byte>()
        for (i in 0 until count) {
            val p = packets.copyOfRange(i * 188, (i + 1) * 188)
            assertEquals(0x47, p[0].toInt() and 0xFF)
            assertEquals(0x100, ((p[1].toInt() and 0x1F) shl 8) or (p[2].toInt() and 0xFF))
            // 连续计数器逐包 +1
            assertEquals(((0x0A + i + 1) and 0x0F), p[3].toInt() and 0x0F)
            assertEquals(if (i == 0) 0x40 else 0x00, p[1].toInt() and 0x40)
            val afc = (p[3].toInt() shr 4) and 0x03
            assertTrue("每个包都必须带负荷", afc == 1 || afc == 3)
            val body = if (afc == 3) 4 + 1 + (p[4].toInt() and 0xFF) else 4
            out.addAll(p.copyOfRange(body, 188).toList())
        }
        // 各包的负荷首尾相接正好是 PES 头 + 数据
        assertArrayEquals(header + payload, out.toByteArray())
        // 只有一个包、且负荷放得下时，剩余空间用自适应字段填满
        val small = TsTail.pesPackets(0x100, 3, TsTail.pesHeader(0xE0, 0, 8 + 10), ByteArray(10))
        assertEquals(188, small.size)
        assertEquals(0x30 or 4, small[3].toInt() and 0xFF)
        assertEquals(159, small[4].toInt() and 0xFF) // 170 字节空间只放 10 字节：剩下 160 用自适应字段填（长度 = 160 - 1）
        // 空包（只用来结束前一个 PES）
        val end = TsTail.pesPackets(0x100, 4, TsTail.pesHeader(0xE0, 0, 8), ByteArray(0))
        assertEquals(188, end.size)
        assertEquals(5, end[3].toInt() and 0x0F)
        assertArrayEquals(TsTail.pesHeader(0xE0, 0, 8), end.copyOfRange(4 + 170, 188))
    }

    @Test
    fun `补下一帧：在 TS 末尾追加，连续计数器接得上，再读出来是追加后的内容`() {
        val f = File.createTempFile("vd-ts-", ".ts").also { it.deleteOnExit() }
        f.writeBytes(tsFile(pes = 3))
        val before = f.length()
        assertEquals(0, TsTail.appendNextFrame(f, ByteArray(0))) // 没给数据就不动
        assertEquals(before, f.length())
        val appended = TsTail.appendNextFrame(f, ByteArray(300) { 0x55 })
        assertTrue(appended > 0)
        assertEquals(before + appended, f.length())
        assertEquals(0, (f.length() % 188).toInt())
        // 最后一包的连续计数器 = 原文件里视频 PID 最后一包 + 追加的包数
        val lastBefore = lastCc(tsFile(pes = 3), 0x100)
        val lastAfter = lastCc(f.readBytes(), 0x100)
        assertEquals((lastBefore + appended / 188) and 0x0F, lastAfter)
        // 追加的内容里带着「补包专用」的 PTS
        val bytes = f.readBytes()
        val injectedPts = (0 until appended / 188).mapNotNull { i ->
            val p = bytes.copyOfRange((before + i * 188).toInt(), (before + (i + 1) * 188).toInt())
            val body = if ((p[3].toInt() shr 4) and 0x03 == 3) 5 + (p[4].toInt() and 0xFF) else 4
            if (p[1].toInt() and 0x40 != 0) TsTail.decodePts(p.copyOfRange(body, body + 14)) else null
        }
        assertEquals(listOf(0x1FFFFFFFFL, 0x1FFFFFFFFL - 1), injectedPts)
    }

    @Test
    fun `TS 超过 2GiB：收尾时读文件开头，文件长度不能按 Int 算`() {
        // 曾经的 bug：file.length().toInt() 在超过 2GiB 时是负数（3.63GiB → -400254016），
        // 长视频下完（80%）开始合成时在这里直接 NegativeArraySizeException
        val len = 3_894_713_280L // 188 的整数倍，正好是用户遇到的那个文件大小
        val head = tsFile(pes = 3)
        val f = File.createTempFile("vd-big-", ".ts")
        try {
            RandomAccessFile(f, "rw").use {
                it.setLength(len) // 稀疏文件：只在开头写真实内容，并不真的占 3.6GiB 磁盘
                it.seek(0)
                it.write(head)
            }
            assertEquals(len, f.length())
            val appended = TsTail.appendNextFrame(f, ByteArray(300) { 0x55 })
            assertTrue(appended > 0)
            assertEquals(len + appended, f.length())
            // 开头原有的内容没被动过
            val first = RandomAccessFile(f, "r").use { r -> ByteArray(head.size).also { r.readFully(it) } }
            assertArrayEquals(head, first)
        } finally {
            f.delete()
        }
    }

    /* ---------------- 测试数据 ---------------- */

    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun lastCc(ts: ByteArray, pid: Int): Int {
        for (i in ts.size / 188 - 1 downTo 0) {
            val p = i * 188
            if (((ts[p + 1].toInt() and 0x1F) shl 8) or (ts[p + 2].toInt() and 0xFF) == pid) return ts[p + 3].toInt() and 0x0F
        }
        return -1
    }

    /**
     * 造一个最小的 TS：一个 PAT、一个 PMT（视频 0x1B 在 PID 0x100，音频 0x0F 在 PID 0x101），
     * 然后 [pes] 个视频 PES 包。表里的 CRC 随便填（解析时不校验）。
     */
    private fun tsFile(pes: Int): ByteArray {
        val out = ArrayList<Byte>()
        fun packet(pid: Int, pusi: Boolean, cc: Int, payload: ByteArray) {
            out.add(0x47)
            out.add(((if (pusi) 0x40 else 0) or ((pid shr 8) and 0x1F)).toByte())
            out.add((pid and 0xFF).toByte())
            out.add((0x10 or (cc and 0x0F)).toByte())
            out.addAll(payload.toList())
            while ((out.size % 188) != 0) out.add(0xFF.toByte())
        }
        // PAT
        val pat = ArrayList<Byte>()
        pat.add(0x00) // pointer_field
        //      table_id  段长 13  流标识  版本  当前段  末段   节目号 1    PMT PID 0x104   CRC
        pat.addAll(listOf(0x00, 0xB0.toByte(), 0x0D, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x01, 0xE1.toByte(), 0x04, 0x00, 0x00, 0x00, 0x00))
        packet(0, true, 0, pat.toByteArray())
        // PMT：节目号 1，PMT PID 0x104；PCR 0xE100；视频 0x1B → 0x100；音频 0x0F → 0x101
        val pmt = ArrayList<Byte>()
        pmt.add(0x00)
        pmt.addAll(
            //      table_id  段长 23  节目号 1  版本 当前段 末段   PCR PID    节目描述长
            listOf(
                0x02, 0xB0.toByte(), 0x19, 0x00, 0x01, 0x00, 0x00, 0x00, 0xE1.toByte(), 0x00, 0xF0.toByte(), 0x00,
                0x1B, 0xE1.toByte(), 0x00, 0xF0.toByte(), 0x00,
                0x0F, 0xE1.toByte(), 0x01, 0xF0.toByte(), 0x00,
                0x00, 0x00, 0x00, 0x00,
            ),
        )
        packet(0x104, true, 0, pmt.toByteArray())
        // 视频 PES：一包一个，头 14 字节 + 若干数据
        val first = TsTail.pesHeader(0xE0, 90000, 0)
        for (i in 0 until pes) {
            val pesBytes = first + ByteArray(100) { (i + it).toByte() }
            packet(0x100, true, i, pesBytes)
        }
        // 末尾再来两个空包（别的 PID）
        packet(0x1FFF, false, 0, ByteArray(184))
        packet(0x1FFF, false, 1, ByteArray(184))
        return out.toByteArray()
    }
}
