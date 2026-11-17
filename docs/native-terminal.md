# Native terminal front end — what it buys, what it costs

Run `node bin/native-terminal-demo.js` first. That is a Tailchat transcript
printed straight into the terminal's own scrollback: the same wordmark, the
same `{name}` bubbles, the same voice card and read marks as the TUI, and
pictures as real pixels instead of a 36-column block-art stamp. Scroll up —
everything is still there, because nothing was ever drawn on an alternate
screen.

The demo answers "does it look right". This file answers "is it worth it".

## What only a native (append-only) front end can do

**Real pictures, and they stay.** The blessed TUI owns the alternate screen
and repaints it, so a graphics-protocol image placed inside it is wiped by the
next redraw. That is exactly why the transcript preview is quadrant block art
(`renderPreview`, ~144x120 px at the widened `PREVIEW_COLUMNS_MAX`) and why
`/view` has to take over the whole screen and hand it back on the next
keypress. Append-only output has no repaint, so a picture is just more stream
content and lives in scrollback next to the message it belongs to.

**The terminal's own text selection and copy.** Today the app has to *emulate*
selection (`src/selection.js`, the tap-to-highlight in the web client) and
mouse capture actively fights the terminal's selection — `showFilePreview`
even prints a one-time hint about it. Native output needs none of that:
drag-select, triple-click, block select, Cmd+C all work because it is ordinary
terminal text.

**Search, and history that outlives the process.** Cmd+F / the terminal's own
scrollback search works over the whole conversation, and the transcript
survives the client exiting. In the TUI, search does not exist and the visible
history dies with the screen.

**Copy-paste of a whole conversation, and piping.** `node … | tee log.txt`,
`| grep`, `| less` all become meaningful. A TUI's output is not a stream.

**Clickable hyperlinks (OSC 8) and native emoji/wide-char rendering.** The
terminal measures the glyphs, so the entire class of bugs `src/wide-chars.js`
exists for — column arithmetic disagreeing with the font — stops being ours.

**No keypress-decoder hazard.** AGENTS.md rule 1 exists because blessed and
readline both attach stdin decoders and every keystroke arrives twice. An
append-only client with one line editor (or none, in a `--pipe` mode) cannot
reproduce that class of bug.

**Cheaper and calmer.** No full-screen repaints on every message, no resize
redraw (the terminal reflows), no flicker, less CPU, and far less output over
a slow SSH link. Screen readers read a stream; they do not read a TUI.

## What it costs — every one of these is load-bearing today

**Immutable lines.** Once a line is printed it cannot change. That kills, or
forces a reprint of:

- read marks (`✓` → `✓✓`) — the whole receipt feature the cloud hub now
  persists (`store.markRead`/`readTs`),
- message edit (`/edit`) and delete (`/del`) — currently both rewrite rows
  in place,
- the "new messages" divider, which is *retired* when you scroll to it,
- reactions, which mutate an existing bubble,
- the typing indicator, which appears and disappears on one fixed line,
- the connection/presence pill, and the roster's unread counters.

**No panes.** The roster (peer list, presence, unread badges, previews) and
the info panel are two-dimensional layout. Append-only has one dimension.

**No composer.** The slash-command palette, autocompletion, draft-per-peer,
inline edit/reply context, `/logo` animation, the Matrix screensaver, every
picker (theme, language, peer, mic device) and every menu (`src/menu.js`) are
interactive full-screen surfaces.

**Mouse affordances disappear.** Click-a-preview-to-open, click-a-file-card,
the scroll-to-latest button.

**Graphics support is not universal.** kitty protocol: kitty, Ghostty,
WezTerm. OSC 1337: iTerm2, Warp. Windows Terminal and macOS Terminal.app:
neither. So the block-art path stays regardless — a native front end adds a
better case, it does not remove the old one (`terminalViewProtocol` already
encodes exactly this fallback).

## The honest recommendation

Do not replace the TUI. The features that make Tailchat feel like a messenger
— live read marks, editing, deletion, roster, unread state, the composer — are
precisely the ones that need a mutable screen.

The cheap 80% is a **second output mode**, not a second client: an append-only
"native transcript" mode for terminals that speak a graphics protocol, where
messages, pictures and voice cards are printed to the real screen and the
interactive surfaces are reached by command instead of by pane. It is
tractable because every transcript row already goes through one funnel
(`ui.addLine` / `ui.addMessage` / `ui.addArt`), so the mode is a different
sink for the same calls — the demo in `bin/native-terminal-demo.js` is that
sink, minus the plumbing.

Until that exists, the picture quality complaint is addressed where it is
cheapest: the transcript preview now scales with the window
(`previewColumnsFor`, 36 → up to 72 columns = 144 px wide, 4x the pixels of
the old fixed box), and `/view` still exists for full resolution.
