package com.sillyshalong.videodownloader

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 链接识别、站点识别、域名归一化、文件名清理 —— 这些小函数错了，用户看到的就是「按钮没反应」 */
class UrlsTest {
    @Test
    fun `从分享口令里抽取链接`() {
        val text = "12.28 复制打开抖音看作品 https://v.douyin.com/AbCd123/ 这是一条口令，还有第二条 https://b23.tv/xyz。"
        assertEquals(listOf("https://v.douyin.com/AbCd123/", "https://b23.tv/xyz"), Urls.extract(text))
    }

    @Test
    fun `链接末尾的标点会被去掉`() {
        assertEquals(listOf("https://www.bilibili.com/video/BV1GJ411x7h7"), Urls.extract("看这个：https://www.bilibili.com/video/BV1GJ411x7h7。"))
        assertEquals(listOf("https://x.y/a"), Urls.extract("(https://x.y/a)"))
    }

    @Test
    fun `没有链接时返回空表而不是报错`() {
        assertTrue(Urls.extract("随便一段文字").isEmpty())
        assertTrue(Urls.extract("").isEmpty())
    }

    @Test
    fun `识别站点`() {
        assertEquals(Sites.YOUTUBE, Sites.of("https://www.youtube.com/watch?v=abc", emptyList()))
        assertEquals(Sites.YOUTUBE, Sites.of("https://youtu.be/abc", emptyList()))
        assertEquals(Sites.YOUTUBE, Sites.of("https://m.youtube.com/shorts/abc", emptyList()))
        assertEquals(Sites.BILIBILI, Sites.of("https://www.bilibili.com/video/BV1GJ411x7h7", emptyList()))
        assertEquals(Sites.BILIBILI, Sites.of("https://b23.tv/xyz", emptyList()))
        assertEquals("douyin", Sites.of("https://v.douyin.com/AbCd123/", emptyList()))
        assertEquals("xiaohongshu", Sites.of("https://xhslink.com/a/abc", emptyList()))
        // 设置里配置的域名（含子域名）走通用 HLS 引擎
        assertEquals(Sites.HLS, Sites.of("https://stream.example.org/a/b", listOf("example.org")))
        assertEquals(Sites.HLS, Sites.of("https://example.org/a", listOf("example.org")))
        // 直接的 m3u8 地址不用配置也算
        assertEquals(Sites.HLS, Sites.of("http://10.0.2.2:8000/master.m3u8", emptyList()))
        assertEquals(Sites.HLS, Sites.of("https://cdn.example.net/ play/720.m3u8?token=1".replace(" ", ""), emptyList()))
        assertEquals("generic", Sites.of("https://example.org.unknown/a", listOf("example.org")))
        assertEquals("generic", Sites.of("https://random.site/", emptyList()))
    }

    @Test
    fun `播放列表里的相对地址换算成绝对地址`() {
        assertEquals("https://cdn.example.org/hls/key.bin", Urls.resolve("https://cdn.example.org/hls/index.m3u8", "key.bin"))
        assertEquals("https://cdn.example.org/key.bin", Urls.resolve("https://cdn.example.org/hls/index.m3u8", "/key.bin"))
        assertEquals("https://other.net/a.m3u8", Urls.resolve("https://cdn.example.org/hls/index.m3u8", "https://other.net/a.m3u8"))
        // 地址里有中文、空格这类 URI 类不接受的字符时也不能抛异常
        assertEquals("https://cdn.example.org/hls/%E8%A7%86%E9%A2%91", Urls.resolve("https://cdn.example.org/hls/index.m3u8", "%E8%A7%86%E9%A2%91"))
        assertEquals("http://h/d/a b.m3u8", Urls.resolve("http://h/d/index.m3u8", "a b.m3u8"))
        assertEquals("http://h/a b.m3u8", Urls.resolve("http://h/index.m3u8", "a b.m3u8"))
        assertEquals("http://h/x.m3u8", Urls.resolve("http://h", "/x.m3u8"))
    }

    @Test
    fun `查询参数`() {
        assertEquals("3", Urls.queryParam("https://www.bilibili.com/video/BV1GJ411x7h7?p=3&share=1", "p"))
        assertNull(Urls.queryParam("https://www.bilibili.com/video/BV1GJ411x7h7", "p"))
    }

    @Test
    fun `域名归一化与桌面端同规则`() {
        val got = TaskEngine.normalizeHlsSites(listOf("Example.COM/path", " https://www.stream.example.org ", "example.com", "not a domain", "a.b", ""))
        assertEquals(listOf("example.com", "stream.example.org", "a.b"), got)
    }

    @Test
    fun `文件名清理：保留扩展名、去掉非法字符、限制长度`() {
        assertEquals("abc [BV1].mp4", Storage.sanitizeFileName("abc [BV1].mp4"))
        assertEquals("a b c.mp4", Storage.sanitizeFileName("a:b?c*.mp4"))
        assertEquals("video", Storage.sanitizeFileName("   "))
        assertEquals("视频.mp4", Storage.sanitizeFileName("视频.mp4"))
        // 超长文件名截到 200 字节以内，扩展名不能丢（曾经有个 bug 把没截断的文件名的扩展名弄丢了）
        val long = "标".repeat(300) + ".mp4"
        val cut = Storage.sanitizeFileName(long)
        assertTrue(cut.toByteArray(Charsets.UTF_8).size <= 200)
        assertTrue(cut.endsWith(".mp4"))
        val ascii = Storage.sanitizeFileName("x".repeat(250) + ".ts")
        assertEquals(200, ascii.length)
        assertTrue(ascii.startsWith("x".repeat(190)))
        assertTrue(ascii.endsWith(".ts"))
        // 没超长的一律原样保留
        assertEquals("a.b.c.mp4", Storage.sanitizeFileName("a.b.c.mp4"))
        assertEquals("a.b", Storage.sanitizeFileName(".a.b."))
    }

    @Test
    fun `文件类型`() {
        assertEquals("video/mp4", Storage.mimeFor("a.mp4"))
        assertEquals("audio/mp4", Storage.mimeFor("a.m4a"))
        assertEquals("video/mp2t", Storage.mimeFor("a.ts"))
        assertEquals("application/octet-stream", Storage.mimeFor("a.xyz"))
    }
}
