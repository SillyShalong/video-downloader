package com.sillyshalong.videodownloader.mp4

import android.media.MediaExtractor
import android.media.MediaFormat
import com.sillyshalong.videodownloader.Http
import com.sillyshalong.videodownloader.TsTail
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer

private const val UNSET = Long.MIN_VALUE

/**
 * 用系统 MediaExtractor 从 MPEG-TS / FLV 这类「没有现成 sample table」的文件里读出音视频轨。
 *
 * 整个文件只开一个 MediaExtractor 实例（[TsDemuxer]），里面的轨道都选中、按文件里的顺序一起读走：
 * 读到哪一路的 sample 就交给那一路的 [ExtractorSampleSource] 排队，等着被合成器取用。
 *
 * 不能「每路轨道各开一个实例、只选自己那一路」：系统解析器照样会解析文件里的所有轨道，
 * 没被读走的那一路全堆在系统的解析器进程里 —— 实测堆到 600MB 左右那个进程就崩了，
 * 十几分钟以上的视频合成到一半被截断。
 *
 * MediaExtractor 只给显示时间（pts），不给解码时间。带 B 帧的视频，解码顺序就是文件里的顺序，
 * 解码时间按下面的规则合成，显示时间原样保留——所以画面顺序、音画同步都和源一致：
 *   视频轨：dts[i] = max(dts[i-1] + 1, min(pts[i], dts[i-1] + 一帧的时长))
 *           帧时长取「最近若干帧的显示时间排序后最小的相邻差」。
 *           （不能取「解码顺序里相邻两帧的时间差」：带 B 帧时那是 2 帧、3 帧的间隔，甚至为负）
 *   音频轨：dts = pts
 * 负的显示偏移由 Mp4Writer 统一处理。
 */
class TsDemuxer(file: File) : Closeable {
    private val extractor = MediaExtractor()
    private val sources = ArrayList<ExtractorSampleSource>()

    /** 整个文件的大小（进度用） */
    internal val fileBytes = file.length()

    /** 文件读完了（所有轨道都不会再有 sample） */
    private var ended = false
    private var released = false

    /** 读到的媒体数据字节数、以及最后一个 sample 的显示时间：读完后用来核对文件是不是真的读完了 */
    private var consumed = 0L
    private var lastPtsUs = UNSET

    init {
        extractor.setDataSource(file.path)
    }

    /** 文件里这一类轨道（"video" / "audio"）的 (轨道下标, 格式)；没有返回 null */
    private fun track(kind: String): Pair<Int, MediaFormat>? {
        for (i in 0 until extractor.trackCount) {
            val f = extractor.getTrackFormat(i)
            if (f.getString(MediaFormat.KEY_MIME)?.startsWith("$kind/") == true) return i to f
        }
        return null
    }

    /** 为 [kind] 这一路建一个 sample 流（文件里没有这一路时抛 ApiException） */
    fun source(kind: String): ExtractorSampleSource {
        val (trackIndex, fmt) = track(kind)
            ?: throw Http.ApiException(if (kind == "video") "视频流里没有可识别的视频轨" else "视频流里没有可识别的音频轨")
        val source = ExtractorSampleSource(this, kind, trackIndex, fmt)
        sources.add(source)
        extractor.selectTrack(trackIndex)
        return source
    }

    /**
     * 继续从文件里读，直到 [source] 手上有 sample 可用，或者文件读完。
     * 路上读到的别的轨道的 sample 交给那一路先排着（合成器马上就会来取，所以攒不了多少）。
     * @return [source] 现在是否有 sample
     */
    internal fun feed(source: ExtractorSampleSource): Boolean {
        while (source.isEmpty()) {
            if (ended) return false
            val trackIndex = extractor.sampleTrackIndex
            if (trackIndex < 0 || extractor.sampleTime >= TsTail.FLUSH_PTS_US) {
                // 到结尾了。显示时间大得离谱的只可能是文件末尾补的「下一帧」（见 TsTail）：真实数据到这儿就读完了。
                // （解析器所在的系统进程崩了之后，这里也会表现成「到结尾了」——所以读完之后要用 [assertComplete] 核对）
                ended = true
                for (s in sources) s.finish()
                return false
            }
            val owner = sources.firstOrNull { it.trackIndex == trackIndex }
            if (owner == null) {
                extractor.advance() // 别的轨道（没被选中的）的数据：跳过
                continue
            }
            try {
                consumed += owner.take()
                if (lastPtsUs == UNSET || owner.lastRawPtsUs > lastPtsUs) lastPtsUs = owner.lastRawPtsUs
            } catch (e: IOException) {
                throw e
            } catch (e: Exception) {
                // 解析器出错（比如它所在的系统进程崩了之后的调用）
                throw IOException("系统媒体解析器读取出错：${e.message ?: e.javaClass.simpleName}", e)
            }
        }
        return true
    }

