package net.tailchat.android.call

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Exercises native ownership: a completed call must not retain factory workers. */
@RunWith(AndroidJUnit4::class)
class WebRtcEngineLifecycleTest {
    @Test
    fun repeatedCallsExchangeAudioAndReleaseTheirWorkers() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val main = Handler(Looper.getMainLooper())
        android.os.ParcelFileDescriptor.AutoCloseInputStream(
            instrumentation.uiAutomation.executeShellCommand(
                "pm grant net.tailchat.android android.permission.RECORD_AUDIO",
            ),
        ).use { it.readBytes() }
        CallEngineAvailability.ensureChecked(context)
        assertTrue(CallEngineAvailability.available)
        val baselineWorkers = factoryWorkers()
        repeat(3) { attempt ->
            val connectedLatch = CountDownLatch(2)
            val failure = AtomicReference<String?>(null)
            lateinit var caller: WebRtcEngine
            lateinit var callee: WebRtcEngine
            var finished = false // Read and written only on Main.
            fun listener(isCaller: Boolean) = object : WebRtcEngineListener {
                private var counted = false
                override fun onLocalIceCandidate(candidate: IceCandidate) {
                    main.post {
                        if (!finished) (if (isCaller) callee else caller).addRemoteIceCandidates(listOf(candidate))
                    }
                }
                override fun onIceConnectionChange(connected: Boolean, failed: Boolean) {
                    if (connected && !counted) {
                        counted = true
                        connectedLatch.countDown()
                    }
                    if (failed) failure.set("ICE failed")
                }
                override fun onLocalSdpReady(sdp: String, type: String) {
                    main.post {
                        if (!finished) {
                            if (isCaller) callee.setRemoteOffer(sdp) else caller.setRemoteAnswer(sdp)
                        }
                    }
                }
                override fun onLocalSdpError(reason: String) { failure.set(reason) }
            }
            caller = WebRtcEngine(context, listener(true))
            callee = WebRtcEngine(context, listener(false))
            val audio = CallAudio(context)
            fun stats(engine: WebRtcEngine): CallMediaStats {
                val result = AtomicReference<CallMediaStats>()
                val latch = CountDownLatch(1)
                instrumentation.runOnMainSync {
                    engine.readStats { result.set(it); latch.countDown() }
                }
                assertTrue("stats callback", latch.await(5, TimeUnit.SECONDS))
                return result.get()
            }
            try {
                instrumentation.runOnMainSync {
                    audio.start()
                    caller.start(emptyList())
                    callee.start(emptyList())
                    caller.createOffer()
                }
                assertTrue("native call $attempt: ${failure.get()}", connectedLatch.await(20, TimeUnit.SECONDS))
                val firstCaller = stats(caller)
                val firstCallee = stats(callee)
                Thread.sleep(3_000)
                val lastCaller = stats(caller)
                val lastCallee = stats(callee)
                Log.i("CallLifecycleTest", "attempt=$attempt caller=$firstCaller -> $lastCaller callee=$firstCallee -> $lastCallee")
                assertTrue("caller receives RTP", lastCaller.bytesReceived > firstCaller.bytesReceived)
                assertTrue("callee receives RTP", lastCallee.bytesReceived > firstCallee.bytesReceived)
                assertTrue("caller sends RTP", lastCaller.bytesSent > firstCaller.bytesSent)
                assertTrue("callee sends RTP", lastCallee.bytesSent > firstCallee.bytesSent)
            } finally {
                instrumentation.runOnMainSync {
                    finished = true
                    caller.release()
                    callee.release()
                    caller.release()
                    callee.release()
                    audio.stop()
                }
            }
            val deadline = SystemClock.elapsedRealtime() + 5_000
            while (factoryWorkers() != baselineWorkers && SystemClock.elapsedRealtime() < deadline) {
                Thread.sleep(20)
            }
            assertEquals("call $attempt leaked native WebRTC workers", baselineWorkers, factoryWorkers())
        }
    }

    private fun factoryWorkers(): Set<String> = File("/proc/self/task").listFiles().orEmpty()
        .filter { task ->
            val name = runCatching { File(task, "comm").readText().trim() }.getOrDefault("")
            name.startsWith("network_thread") || name.startsWith("worker_thread") || name.startsWith("signaling_threa")
        }
        .mapTo(mutableSetOf()) { it.name }
}
