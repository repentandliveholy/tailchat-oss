package net.tailchat.android

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import net.tailchat.proto.Cancellable
import net.tailchat.proto.DEFAULT_MAX_BYTES
import net.tailchat.proto.FileReceiver
import net.tailchat.proto.Outbox
import net.tailchat.proto.PeerEvent
import net.tailchat.proto.PresenceSignal
import net.tailchat.proto.Rendezvous
import net.tailchat.proto.RzEvent
import net.tailchat.proto.TypingSignal
import net.tailchat.proto.Wire
import net.tailchat.proto.fileDenyFrame
import net.tailchat.proto.ownTailnetIps
import net.tailchat.proto.readPresenceState
import net.tailchat.proto.sendFile
import net.tailchat.proto.str
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/** What the service turns into a notification. */
sealed interface Notify {
    data class Incoming(val author: String, val text: String) : Notify
    data object Wake : Notify
    data class FileArrived(val name: String, val location: String) : Notify
}

private const val MAX_ENTRIES = 2000

/**
 * Everything between the wire and the screen: receipts, the outbox, typing and
 * presence, and where a received file lands. The equivalent of src/cli.js minus
 * the terminal — which is most of what that file is.
 *
 * State is published through a [StateFlow] and every mutation goes through
 * `update`, because the callers are three different threads: the rendezvous
 * engine, the file worker, and whichever one the UI is on.
 */
