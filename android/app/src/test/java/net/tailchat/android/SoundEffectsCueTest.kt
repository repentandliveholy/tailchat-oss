package net.tailchat.android

import android.app.Application
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * What a notification channel is given as its sound.
 *
 * A channel's sound is a `Uri` string frozen at creation, and it used to be
 * `android.resource://<package>/<id>` — a *compile-time resource id*. Ids of
 * `res/raw` entries are assigned in name order, so the next app update that
 * inserted entries ahead of the cues (the four call ringtones, 2026-09-17)
 * moved every one of them: a channel created before the move began playing
 * whatever file inherited its id, while the in-app cue, loaded by resource
 * reference at play time, stayed correct. These tests pin the replacement:
 * [SoundEffects.receivedCue] hands the channel a *name*, which
 * `ContentResolver.getResourceId` resolves against the installed package when
 * the sound is played — and an identity in the channel id that an earlier
 * build's channels cannot collide with.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SoundEffectsCueTest {
    private val context get() = ApplicationProvider.getApplicationContext<Application>()

    private fun raw(resId: Int): ByteArray =
        context.resources.openRawResource(resId).use { it.readBytes() }

    private fun bytes(uri: Uri): ByteArray = File(requireNotNull(uri.path)).readBytes()

    /** What a player gets when it opens the channel's sound: `ContentResolver`,
     *  exactly as `MediaPlayer.setDataSource(context, uri)` uses it. */
    private fun resolved(uri: Uri): ByteArray =
        requireNotNull(context.contentResolver.openInputStream(uri)).use { it.readBytes() }

    @Test
    fun `a bundled cue is addressed by name, so a res-raw insertion cannot move it`() {
        Settings(context).soundPack = SoundPack.Soft

        val cue = SoundEffects.receivedCue(context)

        assertEquals("android.resource", cue.uri.scheme)
        assertEquals(context.packageName, cue.uri.authority)
        // Two segments — `raw/<name>` — and never the one-segment form whose
        // number is an index into the resource table the next build rewrites.
        assertEquals(listOf("raw", "soft_received"), cue.uri.pathSegments)
        assertEquals("soft-received", cue.token)
        // What the player does with it: `ContentResolver` resolves the name
        // against the installed package every time the sound is played, so this
        // is the cue's own bytes — and stays them across app updates.
        assertArrayEquals(raw(R.raw.soft_received), resolved(cue.uri))
    }

    @Test
    fun `switching packs changes both the sound and the identity`() {
        Settings(context).soundPack = SoundPack.Soft
        val soft = SoundEffects.receivedCue(context)
        Settings(context).soundPack = SoundPack.Classic
        val classic = SoundEffects.receivedCue(context)

        assertEquals(listOf("raw", "received"), classic.uri.pathSegments)
        // The Classic cues are the mp3s the web client plays, byte for byte, so
        // "sounds like the browser" is a property of the file, not of this code.
        assertArrayEquals(raw(R.raw.received), resolved(classic.uri))
        assertNotEquals(
            "a channel keeps whatever sound it was created with, so the other pack's " +
                "channel cannot be reused — it would go on playing the wrong cue",
            soft.token,
            classic.token,
        )
    }

    @Test
    fun `with a picked file, the cue is that file and wake keeps the built-in one`() {
        val picked = File(context.filesDir, "cue-picked.mp3")
        picked.writeBytes(raw(R.raw.sent))
        Settings(context).apply {
            customSoundPath = picked.absolutePath
            soundPack = SoundPack.Custom
        }

        val incoming = SoundEffects.receivedCue(context)

        assertEquals("file", incoming.uri.scheme)
        assertEquals(picked.absolutePath, incoming.uri.path)
        assertEquals("custom", incoming.pack)
        assertArrayEquals(raw(R.raw.sent), bytes(incoming.uri))
        // A picked file replaces the incoming cue only: `/wake` has no picked
        // sound of its own, so it plays the built-in pack's — and its channel
        // belongs to that pack, not to "custom".
        val wake = SoundEffects.wakeCue(context)
        assertEquals(listOf("raw", "wake"), wake.uri.pathSegments)
        assertEquals("classic", wake.pack)
    }
}
