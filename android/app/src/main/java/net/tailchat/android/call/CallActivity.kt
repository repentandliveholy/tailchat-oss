package net.tailchat.android.call

import android.Manifest
import android.app.KeyguardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Build
import android.os.IBinder
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.foundation.layout.height
import androidx.compose.ui.text.style.TextAlign
import androidx.core.content.ContextCompat
import kotlinx.coroutines.delay
import net.tailchat.android.ChatService
import net.tailchat.android.R
import net.tailchat.android.ui.TailchatTheme

/**
 * The one screen a call has. `showWhenLocked`/`turnScreenOn` (manifest) so an
 * incoming call's full-screen intent actually raises this over a locked
 * screen — §4.2. This activity owns no call state of its own: everything it
 * shows is [ServiceCloudController.callState], the same as every other
 * screen in this app reads through [ChatService.LocalBinder].
 */
class CallActivity : ComponentActivity() {
    private var binder by mutableStateOf<ChatService.LocalBinder?>(null)

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            binder = service as? ChatService.LocalBinder
        }
        override fun onServiceDisconnected(name: ComponentName?) {
            binder = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The manifest already carries showWhenLocked/turnScreenOn, but that
        // pair only decides how a *new* instance is displayed. This activity
        // is singleInstance, so a second call reuses a live instance, and a
        // relaunch onto a locked screen would otherwise sit behind the
        // keyguard. Setting both here covers that, and the dismiss request
        // pushes an unsecured keyguard aside outright.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            (getSystemService(KeyguardManager::class.java))?.requestDismissKeyguard(this, null)
        }
        bindService(Intent(this, ChatService::class.java), connection, Context.BIND_AUTO_CREATE)
        setContent {
            // Answering without RECORD_AUDIO opens no microphone at all
            // (libwebrtc cannot create its `AudioRecord`), so the peer would
            // hear silence for the whole call with nothing on screen saying
            // why. The permission is asked here, from the interactive Answer —
            // §4.2's "microphone only after the user's own action".
            val micPermission = rememberLauncherForActivityResult(
                ActivityResultContracts.RequestPermission(),
            ) { granted -> if (granted) binder?.cloudController?.answerCall() }
            TailchatTheme {
                Surface(Modifier.fillMaxSize()) {
                    val current = binder
                    if (current != null) {
                        val ui by current.cloudController.callState.collectAsState()
                        LaunchedEffect(ui.call) {
                            // A finished call has nothing left to ask, so
                            // this screen leaves at once — no «Call ended»
                            // step, no Close button to dismiss by hand
                            // (owner: «close кнопка вообще не нужна»). The
                            // outcome is not lost: `onCallEnded` has already
                            // written the call into the conversation.
                            when (ui.call) {
                                is CallState.Idle -> finish()
                                is CallState.Ended -> {
                                    current.cloudController.dismissCall()
                                    finish()
                                }
                                else -> Unit
                            }
                        }
                        // While this screen is up, ask the engine what the
                        // call is actually carrying: a silent call is otherwise
                        // indistinguishable from a working one.
                        LaunchedEffect(ui.call is CallState.Active) {
                            while (ui.call is CallState.Active) {
                                current.cloudController.sampleCallMedia()
                                delay(CallController.STATS_INTERVAL_MS)
                            }
                        }
                        CallScreen(
                            ui = ui,
                            onAnswer = {
                                val granted = ContextCompat.checkSelfPermission(
                                    this@CallActivity,
                                    Manifest.permission.RECORD_AUDIO,
                                ) == PackageManager.PERMISSION_GRANTED
                                if (granted) current.cloudController.answerCall()
                                else micPermission.launch(Manifest.permission.RECORD_AUDIO)
                            },
                            onDecline = current.cloudController::declineCall,
                            onHangup = current.cloudController::hangupCall,
                            onToggleMute = { current.cloudController.setCallMuted(!ui.muted) },
                            onToggleSpeaker = {
                                current.cloudController.setCallAudioRoute(
                                    if (ui.route == AudioRoute.Speaker) AudioRoute.Earpiece else AudioRoute.Speaker,
                                )
                            },
                        )
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        runCatching { unbindService(connection) }
    }

    companion object {
        fun incomingIntent(context: Context, callId: String, peer: String): Intent =
            baseIntent(context, callId, peer)

        fun activeIntent(context: Context, callId: String, peer: String): Intent =
            baseIntent(context, callId, peer)

        private fun baseIntent(context: Context, callId: String, peer: String): Intent =
            Intent(context, CallActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                putExtra(EXTRA_CALL_ID, callId)
                putExtra(EXTRA_CALL_PEER, peer)
            }
    }
}

@Composable
private fun CallScreen(
    ui: CallUiState,
    onAnswer: () -> Unit,
    onDecline: () -> Unit,
    onHangup: () -> Unit,
    onToggleMute: () -> Unit,
    onToggleSpeaker: () -> Unit,
) {
    val call = ui.call
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(top = 64.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(ui.peerName.ifBlank { "…" }, style = MaterialTheme.typography.headlineMedium)
            Text(statusText(call), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 8.dp))
            if (call is CallState.Active) {
                var elapsedSec by remember(call.callId, call.connectedAtMs) {
                    mutableStateOf(((System.currentTimeMillis() - call.connectedAtMs).coerceAtLeast(0) / 1000))
                }
                LaunchedEffect(call.callId, call.connectedAtMs) {
                    while (true) {
                        elapsedSec = (System.currentTimeMillis() - call.connectedAtMs).coerceAtLeast(0) / 1000
                        delay(1_000)
                    }
                }
                Text(
                    "%d:%02d".format(elapsedSec / 60, elapsedSec % 60),
                    style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
            // «Connected» is not the same as «audible», and until now the two
            // were indistinguishable on screen: a call with a platform-muted
            // microphone or no arriving RTP looked exactly like a working one.
            ui.media?.let { media ->
                if (media.inboundSilent) {
                    Text(
                        stringResource(R.string.call_no_inbound_audio),
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
                if (media.micSilent) {
                    Text(
                        stringResource(R.string.call_mic_silent),
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
        }

        val ringingIncoming = call is CallState.Ringing && call.isIncoming
        // Equal-width columns, not SpaceEvenly: a label is as wide as its
        // text, and with free-width children two long labels («Выключить
        // микрофон», «Сбросить связь») ran into each other and pulled their
        // circles off the row. A weighted cell clips nothing and keeps every
        // circle on one line.
        Row(
            Modifier.fillMaxWidth().padding(bottom = 56.dp),
            verticalAlignment = Alignment.Top,
        ) {
            if (ringingIncoming) {
                CallActionButton(
                    icon = Icons.Filled.CallEnd,
                    label = stringResource(R.string.call_decline),
                    container = CallRed,
                    onClick = onDecline,
                    modifier = Modifier.weight(1f),
                )
                CallActionButton(
                    icon = Icons.Filled.Call,
                    label = stringResource(R.string.call_answer),
                    container = CallGreen,
                    onClick = onAnswer,
                    modifier = Modifier.weight(1f),
                )
            } else {
                CallActionButton(
                    icon = if (ui.muted) Icons.Filled.MicOff else Icons.Filled.Mic,
                    label = stringResource(if (ui.muted) R.string.call_unmute else R.string.call_mute),
                    container = MaterialTheme.colorScheme.surfaceVariant,
                    content = MaterialTheme.colorScheme.onSurface,
                    size = SECONDARY_BUTTON_DP,
                    onClick = onToggleMute,
                    modifier = Modifier.weight(1f),
                )
                CallActionButton(
                    icon = Icons.Filled.CallEnd,
                    label = stringResource(R.string.call_hangup),
                    container = CallRed,
                    onClick = onHangup,
                    modifier = Modifier.weight(1f),
                )
                CallActionButton(
                    icon = Icons.AutoMirrored.Filled.VolumeUp,
                    label = stringResource(R.string.call_speaker),
                    container = if (ui.route == AudioRoute.Speaker) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.surfaceVariant
                    },
                    content = if (ui.route == AudioRoute.Speaker) {
                        MaterialTheme.colorScheme.onPrimary
                    } else {
                        MaterialTheme.colorScheme.onSurface
                    },
                    size = SECONDARY_BUTTON_DP,
                    onClick = onToggleSpeaker,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/**
 * One call control: a thumb-sized circle with its own label under it.
 *
 * The circle sits in a box as tall as the *largest* control, so a 64 dp
 * Mute and an 88 dp Hang up line up on one row instead of stepping; the
 * label is centred in the cell the caller gives this button (a weighted
 * column), wraps to two lines and is never clipped. Both are the fix for
 * «кнопки при звонке и подписи очень кривые»: free-width children let
 * «Выключить микрофон» and «Сбросить связь» collide and drag their circles
 * out of line.
 *
 * The colours are fixed rather than taken from `colorScheme`: Answer must
 * read as green and anything that ends a call as red in every palette this
 * app ships, including the green one where `primary` is itself green.
 */
@Composable
private fun CallActionButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    container: Color,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    content: Color = Color.White,
    size: Dp = PRIMARY_BUTTON_DP,
) {
    Column(modifier = modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            modifier = Modifier.height(PRIMARY_BUTTON_DP),
            contentAlignment = Alignment.Center,
        ) {
            FilledIconButton(
                onClick = onClick,
                modifier = Modifier.size(size),
                shape = CircleShape,
                colors = IconButtonDefaults.filledIconButtonColors(
                    containerColor = container,
                    contentColor = content,
                ),
            ) {
                Icon(icon, contentDescription = label, modifier = Modifier.size(size / 2.2f))
            }
        }
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            textAlign = TextAlign.Center,
            maxLines = 2,
            modifier = Modifier.fillMaxWidth().padding(top = 10.dp, start = 2.dp, end = 2.dp),
        )
    }
}

/** Answer/Hang up: the two controls a person hits without looking. 88 dp is
 *  a dialer key, not a toolbar icon. */
private val PRIMARY_BUTTON_DP = 88.dp

/** Mute/Speaker — still well over the 48 dp touch-target floor, visibly
 *  subordinate to Hang up. */
private val SECONDARY_BUTTON_DP = 64.dp

/** Fixed, not `colorScheme`: «положить трубку» must read as red and Answer
 *  as green in every palette this app ships, including the green one where
 *  `primary` itself is green. */
private val CallGreen = Color(0xFF1B8E3C)
private val CallRed = Color(0xFFC62828)

@Composable
private fun statusText(call: CallState): String = when (call) {
    CallState.Idle -> ""
    is CallState.Outgoing -> stringResource(R.string.call_outgoing)
    is CallState.Ringing -> if (call.isIncoming) stringResource(R.string.call_incoming) else stringResource(R.string.call_ringing)
    is CallState.Connecting -> stringResource(R.string.call_connecting)
    is CallState.Active -> stringResource(R.string.call_active)
    is CallState.Ended -> when (call.reason) {
        CallEndReason.Declined -> stringResource(R.string.call_ended_declined)
        CallEndReason.Busy -> stringResource(R.string.call_ended_busy)
        CallEndReason.Timeout -> stringResource(R.string.call_ended_timeout)
        CallEndReason.Failed -> stringResource(R.string.call_ended_failed)
        CallEndReason.Unsupported -> stringResource(R.string.call_ended_unsupported)
        else -> stringResource(R.string.call_ended_hangup)
    }
}
