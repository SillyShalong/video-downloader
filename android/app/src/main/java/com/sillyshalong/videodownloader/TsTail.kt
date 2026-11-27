package com.sillyshalong.videodownloader

import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

/**
 * 给缓存里的 MPEG-TS 文件收尾用的小工具（纯 Kotlin，JVM 单测覆盖）。
 *
 * 系统 MediaExtractor 读 TS 里的视频时，要等「下一帧开始」到了才肯把上一帧交出来；
 * 文件一结束，最后一个视频帧就一直卡在里面吐不出来（实测会丢最后一帧）。
 * [appendNextFrame] 在文件末尾给视频流补一个「下一帧」的包：内容取自视频第一帧的开头几字节
 * （只是一个完整的帧起始，用来让解析器把上一帧收尾），时间戳用一个不可能出现在真实内容里的极大值，
 * 读的一方看到这个时间戳就知道真实数据已经读完。
 */
object TsTail {
    const val PACKET_SIZE = 188
    private const val SYNC = 0x47

    /** 补进去的那个包的显示时间（TS 的 90kHz 刻度，取 33 位 PTS 的最大值） */
    private const val FLUSH_PTS_TICKS = 0x1FFFFFFFFL

    /** 显示时间（微秒）达到这个值就只可能是补进去的包：真实内容不会到 25 小时 */
    const val FLUSH_PTS_US = 90_000_000_000L

    /** TS 里的 PMT 所描述的一路基本流 */
    class Stream(val pid: Int, val video: Boolean, val type: Int)

    private val VIDEO_TYPES = setOf(0x01, 0x02, 0x10, 0x1B, 0x24, 0x42, 0x44)
    private val AUDIO_TYPES = setOf(0x03, 0x04, 0x0F, 0x11, 0x1C)

    /** 解析 PAT / PMT，列出各基本流的 PID。不是标准的 188 字节 TS 或找不到 PMT 时返回空表 */
    fun streams(data: ByteArray): List<Stream> {
        if (data.size < PACKET_SIZE * 2 || u8(data, 0) != SYNC || u8(data, PACKET_SIZE) != SYNC) return emptyList()
        val packets = data.size / PACKET_SIZE
        fun pid(p: Int): Int = ((u8(data, p + 1) and 0x1F) shl 8) or u8(data, p + 2)
        fun pusi(p: Int): Boolean = u8(data, p + 1) and 0x40 != 0

        // 负荷的起止位置（跳过自适应字段）
        fun payload(p: Int): Pair<Int, Int> {
            val afc = (u8(data, p + 3) shr 4) and 0x03
            var start = p + 4
            if (afc == 2 || afc == 3) start += 1 + u8(data, p + 4)
            return start to p + PACKET_SIZE
        }

        // PAT（PID 0）→ 各节目的 PMT PID
        val pmtPids = ArrayList<Int>()
        for (i in 0 until packets) {
            val p = i * PACKET_SIZE
            if (u8(data, p) != SYNC || pid(p) != 0 || !pusi(p)) continue
            val (s, e) = payload(p)
            if (s >= e) continue
            var q = s + 1 + u8(data, s) // 跳过 pointer_field
            if (q + 12 > e || u8(data, q) != 0x00) continue
            val end = minOf(e, q + 3 + (((u8(data, q + 1) and 0x0F) shl 8) or u8(data, q + 2)))
            q += 8
            while (q + 4 <= end - 4) { // 末尾 4 字节是 CRC
                pmtPids.add(((u8(data, q + 2) and 0x1F) shl 8) or u8(data, q + 3))
                q += 4
            }
            if (pmtPids.isNotEmpty()) break
        }
        if (pmtPids.isEmpty()) return emptyList()

        // PMT → 各基本流
        val out = ArrayList<Stream>()
        for (i in 0 until packets) {
            val p = i * PACKET_SIZE
            if (u8(data, p) != SYNC || pid(p) !in pmtPids || !pusi(p)) continue
            val (s, e) = payload(p)
            if (s >= e) continue
            var q = s + 1 + u8(data, s)
            if (q + 12 > e || u8(data, q) != 0x02) continue
            val end = minOf(e, q + 3 + (((u8(data, q + 1) and 0x0F) shl 8) or u8(data, q + 2)))
            q += 8 // table_id, 长度, program_number, version, section_number, last_section_number
            q += 2 // PCR PID
            q += 2 + (((u8(data, q) and 0x0F) shl 8) or u8(data, q + 1)) // 跳过节目描述符
            while (q + 5 <= end - 4) {
                // 每路：stream_type(1) + elementary_PID(2) + ES_info_length(2) + 描述符
                val type = u8(data, q)
                val esPid = ((u8(data, q + 1) and 0x1F) shl 8) or u8(data, q + 2)
                q += 5 + (((u8(data, q + 3) and 0x0F) shl 8) or u8(data, q + 4))
                out.add(Stream(esPid, type in VIDEO_TYPES, type))
            }
            break
        }
        return out
    }

