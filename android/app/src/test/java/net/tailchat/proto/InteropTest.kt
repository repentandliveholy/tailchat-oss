package net.tailchat.proto

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.BufferedReader
import java.io.File
import java.io.FileInputStream
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.ServerSocket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Drives the Android protocol code against a peer built from the real src/
 * modules. This is the only test that can prove the port is wire-compatible: a
 * pure unit test would only prove it agrees with itself.
 */
class InteropTest {

    private lateinit var node: Process
    private lateinit var nodeIn: OutputStreamWriter
    private val nodeEvents = LinkedBlockingQueue<JsonObject>()
    private val rzEvents = LinkedBlockingQueue<RzEvent>()
    private var rz: Rendezvous? = null
    private lateinit var filesDir: File

    private val repoRoot: File = File("../..").canonicalFile

    private fun freePort(): Int = ServerSocket(0).use { it.localPort }

    @Before
    fun setUp() {
        val harness = File(repoRoot, "android/tools/peer.mjs")
        assertTrue("harness missing: $harness", harness.isFile)
        filesDir = File.createTempFile("tailchat-files", "").let {
            it.delete()
            it.mkdirs()
            it
        }

        val androidPort = freePort()
        val nodePort = freePort()

        node = ProcessBuilder(
            "node", harness.absolutePath,
            "--peer-host", "127.0.0.1",
            "--peer-port", androidPort.toString(),
            "--port", nodePort.toString(),
            "--bind", "127.0.0.1",
            "--name", "node-peer",
            "--files-dir", filesDir.absolutePath,
        ).directory(repoRoot).redirectErrorStream(false).start()

        Thread({
            BufferedReader(InputStreamReader(node.inputStream)).forEachLine { line ->
                val obj = try {
                    Wire.json.parseToJsonElement(line) as? JsonObject
                } catch (_: Exception) {
                    null
                }
                if (obj != null) nodeEvents.put(obj) else println("node: $line")
            }
        }, "node-stdout").apply { isDaemon = true }.start()

        Thread({
            BufferedReader(InputStreamReader(node.errorStream)).forEachLine { println("node!: $it") }
        }, "node-stderr").apply { isDaemon = true }.start()

        nodeIn = OutputStreamWriter(node.outputStream)
        awaitNode("ready")

        rz = Rendezvous(
            peerHost = "127.0.0.1",
            peerPort = nodePort,
            port = androidPort,
            name = "android-peer",
            bindHost = "127.0.0.1",
        ) { rzEvents.put(it) }
        rz!!.start()
    }

    @After
    fun tearDown() {
        rz?.shutdown()
        try {
            tell(buildJsonObject { put("cmd", "quit") })
        } catch (_: Exception) {
        }
        node.destroy()
        node.waitFor(5, TimeUnit.SECONDS)
        filesDir.deleteRecursively()
    }

    private fun tell(cmd: JsonObject) {
        nodeIn.write(cmd.toString() + "\n")
        nodeIn.flush()
    }

