package com.sillyshalong.videodownloader

import android.app.Application

/**
 * 独立模式入口：App 启动即拉起本地服务（与桌面端同协议），
 * UI（WebView）加载 http://127.0.0.1:8977 —— 同源访问 /api，前端零改动复用。
 */
class App : Application() {
    lateinit var engine: TaskEngine

    override fun onCreate() {
        super.onCreate()
        engine = TaskEngine(this)
        LocalServer.engine = engine
        LocalServer.start(this)
    }
}
