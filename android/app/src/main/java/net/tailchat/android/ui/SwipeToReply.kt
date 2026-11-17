package net.tailchat.android.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import kotlin.math.abs
import kotlinx.coroutines.launch

/*
 * Swipe-to-reply, the one horizontal gesture the plan allows on a bubble
 * (LOCAL_FIRST_EXECUTION_PLAN.md §8A, «что означает смахивание»): visual
 * progress, one activation threshold, the bubble comes back, a reply target is
 * set. Nothing is sent, nothing is deleted — the gesture only reports intent.
 *
 * The transcript is a reverse-layout LazyColumn, so the hard part is *not*
 * stealing its scroll. The bubble is a child of that list, which means it sees
 * every pointer event *before* the scroll does: whatever it consumes, the list
 * never gets. The gesture therefore claims the pointer only when the movement
 * has decided it is a reply swipe — see [replySwipeDecision], which gives the
 * list the pointer back at the very distance the list itself claims one — and
 * until then it consumes nothing at all. A gesture that starts outside this
 * composable is never seen at all, which is what keeps the system edge-back
 * zone intact.
 */

/** How far towards the reading start edge the finger must travel before the
 *  gesture claims the pointer — and so, before the bubble moves at all. The
 *  same deliberate distance the roster's own swipe uses. */
private val ReplyLockDistance = 36.dp

/** How far towards the reading start edge the finger must travel to arm a reply. */
private val ReplyActivationDistance = 56.dp

/** Past the threshold the bubble keeps acknowledging the finger, at a fraction of it. */
private const val OverswipeShare = 0.35f

/** The vertical distance that hands a gesture to the list — the platform's
 *  own touch slop, which is exactly where `LazyColumn` starts scrolling.
 *  Only a fallback: a `ViewConfiguration` reporting a zero slop would veto
 *  every gesture (|dy| >= 0 is always true), which would leave the reply
 *  reachable only from the message menu. */
private val FallbackScrollSlop = 8.dp

/** What the first movement of a pointer decided this gesture is. */
internal enum class ReplySwipeDecision { Pending, Scroll, Reply }

/**
 * Direction lock for the reply swipe, pure so it can be tested without a
 * device.
 *
 * The vertical rule is a veto, not a comparison, and it is asked first: past
 * [scrollSlop] of vertical travel the gesture is the list's, whatever the
 * finger does afterwards. That is the whole point — the bubble is a child of
 * the transcript's `LazyColumn`, so it sees every event before the scroll
 * does and whatever it consumes the list never gets; a first version decided
 * by comparing the two axes at the moment of the claim, and a finger that
 * scrolled 12 px and *then* curved sideways was still read as a reply, which
 * is the «сдвиг сообщения» the user asked to stop. Since [scrollSlop] is the
 * distance at which the list itself claims the pointer, the two can never
 * disagree about who owns it.
 *
 * Within that allowance the claim needs [replyLock] towards the reading start
 * edge; `startSign` is `-1` in LTR and `+1` in RTL, and movement the other way
 * is never a reply — claiming it would take the list's scroll for nothing.
 */
internal fun replySwipeDecision(
    totalX: Float,
    totalY: Float,
    startSign: Float,
    scrollSlop: Float,
    replyLock: Float,
): ReplySwipeDecision {
    if (abs(totalY) >= scrollSlop) return ReplySwipeDecision.Scroll
    return if (totalX * startSign >= replyLock) ReplySwipeDecision.Reply else ReplySwipeDecision.Pending
}

/**
 * Horizontal swipe-to-reply for one bubble.
 *
 * [enabled] is `false` for rows that cannot be replied to (system notes); the
 * modifier then adds nothing at all, so those rows keep the plain scroll
 * behaviour instead of a gesture that silently does nothing.
 */
