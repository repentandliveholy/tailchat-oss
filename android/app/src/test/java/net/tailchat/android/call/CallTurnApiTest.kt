package net.tailchat.android.call

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import net.tailchat.android.cloud.CloudException
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class CallTurnApiTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var api: CallTurnApi

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = OkHttpClient.Builder().callTimeout(3, TimeUnit.SECONDS).build()
        api = CallTurnApi(client)
    }

    @After
    fun tearDown() {
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
        server.shutdown()
    }

    @Test
    fun stunOnlyResponseParsesWithNoUsernameOrCredential() = runBlocking {
        server.enqueue(
            MockResponse().setBody("""{"ttl":600,"iceServers":[{"urls":["stun:203.0.113.5:3478"]}]}"""),
        )
        val config = api.fetch(server.url("/").toString(), "tok-1")
        val request = server.takeRequest()
        assertEquals("Bearer tok-1", request.getHeader("Authorization"))
        assertTrue(request.path?.endsWith("/tailchat/api/turn") == true)
        assertEquals(600, config.ttlSeconds)
        assertEquals(1, config.iceServers.size)
        assertEquals(listOf("stun:203.0.113.5:3478"), config.iceServers[0].urls)
        assertNull(config.iceServers[0].username)
    }

    @Test
    fun turnResponseParsesUsernameAndCredential() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"ttl":600,"iceServers":[
                    {"urls":["stun:203.0.113.5:3478"]},
                    {"urls":["turn:203.0.113.5:3478?transport=udp","turn:203.0.113.5:3478?transport=tcp"],
                     "username":"1700000000:roman","credential":"abc123=="}
                ]}""",
            ),
        )
        val config = api.fetch(server.url("/").toString(), "tok-1")
        assertEquals(2, config.iceServers.size)
        val turn = config.iceServers[1]
        assertEquals("1700000000:roman", turn.username)
        assertEquals("abc123==", turn.credential)
        assertEquals(2, turn.urls.size)
    }

    @Test
    fun unauthorizedThrowsCloudException() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"unknown_token"}"""))
        try {
            api.fetch(server.url("/").toString(), "bad-token")
            fail("expected CloudException")
        } catch (error: CloudException) {
            assertEquals("unknown_token", error.code)
        }
    }
}
