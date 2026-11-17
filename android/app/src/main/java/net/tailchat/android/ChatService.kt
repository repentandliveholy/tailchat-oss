package net.tailchat.android

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentCallbacks2
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.net.Uri
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import net.tailchat.android.cloud.CloudController
import net.tailchat.android.cloud.CloudLink
import net.tailchat.android.cloud.CloudState
import net.tailchat.android.cloud.CloudUnreadNotification
import net.tailchat.android.cloud.ServiceCloudController
import net.tailchat.android.ui.clearImageCaches
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlin.math.abs

/**
 * Holds the channel open. A chat is a listening socket, and a socket that dies
 * with the last visible activity is a chat that only works while you are looking
 * at it — so the conversation lives here and the UI merely binds to it.
 */
class ChatService : Service() {

    inner class LocalBinder : Binder() {
        val controller: ChatController get() = engine
        val cloudController: CloudController get() = cloud
        fun setForeground(visible: Boolean) {
            engine.setForeground(visible)
            cloud.setForeground(visible)
            onActivityVisibility(visible)
        }
    }

    private lateinit var engine: ChatEngine
    private lateinit var cloud: ServiceCloudController
    private val binder = LocalBinder()
    private val scope = CoroutineScope(
        SupervisorJob() + Dispatchers.Main.immediate + CoroutineExceptionHandler { _, error ->
            // A coroutine that dies must not take the process with it. Before
            // this, one uncaught exception in any of the launches below reached
            // the thread's default handler, which is process death — and the
            // things launched here (the status line, the demotion grace, the
            // P2P engine) are not worth a crash: the next start rebuilds them.
            // Whatever the cloud *state* says is unaffected; that is owned by
            // [ServiceCloudController] and its own handler.
            Log.e(TAG, "ChatService background work failed", error)
        },
    )
    private var promoted = false
    /** A call is live, so this service's promotion must include the
     *  `microphone` type — see [foregroundTypes]. */
    private var micForCall = false
    /** Forces the next [promote] to re-issue `startForeground` even though
     *  the service is already foreground, because the *type set* changed. */
    private var micPromotionPending = false
    private var activityVisible = false
    private var demoteJob: Job? = null
    /** The last few messages per peer, so a notification can be a conversation
     *  (`MessagingStyle`) instead of a stack of unrelated one-liners. */
    private val threads = mutableMapOf<String, MutableList<CloudUnreadNotification>>()
    private var activePushWork = 0

    private enum class PostResult { Posted, Suppressed, Failed }

