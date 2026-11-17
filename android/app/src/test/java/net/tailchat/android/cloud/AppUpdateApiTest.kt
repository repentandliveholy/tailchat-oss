package net.tailchat.android.cloud

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppUpdateApiTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient
    private lateinit var api: AppUpdateApi

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = OkHttpClient.Builder().callTimeout(3, TimeUnit.SECONDS).build()
        api = AppUpdateApi(client)
    }

    @After
    fun tearDown() {
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
        server.shutdown()
    }

    @Test
    fun `fetchLatest accepts a same-origin url`() = runBlocking {
        val origin = server.url("/").toString().trimEnd('/')
        server.enqueue(
            MockResponse().setBody(
                """{"versionCode":10,"versionName":"1.0","url":"$origin/tailchat/tailchat.apk"}""",
            ),
        )

        val info = api.fetchLatest(origin)

        assertEquals(10L, info?.versionCode)
        assertEquals("$origin/tailchat/tailchat.apk", info?.url)
    }

    @Test
    fun `fetchLatest accepts a response with no url by defaulting to the same origin`() = runBlocking {
        val origin = server.url("/").toString().trimEnd('/')
        server.enqueue(MockResponse().setBody("""{"versionCode":10,"versionName":"1.0"}"""))

        val info = api.fetchLatest(origin)

        assertEquals("$origin/tailchat/tailchat.apk", info?.url)
    }

    @Test
    fun `fetchLatest rejects a url pointing at a different origin`() = runBlocking {
        val origin = server.url("/").toString().trimEnd('/')
        server.enqueue(
            MockResponse().setBody(
                """{"versionCode":10,"versionName":"1.0","url":"https://attacker.example/tailchat.apk"}""",
            ),
        )

        assertNull(api.fetchLatest(origin))
    }

    @Test
    fun `fetchLatest parses an announced sha256`() = runBlocking {
        val origin = server.url("/").toString().trimEnd('/')
        server.enqueue(
            MockResponse().setBody(
                """{"versionCode":10,"versionName":"1.0","sha256":"ABCDEF0123"}""",
            ),
        )

        assertEquals("abcdef0123", api.fetchLatest(origin)?.sha256)
    }

    @Test
    fun `fetchLatest leaves sha256 null when the server has not published one`() = runBlocking {
        val origin = server.url("/").toString().trimEnd('/')
        server.enqueue(MockResponse().setBody("""{"versionCode":10,"versionName":"1.0"}"""))

        assertNull(api.fetchLatest(origin)?.sha256)
    }

    @Test
    fun `download accepts bytes matching the announced checksum`(): Unit = runBlocking {
        val bytes = "fake apk bytes".toByteArray()
        val sha256 = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        server.enqueue(MockResponse().setBody(okio.Buffer().write(bytes)))
        val origin = server.url("/").toString().trimEnd('/')
        val info = AppUpdateInfo(10L, "1.0", "$origin/tailchat.apk", sha256)
        val context = ApplicationProvider.getApplicationContext<Application>()

        val file = api.download(context, info) {}

        assertNotNull(file)
        assertEquals(bytes.toList(), file.readBytes().toList())
        file.delete()
    }

    @Test(expected = java.io.IOException::class)
    fun `download rejects bytes that do not match the announced checksum`(): Unit = runBlocking {
        val bytes = "fake apk bytes".toByteArray()
        server.enqueue(MockResponse().setBody(okio.Buffer().write(bytes)))
        val origin = server.url("/").toString().trimEnd('/')
        val info = AppUpdateInfo(10L, "1.0", "$origin/tailchat.apk", "0000000000000000000000000000000000000000000000000000000000000000")
        val context = ApplicationProvider.getApplicationContext<Application>()

        api.download(context, info) {}
    }

    @Test
    fun `download skips the integrity check when no checksum was announced`(): Unit = runBlocking {
        val bytes = "fake apk bytes".toByteArray()
        server.enqueue(MockResponse().setBody(okio.Buffer().write(bytes)))
        val origin = server.url("/").toString().trimEnd('/')
        val info = AppUpdateInfo(10L, "1.0", "$origin/tailchat.apk", sha256 = null)
        val context = ApplicationProvider.getApplicationContext<Application>()

        val file = api.download(context, info) {}

        assertEquals(bytes.toList(), file.readBytes().toList())
        file.delete()
    }
}
