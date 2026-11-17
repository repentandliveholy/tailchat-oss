package net.tailchat.android

import android.content.Context
import android.util.Base64
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import net.tailchat.android.cloud.CloudApi
import net.tailchat.android.cloud.CloudSession
import net.tailchat.android.cloud.CloudSessionStore
import net.tailchat.android.cloud.CloudUser
import net.tailchat.android.data.AccountEntity
import net.tailchat.android.data.ConversationDao
import net.tailchat.android.data.DeliveryState
import net.tailchat.android.data.MessageEntity
import net.tailchat.android.data.MessageKind
import net.tailchat.android.data.TailchatDatabase
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The TalkBack seek ±10s custom actions (`CloudScreen.kt`'s `VoicePlayer`,
 * `VOICE_SEEK_STEP_MS`) were confirmed by reading the code and by their
 * *behaviour* being exercised through the sighted drag-seek gesture
 * (LOCAL_FIRST_EXECUTION_PLAN.md / HANDOFF.md, "живой device-смоук"), but the
 * actual TalkBack invocation path — a real `AccessibilityNodeInfo` action,
 * the way the TalkBack service would call it, not the composable's own
 * `seekBy` lambda called directly — was never exercised: the angled
 * local-context-menu gesture TalkBack uses for a custom action does not
 * synthesize reliably through `adb input motionevent` (see three prior
 * HANDOFF entries carrying this exact item forward). This test closes that
 * gap the way those entries' own recommendation says to: find the bubble's
 * node and invoke the action from its real `getActionList()`, no gesture
 * synthesis involved.
 *
 * Self-contained: seeds its own account/conversation/voice message directly
 * into the real on-device Room database and writes its own local session
 * (an unreachable loopback server — voice playback is local-file decode, no
 * network involved), so it does not depend on any interactively-run smoke
 * server or account. Run against a process that is not already alive with a
 * different session (`adb shell am force-stop net.tailchat.android` first) —
 * `ChatService`'s `ServiceCloudController` loads its session once, at
 * construction, so a process already running under a different account would
 * not pick up the one this test writes.
 */
