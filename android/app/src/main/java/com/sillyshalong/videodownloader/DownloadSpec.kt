package com.sillyshalong.videodownloader

/** 各引擎统一的下载规格（引擎 → HttpDownloader） */
data class DownloadSpec(
    val title: String,
    val fileName: String,
    val urls: List<String>,
    val totalBytes: Long,
)
