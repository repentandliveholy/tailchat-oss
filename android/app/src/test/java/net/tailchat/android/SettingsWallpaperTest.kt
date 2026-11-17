package net.tailchat.android

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Covers [Settings.wallpaper] and [Settings.Companion.readWallpaper]. Two things
 * here are load-bearing rather than bookkeeping:
 *
 *  - nothing stored reads as [ChatWallpaper.Aurora], the owner's default for
 *    every install that never picked a pattern (web's `DEFAULT_WALLPAPER` too);
 *    and a stored choice — `None` included — is kept, because the value is only
 *    ever written when a person picks one; and
 *  - an unreadable value on disk falls back to the same default instead of
 *    failing, because a hand-edited preferences file (or a value a future build
 *    retires) must not leave the setting in a state the sheet cannot show.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SettingsWallpaperTest {
    private val context get() = ApplicationProvider.getApplicationContext<Application>()

    private fun store(value: String) {
        context.getSharedPreferences("tailchat", Context.MODE_PRIVATE).edit()
            .putString("wallpaper", value)
            .apply()
    }

    @Test
    fun `defaults to aurora with nothing stored`() {
        assertEquals(ChatWallpaper.Aurora, Settings(context).wallpaper)
    }

    @Test
    fun `a stored plain background stays plain`() {
        // The pre-184 default was `None`, but no build ever wrote it on its
        // own: a stored `None` is somebody's choice, and the new default must
        // not override it.
        store("None")
        assertEquals(ChatWallpaper.None, Settings(context).wallpaper)
    }

    @Test
    fun `reading the default writes nothing`() {
        Settings(context).wallpaper
        assertEquals(
            null,
            context.getSharedPreferences("tailchat", Context.MODE_PRIVATE).getString("wallpaper", null),
        )
    }

    @Test
    fun `every offered pattern reads back as itself`() {
        assertEquals(8, ChatWallpaper.entries.size)
        for (value in ChatWallpaper.entries) {
            Settings(context).wallpaper = value
            assertEquals(value, Settings(context).wallpaper)
        }
    }

    @Test
    fun `a value this build does not offer reads as the default`() {
        store("checkerboard")
        assertEquals(ChatWallpaper.Aurora, Settings(context).wallpaper)

        store("")
        assertEquals(ChatWallpaper.Aurora, Settings(context).wallpaper)

        assertEquals(null, Settings.readWallpaper(null))
    }

    @Test
    fun `the reader accepts both the enum name and the word web stores`() {
        // Android persists the enum name, the way every other appearance axis
        // in this file does (`palette`, `appFont`, `roundness`). The reader is
        // case-insensitive so the eight words shared with `data-wallpaper` in
        // `web/cloud/app.js` always resolve, whichever spelling is on disk.
        Settings(context).wallpaper = ChatWallpaper.Topo
        assertEquals(
            "Topo",
            context.getSharedPreferences("tailchat", Context.MODE_PRIVATE).getString("wallpaper", null),
        )
        val web = mapOf(
            "none" to ChatWallpaper.None,
            "dots" to ChatWallpaper.Dots,
            "ruled" to ChatWallpaper.Ruled,
            "diamond" to ChatWallpaper.Diamond,
            "aurora" to ChatWallpaper.Aurora,
            "waves" to ChatWallpaper.Waves,
            "topo" to ChatWallpaper.Topo,
            "doodle" to ChatWallpaper.Doodle,
        )
        for ((word, value) in web) {
            assertEquals(value, Settings.readWallpaper(word))
            assertEquals(value, Settings.readWallpaper(value.name))
            assertEquals(value, Settings.readWallpaper(word.uppercase()))
        }
    }
}
