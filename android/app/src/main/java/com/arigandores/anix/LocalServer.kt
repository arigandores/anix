package com.arigandores.anix

import android.content.res.AssetManager
import android.util.Base64
import android.util.Log
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URLDecoder
import java.net.UnknownHostException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

// Локальный сервер приложения на 127.0.0.1 — то, что на ПК делает server/index.js, но только то, чего WebView не умеет:
//   /__relay — запрос куда угодно с любыми заголовками (User-Agent, Referer, Cookie, Sign) и без CORS;
//              через него ходят подпись и парсеры из server/, которые работают в WebView (android/web/shim.js)
//   /stream  — прокси медиа для <video> и hls.js (Range, Referer/UA/Cookie, перезапись m3u8), как handleStream
//   /social/google/* — вход через Google в системном браузере (как server/social.js: страница google-auth.html
//              в браузере отдаёт сюда Firebase idToken, приложение ждёт его)
//   остальное — фронтенд из assets/www
// Порт постоянный: localStorage (настройки, история, вход) привязан к адресу страницы вместе с портом
class LocalServer(private val assets: AssetManager) {
    private val socket = bind()
    private val pool = Executors.newCachedThreadPool()
    val port: Int get() = socket.localPort
    @Volatile var googleConfig = "{}" // { apiKey, authDomain } — присылает shim.js (ключи из config.local.json)
    // /__relay — запрос куда угодно с любыми заголовками: сервер виден всем приложениям телефона, поэтому только с ключом,
    // который знает страница приложения (мост anixAndroid.relayKey); новый при каждом запуске
    val relayKey: String = Base64.encodeToString(ByteArray(24).also { java.security.SecureRandom().nextBytes(it) }, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    private val noRedirects = http.newBuilder().followRedirects(false).followSslRedirects(false).build()

    fun start() {
        Thread({
            while (!socket.isClosed) {
                val s = try { socket.accept() } catch (_: IOException) { break }
                pool.execute { serve(s) }
            }
        }, "anix-server").apply { isDaemon = true; start() }
    }

    fun stop() {
        try { socket.close() } catch (_: IOException) {}
        pool.shutdownNow()
    }

    private fun bind(): ServerSocket {
        for (p in PORTS) {
            try {
                return ServerSocket().apply { reuseAddress = true; bind(java.net.InetSocketAddress(InetAddress.getByName("127.0.0.1"), p), 64) }
            } catch (_: IOException) { /* порт занят другим приложением — следующий */ }
        }
        return ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"))
    }

    private class Req(val method: String, val path: String, val query: Map<String, String>,
                      val headers: Map<String, String>, val body: ByteArray)

    private fun serve(s: Socket) {
        s.use {
            try {
                s.soTimeout = 60_000
                val input = BufferedInputStream(s.getInputStream())
                val out = s.getOutputStream()
                val req = readRequest(input) ?: return
                when (req.path) {
                    "/__relay" -> if (req.headers["x-relay-key"] == relayKey) relay(req, out) else send(out, 403, "forbidden".toByteArray(), "text/plain")
                    "/stream" -> stream(req, out)
                    "/social/google/start" -> googleStart(out)
                    "/social/google/config" -> send(out, 200, googleConfig.toByteArray(), JSON_TYPE)
                    "/social/google/result" -> googleResult(req, out)
                    "/social/google/wait" -> googleWait(req, out)
                    else -> static(req, out)
                }
                out.flush()
            } catch (_: IOException) { /* клиент закрыл соединение */ }
            catch (e: Exception) { Log.e(TAG, "serve", e) }
        }
    }

    private fun readRequest(input: InputStream): Req? {
        val head = ByteArrayOutputStream()
        var last4 = 0
        while (true) {
            val b = input.read()
            if (b < 0) return null
            head.write(b)
            last4 = (last4 shl 8) or b
            if (last4 == 0x0D0A0D0A) break
            if (head.size() > 256 * 1024) return null
        }
        val lines = head.toString("UTF-8").split("\r\n")
        val parts = lines[0].split(" ")
        if (parts.size < 2) return null
        val headers = HashMap<String, String>()
        for (line in lines.drop(1)) {
            val i = line.indexOf(':')
            if (i > 0) headers[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
        }
        val len = headers["content-length"]?.toIntOrNull() ?: 0
        val body = ByteArray(len)
        var off = 0
        while (off < len) {
            val n = input.read(body, off, len - off)
            if (n < 0) break
            off += n
        }
        val target = parts[1]
        val q = target.indexOf('?')
        val path = URLDecoder.decode(if (q >= 0) target.substring(0, q) else target, "UTF-8")
        val query = HashMap<String, String>()
        if (q >= 0) for (pair in target.substring(q + 1).split('&')) {
            if (pair.isEmpty()) continue
            val e = pair.indexOf('=')
            val k = if (e >= 0) pair.substring(0, e) else pair
            val v = if (e >= 0) pair.substring(e + 1) else ""
            query[URLDecoder.decode(k, "UTF-8")] = URLDecoder.decode(v, "UTF-8")
        }
        return Req(parts[0], path, query, headers, body)
    }

    private fun writeHead(out: OutputStream, status: Int, headers: List<Pair<String, String>>) {
        val sb = StringBuilder("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n")
        for ((k, v) in headers) sb.append(k).append(": ").append(v.replace("\r", "").replace("\n", "")).append("\r\n")
        sb.append("Connection: close\r\n\r\n")
        out.write(sb.toString().toByteArray(Charsets.UTF_8))
    }

    private fun send(out: OutputStream, status: Int, body: ByteArray, type: String, extra: List<Pair<String, String>> = emptyList()) {
        writeHead(out, status, listOf("Content-Type" to type, "Content-Length" to body.size.toString(), "Cache-Control" to "no-store") + extra)
        out.write(body)
    }

    // ---------- /__relay ----------
    // Заголовок X-Relay — base64(JSON { url, method, headers, follow }), тело запроса — как есть.
    // Ответ: статус 200, тело ответа как есть, настоящие статус/адрес/заголовки — в X-Relay-*;
    // сетевая ошибка — 599 с { error, code } (shim.js превращает в TypeError, как fetch)
    private fun relay(req: Req, out: OutputStream) {
        val meta = JSONObject(String(Base64.decode(req.headers["x-relay"] ?: "", Base64.DEFAULT), Charsets.UTF_8))
        val method = meta.optString("method", "GET").uppercase()
        val hdrs = Headers.Builder()
        meta.optJSONObject("headers")?.let { h -> for (k in h.keys()) hdrs.add(k, h.getString(k)) }
        val hasBody = method != "GET" && method != "HEAD"
        val type = hdrs["Content-Type"]?.toMediaTypeOrNull()
        val rb = Request.Builder().url(meta.getString("url")).headers(hdrs.build())
            .method(method, if (hasBody) req.body.toRequestBody(type) else null)
            .build()
        val client = if (meta.optBoolean("follow", true)) http else noRedirects
        try {
            client.newCall(rb).execute().use { r ->
                val list = JSONArray()
                for ((k, v) in r.headers) list.put(JSONArray().put(k.lowercase()).put(v))
                val body = r.body.bytes()
                val b64 = Base64.encodeToString(list.toString().toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
                send(out, 200, body, "application/octet-stream", listOf(
                    "X-Relay-Status" to r.code.toString(),
                    "X-Relay-Url" to r.request.url.toString(),
                    "X-Relay-Headers" to b64,
                ))
            }
        } catch (e: IOException) {
            val code = when (e) {
                is UnknownHostException -> "ENOTFOUND"
                is SocketTimeoutException -> "UND_ERR_CONNECT_TIMEOUT"
                is java.net.ConnectException -> "ECONNREFUSED"
                else -> e.javaClass.simpleName
            }
            val err = JSONObject().put("error", e.message ?: code).put("code", code)
            send(out, 599, err.toString().toByteArray(), "application/json; charset=utf-8")
        }
    }

    // ---------- /stream ----------
    private fun streamUrl(u: String, referer: String, ua: String, cookie: String): String {
        val sb = StringBuilder("/stream?url=").append(enc(u))
        if (referer.isNotEmpty()) sb.append("&referer=").append(enc(referer))
        if (ua.isNotEmpty()) sb.append("&ua=").append(enc(ua))
        if (cookie.isNotEmpty()) sb.append("&cookie=").append(enc(cookie))
        return sb.toString()
    }

    private val uriAttr = Regex("URI=\"([^\"]+)\"")

    private fun rewritePlaylist(text: String, base: String, referer: String, ua: String, cookie: String): String {
        val baseUrl = base.toHttpUrlOrNull()
        fun abs(u: String) = baseUrl?.resolve(u)?.toString() ?: u
        return text.split(Regex("\r?\n")).joinToString("\n") { line ->
            val t = line.trim()
            when {
                t.isEmpty() -> line
                t.startsWith("#") -> uriAttr.replace(line) { m -> "URI=\"${streamUrl(abs(m.groupValues[1]), referer, ua, cookie)}\"" }
                else -> streamUrl(abs(t), referer, ua, cookie)
            }
        }
    }

    private fun stream(req: Req, out: OutputStream) {
        val target = req.query["url"]
        if (target.isNullOrEmpty()) return send(out, 400, "url required".toByteArray(), "text/plain")
        val referer = req.query["referer"] ?: ""
        val ua = req.query["ua"] ?: ""
        val cookie = req.query["cookie"] ?: ""
        val b = Request.Builder().url(target).header("User-Agent", ua.ifEmpty { PLAYER_UA })
            .header("Accept-Encoding", "identity")
        if (referer.isNotEmpty()) b.header("Referer", referer)
        if (cookie.isNotEmpty()) b.header("Cookie", cookie)
        req.headers["range"]?.let { b.header("Range", it) }
        val r = try { http.newCall(b.build()).execute() } catch (e: IOException) {
            return send(out, 502, (e.message ?: "upstream error").toByteArray(), "text/plain")
        }
        r.use {
            val ctype = r.header("Content-Type") ?: ""
            val finalUrl = r.request.url
            val pathAndQuery = finalUrl.encodedPath + (finalUrl.encodedQuery?.let { "?$it" } ?: "")
            // Kodik отдаёт «…:hls:manifest.m3u8» с Content-Type video/MP2T, поэтому смотрим и на путь
            if (Regex("mpegurl", RegexOption.IGNORE_CASE).containsMatchIn(ctype) ||
                Regex("\\.m3u8(\\?|$)", RegexOption.IGNORE_CASE).containsMatchIn(pathAndQuery)) {
                val text = r.body.string()
                if (text.startsWith("#EXTM3U")) {
                    val body = rewritePlaylist(text, finalUrl.toString(), referer, ua, cookie).toByteArray()
                    return send(out, r.code, body, "application/vnd.apple.mpegurl", listOf("Access-Control-Allow-Origin" to "*"))
                }
                return send(out, r.code, text.toByteArray(), ctype.ifEmpty { "text/plain" })
            }
            val hs = ArrayList<Pair<String, String>>()
            hs.add("Access-Control-Allow-Origin" to "*")
            for (h in listOf("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag")) {
                r.header(h)?.let { hs.add(h to it) }
            }
            writeHead(out, r.code, hs)
            r.body.byteStream().copyTo(out, 64 * 1024)
        }
    }

    // ---------- вход через Google в системном браузере ----------
    private class GoogleLogin(val created: Long) { @Volatile var result: JSONObject? = null; val lock = Object() }
    private val googleLogins = java.util.concurrent.ConcurrentHashMap<String, GoogleLogin>()

    private fun googleStart(out: OutputStream) {
        val now = System.currentTimeMillis()
        googleLogins.entries.removeIf { now - it.value.created > 10 * 60_000 }
        val bytes = ByteArray(18).also { java.security.SecureRandom().nextBytes(it) }
        val n = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        googleLogins[n] = GoogleLogin(now)
        // localhost, а не 127.0.0.1: в разрешённых доменах Firebase-проекта есть только localhost
        val body = JSONObject().put("n", n).put("url", "http://localhost:$port/google-auth.html?n=$n")
        send(out, 200, body.toString().toByteArray(), JSON_TYPE)
    }

    private fun googleResult(req: Req, out: OutputStream) {
        val j = try { JSONObject(String(req.body, Charsets.UTF_8)) } catch (_: Exception) { JSONObject() }
        val s = googleLogins[j.optString("n")]
        val token = j.optString("idToken")
        val ok = s != null && token.isNotEmpty()
        if (s != null && ok) synchronized(s.lock) {
            s.result = JSONObject().put("field", "googleIdToken").put("token", token).put("email", j.optString("email"))
            s.lock.notifyAll()
        }
        send(out, 200, JSONObject().put("ok", ok).toString().toByteArray(), JSON_TYPE)
    }

    // Ждёт результат до 25 с; { pending: true } — ещё не вошли (фронтенд повторяет запрос)
    private fun googleWait(req: Req, out: OutputStream) {
        val n = req.query["n"] ?: ""
        val s = googleLogins[n]
            ?: return send(out, 200, JSONObject().put("error", "Сеанс входа устарел, начните заново").toString().toByteArray(), JSON_TYPE)
        val r = synchronized(s.lock) {
            if (s.result == null) s.lock.wait(25_000)
            s.result
        }
        if (r != null) googleLogins.remove(n)
        send(out, 200, (r ?: JSONObject().put("pending", true)).toString().toByteArray(), JSON_TYPE)
    }

    // ---------- фронтенд ----------
    private fun static(req: Req, out: OutputStream) {
        var p = req.path
        if (p == "/" || !p.substringAfterLast('/').contains('.')) p = "/index.html" // SPA history fallback
        if (p.contains("..")) return send(out, 403, "forbidden".toByteArray(), "text/plain")
        val data = try { assets.open("www$p").use { it.readBytes() } } catch (_: FileNotFoundException) {
            return send(out, 404, "not found".toByteArray(), "text/plain")
        }
        val ext = p.substringAfterLast('.', "").lowercase()
        send(out, 200, data, MIME[ext] ?: "application/octet-stream")
    }

    companion object {
        private const val TAG = "AnixServer"
        private val PORTS = 38371..38380
        private const val JSON_TYPE = "application/json; charset=utf-8"
        // Встроенный плеер: тот же User-Agent, что у server/index.js (PLAYER_UA)
        private const val PLAYER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.45 Safari/537.36"
        private val MIME = mapOf(
            "html" to "text/html; charset=utf-8", "js" to "text/javascript; charset=utf-8", "mjs" to "text/javascript; charset=utf-8",
            "css" to "text/css; charset=utf-8", "json" to "application/json; charset=utf-8", "svg" to "image/svg+xml",
            "png" to "image/png", "jpg" to "image/jpeg", "webp" to "image/webp", "ico" to "image/x-icon",
            "woff2" to "font/woff2", "ttf" to "font/ttf", "otf" to "font/otf", "wasm" to "application/wasm",
        )
        private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
        private fun reason(code: Int) = when (code) {
            200 -> "OK"; 206 -> "Partial Content"; 301 -> "Moved Permanently"; 302 -> "Found"; 304 -> "Not Modified"
            400 -> "Bad Request"; 403 -> "Forbidden"; 404 -> "Not Found"; 416 -> "Range Not Satisfiable"
            502 -> "Bad Gateway"; else -> "Status"
        }
    }
}
