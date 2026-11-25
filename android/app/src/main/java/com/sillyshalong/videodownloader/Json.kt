package com.sillyshalong.videodownloader

import org.json.JSONObject

/**
 * 读取「可能为 null」的字符串字段。
 *
 * 不能直接用 optString(name, fallback)：安卓自带的 org.json 在字段值是 JSON null 时
 * 返回的是字符串 "null"，而不是 fallback。
 */
fun JSONObject.nullableString(key: String): String? =
    if (!has(key) || isNull(key)) null else optString(key)

/** 同上，针对任意对象的 opt：值为 JSON null 或字段缺失时返回 null */
fun JSONObject.nullable(key: String): Any? =
    if (!has(key) || isNull(key)) null else opt(key)
