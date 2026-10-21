package com.arigandores.anix

import android.annotation.SuppressLint
import android.app.Activity
import android.app.PictureInPictureParams
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.window.OnBackInvokedDispatcher
import org.json.JSONObject
import java.io.File

// Одно окно: WebView с фронтендом из public/ на локальном сервере (LocalServer).
// Мост window.anixAndroid (Bridge) — для android/web/shim.js: тема системных полос, плеер (горизонталь, экран не гаснет,
// «картинка в картинке»), вход через соцсети, ссылки наружу, «Поделиться», приглашения anixdesktop://watch/<код>
class MainActivity : Activity() {
    private val server get() = Server.get(this)
    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private var fullscreen: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private var darkTheme = true
    private var playerOpen = false // открыт встроенный плеер (не мини-плеер)
    private var playing = false
    private var pendingLink: String? = null
    private var social: SocialAuth? = null
    private val updater by lazy { Updater(this) { js(it) } }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingLink = linkOf(intent)

        root = FrameLayout(this)
        // Android 15+ рисует под системными полосами — отступы под них (и под клавиатуру). В плеере и полном экране
        // полосы спрятаны: отступ только под вырез камеры
        root.setOnApplyWindowInsetsListener { v, insets ->
            val types = if (fullscreen != null || playerOpen) WindowInsets.Type.displayCutout()
            else WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime()
            val i = insets.getInsets(types)
            v.setPadding(i.left, i.top, i.right, i.bottom)
            insets
        }
        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#121212"))
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString AnixAndroid/${packageManager.getPackageInfo(packageName, 0).versionName}"
        }
        web.addJavascriptInterface(Bridge(), "anixAndroid")
        web.webViewClient = object : WebViewClient() {
            // Ссылки наружу (window.open, ссылки в комментариях, страница проекта) — в системном браузере
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == "127.0.0.1" && u.port == server.port) return false
                openExternal(u)
                return true
            }

            // Процесс страницы упал или его убила система (мало памяти) — без этого падает и приложение; пересоздаём окно
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                root.removeView(view)
                view.destroy()
                recreate()
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            // requestFullscreen() у плеера
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (fullscreen != null) { callback.onCustomViewHidden(); return }
                fullscreen = view
                fullscreenCallback = callback
                root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                applyPlayerMode()
            }

            override fun onHideCustomView() {
                val v = fullscreen ?: return
                root.removeView(v)
                fullscreen = null
                fullscreenCallback = null
                applyPlayerMode()
            }
        }
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        applyBars()

        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { back() }
        }
        web.loadUrl("http://127.0.0.1:${server.port}/")
    }

    // Приглашение в совместный просмотр: anixdesktop://watch/<код> (docs/watch открывает эту ссылку)
    private fun linkOf(i: Intent?): String? = i?.data?.takeIf { it.scheme == "anixdesktop" }?.toString()

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val link = linkOf(intent) ?: return
        js("window.__anixDeepLink && __anixDeepLink(${JSONObject.quote(link)})")
    }

    // «Назад»: решает страница (__anixBack в shim.js: полный экран → окно/плеер → экран назад);
    // не обработала (корневой экран) — приложение сворачивается
    private fun back() {
        social?.let { it.cancel(); return }
        web.evaluateJavascript("window.__anixBack ? __anixBack() : false") { handled ->
            if (handled != "true") moveTaskToBack(true)
        }
    }

    @Deprecated("Android 12 и ниже")
    override fun onBackPressed() = back()

    private fun js(code: String) = runOnUiThread { web.evaluateJavascript(code, null) }

    private fun openExternal(u: Uri) {
        try { startActivity(Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
    }

    private fun applyBars() {
        val bg = if (darkTheme) Color.parseColor("#121212") else Color.WHITE
        root.setBackgroundColor(bg)
        @Suppress("DEPRECATION")
        window.statusBarColor = bg
        @Suppress("DEPRECATION")
        window.navigationBarColor = bg
        val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        window.insetsController?.setSystemBarsAppearance(if (darkTheme) 0 else light, light)
    }

    // Плеер на весь экран: горизонталь, без системных полос (вытягиваются жестом), экран не гаснет, пока идёт серия
    private fun applyPlayerMode() {
        val full = playerOpen || fullscreen != null
        window.insetsController?.apply {
            if (full) {
                hide(WindowInsets.Type.systemBars())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            } else show(WindowInsets.Type.systemBars())
        }
        requestedOrientation = if (full) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        if (playing) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        root.requestApplyInsets()
        updatePip()
    }

    // «Картинка в картинке»: свернули приложение, пока идёт серия, — плеер остаётся маленьким окном поверх других
    private fun pipParams(): PictureInPictureParams {
        val b = PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9))
        if (Build.VERSION.SDK_INT >= 31) b.setAutoEnterEnabled(playerOpen && playing).setSeamlessResizeEnabled(false)
        return b.build()
    }

    private fun updatePip() {
        try { setPictureInPictureParams(pipParams()) } catch (_: Exception) {}
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Build.VERSION.SDK_INT < 31 && playerOpen && playing) {
            try { enterPictureInPictureMode(pipParams()) } catch (_: Exception) {}
        }
    }

    override fun onPictureInPictureModeChanged(inPip: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(inPip, newConfig)
        js("window.__anixPip && __anixPip($inPip)")
    }

    // Ушли из приложения (не в «картинку в картинке») или закрыли окно PiP — серия на паузу, а не играет в фоне
    override fun onStop() {
        super.onStop()
        js("window.__anixPause && __anixPause()")
    }

    // window.anixAndroid в WebView (android/web/shim.js). Методы вызываются не из UI-потока
    inner class Bridge {
        @JavascriptInterface
        fun setTheme(dark: Boolean) = runOnUiThread { darkTheme = dark; applyBars() }

        @JavascriptInterface
        fun setPlayer(open: Boolean) = runOnUiThread { if (playerOpen != open) { playerOpen = open; applyPlayerMode() } }

        @JavascriptInterface
        fun setPlaying(on: Boolean) = runOnUiThread { if (playing != on) { playing = on; applyPlayerMode() } }

        @JavascriptInterface
        fun openExternal(url: String) = runOnUiThread { this@MainActivity.openExternal(Uri.parse(url)) }

        @JavascriptInterface
        fun share(text: String) = runOnUiThread {
            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
            try { startActivity(Intent.createChooser(send, null)) } catch (_: Exception) {}
        }

        @JavascriptInterface
        fun setGoogleConfig(json: String) { server.googleConfig = json }

        @JavascriptInterface
        fun relayKey(): String = server.relayKey

        // Вход через Telegram, VK, Яндекс: результат — в __anixSocialDone(id, json)
        @JavascriptInterface
        fun socialAuth(req: String, id: Int) = runOnUiThread {
            social?.cancel()
            social = SocialAuth(this@MainActivity, JSONObject(req)) { r ->
                social = null
                js("window.__anixSocialDone && __anixSocialDone($id, ${r})")
            }.also { it.show() }
        }

        @JavascriptInterface
        fun cancelSocialAuth() = runOnUiThread { social?.cancel() }

        // Кэш WebView (картинки, скрипты): сколько было байт — очищается в UI-потоке
        @JavascriptInterface
        fun clearWebCache(): Long {
            fun size(f: File): Long = if (f.isDirectory) (f.listFiles() ?: emptyArray()).sumOf { size(it) } else f.length()
            val n = size(cacheDir) + size(File(dataDir, "app_webview/Default/HTTP Cache"))
            runOnUiThread { web.clearCache(true) }
            return n
        }

        // Обновление (update.js через shim.js): скачать APK, отменить, поставить; события — __anixUpdate*
        @JavascriptInterface
        fun updateDownload(url: String) = updater.download(url)

        @JavascriptInterface
        fun updateCancel() = updater.cancel()

        @JavascriptInterface
        fun updateInstall() = runOnUiThread { updater.install() }

        @JavascriptInterface
        fun pendingDeepLink(): String? = pendingLink.also { pendingLink = null }

        @JavascriptInterface
        fun focusWindow() = runOnUiThread {
            startActivity(Intent(this@MainActivity, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
        }

        // Для тестов (android/test): что сейчас с окном — полосы, «экран не гаснет», ориентация, «картинка в картинке»
        @JavascriptInterface
        fun state(): String {
            val task = java.util.concurrent.FutureTask {
                val ins = root.rootWindowInsets
                JSONObject()
                    .put("playerOpen", playerOpen).put("playing", playing)
                    .put("statusBarVisible", ins?.isVisible(WindowInsets.Type.statusBars()) ?: true)
                    .put("navBarVisible", ins?.isVisible(WindowInsets.Type.navigationBars()) ?: true)
                    .put("imeVisible", ins?.isVisible(WindowInsets.Type.ime()) ?: false)
                    .put("webHeight", web.height).put("rootHeight", root.height)
                    .put("keepScreenOn", window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
                    .put("requestedOrientation", requestedOrientation)
                    .put("landscape", resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE)
                    .put("inPip", isInPictureInPictureMode)
                    .put("darkBars", window.insetsController?.systemBarsAppearance?.and(WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS) == 0)
                    .put("socialOpen", social != null)
                    .toString()
            }
            runOnUiThread(task)
            return task.get(3, java.util.concurrent.TimeUnit.SECONDS)
        }

        // Для тестов: масштаб текста WebView (вслед за размером шрифта в настройках Android)
        @JavascriptInterface
        fun textZoom(): Int = java.util.concurrent.FutureTask { web.settings.textZoom }.also { runOnUiThread(it) }.get(3, java.util.concurrent.TimeUnit.SECONDS)

        // Для тестов (android/test): где страница на экране, в пикселях экрана — чтобы нажимать как пальцем (adb input tap)
        @JavascriptInterface
        fun webOrigin(): String {
            val loc = IntArray(2)
            web.getLocationOnScreen(loc)
            return "${loc[0]},${loc[1]}"
        }
    }

    override fun onDestroy() {
        social?.cancel()
        try { web.destroy() } catch (_: Exception) {} // уже уничтожен (упал процесс страницы — onRenderProcessGone)
        super.onDestroy()
    }
}

// Локальный сервер — один на процесс: живёт, пока жив процесс (вход через Google в браузере ждёт ответа и тогда,
// когда окно приложения пересоздаётся)
object Server {
    @Volatile private var instance: LocalServer? = null
    fun get(a: Activity): LocalServer = instance ?: synchronized(this) {
        instance ?: LocalServer(a.applicationContext.assets).also { it.start(); instance = it }
    }
}
