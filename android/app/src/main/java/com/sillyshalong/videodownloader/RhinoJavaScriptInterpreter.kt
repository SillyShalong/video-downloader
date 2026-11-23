package com.sillyshalong.videodownloader

import android.util.Log
import org.mozilla.javascript.Context
import org.mozilla.javascript.Function
import org.mozilla.javascript.ScriptableObject
import org.schabi.newpipe.extractor.utils.JavaScript

/**
 * NewPipeExtractor 的外部 JS 解释器（Android 版）。
 *
 * 库默认走 javax.script（Android 上不存在），且 n 参数解码失败会被
 * YoutubeStreamExtractor 静默吞掉——表现为「提取到 0 条视频流」。
 * 这里用 Rhino 直接 API 实现，供 YoutubeJavaScriptPlayerManager 解码 n 参数。
 */
object RhinoJavaScriptInterpreter {
    private const val TAG = "RhinoJsInterpreter"

    /** 安装到库（幂等；YouTubeEngine.ensureInit 后调用） */
    fun install() {
        JavaScript.setExternalJavaScriptInterpreter { function, functionName, parameters ->
            val cx = Context.enter()
            try {
                cx.setInterpretedMode(true)
                val scope = cx.initSafeStandardObjects()
                cx.evaluateString(scope, function, functionName, 1, null)
                val jsFunction = scope.get(functionName, scope) as Function
                val result = jsFunction.call(cx, scope, scope, parameters)
                Context.jsToJava(result, String::class.java) as String
            } catch (e: Exception) {
                Log.e(TAG, "n 参数解码失败: " + (e.message ?: "").take(200), e)
                throw e
            } finally {
                Context.exit()
            }
        }
    }
}
