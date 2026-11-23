package com.sillyshalong.videodownloader

import com.grack.nanojson.JsonArray
import com.grack.nanojson.JsonObject
import com.grack.nanojson.JsonParser
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.localization.ContentCountry
import org.schabi.newpipe.extractor.localization.Localization
import org.schabi.newpipe.extractor.stream.StreamInfo

/**
 * 网络诊断（仅 VD_NET_DIAG=1 时运行）：记录提取器发出的每个 player 请求，
 * dump 响应里的原始流列表，并与提取器解析结果对比。
 */
class YouTubeNetDiagTest {
    private val client = OkHttpClient()

    private fun dumpStreams(tag: String, json: JsonObject?) {
        if (json == null) {
            println("### [$tag] body is not JSON")
            return
        }
        println("### [$tag] status=" + json.getObject("playabilityStatus")?.get("status"))
        val sd = json.getObject("streamingData") ?: run { println("### [$tag] streamingData=null"); return }
        for (key in listOf("formats", "adaptiveFormats")) {
            val arr: JsonArray? = sd.getArray(key)
            println("### [$tag] $key: " + (arr?.size ?: 0))
            arr?.let { a ->
                for (i in 0 until a.size) {
                    val f = a.getObject(i)
                    println(
                        "  itag=" + f.get("itag") + " " + (f.getString("mimeType") ?: "").substringBefore("; ") +
                            " " + f.get("width") + "x" + f.get("height") + " fps=" + f.get("fps") +
                            " q=" + (f.get("qualityLabel") ?: f.get("audioQuality")) +
                            (if (f.has("url")) " URL" else "") +
                            (if (f.has("signatureCipher")) " CIPHER" else "") +
                            " len=" + (f.get("contentLength") ?: "?") + " br=" + (f.get("bitrate") ?: "?"),
                    )
                }
            }
        }
    }

    private fun newDownloader(): Downloader = object : Downloader() {
        override fun execute(request: Request): Response {
            val rb = okhttp3.Request.Builder().url(request.url())
            request.headers().forEach { (name, values) -> values.forEach { rb.header(name, it) } }
            val data = request.dataToSend()
            rb.method(request.httpMethod(), data?.let { it.toRequestBody("application/json".toMediaTypeOrNull()) })
            println("### REQ " + request.httpMethod() + " " + request.url().take(140))
            request.headers().forEach { (n, v) ->
                if (n.startsWith("X-") || n == "User-Agent") println("###   H " + n + ": " + v.firstOrNull()?.take(90))
            }
            println("###   BODY " + (data?.let { String(it, Charsets.UTF_8) } ?: "").take(600))
            client.newCall(rb.build()).execute().use { resp ->
                val body = resp.body?.string() ?: ""
                println("### RES " + resp.code + " len=" + body.length)
                dumpStreams(
                    resp.request.url.host,
                    runCatching { JsonParser.`object`().from(body) as JsonObject }.getOrNull(),
                )
                return Response(resp.code, resp.message, resp.headers.toMultimap(), body, resp.request.url.toString())
            }
        }
    }

    @Test
    fun `dump 各客户端原始流列表`() {
        assumeTrue(System.getenv("VD_NET_DIAG") == "1")
        val loc = Localization("en", "US")
        val cc = ContentCountry("US")
        NewPipe.init(newDownloader(), loc, cc)

        for (url in listOf("https://www.youtube.com/watch?v=A5sE7l8SbL4")) {
            println("### ========= $url =========")
            try {
                val info = StreamInfo.getInfo(ServiceList.YouTube, url)
                println(
                    "### extractor: videoStreams=" + info.videoStreams.size +
                        " videoOnly=" + info.videoOnlyStreams.size +
                        " audio=" + info.audioStreams.size +
                        " errors=" + info.errors.size,
                )
                info.errors.forEach { println("### extractor error: " + it.message?.take(400)) }
                (info.videoStreams + info.videoOnlyStreams).forEach {
                    println(
                        "  S itag=" + it.formatId + " " + it.format + " " + it.height + "p" +
                            " delivery=" + it.deliveryMethod + " isUrl=" + it.isUrl + " " + it.content.take(70),
                    )
                }
            } catch (e: Exception) {
                println("### extractor EXC: " + (e.message?.take(400) ?: ""))
            }
        }
    }
}
