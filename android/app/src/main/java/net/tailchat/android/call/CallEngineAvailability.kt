package net.tailchat.android.call

import android.content.Context
import android.util.Log
import org.webrtc.PeerConnectionFactory

/**
 * Whether this process can actually place or answer a call — decided once,
 * lazily, the first time anything asks. Owner decision (docs/specs/
 * 2026-09-15-android-calls-plan.md §9.1): `armeabi-v7a` is the weakest ABI
 * this app still ships to, libwebrtc's native library can fail to load there
 * (or on an OOM-constrained OEM image) for reasons no `runCatching` around a
 * single call site can anticipate, and the one thing that must never happen
 * is the whole app crashing over a feature the person may never use. Every
 * other call-package entry point reads [available] rather than calling
 * `PeerConnectionFactory.initialize` itself, so there is exactly one place
 * this can fail.
 */
object CallEngineAvailability {
    private const val TAG = "CallEngine"

    @Volatile private var checked = false
    @Volatile private var result = false

    val available: Boolean get() = result

    /** Call once, early (Application.onCreate is fine) — before the socket
     *  layer needs [available] for its own `caps`. Safe to call more than
     *  once; only the first call does any work. */
    fun ensureChecked(context: Context) {
        if (checked) return
        synchronized(this) {
            if (checked) return
            result = runCatching {
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                        .createInitializationOptions(),
                )
                true
            }.onFailure { error ->
                Log.w(TAG, "libwebrtc did not initialise; calls are unsupported on this device", error)
            }.getOrDefault(false)
            checked = true
        }
    }
}
