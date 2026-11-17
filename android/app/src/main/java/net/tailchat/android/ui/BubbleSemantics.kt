package net.tailchat.android.ui

import android.content.res.Resources
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import net.tailchat.android.R
import net.tailchat.android.cloud.CloudDelivery

/*
 * The screen-reader side of a transcript row (LOCAL_FIRST_EXECUTION_PLAN.md
 * §8A: «у каждого жеста есть доступная кнопка/действие контекстного меню и
 * TalkBack action»).
 *
 * Left alone, a bubble is a pile of separate nodes — author, text, `✎`, `✓✓`,
 * reaction pills — and TalkBack walks them one focus stop at a time, reading
 * the receipt as the two characters it is made of. Merging the row into one
 * spoken sentence and hanging the same two actions the swipe and the long
 * press offer onto it is what makes the transcript usable without a gesture.
 */

/** Merged, spoken description of one transcript row plus its TalkBack actions. */
fun Modifier.bubbleSemantics(
    author: String,
    time: String,
    body: String,
    deliveryLabel: String?,
    edited: Boolean,
    /** A «напомнить ответить» is pending on this message: the mark drawn beside
     *  `✎`, and the same fact read aloud. */
    reminded: Boolean,
    reactions: Map<String, List<String>>,
    onReply: (() -> Unit)?,
    onShowActions: () -> Unit,
): Modifier = composed {
    val resources = LocalContext.current.resources
    val spoken = remember(resources, author, time, body, deliveryLabel, edited, reminded, reactions) {
        spokenRow(
            author = author,
            body = body,
            time = time,
            deliveryLabel = deliveryLabel,
            remindedLabel = if (reminded) resources.getString(R.string.cloud_a11y_reminded) else null,
            editedLabel = if (edited) resources.getString(R.string.cloud_a11y_edited) else null,
            reactionsLabel = reactionSummary(resources, reactions),
        )
    }
    // The callbacks are rebuilt on every recomposition of the row; the actions
    // list is keyed on the labels instead and always calls the current one.
    val reply by rememberUpdatedState(onReply)
    val showActions by rememberUpdatedState(onShowActions)
    val canReply = onReply != null
    val replyLabel = stringResource(R.string.cloud_msg_reply)
    val actionsLabel = stringResource(R.string.cloud_a11y_more_actions)
    val actions = remember(canReply, replyLabel, actionsLabel) {
        buildList {
            if (canReply) add(CustomAccessibilityAction(replyLabel) { reply?.invoke(); true })
            add(CustomAccessibilityAction(actionsLabel) { showActions(); true })
        }
    }
    Modifier.semantics(mergeDescendants = true) {
        contentDescription = spoken
        customActions = actions
    }
}

/** The spoken form of a delivery state — “✓✓” read as a glyph is useless. */
@Composable
fun deliveryContentDescription(delivery: CloudDelivery): String = stringResource(
    when (delivery) {
        CloudDelivery.Queued -> R.string.cloud_delivery_queued
        CloudDelivery.Sending -> R.string.cloud_delivery_sending
        CloudDelivery.Accepted -> R.string.cloud_delivery_accepted
        CloudDelivery.Delivered -> R.string.cloud_delivery_delivered
        CloudDelivery.Read -> R.string.cloud_delivery_read
        CloudDelivery.Failed -> R.string.cloud_delivery_failed
    },
)

/**
 * The row as one sentence, in reading order: who, what, when, then the marks
 * that qualify it. Blank parts are dropped rather than spoken as a pause —
 * an incoming message has no receipt, a system note has no author.
 */
private fun spokenRow(
    author: String,
    body: String,
    time: String,
    deliveryLabel: String?,
    remindedLabel: String?,
    editedLabel: String?,
    reactionsLabel: String?,
): String = listOfNotNull(author, body, time, remindedLabel, editedLabel, deliveryLabel, reactionsLabel)
    .filter { it.isNotBlank() }
    .joinToString(separator = ", ")

/** `👍: 3, ❤: 1`, wrapped so the count is not mistaken for part of the text. */
private fun reactionSummary(resources: Resources, reactions: Map<String, List<String>>): String? {
    if (reactions.isEmpty()) return null
    val listed = reactions.entries.joinToString(separator = ", ") { (emoji, members) ->
        resources.getString(R.string.cloud_a11y_reaction, emoji, members.size)
    }
    return resources.getString(R.string.cloud_a11y_reactions, listed)
}