    /**
     * 在 [file] 末尾给视频流补一个「下一帧」的包。返回补上的字节数（0 = 没补：不是 TS、找不到视频流或没给出帧数据）。
     * @param nextAccessUnit 作为「下一帧」写入的数据（视频第一帧开头的若干字节，AnnexB 格式）
     */
    fun appendNextFrame(file: File, nextAccessUnit: ByteArray): Int {
        if (nextAccessUnit.isEmpty() || file.length() < PACKET_SIZE * 2 || file.length() % PACKET_SIZE != 0L) return 0
        // 文件可能有几个 GiB（长的 HLS 视频很常见）：长度全程按 Long 算，截到缓冲区上限之后再转 Int。
        // 以前直接 file.length().toInt()，超过 2GiB 就成了负数 —— 下载到 80% 开始合成时在这里崩。
        val head = ByteArray(minOf(PACKET_SIZE * 400L, file.length()).toInt())
        RandomAccessFile(file, "r").use { it.readFully(head) }
        val video = streams(head).firstOrNull { it.video } ?: return 0
        var cc = lastContinuityCounter(file, video.pid)
        // 1) 「下一帧」：声明了明确长度的 PES 包，后面再跟一个空包把它结束掉 ——
        //    系统解析器只在一个 PES 包「完整结束」时才把数据交给帧解析，所以补的包自己也必须能结束
        val next = pesPackets(video.pid, cc, pesHeader(0xE0, FLUSH_PTS_TICKS, 8 + nextAccessUnit.size), nextAccessUnit)
        cc = (cc + next.size / PACKET_SIZE) and 0x0F
        val end = pesPackets(video.pid, cc, pesHeader(0xE0, FLUSH_PTS_TICKS - 1, 8), ByteArray(0))
        FileOutputStream(file, true).use { it.write(next); it.write(end) }
        return next.size + end.size
    }

    /** [pid] 上最后一个带负荷的 TS 包的连续计数器（找不到时返回 -1，表示随便填） */
    fun lastContinuityCounter(file: File, pid: Int): Int {
        val len = file.length()
        val size = minOf(PACKET_SIZE * 2000L, len - len % PACKET_SIZE).toInt()
        val tail = ByteArray(size)
        RandomAccessFile(file, "r").use {
            it.seek(len - size)
            it.readFully(tail)
        }
        for (i in size / PACKET_SIZE - 1 downTo 0) {
            val p = i * PACKET_SIZE
            val afc = (u8(tail, p + 3) shr 4) and 0x03
            if (u8(tail, p) == SYNC && ((u8(tail, p + 1) and 0x1F) shl 8 or u8(tail, p + 2)) == pid && afc and 1 != 0) return u8(tail, p + 3) and 0x0F
        }
        return -1
    }