fun Modifier.swipeToReply(
    enabled: Boolean,
    onReply: () -> Unit,
): Modifier = if (!enabled) this else composed {
    val layoutDirection = LocalLayoutDirection.current
    val density = LocalDensity.current
    val viewConfiguration = LocalViewConfiguration.current
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    // The bubble is recomposed on every delivery/reaction change; the callback
    // captured by the long-lived pointer loop has to be the current one.
    val reply by rememberUpdatedState(onReply)
    Modifier
        // Read in the draw phase: dragging a bubble must not recompose the row.
        .graphicsLayer { translationX = offset.value }
        .pointerInput(layoutDirection, density) {
            val thresholdPx = ReplyActivationDistance.toPx()
            val replyLockPx = ReplyLockDistance.toPx()
            val configuredSlop = viewConfiguration.touchSlop
            val scrollSlopPx = if (configuredSlop > 0f) configuredSlop else FallbackScrollSlop.toPx()
            // Towards the reading start edge: left in LTR, right in RTL. The
            // plan is explicit that the direction follows layout direction.
            val startSign = if (layoutDirection == LayoutDirection.Rtl) 1f else -1f
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                var totalX = 0f
                var totalY = 0f
                var claimed = false
                var takenOver = false
                // Where the finger was when the gesture became a reply. The
                // bubble is drawn from *that* point, not from the gesture's
                // start: [ReplyLockDistance] of travel has already happened by
                // the time it is claimed, and snapping the bubble onto all of
                // it in one frame is a jolt the finger did not ask for.
                var claimX = 0f
                while (true) {
                    val event = awaitPointerEvent()
                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                    // Somebody else owns this gesture now. The list is an
                    // ancestor, so this cannot come from its own dispatch (a
                    // child is offered the event first) — but a nested scroll,
                    // a system gesture or another overlay can consume it while
                    // this gesture is still deciding, and there is no claim to
                    // defend against that. What keeps the list's own scroll is
                    // the vertical veto in [replySwipeDecision], which hands
                    // the gesture back at the very distance the list claims it.
                    if (change.isConsumed) {
                        takenOver = true
                        break
                    }
                    if (!change.pressed) break
                    val delta = change.positionChange()
                    totalX += delta.x
                    totalY += delta.y
                    if (!claimed) {
                        when (
                            replySwipeDecision(totalX, totalY, startSign, scrollSlopPx, replyLockPx)
                        ) {
                            // The list's gesture, from here on: consume nothing
                            // and never look at this pointer again.
                            ReplySwipeDecision.Scroll -> return@awaitEachGesture
                            ReplySwipeDecision.Pending -> continue
                            ReplySwipeDecision.Reply -> {
                                claimed = true
                                claimX = totalX
                            }
                        }
                    }
                    change.consume()
                    val travelled = (totalX - claimX) * startSign
                    scope.launch { offset.snapTo(startSign * travelFor(travelled, thresholdPx)) }
                }
                // Armed on the finger's whole travel, not on the drawn
                // distance: the lock is a detent the bubble waits behind, not
                // a shortening of the gesture.
                val fired = claimed && swipeOutcome(totalX, thresholdPx, layoutDirection, cancelled = takenOver)
                // Spring back first, so a throwing callback cannot leave the
                // bubble parked off-centre.
                scope.launch {
                    offset.animateTo(
                        targetValue = 0f,
                        animationSpec = spring(
                            dampingRatio = Spring.DampingRatioLowBouncy,
                            stiffness = Spring.StiffnessMedium,
                        ),
                    )
                }
                if (fired) reply()
            }
        }
}

/**
 * Does this finished gesture set a reply target?
 *
 * The whole decision of the gesture, kept pure so it can be tested without a
 * device: only a completed drag that ended at least [threshold] towards the
 * reading start edge counts. A reverse swipe ([totalDx] pointing the other
 * way), a short swipe, and a gesture another owner took over ([cancelled])
 * all do nothing — the plan forbids a swipe that acts on its own.
 */
internal fun swipeOutcome(
    totalDx: Float,
    threshold: Float,
    layoutDirection: LayoutDirection,
    cancelled: Boolean,
): Boolean {
    if (cancelled || threshold <= 0f) return false
    val towardsStart = if (layoutDirection == LayoutDirection.Rtl) totalDx else -totalDx
    return towardsStart >= threshold
}

/**
 * How far the bubble is drawn for [distance] of travel towards the start edge.
 *
 * One-to-one until the activation distance, so the user can see exactly where
 * the gesture arms, then rubber-banded: an overlong swipe must not drag the
 * bubble across the row, and pulling the wrong way must not move it at all.
 */
internal fun travelFor(distance: Float, threshold: Float): Float {
    if (threshold <= 0f || !(distance > 0f)) return 0f
    if (distance <= threshold) return distance
    val over = distance - threshold
    return threshold + threshold * OverswipeShare * over / (over + threshold)
}
