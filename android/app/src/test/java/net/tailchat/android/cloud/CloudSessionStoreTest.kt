package net.tailchat.android.cloud

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * [CloudSessionStore] tries to encrypt the token with an Android-Keystore-held
 * key, but the JVM Robolectric runs on has no `"AndroidKeyStore"` provider at
 * all (real device/Keystore coverage lives in `app/src/androidTest`) — which
 * makes this suite an exact rehearsal of the store's documented "no usable
 * Keystore" fallback: every save/load here goes through the plaintext
 * `token` key, the same one a pre-encryption install already has on disk.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CloudSessionStoreTest {

    private val context get() = ApplicationProvider.getApplicationContext<Application>()

    @Test
    fun `save then load round-trips`() {
        val store = CloudSessionStore(context)
        val session = CloudSession("https://cloud.example", "tok-1", CloudUser("alice", "Alice"))

        store.save(session)

        assertEquals(session, store.load())
    }

    @Test
    fun `a pre-existing plaintext token from before this change still loads`() {
        val session = CloudSession("https://cloud.example", "legacy-tok", CloudUser("bob", "Bob"))
        context.getSharedPreferences("cloud-session", Context.MODE_PRIVATE).edit()
            .putString("server", session.server)
            .putString("token", session.token)
            .putString("login", session.user.login)
            .putString("name", session.user.name)
            .apply()

        assertEquals(session, CloudSessionStore(context).load())
    }

    @Test
    fun `clear removes the token`() {
        val store = CloudSessionStore(context)
        store.save(CloudSession("https://cloud.example", "tok-2", CloudUser("carol", "Carol")))

        store.clear()

        assertNull(store.load())
        assertNull(context.getSharedPreferences("cloud-session", Context.MODE_PRIVATE).getString("token", null))
    }

    @Test
    fun `no session on disk is null, not a crash`() {
        assertNull(CloudSessionStore(context).load())
    }

    @Test
    fun `an undecryptable token_enc value is treated as no session, not a crash`() {
        // A device with no usable Keystore never writes this key, so this can
        // only be reached by a corrupted blob or a Keystore key invalidated
        // after the fact — either way, recovering it is impossible and the
        // safe behaviour is "no session", not a thrown exception.
        context.getSharedPreferences("cloud-session", Context.MODE_PRIVATE).edit()
            .putString("server", "https://cloud.example")
            .putString("token_enc", "not-a-real-ciphertext-blob")
            .putString("login", "dave")
            .putString("name", "Dave")
            .apply()

        assertNull(CloudSessionStore(context).load())
    }

    @Test
    fun `saving after loading a legacy token keeps only one copy on disk`() {
        val session = CloudSession("https://cloud.example", "legacy-tok-2", CloudUser("erin", "Erin"))
        context.getSharedPreferences("cloud-session", Context.MODE_PRIVATE).edit()
            .putString("server", session.server)
            .putString("token", session.token)
            .putString("login", session.user.login)
            .putString("name", session.user.name)
            .apply()

        val store = CloudSessionStore(context)
        assertEquals(session, store.load())
        store.save(session)

        val prefs = context.getSharedPreferences("cloud-session", Context.MODE_PRIVATE)
        val hasPlain = prefs.getString("token", null) != null
        val hasEncrypted = prefs.getString("token_enc", null) != null
        assertEquals(1, listOf(hasPlain, hasEncrypted).count { it })
    }
}
