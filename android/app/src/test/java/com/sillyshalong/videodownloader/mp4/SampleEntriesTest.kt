package com.sillyshalong.videodownloader.mp4

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 把系统给的编解码参数拼成 MP4 sample entry、以及 TS 数据格式转换（纯逻辑，不依赖设备） */
class SampleEntriesTest {
    private fun bytes(vararg v: Number) = ByteArray(v.size) { v[it].toInt().toByte() }

    @Test
    fun `AnnexB 转成 4 字节长度前缀，3 字节和 4 字节起始码都认`() {
        val annexB = bytes(
            0, 0, 0, 1, 0x09, 0xF0, // AUD
            0, 0, 1, 0x67, 0x64, 0x00, // SPS（3 字节起始码）
            0, 0, 0, 1, 0x68, 0xEB, // PPS
            0, 0, 0, 1, 0x65, 0x88.toByte(), 0x84.toByte(), 0x21, // IDR 片
        )
        assertTrue(SampleEntries.isAnnexB(annexB))
        val avcc = SampleEntries.annexBToAvcc(annexB)
        val expected = bytes(
            0, 0, 0, 2, 0x09, 0xF0,
            0, 0, 0, 3, 0x67, 0x64, 0x00,
            0, 0, 0, 2, 0x68, 0xEB,
            0, 0, 0, 4, 0x65, 0x88.toByte(), 0x84.toByte(), 0x21,
        )
        assertArrayEquals(expected, avcc)
        // 已经是 AVCC 的数据原样返回
        assertFalse(SampleEntries.isAnnexB(expected))
        assertArrayEquals(expected, SampleEntries.annexBToAvcc(expected))
    }

    @Test
    fun `从 AnnexB 的 csd 里拆出 NAL 单元并识别类型`() {
        val units = SampleEntries.splitAnnexB(bytes(0, 0, 0, 1, 0x67, 0x64, 0, 0, 0, 1, 0x68, 0xEB))
        assertEquals(2, units.size)
        assertArrayEquals(bytes(0x67, 0x64), units[0])
        assertArrayEquals(bytes(0x68, 0xEB), units[1])
        assertEquals(7, SampleEntries.nalType(units[0], hevc = false))
        assertEquals(8, SampleEntries.nalType(units[1], hevc = false))
        // H.265：VPS=32 SPS=33 PPS=34（类型在第 0 字节的第 1..6 位）
        assertEquals(32, SampleEntries.nalType(bytes(0x40, 0x01), hevc = true))
        assertEquals(33, SampleEntries.nalType(bytes(0x42, 0x01), hevc = true))
        assertEquals(1, SampleEntries.nalType(bytes(0x02, 0x01), hevc = true)) // TRAIL_R 片
        assertEquals(19, SampleEntries.nalType(bytes(0x26, 0x01), hevc = true)) // IDR_W_RADL 片
        // 没有 NAL 数据
        assertTrue(SampleEntries.splitAnnexB(bytes(0, 0, 0, 0)).isEmpty())
        assertEquals(-1, SampleEntries.nalType(ByteArray(0), hevc = false))
    }

    @Test
    fun `只有分隔符、参数集的「帧」不算画面数据`() {
        val audOnly = SampleEntries.annexBToAvcc(bytes(0, 0, 0, 1, 0x09, 0xF0, 0, 0, 0, 1, 0x0A, 0x80))
        assertFalse(SampleEntries.hasSlices(audOnly, hevc = false))
        val withSlice = SampleEntries.annexBToAvcc(bytes(0, 0, 0, 1, 0x09, 0xF0, 0, 0, 0, 1, 0x41, 0x9A, 0x00))
        assertTrue(SampleEntries.hasSlices(withSlice, hevc = false))
        assertTrue(SampleEntries.hasSlices(SampleEntries.annexBToAvcc(bytes(0, 0, 0, 1, 0x65, 0x88)), hevc = false))
        assertTrue(SampleEntries.hasSlices(SampleEntries.annexBToAvcc(bytes(0, 0, 0, 1, 0x26, 0x01)), hevc = true))
        assertFalse(SampleEntries.hasSlices(SampleEntries.annexBToAvcc(bytes(0, 0, 0, 1, 0x46, 0x01)), hevc = true)) // H.265 的 AUD
        // 数据被截断（某个 NAL 的长度越界）也不算
        assertFalse(SampleEntries.hasSlices(bytes(0, 0, 0, 99, 0x41, 0x9A), hevc = false))
        assertFalse(SampleEntries.hasSlices(ByteArray(0), hevc = false))
    }

