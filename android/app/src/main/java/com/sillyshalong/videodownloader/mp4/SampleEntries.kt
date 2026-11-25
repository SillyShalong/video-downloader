package com.sillyshalong.videodownloader.mp4

/**
 * 用系统 MediaExtractor 给出的编解码参数（csd-0 / csd-1）拼出 sample entry。
 * 只有「不是从现成 MP4 里搬」的流才需要它（比如 HLS 的 MPEG-TS 分段）；
 * 从 MP4 / fMP4 来的轨道由 Mp4Reader 把 sample entry 原样复制，不经过这里。
 * 纯 Kotlin，JVM 单测覆盖。
 */
object SampleEntries {
    /** 视频轨的 sample entry 原始字节（含 box 头）：H.264 */
    fun avc1(sps: List<ByteArray>, pps: List<ByteArray>, width: Int, height: Int): ByteArray =
        visual("avc1", width, height, avcC(sps, pps))

    /** 视频轨的 sample entry：H.265 / HEVC */
    fun hevc(vps: List<ByteArray>, sps: List<ByteArray>, pps: List<ByteArray>, width: Int, height: Int): ByteArray {
        val profile = sps.firstOrNull()?.let { if (it.size >= 14) it.copyOfRange(2, 14) else null }
            ?: ByteArray(12) // 取不到 profile_tier_level 时全 0（多数播放器并不依赖它）
        val w = ByteWriter()
        w.u8(1) // configurationVersion
        w.bytes(profile) // profile_space/tier/idc + compatibility + constraint + level
        w.u16(0xF000) // reserved + min_spatial_segmentation_idc
        w.u8(0xFC) // reserved + parallelismType
        w.u8(0xFC) // reserved + chromaFormat（未知）
        w.u8(0xF8) // reserved + bitDepthLumaMinus8
        w.u8(0xF8) // reserved + bitDepthChromaMinus8
        w.u16(0) // avgFrameRate
        w.u8(0x0F) // constantFrameRate(2) numTemporalLayers(3) temporalIdNested(1) lengthSizeMinusOne(2)=3
        w.u8(3) // numOfArrays
        for ((type, units) in listOf(32 to vps, 33 to sps, 34 to pps)) {
            w.u8(0x80 or type) // array_completeness + NAL_unit_type
            w.u16(units.size)
            for (u in units) {
                w.u16(u.size)
                w.bytes(u)
            }
        }
        return visual("hvc1", width, height, box("hvcC", w.toBytes()))
    }

    /** 音频轨的 sample entry：AAC。[asc] 是 AudioSpecificConfig */
    fun mp4a(asc: ByteArray, channels: Int, sampleRate: Int): ByteArray {
        val w = ByteWriter()
        w.zeros(6) // reserved
        w.u16(1) // data_reference_index
        w.zeros(8) // version / revision / vendor
        w.u16(channels)
        w.u16(16) // samplesize
        w.u16(0)
        w.u16(0)
        w.u32((sampleRate.toLong() shl 16) and 0xFFFFFFFFL) // 16.16 定点
        // esds 是一个完整的盒子：长度 + 类型，不能只写内容
        w.bytes(box("esds", esds(asc)))
        return box("mp4a", w.toBytes())
    }

    /* ---------------- 内部 ---------------- */

    /** esds 盒子的内容：version/flags + ES_Descriptor（里面嵌着解码器配置和 AudioSpecificConfig） */
    private fun esds(asc: ByteArray): ByteArray {
        // DecoderSpecificInfo
        val dsi = ByteWriter().apply { u8(0x05); u8(asc.size); bytes(asc) }.toBytes()
        // DecoderConfigDescriptor：Audio ISO/IEC 14496-3（0x40），音频流（5 << 2 | 1）
        val dcd = ByteWriter().apply {
            u8(0x04); u8(13 + dsi.size)
            u8(0x40); u8(0x15); u24(6144) // bufferSizeDB
            u32(0); u32(0) // max / avg bitrate（未知）
            bytes(dsi)
        }.toBytes()
        // SLConfigDescriptor
        val sl = byteArrayOf(0x06, 0x01, 0x02)
        // ES_Descriptor
        val es = ByteWriter().apply {
            u8(0x03); u8(3 + dcd.size + sl.size)
            u16(1) // ES_ID
            u8(0)
            bytes(dcd)
            bytes(sl)
        }.toBytes()
        return ByteWriter().apply { u32(0); /* version + flags */ bytes(es) }.toBytes()
    }

    private fun avcC(sps: List<ByteArray>, pps: List<ByteArray>): ByteArray {
        val first = sps.firstOrNull() ?: ByteArray(0)
        val w = ByteWriter()
        w.u8(1) // configurationVersion
        fun byteAt(i: Int) = first.getOrNull(i)?.toInt()?.and(0xFF) ?: 0
        w.u8(byteAt(1)) // profile
        w.u8(byteAt(2)) // compatibility
        w.u8(byteAt(3)) // level
        w.u8(0xFF) // reserved + lengthSizeMinusOne = 3（4 字节长度前缀）
        w.u8(0xE0 or sps.size.coerceAtMost(0x1F))
        for (s in sps) {
            w.u16(s.size)
            w.bytes(s)
        }
        w.u8(pps.size.coerceAtMost(0xFF))
        for (p in pps) {
            w.u16(p.size)
            w.bytes(p)
        }
        return box("avcC", w.toBytes())
    }