    /* 只给 ExtractorSampleSource 用的系统解析器接口（当前 sample 属于哪一路由 feed 判断过了） */
    internal fun read(buf: ByteArray): Int = extractor.readSampleData(ByteBuffer.wrap(buf), 0)
    internal fun sampleTimeUs(): Long = extractor.sampleTime
    internal fun sampleIsSync(): Boolean = extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0
    internal fun advance() = extractor.advance()

    /** 各路里最早的显示时间（微秒）；一路数据都没有时为 null */
    private fun firstPtsUs(): Long? = sources.mapNotNull { it.firstPtsUsOrNull() }.minOrNull()

    /**
     * 文件读完之后调用：核对真的读完了。
     *
     * 系统解析器中途出错（它所在的进程崩了）时，「读不出来」在接口上和「读完了」一模一样。
     * 不核对的话，就会得到一个只有前半截的文件还显示成功。
     * @param expectedSeconds 这个文件应有的时长（秒）；<= 0 表示不知道，只按读到的数据量粗略判断
     */
    fun assertComplete(expectedSeconds: Double) {
        val read = consumed.toDouble() / fileBytes.coerceAtLeast(1)
        val first = firstPtsUs()
        val spanSeconds = if (first == null || lastPtsUs == UNSET) 0.0 else (lastPtsUs - first) / 1_000_000.0
        val short = if (expectedSeconds > 0) {
            spanSeconds + COMPLETE_SLACK_SECONDS < expectedSeconds
        } else {
            read < MIN_READ_RATIO
        }
        if (short) {
            val detail = "只读到 ${"%.1f".format(spanSeconds)} 秒 / ${"%.0f".format(read * 100)}% 的数据" +
                if (expectedSeconds > 0) "（应有 ${"%.0f".format(expectedSeconds)} 秒）" else ""
            throw IOException("系统媒体解析器中途中断了，文件不完整：$detail")
        }
    }

    override fun close() {
        if (released) return
        released = true
        runCatching { extractor.release() }
    }

    private companion object {
        /** 时长上的宽限：播放列表里各段的时长只是近似值，允许差这么几秒 */
        const val COMPLETE_SLACK_SECONDS = 3.0

        /** 不知道应有长度时，读到的数据少于文件的这个比例就认为没读完 */
        const val MIN_READ_RATIO = 0.4
    }
}

