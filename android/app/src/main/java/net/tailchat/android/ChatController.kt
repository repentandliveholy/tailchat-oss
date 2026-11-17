package net.tailchat.android

import android.net.Uri
import kotlinx.coroutines.flow.StateFlow

/**
 * Everything the screen may do to the conversation. The implementation lives in
 * the service, so the UI never owns a socket and can be recreated at will.
 */
interface ChatController {
    val state: StateFlow<ChatState>

    /** Queues when offline; the outbox flushes in order once a channel exists. */
    fun send(text: String)

    /** One per keypress: throttled into `typing` frames underneath. */
    fun keystroke()

    fun stopTyping()

    /** The transcript is on screen and a human could see it: release read receipts. */
    fun markRead()

    fun sendFile(uri: Uri)

    /** Nudge the peer's client into the foreground. */
    fun wake()

    fun sendLogo()

    fun clearTranscript()

    fun applySettings(
        name: String,
        peerHost: String,
        peerPort: Int,
        listenPort: Int,
        keepTranscript: Boolean,
    )

    /** Move the conversation to one of the peer's other devices. */
    fun retarget(host: String, port: Int)
}
