package net.tailchat.android.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.StateFlow
import kotlin.math.sqrt

/** Peak, not spectrum: quiet speech remains visible without animating silence. */
internal fun recordingLevel(peak: Int): Float =
    (sqrt(peak.coerceIn(0, 32767) / 32767f) * 1.6f).coerceAtMost(1f)

/** Collect only here: microphone samples never invalidate the conversation's state. */
@Composable
internal fun RecordingLevelMeter(amplitude: StateFlow<Int>, modifier: Modifier = Modifier) {
    val peak = amplitude.collectAsState()
    val level = animateFloatAsState(
        targetValue = recordingLevel(peak.value),
        animationSpec = tween(durationMillis = 80, easing = LinearEasing),
        label = "recording-level",
    )
    val quiet = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.18f)
    val signal = MaterialTheme.colorScheme.primary
    val loud = MaterialTheme.colorScheme.error
    Canvas(modifier.height(24.dp)) {
        val count = 18
        val gap = 2.dp.toPx()
        val width = ((size.width - gap * (count - 1)) / count).coerceAtLeast(1f)
        val minimum = 2.dp.toPx()
        val lit = level.value * count
        repeat(count) { index ->
            val fill = (lit - index).coerceIn(0f, 1f)
            val maximum = (4f + index * 14f / (count - 1)).dp.toPx()
            val height = minimum + (maximum - minimum) * fill
            drawRoundRect(
                color = lerp(quiet, if (index >= count - 3) loud else signal, fill),
                topLeft = Offset(index * (width + gap), (size.height - height) / 2f),
                size = Size(width, height),
                cornerRadius = CornerRadius(width / 2f, width / 2f),
            )
        }
    }
}
