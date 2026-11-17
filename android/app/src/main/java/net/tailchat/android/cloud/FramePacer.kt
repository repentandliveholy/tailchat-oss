package net.tailchat.android.cloud

import android.os.SystemClock
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The hub disconnects a connection outright once it sends more than 60
 * frames in any rolling second (`withinRate` in `src/cloud/hub.js`) — and it
 * is one counter *per socket*, not per feature. [SyncEngine]'s message/edit/
 * reaction/delete outbox and receipt queue used to pace themselves against
 * that ceiling with a private counter, while [ServiceCloudController]'s P2P
 * file-transfer chunk loop paced itself independently with its own 20ms
 * floor (up to 50 frames/s on its own). Both stayed under 60 in isolation,
 * but a file send running *alongside* ordinary chat traffic could put their
 * combined rate well past it — the socket then dropped with `rate_limited`
 * ("too many attempts"), taking down whatever message happened to be
 * mid-flight with it, for no reason visible from the chat itself. One shared
 * instance, acquired before every outbound `k:"frame"` path regardless of
 * which feature sends it, is what keeps the *connection's* total under
 * budget rather than each caller's own slice of it: message/edit/reaction/
 * delete/read-receipt/typing sends, file-transfer chunks, and the single
 * `/ping`/`/wake` frames and their answers.
 *
 * The frames-per-second count is only half of it. [CloudSocket.Connection]'s
 * `send` is OkHttp's, which is non-blocking: it appends to the socket's own
 * message queue and returns true. A writer that only counts its own calls
 * therefore measures *frames handed over*, not *frames on the wire*, and when
 * the peer stops reading — a TCP zero window on a mobile link, a VPN
 * renegotiating, a Doze window, a writer starved by the CPU — the queue fills
 * and then flushes all at once the moment it unblocks. The hub's window is a
 * tumbling 1000 ms bucket, so ninety frames that arrive in the same tick are
 * ninety frames in one window: a `rate_limited` close for a client that never
 * sent them faster than 37.5/second. [awaitDrain] is the other half — see it,
 * and note that it is applied by every caller *before* `acquire`, so the frame
 * budget is spent on frames that had a chance to leave.
 *
 * [acquire] is called from both [SyncEngine] (`Dispatchers.Main.immediate`)
 * and the file-transfer loop (`Dispatchers.IO`), so the window state is
 * mutex-guarded rather than plain vars — two callers landing on different
 * threads in the same instant must not race the same counter.
 */
class FramePacer(
    private val budget: Int = PACE_BUDGET,
    private val windowMs: Long = PACE_WINDOW_MS,
    private val elapsedRealtime: () -> Long = SystemClock::elapsedRealtime,
) {
    private val mutex = Mutex()
    private var windowStartedAt = 0L
    private var windowFrames = 0

    suspend fun acquire() = mutex.withLock {
        val now = elapsedRealtime()
        if (now - windowStartedAt >= windowMs) {
            windowStartedAt = now
            windowFrames = 0
        }
        if (windowFrames >= budget) {
            delay(windowMs - (now - windowStartedAt))
            windowStartedAt = elapsedRealtime()
            windowFrames = 0
        }
        windowFrames += 1
    }

    /** A fresh connection starts with a fresh budget: a stale window from a
     *  socket that is no longer live must never throttle the next one. Plain
     *  (not mutex-guarded): called only from [SyncEngine.forget]'s
     *  synchronous teardown, where no frame send is meant to be in flight —
     *  a benign race here just means the next window starts a beat early. */
    fun reset() {
        windowStartedAt = 0L
        windowFrames = 0
    }

    companion object {
        // Comfortably under the hub's 60-per-second close, shared by every
        // frame-emitting feature on the connection.
        const val PACE_BUDGET = 15
        const val PACE_WINDOW_MS = 400L
    }
}

/**
 * Bytes the socket may hold unsent before a frame-emitting loop pauses — the
 * same 512 KiB high-water mark `web/cloud/app.js`'s `waitForSocketDrain` uses,
 * and low enough that the queue can never be the thing that puts the
 * connection over the hub's per-second ceiling.
 */
const val QUEUE_HIGH_WATER_BYTES = 512L * 1024

/** How often a paused writer re-checks the queue. One frame of the pacer's own
 *  window is 26 ms, so this is the smallest delay that cannot itself become a
 *  rate of its own. */
private const val DRAIN_POLL_MS = 16L

/**
 * Waits for this connection's own send queue to fall back under [highWaterBytes]
 * before the caller hands OkHttp another frame.
 *
 * Deliberately unbounded — see [FramePacer]'s doc for why the byte count, not
 * the frame count, is what protects the connection. A socket that never drains
 * is a socket that is already dead: the writer parks here instead of filling
 * OkHttp's queue (which is itself bounded at 16 MiB), the liveness probe
 * notices that nothing is answered and replaces the connection, and
 * `invalidate()` cancels this coroutine. Waiting is the conservative failure —
 * a frame held is a message still queued and visible, a frame handed to a
 * stalled socket is memory the platform will kill the process over.
 *
 * A null receiver — no live connection — returns at once: there is nothing to
 * drain and the caller's own `send` will refuse the frame.
 */
internal suspend fun CloudSocket.Connection?.awaitDrain(highWaterBytes: Long = QUEUE_HIGH_WATER_BYTES) {
    val conn = this ?: return
    while (conn.queuedBytes() > highWaterBytes) delay(DRAIN_POLL_MS)
}
