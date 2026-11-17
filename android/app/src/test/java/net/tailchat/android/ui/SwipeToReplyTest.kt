package net.tailchat.android.ui

import androidx.compose.ui.unit.LayoutDirection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The plan's acceptance line for the gesture is «один reply target только по
 * завершённому жесту; нет отправки/удаления и конфликта с vertical scroll».
 * Everything about that promise that can be wrong silently lives in
 * [swipeOutcome]: the sign, the threshold and the cancelled case. A wrong sign
 * means the gesture works in exactly one layout direction, and a cancelled
 * gesture that still counts means the scroll steals the pointer *and* sets a
 * reply target. None of it is visible in a screenshot, so it is pinned here.
 */
class SwipeToReplyTest {
    private val threshold = 56f

    @Test
    fun ltrSwipeTowardsTheStartEdgePastTheThresholdReplies() {
        assertTrue(swipeOutcome(-80f, threshold, LayoutDirection.Ltr, cancelled = false))
    }

    @Test
    fun exactlyTheThresholdCounts() {
        assertTrue(swipeOutcome(-56f, threshold, LayoutDirection.Ltr, cancelled = false))
        assertTrue(swipeOutcome(56f, threshold, LayoutDirection.Rtl, cancelled = false))
    }

    @Test
    fun shortSwipeDoesNothing() {
        assertFalse(swipeOutcome(-55f, threshold, LayoutDirection.Ltr, cancelled = false))
        assertFalse(swipeOutcome(-1f, threshold, LayoutDirection.Ltr, cancelled = false))
        assertFalse(swipeOutcome(0f, threshold, LayoutDirection.Ltr, cancelled = false))
    }

    @Test
    fun reverseSwipeDoesNothingHoweverLong() {
        assertFalse(swipeOutcome(400f, threshold, LayoutDirection.Ltr, cancelled = false))
        assertFalse(swipeOutcome(-400f, threshold, LayoutDirection.Rtl, cancelled = false))
    }

    @Test
    fun rtlMirrorsTheActivatingDirection() {
        assertTrue(swipeOutcome(80f, threshold, LayoutDirection.Rtl, cancelled = false))
        assertFalse(swipeOutcome(80f, threshold, LayoutDirection.Ltr, cancelled = false))
        assertTrue(swipeOutcome(-80f, threshold, LayoutDirection.Ltr, cancelled = false))
        assertFalse(swipeOutcome(-80f, threshold, LayoutDirection.Rtl, cancelled = false))
    }

    @Test
    fun cancelledGestureNeverReplies() {
        // The scroll winning the pointer mid-drag ends the drag as cancelled,
        // however far the finger had already travelled.
        assertFalse(swipeOutcome(-400f, threshold, LayoutDirection.Ltr, cancelled = true))
        assertFalse(swipeOutcome(400f, threshold, LayoutDirection.Rtl, cancelled = true))
    }

    @Test
    fun aDegenerateThresholdDoesNotTurnEveryTapIntoAReply() {
        // A zero-height/zero-density measurement must fail closed: with a `>=`
        // test a threshold of zero would fire on the down event itself.
        assertFalse(swipeOutcome(0f, 0f, LayoutDirection.Ltr, cancelled = false))
        assertFalse(swipeOutcome(-80f, 0f, LayoutDirection.Ltr, cancelled = false))
    }

    @Test
    fun bubbleFollowsTheFingerUpToTheThreshold() {
        assertEquals(0f, travelFor(0f, threshold), 0.001f)
        assertEquals(20f, travelFor(20f, threshold), 0.001f)
        assertEquals(threshold, travelFor(threshold, threshold), 0.001f)
    }

    @Test
    fun bubbleNeverRunsAwayWithAnOverlongSwipe() {
        // Past the threshold the travel is rubber-banded and bounded by
        // 1.35x the activation distance, so the bubble cannot cross the row.
        assertTrue(travelFor(200f, threshold) > threshold)
        assertTrue(travelFor(2000f, threshold) < threshold * 1.36f)
        assertTrue(travelFor(2000f, threshold) > travelFor(200f, threshold))
    }

    @Test
    fun bubbleDoesNotMoveTheWrongWay() {
        assertEquals(0f, travelFor(-80f, threshold), 0.001f)
        assertEquals(0f, travelFor(80f, 0f), 0.001f)
    }

    // ---- the direction lock -------------------------------------------------
    //
    // «не нужно так легко сдвиг сообщения для ответа — главное, это скролл без
    // препятствий». The bubble is a child of the transcript's LazyColumn, so it
    // sees every pointer event before the scroll does: whatever it consumes,
    // the list never gets. These are the rules that decide when it may.

    private val lock = 36f
    private val slop = 8f
    private val ltr = -1f
    private val rtl = 1f

    private fun decide(x: Float, y: Float, startSign: Float = ltr) =
        replySwipeDecision(x, y, startSign, slop, lock)

    @Test
    fun aCleanHorizontalSwipeTowardsTheReplyEdgeClaimsThePointer() {
        assertEquals(ReplySwipeDecision.Reply, decide(-36f, 0f))
        assertEquals(ReplySwipeDecision.Reply, decide(-120f, 4f))
        assertEquals(ReplySwipeDecision.Reply, decide(-60f, -5f))
        assertEquals(ReplySwipeDecision.Reply, decide(-42f, 7.9f))
    }

    @Test
    fun aVerticalDragIsAlwaysTheListScroll() {
        assertEquals(ReplySwipeDecision.Scroll, decide(0f, 40f))
        assertEquals(ReplySwipeDecision.Scroll, decide(-4f, -30f))
        assertEquals(ReplySwipeDecision.Scroll, decide(-40f, 80f))
    }

    @Test
    fun enoughVerticalTravelVetoesTheReplyHoweverFarTheFingerThenGoesSideways() {
        // The case that made the bubble shift while the list was scrolling: a
        // finger that scrolled first and curved left afterwards. 36 px across
        // against 8 px down is not a swipe, whatever the totals say.
        assertEquals(ReplySwipeDecision.Scroll, decide(-36f, 8f))
        assertEquals(ReplySwipeDecision.Scroll, decide(-200f, 12f))
        assertEquals(ReplySwipeDecision.Scroll, decide(-200f, -40f))
    }

    @Test
    fun theWrongDirectionIsNeverAReply() {
        assertEquals(ReplySwipeDecision.Pending, decide(60f, 0f))
        assertEquals(ReplySwipeDecision.Pending, decide(400f, 5f))
        assertEquals(ReplySwipeDecision.Scroll, decide(60f, 40f))
    }

    @Test
    fun rtlMirrorsTheClaimingDirection() {
        assertEquals(ReplySwipeDecision.Reply, decide(60f, 4f, rtl))
        assertEquals(ReplySwipeDecision.Pending, decide(-60f, 4f, rtl))
        assertEquals(ReplySwipeDecision.Scroll, decide(-60f, 40f, rtl))
    }

    @Test
    fun theLockIsCountedFromTheStartOfTheGesture() {
        assertEquals(ReplySwipeDecision.Pending, decide(-35.9f, 0f))
        assertEquals(ReplySwipeDecision.Reply, decide(-36f, 0f))
        assertEquals(ReplySwipeDecision.Pending, decide(-20f, 0f))
    }
}
