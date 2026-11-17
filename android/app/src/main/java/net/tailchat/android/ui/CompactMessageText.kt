package net.tailchat.android.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString

/** Reserve the measured metadata width in the final line, then place it once. */
@Composable
internal fun CompactMessageText(
    text: AnnotatedString,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
    jumbo: Boolean = false,
    modifier: Modifier = Modifier,
    meta: @Composable () -> Unit,
) {
    val body = remember(text) {
        buildAnnotatedString {
            append(text)
            append(" ")
            appendInlineContent("message-meta", "\u00a0")
        }
    }
    SubcomposeLayout(modifier) { constraints ->
        val loose = constraints.copy(minWidth = 0, minHeight = 0)
        val metadata = subcompose("metadata", meta).single().measure(loose)
        val metaWidth = metadata.width.toSp()
        val metaHeight = metadata.height.toSp()
        val content = subcompose("text") {
            val inline = remember(metaWidth, metaHeight) {
                mapOf("message-meta" to InlineTextContent(
                    Placeholder(metaWidth, metaHeight, PlaceholderVerticalAlign.Bottom),
                ) { Box(Modifier) })
            }
            EmojiText(body, style = style, jumbo = jumbo, extraInline = inline)
        }.single().measure(loose)
        layout(
            content.width.coerceIn(constraints.minWidth, constraints.maxWidth),
            content.height.coerceIn(constraints.minHeight, constraints.maxHeight),
        ) {
            content.placeRelative(0, 0)
            metadata.placeRelative(
                (content.width - metadata.width).coerceAtLeast(0),
                (content.height - metadata.height).coerceAtLeast(0),
            )
        }
    }
}
