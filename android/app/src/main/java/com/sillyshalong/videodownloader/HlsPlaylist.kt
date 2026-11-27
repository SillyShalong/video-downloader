package com.sillyshalong.videodownloader

import java.net.URI

/**
 * m3u8 播放列表解析与清晰度选择（纯 Kotlin，不依赖平台 API；JVM 单测覆盖）。
 *
 * 覆盖 HLS（RFC 8216）里 VOD 点播常见的部分：
 *  - 主播放列表（#EXT-X-STREAM-INF）→ 选一路清晰度
 *  - 媒体播放列表：分段地址、时长、字节范围（#EXT-X-BYTERANGE）、AES-128 加密（#EXT-X-KEY）、
 *    fMP4 初始化段（#EXT-X-MAP）
 */
object HlsPlaylist {
    class Variant(
        val uri: String,
        val bandwidth: Long,
        val width: Int,
        val height: Int,
        val fps: Double,
        /** 形如 "avc1.64001f,mp4a.40.2" */
        val codecs: String?,
        /** 所属的独立音轨组（EXT-X-MEDIA 的 GROUP-ID）；通常为 null */
        val audioGroup: String?,
    )

    class Master(val variants: List<Variant>, val audioUris: List<String>)

    class Key(val method: String, val uri: String?, val iv: ByteArray?)

    class Segment(val uri: String, val duration: Double, val range: LongRange?, val key: Key?)

    class Media(
        val segments: List<Segment>,
        /** EXT-X-MAP 的地址：有它说明分段是 fMP4，否则是 MPEG-TS */
        val initUri: String?,
        val mediaSequence: Long,
        /** 没有 #EXT-X-ENDLIST：多半是直播流 */
        val ended: Boolean,
        val totalDuration: Double,
    )

    fun isMaster(text: String): Boolean = text.contains("#EXT-X-STREAM-INF")

    // 属性值要么是带引号的字符串（里面可以有逗号，如 CODECS="avc1.64001f,mp4a.40.2"），要么是不含逗号的裸值
    private val ATTR = Regex("([A-Za-z0-9-]+)=(\"[^\"]*\"|[^,\"]*)")

    private fun attrs(line: String): Map<String, String> =
        ATTR.findAll(line).associate { it.groupValues[1].uppercase() to it.groupValues[2].trim('"') }

    fun parseMaster(text: String, base: String): Master {
        val variants = ArrayList<Variant>()
        val audioUris = ArrayList<String>()
        val lines = text.lines().map { it.trim() }.filter { it.isNotEmpty() }
        var pending: Map<String, String>? = null
        for (line in lines) {
            when {
                line.startsWith("#EXT-X-STREAM-INF") -> pending = attrs(line)
                line.startsWith("#EXT-X-MEDIA") -> attrs(line)["URI"]?.let { audioUris.add(Urls.resolve(base, it)) }
                line.startsWith("#") -> Unit
                pending != null -> {
                    val a = pending
                    pending = null
                    val (w, h) = a["RESOLUTION"]?.split('x')?.mapNotNull { it.toIntOrNull() }
                        ?.takeIf { it.size == 2 }?.let { it[0] to it[1] } ?: (0 to 0)
                    variants.add(
                        Variant(
                            uri = Urls.resolve(base, line),
                            bandwidth = a["AVERAGE-BANDWIDTH"]?.toLongOrNull() ?: a["BANDWIDTH"]?.toLongOrNull() ?: 0L,
                            width = w,
                            height = h,
                            fps = a["FRAME-RATE"]?.toDoubleOrNull() ?: 0.0,
                            codecs = a["CODECS"],
                            audioGroup = a["AUDIO"],
                        ),
                    )
                }
            }
        }
        return Master(variants, audioUris)
    }

