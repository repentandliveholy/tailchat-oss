package net.tailchat.android.ui

import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import net.tailchat.android.cloud.CloudDelivery

// Canonical web/APK geometry; only the tint distinguishes delivered from read.
private fun receiptVector(single: Boolean, strokeWidth: Float): ImageVector = ImageVector.Builder(
    name = if (single) "ReceiptSingle" else "ReceiptDouble",
    defaultWidth = RECEIPT_HEIGHT * (if (single) 0.833f else 1.183f),
    defaultHeight = RECEIPT_HEIGHT,
    viewportWidth = if (single) 10f else 14.2f,
    viewportHeight = 12f,
).apply {
    path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = strokeWidth,
        strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round) {
        moveTo(1f, 6.25f)
        lineTo(3.9f, 9.15f)
        lineTo(9f, 2.85f)
        if (!single) {
            moveTo(5.2f, 6.25f)
            lineTo(8.1f, 9.15f)
            lineTo(13.2f, 2.85f)
        }
    }
}.build()

private val singleReceipt by lazy { receiptVector(single = true, strokeWidth = 1.8f) }
private val doubleReceipt by lazy { receiptVector(single = false, strokeWidth = 1.8f) }
private val readReceiptOutline by lazy { receiptVector(single = false, strokeWidth = 3.8f) }

@Composable
internal fun CloudReceiptMark(
    delivery: CloudDelivery,
    color: Color,
    modifier: Modifier = Modifier,
    outline: Color? = null,
) {
    when (delivery) {
        CloudDelivery.Accepted, CloudDelivery.Delivered, CloudDelivery.Read -> {
            val single = delivery == CloudDelivery.Accepted
            val halo = if (outline != null && delivery == CloudDelivery.Read) {
                val painter = rememberVectorPainter(readReceiptOutline)
                val filter = remember(outline) { ColorFilter.tint(outline) }
                Modifier.drawBehind { with(painter) { draw(size, colorFilter = filter) } }
            } else Modifier
            Icon(
                imageVector = if (single) singleReceipt else doubleReceipt,
                contentDescription = cloudReceiptGlyph(delivery),
                tint = color,
                modifier = modifier.size(
                    width = RECEIPT_HEIGHT * (if (single) 0.833f else 1.183f),
                    height = RECEIPT_HEIGHT,
                ).then(halo),
            )
        }
        CloudDelivery.Queued, CloudDelivery.Sending, CloudDelivery.Failed -> Text(
            text = cloudReceiptGlyph(delivery),
            modifier = modifier,
            style = MaterialTheme.typography.labelSmall.copy(
                fontFamily = TailchatMono,
                fontSize = RECEIPT_SIZE,
            ),
            color = color,
            maxLines = 1,
        )
    }
}