    /**
     * 构造承载 [payload] 的 TS 包序列：第一个包带 PES 头 [header]，
     * 负荷放不下就续到后面的包里，最后一个包的剩余空间用自适应字段填满。
     * 连续计数器从 [lastCc] + 1 开始递增，不出现跳变（跳变会被解析器当成传输错误，丢掉前面没收完的数据）。
     */
    fun pesPackets(pid: Int, lastCc: Int, header: ByteArray, payload: ByteArray): ByteArray {
        val firstCapacity = PACKET_SIZE - 4 - header.size // 第一个包：TS 头 + PES 头之后能放的负荷
        val rest = (payload.size - firstCapacity).coerceAtLeast(0)
        val perPacket = PACKET_SIZE - 4
        val count = if (rest == 0) 1 else 2 + (rest - 1) / perPacket // 之后的包每个放 184 字节
        val out = ByteArray(count * PACKET_SIZE)
        var cc = lastCc
        var src = 0
        var left = payload.size
        for (i in 0 until count) {
            val base = i * PACKET_SIZE
            val first = i == 0
            val capacity = if (first) firstCapacity else PACKET_SIZE - 4
            val chunk = minOf(capacity, left)
            val padding = capacity - chunk // 负荷放不满的部分（只可能出现在最后一个包）
            cc = (cc + 1) and 0x0F
            out[base] = SYNC.toByte()
            out[base + 1] = ((if (first) 0x40 else 0x00) or ((pid shr 8) and 0x1F)).toByte()
            out[base + 2] = (pid and 0xFF).toByte()
            var dst = base + 4
            if (padding > 0) {
                // 放不满的部分用自适应字段填满：1 字节长度 + 可选的标志字节 + 填充字节
                out[base + 3] = (0x30 or cc).toByte()
                out[dst] = (padding - 1).toByte()
                if (padding >= 2) out[dst + 1] = 0x00
                for (k in 2 until padding) out[dst + k] = 0xFF.toByte()
                dst += padding
            } else {
                out[base + 3] = (0x10 or cc).toByte()
            }
            if (first) {
                System.arraycopy(header, 0, out, dst, header.size)
                dst += header.size
            }
            System.arraycopy(payload, src, out, dst, chunk)
            src += chunk
            left -= chunk
        }
        return out
    }

    /**
     * PES 包头（视频流、只带 PTS），共 14 字节。
     * PTS 在头里按 3 / 8 / 7 / 7 / 8 位分成五段，后三段的前面各有一个必须为 1 的标记位
     * （系统解析器会校验，不对就整包丢弃）。
     * @param dataLength PES 包头之后的字节数（PTS 的 5 字节 + 负荷）；0 表示不限长、直到下一个包开始
     */
    fun pesHeader(streamId: Int, pts: Long, dataLength: Int = 0): ByteArray {
        fun low8(v: Long): Byte = (v and 0xFFL).toInt().toByte()
        val markerTop: Byte = (0x21 or ((pts shr 29) and 0x0EL).toInt()).toByte() // 0010 + PTS[32..30] + 标记位
        val marker1: Byte = (0x01 or ((pts shr 14) and 0xFEL).toInt()).toByte() // PTS[21..15] 放在第 7..1 位，第 0 位是标记
        val marker2: Byte = (0x01 or ((pts shr 7) and 0xFEL).toInt()).toByte() // PTS[14..8] 放在第 7..1 位，第 0 位是标记
        return byteArrayOf(
            0x00, 0x00, 0x01, streamId.toByte(),
            ((dataLength shr 8) and 0xFF).toByte(), (dataLength and 0xFF).toByte(),
            0x80.toByte(), 0x80.toByte(), 5, // 标志：只有 PTS
            markerTop, low8(pts shr 22), marker1, marker2, low8(pts),
        )
    }

    /** 从 PES 头里解出 PTS（只带 PTS 的那种头），校验标记位；格式不对返回 null */
    fun decodePts(header: ByteArray): Long? {
        if (header.size < 14 || header[2] != 0x01.toByte() || header[6] != 0x80.toByte() || header[7] != 0x80.toByte() || header[8] != 5.toByte()) return null
        fun u(i: Int) = header[i].toInt() and 0xFF
        val b0 = u(9)
        val b1 = u(10)
        val b2 = u(11)
        val b3 = u(12)
        val b4 = u(13)
        if (b0 and 0xF0 != 0x20 || b0 and 0x01 != 1 || b2 and 0x01 != 1 || b3 and 0x01 != 1) return null
        val top = (b0 shr 1) and 0x07 // PTS[32..30]
        val mid = (b1 shl 7) or (b2 ushr 1) // PTS[29..15]
        val low = ((b3 ushr 1) shl 8) or b4 // PTS[14..0]
        return top.toLong() shl 30 or (mid.toLong() shl 15) or low.toLong()
    }

    private fun u8(b: ByteArray, i: Int): Int = b[i].toInt() and 0xFF
}
