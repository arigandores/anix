package com.arigandores.anix

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Dialog
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

// Вход через Telegram, VK, Яндекс — то же, что окно social-auth в electron/main.js: страница провайдера в отдельном
// окне, редирект на redirect_uri перехватывается, из него берутся code (PKCE) или access_token.
// req — из server/social.js authRequest: url, redirectHost | redirectScheme | redirectPrefix, tokenInFragment.
// done получает JSON { ok, params } или { ok: false, error }
class SocialAuth(private val activity: Activity, req: JSONObject, private val done: (JSONObject) -> Unit) {
    private val url = req.getString("url")
    private val redirectHost = req.optString("redirectHost")
    private val redirectScheme = req.optString("redirectScheme")
    private val redirectPrefix = req.optString("redirectPrefix")
    private val tokenInFragment = req.optBoolean("tokenInFragment")
    private var finished = false
    private lateinit var dialog: Dialog
    private lateinit var web: WebView

    private val provider = req.optString("provider")

    @SuppressLint("SetJavaScriptEnabled")
    fun show() {
        // Шапка — как в приложении: крестик «Закрыть» слева и «Вход через …», цвета темы приложения. Раньше кнопка
        // «Отмена» справа терялась (светлая тема окна поверх тёмной системы), и выйти можно было только «Назад»
        val dark = activity.getSharedPreferences("anix", Activity.MODE_PRIVATE).getBoolean("darkTheme", true)
        val bg = if (dark) Color.parseColor("#121212") else Color.WHITE
        val fg = if (dark) Color.WHITE else Color.parseColor("#212121")
        dialog = Dialog(activity, if (dark) android.R.style.Theme_DeviceDefault_NoActionBar else android.R.style.Theme_DeviceDefault_Light_NoActionBar)
        val root = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(bg) }
        val name = mapOf("telegram" to "Telegram", "vk" to "ВКонтакте", "yandex" to "Яндекс")[provider]
        val bar = LinearLayout(activity).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), dp(4), dp(16), dp(4))
            setBackgroundColor(bg)
            addView(TextView(activity).apply {
                text = "✕"; textSize = 22f; setTextColor(fg); gravity = Gravity.CENTER
                contentDescription = "Закрыть"
                val ripple = android.util.TypedValue().also { activity.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, it, true) }
                setBackgroundResource(ripple.resourceId)
                setOnClickListener { finish(JSONObject().put("ok", false).put("error", "canceled")) }
            }, LinearLayout.LayoutParams(dp(48), dp(48)))
            addView(TextView(activity).apply {
                text = if (name != null) "Вход через $name" else "Вход"; textSize = 18f; setTextColor(fg)
                setPadding(dp(8), 0, 0, 0); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }
        web = WebView(activity)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url.toString()
                if (check(u)) return true
                // Ссылки на приложения (tg://resolve… — «Open in Telegram») — системе; страница тем временем ждёт
                // подтверждения и потом сама уходит на redirect_uri
                if (!u.startsWith("http")) {
                    try { activity.startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: Exception) {}
                    return true
                }
                return false
            }

            override fun onPageStarted(view: WebView, u: String, favicon: android.graphics.Bitmap?) { check(u) }
        }
        root.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        val frame = FrameLayout(activity).apply { addView(root) }
        frame.setOnApplyWindowInsetsListener { v, insets ->
            val i = insets.getInsets(android.view.WindowInsets.Type.systemBars() or android.view.WindowInsets.Type.ime())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            insets
        }
        frame.setBackgroundColor(bg)
        dialog.setContentView(frame)
        dialog.window?.let { w ->
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            // значки строки состояния — тёмные на светлой шапке, светлые на тёмной
            val light = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            w.insetsController?.setSystemBarsAppearance(if (dark) 0 else light, light)
        }
        dialog.setOnCancelListener { finish(JSONObject().put("ok", false).put("error", "canceled")) }
        dialog.show()
        web.loadUrl(url)
    }

    fun cancel() = finish(JSONObject().put("ok", false).put("error", "canceled"))

    private fun check(raw: String): Boolean {
        val u = try { Uri.parse(raw) } catch (_: Exception) { return false }
        val matchHost = redirectHost.isNotEmpty() && u.host == redirectHost
        val matchScheme = redirectScheme.isNotEmpty() && u.scheme == redirectScheme
        val matchPrefix = redirectPrefix.isNotEmpty() && raw.startsWith(redirectPrefix)
        if (!matchHost && !matchScheme && !matchPrefix) return false
        val frag = Uri.parse("x://x?" + (u.encodedFragment ?: ""))
        fun get(k: String) = (if (u.isHierarchical) u.getQueryParameter(k) else null) ?: frag.getQueryParameter(k)
        if (tokenInFragment) get("access_token")?.let { at ->
            finish(JSONObject().put("ok", true).put("params", JSONObject().put("access_token", at))); return true
        }
        get("code")?.let { code ->
            finish(JSONObject().put("ok", true).put("params", JSONObject().put("code", code)
                .put("device_id", get("device_id") ?: "").put("state", get("state") ?: "")))
            return true
        }
        get("error")?.let { err ->
            finish(JSONObject().put("ok", false).put("error", get("error_description") ?: err)); return true
        }
        return false
    }

    private fun finish(r: JSONObject) {
        if (finished) return
        finished = true
        activity.runOnUiThread {
            try { dialog.dismiss() } catch (_: Exception) {}
            web.destroy()
            done(r)
        }
    }

    private fun dp(v: Int) = (v * activity.resources.displayMetrics.density).toInt()
}