class ChatEngine(
    private val context: Context,
    private val onNotify: (Notify) -> Unit,
) : ChatController {

    private val settings = Settings(context)
    private val transcript = Transcript(context)
    private val _state = MutableStateFlow(ChatState())
    override val state: StateFlow<ChatState> = _state.asStateFlow()

    private val timers = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "tailchat-timers").apply { isDaemon = true }
    }

    /** File work is bulk I/O and blocking writes; it never shares a thread. */
    private val worker = Executors.newSingleThreadExecutor { r ->
        Thread(r, "tailchat-files").apply { isDaemon = true }
    }

    private val outbox = Outbox()
    // Inbound files spool here rather than into memory; the directory is the P2P
    // engine's alone, since the receiver clears leftovers from a previous process.
    private val receiver = FileReceiver(File(context.cacheDir, "file-in"))
    private val unread = LinkedHashSet<String>()

    @Volatile private var rz: Rendezvous? = null
    @Volatile private var foreground = false
    private var noteSeq = 0L

    private val typing = TypingSignal(
        send = { signal -> sendIfOnline { put("t", "typing"); put("state", signal) } },
        schedule = ::later,
    )

    private val presence = PresenceSignal(
        send = { signal -> sendIfOnline { put("t", "focus"); put("state", signal) } },
        schedule = ::later,
    )

    fun start() {
        _state.update {
            it.copy(
                configured = settings.configured,
                peerHost = settings.peerHost,
                tailnetAddress = tailnetAddress(),
            )
        }
        // Reading the transcript is disk I/O and start() is called from the
        // service's onCreate, i.e. the main thread. The history simply appears a
        // moment later; it is prepended so a message that arrives first stays
        // last, where it belongs.
        worker.execute {
            val history = transcript.load()
            if (history.isNotEmpty()) _state.update { it.copy(entries = history + it.entries) }
        }
        openChannel()
    }

    fun shutdown() {
        typing.stop()
        presence.destroy()
        rz?.shutdown()
        rz = null
        timers.shutdownNow()
        worker.shutdownNow()
    }

    /** The chat is on screen, or it is not. Drives presence and read receipts. */
    fun setForeground(visible: Boolean) {
        if (foreground == visible) return
        foreground = visible
        if (visible) {
            presence.focus()
            markRead()
        } else {
            typing.stop()
            presence.blur()
        }
    }

    // ---- ChatController ---------------------------------------------------

    override fun send(text: String) {
        val body = text.trimEnd()
        if (body.isEmpty()) return
        val id = Wire.newMessageId()
        val ts = System.currentTimeMillis()
        val sent = rz?.send(body, ts, id) != null
        if (!sent) outbox.add(body, ts, id)
        addEntry(
            Entry.Msg(
                key = id,
                id = id,
                mine = true,
                author = settings.displayName,
                text = body,
                ts = ts,
                receipt = if (sent) Receipt.Sent else Receipt.Queued,
            ),
        )
        typing.stop()
        presence.activity()
        _state.update { it.copy(queued = outbox.size()) }
    }

    override fun keystroke() {
        typing.keystroke()
        presence.activity()
    }

    override fun stopTyping() = typing.stop()

    override fun markRead() {
        if (unread.isEmpty()) return
        val link = rz ?: return
        for (id in unread.toList()) link.sendReceipt("read", id)
        unread.clear()
    }

    override fun sendFile(uri: Uri) {
        worker.execute {
            val picked = readForSending(context, uri, DEFAULT_MAX_BYTES).getOrElse { error ->
                note(error.message ?: "could not read that file")
                return@execute
            }
            val name = picked.name
            val size = picked.size
            val id = Wire.newMessageId()
            val key = "file-out-$id"
            addEntry(
                Entry.FileEntry(
                    key = key,
                    id = id,
                    mine = true,
                    name = name,
                    size = size,
                    ts = System.currentTimeMillis(),
                    transfer = Transfer.Progress(0, size),
                ),
            )
            val link = rz
            if (link == null || !link.isOnline()) {
                updateTransfer(key, Transfer.Failed("no channel"))
                return@execute
            }
            // The document is never held: sendFile opens it once to digest it and once
            // to send it, so a null here is the same read failure the note above covers.
            val failure = sendFile(
                link,
                id,
                name,
                size,
                openStream = { context.contentResolver.openInputStream(uri) },
            ) { done, total ->
                updateTransfer(key, Transfer.Progress(done, total))
            }
            updateTransfer(key, if (failure == null) Transfer.Complete("sent") else Transfer.Failed(failure))
        }
    }

    override fun wake() {
        if (sendIfOnline { put("t", "wake") }) note("nudged ${peerLabel()}")
        else note("cannot nudge ${peerLabel()}: offline")
    }

    override fun sendLogo() {
        val drawn = sendIfOnline { put("t", "logo") }
        note(banner(), monospace = true)
        if (!drawn) note("offline, so only this screen saw it")
    }

    override fun clearTranscript() {
        transcript.clear()
        _state.update { it.copy(entries = emptyList()) }
    }

    override fun applySettings(
        name: String,
        peerHost: String,
        peerPort: Int,
        listenPort: Int,
        keepTranscript: Boolean,
    ) {
        val restart = name != settings.displayName ||
            peerHost != settings.peerHost ||
            peerPort != settings.peerPort ||
            listenPort != settings.listenPort
        settings.displayName = name
        settings.peerHost = peerHost
        settings.peerPort = peerPort
        settings.listenPort = listenPort
        settings.keepTranscript = keepTranscript
        _state.update { it.copy(configured = settings.configured, peerHost = settings.peerHost) }
        if (restart) openChannel()
    }

    override fun retarget(host: String, port: Int) {
        settings.peerHost = host
        settings.peerPort = port
        _state.update { it.copy(peerHost = host, configured = settings.configured) }
        val link = rz
        if (link == null) openChannel() else link.retarget(host, port)
        note("talking to $host:$port")
    }

    // ---- channel ---------------------------------------------------------

    private fun openChannel() {
        rz?.shutdown()
        rz = null
        unread.clear()
        receiver.abortAll()
        _state.update {
            it.copy(
                link = Link.Offline,
                peerName = null,
                peerVersion = null,
                remoteAddress = null,
                peerTyping = false,
                peerPresence = null,
                peerTracksFocus = false,
                listenAddress = null,
                tailnetAddress = tailnetAddress(),
            )
        }
        val host = settings.peerHost
        if (host.isBlank()) {
            note("no peer set yet — open settings and name one")
            return
        }
        val link = Rendezvous(
            peerHost = host,
            peerPort = settings.peerPort,
            port = settings.listenPort,
            name = settings.displayName,
        ) { event -> onRzEvent(event) }
        rz = link
        link.start()
    }

    private fun onRzEvent(event: RzEvent) {
        when (event) {
            is RzEvent.Online -> {
                _state.update {
                    it.copy(
                        link = Link.Online,
                        peerName = event.peerName,
                        peerVersion = event.peerVersion,
                        remoteAddress = event.remoteAddress,
                    )
                }
                note("${event.peerName} is here (${event.remoteAddress ?: "?"})")
                // Tell the peer what this client can do, so a missing ✓✓ is
                // explained rather than mysterious. It has no AI of its own.
                sendIfOnline { put("t", "caps"); put("focus", true); put("ai", false) }
                sendIfOnline { put("t", "focus"); put("state", presence.current()) }
                flushOutbox()
                if (foreground) markRead()
            }

            RzEvent.Offline -> {
                _state.update { it.copy(link = Link.Offline, peerTyping = false, remoteAddress = null) }
                note("${peerLabel()} went away")
            }

            is RzEvent.Reaching -> _state.update {
                // Reaching is only news while nothing is established: an
                // in-flight dial beside a live channel must not downgrade it.
                if (it.link == Link.Online) it
                else it.copy(link = if (event.active) Link.Reaching else Link.Offline)
            }

            is RzEvent.Inbound -> Unit // 'online' says it better, once hello lands
            is RzEvent.Rejected -> note("refused a connection from ${event.ip}: not ${event.expected}")
            is RzEvent.Listening -> _state.update {
                it.copy(listenAddress = event.address, tailnetAddress = tailnetAddress())
            }

            is RzEvent.ListenError -> note("cannot listen on port ${settings.listenPort}: ${event.error}")
            is RzEvent.Unresolved -> note("cannot resolve ${event.peer} — is Tailscale connected?")
            is RzEvent.Peer -> onPeerEvent(event.event)
        }
    }

    private fun onPeerEvent(event: PeerEvent) {
        when (event) {
            is PeerEvent.Message -> {
                addEntry(
                    Entry.Msg(
                        key = event.id ?: "in-${System.nanoTime()}",
                        id = event.id,
                        mine = false,
                        author = event.name,
                        text = event.text,
                        ts = event.ts,
                        receipt = Receipt.Read,
                    ),
                )
                _state.update { it.copy(peerTyping = false) }
                val id = event.id
                if (id != null) {
                    rz?.sendReceipt("ack", id)
                    // "Read" must mean a human could actually see it, so it waits
                    // for the chat to be on screen rather than merely delivered.
                    if (foreground) rz?.sendReceipt("read", id) else unread.add(id)
                }
                if (!foreground) onNotify(Notify.Incoming(event.name, event.text))
            }

            is PeerEvent.Ai -> {
                addEntry(
                    Entry.Msg(
                        key = "ai-${System.nanoTime()}",
                        id = null,
                        mine = false,
                        author = event.name,
                        text = event.text,
                        ts = event.ts,
                        receipt = Receipt.Read,
                    ),
                )
                if (!foreground) onNotify(Notify.Incoming(event.name, event.text))
            }

            is PeerEvent.Receipt -> markReceipt(
                event.id,
                if (event.kind == "read") Receipt.Read else Receipt.Acked,
            )

            is PeerEvent.Typing -> _state.update { it.copy(peerTyping = event.start) }
            is PeerEvent.Focus -> _state.update { it.copy(peerPresence = readPresenceState(event.state)) }
            is PeerEvent.Caps -> _state.update { it.copy(peerTracksFocus = event.focus) }
            PeerEvent.Wake -> onNotify(Notify.Wake)
            PeerEvent.Logo -> note(banner(), monospace = true)
            is PeerEvent.Bye -> note(
                if (event.reason == "replaced") "${peerLabel()} moved the chat to another device"
                else "${peerLabel()} left${if (event.reason.isEmpty()) "" else ": ${event.reason}"}",
            )

            is PeerEvent.Update -> note("${peerLabel()} runs ${event.version ?: "?"}; this app is ${Wire.VERSION}")
            is PeerEvent.Devices -> {
                _state.update { it.copy(peerDevices = event.devices) }
                rz?.trustDeviceIps(event.devices.flatMap { it.ips })
            }

            is PeerEvent.FileFrame -> onFileFrame(event)
            is PeerEvent.Hello -> Unit // consumed by the rendezvous
            PeerEvent.Closed -> Unit //  ditto
        }
    }

    private fun onFileFrame(event: PeerEvent.FileFrame) {
        val frame = event.frame
        val id = frame.str("id") ?: return
        when (event.kind) {
            "file-offer" -> when (val offer = receiver.offer(frame)) {
                is FileReceiver.Offer.Refused -> {
                    rz?.sendFrame(fileDenyFrame(id, offer.reason))
                    note("refused an incoming file: ${offer.reason}")
                }

                is FileReceiver.Offer.Accepted -> addEntry(
                    Entry.FileEntry(
                        key = "file-in-$id",
                        id = id,
                        mine = false,
                        name = offer.name,
                        size = offer.size,
                        ts = System.currentTimeMillis(),
                        transfer = Transfer.Progress(0, offer.size),
                    ),
                )
            }

            "file-chunk" -> when (val chunk = receiver.chunk(frame)) {
                is FileReceiver.Chunk.Failed -> updateTransfer("file-in-$id", Transfer.Failed(chunk.reason))
                is FileReceiver.Chunk.Progress -> updateTransfer(
                    "file-in-$id",
                    Transfer.Progress(chunk.received, chunk.size),
                )
            }

            "file-done" -> when (val done = receiver.done(frame)) {
                is FileReceiver.Done.Failed -> updateTransfer("file-in-$id", Transfer.Failed(done.reason))
                is FileReceiver.Done.Complete -> worker.execute {
                    // Shared storage, not app-private: a file nothing else can
                    // open has arrived without arriving. The spool file is consumed
                    // here, so the cache does not keep a second copy of every arrival.
                    saveToDownloads(context, done.name, done.file)
                        .onSuccess { location ->
                            updateTransfer("file-in-$id", Transfer.Complete(location))
                            onNotify(Notify.FileArrived(done.name, location))
                        }
                        .onFailure { error ->
                            updateTransfer("file-in-$id", Transfer.Failed(error.message ?: "could not save it"))
                        }
                }
            }

            "file-deny" -> {
                val reason = frame.str("reason") ?: "no reason given"
                updateTransfer("file-out-$id", Transfer.Failed(reason))
                note("${peerLabel()} refused the file: $reason")
            }
        }
    }

    private fun flushOutbox() {
        val link = rz ?: return
        outbox.flush { item ->
            val ok = link.send(item.text, item.ts, item.id) != null
            if (ok) markReceipt(item.id, Receipt.Sent)
            ok
        }
        _state.update { it.copy(queued = outbox.size()) }
    }

    // ---- entries ---------------------------------------------------------

    private fun addEntry(entry: Entry) {
        _state.update { current ->
            val grown = current.entries + entry
            val next = if (grown.size > MAX_ENTRIES) grown.subList(grown.size - MAX_ENTRIES, grown.size) else grown
            current.copy(entries = next)
        }
        persist(entry)
    }

    /**
     * Appending is disk I/O and the callers include the UI thread, so it is
     * queued behind the same worker that already serialises file work — which
     * also means the file is only ever written from one thread.
     */
    private fun persist(entry: Entry) {
        if (!settings.keepTranscript) return
        try {
            worker.execute { transcript.append(entry) }
        } catch (_: RejectedExecutionException) {
            // Shutting down: the entry is on screen, and that is enough.
        }
    }

    private fun note(text: String, monospace: Boolean = false) {
        addEntry(
            Entry.Note(
                key = "note-${noteSeq++}",
                text = text,
                ts = System.currentTimeMillis(),
                monospace = monospace,
            ),
        )
    }

    private fun markReceipt(id: String, receipt: Receipt) {
        _state.update { current ->
            var changed = false
            val next = current.entries.map { entry ->
                if (entry !is Entry.Msg || !entry.mine || entry.id != id) return@map entry
                // Never walk a receipt backwards: a late ack after a read would
                // otherwise turn ✓✓ back into ✓.
                if (entry.receipt != Receipt.Queued && receipt.ordinal <= entry.receipt.ordinal) {
                    entry
                } else {
                    changed = true
                    entry.copy(receipt = receipt)
                }
            }
            if (changed) current.copy(entries = next) else current
        }
        // Otherwise a reopened transcript shows ✓ against a message the peer
        // read hours ago: the load dedupes by key, so re-appending is enough.
        val settled = _state.value.entries.firstOrNull { it is Entry.Msg && it.id == id }
        if (settled is Entry.Msg && settled.receipt == receipt) persist(settled)
    }

    private fun updateTransfer(key: String, transfer: Transfer) {
        _state.update { current ->
            var changed = false
            val next = current.entries.map { entry ->
                if (entry is Entry.FileEntry && entry.key == key) {
                    changed = true
                    entry.copy(transfer = transfer)
                } else {
                    entry
                }
            }
            if (changed) current.copy(entries = next) else current
        }
        // Only a settled transfer is worth remembering; a progress bar is not.
        if (transfer is Transfer.Complete || transfer is Transfer.Failed) {
            val entry = _state.value.entries.firstOrNull { it.key == key }
            if (entry is Entry.FileEntry) persist(entry)
        }
    }

    // ---- helpers ---------------------------------------------------------

    private fun tailnetAddress(): String? = ownTailnetIps().firstOrNull { !it.contains(':') }

    private fun peerLabel(): String = _state.value.peerName ?: settings.peerHost.ifBlank { "the peer" }

    private fun sendIfOnline(build: JsonObjectBuilder.() -> Unit): Boolean =
        rz?.sendFrame(buildJsonObject(build)) ?: false

    private fun later(delayMs: Long, block: () -> Unit): Cancellable {
        val handle = try {
            timers.schedule(block, delayMs, TimeUnit.MILLISECONDS)
        } catch (_: RejectedExecutionException) {
            null
        }
        return Cancellable { handle?.cancel(false) }
    }

    /**
     * The desktop replays ASCII art on /logo. Reproducing its exact drawing on a
     * phone would be a lie about the width available, so this is the same gesture
     * at a size that fits — built around the label so the rules always line up.
     */
    private fun banner(): String {
        val label = "tailchat · android · ${Wire.VERSION}"
        val rule = "─".repeat(label.length + 2)
        return "╭$rule╮\n│ $label │\n╰$rule╯"
    }
}
