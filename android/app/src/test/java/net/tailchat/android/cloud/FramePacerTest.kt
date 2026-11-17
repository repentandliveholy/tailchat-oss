package net.tailchat.android.cloud

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The bug this pins: the hub closes a socket that sends more than 60 frames in
 * a rolling second, counted per *connection*, not per feature. The outbox and
 * the P2P file-transfer chunk loop used to each pace themselves against that
 * ceiling with their own private counter, so a file send running beside
 * ordinary chat traffic could put their combined rate past it — the socket
 * dropped with `rate_limited` and took whatever message was mid-flight down
 * with it. One [FramePacer] per connection is the fix, and "one budget, not
 * two" is exactly what these tests measure: virtual time only advances when a
 * caller is actually made to wait out a window.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class FramePacerTest {

    @Test
    fun `two senders share one window instead of each getting their own`() = runTest {
        val pacer = FramePacer(budget = 3, windowMs = 100, elapsedRealtime = { testScheduler.currentTime })

        val first = launch { repeat(3) { pacer.acquire() } }
        val second = launch { repeat(3) { pacer.acquire() } }
        first.join()
        second.join()

        // Six frames at three per window cannot fit in one window, so at least
        // one window had to be waited out. Were the budget per sender, both
        // would have run their three frames without waiting at all and the
        // clock would still read zero — which is the rate the hub closes on.
        assertTrue("expected a shared window to be waited out, clock=${testScheduler.currentTime}", testScheduler.currentTime >= 100)
        assertTrue("six frames need at most two windows, clock=${testScheduler.currentTime}", testScheduler.currentTime < 200)
    }

    @Test
    fun `one sender is held to the budget across consecutive windows`() = runTest {
        val pacer = FramePacer(budget = 3, windowMs = 100, elapsedRealtime = { testScheduler.currentTime })

        repeat(7) { pacer.acquire() }

        // Three frames may go immediately; the fourth waits, and so on.
        assertTrue("expected two windows waited out, clock=${testScheduler.currentTime}", testScheduler.currentTime >= 200)
        assertTrue("seven frames need at most three windows, clock=${testScheduler.currentTime}", testScheduler.currentTime < 300)
    }

    @Test
    fun `a fresh connection starts with a fresh budget`() = runTest {
        val pacer = FramePacer(budget = 3, windowMs = 100, elapsedRealtime = { testScheduler.currentTime })

        repeat(3) { pacer.acquire() }
        assertEquals(0, testScheduler.currentTime)
        pacer.reset()
        pacer.acquire()

        // The window the old socket spent must never throttle the new one.
        assertEquals(0, testScheduler.currentTime)
    }
}
