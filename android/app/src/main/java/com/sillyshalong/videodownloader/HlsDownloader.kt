package com.sillyshalong.videodownloader

import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * HLS 分段下载：按播放列表逐段下载（需要时用 AES-128 解密），顺序追加写进一个本地文件。
 *
 * 断点续传：[stateFile] 记录「下一个要下载的分段的媒体序号」和文件长度，恢复时跳过它之前的分段。
 * 暂停、失败之后重试都从这里接着下，已经下好的分段不重来。
 *
 * 分段地址过期：很多服务器的分段地址带有效期（地址里带 token），长视频下到一半服务器就开始回 HTTP 403。
 * 这时通过 [reload] 重新读一遍播放列表换新地址，接着下。
 */
object HlsDownloader {
    private const val TAG = "HlsDownloader"

    /** 同一个分段最多试几次（网络抖动、限流） */
    private const val ATTEMPTS = 5

    /** 刷新播放列表之后同一段还是过期：连着这么多次就放弃（地址有效期短的长视频可以刷新很多次，不受这个限制） */
    private const val MAX_FRUITLESS_RELOADS = 3

    /** 「地址过期」时服务器常见的回应 */
    private fun expired(code: Int): Boolean = code == 401 || code == 403 || code == 410

    /**
     * @param headers 下载分段时要带的请求头。[reload] 可以就地更新它（比如网页重新验证后 Cookie 变了）
     * @param onProgress （已完成分段数，总分段数），每写完一段回调一次
     * @param onLog 需要让用户知道的事（断点续传、地址过期后刷新、重试……）
     * @param reload 重新读一遍播放列表，返回新的分段列表；null = 不支持刷新
     * @return 文件大小
     */
    fun download(
        media: HlsPlaylist.Media,
        headers: MutableMap<String, String>,
        out: File,
        stateFile: File,
        flag: CancelFlag,
        onProgress: ((Int, Int) -> Unit)? = null,
        onLog: ((String) -> Unit)? = null,
        reload: (() -> HlsPlaylist.Media)? = null,
    ): Long {
        val first = media.mediaSequence
        val total = media.segments.size
        val end = first + total
        val fp = fingerprint(media)
        val initUri = media.initUri

        // 接着上次：状态文件和现在的播放列表对得上才续，对不上（换了视频、列表变了）就从头来
        var next = first
        var resumeLength = -1L
        if (out.exists() && stateFile.exists()) {
            val saved = runCatching { readState(stateFile.readText(), first) }.getOrNull()
            when {
                saved == null || (saved.fingerprint != null && saved.fingerprint != fp) || saved.next < first || saved.next > end ->
                    onLog?.invoke("播放列表和上次下载时不一样，从头开始")
                saved.next > first -> {
                    next = saved.next
                    resumeLength = saved.rawLength
                }
                else -> Unit // 一段都还没下完
            }
        }
        if (next == first) {
            out.delete()
            stateFile.delete()
        } else {
            if (resumeLength >= 0 && out.length() != resumeLength) {
                // 写完一段、还没来得及记状态就被打断了：文件里多出一段，按记录的长度截掉，免得重复
                RandomAccessFile(out, "rw").use { it.setLength(resumeLength) }
            }
            onLog?.invoke("分段从断点继续下载（已完成 ${next - first} 段，共 $total 段）")
        }
        out.parentFile?.mkdirs()
        stateFile.parentFile?.mkdirs()

        var list = media
        var fruitless = 0 // 刷新之后一段都没下成就又过期了
        var lastReloadAt = -1L
        FileOutputStream(out, next > first).use { sink ->
            val keys = HashMap<String, ByteArray>()
            var cachedUrl: String? = null
            var cachedBytes = ByteArray(0)

            // 同一个地址被相邻的分段按字节范围切着用时，整份只下载一次
            fun fetch(uri: String, range: LongRange?): ByteArray {
                if (range != null && cachedUrl == uri && cachedBytes.size > range.last) {
                    return cachedBytes.copyOfRange(range.first.toInt(), range.last.toInt() + 1)
                }
                val bytes = fetchSegment(uri, range, headers, flag, onLog)
                if (range != null) {
                    cachedUrl = uri
                    cachedBytes = bytes
                } else {
                    cachedUrl = null
                }
                return if (range != null && bytes.size > range.last) bytes.copyOfRange(range.first.toInt(), range.last.toInt() + 1) else bytes
            }

            /** 下一段（第 [seq] 号）。地址过期时抛 HttpException 交给外层去刷新播放列表 */
            fun fetchOne(seq: Long): ByteArray {
                val i = (seq - list.mediaSequence).toInt()
                if (i !in list.segments.indices) throw Http.ApiException("刷新后的播放列表里找不到第 ${seq - first + 1} 段，无法继续下载")
                val seg = list.segments[i]
                val data = fetch(seg.uri, seg.range)
                val k = seg.key ?: return data
                val keyUri = k.uri ?: throw Http.ApiException("播放列表里的加密信息不完整")
                val keyBytes = keys[keyUri] ?: Http.bytes(keyUri, headers, flag).also {
                    if (it.size != 16) throw Http.ApiException("视频流的解密密钥格式异常")
                    keys[keyUri] = it
                }
                return decrypt(data, keyBytes, HlsPlaylist.ivAt(k, seq))
            }

            // fMP4 的初始化段要写在最前面
            if (initUri != null && next == first) sink.write(fetch(initUri, null))
            while (next < end) {
                flag.throwIfCancelled()
                val data = try {
                    fetchOne(next)
                } catch (e: Http.HttpException) {
                    if (!expired(e.code) || reload == null) throw e
                    // 分段地址过期：重新读一遍播放列表，换新地址接着下。
                    // 只要每次刷新之后都有进展（至少下成了一段）就一直刷新 —— 长视频的有效期短，过很多次也是正常的；
                    // 刷新之后还是同一段过期，连着几次就说明不是有效期的问题，放弃
                    if (next == lastReloadAt && ++fruitless >= MAX_FRUITLESS_RELOADS) throw e
                    lastReloadAt = next
                    val latest = reload()
                    val j = (next - latest.mediaSequence).toInt()
                    if (j !in latest.segments.indices) throw e
                    list = latest
                    onLog?.invoke("分段地址已过期（HTTP ${e.code}），已刷新播放列表，从第 ${next - first + 1} 段继续")
                    continue
                }
                sink.write(data)
                sink.flush()
                next++
                writeState(stateFile, next, out.length(), fp)
                onProgress?.invoke((next - first).toInt(), total)
            }
        }
        stateFile.delete()
        return out.length()
    }

