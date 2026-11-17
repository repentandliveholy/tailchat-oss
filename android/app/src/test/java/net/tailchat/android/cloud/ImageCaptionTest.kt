package net.tailchat.android.cloud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A picture's caption travels in the frame's `text`, which web, the terminal and every old APK
 * show verbatim — so what goes there when nobody typed anything is part of the wire contract,
 * and what comes back as "no caption" decides whether web draws the picture with a bubble.
 */
class ImageCaptionTest {
    private val placeholder = "🖼 [Image]"

    @Test
    fun anEmptyOrBlankCaptionIsThePlaceholder() {
        assertEquals(placeholder, imageMessageText("", placeholder))
        assertEquals(placeholder, imageMessageText("   \n\t ", placeholder))
    }

    @Test
    fun aCaptionIsTrimmedAndOtherwiseSentAsTyped() {
        assertEquals("sunset", imageMessageText("  sunset \n", placeholder))
        assertEquals("line one\nline two", imageMessageText("line one\nline two", placeholder))
    }

    @Test
    fun aCaptionOfExactlyTheCeilingIsKeptWhole() {
        val caption = "a".repeat(IMAGE_CAPTION_MAX_CHARS)
        assertEquals(caption, imageMessageText(caption, placeholder))
    }

    @Test
    fun aLongerCaptionIsCutAtTheCeiling() {
        val cut = imageMessageText("b".repeat(IMAGE_CAPTION_MAX_CHARS + 500), placeholder)
        assertEquals(IMAGE_CAPTION_MAX_CHARS, cut.length)
    }

    @Test
    fun theCeilingNeverSplitsAnEmojiInHalf() {
        // 3999 letters then a two-char emoji: the emoji would straddle the 4000th character, and a
        // lone high surrogate on the wire is a broken message.
        val cut = imageMessageText("a".repeat(IMAGE_CAPTION_MAX_CHARS - 1) + "😀" + "tail", placeholder)
        assertEquals(IMAGE_CAPTION_MAX_CHARS - 1, cut.length)
        assertTrue(cut.all { it == 'a' })
    }

    @Test
    fun theEditorsLimitCannotFeedABrokenEmojiToTheSender() {
        val prefix = "a".repeat(IMAGE_CAPTION_MAX_CHARS - 1)
        val typed = limitImageCaption(prefix + "😀tail")
        assertEquals(prefix, imageMessageText(typed, placeholder))
    }

    @Test
    fun typingKeepsWhitespaceUntilThePictureIsSent() {
        assertEquals("  caption  ", limitImageCaption("  caption  "))
    }

}