    /** VisualSampleEntry（78 字节头）+ 子 box */
    private fun visual(type: String, width: Int, height: Int, child: ByteArray): ByteArray {
        val w = ByteWriter()
        w.u32((8 + 78 + child.size).toLong())
        w.fourcc(type)
        w.zeros(6)
        w.u16(1) // data_reference_index
        w.u16(0)
        w.u16(0)
        w.zeros(12) // pre_defined[3]
        w.u16(width)
        w.u16(height)
        w.u32(0x00480000) // horizresolution 72 dpi
        w.u32(0x00480000) // vertresolution
        w.u32(0)
        w.u16(1) // frame_count
        w.zeros(32) // compressorname
        w.u16(0x18) // depth
        w.u16(0xFFFF)
        w.bytes(child)
        return w.toBytes()
    }

    private fun box(type: String, payload: ByteArray): ByteArray =
        ByteWriter(payload.size + 8).apply { u32((payload.size + 8).toLong()); fourcc(type); bytes(payload) }.toBytes()

    /**
     * 把 AnnexB（00 00 00 01 / 00 00 01 起始码分隔的 NAL 单元）转成 MP4 用的 4 字节长度前缀格式。
     * 输入不是 AnnexB 时原样返回。
     */
    fun annexBToAvcc(data: ByteArray, size: Int = data.size): ByteArray {
        if (!isAnnexB(data, size)) return data.copyOf(size)
        val out = ByteWriter(size + 4)
        var i = 0
        var start = -1
        while (i < size - 2) {
            val isStart = data[i].toInt() == 0 && data[i + 1].toInt() == 0 && (data[i + 2].toInt() == 1 ||
                (data[i + 2].toInt() == 0 && i + 3 < size && data[i + 3].toInt() == 1))
            if (isStart) {
                if (start >= 0) {
                    val len = i - start
                    out.u32(len.toLong())
                    out.bytes(data, start, len)
                }
                start = i + (if (data[i + 2].toInt() == 1) 3 else 4)
                i = start
            } else {
                i++
            }
        }
        if (start >= 0 && start < size) {
            out.u32((size - start).toLong())
            out.bytes(data, start, size - start)
        }
        return out.toBytes()
    }

    /** 这段数据是否以 AnnexB 起始码开头 */
    fun isAnnexB(data: ByteArray, size: Int = data.size): Boolean =
        size > 3 && data[0].toInt() == 0 && data[1].toInt() == 0 && (data[2].toInt() == 1 || (data[2].toInt() == 0 && data[3].toInt() == 1))

    /**
     * 从 AnnexB 格式的 csd 里拆出一个个 NAL 单元（去掉起始码）。
     * 系统给的 csd-0 通常是 SPS（或 VPS+SPS+PPS 连在一起），csd-1 是 PPS。
     */
    fun splitAnnexB(data: ByteArray): List<ByteArray> {
        val out = ArrayList<ByteArray>()
        var i = 0
        var start = -1
        fun end(at: Int) {
            if (start >= 0 && at > start) out.add(data.copyOfRange(start, at))
        }
        while (i + 2 < data.size) {
            val sc = when {
                data[i].toInt() == 0 && data[i + 1].toInt() == 0 && data[i + 2].toInt() == 1 -> 3
                data[i].toInt() == 0 && data[i + 1].toInt() == 0 && i + 3 < data.size && data[i + 3].toInt() == 1 -> 4
                else -> 0
            }
            if (sc > 0) {
                end(i)
                start = i + sc
                i = start
            } else {
                i++
            }
        }
        end(data.size)
        return out
    }

    /** NAL 单元类型（H.264：低 5 位；H.265：(byte0 >> 1) & 0x3F） */
    fun nalType(nal: ByteArray, hevc: Boolean): Int =
        if (nal.isEmpty()) -1 else if (hevc) (nal[0].toInt() and 0xFF) shr 1 and 0x3F else nal[0].toInt() and 0x1F

    /**
     * 这段 AVCC 格式（4 字节长度前缀）的数据里有没有画面数据（片 slice 类的 NAL 单元）。
     * 只有分隔符、参数集、结束标记的「帧」不是画面，调用方应跳过。
     */
    fun hasSlices(data: ByteArray, hevc: Boolean): Boolean {
        var i = 0
        while (i + 4 < data.size) {
            val len = ((data[i].toInt() and 0xFF) shl 24) or ((data[i + 1].toInt() and 0xFF) shl 16) or
                ((data[i + 2].toInt() and 0xFF) shl 8) or (data[i + 3].toInt() and 0xFF)
            if (len <= 0 || i + 4 + len > data.size) return false
            val type = nalType(data.copyOfRange(i + 4, i + 5), hevc)
            if (if (hevc) type in 0..21 else type in 1..5) return true
            i += 4 + len
        }
        return false
    }

    /**
     * 把「若干帧 ADTS AAC 连在一起」的一段数据拆成一帧帧的裸 AAC（去掉 7/9 字节的 ADTS 头）。
     * 不是以 ADTS 同步字开头、或者中途对不上时返回 null（调用方当作单帧原样使用）。
     */
    fun splitAdts(data: ByteArray, size: Int = data.size): List<ByteArray>? {
        fun syncAt(p: Int) = p + 7 <= size && (data[p].toInt() and 0xFF) == 0xFF && (data[p + 1].toInt() and 0xF6) == 0xF0
        if (!syncAt(0)) return null
        val out = ArrayList<ByteArray>()
        var pos = 0
        while (pos < size) {
            if (!syncAt(pos)) return null
            val frameLen = ((data[pos + 3].toInt() and 0x03) shl 11) or ((data[pos + 4].toInt() and 0xFF) shl 3) or ((data[pos + 5].toInt() and 0xE0) shr 5)
            val headerLen = if (data[pos + 1].toInt() and 0x01 != 0) 7 else 9
            if (frameLen < headerLen || pos + frameLen > size) return null
            out.add(data.copyOfRange(pos + headerLen, pos + frameLen))
            pos += frameLen
        }
        return out
    }
}