    override fun onCreate() {
        super.onCreate()
        createChannels()
        // Lazy and in runCatching (§9.1 of docs/specs/2026-09-15-android-calls-plan.md):
        // this is what decides whether the socket layer ever claims `call-v1`
        // and whether the call button ever shows — never whether the chat
        // itself comes up.
        net.tailchat.android.call.CallEngineAvailability.ensureChecked(this)
        engine = ChatEngine(this) { onNotify(it) }
        cloud = ServiceCloudController(this, ::onCloudUnread, ::onCloudWake, ::clearCloudNotifications)
        SoundEffects.warmUp(this)
        engine.start()
        // Only a background-mode install keeps a foreground service — and its
        // undismissable shade row — alive when nobody is looking. Everyone
        // else gets the notification only for as long as the service has to
        // outlive the activity, which is the few seconds between a start
        // command and the app coming to the front.
        if (backgroundEnabled()) {
            // A `startForegroundService` caller — `BootReceiver`, above all —
            // is owed `startForeground` within ten seconds, and that promise is
            // enforced by killing the process with an exception nothing can
            // catch. `stopSelf` is the other way to discharge it, and the only
            // survivable answer when promotion was refused.
            if (!promote()) stopSelf()
            WatchdogReceiver.schedule(this)
        }
        // The ongoing notification is the only status display when the app is
        // not on screen. It reports the *cloud* link, because that is the
        // channel every message on this device actually travels over; the P2P
        // leg is appended only when a peer host has been configured at all.
        // Before this it reported the P2P leg alone, so a phone with no peer
        // configured — the normal case — permanently read "no peer set ·
        // waiting", which is noise dressed up as a status.
        scope.launch {
            combine(cloud.state, engine.state) { cloud, p2p -> statusLine(cloud, p2p) }
                .distinctUntilChanged()
                .collect { line -> notifyStatus(line) }
        }
        // The microphone type follows the call, not the screen: a call
        // answered from the lock screen has no visible activity to earn
        // microphone access with. Starts as soon as a call exists (ringing
        // included, so the engine's audio module is built with the right to
        // record) and drops when it is over.
        scope.launch {
            cloud.callState
                .map { it.call !is net.tailchat.android.call.CallState.Idle && it.call !is net.tailchat.android.call.CallState.Ended }
                .distinctUntilChanged()
                .collect { active -> setCallMicrophone(active) }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // A service started from the background must promote itself or Android
        // kills it; one started by the visible activity in non-background mode
        // must not, or the row it is complaining about comes right back.
        //
        // The intent cannot say which of those this is — a `startForegroundService`
        // start and an ordinary `startService` start are identical by the time
        // they arrive here — so the rule is the conservative one: promote
        // whenever a row is the lesser evil, and demote below once the work it
        // covered has had time to leave. An action is enough (an FCM wake, a
        // watchdog alarm, a notification reply); so is being in background mode;
        // so is starting while nothing is on screen, because *that* is exactly
        // what `startForegroundService` looks like from the outside, and not
        // promoting it is the unhandled
        // `ForegroundServiceDidNotStartInTimeException` that took the process
        // down about ten seconds later — the crash `START_STICKY` then restarted
        // into. `stopSelf` discharges the obligation when promotion was refused
        // outright, and `START_NOT_STICKY` keeps the restart loop from replaying
        // a refused start forever.
        val promoteForThisStart = backgroundEnabled() || intent?.action != null || !activityVisible
        if (promoteForThisStart) {
            if (!promote()) {
                stopSelf(startId)
                return START_NOT_STICKY
            }
        }
        when (intent?.action) {
            // Typed straight into the shade: sent without the conversation ever
            // being opened (CloudController.sendTo), then echoed back into the
            // same notification so the shade shows it left.
            ACTION_REPLY -> {
                val peer = intent.getStringExtra(EXTRA_PEER)
                val text = RemoteInput.getResultsFromIntent(intent)
                    ?.getCharSequence(KEY_REPLY)?.toString()?.trim()
                if (!peer.isNullOrEmpty() && !text.isNullOrEmpty()) {
                    cloud.sendTo(peer, text)
                    cloud.markConversationRead(peer)
                    appendOwnReply(peer, text)
                }
            }
            ACTION_MARK_READ -> {
                val peer = intent.getStringExtra(EXTRA_PEER)
                if (!peer.isNullOrEmpty()) {
                    cloud.markConversationRead(peer)
                    threads.remove(peer)
                    NotificationManagerCompat.from(this).cancel(threadId(peer))
                }
            }
            // A service cannot ask for a permission, and answering without
            // RECORD_AUDIO gives the caller a call they hear nothing on
            // (libwebrtc fails to create its `AudioRecord`). So the shade's
            // Answer raises the call screen instead, where the interactive
            // Answer asks — one tap more, never a silent call.
            net.tailchat.android.call.ACTION_CALL_ANSWER -> {
                val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
                    PackageManager.PERMISSION_GRANTED
                if (granted) {
                    cloud.answerCall()
                } else {
                    val callId = intent.getStringExtra(net.tailchat.android.call.EXTRA_CALL_ID).orEmpty()
                    val peer = intent.getStringExtra(net.tailchat.android.call.EXTRA_CALL_PEER).orEmpty()
                    startActivity(net.tailchat.android.call.CallActivity.incomingIntent(this, callId, peer))
                }
            }
            net.tailchat.android.call.ACTION_CALL_DECLINE -> cloud.declineCall()
            net.tailchat.android.call.ACTION_CALL_HANGUP -> cloud.hangupCall()
            ACTION_WAKE -> {
                val peer = intent.getStringExtra(EXTRA_PEER)
                val messageId = intent.getStringExtra(EXTRA_MESSAGE_ID)
                val accountScope = intent.getStringExtra(EXTRA_ACCOUNT_SCOPE)
                if (peer.isNullOrBlank() || messageId.isNullOrBlank() || accountScope.isNullOrBlank()) {
                    cloud.connect()
                } else {
                    activePushWork += 1
                    cloud.processPush(peer, messageId, accountScope) { finishPushWork() }
                }
            }
            // A call is ringing somewhere and this device's socket is not up
            // — the offer itself is held by the hub and replayed the moment
            // this connection authenticates, so all that is needed here is
            // the link, held for as long as a call could still arrive.
            ACTION_CALL_WAKE -> {
                cloud.connect()
                demoteJob?.cancel()
                demoteJob = scope.launch {
                    delay(CALL_WAKE_GRACE_MS)
                    if (activityVisible || backgroundEnabled() || activePushWork > 0) return@launch
                    // A call that did arrive owns the link now; CallService's
                    // own foreground row and CallController keep it alive.
                    if (cloud.callState.value.call !is net.tailchat.android.call.CallState.Idle) return@launch
                    demote()
                    cloud.standDown()
                }
            }
            // The alarm exists because a foreground service is not immortal:
            // OEM battery managers and a swipe-away both end the process, and
            // START_STICKY's own restart is best-effort. It is armed and
            // delivered by [WatchdogReceiver] — a broadcast always arrives,
            // whereas an alarm that starts a service directly can be refused,
            // which used to crash the process and break the chain (see that
            // class for the full story).
            ACTION_WATCHDOG -> {
                // `Offline`, not `!= Online`: a `Connecting` socket is a
                // handshake in flight, and dialling again tears it down and
                // starts over — the difference between a reconnect and a
                // reconnect loop on a slow link.
                if (cloud.state.value.link == CloudLink.Offline) cloud.connect()
                WatchdogReceiver.schedule(this)
            }
        }
        // A start promoted above — a shade action, a push, an alarm — was
        // allowed to run only for as long as it took; in non-background mode
        // that row is not supposed to stay, so drop it once the work it covered
        // has had time to leave. `promoteForThisStart` rather than the action
        // alone, because the row it is closing is the one promotion opened.
        if (!backgroundEnabled() && !activityVisible && promoteForThisStart &&
            intent?.action != ACTION_WAKE && intent?.action != ACTION_CALL_WAKE
        ) {
            demoteJob?.cancel()
            demoteJob = scope.launch {
                delay(ACTION_GRACE_MS)
                if (activityVisible || backgroundEnabled() || activePushWork > 0) return@launch
                demote()
                cloud.standDown()
            }
        }
        return START_STICKY
    }

    private fun finishPushWork() {
        scope.launch {
            activePushWork = (activePushWork - 1).coerceAtLeast(0)
            if (activePushWork == 0 && !activityVisible && !backgroundEnabled()) {
                demote()
                cloud.standDown()
            }
        }
    }

    private fun backgroundEnabled(): Boolean = Settings(this).backgroundService

    /**
     * The whole difference between «висит в шторке всегда» and «не висит».
     *
     * With background mode off the socket, the watchdog alarm and the status
     * notification exist only while the app is on screen: going away closes
     * the link (so the roster stops showing this phone as online) and takes
     * the row with it; coming back dials in again. With it on nothing here
     * applies and the service behaves exactly as it did before.
     */
    private fun onActivityVisibility(visible: Boolean) {
        activityVisible = visible
        demoteJob?.cancel()
        demoteJob = null
        if (backgroundEnabled()) {
            promote()
            WatchdogReceiver.schedule(this)
            return
        }
        if (visible) {
            WatchdogReceiver.cancel(this)
            demote()
            // `Offline` only: see the watchdog branch in [onStartCommand] —
            // a handshake already in flight is not something to interrupt.
            if (cloud.state.value.link == CloudLink.Offline) cloud.connect()
            return
        }
        // A short grace: switching apps for a moment, answering a call, or
        // rotating the screen must not cost a reconnect.
        demoteJob = scope.launch {
            delay(BACKGROUND_GRACE_MS)
            if (activityVisible || backgroundEnabled()) return@launch
            WatchdogReceiver.cancel(this@ChatService)
            demote()
            cloud.standDown()
        }
    }

    private fun demote() {
        if (!promoted) return
        promoted = false
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    }

    override fun onBind(intent: Intent?): IBinder = binder

    /**
     * The system's own warning that this process is close to being killed.
     *
     * A chat is the app the low-memory killer reaches for first, and its two
     * bitmap caches ([clearImageCaches]) are the largest thing it holds that it
     * can rebuild — a decoded photo costs a re-decode, a killed process costs
     * the person everything the process was holding. Both are dropped on any
     * level from `RUNNING_LOW` up, which deliberately includes `UI_HIDDEN`:
     * while the app is off screen, holding bitmaps nobody can see is the worst
     * possible use of the memory the rest of the phone needs.
     */
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) clearImageCaches()
    }

    override fun onDestroy() {
        scope.cancel()
        engine.shutdown()
        cloud.close()
        super.onDestroy()
    }

    // ---- notifications ---------------------------------------------------

    /**
     * `startForeground` throws — it is not a boolean API. On API 31+ a service
     * started while the app was in the background and without an exemption gets
     * `ForegroundServiceStartNotAllowedException` (an `IllegalStateException`),
     * and on API 34+ a mismatched type gets `SecurityException`. Unguarded,
     * either one escapes `onCreate`/`onStartCommand` and kills the process,
     * which `START_STICKY` then restarts into the same crash — the "keeps
     * stopping" loop. Failing to promote is survivable: the service keeps
     * running for as long as the system lets it, and the next start from a
     * visible activity or a notification action promotes it properly.
     *
     * Returns whether the service is (now) foreground, because a caller that
     * itself arrived via `startForegroundService` has a second obligation to
     * discharge — see [onStartCommand].
     */
    private fun promote(): Boolean {
        if (promoted && !micPromotionPending) return true
        val notification = statusNotification(statusLine(cloud.state.value, engine.state.value))
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(ID_STATUS, notification, foregroundTypes())
            } else {
                startForeground(ID_STATUS, notification)
            }
            promoted = true
            micPromotionPending = false
        } catch (_: Exception) {
            if (!promoted) promoted = false
        }
        return promoted
    }

    /**
     * `specialUse` for the chat channel, plus `microphone` while a call is
     * live.
     *
     * Why this service and not [net.tailchat.android.call.CallService] alone:
     * Android silences (and on API 34 refuses outright) the microphone of a
     * process that is neither visible nor holding a `microphone` foreground
     * service, and `CallService` is *started* while the call is ringing —
     * from the background, with the screen locked, which is exactly the start
     * API 34 can refuse (`ForegroundServiceStartNotAllowedException`, caught
     * in `CallService.onStartCommand`). When it was refused, libwebrtc could
     * not open its `AudioRecord` at all, so the answer never got made and the
     * call sat at «Connecting» — answered from the lock screen and nowhere
     * else. This service is *already* foreground, so re-promoting it with an
     * extra type is not a background start and cannot be refused for that
     * reason; both types are declared on it in the manifest.
     */
    private fun foregroundTypes(): Int {
        var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        if (micForCall && ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        }
        return types
    }

    /**
     * Called as a call starts and ends: adds/removes the `microphone` type on
     * this service's own foreground promotion.
     *
     * A call ending in a non-background install gives the row back: this
     * promotion exists for the call only, and leaving it behind is the
     * permanent shade entry the owner asked to be rid of.
     */
    private fun setCallMicrophone(active: Boolean) {
        if (micForCall == active) return
        micForCall = active
        micPromotionPending = true
        if (active) promote()
        else if (backgroundEnabled() || activityVisible) promote() else demote()
    }

    /**
     * One line: what the cloud link is doing, how much is still queued, and —
     * only if a P2P peer was ever configured — what that leg is doing.
     */
    private fun statusLine(cloud: CloudState, p2p: ChatState): String {
        val head = when (cloud.link) {
            CloudLink.Online -> {
                val who = cloud.session?.user?.name ?: cloud.session?.user?.login ?: ""
                getString(R.string.notif_cloud_online, who)
            }
            CloudLink.Connecting -> getString(R.string.notif_cloud_connecting)
            CloudLink.Offline -> getString(R.string.notif_cloud_offline)
            CloudLink.SignedOut -> getString(R.string.notif_cloud_signed_out)
        }
        val queued = if (cloud.queuedTotal > 0) {
            getString(R.string.notif_queued_suffix, cloud.queuedTotal)
        } else ""
        val direct = if (!p2p.configured) "" else getString(
            R.string.notif_p2p_suffix,
            when {
                p2p.link == Link.Online -> getString(R.string.notif_p2p_online)
                !p2p.tailscaleUp -> getString(R.string.notif_p2p_tailscale_down)
                else -> getString(R.string.notif_p2p_waiting)
            },
        )
        return head + queued + direct
    }

    private fun openApp(peer: String? = null): PendingIntent {
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (peer != null) intent.putExtra(MainActivity.EXTRA_OPEN_PEER, peer)
        return PendingIntent.getActivity(
            this,
            // A distinct request code per peer: PendingIntents that differ only
            // in their extras are otherwise the *same* PendingIntent, so every
            // notification would open whichever conversation was posted first.
            if (peer == null) 0 else REQ_OPEN_BASE + threadSlot(peer),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun statusNotification(line: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_STATUS)
            .setSmallIcon(R.drawable.ic_stat_tailchat)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(line)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setContentIntent(openApp())
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            // Android shows a foreground service's notification within ten
            // seconds unless it is deferred; deferring keeps a short visit to
            // the app from leaving a status row behind it.
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED)
            .build()

    private fun notifyStatus(line: String) {
        if (!promoted) return
        post(ID_STATUS, statusNotification(line))
    }

    private fun onNotify(event: Notify) {
        when (event) {
            is Notify.Incoming -> postConversation(
                CloudUnreadNotification("", P2P_THREAD, "p2p-${System.nanoTime()}", event.author, event.text, System.currentTimeMillis()),
            )

            Notify.Wake -> post(
                ID_WAKE,
                NotificationCompat.Builder(this, wakeChannel())
                    .setSmallIcon(R.drawable.ic_stat_tailchat)
                    .setContentTitle(getString(R.string.app_name))
                    .setContentText(getString(R.string.notif_wake_body))
                    .setAutoCancel(true)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setContentIntent(openApp())
                    .build(),
            )

            is Notify.FileArrived -> post(
                ID_FILE,
                NotificationCompat.Builder(this, messageChannel())
                    .setSmallIcon(R.drawable.ic_stat_tailchat)
                    .setContentTitle(event.name)
                    .setContentText(getString(R.string.notif_file_saved, event.location))
                    .setAutoCancel(true)
                    .setContentIntent(openApp())
                    .build(),
            )
        }
    }

    private fun onCloudUnread(event: CloudUnreadNotification) {
        if (!Settings(this).cloudNotifications) {
            cloud.completeNotification(event, posted = false)
            return
        }
        if (event.peer in AppPreferences.mutedContacts.value) {
            cloud.completeNotification(event, posted = false)
            return
        }
        when (postConversation(event)) {
            PostResult.Posted -> cloud.completeNotification(event, posted = true)
            PostResult.Suppressed -> cloud.completeNotification(event, posted = false)
            PostResult.Failed -> Unit
        }
    }

    /**
     * One notification per conversation, in the system's own chat shape.
     *
     * `MessagingStyle` is what makes Android treat this like a messenger: the
     * sender's name and its history are the notification's content, the shade
     * groups per conversation instead of stacking sixteen rotating ids, and
     * Android Auto / wearables / lock screen all render it. The two actions are
     * the reason it is worth the code: replying and clearing the badge without
     * opening the app is what people expect of a chat that notifies them, and
     * both paths reach the live socket through the service that owns it.
     */
    private fun postConversation(event: CloudUnreadNotification): PostResult {
        val history = threads.getOrPut(event.peer) { mutableListOf() }
        history += event
        while (history.size > THREAD_HISTORY) history.removeAt(0)

        val self = Person.Builder().setName(getString(R.string.notif_you)).setKey("self").build()
        val them = Person.Builder().setName(event.author).setKey(event.peer).build()
        val style = NotificationCompat.MessagingStyle(self)
            .setConversationTitle(event.author)
        for (item in history) {
            val who = if (item.author.isEmpty()) self else them
            style.addMessage(item.text, item.ts, if (item.mine) self else who)
        }

        val builder = NotificationCompat.Builder(this, messageChannel())
            .setSmallIcon(R.drawable.ic_stat_tailchat)
            .setStyle(style)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setSilent(!Settings(this).cloudSounds)
            .setOnlyAlertOnce(false)
            .setGroup(GROUP_MESSAGES)
            .setContentIntent(openApp(event.peer))

        if (event.peer != P2P_THREAD) {
            builder.addAction(replyAction(event.peer))
            builder.addAction(markReadAction(event.peer))
        }
        return post(threadId(event.peer), builder.build())
    }

    /** Puts the sent reply back into the same notification: the shade is the
     *  only place the sender can see it went out without opening the app. */
    private fun appendOwnReply(peer: String, text: String) {
        val previous = threads[peer]?.lastOrNull() ?: return
        postConversation(
            previous.copy(
                messageId = "local-reply-${System.currentTimeMillis()}",
                text = text,
                ts = System.currentTimeMillis(),
                mine = true,
            ),
        )
    }

    private fun replyAction(peer: String): NotificationCompat.Action {
        val input = RemoteInput.Builder(KEY_REPLY)
            .setLabel(getString(R.string.notif_reply))
            .build()
        // FLAG_MUTABLE, not IMMUTABLE: the system has to write the typed text
        // into this intent, which an immutable PendingIntent forbids.
        val pending = PendingIntent.getForegroundService(
            this,
            REQ_REPLY_BASE + threadSlot(peer),
            Intent(this, ChatService::class.java)
                .setAction(ACTION_REPLY)
                .putExtra(EXTRA_PEER, peer),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        return NotificationCompat.Action.Builder(
            R.drawable.ic_stat_tailchat,
            getString(R.string.notif_reply),
            pending,
        )
            .addRemoteInput(input)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false)
            .build()
    }

    private fun markReadAction(peer: String): NotificationCompat.Action {
        val pending = PendingIntent.getForegroundService(
            this,
            REQ_READ_BASE + threadSlot(peer),
            Intent(this, ChatService::class.java)
                .setAction(ACTION_MARK_READ)
                .putExtra(EXTRA_PEER, peer),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Action.Builder(
            R.drawable.ic_stat_tailchat,
            getString(R.string.notif_mark_read),
            pending,
        )
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
            .setShowsUserInterface(false)
            .build()
    }

    /** A stable per-peer slot, so the same conversation always updates its own
     *  notification and its own PendingIntents instead of a rotating id. */
    private fun threadSlot(peer: String): Int = abs(peer.hashCode()) % THREAD_SLOTS

    private fun threadId(peer: String): Int = ID_MESSAGE_BASE + threadSlot(peer)

    private fun clearCloudNotifications(peer: String?) {
        if (peer != null) {
            threads.remove(peer)
            NotificationManagerCompat.from(this).cancel(threadId(peer))
            return
        }
        threads.clear()
        val manager = getSystemService(NotificationManager::class.java) ?: return
        manager.activeNotifications
            .filter { it.notification.group == GROUP_MESSAGES }
            .forEach { manager.cancel(it.id) }
    }

    private fun onCloudWake(from: String, name: String) {
        post(
            ID_WAKE,
            NotificationCompat.Builder(this, wakeChannel())
                .setSmallIcon(R.drawable.ic_stat_tailchat)
                .setContentTitle(name)
                .setContentText(getString(R.string.cloud_cmd_wake_received, name))
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setContentIntent(openApp())
                .build(),
        )
    }

    /** The vibration channel is picked at post time: a channel's own vibration
     *  behaviour is fixed for the user once created, so honoring a live toggle
     *  means posting to one of two channels rather than one mutable channel. */
    private fun messageChannel(): String = ensureCueChannel(
        if (AppPreferences.cloudVibration.value) CHANNEL_MESSAGES else CHANNEL_MESSAGES_QUIET,
    )

    private fun wakeChannel(): String = ensureCueChannel(CHANNEL_WAKE)

    /**
     * The channel for `prefix` under the cue the settings currently resolve to,
     * created on the first post that needs it.
     *
     * A channel's sound is as fixed as its vibration: whatever `setSound` said
     * at creation is what the user keeps, and re-creating the same id is a
     * no-op. So the cue rides in the id — `messages_soft-received`,
     * `wake_classic-wake` — and a different cue posts to a channel that did not
     * exist before instead of trying to mutate one that cannot be mutated.
     * [SoundEffects.ChannelCue] owns both halves of that identity: the `Uri` the
     * system plays, and the token that names it. Lazily, because creating the
     * cue channels for every pack up front would drop a dozen rows nobody uses
     * into the system's notification settings.
     */
    private fun ensureCueChannel(prefix: String): String {
        val cue = if (prefix == CHANNEL_WAKE) {
            SoundEffects.wakeCue(this)
        } else {
            SoundEffects.receivedCue(this)
        }
        val id = prefix + cue.token
        val manager = getSystemService(NotificationManager::class.java) ?: return id
        if (manager.getNotificationChannel(id) != null) return id
        manager.createNotificationChannel(cueChannel(prefix, id, cue.uri))
        // Anything else under the same prefix and pack is a channel this build
        // no longer posts to, and it cannot be repaired: `messages_soft` was
        // created before the cue was addressed by name, so it is frozen onto a
        // resource id that has since moved to another file — which is how a
        // call ringtone ended up as the message cue (see
        // [SoundEffects.ChannelCue]). The sweep also covers the pick that
        // replaced a custom file. Left behind, they are rows the user can still
        // see and change in notification settings with nothing posting to them.
        retireStaleCueChannels(manager, id, prefix + cue.pack)
        return id
    }

    /** The `Uri` comes from [SoundEffects] (see [SoundEffects.ChannelCue]) so a
     *  channel and the in-app cue cannot disagree about what the chosen pack
     *  sounds like. */
    private fun cueChannel(prefix: String, id: String, sound: Uri): NotificationChannel {
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        if (prefix == CHANNEL_WAKE) {
            return NotificationChannel(
                id,
                getString(R.string.notif_channel_wake),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = getString(R.string.notif_channel_wake_hint)
                enableVibration(true)
                setSound(sound, attributes)
            }
        }
        val quiet = prefix == CHANNEL_MESSAGES_QUIET
        val label =
            if (quiet) R.string.notif_channel_messages_quiet else R.string.notif_channel_messages
        return NotificationChannel(
            id,
            getString(label),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = getString(R.string.notif_channel_messages_hint)
            if (quiet) enableVibration(false)
            setSound(sound, attributes)
        }
    }

    private fun post(id: Int, notification: Notification): PostResult {
        val manager = NotificationManagerCompat.from(this)
        if (!manager.areNotificationsEnabled()) return PostResult.Suppressed
        return try {
            manager.notify(id, notification)
            PostResult.Posted
        } catch (_: SecurityException) {
            PostResult.Failed
        }
    }

    private fun createChannels() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        for (retired in RETIRED_CHANNELS) manager.deleteNotificationChannel(retired)
        // A channel's importance is fixed for the user once it has been created,
        // so lowering it means publishing under a new id: the old `status`
        // channel was IMPORTANCE_LOW, which puts the row above the "silent"
        // divider and shows an icon in the status bar for a line nobody needs to
        // read. MIN keeps the service legal and the shade quiet.
        //
        // The cue channels are deliberately not created here — their ids depend
        // on the sound pack that is picked when a message actually arrives; see
        // [ensureCueChannel].
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_STATUS,
                getString(R.string.notif_channel_status),
                NotificationManager.IMPORTANCE_MIN,
            ).apply {
                description = getString(R.string.notif_channel_status_hint)
                setShowBadge(false)
            },
        )
    }

    companion object {
        private const val TAG = "ChatService"
        const val ACTION_REPLY = "net.tailchat.android.action.REPLY"
        const val ACTION_MARK_READ = "net.tailchat.android.action.MARK_READ"
        const val ACTION_WATCHDOG = "net.tailchat.android.action.WATCHDOG"

        /**
         * A background wake from FCM (`TailchatFirebaseMessagingService`): the
         * only start this app makes that carries an action purely so that
         * `onStartCommand` has a reason to promote — a service started with
         * `startForegroundService` and never promoted is killed by the
         * platform outright.
         */
        const val ACTION_WAKE = "net.tailchat.android.action.WAKE"
        const val EXTRA_PEER = "peer"
        const val EXTRA_MESSAGE_ID = "messageId"
        const val EXTRA_ACCOUNT_SCOPE = "accountScope"

        /**
         * A call push (`kind=call`) from FCM. Distinct from [ACTION_WAKE]
         * because there is no message to fetch and the deadline is the
         * caller's ring: this only has to get the cloud socket back up so the
         * held `call-offer` the hub replays on authentication can arrive.
         */
        const val ACTION_CALL_WAKE = "net.tailchat.android.action.CALL_WAKE"
        const val EXTRA_CALL_ID = "callId"
        /** How long a call wake keeps the link (and the promoted row) alive
         *  while nothing has rung: the hub's own ring timeout, after which a
         *  call that never arrived is a call that is not coming. */
        private const val CALL_WAKE_GRACE_MS = net.tailchat.android.call.CallController.RING_TOTAL_TIMEOUT_MS
        /** How long the link and the shade row survive the app leaving the
         *  screen when background mode is off. Long enough for a glance at
         *  another app, short enough that a pocketed phone reads as offline. */
        private const val BACKGROUND_GRACE_MS = 20_000L
        /** The same, after a reply typed into the notification: only as long
         *  as it takes that frame to leave. */
        private const val ACTION_GRACE_MS = 10_000L
        private const val KEY_REPLY = "reply"
        private const val CHANNEL_STATUS = "link"
        // Cue channel id prefixes; [SoundEffects.ChannelCue.token] completes
        // them, so an id reads `messages_soft-received`,
        // `wake_classic-wake`, `messages_quiet_custom-received-…`.
        private const val CHANNEL_MESSAGES = "messages_"
        private const val CHANNEL_MESSAGES_QUIET = "messages_quiet_"
        private const val CHANNEL_WAKE = "wake_"
        /**
         * Ids this build no longer posts to, dropped once per process in
         * [createChannels]. `status`/`messages`/`messages_quiet`/`wake` predate
         * the cue samples and carried the OEM default ding at the wrong
         * importance; the `*_cue` trio is 0.54's single-pack set, frozen onto
         * the Classic sound. Left behind, they are rows the user can still see
         * and change in the app's notification settings with nothing posting to
         * them.
         */
        private val RETIRED_CHANNELS = listOf(
            "status",
            "messages",
            "messages_quiet",
            "wake",
            "messages_cue",
            "messages_quiet_cue",
            "wake_cue",
        )
        private const val GROUP_MESSAGES = "net.tailchat.messages"
        /** The P2P leg has no login to key a thread on — one fixed thread. */
        private const val P2P_THREAD = "\u0000p2p"
        private const val THREAD_HISTORY = 6
        private const val THREAD_SLOTS = 64
        private const val ID_STATUS = 1
        private const val ID_WAKE = 2
        private const val ID_FILE = 3
        private const val ID_MESSAGE_BASE = 100
        private const val REQ_OPEN_BASE = 1000
        private const val REQ_REPLY_BASE = 2000
        private const val REQ_READ_BASE = 3000
    }
}

/**
 * Drops every cue channel under `stalePrefix` except [id] — the id this build
 * posts to, just created.
 *
 * `messages_soft` is what this exists for: a channel created before a cue was
 * addressed by name, frozen onto an `android.resource://` id that a later
 * build's `res/raw` insertions moved to another file. A channel's sound cannot
 * be corrected in place, so the repair is to post to an id no earlier build
 * used and to retire what it replaced. The scope is one prefix *and* one pack —
 * the service passes `prefix` plus the cue's pack — so the channels of other
 * packs and the silent twin of this one keep whatever the user set on them.
 */
internal fun retireStaleCueChannels(
    manager: NotificationManager,
    id: String,
    stalePrefix: String,
) {
    for (existing in manager.notificationChannels.toList()) {
        if (existing.id != id && existing.id.startsWith(stalePrefix)) {
            manager.deleteNotificationChannel(existing.id)
        }
    }
}
