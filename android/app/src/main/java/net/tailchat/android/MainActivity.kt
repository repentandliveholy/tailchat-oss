package net.tailchat.android

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import androidx.activity.ComponentActivity
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.activity.compose.PredictiveBackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import android.os.SystemClock
import androidx.activity.viewModels
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.Button
import android.widget.Toast
import kotlin.coroutines.cancellation.CancellationException
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.tailchat.android.data.DeviceDataKey
import net.tailchat.android.data.DeviceMigration
import kotlinx.coroutines.flow.collect
import net.tailchat.android.call.CallRinger
import net.tailchat.android.ui.BackOutcome
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay
import net.tailchat.android.ui.CloudUiViewModel
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import net.tailchat.android.ui.CloudScreen
import net.tailchat.android.ui.ChatScreen
import net.tailchat.android.ui.TailchatTheme
/**
 * A window onto the service. The conversation, the socket and the transcript all
 * live in [ChatService]; this activity only binds, renders and reports whether a
 * human is currently looking at the screen.
 */
class MainActivity : ComponentActivity() {

    private var binder by mutableStateOf<ChatService.LocalBinder?>(null)
    private var bound = false
    private var visible = false

    /** The same instance [CloudUiViewModel] `setContent` reads — created here
     *  too so [onStart] can bump [CloudUiViewModel.appStartSignal] without
     *  waiting for a composition to exist yet. */
    private val uiViewModel: CloudUiViewModel by viewModels()

    /**
     * A file chosen while the binder was away. Picking one pushes this activity
     * into the background, and `bindService` completes asynchronously on the way
     * back, so the result routinely arrives before the connection does — which
     * used to drop the chosen file on the floor without a word.
     */
    private var pendingFile: Uri? = null

    /** The conversation a tapped message notification asked for; applied once
     *  the binder lands, since the activity is routinely created by the tap. */
    private var pendingPeer: String? = null
    private var lastUpdateCheckMs = 0L

