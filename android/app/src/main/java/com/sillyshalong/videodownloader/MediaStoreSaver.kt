package com.sillyshalong.videodownloader

import android.content.ContentValues
import android.content.Context
import android.os.Environment
import android.provider.MediaStore
import java.io.File

/** 缓存文件 → MediaStore（系统下载目录）落盘 */
object MediaStoreSaver {
    /** @return 展示用相对路径（Download/VideoDownloader/<name>） */
    fun saveFromCache(ctx: Context, file: File, name: String): Uri2 {
        val resolver = ctx.contentResolver
        val mime = when {
            name.endsWith(".m4a") -> "audio/mp4"
            name.endsWith(".mp3") -> "audio/mpeg"
            name.endsWith(".webm") -> "video/webm"
            else -> "video/mp4"
        }
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/VideoDownloader")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw RuntimeException("创建下载文件失败")
        try {
            resolver.openOutputStream(uri)!!.use { out ->
                file.inputStream().use { it.copyTo(out) }
            }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            return Uri2("Download/VideoDownloader/$name")
        } catch (e: Exception) {
            try { resolver.delete(uri, null, null) } catch (_: Exception) {}
            throw e
        }
    }

    /** 展示路径的轻量包装（避免与android.net.Uri混淆） */
    data class Uri2(val displayPath: String)
}
