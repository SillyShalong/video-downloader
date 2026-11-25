package com.sillyshalong.videodownloader

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.DocumentsContract
import android.util.Log
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 系统文件夹选择器的宿主 Activity（透明、无界面）。
 *
 * 用法：[pick] 从任意线程调用 → 弹出系统“选择文件夹”界面 → 阻塞到用户选完/取消/超时。
 * 选中的目录是 SAF 树 URI（content://…），App 对它持有持久读写权限，
 * 之后下载可以直接写进去（无需“所有文件访问权限”这类敏感权限）。
 */
class DirPickerActivity : Activity() {

    companion object {
        private const val TAG = "DirPicker"
        private const val REQ = 4271
        private const val EXTRA_INITIAL_URI = "initial"
        private const val FLAGS = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION

        private var callback: ((Uri?) -> Unit)? = null

        /**
         * 弹出系统目录选择器并等待结果。
         * @param initial 打开时停在哪（见 [Storage.pickerStartUri]）；null → 系统「下载」目录
         * @return 选中的目录树 URI；用户取消 / 超时 / 已有一个选择器在等待 → null
         */
        fun pick(ctx: Context, initial: Uri? = null, timeoutMs: Long = 5 * 60_000): Uri? {
            val latch = CountDownLatch(1)
            var result: Uri? = null
            synchronized(this) {
                if (callback != null) return null // 上一次选择还没结束
                callback = { uri ->
                    result = uri
                    latch.countDown()
                }
            }
            try {
                ctx.startActivity(
                    Intent(ctx, DirPickerActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        .putExtra(EXTRA_INITIAL_URI, initial),
                )
            } catch (e: Exception) {
                Log.e(TAG, "无法启动系统目录选择器", e)
                synchronized(this) { callback = null }
                return null
            }
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
            synchronized(this) { callback = null }
            return result
        }
    }

    private var delivered = false

    @Suppress("DEPRECATION") // 带 Class 参数的重载要 API 33，这里 minSdk 24
    private val initial: Uri? get() = intent?.getParcelableExtra(EXTRA_INITIAL_URI)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState != null) {
            // 进程被系统回收后重建：已经没有等待结果的请求方了，直接回主界面
            backToMain()
            finish()
            return
        }
        // 打开时停在当前保存目录（见 [Storage.pickerStartUri]）；没给的话退回「下载」目录
        //（地址必须经 DocumentsContract 拼：文档 ID 里的「/」要编码，系统选择器才认）
        val start = initial
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(FLAGS)
            addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
            putExtra(
                DocumentsContract.EXTRA_INITIAL_URI,
                start
                    ?: DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:${Environment.DIRECTORY_DOWNLOADS}"),
            )
        }
        try {
            startActivityForResult(intent, REQ)
        } catch (e: Exception) {
            Log.e(TAG, "系统缺少目录选择器", e)
            deliver(null)
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ) return
        val uri = if (resultCode == RESULT_OK) data?.data else null
        if (uri != null) persist(uri)
        deliver(uri)
    }

    /** 持久化所选目录的读写权限；只保留最新选中的一个（系统对可持有的数量有限制） */
    private fun persist(uri: Uri) {
        val resolver = contentResolver
        try {
            resolver.takePersistableUriPermission(uri, FLAGS)
        } catch (e: SecurityException) {
            Log.w(TAG, "持久化目录权限失败", e)
        }
        for (p in resolver.persistedUriPermissions) {
            if (p.uri != uri && p.isWritePermission) {
                runCatching { resolver.releasePersistableUriPermission(p.uri, FLAGS) }
            }
        }
    }

    private fun deliver(uri: Uri?) {
        if (delivered) return
        delivered = true
        val cb = synchronized(Companion) { callback.also { callback = null } }
        cb?.invoke(uri)
        if (MainActivity.current == null) backToMain() // 主界面已经不在了（被系统回收）：把它带回来
        finish()
    }

    private fun backToMain() {
        runCatching {
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    override fun onDestroy() {
        // 被系统回收而用户没有选完：通知等待方，避免请求永远挂着
        deliver(null)
        super.onDestroy()
    }
}
