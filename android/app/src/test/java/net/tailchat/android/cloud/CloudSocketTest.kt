package net.tailchat.android.cloud

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class CloudSocketTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = OkHttpClient()
    }

    @After
    fun tearDown() {
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
        server.shutdown()
    }

    @Test
    fun authenticatesAndBecomesReady() {
        val frames = LinkedBlockingQueue<String>()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                frames.add(text)
                webSocket.send(
                    """{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[{"login":"anna","name":"Anna","online":true,""" +
                        """"pending":2,"last":{"id":"m-9","from":"anna","ts":77,"text":"see you","media":null}},""" +
                        """{"login":"boris","name":"Boris","last":{"id":"m-8","from":"roman","ts":66,"text":"","media":"voice"}}]}""",
                )
            }
        }))

        val ready = CountDownLatch(1)
        val self = AtomicReference<CloudUser>()
        val users = AtomicReference<List<CloudUser>>()
        val failure = AtomicReference<CloudFailure>()
        val socket = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(value: CloudUser, available: List<CloudUser>, caps: Set<String>) {
                self.set(value)
                users.set(available)
                ready.countDown()
            }
            override fun onFailure(value: CloudFailure) {
                failure.set(value)
                ready.countDown()
            }
            override fun onClosed() = Unit
        })

        assertTrue("ready frame not received", ready.await(5, TimeUnit.SECONDS))
        val request = server.takeRequest(1, TimeUnit.SECONDS)
        val sent = Json.parseToJsonElement(frames.poll(1, TimeUnit.SECONDS)).jsonObject

        assertEquals("/tailchat/ws", request?.path)
        assertEquals("auth", sent.getValue("k").jsonPrimitive.content)
        assertEquals("token-1", sent.getValue("token").jsonPrimitive.content)
        assertEquals(CloudUser("roman", "Roman"), self.get())
        // `last` is what the roster's second line is: parsed for every client,
        // and media named rather than carried (`lastMessage`, accounts.js:1207).
        assertEquals(
            listOf(
                CloudUser("anna", "Anna", online = true, pending = 2,
                    preview = CloudPreview(from = "anna", text = "see you", ts = 77)),
                CloudUser("boris", "Boris",
                    preview = CloudPreview(from = "roman", text = "", media = "voice", ts = 66)),
            ),
            users.get(),
        )
        assertNull(failure.get())
        socket.cancel()
    }

    @Test
    fun anEditCarrierFrameIsMarkedHiddenWhetherItIsAStubOrATombstone() {
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (Json.parseToJsonElement(text).jsonObject["k"]?.jsonPrimitive?.content != "auth") return
                webSocket.send("""{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[]}""")
                webSocket.send("""{"k":"frame","from":"anna","d":{"t":"msg","id":"e-stub","text":"stub","ts":1,"sealedEdit":true}}""")
                webSocket.send("""{"k":"frame","from":"anna","d":{"t":"msg","id":"e-tomb","ts":2,"deletedAt":2,"sealedEdit":true}}""")
                webSocket.send("""{"k":"frame","from":"anna","d":{"t":"msg","id":"m-1","text":"hi","ts":3}}""")
            }
        }))
        val received = CountDownLatch(3)
        val seen = java.util.concurrent.CopyOnWriteArrayList<CloudSocket.IncomingMessage>()
        val connection = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) = Unit
            override fun onMessage(message: CloudSocket.IncomingMessage) {
                seen += message
                received.countDown()
            }
            override fun onFailure(failure: CloudFailure) = Unit
            override fun onClosed() = Unit
        })
        assertTrue(received.await(5, TimeUnit.SECONDS))
        assertEquals(listOf(true, true, false), seen.map { it.hidden })
        assertEquals(listOf("e-stub", "e-tomb", "m-1"), seen.map { it.id })
        connection.cancel()
    }

    @Test
    fun subscribesSendsAndReceivesTextFrames() {
        val frames = LinkedBlockingQueue<String>()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                frames.add(text)
                val payload = Json.parseToJsonElement(text).jsonObject
                when (payload["k"]?.jsonPrimitive?.content) {
                    "auth" -> webSocket.send(
                        """{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[{"login":"anna","name":"Anna"}]}""",
                    )
                    "subscribe" -> {
                        webSocket.send("""{"k":"subscribed","peer":"anna"}""")
                        webSocket.send(
                            """{"k":"frame","from":"anna","d":{"t":"msg","id":"m-in","text":"hello","ts":1234}}""",
                        )
                    }
                }
            }
        }))

        val ready = CountDownLatch(1)
        val subscribed = CountDownLatch(1)
        val received = CountDownLatch(1)
        val incoming = AtomicReference<CloudSocket.IncomingMessage>()
        val connection = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) = ready.countDown()
            override fun onSubscribed(peer: String) {
                assertEquals("anna", peer)
                subscribed.countDown()
            }
            override fun onMessage(message: CloudSocket.IncomingMessage) {
                incoming.set(message)
                received.countDown()
            }
            override fun onFailure(failure: CloudFailure) = Unit
            override fun onClosed() = Unit
        })

        assertTrue(ready.await(5, TimeUnit.SECONDS))
        frames.poll(1, TimeUnit.SECONDS)
        assertTrue(connection.subscribe("anna"))
        assertTrue(subscribed.await(5, TimeUnit.SECONDS))
        assertTrue(received.await(5, TimeUnit.SECONDS))
        val subscribe = Json.parseToJsonElement(frames.poll(1, TimeUnit.SECONDS)).jsonObject
        assertEquals("subscribe", subscribe.getValue("k").jsonPrimitive.content)
        assertEquals("hello", incoming.get().text)
        assertEquals("anna", incoming.get().from)

        assertTrue(connection.sendMessage("anna", "m-out", "hi", 5678, "Roman"))
        val outbound = Json.parseToJsonElement(frames.poll(1, TimeUnit.SECONDS)).jsonObject
        assertEquals("frame", outbound.getValue("k").jsonPrimitive.content)
        assertEquals("anna", outbound.getValue("to").jsonPrimitive.content)
        assertEquals("m-out", outbound.getValue("d").jsonObject.getValue("id").jsonPrimitive.content)
        assertTrue(connection.sendHello("anna", "Roman", connId = "c123", version = "android"))
        val helloOut = Json.parseToJsonElement(frames.poll(1, TimeUnit.SECONDS)).jsonObject
        assertEquals("frame", helloOut.getValue("k").jsonPrimitive.content)
        assertEquals("anna", helloOut.getValue("to").jsonPrimitive.content)
        val helloD = helloOut.getValue("d").jsonObject
        assertEquals("hello", helloD.getValue("t").jsonPrimitive.content)
        assertEquals("Roman", helloD.getValue("name").jsonPrimitive.content)
        assertEquals("c123", helloD.getValue("connId").jsonPrimitive.content)
        assertEquals("android", helloD.getValue("v").jsonPrimitive.content)
        connection.cancel()
    }

    @Test
    fun parsesTransientBotActionsWithoutPuttingThemInMessages() {
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val payload = Json.parseToJsonElement(text).jsonObject
                if (payload["k"]?.jsonPrimitive?.content == "auth") {
                    webSocket.send("""{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[]}""")
                    webSocket.send(
                        """{"k":"frame","from":"remindka_bot","d":{"t":"actions","actions":[""" +
                            """{"id":"done","label":"✅ Готово","value":"готово"},""" +
                            """{"id":"snooze","label":"+10 мин","value":"через 10 минут"},""" +
                            """{"id":"","label":"bad","value":"bad"}]}}""",
                    )
                }
            }
        }))

        val ready = CountDownLatch(1)
        val received = CountDownLatch(1)
        val incoming = AtomicReference<CloudSocket.IncomingActions>()
        val connection = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) = ready.countDown()
            override fun onActions(actions: CloudSocket.IncomingActions) {
                incoming.set(actions)
                received.countDown()
            }
            override fun onFailure(failure: CloudFailure) = Unit
            override fun onClosed() = Unit
        })

        assertTrue(ready.await(5, TimeUnit.SECONDS))
        assertTrue(received.await(5, TimeUnit.SECONDS))
        assertEquals("remindka_bot", incoming.get().from)
        assertEquals(
            listOf(
                CloudBotAction("done", "✅ Готово", "готово"),
                CloudBotAction("snooze", "+10 мин", "через 10 минут"),
            ),
            incoming.get().actions,
        )
        connection.cancel()
    }

    @Test
    fun parsesServerAcceptanceAndLiveAiMessage() {
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val payload = Json.parseToJsonElement(text).jsonObject
                when (payload["k"]?.jsonPrimitive?.content) {
                    "auth" -> webSocket.send(
                        """{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[{"login":"tailik","name":"Тэйлик"}]}""",
                    )
                    "subscribe" -> {
                        webSocket.send("""{"k":"subscribed","peer":"tailik"}""")
                        webSocket.send("""{"k":"message-accepted","peer":"tailik","id":"m-out","ts":5679}""")
                        webSocket.send(
                            """{"k":"frame","from":"tailik","d":{"t":"ai","id":"ai-1","text":"Привет!","ts":5680,"name":"Тэйлик"}}""",
                        )
                    }
                }
            }
        }))

        val ready = CountDownLatch(1)
        val accepted = CountDownLatch(1)
        val received = CountDownLatch(1)
        val acceptedRef = AtomicReference<CloudSocket.MessageAccepted>()
        val incomingRef = AtomicReference<CloudSocket.IncomingMessage>()
        val connection = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) = ready.countDown()
            override fun onMessageAccepted(value: CloudSocket.MessageAccepted) {
                acceptedRef.set(value)
                accepted.countDown()
            }
            override fun onMessage(message: CloudSocket.IncomingMessage) {
                incomingRef.set(message)
                received.countDown()
            }
            override fun onFailure(failure: CloudFailure) = Unit
            override fun onClosed() = Unit
        })

        assertTrue(ready.await(5, TimeUnit.SECONDS))
        assertTrue(connection.subscribe("tailik"))
        assertTrue(accepted.await(5, TimeUnit.SECONDS))
        assertTrue(received.await(5, TimeUnit.SECONDS))
        assertEquals(CloudSocket.MessageAccepted("tailik", "m-out", 5679), acceptedRef.get())
        assertEquals("ai", incomingRef.get().kind)
        assertEquals("Тэйлик", incomingRef.get().author)
        assertEquals("Привет!", incomingRef.get().text)
        connection.cancel()
    }

    @Test
    fun relaysFileTransferFrames() {
        val frames = LinkedBlockingQueue<String>()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                frames.add(text)
                val payload = Json.parseToJsonElement(text).jsonObject
                when (payload["k"]?.jsonPrimitive?.content) {
                    "auth" -> webSocket.send(
                        """{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[{"login":"anna","name":"Anna"}]}""",
                    )
                    "subscribe" -> {
                        webSocket.send("""{"k":"subscribed","peer":"anna"}""")
                        webSocket.send(
                            """{"k":"frame","from":"anna","d":{"t":"file-offer","id":"f-1","name":"photo.jpg","size":9,"sha256":"deadbeef"}}""",
                        )
                    }
                }
            }
        }))

        val ready = CountDownLatch(1)
        val offerReceived = CountDownLatch(1)
        val offerRef = AtomicReference<CloudSocket.IncomingFileFrame>()
        val connection = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) = ready.countDown()
            override fun onFileOffer(offer: CloudSocket.IncomingFileFrame) {
                offerRef.set(offer)
                offerReceived.countDown()
            }
            override fun onFailure(failure: CloudFailure) = Unit
            override fun onClosed() = Unit
        })

        assertTrue(ready.await(5, TimeUnit.SECONDS))
        frames.poll(1, TimeUnit.SECONDS)
        assertTrue(connection.subscribe("anna"))
        frames.poll(1, TimeUnit.SECONDS)
        assertTrue(offerReceived.await(5, TimeUnit.SECONDS))
        val received = offerRef.get()
        assertEquals("anna", received.from)
        assertEquals("f-1", received.frame["id"]?.jsonPrimitive?.content)
        assertEquals("photo.jpg", received.frame["name"]?.jsonPrimitive?.content)

        assertTrue(connection.sendFileFrame("anna", net.tailchat.proto.fileChunkFrame("f-1", 0, "AAAA")))
        val chunkOut = Json.parseToJsonElement(frames.poll(1, TimeUnit.SECONDS)).jsonObject
        assertEquals("frame", chunkOut.getValue("k").jsonPrimitive.content)
        assertEquals("anna", chunkOut.getValue("to").jsonPrimitive.content)
        assertEquals("file-chunk", chunkOut.getValue("d").jsonObject.getValue("t").jsonPrimitive.content)
        assertEquals("AAAA", chunkOut.getValue("d").jsonObject.getValue("data").jsonPrimitive.content)
        connection.cancel()
    }


    @Test
    fun sendsAndParsesInlineImageAndVoice() {
        val frames = LinkedBlockingQueue<String>()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                frames.add(text)
                val payload = Json.parseToJsonElement(text).jsonObject
                when (payload["k"]?.jsonPrimitive?.content) {
                    "auth" -> webSocket.send(
                        """{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[{"login":"anna","name":"Anna"}]}""",
                    )
                    "subscribe" -> {
                        webSocket.send("""{"k":"subscribed","peer":"anna"}""")
                        webSocket.send(
                            """{"k":"frame","from":"anna","d":{"t":"msg","id":"m-in","text":"hi",""" +
                                """"ts":1234,"voice":{"dataUrl":"data:audio/mp4;base64,QQ==","duration":7}}}""",
                        )
                    }
                }
            }
        }))

        val ready = CountDownLatch(1)
        val received = CountDownLatch(1)
        val incoming = AtomicReference<CloudSocket.IncomingMessage>()
        val connection = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) = ready.countDown()
            override fun onMessage(message: CloudSocket.IncomingMessage) {
                incoming.set(message)
                received.countDown()
            }
            override fun onFailure(failure: CloudFailure) = Unit
            override fun onClosed() = Unit
        })

        assertTrue(ready.await(5, TimeUnit.SECONDS))
        frames.poll(1, TimeUnit.SECONDS)
        assertTrue(connection.subscribe("anna"))
        frames.poll(1, TimeUnit.SECONDS)
        assertTrue(received.await(5, TimeUnit.SECONDS))
        assertEquals(7, incoming.get().voice?.durationSec)
        assertEquals("data:audio/mp4;base64,QQ==", incoming.get().voice?.dataUrl)

        assertTrue(connection.sendMessage(
            "anna", "m-out", "photo", 5678, "Roman",
            image = CloudImage("data:image/jpeg;base64,Zm9v", 100, 80),
        ))
        val outbound = Json.parseToJsonElement(frames.poll(2, TimeUnit.SECONDS)).jsonObject
        val outImage = outbound.getValue("d").jsonObject.getValue("image").jsonObject
        assertEquals("data:image/jpeg;base64,Zm9v", outImage.getValue("dataUrl").jsonPrimitive.content)
        assertEquals(100, outImage.getValue("width").jsonPrimitive.content.toInt())
        connection.cancel()
    }

    /**
     * The four frames this client learned from the web protocol
     * (`src/cloud/hub.js`'s `relay`): a reaction toggle, an edit, a delete, and
     * the reply snapshot a `msg` carries. Every one of them is a silent no-op
     * if a field name drifts — the peer simply never sees the reaction and the
     * badge never appears — which is exactly the failure a running app hides.
     */
    @Test
    fun sendsAndParsesReactionEditDeleteAndReply() {
        val frames = LinkedBlockingQueue<String>()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                frames.add(text)
                val payload = Json.parseToJsonElement(text).jsonObject
                when (payload["k"]?.jsonPrimitive?.content) {
                    "auth" -> webSocket.send(
                        """{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[{"login":"anna","name":"Anna"}]}""",
                    )
                    "subscribe" -> {
                        webSocket.send("""{"k":"subscribed","peer":"anna"}""")
                        webSocket.send(
                            """{"k":"frame","from":"anna","d":{"t":"msg","id":"m-in","text":"sure","ts":11,""" +
                                """"replyTo":{"id":"m-mine","from":"roman","text":"question?"}}}""",
                        )
                        webSocket.send("""{"k":"frame","from":"anna","d":{"t":"react","id":"m-mine","emoji":"👍","by":"anna","add":true}}""")
                        webSocket.send("""{"k":"frame","from":"anna","d":{"t":"edit","id":"m-in","text":"sure!"}}""")
                        webSocket.send("""{"k":"frame","from":"anna","d":{"t":"del","ids":["m-in"],"scope":"all"}}""")
                    }
                }
            }
        }))

        val ready = CountDownLatch(1)
        val landed = CountDownLatch(4)
        val message = AtomicReference<CloudSocket.IncomingMessage>()
        val reaction = AtomicReference<CloudSocket.IncomingReaction>()
        val edit = AtomicReference<CloudSocket.IncomingEdit>()
        val deletion = AtomicReference<CloudSocket.IncomingDelete>()
        val connection = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) = ready.countDown()
            override fun onMessage(incoming: CloudSocket.IncomingMessage) {
                message.set(incoming)
                landed.countDown()
            }
            override fun onReaction(incoming: CloudSocket.IncomingReaction) {
                reaction.set(incoming)
                landed.countDown()
            }
            override fun onEdit(incoming: CloudSocket.IncomingEdit) {
                edit.set(incoming)
                landed.countDown()
            }
            override fun onDelete(incoming: CloudSocket.IncomingDelete) {
                deletion.set(incoming)
                landed.countDown()
            }
            override fun onFailure(failure: CloudFailure) = Unit
            override fun onClosed() = Unit
        })

        assertTrue(ready.await(5, TimeUnit.SECONDS))
        frames.poll(1, TimeUnit.SECONDS)
        assertTrue(connection.subscribe("anna"))
        frames.poll(1, TimeUnit.SECONDS)
        assertTrue(landed.await(5, TimeUnit.SECONDS))

        assertEquals("m-mine", message.get().replyTo?.id)
        assertEquals("question?", message.get().replyTo?.text)
        assertEquals("👍", reaction.get().emoji)
        assertEquals("anna", reaction.get().by)
        assertTrue(reaction.get().add)
        assertEquals("sure!", edit.get().text)
        assertEquals(listOf("m-in"), deletion.get().ids)

        assertTrue(connection.sendReaction("anna", "m-in", "🔥", add = false))
        val react = Json.parseToJsonElement(frames.poll(2, TimeUnit.SECONDS)).jsonObject.getValue("d").jsonObject
        assertEquals("react", react.getValue("t").jsonPrimitive.content)
        assertEquals("🔥", react.getValue("emoji").jsonPrimitive.content)
        assertEquals("false", react.getValue("add").jsonPrimitive.content)

        assertTrue(connection.sendDelete("anna", listOf("m-a", "m-b"), scope = "self"))
        val del = Json.parseToJsonElement(frames.poll(2, TimeUnit.SECONDS)).jsonObject.getValue("d").jsonObject
        assertEquals("self", del.getValue("scope").jsonPrimitive.content)
        assertEquals(2, del.getValue("ids").jsonArray.size)

        assertTrue(connection.sendMessage(
            "anna", "m-out", "answer", 22, "Roman",
            replyTo = CloudReply(id = "m-in", from = "anna", text = "sure!", media = "image"),
        ))
        val quote = Json.parseToJsonElement(frames.poll(2, TimeUnit.SECONDS)).jsonObject
            .getValue("d").jsonObject.getValue("replyTo").jsonObject
        assertEquals("m-in", quote.getValue("id").jsonPrimitive.content)
        assertEquals("anna", quote.getValue("from").jsonPrimitive.content)
        assertEquals("image", quote.getValue("media").jsonPrimitive.content)
        connection.cancel()
    }

    /**
     * The hub closes with 4429 when a client outruns its 60-frames-per-second
     * limit. Reported as a plain `onClosed`, that looked like an ordinary drop
     * and the controller dialled straight back in — the reconnect loop behind
     * "constantly disconnects" and the battery report. It has to arrive as a
     * named failure the caller can back off from.
     */
    @Test
    fun reportsTheHubsRateLimitCloseAsANamedFailure() {
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                webSocket.close(CloudSocket.RATE_LIMITED_CODE, "too fast")
            }
        }))

        val settled = CountDownLatch(1)
        val failure = AtomicReference<CloudFailure>()
        val closed = AtomicReference<Boolean>(false)
        val connection = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) = Unit
            override fun onFailure(value: CloudFailure) {
                failure.set(value)
                settled.countDown()
            }
            override fun onClosed() {
                closed.set(true)
                settled.countDown()
            }
        })

        assertTrue("socket never settled", settled.await(5, TimeUnit.SECONDS))
        assertEquals("rate_limited", failure.get()?.code)
        assertEquals(false, closed.get())
        connection.cancel()
    }

    /**
     * A frame this client mis-reads must not take the socket with it. OkHttp
     * turns any exception thrown out of its listener into `failWebSocket`, so
     * before the guard a single malformed payload disconnected the chat; the
     * frame is reported and the socket keeps carrying the conversation.
     */
    @Test
    fun survivesAFrameItCannotRead() {
        val frames = LinkedBlockingQueue<String>()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                frames.add(text)
                if (frames.size > 1) return
                webSocket.send("""{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[]}""")
                // `ids` holds objects, not strings: reading them as primitives
                // throws inside the delete parser.
                webSocket.send("""{"k":"frame","from":"anna","d":{"t":"del","ids":[{"id":"m-1"}]}}""")
                webSocket.send("""{"k":"frame","from":"anna","d":{"t":"msg","id":"m-2","text":"still here","ts":9}}""")
            }
        }))

        val landed = CountDownLatch(1)
        val message = AtomicReference<CloudSocket.IncomingMessage>()
        val failure = AtomicReference<CloudFailure>()
        val connection = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) = Unit
            override fun onMessage(incoming: CloudSocket.IncomingMessage) {
                message.set(incoming)
                landed.countDown()
            }
            override fun onFailure(value: CloudFailure) = failure.set(value)
            override fun onClosed() = Unit
        })

        assertTrue("the frame after the bad one never arrived", landed.await(5, TimeUnit.SECONDS))
        assertEquals("still here", message.get().text)
        assertEquals("client_error", failure.get()?.code)
        assertTrue("the socket must still be usable", connection.sendWho())
        connection.cancel()
    }

    /**
     * Inbound media is capped at what this client will send. A web client can
     * put ten megabytes in one frame, and holding that data URL, its parsed
     * copy and the re-encoded disk cache is an `OutOfMemoryError` — which
     * OkHttp's `catch (Exception)` does not intercept, so it kills the process
     * instead of the socket. The message survives; the payload does not.
     */
    @Test
    fun dropsInboundMediaLargerThanThisClientWouldSend() {
        val huge = "data:image/jpeg;base64," + "A".repeat(CLOUD_VOICE_MAX_DATA_URL_CHARS)
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                webSocket.send(
                    """{"k":"frame","from":"anna","d":{"t":"msg","id":"m-3","text":"look","ts":11,""" +
                        """"image":{"dataUrl":"$huge","width":800,"height":600}}}""",
                )
            }
        }))

        val landed = CountDownLatch(1)
        val message = AtomicReference<CloudSocket.IncomingMessage>()
        val connection = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) = Unit
            override fun onMessage(incoming: CloudSocket.IncomingMessage) {
                message.set(incoming)
                landed.countDown()
            }
            override fun onFailure(value: CloudFailure) = Unit
            override fun onClosed() = Unit
        })

        assertTrue(landed.await(5, TimeUnit.SECONDS))
        assertEquals("look", message.get().text)
        assertNull("an oversized payload is dropped", message.get().image)
        connection.cancel()
    }

    /** A server that clamps duration on write (`accounts.js` normalizeMedia)
     *  still deserves a client-side floor: a legacy or misbehaving peer
     *  sending an out-of-range `duration` must not hand the waveform player a
     *  value it will misread as a multi-hour recording. */
    @Test
    fun clampsAnOutOfRangeInboundVoiceDuration() {
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.startsWith("{\"k\":\"auth\"")) {
                    webSocket.send("""{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[]}""")
                    webSocket.send(
                        """{"k":"frame","from":"anna","d":{"t":"msg","id":"m-long","text":"",""" +
                            """"ts":1,"voice":{"dataUrl":"data:audio/mp4;base64,QQ==","duration":99999}}}""",
                    )
                }
            }
        }))

        val received = CountDownLatch(1)
        val incoming = AtomicReference<CloudSocket.IncomingMessage>()
        val connection = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) = Unit
            override fun onMessage(message: CloudSocket.IncomingMessage) {
                incoming.set(message)
                received.countDown()
            }
            override fun onFailure(value: CloudFailure) = Unit
            override fun onClosed() = Unit
        })

        assertTrue(received.await(5, TimeUnit.SECONDS))
        assertEquals(VOICE_MAX_SEC, incoming.get().voice?.durationSec)
        connection.cancel()
    }


    /**
     * A live voice note keeps whatever finite duration its sender wrote. Fractional is what
     * the CLI sends (`src/voice.js`'s `totalSamples / sampleRate`, relayed as written by
     * `hub.js`) — `intOrNull` answered "not a number" for 3.46 and dropped the payload, an
     * empty bubble with nothing to play — and `0` is what web and the CLI write for an
     * unknown length: dropping *that* was the regression of the first fix. Rounded the way
     * web/CLI round, clamped the way this path always clamped. And a live image's `0`
     * dimensions stay `0` ("unknown" to `InlineImage`), not `1`.
     */
    @Test
    fun keepsALiveVoiceNoteWhateverItsFiniteDuration() {
        val voice = """"dataUrl":"data:audio/wav;base64,QQ==""""
        val frames = listOf(
            "m-frac" to """"voice":{$voice,"duration":3.46}""",
            "m-zero" to """"voice":{$voice,"duration":0}""",
            "m-zero-f" to """"voice":{$voice,"duration":0.0}""",
            "m-neg" to """"voice":{$voice,"duration":-1}""",
            "m-image" to """"image":{"dataUrl":"data:image/png;base64,QQ==","width":0,"height":0}""",
        )
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.startsWith("{\"k\":\"auth\"")) {
                    webSocket.send("""{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[]}""")
                    frames.forEachIndexed { index, (id, media) ->
                        webSocket.send(
                            """{"k":"frame","from":"anna","d":{"t":"msg","id":"$id","text":"",""" +
                                """"ts":${index + 1},$media}}""",
                        )
                    }
                }
            }
        }))

        val received = CountDownLatch(frames.size)
        val incoming = CopyOnWriteArrayList<CloudSocket.IncomingMessage>()
        val connection = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) = Unit
            override fun onMessage(message: CloudSocket.IncomingMessage) {
                incoming += message
                received.countDown()
            }
            override fun onFailure(value: CloudFailure) = Unit
            override fun onClosed() = Unit
        })

        assertTrue(received.await(5, TimeUnit.SECONDS))
        val byId = incoming.associateBy { it.id }
        assertEquals("3.46 s rounds to 3, as web and the CLI round it", 3, byId.getValue("m-frac").voice?.durationSec)
        assertEquals("0 is a voice note, at the clamp's floor", 1, byId.getValue("m-zero").voice?.durationSec)
        assertEquals("0.0 likewise", 1, byId.getValue("m-zero-f").voice?.durationSec)
        assertEquals("a negative duration is clamped, not dropped", 1, byId.getValue("m-neg").voice?.durationSec)
        assertEquals("an unknown width stays unknown", 0, byId.getValue("m-image").image?.width)
        assertEquals("an unknown height stays unknown", 0, byId.getValue("m-image").image?.height)
        connection.cancel()
    }


    /**
     * `{k:'unread', from, text, ts, count}` — `src/cloud/hub.js`'s
     * `deliverFrame` sends an absolute count, not a delta. A frame missing
     * `count`, or carrying a negative one, is dropped outright rather than
     * handed to the observer with a guessed value — see `toUnread`.
     */
    @Test
    fun parsesTheUnreadFramesAbsoluteCountAndRejectsAnInvalidOne() {
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.startsWith("{\"k\":\"auth\"")) {
                    webSocket.send("""{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[]}""")
                    // No `count` at all: an older server, or a malformed frame.
                    webSocket.send("""{"k":"unread","from":"anna","text":"привет","ts":5}""")
                    // A negative count is not a valid absolute total either.
                    webSocket.send("""{"k":"unread","from":"anna","text":"ещё","ts":6,"count":-1}""")
                    // A non-numeric count is likewise rejected.
                    webSocket.send("""{"k":"unread","from":"anna","text":"опять","ts":7,"count":"three"}""")
                    // The first frame this client should actually see.
                    webSocket.send("""{"k":"unread","from":"anna","text":"на связи","ts":8,"count":3}""")
                }
            }
        }))

        val received = LinkedBlockingQueue<CloudSocket.Unread>()
        val connection = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) = Unit
            override fun onUnread(unread: CloudSocket.Unread) { received.add(unread) }
            override fun onFailure(value: CloudFailure) = Unit
            override fun onClosed() = Unit
        })

        val unread = received.poll(5, TimeUnit.SECONDS)
        assertEquals("anna", unread?.from)
        assertEquals(3, unread?.count)
        assertEquals("на связи", unread?.text)
        assertNull("no second, malformed frame should have reached the observer", received.poll(200, TimeUnit.MILLISECONDS))
        connection.cancel()
    }


    /**
     * Issue #29: a wake-only connection declares `lurk-v1` so the hub counts it
     * for neither presence nor callability — while still delivering every frame.
     */
    @Test
    fun `a lurk dial declares lurk-v1 in the auth caps`() {
        val caps = connectAndReadCaps(lurk = true)
        assertTrue("a wake-only dial must declare lurk-v1", "lurk-v1" in caps)
    }

    @Test
    fun `a present dial does not declare lurk-v1`() {
        val caps = connectAndReadCaps(lurk = false)
        assertTrue("a normal dial must not declare lurk-v1", "lurk-v1" !in caps)
    }

    /**
     * Issue #28: the roster entry's `alias` is the caller's own nickname for a
     * contact and is carried through to [CloudUser.alias].
     */
    @Test
    fun `the roster entry's alias is parsed onto the contact`() {
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                webSocket.send(
                    """{"k":"ready","self":{"login":"roman","name":"Roman"},""" +
                        """"users":[{"login":"anna","name":"Anna","alias":"Аня с работы"}]}""",
                )
            }
        }))
        val ready = CountDownLatch(1)
        val users = AtomicReference<List<CloudUser>>()
        val connection = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, available: List<CloudUser>, caps: Set<String>) {
                users.set(available)
                ready.countDown()
            }
            override fun onFailure(value: CloudFailure) = ready.countDown()
            override fun onClosed() = Unit
        })

        assertTrue(ready.await(5, TimeUnit.SECONDS))
        assertEquals("Аня с работы", users.get().single().alias)
        connection.cancel()
    }

    @Test
    fun reportsAReminderSetAndOneThatFires() {
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                webSocket.send("""{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[]}""")
                // What the hub answers the connection that asked for a reminder,
                // and again with everything still pending on `auth`.
                webSocket.send(
                    """{"k":"reply-reminder-set","reminder":{"id":"r-1","peer":"anna",""" +
                        """"messageId":"m-1","dueAt":5000}}""",
                )
                webSocket.send(
                    """{"k":"reply-reminder-fired","reminder":{"id":"r-1","peer":"anna",""" +
                        """"messageId":"m-1","dueAt":5000}}""",
                )
                // `dueAt` is required by both: a reminder the client cannot put
                // a time on is not one it may mark a message with.
                webSocket.send("""{"k":"reply-reminder-set","reminder":{"id":"r-2","peer":"anna","messageId":"m-2"}}""")
            }
        }))

        val sets = LinkedBlockingQueue<CloudSocket.ReplyReminder>()
        val fired = LinkedBlockingQueue<CloudSocket.ReplyReminder>()
        val ready = CountDownLatch(1)
        val socket = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) = ready.countDown()
            override fun onFailure(value: CloudFailure) = ready.countDown()
            override fun onClosed() = Unit
            override fun onReplyReminderSet(reminder: CloudSocket.ReplyReminder) { sets.add(reminder) }
            override fun onReplyReminder(reminder: CloudSocket.ReplyReminder) { fired.add(reminder) }
        })

        assertTrue("ready frame not received", ready.await(5, TimeUnit.SECONDS))
        assertEquals(CloudSocket.ReplyReminder("r-1", "anna", "m-1", 5000), sets.poll(2, TimeUnit.SECONDS))
        assertEquals(CloudSocket.ReplyReminder("r-1", "anna", "m-1", 5000), fired.poll(2, TimeUnit.SECONDS))
        assertNull("a reminder with no due time marks nothing", sets.poll(300, TimeUnit.MILLISECONDS))
        socket.cancel()
    }

    /**
     * The three frames that carry a read fact — the peer's receipt, this
     * account's own `read-sync` and the durable `read-accepted` — all name
     * *when* the watermark moved and *which client* moved it. Dropping either
     * on the way in is what leaves the message menu with a time it cannot
     * explain or a client it would have to guess, so both are pinned here, as
     * is the frame that carries neither: unknown stays empty, never invented.
     */
    @Test
    fun `read frames carry the read time and the client that produced them`() {
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                webSocket.send("""{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[]}""")
                webSocket.send(
                    """{"k":"frame","from":"anna","d":{"t":"read","id":"m-1","readTs":3000,"readAt":9000,"via":"web"}}""",
                )
                webSocket.send(
                    """{"k":"read-sync","peer":"anna","id":"m-1","readTs":3000,"readAt":9000,"via":"android/450"}""",
                )
                webSocket.send(
                    """{"k":"read-accepted","peer":"anna","id":"m-1","readTs":3000,"readAt":9000,"via":"cli"}""",
                )
                // An older server's read frame: the watermark and nothing else.
                webSocket.send("""{"k":"frame","from":"anna","d":{"t":"read","id":"m-2","readTs":3000}}""")
            }
        }))

        val receipts = LinkedBlockingQueue<CloudSocket.IncomingReceipt>()
        val syncs = LinkedBlockingQueue<CloudSocket.ReadSync>()
        val accepted = LinkedBlockingQueue<CloudSocket.ReadAccepted>()
        val ready = CountDownLatch(1)
        val socket = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) = ready.countDown()
            override fun onFailure(value: CloudFailure) = ready.countDown()
            override fun onClosed() = Unit
            override fun onReceipt(receipt: CloudSocket.IncomingReceipt) { receipts.add(receipt) }
            override fun onReadSync(readSync: CloudSocket.ReadSync) { syncs.add(readSync) }
            override fun onReadAccepted(value: CloudSocket.ReadAccepted) { accepted.add(value) }
        })

        assertTrue("ready frame not received", ready.await(5, TimeUnit.SECONDS))
        assertEquals(
            CloudSocket.IncomingReceipt(
                from = "anna",
                id = "m-1",
                read = true,
                readTs = 3000,
                readAt = 9000,
                via = "web",
            ),
            receipts.poll(2, TimeUnit.SECONDS),
        )
        assertEquals(
            CloudSocket.ReadSync(peer = "anna", id = "m-1", readTs = 3000, readAt = 9000, via = "android/450"),
            syncs.poll(2, TimeUnit.SECONDS),
        )
        assertEquals(
            CloudSocket.ReadAccepted(peer = "anna", id = "m-1", readTs = 3000, readAt = 9000, via = "cli"),
            accepted.poll(2, TimeUnit.SECONDS),
        )
        assertEquals(
            "an unlabelled frame leaves both fields empty rather than guessing a client",
            CloudSocket.IncomingReceipt(from = "anna", id = "m-2", read = true, readTs = 3000),
            receipts.poll(2, TimeUnit.SECONDS),
        )
        socket.cancel()
    }

    /**
     * An `ack` is the delivered rung and, since the hub learned to set it,
     * carries the peer's whole delivered watermark on the same `d` the read
     * frame does. Dropping it on the way in leaves the client able to advance
     * only the one bubble the frame named, so the earlier ones a lost receipt
     * never reached would sit on ✓ forever; and an older server's `ack` — or a
     * `read`, which is a different rung — must read back as no watermark at
     * all, never a guessed one.
     */
    @Test
    fun `an ack carries the delivered watermark and a frame without one says nothing`() {
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                webSocket.send("""{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[]}""")
                webSocket.send("""{"k":"frame","from":"anna","d":{"t":"ack","id":"m-1","deliveredTs":3000}}""")
                // An older server's ack: the id and nothing else.
                webSocket.send("""{"k":"frame","from":"anna","d":{"t":"ack","id":"m-2"}}""")
                // A read frame is the rung above delivery; it never borrows the
                // delivered watermark's field.
                webSocket.send("""{"k":"frame","from":"anna","d":{"t":"read","id":"m-3","readTs":5000}}""")
            }
        }))

        val receipts = LinkedBlockingQueue<CloudSocket.IncomingReceipt>()
        val ready = CountDownLatch(1)
        val socket = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) = ready.countDown()
            override fun onFailure(value: CloudFailure) = ready.countDown()
            override fun onClosed() = Unit
            override fun onReceipt(receipt: CloudSocket.IncomingReceipt) { receipts.add(receipt) }
        })

        assertTrue("ready frame not received", ready.await(5, TimeUnit.SECONDS))
        assertEquals(
            CloudSocket.IncomingReceipt(from = "anna", id = "m-1", read = false, deliveredTs = 3000),
            receipts.poll(2, TimeUnit.SECONDS),
        )
        assertEquals(
            "an old ack leaves the delivered watermark unknown rather than zero-claiming",
            CloudSocket.IncomingReceipt(from = "anna", id = "m-2", read = false),
            receipts.poll(2, TimeUnit.SECONDS),
        )
        assertEquals(
            "a read frame carries readTs alone",
            CloudSocket.IncomingReceipt(from = "anna", id = "m-3", read = true, readTs = 5000),
            receipts.poll(2, TimeUnit.SECONDS),
        )
        socket.cancel()
    }

    @Test
    fun reportsTheBuildItIsRunningAndSaysNothingWhenItCannotKnow() {
        assertEquals(174L, authFrame(appVersion = { 174L }).getValue("appVersion").jsonPrimitive.content.toLong())
        // Absent, not zero: the server must never have to tell "an old client"
        // apart from "build zero" (`authenticate` in src/cloud/hub.js).
        assertNull(authFrame(appVersion = { 0L })["appVersion"])
    }

    private fun authFrame(appVersion: () -> Long): kotlinx.serialization.json.JsonObject {
        val frames = LinkedBlockingQueue<String>()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                frames.add(text)
                webSocket.send("""{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[]}""")
            }
        }))
        val ready = CountDownLatch(1)
        val connection = CloudSocket(client, appVersion = appVersion).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) = ready.countDown()
            override fun onFailure(value: CloudFailure) = ready.countDown()
            override fun onClosed() = Unit
        })
        assertTrue("ready frame not received", ready.await(5, TimeUnit.SECONDS))
        val auth = Json.parseToJsonElement(frames.poll(1, TimeUnit.SECONDS)).jsonObject
        connection.cancel()
        return auth
    }

    private fun connectAndReadCaps(lurk: Boolean): List<String> {
        val frames = LinkedBlockingQueue<String>()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                frames.add(text)
                webSocket.send("""{"k":"ready","self":{"login":"roman","name":"Roman"},"users":[]}""")
            }
        }))
        val ready = CountDownLatch(1)
        val connection = CloudSocket(client).connect(session(), object : CloudSocket.Observer {
            override fun onReady(self: CloudUser, users: List<CloudUser>, caps: Set<String>) = ready.countDown()
            override fun onFailure(value: CloudFailure) = ready.countDown()
            override fun onClosed() = Unit
        }, lurk = lurk)

        assertTrue("ready frame not received", ready.await(5, TimeUnit.SECONDS))
        val auth = Json.parseToJsonElement(frames.poll(1, TimeUnit.SECONDS)).jsonObject
        assertEquals("auth", auth.getValue("k").jsonPrimitive.content)
        connection.cancel()
        return auth.getValue("caps").jsonArray.map { it.jsonPrimitive.content }
    }

    private fun session() = CloudSession(
        server = server.url("/").toString(),
        token = "token-1",
        user = CloudUser("roman", "Roman"),
    )
}
