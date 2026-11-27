package com.sillyshalong.videodownloader

import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.media.MediaScannerConnection
import android.provider.OpenableColumns
import android.util.Log
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream

/**
 * 下载目标的统一写入接口，两种实现：
 *  - MediaStoreSink：默认，系统「下载/VideoDownloader」目录（无需存储权限）
 *  - SafSink：用户在系统文件夹选择器里选的目录（content:// 树 URI）
 */
/** 保存目录出的问题（不是网络问题）：文案是写给用户看的，界面原样显示 */
class StorageException(message: String, cause: Throwable? = null) : IOException(message, cause)

abstract class StorageSink : Closeable {
    /** 底层输出流，由子类提供 */
    protected abstract val target: OutputStream

    /**
     * 对外的输出流。写不进去（空间不足、目录被删）时抛 [StorageException] ——
     * 不包一层的话它和网络读写失败是同一种异常，界面会把它说成「网络错误」。
     */
    val outputStream: OutputStream = object : OutputStream() {
        private fun guard(block: () -> Unit) {
            try {
                block()
            } catch (e: IOException) {
                throw StorageException("无法写入保存目录（存储空间不足或目录已不可用）", e)
            }
        }

        override fun write(b: Int) = guard { target.write(b) }
        override fun write(b: ByteArray, off: Int, len: Int) = guard { target.write(b, off, len) }
        override fun flush() = guard { target.flush() }
        override fun close() = target.close()
    }

    /** 界面展示用路径 */
    abstract val displayPath: String
    /** 已写入文件的 content:// URI（打开文件 / 定位目录用） */
    abstract val fileUri: Uri
    /** 所在目录的树 URI（仅用户所选目录有） */
    open val treeUri: Uri? get() = null

    /** 成功写完：提交（MediaStore 要清掉“写入中”标记，文件才对其他应用可见） */
    abstract fun commit()

    /** 中途失败：删除半成品 */
    abstract fun abort()

    /** 关闭时调用（Storage 用它撤销文件名占位） */
    var onClosed: (() -> Unit)? = null

    private var closed = false
    final override fun close() {
        if (closed) return
        closed = true
        try {
            outputStream.close()
        } catch (e: IOException) {
            // 系统的下载目录 / SAF 目录要到关闭时才真正报错（比如空间不足）
            throw StorageException("无法写入保存目录（存储空间不足或目录已不可用）", e)
        } finally {
            onClosed?.invoke()
        }
    }
}

