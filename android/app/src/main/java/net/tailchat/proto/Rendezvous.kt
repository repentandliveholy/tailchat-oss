package net.tailchat.proto

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

sealed interface RzEvent {
    data class Online(val peerName: String, val peerVersion: String?, val remoteAddress: String?) : RzEvent
    data object Offline : RzEvent
    data class Reaching(val active: Boolean) : RzEvent
    data class Inbound(val ip: String) : RzEvent
    data class Rejected(val ip: String, val expected: String) : RzEvent
    data class Listening(val address: String) : RzEvent
    data class ListenError(val error: String) : RzEvent
    data class Unresolved(val peer: String) : RzEvent

    /** An event from the channel currently in charge. */
    data class Peer(val event: PeerEvent) : RzEvent
}

data class Arbitration(
    val active: Connection?,
    val activeConnId: String?,
    val destroy: List<Connection>,
    val event: String?,
)

/** Lexicographically smaller connId wins the dedup — identical on both ends. */
fun connIdWins(a: String, b: String): Boolean = a < b

/**
 * Pure, order-independent channel selection, ported from src/rendezvous.js. Both
 * peers run this identically and a physical channel's connId is the same on both
 * ends, so min(connId) selects the same channel on both sides — no split, no
 * leader protocol. One exception: a candidate from a *different* address is
 * another device of the same person rather than a duplicate of this channel, so
 * the newcomer takes over and the old device is told it was replaced.
 */
fun arbitrate(
    active: Connection?,
    activeConnId: String?,
    activeAddress: String?,
    candidate: Connection,
    candidateConnId: String,
    candidateAddress: String?,
): Arbitration {
    if (active == null) {
        return Arbitration(candidate, candidateConnId, emptyList(), "online")
    }
    if (candidate === active) {
        return Arbitration(active, activeConnId, emptyList(), null)
    }
    if (!activeAddress.isNullOrEmpty() && !candidateAddress.isNullOrEmpty() && candidateAddress != activeAddress) {
        return Arbitration(candidate, candidateConnId, listOf(active), "replaced")
    }
    if (activeConnId != null && connIdWins(candidateConnId, activeConnId)) {
        return Arbitration(candidate, candidateConnId, listOf(active), "swap")
    }
    return Arbitration(active, activeConnId, listOf(candidate), null)
}

/** The tailnet addresses this device holds, i.e. proof Tailscale is up. */
fun ownTailnetIps(): List<String> {
    val out = mutableListOf<String>()
    val ifaces = try {
        NetworkInterface.getNetworkInterfaces() ?: return out
    } catch (_: Exception) {
        return out
    }
    for (iface in ifaces) {
        for (addr in iface.inetAddresses) {
            val ip = normalizeIp(addr.hostAddress)
            if (ip.contains(':')) {
                if (ip.lowercase().startsWith("fd7a:115c:a1e0:")) out.add(ip)
            } else if (isTailnetIp(ip)) {
                out.add(ip)
            }
        }
    }
    return out
}

fun byeFrame(reason: String): JsonObject = buildJsonObject {
    put("t", "bye")
    put("reason", reason)
}

private const val RETRY_MS = 1_000L
private const val RETRY_MAX_MS = 30_000L
private const val HELLO_MS = 5_000L
private const val DIAL_TIMEOUT_MS = 10_000

/**
 * The symmetric rendezvous: listen and dial at the same time, then arbitrate so
 * exactly one of the two channels survives. Port of src/rendezvous.js.
 *
 * All mutable state lives on [engine], a single thread, which is what makes the
 * reference logic transplantable without a single lock. Anything that blocks —
 * DNS, `connect`, `accept` — runs elsewhere and posts its result back.
 */
