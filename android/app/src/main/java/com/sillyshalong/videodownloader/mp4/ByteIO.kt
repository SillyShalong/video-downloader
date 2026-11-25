package com.sillyshalong.videodownloader.mp4

import java.io.IOException
import java.io.RandomAccessFile

/* ---------- 字节读写（MP4 全部是大端序）。纯 Kotlin，JVM 单测可直接跑 ---------- */

internal class ByteWriter(initial: Int = 256) {
    private var buf = ByteArray(initial)
    var size = 0
        private set

    private fun need(n: Int) {
        if (size + n > buf.size) buf = buf.copyOf(maxOf(buf.size * 2, size + n))
    }

    fun u8(v: Int) {
        need(1)
        buf[size++] = v.toByte()
    }

    fun u16(v: Int) {
        need(2)
        buf[size] = (v shr 8).toByte()
        buf[size + 1] = v.toByte()
        size += 2
    }

    fun u24(v: Int) {
        u8(v shr 16)
        u16(v)
    }

    fun u32(v: Long) {
        need(4)
        for (i in 0 until 4) buf[size + i] = (v ushr (24 - 8 * i)).toByte()
        size += 4
    }

    fun i32(v: Int) = u32(v.toLong() and 0xFFFFFFFFL)

    fun i64(v: Long) = u64(v)

    fun u64(v: Long) {
        u32(v ushr 32)
        u32(v and 0xFFFFFFFFL)
    }

    fun fourcc(s: String) {
        for (c in s) u8(c.code)
    }

    fun bytes(b: ByteArray, off: Int = 0, len: Int = b.size - off) {
        need(len)
        System.arraycopy(b, off, buf, size, len)
        size += len
    }

    fun zeros(n: Int) {
        need(n)
        size += n
    }

    /** 原地改写 [index] 处的 32 位值（写 box 长度占位后回填用） */
    fun patch32(index: Int, v: Long) {
        for (i in 0 until 4) buf[index + i] = (v ushr (24 - 8 * i)).toByte()
    }

    fun toBytes(): ByteArray = buf.copyOf(size)
}

internal class ByteReader(private val b: ByteArray, start: Int = 0, private val end: Int = b.size) {
    var p = start
        private set

    val remaining: Int get() = end - p

    private fun need(n: Int) {
        if (p + n > end) throw IOException("MP4 结构不完整（需要 $n 字节，只剩 ${remaining}）")
    }

    fun u8(): Int {
        need(1)
        return b[p++].toInt() and 0xFF
    }

    fun u16(): Int {
        need(2)
        return (b[p++].toInt() and 0xFF shl 8) or (b[p++].toInt() and 0xFF)
    }

    fun u24(): Int = (u8() shl 16) or u16()

    fun u32(): Long {
        need(4)
        var v = 0L
        for (i in 0 until 4) v = v shl 8 or (b[p + i].toLong() and 0xFF)
        p += 4
        return v
    }

    fun i32(): Int = u32().toInt()

    fun i64(): Long = (u32() shl 32) or u32()

    fun u64(): Long = i64()

    fun fourcc(): String {
        need(4)
        val sb = StringBuilder(4)
        repeat(4) { sb.append(u8().toChar()) }
        return sb.toString()
    }

    fun bytes(n: Int): ByteArray {
        need(n)
        val out = b.copyOfRange(p, p + n)
        p += n
        return out
    }

    fun skip(n: Int) {
        need(n)
        p += n
    }

    /** 回到 [index]（例如读完 box 头后要把它算进整体内容时） */
    fun rewind(index: Int) {
        p = index
    }
}

/**
 * 文件里的一个 box：[start] 是 box 头的起始偏移，[payload] 是内容的起始偏移，
 * [payloadSize] 是内容长度（不含 box 头）
 */
internal class BoxRef(val type: String, val start: Long, val payload: Long, val payloadSize: Long)

internal object Boxes {
    /** 列出 [start, end) 范围内的直接子 box（只读 box 头，不读内容，mdat 再大也很快） */
    fun children(r: RandomAccessFile, start: Long, end: Long): List<BoxRef> {
        val out = ArrayList<BoxRef>()
        var pos = start
        val hdr = ByteArray(16)
        while (pos + 8 <= end) {
            r.seek(pos)
            r.readFully(hdr, 0, 8)
            val rd = ByteReader(hdr, 0, 8)
            var size = rd.u32()
            val type = rd.fourcc()
            var head = 8L
            if (size == 1L) { // 64 位长度
                r.readFully(hdr, 0, 8)
                size = ByteReader(hdr, 0, 8).u64()
                head = 16
            } else if (size == 0L) {
                size = end - pos // 一直延伸到所在容器末尾
            }
            if (size < head || pos + size > end) throw IOException("MP4 结构损坏：box $type 的长度不合法")
            val payloadStart = pos + head
            out.add(BoxRef(type, pos, payloadStart, pos + size - payloadStart))
            pos += size
        }
        return out
    }

    fun child(r: RandomAccessFile, parent: BoxRef, type: String): BoxRef? =
        children(r, parent.payload, parent.payload + parent.payloadSize).firstOrNull { it.type == type }

    fun childrenOfType(r: RandomAccessFile, parent: BoxRef, type: String): List<BoxRef> =
        children(r, parent.payload, parent.payload + parent.payloadSize).filter { it.type == type }

    fun payload(r: RandomAccessFile, box: BoxRef): ByteArray {
        if (box.payloadSize > 256L * 1024 * 1024) throw IOException("MP4 结构异常：${box.type} 过大")
        val b = ByteArray(box.payloadSize.toInt())
        r.seek(box.payload)
        r.readFully(b)
        return b
    }
}

/* ---------- 可增长的原始类型数组（sample table 动态收集用） ---------- */

internal class Longs(initial: Int = 4096) {
    var data = LongArray(initial)
        private set
    var size = 0
        private set

    fun add(v: Long) {
        if (size == data.size) data = data.copyOf(data.size * 2)
        data[size++] = v
    }

    operator fun get(i: Int): Long = data[i]

    operator fun set(i: Int, v: Long) {
        data[i] = v
    }
}

internal class Ints(initial: Int = 4096) {
    var data = IntArray(initial)
        private set
    var size = 0
        private set

    fun add(v: Int) {
        if (size == data.size) data = data.copyOf(data.size * 2)
        data[size++] = v
    }

    operator fun get(i: Int): Int = data[i]

    operator fun set(i: Int, v: Int) {
        data[i] = v
    }
}

internal class Flags(initial: Int = 4096) {
    var data = BooleanArray(initial)
        private set
    var size = 0
        private set
    var anyFalse = false
        private set

    fun add(v: Boolean) {
        if (size == data.size) data = data.copyOf(data.size * 2)
        data[size++] = v
        if (!v) anyFalse = true
    }

    operator fun get(i: Int): Boolean = data[i]
}
