package net.tailchat.android

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Covers [Settings.voicePlaybackSpeed] and [nearestVoicePlaybackSpeed]: the
 * picker only offers [VOICE_PLAYBACK_SPEEDS], so whatever lands on disk —
 * from the picker itself, a future step added to the list, or a hand-edited
 * preferences file — must always snap back onto one of those five values,
 * never sit between them or crash the reader.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SettingsVoicePlaybackSpeedTest {
    private val context get() = ApplicationProvider.getApplicationContext<Application>()

    @Test
    fun `defaults to 1x with nothing stored`() {
        assertEquals(1f, Settings(context).voicePlaybackSpeed)
    }

    @Test
    fun `a picked speed survives a new Settings instance`() {
        Settings(context).voicePlaybackSpeed = 1.5f

        assertEquals(1.5f, Settings(context).voicePlaybackSpeed)
    }

    @Test
    fun `nearestVoicePlaybackSpeed snaps to the closest offered step`() {
        assertEquals(1f, nearestVoicePlaybackSpeed(1.1f))
        assertEquals(1.25f, nearestVoicePlaybackSpeed(1.3f))
        assertEquals(2f, nearestVoicePlaybackSpeed(1.95f))
        assertEquals(2f, nearestVoicePlaybackSpeed(5f))
    }

    @Test
    fun `a value off the step grid on disk reads back snapped, not raw`() {
        context.getSharedPreferences("tailchat", android.content.Context.MODE_PRIVATE).edit()
            .putFloat("voicePlaybackSpeed", 1.6f)
            .apply()

        assertEquals(1.5f, Settings(context).voicePlaybackSpeed)
    }
}
