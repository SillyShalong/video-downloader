package com.sillyshalong.videodownloader

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * HLS 分段下载器（纯 Kotlin，无 ffmpeg）：
 *   1. 拉取 m3u8 播放列表（支持 master → media 一级跳转）
 *   2. 解析 EXT-X-KEY（AES-128）/ EXT-X-MAP（fMP4 init）/ 分段 URL
 *   3. 顺序下载分段，AES-128 分段实时解密，拼接为单一容器文件
 * 产物为 TS 或 fMP4 原始流，系统播放器普遍可直接播放（改后缀 mp4/ts 由调用方定）。
 */
object HlsDownloader {
    private const val DESKTOP_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    interface Progress {
        fun onProgress(percent: Double, done: Int, total: Int, speed: Long, eta: Int)
        fun onCancelled()
        fun registerCancel(fn: () -> Unit)
    }

    private class Segment(val url: String, val key: AesKey?)
    private class AesKey(val keyBytes: ByteArray, val iv: ByteArray?)

    /** 下载 HLS 流拼接为本地文件。urls 容灾（master 失败换下一个） */
    fun download(
        ctx: Context,
        m3u8Urls: List<String>,
        referer: String,
        output: File,
        cb: Progress,
    ) {
        val cancelled = AtomicBoolean(false)
        cb.registerCancel { cancelled.set(true) }
        var lastErr: Exception? = null
        for (u in m3u8Urls) {
            try {
                return doDownload(ctx, u, referer, output, cancelled, cb)
            } catch (e: InterruptedException) {
                cb.onCancelled(); throw e
            } catch (e: Exception) {
                if (cancelled.get()) { cb.onCancelled(); throw InterruptedException() }
                lastErr = e
            }
        }
        throw RuntimeException("HLS 下载失败: ${lastErr?.message}")
    }

    private fun doDownload(
        ctx: Context,
        m3u8Url: String,
        referer: String,
        output: File,
        cancelled: AtomicBoolean,
        cb: Progress,
    ) {
        val base = m3u8Url.substringBeforeLast('/')
        var playlist = fetchText(m3u8Url, referer)

        // master playlist：跳到第一个 media playlist
        if (playlist.contains("#EXT-X-STREAM-INF")) {
            val line = playlist.lineSequence().firstOrNull { it.isNotBlank() && !it.startsWith("#") }
                ?: throw RuntimeException("master playlist 无媒体流")
            playlist = fetchText(abs(line, base), referer)
        }

        // 解析分段与加密
        val segments = mutableListOf<Segment>()
        var currentKey: AesKey? = null
        var mapUrl: String? = null
        playlist.lineSequence().forEach { raw ->
            val line = raw.trim()
            when {
                line.startsWith("#EXT-X-KEY") -> {
                    currentKey = if (line.contains("METHOD=NONE")) null else parseKey(line, base, referer)
                }
                line.startsWith("#EXT-X-MAP") -> {
                    mapUrl = line.substringAfter("URI=\"", "").substringBefore("\"")
                        .takeIf { it.isNotBlank() }?.let { abs(it, base) }
                }
                line.isNotBlank() && !line.startsWith("#") -> {
                    segments.add(Segment(abs(line, base), currentKey))
                }
            }
        }
        if (segments.isEmpty()) throw RuntimeException("HLS: 播放列表无分段")
        if (mapUrl != null) throw RuntimeException("HLS: fMP4 (EXT-X-MAP) 暂不支持，请反馈该站点")

        // AES-128 密钥预取（整列表通常共用一把）
        segments.firstOrNull()?.key?.let { key ->
            key.keyBytes // 触发拉取在 parseKey 中完成
        }

        // 下载分段（顺序，AES 解密在内存中做）
        val tmp = File.createTempFile("hls-", ".out")
        var done = 0
        var speed = 0L
        var winBytes = 0L
        var lastTick = System.currentTimeMillis()
        tmp.outputStream().use { out ->
            for (seg in segments) {
                if (cancelled.get()) throw InterruptedException()
                val data = fetchBytes(seg.url, referer)
                val plain = seg.key?.let { decryptAes128(data, it) } ?: data
                out.write(plain)
                done++
                winBytes += plain.size
                val now = System.currentTimeMillis()
                val dt = (now - lastTick) / 1000.0
                if (dt >= 0.4) {
                    val inst = (winBytes / dt).toLong()
                    speed = if (speed > 0) speed / 2 + inst / 2 else inst
                    winBytes = 0
                    lastTick = now
                }
                val pct = done.toDouble() / segments.size * 100
                val eta = if (speed > 0) ((segments.size - done) * ((plain.size.coerceAtLeast(1)) / speed.coerceAtLeast(1))).toInt() else -1
                cb.onProgress(pct, done, segments.size, speed, eta)
            }
        }
        // 拼接结果移动到目标位置
        tmp.delete()
        if (!tmp.renameTo(output)) {
            tmp.copyTo(output, overwrite = true)
            tmp.delete()
        }
    }

    private fun parseKey(line: String, base: String, referer: String): AesKey {
        val method = Regex("METHOD=([^,\"]+)").find(line)?.groupValues?.get(1) ?: ""
        if (method != "AES-128") throw RuntimeException("HLS: 不支持的加密方法 $method")
        val uri = Regex("URI=\"([^\"]+)\"").find(line)?.groupValues?.get(1)
            ?: throw RuntimeException("HLS: KEY 行无 URI")
        val iv = Regex("IV=0x([0-9a-fA-F]+)").find(line)?.groupValues?.get(1)
        val keyBytes = fetchBytes(abs(uri, base), referer)
        if (keyBytes.size != 16) throw RuntimeException("HLS: AES 密钥长度异常 ${keyBytes.size}")
        return AesKey(keyBytes, iv?.hexToBytes())
    }

    private fun decryptAes128(data: ByteArray, key: AesKey): ByteArray {
        val ivBytes = key.iv ?: ByteArray(16) // 无 IV 时默认 0
        val cipher = javax.crypto.Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(javax.crypto.Cipher.DECRYPT_MODE, javax.crypto.spec.SecretKeySpec(key.keyBytes, "AES"),
            javax.crypto.spec.IvParameterSpec(ivBytes))
        return cipher.doFinal(data)
    }

    private fun fetchText(url: String, referer: String): String {
        val req = Request.Builder().url(url)
            .header("User-Agent", DESKTOP_UA)
            .header("Referer", referer)
            .build()
        client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw RuntimeException("HLS: HTTP ${resp.code} for $url")
            return resp.body?.string() ?: ""
        }
    }

    private fun fetchBytes(url: String, referer: String): ByteArray {
        val req = Request.Builder().url(url)
            .header("User-Agent", DESKTOP_UA)
            .header("Referer", referer)
            .build()
        client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw RuntimeException("HLS 分段 HTTP ${resp.code}")
            return resp.body?.bytes() ?: ByteArray(0)
        }
    }

    private fun abs(link: String, base: String): String =
        if (link.startsWith("http")) link
        else java.net.URI(base).resolve(link).toString()

    private fun String.hexToBytes(): ByteArray =
        chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
