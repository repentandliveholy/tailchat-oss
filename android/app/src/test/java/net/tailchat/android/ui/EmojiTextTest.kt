package net.tailchat.android.ui

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.ParagraphStyle
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EmojiTextTest {
    private val family = "👨‍👩‍👧‍👦"
    private val table = EmojiTable(listOf(EmojiCategory("test", listOf("😀", "👍", "©️", "❤️‍🔥", family).map { EmojiEntry(it, "", "test.png") })))

    @Test fun emojiInsideALinkKeepsItsClickTargetStyleAndParagraph() {
        val url = "https://example.com/😀"
        val source = buildAnnotatedString {
            append(url)
            addLink(LinkAnnotation.Url(url), 0, length)
            addStyle(SpanStyle(fontWeight = FontWeight.Bold), 0, length)
            addStyle(ParagraphStyle(textAlign = TextAlign.Center), 0, length)
        }
        val (rendered, glyphs) = emojiVisuals(source, table)
        val start = url.indexOf("😀")
        val link = rendered.getLinkAnnotations(start, start + 2).single().item as LinkAnnotation.Url
        assertEquals(url, link.url)
        assertTrue(rendered.spanStyles.any { it.start <= start && it.end >= start + 2 && it.item.fontWeight == FontWeight.Bold })
        assertEquals(1, rendered.paragraphStyles.size)
        assertEquals(TextAlign.Center, rendered.paragraphStyles.single().item.textAlign)
        assertEquals(url, rendered.text)
        assertEquals(listOf("😀"), glyphs.values.toList())
    }

    @Test fun unknownModifiedEmojiIsNotSplitWhileKnownFamilyIsReplaced() {
        val source = AnnotatedString("tone 👍🏽 and family $family")
        val (rendered, glyphs) = emojiVisuals(source, table)
        assertEquals(source.text, rendered.text)
        assertEquals(listOf(family), glyphs.values.toList())
    }

    @Test fun textPresentationStaysTextButUnqualifiedJoinedEmojiKeepsItsPicture() {
        val source = AnnotatedString("© ©️ ❤‍🔥")
        val (rendered, glyphs) = emojiVisuals(source, table)
        assertEquals(source.text, rendered.text)
        assertEquals(listOf("©️", "❤‍🔥"), glyphs.values.toList())
        assertTrue(!isJumboEmoji("©", table))
        assertTrue(isJumboEmoji("❤‍🔥", table))
    }
}
