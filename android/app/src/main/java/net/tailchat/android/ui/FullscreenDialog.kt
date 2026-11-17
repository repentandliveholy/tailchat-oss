package net.tailchat.android.ui

import android.view.WindowManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat

/**
 * A full-screen picture viewer, or an image editor fitted above the keyboard.
 *
 * The platform dim is off: each surface draws its own scrim, so a viewer's swipe
 * can reveal the conversation without a second dim underneath. The viewer draws
 * edge to edge; the editable dialog uses platform inset fitting so its legacy
 * Compose Dialog window actually resizes when the keyboard opens.
 *
 * [resizeForKeyboard] is for a dialog with a text field: the window then shrinks above the
 * on-screen keyboard (and, on API 30+, reports the keyboard through `WindowInsets.ime`), so the
 * caption stays visible while the picture above it makes room.
 *
 * The bars' icons are forced light: they sit over black, whatever the app's theme says.
 */
@Composable
internal fun FullscreenDialog(
    onDismissRequest: () -> Unit,
    resizeForKeyboard: Boolean = false,
    content: @Composable () -> Unit,
) {
    Dialog(
        onDismissRequest = onDismissRequest,
        properties = DialogProperties(
            dismissOnBackPress = true,
            dismissOnClickOutside = false,
            // Compose 1.7's custom-width branch fixes height to the screen too, ignoring the IME.
            // Editable dialogs use normal measurement with full-window layout params instead.
            usePlatformDefaultWidth = resizeForKeyboard,
            decorFitsSystemWindows = resizeForKeyboard,
        ),
    ) {
        val view = LocalView.current
        SideEffect {
            // The compose view's parent is the dialog's own `DialogLayout`, which is the window provider.
            val window = (view.parent as? DialogWindowProvider)?.window ?: return@SideEffect
            window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            if (resizeForKeyboard) {
                val matchParent = WindowManager.LayoutParams.MATCH_PARENT
                if (window.attributes.width != matchParent || window.attributes.height != matchParent) {
                    window.setLayout(matchParent, matchParent)
                }
                window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
            }
            val bars = WindowCompat.getInsetsController(window, view)
            bars.isAppearanceLightStatusBars = false
            bars.isAppearanceLightNavigationBars = false
        }
        content()
    }
}
