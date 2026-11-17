package net.tailchat.android.ui

import net.tailchat.android.cloud.CloudDelivery
import net.tailchat.android.cloud.CloudMessage
import net.tailchat.android.cloud.CloudReply
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Plan §4 acceptance: «Позднее восстановление старого черновика не
 * перезаписывает уже введённый текст». [shouldApplyLoadedDraft] is the one
 * guard standing between a slow `controller.draft()` read and silently
 * discarding whatever the user typed, swiped to reply to, or picked to edit
 * while that read was still in flight.
 */
class CloudConversationDraftTest {

    private val reply = CloudReply(id = "m-1", from = "bob", text = "hi")
    private val message = CloudMessage(
        id = "m-1",
        peer = "bob",
        text = "hi",
        ts = 0L,
        author = "bob",
        mine = false,
        delivery = CloudDelivery.Delivered,
    )

    @Test
    fun emptyComposerAcceptsTheLoadedDraft() {
        assertTrue(shouldApplyLoadedDraft("", null, null))
    }

    @Test
    fun textTypedBeforeLoadResolvesWins() {
        assertFalse(shouldApplyLoadedDraft("already typing", null, null))
    }

    @Test
    fun replyPickedBeforeLoadResolvesWins() {
        assertFalse(shouldApplyLoadedDraft("", reply, null))
    }

    @Test
    fun editPickedBeforeLoadResolvesWins() {
        assertFalse(shouldApplyLoadedDraft("", null, message))
    }

    @Test
    fun allThreeMustBeClearForTheLoadedDraftToApply() {
        assertFalse(shouldApplyLoadedDraft("typing", reply, message))
    }
}
