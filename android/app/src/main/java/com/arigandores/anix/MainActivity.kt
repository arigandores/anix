package com.arigandores.anix

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationManager
import android.app.Activity
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Insets
import android.graphics.drawable.Icon
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.speech.RecognizerIntent
import android.util.Rational
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
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
    private var rotateFree = false // плеер поворачивается за телефоном («Только горизонтально» выключено)
    private var orientationLocked = false // блокировка в плеере: ориентация — та, что сейчас
    private var haptics = 0 // сколько раз был отклик вибрацией (для тестов)
    private var pendingLink: String? = null
    private var social: SocialAuth? = null
    private val updater by lazy { Updater(this) { js(it) } }
    private var session: MediaSession? = null
    private var fileCallback: android.webkit.ValueCallback<Array<Uri>>? = null // выбор файла для страницы
    private var saveText: String? = null // файл, который страница сохраняет (экспорт закладок), — до выбора места
    private var imeShown = false // клавиатура открыта: странице — убрать нижнее меню (shim.js __anixIme)
    private var cutout = Insets.NONE // вырез камеры в плеере: видео под ним, кнопки страница отодвигает (shim.js)
    // Кнопки окна «картинка в картинке» → страница (__anixMedia в shim.js)
    private val mediaReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) { i.getStringExtra("cmd")?.let { media(it) } }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        // тема приложения с прошлого запуска (страница сообщает её — setTheme): светлая — без тёмной вспышки до загрузки
        darkTheme = getSharedPreferences("anix", MODE_PRIVATE).getBoolean("darkTheme", true)
        if (!darkTheme) setTheme(R.style.AppTheme_Light)
        super.onCreate(savedInstanceState)
        pendingLink = linkOf(intent)

        root = FrameLayout(this)
        // видео в плеере — до края экрана, и под вырезом камеры (по умолчанию в горизонтали окно его обходит)
        window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
        // Android 15+ рисует под системными полосами — отступы под них (и под клавиатуру). В плеере и полном экране
        // полосы спрятаны и отступа нет: видео на весь экран, а кнопки плеера страница отодвигает от выреза сама
        root.setOnApplyWindowInsetsListener { v, insets ->
            val full = fullscreen != null || playerOpen
            val i = if (full) Insets.NONE
            else insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            val c = if (full) insets.getInsets(WindowInsets.Type.displayCutout()) else Insets.NONE
            if (c != cutout) { cutout = c; js("window.__anixInsets && __anixInsets()") }
            val k = insets.isVisible(WindowInsets.Type.ime())
            if (k != imeShown) { imeShown = k; js("window.__anixIme && __anixIme($k)") }
            insets
        }
        web = WebView(this)
        web.setBackgroundColor(if (darkTheme) Color.parseColor("#121212") else Color.WHITE)
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            // страница — как приложение, а не сайт: двумя пальцами её не масштабировать (щипок в плеере — режим кадра,
            // его ловит сама страница). И метатег viewport в сборке (sync-web.mjs)
            setSupportZoom(false); builtInZoomControls = false; displayZoomControls = false
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

            // <input type="file"> (обложка коллекции, аватар, импорт закладок) — системный выбор файла
            override fun onShowFileChooser(view: WebView, callback: android.webkit.ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                @Suppress("DEPRECATION")
                return try { startActivityForResult(params.createIntent(), REQ_FILE); true } catch (_: Exception) { fileCallback = null; false }
            }

            // Заглушка видео без кадра — прозрачная: своя у WebView (серый фон и огромный треугольник) была на весь
            // экран плеера, пока серия грузится, — поверх неё только кружок загрузки страницы
            override fun getDefaultVideoPoster(): Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)

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

        val filter = IntentFilter(MEDIA)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(mediaReceiver, filter, RECEIVER_NOT_EXPORTED) else registerReceiver(mediaReceiver, filter)
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { back() }
        }
        web.loadUrl("http://127.0.0.1:${server.port}/")
    }

    // MIUI/HyperOS: разрешено ли создавать ярлыки (MIUIOP 10017, «Ярлыки на рабочем столе»). Не Xiaomi или не
    // удалось спросить — считаем, что можно (как раньше)
    private fun miuiShortcutsAllowed(): Boolean {
        if (!Build.MANUFACTURER.equals("Xiaomi", ignoreCase = true)) return true
        return try {
            val ops = getSystemService(android.app.AppOpsManager::class.java)
            val check = android.app.AppOpsManager::class.java.getMethod("checkOpNoThrow", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, String::class.java)
            check.invoke(ops, 10017, applicationInfo.uid, packageName) as Int == android.app.AppOpsManager.MODE_ALLOWED
        } catch (_: Exception) { true }
    }

    // Приглашение в совместный просмотр: anixdesktop://watch/<код> (docs/watch открывает эту ссылку); ссылки на Anixart
    // (https://anixart.tv/release/…, anixart://…) — страница открывает их сама (links.js)
    private fun linkOf(i: Intent?): String? =
        i?.takeIf { it.action == Intent.ACTION_VIEW }?.data?.takeIf { it.scheme in setOf("anixdesktop", "anixart", "https", "http") }?.toString()

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

    // Голосовой поиск: распознанный текст — странице (__anixVoice в shim.js); выбранный файл — <input type="file">
    @Deprecated("startActivityForResult — без androidx")
    override fun onActivityResult(code: Int, result: Int, data: Intent?) {
        super.onActivityResult(code, result, data)
        if (code == REQ_SAVE) {
            val text = saveText; saveText = null
            val ok = result == RESULT_OK && text != null && data?.data != null && try {
                contentResolver.openOutputStream(data.data!!)?.use { it.write(text.toByteArray()) } != null
            } catch (_: Exception) { false }
            js("window.__anixSaved && __anixSaved($ok)")
            return
        }
        if (code == REQ_FILE) { fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data)); fileCallback = null; return }
        if (code != REQ_VOICE) return
        val text = if (result == RESULT_OK) data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull() else null
        js("window.__anixVoice && __anixVoice(${if (text != null) JSONObject.quote(text) else "null"})")
    }

    private fun voiceIntent() = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ru-RU")
        .putExtra(RecognizerIntent.EXTRA_PROMPT, "Название аниме")

    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, permissions, results)
        if (code == REQ_NOTIFY) js("window.__anixNotifyPermission && __anixNotifyPermission(${notifyPermission() == "granted"})")
    }

    // Уведомления на телефоне: granted — можно; ask — можно спросить (системный диалог); denied — отказали насовсем
    // (только в настройках Android); off — выключены в настройках Android
    private fun notifyPermission(): String {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
            return if (nm.areNotificationsEnabled()) "granted" else "off"
        val asked = getSharedPreferences("anix", MODE_PRIVATE).getBoolean("notifyAsked", false)
        return if (!asked || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) "ask" else "denied"
    }

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
        requestedOrientation = when {
            !full -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            orientationLocked -> ActivityInfo.SCREEN_ORIENTATION_LOCKED
            rotateFree -> ActivityInfo.SCREEN_ORIENTATION_FULL_USER
            else -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        }
        if (playing) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        root.requestApplyInsets()
        updatePip()
        updateSession()
    }

    // Значок ярлыка из постера: квадрат по центру (постер 2:3), без сети — значок приложения
    private fun shortcutIcon(url: String): Icon? = try {
        val bytes = okhttp3.OkHttpClient().newCall(okhttp3.Request.Builder().url(url).build()).execute().use { if (it.isSuccessful) it.body.bytes() else null }
        bytes?.let { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size) }?.let { b ->
            val side = minOf(b.width, b.height)
            val sq = android.graphics.Bitmap.createBitmap(b, (b.width - side) / 2, (b.height - side) / 4, side, side)
            Icon.createWithBitmap(android.graphics.Bitmap.createScaledBitmap(sq, 192, 192, true))
        }
    } catch (_: Exception) { null }

    // Команда плееру: play, pause, rew, fwd (∓10 с), next, prev — от окна PiP, гарнитуры, Bluetooth
    private fun media(cmd: String) = js("window.__anixMedia && __anixMedia(${JSONObject.quote(cmd)})")

    private fun pipAction(cmd: String, icon: Int, title: String, code: Int) = RemoteAction(
        Icon.createWithResource(this, icon), title, title,
        PendingIntent.getBroadcast(this, code, Intent(MEDIA).setPackage(packageName).putExtra("cmd", cmd),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))

    // «Картинка в картинке»: свернули приложение, пока идёт серия, — плеер остаётся маленьким окном поверх других.
    // В окне — −10 с, пауза или «Продолжить», +10 с (система разрешает не больше трёх кнопок)
    private fun pipParams(): PictureInPictureParams {
        val b = PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9)).setActions(listOf(
            pipAction("rew", android.R.drawable.ic_media_rew, "−10 с", 1),
            if (playing) pipAction("pause", android.R.drawable.ic_media_pause, "Пауза", 2)
            else pipAction("play", android.R.drawable.ic_media_play, "Продолжить", 2),
            pipAction("fwd", android.R.drawable.ic_media_ff, "+10 с", 3)))
        if (Build.VERSION.SDK_INT >= 31) b.setAutoEnterEnabled(playerOpen && playing).setSeamlessResizeEnabled(false)
        return b.build()
    }

    // Медиасессия, пока открыт плеер: кнопки гарнитуры и Bluetooth (пауза, следующая серия) — плееру
    private fun updateSession() {
        if (!playerOpen) { session?.release(); session = null; return }
        val s = session ?: MediaSession(this, "Anix").also {
            it.setCallback(object : MediaSession.Callback() {
                override fun onPlay() { media("play") }
                override fun onPause() { media("pause") }
                override fun onSkipToNext() { media("next") }
                override fun onSkipToPrevious() { media("prev") }
                override fun onFastForward() { media("fwd") }
                override fun onRewind() { media("rew") }
            })
            session = it
        }
        s.setPlaybackState(PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
                PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_FAST_FORWARD or PlaybackState.ACTION_REWIND)
            .setState(if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
            .build())
        s.isActive = true
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

    // Уходим с экрана — «Домой», список недавних, «картинка в картинке» (серия идёт дальше): место в серии и история
    // просмотра — сразу на сервер синхронизации (sync.js), пока процесс жив. Из недавних приложение смахивают, и
    // процесс убивается без onStop: отправка только в onStop (так было в 1.8.0) не успевала, на ПК оставалось старое место
    override fun onPause() {
        super.onPause()
        js("window.__anixLeave && __anixLeave()")
    }
    // Список недавних: приложение там — «живая плитка», onPause/onStop приходят только через ~2 с (или не приходят,
    // если смахнули раньше). Сразу приходит лишь потеря фокуса окна — по ней тоже отправляем. Фокус теряется и под
    // шторкой уведомлений, системными окнами — лишняя отправка безвредна (уходит только новое)
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) js("window.__anixLeave && __anixLeave()")
    }

    // Ушли из приложения (не в «картинку в картинке») или закрыли окно PiP — серия на паузу, а не играет в фоне;
    // место — ещё раз на сервер (с паузы)
    override fun onStop() {
        super.onStop()
        js("window.__anixPause && __anixPause(); window.__anixLeave && __anixLeave()")
    }

    // window.anixAndroid в WebView (android/web/shim.js). Методы вызываются не из UI-потока
    inner class Bridge {
        @JavascriptInterface
        fun setTheme(dark: Boolean) = runOnUiThread {
            if (dark != darkTheme || !getSharedPreferences("anix", MODE_PRIVATE).contains("darkTheme")) {
                getSharedPreferences("anix", MODE_PRIVATE).edit().putBoolean("darkTheme", dark).apply()
                // заставка при следующем запуске (Android 13+) — в цвет темы
                if (Build.VERSION.SDK_INT >= 33) try { splashScreen.setSplashScreenTheme(if (dark) R.style.AppTheme else R.style.AppTheme_Light) } catch (_: Exception) {}
            }
            darkTheme = dark; applyBars()
        }

        @JavascriptInterface
        fun setPlayer(open: Boolean) = runOnUiThread { if (playerOpen != open) { playerOpen = open; orientationLocked = false; applyPlayerMode() } }

        @JavascriptInterface
        fun setPlayerRotate(free: Boolean) = runOnUiThread { rotateFree = free }

        @JavascriptInterface
        fun lockOrientation(on: Boolean) = runOnUiThread { orientationLocked = on; applyPlayerMode() }

        @JavascriptInterface
        fun setPlaying(on: Boolean) = runOnUiThread { if (playing != on) { playing = on; applyPlayerMode() } }

        // Уведомления Anixart на телефоне (push.js): разрешение, фоновая проверка (NotifyJob), настройки уведомлений Android
        @JavascriptInterface
        fun notifyPermission(): String = this@MainActivity.notifyPermission()

        @JavascriptInterface
        fun requestNotifyPermission() = runOnUiThread {
            getSharedPreferences("anix", MODE_PRIVATE).edit().putBoolean("notifyAsked", true).apply()
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
        }

        @JavascriptInterface
        fun setNotify(on: Boolean) = NotifyJob.schedule(this@MainActivity, on)

        @JavascriptInterface
        fun openNotifySettings() = runOnUiThread {
            try { startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)) } catch (_: Exception) {}
        }

        // Настройки Android «Открывать по умолчанию»: разрешить приложению ссылки Anixart (домены не наши — сама система
        // их нам не отдаёт, открывает браузер)
        @JavascriptInterface
        fun openLinkSettings() = runOnUiThread {
            val pkg = Uri.parse("package:$packageName")
            try { startActivity(Intent(Settings.ACTION_APP_OPEN_BY_DEFAULT_SETTINGS, pkg)) }
            catch (_: Exception) { try { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)) } catch (_: Exception) {} }
        }

        // Запись страницы в журнал телефона (adb logcat -s AnixWeb): возможности WebView, сбои — для диагностики
        @JavascriptInterface
        fun log(msg: String) { android.util.Log.i("AnixWeb", msg.take(500)) }

        // Отклик вибрацией (platform.js haptic): long — меню по долгому нажатию, tap — голос, оценка
        @JavascriptInterface
        fun haptic(kind: String) = runOnUiThread {
            haptics++
            web.performHapticFeedback(if (kind == "long") HapticFeedbackConstants.LONG_PRESS else HapticFeedbackConstants.CONFIRM)
        }

        // Голосовой поиск: есть ли распознавание речи на телефоне, послушать (результат — onActivityResult)
        @JavascriptInterface
        fun voiceAvailable(): Boolean = packageManager.queryIntentActivities(voiceIntent(), 0).isNotEmpty()

        @Suppress("DEPRECATION")
        @JavascriptInterface
        fun voiceListen() = runOnUiThread {
            try { startActivityForResult(voiceIntent(), REQ_VOICE) } catch (_: Exception) { js("window.__anixVoice && __anixVoice(null)") }
        }

        // Ярлык на рабочем столе (аниме, коллекция): значок — постер (квадрат по центру), нажатие — ссылка anixart://…
        @JavascriptInterface
        // ok | unsupported | blocked — на Xiaomi (MIUI/HyperOS) ярлыки по умолчанию запрещены разрешением «Ярлыки на
        // рабочем столе» (MIUIOP 10017): запрос система молча отклоняет, и кнопка «ничего не делала» — страница
        // показывает, где разрешить (openShortcutSettings)
        fun pinShortcut(id: String, label: String, link: String, image: String): String {
            val sm = getSystemService(android.content.pm.ShortcutManager::class.java)
            if (sm?.isRequestPinShortcutSupported != true) return "unsupported"
            if (!miuiShortcutsAllowed()) return "blocked"
            kotlin.concurrent.thread {
                val pic = image.takeIf { it.startsWith("http") }?.let { shortcutIcon(it) }
                val info = android.content.pm.ShortcutInfo.Builder(this@MainActivity, id)
                    .setShortLabel(label.take(24)).setLongLabel(label)
                    .setIcon(pic ?: Icon.createWithResource(this@MainActivity, R.mipmap.ic_launcher))
                    .setIntent(Intent(Intent.ACTION_VIEW, Uri.parse(link), this@MainActivity, MainActivity::class.java))
                    .build()
                runOnUiThread { try { sm.requestPinShortcut(info, null) } catch (_: Exception) {} }
            }
            return "ok"
        }

        // Экран разрешений приложения в MIUI (там «Ярлыки на рабочем столе»); не открылся — карточка приложения
        @JavascriptInterface
        fun openShortcutSettings() = runOnUiThread {
            try {
                startActivity(Intent("miui.intent.action.APP_PERM_EDITOR")
                    .setClassName("com.miui.securitycenter", "com.miui.permcenter.permissions.PermissionsEditorActivity")
                    .putExtra("extra_pkgname", packageName))
            } catch (_: Exception) {
                try { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) } catch (_: Exception) {}
            }
        }

        // Значок приложения на рабочем столе: default | light | carmine — включён один ярлык запуска (activity-alias)
        @JavascriptInterface
        fun icon(): String = ICONS.entries.firstOrNull { (_, alias) ->
            packageManager.getComponentEnabledSetting(ComponentName(this@MainActivity, "$packageName$alias")).let {
                it == PackageManager.COMPONENT_ENABLED_STATE_ENABLED || (it == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && alias == ".IconDefault")
            }
        }?.key ?: "default"

        @JavascriptInterface
        fun setIcon(name: String) {
            if (name !in ICONS) return
            for ((key, alias) in ICONS) packageManager.setComponentEnabledSetting(ComponentName(this@MainActivity, "$packageName$alias"),
                if (key == name) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP)
        }

        // Сохранить файл (экспорт закладок): системный «Сохранить как» — папка и имя на выбор, результат — __anixSaved
        @Suppress("DEPRECATION")
        @JavascriptInterface
        fun saveFile(name: String, mime: String, text: String) = runOnUiThread {
            saveText = text
            try {
                startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime)
                    .putExtra(Intent.EXTRA_TITLE, name), REQ_SAVE)
            } catch (_: Exception) { saveText = null; js("window.__anixSaved && __anixSaved(false)") }
        }

        // Кнопка «Картинка в картинке» в плеере
        @JavascriptInterface
        fun enterPip() = runOnUiThread { try { enterPictureInPictureMode(pipParams()) } catch (_: Exception) {} }

        // Вырез камеры в плеере, в пикселях страницы: {l, t, r, b}
        @JavascriptInterface
        fun cutout(): String {
            val d = resources.displayMetrics.density
            return JSONObject().put("l", cutout.left / d).put("t", cutout.top / d).put("r", cutout.right / d).put("b", cutout.bottom / d).toString()
        }

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
                    .put("pipActions", pipParams().actions.joinToString("|") { it.title })
                    .put("session", session?.takeIf { it.isActive }?.controller?.playbackState?.state ?: 0)
                    .put("rootPadding", "${root.paddingLeft},${root.paddingTop},${root.paddingRight},${root.paddingBottom}")
                    .put("darkBars", window.insetsController?.systemBarsAppearance?.and(WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS) == 0)
                    .put("socialOpen", social != null)
                    .put("notifyScheduled", NotifyJob.scheduled(this@MainActivity))
                    .put("haptics", haptics)
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
        session?.release()
        try { unregisterReceiver(mediaReceiver) } catch (_: Exception) {}
        try { web.destroy() } catch (_: Exception) {} // уже уничтожен (упал процесс страницы — onRenderProcessGone)
        super.onDestroy()
    }
}

private const val MEDIA = "com.arigandores.anix.MEDIA"
private const val REQ_NOTIFY = 7
private const val REQ_VOICE = 8
private const val REQ_FILE = 9
private const val REQ_SAVE = 10
private val ICONS = mapOf("default" to ".IconDefault", "light" to ".IconLight", "carmine" to ".IconCarmine")

// Локальный сервер — один на процесс: живёт, пока жив процесс (вход через Google в браузере ждёт ответа и тогда,
// когда окно приложения пересоздаётся; фоновой проверке уведомлений — NotifyJob — окно не нужно)
object Server {
    @Volatile private var instance: LocalServer? = null
    fun get(c: Context): LocalServer = instance ?: synchronized(this) {
        instance ?: LocalServer(c.applicationContext.assets).also { it.start(); instance = it }
    }
}
