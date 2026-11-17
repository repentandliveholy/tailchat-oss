package net.tailchat.android.cloud

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import net.tailchat.android.Settings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The one-time legacy-nickname migration (issue #28): the local
 * `Settings.contactAliases` map is pushed to the server, entry by entry, as
 * complete rosters arrive.
 *
 * The invariant these tests exist for: the local map is no longer a display
 * fallback — every screen reads the server `alias` — so the durable
 * `contactAliasesMigrated` flag may be written **only** once the map is empty.
 * A peer missing from the current roster keeps its entry (and keeps the pass
 * unresolved), so the nickname is migrated on a later roster rather than
 * silently lost.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ContactAliasMigrationTest {
    private val context get() = ApplicationProvider.getApplicationContext<Application>()
    private fun settings() = Settings(context)

    private fun user(login: String, alias: String? = null) =
        CloudUser(login = login, name = login, alias = alias)

    @Test
    fun `an alias for a peer absent from the roster stays put and does not finish the migration`() = runBlocking {
        val settings = settings()
        settings.contactAliases = mapOf("anna" to "Аня")
        val posted = mutableListOf<Pair<String, String>>()

        // First roster does not contain anna.
        val first = migrateLegacyAliases(settings, listOf(user("boris"))) { l, n -> posted += l to n }

        assertNull(first)
        assertTrue("a peer absent from the roster must not be POSTed", posted.isEmpty())
        assertEquals("the entry must be kept", mapOf("anna" to "Аня"), settings.contactAliases)
        assertFalse("the migration is not finished while an entry is owed", settings.contactAliasesMigrated)

        // Later roster does contain anna.
        migrateLegacyAliases(settings, listOf(user("anna"))) { l, n -> posted += l to n }

        assertEquals(listOf("anna" to "Аня"), posted)
        assertTrue("the entry migrates once its peer is back", settings.contactAliases.isEmpty())
        assertTrue("and only then is the flag set", settings.contactAliasesMigrated)
    }

    @Test
    fun `the flag is set once the map ends up empty`() = runBlocking {
        val settings = settings()
        settings.contactAliases = mapOf("anna" to "Аня")

        migrateLegacyAliases(settings, listOf(user("anna"))) { _, _ -> }

        assertTrue(settings.contactAliases.isEmpty())
        assertTrue(settings.contactAliasesMigrated)
    }

    @Test
    fun `an empty map finishes the migration immediately`() = runBlocking {
        val settings = settings()
        // No local aliases at all.
        migrateLegacyAliases(settings, emptyList()) { _, _ -> }

        assertTrue(settings.contactAliasesMigrated)
    }

    @Test
    fun `a server alias wins and the local entry is dropped without a POST`() = runBlocking {
        val settings = settings()
        settings.contactAliases = mapOf("anna" to "Аня")
        val posted = mutableListOf<Pair<String, String>>()

        migrateLegacyAliases(settings, listOf(user("anna", alias = "Аня-сервер"))) { l, n -> posted += l to n }

        assertTrue("the authoritative value needs no POST", posted.isEmpty())
        assertTrue(settings.contactAliases.isEmpty())
        assertTrue(settings.contactAliasesMigrated)
    }

    @Test
    fun `a failed POST keeps the entry and blocks the flag`() = runBlocking {
        val settings = settings()
        settings.contactAliases = mapOf("anna" to "Аня")

        val failure = migrateLegacyAliases(settings, listOf(user("anna"))) { _, _ ->
            throw CloudException("unreachable")
        }

        assertNull(failure)
        assertEquals("the entry is retried, never dropped", mapOf("anna" to "Аня"), settings.contactAliases)
        assertFalse(settings.contactAliasesMigrated)
    }

    @Test
    fun `an invalid alias is surfaced but the entry is kept`() = runBlocking {
        val settings = settings()
        settings.contactAliases = mapOf("anna" to "\u0000\u0007")

        val failure = migrateLegacyAliases(settings, listOf(user("anna"))) { _, _ ->
            throw CloudException("invalid_alias")
        }

        assertEquals("invalid_alias", failure?.code)
        assertEquals(mapOf("anna" to "\u0000\u0007"), settings.contactAliases)
        assertFalse(settings.contactAliasesMigrated)
    }
}
