package net.tailchat.android.ui

import net.tailchat.android.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The message menu's read line — «Прочитано: 14:44 · телефон».
 *
 * `via` is the server's `clientKind`, a per-conversation fact about which
 * client last moved the peer's read watermark, and `''` on every snapshot the
 * server wrote before it tracked this. Two rules are worth pinning, and both
 * are the difference between a fact and a fabrication: the three known kinds
 * map to their three words (an Android build number included, dropped rather
 * than shown), and anything else — the empty string above all — contributes
 * nothing rather than a guessed client.
 *
 * Plain JUnit: the mapping and the value composition are pure, and the labels
 * are handed in/resolved as string resources, so no Compose is involved.
 */
class MessageMenuReadDetailTest {
    @Test
    fun `the three server client kinds map to their words`() {
        assertEquals(ReadClient.Browser, readClientOf("web"))
        assertEquals(ReadClient.Terminal, readClientOf("cli"))
        // The build number is deliberately dropped: the line says «телефон»,
        // not the sender's install id.
        assertEquals(ReadClient.Phone, readClientOf("android/450"))
        assertEquals(R.string.cloud_read_client_web, ReadClient.Browser.labelRes)
        assertEquals(R.string.cloud_read_client_cli, ReadClient.Terminal.labelRes)
        assertEquals(R.string.cloud_read_client_android, ReadClient.Phone.labelRes)
    }

    @Test
    fun `an unknown client is no client, never a guessed one`() {
        assertNull("an unlabelled snapshot names no client", readClientOf(""))
        assertNull(readClientOf("desktop"))
        assertNull("a build number is not a kind of its own", readClientOf("450"))
    }

    @Test
    fun `the value is the time alone unless a client can be named`() {
        assertEquals("14:44", readDetailValue("14:44", null))
        assertEquals("an empty label adds nothing", "14:44", readDetailValue("14:44", ""))
        assertEquals("14:44 · браузер", readDetailValue("14:44", "браузер"))
    }
}
