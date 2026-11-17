package net.tailchat.android.ui

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LinkPreviewAndroidTest {
    @Test fun unicodeSeparatorsTerminateLinksOnAndroid() {
        assertEquals("https://example.com/photo", firstLinkIn("https://example.com/photo\u00A0next"))
        assertEquals("https://example.com/photo", firstLinkIn("https://example.com/photo\uFEFFnext"))
        assertEquals("https://example.com/photo", firstLinkIn("https://example.com/photo\u2003next"))
    }
}
