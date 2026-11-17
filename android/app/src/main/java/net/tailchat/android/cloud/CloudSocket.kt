package net.tailchat.android.cloud

import android.os.Handler
import android.os.Looper
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.add
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

class CloudSocket(
    private val client: OkHttpClient,
    private val json: Json = Json { ignoreUnknownKeys = true },
    /**
     * Where [Observer] callbacks are handed over. Injected rather than fixed to
     * the main looper so this class stays a plain JVM object under test; the
     * app passes [mainThread], which is what keeps socket state off OkHttp's
     * reader thread — see `connect`.
     */
    private val dispatch: (() -> Unit) -> Unit = { it() },
    /**
     * This install's `versionCode`, or 0 when the caller has none to report.
     * Sent as `appVersion` on `auth`: the server answers a build it has
     * user-facing notes for with exactly one message about it, in this
     * account's own thread with the service account (`announceAppBuild` in
     * `src/cloud/service-account.js`). A lambda rather than a number so this
     * class stays a plain JVM object under test, and so nothing here needs a
     * `Context`.
     */
    private val appVersion: () -> Long = { 0L },
) {

    data class IncomingMessage(
        val from: String,
        val id: String,
        val text: String,
        val ts: Long,
        val self: Boolean,
        val kind: String = "msg",
        val author: String? = null,
        val image: CloudImage? = null,
        val voice: CloudVoice? = null,
        val replyTo: CloudReply? = null,
        val forwardedFrom: CloudForward? = null,
        val buttons: List<CloudBotAction> = emptyList(),
        /** An edit's carrier (`sealedEdit`) or a tombstone standing in for one:
         *  stored hidden so the id is held, never drawn, counted or announced. */
        val hidden: Boolean = false,
    )
    /**
     * `{k:"message-accepted", peer, id, ts, seq}` — the server's proof that the
     * message is committed to its write-ahead journal, not merely that
     * `WebSocket.send()` returned true. [seq] is the account-scoped sequence
     * the record got, and it is what lets the sync cursor be advanced in the
     * same transaction that clears the pending operation.
     */
    data class MessageAccepted(val peer: String, val id: String, val ts: Long?, val seq: Long? = null)

    /** One entry of `{k:"sync-page"}` — an account-scoped durable mutation. */
    data class SyncEvent(
        val seq: Long,
        val kind: String,
        val peer: String,
        val id: String? = null,
        val ts: Long? = null,
        val text: String? = null,
        val emoji: String? = null,
        val by: String? = null,
        val add: Boolean = true,
        val ids: List<String> = emptyList(),
        val scope: String? = null,
        val readTs: Long? = null,
        /** When the reader reached [readTs] and which client did it, on a
         *  `kind:"read"` event — the server's `readAt`/`via`. Absent on an
         *  older server and on an old snapshot, and then the menu shows the
         *  time alone or no detail, never a guessed client. */
        val readAt: Long? = null,
        val via: String = "",
        val from: String? = null,
        val self: Boolean = false,
    )

    /** `{k:"sync-page", events, cursor, more, reset}`. [reset] means the cursor
     *  fell out of the server's retained window: conversations must be re-seeded
     *  from HTTP history, and the local outbox must survive that. */
    data class SyncPage(
        val events: List<SyncEvent>,
        val cursor: Long,
        val more: Boolean,
        val reset: Boolean,
    )

    /** `{k:"read-sync", peer, id, readTs}` — this account's own read watermark
     *  moving on another session. [readAt]/[via] describe *this* account's own
     *  advance (the server's `readAt`/`clientKind`), carried so the frame is
     *  not parsed one field short of what it says; the peer's own read detail
     *  comes from the receipt and feed paths, not from here. */
    data class ReadSync(
        val peer: String,
        val id: String,
        val readTs: Long,
        val readAt: Long? = null,
        val via: String = "",
    )
    /** `{k:"read-accepted", peer, id, readTs}` — the server's durable proof
     *  that a read receipt (this account's own outgoing `read`/`mark-read`)
     *  was actually applied, not merely accepted by the socket. [id] is the
     *  message id for a per-message receipt, or `null` for a bulk `mark-read`.
     *  [readAt]/[via] are this account's own advance, as on [ReadSync]. */
    data class ReadAccepted(
        val peer: String,
        val id: String?,
        val readTs: Long,
        val readAt: Long? = null,
        val via: String = "",
    )
    /** `{k:"op-accepted", peer, opKind, id, opId?}` — confirmation that an
     * edit/reaction/delete reached the server's synchronous mutation boundary.
     * [opId] is echoed by new servers for exact correlation; [id] remains the
     * affected message for the base `op-ack-v1` contract. */
    data class OperationAccepted(
        val peer: String,
        val opKind: String,
        val id: String,
        val opId: String?,
    )
    /**
     * `{t:"ack"|"read", id}` — the peer's receipt for one of this account's own
     * messages.
     *
     * [readTs] is the peer's read *watermark*, sent on `read` since the server
     * learned to include it (`src/cloud/hub.js`, `relay`'s read branch): the
     * message named by [id] is the newest one they read, and everything of ours
     * at or before that time is read too. Without it a client could only ever
     * advance the single bubble a receipt happened to name, so a receipt lost
     * to a reconnect left every earlier message on one ✓ forever — the
     * «галочки не совпадают» complaint. `null` from an older server or an
     * `ack`, and then only [id] may be advanced.
     *
     * [readAt] is when the peer reached that watermark and [via] is the client
     * that did it (`web`/`cli`/`android/<build>`, `''` when the server knows
     * only that the snapshot has one) — the same pair the durable feed and
     * `/api/history` carry, so the menu can say «Прочитано: 14:44 · телефон»
     * without guessing either half.
     *
     * [deliveredTs] is the peer's *delivered* watermark, sent on an `ack` since
     * the server learned to include it: the message named by [id] is the newest
     * one the peer's device holds, and everything of ours at or before that
     * time is on that device too. It is the delivered rung of the same ladder
     * [readTs] completes — one rung below it, and reached one receipt earlier.
     * `null` from an older server, which simply leaves the watermark where it
     * was; never invented, so a client that never sends `ack` reports nothing.
     */
    data class IncomingReceipt(
        val from: String,
        val id: String,
        val read: Boolean,
        val readTs: Long? = null,
        val readAt: Long? = null,
        val via: String = "",
        val deliveredTs: Long? = null,
    )

    /** `{t:"react", id, emoji, by, add}` — `relay`'s reaction branch,
     *  `src/cloud/hub.js:670-680`. `by` is who pressed it, which for an inbound
     *  frame is the sender but is carried explicitly all the same. */
    data class IncomingReaction(
        val from: String,
        val id: String,
        val emoji: String,
        val by: String,
        val add: Boolean,
    )

    /** `{t:"edit", id, text}` — `src/cloud/hub.js:658-667`. */
    data class IncomingEdit(val from: String, val id: String, val text: String)

    /** `{t:"del", ids, scope}` — `src/cloud/hub.js:631-655`. A `scope:"self"`
     *  frame is never relayed to the other side, so anything arriving here
     *  means the sender removed it for both of us. */
    data class IncomingDelete(val from: String, val ids: List<String>)

    data class Unread(
        val from: String,
        val text: String?,
        val ts: Long?,
        /** Absolute unread total for this peer, not a delta — see
         *  `src/cloud/hub.js`'s `deliverFrame`. Required: a frame missing it
         *  or carrying a negative/non-numeric value is dropped by
         *  [toUnread] rather than guessed at. */
        val count: Int,
    )

    data class ReplyReminder(
        val id: String,
        val peer: String,
        val messageId: String,
        val dueAt: Long,
    )

    data class IncomingWake(val from: String)

    data class IncomingTyping(val from: String, val typing: Boolean)

    /** Transient bot controls. They are never history: the latest set replaces
     *  the previous one for [from], and an empty list clears it. */
    data class IncomingActions(val from: String, val actions: List<CloudBotAction>)

    data class IncomingPing(val from: String, val id: String)

    data class IncomingPong(val from: String, val id: String, val ts: Long)

    /** `d` verbatim from a `file-offer`/`file-chunk`/`file-done`/`file-deny` frame — the
     *  shape [net.tailchat.proto.FileReceiver] already knows how to read, so it is passed
     *  through unparsed rather than re-declared here. */
    data class IncomingFileFrame(val from: String, val frame: JsonObject)


    interface Observer {
        /** [caps] is what the *server* announced it supports. Empty means an
         *  older server: durable acceptance and resumable sync are unavailable,
         *  and the client must say so rather than pretend. */
        fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>)
        fun onUsers(users: List<CloudUser>) = Unit
        fun onPresence(peer: String, online: Boolean, lastSeen: Long?) = Unit
        fun onSubscribed(peer: String) = Unit
        fun onMessage(message: IncomingMessage) = Unit
        fun onReceipt(receipt: IncomingReceipt) = Unit
        fun onMessageAccepted(accepted: MessageAccepted) = Unit
        fun onReaction(reaction: IncomingReaction) = Unit
        fun onEdit(edit: IncomingEdit) = Unit
        fun onDelete(delete: IncomingDelete) = Unit
        fun onUnread(unread: Unread) = Unit
        fun onSyncPage(page: SyncPage) = Unit
        /** `k:"sync-nudge"`: this account's durable feed has moved. The client
         *  answers by asking `sync` from its own cursor — the envelope carries
         *  no content on purpose, so there is nothing to merge here and nothing
         *  to acknowledge. */
        fun onSyncAvailable() = Unit
        fun onReadSync(readSync: ReadSync) = Unit
        fun onReadAccepted(accepted: ReadAccepted) = Unit
        fun onOperationAccepted(accepted: OperationAccepted) = Unit
        fun onReplyReminder(reminder: ReplyReminder) = Unit
        /** A reminder this account has set and that has not come due yet —
         *  the hub's answer to `reply-reminder`, and again for every pending
         *  one on `auth`. The mark goes on the message, so a client redraws
         *  it from here rather than remembering that *it* was the one that
         *  asked. */
        fun onReplyReminderSet(reminder: ReplyReminder) = Unit
        fun onWake(wake: IncomingWake) = Unit
        fun onTyping(typing: IncomingTyping) = Unit
        fun onActions(actions: IncomingActions) = Unit
        fun onPing(ping: IncomingPing) = Unit
        fun onPong(pong: IncomingPong) = Unit
        fun onFileOffer(offer: IncomingFileFrame) = Unit
        fun onFileChunk(chunk: IncomingFileFrame) = Unit
        fun onFileDone(done: IncomingFileFrame) = Unit
        fun onFileDeny(deny: IncomingFileFrame) = Unit
        /** Any `call-*` frame, undecoded — [net.tailchat.android.call.CallSignaling]
         *  is what turns [IncomingFileFrame.frame] (reused for shape only:
         *  "from this peer, here is a JsonObject `d`") into a `CallFrame`. */
        fun onCallSignal(from: String, frame: JsonObject) = Unit
        /** `k:"throttle"`: the hub dropped the frame that triggered this — a
         *  soft answer, not a close, so the socket stays up and whatever sent
         *  the dropped frame is on its own to notice and redo it (see
         *  `SyncEngine.drainReceipts`, the one caller with no other way to
         *  know a receipt never landed). */
        fun onThrottle() = Unit
        /** Any bytes at all from the server, before they are even parsed: proof the
         *  socket is still a two-way pipe, which a TCP connection dropped by a NAT or
         *  a carrier will keep pretending to be until something is actually asked of
         *  it. [Connection.sendWho] is what asks. */
        fun onTraffic() = Unit
        fun onFailure(failure: CloudFailure)
        fun onClosed()
    }

    class Connection internal constructor() {
        private var socket: WebSocket? = null

        internal fun attach(socket: WebSocket) {
            this.socket = socket
        }

        fun subscribe(peer: String): Boolean = socket?.send(buildJsonObject {
            put("k", "subscribe")
            put("peer", peer)
        }.toString()) ?: false

        /** The counterpart to [subscribe]: an empty peer tells the hub to stop
         *  treating this connection as an active viewer of whoever it was
         *  subscribed to — what closing a conversation must send, or the
         *  subscription is "sticky" and every later message from that peer
         *  is routed as if delivered to an open, watching client (silently
         *  skipping the unread count) long after the UI moved back to the
         *  roster. */
        fun unsubscribe(): Boolean = socket?.send(buildJsonObject {
            put("k", "subscribe")
            put("peer", "")
        }.toString()) ?: false

        fun markConversationUnread(peer: String): Boolean = socket?.send(buildJsonObject {
            put("k", "mark-unread")
            put("peer", peer)
        }.toString()) ?: false

        fun readReactionEvents(peer: String, ids: List<String>): Boolean = socket?.send(buildJsonObject {
            put("k", "reaction-read")
            put("peer", peer)
            put("ids", buildJsonArray { ids.forEach { add(it) } })
        }.toString()) ?: false

        fun scheduleReplyReminder(peer: String, messageId: String, dueAt: Long): Boolean =
            socket?.send(buildJsonObject {
                put("k", "reply-reminder")
                put("peer", peer)
                put("messageId", messageId)
                put("dueAt", dueAt)
            }.toString()) ?: false

        fun acknowledgeReplyReminder(id: String): Boolean = socket?.send(buildJsonObject {
            put("k", "reply-reminder-ack")
            put("id", id)
        }.toString()) ?: false

        fun sendMessage(
            peer: String,
            id: String,
            text: String,
            ts: Long,
            name: String,
            image: CloudImage? = null,
            voice: CloudVoice? = null,
            replyTo: CloudReply? = null,
            forwardedFrom: CloudForward? = null,
        ): Boolean =
            socket?.send(buildJsonObject {
                put("k", "frame")
                put("to", peer)
                put("d", buildJsonObject {
                    put("t", "msg")
                    put("id", id)
                    put("text", text)
                    put("ts", ts)
                    put("name", name)
                    if (image != null) put("image", buildJsonObject {
                        put("dataUrl", image.dataUrl)
                        put("width", image.width)
                        put("height", image.height)
                    })
                    if (voice != null) put("voice", buildJsonObject {
                        put("dataUrl", voice.dataUrl)
                        put("duration", voice.durationSec)
                    })
                    if (replyTo != null) put("replyTo", buildJsonObject {
                        put("id", replyTo.id)
                        put("from", replyTo.from)
                        put("text", replyTo.text)
                        if (replyTo.media != null) put("media", replyTo.media)
                    })
                    if (forwardedFrom != null) put("forwardedFrom", buildJsonObject {
                        put("login", forwardedFrom.login)
                        put("name", forwardedFrom.name)
                    })
                })
            }.toString()) ?: false
        fun sendReceipt(peer: String, id: String, read: Boolean): Boolean =
            socket?.send(buildJsonObject {
                put("k", "frame")
                put("to", peer)
                put("d", buildJsonObject {
                    put("t", if (read) "read" else "ack")
                    put("id", id)
                })
            }.toString()) ?: false

        /** Toggles one emoji on one message. The server is the bookkeeper: it
         *  folds the change into its own history record and relays the result,
         *  so this never sends the whole reaction set. */
        fun sendReaction(
            peer: String,
            id: String,
            emoji: String,
            add: Boolean,
            opId: String? = null,
        ): Boolean =
            socket?.send(buildJsonObject {
                put("k", "frame")
                put("to", peer)
                put("d", buildJsonObject {
                    put("t", "react")
                    put("id", id)
                    put("emoji", emoji)
                    put("add", add)
                    if (opId != null) put("opId", opId)
                })
            }.toString()) ?: false

        fun sendEdit(peer: String, id: String, text: String, opId: String? = null): Boolean =
            socket?.send(buildJsonObject {
                put("k", "frame")
                put("to", peer)
                put("d", buildJsonObject {
                    put("t", "edit")
                    put("id", id)
                    put("text", text)
                    if (opId != null) put("opId", opId)
                })
            }.toString()) ?: false

        /** `scope = "all"` removes the message from the server's history and
         *  tells the peer; `scope = "self"` only hides this account's copy
         *  (`hideHistory`), which is why the peer is never told about it. */
        fun sendDelete(
            peer: String,
            ids: List<String>,
            scope: String,
            opId: String? = null,
        ): Boolean =
            socket?.send(buildJsonObject {
                put("k", "frame")
                put("to", peer)
                put("d", buildJsonObject {
                    put("t", "del")
                    put("ids", buildJsonArray { for (id in ids) add(id) })
                    put("scope", scope)
                    if (opId != null) put("opId", opId)
                })
            }.toString()) ?: false

        fun sendWake(peer: String): Boolean = sendSimpleFrame(peer, "wake")

        /**
         * Both halves of the indicator. Every other client — web and the
         * terminal — sends `state`, and web treats a `typing` frame without
         * one as a *stop*: an Android composer therefore showed nothing at
         * all on the other side («я не вижу typing»). The stop is sent when
         * the composer goes quiet or the message leaves, so the peer's line
         * disappears at once instead of waiting out their own timeout.
         */
        fun sendTyping(peer: String, state: String = "start"): Boolean =
            socket?.send(buildJsonObject {
                put("k", "frame")
                put("to", peer)
                put("d", buildJsonObject {
                    put("t", "typing")
                    put("state", state)
                })
            }.toString()) ?: false

        fun sendPing(peer: String, id: String, ts: Long): Boolean =
            socket?.send(buildJsonObject {
                put("k", "frame")
                put("to", peer)
                put("d", buildJsonObject {
                    put("t", "ping")
                    put("id", id)
                    put("ts", ts)
                })
            }.toString()) ?: false

        fun sendPong(peer: String, id: String, ts: Long): Boolean =
            socket?.send(buildJsonObject {
                put("k", "frame")
                put("to", peer)
                put("d", buildJsonObject {
                    put("t", "pong")
                    put("id", id)
                    put("ts", ts)
                })
            }.toString()) ?: false
        fun sendHello(
            peer: String,
            name: String,
            connId: String = net.tailchat.proto.Wire.newConnId(),
            version: String = "android",
            tz: String? = null,
            lang: String? = null,
        ): Boolean =
            socket?.send(buildJsonObject {
                put("k", "frame")
                put("to", peer)
                put("d", buildJsonObject {
                    put("t", "hello")
                    put("name", name)
                    put("connId", connId)
                    put("v", version)
                    if (tz != null) put("tz", tz)
                    if (lang != null) put("lang", lang)
                })
            }.toString()) ?: false


        private fun sendSimpleFrame(peer: String, type: String): Boolean =
            socket?.send(buildJsonObject {
                put("k", "frame")
                put("to", peer)
                put("d", buildJsonObject { put("t", type) })
            }.toString()) ?: false

        /** Wraps an already-built frame (`net.tailchat.proto.fileOfferFrame` and friends)
         *  in the cloud envelope — the file-transfer protocol is otherwise identical to the
         *  P2P one, so its frame builders are reused verbatim rather than duplicated here. */
        fun sendFileFrame(peer: String, frame: JsonObject): Boolean = socket?.send(buildJsonObject {
            put("k", "frame")
            put("to", peer)
            put("d", frame)
        }.toString()) ?: false

        /** `call-*` (docs/specs/2026-09-15-android-calls-plan.md §2) —
         *  addressed the same way as [sendFileFrame], and like it, never
         *  paced through [FramePacer]: a call's own signalling is already
         *  batched (`call-ice` candidates) or infrequent enough (one offer,
         *  one answer, occasional end) that it cannot itself spend the
         *  connection's 60/s budget. */
        fun sendCallFrame(peer: String, frame: JsonObject): Boolean = socket?.send(buildJsonObject {
            put("k", "frame")
            put("to", peer)
            put("d", frame)
        }.toString()) ?: false

        /** Bytes OkHttp has accepted but not yet written to the wire — the same signal
         *  `socket.bufferedAmount` gives the web client's `waitForSocketDrain`, used the same
         *  way: park the chunk loop until this drops, so a slow link fills memory instead of
         *  letting one huge file starve every other frame on the socket. */
        fun queuedBytes(): Long = socket?.queueSize() ?: 0L

        /** `k:"who"` — the one request the hub answers unconditionally with a `users`
         *  envelope (`src/cloud/hub.js:397`). Sent as a liveness probe: it is not rate
         *  limited (`withinRate` gates `k:"frame"` only), costs two small frames, and
         *  its answer is the only way this client can tell a healthy idle socket from a
         *  half-open one — OkHttp's own ping/pong is handled below the listener and the
         *  server's 30s ping never surfaces here either. */
        fun sendWho(): Boolean = socket?.send(buildJsonObject { put("k", "who") }.toString()) ?: false

        /** `k:"sync"` — the resumable account-level change feed. Answered with
         *  `sync-page`; not rate limited, same as `who`. */
        fun sendSync(since: Long, limit: Int): Boolean = socket?.send(buildJsonObject {
            put("k", "sync")
            put("since", since)
            put("limit", limit)
        }.toString()) ?: false

        /** `k:"mark-read"` — the bulk watermark jump, which unlike a per-id
         *  `read` frame does not need a subscription to that peer. */
        fun sendMarkRead(peer: String): Boolean = socket?.send(buildJsonObject {
            put("k", "mark-read")
            put("peer", peer)
        }.toString()) ?: false


        fun cancel() {
            socket?.cancel()
            socket = null
        }
    }

    fun connect(session: CloudSession, observer: Observer, lurk: Boolean = false): Connection {
        val connection = Connection()
        val request = Request.Builder().url(CloudApi.socketUrl(session.server)).build()
        val socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(buildJsonObject {
                    put("k", "auth")
                    put("token", session.token)
                    // What this client implements, not what it wants: the server
                    // answers with its own list on `ready`, and the intersection
                    // is what either side may rely on. `call-v1` is appended
                    // only when the local call engine actually came up (§9.1):
                    // claiming it unconditionally would make this device
                    // `callable` in everyone's roster and ring into a phone
                    // whose engine never initialised. `lurk-v1` is appended only
                    // for a wake-only connection (see [CAP_LURK]).
                    put("caps", buildJsonArray {
                        for (cap in CLIENT_CAPS) add(cap)
                        if (net.tailchat.android.call.CallEngineAvailability.available) add(CAP_CALL)
                        if (lurk) add(CAP_LURK)
                    })
                    // What this install is, when this build knows: the server
                    // sends the curated user-facing notes for exactly this
                    // build once, to whoever is actually running it. Absent
                    // (not 0) when unknown, so the server never has to
                    // distinguish "an old client" from "build zero".
                    appVersion().takeIf { it > 0 }?.let { put("appVersion", it) }
                }.toString())
            }

            // Parsing is cheap and belongs on the reader thread; *delivery* does
            // not. Everything behind [Observer] — the unread sets, the outbox
            // map, the notification threads — is owned by the main thread
            // (`ServiceCloudController`'s scope is `Dispatchers.Main.immediate`),
            // and before this hop those collections were mutated from OkHttp's
            // reader thread as well: a message arriving while the user opened a
            // conversation was a `ConcurrentModificationException` on whichever
            // thread lost the race — a process crash on main, a dead socket on
            // the reader thread, since OkHttp turns any exception thrown out of
            // `onMessage` into `failWebSocket`. One handler hop fixes both, and
            // ordering is preserved because a single looper queue is FIFO.
            override fun onMessage(webSocket: WebSocket, text: String) {
                val payload = try {
                    json.parseToJsonElement(text).jsonObject
                } catch (_: Exception) {
                    onMain { observer.onFailure(CloudFailure("invalid_json")) }
                    return
                }
                onMain {
                    observer.onTraffic()
                    // A bug in our own dispatch must not read as a network
                    // failure: reported, not thrown, so the socket survives it.
                    try {
                        deliver(payload, observer)
                    } catch (error: Exception) {
                        observer.onFailure(CloudFailure("client_error", error.message))
                    }
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            // The hub closes with 4429 when a client outruns its 60-frames-per-
            // second limit (`src/cloud/hub.js`, `RATE_LIMITED_CODE`). That is a
            // close, not a transport failure, and reconnecting straight into it
            // reproduces it — so it is reported as a named failure the
            // controller can back off from, instead of a plain `onClosed`.
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                onMain {
                    if (code == RATE_LIMITED_CODE) {
                        observer.onFailure(CloudFailure("rate_limited", reason))
                    } else {
                        observer.onClosed()
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                onMain { observer.onFailure(CloudFailure("unreachable", error.message)) }
            }
        })
        connection.attach(socket)
        return connection
    }

    private fun onMain(block: () -> Unit) = dispatch(block)

    private fun deliver(payload: JsonObject, observer: Observer) {
        when (payload["k"]?.jsonPrimitive?.contentOrNull) {
            "ready" -> {
                val self = payload["self"]?.jsonObject?.toUser()
                if (self == null) observer.onFailure(CloudFailure("malformed_response"))
                else observer.onReady(self, payload.users(), payload.caps())
            }
            "users", "roster" -> observer.onUsers(payload.users())
            "presence" -> {
                val peer = payload["peer"]?.jsonPrimitive?.contentOrNull ?: return
                val online = payload["online"]?.jsonPrimitive?.booleanOrNull ?: false
                val lastSeen = payload["lastSeen"]?.jsonPrimitive?.longOrNull
                observer.onPresence(peer, online, lastSeen)
            }
            "subscribed" -> payload["peer"]?.jsonPrimitive?.contentOrNull?.let(observer::onSubscribed)
            "message-accepted" -> {
                val peer = payload["peer"]?.jsonPrimitive?.contentOrNull ?: return
                val id = payload["id"]?.jsonPrimitive?.contentOrNull ?: return
                observer.onMessageAccepted(MessageAccepted(
                    peer = peer,
                    id = id,
                    ts = payload["ts"]?.jsonPrimitive?.longOrNull,
                    seq = payload["seq"]?.jsonPrimitive?.longOrNull,
                ))
            }
            "sync-page" -> observer.onSyncPage(payload.toSyncPage())
            // The account feed moved: an empty notification, because `sync`
            // already answers with everything since a cursor and a nudge that
            // tried to describe the change would be a second, weaker copy of
            // the feed. Not rate limited and never answered with anything but a
            // `sync` request, so it cannot become a loop.
            "sync-nudge" -> observer.onSyncAvailable()
            "read-accepted" -> {
                val peer = payload["peer"]?.jsonPrimitive?.contentOrNull ?: return
                val readTs = payload["readTs"]?.jsonPrimitive?.longOrNull ?: return
                observer.onReadAccepted(ReadAccepted(
                    peer,
                    payload["id"]?.jsonPrimitive?.contentOrNull,
                    readTs,
                    readAt = payload["readAt"]?.jsonPrimitive?.longOrNull,
                    via = payload["via"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                ))
            }
            "op-accepted" -> {
                val peer = payload["peer"]?.jsonPrimitive?.contentOrNull ?: return
                val opKind = payload["opKind"]?.jsonPrimitive?.contentOrNull ?: return
                val id = payload["id"]?.jsonPrimitive?.contentOrNull ?: return
                observer.onOperationAccepted(OperationAccepted(
                    peer = peer,
                    opKind = opKind,
                    id = id,
                    opId = payload["opId"]?.jsonPrimitive?.contentOrNull,
                ))
            }
            "read-sync" -> {
                val peer = payload["peer"]?.jsonPrimitive?.contentOrNull ?: return
                val readTs = payload["readTs"]?.jsonPrimitive?.longOrNull ?: return
                observer.onReadSync(ReadSync(
                    peer,
                    payload["id"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                    readTs,
                    readAt = payload["readAt"]?.jsonPrimitive?.longOrNull,
                    via = payload["via"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                ))
            }
            "unread" -> payload.toUnread()?.let(observer::onUnread)
            "reply-reminder-fired" -> payload["reminder"]?.jsonObject?.toReplyReminder()
                ?.let(observer::onReplyReminder)
            "reply-reminder-set" -> payload["reminder"]?.jsonObject?.toReplyReminder()
                ?.let(observer::onReplyReminderSet)
            "frame" -> {
                payload.toIncomingMessage()?.let(observer::onMessage)
                payload.toIncomingReceipt()?.let(observer::onReceipt)
                payload.toIncomingWake()?.let(observer::onWake)
                payload.toIncomingTyping()?.let(observer::onTyping)
                payload.toIncomingActions()?.let(observer::onActions)
                payload.toIncomingPing()?.let(observer::onPing)
                payload.toIncomingPong()?.let(observer::onPong)
                payload.toIncomingReaction()?.let(observer::onReaction)
                payload.toIncomingEdit()?.let(observer::onEdit)
                payload.toIncomingDelete()?.let(observer::onDelete)
                val from = payload.fromLogin()
                if (from != null) when (payload.frameType()) {
                    "file-offer" -> payload["d"]?.jsonObject?.let { observer.onFileOffer(IncomingFileFrame(from, it)) }
                    "file-chunk" -> payload["d"]?.jsonObject?.let { observer.onFileChunk(IncomingFileFrame(from, it)) }
                    "file-done" -> payload["d"]?.jsonObject?.let { observer.onFileDone(IncomingFileFrame(from, it)) }
                    "file-deny" -> payload["d"]?.jsonObject?.let { observer.onFileDeny(IncomingFileFrame(from, it)) }
                    in net.tailchat.android.call.CALL_FRAME_TYPES ->
                        payload["d"]?.jsonObject?.let { observer.onCallSignal(from, it) }
                }
            }
            "throttle" -> observer.onThrottle()
            "error" -> observer.onFailure(CloudFailure(
                code = payload["code"]?.jsonPrimitive?.contentOrNull ?: "server_error",
                detail = payload["message"]?.jsonPrimitive?.contentOrNull,
            ))
        }
    }

    private fun JsonObject.caps(): Set<String> = this["caps"]?.jsonArray
        ?.mapNotNull { it.jsonPrimitive.contentOrNull }
        ?.toSet()
        .orEmpty()

    private fun JsonObject.toSyncPage(): SyncPage = SyncPage(
        events = this["events"]?.jsonArray
            ?.mapNotNull { element -> runCatching { element.jsonObject.toSyncEvent() }.getOrNull() }
            ?.filterNotNull()
            .orEmpty(),
        cursor = this["cursor"]?.jsonPrimitive?.longOrNull ?: 0L,
        more = this["more"]?.jsonPrimitive?.booleanOrNull ?: false,
        reset = this["reset"]?.jsonPrimitive?.booleanOrNull ?: false,
    )

    private fun JsonObject.toSyncEvent(): SyncEvent? {
        val seq = this["seq"]?.jsonPrimitive?.longOrNull ?: return null
        val kind = this["kind"]?.jsonPrimitive?.contentOrNull ?: return null
        val peer = this["peer"]?.jsonPrimitive?.contentOrNull ?: return null
        return SyncEvent(
            seq = seq,
            kind = kind,
            peer = peer,
            id = this["id"]?.jsonPrimitive?.contentOrNull,
            ts = this["ts"]?.jsonPrimitive?.longOrNull,
            text = this["text"]?.jsonPrimitive?.contentOrNull,
            emoji = this["emoji"]?.jsonPrimitive?.contentOrNull,
            by = this["by"]?.jsonPrimitive?.contentOrNull,
            add = this["add"]?.jsonPrimitive?.booleanOrNull ?: true,
            ids = this["ids"]?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty(),
            scope = this["scope"]?.jsonPrimitive?.contentOrNull,
            readTs = this["readTs"]?.jsonPrimitive?.longOrNull,
            readAt = this["readAt"]?.jsonPrimitive?.longOrNull,
            via = this["via"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            from = this["from"]?.jsonPrimitive?.contentOrNull,
            self = this["self"]?.jsonPrimitive?.booleanOrNull ?: false,
        )
    }
    private fun JsonObject.users(): List<CloudUser> = this["users"]?.jsonArray
        ?.mapNotNull { element -> runCatching { element.jsonObject.toUser() }.getOrNull() }
        .orEmpty()

    private fun JsonObject.toUser(): CloudUser? {
        val login = this["login"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank) ?: return null
        val name = this["name"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank) ?: login
        return CloudUser(
            login = login,
            name = name,
            // The caller's own nickname for this contact (issue #28), present
            // only when this account set one. Blank is treated as "none" so a
            // cleared nickname never wins over the account's own name.
            alias = this["alias"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank),
            online = this["online"]?.jsonPrimitive?.booleanOrNull ?: false,
            lastSeen = this["lastSeen"]?.jsonPrimitive?.longOrNull,
            pending = this["pending"]?.jsonPrimitive?.intOrNull ?: 0,
            // `usersFor` puts this in every roster entry, browser or not
            // (`src/cloud/hub.js:190`): a client knows only the conversations
            // it has actually opened, which on a fresh start is none of them.
            preview = this["last"]?.jsonObject?.toPreview(),
            // Set only for the deployment's own service/AI account
            // (`src/cloud/hub.js`'s `official` flag); absent for everyone else.
            official = this["official"]?.jsonPrimitive?.booleanOrNull ?: false,
            // A bot account: set by the server from the `v: 'bot'` its own
            // socket announces (`bots/client.mjs`), never by a client. Absent
            // means "a person" — the same as every other optional roster flag.
            bot = this["bot"]?.jsonPrimitive?.booleanOrNull ?: false,
            // Omitted (not merely `false`) when this account has not blocked
            // the peer — see `GET /api/users`/`ready`/`users` in the server
            // contract; absent means false the same as every other roster flag.
            blocked = this["blocked"]?.jsonPrimitive?.booleanOrNull ?: false,
            callable = this["callable"]?.jsonPrimitive?.booleanOrNull ?: false,
            reactionEvents = this["reactionEvents"]?.jsonArray?.mapNotNull { element ->
                val event = element as? JsonObject ?: return@mapNotNull null
                CloudReactionEvent(
                    event["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                    event["messageId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                    event["emoji"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                    event["by"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                    event["ts"]?.jsonPrimitive?.longOrNull ?: 0L,
                )
            }.orEmpty(),
        )
    }

    private fun JsonObject.toPreview(): CloudPreview? {
        val from = this["from"]?.jsonPrimitive?.contentOrNull ?: return null
        return CloudPreview(
            from = from,
            text = this["text"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            media = this["media"]?.jsonPrimitive?.contentOrNull,
            ts = this["ts"]?.jsonPrimitive?.longOrNull ?: 0,
        )
    }

    private fun JsonObject.toIncomingMessage(): IncomingMessage? {
        val frame = this["d"]?.jsonObject ?: return null
        val kind = frame["t"]?.jsonPrimitive?.contentOrNull
        if (kind != "msg" && kind != "ai") return null
        val from = this["from"]?.jsonPrimitive?.contentOrNull ?: return null
        val id = frame["id"]?.jsonPrimitive?.contentOrNull ?: return null
        // The server's envelope for an encrypted edit reaches this client as a
        // stub (or, from a newer server, a tombstone without `text`); either way
        // it is not a message to the reader.
        val hidden = frame["sealedEdit"]?.jsonPrimitive?.booleanOrNull == true ||
            frame["deletedAt"]?.jsonPrimitive?.longOrNull != null
        val text = if (hidden) "" else frame["text"]?.jsonPrimitive?.contentOrNull ?: return null
        val ts = frame["ts"]?.jsonPrimitive?.longOrNull ?: return null
        if (hidden) return IncomingMessage(
            from = from, id = id, text = "", ts = ts,
            self = this["self"]?.jsonPrimitive?.booleanOrNull ?: false, kind = kind, hidden = true,
        )
        return IncomingMessage(
            from = from,
            id = id,
            text = text,
            ts = ts,
            self = this["self"]?.jsonPrimitive?.booleanOrNull ?: false,
            kind = kind,
            author = frame["name"]?.jsonPrimitive?.contentOrNull,
            image = frame["image"]?.jsonObject?.toCloudImage(),
            voice = frame["voice"]?.jsonObject?.toCloudVoice(),
            replyTo = frame["replyTo"]?.jsonObject?.toCloudReply(),
            forwardedFrom = frame["forwardedFrom"]?.jsonObject?.toCloudForward(),
            buttons = frame.toCloudButtons(),
        )
    }

    // Inbound media is capped at the same size this client is willing to send.
    // The hub's own ceiling is a 10 MiB frame, and a web client can reach it:
    // holding the data URL, its parsed copy and then the re-encoded disk cache
    // for one such message is an `OutOfMemoryError`, which is an `Error` — not
    // caught by OkHttp's `catch (Exception)`, so it kills the process rather
    // than the socket. Dropping the payload keeps the message itself.
    private fun JsonObject.toCloudImage(): CloudImage? {
        val dataUrl = this["dataUrl"]?.jsonPrimitive?.contentOrNull ?: return null
        if (dataUrl.length > CLOUD_VOICE_MAX_DATA_URL_CHARS) return null
        val width = this["width"]?.jsonPrimitive?.pixelsOrNull() ?: return null
        val height = this["height"]?.jsonPrimitive?.pixelsOrNull() ?: return null
        return CloudImage(dataUrl, width, height)
    }

    /** The duration through the shared reader ([voiceSecondsOrNull]): the hub relays the
     *  sender's `voice` object as written (`hub.js`'s `record.voice = d.voice`), so a
     *  fractional or zero duration arrives here exactly as the CLI or web wrote it. */
    private fun JsonObject.toCloudVoice(): CloudVoice? {
        val dataUrl = this["dataUrl"]?.jsonPrimitive?.contentOrNull ?: return null
        if (dataUrl.length > CLOUD_VOICE_MAX_DATA_URL_CHARS) return null
        val duration = this["duration"]?.jsonPrimitive?.voiceSecondsOrNull() ?: return null
        return CloudVoice(dataUrl, duration)
    }

    private fun JsonObject.toCloudForward(): CloudForward? {
        val login = this["login"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val name = this["name"]?.jsonPrimitive?.contentOrNull.orEmpty()
        if (login.isEmpty() && name.isEmpty()) return null
        return CloudForward(login = login, name = name.ifEmpty { login })
    }

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
    private fun JsonObject.toCloudButtons(): List<CloudBotAction> {
        val raw = this["buttons"]?.jsonArray ?: return emptyList()
        return raw.take(8).mapNotNull { element ->
            val obj = runCatching { element.jsonObject }.getOrNull() ?: return@mapNotNull null
            val id = obj["id"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
            val label = obj["label"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
            val value = obj["value"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
            if (id.isEmpty() || id.length > 40 || label.isEmpty() || label.length > 40 ||
                value.isEmpty() || value.length > 200
            ) return@mapNotNull null
            CloudBotAction(id, label, value)
        }
    }


    private fun JsonObject.toIncomingReceipt(): IncomingReceipt? {
        val frame = this["d"]?.jsonObject ?: return null
        val type = frame["t"]?.jsonPrimitive?.contentOrNull
        if (type != "ack" && type != "read") return null
        return IncomingReceipt(
            from = this["from"]?.jsonPrimitive?.contentOrNull ?: return null,
            id = frame["id"]?.jsonPrimitive?.contentOrNull ?: return null,
            read = type == "read",
            readTs = frame["readTs"]?.jsonPrimitive?.longOrNull,
            readAt = frame["readAt"]?.jsonPrimitive?.longOrNull,
            via = frame["via"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            // The relayed `ack` carries the peer's delivered watermark on the
            // same `d`, set by the hub before it fans the frame out; a `read`
            // frame has no such field and reads back as `null`.
            deliveredTs = frame["deliveredTs"]?.jsonPrimitive?.longOrNull,
        )
    }

    private fun JsonObject.frameType(): String? = this["d"]?.jsonObject?.get("t")?.jsonPrimitive?.contentOrNull

    private fun JsonObject.fromLogin(): String? = this["from"]?.jsonPrimitive?.contentOrNull

    private fun JsonObject.toIncomingWake(): IncomingWake? {
        if (frameType() != "wake") return null
        return IncomingWake(fromLogin() ?: return null)
    }

    private fun JsonObject.toIncomingTyping(): IncomingTyping? {
        if (frameType() != "typing") return null
        // No `state` means an older client that only ever announced the start.
        val state = this["d"]?.jsonObject?.get("state")?.jsonPrimitive?.contentOrNull ?: "start"
        return IncomingTyping(fromLogin() ?: return null, state != "stop")
    }

    private fun JsonObject.toIncomingActions(): IncomingActions? {
        if (frameType() != "actions") return null
        val frame = this["d"]?.jsonObject ?: return null
        val raw = frame["actions"]?.jsonArray ?: return null
        val actions = raw.take(8).mapNotNull { element ->
            val action = runCatching { element.jsonObject }.getOrNull() ?: return@mapNotNull null
            val id = action["id"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
            val label = action["label"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
            val value = action["value"]?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
            if (id.isEmpty() || id.length > 40 || label.isEmpty() || label.length > 40 ||
                value.isEmpty() || value.length > 200
            ) return@mapNotNull null
            CloudBotAction(id, label, value)
        }
        return IncomingActions(fromLogin() ?: return null, actions)
    }

    private fun JsonObject.toIncomingPing(): IncomingPing? {
        if (frameType() != "ping") return null
        val id = this["d"]?.jsonObject?.get("id")?.jsonPrimitive?.contentOrNull ?: return null
        return IncomingPing(fromLogin() ?: return null, id)
    }

    private fun JsonObject.toIncomingPong(): IncomingPong? {
        if (frameType() != "pong") return null
        val frame = this["d"]?.jsonObject ?: return null
        val id = frame["id"]?.jsonPrimitive?.contentOrNull ?: return null
        val ts = frame["ts"]?.jsonPrimitive?.longOrNull ?: return null
        return IncomingPong(fromLogin() ?: return null, id, ts)
    }

    private fun JsonObject.toUnread(): Unread? {
        val from = this["from"]?.jsonPrimitive?.contentOrNull ?: return null
        val count = this["count"]?.jsonPrimitive?.intOrNull ?: return null
        if (count < 0) return null
        return Unread(
            from = from,
            text = this["text"]?.jsonPrimitive?.contentOrNull,
            ts = this["ts"]?.jsonPrimitive?.longOrNull,
            count = count,
        )
    }

    /** The `reminder` object `reply-reminder-set` and `reply-reminder-fired`
     *  both carry (`src/cloud/hub.js`): four required fields, anything
     *  missing is a frame this client cannot act on. */
    private fun JsonObject.toReplyReminder(): ReplyReminder? {
        val id = this["id"]?.jsonPrimitive?.contentOrNull ?: return null
        val peer = this["peer"]?.jsonPrimitive?.contentOrNull ?: return null
        val messageId = this["messageId"]?.jsonPrimitive?.contentOrNull ?: return null
        val dueAt = this["dueAt"]?.jsonPrimitive?.longOrNull ?: return null
        return ReplyReminder(id, peer, messageId, dueAt)
    }

    private fun JsonObject.toIncomingReaction(): IncomingReaction? {
        if (frameType() != "react") return null
        val frame = this["d"]?.jsonObject ?: return null
        val id = frame["id"]?.jsonPrimitive?.contentOrNull ?: return null
        val emoji = frame["emoji"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotEmpty) ?: return null
        val from = fromLogin() ?: return null
        return IncomingReaction(
            from = from,
            id = id,
            emoji = emoji,
            by = frame["by"]?.jsonPrimitive?.contentOrNull ?: from,
            add = frame["add"]?.jsonPrimitive?.booleanOrNull ?: true,
        )
    }

    private fun JsonObject.toIncomingEdit(): IncomingEdit? {
        if (frameType() != "edit") return null
        val frame = this["d"]?.jsonObject ?: return null
        val id = frame["id"]?.jsonPrimitive?.contentOrNull ?: return null
        val text = frame["text"]?.jsonPrimitive?.contentOrNull ?: return null
        return IncomingEdit(fromLogin() ?: return null, id, text)
    }

    private fun JsonObject.toIncomingDelete(): IncomingDelete? {
        if (frameType() != "del") return null
        val ids = this["d"]?.jsonObject?.get("ids")?.jsonArray
            ?.mapNotNull { it.jsonPrimitive.contentOrNull }
            ?.takeIf { it.isNotEmpty() } ?: return null
        return IncomingDelete(fromLogin() ?: return null, ids)
    }

    companion object {
        /** `RATE_LIMITED_CODE` in `src/cloud/hub.js`. */
        const val RATE_LIMITED_CODE = 4429

        /** Acceptance is journal-backed on the server before it is announced. */
        const val CAP_DURABLE_ACK = "durable-ack"
        /** The resumable `sync`/`sync-page` change feed exists. */
        const val CAP_SYNC = "sync-v1"
        /** The server announces a durable feed change with `k:"sync-nudge"`
         *  instead of leaving the client to notice on its next reconnect. */
        const val CAP_SYNC_NUDGE = "sync-nudge-v1"
        /** A frame may be addressed to a peer this socket is not subscribed to,
         *  which is what lets one queue drain every conversation without
         *  borrowing the UI's subscription. */
        const val CAP_ADDRESSED_SEND = "addressed-send"
        /** `read` (per-message receipt) and `mark-read` are answered with
         *  `read-accepted`, so a client no longer has to trust "the socket
         *  accepted the frame" as proof the server actually applied it. */
        const val CAP_READ_ACK = "read-ack-v1"
        /** Edit/reaction/delete are answered with `op-accepted`. */
        const val CAP_OP_ACK = "op-ack-v1"
        const val CAP_MARKED_UNREAD = "marked-unread-v1"
        const val CAP_REPLY_REMINDER = "reply-reminder-v1"
        const val CAP_REACTION_READ = "reaction-read-v1"
        /** This device can place/answer a voice call — sent only when
         *  [net.tailchat.android.call.CallEngineAvailability.available]. */
        const val CAP_CALL = "call-v1"

        /**
         * A wake-only connection (issue #29): the process was brought up by an
         * FCM push while the app is not on screen and the background service is
         * off. The hub still delivers every frame to such a socket, but counts
         * it for neither presence nor callability, so the account does not look
         * online to everyone else's roster just because a push woke it.
         */
        const val CAP_LURK = "lurk-v1"

        /** What this client implements, sent on `auth`. */
        val CLIENT_CAPS = listOf(
            CAP_DURABLE_ACK,
            CAP_SYNC,
            CAP_SYNC_NUDGE,
            CAP_ADDRESSED_SEND,
            CAP_READ_ACK,
            CAP_OP_ACK,
            CAP_MARKED_UNREAD,
            CAP_REPLY_REMINDER,
            CAP_REACTION_READ,
        )

        /**
         * The production `dispatch`: hand the callback to the main looper,
         * where every collection behind [Observer] is owned. Already on it —
         * a `connect()` that fails synchronously — runs inline, so ordering
         * cannot invert.
         */
        fun mainThread(): (() -> Unit) -> Unit {
            val handler = Handler(Looper.getMainLooper())
            return { block ->
                if (Looper.myLooper() == Looper.getMainLooper()) block() else handler.post(block)
            }
        }
    }
}
