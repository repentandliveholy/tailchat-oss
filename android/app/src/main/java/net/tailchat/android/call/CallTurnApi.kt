package net.tailchat.android.call

import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import net.tailchat.android.cloud.CloudApi
import net.tailchat.android.cloud.CloudException
import okhttp3.OkHttpClient
import okhttp3.Request

/** One ICE server as WebRTC's `PeerConnection.IceServer` wants it — kept
 *  as a plain data class here so [WebRtcEngine] is the only place that
 *  touches the `org.webrtc` type. */
data class IceServerConfig(val urls: List<String>, val username: String?, val credential: String?)

data class TurnConfig(val ttlSeconds: Int, val iceServers: List<IceServerConfig>)

/**
 * `GET /api/turn` (docs/specs/2026-09-15-android-calls-plan.md §3.3). Fetched
 * fresh before every call — the response says `ttl` for a reason, and
 * nothing here caches past one call's lifetime; [CallController] is the
 * caller and decides when "before every call" is.
 */
class CallTurnApi(
    private val client: OkHttpClient,
    private val json: Json = Json { ignoreUnknownKeys = true },
) {
    suspend fun fetch(server: String, token: String): TurnConfig = withContext(Dispatchers.IO) {
        val origin = CloudApi.normalizeServerUrl(server) ?: throw CloudException("invalid_server")
        val request = Request.Builder()
            .url("$origin/tailchat/api/turn")
            .header("Authorization", "Bearer $token")
            .get()
            .build()
        val response = try {
            client.newCall(request).execute()
        } catch (error: IOException) {
            throw CloudException("unreachable", cause = error)
        }
        response.use {
            val text = it.body?.string().orEmpty()
            val body = try {
                json.parseToJsonElement(text).jsonObject
            } catch (error: Exception) {
                throw CloudException("malformed_response", cause = error)
            }
            if (!it.isSuccessful) {
                val code = body["error"]?.jsonPrimitive?.contentOrNull ?: "server_error"
                throw CloudException(code, body["message"]?.jsonPrimitive?.contentOrNull)
            }
            val ttl = body["ttl"]?.jsonPrimitive?.int ?: throw CloudException("malformed_response")
            val servers = body["iceServers"]?.jsonArray?.mapNotNull { element ->
                runCatching {
                    val obj = element.jsonObject
                    val urls = obj["urls"]?.jsonArray?.mapNotNull { u -> u.jsonPrimitive.contentOrNull } ?: emptyList()
                    if (urls.isEmpty()) return@runCatching null
                    IceServerConfig(
                        urls = urls,
                        username = obj["username"]?.jsonPrimitive?.contentOrNull,
                        credential = obj["credential"]?.jsonPrimitive?.contentOrNull,
                    )
                }.getOrNull()
            }.orEmpty()
            TurnConfig(ttl, servers)
        }
    }
}
