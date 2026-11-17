// Selecting text out of a full-screen TUI cannot be left to the terminal: the
// app owns the alternate screen, so the terminal only ever sees the current page
// and a drag past the edge selects nothing. This is the app's own selection.
//
// It works in whole transcript lines rather than cells. A chat is read to copy a
// command, a path or a code block out of it, and a whole line is what that means;
// tracking columns across a scroll would also have to guess what a half-selected
// wrapped row is worth.

// blessed turns its own tags into real SGR sequences inside `_clines`, so the
// text has to be cleaned before it reaches a clipboard.
export function stripSgr(text) {
  return String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

// A drag has an anchor and a moving head, in either order.
export function selectionRange(anchor, head) {
  if (!Number.isInteger(anchor) || !Number.isInteger(head)) return null;
  return { from: Math.min(anchor, head), to: Math.max(anchor, head) };
}

export function rangeCovers(range, line) {
  return Boolean(range) && line >= range.from && line <= range.to;
}

// `lines` are the logical, unwrapped transcript lines; the range indexes them.
// `padWidths[i]`, when given, is how many leading cells of line `i` are pure
// alignment padding (a continuation row of a multi-line message, indented so
// it starts under the body rather than the sender label) rather than content —
// stripping it is what keeps a copied multi-line message pasting back as the
// text that was actually sent instead of gaining a wall of indent on every
// row after the first.
export function selectedText(lines, range, padWidths = []) {
  if (!range || !Array.isArray(lines)) return '';
  const from = Math.max(0, range.from);
  return lines
    .slice(from, Math.min(lines.length, range.to + 1))
    .map(stripSgr)
    .map((line, i) => {
      const pad = padWidths[from + i] ?? 0;
      return pad > 0 ? line.slice(pad) : line;
    })
    // Trailing spaces come from padding the frame, not from the message.
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n');
}

// How far to scroll when the pointer is held at an edge: dragging past the top
// or bottom is the only way to reach beyond one screen, and one line per event
// keeps it controllable rather than flinging the view.
export const EDGE_SCROLL_LINES = 1;

// Terminals report motion only when the pointer actually moves, so a pointer
// held still at an edge would freeze the reach. This is how often it repeats.
export const EDGE_SCROLL_MS = 120;

export function edgeScroll(y, top, bottom) {
  if (y <= top) return -EDGE_SCROLL_LINES;
  if (y >= bottom) return EDGE_SCROLL_LINES;
  return 0;
}
