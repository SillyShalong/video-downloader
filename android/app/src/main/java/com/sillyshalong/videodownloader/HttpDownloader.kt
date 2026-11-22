package com.sillyshalong.videodownloader

import android.content.ContentValues
import android.content.Context
import android.os.Environment
import android.provider.MediaStore
import okhttp3.OkHttpClient
import okhttp3.Request
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

    fun download(ctx: Context, info: DownloadSpec, cb: Progress) {
        val cancelled = AtomicBoolean(false)
        cb.registerCancel { cancelled.set(true) }
        var lastErr: Exception? = null
        for (url in info.urls) {
            try {
                doDownloadOne(ctx, info, url, cancelled, cb)
                return
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

    private fun doDownloadOne(
        ctx: Context,
        info: DownloadSpec,
        url: String,
        cancelled: AtomicBoolean,
        cb: Progress,
    ) {
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
            } catch (e: Exception) {
                try { resolver.delete(uri, null, null) } catch (_: Exception) {}
                throw e
            }
        }
    }
}
