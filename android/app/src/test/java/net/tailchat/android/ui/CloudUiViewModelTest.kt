package net.tailchat.android.ui

import androidx.lifecycle.SavedStateHandle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The dismiss order and the root double-Back exit contract from
 * LOCAL_FIRST_EXECUTION_PLAN.md §8A: emoji palette → reply/edit context →
 * voice recording → conversation → P2P → root roster's arm-then-exit window.
 */
class CloudUiViewModelTest {

    private var now = 0L
    private fun model() = CloudUiViewModel(SavedStateHandle()).apply { clock = { now } }

    @Test
    fun `first back on root arms the exit window without exiting`() {
        val model = model()
        val outcome = model.consumeBack(conversationOpen = false) { }
        assertEquals(BackOutcome.ExitArmed, outcome)
    }

    @Test
    fun `second back within the window exits`() {
        val model = model()
        model.consumeBack(conversationOpen = false) { }
        now += 500
        val outcome = model.consumeBack(conversationOpen = false) { }
        assertEquals(BackOutcome.ExitApp, outcome)
    }

    @Test
    fun `second back after the window re-arms instead of exiting`() {
        val model = model()
        model.consumeBack(conversationOpen = false) { }
        now += CloudUiViewModel.EXIT_WINDOW_MS + 1
        val outcome = model.consumeBack(conversationOpen = false) { }
        assertEquals(BackOutcome.ExitArmed, outcome)
    }

    @Test
    fun `a route change between the two presses cancels the exit`() {
        val model = model()
        model.consumeBack(conversationOpen = false) { }
        model.noteRouteChanged()
        now += 500
        val outcome = model.consumeBack(conversationOpen = false) { }
        assertEquals(BackOutcome.ExitArmed, outcome)
    }

    @Test
    fun `opening or closing P2P counts as a route change`() {
        val model = model()
        model.consumeBack(conversationOpen = false) { }
        model.openP2P()
        model.closeP2P()
        now += 500
        val outcome = model.consumeBack(conversationOpen = false) { }
        assertEquals(BackOutcome.ExitArmed, outcome)
    }

    @Test
    fun `emoji palette closes before anything else`() {
        val model = model()
        model.openEmojiPalette(true)
        var closedConversation = false
        val outcome = model.consumeBack(conversationOpen = true) { closedConversation = true }
        assertEquals(BackOutcome.Consumed, outcome)
        assertFalse(model.emojiPaletteOpen)
        assertFalse("conversation must not close while the palette is still open", closedConversation)
    }

    @Test
    fun `composer context cancels before the conversation closes`() {
        val model = model()
        var cancelled = false
        model.setComposerContext(active = true) { cancelled = true }
        var closedConversation = false
        val outcome = model.consumeBack(conversationOpen = true) { closedConversation = true }
        assertEquals(BackOutcome.Consumed, outcome)
        assertTrue(cancelled)
        assertFalse(closedConversation)
    }

    @Test
    fun `voice recording cancels before the conversation closes`() {
        val model = model()
        var cancelled = false
        model.setVoiceRecording(active = true) { cancelled = true }
        var closedConversation = false
        val outcome = model.consumeBack(conversationOpen = true) { closedConversation = true }
        assertEquals(BackOutcome.Consumed, outcome)
        assertTrue(cancelled)
        assertFalse(closedConversation)
    }

    @Test
    fun `conversation closes before P2P`() {
        val model = model()
        model.openP2P()
        var closedConversation = false
        val outcome = model.consumeBack(conversationOpen = true) { closedConversation = true }
        assertEquals(BackOutcome.Consumed, outcome)
        assertTrue(closedConversation)
        assertTrue("P2P must still be open — only the conversation layer closed", model.showP2P)
    }

    @Test
    fun `p2p closes before the root exit window arms`() {
        val model = model()
        model.openP2P()
        val outcome = model.consumeBack(conversationOpen = false) { }
        assertEquals(BackOutcome.Consumed, outcome)
        assertFalse(model.showP2P)
    }
}
