package com.sillyshalong.videodownloader

import android.content.ContentValues
import android.content.Context
import android.os.Environment
import android.provider.MediaStore
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.OutputStream
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 直链流式下载：OkHttp → 系统下载目录（Download/VideoDownloader，MediaStore），
 * 带测速/ETA/取消。多 CDN 镜像容灾。
 */
object HttpDownloader {
    private const val DESKTOP_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

    interface Progress {
        fun onProgress(percent: Double, downloaded: Long, total: Long, speed: Long, eta: Int)
        fun onCancelled()
        fun registerCancel(fn: () -> Unit)
    }

    /** 进度回调的区间缩放装饰器：把 [0,100] 映射到 [from, from+span]（多阶段进度用） */
    class ProgressSpan(private val inner: Progress, from: Double, span: Double) : Progress {
        private val from = from
        private val span = span
        override fun onProgress(percent: Double, downloaded: Long, total: Long, speed: Long, eta: Int) {
            val scaled = if (percent < 0) -1.0 else from + percent / 100.0 * span
            inner.onProgress(scaled, downloaded, total, speed, eta)
        }
        override fun onCancelled() = inner.onCancelled()
        override fun registerCancel(fn: () -> Unit) = inner.registerCancel(fn)
    }

    /** 缩放便捷方法：asPart(from=0.6, span=0.2) 表示占整体进度的 60%~80% */
    fun Progress.asPart(from: Double, span: Double): Progress = ProgressSpan(this, from, span)

    data class Saved(val displayPath: String, val sizeBytes: Long)

    /** 下载到 MediaStore（系统下载目录），返回展示路径与大小 */
    fun download(ctx: Context, info: DownloadSpec, cb: Progress): Saved {
        val cancelled = AtomicBoolean(false)
        cb.registerCancel { cancelled.set(true) }
        var lastErr: Exception? = null
        for (url in info.urls) {
            try {
                return doDownloadOne(ctx, info, url, cancelled, cb)
            } catch (e: InterruptedException) {
                cb.onCancelled()
                throw e
            } catch (e: Exception) {
                if (cancelled.get()) { cb.onCancelled(); throw InterruptedException() }
                lastErr = e
            }
        }
        throw RuntimeException("下载失败: ${lastErr?.message}")
    }

    /** 下载到应用缓存目录的临时文件（供封装等后处理），返回 File */
    fun downloadToCache(ctx: Context, info: DownloadSpec, cb: Progress): File {
        val cancelled = AtomicBoolean(false)
        cb.registerCancel { cancelled.set(true) }
        var lastErr: Exception? = null
        for (url in info.urls) {
            try {
                val req = Request.Builder().url(url)
                    .header("User-Agent", DESKTOP_UA)
                    .header("Referer", "https://www.bilibili.com/")
                    .build()
                client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) throw RuntimeException("HTTP ${resp.code}")
                    val body = resp.body ?: throw RuntimeException("空响应")
                    val total = if (body.contentLength() > 0) body.contentLength() else info.totalBytes
                    val tmp = File.createTempFile("vd-", ".part", ctx.cacheDir)
                    var done = 0L
                    var speed = 0L
                    var winBytes = 0L
                    var lastTick = System.currentTimeMillis()
                    val buf = ByteArray(64 * 1024)
                    tmp.outputStream().use { o ->
                        while (true) {
                            if (cancelled.get()) throw InterruptedException()
                            val n = body.byteStream().read(buf)
                            if (n < 0) break
                            o.write(buf, 0, n)
                            done += n
                            winBytes += n
                            val now = System.currentTimeMillis()
                            val dt = (now - lastTick) / 1000.0
                            if (dt >= 0.4) {
                                val inst = (winBytes / dt).toLong()
                                speed = if (speed > 0) speed / 2 + inst / 2 else inst
                                winBytes = 0
                                lastTick = now
                            }
                            val pct = if (total > 0) done.toDouble() / total * 100 else -1.0
                            val eta = if (total > 0 && speed > 0) ((total - done) / speed).toInt() else -1
                            cb.onProgress(pct, done, total, speed, eta)
                        }
                    }
                    return tmp
                }
            } catch (e: InterruptedException) {
                cb.onCancelled()
                throw e
            } catch (e: Exception) {
                lastErr = e
            }
        }
        throw RuntimeException("下载失败: ${lastErr?.message}")
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private fun doDownloadOne(
        ctx: Context,
        info: DownloadSpec,
        url: String,
        cancelled: AtomicBoolean,
        cb: Progress,
    ): Saved {
        val client = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
        val req = Request.Builder().url(url)
            .header("User-Agent", DESKTOP_UA)
            .header("Referer", "https://www.bilibili.com/")
            .build()
        client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw RuntimeException("HTTP ${resp.code}")
            val body = resp.body ?: throw RuntimeException("空响应")
            val total = if (body.contentLength() > 0) body.contentLength() else info.totalBytes

            // MediaStore：公共下载目录，无需存储权限
            val name = info.fileName.ifBlank { "video_${System.currentTimeMillis()}.mp4" }
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, if (name.endsWith(".m4a")) "audio/mp4" else "video/mp4")
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/VideoDownloader")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = ctx.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw RuntimeException("创建下载文件失败")
            try {
                val out: OutputStream = resolver.openOutputStream(uri)!!
                var done = 0L
                var speed = 0L
                var winBytes = 0L
                var lastTick = System.currentTimeMillis()
                val buf = ByteArray(64 * 1024)
                out.use { o ->
                    while (true) {
                        if (cancelled.get()) throw InterruptedException()
                        val n = body.byteStream().read(buf)
                        if (n < 0) break
                        o.write(buf, 0, n)
                        done += n
                        winBytes += n
                        val now = System.currentTimeMillis()
                        val dt = (now - lastTick) / 1000.0
                        if (dt >= 0.4) {
                            val inst = (winBytes / dt).toLong()
                            speed = if (speed > 0) speed / 2 + inst / 2 else inst
                            winBytes = 0
                            lastTick = now
                        }
                        val pct = if (total > 0) done.toDouble() / total * 100 else -1.0
                        val eta = if (total > 0 && speed > 0) ((total - done) / speed).toInt() else -1
                        cb.onProgress(pct, done, total, speed, eta)
                    }
                }
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
                cb.onProgress(100.0, done, if (total > 0) total else done, speed, 0)
                return Saved("Download/VideoDownloader/$name", done)
            } catch (e: Exception) {
                try { resolver.delete(uri, null, null) } catch (_: Exception) {}
                throw e
            }
        }
    }
}
