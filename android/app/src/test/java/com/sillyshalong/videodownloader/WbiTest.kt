package com.sillyshalong.videodownloader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Wbi 签名单元测试——使用 bilibili-API-collect 官方文档测试向量。
 * https://socialsisteryi.github.io/bilibili-API-collect/docs/misc/sign/wbi.html
 */
class WbiTest {
    // 官方示例 keys
    private val imgKey = "7cd084941338484aae1ad942dc57238b"
    private val subKey = "4932ca060621b1fbda513725f4d6d1c0"

    @Test
    fun `mixinKey 混淆表重排取前32位`() {
        val mixin = Wbi.mixinKey(imgKey, subKey)
        // 官方文档示例的 mixin key（经 Node 独立实现交叉验证）
        assertEquals("fb1d7124a53bd012714a932a32464068", mixin)
        assertEquals(32, mixin.length)
    }

    @Test
    fun `sign 官方测试向量 w_rid`() {
        // 官方示例：params {foo:114, zab:5168, bar:110} + wts=1702204800
        // 排序后 query = bar=110&foo=114&wts=1702204800&zab=5168
        // w_rid = md5(query + mixinKey)（经 Node 独立实现交叉验证）
        val mixin = Wbi.mixinKey(imgKey, subKey)
        val (query, wRid) = Wbi.sign(
            mapOf("foo" to "114", "zab" to "5168", "bar" to "110"),
            mixin,
            wtsSeconds = 1702204800,
        )
        assertEquals("bar=110&foo=114&wts=1702204800&zab=5168", query)
        assertEquals("d66460b340d6700187972610aa3bbf59", wRid)
    }

    @Test
    fun `md5hex 标准向量`() {
        assertEquals("d41d8cd98f00b204e9800998ecf8427e", Wbi.md5hex(""))
        assertEquals("900150983cd24fb0d6963f7d28e17f72", Wbi.md5hex("abc"))
        // 中文按 UTF-8（经 Node 交叉验证）
        assertEquals("a7bac2239fcdcb3a067903d8077c4a07", Wbi.md5hex("中文"))
    }

    @Test
    fun `sign 特殊字符按RFC3986编码`() {
        val (query, wRid) = Wbi.sign(
            mapOf("a" to "x y!z'q(w)r*s"),
            Wbi.mixinKey(imgKey, subKey),
            wtsSeconds = 1702204800,
        )
        // 空格 %20，!'()* 不转义
        assertTrue(query.contains("a=x%20y!z'q(w)r*s"))
        // w_rid 是 32 位十六进制
        assertTrue(wRid.matches(Regex("[0-9a-f]{32}")))
    }
}
