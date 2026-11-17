package net.tailchat.android.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EmojiDraftFieldTest {
    private val family = "👨‍👩‍👧‍👦"
    private val table = EmojiTable(listOf(EmojiCategory("test", listOf(
        EmojiEntry("👍", "", "thumb.png"),
        EmojiEntry("👨", "", "man.png"),
        EmojiEntry(family, "", "family.png"),
        EmojiEntry("❤️‍🔥", "", "fire.png"),
        EmojiEntry("©️", "", "copyright.png"),
        EmojiEntry("🎃", "", "pumpkin.png"),
    ))))

    @Test fun joinedGlyphsAreHiddenWholeAndUnsupportedToneKeepsSystemRendering() {
        val text = "© 👍🏽 ❤‍🔥 $family"
        val fire = text.indexOf("❤‍🔥")
        val familyStart = text.indexOf(family)
        assertEquals(listOf(
            DraftEmojiSpan(fire, fire + "❤‍🔥".length, "fire.png"),
            DraftEmojiSpan(familyStart, familyStart + family.length, "family.png"),
        ), draftEmojiSpans(text, table))
    }

    @Test fun pickerExclusionsDoNotHideTypedOrPastedDraftContent() {
        assertEquals(listOf(DraftEmojiSpan(0, "🎃".length, "pumpkin.png")), draftEmojiSpans("🎃", table))
    }
}