    @Test
    fun `一个包里连着的几帧 ADTS AAC 拆成单帧（去掉 7 字节头）`() {
        val a = bytes(1, 2, 3, 4, 5)
        val b = bytes(6, 7, 8, 9, 10, 11, 12)
        val c = bytes(13)
        val blob = adts(a) + adts(b) + adts(c)
        val frames = SampleEntries.splitAdts(blob)
        assertEquals(3, frames?.size)
        assertArrayEquals(a, frames!![0])
        assertArrayEquals(b, frames[1])
        assertArrayEquals(c, frames[2])
        // 单帧
        assertArrayEquals(a, SampleEntries.splitAdts(adts(a))!![0])
        // 不是 ADTS（裸 AAC）→ null，调用方当作单帧
        assertNull(SampleEntries.splitAdts(bytes(0xFF, 0x00, 1, 2, 3, 4, 5, 6, 7)))
        assertNull(SampleEntries.splitAdts(bytes(1, 2, 3)))
        // 中途对不上（长度字段越界）→ null
        assertNull(SampleEntries.splitAdts(adts(a) + adts(b).copyOf(10)))
    }

    @Test
    fun `AAC 的 sample entry：mp4a + esds，声道数和采样率写进去`() {
        val entry = SampleEntries.mp4a(bytes(0x12, 0x10), channels = 2, sampleRate = 44100)
        assertEquals(entry.size, readU32(entry, 0)) // 长度字段 = 整个 box
        assertEquals("mp4a", String(entry, 4, 4, Charsets.ISO_8859_1))
        assertEquals(2, readU16(entry, 8 + 6 + 2 + 8))
        assertEquals(16, readU16(entry, 8 + 6 + 2 + 8 + 2))
        // 采样率：16.16 定点 = 0xAC440000
        assertArrayEquals(bytes(0xAC, 0x44, 0x00, 0x00), entry.copyOfRange(8 + 6 + 2 + 8 + 8, 8 + 6 + 2 + 8 + 12))
        // esds 必须是一个完整的盒子（长度 + 类型）。曾经漏写了盒头：ffmpeg 找不到配置时按 44.1kHz 立体声猜，
        // 测试音频碰巧是这个格式所以没暴露，换成别的格式就没声音了
        val esds = 8 + 28 // AudioSampleEntry 固定部分：盒头 8 + 28 字节
        assertEquals("esds", String(entry, esds + 4, 4, Charsets.ISO_8859_1))
        assertEquals(entry.size - esds, readU32(entry, esds))
        assertEquals(0, readU32(entry, esds + 8)) // version + flags
        val es = esds + 12 // ES_Descriptor
        assertEquals(0x03, entry[es].toInt())
        assertEquals(0x04, entry[es + 5].toInt()) // DecoderConfigDescriptor
        assertEquals(0x40, entry[es + 7].toInt()) // AAC
        assertEquals(0x05, entry[es + 20].toInt()) // DecoderSpecificInfo
        assertArrayEquals(bytes(0x12, 0x10), entry.copyOfRange(es + 22, es + 24))
        assertEquals(0x06, entry[es + 24].toInt()) // SLConfigDescriptor
        assertEquals(entry.size, es + 27)
    }

    @Test
    fun `H264 的 sample entry：avc1 + avcC，SPS 和 PPS 在里面，宽高写进去`() {
        val sps = bytes(0x67, 0x64, 0x00, 0x1F)
        val pps = bytes(0x68, 0xEB, 0xEC)
        val entry = SampleEntries.avc1(listOf(sps), listOf(pps), 1920, 1080)
        assertEquals("avc1", String(entry, 4, 4, Charsets.ISO_8859_1))
        assertEquals(entry.size, readU32(entry, 0))
        assertEquals(1920, readU16(entry, 32))
        assertEquals(1080, readU16(entry, 34))
        assertEquals(8 + 78 + readU32(entry, 8 + 78), entry.size) // avcC 盒子的长度正好到结尾
        assertEquals("avcC", String(entry, 8 + 78 + 4, 4, Charsets.ISO_8859_1))
        val avcC = 8 + 78 + 8
        assertEquals(1, u(entry, avcC)) // 版本
        assertEquals(0x64, u(entry, avcC + 1)) // profile / 兼容 / 级别取自 SPS
        assertEquals(0x1F, u(entry, avcC + 3))
        assertEquals(0xFF, u(entry, avcC + 4)) // 4 字节长度前缀
        assertEquals(0xE1, u(entry, avcC + 5)) // 1 个 SPS
        assertEquals(4, readU16(entry, avcC + 6))
        assertArrayEquals(sps, entry.copyOfRange(avcC + 8, avcC + 12))
        assertEquals(1, u(entry, avcC + 12)) // 1 个 PPS
        assertEquals(3, readU16(entry, avcC + 13))
        assertArrayEquals(pps, entry.copyOfRange(avcC + 15, avcC + 18))
        assertEquals(entry.size, avcC + 18)
    }