    fun parseMedia(text: String, base: String): Media {
        val segments = ArrayList<Segment>()
        var key: Key? = null
        var initUri: String? = null
        var mediaSequence = 0L
        var ended = false
        var duration = 0.0
        var nextDuration = 0.0
        var skipNext = false
        var pendingLength = -1L // #EXT-X-BYTERANGE：长度（-1 = 下一个分段是完整资源）
        var pendingOffset: Long? = null // 起始偏移；没给就紧接上一个范围
        var prevUri: String? = null
        var prevEnd = 0L
        val lines = text.lines().map { it.trim() }.filter { it.isNotEmpty() }
        for (line in lines) {
            when {
                line.startsWith("#EXT-X-KEY") -> {
                    val a = attrs(line)
                    val method = a["METHOD"] ?: "NONE"
                    if (method == "NONE") {
                        key = null
                    } else {
                        if (method != "AES-128") throw Http.ApiException("该视频使用了暂不支持的加密方式（$method）")
                        val uri = a["URI"]?.let { Urls.resolve(base, it) } ?: throw Http.ApiException("播放列表里的加密信息不完整")
                        key = Key(method, uri, a["IV"]?.removePrefix("0x")?.removePrefix("0X")?.let(::hex))
                    }
                }
                line.startsWith("#EXT-X-MAP") -> initUri = attrs(line)["URI"]?.let { Urls.resolve(base, it) }
                line.startsWith("#EXT-X-MEDIA-SEQUENCE") -> mediaSequence = line.substringAfter(':').trim().toLongOrNull() ?: 0L
                line.startsWith("#EXT-X-ENDLIST") -> ended = true
                line.startsWith("#EXT-X-BYTERANGE") -> {
                    // 形如 <n>[@<o>]：长度@起始偏移
                    val spec = line.substringAfter(':').trim()
                    pendingLength = spec.substringBefore('@').toLongOrNull() ?: -1L
                    pendingOffset = spec.substringAfter('@', "").toLongOrNull()
                }
                line.startsWith("#EXTINF") -> nextDuration = line.substringAfter(':').substringBefore(',').trim().toDoubleOrNull() ?: 0.0
                line.startsWith("#EXT-X-GAP") -> skipNext = true
                line.startsWith("#") -> Unit
                else -> {
                    val skip = skipNext
                    skipNext = false
                    val length = pendingLength
                    val offset = pendingOffset
                    pendingLength = -1L
                    pendingOffset = null
                    val uri = Urls.resolve(base, line)
                    val range = if (length < 0) null else {
                        val start = offset ?: if (uri == prevUri) prevEnd else 0L
                        prevEnd = start + length
                        (start until start + length)
                    }
                    prevUri = uri
                    if (skip) continue
                    segments.add(Segment(uri, nextDuration, range, key))
                    duration += nextDuration
                }
            }
        }
        if (segments.isEmpty()) throw Http.ApiException("播放列表里没有任何分段（可能不是视频播放列表，或链接已失效）")
        return Media(segments, initUri, mediaSequence, ended, duration)
    }

    /**
     * 选一路清晰度：不超过 [maxHeight] 的最高一路；都超过就取最低的一路。
     * 同等清晰度优先 H.264（avc）。
     */
    fun pick(master: Master, maxHeight: Int): Variant {
        if (master.variants.isEmpty()) throw Http.ApiException("播放列表里没有任何清晰度可选")
        fun side(v: Variant) = if (v.width > 0 && v.height > 0) minOf(v.width, v.height) else 0
        fun isAvc(v: Variant) = v.codecs?.startsWith("avc") == true
        val best = compareBy<Variant>({ side(it) }, { if (isAvc(it)) 1 else 0 }, { it.bandwidth })
        val fitting = master.variants.filter { side(it) in 1..maxHeight }
        val sized = master.variants.filter { side(it) > 0 }
        val chosen = when {
            fitting.isNotEmpty() -> fitting.maxWithOrNull(best) // 不超过上限的最高一档
            sized.isNotEmpty() -> sized.minWithOrNull(best) // 都超过上限：取最接近的最低一档，别下个超大文件
            else -> null // 没有任何一路写了分辨率
        } ?: master.variants[0]
        // 独立音轨（EXT-X-MEDIA TYPE=AUDIO）需要再下载一路音频再合成，暂不支持
        if (chosen.audioGroup != null && master.audioUris.isNotEmpty()) {
            throw Http.ApiException("这个视频的音轨是单独一路的流，暂不支持下载")
        }
        return chosen
    }

    /** 128 位的 IV：给了就用给的，没给就用分段所在的媒体序号 */
    fun ivAt(key: Key, sequence: Long): ByteArray {
        key.iv?.let { if (it.size == 16) return it }
        return ByteArray(16).also { for (i in 0 until 8) it[15 - i] = (sequence ushr (8 * i)).toByte() }
    }

    fun iv(key: Key, mediaSequence: Long, index: Int): ByteArray = ivAt(key, mediaSequence + index)

    private fun hex(s: String): ByteArray? {
        if (s.length != 32) return null
        return try {
            ByteArray(16) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        } catch (_: NumberFormatException) {
            null
        }
    }
}
