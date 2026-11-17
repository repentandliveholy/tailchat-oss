package net.tailchat.android.call

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import net.tailchat.android.CallRingtone
import net.tailchat.android.SoundEffects
import net.tailchat.android.SoundPack
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CallRingPreviewTest {
    private val context get() = ApplicationProvider.getApplicationContext<Application>()

    @Test
    fun `play each ringtone preview without error`() {
        for (tone in CallRingtone.entries) {
            CallRingPreview.play(context, tone)
        }
        CallRingPreview.stop()
    }

    @Test
    fun `play sound cue preview without error`() {
        SoundEffects.preview(context)
        SoundEffects.stopPreview()
    }
}