private class MediaStoreSink(
    private val resolver: ContentResolver,
    override val fileUri: Uri,
    displayName: String,
    override val target: OutputStream,
) : StorageSink() {
    override var displayPath = "${Storage.DEFAULT_DIR}/$displayName"
        private set

    override fun commit() {
        resolver.update(fileUri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        // 同一目录里有同名文件时（比如同时下几个没写标题的视频），系统是在文件「发布」这一刻才给改名加上 " (1)" 的。
        // 所以发布之后要再读一次名字：任务里记的路径得是磁盘上真实的那个。
        Storage.displayNameOf(resolver, fileUri)?.let { displayPath = "${Storage.DEFAULT_DIR}/$it" }
    }

    override fun abort() {
        runCatching { resolver.delete(fileUri, null, null) }
    }
}

private class SafSink(
    private val resolver: ContentResolver,
    override val fileUri: Uri,
    override val treeUri: Uri,
    dirLabel: String,
    displayName: String,
    override val target: OutputStream,
) : StorageSink() {
    override val displayPath = "$dirLabel/$displayName"

    override fun commit() {}

    override fun abort() {
        runCatching { DocumentsContract.deleteDocument(resolver, fileUri) }
    }
}

/** Android 9 及以下：应用专属目录里的普通文件，写完后通知媒体库扫描（相册/播放器才能看到） */
private class FileSink(
    private val ctx: Context,
    private val file: File,
    override val target: OutputStream,
) : StorageSink() {
    override val displayPath = "Android/data/${ctx.packageName}/files/${Storage.DEFAULT_DIR}/${file.name}"
    override val fileUri: Uri = Uri.fromFile(file)

    override fun commit() {
        MediaScannerConnection.scanFile(ctx, arrayOf(file.path), arrayOf(Storage.mimeFor(file.name)), null)
    }

    override fun abort() {
        file.delete()
    }
}

object Storage {
    const val SUBDIR = "VideoDownloader"

    private const val TAG = "Storage"

    /** 建默认目录用的占位文件（见 [ensureDefaultDir]） */
    private const val PLACEHOLDER = "VideoDownloader.txt"
    private val PLACEHOLDER_TEXT = listOf(
        "这是 Video Downloader 的默认下载目录。",
        "This folder is where Video Downloader saves videos by default.",
        "它只用来占位，好让系统文件夹选择器能直接停在这里；删掉它之后如果目录是空的，系统会把目录也清掉。",
    ).joinToString("\n")

    /** 默认目录（系统“下载”目录下，无需任何权限） */
    val DEFAULT_DIR = "${Environment.DIRECTORY_DOWNLOADS}/$SUBDIR"

    /** 用户所选目录以 content:// 树 URI 表示 */
    fun isCustomDir(outDir: String?): Boolean = outDir?.startsWith("content://") == true

    /** 系统文件选择器里「下载/VideoDownloader」这类目录的地址（primary = 手机内置存储） */
    private fun downloadsDoc(vararg path: String): Uri =
        // 必须经 DocumentsContract 拼出来：文档 ID 里的「/」要编码成 %2F，
        // 直接拼字符串的话会被当成多一级路径，系统选择器认不出这是个文档、直接忽略
        DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", listOf("primary:${Environment.DIRECTORY_DOWNLOADS}", *path).joinToString("/"))

    /**
     * 系统文件夹选择器打开时停在哪。
     * 系统不允许直接选「下载」根目录（以及存储根目录）—— 停在那里的话，用户第一眼看到的是
     * 「无法使用此文件夹」和一个灰掉的确认按钮，很容易以为选目录这个功能坏了。所以：
     *  - 用户选过目录：就停在所选目录里，直接确认，或者换一个；
     *  - 默认目录：「下载/VideoDownloader」（还没建出来就先建；建不了就退回「下载」）。
     * 部分系统会忽略这个位置、打开上一次的位置。
     */
    fun pickerStartUri(ctx: Context, outDir: String?): Uri {
        if (isCustomDir(outDir)) {
            val tree = Uri.parse(outDir)
            runCatching { return DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree)) }
        }
        // 建不出目录就退回「下载」根目录（系统不让选那一层，用户得进一个子目录）
        if (Build.VERSION.SDK_INT < 29 || !ensureDefaultDir(ctx)) return downloadsDoc()
        return downloadsDoc(SUBDIR)
    }

    /**
     * 默认目录还没建出来（一次都没下载过）：先把它建出来。
     *
     * 分区存储下 App 不能直接在「下载」里 mkdir，只能经媒体库登记一个文件，系统才会把目录建出来；
     * 而目录里一个文件都不剩时系统又会把它回收。所以这里放一个很小的说明文件 [PLACEHOLDER]
     * （只在用户点「浏览…」而默认目录还不存在时创建一次；之后的下载不会碰它）。
     *
     * 实测（API 35）：以点开头的文件名会被系统改名成下划线开头，起不到隐藏作用，所以用普通名字。
     * 失败返回 false（只影响选择器的起始位置，不影响下载）。
     */
    private fun ensureDefaultDir(ctx: Context): Boolean = runCatching {
        @Suppress("DEPRECATION")
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), SUBDIR)
        if (dir.isDirectory) return true
        val resolver = ctx.contentResolver
        val where = "${MediaStore.Downloads.RELATIVE_PATH}=? AND ${MediaStore.Downloads.DISPLAY_NAME}=?"
        val args = arrayOf("$DEFAULT_DIR/", PLACEHOLDER)
        resolver.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI, arrayOf(MediaStore.MediaColumns._ID), where, args, null)?.use { c ->
            if (c.moveToFirst()) return true // 目录在、说明文件也在（只是 App 这边看不到目录项）
        }
        val uri = resolver.insert(
            MediaStore.Downloads.EXTERNAL_CONTENT_URI,
            ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, PLACEHOLDER)
                put(MediaStore.Downloads.MIME_TYPE, "text/plain")
                put(MediaStore.Downloads.RELATIVE_PATH, DEFAULT_DIR)
                put(MediaStore.Downloads.IS_PENDING, 1)
            },
        ) ?: return false
        // 只有真正写入过，系统才会在磁盘上把目录建出来
        val written = runCatching { resolver.openOutputStream(uri, "w")?.use { it.write(PLACEHOLDER_TEXT.toByteArray()) } }.isSuccess
        if (!written) {
            resolver.delete(uri, null, null)
            return false
        }
        // 发布（其他应用才看得到这个文件；不删，删了空目录会被回收）
        resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        true
    }.onFailure { Log.w(TAG, "建默认目录失败（不影响下载）", it) }.getOrDefault(false)

    fun mimeFor(name: String): String =
        when (name.substringAfterLast('.', "").lowercase()) {
            "mp4", "m4v" -> "video/mp4"
            "m4a" -> "audio/mp4"
            "ts", "mts", "m2ts" -> "video/mp2t"
            "webm" -> "video/webm"
            "mkv" -> "video/x-matroska"
            else -> "application/octet-stream"
        }

    /**
     * 打开写入目标：outDir 为 content:// 树 URI 时写入所选目录，否则写入默认目录。
     * 同名文件已存在时系统会自动追加序号（不会覆盖）。
     */
    fun open(ctx: Context, outDir: String?, name: String, mime: String = mimeFor(name)): StorageSink {
        val safeName = sanitizeFileName(name)
        val custom = outDir?.takeIf { isCustomDir(it) }
        return when {
            custom != null -> withReservedName(custom, safeName, null) { openSaf(ctx, Uri.parse(custom), it, mime) }
            Build.VERSION.SDK_INT >= 29 ->
                withReservedName(DEFAULT_DIR, safeName, { existsInDownloads(ctx, it) }) { openMediaStore(ctx, it, mime) }
            else -> withReservedName("legacy", safeName, null) { openLegacy(ctx, it, mime) }
        }
    }

    /** 目录里是不是已经有叫这个名字的文件 */
    private fun existsInDownloads(ctx: Context, name: String): Boolean = runCatching {
        ctx.contentResolver.query(
            MediaStore.Downloads.EXTERNAL_CONTENT_URI,
            arrayOf(MediaStore.MediaColumns._ID),
            "${MediaStore.Downloads.RELATIVE_PATH}=? AND ${MediaStore.Downloads.DISPLAY_NAME}=?",
            arrayOf("$DEFAULT_DIR/", name),
            null,
        )?.use { it.moveToFirst() } ?: false
    }.getOrDefault(false)

    /**
     * 下载开始之前先确认用户所选的保存目录还能用（目录可能已经被删掉，或者授权被收回）。
     * 各个站点都是先下到应用缓存、最后才写进保存目录：不先查的话，要等整个视频下完、开始保存时才发现，
     * 白等一趟。只读不写，不会在目录里留下任何东西。
     * @throws StorageException 目录不可用（文案和保存时的报错一致）
     */
    fun checkDir(ctx: Context, outDir: String?) {
        val custom = outDir?.takeIf { isCustomDir(it) } ?: return // 默认目录由系统管理，不用查
        val resolver = ctx.contentResolver
        val tree = Uri.parse(custom)
        val doc = try {
            DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        } catch (e: Exception) {
            throw StorageException("所选目录无效，请重新选择保存目录")
        }
        val exists = runCatching {
            resolver.query(doc, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID), null, null, null)?.use { it.moveToFirst() }
        }.getOrNull() == true
        if (!exists) throw StorageException("无法在所选目录创建文件（目录权限可能已失效，请重新选择保存目录）")
    }

    /**
     * 正在写入的文件（「目录/文件名」）。
     *
     * 系统只在文件「发布」的那一刻才给重名文件加序号。发布之前，两个同名的待写入文件在系统眼里是同一个文件：
     * 同时下几个任务、文件名又一样时（比如几个没写标题的视频在同一秒开始），两路数据会写进同一个文件，
     * 其中一个任务的结果就被另一个覆盖掉了。所以打开之前先在这里登记占位：
     * 同一个目录里已经有同名文件正在写，就依次用「名字 (1)」「名字 (2)」……写完（或失败）后撤销登记。
     * @param exists 目录里已有同名文件时返回 true（用来跳过已经下好的文件，免得系统再叠一层序号）；null = 不查
     */
    private val writing = HashSet<String>()

    private fun withReservedName(
        dir: String,
        name: String,
        exists: ((String) -> Boolean)?,
        block: (String) -> StorageSink,
    ): StorageSink {
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        val reserved: String
        val release: () -> Unit
        synchronized(writing) {
            var candidate = name
            var n = 0
            while ("$dir/$candidate" in writing || exists?.invoke(candidate) == true) candidate = "$stem (${++n})$ext"
            val key = "$dir/$candidate"
            writing.add(key)
            reserved = candidate
            release = { synchronized(writing) { writing.remove(key) } } // 重复撤销是空操作
        }
        try {
            return block(reserved).also { it.onClosed = release }
        } catch (e: Throwable) {
            release()
            throw e
        }
    }

    private fun openMediaStore(ctx: Context, name: String, mime: String): StorageSink {
        val resolver = ctx.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, DEFAULT_DIR)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw StorageException("无法在系统下载目录创建文件（存储空间不足？）")
        try {
            val out = resolver.openOutputStream(uri) ?: throw StorageException("无法写入系统下载目录")
            return MediaStoreSink(resolver, uri, displayNameOf(resolver, uri) ?: name, out)
        } catch (e: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            throw e
        }
    }

    private fun openSaf(ctx: Context, tree: Uri, name: String, mime: String): StorageSink {
        val resolver = ctx.contentResolver
        val parent = try {
            DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        } catch (e: Exception) {
            throw StorageException("所选目录无效，请重新选择保存目录")
        }
        val doc = try {
            DocumentsContract.createDocument(resolver, parent, mime, name)
        } catch (e: Exception) {
            null
        } ?: throw StorageException("无法在所选目录创建文件（目录权限可能已失效，请重新选择保存目录）")
        try {
            val out = resolver.openOutputStream(doc, "w") ?: throw StorageException("无法写入所选目录")
            return SafSink(resolver, doc, tree, label(ctx, tree), displayNameOf(resolver, doc) ?: name, out)
        } catch (e: Exception) {
            runCatching { DocumentsContract.deleteDocument(resolver, doc) }
            throw e
        }
    }

    /** Android 9 及以下没有「下载」集合：写进应用专属目录（无需存储权限，卸载时一并删除） */
    private fun openLegacy(ctx: Context, name: String, mime: String): StorageSink {
        val base = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: ctx.filesDir
        val dir = File(base, SUBDIR)
        if (!dir.isDirectory && !dir.mkdirs()) throw StorageException("无法创建目录 ${dir.path}（存储空间不足？）")
        // 同名加序号，不覆盖已有文件
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        var file = File(dir, name)
        var n = 1
        while (file.exists()) file = File(dir, "$stem (${++n})$ext")
        val out = FileOutputStream(file)
        return FileSink(ctx, file, out)
    }

    /** 目录/文件的显示名（如“Movies”）；查询失败返回 null */
    fun displayNameOf(resolver: ContentResolver, uri: Uri): String? = runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0)?.takeIf { it.isNotBlank() } else null
        }
    }.getOrNull()

    /** 用户所选目录的显示名 */
    fun label(ctx: Context, tree: Uri): String {
        val doc = runCatching { DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree)) }.getOrNull()
            ?: return "所选目录"
        return displayNameOf(ctx.contentResolver, doc) ?: "所选目录"
    }

    /**
     * “打开文件夹”用的 Intent：用户所选目录 → 系统文件管理器定位到文件所在目录。
     * 默认目录（无树 URI）或定位失败返回 null，由调用方打开系统下载列表。
     */
    fun revealIntent(ctx: Context, tree: Uri, fileUri: Uri): Intent? {
        val parentId = runCatching { DocumentsContract.getDocumentId(fileUri).substringBeforeLast('/', "") }.getOrDefault("")
        if (parentId.isEmpty()) return null
        val parentUri = DocumentsContract.buildDocumentUriUsingTree(tree, parentId)
        return Intent(Intent.ACTION_VIEW)
            .setDataAndType(parentUri, DocumentsContract.Document.MIME_TYPE_DIR)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
    }

    /** 去掉文件名里文件系统不允许的字符，并限制长度（保留扩展名；文件名上限 255 字节，这里留足余量） */
    fun sanitizeFileName(name: String): String {
        val cleaned = name.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), " ").replace(Regex("\\s+"), " ").trim().trim('.', ' ')
        if (cleaned.isEmpty()) return "video"
        val dot = cleaned.lastIndexOf('.')
        val ext = if (dot > 0 && dot >= cleaned.length - 6) cleaned.substring(dot + 1) else ""
        val stem = if (ext.isEmpty()) cleaned else cleaned.substring(0, dot)
        var end = stem.length
        while (end > 1 && stem.substring(0, end).toByteArray(Charsets.UTF_8).size + ext.length + 1 > 200) end--
        val cut = stem.substring(0, end).trimEnd('.', ' ')
        return (if (cut.isEmpty()) "video" else cut) + if (ext.isEmpty()) "" else ".$ext"
    }
}
