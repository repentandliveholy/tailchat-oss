package net.tailchat.android.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel

/**
 * What one Back press should do, decided once here instead of scattered
 * `if`s at every call site — [net.tailchat.android.MainActivity] pattern-matches
 * this to run the one platform action ([BackOutcome.ExitApp]) this class
 * cannot perform itself (`moveTaskToBack` needs the `Activity`).
 */
sealed interface BackOutcome {
    /** A layer closed (palette/context/recording/conversation/P2P). Nothing
     *  else happens. */
    data object Consumed : BackOutcome

    /** The first Back press on the root roster just armed the exit window —
     *  the caller shows the localized "press again to exit" toast. */
    data object ExitArmed : BackOutcome

    /** A second Back on the root roster within [CloudUiViewModel.EXIT_WINDOW_MS]
     *  of the first: the caller must `moveTaskToBack(true)`. Never `finish()`
     *  or a logout — see LOCAL_FIRST_EXECUTION_PLAN.md §8A for why those are
     *  the wrong ones. */
    data object ExitApp : BackOutcome
}

/**
 * Screen-level state that a hardware Back press needs to know about, and
 * nothing else — the transcript, roster and drafts are [net.tailchat.android.data.ChatRepository]'s
 * and observed straight from there; this is only what is currently drawn on
 * top of it (LOCAL_FIRST_EXECUTION_PLAN.md §8A).
 *
 * Before this class the app had two independent back handlers
 * (`MainActivity`'s `showP2P` toggle and `CloudScreen`'s `closeConversation`),
 * and three more layers — the emoji palette, an active reply/edit, an
 * in-progress voice recording — had no Back handling at all, so a Back press
 * during any of them skipped straight past the thing actually on screen and
 * closed the whole conversation. `MainActivity` now owns exactly one
 * `PredictiveBackHandler`, and every screen reports what it has open here
 * instead of registering a handler of its own.
 *
 * A `Dialog`/`Popup`-backed layer (`AlertDialog`, `ModalBottomSheet`,
 * `DropdownMenu`) needs no entry: those own a separate Android window and
 * already consume the platform Back press before `MainActivity`'s dispatcher
 * ever sees it. Only same-window overlays — state this composable tree draws
 * inline — have to be tracked here.
 *
 * `showP2P` is the only field worth surviving process death: the rest
 * (emoji palette open, an unfinished reply/edit, a live recording, the exit
 * arm window) are either cheap to lose or already recoverable — a reply/edit
 * target is UI-only, an in-progress recording cannot survive process death
 * regardless of what this class remembers since the recorder itself dies
 * with the process, and a lost arm window just means one extra Back press
 * after a process restart, never a stuck or premature exit.
 */
class CloudUiViewModel(private val savedStateHandle: SavedStateHandle) : ViewModel() {

    /** Wall-clock by default; a test overrides this directly (same package,
     *  no constructor parameter) — `androidx.lifecycle`'s reflective
     *  `SavedStateViewModelFactory` only knows how to satisfy a
     *  `SavedStateHandle`/`CreationExtras` constructor parameter, and a
     *  second parameter — even with a Kotlin default value, which is
     *  compile-time sugar, not something the factory's reflection sees —
     *  makes it throw `Cannot create an instance of class CloudUiViewModel`
     *  at runtime. Caught only by an actual `viewModel()` call on a device;
     *  no unit test exercises that factory. */
    internal var clock: () -> Long = System::currentTimeMillis

    var showP2P: Boolean by mutableStateOf(savedStateHandle[KEY_SHOW_P2P] ?: false)
        private set

    var emojiPaletteOpen: Boolean by mutableStateOf(false)
        private set

    private var composerContextOpen: Boolean = false
    private var cancelComposerContext: (() -> Unit)? = null

    private var voiceRecordingActive: Boolean = false
    private var cancelVoiceRecording: (() -> Unit)? = null

    /**
     * Bumped once per [net.tailchat.android.MainActivity.onStart] — cold
     * launch and every return from being genuinely stopped (Home, recents,
     * screen lock), never a same-process navigation inside the app. The
     * roster's logo-reveal keys its replay off this instead of its own
     * `remember`, which is what "once per resume, not once per visit to the
     * roster" needs: `onStart`/`onStop` bracket real backgrounding, `onPause`
     * fires too eagerly (a permission dialog, a share sheet) to mean "the
     * user left".
     */
    var appStartSignal: Int by mutableStateOf(0)
        private set

    fun noteAppStarted() {
        appStartSignal++
    }

    /** When the first Back press on the root roster armed the exit window, or
     *  `null` when unarmed. A second press within [EXIT_WINDOW_MS] exits. */
    private var exitArmedAt: Long? = null

    fun openP2P() {
        showP2P = true
        savedStateHandle[KEY_SHOW_P2P] = true
        noteRouteChanged()
    }

    fun closeP2P() {
        showP2P = false
        savedStateHandle[KEY_SHOW_P2P] = false
        noteRouteChanged()
    }

    fun openEmojiPalette(open: Boolean) {
        emojiPaletteOpen = open
    }

    /** Called by the composer whenever a reply/edit target changes; `onCancel`
     *  is invoked at most once for the target it was registered with. */
    fun setComposerContext(active: Boolean, onCancel: (() -> Unit)?) {
        composerContextOpen = active
        cancelComposerContext = onCancel
    }

    fun setVoiceRecording(active: Boolean, onCancel: (() -> Unit)?) {
        voiceRecordingActive = active
        cancelVoiceRecording = onCancel
    }

    /**
     * Any navigation that reaches the root roster (or leaves it) by a means
     * other than this dispatcher's own Back handling — selecting a
     * conversation, a notification deep link, a cold launch straight into a
     * chat. An armed exit window must not survive a route change: leaving the
     * root and coming back later must not make the *next* Back press on root
     * read as a phantom "second" one — see LOCAL_FIRST_EXECUTION_PLAN.md §8A.
     */
    fun noteRouteChanged() {
        exitArmedAt = null
    }

    /**
     * The one dismiss order the whole app follows, per §8A: emoji palette →
     * reply/edit context → voice recording (safe cancel, never a silent send
     * or a silent discard) → conversation → P2P → root roster's double-Back
     * exit window (armed on the first press, `moveTaskToBack` on the second
     * within [EXIT_WINDOW_MS] — never `finish()`, never a logout).
     */
    fun consumeBack(conversationOpen: Boolean, closeConversation: () -> Unit): BackOutcome {
        when {
            emojiPaletteOpen -> emojiPaletteOpen = false
            composerContextOpen -> {
                cancelComposerContext?.invoke()
                composerContextOpen = false
            }
            voiceRecordingActive -> {
                cancelVoiceRecording?.invoke()
                voiceRecordingActive = false
            }
            conversationOpen -> closeConversation()
            showP2P -> closeP2P()
            else -> {
                val armedAt = exitArmedAt
                val now = clock()
                return if (armedAt != null && now - armedAt <= EXIT_WINDOW_MS) {
                    exitArmedAt = null
                    BackOutcome.ExitApp
                } else {
                    exitArmedAt = now
                    BackOutcome.ExitArmed
                }
            }
        }
        return BackOutcome.Consumed
    }

    companion object {
        private const val KEY_SHOW_P2P = "showP2P"

        /** How long the first root Back press's exit arm stays live for a
         *  confirming second press — the localized toast tells the user this
         *  window exists. */
        const val EXIT_WINDOW_MS = 2_000L
    }
}
