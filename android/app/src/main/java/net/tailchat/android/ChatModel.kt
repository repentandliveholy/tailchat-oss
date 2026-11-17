package net.tailchat.android

import net.tailchat.proto.PeerDevice

enum class Link { Offline, Reaching, Online }

/** How far a message of ours has got. Mirrors the desktop's ·, ✓, ✓✓. */
enum class Receipt { Queued, Sent, Acked, Read, Failed }

sealed interface Transfer {
    data class Progress(val done: Long, val total: Long) : Transfer
    data class Complete(val location: String?) : Transfer
    data class Failed(val reason: String) : Transfer
}

sealed interface Entry {
    val key: String
    val ts: Long

    data class Msg(
        override val key: String,
        val id: String?,
        val mine: Boolean,
        val author: String,
        val text: String,
        override val ts: Long,
        val receipt: Receipt,
    ) : Entry

    /** A line the client itself says: connected, rejected, peer left, and so on. */
    data class Note(
        override val key: String,
        val text: String,
        override val ts: Long,
        val monospace: Boolean = false,
    ) : Entry

    data class FileEntry(
        override val key: String,
        val id: String,
        val mine: Boolean,
        val name: String,
        val size: Long,
        override val ts: Long,
        val transfer: Transfer,
    ) : Entry
}

data class ChatState(
    val link: Link = Link.Offline,
    val peerHost: String = "",
    val peerName: String? = null,
    val peerVersion: String? = null,
    val remoteAddress: String? = null,
    val peerTyping: Boolean = false,
    /** active / idle / away, as reported by the peer. Null when it cannot say. */
    val peerPresence: String? = null,
    val peerTracksFocus: Boolean = false,
    val tailnetAddress: String? = null,
    val listenAddress: String? = null,
    val entries: List<Entry> = emptyList(),
    val queued: Int = 0,
    val peerDevices: List<PeerDevice> = emptyList(),
    val configured: Boolean = false,
) {
    val tailscaleUp: Boolean get() = tailnetAddress != null
}
