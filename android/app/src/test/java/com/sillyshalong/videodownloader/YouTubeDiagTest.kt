package com.sillyshalong.videodownloader

import okhttp3.OkHttpClient
import org.junit.Test
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.localization.ContentCountry
import org.schabi.newpipe.extractor.localization.Localization
import org.schabi.newpipe.extractor.stream.StreamInfo

/** 诊断：打印 YouTube 实际提取到的流列表 */
class YouTubeDiagTest {
    @Test
    fun `诊断 YouTube 流列表`() {
        val client = OkHttpClient()
        val downloader = object : Downloader() {
            override fun execute(request: Request): Response {
                val rb = okhttp3.Request.Builder().url(request.url())
                request.headers().forEach { (name, values) -> values.forEach { rb.header(name, it) } }
                if (request.headers()["User-Agent"] == null) rb.header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
                val data = request.dataToSend()
                rb.method(request.httpMethod(), data?.let { okhttp3.RequestBody.create(null, it) })
                val resp = client.newCall(rb.build()).execute()
                val body = resp.body?.string() ?: ""
                println("HTTP " + resp.code + " " + resp.request.url.toString().take(100))
                return Response(resp.code, resp.message, resp.headers.toMultimap(), body, resp.request.url.toString())
            }
        }
        NewPipe.init(downloader, Localization("en", "US"), ContentCountry("US"))

        for (url in listOf(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=A5sE7l8SbL4",
        )) {
            try {
                val info = StreamInfo.getInfo(ServiceList.YouTube, url)
                println("### " + url)
                println("### title: " + info.name.take(40) + " | duration: " + info.duration + " | errors: " + info.errors.size)
                println("### videoStreams (" + info.videoStreams.size + "):")
                info.videoStreams.forEach {
                    println("  fmt=" + it.format?.name + " videoOnly=" + it.isVideoOnly + " h=" + it.height + " url=" + it.content.take(50))
                }
                println("### audioStreams (" + info.audioStreams.size + "):")
                info.audioStreams.forEach {
                    println("  fmt=" + it.format?.name + " br=" + it.averageBitrate)
                }
            } catch (e: Exception) {
                println("### " + url + " EXC: " + (e.message?.take(200) ?: ""))
            }
        }
    }
}
