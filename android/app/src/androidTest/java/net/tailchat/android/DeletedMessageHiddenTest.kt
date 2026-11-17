package net.tailchat.android

import android.content.Context
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Tombstones keep their id in Room so a stale history page cannot resurrect
 * content. Their visibility is local: the default transcript omits them
 * entirely; enabling the setting renders only the generic marker, never the
 * original text or media.
 */
@RunWith(AndroidJUnit4::class)
class DeletedMessageHiddenTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val server = CloudApi.normalizeServerUrl("http://127.0.0.1:1")!!
    private val login = "deleted-msg-tester"
    private val peer = "tombstonebot"
    private val accountKey = "$server|$login"
    private val liveText = "this-message-must-stay-visible"
    private val tombstonedText = "this-message-must-never-render"

    @Before
    fun seed() {
        // Self-contained against a freshly installed/reset device: on API 33+
        // the first launch shows a POST_NOTIFICATIONS system dialog that
        // steals the accessibility tree from the app underneath it, which is
        // exactly what this test inspects. Granting it up front (the same
        // effect `adb shell pm grant` has) keeps the test hermetic instead of
        // depending on some earlier manual grant surviving in this AVD.
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(
            "pm grant net.tailchat.android android.permission.POST_NOTIFICATIONS",
        ).close()
        Settings(context).showDeletedMessages = false
        CloudSessionStore(context).save(
            CloudSession(server = server, token = "test-token", user = CloudUser(login, "Tester")),
        )
        val db = TailchatDatabase.get(context)
        runBlocking {
            db.accounts().upsert(AccountEntity(accountKey, server, login, "Tester"))
            db.conversations().upsert(
                ConversationDao.blank(accountKey, peer, now = CLOCK).copy(name = "Tombstonebot", historySeeded = true),
            )
            db.messages().upsert(blank(id = "keep-1", ts = CLOCK, text = liveText, deletedAt = null))
            db.messages().upsert(blank(id = "gone-1", ts = CLOCK + 1_000, text = tombstonedText, deletedAt = CLOCK + 1_000))
        }
    }

    @Test
    fun tombstonedMessageNeverReachesTheAccessibilityTreeWhileTheLiveOneDoes() {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val scenario = ActivityScenario.launch<MainActivity>(
            android.content.Intent(context, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_OPEN_PEER, peer),
        )
        try {
            assertNotNull(
                "the non-deleted message must render",
                awaitNode(automation) { node -> node.text()?.contains(liveText) == true },
            )
            // The live message rendering proves the screen finished composing;
            // give it one more settle pass before asserting a negative.
            Thread.sleep(500)
            assertNull(
                "a tombstoned message must not render any node carrying its content",
                findNode(automation.rootInActiveWindow!!) { node -> node.text()?.contains(tombstonedText) == true },
            )
        } finally {
            scenario.close()
        }
    }

    @Test
    fun enabledDeletionMarkersExposeOnlyTheGenericMarker() {
        Settings(context).showDeletedMessages = true
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        val scenario = ActivityScenario.launch<MainActivity>(
            android.content.Intent(context, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_OPEN_PEER, peer),
        )
        try {
            assertNotNull(
                "the enabled setting must show a generic tombstone marker",
                awaitNode(automation) { node -> node.text()?.contains(context.getString(R.string.cloud_msg_deleted)) == true },
            )
            assertNull(
                "the marker must not expose the deleted content",
                findNode(automation.rootInActiveWindow!!) { node -> node.text()?.contains(tombstonedText) == true },
            )
        } finally {
            scenario.close()
            Settings(context).showDeletedMessages = false
        }
    }

    private fun blank(id: String, ts: Long, text: String, deletedAt: Long?) = MessageEntity(
        accountKey = accountKey, peer = peer, id = id, text = text, ts = ts,
        author = peer, mine = false, delivery = DeliveryState.Delivered.ordinal, system = false,
        kind = MessageKind.TEXT, imageDataUrl = null, imageWidth = null, imageHeight = null,
        voiceDataUrl = null, voiceDurationSec = null, reactionsJson = null, replyJson = null,
        forwardJson = null, editedAt = null, deletedAt = deletedAt, serverSeq = null,
    )

    private fun AccessibilityNodeInfo.text(): String? =
        (this.text?.toString().orEmpty() + " " + this.contentDescription?.toString().orEmpty()).ifBlank { null }

    private fun awaitNode(
        automation: android.app.UiAutomation,
        timeoutMs: Long = 10_000,
        predicate: (AccessibilityNodeInfo) -> Boolean,
    ): AccessibilityNodeInfo? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val root = automation.rootInActiveWindow
            if (root != null) {
                findNode(root, predicate)?.let { return it }
            }
            Thread.sleep(100)
        }
        return null
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