    private fun checkForegroundUpdate() {
        val now = System.currentTimeMillis()
        if (now - lastUpdateCheckMs < 5 * 60 * 1000L) return
        val controller = binder?.cloudController ?: return
        lastUpdateCheckMs = now
        controller.checkForUpdate()
    }


    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val local = service as? ChatService.LocalBinder ?: return
            binder = local
            // The bind can land after onResume, so catch up on what onResume did.
            if (visible) {
                local.setForeground(true)
                local.controller.markRead()
                checkForegroundUpdate()
            }
            val waiting = pendingFile
            if (waiting != null) {
                pendingFile = null
                local.controller.sendFile(waiting)
            }
            val peer = pendingPeer
            if (peer != null) {
                pendingPeer = null
                local.cloudController.selectPeer(peer)
            }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            binder = null
        }
    }

    /** The in-app language choice can only reach an activity's own resources
     *  through here on API < 33 (see [AppLocale]). */
    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(AppLocale.wrap(newBase))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Must land before super.onCreate(): this is what makes
        // Theme.Tailchat.Splash's icon/background the actual cold-start
        // frame instead of a blank window, on every API level back to this
        // app's minSdk (the platform only draws it unprompted from 31 on).
        val isColdStart = savedInstanceState == null
        val needsMigration = DeviceMigration.needed(this)
        val unavailable = if (!needsMigration || DeviceDataKey.hasWrappedKey(this) ||
            getDatabasePath(net.tailchat.android.data.TailchatDatabase.ENCRYPTED_NAME).exists())
            runCatching { DeviceDataKey.get(this) }.exceptionOrNull() else null
        val splashScreen = installSplashScreen()
        val splashStartUptime = SystemClock.uptimeMillis()
        splashScreen.setKeepOnScreenCondition {
            if (!isColdStart || needsMigration || unavailable != null) return@setKeepOnScreenCondition false
            val elapsed = SystemClock.uptimeMillis() - splashStartUptime
            val ready = elapsed >= SPLASH_MAX_HOLD_MS || binder?.let { b ->
                val state = b.cloudController.state.value
                !state.signedIn || state.rosterLoaded
            } == true
            !ready
        }
        super.onCreate(savedInstanceState)
        // Ensures the process-wide theme/sound mirror is populated before the
        // first composition reads it, regardless of whether ChatService has
        // finished its own onCreate yet.
        if (needsMigration || unavailable != null) {
            setContent {
                var busy by androidx.compose.runtime.remember { mutableStateOf(false) }
                var failure by androidx.compose.runtime.remember { mutableStateOf<String?>(null) }
                var confirmingRestart by androidx.compose.runtime.remember { mutableStateOf(false) }
                Surface(Modifier.fillMaxSize()) {
                    Column(
                        Modifier.fillMaxSize().padding(24.dp),
                        verticalArrangement = Arrangement.Center,
                    ) {
                        Text(if (unavailable != null)
                            "The device encryption key is unavailable. Unsent messages and P2P history cannot be restored without the original key. No data has been erased."
                        else
                            "Your local chat database, WAL, media and older history need encryption before chat starts. Originals will remain untouched for recovery. Keep enough free storage for a second copy.")
                        if (needsMigration && unavailable == null) {
                            Spacer(Modifier.height(16.dp))
                            Button(enabled = !busy, onClick = {
                                busy = true
                                lifecycleScope.launch {
                                    failure = runCatching { withContext(Dispatchers.IO) { DeviceMigration.migrate(this@MainActivity) } }
                                        .exceptionOrNull()?.message
                                    if (failure == null) recreate() else busy = false
                                }
                            }) { Text(if (busy) "Encrypting local data…" else "Encrypt local data") }
                        }
                        // Without this the screen is a dead end: the key cannot be
                        // recovered, so the only way back into chat is to abandon the
                        // local data — and a reinstall would do the same thing silently,
                        // which is worse than asking.
                        if (unavailable != null) {
                            Spacer(Modifier.height(16.dp))
                            Button(enabled = !busy, onClick = { confirmingRestart = true }) {
                                Text(if (busy) "Starting fresh…" else "Start fresh")
                            }
                        }
                        failure?.let { Text("Encryption stopped: $it. The originals are untouched; retry when the problem is resolved.") }
                    }
                }
                if (confirmingRestart) {
                    androidx.compose.material3.AlertDialog(
                        onDismissRequest = { confirmingRestart = false },
                        title = { Text("Start fresh?") },
                        text = {
                            Text(
                                "This deletes this device's local chat storage and its encryption key: " +
                                    "messages waiting to be sent and P2P history are lost for good. " +
                                    "Chats already synced to the cloud come back after you sign in.",
                            )
                        },
                        confirmButton = {
                            androidx.compose.material3.TextButton(onClick = {
                                confirmingRestart = false
                                busy = true
                                lifecycleScope.launch {
                                    failure = runCatching { withContext(Dispatchers.IO) { DeviceMigration.discard(this@MainActivity) } }
                                        .exceptionOrNull()?.message
                                    if (failure == null) recreate() else busy = false
                                }
                            }) { Text("Delete and start fresh") }
                        },
                        dismissButton = {
                            androidx.compose.material3.TextButton(onClick = { confirmingRestart = false }) { Text("Cancel") }
                        },
                    )
                }
            }
            return
        }
        val settings = Settings(this)
        // `startForegroundService` obliges the service to call
        // `startForeground` within seconds or the system kills the process.
        // That contract is only wanted in background mode; otherwise this is
        // an ordinary start from a visible activity, which needs no
        // notification at all.
        val serviceIntent = Intent(this, ChatService::class.java)
        if (settings.backgroundService) startForegroundService(serviceIntent)
        else startService(serviceIntent)
        pendingPeer = intent?.getStringExtra(EXTRA_OPEN_PEER)
        // Bound for the life of the activity rather than per onStart/onStop. The
        // service is started in its own right, so this keeps nothing alive that
        // would otherwise die — it only stops the connection from being torn down
        // and rebuilt every time another activity comes in front of this one.
        bound = bindService(
            Intent(this, ChatService::class.java),
            connection,
            Context.BIND_AUTO_CREATE,
        )

        setContent {
            val mode by AppPreferences.themeMode.collectAsState()
            val palette by AppPreferences.palette.collectAsState()
            val font by AppPreferences.font.collectAsState()
            val textScale by AppPreferences.textScale.collectAsState()
            val roundness by AppPreferences.roundness.collectAsState()
            val outlines by AppPreferences.outlines.collectAsState()
            val depthDesign by AppPreferences.depthDesign.collectAsState()
            TailchatTheme(
                mode = mode,
                palette = palette,
                font = font,
                textScale = textScale,
                roundness = roundness,
                depthDesign = depthDesign,
                outlines = outlines,
            ) {
                val controller = binder?.controller
                val cloudController = binder?.cloudController
                val cloudState = cloudController?.state?.collectAsState()
                val context = LocalContext.current
                val exitToast = stringResource(R.string.cloud_exit_confirm)
                val selectedPeer = cloudState?.value?.selectedPeer
                // Selecting a conversation is a route change reached by a tap,
                // not by this dispatcher's own Back handling — an armed exit
                // window from an earlier root visit must not survive it. See
                // CloudUiViewModel.noteRouteChanged.
                LaunchedEffect(selectedPeer) { uiViewModel.noteRouteChanged() }
                // The single Back dispatcher for the whole activity — see
                // CloudUiViewModel for the dismiss order and why every other
                // back handler in this module was removed. Predictive, not
                // plain BackHandler: a cancelled edge-swipe must be a true
                // no-op (nothing dismissed, nothing armed), which only the
                // gesture-progress API can tell apart from a completed one.
                PredictiveBackHandler { progress ->
                    try {
                        progress.collect { }
                        when (
                            uiViewModel.consumeBack(
                                conversationOpen = selectedPeer != null,
                                closeConversation = { cloudController?.closeConversation() },
                            )
                        ) {
                            BackOutcome.Consumed -> Unit
                            BackOutcome.ExitArmed ->
                                Toast.makeText(context, exitToast, Toast.LENGTH_SHORT).show()
                            // Never finish()/logout — LOCAL_FIRST_EXECUTION_PLAN.md §8A:
                            // the roster is a place the user leaves, not a state the
                            // app tears itself down from.
                            BackOutcome.ExitApp -> moveTaskToBack(true)
                        }
                    } catch (_: CancellationException) {
                        // Gesture cancelled (swiped back toward the edge and let
                        // go): no dismissal, no arm, no toast — exactly as if the
                        // press never happened.
                    }
                }
                RequestNotificationsOnce()
                RequestBatteryExemptionOnce()
                RequestFullScreenCallsOnce()
                val picker = rememberLauncherForActivityResult(
                    ActivityResultContracts.OpenDocument(),
                ) { uri ->
                    val ready = binder?.controller
                    if (uri == null) {
                        // cancelled: nothing to do
                    } else if (ready == null) {
                        pendingFile = uri
                    } else {
                        ready.sendFile(uri)
                    }
                }
                val isRosterLoading = cloudState?.value?.let { it.signedIn && !it.rosterLoaded } ?: false
                var rosterTimeout by remember { mutableStateOf(!isColdStart) }
                LaunchedEffect(Unit) {
                    if (isColdStart) {
                        delay(SPLASH_MAX_HOLD_MS)
                        rosterTimeout = true
                    }
                }
                val showStarting = controller == null || cloudController == null || (isRosterLoading && !rosterTimeout)
                if (showStarting) {
                    Starting()
                } else if (uiViewModel.showP2P) {
                    ChatScreen(
                        controller = controller,
                        cloudController = cloudController,
                        onPickFile = { picker.launch(arrayOf("*/*")) },
                        onCloud = { uiViewModel.closeP2P() },
                    )
                } else {
                    CloudScreen(
                        controller = cloudController,
                        onP2P = { uiViewModel.openP2P() },
                        uiViewModel = uiViewModel,
                    )
                }
            }
        }
    }

    /** A notification tap on an already-running app arrives here, not in
     *  `onCreate` — `singleTop` reuses the instance. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val peer = intent.getStringExtra(EXTRA_OPEN_PEER) ?: return
        val local = binder
        if (local == null) pendingPeer = peer else local.cloudController.selectPeer(peer)
    }

    override fun onStart() {
        super.onStart()
        // Cold launch and every genuine return from being stopped (Home,
        // recents, screen lock) — never a same-process navigation inside the
        // app, which is what makes this the right signal for "replay the
        // roster's logo reveal", not `onResume` (fires too eagerly: a
        // permission dialog or share sheet pauses and resumes the activity
        // without the user ever having left).
        uiViewModel.noteAppStarted()
        checkForegroundUpdate()
    }

    override fun onResume() {
        super.onResume()
        visible = true
        binder?.let {
            it.setForeground(true)
            it.controller.markRead()
            checkForegroundUpdate()
        }
    }

    override fun onPause() {
        super.onPause()
        visible = false
        binder?.let {
            it.setForeground(false)
            it.controller.stopTyping()
        }
    }

    override fun onDestroy() {
        if (bound) {
            unbindService(connection)
            bound = false
        }
        binder = null
        super.onDestroy()
    }

    companion object {
        /** Set by a message notification: the conversation to open on arrival. */
        const val EXTRA_OPEN_PEER = "open_peer"
        private const val SPLASH_MAX_HOLD_MS = 5000L
    }
}