/** 文件里的一路轨道（"video" 或 "audio"）；sample 由共用的 [TsDemuxer] 按文件顺序送进来 */
class ExtractorSampleSource internal constructor(
    private val demuxer: TsDemuxer,
    private val kind: String,
    internal val trackIndex: Int,
    fmt: MediaFormat,
) : SampleSource {
    private class Unit(val data: ByteArray, val ptsUs: Double, val sync: Boolean)

    private val isVideo = kind == "video"
    private val hevc: Boolean
    private val sampleRate: Int
    private var buffer: ByteArray
    private val queue = ArrayDeque<Unit>()
    private var pending: Sample? = null
    private var index = 0
    private var fed = false
    private var audioEndUs = -1.0 // 音频轨：上一帧结束的时刻（微秒），用来让帧接着排
    private var heldFrames: ArrayDeque<ByteArray>? = null // 音频轨：先扣住的第一个包
    private var firstAuReportedUs = 0.0
    private var firstPtsUs = UNSET
    private var rawPtsUs = UNSET

    private val dtsTicks: Long
    private var lastDts = -1L
    private var frameTicks: Long
    private val ptsWindow = LongArray(32)
    private var windowSize = 0
    private var constantRate = true

    /** 各路轨道统一减去的时间偏移（微秒），让整份文件最早的一帧从 0 开始 */
    var shiftUs = 0L

    /** 进度用：视频轨报整个文件的大小，音频轨报 0（音视频在同一个文件里，合成进度按文件算） */
    override val totalBytes: Long = if (isVideo) demuxer.fileBytes else 0L
    override val spec: Mp4Writer.TrackSpec
    override var maxSampleSize: Int
        private set

    /** 最近一个 sample 的显示时间（微秒，未偏移）；还没有数据时为 [UNSET] */
    internal val lastRawPtsUs: Long get() = rawPtsUs

    init {
        val mime = fmt.getString(MediaFormat.KEY_MIME) ?: ""
        // TS 这类来源不一定每项都有：缺的用常见值补上
        fun int(key: String, fallback: Int): Int = if (fmt.containsKey(key)) runCatching { fmt.getInteger(key) }.getOrDefault(fallback) else fallback
        fun csd(i: Int): ByteArray? = fmt.getByteBuffer("csd-$i")?.let { d -> ByteArray(d.remaining()).also { d.get(it) } }
        val width = int(MediaFormat.KEY_WIDTH, 0)
        val height = int(MediaFormat.KEY_HEIGHT, 0)
        sampleRate = int(MediaFormat.KEY_SAMPLE_RATE, 44100)
        hevc = mime == "video/hevc"
        val entry: ByteArray = when {
            !isVideo && mime == "audio/mp4a-latm" -> SampleEntries.mp4a(csd(0) ?: ByteArray(0), int(MediaFormat.KEY_CHANNEL_COUNT, 2), sampleRate)
            isVideo && (mime == "video/avc" || mime == "video/hevc") -> {
                val units = (0 until 4).mapNotNull { csd(it) }
                    .flatMap { if (SampleEntries.isAnnexB(it)) SampleEntries.splitAnnexB(it) else listOf(it) }
                fun unitsOf(vararg types: Int) = units.filter { SampleEntries.nalType(it, hevc) in types }
                if (hevc) SampleEntries.hevc(unitsOf(32), unitsOf(33), unitsOf(34), width, height)
                else SampleEntries.avc1(unitsOf(7), unitsOf(8), width, height)
            }
            else -> throw Http.ApiException("这段视频用了暂不支持的编码（$mime），无法转换成 MP4")
        }
        dtsTicks = if (isVideo) 90_000L else sampleRate.toLong()
        frameTicks = 33_333L * dtsTicks / 1_000_000 // 先按 30fps 估，看过几帧后改为实测
        spec = Mp4Writer.TrackSpec(
            handler = if (isVideo) Mp4Writer.HANDLER_VIDEO else Mp4Writer.HANDLER_AUDIO,
            entries = listOf(entry),
            timescale = dtsTicks,
            width = if (isVideo) width shl 16 else 0,
            height = if (isVideo) height shl 16 else 0,
            volume = if (isVideo) 0 else 0x0100,
        )
        maxSampleSize = (int(MediaFormat.KEY_MAX_INPUT_SIZE, 1 shl 20).takeIf { it > 0 } ?: (1 shl 20)).coerceIn(1 shl 16, MAX_BUFFER)
        buffer = ByteArray(maxSampleSize)
    }

    /** 第一个 sample 的显示时间（微秒，未偏移）；要等 [prime] 读过开头之后才有 */
    fun firstPtsUs(): Long = firstPtsUsOrNull() ?: 0L

    /** 第一个 sample 的显示时间（微秒，未偏移），还没读到时为 null */
    internal fun firstPtsUsOrNull(): Long? = if (firstPtsUs == UNSET) null else firstPtsUs

    /** 手上没有排着队的 sample 了 */
    internal fun isEmpty(): Boolean = queue.isEmpty()

    /** 文件读完了：不会再有新数据进来 */
    internal fun finish() {
        fed = true
        flushHeldAudio()
    }

    override fun current(): Sample? {
        pending?.let { return it }
        fill()
        val u = queue.firstOrNull() ?: return null
        val ptsUs = Math.round(u.ptsUs - shiftUs)
        val pts = toTicks(ptsUs)
        val dts = if (isVideo) nextDts(pts) else maxOf(pts, lastDts + 1)
        val sample = Sample(dts, pts - dts, u.data.size, u.sync || index == 0, 1, dts * 1_000_000.0 / dtsTicks)
        index++
        pending = sample
        return sample
    }

    override fun read(buf: ByteArray) {
        val s = pending ?: throw IllegalStateException("先调用 current()")
        val u = queue.removeFirst()
        System.arraycopy(u.data, 0, buf, 0, u.data.size)
        lastDts = s.dts
        pending = null
    }

    /** 合成前调用：让这一路先读到开头的数据，之后它的起点才可靠 */
    fun prime() {
        fill()
        if (firstPtsUs == UNSET) queue.firstOrNull()?.let { firstPtsUs = Math.round(it.ptsUs) }
    }

    /** 手上没有 sample 且文件还没读完：让 [TsDemuxer] 接着读 */
    private fun fill() {
        if (fed) return
        demuxer.feed(this) // 文件读完时 TsDemuxer 会调用 finish()
    }

    /**
     * 文件里当前的 sample 属于这一路：读出来、转成 MP4 用的格式、排进队列，然后前进到下一个 sample。
     * 只由 [TsDemuxer.feed] 调用（它保证当前的 sample 就是这一路的）。
     * @return 读到的字节数
     */
    internal fun take(): Int {
        val n = readCurrent()
        val ptsUs = demuxer.sampleTimeUs()
        val sync = demuxer.sampleIsSync()
        demuxer.advance() // 数据已经读出来了，马上前进，下一次需要时再读
        if (n <= 0) {
            // 解析器读不出数据。不是到结尾了（到结尾的情况 TsDemuxer 已经处理掉），是它出了错 ——
            // 比如它所在的系统进程崩了。绝不能当成「读完了」：那会得到一个被截断的文件还显示成功
            throw IOException("系统媒体解析器读取${if (isVideo) "视频" else "音频"}数据失败")
        }
        rawPtsUs = ptsUs
        if (isVideo) {
            val data = SampleEntries.annexBToAvcc(buffer, n)
            // 只有分隔符、参数集而没有画面数据的包不是一帧（比如文件末尾的收尾包），跳过
            if (SampleEntries.hasSlices(data, hevc)) queue.add(Unit(data, ptsUs.toDouble(), sync))
        } else {
            // 系统解析器把同一个包里的所有 AAC 帧当作一个采样交出来，这里拆成单帧，时间依次顺延
            enqueueAudio(ptsUs, SampleEntries.splitAdts(buffer, n) ?: listOf(buffer.copyOf(n)))
        }
        return n
    }

    /**
     * 把一个音频包里的帧排进队列。
     *
     * 系统解析器以「最先解析出来的那个包」作为时间基准，并把早于基准的时间截成 0。音频第一帧常常比视频早
     * （比如 AAC 的预滚帧），这时第一个音频包的真实起点是负的，解析器报的是 0 —— 直接用的话，包里的 N 帧
     * 就被挤进 N-1 帧的时间里。而第二个包报的时间是准的，所以先把第一个包扣住，
     * 等第二个包到了再用「第二个包的时间 − 第一个包的帧数 × 帧时长」把它的真实起点反推出来。
     */
    private fun enqueueAudio(reportedUs: Long, frames: List<ByteArray>) {
        val stepUs = frameUs
        heldFrames?.let { held ->
            // 第二个包到了：反推第一个包的真实起点，把它放行
            heldFrames = null
            val implied = reportedUs - held.size * stepUs
            val firstStart = if (implied < firstAuReportedUs - 0.5 * stepUs) implied else firstAuReportedUs
            pushAudio(held, firstStart)
            firstPtsUs = Math.round(firstStart)
        }
        if (audioEndUs < 0) {
            // 第一个包：先扣住
            heldFrames = ArrayDeque(frames)
            firstAuReportedUs = reportedUs.toDouble()
            return
        }
        // 帧本来就是等间隔的连续序列：解析器报的时间离「上一帧末尾」不到半帧就接着排，否则（真的断开了）用它的
        pushAudio(frames, if (Math.abs(reportedUs - audioEndUs) < 0.5 * stepUs) audioEndUs else reportedUs.toDouble())
    }

    private fun pushAudio(frames: List<ByteArray>, startUs: Double) {
        frames.forEachIndexed { i, f -> queue.add(Unit(f, startUs + i * frameUs, true)) }
        audioEndUs = startUs + frames.size * frameUs
    }

    /** 到结尾了还扣着第一个包（整段音频只有一个包）：没法反推，只能按解析器报的时间放行 */
    private fun flushHeldAudio() {
        val held = heldFrames ?: return
        heldFrames = null
        pushAudio(held, firstAuReportedUs)
        firstPtsUs = Math.round(firstAuReportedUs)
    }

    private val frameUs: Double get() = 1024.0 * 1_000_000 / sampleRate

    private fun nextDts(pts: Long): Long {
        if (lastDts < 0) return 0
        updateFrameEstimate(pts)
        // 定帧率：解码时间就是「第几帧 × 帧时长」。带连续 B 帧时，后面的 B 帧显示时间会比当前解码时间还早，
        // 这时按显示时间去找位置会让解码时间原地踏步（每几帧只前进一点点），整条时间轴越走越慢。
        if (constantRate) return lastDts + maxOf(frameTicks, 1)
        // 变帧率：解码时间尽量跟着显示时间走，但不倒退、也不超过它
        val floor = maxOf(lastDts + frameTicks, pts - LOOKAHEAD * frameTicks)
        return maxOf(lastDts + 1, minOf(pts, floor))
    }

    /**
     * 帧时长估计：最近若干帧的显示时间排序后，最小的相邻差就是一帧的时长。
     * 同时判断是不是定帧率（排序后相邻差都约等于整数个帧时长）。
     */
    private fun updateFrameEstimate(pts: Long) {
        ptsWindow[windowSize % ptsWindow.size] = pts
        windowSize++
        val n = minOf(windowSize, ptsWindow.size)
        if (n < 8) return
        val sorted = (0 until n).map { ptsWindow[(windowSize - 1 - it).mod(ptsWindow.size)] }.sorted()
        var minDiff = Long.MAX_VALUE
        for (i in 1 until n) {
            val d = sorted[i] - sorted[i - 1]
            if (d in 1 until minDiff) minDiff = d
        }
        if (minDiff == Long.MAX_VALUE) return
        frameTicks = minDiff
        // 每个相邻差都应该是帧时长的整数倍（允许丢帧造成的 2 倍、3 倍），误差不超过 2 个刻度
        constantRate = sorted.indices.drop(1).all { i ->
            val d = sorted[i] - sorted[i - 1]
            Math.abs(d - Math.round(d.toDouble() / minDiff) * minDiff) <= 2
        }
    }

    private fun toTicks(us: Long): Long = Math.round(us * dtsTicks / 1_000_000.0)

    /** 读取当前 sample 到 [buffer]，返回字节数（<= 0 表示没有数据） */
    private fun readCurrent(): Int {
        var n = demuxer.read(buffer)
        // 个别关键帧可能比格式里声明的最大值还大（系统此时返回 -1）：换更大的缓冲区再试
        var guard = 0
        while (n <= 0 && buffer.size < MAX_BUFFER && guard++ < 4) {
            buffer = ByteArray(minOf(buffer.size * 4, MAX_BUFFER))
            maxSampleSize = buffer.size
            n = demuxer.read(buffer)
        }
        return n
    }

    override fun close() = demuxer.close()

    companion object {
        /** 单个 sample 的缓冲区上限（64MB，正常视频远用不到） */
        private const val MAX_BUFFER = 64 shl 20

        /** 变帧率时，解码时间最多落在显示时间之前这么多帧（给 B 帧重排留的余量） */
        private const val LOOKAHEAD = 4

        /**
         * 读出视频轨第一个 sample 的原始数据（最多 [maxBytes] 字节，AnnexB 格式）。
         * 给 TsTail 当「下一帧」用：补在 TS 文件末尾，让系统解析器把最后一个真实帧交出来。
         */
        fun firstVideoSample(file: File, maxBytes: Int = 1024): ByteArray? {
            val extractor = MediaExtractor()
            try {
                extractor.setDataSource(file.path)
                for (i in 0 until extractor.trackCount) {
                    if (extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME)?.startsWith("video/") != true) continue
                    extractor.selectTrack(i)
                    val buf = ByteBuffer.allocate(1 shl 20)
                    val n = extractor.readSampleData(buf, 0)
                    if (n <= 0) return null
                    return ByteArray(minOf(n, maxBytes)).also { buf.position(0); buf.get(it) }
                }
                return null
            } catch (_: Exception) {
                return null
            } finally {
                extractor.release()
            }
        }
    }
}
