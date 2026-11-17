package net.tailchat.android

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Fresh installs use the Green palette with the terminal face (owner's default
 * since APK 184, web's since 1.128); a palette or font somebody picked — Paper
 * included — is kept, because those keys are written only by a choice.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SettingsPaletteTest {
    private val context get() = ApplicationProvider.getApplicationContext<Application>()
    private val prefs get() = context.getSharedPreferences("tailchat", Context.MODE_PRIVATE)

    @Before
    @After
    fun clearPalettePreferences() {
        prefs.edit()
            .remove("palette")
            .remove("appTheme")
            .remove("appFont")
            .apply()
    }

    @Test
    fun `defaults to Green and the terminal face with no stored palette`() {
        assertEquals(AppPalette.Green, Settings(context).palette)
        assertEquals(AppFont.Mono, Settings(context).appFont)
    }

    @Test
    fun `a stored Paper choice keeps Paper and its antiqua`() {
        prefs.edit().putString("palette", "Paper").apply()
        assertEquals(AppPalette.Paper, Settings(context).palette)
        assertEquals(AppFont.Serif, Settings(context).appFont)
    }

    @Test
    fun `picking Paper with no font chosen writes the antiqua with it`() {
        Settings(context).palette = AppPalette.Paper
        assertEquals("Paper", prefs.getString("palette", null))
        assertEquals("Serif", prefs.getString("appFont", null))
    }

    @Test
    fun `reading the defaults writes nothing`() {
        Settings(context).palette
        Settings(context).appFont
        assertEquals(null, prefs.getString("palette", null))
        assertEquals(null, prefs.getString("appFont", null))
    }

    @Test
    fun `Paper remains an available explicit palette`() {
        assertEquals(AppPalette.Paper, Settings.readPalette("paper"))
    }
}
