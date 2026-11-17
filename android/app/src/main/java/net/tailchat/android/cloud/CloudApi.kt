package net.tailchat.android.cloud

import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.net.URI
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromStream
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class CloudApi(
    private val client: OkHttpClient,
    private val json: Json = Json { ignoreUnknownKeys = true },
    /**
     * The largest `/api/history` body [history] will read, in bytes — see
     * [HISTORY_MAX_BODY_BYTES]. A parameter rather than that constant read directly for the
     * same reason [json] is one: the size policy has to be provable in a unit test without
     * building a forty-megabyte fixture, and nothing in the app passes it.
     */
    private val historyMaxBodyBytes: Long = HISTORY_MAX_BODY_BYTES,
) {
    /** The shared client's 8 s call budget is shorter than the server's own worst case for a
     *  preview (five seconds per hop, up to three redirects), so [linkPreview] gets its own. */
    private val previewClient: OkHttpClient by lazy {
        client.newBuilder()
            .callTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
    }

    /**
     * [history]'s own client, for the same reason [AppUpdateApi.download] has one.
     *
     * A history page is not a small JSON answer: every inline photo and voice note in it
     * travels as a base64 `data:` URL inside the record (`src/cloud/limits.js` allows 10 MiB
     * of them per message and 64 MiB per conversation), so one page of two hundred messages
     * can be tens of megabytes. The shared client's `callTimeout(8s)` budgets the *whole*
     * call — headers plus body — and on a mobile link such a page cannot finish inside it:
     * the call is aborted halfway, every retry aborts at the same point, and the
     * conversation never fills in (the defect this client exists to fix).
     *
     * So the total budget goes away and the per-read one stays: a read that sees no bytes
     * for [HISTORY_READ_TIMEOUT_SECONDS] still fails, while a slow but progressing download
     * is allowed to finish. Connect/write/websocket settings are inherited unchanged from
     * the shared client.
     */
    private val historyClient: OkHttpClient by lazy {
        client.newBuilder()
            .callTimeout(0, TimeUnit.SECONDS)
            .readTimeout(HISTORY_READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .build()
    }

    suspend fun register(server: String, login: String, password: String, name: String): CloudAuthResult =
        authenticate(server, "/register", buildJsonObject {
            put("login", login)
            put("password", password)
            put("name", name)
            put("pubKey", JsonNull)
        })

    /**
     * Signs in.
     *
     * [extraPassword] is the account's additional password, for the accounts
     * that have one (`accounts.js`'s `signIn`): the server proves the primary
     * password first and only then answers `extra_password_required`, so the
     * app can ask for the second field without either knowing in advance
     * whether it is needed or being told anything about an account whose
     * primary password was wrong.
     *
     * Omitted (not empty) when the caller has none to offer: an empty string is
     * a *wrong* additional password to a protected account, and a client that
     * sent it blindly would turn "we have not asked yet" into a failed attempt.
     */
    suspend fun login(
        server: String,
        login: String,
        password: String,
        extraPassword: String? = null,
    ): CloudAuthResult =
        authenticate(server, "/login", buildJsonObject {
            put("login", login)
            put("password", password)
            put("pubKey", JsonNull)
            if (!extraPassword.isNullOrEmpty()) put("extraPassword", extraPassword)
        })

    data class HistoryPage(
        val messages: List<CloudMessage>,
        val peerReadTs: Long,
        /** When the peer reached [peerReadTs] and which client did it, from the
         *  same answer (`peerReadAt`/`peerReadVia`). `0`/`''` on an older
         *  server, which the menu must render as unknown rather than guessed. */
        val peerReadAt: Long = 0L,
        val peerReadVia: String = "",
        /** How far the peer's *device* holds this conversation, the rung below
         *  [peerReadTs] — the server's `peerDeliveredTs`. `0` when unknown,
         *  which is every snapshot from a server or client that predates the
         *  delivered watermark; a `0` must never be read as "nothing
         *  delivered", only as "not known here", because the read watermark
         *  above it already implies delivery for everything it covers. */
        val peerDeliveredTs: Long = 0L,
    )

    /**
     * One page of the shared history with [peer], newest first.
     *
     * [before] and [beforeId] are how a caller walks further back: the server
     * returns the rows strictly older than that one (`src/cloud/server.js`'s
     * `/history`), with `beforeId` deciding the boundary when several messages
     * share a timestamp — which a burst of messages queued offline routinely
     * produces, and which a timestamp-only cursor would either repeat forever
     * or skip across. Both are absent for the newest page.
     *
     * [limit] is bounded by the deployment (`HISTORY_MAX_LIMIT`); the caller is
     * the one that knows whether it wants one page or a walk, and a caller that
     * needs a specific older message must keep asking rather than raise this
     * number — the page it needs may be a hundred pages back.
     *
     * Runs on [historyClient], so the shared eight-second budget does not apply, and the
     * body is parsed straight from the socket, up to [HISTORY_MAX_BODY_BYTES] only. A page
     * over that bound — or one the heap cannot hold — fails with `too_large`; a body that
     * stops mid-transfer fails with `transfer_failed`. The caller answers both by asking
     * again for the same position with a smaller page.
     *
     * Cancellable for real: cancelling the calling coroutine cancels the HTTP call itself
     * ([Call.cancel]), so a reconnect, a logout or a superseded walk does not leave a
     * tens-of-megabytes download running behind it. The caller still sees the
     * [kotlinx.coroutines.CancellationException], never a network error code.
     */
    suspend fun history(
        session: CloudSession,
        peer: String,
        limit: Int = HISTORY_PAGE_DEFAULT,
        before: Long? = null,
        beforeId: String? = null,
    ): HistoryPage {
        val origin = normalizeServerUrl(session.server) ?: throw CloudException("invalid_server")
        val builder = "$origin/tailchat/api/history".toHttpUrl().newBuilder()
            .addQueryParameter("peer", peer)
            .addQueryParameter("deleted", "1")
            .addQueryParameter("limit", limit.coerceAtLeast(1).toString())
        if (before != null && before > 0L) builder.addQueryParameter("before", before.toString())
        if (!beforeId.isNullOrEmpty()) builder.addQueryParameter("beforeId", beforeId)
        val request = Request.Builder()
            .url(builder.build())
            .header("Authorization", "Bearer ${session.token}")
            .get()
            .build()
        val call = historyClient.newCall(request)
        return coroutineScope {
            // `execute()` and the body read block a thread and know nothing about coroutines:
            // `withContext(IO) { execute() }` alone keeps downloading after its caller is gone.
            // So the blocking half runs as a child, and whoever stops waiting for it — this
            // coroutine cancelled, or the child itself failing — cancels the call, which closes
            // the socket under the read and lets the child finish at once.
            val fetch = async(Dispatchers.IO) {
                try {
                    readHistory(call, peer, session.user.login)
                } catch (error: CloudException) {
                    // If this coroutine was cancelled, the socket closed because *we*
                    // cancelled the call: that is the cancellation arriving, not a
                    // transfer failure. Reported as one, it would become the scope's root
                    // cause and reach the caller in place of its `CancellationException`.
                    // (The call is also cancelled on purpose for a page refused by size —
                    // that one is a real `too_large`, and this coroutine is still active.)
                    ensureActive()
                    throw error
                }
            }
            try {
                fetch.await()
            } catch (error: Throwable) {
                call.cancel()
                throw error
            }
        }
    }

    /** The blocking half of [history]: the call, the bounded parse, the mapping. An
     *  `OutOfMemoryError` anywhere in it is the page not fitting this heap — the same
     *  answer as a page over the bound, so the caller asks for less instead of the process
     *  dying. Nothing here keeps a reference to the page once it fails, so the memory the
     *  failed attempt held is garbage by the time the caller retries. */
    private fun readHistory(call: Call, peer: String, self: String): HistoryPage = try {
        executeHistory(call).toHistoryPage(peer, self)
    } catch (_: OutOfMemoryError) {
        throw CloudException("too_large")
    }

    /**
     * [execute] for `/api/history`, with the body bounded and streamed.
     *
     * A page the server announces as longer than [historyMaxBodyBytes] (`Content-Length`,
     * which the deployment always sends for `/history`) is `too_large` on its headers: not
     * one byte of the body is read, and the call is cancelled so OkHttp does not drain the
     * rest to reuse the connection either. Each step down a halving ladder costs a header,
     * not forty megabytes.
     *
     * A body of unannounced length is parsed directly from the response stream, which
     * refuses to read past the bound: the page is held once — as the parsed tree, whose
     * strings the mapped [CloudMessage]s then share — instead of as a body string, a copy of
     * it and then the tree, and an oversized one is `too_large` after the bound's worth of
     * bytes, not after the whole of it. A body that dies halfway (connection reset, read
     * timeout, socket closed by [Call.cancel]) is `transfer_failed` rather than
     * `unreachable`: the headers arrived, the page exists, it just did not make it through
     * this link this time.
     */
    @OptIn(ExperimentalSerializationApi::class)
    private fun executeHistory(call: Call): JsonObject {
        val response = try {
            call.execute()
        } catch (error: IOException) {
            throw CloudException("unreachable", cause = error)
        }
        response.use {
            val payload = it.body!!
            if (payload.contentLength() > historyMaxBodyBytes) {
                call.cancel()
                throw CloudException("too_large")
            }
            val body = try {
                BoundedInputStream(payload.byteStream(), historyMaxBodyBytes).use { stream ->
                    json.decodeFromStream(JsonElement.serializer(), stream).jsonObject
                }
            } catch (_: BodyTooLarge) {
                call.cancel()
                throw CloudException("too_large")
            } catch (error: IOException) {
                throw CloudException("transfer_failed", cause = error)
            } catch (error: Exception) {
                throw CloudException("malformed_response", cause = error)
            }
            if (!it.isSuccessful) {
                val code = body["error"]?.jsonPrimitive?.contentOrNull ?: "server_error"
                val message = body["message"]?.jsonPrimitive?.contentOrNull
                throw CloudException(code, message)
            }
            return body
        }
    }

    private fun JsonObject.toHistoryPage(peer: String, self: String): HistoryPage {
        val body = this
        val peerReadTs = body["peerReadTs"]?.jsonPrimitive?.longOrNull ?: 0L
        val peerReadAt = body["peerReadAt"]?.jsonPrimitive?.longOrNull ?: 0L
        val peerReadVia = body["peerReadVia"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val peerDeliveredTs = body["peerDeliveredTs"]?.jsonPrimitive?.longOrNull ?: 0L
        val messages = body["messages"]?.jsonArray?.mapNotNull { element ->
            // `Exception`, not `runCatching`'s `Throwable`: a record of the wrong shape is
            // skipped, but an `OutOfMemoryError` must reach [readHistory] and become
            // `too_large` rather than silently drop the message it struck.
            try {
                val item = element.jsonObject
                val id = item["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                val from = item["from"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                val text = item["text"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                val ts = item["ts"]?.jsonPrimitive?.longOrNull ?: return@mapNotNull null
                val author = item["author"]?.jsonPrimitive?.contentOrNull ?: from
                // A history record `tailik` answered for the account owner carries
                // `kind:"ai"` and `from` equal to the owner's own login (see
                // `accounts.js`'s `record.kind`/`record.author`) — without this,
                // the owner's own device read its own login back and rendered the
                // bot's reply as something it had sent itself, the same
                // `kind`-blind bug `SyncEngine`'s live path had.
                val kind = item["kind"]?.jsonPrimitive?.contentOrNull
                // An encrypted edit's carrier (the stub of an older server, or a
                // tombstone of a newer one): held as a tombstone so the id stops
                // being owed to the backfill, never drawn.
                val carrier = item["sealedEdit"]?.jsonPrimitive?.booleanOrNull == true
                if (carrier) return@mapNotNull CloudMessage(
                    id = id, peer = peer, text = "", ts = ts, author = author, mine = kind != "ai" && from == self,
                    delivery = CloudDelivery.Accepted,
                    deletedAt = item["deletedAt"]?.jsonPrimitive?.longOrNull ?: ts,
                )
                CloudMessage(
                    id = id,
                    peer = peer,
                    text = text,
                    ts = ts,
                    author = author,
                    mine = kind != "ai" && from == self,
                    // A message the server persisted was, by definition, accepted:
                    // the queued/`⧗` state is only ever meaningful for this device's
                    // own not-yet-committed sends. The record carries no ack/read
                    // field, so nothing stronger than Accepted can be claimed from
                    // history alone — Delivered and Read arrive as receipts.
                    delivery = CloudDelivery.Accepted,
                    image = item["image"]?.jsonObject?.toCloudImage(),
                    voice = item["voice"]?.jsonObject?.toCloudVoice(),
                    // Reactions and the reply snapshot are part of the record for every
                    // client, not just the browser (`history()` copies both,
                    // `src/cloud/accounts.js:1181`), so a thread reopened on a phone shows
                    // the same badges and quotes it had before.
                    reactions = item["reactions"]?.jsonObject?.toReactions().orEmpty(),
                    replyTo = item["replyTo"]?.jsonObject?.toCloudReply(),
                    editedAt = item["editedAt"]?.jsonPrimitive?.longOrNull,
                    deletedAt = item["deletedAt"]?.jsonPrimitive?.longOrNull,
                    buttons = item["buttons"]?.jsonArray?.toCloudButtons().orEmpty(),
                )
            } catch (_: Exception) {
                null
            }
        }.orEmpty()
        return HistoryPage(
            messages = messages,
            peerReadTs = peerReadTs,
            peerReadAt = peerReadAt,
            peerReadVia = peerReadVia,
            peerDeliveredTs = peerDeliveredTs,
        )
    }

    /** Returns a one-time 64-hex-character code a friend can redeem once.
     *
     *  [login] mints the code *for that account* instead of this one — whoever
     *  redeems it becomes their friend, not the caller's — which the server
     *  allows only to the deployment owner (403 `forbidden`, 404
     *  `unknown_user`). Omitted, the request body is byte-for-byte what it
     *  always was. */
    suspend fun createInvite(session: CloudSession, login: String? = null): String = withContext(Dispatchers.IO) {
        val origin = normalizeServerUrl(session.server) ?: throw CloudException("invalid_server")
        val payload = if (login == null) "{}" else buildJsonObject { put("login", login) }.toString()
        val request = Request.Builder()
            .url("$origin/tailchat/api/invite")
            .header("Authorization", "Bearer ${session.token}")
            .post(payload.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        val body = execute(request)
        body["invite"]?.jsonPrimitive?.contentOrNull ?: throw CloudException("malformed_response")
    }

    /** Redeems a code created by [createInvite], returning the new friend. */
    suspend fun acceptInvite(session: CloudSession, invite: String): CloudUser = withContext(Dispatchers.IO) {
        val origin = normalizeServerUrl(session.server) ?: throw CloudException("invalid_server")
        val request = Request.Builder()
            .url("$origin/tailchat/api/invite/accept")
            .header("Authorization", "Bearer ${session.token}")
            .post(buildJsonObject { put("invite", invite) }.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()
        val body = execute(request)
        body["friend"]?.jsonObject?.toUser() ?: throw CloudException("malformed_response")
    }

    /** The two ways a friend request can succeed — the same distinction the
     *  server draws with `state`, kept as a type so the caller cannot show
     *  "waiting for an answer" about someone who is already a contact. */
    sealed interface FriendRequest {
        /** Handed to `{tailchat}`, which asks the other person; also the answer
         *  to a repeat of a request that is still pending, and — deliberately
         *  indistinguishable — to one the addressee has blocked. */
        data object Requested : FriendRequest

        /** No request was needed: either the two were already friends, or a
         *  request from the other side was waiting and closed the loop. The
         *  contact is on the roster now. */
        data class Friends(val friend: CloudUser) : FriendRequest
    }

    /** Asks [login] to become a contact. A leading `@` is the form people type
     *  and paste, and the server strips it itself, so it is passed through
     *  rather than rejected here. */
    suspend fun requestFriend(session: CloudSession, login: String): FriendRequest = withContext(Dispatchers.IO) {
        val origin = normalizeServerUrl(session.server) ?: throw CloudException("invalid_server")
        val request = Request.Builder()
            .url("$origin/tailchat/api/friend/request")
            .header("Authorization", "Bearer ${session.token}")
            .post(buildJsonObject { put("login", login) }.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()
        val body = execute(request)
        when (body["state"]?.jsonPrimitive?.contentOrNull) {
            "requested" -> FriendRequest.Requested
            "friends" -> FriendRequest.Friends(
                body["friend"]?.jsonObject?.toUser() ?: throw CloudException("malformed_response"),
            )
            else -> throw CloudException("malformed_response")
        }
    }

    /** Registers this device's FCM registration token with the account so the
     *  server can wake the app (`TailchatFirebaseMessagingService`) even when
     *  `ChatService`'s socket is not running. */
    suspend fun registerFcmToken(session: CloudSession, token: String): Unit = withContext(Dispatchers.IO) {
        val origin = normalizeServerUrl(session.server) ?: throw CloudException("invalid_server")
        val request = Request.Builder()
            .url("$origin/tailchat/api/fcm/register")
            .header("Authorization", "Bearer ${session.token}")
            .post(
                buildJsonObject {
                    put("token", token)
                    put("scope", accountScopeOf(session))
                }.toString().toRequestBody(JSON_MEDIA_TYPE),
            )
            .build()
        execute(request)
        Unit
    }

    /** The counterpart to [registerFcmToken] — called on logout so a signed-out
     *  device stops receiving wake pushes for an account it no longer holds. */
    suspend fun unregisterFcmToken(session: CloudSession, token: String): Unit = withContext(Dispatchers.IO) {
        val origin = normalizeServerUrl(session.server) ?: throw CloudException("invalid_server")
        val request = Request.Builder()
            .url("$origin/tailchat/api/fcm/unregister")
            .header("Authorization", "Bearer ${session.token}")
            .post(buildJsonObject { put("token", token) }.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()
        execute(request)
        Unit
    }

    /** Blocks [login]: the server rejects live frames (msg/ai/typing/focus/
     *  read/edit/del/react) between the two accounts, either direction, until
     *  [unblock] undoes it. Requires an existing friendship — `not_friends`
     *  otherwise; history and the friendship are both untouched. */
    suspend fun block(session: CloudSession, login: String): Unit = withContext(Dispatchers.IO) {
        val origin = normalizeServerUrl(session.server) ?: throw CloudException("invalid_server")
        val request = Request.Builder()
            .url("$origin/tailchat/api/block")
            .header("Authorization", "Bearer ${session.token}")
            .post(buildJsonObject { put("login", login) }.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()
        execute(request)
        Unit
    }

    /** Undoes [block]. Idempotent server-side: unblocking a [login] never
     *  blocked still returns success. */
    suspend fun unblock(session: CloudSession, login: String): Unit = withContext(Dispatchers.IO) {
        val origin = normalizeServerUrl(session.server) ?: throw CloudException("invalid_server")
        val request = Request.Builder()
            .url("$origin/tailchat/api/unblock")
            .header("Authorization", "Bearer ${session.token}")
            .post(buildJsonObject { put("login", login) }.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()
        execute(request)
        Unit
    }

    /** This account's own nickname for [login] (issue #28) — private to the
     *  caller, never sent to the peer. [name] is free text: the server cleans
     *  it (NFKC, controls and bidi overrides removed, whitespace collapsed,
     *  trimmed, capped at 32 code points) and stores what survives, so this
     *  sends exactly what the user typed (trimmed) — a client-side transform
     *  would make a nickname look different from what the owner saw. An empty
     *  [name] clears the nickname. Returns the stored `alias` (empty when
     *  cleared). A value the server refuses (`invalid_alias`) throws. */
    suspend fun setAlias(session: CloudSession, login: String, name: String): String = withContext(Dispatchers.IO) {
        val origin = normalizeServerUrl(session.server) ?: throw CloudException("invalid_server")
        val request = Request.Builder()
            .url("$origin/tailchat/api/alias")
            .header("Authorization", "Bearer ${session.token}")
            .post(buildJsonObject { put("login", login); put("name", name) }.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()
        val body = execute(request)
        body["alias"]?.jsonPrimitive?.contentOrNull.orEmpty()
    }

    /** Deletes [login] together with this account's own side of the
     *  conversation: the roster loses the contact on every device of this
     *  account and new frames between the two are refused with
     *  `peer_not_found`. One-sided — the other person keeps both the contact
     *  and their copy of the history, and is never told. Idempotent:
     *  removing an already-removed contact answers 200. The deployment's own
     *  accounts (`tailchat`, `tailik`) answer 403 `official_contact`, which
     *  is why clients never offer the action on them in the first place. */
    suspend fun removeContact(session: CloudSession, login: String): Unit = withContext(Dispatchers.IO) {
        val origin = normalizeServerUrl(session.server) ?: throw CloudException("invalid_server")
        val request = Request.Builder()
            .url("$origin/tailchat/api/contact/remove")
            .header("Authorization", "Bearer ${session.token}")
            .post(buildJsonObject { put("login", login) }.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()
        execute(request)
        Unit
    }

    /**
     * What the server could read from [url]'s page — `GET /api/link-preview?url=`. Any
     * authenticated account may ask (`handleLinkPreview` in `src/cloud/server.js`): the link
     * itself carries no relationship to check, and what keeps the route safe is the server's
     * own address guard (`fetchLinkPreview` refuses anything but the public web), not who asks.
     *
     * `null` when there is nothing worth a card: the server answered `{"preview":null}` (not a
     * page, refused, unreachable), or a preview with no title — web draws no card without one,
     * and a picture on its own does not make one. A refusal (`unknown_token`, `bad_request`) or
     * an unreachable server throws [CloudException].
     */
    suspend fun linkPreview(session: CloudSession, url: String): LinkPreviewMeta? = withContext(Dispatchers.IO) {
        val origin = normalizeServerUrl(session.server) ?: throw CloudException("invalid_server")
        val request = Request.Builder()
            .url("$origin/tailchat/api/link-preview".toHttpUrl().newBuilder().addQueryParameter("url", url).build())
            .header("Authorization", "Bearer ${session.token}")
            .get()
            .build()
        val body = execute(request, previewClient)
        // A malformed `preview` is the same answer as none: there is nothing to draw.
        runCatching { (body["preview"] as? JsonObject)?.toLinkPreviewMeta() }.getOrNull()
    }

    private suspend fun authenticate(server: String, path: String, payload: JsonObject): CloudAuthResult =
        withContext(Dispatchers.IO) {
            val origin = normalizeServerUrl(server) ?: throw CloudException("invalid_server")
            val request = Request.Builder()
                .url("$origin/tailchat/api$path")
                .post(payload.toString().toRequestBody(JSON_MEDIA_TYPE))
                .build()
            val body = execute(request)
            val token = body["token"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank)
                ?: throw CloudException("malformed_response")
            val userObject = body["user"]?.jsonObject ?: throw CloudException("malformed_response")
            val user = userObject.toUser() ?: throw CloudException("malformed_response")
            val recoveryKey = body["recoveryKey"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank)
            CloudAuthResult(CloudSession(origin, token, user), recoveryKey)
        }

    private fun execute(request: Request, via: OkHttpClient = client): JsonObject {
        val response = try {
            via.newCall(request).execute()
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
                val message = body["message"]?.jsonPrimitive?.contentOrNull
                throw CloudException(code, message)
            }
            return body
        }
    }

    /** The signal [BoundedInputStream] raises past its bound — an [IOException] so it
     *  travels through the JSON reader unchanged, a type of its own so [executeHistory]
     *  can tell "too big" from "cut off". */
    private class BodyTooLarge : IOException("history body over the bound")

    /** Fails the read that would take the total past [maxBytes]; nothing past the bound is
     *  ever pulled off the socket by this client. */
    private class BoundedInputStream(source: InputStream, private val maxBytes: Long) : FilterInputStream(source) {
        private var consumed = 0L

        override fun read(): Int {
            val value = super.read()
            if (value >= 0) count(1)
            return value
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (length == 0) return 0
            // Never ask for more than one byte past the bound: the read that crosses it is
            // then as small as it can be, and the body behind it stays on the wire.
            val room = minOf(length.toLong(), maxBytes - consumed + 1).coerceAtLeast(1L).toInt()
            val read = super.read(buffer, offset, room)
            if (read > 0) count(read.toLong())
            return read
        }

        override fun skip(n: Long): Long = super.skip(n).also { if (it > 0) count(it) }

        private fun count(read: Long) {
            consumed += read
            if (consumed > maxBytes) throw BodyTooLarge()
        }
    }

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        /** How long [history] waits for the next bytes of a page before giving up on it — a
         *  stalled link, not a slow one. See [historyClient] for why the whole call has no
         *  budget of its own. */
        private const val HISTORY_READ_TIMEOUT_SECONDS = 30L

        /** The largest `/api/history` body this client reads, in bytes: `MAX_INBOUND` in the
         *  Rust core (`4 × (10 MiB + 1024)`, `crates/tailchat-core/src/frames.rs`, measured
         *  on the UTF-8 body like this), the same bound the socket's frames use, because a
         *  page is the same kind of payload — inline media, several messages' worth of it,
         *  inside one JSON string. A page over it is refused as `too_large` and asked for
         *  again in smaller pages. */
        const val HISTORY_MAX_BODY_BYTES = 4L * (CLOUD_MEDIA_MAX_CHARS + 1024)

        /**
         * How many messages [history] asks for by default — the deployment's own
         * `HISTORY_DEFAULT_LIMIT`, named rather than assumed. A caller that walks back
         * through pages decides "there is nothing older" from a page shorter than the
         * `limit` *it asked for* — this number, until a page too large to transfer made the
         * walk ask for fewer — so both ends have to agree on it rather than trust whatever a
         * server happens to default to.
         */
        const val HISTORY_PAGE_DEFAULT = 200

        /** The server's answer when a protected account's primary password was
         *  correct but its additional one was not offered (`handleLogin` in
         *  `src/cloud/server.js`). The one rejection that is a request for more
         *  information rather than a refusal, which is why the sign-in screen
         *  reacts to it by revealing a field instead of only reporting it. */
        const val EXTRA_PASSWORD_REQUIRED = "extra_password_required"

        fun normalizeServerUrl(value: String): String? {
            val raw = value.trim()
            if (raw.isEmpty()) return null
            val withScheme = if (SCHEME.containsMatchIn(raw)) raw else "https://$raw"
            val uri = try { URI(withScheme) } catch (_: Exception) { return null }
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") return null
            if (uri.host == null || uri.userInfo != null || uri.query != null || uri.fragment != null) return null
            val path = uri.path.orEmpty().trimEnd('/')
            if (path.isNotEmpty() && path != "/tailchat" && path != "/cloud") return null
            return URI(scheme, null, uri.host, uri.port, null, null, null).toString()
        }

        /** The shareable form of an invite: the very same URL the web client
         *  prints (`web/cloud/app.js`: `${location.origin}/tailchat/?invite=…`),
         *  so it can be pasted whole into "Add a friend" on any client — each of
         *  them pulls the code back out of it. The raw code is never what a
         *  person is meant to pass on, and only this string carries the server
         *  it was minted on.
         *
         *  Null when [server] is not a supported address, in which case callers
         *  fall back to the bare [code]. */
        fun inviteUrl(server: String, code: String): String? =
            normalizeServerUrl(server)?.let { "$it/tailchat/?invite=$code" }

        fun socketUrl(server: String): String {
            val origin = normalizeServerUrl(server) ?: throw CloudException("invalid_server")
            val scheme = if (origin.startsWith("https://")) "wss://" else "ws://"
            return scheme + origin.substringAfter("://") + "/tailchat/ws"
        }

        private fun JsonObject.toUser(): CloudUser? {
            val login = this["login"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank) ?: return null
            val name = this["name"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank) ?: login
            return CloudUser(
                login = login,
                name = name,
                alias = this["alias"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank),
            )
        }

        private fun JsonObject.toCloudImage(): CloudImage? {
            val dataUrl = this["dataUrl"]?.jsonPrimitive?.contentOrNull ?: return null
            val width = this["width"]?.jsonPrimitive?.pixelsOrNull() ?: return null
            val height = this["height"]?.jsonPrimitive?.pixelsOrNull() ?: return null
            return CloudImage(dataUrl, width, height)
        }

        /** Fields the card shows, bounded to what the server itself promises (`MAX_TITLE_CHARS`,
         *  `MAX_DESCRIPTION_CHARS` in `link-preview.js`); no `title`, no preview. */
        private fun JsonObject.toLinkPreviewMeta(): LinkPreviewMeta? {
            fun text(key: String, max: Int): String? =
                this[key]?.jsonPrimitive?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)?.take(max)
            val title = text("title", 200) ?: return null
            val url = text("url", 2048)?.takeIf {
                it.startsWith("http://", ignoreCase = true) || it.startsWith("https://", ignoreCase = true)
            } ?: return null
            return LinkPreviewMeta(url, title, text("description", 400), text("image", 2048), text("siteName", 80))
        }

        /** The duration through the shared reader ([voiceSecondsOrNull]): a fractional or
         *  zero one is a voice note, not a missing payload. */
        private fun JsonObject.toCloudVoice(): CloudVoice? {
            val dataUrl = this["dataUrl"]?.jsonPrimitive?.contentOrNull ?: return null
            val duration = this["duration"]?.jsonPrimitive?.voiceSecondsOrNull() ?: return null
            return CloudVoice(dataUrl, duration)
        }

        /** `{ "👍": ["ann", "bob"] }` — emoji to the logins that pressed it. */
        private fun JsonObject.toReactions(): Map<String, List<String>> = entries.mapNotNull { (emoji, members) ->
            val logins = runCatching {
                members.jsonArray.mapNotNull { it.jsonPrimitive.contentOrNull }
            }.getOrNull()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            emoji to logins
        }.toMap()

        private fun JsonObject.toCloudReply(): CloudReply? {
            val id = this["id"]?.jsonPrimitive?.contentOrNull ?: return null
            val from = this["from"]?.jsonPrimitive?.contentOrNull ?: return null
            return CloudReply(
                id = id,
                from = from,
                text = this["text"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                media = this["media"]?.jsonPrimitive?.contentOrNull,
            )
        }
        private fun JsonArray.toCloudButtons(): List<CloudBotAction> =
            take(8).mapNotNull { element ->
                val obj = runCatching { element.jsonObject }.getOrNull() ?: return@mapNotNull null
                val id = obj["id"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
                val label = obj["label"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
                val value = obj["value"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
                if (id.isEmpty() || id.length > 40 || label.isEmpty() || label.length > 40 ||
                    value.isEmpty() || value.length > 200
                ) return@mapNotNull null
                CloudBotAction(id, label, value)
            }


        private val SCHEME = Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE)
    }
}
