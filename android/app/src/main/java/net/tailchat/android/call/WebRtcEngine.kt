package net.tailchat.android.call

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate as WebRtcIceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule

/** What this device is offering/answering with — §9.3: a parameter of the
 *  call, never a hardcoded constant, so a later video phase adds a kind
 *  here instead of reworking every caller. Only `Audio` is actually wired
 *  up; the sealed type exists so that rework is additive. */
enum class MediaKind { Audio }

/** Callbacks [CallController] reacts to — every one of them arrives on
 *  whatever thread libwebrtc's signalling thread happens to be, so the
 *  implementation is expected to hop back to `Dispatchers.Main` itself,
 *  the same contract [net.tailchat.android.cloud.CloudSocket.Observer] uses. */
interface WebRtcEngineListener {
    fun onLocalIceCandidate(candidate: IceCandidate)
    fun onIceConnectionChange(connected: Boolean, failed: Boolean)
    fun onLocalSdpReady(sdp: String, type: String)
    fun onLocalSdpError(reason: String)
}

/**
 * What the call is actually carrying, read straight off libwebrtc's own
 * `getStats`. A call whose ICE says «connected» can still be silent in either
 * direction — the microphone may be silenced by the platform, or no RTP may be
 * arriving at all — and nothing else in this app can tell those apart.
 *
 * [outboundAudioLevel]/[inboundAudioLevel] are 0..1 as libwebrtc reports them;
 * an exactly-zero outbound level while unmuted is what a platform-muted
 * microphone looks like from inside the process.
 */
data class CallMediaStats(
    val bytesSent: Long = 0,
    val bytesReceived: Long = 0,
    val outboundAudioLevel: Double = 0.0,
    val inboundAudioLevel: Double = 0.0,
)

/** What [CallController] needs from a call engine — extracted purely so
 *  `CallControllerTest` can supply a fake instead of a real
 *  [WebRtcEngine], which needs a live `PeerConnectionFactory` and cannot
 *  run on the JVM unit-test target. */
interface CallEngine {
    fun start(iceServers: List<IceServerConfig>)
    fun createOffer()
    /** Applies a remote offer and answers it. One entry point rather than two
     *  calls the controller has to sequence itself: `createAnswer` in the
     *  wrong signalling state is a `setLocalDescription` that fails, and
     *  which state this is depends on a native callback the controller
     *  cannot see. */
    fun setRemoteOffer(sdp: String)
    fun setRemoteAnswer(sdp: String)
    fun addRemoteIceCandidates(candidates: List<IceCandidate>)
    fun setMuted(muted: Boolean)
    fun restartIce()
    /** Samples libwebrtc's `getStats`; [onStats] may arrive on any thread. */
    fun readStats(onStats: (CallMediaStats) -> Unit)
    fun release()
}

/**
 * One instance per call — [CallController] creates it when a call starts and
 * releases it (never reuses it) when the call ends, mirroring how
 * `VoicePlaybackController` treats a `MediaPlayer`. Every entry point here
 * assumes [CallEngineAvailability.available] is already `true`; the caller
 * is responsible for never constructing this otherwise.
 */
