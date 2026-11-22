package com.sillyshalong.videodownloader

import java.security.MessageDigest
import java.util.TreeMap

/**
 * B站 wbi 签名（纯 Kotlin，JVM 可测）。
 * 算法与 bilibili-API-collect 文档一致：
 *   1. mixinKey = 按混淆表重排 (imgKey+subKey) 后取前 32 位
 *   2. 参数加 wts=当前秒级时间戳，按 key 字典序排序，RFC3986 风格编码（!'()* 不转义）
 *   3. w_rid = md5(query + mixinKey)
 * 官方测试向量（见 WbiTest）：w_rid = d3fea1350874164c1e1b7bc02feb85b2
 */
object Wbi {
    private val MIXIN_TABLE = intArrayOf(
        46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
        33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
        26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
        20, 34, 44, 52,
    )

    /** 按混淆表重排取前 32 位 */
    fun mixinKey(imgKey: String, subKey: String): String {
        val raw = imgKey + subKey
        return MIXIN_TABLE.take(32).map { raw[it] }.joinToString("")
    }

    /**
     * 签名参数。
     * @param params 业务参数（不含 wts）
     * @param mixinKey 由 mixinKey() 得到
     * @param wtsSeconds 注入时间戳（测试用）；null = 当前时间
     * @return (已排序编码的 query 串, w_rid)
     */
    fun sign(
        params: Map<String, String>,
        mixinKey: String,
        wtsSeconds: Long? = null,
    ): Pair<String, String> {
        val p = TreeMap<String, String>().apply {
            putAll(params)
            put("wts", (wtsSeconds ?: (System.currentTimeMillis() / 1000)).toString())
        }
        val query = p.entries.joinToString("&") { (k, v) -> "${enc(k)}=${enc(v)}" }
        val wRid = md5hex(query + mixinKey)
        return query to wRid
    }

    /** RFC3986 风格编码：空格→%20，!'()* 保持原样 */
    private fun enc(s: String): String {
        val e = java.net.URLEncoder.encode(s, "UTF-8")
        return e
            .replace("+", "%20")
            .replace("%21", "!")
            .replace("%27", "'")
            .replace("%28", "(")
            .replace("%29", ")")
            .replace("%2A", "*")
    }

    fun md5hex(s: String): String =
        MessageDigest.getInstance("MD5").digest(s.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
}
