package net.tailchat.android.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The speed picker's own labels, and the ones the dropdown menu items show —
 * both come from [formatVoiceSpeed]. A whole step must read "1×"/"2×", not
 * "1.0×"; every fractional step in [net.tailchat.android.VOICE_PLAYBACK_SPEEDS]
 * must round-trip exactly, since these are also what the user tapped to pick.
 */
class VoiceSpeedFormatTest {

    @Test
    fun wholeStepsDropTheDecimal() {
        assertEquals("1\u00d7", formatVoiceSpeed(1f))
        assertEquals("2\u00d7", formatVoiceSpeed(2f))
    }

    @Test
    fun fractionalStepsKeepTheirDigits() {
        assertEquals("1.25\u00d7", formatVoiceSpeed(1.25f))
        assertEquals("1.5\u00d7", formatVoiceSpeed(1.5f))
        assertEquals("1.75\u00d7", formatVoiceSpeed(1.75f))
    }
}
