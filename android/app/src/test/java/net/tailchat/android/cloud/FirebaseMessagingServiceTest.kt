package net.tailchat.android.cloud

import android.app.Application
import com.google.firebase.messaging.RemoteMessage
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.testing.WorkManagerTestInitHelper
import net.tailchat.android.ChatService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config

/**
 * The FCM callback is the only place an untrusted, cross-device payload enters
 * the app. What matters is what it refuses: a malformed envelope, an envelope
 * for another account on this device, or one carrying a bogus scope must not
 * start the service or enqueue work. A valid one starts the same ChatService
 * that owns the sole SyncEngine — never a notification built here.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class FirebaseMessagingServiceTest {
    private lateinit var app: Application
    private lateinit var session: CloudSession

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        WorkManagerTestInitHelper.initializeTestWorkManager(
            app,
            Configuration.Builder().build(),
        )
        session = CloudSession("https://chat.example", "token-1", CloudUser("roman", "Roman"))
        CloudSessionStore(app).save(session)
    }

    private fun deliver(vararg data: Pair<String, String>) {
        val builder = RemoteMessage.Builder("tailchat@fcm")
        for ((key, value) in data) builder.addData(key, value)
        val service = Robolectric.buildService(TailchatFirebaseMessagingService::class.java).create().get()
        service.onMessageReceived(builder.build())
    }

    private fun validData(peer: String = "anna", messageId: String = "m1"): Array<Pair<String, String>> = arrayOf(
        "peer" to peer,
        "messageId" to messageId,
        "login" to session.user.login,
        "scope" to accountScopeOf(session),
    )

    @Test
    fun `a complete envelope starts ChatService with the routing identity`() {
        deliver(*validData())

        val started = Shadows.shadowOf(app).nextStartedService
        assertEquals(ChatService::class.java.name, started?.component?.className)
        assertEquals(ChatService.ACTION_WAKE, started?.action)
        assertEquals("anna", started?.getStringExtra(ChatService.EXTRA_PEER))
        assertEquals("m1", started?.getStringExtra(ChatService.EXTRA_MESSAGE_ID))
    }

    @Test
    fun `an envelope missing its message identity is refused without a start`() {
        deliver("peer" to "anna", "login" to session.user.login, "scope" to accountScopeOf(session))

        assertNull(Shadows.shadowOf(app).nextStartedService)
    }

    /** A call push carries no `messageId` — there is no message to fetch. It
     *  used to fall into the refusal above, which is why a phone whose socket
     *  had gone never rang: the one signal that could have brought the socket
     *  back was discarded on arrival. */
    @Test
    fun `a call envelope starts ChatService with the call wake action`() {
        deliver(
            "kind" to "call",
            "callId" to "c1",
            "peer" to "anna",
            "login" to session.user.login,
            "scope" to accountScopeOf(session),
        )

        val started = Shadows.shadowOf(app).nextStartedService
        assertEquals(ChatService::class.java.name, started?.component?.className)
        assertEquals(ChatService.ACTION_CALL_WAKE, started?.action)
        assertEquals("anna", started?.getStringExtra(ChatService.EXTRA_PEER))
        assertEquals("c1", started?.getStringExtra(ChatService.EXTRA_CALL_ID))
        assertNull(started?.getStringExtra(ChatService.EXTRA_MESSAGE_ID))
    }

    /** The account checks apply to a call exactly as they do to a message. */
    @Test
    fun `a call envelope for another account is refused`() {
        deliver(
            "kind" to "call",
            "callId" to "c1",
            "peer" to "anna",
            "login" to "someone-else",
            "scope" to accountScopeOf(session),
        )

        assertNull(Shadows.shadowOf(app).nextStartedService)
    }

    @Test
    fun `an envelope for another account on this device is refused`() {
        deliver(
            "peer" to "anna",
            "messageId" to "m1",
            "login" to "someone-else",
            "scope" to accountScopeOf(session),
        )

        assertNull(Shadows.shadowOf(app).nextStartedService)
    }

    @Test
    fun `an envelope carrying a foreign account scope is refused`() {
        deliver(
            "peer" to "anna",
            "messageId" to "m1",
            "login" to session.user.login,
            "scope" to "b".repeat(64),
        )

        assertNull(Shadows.shadowOf(app).nextStartedService)
    }

    @Test
    fun `a payload with control characters in the identity is refused instead of crashing`() {
        deliver(
            "peer" to "anna\u0000\u0001",
            "messageId" to "m1",
            "login" to session.user.login,
            "scope" to accountScopeOf(session),
        )

        assertNull(Shadows.shadowOf(app).nextStartedService)
    }
}