@RunWith(AndroidJUnit4::class)
class VoiceTalkBackActionsTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val server = CloudApi.normalizeServerUrl("http://127.0.0.1:1")!!
    private val login = "talkback-voice-tester"
    private val peer = "voicebot"
    private val accountKey = "$server|$login"
    private val messageId = "voice-1"

    @Before
    fun seed() {
        // See DeletedMessageHiddenTest.seed for why: a fresh device shows the
        // POST_NOTIFICATIONS system dialog on first launch, stealing the
        // accessibility tree this test drives before the transcript is even
        // visible.
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(
            "pm grant net.tailchat.android android.permission.POST_NOTIFICATIONS",
        ).close()
        CloudSessionStore(context).save(
            CloudSession(server = server, token = "test-token", user = CloudUser(login, "Tester")),
        )
        val testContext = InstrumentationRegistry.getInstrumentation().context
        val voiceBytes = testContext.assets.open("voice-test.m4a").use { it.readBytes() }
        val dataUrl = "data:audio/mp4;base64," + Base64.encodeToString(voiceBytes, Base64.NO_WRAP)
        val db = TailchatDatabase.get(context)
        runBlocking {
            db.accounts().upsert(AccountEntity(accountKey, server, login, "Tester"))
            db.conversations().upsert(
                ConversationDao.blank(accountKey, peer, now = CLOCK).copy(name = "Voicebot", historySeeded = true),
            )
            db.messages().upsert(
                MessageEntity(
                    accountKey = accountKey, peer = peer, id = messageId, text = "", ts = CLOCK,
                    author = peer, mine = false, delivery = DeliveryState.Delivered.ordinal, system = false,
                    kind = MessageKind.VOICE, imageDataUrl = null, imageWidth = null, imageHeight = null,
                    voiceDataUrl = dataUrl, voiceDurationSec = 20, reactionsJson = null, replyJson = null,
                    forwardJson = null, editedAt = null, deletedAt = null, serverSeq = null,
                ),
            )
        }
    }

    @Test
    fun talkBackForwardActionSeeksTenSecondsOnARealAccessibilityNode() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val automation = instrumentation.uiAutomation
        val scenario = ActivityScenario.launch<MainActivity>(
            android.content.Intent(context, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_OPEN_PEER, peer),
        )
        try {
            // The whole voice row is one `clearAndSetSemantics` node
            // (CloudScreen.kt's `VoicePlayer`): the play/pause `IconButton`
            // inside it has no accessibility presence of its own — merged
            // away on purpose, which is exactly why the row carries an
            // explicit semantics `onClick` for TalkBack. So the play toggle
            // and the forward seek below are the same node throughout, not a
            // button found and then a separate bubble found.
            val voiceNode = awaitNode(automation, predicate = { node ->
                node.actionList.any { it.label == forwardLabel() }
            })
            // seekTo is a no-op until a MediaPlayer actually exists for this
            // message (VoicePlaybackController.seekTo returns early with no
            // player) — the same precondition a TalkBack user hits: you
            // cannot seek a note you have not opened.
            assertTrue("expected the row's click action to start playback", voiceNode.performAction(AccessibilityNodeInfo.ACTION_CLICK))

            awaitNode(automation, predicate = { node ->
                node.contentDescription?.toString()?.contains(playingWord()) == true
            })
            val before = positionSeconds(
                awaitNode(automation, predicate = { it.actionList.any { a -> a.label == forwardLabel() } })
                    .contentDescription.toString(),
            )

            val forward = awaitNode(automation, predicate = { node -> node.actionList.any { it.label == forwardLabel() } })
                .actionList.first { it.label == forwardLabel() }
            val target = awaitNode(automation, predicate = { it.actionList.any { a -> a.label == forwardLabel() } })
            assertTrue("expected the forward custom action to be performable", target.performAction(forward.id))

            val after = awaitNode(automation, predicate = { node ->
                node.actionList.any { it.label == forwardLabel() } &&
                    (positionSecondsOrNull(node.contentDescription?.toString()) ?: before) > before
            })
            val afterSeconds = positionSeconds(after.contentDescription.toString())

            assertTrue(
                "expected forward to advance position by ~10s (before=$before after=$afterSeconds)",
                afterSeconds - before in 8..15,
            )
        } finally {
            scenario.close()
        }
    }

    private fun playingWord(): String = context.getString(R.string.cloud_voice_playing)

    private fun forwardLabel(): String = context.getString(R.string.cloud_voice_seek_forward)

    /** `"0:00 / 0:20"`-shaped text embedded in the merged content description
     *  ([R.string.cloud_voice_player_description]) — the position half. */
    private fun positionSeconds(description: String): Int = positionSecondsOrNull(description)
        ?: error("no position clock in '$description'")

    private fun positionSecondsOrNull(description: String?): Int? {
        val match = Regex("(\\d+):(\\d{2})").find(description.orEmpty()) ?: return null
        val (minutes, seconds) = match.destructured
        return minutes.toInt() * 60 + seconds.toInt()
    }

    private fun awaitNode(
        automation: android.app.UiAutomation,
        timeoutMs: Long = 10_000,
        predicate: (AccessibilityNodeInfo) -> Boolean,
    ): AccessibilityNodeInfo {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val root = automation.rootInActiveWindow
            if (root != null) {
                findNode(root, predicate)?.let { return it }
            }
            Thread.sleep(100)
        }
        error("no matching accessibility node within ${timeoutMs}ms")
    }

    private fun findNode(node: AccessibilityNodeInfo, predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        if (predicate(node)) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            findNode(child, predicate)?.let { return it }
        }
        return null
    }

    private companion object {
        const val CLOCK = 1_000L
    }
}
