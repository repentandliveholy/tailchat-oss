package net.tailchat.android.cloud

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaRecorder
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.core.content.ContextCompat
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.Base64

/**
 * Verifies on real Android hardware or emulator that MediaRecorder can write
 * its MPEG-4 AAC voice recording to a temporary file in cacheDir.
 *
 * This test guards against the SELinux regression (Issue #21): MediaRecorder
 * runs inside the mediaserver daemon (u:r:mediaserver:s0), which SELinux strictly
 * forbids from writing to app FUSE proxy descriptors (u:object_r:app_fuse_file:s0).
 * Standard cache files are accessible and can be safely unlinked upon completion.
 */
@RunWith(AndroidJUnit4::class)
class VoiceRecordingOnDeviceTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Before
    fun requireExplicitMicrophonePermission() {
        assumeTrue(
            "Grant microphone permission explicitly on the isolated test device first",
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED,
        )
    }

    @Test
    fun voiceRecordingProducesValidFileInCacheDir() {
        val file = File.createTempFile("voice-test-", ".m4a", context.cacheDir)
        val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(context)
        } else {
            @Suppress("DEPRECATION") MediaRecorder()
        }
        try {
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            recorder.setAudioEncodingBitRate(24_000)
            recorder.setAudioSamplingRate(16_000)
            recorder.setAudioChannels(1)
            recorder.setOutputFile(file.absolutePath)
            recorder.prepare()
            recorder.start()
            Thread.sleep(600)
            recorder.stop()
            val extractor = MediaExtractor()
            try {
                extractor.setDataSource(file.absolutePath)
                val audio = (0 until extractor.trackCount).map(extractor::getTrackFormat)
                    .first { it.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true }
                assertTrue("Capture must contain a playable duration", audio.getLong(MediaFormat.KEY_DURATION) >= 250_000L)
            } finally {
                extractor.release()
            }
            val dataUrl = "data:audio/mp4;base64," + Base64.getEncoder().encodeToString(file.readBytes())
            assertNotNull("The actual voice-note decoder must accept the capture", VoiceWaveformDecoder.decodeFromDataUrl(dataUrl))
        } finally {
            recorder.release()
            file.delete()
        }
    }
}
