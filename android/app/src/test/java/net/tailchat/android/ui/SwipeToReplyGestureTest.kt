package net.tailchat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The reply gesture through the real pointer pipeline, not through
 * [replySwipeDecision].
 *
 * That classifier is only half the promise. The other half is the one the user
 * asked for — «главное, это скролл без препятствий» — and it is a property of
 * the gesture loop: the modifier sits on a child of the transcript's
 * `LazyColumn`, so it is offered every event before the list is, and anything
 * it consumes the list never gets. Whether an injected drag scrolls, arms a
 * reply, or does neither is therefore only observable here.
 *
 * `xxhdpi` pins the density so the distances below are a known number of dp:
 * 1 dp = 3 px.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w400dp-h800dp-xxhdpi")
class SwipeToReplyGestureTest {
    @get:Rule
    val rule = createComposeRule()

    /** 1 dp in the qualifiers above. */
    private val px = 3f

    private val replied = mutableListOf<String>()
    private lateinit var listState: LazyListState

    /** 40 rows of 40 dp in a 300 dp window: seven fit, so there is somewhere to
     *  scroll and an unambiguous first visible index. */
    private fun showTranscript() {
        rule.setContent {
            listState = rememberLazyListState()
            LazyColumn(state = listState, modifier = Modifier.height(300.dp).background(Color.White)) {
                items(40) { index ->
                    val label = "row ${index + 1}"
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(40.dp)
                            .swipeToReply(enabled = true) { replied += label }
                            .testTag(label),
                    ) { Text(label) }
                }
            }
        }
    }

    /** One continuous touch on [tag], in px steps. Several moves, the way a
     *  finger arrives: a single jump is not a gesture, and the loop decides on
     *  accumulated travel. */
    private fun drag(tag: String, moves: List<Offset>) {
        rule.onNodeWithTag(tag).performTouchInput {
            down(center)
            for (move in moves) {
                val steps = 8
                repeat(steps) { moveBy(Offset(move.x / steps, move.y / steps)) }
            }
            up()
        }
    }

    @Test
    fun aVerticalDragOverABubbleScrollsTheTranscriptAndRepliesToNothing() {
        showTranscript()
        val before = listState.firstVisibleItemIndex

        drag("row 4", listOf(Offset(0f, -120 * px)))

        assertTrue(
            "the list did not move: still at ${listState.firstVisibleItemIndex}",
            listState.firstVisibleItemIndex > before,
        )
        assertEquals(emptyList<String>(), replied)
    }

    @Test
    fun aDiagonalDragWithTheFingerScrollingStillScrolls() {
        showTranscript()
        val before = listState.firstVisibleItemIndex

        // 120 dp up and 30 dp across: far past the ~8 dp the old touch-slop
        // claim needed sideways, and still a scroll.
        drag("row 4", listOf(Offset(-30 * px, -120 * px)))

        assertTrue(
            "the list did not move: still at ${listState.firstVisibleItemIndex}",
            listState.firstVisibleItemIndex > before,
        )
        assertEquals(emptyList<String>(), replied)
    }

    /**
     * The trajectory the veto exists for: the finger scrolls first and curves
     * sideways afterwards. The list has already taken the pointer by then, and
     * a claim made on the curve would be a claim on a gesture the list is in
     * the middle of.
     */
    @Test
    fun aDragThatScrollsFirstAndThenCurvesSidewaysIsStillAScroll() {
        showTranscript()
        val before = listState.firstVisibleItemIndex

        drag("row 4", listOf(Offset(0f, -30 * px), Offset(-60 * px, -90 * px)))

        assertTrue(
            "the list did not move: still at ${listState.firstVisibleItemIndex}",
            listState.firstVisibleItemIndex > before,
        )
        assertEquals(emptyList<String>(), replied)
    }

    @Test
    fun aSidewaysDragTowardsTheStartEdgeArmsTheReply() {
        showTranscript()

        // 66 dp: past the 56 dp arming distance, and nowhere near vertical.
        drag("row 3", listOf(Offset(-66 * px, 0f)))

        assertEquals(listOf("row 3"), replied)
    }

    @Test
    fun aSidewaysDragAwayFromTheStartEdgeDoesNothing() {
        showTranscript()
        val before = listState.firstVisibleItemIndex

        drag("row 3", listOf(Offset(66 * px, 0f)))

        assertEquals(emptyList<String>(), replied)
        assertEquals(before, listState.firstVisibleItemIndex)
    }

    @Test
    fun aSwipeShortOfTheLockArmsNothingAndDoesNotScroll() {
        showTranscript()
        val before = listState.firstVisibleItemIndex

        // 20 dp across: past the platform slop, short of the 36 dp lock.
        drag("row 3", listOf(Offset(-20 * px, 0f)))

        assertEquals(emptyList<String>(), replied)
        assertEquals(before, listState.firstVisibleItemIndex)
    }
}