class WebRtcEngine(
    context: Context,
    private val listener: WebRtcEngineListener,
    private val mediaKinds: List<MediaKind> = listOf(MediaKind.Audio),
) : CallEngine {
    private val eglBase: EglBase = EglBase.create()
    private val audioDeviceModule = JavaAudioDeviceModule.builder(context)
        // Keep hardware AEC/NS selection unchanged; this engine owns the
        // module's native reference separately from the factory's reference.
        .setUseHardwareAcousticEchoCanceler(JavaAudioDeviceModule.isBuiltInAcousticEchoCancelerSupported())
        .setUseHardwareNoiseSuppressor(JavaAudioDeviceModule.isBuiltInNoiseSuppressorSupported())
        .createAudioDeviceModule()
    private val factory: PeerConnectionFactory = PeerConnectionFactory.builder()
        .setAudioDeviceModule(audioDeviceModule)
        .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
        .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
        .createPeerConnectionFactory()

    private var peerConnection: PeerConnection? = null
    private var audioSource: AudioSource? = null
    private var localAudioTrack: AudioTrack? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val pendingRemoteIce = mutableListOf<IceCandidate>()
    private var remoteDescriptionReady = false
    private var released = false

    /** [iceServers] comes from [CallTurnApi] — STUN always, TURN only when
     *  the deployment has a secret configured (§3.3). */
    override fun start(iceServers: List<IceServerConfig>) {
        val rtcServers = iceServers.map { server ->
            val builder = PeerConnection.IceServer.builder(server.urls)
            if (server.username != null) builder.setUsername(server.username)
            if (server.credential != null) builder.setPassword(server.credential)
            builder.createIceServer()
        }
        val rtcConfig = PeerConnection.RTCConfiguration(rtcServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        peerConnection = factory.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: WebRtcIceCandidate) {
                listener.onLocalIceCandidate(IceCandidate(candidate.sdp, candidate.sdpMid, candidate.sdpMLineIndex))
            }

            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                when (state) {
                    PeerConnection.IceConnectionState.CONNECTED,
                    PeerConnection.IceConnectionState.COMPLETED,
                    -> listener.onIceConnectionChange(connected = true, failed = false)
                    PeerConnection.IceConnectionState.FAILED,
                    PeerConnection.IceConnectionState.DISCONNECTED,
                    PeerConnection.IceConnectionState.CLOSED,
                    -> listener.onIceConnectionChange(connected = false, failed = state == PeerConnection.IceConnectionState.FAILED)
                    else -> Unit
                }
            }

            override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
            override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
            override fun onIceCandidatesRemoved(candidates: Array<out WebRtcIceCandidate>) = Unit
            override fun onAddStream(stream: org.webrtc.MediaStream) = Unit
            override fun onRemoveStream(stream: org.webrtc.MediaStream) = Unit
            override fun onDataChannel(channel: org.webrtc.DataChannel) = Unit
            override fun onRenegotiationNeeded() = Unit
            override fun onAddTrack(receiver: org.webrtc.RtpReceiver, streams: Array<out org.webrtc.MediaStream>) = Unit
        })

        if (mediaKinds.contains(MediaKind.Audio)) {
            val source = factory.createAudioSource(MediaConstraints())
            audioSource = source
            val track = factory.createAudioTrack(LOCAL_AUDIO_TRACK_ID, source)
            track.setEnabled(true)
            localAudioTrack = track
            peerConnection?.addTrack(track, listOf(LOCAL_STREAM_ID))
        }
    }

    override fun createOffer() {
        val pc = peerConnection ?: return
        pc.createOffer(sdpObserver(onSuccess = { sdp -> pc.setLocalDescription(sdpObserver(), sdp) }), MediaConstraints())
    }

    /** The answer is created here, after the remote offer is really applied —
     *  not by the caller, which has no way to know when that is. */
    private fun createAnswer() {
        val pc = peerConnection ?: return
        pc.createAnswer(sdpObserver(onSuccess = { sdp -> pc.setLocalDescription(sdpObserver(), sdp) }), MediaConstraints())
    }

    override fun setRemoteOffer(sdp: String) {
        setRemoteDescription(sdp, SessionDescription.Type.OFFER, answer = true)
    }

    override fun setRemoteAnswer(sdp: String) {
        setRemoteDescription(sdp, SessionDescription.Type.ANSWER, answer = false)
    }

    private fun setRemoteDescription(sdp: String, type: SessionDescription.Type, answer: Boolean) {
        val pc = peerConnection ?: return
        pc.setRemoteDescription(sdpObserver(onSet = {
            // Native SDP callbacks run on the signalling thread. The controller
            // owns this engine on Main; drain there, after SDP really succeeded.
            mainHandler.post {
                if (peerConnection !== pc) return@post
                remoteDescriptionReady = true
                addRemoteIceCandidates(pendingRemoteIce)
                pendingRemoteIce.clear()
                if (answer) createAnswer()
            }
        }), SessionDescription(type, sdp))
    }

    override fun addRemoteIceCandidates(candidates: List<IceCandidate>) {
        val pc = peerConnection
        // Trickle ICE often arrives while TURN is loading or the phone is
        // still ringing. libwebrtc cannot accept it until remote SDP is set.
        if (pc == null || !remoteDescriptionReady) {
            pendingRemoteIce.addAll(candidates)
            return
        }
        for (candidate in candidates) {
            pc.addIceCandidate(WebRtcIceCandidate(candidate.sdpMid ?: "", candidate.sdpMLineIndex ?: 0, candidate.candidate))
        }
    }

    override fun setMuted(muted: Boolean) {
        localAudioTrack?.setEnabled(!muted)
    }

    /** Restarts ICE gathering on the existing connection — §7.6's "Wi-Fi to
     *  LTE mid-call" scenario. A fresh offer is expected to follow through
     *  the same signalling path as the original one. */
    override fun restartIce() {
        peerConnection?.restartIce()
    }

    /**
     * Reads the byte counters and audio levels of the one audio stream this
     * call has. Only the four numbers [CallMediaStats] names are pulled out:
     * the outbound side comes from `media-source` (the level the microphone is
     * actually delivering, before any network) and `outbound-rtp`, the inbound
     * side from `inbound-rtp`.
     */
    override fun readStats(onStats: (CallMediaStats) -> Unit) {
        val pc = peerConnection ?: return
        pc.getStats { report ->
            var sent = 0L
            var received = 0L
            var outLevel = 0.0
            var inLevel = 0.0
            for (entry in report.statsMap.values) {
                val members = entry.members
                if (members["kind"] != null && members["kind"] != "audio") continue
                when (entry.type) {
                    "outbound-rtp" -> sent += members.longOf("bytesSent")
                    "inbound-rtp" -> {
                        received += members.longOf("bytesReceived")
                        inLevel = maxOf(inLevel, members.doubleOf("audioLevel"))
                    }
                    "media-source" -> outLevel = maxOf(outLevel, members.doubleOf("audioLevel"))
                }
            }
            onStats(CallMediaStats(sent, received, outLevel, inLevel))
        }
    }

    override fun release() {
        if (released) return
        released = true
        pendingRemoteIce.clear()
        remoteDescriptionReady = false
        val pc = peerConnection
        peerConnection = null
        pc?.close()
        pc?.dispose()
        localAudioTrack?.dispose()
        audioSource?.dispose()
        localAudioTrack = null
        audioSource = null
        factory.dispose()
        audioDeviceModule.release()
        eglBase.release()
    }

    private fun sdpObserver(
        onSuccess: (SessionDescription) -> Unit = {},
        onSet: () -> Unit = {},
    ): SdpObserver = object : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription) {
            onSuccess(sdp)
            listener.onLocalSdpReady(sdp.description, sdp.type.canonicalForm())
        }
        override fun onSetSuccess() = onSet()
        override fun onCreateFailure(reason: String) {
            Log.w(TAG, "SDP create failed: $reason")
            listener.onLocalSdpError(reason)
        }
        override fun onSetFailure(reason: String) {
            Log.w(TAG, "SDP set failed: $reason")
            listener.onLocalSdpError(reason)
        }
    }

    companion object {
        private const val TAG = "WebRtcEngine"
        private const val LOCAL_AUDIO_TRACK_ID = "tailchat-audio0"
        private const val LOCAL_STREAM_ID = "tailchat-stream0"
    }
}

/** `getStats` members are boxed as whatever the native layer produced —
 *  `BigInteger` for byte counters, `Double` for levels — so both are read
 *  through `Number` rather than cast to one of them. */
private fun Map<String, Any>.longOf(key: String): Long = (this[key] as? Number)?.toLong() ?: 0L

private fun Map<String, Any>.doubleOf(key: String): Double = (this[key] as? Number)?.toDouble() ?: 0.0
