package com.arigandores.anix

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.os.Build
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.IOException

// Обновление приложения (как electron/updater.js на ПК): APK новой версии из релиза GitHub скачивается с прогрессом
// и ставится системным установщиком Android поверх — вход и настройки сохраняются. Что скачивать и когда — решает
// update.js (окно «Вышла новая версия»); события уходят в страницу через report(код JS)
class Updater(private val activity: Activity, private val report: (String) -> Unit) {
    private val http = OkHttpClient()
    private val file get() = File(activity.cacheDir, "update/Anix-update.apk")
    @Volatile private var call: Call? = null

    fun download(url: String) {
        call?.cancel()
        val c = http.newCall(Request.Builder().url(url).header("User-Agent", "AnixAndroid").build())
        call = c
        Thread {
            try {
                c.execute().use { r ->
                    if (!r.isSuccessful) throw IOException("HTTP ${r.code}")
                    val total = r.body.contentLength()
                    file.parentFile?.mkdirs()
                    val t0 = System.currentTimeMillis()
                    var got = 0L
                    var lastSent = 0L
                    r.body.byteStream().use { inp ->
                        file.outputStream().use { out ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                val n = inp.read(buf)
                                if (n < 0) break
                                out.write(buf, 0, n)
                                got += n
                                val now = System.currentTimeMillis()
                                if (now - lastSent > 200) { lastSent = now; progress(got, total, t0) }
                            }
                        }
                    }
                    progress(got, if (total > 0) total else got, t0)
                    report("__anixUpdateDone(${JSONObject().put("ok", true)})")
                }
            } catch (e: IOException) {
                val r = JSONObject().put("ok", false).put("canceled", c.isCanceled()).put("error", e.message ?: e.javaClass.simpleName)
                report("__anixUpdateDone($r)")
            } finally {
                if (call === c) call = null
            }
        }.start()
    }

    private fun progress(got: Long, total: Long, t0: Long) {
        val secs = (System.currentTimeMillis() - t0).coerceAtLeast(1) / 1000.0
        val p = JSONObject().put("percent", if (total > 0) got * 100.0 / total else 0.0)
            .put("transferred", got).put("total", total).put("speed", (got / secs).toLong())
        report("__anixUpdateProgress($p)")
    }

    fun cancel() { call?.cancel() }

    // Установка через PackageInstaller: система показывает «Обновить приложение?» (и, если нужно, разрешение ставить
    // приложения из этого источника); итог — в __anixUpdateInstalled
    fun install() {
        val f = file
        if (!f.exists()) return report("__anixUpdateInstalled(${JSONObject().put("ok", false).put("error", "нет файла")})")
        val pi = activity.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(activity.packageName)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
        }
        val id = pi.createSession(params)
        pi.openSession(id).use { s ->
            s.openWrite("anix.apk", 0, f.length()).use { out ->
                f.inputStream().use { it.copyTo(out) }
                s.fsync(out)
            }
            val action = "${activity.packageName}.UPDATE_STATUS"
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(ctx: Context, i: Intent) {
                    val st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
                    if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                        @Suppress("DEPRECATION")
                        val confirm = if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else i.getParcelableExtra(Intent.EXTRA_INTENT)
                        confirm?.let { activity.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                        return
                    }
                    try { activity.unregisterReceiver(this) } catch (_: Exception) {}
                    val r = JSONObject().put("ok", st == PackageInstaller.STATUS_SUCCESS).put("error", i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "")
                    report("__anixUpdateInstalled($r)")
                }
            }
            if (Build.VERSION.SDK_INT >= 33) activity.registerReceiver(receiver, IntentFilter(action), Context.RECEIVER_NOT_EXPORTED)
            else activity.registerReceiver(receiver, IntentFilter(action))
            val intent = Intent(action).setPackage(activity.packageName)
            s.commit(PendingIntent.getBroadcast(activity, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE).intentSender)
        }
    }
}
