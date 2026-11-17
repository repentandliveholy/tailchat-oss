package net.tailchat.android

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Covers the surviving half of [Settings.contactAliases]: it is no longer the
 * source of truth for display (the roster's server `alias` is — issue #28), but
 * it is still where the *legacy* local map waits for the one-time migration,
 * together with the [Settings.contactAliasesMigrated] flag that guards it.
 * The contract is only "survives a restart and never crashes on whatever is
 * already on disk".
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SettingsContactAliasTest {
    private val context get() = ApplicationProvider.getApplicationContext<Application>()

    @Test
    fun `a legacy alias survives a new Settings instance`() {
        Settings(context).contactAliases = mapOf("anna" to "Аня с работы")

        val reloaded = Settings(context)
        assertEquals("Аня с работы", reloaded.contactAliases["anna"])
        assertNull(reloaded.contactAliases["boris"])
    }

    @Test
    fun `clearing the map persists`() {
        val settings = Settings(context)
        settings.contactAliases = mapOf("anna" to "Аня")
        settings.contactAliases = emptyMap()

        assertTrue(Settings(context).contactAliases.isEmpty())
    }

    @Test
    fun `two different logins keep independent aliases`() {
        val settings = Settings(context)
        settings.contactAliases = mapOf("anna" to "Аня", "boris" to "Боря")

        assertEquals(mapOf("anna" to "Аня", "boris" to "Боря"), settings.contactAliases)
    }

    @Test
    fun `the migration flag defaults to false and survives a restart`() {
        val settings = Settings(context)
        assertFalse("a fresh install has nothing to migrate", settings.contactAliasesMigrated)
        settings.contactAliasesMigrated = true
        assertTrue(Settings(context).contactAliasesMigrated)
    }

    @Test
    fun `a value stored before this feature existed does not crash the reader`() {
        context.getSharedPreferences("tailchat", Context.MODE_PRIVATE).edit()
            .putString("contactAliases", "not json at all")
            .apply()

        assertTrue(Settings(context).contactAliases.isEmpty())
    }
}