class Rendezvous(
    peerHost: String,
    peerPort: Int,
    private val port: Int,
    private val name: String,
    /**
     * Where to listen. Null means "the tailnet address if there is one", which
     * is what the app wants; an explicit value is for a test that has to reach
     * this listener over loopback.
     */
    private val bindHost: String? = null,
    private val onEvent: (RzEvent) -> Unit,
) {
    private val engine: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "tailchat-engine").apply { isDaemon = true }
    }

    /** Two threads: a slow dial must never hold up the next name lookup. */
    private val net = Executors.newFixedThreadPool(2) { r ->
        Thread(r, "tailchat-net").apply { isDaemon = true }
    }

    private var peerHost = peerHost
    private var target = Target(peerHost, peerPort)
    private var active: Connection? = null
    private var activeConnId: String? = null
    private var outgoing: Connection? = null
    private var dialing = false
    private var retry: ScheduledFuture<*>? = null
    private var retryDelay = RETRY_MS
    private var listenRetry: ScheduledFuture<*>? = null
    private var server: ServerSocket? = null
    private var stopped = false
    private var allow = mutableSetOf<String>()

    /**
     * Addresses learned from the peer's own `devices` frame, plus anything the
     * user pinned. A phone has no tailscaled to ask "who owns this address", so
     * the peer's announcement over an already-authorised channel is the only
     * roster there is; without it a peer answering from a second machine is
     * turned away for the rest of the session.
     */
    private val extraAllow = mutableSetOf<String>()
    private val reportedRejections = mutableSetOf<String>()
    private val conns = mutableSetOf<Connection>()
    private val helloTimers = mutableMapOf<Connection, ScheduledFuture<*>>()

    data class Target(val host: String, val port: Int)

    fun start() = post {
        if (stopped) return@post
        resolveAllow {
            listenOnce()
            connectOnce()
        }
    }

    fun stop() = post { shutdownState() }

    fun shutdown() {
        post { shutdownState() }
        engine.shutdown()
        net.shutdownNow()
    }

    /**
     * The engine is shut down while accept and reader threads are still alive,
     * so work posted from them lands on a dead executor as a matter of course.
     * That is a conversation ending, not a fault, and it must not crash a thread
     * or spray stack traces over the log.
     */
    private fun post(block: () -> Unit) {
        try {
            engine.execute(block)
        } catch (_: RejectedExecutionException) {
        }
    }

    private fun postDelayed(delayMs: Long, block: () -> Unit): ScheduledFuture<*>? = try {
        engine.schedule(block, delayMs, TimeUnit.MILLISECONDS)
    } catch (_: RejectedExecutionException) {
        null
    }

    private fun shutdownState() {
        stopped = true
        stopRetry()
        listenRetry?.cancel(false)
        listenRetry = null
        closeQuietly(server)
        server = null
        for (conn in conns.toList()) conn.destroy()
        conns.clear()
        helloTimers.values.forEach { it.cancel(false) }
        helloTimers.clear()
        active = null
        activeConnId = null
        outgoing = null
    }

    // ---- outbound API, safe from any thread -------------------------------

    fun isOnline(): Boolean = active != null

    fun writable(): Boolean = active?.writable() == true

    fun sendFrame(frame: JsonObject): Boolean = active?.sendFrame(frame) ?: false

    /** Bulk write with backpressure. Blocks; never call it from the UI thread. */
    fun putFrame(frame: JsonObject): Boolean = active?.putFrame(frame) ?: false

    /** Blocks until everything queued has left the socket. */
    fun flushed(timeoutMs: Long = 30_000): Boolean = active?.flushed(timeoutMs) ?: false

    fun send(text: String, ts: Long, id: String): String? = active?.send(text, ts, id)

    fun sendReceipt(kind: String, id: String): Boolean = active?.sendReceipt(kind, id) ?: false

    /** Retarget the outbound dial, e.g. after the user picks another device. */
    fun retarget(host: String, port: Int) = post {
        if (stopped) return@post
        peerHost = host
        target = Target(host, port)
        extraAllow.clear()
        allow.clear()
        reportedRejections.clear()
        // Drop the channel we are moving away from, or the old device keeps the
        // conversation and the new address is never actually tried.
        active?.destroy()
        outgoing?.destroy()
        resolveAllow {
            retryDelay = RETRY_MS
            connectOnce()
        }
    }

    fun trustDeviceIps(ips: Collection<String>) = post {
        for (ip in ips) {
            val norm = normalizeIp(ip)
            if (norm.isNotEmpty()) extraAllow.add(norm)
        }
        allow.addAll(extraAllow)
    }

    // ---- internals -------------------------------------------------------

    /** Resolves off-thread, then runs [then] on the engine thread. */
    private fun resolveAllow(then: () -> Unit) {
        val host = peerHost
        net.execute {
            val ips = try {
                InetAddress.getAllByName(host).map { normalizeIp(it.hostAddress) }
            } catch (_: Exception) {
                emptyList()
            }
            post {
                if (stopped) return@post
                if (host != peerHost) return@post // retargeted mid-flight
                allow = (ips + extraAllow).filter { it.isNotEmpty() }.toMutableSet()
                // A silent forever-connecting screen hides a plain typo or a
                // MagicDNS that never came up, so the failure is said out loud.
                if (allow.isEmpty()) onEvent(RzEvent.Unresolved(host))
                then()
            }
        }
    }

    private fun setOutgoing(conn: Connection?) {
        val was = outgoing != null
        outgoing = conn
        if ((conn != null) != was) onEvent(RzEvent.Reaching(conn != null))
    }

    private fun onCandidate(conn: Connection, channelConnId: String, peerName: String, peerVersion: String?) {
        if (stopped) {
            conn.destroy()
            return
        }
        val previous = active
        val verdict = arbitrate(
            active = active,
            activeConnId = activeConnId,
            activeAddress = active?.remoteAddress,
            candidate = conn,
            candidateConnId = channelConnId,
            candidateAddress = conn.remoteAddress,
        )
        active = verdict.active
        activeConnId = verdict.activeConnId
        if (verdict.event == "replaced" && previous != null) {
            // Tell the displaced device why, or the two trade the channel forever.
            previous.sendFrame(byeFrame("replaced"))
        }
        for (dead in verdict.destroy) dead.destroy()
        if (verdict.event == "online" || verdict.event == "replaced") {
            stopRetry()
            retryDelay = RETRY_MS // a working channel earns a fast retry next time
            onEvent(RzEvent.Online(peerName, peerVersion, active?.remoteAddress))
        }
        // "swap" is the same peer on a better channel: invisible to the caller.
    }

    private fun register(conn: Connection, isOutgoing: Boolean) {
        conns.add(conn)
        postDelayed(HELLO_MS) { conn.destroy() }?.let { helloTimers[conn] = it }
        if (isOutgoing) setOutgoing(conn)
        conn.start()
    }

    private fun handle(conn: Connection, event: PeerEvent) {
        when (event) {
            is PeerEvent.Hello -> {
                helloTimers.remove(conn)?.cancel(false)
                if (conn === outgoing) setOutgoing(null) // now a full candidate
                onCandidate(conn, event.channelConnId, event.peerName, event.peerVersion)
            }

            is PeerEvent.Closed -> {
                conns.remove(conn)
                helloTimers.remove(conn)?.cancel(false)
                when {
                    conn === active -> {
                        active = null
                        activeConnId = null
                        onEvent(RzEvent.Offline)
                        if (!stopped) resolveAllow { scheduleConnect() }
                    }

                    conn === outgoing -> {
                        setOutgoing(null)
                        if (active == null && !stopped) scheduleConnect()
                    }
                    // a losing candidate we destroyed is neither → ignored
                }
            }

            is PeerEvent.Bye -> {
                if (conn !== active) return
                if (event.reason == "replaced") {
                    // The peer moved the conversation to another of our devices;
                    // retrying would only fight that device for the channel.
                    stopped = true
                    stopRetry()
                    closeQuietly(server)
                    server = null
                }
                onEvent(RzEvent.Peer(event))
            }

            is PeerEvent.Devices -> {
                if (conn !== active) return
                for (ip in event.devices.flatMap { it.ips }) if (ip.isNotEmpty()) extraAllow.add(ip)
                allow.addAll(extraAllow)
                onEvent(RzEvent.Peer(event))
            }

            else -> if (conn === active) onEvent(RzEvent.Peer(event))
        }
    }

    /** Engine thread. The blocking part runs on [net] and comes back here. */
    private fun connectOnce() {
        if (stopped || active != null || outgoing != null || dialing) return
        val dest = target
        dialing = true
        net.execute {
            var socket: Socket? = null
            try {
                val s = Socket()
                socket = s
                s.tcpNoDelay = true
                s.connect(InetSocketAddress(dest.host, dest.port), DIAL_TIMEOUT_MS)
            } catch (_: Exception) {
                closeQuietly(socket)
                socket = null
            }
            val ready = socket
            post {
                dialing = false
                if (ready == null) {
                    scheduleConnect()
                    return@post
                }
                // The listener may have won the race while we were dialling.
                if (stopped || active != null || outgoing != null) {
                    closeQuietly(ready)
                    return@post
                }
                register(
                    Connection(ready, name, Wire.newConnId(), initiatedByMe = true, dispatch = engine) { c, e ->
                        handle(c, e)
                    },
                    isOutgoing = true,
                )
            }
        }
    }

    private fun scheduleConnect() {
        if (stopped || active != null || outgoing != null || dialing || retry != null) return
        val delay = retryDelay
        // A peer switched off for an hour cost 3600 attempts before this. The
        // delay grows instead, and that is safe because the rendezvous is
        // symmetric: our listener stays up, so a peer coming back reaches us on
        // its own first attempt without waiting for ours.
        retryDelay = minOf(retryDelay * 2, RETRY_MAX_MS)
        retry = postDelayed(delay) {
            retry = null
            connectOnce()
        }
    }

    private fun stopRetry() {
        retry?.cancel(false)
        retry = null
    }

    private fun listenOnce() {
        if (stopped || server != null) return
        // Bind to the tailnet address when there is one: then nothing off the
        // tailnet can even open a socket to us. Re-detected on every attempt,
        // because Tailscale may come up long after the app did.
        val bind = bindHost ?: ownTailnetIps().firstOrNull { !it.contains(':') }
        val socket = ServerSocket()
        try {
            socket.reuseAddress = true
            socket.bind(if (bind == null) InetSocketAddress(port) else InetSocketAddress(bind, port), 16)
        } catch (err: IOException) {
            closeQuietly(socket)
            onEvent(RzEvent.ListenError(err.message ?: "bind failed"))
            scheduleListen()
            return
        }
        server = socket
        onEvent(RzEvent.Listening("${bind ?: "0.0.0.0"}:${socket.localPort}"))
        Thread({ acceptLoop(socket) }, "tailchat-accept").apply { isDaemon = true }.start()
    }

    private fun scheduleListen() {
        if (stopped || listenRetry != null) return
        listenRetry = postDelayed(RETRY_MS) {
            listenRetry = null
            listenOnce()
        }
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (true) {
            val client = try {
                socket.accept()
            } catch (_: IOException) {
                break // closed by stop(), or the interface went away
            }
            post { onInbound(client) }
        }
        post {
            if (server === socket) {
                server = null
                if (!stopped) scheduleListen()
            }
        }
    }

    private fun onInbound(client: Socket) {
        if (stopped) {
            closeQuietly(client)
            return
        }
        val ip = normalizeIp(client.inetAddress?.hostAddress)
        if (ip !in allow) {
            // A stale instance elsewhere retries every second forever; the fact
            // is worth stating once per source, not once per attempt.
            if (reportedRejections.add(ip)) onEvent(RzEvent.Rejected(ip, peerHost))
            closeQuietly(client)
            return
        }
        client.tcpNoDelay = true
        retryDelay = RETRY_MS // the peer is alive, so stop being patient
        onEvent(RzEvent.Inbound(ip))
        register(
            Connection(client, name, Wire.newConnId(), initiatedByMe = false, dispatch = engine) { c, e ->
                handle(c, e)
            },
            isOutgoing = false,
        )
    }

    private fun closeQuietly(socket: Socket?) {
        try {
            socket?.close()
        } catch (_: IOException) {
        }
    }

    private fun closeQuietly(socket: ServerSocket?) {
        try {
            socket?.close()
        } catch (_: IOException) {
        }
    }
}
