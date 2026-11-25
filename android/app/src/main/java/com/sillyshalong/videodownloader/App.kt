package com.sillyshalong.videodownloader

import android.app.Application
import android.util.Log

/**
 * 应用入口：进程一起来就拉起本地服务（与桌面端同协议），
 * 界面（WebView）随后加载 http://127.0.0.1:8977，同源访问 /api。
 */
class App : Application() {
    lateinit var engine: TaskEngine
        private set
    lateinit var server: LocalServer
        private set

    companion object {
        private const val TAG = "App"

        @Volatile lateinit var instance: App
            private set
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        engine = TaskEngine(this)
        // 设置里保存过的代理要先于任何网络请求生效
        try {
            val proxy = getSharedPreferences("config", MODE_PRIVATE).getString("proxy", "") ?: ""
            Http.setProxy(proxy)
            HlsEngine.applyWebViewProxy(proxy)
        } catch (e: Exception) {
            Log.w(TAG, "读取代理设置失败", e)
        }
        LocalServer.engine = engine
        server = LocalServer.start(this)
    }
}