    /** 下载一个分段（或其中的字节范围），失败后退避重试 */
    private fun fetchSegment(
        uri: String,
        range: LongRange?,
        headers: Map<String, String>,
        flag: CancelFlag,
        onLog: ((String) -> Unit)?,
    ): ByteArray {
        val extra = if (range != null) mapOf("Range" to "bytes=${range.first}-${range.last}") else emptyMap()
        var last: IOException? = null
        repeat(ATTEMPTS) { attempt ->
            flag.throwIfCancelled()
            try {
                return Http.call(uri, headers + extra, flag).use { it.body?.bytes() ?: ByteArray(0) }
            } catch (e: CancelledException) {
                throw e
            } catch (e: IOException) {
                last = e
                Log.w(TAG, "分段下载失败（第 ${attempt + 1} 次）: ${e.message}")
                if (attempt == 0) onLog?.invoke("分段下载失败（${e.message ?: e.javaClass.simpleName}），正在重试")
                // 地址过期同一个地址再试也没用：多试一次就交出去刷新播放列表
                if (e is Http.HttpException && expired(e.code) && attempt >= 1) throw e
                if (attempt < ATTEMPTS - 1) try {
                    Thread.sleep(500L shl attempt)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                }
            }
        }
        throw last ?: IOException("分段下载失败")
    }

    /** 播放列表的「指纹」：段数和总时长。续传前用它确认还是同一份列表 */
    private fun fingerprint(media: HlsPlaylist.Media): String =
        "${media.segments.size}|${Math.round(media.totalDuration * 1000.0)}"

    /** [fingerprint] 为 null 表示是旧版状态文件（没记指纹），没法核对，按对得上处理 */
    private class SavedState(val next: Long, val rawLength: Long, val fingerprint: String?)

    /**
     * 状态文件：每行依次是 版本(2)、下一个要下载的媒体序号、文件长度、播放列表指纹。
     * 旧版本只有一个数字（已完成的段数），按当时的列表起始序号换算。
     */
    private fun readState(text: String, first: Long): SavedState? {
        val lines = text.trim().lines().map { it.trim() }
        if (lines.isEmpty()) return null
        if (lines.size == 1) {
            val done = lines[0].toLongOrNull() ?: return null
            return SavedState(first + done, -1L, null)
        }
        if (lines.size < 4 || lines[0] != "2") return null
        val next = lines[1].toLongOrNull() ?: return null
        val rawLength = lines[2].toLongOrNull() ?: return null
        return SavedState(next, rawLength, lines[3])
    }

    private fun writeState(stateFile: File, next: Long, rawLength: Long, fingerprint: String) {
        // 先写临时文件再改名：写一半被打断也不会留下残缺的状态
        val tmp = File(stateFile.path + ".tmp")
        tmp.writeText("2\n$next\n$rawLength\n$fingerprint\n")
        if (!tmp.renameTo(stateFile)) {
            stateFile.writeText("2\n$next\n$rawLength\n$fingerprint\n")
            tmp.delete()
        }
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
