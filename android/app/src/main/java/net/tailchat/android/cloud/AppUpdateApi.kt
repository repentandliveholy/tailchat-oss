package net.tailchat.android.cloud

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import net.tailchat.android.Transfer
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * The Android counterpart of `bin/release-android.js`'s published pair,
 * `android-version.json` next to `tailchat.apk` — same-origin static files,
 * not a new API surface, so a self-hosted deployment updates itself the same
 * way. Shares [client] with [CloudApi], but not its timeouts: a version
 * check is a small JSON body like any other API call, while an APK download's
 * duration depends on the connection and the build's size, neither bounded in
 * advance — [CloudApi]'s 8s whole-call budget would abort a slow one midway.
 */
class AppUpdateApi(
    private val client: OkHttpClient,
    private val json: Json = Json { ignoreUnknownKeys = true },
) {
    suspend fun fetchLatest(server: String): AppUpdateInfo? = withContext(Dispatchers.IO) {
        val origin = CloudApi.normalizeServerUrl(server) ?: return@withContext null
        val request = Request.Builder().url("$origin/tailchat/android-version.json").get().build()
        val body = try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext null
                response.body?.string()
            }
        } catch (_: IOException) {
            return@withContext null
        } ?: return@withContext null
        runCatching {
            val obj = json.parseToJsonElement(body).jsonObject
            val versionCode = obj["versionCode"]?.jsonPrimitive?.longOrNull ?: return@runCatching null
            val versionName = obj["versionName"]?.jsonPrimitive?.contentOrNull ?: return@runCatching null
            val url = obj["url"]?.jsonPrimitive?.contentOrNull ?: "$origin/tailchat/tailchat.apk"
            val sha256 = obj["sha256"]?.jsonPrimitive?.contentOrNull?.trim()?.lowercase()?.takeIf { it.isNotBlank() }
            if (!sameOrigin(origin, url)) return@runCatching null
            AppUpdateInfo(versionCode, versionName, url, sha256)
        }.getOrNull()
    }

    /**
     * Streams [info]'s APK into `context.cacheDir/updates/`, reporting
     * [Transfer.Progress] as bytes land. The body is never held in memory —
     * it is copied straight to disk in bounded chunks, the same discipline
     * `net.tailchat.proto.FileTransfer` uses for the P2P relay — and a
     * failed/cancelled download leaves no partial file behind under the final
     * name, since the write lands under `.part` until it verifiably finished.
     *
     * [AppUpdateInfo.sha256], when the connected server publishes one, is
     * checked against the downloaded bytes before the `.part` file is ever
     * renamed into place — a mismatch throws and nothing reaches
     * [net.tailchat.android.installApk]. This is content integrity, not
     * authenticity: the platform's own signature check at install time is
     * still what actually stops a re-signed APK, this only stops a
     * truncated/corrupted/substituted download of an otherwise-trusted one.
     */
    suspend fun download(
        context: Context,
        info: AppUpdateInfo,
        onProgress: (Transfer) -> Unit,
    ): File = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        val dest = File(dir, "tailchat-update.apk")
        val temp = File(dir, "tailchat-update.apk.part")
        val downloadClient = client.newBuilder()
            .callTimeout(0, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
        val request = Request.Builder().url(info.url).get().build()
        val digest = if (info.sha256 != null) MessageDigest.getInstance("SHA-256") else null
        downloadClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("http_${response.code}")
            val body = response.body ?: throw IOException("empty_body")
            val total = body.contentLength()
            var done = 0L
            body.byteStream().use { input ->
                FileOutputStream(temp).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        digest?.update(buffer, 0, read)
                        done += read
                        onProgress(Transfer.Progress(done, if (total > 0L) total else done))
                    }
                }
            }
        }
        val expected = info.sha256
        if (expected != null) {
            val actual = digest!!.digest().joinToString("") { "%02x".format(it) }
            if (actual != expected) {
                temp.delete()
                throw IOException("checksum_mismatch")
            }
        }
        dest.delete()
        if (!temp.renameTo(dest)) {
            temp.copyTo(dest, overwrite = true)
            temp.delete()
        }
        dest
    }

    /** [url] must be an `http(s)` URL sharing [origin]'s scheme/host/port —
     *  the update JSON is same-origin static content, so an APK URL pointing
     *  anywhere else (or not parsing as a URL at all) is a wrong or tampered
     *  response, not a valid deployment choice. */
    private fun sameOrigin(origin: String, url: String): Boolean {
        val target = url.toHttpUrlOrNull() ?: return false
        val base = origin.toHttpUrlOrNull() ?: return false
        return target.scheme == base.scheme && target.host == base.host && target.port == base.port
    }
}