@Composable
private fun Starting() {
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = colorResource(R.color.splash_background),
    ) {
        Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = Alignment.Center,
        ) {
            Image(
                painter = painterResource(R.drawable.splash_icon),
                contentDescription = null,
                modifier = Modifier.size(288.dp),
            )
        }
    }
}

/** Asked for exactly once per launch, and only when it is not already held. */
@Composable
private fun RequestNotificationsOnce() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        val context = LocalContext.current
        val request = rememberLauncherForActivityResult(
            ActivityResultContracts.RequestPermission(),
        ) { }
        LaunchedEffect(Unit) {
            val granted = ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) request.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}

/**
 * Asked for exactly once per launch, and only when the app is not already
 * exempt: without this, Doze and OEM battery managers eventually suspend the
 * cloud socket hours after the screen last turned on, which is what makes a
 * message land only once the app is reopened by hand instead of right away.
 * Declining leaves the chat working — just back to relying on `ChatService`
 * reconnecting the next time the app or its notification is touched.
 */
@Composable
private fun RequestBatteryExemptionOnce() {
    val context = LocalContext.current
    val request = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { }
    val background by AppPreferences.backgroundService.collectAsState()
    LaunchedEffect(background) {
        val settings = Settings(context)
        // Asked at most once per install, and only by an install that actually
        // needs the exemption: without background mode there is no socket to
        // keep alive while the phone sleeps, so the dialog was pure noise —
        // and it came back on every single launch.
        if (!background || settings.batteryPromptShown) return@LaunchedEffect
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val exempt = power?.isIgnoringBatteryOptimizations(context.packageName) ?: true
        if (!exempt) {
            settings.batteryPromptShown = true
            val intent = Intent(
                AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:${context.packageName}"),
            )
            runCatching { request.launch(intent) }
        }
    }
}

/**
 * Android 14 stopped granting `USE_FULL_SCREEN_INTENT` at install time to
 * everything that is not a dialer or an alarm clock. Without it an incoming
 * call cannot raise [net.tailchat.android.call.CallActivity] over the lock
 * screen: the call notification degrades to a heads-up, which a locked, dark
 * phone never displays — "звонки на заблокированном устройстве не видны".
 * The app still rings and still lights the screen ([CallRinger]), but the
 * answer buttons are a swipe away instead of in front of the person.
 *
 * One trip to the system toggle, once per install, and only where the grant
 * is actually missing.
 */
@Composable
private fun RequestFullScreenCallsOnce() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return
    val context = LocalContext.current
    val request = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { }
    LaunchedEffect(Unit) {
        val settings = Settings(context)
        if (settings.fullScreenPromptShown) return@LaunchedEffect
        if (CallRinger.canUseFullScreenIntent(context)) return@LaunchedEffect
        settings.fullScreenPromptShown = true
        val intent = Intent(
            AndroidSettings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
            Uri.parse("package:${context.packageName}"),
        )
        runCatching { request.launch(intent) }
    }
}
