package net.tailchat.proto

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.IOException
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

object Wire {
    val json = Json { ignoreUnknownKeys = true; isLenient = false }

    /**
     * Announced in `hello` so the peer can warn about a stale client. It tracks
     * the reference client's version because it is the same protocol, and a
     * lower number here would make every desktop offer us an update we cannot
     * install from an app store.
     */
    const val VERSION = "0.47.0"

    private val rng = SecureRandom()

    fun randomHex(bytes: Int): String {
        val raw = ByteArray(bytes)
        rng.nextBytes(raw)
        return raw.joinToString("") { "%02x".format(it) }
    }

    fun newMessageId(): String = randomHex(8)
    fun newConnId(): String = randomHex(16)
}

data class PeerDevice(val host: String?, val dns: String?, val ips: List<String>)

sealed interface PeerEvent {
    data class Hello(
        val peerName: String,
        val channelConnId: String,
        val peerVersion: String?,
    ) : PeerEvent

    data class Message(val name: String, val text: String, val ts: Long, val id: String?) : PeerEvent
    data class Ai(val name: String, val text: String, val ts: Long) : PeerEvent

    /** kind is "ack" or "read". */
    data class Receipt(val kind: String, val id: String) : PeerEvent

    /** kind is one of file-offer / file-chunk / file-done / file-deny. */
    data class FileFrame(val kind: String, val frame: JsonObject) : PeerEvent

    data class Typing(val start: Boolean) : PeerEvent
    data class Focus(val state: String?) : PeerEvent
    data object Wake : PeerEvent
    data object Logo : PeerEvent
    data class Bye(val reason: String) : PeerEvent
    data class Devices(val login: String?, val name: String?, val devices: List<PeerDevice>) : PeerEvent
    data class Update(val version: String?) : PeerEvent
    data class Caps(val focus: Boolean, val ai: Boolean) : PeerEvent
    data object Closed : PeerEvent
}

private val RECEIPTS = setOf("ack", "read")
private val FILE_FRAMES = setOf("file-offer", "file-chunk", "file-done", "file-deny")

/**
 * One TCP channel to a peer, framed and gated on `hello` — a port of
 * src/session.js. Every event is handed to [dispatch] so the caller can pin all
 * channel state to a single thread the way node's event loop does; the socket is
 * read on its own thread because blocking sockets are the only ones Android
 * gives us without dragging in a selector loop.
 */
