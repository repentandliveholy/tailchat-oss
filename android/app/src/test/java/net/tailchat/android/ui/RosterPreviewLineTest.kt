package net.tailchat.android.ui

import net.tailchat.android.cloud.CloudDelivery
import net.tailchat.android.cloud.CloudPreview
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Issue #25: the roster preview's read mark closes the line instead of opening
 * it, and it is split out from the body so the row can ellipsize the body while
 * the mark keeps its width. This pins the pure body/mark split that the row's
 * layout relies on.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RosterPreviewLineTest {
    private val captions = mapOf(
        "image" to "фото",
        "voice" to "голосовое",
        "call" to "звонок",
    )

    private fun line(preview: CloudPreview?, self: String = "roman") =
        rosterPreviewLine(preview, selfLogin = self, youLabel = "вы") { captions.getValue(it) }

    @Test
    fun `an unread own message puts the body first and the mark last`() {
        val result = line(CloudPreview(from = "roman", text = "привет", read = false))
        assertEquals("{вы}: привет", result?.body)
        assertEquals(CloudDelivery.Accepted, result?.mark)
    }

    @Test
    fun `a read own message retains the read rung`() {
        val result = line(CloudPreview(from = "roman", text = "привет", read = true))
        assertEquals("{вы}: привет", result?.body)
        assertEquals(CloudDelivery.Read, result?.mark)
    }

    @Test
    fun `a delivered own message retains delivery before the peer reads it`() {
        val result = line(CloudPreview(from = "roman", text = "привет", delivered = true))
        assertEquals("{вы}: привет", result?.body)
        assertEquals(
            "delivery must not be collapsed into read just because both use a double vector",
            CloudDelivery.Delivered,
            result?.mark,
        )
    }

    @Test
    fun `read outranks delivery when the row knows both`() {
        val result = line(CloudPreview(from = "roman", text = "привет", read = true, delivered = true))
        assertEquals(CloudDelivery.Read, result?.mark)
    }

    @Test
    fun `a peer message carries no mark`() {
        val result = line(CloudPreview(from = "anna", text = "привет", delivered = true))
        assertEquals("привет", result?.body)
        assertNull("a peer's own delivery says nothing about this account", result?.mark)
    }

    @Test
    fun `media is named rather than shown`() {
        val result = line(CloudPreview(from = "roman", text = "", media = "voice", read = false))
        assertEquals("{вы}: голосовое", result?.body)
        assertEquals(CloudDelivery.Accepted, result?.mark)
    }

    @Test
    fun `an empty body yields no line at all`() {
        assertNull(line(CloudPreview(from = "roman", text = "  ")))
        assertNull(line(null))
    }

    @Test
    fun `newlines are flattened into one line`() {
        val result = line(CloudPreview(from = "anna", text = "one\ntwo\nthree"))
        assertEquals("one two three", result?.body)
    }
}
