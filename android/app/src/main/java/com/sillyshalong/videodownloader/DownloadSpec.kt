package com.sillyshalong.videodownloader

/**
 * 各引擎交给下载器的统一规格。
 *
 * parts：分段列表，按顺序首尾相接拼成一个文件；每段是一组等价的候选直链（依次尝试容错）。
 * 绝大多数视频只有一段；B站超长视频的 html5 接口会返回多段。
 */
data class DownloadSpec(
    val title: String,
    /** 最终文件名（含扩展名） */
    val fileName: String,
    val parts: List<List<String>>,
    val totalBytes: Long = 0,
    val mime: String = "video/mp4",
    /** 请求直链时要带的头（Referer / Cookie 等） */
    val headers: Map<String, String> = emptyMap(),
) {
    constructor(
        title: String,
        fileName: String,
        url: String,
        totalBytes: Long = 0,
        mime: String = "video/mp4",
        headers: Map<String, String> = emptyMap(),
    ) : this(title, fileName, listOf(listOf(url)), totalBytes, mime, headers)
}

/** 任务被用户暂停/终止时抛出（与真正的失败区分开） */
class CancelledException : Exception("cancelled")

/**
 * 取消信号。长耗时步骤在循环里调用 throwIfCancelled()；
 * 进行中的网络请求通过 onCancel 挂 call.cancel() 立即中断。
 */
class CancelFlag {
    @Volatile var isCancelled = false
        private set
    private val hooks = mutableListOf<() -> Unit>()

    @Synchronized
    fun cancel() {
        if (isCancelled) return
        isCancelled = true
        val toRun = hooks.toList()
        hooks.clear()
        toRun.forEach { runCatching(it) }
    }

    /** 注册“取消时立即执行”的动作；若已经取消则立刻执行 */
    @Synchronized
    fun onCancel(hook: () -> Unit) {
        if (isCancelled) runCatching(hook) else hooks.add(hook)
    }

    fun throwIfCancelled() {
        if (isCancelled) throw CancelledException()
    }
}
