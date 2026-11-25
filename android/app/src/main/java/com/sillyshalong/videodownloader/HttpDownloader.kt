package com.sillyshalong.videodownloader

import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/**
 * 直链下载器：把 [DownloadSpec] 的各段按顺序写出，带进度、测速、取消。
 *
 * 两种落点：
 *  - [write]：写进已打开的输出流（系统下载目录 / 用户所选目录）。输出流不能回退，
 *    所以只有「一个字节都还没写」时才会换地址重试。
 *  - [toFile]：写进本地文件（需要先落盘再处理的多路流）。保留 .part 文件，
 *    重试 / 恢复时用 Range 从断点继续。
 */
object HttpDownloader {
    private const val TAG = "HttpDownloader"
    private const val MAX_ATTEMPTS = 4

    /** 进度回调：total <= 0 表示总大小未知；speed 为字节/秒 */
    fun interface Progress {
        fun onProgress(downloaded: Long, total: Long, speed: Long)
    }

    /** 把 [spec] 依次写入 [out]（不负责关闭 [out]）。返回写入的字节数 */
    @Throws(IOException::class)
    fun write(spec: DownloadSpec, out: OutputStream, flag: CancelFlag, onProgress: Progress): Long {
        var written = 0L
        for (candidates in spec.parts) {
            var failure: IOException? = null
            var done = false
            for (url in candidates) {
                flag.throwIfCancelled()
                val counter = Counter()
                try {
                    written += pump(Http.call(url, spec.headers, flag), out, flag, written, spec.totalBytes, onProgress, counter)
                    done = true
                    break
                } catch (e: CancelledException) {
                    throw e
                } catch (e: IOException) {
                    if (counter.n > 0) throw e // 已经写出了一部分，换地址会重复写入
                    failure = e
                    Log.w(TAG, "连接失败，换地址重试: ${e.message}")
                }
            }
            if (!done) throw failure ?: IOException("没有可用的下载地址")
        }
        return written
    }

    /**
     * 下载到本地文件；已有 .part 时断点续传。返回文件大小。
     * @param onResumed 从断点继续时回调一次（参数：已有的字节数），用来在任务日志里说明
     */
    @Throws(IOException::class)
    fun toFile(
        spec: DownloadSpec,
        file: File,
        flag: CancelFlag,
        onProgress: Progress,
        onResumed: ((Long) -> Unit)? = null,
    ): Long {
        file.parentFile?.mkdirs()
        val count = spec.parts.size
        var finished = 0L // 前面各段已完成的字节数
        for ((index, candidates) in spec.parts.withIndex()) {
            val part = partFile(file, index, count)
            var expected = if (count == 1 && spec.totalBytes > 0) spec.totalBytes else -1L
            var failures = 0
            var resumed = false
            while (true) {
                flag.throwIfCancelled()
                if (expected > 0 && part.length() >= expected) break // 本段已完成
                val offset = part.length()
                if (offset > 0 && !resumed) {
                    resumed = true
                    onResumed?.invoke(offset)
                }
                var success = false
                var lastErr: IOException? = null
                for (url in candidates) {
                    flag.throwIfCancelled()
                    try {
                        val extra = if (offset > 0) mapOf("Range" to "bytes=$offset-") else emptyMap()
                        Http.call(url, spec.headers + extra, flag).use { resp ->
                            val body = resp.body ?: throw IOException("空响应")
                            val append = offset > 0 && resp.code == 206
                            if (expected <= 0) {
                                val len = body.contentLength()
                                if (len >= 0) expected = (if (append) offset else 0L) + len
                            }
                            val base = if (append) offset else 0L
                            FileOutputStream(part, append).use { out ->
                                pump(resp, out, flag, finished + base, spec.totalBytes, onProgress, Counter())
                            }
                        }
                        success = true
                        break
                    } catch (e: CancelledException) {
                        throw e
                    } catch (e: Http.HttpException) {
                        if (e.code == 416) { // 请求的范围已在文件末尾之外：本段其实已经下完
                            success = true
                            break
                        }
                        lastErr = e
                    } catch (e: IOException) {
                        lastErr = e
                        Log.w(TAG, "下载失败: ${e.message}")
                    }
                }
                if (success) break
                // 所有地址都失败：断点有进展就再试几轮，原地踏步则放弃
                val stalled = part.length() == offset
                if (++failures >= MAX_ATTEMPTS || (stalled && failures > candidates.size)) {
                    throw lastErr ?: IOException("下载失败")
                }
            }
            finished += part.length()
        }
        file.delete()
        if (!partFile(file, 0, count).renameTo(file)) {
            // 跨不了文件系统时退化为拼接（.part 与目标同目录，正常走不到这里）
            FileOutputStream(file).use { out -> for (i in 0 until count) partFile(file, i, count).inputStream().use { it.copyTo(out) } }
        }
        for (i in 0 until count) partFile(file, i, count).delete()
        return file.length()
    }

    /** 本次尝试已写出的字节数（判断失败后还能不能换地址重试） */
    private class Counter {
        var n = 0L
    }

    /**
     * 把一个响应体写进 [out]，直到读完。
     * 响应必须完整（不少于 Content-Length 声明的字节数），否则抛 IOException。
     */
    private fun pump(
        resp: okhttp3.Response,
        out: OutputStream,
        flag: CancelFlag,
        already: Long,
        total: Long,
        onProgress: Progress,
        counter: Counter,
    ): Long {
        val input: InputStream = resp.body?.byteStream() ?: throw IOException("空响应")
        val declared = resp.body?.contentLength() ?: -1L
        val meter = SpeedMeter()
        var n = 0L
        val buf = ByteArray(256 * 1024)
        try {
            while (true) {
                flag.throwIfCancelled()
                val read = input.read(buf)
                if (read < 0) break
                out.write(buf, 0, read)
                n += read
                counter.n += read
                meter.add(read.toLong())
                val expectTotal = when {
                    total > 0 -> total
                    declared >= 0 -> already + declared
                    else -> -1L
                }
                onProgress.onProgress(already + n, expectTotal, meter.speed())
            }
        } catch (e: IOException) {
            if (n == 0L) throw e
            throw IOException("连接中断（已收到 $n 字节）", e)
        }
        if (declared > 0 && n < declared) throw IOException("连接中断（收到 $n / $declared 字节）")
        return n
    }

    private fun partFile(file: File, index: Int, count: Int): File =
        if (count == 1) File(file.path + ".part") else File("${file.path}.$index.part")
}

/** 滑动窗口测速（每 0.5 秒更新一次的指数平均） */
class SpeedMeter {
    private var lastTs = 0L
    private var windowBytes = 0L
    private var current = 0L

    fun add(bytes: Long) {
        val now = System.currentTimeMillis()
        if (lastTs == 0L) lastTs = now
        windowBytes += bytes
        val dt = now - lastTs
        if (dt >= 500) {
            val inst = windowBytes * 1000 / dt
            current = if (current > 0) (current + inst) / 2 else inst
            windowBytes = 0
            lastTs = now
        }
    }

    fun speed(): Long = current
}
