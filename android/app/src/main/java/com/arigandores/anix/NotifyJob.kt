package com.arigandores.anix

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

// Уведомления Anixart на телефоне, пока приложение закрыто: раз в ~30 минут (когда есть сеть) система запускает эту
// задачу, она открывает скрытый WebView со страницей android/web/background.html — тот же код запросов, что у
// приложения (подпись, relay, токен в localStorage), — и показывает новые уведомления аккаунта системными, с постером.
// Нажатие — ссылка anixart://… в приложение (MainActivity → links.js). Включает и выключает страница (push.js)
class NotifyJob : JobService() {
    private var web: WebView? = null
    private val main = Handler(Looper.getMainLooper())

    override fun onStartJob(params: JobParameters): Boolean {
        main.post { check(params) }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        main.post { finish() }
        return true // не успели — повторить
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun check(params: JobParameters) {
        val server = Server.get(this)
        var done = false
        val end = { json: String? ->
            main.post {
                if (!done) {
                    done = true
                    finish()
                    if (json != null) thread { show(this, json) }
                    jobFinished(params, false)
                }
            }
        }
        val w = WebView(this)
        web = w
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        w.webViewClient = WebViewClient()
        w.addJavascriptInterface(object {
            @JavascriptInterface fun relayKey(): String = server.relayKey
            @JavascriptInterface fun done(json: String) { end(json) }
        }, "anixBackground")
        w.loadUrl("http://127.0.0.1:${server.port}/android/background.html")
        main.postDelayed({ end(null) }, 60_000) // сеть или страница зависли — в следующий раз
    }

    private fun finish() {
        web?.let { it.stopLoading(); it.destroy() }
        web = null
    }

    companion object {
        private const val JOB = 1
        private const val CHANNEL = "anixart"

        fun schedule(c: Context, on: Boolean) {
            val js = c.getSystemService(JobScheduler::class.java)
            if (!on) { js.cancel(JOB); return }
            if (js.getPendingJob(JOB) != null) return
            js.schedule(JobInfo.Builder(JOB, ComponentName(c, NotifyJob::class.java))
                .setPeriodic(TimeUnit.MINUTES.toMillis(30))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .build())
        }

        fun scheduled(c: Context) = c.getSystemService(JobScheduler::class.java).getPendingJob(JOB) != null

        // [{ id, title, text, image, link }] → системные уведомления (не в UI-потоке: постеры качаются из сети)
        fun show(c: Context, json: String) {
            val list = try { JSONArray(json) } catch (_: Exception) { return } // {error} — сеть, сервер
            if (list.length() == 0) return
            val nm = c.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Уведомления Anixart", NotificationManager.IMPORTANCE_DEFAULT)
                .apply { description = "Новые серии, ответы на комментарии, друзья — как в приложении Anixart" })
            val http = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).build()
            for (i in 0 until list.length()) {
                val n = list.getJSONObject(i)
                val id = n.optString("id")
                val pic = n.optString("image").takeIf { it.startsWith("http") }?.let { poster(http, it) }
                val open = Intent(Intent.ACTION_VIEW, Uri.parse(n.optString("link")), c, MainActivity::class.java)
                val b = Notification.Builder(c, CHANNEL)
                    .setSmallIcon(R.drawable.ic_stat_anix)
                    .setContentTitle(n.optString("title"))
                    .setContentText(n.optString("text"))
                    .setStyle(Notification.BigTextStyle().bigText(n.optString("text")))
                    .setAutoCancel(true)
                    .setContentIntent(PendingIntent.getActivity(c, id.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
                if (pic != null) b.setLargeIcon(pic)
                try { nm.notify(id, 1, b.build()) } catch (_: SecurityException) { return } // разрешение отозвали
            }
        }

        private fun poster(http: OkHttpClient, url: String): Bitmap? = try {
            http.newCall(Request.Builder().url(url).build()).execute().use { r -> if (r.isSuccessful) r.body.bytes().let { BitmapFactory.decodeByteArray(it, 0, it.size) } else null }
        } catch (_: Exception) { null }
    }
}
