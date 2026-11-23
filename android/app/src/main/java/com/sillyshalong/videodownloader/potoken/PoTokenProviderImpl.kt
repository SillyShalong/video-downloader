package com.sillyshalong.videodownloader.potoken

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.sillyshalong.videodownloader.App
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.services.youtube.InnertubeClientRequestInfo
import org.schabi.newpipe.extractor.services.youtube.PoTokenProvider
import org.schabi.newpipe.extractor.services.youtube.PoTokenResult
import org.schabi.newpipe.extractor.services.youtube.YoutubeParsingHelper

/**
 * PO token 提供者（移植自 NewPipe PoTokenProviderImpl，适配本应用结构）。
 * 通过 WebView 运行 Google BotGuard 生成 WEB 客户端的 PO token，
 * 使 YouTube 返回视频流（否则只有音频流）。
 */
object PoTokenProviderImpl : PoTokenProvider {
    private val TAG = PoTokenProviderImpl::class.simpleName

    private var webViewBadImpl = false // 系统 WebView 实现损坏时不再重试

    private object WebPoTokenGenLock
    private var webPoTokenVisitorData: String? = null
    private var webPoTokenStreamingPot: String? = null
    private var webPoTokenGenerator: PoTokenGenerator? = null

    override fun getWebClientPoToken(videoId: String): PoTokenResult? {
        if (webViewBadImpl) {
            return null
        }
        try {
            return getWebClientPoToken(videoId = videoId, forceRecreate = false)
        } catch (e: RuntimeException) {
            when (val cause = e.cause) {
                is BadWebViewException -> {
                    Log.e(TAG, "WebView 异常，无法获取 poToken", e)
                    webViewBadImpl = true
                    return null
                }
                null -> throw e
                else -> throw cause
            }
        }
    }

    private fun getWebClientPoToken(videoId: String, forceRecreate: Boolean): PoTokenResult {
        data class Quadruple<T1, T2, T3, T4>(val t1: T1, val t2: T2, val t3: T3, val t4: T4)

        val (poTokenGenerator, visitorData, streamingPot, hasBeenRecreated) =
            synchronized(WebPoTokenGenLock) {
                val shouldRecreate = webPoTokenGenerator == null || forceRecreate ||
                    webPoTokenGenerator!!.isExpired()

                if (shouldRecreate) {
                    val innertubeClientRequestInfo = InnertubeClientRequestInfo.ofWebClient()
                    innertubeClientRequestInfo.clientInfo.clientVersion =
                        YoutubeParsingHelper.getClientVersion()

                    webPoTokenVisitorData = YoutubeParsingHelper.getVisitorDataFromInnertube(
                        innertubeClientRequestInfo,
                        NewPipe.getPreferredLocalization(),
                        NewPipe.getPreferredContentCountry(),
                        YoutubeParsingHelper.getYouTubeHeaders(),
                        YoutubeParsingHelper.YOUTUBEI_V1_URL,
                        null,
                        false,
                    )
                    // 旧 generator 在主线程关闭
                    webPoTokenGenerator?.let { Handler(Looper.getMainLooper()).post { it.close() } }

                    webPoTokenGenerator = PoTokenWebView
                        .newPoTokenGenerator(App.instance).blockingGet()

                    // streaming poToken 必须先生成一次
                    webPoTokenStreamingPot = webPoTokenGenerator!!
                        .generatePoToken(webPoTokenVisitorData!!).blockingGet()
                }

                Quadruple(
                    webPoTokenGenerator!!,
                    webPoTokenVisitorData!!,
                    webPoTokenStreamingPot!!,
                    shouldRecreate,
                )
            }

        val playerPot = try {
            poTokenGenerator.generatePoToken(videoId).blockingGet()
        } catch (throwable: Throwable) {
            if (hasBeenRecreated) {
                throw throwable
            } else {
                Log.e(TAG, "poToken 获取失败，重建 generator 后重试", throwable)
                return getWebClientPoToken(videoId = videoId, forceRecreate = true)
            }
        }

        return PoTokenResult(visitorData, playerPot, streamingPot)
    }

    /** 供 App/引擎判断 WebView 可用性 */
    fun supportsWebView(ctx: Context): Boolean =
        try {
            android.webkit.WebView.getCurrentWebViewPackage() != null
        } catch (_: Exception) {
            true // 新 API 不可用时按可用处理
        }
}
