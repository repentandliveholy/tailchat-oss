package net.tailchat.proto

/**
 * Ports of src/typing.js, src/presence.js and src/outbox.js. Timing is supplied
 * by the caller so the app can drive them from its own scheduler and a test can
 * drive them from a clock it controls.
 */

const val TYPING_THROTTLE_MS = 2_000L
const val TYPING_IDLE_MS = 3_000L
const val IDLE_AFTER_MS = 30_000L
const val AWAY_AFTER_MS = 5 * 60_000L

/**
 * Emits at most one `start` per throttle window and exactly one `stop`, so a
 * fast typist cannot turn every keypress into a frame on the wire.
 */
class TypingSignal(
    private val send: (String) -> Unit,
    private val throttleMs: Long = TYPING_THROTTLE_MS,
    private val idleMs: Long = TYPING_IDLE_MS,
    private val now: () -> Long = System::currentTimeMillis,
    private val schedule: (Long, () -> Unit) -> Cancellable,
) {
    private var active = false
    private var lastSentAt = Long.MIN_VALUE
    private var idleTimer: Cancellable? = null

    fun keystroke() {
        val at = now()
        if (!active || at - lastSentAt >= throttleMs) {
            lastSentAt = at
            active = true
            send("start")
        }
        idleTimer?.cancel()
        idleTimer = schedule(idleMs) {
            idleTimer = null
            if (active) {
                active = false
                send("stop")
            }
        }
    }

    fun stop() {
        idleTimer?.cancel()
        idleTimer = null
        if (!active) return
        active = false
        send("stop")
    }

    fun isActive(): Boolean = active
}

fun interface Cancellable {
    fun cancel()
}

/**
 * ACTIVE means the person is at the keyboard this minute, not merely that the
 * app is on screen. A visible chat nobody touches is idle, and eventually away,
 * because a reading human is indistinguishable from a phone left on a table —
 * the peer deserves to know which.
 */
class PresenceSignal(
    private val send: (String) -> Unit,
    private val idleMs: Long = IDLE_AFTER_MS,
    private val awayMs: Long = AWAY_AFTER_MS,
    private val schedule: (Long, () -> Unit) -> Cancellable,
) {
    private var state = "active"
    private var focused = true
    private var idleTimer: Cancellable? = null
    private var awayTimer: Cancellable? = null

    private fun cancel() {
        idleTimer?.cancel()
        awayTimer?.cancel()
        idleTimer = null
        awayTimer = null
    }

    private fun report(next: String) {
        if (next == state) return
        state = next
        send(state)
    }

    private fun armIdle() {
        idleTimer?.cancel()
        idleTimer = schedule(idleMs) {
            idleTimer = null
            report("idle")
            awayTimer = schedule(awayMs) {
                awayTimer = null
                report("away")
            }
        }
    }

    private fun armAway() {
        awayTimer?.cancel()
        awayTimer = schedule(awayMs) {
            awayTimer = null
            report("away")
        }
    }

    /** A keystroke or a tap while the chat is on screen. */
    fun activity() {
        if (!focused) return
        cancel()
        report("active")
        armIdle()
    }

    fun focus() {
        focused = true
        cancel()
        report("active")
        armIdle()
    }

    fun blur() {
        focused = false
        cancel()
        report("idle")
        armAway()
    }

    fun current(): String = state

    fun destroy() = cancel()
}

/** A 0.10.x peer only knew "inactive": idle is the honest reading of that. */
fun readPresenceState(value: String?): String? = when (value) {
    "inactive" -> "idle"
    "active", "idle", "away" -> value
    else -> null
}

/**
 * Holds messages composed while the peer is unreachable so they go out, in
 * order, as soon as a channel is established again.
 */
class Outbox(private val limit: Int = 500) {
    data class Item(val text: String, val ts: Long, val id: String)

    private val items = ArrayDeque<Item>()

    fun add(text: String, ts: Long = System.currentTimeMillis(), id: String = Wire.newMessageId()): Int {
        items.addLast(Item(text, ts, id))
        // Bound the queue: an unreachable peer must not grow memory without end.
        while (items.size > limit) items.removeFirst()
        return items.size
    }

    fun size(): Int = items.size

    fun pending(): List<Item> = items.toList()

    /**
     * [send] returns false when the link died again; the untried remainder stays
     * queued so nothing is delivered twice or silently dropped.
     */
    fun flush(send: (Item) -> Boolean): Int {
        var delivered = 0
        while (items.isNotEmpty()) {
            if (!send(items.first())) break
            items.removeFirst()
            delivered++
        }
        return delivered
    }
}
