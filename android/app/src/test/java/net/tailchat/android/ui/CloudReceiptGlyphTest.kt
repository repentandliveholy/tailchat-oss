package net.tailchat.android.ui

import net.tailchat.android.cloud.CloudDelivery
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The one ladder every client draws a message of ours with, and the thing the
 * delivered watermark exists to reach: ✓✓ is the peer's *device* holding the
 * message (`CloudDelivery.Delivered`) or the peer's read watermark passing it
 * (`CloudDelivery.Read`), and reverting Delivered to the single ✓ — the state
 * this whole change grew out of — is what the first assertion here catches.
 *
 * The roster preview draws from the same function (`rosterPreviewLine`), so its
 * read mark and the transcript's cannot drift; the second test pins that they
 * are literally the same ladder asked the same way.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CloudReceiptGlyphTest {
    @Test
    fun `every rung of the ladder draws its own mark`() {
        assertEquals("⧗", cloudReceiptGlyph(CloudDelivery.Queued))
        assertEquals("⧗", cloudReceiptGlyph(CloudDelivery.Sending))
        assertEquals("✓", cloudReceiptGlyph(CloudDelivery.Accepted))
        assertEquals(
            "the peer's device holding it is the doubled mark, not the single one the server's ✓ means",
            "✓✓",
            cloudReceiptGlyph(CloudDelivery.Delivered),
        )
        assertEquals("✓✓", cloudReceiptGlyph(CloudDelivery.Read))
        assertEquals("⚠", cloudReceiptGlyph(CloudDelivery.Failed))
    }

    @Test
    fun `the roster preview asks the same ladder the transcript does`() {
        // The exact `when` `rosterPreviewLine` uses: read first, then delivered,
        // then the plain sent mark. If either rung were to draw a different
        // glyph here than in the transcript, this fails.
        fun rosterMark(read: Boolean, delivered: Boolean) = cloudReceiptGlyph(
            when {
                read -> CloudDelivery.Read
                delivered -> CloudDelivery.Delivered
                else -> CloudDelivery.Accepted
            },
        )

        assertEquals("✓✓", rosterMark(read = true, delivered = true))
        assertEquals("✓✓", rosterMark(read = false, delivered = true))
        assertEquals("✓", rosterMark(read = false, delivered = false))
    }
}
