package com.sillyshalong.videodownloader

import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * HLS 分段下载：按播放列表逐段下载（需要时用 AES-128 解密），顺序追加写进一个本地文件。
 *
 * 断点续传：[stateFile] 记录已经写完的分段数，恢复时跳过它们从下一片继续。
 */
object HlsDownloader {
    private const val TAG = "HlsDownloader"
    private const val ATTEMPTS = 3

    /**
     * @param onProgress （已完成分段数， 总分段数），每写完一段回调一次
     * @return 文件大小
     */
    fun download(
        media: HlsPlaylist.Media,
        headers: Map<String, String>,
        out: File,
        stateFile: File,
        flag: CancelFlag,
        onProgress: ((Int, Int) -> Unit)? = null,
    ): Long {
        var done = if (out.exists() && stateFile.exists()) stateFile.readText().trim().toIntOrNull() ?: 0 else 0
        if (done < 0 || done > media.segments.size) done = 0
        if (done == 0) out.delete()
        out.parentFile?.mkdirs()
        val total = media.segments.size

        FileOutputStream(out, done > 0).use { sink ->
            val keys = HashMap<String, ByteArray>()
            var cachedUrl: String? = null
            var cachedBytes = ByteArray(0)

            // 同一个地址被相邻的分段按字节范围切着用时，整份只下载一次
            fun fetch(uri: String, range: LongRange?): ByteArray {
                if (range != null && cachedUrl == uri && cachedBytes.size > range.last) {
                    return cachedBytes.copyOfRange(range.first.toInt(), range.last.toInt() + 1)
                }
                val extra = if (range != null) mapOf("Range" to "bytes=${range.first}-${range.last}") else emptyMap()
                val bytes = fetchWithRetry(uri, headers + extra, flag)
                if (range != null) {
                    cachedUrl = uri
                    cachedBytes = bytes
                } else {
                    cachedUrl = null
                }
                return if (range != null && bytes.size > range.last) bytes.copyOfRange(range.first.toInt(), range.last.toInt() + 1) else bytes
            }

            // fMP4 的初始化段要写在最前面
            media.initUri?.let { if (done == 0) sink.write(fetch(it, null)) }
            for (i in done until total) {
                flag.throwIfCancelled()
                val seg = media.segments[i]
                var data = fetch(seg.uri, seg.range)
                seg.key?.let { k ->
                    val keyUri = k.uri ?: throw Http.ApiException("播放列表里的加密信息不完整")
                    val keyBytes = keys[keyUri] ?: Http.bytes(keyUri, headers, flag).also {
                        if (it.size != 16) throw Http.ApiException("视频流的解密密钥格式异常")
                        keys[keyUri] = it
                    }
                    data = decrypt(data, keyBytes, HlsPlaylist.iv(k, media.mediaSequence, i))
                }
                sink.write(data)
                sink.flush()
                stateFile.writeText((i + 1).toString())
                onProgress?.invoke(i + 1, total)
            }
        }
        return out.length()
    }

    private fun fetchWithRetry(uri: String, headers: Map<String, String>, flag: CancelFlag): ByteArray {
        var last: IOException? = null
        repeat(ATTEMPTS) { attempt ->
            flag.throwIfCancelled()
            try {
                return Http.call(uri, headers, flag).use { it.body?.bytes() ?: ByteArray(0) }
            } catch (e: CancelledException) {
                throw e
            } catch (e: IOException) {
                last = e
                Log.w(TAG, "分段下载失败（第 ${attempt + 1} 次）: ${e.message}")
                if (attempt < ATTEMPTS - 1) try {
                    Thread.sleep(500L * (attempt + 1))
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                }
            }
        }
        throw last ?: IOException("分段下载失败")
    }

    /**
     * AES-128 CBC 解密。按标准最后会带 PKCS7 填充，去掉；
     * 有些实现用 0 补齐或不补，那就原样保留（结尾多几个字节不影响播放）。
     */
    fun decrypt(data: ByteArray, key: ByteArray, iv: ByteArray): ByteArray {
        val usable = data.size - data.size % 16
        val cipher = Cipher.getInstance("AES/CBC/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
        val plain = cipher.doFinal(data, 0, usable)
        val pad = plain.lastOrNull()?.toInt()?.and(0xFF) ?: 0
        val padded = pad in 1..16 && plain.size >= pad && plain.takeLast(pad).all { (it.toInt() and 0xFF) == pad }
        return if (padded) plain.copyOf(plain.size - pad) else plain
    }
}