    @Test
    fun `H265 的 sample entry：hvc1 + hvcC，VPS SPS PPS 三个数组`() {
        val vps = bytes(0x40, 0x01, 0x0C)
        val sps = ByteArray(20) { it.toByte() }.also { it[0] = 0x42; it[1] = 0x01 }
        val pps = bytes(0x44, 0x01, 0xC1)
        val entry = SampleEntries.hevc(listOf(vps), listOf(sps), listOf(pps), 1280, 720)
        assertEquals("hvc1", String(entry, 4, 4, Charsets.ISO_8859_1))
        assertEquals(1280, readU16(entry, 32))
        assertEquals(720, readU16(entry, 34))
        assertEquals(8 + 78 + readU32(entry, 8 + 78), entry.size)
        val hvcC = 8 + 78 + 8
        assertEquals("hvcC", String(entry, hvcC - 4, 4, Charsets.ISO_8859_1))
        assertEquals(1, u(entry, hvcC)) // configurationVersion
        // profile_tier_level 取自 SPS 的第 2..13 字节
        assertArrayEquals(sps.copyOfRange(2, 14), entry.copyOfRange(hvcC + 1, hvcC + 13))
        assertArrayEquals(bytes(0xF0, 0x00, 0xFC, 0xFC, 0xF8, 0xF8), entry.copyOfRange(hvcC + 13, hvcC + 19)) // 各项保留位
        assertEquals(0x0F, u(entry, hvcC + 21)) // 4 字节长度前缀
        assertEquals(3, u(entry, hvcC + 22)) // numOfArrays
        assertEquals(0x80 or 32, u(entry, hvcC + 23)) // 第 1 个数组：VPS
        assertEquals(3, readU16(entry, hvcC + 26))
        assertArrayEquals(vps, entry.copyOfRange(hvcC + 28, hvcC + 31))
        assertEquals(0x80 or 33, u(entry, hvcC + 31)) // 第 2 个数组：SPS
        assertEquals(20, readU16(entry, hvcC + 34))
        assertArrayEquals(sps, entry.copyOfRange(hvcC + 36, hvcC + 56))
        assertEquals(0x80 or 34, u(entry, hvcC + 56)) // 第 3 个数组：PPS
        assertEquals(entry.size, hvcC + 64) // 23 字节头 + VPS 8 + SPS 25 + PPS 8
    }

    private fun u(b: ByteArray, i: Int): Int = b[i].toInt() and 0xFF

    private fun readU32(b: ByteArray, off: Int): Int =
        ((b[off].toInt() and 0xFF) shl 24) or ((b[off + 1].toInt() and 0xFF) shl 16) or ((b[off + 2].toInt() and 0xFF) shl 8) or (b[off + 3].toInt() and 0xFF)

    private fun readU16(b: ByteArray, off: Int): Int = ((b[off].toInt() and 0xFF) shl 8) or (b[off + 1].toInt() and 0xFF)

    /** 造一个带 7 字节头的 ADTS 帧（AAC-LC、44100Hz、双声道、无 CRC） */
    private fun adts(payload: ByteArray): ByteArray {
        val len = payload.size + 7
        return bytes(
            0xFF, 0xF1,
            (0x40 or (4 shl 2)), // profile=LC, 采样率序号 4（44100），声道配置最高位 0
            (0x80 or ((len shr 11) and 0x03)),
            ((len shr 3) and 0xFF),
            (((len and 7) shl 5) or 0x1F),
            0xFC,
        ) + payload
    }
}