class Connection(
    val socket: Socket,
    private val name: String,
    val connId: String,
    private val initiatedByMe: Boolean,
    private val dispatch: Executor,
    private val onEvent: (Connection, PeerEvent) -> Unit,
) {
    @Volatile private var gotHello = false
    @Volatile private var peerName: String? = null
    @Volatile private var eof = false
    @Volatile private var closed = false

    /**
     * A queued write, or — with both fields null — the signal for the writer to
     * stop. `bulk` marks a frame that returned a backpressure permit; `done`
     * lets a caller wait until this exact frame has left the socket.
     */
    private class Out(val bytes: ByteArray?, val bulk: Boolean, val done: CountDownLatch?)

    /**
     * Node writes asynchronously; Android forbids a blocking socket write on the
     * main thread outright, and rightly — the UI must not stall because a peer
     * stopped reading. So every frame is handed to one writer thread, and
     * `sendFrame` becomes exactly as truthful as node's: it means "queued on a
     * live channel", never "the peer has it".
     *
     * The queue is unbounded because only bulk transfers can produce frames
     * faster than the wire drains, and those are throttled by [bulkPermits]
     * instead — so a chat message can never be refused just because a file is
     * in flight.
     */
    private val outQueue = LinkedBlockingQueue<Out>()
    private val bulkPermits = Semaphore(BULK_WINDOW)
    private var reader: Thread? = null

    val remoteAddress: String? get() = normalizeIp(socket.inetAddress?.hostAddress)

    /** Sends our hello, then reads until the channel ends. */
    fun start() {
        startWriter()
        // Queued before anything is read: both sides announce unprompted, which
        // is what lets either of them be the one that dialled.
        sendFrame(
            buildJsonObject {
                put("t", "hello")
                put("name", name)
                put("connId", connId)
                put("v", Wire.VERSION)
            },
        )
        val parser = FrameParser(::onFrame)
        val thread = Thread({
            val buf = ByteArray(64 * 1024)
            try {
                val input = socket.getInputStream()
                while (true) {
                    val read = input.read(buf)
                    if (read < 0) break
                    parser.push(buf, read)
                }
            } catch (_: IOException) {
                // A reset or a local close: 'closed' is the only report either way.
            } finally {
                eof = true
                destroy()
                post(PeerEvent.Closed)
            }
        }, "tailchat-conn-$connId")
        thread.isDaemon = true
        reader = thread
        thread.start()
    }

    private fun startWriter() {
        val out = try {
            socket.getOutputStream()
        } catch (_: IOException) {
            destroy()
            return
        }
        val thread = Thread({
            try {
                while (true) {
                    val item = outQueue.take()
                    val bytes = item.bytes
                    if (bytes == null && item.done == null) break // stop signal
                    if (bytes != null) {
                        out.write(bytes)
                        out.flush()
                    }
                    if (item.bulk) bulkPermits.release()
                    item.done?.countDown()
                }
            } catch (_: IOException) {
                destroy()
            } catch (_: InterruptedException) {
                destroy()
            } finally {
                // Whoever is waiting on a permit or a barrier must be let go, or
                // a transfer would hang on a channel that has already died.
                releaseWaiters()
            }
        }, "tailchat-write-$connId")
        thread.isDaemon = true
        thread.start()
    }

    private fun releaseWaiters() {
        while (true) {
            val pending = outQueue.poll() ?: break
            pending.done?.countDown()
        }
        bulkPermits.release(BULK_WINDOW)
    }

    private fun onFrame(frame: JsonObject) {
        val t = frame.str("t") ?: return
        if (t == "hello") {
            if (gotHello) return
            gotHello = true
            val peer = frame.str("name") ?: "peer"
            peerName = peer
            val channelConnId = if (initiatedByMe) connId else (frame.str("connId") ?: frame.long("connId")?.toString() ?: "")
            emit(PeerEvent.Hello(peer, channelConnId, frame.str("v")))
            return
        }
        if (!gotHello) return // a frame before hello is not ours to trust
        when {
            t == "msg" -> emit(
                PeerEvent.Message(
                    name = peerName ?: "peer",
                    text = frame.str("text") ?: "",
                    ts = frame.long("ts") ?: System.currentTimeMillis(),
                    // A peer that predates message ids cannot be acked; that is
                    // null rather than an invented id it would never recognise.
                    id = frame.str("id"),
                ),
            )

            t == "ai" -> {
                val text = frame.str("text") ?: ""
                if (text.isNotEmpty()) {
                    emit(
                        PeerEvent.Ai(
                            name = frame.str("name")?.takeIf { it.isNotEmpty() } ?: "ai",
                            text = text,
                            ts = frame.long("ts") ?: System.currentTimeMillis(),
                        ),
                    )
                }
            }

            t in RECEIPTS -> frame.str("id")?.let { emit(PeerEvent.Receipt(t, it)) }
            t in FILE_FRAMES -> frame.str("id")?.let { emit(PeerEvent.FileFrame(t, frame)) }
            t == "typing" -> emit(PeerEvent.Typing(frame.str("state") == "start"))
            t == "focus" -> emit(PeerEvent.Focus(frame.str("state")))
            t == "wake" -> emit(PeerEvent.Wake)
            t == "logo" -> emit(PeerEvent.Logo)
            t == "bye" -> emit(PeerEvent.Bye(frame.str("reason") ?: ""))
            t == "devices" -> emit(
                PeerEvent.Devices(
                    login = frame.str("login"),
                    name = frame.str("name"),
                    devices = parseDevices(frame.element("devices")),
                ),
            )

            t == "update" -> emit(PeerEvent.Update(frame.str("version")))
            t == "caps" -> emit(PeerEvent.Caps(focus = frame.bool("focus"), ai = frame.bool("ai")))
            // unknown t → ignored, so a newer peer never breaks this one
        }
    }

    private fun emit(event: PeerEvent) = post(event)

    /**
     * The engine shuts down before the reader threads notice their sockets are
     * gone, so the last event of a closing channel routinely arrives at a dead
     * executor. That is the normal end of a conversation, not a fault.
     */
    private fun post(event: PeerEvent) {
        try {
            dispatch.execute { onEvent(this, event) }
        } catch (_: RejectedExecutionException) {
        }
    }

    /**
     * True while the channel can still take bytes. A peer that quits sends FIN,
     * the reader sees EOF, and this goes false immediately — long before anyone
     * would notice from a write that silently vanished.
     */
    fun writable(): Boolean = !closed && !eof && !socket.isClosed && !socket.isOutputShutdown

    /**
     * Queues a frame. Never blocks, so it is safe from the UI thread; `true`
     * means "accepted on a live channel", which is the same promise node's
     * `socket.write` makes.
     */
    fun sendFrame(frame: JsonObject): Boolean {
        if (!writable()) return false
        return outQueue.offer(Out(encodeFrame(frame), bulk = false, done = null))
    }

    /**
     * Queues a bulk frame, blocking until the wire has room for it. This is the
     * backpressure a file transfer needs and the reason it must never be called
     * from the main thread.
     */
    fun putFrame(frame: JsonObject): Boolean {
        val bytes = encodeFrame(frame)
        while (writable()) {
            if (!bulkPermits.tryAcquire(200, TimeUnit.MILLISECONDS)) continue
            if (!writable()) {
                bulkPermits.release()
                return false
            }
            return outQueue.offer(Out(bytes, bulk = true, done = null))
        }
        return false
    }

    /**
     * Blocks until everything queued so far has left the socket, or the channel
     * dies trying. A peer that quits mid-transfer never reads again, so this can
     * only ever be a bounded wait.
     */
    fun flushed(timeoutMs: Long = 30_000): Boolean {
        if (!writable()) return false
        val latch = CountDownLatch(1)
        if (!outQueue.offer(Out(bytes = null, bulk = false, done = latch))) return false
        return try {
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            false
        }
    }

    /**
     * Returns the message id so the caller can track receipts, or null when the
     * channel is gone and nothing was written. The id may be supplied so a
     * message queued while offline keeps one identity end to end.
     */
    fun send(text: String, ts: Long = System.currentTimeMillis(), id: String = Wire.newMessageId()): String? {
        val ok = sendFrame(
            buildJsonObject {
                put("t", "msg")
                put("id", id)
                put("text", text)
                put("ts", ts)
            },
        )
        return if (ok) id else null
    }

    fun sendReceipt(kind: String, id: String): Boolean {
        require(kind in RECEIPTS) { "unknown receipt: $kind" }
        return sendFrame(
            buildJsonObject {
                put("t", kind)
                put("id", id)
            },
        )
    }

    fun destroy() {
        if (closed) return
        closed = true
        // The writer parks on an empty queue, so closing the socket alone would
        // leave it there: the stop signal is what actually ends it.
        outQueue.offer(Out(bytes = null, bulk = false, done = null))
        try {
            socket.close()
        } catch (_: IOException) {
            // Already gone; the reader thread reports the close either way.
        }
    }

    private companion object {
        /**
         * How many bulk frames may be in flight before a transfer has to wait.
         * At 48 KiB per chunk this is a few hundred KiB of slack: enough to keep
         * the wire busy, small enough that a stalled peer cannot make the app
         * buffer a whole file twice over.
         */
        const val BULK_WINDOW = 6
    }
}

private fun parseDevices(element: kotlinx.serialization.json.JsonElement?): List<PeerDevice> {
    val array = element as? JsonArray ?: return emptyList()
    return array.mapNotNull { entry ->
        val obj = entry as? JsonObject ?: return@mapNotNull null
        val ips = (obj["ips"] as? JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
            ?.map(::normalizeIp)
            ?: emptyList()
        PeerDevice(host = obj.str("host"), dns = obj.str("dns"), ips = ips)
    }
}

/** Port of normalizeIp from src/addr.js: strip a zone id and the v6 v4-mapped prefix. */
fun normalizeIp(addr: String?): String {
    if (addr.isNullOrEmpty()) return addr ?: ""
    var a = addr
    val pct = a.indexOf('%')
    if (pct != -1) a = a.substring(0, pct)
    if (a.startsWith("::ffff:")) a = a.removePrefix("::ffff:")
    return a
}

/** 100.64.0.0/10 — the CGNAT range Tailscale hands out. */
fun isTailnetIp(ip: String): Boolean {
    val parts = ip.split('.')
    if (parts.size != 4) return false
    val a = parts[0].toIntOrNull() ?: return false
    val b = parts[1].toIntOrNull() ?: return false
    return a == 100 && b in 64..127
}
