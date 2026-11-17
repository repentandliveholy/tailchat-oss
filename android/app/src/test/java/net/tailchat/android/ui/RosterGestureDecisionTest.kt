package net.tailchat.android.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class RosterGestureDecisionTest {
    private fun decide(x: Float, y: Float) = rosterGestureDecision(
        totalX = x,
        totalY = y,
        verticalRelease = 12f,
        horizontalLock = 36f,
        horizontalDominance = 2.5f,
    )

    @Test
    fun `vertical and diagonal movement stays with roster scrolling`() {
        assertEquals(RosterGestureDecision.Vertical, decide(2f, 12f))
        assertEquals(RosterGestureDecision.Vertical, decide(20f, 18f))
        assertEquals(RosterGestureDecision.Vertical, decide(35f, 20f))
    }

    @Test
    fun `horizontal swipe locks only after distance and dominance thresholds`() {
        assertEquals(RosterGestureDecision.Pending, decide(35f, 1f))
        assertEquals(RosterGestureDecision.Vertical, decide(36f, 15f))
        assertEquals(RosterGestureDecision.Horizontal, decide(36f, 14f))
        assertEquals(RosterGestureDecision.Horizontal, decide(-48f, 8f))
    }
}
