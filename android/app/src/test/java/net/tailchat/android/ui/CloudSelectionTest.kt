package net.tailchat.android.ui

import net.tailchat.android.cloud.CloudMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The message selection's own rules — the set the transcript rings and the bar
 * counts — plus the two decisions the bar and the menu make from it: which
 * messages the ids name and in what order, and whether «Удалить у всех» may be
 * offered for them.
 *
 * Plain JUnit: [CloudSelection], [cloudSelectedInOrder] and
 * [cloudSelectionAllOwn] are pure values and functions — the composer calls
 * them with the conversation the controller already holds — so no Compose is
 * involved. The gesture wiring itself (which `combinedClickable` fires on which
 * press, and that the bar takes the composer's slot) is not reachable from a
 * JVM test: it is a `CloudMessageBubble` and a `CloudSelectionBar`, and the
 * on-device harness here launches the real screen against a live-shaped
 * controller rather than injecting a fake one, so the interaction is listed in
 * this change's hand-off for a phone, never pinned by an assertion on source
 * text.
 */
class CloudSelectionTest {
    @Test
    fun `a long press starts the mode on exactly the pressed message`() {
        val empty = CloudSelection()
        assertFalse("an empty set is the mode being off", empty.active)
        assertEquals(0, empty.count)

        val one = empty.enter("m2")
        assertTrue(one.active)
        assertEquals(1, one.count)
        assertEquals(setOf("m2"), one.ids)
    }

    @Test
    fun `entering again replaces the set instead of adding to it`() {
        val selection = CloudSelection().enter("m1").enter("m3")
        assertEquals(setOf("m3"), selection.ids)
        assertEquals(1, selection.count)
    }

    @Test
    fun `a tap toggles one message and the count follows it`() {
        var selection = CloudSelection().enter("m1")
        selection = selection.toggle("m2")
        assertEquals(2, selection.count)
        assertTrue(selection.active)

        selection = selection.toggle("m1")
        assertEquals(setOf("m2"), selection.ids)
        assertEquals(1, selection.count)

        selection = selection.toggle("m2")
        assertEquals("the last message leaving ends the mode", 0, selection.count)
        assertFalse(selection.active)
    }

    @Test
    fun `toggling a message twice is the selection it started from`() {
        val start = CloudSelection().enter("m1").toggle("m2")
        assertEquals(start, start.toggle("m2").toggle("m2"))
    }

    @Test
    fun `a message the transcript no longer draws leaves the selection`() {
        val selection = CloudSelection().enter("m1").toggle("m2").toggle("m3")
        val kept = selection.retain(setOf("m1", "m3"))
        assertEquals(setOf("m1", "m3"), kept.ids)
        assertEquals("the count never names a message that is not on screen", 2, kept.count)

        val gone = kept.retain(setOf("m9"))
        assertFalse("a redraw that dropped them all ends the mode", gone.active)
    }

    @Test
    fun `retaining keeps the selection untouched while every message is still there`() {
        val selection = CloudSelection().enter("m1").toggle("m2")
        assertEquals(selection, selection.retain(setOf("m1", "m2", "m3")))
        assertEquals("nothing selected stays nothing selected", CloudSelection(), CloudSelection().retain(emptySet()))
    }

    @Test
    fun `the ids are read in conversation order, not in the order they were tapped`() {
        val messages = listOf(message("m1", ts = 1), message("m2", ts = 2), message("m3", ts = 3))
        // Marked bottom-up, the way a finger reaching for the newest message
        // first would: the copy still goes out oldest-first.
        val tappedBottomUp = CloudSelection().enter("m3").toggle("m1")
        assertEquals(
            listOf("m1", "m3"),
            cloudSelectedInOrder(messages, tappedBottomUp.ids).map { it.id },
        )
    }

    @Test
    fun `an id the conversation does not hold names nothing`() {
        val messages = listOf(message("m1", ts = 1))
        assertEquals(
            emptyList<String>(),
            cloudSelectedInOrder(messages, setOf("m9")).map { it.id },
        )
        assertEquals(emptyList<CloudMessage>(), cloudSelectedInOrder(messages, emptySet()))
    }

    @Test
    fun `only a selection this account wrote all of offers the for-everyone scope`() {
        val own = listOf(message("m1", ts = 1), message("m2", ts = 2))
        assertTrue(cloudSelectionAllOwn(own))

        val mixed = own + message("m3", ts = 3, mine = false)
        assertFalse("somebody else's message can only be dropped for one side", cloudSelectionAllOwn(mixed))

        assertFalse(cloudSelectionAllOwn(listOf(message("m1", ts = 1, mine = false))))
        assertFalse("an empty selection offers it to nobody", cloudSelectionAllOwn(emptyList()))
    }

    private fun message(id: String, ts: Long, mine: Boolean = true) = CloudMessage(
        id = id,
        peer = "peer",
        text = "text-$id",
        ts = ts,
        author = "author",
        mine = mine,
    )
}