    private fun awaitNode(ev: String, timeoutMs: Long = 15_000): JsonObject {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val remaining = deadline - System.currentTimeMillis()
            val next = nodeEvents.poll(maxOf(remaining, 1), TimeUnit.MILLISECONDS)
                ?: throw AssertionError("timed out waiting for node event '$ev'")
            if (next.str("ev") == ev) return next
        }
    }

    private inline fun <reified T : RzEvent> awaitRz(timeoutMs: Long = 15_000, predicate: (T) -> Boolean = { true }): T {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val remaining = deadline - System.currentTimeMillis()
            val next = rzEvents.poll(maxOf(remaining, 1), TimeUnit.MILLISECONDS)
                ?: throw AssertionError("timed out waiting for ${T::class.simpleName}")
            if (next is T && predicate(next)) return next
        }
    }

    private inline fun <reified T : PeerEvent> awaitPeer(timeoutMs: Long = 15_000, predicate: (T) -> Boolean = { true }): T {
        val wrapper = awaitRz<RzEvent.Peer>(timeoutMs) { it.event is T && predicate(it.event as T) }
        return wrapper.event as T
    }

    @Test
    fun handshakeReachesBothSides() {
        val online = awaitRz<RzEvent.Online>()
        assertEquals("node-peer", online.peerName)
        assertNotNull("node must announce a version", online.peerVersion)
        val nodeOnline = awaitNode("online")
        assertEquals("android-peer", nodeOnline.str("peerName"))
        assertEquals(Wire.VERSION, nodeOnline.str("peerVersion"))
    }

    @Test
    fun messagesAndReceiptsCrossBothWays() {
        awaitRz<RzEvent.Online>()
        awaitNode("online")

        // Android → node, then node acks and reads it.
        val id = Wire.newMessageId()
        assertEquals(id, rz!!.send("привет из android", System.currentTimeMillis(), id))
        val delivered = awaitNode("message")
        assertEquals("привет из android", delivered.str("text"))
        assertEquals(id, delivered.str("id"))

        tell(buildJsonObject { put("cmd", "receipt"); put("kind", "ack"); put("id", id) })
        tell(buildJsonObject { put("cmd", "receipt"); put("kind", "read"); put("id", id) })
        assertEquals(id, awaitPeer<PeerEvent.Receipt> { it.kind == "ack" }.id)
        assertEquals(id, awaitPeer<PeerEvent.Receipt> { it.kind == "read" }.id)

        // node → Android, then Android acks it.
        tell(buildJsonObject { put("cmd", "send"); put("text", "reply from node") })
        val sent = awaitNode("sent")
        val replyId = sent.str("id")!!
        val inbound = awaitPeer<PeerEvent.Message>()
        assertEquals("reply from node", inbound.text)
        assertEquals(replyId, inbound.id)
        assertEquals("node-peer", inbound.name)

        assertTrue(rz!!.sendReceipt("ack", replyId))
        assertEquals(replyId, awaitNode("ack").str("id"))
    }

    @Test
    fun typingCapsAndPresenceAreUnderstood() {
        awaitRz<RzEvent.Online>()
        awaitNode("online")

        tell(buildJsonObject { put("cmd", "frame"); put("frame", buildJsonObject { put("t", "typing"); put("state", "start") }) })
        assertTrue(awaitPeer<PeerEvent.Typing>().start)

        tell(buildJsonObject { put("cmd", "frame"); put("frame", buildJsonObject { put("t", "caps"); put("focus", true); put("ai", false) }) })
        val caps = awaitPeer<PeerEvent.Caps>()
        assertTrue(caps.focus)
        assertEquals(false, caps.ai)

        tell(buildJsonObject { put("cmd", "frame"); put("frame", buildJsonObject { put("t", "focus"); put("state", "away") }) })
        assertEquals("away", awaitPeer<PeerEvent.Focus>().state)

        // And the same frames in the other direction land on a real client.
        assertTrue(rz!!.sendFrame(buildJsonObject { put("t", "typing"); put("state", "start") }))
        assertEquals("start", awaitNode("typing").str("state"))
        assertTrue(rz!!.sendFrame(buildJsonObject { put("t", "caps"); put("focus", true); put("ai", false) }))
        assertEquals(true, awaitNode("caps").bool("focus"))
    }

    @Test
    fun fileTransferArrivesIntactOnTheRealReceiver() {
        awaitRz<RzEvent.Online>()
        awaitNode("online")

        // Larger than one 48 KiB chunk, and not a round multiple of it. It goes through a
        // file because the sender streams: it takes a factory for fresh streams, not bytes.
        val payload = ByteArray(150_000) { (it * 31 % 251).toByte() }
        // Not under filesDir: that is where the node receiver writes, and it must not
        // find the very file it is being sent already sitting in its own directory.
        val source = File.createTempFile("android-payload", ".bin").apply {
            deleteOnExit()
            writeBytes(payload)
        }
        val id = Wire.newMessageId()
        val failure = sendFile(
            rz!!,
            id,
            "android-payload.bin",
            payload.size.toLong(),
            openStream = { FileInputStream(source) },
        )
        assertEquals(null, failure)

        assertEquals("android-payload.bin", awaitNode("file-offer").str("name"))
        val done = awaitNode("file-done")
        assertEquals(payload.size.toLong(), done.long("size"))
        val landed = File(done.str("path")!!)
        assertTrue("receiver wrote nothing", landed.isFile)
        assertTrue("bytes differ", landed.readBytes().contentEquals(payload))
    }

    @Test
    fun inboundFileFromTheRealClientIsVerified() {
        awaitRz<RzEvent.Online>()
        awaitNode("online")

        val spool = File(filesDir, "spool").apply { mkdirs() }
        val receiver = FileReceiver(spool)
        val payload = ByteArray(70_000) { (it % 97).toByte() }
        val id = Wire.newMessageId()
        val encoder = java.util.Base64.getEncoder()

        tell(
            buildJsonObject {
                put("cmd", "frame")
                put("frame", fileOfferFrame(id, "from-node.bin", payload.size.toLong(), sha256Hex(payload)))
            },
        )
        val offer = receiver.offer(awaitPeer<PeerEvent.FileFrame> { it.kind == "file-offer" }.frame)
        assertTrue(offer is FileReceiver.Offer.Accepted)

        var seq = 0
        var offset = 0
        while (offset < payload.size) {
            val end = minOf(offset + CHUNK_BYTES, payload.size)
            val data = encoder.encodeToString(payload.copyOfRange(offset, end))
            tell(buildJsonObject { put("cmd", "frame"); put("frame", fileChunkFrame(id, seq++, data)) })
            offset = end
        }
        repeat(seq) {
            val chunk = receiver.chunk(awaitPeer<PeerEvent.FileFrame> { it.kind == "file-chunk" }.frame)
            assertTrue("chunk rejected: $chunk", chunk is FileReceiver.Chunk.Progress)
        }

        tell(buildJsonObject { put("cmd", "frame"); put("frame", fileDoneFrame(id)) })
        val result = receiver.done(awaitPeer<PeerEvent.FileFrame> { it.kind == "file-done" }.frame)
        assertTrue("transfer failed: $result", result is FileReceiver.Done.Complete)
        result as FileReceiver.Done.Complete
        assertEquals("from-node.bin", result.name)
        assertTrue("bytes differ", result.file.readBytes().contentEquals(payload))
        // The verified file belongs to the caller now, and nothing else is left behind.
        assertEquals(listOf(result.file), spool.listFiles()!!.toList())
    }
}
