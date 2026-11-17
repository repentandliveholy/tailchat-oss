package net.tailchat.android.ui

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.json.JSONArray
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EmojiPreferencesTest {
    private val context get() = ApplicationProvider.getApplicationContext<Application>()
    private val disk get() = context.getSharedPreferences("tailchat", Context.MODE_PRIVATE)
    private val table = EmojiTable(listOf(EmojiCategory("smileys",
        (EmojiChoices.defaults + listOf("😀", "🎃", "🏳️‍🌈", "❤‍🔥", "❤️‍🔥")).distinct().map { EmojiEntry(it, "", "test.png") })))

    @Before @After fun clearEmojiKeys() {
        disk.edit().remove("quickReactions").remove("emojiRecent").commit()
    }

    @Test fun customSlotsSurviveExpansionAndForbiddenSlotIsReplacedWithoutDuplicates() {
        disk.edit().putString("quickReactions", JSONArray(listOf("😀", "🎃", "👌", "❤️", "🙏", "🔥")).toString()).commit()
        val result = EmojiPreferences(context).quick(table)
        assertEquals("😀", result[0])
        assertEquals("👌", result[2])
        assertFalse("🎃" in result)
        assertEquals(32, result.size)
        assertEquals(result.size, result.distinct().size)
    }

    @Test fun unknownAndDuplicateSlotsDoNotResetTheOtherCustomChoices() {
        val quick = EmojiChoices.normalize(listOf("😀", "not-an-emoji", "😀", "🙏"), table)
        assertEquals("😀", quick[0])
        assertEquals("🙏", quick[3])
        assertEquals(quick.size, quick.distinct().size)
        assertFalse("not-an-emoji" in quick)
    }

    @Test fun choosingAnExistingQuickGlyphSwapsRatherThanDuplicatesIt() {
        val prefs = EmojiPreferences(context)
        prefs.setQuick(0, "🙏", table)
        assertEquals("🙏", prefs.quick(table)[0])
        assertEquals("👍", prefs.quick(table)[4])
        val persisted = JSONArray(disk.getString("quickReactions", null))
        assertEquals("🙏", persisted.getString(0))
        assertEquals("👍", persisted.getString(4))
    }

    @Test fun recentChoicesAreSharedUniqueBoundedAndRestrictedOnlyAtSelection() {
        val prefs = EmojiPreferences(context)
        EmojiChoices.defaults.forEach { prefs.remember(it, table) }
        prefs.remember("🙏", table)
        prefs.remember("🎃", table)
        val recent = prefs.recent(table)
        assertEquals(24, recent.size)
        assertEquals("🙏", recent.first())
        assertEquals(24, recent.distinct().size)
        assertFalse("🎃" in recent)
        assertNotNull("History still has the original artwork", table.entry("🎃"))
        assertFalse(EmojiChoices.allowed("🏳️‍🌈"))
        assertTrue(EmojiChoices.allowed("🌈"))
        assertTrue(EmojiChoices.allowed("🥕"))
    }

    @Test fun graphemeSegmentationNeverSplitsJoinedOrTonedGlyphs() {
        val source = "A❤‍🔥👍🏽Z"
        assertEquals(listOf("A", "❤‍🔥", "👍🏽", "Z"), emojiSegments(source).map { source.substring(it) })
        assertNotNull(table.entry("❤‍🔥"))
        assertNull(table.entry("👍🏽"))
        assertTrue(isJumboEmoji("😀 ❤️‍🔥", table))
        assertFalse(isJumboEmoji("😀 hello", table))
        assertFalse(isJumboEmoji("😀 😀 😀 😀", table))
    }
}
