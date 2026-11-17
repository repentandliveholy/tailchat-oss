package net.tailchat.android.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Which link a message previews, and how wide the hero picture is allowed to be on a given card. */
class LinkPreviewCardTest {
    // ---- the link ----

    @Test
    fun theFirstLinkOfAMessageIsPreviewed() {
        assertEquals("https://example.com/a", firstLinkIn("look: https://example.com/a and https://example.org/b"))
        assertEquals("http://example.com", firstLinkIn("http://example.com"))
        assertEquals("https://example.com/a?x=1&y=2#top", firstLinkIn("go to https://example.com/a?x=1&y=2#top now"))
    }

    @Test
    fun aMessageWithoutAWebLinkHasNone() {
        assertNull(firstLinkIn(""))
        assertNull(firstLinkIn("no link here"))
        assertNull(firstLinkIn("ftp://example.com/file"))
        assertNull(firstLinkIn("example.com/a"))
        assertNull(firstLinkIn("HTTP://EXAMPLE.COM")) // web's pattern is case-sensitive too
    }

    @Test
    fun sentencePunctuationAfterALinkIsNotPartOfIt() {
        assertEquals("https://example.com/a", firstLinkIn("see https://example.com/a."))
        assertEquals("https://example.com/a", firstLinkIn("see https://example.com/a, or not"))
        assertEquals("https://example.com/a", firstLinkIn("really https://example.com/a?!"))
        assertEquals("https://example.com/a", firstLinkIn("note: https://example.com/a;"))
        assertEquals("https://example.com/a", firstLinkIn("at https://example.com/a:"))
    }

    @Test
    fun aClosingBracketBelongsToTheLinkOnlyIfItOpenedOneInside() {
        // Wrapped in brackets by the writer: the closer is theirs.
        assertEquals("https://example.com/a", firstLinkIn("(see https://example.com/a)"))
        assertEquals("https://example.com/a", firstLinkIn("[https://example.com/a]"))
        assertEquals("https://example.com/a", firstLinkIn("{https://example.com/a}"))
        // Part of the address: kept.
        assertEquals("https://en.wikipedia.org/wiki/Foo_(bar)", firstLinkIn("https://en.wikipedia.org/wiki/Foo_(bar)"))
        // Punctuation first, then brackets — the order web takes them in.
        assertEquals("https://example.com/a", firstLinkIn("(https://example.com/a)."))
    }

    @Test
    fun aLinkEndsAtTheFirstWhitespace() {
        assertEquals("https://example.com/a", firstLinkIn("https://example.com/a\nnext line https://example.com/b"))
        assertEquals("https://example.com/a", firstLinkIn("https://example.com/a\u00A0and more")) // a no-break space too
    }

    // ---- the hero ----

    private val max = 280f

    @Test
    fun aHeroFillsTheCardWhenThatCropsLittle() {
        // 1.9:1 picture on a 300 px card: full width, the height follows the shape (no crop at all here).
        val (width, height) = linkHeroSize(300f, 1.9f, max)
        assertEquals(300f, width, 1e-3f)
        assertEquals(300f / 1.9f, height, 1e-3f)
        // A card where the ceiling bites but the crop stays under 15%: still full width, 280 tall.
        val (w2, h2) = linkHeroSize(600f, 1.9f, max)
        assertEquals(600f, w2, 1e-3f)
        assertEquals(280f, h2, 1e-3f)
    }

    @Test
    fun aHeroKeepsItsOwnProportionsWhenFillingTheCardWouldCropTooMuch() {
        // 1.9:1 on a 700 px card: filling it would cut 1 - 280 / (700 / 1.9) = 24% off — so the picture's own
        // 532×280, centred, and the same 280 tall as on either side of the step.
        val (width, height) = linkHeroSize(700f, 1.9f, max)
        assertEquals(280f * 1.9f, width, 1e-3f)
        assertEquals(280f, height, 1e-3f)
        // A portrait is always in this case: 140 px of a 300 px card.
        val (w2, h2) = linkHeroSize(300f, 0.5f, max)
        assertEquals(140f, w2, 1e-3f)
        assertEquals(280f, h2, 1e-3f)
    }

    @Test
    fun theHeroesHeightIsContinuousAcrossTheStep() {
        // The step is at width = maxHeight * ratio / 0.85; the height must not move when the width crosses it.
        val ratio = 1.5f
        val step = max * ratio / 0.85f
        val below = linkHeroSize(step - 1f, ratio, max)
        val above = linkHeroSize(step + 1f, ratio, max)
        assertEquals(below.second, above.second, 1e-3f)
    }

    @Test
    fun noRoomOrNoShapeIsAnEmptyBox() {
        assertEquals(0f to 0f, linkHeroSize(0f, 1.9f, max))
        assertEquals(0f to 0f, linkHeroSize(300f, 0f, max))
        assertEquals(0f to 0f, linkHeroSize(300f, 1.9f, 0f))
    }
}
