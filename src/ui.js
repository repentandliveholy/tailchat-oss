import { patchedEmojiRanges } from './wide-chars.js'; // must load before blessed builds any screen
import blessed from 'blessed';
import {
  createPasteInput, compactPastedText, transcriptKeys, matchKey,
} from './paste.js';
import { highlight, normaliseLanguage } from './highlight.js';

// On a Mac the shortcut key is ⌘, which blessed only ever sees as `meta` (its
// key object has ctrl, meta and shift — nothing for Command). The two are
// treated as the same modifier there.
const MAC = process.platform === 'darwin';
import {
  selectionRange, rangeCovers, selectedText, edgeScroll, EDGE_SCROLL_MS,
} from './selection.js';
import { createEditor } from './editor.js';
import { readPresenceState } from './presence.js';
import { stripVTControlCharacters } from 'node:util';

const COMPACT_WIDTH = 60;
const MAX_DRAFT_ROWS = 5;
const WHEEL_STEP = 3;
// One paint per notch is fine on text and hopeless on pictures, and a trackpad
// sends notches far faster than a terminal can swallow frames. 16ms is a frame
// at 60Hz: fast enough that a sweep looks continuous, slow enough that a burst
// of thirty notches costs three paints instead of thirty.
const SCROLL_FRAME_MS = 16;
// The command menu over the composer and its completion rows show the same
// number of entries, or the two would scroll differently. The standalone
// full-screen list menu (menu.js) sizes itself from the terminal instead — a
// frame can hold more than six rows on a tall screen.
export const MENU_ROWS = 6;
// Shimmer velocity, matched to omp: the band advances one cell per frame at
// 30 fps. Velocity is fixed rather than sweep duration, so a long label travels
// at the same speed as a short one instead of racing to finish on time and
// stepping visibly.
const SHIMMER_MS = 33;
// The logo sweep. One column per frame at roughly 40 a second: fast enough to
// read as drawing rather than as rows appearing, and about a second end to end
// on a wordmark this wide. Slower and it is a wait, faster and it is a flicker.
const LOGO_FRAME_MS = 24;
// A slow phosphor pulse over the night scene, in the same green the band logo
// is drawn in: the picture breathes without any of it moving. Numeric xterm-256
// cells are emitted verbatim by blessed, avoiding remapping at the dark end.
const SAVER_GLOW = [22, 28, 34, 40, 46, 40, 34, 28];
// No background of its own: the saver sits on the same terminal background the
// transcript does, so switching to it does not repaint the window a different
// colour. Only the drawing is coloured, exactly like the band logo.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function safeTerminalText(value) {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '')
    // Variation selectors make terminals pick emoji presentation while blessed
    // still measures one cell, which desyncs the screen buffer and shifts rows.
    .replace(/[\uFE0E\uFE0F]/gu, '');
}

// CJK/fullwidth ranges blessed already measured correctly natively, before
// wide-chars.js's patch ever ran — kept here rather than duplicated into that
// patch, which exists only to add what blessed@0.1.81 predates: emoji.
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x20000, 0x3fffd],
];

// Blessed reports width 1 for emoji, so drafts overflow their box. Measure
// the cells a terminal actually paints instead — for emoji specifically, the
// same table wide-chars.js already patches blessed's own renderer with
// (`patchedEmojiRanges`), not a second hand-copied list: keeping two tables
// in sync by hand is exactly how "⚡" ended up counted as 1 cell here while
// blessed painted it as 2, pushing header status text off the widget.
export function displayWidth(value) {
  const text = String(value ?? '');
  let width = 0;
  for (const char of text) {
    const point = char.codePointAt(0);
    if (point === 0x200d) continue;                       // zero-width joiner
    if (point >= 0x0300 && point <= 0x036f) continue;     // combining marks
    if (point === 0xfe0e || point === 0xfe0f) {
      width += 1;                                         // emoji presentation
      continue;
    }
    const wide = WIDE_RANGES.some(([lo, hi]) => point >= lo && point <= hi)
      || patchedEmojiRanges.some(([lo, hi]) => point >= lo && point <= hi);
    width += wide ? 2 : 1;
  }
  return width;
}

const escapeMarkup = (value) => blessed.escape(safeTerminalText(value));

// Cells, not code points: a header packed to the edge with an emoji badge
// (see renderHeaderMarkup's transport/peerClient badges) needs the same cell
// accounting displayWidth already gives every other layout in this file —
// counting code points here undercounts a wide character by one cell and
// pushes whatever comes after it (the status text) past the widget's right
// edge, where blessed silently drops it instead of wrapping.
function truncate(value, maxWidth) {
  const text = String(value ?? '');
  if (displayWidth(text) <= maxWidth) return text;
  if (maxWidth <= 1) return '…'.slice(0, maxWidth);
  let out = '';
  let used = 0;
  for (const char of text) {
    const w = displayWidth(char);
    if (used + w > maxWidth - 1) break;
    out += char;
    used += w;
  }
  return `${out}…`;
}

// Ranked so a late `ack` cannot undo a `read` that already arrived. ⧗ and ⚠
// share the bottom rung on purpose: both say "the server has not taken this",
// and the retry loop moves a row between them — ⧗ → ⚠ when the queue gives up,
// ⚠ → ⧗ when the person asks again (see `climbs`). Neither outranks the other
// and neither can ever overwrite a rung the server has confirmed.
export const MARKER_RANK = { '⧗': 0, '⚠': 0, '✓': 1, '✓✓': 2 };

// The core's receipt names as this client draws them: the one ladder
// AGENTS.md §12 fixes for every client. Delivered and read share the glyph and
// are told apart by colour alone, which is what `markerRead` carries.
export const RECEIPT_MARKERS = Object.freeze({
  queued: '⧗', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '⚠',
});

// Whether `next` may replace `current` on the ladder: upward only, plus the one
// sideways step the shared bottom rung allows. A mark never walks backwards.
export function climbs(current, next) {
  const from = MARKER_RANK[current] ?? -1;
  const to = MARKER_RANK[next] ?? -1;
  if (to < 0) return false;
  return to > from || (to === 0 && from === 0 && next !== current);
}

// The ceiling `src/cloud/accounts.js` puts on one emoji's login list, mirrored
// here so a tally built up frame by frame in a long-lived session cannot grow
// past what the same conversation reloaded from the server would show.
const REACTION_LOGINS_MAX = 100;

// History and the live socket describe the same message, not two transcript
// rows. A later snapshot may update its body/reactions but cannot lower a
// receipt that already arrived on the socket.
export function mergeMessageState(previous, message) {
  const merged = { ...previous, ...message };
  if (previous.markerRead || (MARKER_RANK[previous.marker] ?? -1) > (MARKER_RANK[message.marker] ?? -1)) {
    merged.marker = previous.marker;
  }
  merged.markerRead = Boolean(previous.markerRead || message.markerRead);
  return merged;
}

export function createHistoryBuffer(
  limit = 2000,
  render = (message, options) => renderMessageMarkup({ ...message, ...options }),
) {
  let entries = [];

  const trim = () => {
    if (entries.length > limit) entries = entries.slice(entries.length - limit);
  };

  // Rendered once, kept on the entry: the whole transcript is redrawn for every
  // appended line, and re-rendering two thousand messages to add one status line
  // is work nobody asked for. A marker change drops the one entry it touches.
  const textOf = (entry) => {
    if (entry.text == null) {
      entry.text = render(entry.message, {
        onPrefix: (prefix, lead = 0) => { entry.prefix = prefix; entry.lead = lead; },
      });
    }
    return entry.text;
  };

  const draw = () => entries.map((entry) => textOf(entry)).join('\n');

  // A multi-line message bakes real alignment spaces after every internal
  // newline (see continuationPrefixWidth) so continuation rows start under the
  // body, not under the sender label. Selection-copy has to undo exactly that
  // padding — never generic leading whitespace, or a code block's own indent
  // would be stripped along with it — so each drawn line gets its true pad
  // width recorded here, in lockstep with `draw()`'s line numbering.
  //
  // `entry.prefix` comes from `render`'s own `onPrefix` report (set by
  // `textOf`), not from recomputing the padding via `continuationPrefixWidth`
  // here: `render` is a pluggable constructor argument — tests hand it their
  // own — so a formula guessed from the entry's fields would silently strip
  // real characters off any render that pads differently, or not at all.
  const computeCopyPadding = () => {
    const pads = [];
    for (const entry of entries) {
      const rows = textOf(entry).split('\n');
      const prefix = entry.prefix ?? 0;
      // Which drawn row carries the start of the body. A reply prints its quote
      // above the body, and that row is padding from its very first character —
      // unlike a plain message, whose first row opens with the sender label and
      // so has nothing to strip. `render` reports the count, for the same
      // reason it reports the width: a render that quotes differently, or not
      // at all, must not have a layout guessed on its behalf.
      const body = entry.lead ?? 0;
      for (let i = 0; i < rows.length; i++) pads.push(i === body ? 0 : prefix);
    }
    return pads;
  };

  const heightOf = (text) => {
    let rows = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) rows += 1;
    return rows;
  };

  // Where a thing sits is derived from the entries every time it is asked for,
  // never remembered. The buffer trims its head and /clear takes messages out of
  // the middle, so a line number written down at append time points at the wrong
  // picture minutes later — or, once a session got long, at nothing at all,
  // which is how clicking a preview quietly stopped opening it.
  const walk = (visit) => {
    let line = 0;
    for (const entry of entries) {
      const text = textOf(entry);
      const height = heightOf(text);
      if (visit(entry, line, height) === false) return;
      line += height;
    }
  };

  const putMessage = (message, ordered = false) => {
    const existing = message.id
      ? entries.find((entry) => entry.kind === 'message' && entry.id === message.id)
      : null;
    if (existing) {
      existing.message = mergeMessageState(existing.message, message);
      existing.text = null;
      return;
    }
    const entry = { kind: 'message', id: message.id ?? null, message: { ...message } };
    // A cold-cache HTTP answer can arrive after the latest live message.
    // Insert its older rows before that message, leaving attached art beside
    // the entry that owns it rather than sorting all transcript lines.
    const before = ordered && Number.isFinite(message.ts)
      ? entries.findIndex((item) => item.kind === 'message' && item.message.ts > message.ts)
      : -1;
    if (before >= 0) entries.splice(before, 0, entry);
    else entries.push(entry);
  };

  return {
    appendLine(text) {
      entries.push({ kind: 'line', text: String(text) });
      trim();
      return draw();
    },
    replaceLastLine(text) {
      const last = entries[entries.length - 1];
      if (!last || last.kind !== 'line') return null;
      last.text = String(text);
      return draw();
    },
    // A preview stays adjacent to the message that introduced it even when its
    // asynchronous renderer finishes after later messages have arrived.
    appendArt(lines, file = null, afterMessageId = null) {
      const entry = { kind: 'line', text: lines.join('\n'), file: file ?? null };
      const after = afterMessageId
        ? entries.findIndex((item) => item.kind === 'message' && item.id === afterMessageId)
        : -1;
      if (after >= 0) entries.splice(after + 1, 0, entry);
      else entries.push(entry);
      trim();
      return draw();
    },
    appendMessage(message) {
      putMessage(message);
      trim();
      return draw();
    },
    // The same append, for a batch. Every call to `draw()` joins the whole
    // transcript, so appending a replayed conversation one message at a time
    // concatenated it once per message; here it is joined once.
    appendMessages(messages) {
      for (const message of messages) putMessage(message, true);
      trim();
      return draw();
    },
    // Logical-line ranges owned by previews, so a click on one opens the picture
    // instead of selecting the half-block cells it is made of.
    artSpans() {
      const spans = [];
      walk((entry, line, height) => {
        if (entry.file) spans.push({ from: line, to: line + height - 1, file: entry.file });
      });
      return spans;
    },
    // Links are matched by (line, column), and only the message under the click
    // is re-rendered to find them: scanning the whole transcript for every click
    // would cost as much as painting it.
    linkAt(line, col) {
      let url = null;
      walk((entry, start, height) => {
        if (line >= start + height) return true;
        if (entry.kind === 'message') {
          const links = [];
          render(entry.message, { onLink: (span) => links.push(span) });
          url = findLink(links, line - start, col);
        }
        return false;
      });
      return url;
    },
    setMarker(id, marker) {
      if (!id) return false;
      const entry = entries.find((item) => item.kind === 'message' && item.id === id);
      if (!entry) return false;
      if (!climbs(entry.message.marker, marker)) return false;
      // A ✓✓ arriving here is the *delivered* rung — the peer's device holds
      // the message — never the read one: only a receipt going through
      // markReadUpTo below means the peer's client reported reading it. The
      // glyph cannot tell the two apart, so the flag carries it.
      entry.message = { ...entry.message, marker, markerRead: false };
      entry.text = null;
      return true;
    },

    // A read receipt is a watermark, not a fact about one message: the peer
    // cannot have read what they reported without having read everything
    // above it. Receipts also get lost — an offline queue trimmed, a socket
    // replaced mid-flight — and a run of older messages left on ✓ underneath
    // a newer ✓✓ is simply wrong.
    markReadUpTo(id) {
      if (!id) return 0;
      const at = entries.findIndex((item) => item.kind === 'message' && item.id === id);
      if (at < 0) return 0;
      let changed = 0;
      for (let i = 0; i <= at; i += 1) {
        const item = entries[i];
        if (item.kind !== 'message' || !item.message.self) continue;
        const rank = MARKER_RANK[item.message.marker] ?? -1;
        // Never invents a marker for a message that never carried one.
        if (rank < 0) continue;
        // ⧗ and ⚠ never reached the server, so the peer cannot have read them
        // however old they are — only the message the receipt names, which they
        // plainly did read. Android and web skip the same rows.
        if (i !== at && rank === 0) continue;
        // Already a read: a repeated receipt changes nothing. A ✓✓ that is
        // merely *delivered* is not skipped — the ranking by glyph alone
        // cannot see past its own two ticks, so a delivered message would sit
        // colourless-forever without this check on the flag instead.
        if (item.message.markerRead) continue;
        item.message = { ...item.message, marker: '✓✓', markerRead: true };
        item.text = null;
        changed += 1;
      }
      return changed;
    },

    // `reset` makes `edited` the whole answer instead of one more reason to say
    // "edited": taking an edit back must not leave the mark it drew.
    updateMessage(id, text, { edited = true, reset = false } = {}) {
      if (!id || typeof text !== 'string') return false;
      const entry = entries.find((item) => item.kind === 'message' && item.id === id);
      if (!entry) return false;
      entry.message = { ...entry.message, text, edited: reset ? Boolean(edited) : Boolean(edited || entry.message.edited) };
      entry.text = null;
      return true;
    },
    // The tally belongs to the message, so it is stored on it: a reaction that
    // arrived for a message this buffer no longer holds has nowhere to go, and
    // reporting that lets the caller announce it as a line instead of dropping
    // it on the floor.
    setReactions(id, reactions) {
      if (!id) return false;
      const entry = entries.find((item) => item.kind === 'message' && item.id === id);
      if (!entry) return false;
      entry.message = { ...entry.message, reactions };
      entry.text = null;
      return true;
    },
    // A `react` frame says "this login added or removed this emoji", not "the
    // tally is now this", so the map is edited in place: rebuilding it from a
    // frame that names one person would throw everybody else's reaction away.
    //
    // Returns whether the message was there to carry it. Deliberately not
    // "whether anything changed": a second tap on the same emoji by the same
    // login is already reflected, and answering `false` to it would make the
    // caller announce a reaction to trimmed-away history that is right here.
    applyReaction(id, emoji, by, add) {
      if (!id || typeof emoji !== 'string' || emoji === '') return false;
      if (typeof by !== 'string' || by === '') return false;
      const entry = entries.find((item) => item.kind === 'message' && item.id === id);
      if (!entry) return false;
      const current = entry.message.reactions;
      const reactions = current && typeof current === 'object' && !Array.isArray(current)
        ? current
        : {};
      const logins = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
      const at = logins.indexOf(by);
      if (add) {
        if (at >= 0 || logins.length >= REACTION_LOGINS_MAX) return true;
        logins.push(by);
      } else {
        if (at < 0) return true;
        logins.splice(at, 1);
      }
      // An emoji nobody stands behind any more is not "x0", it is gone.
      if (logins.length === 0) delete reactions[emoji];
      else reactions[emoji] = logins;
      entry.message = {
        ...entry.message,
        reactions: Object.keys(reactions).length > 0 ? reactions : undefined,
      };
      entry.text = null;
      return true;
    },
    markerOf(id) {
      const entry = entries.find((item) => item.kind === 'message' && item.id === id);
      return entry ? entry.message.marker ?? null : null;
    },
    reactionsOf(id) {
      const entry = entries.find((item) => item.kind === 'message' && item.id === id);
      return entry ? entry.message.reactions ?? null : null;
    },
    // What a reply needs in order to quote something: a copy of the stored
    // fields, never the entry, so a lookup cannot become a way to rewrite the
    // transcript from outside.
    messageById(id) {
      if (!id) return null;
      const entry = entries.find((item) => item.kind === 'message' && item.id === id);
      if (!entry) return null;
      const { self, name, text, media, edited } = entry.message;
      return {
        id: entry.id,
        self: Boolean(self),
        name: name ?? null,
        text: typeof text === 'string' ? text : '',
        media: typeof media === 'string' ? media : null,
        edited: Boolean(edited),
      };
    },
    // Takes messages out of the transcript entirely. Returns how many were
    // actually there: the caller announces a deletion, and announcing one that
    // removed nothing — a message already trimmed off the head of the buffer,
    // an id from a peer for something this side never saw — would be a lie.
    remove(ids) {
      const wanted = new Set((Array.isArray(ids) ? ids : []).filter(Boolean));
      if (wanted.size === 0) return 0;
      const before = entries.length;
      entries = entries.filter((item) => !(item.kind === 'message' && wanted.has(item.id)));
      return before - entries.length;
    },
    // The newest message ids, most recent first, so `/del` can mean "what I just
    // said" without the reader having to name an id they have never seen.
    // Filtered by authorship because deleting for everyone is only ever offered
    // for one's own words.
    recentIds({ self = null, limit = 1 } = {}) {
      const found = [];
      for (let i = entries.length - 1; i >= 0 && found.length < limit; i -= 1) {
        const item = entries[i];
        if (item.kind !== 'message' || !item.id) continue;
        if (self !== null && Boolean(item.message.self) !== self) continue;
        found.push(item.id);
      }
      return found;
    },
    // A copy of the transcript can only identify a message, never rebuild it:
    // the wrap seams are gone by the time it reaches the clipboard. The text is
    // held right here, so a key with the spacing removed is enough to hand back
    // what was actually sent.
    lookup(keys) {
      if (!Array.isArray(keys) || keys.length === 0) return null;
      const quoted = [];
      for (const key of keys) {
        const found = new Set(entries
          .filter((item) => item.kind === 'message' && matchKey(item.message.text) === key)
          .map((item) => item.message.text));
        // The same words twice are the same quote. Two different messages behind
        // one key would be a guess, and a guess must not rewrite a paste.
        if (found.size !== 1) return null;
        quoted.push([...found][0]);
      }
      return quoted.join('\n');
    },
    content() {
      return draw();
    },
    copyPadding() {
      return computeCopyPadding();
    },
    // A theme switch changes what render() would produce for every message
    // already on screen; only messages, not system lines, carry a sender
    // colour, so only their cached text needs to be dropped.
    recolor() {
      for (const entry of entries) if (entry.kind === 'message') entry.text = null;
      return draw();
    },
    // /clear empties the transcript outright. The logo is not in here — it is a
    // band of its own above the history, so clearing cannot take it away and
    // scrolling cannot hide it.
    clear() {
      entries = [];
      return '';
    },
  };
}

export function isCompact(width) {
  return Number(width) < COMPACT_WIDTH;
}

export function statusPresentation(status, themed = true) {
  const normalized = String(status || '').trim().replace(/…/g, '').toLowerCase();
  let presentation;
  // Only base colour names may appear here: blessed's tag parser silently
  // prints `{brightgreen-fg}` as text. Brightness comes from bold instead.
  // No `typing` here on purpose: the indicator lives on the composer rule, and
  // the header keeps showing presence while the peer types. 0.29.0 moved it and
  // left this branch behind, dead, until 0.42.28 took it out.
  if (normalized === 'active') {
    presentation = { symbol: '●', label: 'ACTIVE', color: 'green' };
  } else if (normalized === 'idle') {
    presentation = { symbol: '◐', label: 'IDLE', color: 'cyan' };
  } else if (normalized === 'away') {
    presentation = { symbol: '○', label: 'AWAY', color: 'yellow' };
  } else if (normalized === 'online') {
    presentation = { symbol: '●', label: 'ONLINE', color: 'green' };
  } else if (normalized.includes('reconnect')) {
    presentation = { symbol: '◌', label: 'RECONNECTING', color: 'yellow' };
  } else if (normalized === 'offline') {
    presentation = { symbol: '●', label: 'OFFLINE', color: 'red' };
  } else if (normalized === 'connecting') {
    presentation = { symbol: '◌', label: 'CONNECTING', color: 'yellow' };
  } else {
    // Waiting is the honest default and the state we are in most of the time: the
    // listener is up, the backoff has nothing in flight, and the peer arrives when
    // it arrives. CONNECTING is reserved for a call that is genuinely open, so a
    // yellow header means something is happening this second.
    presentation = { symbol: '◌', label: 'WAITING', color: 'gray' };
  }
  return themed
    ? presentation
    : { symbol: '', label: presentation.label, color: null };
}

function statusMarkup(presentation, themed) {
  const plain = presentation.symbol
    ? `${presentation.symbol} ${presentation.label}`
    : presentation.label;
  return themed
    ? `{${presentation.color}-fg}{bold}${plain}{/bold}{/${presentation.color}-fg}`
    : plain;
}

// omp's shimmer, matched: a soft cosine band sweeps the label from one end to
// the other, walks off the edge, and waits in the dark before the next pass.
// The pause is what makes it breathe — a band that wraps straight back round
// reads as a barber pole. Either way the width never changes, which animated
// dots could only manage by padding.
// Named as xterm-256 cells rather than hex: blessed re-matches a hex triplet
// against its own table, and the dim end of a green ramp kept snapping to a
// grey (236) or a teal (23) cell — the resting label came out the wrong colour
// on every terminal. An index is emitted as `38;5;n` verbatim.
// Deliberately short: a longer ramp made blessed stop marking lines dirty and
// the animation froze with no output (reproduces around 13+ shades). The motion
// smoothness comes from the frame time and the cosine profile instead.
// Dark phosphor green at rest through vivid to near-white at the crest. The
// floor still has to be readable: with the band off stage the whole label sits
// on it, and an indicator nobody can read is not one.
const SHIMMER = [22, 28, 65, 71, 77, 83, 120, 157, 194];
// How far past each end the head travels, and the half-width of the lit band.
// The run-up has to be longer than the half-width or the label never goes fully
// dark and the passes run into each other.
const SHIMMER_PAD = 10;
const SHIMMER_HALF = 6;

// One full pass, counted in frames: across the label plus the run-up and the
// run-out. A fixed circumference used to leave any name longer than it with a
// negative distance, which indexed past the palette and printed
// `{undefined-fg}` into the frame.
export function shimmerSpan(text) {
  return Array.from(text).length + SHIMMER_PAD * 2;
}

export function shimmerMarkup(text, phase) {
  const chars = Array.from(text);
  const span = shimmerSpan(text);
  // Measured from SHIMMER_PAD cells before the first character, so the band
  // enters and leaves the word instead of appearing on top of it.
  const head = (((phase % span) + span) % span) - SHIMMER_PAD;
  return chars.map((char, index) => {
    if (char === ' ') return char;
    const distance = Math.abs(index - head);
    // Raised cosine: full brightness under the head, dark at the edge of the
    // band, no corner in between. That is the difference between a sweep and a
    // block of colour sliding past.
    const intensity = distance >= SHIMMER_HALF
      ? 0
      : 0.5 * (1 + Math.cos((Math.PI * distance) / SHIMMER_HALF));
    const shade = SHIMMER[Math.round(intensity * (SHIMMER.length - 1))];
    // Bold at the crest only, the way omp lifts its accent. `{/}` is blessed's
    // full reset, so it closes the weight and the colour together.
    return intensity >= 0.9
      ? `{bold}{${shade}-fg}${char}{/}`
      : `{${shade}-fg}${char}{/}`;
  }).join('');
}

// A wall of same-coloured lines is unreadable, and `/help` was fifty of them.
// Two columns give the eye an anchor: the name is found by scanning one narrow
// strip, and the description keeps its own column even when it wraps.
// Unicode calls these ambiguous: a terminal may draw them one cell wide or two,
// and tmux and iTerm can be configured either way. An em dash measured as one and
// drawn as two pushes the last word past the frame — twice over on a line with two
// of them, which is how the key list ended up with a stranded `to`. Budgeting for
// the wide case costs a trailing space nobody sees.
const AMBIGUOUS = /[\u2010-\u2027\u2030-\u205e\u2190-\u21ff\u2200-\u22ff\u25a0-\u27bf]/g;

export function worstCaseWidth(text) {
  const value = String(text ?? '');
  return displayWidth(value) + (value.match(AMBIGUOUS)?.length ?? 0);
}

// `truncate` above cuts by characters, which is not what a terminal counts: one
// ambiguous glyph drawn two cells wide is enough to push a row into a second
// line. This cuts by cells, budgeting for the worst case, ellipsis included.
export function truncateToWidth(value, cells) {
  const text = String(value ?? '');
  if (worstCaseWidth(text) <= cells) return text;
  const budget = cells - worstCaseWidth('…');
  if (budget <= 0) return '';
  let width = 0;
  let kept = '';
  for (const char of Array.from(text)) {
    const next = width + worstCaseWidth(char);
    if (next > budget) break;
    kept += char;
    width = next;
  }
  return `${kept}…`;
}

export function layoutTable({ rows, width, gap = 2, indent = 2 }) {
  const available = Math.max(20, width - indent);
  const longest = rows.reduce((max, [left]) => Math.max(max, worstCaseWidth(left)), 0);
  // A name wider than this would leave nothing to describe it with, so it takes
  // its own line instead of squeezing the text into a ribbon.
  const column = Math.min(longest, Math.max(8, Math.floor(available * 0.4)));
  const textWidth = Math.max(12, available - column - gap);
  const out = [];
  for (const [left, right] of rows) {
    const words = String(right ?? '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (worstCaseWidth(candidate) > textWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line || lines.length === 0) lines.push(line);
    const fits = worstCaseWidth(left) <= column;
    const head = fits
      ? left + ' '.repeat(column - worstCaseWidth(left))
      : left;
    out.push({ indent, left: head, gap: fits ? gap : 0, text: fits ? lines[0] : '', column });
    const rest = fits ? lines.slice(1) : lines;
    for (const cont of rest) {
      out.push({ indent: indent + column + gap, left: '', gap: 0, text: cont, column });
    }
  }
  return out;
}

// The list of commands over the composer. Pure, like the header and the message
// body: what it paints is worth asserting without a screen to paint on.
export function menuRuleLabel({ index, total, shown, word = 'commands' }) {
  // English like the `Message` rule below it: these words belong to the frame,
  // not to the conversation. A picker passes its own word (`peers`).
  return total > shown ? `${word} ${index + 1}/${total}` : word;
}

export function renderMenuMarkup({
  shown, hidden = 0, chosenIndex = 0, width = 80, themed = true, nameWidth = 8,
}) {
  // The list lives in a box inset one cell inside the frame's border, so it has
  // width - 4 cells, and blessed wraps a row that exactly fills a one-line
  // widget. A wrapped row steals a line from a box sized to the number of
  // commands, and the line it steals is the last one — which is the selected one
  // for as long as the list is scrolling. That is how the selection walked off
  // the bottom of the menu and could not be seen at all. So: one cell of slack,
  // and cells counted for the worst case a terminal may draw, because `❯` on the
  // chosen row and the `…` in the `+N` tail are both ambiguous-width.
  return shown.map((command, index) => {
    const chosen = index === chosenIndex;
    const last = index === shown.length - 1 && hidden > 0;
    const more = last ? `   … +${hidden}` : '';
    const alias = command.alias ? ` ${command.alias}` : '';
    const head = `${chosen ? '❯' : ' '} ${command.name.padEnd(nameWidth)}${alias.padEnd(4)} `;
    const room = Math.max(1, width - 5 - worstCaseWidth(more));
    const text = truncateToWidth(`${head}${command.help ?? ''}`, room) + more;
    const safe = escapeMarkup(text);
    if (!themed) return safe;
    // Reverse video on the selection: bold green on green was the difference the
    // eye kept missing.
    if (chosen) return `{green-bg}{black-fg}${safe}{/black-fg}{/green-bg}`;
    // Name and explanation in different hues, so the list is scanned by name.
    const cut = Math.min(head.length, safe.length);
    return `{cyan-fg}${escapeMarkup(text.slice(0, cut))}{/cyan-fg}`
      + `{green-fg}${escapeMarkup(text.slice(cut))}{/green-fg}`;
  }).join('\n');
}

export function renderHeaderMarkup({
  width,
  selfName,
  peerName,
  peerDevice = '',
  status,
  unreadSummary = '',
  updateAvailable = false,
  themed = true,
  version = '',
  // 'p2p' or 'cloud' — which network this session rides for this
  // conversation (see the doc comment on createUI). Empty string
  // (headless/legacy callers) draws nothing, same as before this existed.
  transport = '',
  // 'web' or 'cli' — what the peer is actually running, learned from their
  // hello's version string (isWebVersion, cli.js). Empty until a hello has
  // arrived, same as peerDevice before the first one does.
  peerClient = '',
}) {
  const presentation = statusPresentation(status, themed);
  const statusText = presentation.symbol
    ? `${presentation.symbol} ${presentation.label}`
    : presentation.label;
  const updateText = updateAvailable ? 'update!  ' : '';
  const unreadText = unreadSummary ? `${unreadSummary}  ` : '';
  const rightText = `${unreadText}${updateText}${statusText}`;
  // Blessed wraps a final word when content exactly fills a one-line widget.
  const available = Math.max(1, Number(width) - 1);
  const compact = isCompact(Number(width) + 4);
  const leftText = version ? `tailchat v${version}` : 'tailchat';
  const safeSelfName = safeTerminalText(selfName);
  const safePeerName = safeTerminalText(peerName);
  // Which machine of theirs is actually on the other end. It matters when a
  // person has several: the device can change mid-conversation.
  const device = safeTerminalText(peerDevice);
  const transportBadge = transport === 'cloud' ? '🌐 ' : transport === 'p2p' ? '⚡ ' : '';
  const clientSuffix = peerClient ? ` (${peerClient})` : '';
  const peerCore = device ? `${safePeerName} @ ${device}` : safePeerName;
  const peerText = `${transportBadge}${peerCore}${clientSuffix}`;
  const centerLimit = Math.max(
    1,
    available - displayWidth(leftText) - displayWidth(rightText) - 2,
  );
  const centerText = compact
    ? truncate(`${transportBadge}${safePeerName}${clientSuffix}`, centerLimit)
    : truncate(`${safeSelfName} ↔ ${peerText}`, centerLimit);
  const centerLength = displayWidth(centerText);
  const leftGap = Math.max(
    1,
    Math.floor((available - centerLength) / 2) - displayWidth(leftText),
  );
  const used = displayWidth(leftText) + leftGap + centerLength;
  const rightGap = Math.max(
    1,
    available - used - displayWidth(rightText),
  );
  const right = statusMarkup(presentation, themed);
  const leftMarkup = themed ? `{bold}${leftText}{/bold}` : leftText;
  const unreadStyled = unreadText
    ? (themed ? `{yellow-fg}{bold}${escapeMarkup(unreadText)}{/bold}{/yellow-fg}` : unreadText)
    : '';
  return `${leftMarkup}`
    + `${' '.repeat(leftGap)}${escapeMarkup(centerText)}`
    + `${' '.repeat(rightGap)}${unreadStyled}${updateText}${right}`;
}

// The right-hand panel shown once the terminal is wide enough (see
// `INFO_PANEL_WIDTH`/`INFO_PANEL_MIN_WIDTH` in createUI): a fixed strip of
// facts about the open conversation, alongside the roster rather than
// instead of it — the header already names the peer and their live status,
// this is the place for the things that do not fit a one-line header:
// transport, which client they are running, which of their machines
// answered. Pure and exported for the same reason renderHeaderMarkup is:
// nothing here needs a real screen to be worth asserting.
export function renderInfoPanelMarkup({
  width,
  peerName = '',
  peerDevice = '',
  status,
  transport = '',
  peerClient = '',
  themed = true,
}) {
  const inner = Math.max(1, Number(width) - 2);
  const dim = (text) => (themed ? `{245-fg}${text}{/245-fg}` : text);
  const heading = (text) => (themed ? `{bold}${text}{/bold}` : text);
  const presentation = statusPresentation(status, themed);
  const statusText = presentation.symbol
    ? `${presentation.symbol} ${presentation.label}`
    : presentation.label;
  const statusLine = themed
    ? `{${presentation.color}-fg}{bold}${statusText}{/bold}{/${presentation.color}-fg}`
    : statusText;
  const safeName = truncateToWidth(safeTerminalText(peerName) || '—', inner);
  const device = safeTerminalText(peerDevice);
  const clientText = peerClient === 'web' ? 'web' : peerClient === 'cli' ? 'cli' : '—';
  const transportText = transport === 'cloud' ? 'cloud' : transport === 'p2p' ? 'p2p' : '—';
  const rows = [
    heading('PEER'),
    safeName,
    statusLine,
    '',
    heading('CONNECTION'),
    `${dim('transport')} ${transportText}`,
    `${dim('client')}    ${clientText}`,
  ];
  if (device) rows.push(`${dim('device')}    ${truncateToWidth(device, Math.max(1, inner - 11))}`);
  return rows.join('\n');
}


// A fence line is syntax, never content: an info string ("```js") only ever
// opens, so a decorated line inside a block cannot close it and lose code.
const FENCE = /^\s*```(.*)$/;
// Four hashes or a bare `#` are ordinary chat characters, not a heading.
const HEADING = /^(#{1,3}) +(\S.*)$/;
const INLINE_CODE = /`([^`]+)`/;
// Only the doubled asterisk, and only away from word characters. The single form
// and `__underline__` were both tried and removed: this is a chat about shells
// and Python, where `'*.db*'` is a glob and `__init__` is a method name, and both
// were silently eaten. Losing a character from a pasted command is far worse than
// missing a way to write emphasis.
const BOLD = /(?<![\w*])\*\*(\S[^*]*?)\*\*(?![\w*])/g;
// A URL is the one thing worth lifting out of prose: blue + underline, and later
// clickable. Whitespace and the common delimiters end it.
const URL_RE = /(?:https?:\/\/|www\.|file:\/\/)[^\s<>"'`]+|(?:\/(?:Users|home|private|tmp|opt|var|mnt)|\~)[^\s<>"'`*]+\.[a-zA-Z0-9]{2,5}\b/g;
// Indentation is captured so a nested list keeps its shape, and the marker is
// captured separately so it can be coloured without being removed.
const BULLET = /^(\s*)([-*+] )(.*)$/;
const QUOTE = /^(\s*> ?)(.*)$/;

// Code and headings borrow the two hues the frame already uses, so a formatted
// message still reads as one phosphor terminal instead of a rainbow.
const CODE_COLOR = 'cyan';
const HEADING_COLOR = 'green';

// A handful of named accent palettes: who is who in the transcript (self,
// the peer, the bot) plus the frame's own border. Everything else — code,
// headings, links, status dots, markers — stays fixed, because those carry
// meaning (online is green, a queued send is yellow) rather than taste, and
// mixing that up with a chosen colour scheme would make the status header a
// worse status header. `green` reproduces the original, unthemed look.
export const THEMES = {
  green: {
    self: 'green', peer: 'cyan', bot: 'magenta', border: 'green',
  },
  // Named colours (above) and xterm-256 indices (below) both work as markup
  // tags — `${220}` still interpolates to `{220-fg}` — but a widget's own
  // `style.border.fg` is resolved by `colors.convert()`, which only special-
  // cases `typeof number` and `#hex`; a numeric *string* has no entry in its
  // name table and silently loses the border colour to blessed's default.
  // These must stay real numbers, not quoted digits.
  amber: {
    self: 220, peer: 208, bot: 196, border: 220,
  },
  ocean: {
    self: 39, peer: 51, bot: 141, border: 39,
  },
  matrix: {
    self: 46, peer: 34, bot: 82, border: 46,
  },
  nord: {
    self: 110, peer: 73, bot: 139, border: 110,
  },
  catppuccin: {
    self: 183, peer: 117, bot: 211, border: 183,
  },
  tokyo: {
    self: 111, peer: 120, bot: 176, border: 111,
  },
  gruvbox: {
    self: 142, peer: 108, bot: 208, border: 214,
  },
  solarized: {
    self: 37, peer: 33, bot: 125, border: 37,
  },
};
export const DEFAULT_THEME = 'green';
export const THEME_NAMES = Object.keys(THEMES);

const emphasise = (text, paint, linkAt = () => {}, base = 0) => text
  .replace(URL_RE, (url, offset) => {
    linkAt(url, base + displayWidth(text.slice(0, offset)));
    return paint.link(url);
  })
  .replace(BOLD, (_, inner) => paint.bold(inner));

function inlineMarkup(line, paint, linkAt = () => {}) {
  let out = '';
  let rest = line;
  // Visible columns advance by the width of what is actually drawn: code spans
  // drop their backticks, so their content width is what moves the cursor.
  let base = 0;
  for (;;) {
    const span = INLINE_CODE.exec(rest);
    // Backticks fence emphasis off: `**` inside a code span is code, not bold.
    if (!span) return out + emphasise(rest, paint, linkAt, base);
    out += emphasise(rest.slice(0, span.index), paint, linkAt, base);
    base += displayWidth(rest.slice(0, span.index));
    out += paint.code(span[1]);
    base += displayWidth(span[1]);
    rest = rest.slice(span.index + span[0].length);
  }
}

// The path of an attachment, drawn as a link the transcript can both show and
// open.
//
// Deliberately not an OSC 8 hyperlink: this transcript is a blessed box that
// owns every cell of it — content is wrapped to the box width and repainted
// from blessed's own buffer, so such an escape is measured as text and mangled
// instead of reaching the terminal, the same wall `preview.js` documents for
// inline images. What makes the gesture work instead is the pair of halves the
// terminal and this client each already have: the path is painted the way
// `renderBodyMarkup` paints a URL (underlined, same blue), which is what a
// terminal's own path detection reads out of the text on screen (Warp, iTerm2,
// Terminal.app — Cmd+click), and the line is appended inside the attachment's
// own span, so a click with the mouse captured opens it through `openPath` too.
export function fileLinkLine(file, { themed = true } = {}) {
  const label = String(file ?? '').trim();
  if (label === '') return '';
  // A file name is user data: braces in it must not become blessed tags.
  const safe = escapeMarkup(label);
  return themed ? `{underline}{39-fg}${safe}{/39-fg}{/underline}` : safe;
}

// Escaping runs first so a message containing `{bold}` cannot inject markup;
// everything added here is zero-width, which keeps the continuation indent in
// renderMessageMarkup measuring visible characters only.
export function renderBodyMarkup(text, { themed = true, onLink = () => {} } = {}) {
  const paint = themed ? {
    code: (value) => `{${CODE_COLOR}-fg}${value}{/${CODE_COLOR}-fg}`,
    link: (value) => `{underline}{39-fg}${value}{/39-fg}{/underline}`,
    bold: (value) => `{bold}${value}{/bold}`,
    heading: (value) => `{bold}{${HEADING_COLOR}-fg}${value}{/${HEADING_COLOR}-fg}{/bold}`,
    // The marker is coloured but never removed: a pasted list must still read
    // as the same characters if it is copied out again.
    underline: (value) => `{underline}${value}{/underline}`,
    label: (value) => `{gray-fg}${value}{/gray-fg}`,
    bullet: (value) => `{${HEADING_COLOR}-fg}${value}{/${HEADING_COLOR}-fg}`,
    quote: (mark, value) => `{${CODE_COLOR}-fg}${mark}{/${CODE_COLOR}-fg}{67-fg}${value}{/67-fg}`,
  } : {
    // Monochrome still drops the syntax characters: the text has to read
    // cleanly without colour, not show its markers.
    code: (value) => value,
    link: (value) => value,
    bold: (value) => value,
    heading: (value) => value,
    underline: (value) => value,
    label: (value) => value,
    bullet: (value) => value,
    quote: (mark, value) => `${mark}${value}`,
  };
  const out = [];
  let fenced = false;
  let language = null;
  // Lines are split before escaping so a code line can be tokenised as the user
  // wrote it; each token is escaped on its way out instead. The index is the body
  // line number, so a link can later be mapped back to its transcript row.
  const lines = String(text ?? '').split('\n');
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo];
    const line = escapeMarkup(raw);
    const fence = FENCE.exec(raw);
    if (fence && (!fenced || !fence[1].trim())) {
      fenced = !fenced;
      if (fenced) {
        language = normaliseLanguage(fence[1]);
        // Name the language above the block, the way a chat app labels it: it is
        // what tells the reader why the colours mean what they mean.
        // Only with colour: a bare word on its own line would read as code.
        const label = fence[1].trim();
        if (label && themed) out.push(paint.label(escapeMarkup(label)));
      } else {
        language = null;
      }
      continue;
    }
    if (fenced) {
      // Indentation is meaning in code, so the line survives verbatim; an
      // unterminated fence keeps colouring to the end rather than dropping text.
      const code = raw ? highlight(raw, language, { escape: escapeMarkup, themed }) : raw;
      out.push(code);
      continue;
    }
    // A pasted report is mostly lists and the odd quote, so those are worth
    // recognising on their own rather than only inside a fence.
    // The report callback shifts a link's column by the marker in front of it
    // (`> `, `- `) so a click on the link lands on the right cell.
    const at = (base) => (url, col) => onLink({ url, line: lineNo, col: base + col });
    const quote = QUOTE.exec(line);
    if (quote) {
      out.push(paint.quote(quote[1], inlineMarkup(quote[2], paint, at(displayWidth(quote[1])))));
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      const base = displayWidth(bullet[1]) + displayWidth(bullet[2]);
      out.push(bullet[1] + paint.bullet(bullet[2]) + inlineMarkup(bullet[3], paint, at(base)));
      continue;
    }
    const heading = HEADING.exec(line);
    out.push(heading
      ? paint.heading(inlineMarkup(heading[2], paint, at(0)))
      : inlineMarkup(line, paint, at(0)));
  }
  return out.join('\n');
}

// The colour of a marker depends on *which* ✓✓ it is, so the mapping lives in
// one function keyed by (glyph, read flag) rather than a plain glyph table. A
// ✓ the server committed and a ✓✓ the peer's device holds are both settled
// facts about this device's own work being over: quiet grey, the same dim tone
// as a clock. The green accent is kept for the one rung that is a claim about
// the peer's own reading, so delivery and read are told apart at a glance.
// ⧗ keeps the amber of something still owned here, and ⚠ the red of something
// that needs a decision (the APK draws it in its error colour the same way).
const MARKER_COLOR = {
  '⧗': 'yellow', '⚠': 'red', '✓': '245', '✓✓': '245',
};
function markerColor(marker, markerRead = false) {
  if (marker === '✓✓' && markerRead) return 'green';
  return MARKER_COLOR[marker];
}

export function findLink(spans, line, col) {
  const hit = spans.find((s) => s.line === line && col >= s.col && col < s.col + s.url.length);
  return hit ? hit.url : null;
}
// How many cells a continuation row of a multi-line message must be padded
// with to start under the body rather than under the sender label. Shared
// between renderMessageMarkup, which bakes the padding in as real spaces for
// display, and createHistoryBuffer's copyPadding, which strips exactly that
// many characters back out so a copied paste matches what was actually sent.
export function continuationPrefixWidth(message, width = null) {
  if (width !== null && Number.isFinite(width) && width < 70) return 0;
  const plainWho = message?.self ? 'you' : safeTerminalText(message?.name);
  return displayWidth(`{${plainWho}} `);
}

// A tally, not a roll call: who reacted is between the people in the room, and
// a row of logins would push the clock off the end of the line. Heaviest first
// so the loudest reaction reads first, and arrival order for ties, so agreeing
// with something never reshuffles the line under the reader's eyes.
function renderReactions(reactions) {
  if (!reactions || typeof reactions !== 'object' || Array.isArray(reactions)) return '';
  const counted = Object.entries(reactions)
    .map(([emoji, logins]) => [emoji, Array.isArray(logins) ? logins.length : 0])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  if (counted.length === 0) return '';
  return `(${counted.map(([emoji, count]) => `${escapeMarkup(emoji)} x${count}`).join(', ')})`;
}

// How much of the quoted message a reply shows: enough to recognise what is
// being answered, never enough for the quote to outweigh the answer.
const REPLY_SNIPPET_MAX = 60;
// A quoted picture or voice note has no words to show. The glyph says what it
// was without inventing a caption for it — and a symbol needs no translation,
// so the quote row stays out of the dictionaries.
const REPLY_MEDIA_GLYPH = { image: '🖼', voice: '🎙', file: '📎' };

// The quote is the snapshot taken when the reply was written, not a live
// lookup: it still reads after the original was edited, revoked for one side
// only, or trimmed off the head of this buffer.
function renderReplyQuote(replyTo, { replyLabel, themed }) {
  if (!replyTo || typeof replyTo !== 'object' || Array.isArray(replyTo)) return '';
  const from = typeof replyTo.from === 'string' ? replyTo.from : '';
  const author = escapeMarkup(replyLabel(from));
  // One row, whatever was quoted: a wrapped quote competes with the answer it
  // belongs to, so the newlines are spent as spaces.
  const quoted = typeof replyTo.text === 'string' ? replyTo.text.replace(/\s+/gu, ' ').trim() : '';
  const snippet = quoted !== '' ? quoted : (REPLY_MEDIA_GLYPH[replyTo.media] ?? '');
  const row = `↩ ${author}: ${escapeMarkup(truncate(snippet, REPLY_SNIPPET_MAX))}`;
  return themed ? `{245-fg}${row}{/245-fg}` : row;
}
export function renderMessageMarkup({
  ts,
  name,
  text,
  self,
  // A third voice: the AI answering into this transcript, human on neither
  // end. Only meaningful when self is false — a bot never speaks as "you".
  bot = false,
  marker = null,
  // True only for a ✓✓ the peer's client reported read: the flag that separates
  // the delivered rung from the read one, since both share the glyph.
  markerRead = false,
  // The emoji tally this message carries: `{ '<emoji>': ['login', …] }`.
  reactions = null,
  // The snapshot of the message this one answers: `{ id, from, text, media? }`.
  replyTo = null,
  // Turns a quoted message's login into the words this screen uses for that
  // person. Injected because a login is not a display name: /nick, the roster
  // and the peer's own hello all have a say, and none of them live in here.
  replyLabel = (from) => from,
  themed = true,
  nameBadge = true,
  palette = THEMES[DEFAULT_THEME],
  onLink = () => {},
  // Reports the continuation-row padding this call actually used, so a
  // caller that only ever sees the returned string (createHistoryBuffer's
  // copy-padding bookkeeping) never has to guess it back out of a formula —
  // guessing is exactly wrong the moment `render` is some other function
  // (tests inject their own) that pads differently or not at all.
  onPrefix = () => {},
  edited = false,
  width = null,
}) {
  const date = new Date(ts);
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const who = self ? 'you' : escapeMarkup(name);
  const prefix = continuationPrefixWidth({ self, name }, width);
  // Indented to the body's own column, so a reply reads as one block rather
  // than as two unrelated lines. On narrow screens (<70) indentation is skipped
  // to prevent jagged line wrapping.
  const quote = renderReplyQuote(replyTo, { replyLabel, themed });
  const lead = quote ? (prefix > 0 ? `${' '.repeat(prefix)}${quote}\n` : `${quote}\n`) : '';
  onPrefix(prefix, quote ? 1 : 0);
  const body = renderBodyMarkup(text, {
    themed,
    // A quote row shifts every body row down by one, and a link is looked up
    // by (row, column): an unshifted report opens the wrong thing, or nothing.
    onLink: ({ url, line, col }) => onLink({ url, line: quote ? line + 1 : line, col: prefix + col }),
  }).replace(/\n/g, prefix > 0 ? `\n${' '.repeat(prefix)}` : '\n');
  // Between the body and the clock, dimmed like the clock: the tally is about
  // the message, not part of what was said.
  const tally = renderReactions(reactions);
  const editedStr = edited ? ' ✎' : '';
  const tail = `${editedStr} [${clock}]${marker ? ` ${marker}` : ''}`;
  if (!themed) return `${lead}{${who}} ${body}${tally ? ` ${tally}` : ''}${tail}`;
  // colour fills the label while black keeps it readable on each palette.
  const whoColor = self ? palette.self : (bot ? palette.bot : palette.peer);
  const color = markerColor(marker, markerRead);
  const markerMarkup = marker ? ` ${color ? `{${color}-fg}${marker}{/${color}-fg}` : marker}` : '';
  const whoMarkup = nameBadge
    ? `{${whoColor}-bg}{black-fg}{bold}{open}${who}{close}{/bold}{/black-fg}{/${whoColor}-bg}`
    : `{bold}{${whoColor}-fg}{open}${who}{close}{/${whoColor}-fg}{/bold}`;
  const tallyMarkup = tally ? ` {245-fg}${tally}{/245-fg}` : '';
  const editedMarkup = edited ? ' {245-fg}✎{/245-fg}' : '';
  const clockMarkup = ` {245-fg}[${clock}]{/245-fg}${markerMarkup}`;
  return `${lead}${whoMarkup} ${body}${tallyMarkup}${editedMarkup}${clockMarkup}`;
}
// The bar's own layout, in one place: which contact pills are visible, where
// each of them starts and ends in cells, and the markup that paints it. The
// click handler resolves a pointer against these same spans, so a click cannot
// land on a contact other than the one drawn under it.
//
// `offset` is the first pill to show when the bar is one row tall and the first
// wrapped line when it is taller, or null to follow the active contact — where
// the wheel leaves it, and where every roster update puts it back.
export function layoutRosterBar({
  items,
  activeLogin,
  width = 80,
  themed = true,
  palette = THEMES[DEFAULT_THEME],
  maxRows = 3,
  offset = null,
} = {}) {
  const rows = [];
  if (!Array.isArray(items) || items.length === 0) return { rows, top: 0, maxTop: 0 };
  const cleanActive = String(activeLogin ?? '').replace(/^@/, '').toLowerCase();

  const activeIdx = items.findIndex((item) => {
    const cleanLogin = String(item.login ?? '').replace(/^@/, '').toLowerCase();
    return cleanLogin === cleanActive || item.login === String(activeLogin ?? '');
  });

  const sep = ' ';
  const sepWidth = 1;

  const pills = items.map((item, idx) => {
    const login = String(item.login ?? '');
    const cleanLogin = login.replace(/^@/, '').toLowerCase();
    const isActive = idx === activeIdx || (cleanActive !== '' && cleanLogin === cleanActive);
    const name = item.name && item.name !== login ? item.name : login;
    const isService = Boolean(item.official) || item.isSystem || item.type === 'system';
    const isSaved = item.type === 'saved' || item.isSaved || (name === 'Saved' && login.startsWith('@'));
    const isSpecial = isService || isSaved;
    const isOnline = item.state === 'online' || item.online === true;
    // cursor is sitting on described a count the reader had already seen and
    // could do nothing about.
    const unread = isActive ? 0 : (Number(item.unread) || 0);
    const unreadStr = unread > 0 ? ` 🔔${unread > 1 ? unread : ''}` : '';
    // The cells this pill takes on screen: ` name ` for the open contact when
    // themed, `[name]*` for it in the plain frame, and `[name]` with the bell
    // for everyone else. Measured from the text that is really painted, because
    // a pill measured one cell short pushes every pill after it out of step —
    // and a click on the bar is resolved against these offsets.
    const painted = isActive
      ? (themed ? ` ${name} ` : `[${name}]*`)
      : `[${name}${unreadStr}]`;
    const w = displayWidth(painted);

    let markup;
    if (isActive) {
      const bg = isSpecial ? (palette.bot || 'blue') : (palette.self || 'green');
      markup = themed
        ? `{bold}{black-fg}{${bg}-bg} ${escapeMarkup(name)} {/${bg}-bg}{/black-fg}{/bold}`
        : `[${name}]*`;
    } else if (unread > 0) {
      markup = themed
        ? `{bold}{yellow-fg}[${escapeMarkup(name)}${unreadStr}]{/yellow-fg}{/bold}`
        : `[${name}${unreadStr}]`;
    } else if (isSpecial) {
      markup = themed
        ? `{bold}{${palette.bot}-fg}[${escapeMarkup(name)}]{/${palette.bot}-fg}{/bold}`
        : `[${name}]`;
    } else if (isOnline) {
      markup = themed
        ? `{bold}{green-fg}[${escapeMarkup(name)}]{/green-fg}{/bold}`
        : `[${name}]`;
    } else {
      const fg = '240';
      markup = themed
        ? `{${fg}-fg}[${escapeMarkup(name)}]{/${fg}-fg}`
        : `[${name}]`;
    }
    // The identity travels with the pill: a click has to name the contact it
    // landed on, and `active` is what makes a click on the open one a no-op
    // instead of a second switch to where the reader already is.
    return { markup, width: w, index: idx, login, active: isActive };
  });

  // One painted row: the markup, and the cells every pill in it occupies. The
  // marker is part of the row's width, so where a pill starts depends on
  // whether there is one — which is why this counts the columns and not the
  // caller.
  const rowOf = (slice, moreBefore, moreAfter) => {
    const prefix = moreBefore ? (themed ? '{245-fg}‹{/245-fg} ' : '< ') : ' ';
    const suffix = moreAfter ? (themed ? ' {245-fg}›{/245-fg}' : ' >') : '';
    const spans = [];
    let x = moreBefore ? 2 : 1;
    for (const pill of slice) {
      spans.push({
        index: pill.index,
        login: pill.login,
        active: pill.active,
        start: x,
        end: x + pill.width,
      });
      x += pill.width + sepWidth;
    }
    return {
      text: `${prefix}${slice.map((p) => p.markup).join(sep)}${suffix}`,
      spans,
    };
  };

  const available = Math.max(10, Number(width) - 2);
  const rowsLimit = Math.max(1, Math.min(3, Number(maxRows) || 3));

  if (rowsLimit === 1) {
    const totalWidth = pills.reduce((sum, p) => sum + p.width, 0) + Math.max(0, pills.length - 1) * sepWidth;
    if (totalWidth + 1 <= available) {
      return { rows: [rowOf(pills, false, false)], top: 0, maxTop: 0 };
    }

    let start;
    let end;
    let currentWidth;

    if (offset !== null) {
      // Scrolled: the window starts where the wheel left it and takes as many
      // pills after it as fit. Re-anchoring on the active contact here would
      // throw the scroll away on the very next repaint.
      start = clamp(Math.round(Number(offset) || 0), 0, pills.length - 1);
      end = start + 1;
      currentWidth = pills[start].width;
      const room = available - (start > 0 ? 2 : 1) - 2;
      while (end < pills.length && currentWidth + sepWidth + pills[end].width <= room) {
        currentWidth += sepWidth + pills[end].width;
        end += 1;
      }
    } else {
      // Window around the cursor, not around the first contact: a bar whose only
      // row shows somebody else shows nothing at all when the selection moves,
      // which on a narrow screen is how Ctrl+→ switched conversations with no
      // visible cause. An unread contact is worth reaching for, but never at the
      // price of the pill the reader is standing on — see the multi-row window
      // below, which follows the same rule.
      start = activeIdx >= 0 ? activeIdx : 0;
      end = start + 1;
      currentWidth = pills[start] ? pills[start].width : 0;

      while (start > 0 || end < pills.length) {
        let expanded = false;
        const unreadBeforeStart = items.slice(0, start).some((item) => (Number(item?.unread) || 0) > 0);
        if (start > 0 && unreadBeforeStart) {
          const prevW = pills[start - 1].width + sepWidth;
          if (currentWidth + prevW <= available - 2) {
            currentWidth += prevW;
            start -= 1;
            expanded = true;
          }
        }
        if (end < pills.length) {
          const nextW = pills[end].width + sepWidth;
          if (currentWidth + nextW <= available - 2) {
            currentWidth += nextW;
            end += 1;
            expanded = true;
          }
        }
        if (start > 0) {
          const prevW = pills[start - 1].width + sepWidth;
          if (currentWidth + prevW <= available - 2) {
            currentWidth += prevW;
            start -= 1;
            expanded = true;
          }
        }
        if (!expanded) break;
      }
    }

    return {
      rows: [rowOf(pills.slice(start, end), start > 0, end < pills.length)],
      top: start,
      maxTop: Math.max(0, pills.length - 1),
    };
  }

  // Multi-row layout (rowsLimit 2 or 3)
  const lines = [];
  let currentLine = [];
  let currentW = 0;

  for (let i = 0; i < pills.length; i++) {
    const p = pills[i];
    const needed = currentLine.length === 0 ? p.width + 1 : currentW + sepWidth + p.width;
    if (needed <= available) {
      currentLine.push(p);
      currentW = needed;
    } else {
      if (currentLine.length > 0) lines.push(currentLine);
      currentLine = [p];
      currentW = p.width + 1;
    }
  }
  if (currentLine.length > 0) lines.push(currentLine);

  if (lines.length <= rowsLimit) {
    return { rows: lines.map((line) => rowOf(line, false, false)), top: 0, maxTop: 0 };
  }

  let activeLineIdx = 0;
  let count = 0;
  for (let l = 0; l < lines.length; l++) {
    if (activeIdx >= count && activeIdx < count + lines[l].length) {
      activeLineIdx = l;
      break;
    }
    count += lines[l].length;
  }

  // The window always contains the cursor. It used to be pinned to the first
  // line whenever any contact had unread, which on a narrow screen — where the
  // pills wrap into more lines than [maxRows] — walked the highlighted contact
  // off the bottom: switching with Ctrl+→ changed the conversation while the
  // bar sat still, so the switch looked like it had done nothing at all. An
  // unread contact worth showing is not worth hiding the selection for; it
  // only decides the window when there is no selection here to follow (the
  // open conversation is not one of these items, and then the first line is
  // the best this bar can do anyway).
  //
  // Scrolling the bar with the wheel overrides that: the window then stands
  // where the wheel left it, and the marker on the first and last visible rows
  // says which way the rest of the roster is.
  const maxTop = Math.max(0, lines.length - rowsLimit);
  const startLine = offset === null
    ? (activeIdx >= 0 ? Math.max(0, Math.min(activeLineIdx, maxTop)) : 0)
    : clamp(Math.round(Number(offset) || 0), 0, maxTop);
  const visible = lines.slice(startLine, startLine + rowsLimit);

  visible.forEach((line, idx) => {
    const lineIdx = startLine + idx;
    rows.push(rowOf(
      line,
      lineIdx !== 0 && idx === 0,
      lineIdx !== lines.length - 1 && idx === visible.length - 1,
    ));
  });
  return { rows, top: startLine, maxTop };
}

// The bar as markup, which is all the screen needs. `layoutRosterBar` keeps the
// cell offsets, and those only the click handler reads.
export function renderRosterBarMarkup(options) {
  return layoutRosterBar(options).rows.map((row) => row.text).join('\n');
}


export function createUI({
  selfName,
  peerLabel,
  // This account's login(s), as they appear in the `from` of reply snapshots.
  // Cloud and tailnet identities can differ when a conversation switches
  // transport, so callers may supply both; display names cannot stand in for
  // either because /name may change them independently.
  selfLogin = null,
  themed = true,
  nameBadge = true,
  // A named accent palette from THEMES; an unknown name falls back to the
  // default rather than crashing a session over a mangled config file.
  theme = DEFAULT_THEME,
  // Released by default: the terminal's own selection works right away, which
  // is what a reader wants most of the time. /mouse (or Ctrl+T) captures it
  // back for in-app selection, clicks on previews and wheel scrolling.
  mouse = false,
  // The marker a collapsed paste renders as; cli.js passes the translated
  // formatter so ui stays independent of the dictionaries.
  pasteLabel = (count) => `pasted ${count} lines`,
  // Same reason as pasteLabel: the field's own name is UI chrome, and it was
  // the one English word left standing in a translated frame.
  composerLabel = 'Message',
  // Proven by asking the terminal (DECRQM), not by waiting for a focus change
  // that may never come because the user never leaves the window.
  focusSupported = false,
  termux = false,
  input: inputStream = process.stdin,
  output: outputStream = process.stdout,
  // Which network the session actually rides on for this conversation — 'p2p'
  // (Tailscale/LAN direct) or 'cloud' (Cloud Hub relay). Purely a header
  // label; it never decides routing, only announces what cli.js already
  // decided, so a person switching /p2p ↔ /cloud for the same friend (see
  // /link) can tell at a glance which one they are looking at right now.
  transport = '',
  version = '',
  rosterRows = 3,
}) {
  let activeRosterRows = clamp(Number(rosterRows) || 3, 1, 3);

  const paste = createPasteInput(inputStream);
  const screen = blessed.screen({
    smartCSR: !termux,
    title: 'tailchat',
    fullUnicode: true,
    sendFocus: true,
    input: paste.input,
    output: outputStream,
  });
  // `/saver` locks ordinary keys so its waking key cannot reach the composer;
  // Ctrl+C remains blessed's documented escape hatch from a locked screen.
  screen.ignoreLocked.push('C-c', 'M-c');

  let peerName = peerLabel;
  let transportLabel = transport;
  let peerClientLabel = ''; // 'web' or 'cli', learned from the peer's hello
  let peerDevice = ''; // which machine of theirs answered, once the daemon says
  let status = 'connecting…';
  let unreadSummary = '';
  let focused = !termux;
  let focusTracked = !termux && Boolean(focusSupported); // proven capability, or a later real event
  let quitCb = () => {};
  let peerPickerCb = () => {};
  let shimmerPhase = 0;
  let shimmerTimer = null;
  let inputCb = () => {};
  let focusCb = () => {};
  let pasteImageCb = () => {};
  let mouseToggleCb = () => {};
  let pasteTextCb = () => false; // returns true when the caller consumed the paste
  let peerPresence = null; // null until the peer reports it; old clients never do
  let updateAvailable = false; // a newer peer version was observed this session
  let typingCb = () => {};
  const PEER_TYPING_VOICE = Symbol('peer');
  // Human and named AI typing frames can overlap. Keep each voice until its own
  // stop frame instead of letting the last arrival overwrite the earlier one.
  const peerTypingVoices = new Set();
  let selfTyping = false;
  // The name of the file going out, while it is going out. Sending temporarily
  // owns the composer rule but does not erase the voices still typing.
  let sending = null;
  let aiTyping = null;
  let destroyed = false;
  let paletteName = THEMES[theme] ? theme : DEFAULT_THEME;
  let palette = THEMES[paletteName];

  const frame = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    border: 'line',
    style: themed
      ? { border: { fg: palette.border } }
      : { border: { fg: 'white' } },
  });

  const header = blessed.box({
    parent: frame,
    top: 0,
    left: 1,
    right: 1,
    height: 1,
    tags: true,
    // A cell-width residual (an emoji + arrow next to each other can still
    // land a cell or two past the computed budget) used to word-wrap the
    // last word — the status text, e.g. IDLE — onto a second line a
    // height:1 box never shows, so it silently vanished instead of just
    // being tight. Clipping the overflow keeps it visible, if crowded,
    // rather than dropping it.
    wrap: false,
  });

  const headerRule = blessed.box({
    parent: frame,
    top: 1,
    left: 0,
    right: 0,
    height: 1,
    tags: false,
    style: themed ? { fg: palette.border } : { fg: 'default' },
  });

  // Blessed enables mouse reporting the moment a `mouse: true` element is
  // constructed below, so this must start true to reflect the real terminal
  // state — otherwise the startup setMouseCapture(false) would early-return and
  // never actually release the mouse back to the terminal.
  let mouseCaptured = true; // read by the selection handlers declared below

  // The logo lives in a band of its own between the rule and the transcript, so
  // it cannot scroll out of view and /clear cannot take it. Zero height until
  // someone sets it: a terminal too narrow for the wordmark, or a person who
  // would rather have the three rows back, sees the transcript start where it
  // always did.
  const logo = blessed.box({
    parent: frame,
    top: 2,
    left: 1,
    right: 1,
    height: 0,
    hidden: true,
    tags: false,
    style: themed ? { fg: 'green' } : {},
  });
  // A visible seam between the top block (header plus whatever the band is
  // showing) and the scrolling conversation below it — the same rule style
  // as headerRule, repositioned wherever the band's height puts it.
  const logoRule = blessed.box({
    parent: frame,
    top: 2,
    left: 0,
    right: 0,
    height: 1,
    tags: false,
    style: themed ? { fg: palette.border } : { fg: 'default' },
  });
  // One timer for the logo band, so a replay cannot race the sweep it interrupts.
  let logoTimer = null;
  const stopLogo = () => {
    if (!logoTimer) return;
    clearTimeout(logoTimer);
    logoTimer = null;
  };

  // A sibling of `frame`, rather than one of its children: this overlay covers
  // the entire conversation and blessed centres the scene on every resize.
  const saverScreen = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    hidden: true,
    tags: false,
    align: 'center',
    valign: 'middle',
    style: themed ? { fg: SAVER_GLOW.at(-1) } : {},
  });
  const lockScreen = blessed.box({
    screen,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    hidden: true,
    tags: true,
    align: 'center',
    valign: 'middle',
    style: themed ? { bg: 'black', fg: palette.border } : { bg: 'black', fg: 'white' },
  });
  let lockState = null;

  // Bullets for what was typed, never the text. A recovery key is ~65 characters,
  // which would push the card past a narrow window, so a long entry shows its
  // first bullets and its length instead.
  const SECRET_BULLETS_MAX = 32;
  function bulletsFor(entered) {
    const length = [...entered].length;
    if (length <= SECRET_BULLETS_MAX) return '•'.repeat(length);
    return `${'•'.repeat(SECRET_BULLETS_MAX - 8)}… ${length}`;
  }

  function renderLockContent() {
    if (!lockState || lockScreen.hidden) return;
    const { entered, error, t: lt, hasPass } = lockState;
    const secret = lockState.kind === 'secret';
    const bullets = bulletsFor(entered);
    const titleText = secret ? lockState.title : (lt ? lt('lock.title') : '🔒 TAILCHAT LOCKED');
    const subText = secret ? lockState.subtitle : 'SCREEN IS LOCKED';
    const promptText = secret
      ? lockState.prompt
      : error
        ? (lt ? lt('lock.error') : 'Incorrect password. Try again:')
        : (hasPass ? (lt ? lt('lock.prompt') : 'Enter password to unlock:') : (lt ? lt('lock.promptNoPass') : 'Press Enter to unlock:'));
    const inputDisplay = hasPass ? `[ ${bullets || ' '} ]` : `[ ENTER ]`;
    const hintText = secret ? lockState.hint : (lt ? lt('lock.hint') : '[Enter] Unlock  ·  [Esc] Clear');

    const maxTextW = Math.max(
      displayWidth(titleText),
      displayWidth(subText),
      displayWidth(promptText),
      displayWidth(inputDisplay),
      displayWidth(hintText),
      36,
    );
    const innerW = Math.max(46, maxTextW + 4);
    const borderCol = themed && palette?.border ? `{${palette.border}-fg}` : '';
    const borderEnd = themed && palette?.border ? `{/${palette.border}-fg}` : '';

    const centerPad = (str, visLen) => {
      const pad = Math.max(0, innerW - visLen);
      const l = Math.floor(pad / 2);
      const r = pad - l;
      return ' '.repeat(l) + str + ' '.repeat(r);
    };

    const row = (str, visLen) => `${borderCol}│${borderEnd}${centerPad(str, visLen)}${borderCol}│${borderEnd}`;
    const divider = `${borderCol}├${'─'.repeat(innerW)}┤${borderEnd}`;
    const top = `${borderCol}┌${'─'.repeat(innerW)}┐${borderEnd}`;
    const bottom = `${borderCol}└${'─'.repeat(innerW)}┘${borderEnd}`;
    const blank = `${borderCol}│${borderEnd}${' '.repeat(innerW)}${borderCol}│${borderEnd}`;

    const titleRow = row(`{bold}${titleText}{/bold}`, displayWidth(titleText));
    const subRow = row(`{245-fg}${subText}{/245-fg}`, displayWidth(subText));
    const promptStyled = error ? `{red-fg}${promptText}{/red-fg}` : `{bold}${promptText}{/bold}`;
    const promptRow = row(promptStyled, displayWidth(promptText));
    const inputStyled = error
      ? `{red-fg}${inputDisplay}{/red-fg}`
      : (themed && palette?.self ? `{bold}{${palette.self}-fg}${inputDisplay}{/${palette.self}-fg}{/bold}` : `{bold}${inputDisplay}{/bold}`);
    const inputRow = row(inputStyled, displayWidth(inputDisplay));
    const hintRow = row(`{245-fg}${hintText}{/245-fg}`, displayWidth(hintText));

    const lines = [
      '',
      top,
      titleRow,
      subRow,
      divider,
      blank,
      promptRow,
      blank,
      inputRow,
      blank,
      divider,
      hintRow,
      bottom,
      '',
    ];

    lockScreen.setContent(lines.join('\n'));
    render();
  }

  // A secret prompt ends one of two ways, and either way the typed text leaves
  // the overlay's state before anything else runs: it is handed to whoever
  // asked, never kept, never drawn.
  function finishSecretPrompt(value) {
    const settle = lockState?.settle;
    closeLockScreen();
    settle?.(value);
  }

  // An overlay opened by a key — `/lock` or `/keys reset` sent with Enter —
  // would otherwise hear that same Enter: blessed's screen hands the keypress
  // to the composer (which runs the command that opens the overlay) and only
  // then to the program-level listener below, which finds the overlay up and
  // took the Enter as its answer: `/lock` without a password unlocked at once,
  // `/keys reset` "cancelled" before its card was seen. So every keypress is
  // numbered before anyone sees it (`keypressSeq`, the first listener on the
  // program) and an overlay ignores exactly the one it was opened during. Not
  // "everything until the next tick": blessed parses one chunk of input into
  // several keypresses in a single synchronous loop, and the keys after the
  // opener in that chunk are the person's next keys, not echoes of it.
  // One physical Enter is two keypresses in blessed (program.js re-emits a
  // `\r` "return" as "enter" first, then delivers the "return"): the twin
  // shares its number, or the overlay opened on "enter" would take "return".
  let keypressSeq = 0;
  screen.program.prependListener('keypress', (ch, key) => {
    if (key?.name === 'return' && key.sequence === '\r') return;
    keypressSeq += 1;
  });

  function handleLockKeypress(ch, key) {
    if (lockScreen.hidden || !lockState || lockState.openedBy === keypressSeq) return;
    const keyName = key ? (key.name || '') : '';
    if (lockState.kind === 'secret') {
      if (keyName === 'enter' || keyName === 'return' || ch === '\r' || ch === '\n') {
        finishSecretPrompt(lockState.entered);
        return;
      }
      if (keyName === 'escape') {
        finishSecretPrompt(null);
        return;
      }
      // Ctrl+U, or the macOS spelling the hint shows (`createTranslator` turns
      // "Ctrl+" into "⌘") — the same pair the composer accepts for its keys.
      if ((key?.ctrl || (MAC && key?.meta)) && keyName === 'u') {
        lockState.entered = '';
        renderLockContent();
        return;
      }
    }
    if (keyName === 'enter' || keyName === 'return' || ch === '\r' || ch === '\n') {
      const ok = lockState.verifyPassword ? lockState.verifyPassword(lockState.entered) : true;
      if (ok) {
        const onUnlock = lockState.onUnlock;
        closeLockScreen();
        onUnlock?.();
      } else {
        lockState.error = true;
        lockState.entered = '';
        if (screen.bell) screen.bell();
        renderLockContent();
      }
      return;
    }
    if (keyName === 'backspace' || ch === '\b' || ch === '\x7f' || ch === '\x08') {
      lockState.entered = lockState.entered.slice(0, -1);
      lockState.error = false;
      renderLockContent();
      return;
    }
    if (keyName === 'escape' || ch === '\x1b') {
      lockState.entered = '';
      lockState.error = false;
      renderLockContent();
      return;
    }
    if (ch && typeof ch === 'string' && ch.length === 1 && !key?.ctrl && !key?.meta && ch >= ' ') {
      lockState.entered += ch;
      lockState.error = false;
      renderLockContent();
    }
  }

  function closeLockScreen() {
    if (lockScreen.hidden) return;
    lockScreen.hide();
    lockState = null;
    composer.focus();
    render();
    setImmediate(() => {
      if (!destroyed && lockScreen.hidden && saverScreen.hidden) {
        screen.lockKeys = false;
      }
    });
  }
  let saverTimer = null;
  // The geometry of the frames in flight. A window can be resized while the
  // saver is up, and a frame wider than the window would be wrapped by blessed
  // into twice as many rows — the picture shredded. Whoever chose the frames
  // asks `saverFits()` after a resize and re-picks.
  let saverGeometry = null;
  // Whether the mouse may end this saver, and what mouse capture was before it
  // borrowed it. A saver somebody asked for with `/saver` is something to look
  // at: the pointer crossing the window must not kill it, and outside the VTE
  // family blessed reports mere movement as a stream of `mousedown` (see the
  // selection handler below), so "a click but not movement" cannot be told
  // apart anyway. A saver that came up on its own means nobody is here, and a
  // moved mouse is proof that somebody is — so there it does end it.
  let saverWakeOnMouse = false;
  let saverMouseWas = null;
  let saverWakeCb = () => {};
  const stopSaverTimer = () => {
    if (!saverTimer) return;
    clearTimeout(saverTimer);
    saverTimer = null;
  };
  // `inputOnFocus` immediately returns focus to the textarea after a blur, so
  // focus cannot safely swallow the waking key. Lock blessed's normal routing
  // instead; raw program events still arrive and wake the saver. This listener
  // runs before blessed's own key router, so release the lock in the next turn:
  // otherwise that router sees an unlocked screen and types the waking key.
  const closeSaver = (wake) => {
    if (saverScreen.hidden) return;
    stopSaverTimer();
    saverScreen.hide();
    saverGeometry = null;
    saverWakeOnMouse = false;
    if (saverMouseWas !== null) {
      const wanted = saverMouseWas;
      saverMouseWas = null;
      if (wanted !== mouseCaptured) setMouseCapture(wanted);
    }
    if (wake) {
      activityCb();
      saverWakeCb();
    }
    render();
    setImmediate(() => {
      if (!destroyed && lockScreen.hidden) screen.lockKeys = false;
    });
  };
  // A full-screen raw terminal drawing (the kitty-graphics image viewer). While
  // one is up, blessed is locked out of the screen: `screen.lockKeys` swallows
  // every key before it reaches the composer or a screen.key binding, and any
  // input, mouse gesture or resize runs the exit callback instead of acting on
  // the hidden UI. The callback (the caller's) erases the raw drawing and ends
  let rawViewExit = null;
  const closeRawView = () => {
    if (!rawViewExit) return false;
    const exit = rawViewExit;
    rawViewExit = null;
    exit?.();
    // The key that dismissed the view must not fall through into the composer:
    // blessed is still dispatching this very keypress, so the unlock waits a
    // tick (the same defer the saver uses) and only when nothing else claimed
    // the screen in the meantime.
    setImmediate(() => {
      if (!destroyed && rawViewExit === null && lockScreen.hidden && saverScreen.hidden) {
        screen.lockKeys = false;
      }
    });
    return true;
  };
  screen.program.on('keypress', (ch, key) => {
    if (closeRawView()) return;
    activityCb();
    if (!lockScreen.hidden) {
      handleLockKeypress(ch, key);
      return;
    }
    closeSaver(true);
  });
  screen.program.on('mouse', () => {
    if (closeRawView()) return;
    activityCb();
    if (saverScreen.hidden || !saverWakeOnMouse) return;
    closeSaver(true);
  });

  const history = blessed.box({
    parent: frame,
    top: 3,
    left: 1,
    right: 1,
    bottom: 4,
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    keys: true,
    // A space either way, painted rather than drawn: the terminal copies whole
    // rows, and a glyph here would ride along into every copied line.
    scrollbar: themed
      ? { ch: ' ', style: { bg: 'green' } }
      : { ch: ' ', style: { inverse: true } },
  });
  // Blessed recomputes the starting attribute of every line in the transcript on
  // every frame — "because the default fg/bg may change" — and the guard meant to
  // skip that work reads `lines[0].attr`, a property a string can never carry, so
  // it never fires. The walk scans each escape code in the whole history, which
  // is nothing on plain text and murder with pictures in it: one wheel notch paid
  // for parsing every colour of every preview ever posted. The answer only depends
  // on the wrapped lines and on the element's own style, and blessed builds a new
  // `_clines` whenever either the content or the width changes — so it is cached
  // right there, and recomputed the moment the default attribute moves.
  const parseAttrUncached = history._parseAttr.bind(history);
  history._parseAttr = function cachedParseAttr(lines) {
    const dattr = this.sattr(this.style);
    if (lines.attrCache && lines.attrCacheFor === dattr) return lines.attrCache;
    const attrs = parseAttrUncached(lines);
    lines.attrCacheFor = dattr;
    lines.attrCache = attrs;
    return attrs;
  };
  let badgeEnabled = Boolean(nameBadge);
  const selfReplyLogins = new Set(
    (Array.isArray(selfLogin) ? selfLogin : [selfLogin])
      .filter((login) => typeof login === 'string' && login !== '')
      .map((login) => login.toLowerCase()),
  );
  // Who a quoted message was from, in the words this screen uses for people.
  // Resolved at render time rather than baked in when the message arrived, so
  // a /nick or a peer switch relabels the quotes already on screen — and this
  // is a two-person conversation, so anyone who is not us is the peer.
  const replyAuthorLabel = (from) => (
    typeof from === 'string' && selfReplyLogins.has(from.toLowerCase())
      ? 'you'
      : peerName
  );
  const historyBuffer = createHistoryBuffer(
    2000,
    (message, options) => renderMessageMarkup({
      ...message,
      themed,
      palette,
      nameBadge: badgeEnabled,
      replyLabel: replyAuthorLabel,
      width: history.width,
      ...options,
    }),
  );
  let followTail = true;
  let scrollFrame = null; // set while a paint is already scheduled for this burst
  let scrollPending = false;

  function atTail() {
    const perc = history.getScrollPerc();
    return perc < 0 || perc >= 100;
  }

  // A trackpad reports a swipe as a burst of notches, and a frame with previews
  // on it costs milliseconds to paint: blessed rescans every escape code in
  // every visible cell, and a picture is thousands of them. So the movement
  // itself is immediate — the position is what the next event reads — while the
  // paint runs at most once per frame, with one more at the end of the burst.
  // Both the wheel and a scrollbar drag arrive as bursts, and both go through
  // here for the same reason.
  function schedulePaint() {
    if (scrollFrame) {
      scrollPending = true;
      return;
    }
    screen.render();
    scrollFrame = setTimeout(() => {
      scrollFrame = null;
      if (!scrollPending || destroyed) return;
      scrollPending = false;
      screen.render();
    }, SCROLL_FRAME_MS);
    scrollFrame.unref?.();
  }

  function scrollHistory(lines) {
    history.scroll(lines);
    followTail = atTail();
    schedulePaint();
  }

  function tailIfFollowing() {
    if (!followTail) return;
    history.setScrollPerc(100);
  }

  // Typing while scrolled up: what is being written belongs at the end of the
  // conversation, so the view goes back there. Reading history is a deliberate
  // act and keeps the position; putting a character in the draft says the reader
  // is done reading — and a reply composed against a screen that does not show
  // the last message is how people answer something twice.
  function snapToTail() {
    if (followTail) return;
    followTail = true;
    history.setScrollPerc(100);
  }

  // Blessed scrolls half a page per wheel notch, which overshoots badly on a
  // tall terminal and with trackpads that emit bursts of events.
  history.removeAllListeners('wheelup');
  history.removeAllListeners('wheeldown');
  history.on('wheelup', () => { activityCb(); scrollHistory(-WHEEL_STEP); });
  history.on('wheeldown', () => { activityCb(); scrollHistory(WHEEL_STEP); });

  // The terminal's own selection can only see the current page, because the app
  // owns the alternate screen. So the app selects for itself, in whole transcript
  // lines, and scrolls while the pointer is held past an edge.
  let anchorLine = null;
  let headLine = null;
  let copyCb = () => {};
  let openImageCb = () => {};
  let openLinkCb = () => {};
  let activityCb = () => {};

  function selection() {
    return selectionRange(anchorLine, headLine);
  }

  // Screen row → the logical transcript line under it. `rtof` maps a wrapped row
  // back to the line it came from, which is what makes a selection survive both
  // wrapping and scrolling.
  function lineAtRow(y) {
    const coords = history._getCoords();
    if (!coords) return null;
    const row = Math.min(
      Math.max(0, y - coords.yi),
      Math.max(0, coords.yl - coords.yi - 1),
    );
    const fake = (history.childBase || 0) + row;
    const map = history._clines?.rtof;
    if (!Array.isArray(map) || map.length === 0) return null;
    return map[Math.min(fake, map.length - 1)] ?? null;
  }

  let dragging = false;
  let edgeTimer = null;

  function stopEdgeScroll() {
    if (edgeTimer) clearInterval(edgeTimer);
    edgeTimer = null;
  }

  function trackHead(y) {
    const line = lineAtRow(y);
    if (line !== null) headLine = line;
    render();
  }

  function extendSelection(y) {
    const coords = history._getCoords();
    if (!coords) return;
    stopEdgeScroll();
    const step = edgeScroll(y, coords.yi, coords.yl - 1);
    if (step !== 0) {
      edgeTimer = setInterval(() => {
        history.scroll(step);
        trackHead(y);
      }, EDGE_SCROLL_MS);
    }
    trackHead(y);
  }

  function insideHistory(x, y) {
    const coords = history._getCoords();
    return Boolean(coords)
      && x >= coords.xi && x < coords.xl
      && y >= coords.yi && y < coords.yl;
  }

  // The bar itself is one column, which is a target a pointer misses: a click
  // one cell to its left landed in the transcript and started selecting text
  // instead. Two columns is still nothing a reader would aim at for anything
  // else — the rightmost cells of the transcript hold the ends of wrapped
  // lines — and it is the difference between a scrollbar you can grab and one
  // you can only hit.
  const SCROLLBAR_GRAB = 2;

  function insideScrollbar(x, y) {
    const coords = history._getCoords();
    if (!coords) return false;
    if (x < coords.xl - SCROLLBAR_GRAB || x >= coords.xl) return false;
    if (y < coords.yi || y >= coords.yl) return false;
    const contentRows = Math.max(history._clines?.length ?? 0, history._scrollBottom());
    return contentRows > coords.yl - coords.yi;
  }

  // Where the pointer is, not how many events it took to get there: the drag
  // arrives as a stream (one synthetic mousedown per motion report outside the
  // VTE family), and each event used to force a whole repaint — milliseconds
  // each on a transcript with pictures in it, which is what made a fast drag
  // stutter and lag behind the hand. The position follows every event; the
  // paint is the same once-per-frame the wheel gets, and an event that does not
  // move the thumb costs nothing at all.
  let scrollbarPerc = -1;

  function scrollFromScrollbar(y) {
    const coords = history._getCoords();
    if (!coords) return;
    const height = Math.max(1, coords.yl - coords.yi - 1);
    const perc = clamp(((y - coords.yi) / height) * 100, 0, 100);
    if (perc === scrollbarPerc) return;
    scrollbarPerc = perc;
    history.setScrollPerc(perc);
    followTail = atTail();
    schedulePaint();
  }

  // Two blessed facts shape this. A left-button drag arrives as a stream of
  // `mousedown`, because blessed rewrites the motion codes into `mousemove` only
  // for the VTE family. And an element is only told about the pointer while it is
  // inside it, so a drag released over the composer — which is where a downward
  // drag ends — would never see its release: the selection would stay armed and
  // the edge scroll would run on forever. So the whole gesture lives on the
  // screen, and only its start is confined to the transcript.
  let scrollbarDragging = false;
  screen.on('mousedown', (data) => {
    activityCb();
    if (!mouseCaptured) return;
    if (scrollbarDragging) return scrollFromScrollbar(data.y);
    if (insideScrollbar(data.x, data.y)) {
      stopEdgeScroll();
      dragging = false;
      scrollbarDragging = true;
      // A fresh grab must move the view even if it lands exactly where the
      // last drag left off: the guard against a repeated position belongs to
      // one gesture, not to the session.
      scrollbarPerc = -1;
      return scrollFromScrollbar(data.y);
    }
    if (dragging) return extendSelection(data.y);
    // The bar under the draft is a control, not text: a click on a pill opens
    // that conversation, and a click on the open one does nothing — it is
    // already where the click would go. Anything else on the bar (the gaps, the
    // ‹ › markers) is a miss and starts nothing.
    const pill = rosterPillAt(data.x, data.y);
    if (pill) {
      if (!pill.active) selectRoster(pill.login);
      return;
    }
    if (!insideHistory(data.x, data.y)) return;
    const line = lineAtRow(data.y);
    if (line === null) return;
    dragging = true;
    anchorLine = line;
    headLine = line;
    return render();
  });

  // blessed autofocuses whatever clickable element was clicked — see the
  // `element click` handler its Screen constructor installs. The transcript has
  // to be clickable so a preview or a link can be opened, but it must never
  // hold focus: the composer is the only widget that reads keys, so a single
  // click with the mouse captured left the terminal with a dead keyboard and,
  // because typing was what it had killed, no way to type `/mouse` and get back
  // out. Registered after blessed's own handler, so this is the one that wins.
  screen.on('element click', () => {
    if (destroyed) return;
    // The lock and saver screens deliberately own input while they are up.
    if (!lockScreen.hidden || !saverScreen.hidden) return;
    if (screen.focused !== composer) composer.focus();
  });

  screen.on('mousemove', (data) => {
    activityCb();
    if (scrollbarDragging) return scrollFromScrollbar(data.y);
    if (dragging) extendSelection(data.y);
  });

  screen.on('mouseup', (data) => {
    if (scrollbarDragging) {
      scrollbarDragging = false;
      scrollbarPerc = -1;
      // The last frame of the burst may still be pending behind the throttle,
      // and the position the hand let go of is the one that has to be on screen.
      screen.render();
      return;
    }
    if (!dragging) return;
    stopEdgeScroll();
    dragging = false;
    const range = selection();
    if (!range) return;
    // A click without a drag over a preview opens the file, and over a link opens
    // the browser. The selection stays painted either way so the click has visible
    // feedback instead of silently jumping into another window.
    if (range.from === range.to) {
      const span = historyBuffer.artSpans()
        .find((item) => range.from >= item.from && range.from <= item.to);
      if (span) {
        render();
        return openImageCb(span.file);
      }
      const coords = history._getCoords();
      if (coords) {
        const url = historyBuffer.linkAt(range.from, data.x - coords.xi);
        if (url) {
          render();
          return openLinkCb(url);
        }
      }
    }
    anchorLine = null;
    headLine = null;
    render();
    const text = selectedText(history._clines?.fake ?? [], range, historyBuffer.copyPadding());
    if (text) copyCb(text, range.to - range.from + 1);
  });

  // Sits between the transcript and the composer rule, so a half-typed command
  // shows what it could become without covering the conversation.
  const menu = blessed.box({
    parent: frame,
    left: 1,
    right: 1,
    bottom: 3,
    height: 0,
    tags: true,
    hidden: true,
    style: themed ? { fg: 'green' } : { fg: 'default' },
  });

  // The list used to float in the same green as the conversation above it, with
  // nothing but boldness marking the selection. A rule of its own gives it a top
  // edge, so it reads as a panel over the chat rather than more chat.
  const menuRule = blessed.box({
    parent: frame,
    left: 1,
    right: 1,
    height: 1,
    hidden: true,
    tags: true,
    style: themed ? { fg: palette.border } : { fg: 'default' },
  });

  const composerRule = blessed.box({
    parent: frame,
    left: 0,
    right: 0,
    bottom: 1,
    height: 1,
    tags: true,
    style: themed ? { fg: palette.border } : { fg: 'default' },
  });

  const prompt = blessed.box({
    parent: frame,
    left: 1,
    bottom: 0,
    width: 2,
    height: 1,
    content: themed ? '❯ ' : '> ',
    style: themed ? { fg: 'brightgreen', bold: true } : { fg: 'white' },
  });

  const composer = blessed.textarea({
    parent: frame,
    left: 3,
    right: 1,
    bottom: 0,
    height: 1,
    inputOnFocus: false,
    keys: false,
    scrollable: true,
    alwaysScroll: true,
    style: themed ? { fg: 'brightgreen' } : { fg: 'default' },
  });

  const rosterBar = blessed.box({
    parent: frame,
    left: 0,
    right: 0,
    bottom: 0,
    height: 1,
    tags: true,
    wrap: false,
    hidden: true,
    style: themed ? { fg: palette.border } : { fg: 'default' },
  });

  // The same rule that separates the draft from the transcript, repeated
  // between the draft and the contact bar: without it the pills sat directly
  // under the input line and read as part of it.
  const rosterRule = blessed.box({
    parent: frame,
    left: 0,
    right: 0,
    bottom: 1,
    height: 1,
    tags: true,
    hidden: true,
    style: themed ? { fg: palette.border } : { fg: 'default' },
  });

  // A second column, mirroring the roster's on the opposite edge: facts about
  // the open conversation that do not fit the one-line header. Its own
  // threshold, wider than the roster's own (80): the roster alone already
  // earns its keep at 80 columns, but a *second* column on top of it needs
  // real room, or the transcript in between is squeezed unreadable.
  const INFO_PANEL_WIDTH = 26;
  function infoPanelShown() { return Number(screen.width) >= 120; }
  // +1 for the vertical rule between the transcript and the panel, the same
  // way the roster's own column always costs 27 (26 plus its rule) rather
  // than 26.
  function infoReserve() { return infoPanelShown() ? INFO_PANEL_WIDTH + 1 : 0; }

  const infoPanel = blessed.box({
    parent: frame,
    top: 0,
    bottom: 0,
    right: 0,
    width: INFO_PANEL_WIDTH,
    tags: true,
    wrap: false,
    hidden: true,
    style: themed ? { fg: palette.border } : { fg: 'default' },
  });

  const infoRule = blessed.box({
    parent: frame,
    top: 0,
    bottom: 0,
    right: INFO_PANEL_WIDTH,
    width: 1,
    tags: false,
    hidden: true,
    style: themed ? { fg: palette.border } : { fg: 'default' },
  });

  let rosterItems = [];
  let activeRosterLogin = null;
  let rosterSelectCb = () => {};
  // The bar may paint three rows while the roster is longer, so the wheel over
  // it moves the window instead of the transcript. `null` means "follow the
  // active contact", the default; the other two are what the last paint
  // actually did, because the wheel has to move on from where the window
  // really stands and not from what was asked for.
  let rosterScrollTop = null;
  let rosterScrollMax = 0;
  let rosterScrollView = 0;
  let rosterHitRows = []; // spans of the painted rows, for resolving a click

  // Opening a conversation: the keyboard's switch and a click on a pill are the
  // same act, so both come through here.
  function selectRoster(login) {
    if (!login) return false;
    rosterScrollTop = null; // the bar goes back to following the selection
    activeRosterLogin = login;
    rosterSelectCb(login);
    render();
    return true;
  }

  function switchRoster(step) {
    if (rosterItems.length <= 1) return;
    const cleanActive = String(activeRosterLogin ?? '').replace(/^@/, '').toLowerCase();
    const currentIdx = rosterItems.findIndex((item) => {
      const cleanLogin = String(item.login ?? '').replace(/^@/, '').toLowerCase();
      return cleanLogin === cleanActive || item.login === String(activeRosterLogin ?? '');
    });
    const baseIdx = currentIdx >= 0 ? currentIdx : 0;
    let nextIdx = (baseIdx + step) % rosterItems.length;
    if (nextIdx < 0) nextIdx += rosterItems.length;
    selectRoster(rosterItems[nextIdx]?.login);
  }
  function switchRosterPrev() { switchRoster(-1); }
  function switchRosterNext() { switchRoster(1); }

  // Where the bar sits, or null when it is not on screen — a hidden element has
  // no coordinates, which is also the right answer for "nothing to hit".
  function rosterCoordsAt(x, y) {
    if (rosterBar.hidden) return null;
    const coords = rosterBar._getCoords();
    if (!coords) return null;
    if (x < coords.xi || x >= coords.xl || y < coords.yi || y >= coords.yl) return null;
    return coords;
  }

  // The pill under the pointer. The gaps between pills, the ‹ › markers and the
  // empty cells after the last contact are all misses: a click there does
  // nothing rather than opening whichever neighbour happens to be nearest.
  function rosterPillAt(x, y) {
    const coords = rosterCoordsAt(x, y);
    if (!coords) return null;
    const row = rosterHitRows[y - coords.yi];
    if (!row) return null;
    const cell = x - coords.xi;
    return row.spans.find((span) => cell >= span.start && cell < span.end) ?? null;
  }

  // The wheel over the bar, one row per notch: the bar is three rows tall, and
  // a trackpad sends a burst per gesture, so a three-row step would land
  // somewhere unrelated to the hand. A roster that already fits has nothing to
  // scroll and leaves the notches alone.
  function scrollRoster(step, x, y) {
    if (!mouseCaptured || rosterScrollMax <= 0 || !rosterCoordsAt(x, y)) return false;
    const base = rosterScrollTop ?? rosterScrollView;
    const next = clamp(base + step, 0, rosterScrollMax);
    if (next === base) return false;
    rosterScrollTop = next;
    activityCb();
    render();
    return true;
  }

  screen.on('wheelup', (data) => { scrollRoster(-1, data.x, data.y); });
  screen.on('wheeldown', (data) => { scrollRoster(1, data.x, data.y); });

  screen.append(frame);
  screen.append(saverScreen);
  screen.append(lockScreen);
  // mode blessed picks for xterm-*, which is why the wheel never scrolled.
  // Capturing the mouse also takes over native text selection, so it can be
  // switched off at runtime when the reader wants to copy from the transcript.
  const MOUSE_MODES = { sgrMouse: true, vt200Mouse: true, cellMotion: true };

  // Non-null while `addLine` output is being collected rather than shown.
  let captured = null;

  function setMouseCapture(enabled) {
    const next = Boolean(enabled);
    if (next) screen.program.setMouse(MOUSE_MODES, true);
    else screen.program.disableMouse();
    // disableMouse() clears focus reporting along with the mouse modes, and
    // presence must not depend on whether the reader is copying text.
    if (focusSupported) screen.program.setMode('?1004');
    mouseCaptured = next;
    return mouseCaptured;
  }

  setMouseCapture(mouse);

  // Completion is offered only while the draft is a bare command word: once a
  // space is typed the user is writing an argument, not choosing a command.
  let commandList = [];
  let menuIndex = 0;
  let menuOffset = 0; // first visible row, so a long list can scroll

  function completionPrefix() {
    const value = editor.value();
    if (!/^\/([a-z][a-z0-9_-]*)?$/i.test(value)) return null;
    return value.toLowerCase();
  }

  function matchingCommands() {
    const prefix = completionPrefix();
    if (prefix === null) return [];
    if (prefix === '/') return commandList;
    return commandList.filter(({ name, alias }) => (
      name.startsWith(prefix) || alias === prefix
    ));
  }

  // blessed's textarea is append-only and ignores the arrow keys entirely, so
  // the draft is owned by our own editor model and the widget only renders it.
  const editor = createEditor();

  function syncComposer() {
    // Bypass setValue()'s change detection: the text can stay identical while
    // only the cursor moved, and the cursor still has to be repainted.
    const display = editor.displayValue(pasteLabel);
    composer.value = display;
    composer._value = display;
    composer.setContent(display);
  }

  // Clearing the draft can shrink the composer by several rows at once, and a
  // damaged frame is exactly when this is reached for, so rebuild the buffer
  // rather than trusting the diff.
  function repaint() {
    composer.childBase = 0;
    screen.realloc();
  }

  // Accepts the highlighted command. Enter keeps meaning "send", so a visible
  // menu never changes what the most-used key does.
  function resetMenu() {
    menuIndex = 0;
    menuOffset = 0;
  }

  // A modal list riding the same widget as the command completion: /peer offers
  // the roster here, with the same cursor, colours and keys. Rows are the same
  // { name, help } shape the command menu eats, plus an optional `value` that is
  // what the picker resolves with (defaults to `name`).
  let picker = null; // { label, rows, resolve }
  function closePicker(value) {
    if (!picker) return;
    const { resolve } = picker;
    picker = null;
    menuIndex = 0;
    menuOffset = 0;
    resolve(value);
    render();
  }


  // The draft already names a command exactly, so there is nothing to complete
  // and Enter should run it rather than rewrite it.
  function isExactCommand(value) {
    const text = String(value).trim().toLowerCase();
    return commandList.some(({ name, alias }) => text === name || text === alias);
  }

  function acceptCompletion() {
    // Index the whole match list, not the visible window: the selection can be
    // scrolled past the rows currently on screen.
    const chosen = matchingCommands()[menuIndex];
    if (!chosen) return false;
    editor.setValue(`${chosen.name} `);
    resetMenu();
    return true;
  }

  // Alt+Enter reaches us as ESC immediately followed by CR — that is how a
  // terminal spells a meta key — so the two are joined back together by time.
  // Ctrl+J needs no such trick: it arrives as its own key.
  let escapeAt = 0;
  const ALT_WINDOW_MS = 50;

  // No language is written in: guessing one from the first word labelled a
  // JavaScript paste as shell, because `export` and `function` belong to both.
  // An unlabelled block still gets the colouring every language agrees on, and
  // whoever knows the language can type it on the fence line.
  function wrapDraftAsCode() {
    const draft = editor.value().trim();
    if (draft === '' || draft.startsWith('```')) return;
    editor.setValue(`\`\`\`\n${draft}\n\`\`\``);
  }

  composer._listener = function listener(ch, key) {
    if (!lockScreen.hidden) {
      handleLockKeypress(ch, key);
      return undefined;
    }
    const mod = (k) => k.ctrl || (MAC && k.meta);
    const menuOpen = picker !== null || matchingCommands().length > 0;
    switch (key.name) {
      case 'linefeed':
        editor.insert('\n');
        typingCb();
        break;
      case 'enter': {
        if (picker) {
          const row = picker.rows[menuIndex];
          closePicker(row?.value ?? row?.name ?? null);
          break;
        }
        // A newline in the draft is the only way to write a fenced code block:
        // Enter itself has to keep meaning "send".
        if (Date.now() - escapeAt < ALT_WINDOW_MS) {
          escapeAt = 0;
          editor.insert('\n');
          typingCb();
          break;
        }
        // A visible menu means the draft is an unfinished command. Completing
        // it is what the highlighted row promises; posting "/" into the
        // conversation is not.
        const value = editor.value();
        if (!isExactCommand(value) && acceptCompletion()) break;
        const text = (value || '').trim();
        editor.clear();
        syncComposer();
        composer.focus();
        render();
        if (text.length > 0) inputCb(text);
        return undefined;
      }
      // A lone ESC is indistinguishable from the start of an escape sequence,
      // so it is never treated as a command: Ctrl+G clears the draft instead.
      // Its arrival time is kept only to recognise Alt+Enter. An open picker is
      // the exception: there ESC plainly means "cancel this list".
      case 'escape':
        if (picker) { closePicker(null); break; }
        escapeAt = Date.now();
        return undefined;
      case 'tab': {
        if (picker) {
          const row = picker.rows[menuIndex];
          closePicker(row?.value ?? row?.name ?? null);
          break;
        }
        if (acceptCompletion()) break;
        if (rosterItems.length > 1) {
          if (key.shift) switchRosterPrev();
          else switchRosterNext();
          break;
        }
        return undefined;
      }
      case 'left':
        if (mod(key) && rosterItems.length > 1) {
          switchRosterPrev();
          break;
        }
        editor.left();
        break;
      case 'right':
        if (mod(key) && rosterItems.length > 1) {
          switchRosterNext();
          break;
        }
        editor.right();
        break;
      case 'up':
        if (mod(key) && rosterItems.length > 1) {
          switchRosterPrev();
          break;
        }
        if (menuOpen) menuIndex = Math.max(0, menuIndex - 1);
        else if (editor.value() === '') scrollHistory(-1);
        else editor.up();
        break;
      case 'down':
        if (mod(key) && rosterItems.length > 1) {
          switchRosterNext();
          break;
        }
        if (menuOpen) menuIndex += 1;
        else if (editor.value() === '' || !editor.down()) scrollHistory(1);
        break;
      case 'home': editor.home(); break;
      case 'end': editor.end(); break;
      case 'backspace': editor.backspace(); resetMenu(); typingCb(); break;
      case 'delete': editor.del(); resetMenu(); typingCb(); break;
      default:
        if (picker && ch && !mod(key)) {
          // A digit picks its row outright — reachable even where arrows are
          // not (see the startup menu's raw-byte fallback).
          const digit = /^[1-9]$/.test(ch) ? Number(ch) : null;
          if (digit !== null && digit <= picker.rows.length) {
            const row = picker.rows[digit - 1];
            closePicker(row?.value ?? row?.name ?? null);
            break;
          }
        }
        if (mod(key) && (ch === '[' || key.name === '[')) {
          if (rosterItems.length > 1) { switchRosterPrev(); break; }
        }
        if (mod(key) && (ch === ']' || key.name === ']')) {
          if (rosterItems.length > 1) { switchRosterNext(); break; }
        }
        // Typing dismisses the modal list; the keystroke itself still lands in
        // the draft, so nothing typed is lost to the menu that just closed.
        if (picker && ch && !mod(key) && !/^[\u0000-\u0008\u000b-\u001f\u007f]$/.test(ch)) {
          closePicker(null);
        }
        if (mod(key) && key.name === 'p') {
          peerPickerCb();
          break;
        }
        if (mod(key) && key.name === 'a') { editor.home(); break; }
        if (mod(key) && key.name === 'e') { editor.end(); break; }
        if (mod(key) && key.name === 'k') { editor.killLine(); break; }
        if (mod(key) && key.name === 'u') { editor.killToStart(); break; }
        if (mod(key) && key.name === 'w') { editor.killWord(); break; }
        // A panic key: wipe the draft and rebuild the frame, for when a resize
        // or a stray escape sequence has left the composer looking wrong.
        if (mod(key) && key.name === 'g') { editor.clear(); repaint(); break; }
        // A command is pasted far more often than a fence is typed, so one key
        // turns the draft into a code block. The language is a guess from the
        // first word and stays editable on the fence line.
        if (mod(key) && key.name === 'b') { wrapDraftAsCode(); break; }
        // Expand or collapse the pasted block at the cursor: the draft keeps
        // the full text either way, only the view changes.
        if (mod(key) && key.name === 'x') { editor.togglePaste(); break; }
        if (mod(key) || !ch) return undefined; // other control keys belong elsewhere
        if (/^[\u0000-\u0008\u000b-\u001f\u007f]$/.test(ch)) return undefined;
        editor.insert(ch);
        // A narrower filter means a different best match: start from the top.
        resetMenu();
        snapToTail();
        typingCb();
    }
    syncComposer();
    render();
    return undefined;
  };

  // Place the real terminal cursor from the editor instead of blessed's
  // append-only assumption that it always sits after the last character.
  composer._updateCursor = function updateCursor() {
    if (screen.focused !== composer) return;
    const coords = composer._getCoords();
    if (!coords) return;
    const { row, col } = cursorCell();
    const visible = Math.max(1, composer.height);
    // The caret must stay inside the composer even mid-resize, or it is drawn
    // over the transcript.
    const line = clamp(row - (composer.childBase || 0), 0, visible - 1);
    screen.program.cup(coords.yi + line, coords.xi + col);
  };

  // Precedence: a dropped link matters most, then whether the peer's window is
  // actually in front of them. Typing is deliberately absent — it is a passing
  // event and it is shown on the composer rule, so presence stays visible.
  function headerStatus() {
    if (status !== 'online') return status;
    return peerPresence ?? status;
  }

  function renderHeader() {
    const wide = Number(screen.width) >= 80 && rosterItems.length > 0;
    header.setContent(renderHeaderMarkup({
      width: Math.max(1, Number(screen.width) - (wide ? 31 : 4) - infoReserve()),
      selfName,
      peerName,
      peerDevice,
      status: headerStatus(),
      unreadSummary,
      updateAvailable,
      themed,
      version,
      transport: transportLabel,
      peerClient: peerClientLabel,
    }));
  }


  // What the composer rule says while something is happening, or null when it
  // goes back to being just `Message`. Sending temporarily wins, but every
  // simultaneous human and AI voice is retained and returns afterward.
  function typingLabels() {
    const labels = [];
    if (selfTyping) labels.push(selfName);
    for (const voice of peerTypingVoices) {
      labels.push(voice === PEER_TYPING_VOICE ? peerName : voice);
    }
    if (aiTyping !== null) labels.push(aiTyping);
    return [...new Set(labels)];
  }

  function shimmerLabel() {
    if (sending !== null) return `sending ${safeTerminalText(sending)}`;
    const labels = typingLabels();
    if (labels.length === 0) return null;
    return `${labels.map(safeTerminalText).join(' + ')} typing`;
  }

  function stopShimmer() {
    if (!shimmerTimer) return;
    clearInterval(shimmerTimer);
    shimmerTimer = null;
    shimmerPhase = 0;
  }

  function startShimmer() {
    if (shimmerTimer) return;
    shimmerPhase = 0;
    shimmerTimer = setInterval(() => {
      if (destroyed) return stopShimmer();
      // Counted, never wrapped here: only the painter knows how long the label
      // is, so it does the modulo and this only has to keep advancing.
      shimmerPhase += 1;
      // A full render, not just the header: the indicator is drawn on the
      // composer rule inside layout(), and the header does not animate at all.
      render();
      return undefined;
    }, SHIMMER_MS);
    // Never hold the event loop open just to animate an indicator.
    shimmerTimer.unref?.();
  }

  // One switch for both indicators, so a transfer starting mid-typing cannot
  // leave two timers running or none.
  function syncShimmer() {
    if (shimmerLabel() === null) stopShimmer();
    else startShimmer();
  }

  // One place that knows how the draft wraps, so the size, the scroll offset
  // and the cursor can never disagree about where a character lands.
  function draftWidth() {
    const wide = Number(screen.width) >= 80 && rosterItems.length > 0;
    return Math.max(1, Number(screen.width) - (wide ? 34 : 7) - infoReserve());
  }
  function wrappedRows(text, available) {
    return Math.max(1, Math.ceil(displayWidth(text) / available));
  }

  // blessed word-wraps: it breaks at spaces, not every N cells. Counting cells
  // put the caret in the middle of a pasted paragraph, so the wrap is read back
  // from the widget that paints it. `_clines` is blessed's own list of wrapped
  // rows and its rows concatenate exactly to the text, nothing dropped.
  function wrappedLines() {
    const rows = composer._clines;
    return Array.isArray(rows) && rows.length > 0 ? rows : [''];
  }

  function draftTotalRows() {
    return wrappedLines().length;
  }

  function draftRows() {
    return clamp(draftTotalRows(), 1, MAX_DRAFT_ROWS);
  }

  // Where the cursor sits once soft wrapping is applied. The column is measured
  // in screen cells, not code points, or a wide character shifts the caret.
  function cursorCell() {
    const rows = wrappedLines();
    const { line, column } = editor.cursorPosition();
    // `ftor` lists every wrapped row of a logical line; `rtof` is the reverse
    // map and reading it here put the caret on the first row of a paragraph.
    const fakes = composer._clines?.ftor?.[line];
    const start = Array.isArray(fakes) && fakes.length > 0 ? fakes[0] : 0;
    const end = Array.isArray(fakes) && fakes.length > 0
      ? fakes[fakes.length - 1] + 1
      : rows.length;
    const available = draftWidth();
    let consumed = 0;
    for (let r = start; r < end; r++) {
      const chars = Array.from(rows[r] ?? '');
      if (column <= consumed + chars.length) {
        const col = displayWidth(chars.slice(0, column - consumed).join(''));
        // Sitting exactly on the right edge belongs to the next row, which is
        // where the next character will actually land.
        if (col >= available && r + 1 < end) return { row: r + 1, col: 0 };
        return { row: r, col };
      }
      consumed += chars.length;
    }
    const last = Math.max(start, end - 1);
    return { row: last, col: displayWidth(rows[last] ?? '') };
  }

  function renderRule(label = '', markup = null) {
    const wide = Number(screen.width) >= 80 && rosterItems.length > 0;
    const width = Math.max(1, Number(screen.width) - (wide ? 29 : 2) - infoReserve());
    const prefix = label ? `╌ ${label} ` : '';
    const dashes = '╌'.repeat(Math.max(0, width - prefix.length));
    return label && markup ? `╌ ${markup} ${dashes}` : `${prefix}${dashes}`;
  }

  let lastRows = 0;
  let lastMenuRows = 0;
  let lastRosterOffset = 0;
  function layout() {
    const rows = draftRows();
    const compact = isCompact(screen.width);
    const wide = Number(screen.width) >= 80 && rosterItems.length > 0;
    const contentLeft = wide ? 28 : 1;
    const showInfo = infoPanelShown();
    const reserve = infoReserve();
    header.left = contentLeft;
    header.right = 1 + reserve;
    headerRule.left = wide ? 27 : 0;
    headerRule.right = reserve;
    logo.left = contentLeft;
    logo.right = 1 + reserve;
    logoRule.left = wide ? 27 : 0;
    logoRule.right = reserve;
    history.left = contentLeft;
    history.right = 1 + reserve;
    menu.left = contentLeft;
    menu.right = 1 + reserve;
    menuRule.left = wide ? 27 : 0;
    menuRule.right = reserve;
    composerRule.left = wide ? 27 : 0;
    composerRule.right = reserve;
    prompt.left = contentLeft;
    composer.left = contentLeft + 2;
    composer.right = 1 + reserve;
    infoPanel.hidden = !showInfo;
    infoRule.hidden = !showInfo;
    if (showInfo) {
      infoPanel.setContent(renderInfoPanelMarkup({
        width: INFO_PANEL_WIDTH,
        peerName,
        peerDevice,
        status: headerStatus(),
        transport: transportLabel,
        peerClient: peerClientLabel,
        themed,
      }));
      // Тот же вертикальный шов, что у ростера слева (см. `rosterRule` ниже):
      // без контента это был просто пустой столбец нужной ширины.
      infoRule.setContent('│\n'.repeat(Math.max(1, Number(screen.height))));
    }
    rosterBar.hidden = rosterItems.length === 0;
    rosterRule.hidden = rosterBar.hidden;
    let renderedRosterLines = 0;
    if (!rosterBar.hidden && wide) {
      const capacity = Math.max(1, Number(screen.height) - 2);
      const maxTop = Math.max(0, rosterItems.length - capacity);
      const activeIndex = Math.max(0, rosterItems.findIndex((item) =>
        String(item.login ?? '').replace(/^@/, '').toLowerCase()
          === String(activeRosterLogin ?? '').replace(/^@/, '').toLowerCase()));
      const top = rosterScrollTop === null
        ? clamp(activeIndex - Math.floor(capacity / 2), 0, maxTop)
        : clamp(rosterScrollTop, 0, maxTop);
      const visible = rosterItems.slice(top, top + capacity);
      rosterHitRows = visible.map((item, index) => {
        const active = item.login === activeRosterLogin;
        const unread = active ? 0 : Number(item.unread) || 0;
        const online = item.state === 'online' || item.online === true;
        const name = safeTerminalText(item.name && item.name !== item.login ? item.name : item.login);
        const suffix = unread > 0 ? ` ${unread}` : '';
        const plain = `${active ? '▸' : ' '} ${online ? '●' : '○'} ${name}${suffix}`;
        const markup = themed
          ? active
            ? `{bold}{green-fg}${escapeMarkup(plain)}{/green-fg}{/bold}`
            : unread > 0
              ? `{bold}{yellow-fg}${escapeMarkup(plain)}{/yellow-fg}{/bold}`
              : escapeMarkup(plain)
          : plain;
        return {
          text: markup,
          spans: [{ login: item.login, active, start: 0, end: 26 }],
          index,
        };
      });
      if (top + visible.length < rosterItems.length && rosterHitRows.length > 0) {
        const hidden = rosterItems.length - top - visible.length;
        rosterHitRows[rosterHitRows.length - 1] = {
          text: themed ? `{245-fg}+${hidden}{/245-fg}` : `+${hidden}`,
          spans: [],
        };
      }
      rosterScrollMax = maxTop;
      rosterScrollView = top;
      rosterScrollTop = maxTop > 0 && rosterScrollTop !== null ? top : null;
      rosterBar.top = 0;
      rosterBar.bottom = 0;
      rosterBar.left = 0;
      rosterBar.right = undefined;
      rosterBar.width = 26;
      rosterBar.height = '100%';
      rosterBar.setContent(rosterHitRows.map((row) => row.text).join('\n'));
      rosterRule.top = 0;
      rosterRule.bottom = 0;
      rosterRule.left = 26;
      rosterRule.right = undefined;
      rosterRule.width = 1;
      rosterRule.height = '100%';
      rosterRule.setContent('│\n'.repeat(Math.max(1, Number(screen.height))));
    } else if (!rosterBar.hidden) {
      const bar = layoutRosterBar({
        items: rosterItems,
        maxRows: Math.min(activeRosterRows, 2),
        activeLogin: activeRosterLogin,
        width: Number(screen.width),
        themed,
        palette,
        offset: rosterScrollTop,
      });
      rosterHitRows = bar.rows;
      rosterScrollMax = bar.maxTop;
      rosterScrollView = bar.top;
      rosterScrollTop = bar.maxTop > 0 && rosterScrollTop !== null ? bar.top : null;
      renderedRosterLines = Math.max(1, bar.rows.length);
      rosterBar.top = undefined;
      rosterBar.left = 0;
      rosterBar.right = 0;
      rosterBar.width = undefined;
      rosterBar.height = renderedRosterLines;
      rosterBar.bottom = 0;
      rosterRule.top = undefined;
      rosterRule.left = 0;
      rosterRule.right = 0;
      rosterRule.width = undefined;
      rosterRule.height = 1;
      rosterRule.bottom = renderedRosterLines;
      rosterRule.setContent(renderRule());
      rosterBar.setContent(bar.rows.map((row) => row.text).join('\n'));
    } else {
      rosterHitRows = [];
      rosterScrollMax = 0;
      rosterScrollView = 0;
      rosterScrollTop = null;
    }
    const rosterOffset = !wide && rosterItems.length > 0 ? (renderedRosterLines + 1) : 0;
    composer.height = rows;
    composer.bottom = rosterOffset;
    // Follow the cursor, not the end of the text: pinning the view to the
    // bottom leaves the caret painted on whatever row happens to be there.
    const { row } = cursorCell();
    const maxBase = Math.max(0, draftTotalRows() - rows);
    let base = composer.childBase || 0;
    if (row < base) base = row;
    else if (row >= base + rows) base = row - rows + 1;
    composer.childBase = clamp(base, 0, maxBase);
    prompt.height = rows;
    prompt.bottom = rosterOffset;
    composerRule.bottom = rosterOffset + rows;
    const matches = picker ? picker.rows : matchingCommands();
    menuIndex = matches.length > 0 ? clamp(menuIndex, 0, matches.length - 1) : 0;
    // The list is longer than the window it is allowed to occupy, so the window
    // follows the selection instead of hiding whatever did not fit.
    const visible = Math.min(MENU_ROWS, matches.length);
    if (menuIndex < menuOffset) menuOffset = menuIndex;
    else if (menuIndex >= menuOffset + visible) menuOffset = menuIndex - visible + 1;
    menuOffset = clamp(menuOffset, 0, Math.max(0, matches.length - visible));
    const shown = matches.slice(menuOffset, menuOffset + visible);
    const hidden = matches.length - shown.length;
    menu.height = shown.length;
    menu.hidden = shown.length === 0;
    menu.bottom = rosterOffset + rows + 1;
    menuRule.hidden = menu.hidden;
    menuRule.bottom = rosterOffset + rows + 1 + shown.length;
    if (!menu.hidden) {
      const label = menuRuleLabel({
        index: menuIndex, total: matches.length, shown: shown.length,
        word: picker ? picker.label : undefined,
      });
      menuRule.setContent(themed
        ? `{green-fg}{bold}${escapeMarkup(renderRule(label))}{/bold}{/green-fg}`
        : escapeMarkup(renderRule(label)));
    }
    menu.setContent(renderMenuMarkup({
      shown,
      hidden,
      chosenIndex: menuIndex - menuOffset,
      width: Number(screen.width) - (wide ? 27 : 0),
      themed,
      nameWidth: Math.max(1, ...(picker ? picker.rows : commandList).map(({ name }) => name.length)),
    }));
    history.bottom = rosterOffset + rows + 1 + shown.length;
    headerRule.setContent(renderRule());
    logoRule.setContent(renderRule());
    // Both indicators belong next to the composer, not in the header: they are
    // passing events, and the header is for state that persists.
    const label = shimmerLabel();
    if (label !== null) {
      composerRule.setContent(renderRule(
        label,
        themed ? shimmerMarkup(label, shimmerPhase) : escapeMarkup(label),
      ));
    } else {
      composerRule.setContent(renderRule(compact ? '' : composerLabel));
    }
    renderHeader();
    if (rows !== lastRows || shown.length !== lastMenuRows || rosterOffset !== lastRosterOffset) {
      // Growing or shrinking the composer moves every element below it;
      // blessed keeps the vacated cells, which strands a stale prompt row and
      // eats the bottom border. Rebuild the buffer so the frame stays intact.
      lastRows = rows;
      lastMenuRows = shown.length;
      lastRosterOffset = rosterOffset;
      screen.realloc();
    }
  }

  // blessed packs an attribute as (flags << 18) | (fg << 9) | bg. A selection
  // replaces the colours and keeps the flags, which reads clearly without having
  // to re-render the markup underneath.
  const SELECTION_ATTR = (attr) => ((attr >> 18) << 18) | (0 << 9) | 2;

  function paintSelection() {
    const range = selection();
    if (!range) return;
    const coords = history._getCoords();
    if (!coords) return;
    const map = history._clines?.rtof;
    if (!Array.isArray(map)) return;
    const base = history.childBase || 0;
    let first = null;
    let last = null;
    for (let y = coords.yi; y < coords.yl; y++) {
      const line = map[base + (y - coords.yi)];
      if (line === undefined || !rangeCovers(range, line)) continue;
      const row = screen.lines[y];
      if (!row) continue;
      for (let x = coords.xi; x < coords.xl; x++) {
        if (row[x]) row[x][0] = SELECTION_ATTR(row[x][0]);
      }
      row.dirty = true;
      if (first === null) first = y;
      last = y;
    }
    if (first !== null) screen.draw(first, last);
  }

  function render() {
    layout();
    screen.render();
    paintSelection();
  }
  // Some terminals (Termux among them) never report focus. Claiming "active"
  // there would tell the peer that a phone in a pocket is being watched, so
  // support is trusted only once a real event has actually arrived.
  const onFocus = () => { if (!termux) { focusTracked = true; focused = true; focusCb(true); } };
  const onBlur = () => { if (!termux) { focusTracked = true; focused = false; focusCb(false); } };
  screen.program.on('focus', onFocus);
  screen.program.on('blur', onBlur);
  screen.on('resize', () => {
    // A raw view has no layout of its own to reflow: hand the terminal back to
    // blessed, which repaints everything at the new size on the way out.
    if (closeRawView()) return;
    render();
  });

  composer.key(MAC ? ['C-c', 'M-c'] : ['C-c'], () => quitCb());
  screen.key(MAC ? ['C-c', 'M-c'] : ['C-c'], () => quitCb());
  composer.key(['pageup'], () => scrollHistory(-(history.height - 1 || 1)));
  composer.key(['pagedown'], () => scrollHistory(history.height - 1 || 1));
  composer.key(['S-up'], () => scrollHistory(-1));
  composer.key(['S-down'], () => scrollHistory(1));
  composer.key(MAC ? ['C-v', 'M-v'] : ['C-v'], () => pasteImageCb());
  composer.key(MAC ? ['C-t', 'M-t'] : ['C-t'], () => mouseToggleCb());
  screen.key(MAC ? ['C-t', 'M-t'] : ['C-t'], () => mouseToggleCb());
  composer.on('keypress', (ch, key) => {
    activityCb();
    composer._listener(ch, key);
    setImmediate(() => { if (!destroyed) render(); });
  });

  paste.onPaste((text) => {
    // While the lock or a secret prompt is up, a paste belongs to it: a
    // recovery key is pasted far more often than typed, and the hidden
    // composer behind the overlay is the one place it must never land (it would
    // sit in the draft, on screen once the overlay closes). Line breaks and
    // control characters are dropped — a copied key often ends in a newline,
    // and a secret is one line.
    if (!lockScreen.hidden && lockState) {
      lockState.entered += String(text).replace(/[\u0000-\u001f\u007f]/g, '');
      lockState.error = false;
      renderLockContent();
      return;
    }
    // Dragging a file onto an empty composer means "send this"; dropping one
    // into a half-written message means "put the path here". Only offer the
    // paste to the caller in the first case.
    if (editor.value() === '' && pasteTextCb(text)) return;
    // A copy of the conversation names the messages in it; the text of those is
    // held verbatim, so quoting hands back what was sent rather than the rows
    // the terminal happened to have on screen. A quote stays plain text: it is
    // a deliberate, short answer, not a bulk dump.
    const quoted = historyBuffer.lookup(transcriptKeys(text, ['you', peerName, selfName]));
    const finalText = safeTerminalText(quoted ?? compactPastedText(text));
    // Sanitize here too: blessed wraps the draft by its own width table, so an
    // unsanitized variation selector pushes emoji past the frame border.
    if (!quoted && finalText.split('\n').length >= 2) editor.insertPaste(finalText);
    else editor.insert(finalText);
    snapToTail();
    syncComposer();
    typingCb();
    composer.focus();
    render();
  });

  screen.program.setMode('?2004');
  composer.focus();
  render();

  function addRaw(rendered) {
    history.setContent(historyBuffer.appendLine(rendered));
    tailIfFollowing();
    screen.render();
  }

  return {
    addLine(line) {
      // While a capture is open the line is collected instead of painted. This
      // exists for AI-initiated commands: `/help`, `/diagnose` and friends
      // write their output straight to the transcript, which is right when a
      // person typed them and wrong when the model did — there the output is
      // raw material for its answer, and dumping it too turned one question
      // into a screen of help text.
      if (captured) {
        captured.push(line);
        return;
      }
      const safe = escapeMarkup(line);
      // Dim green keeps chatter subordinate to the conversation itself.
      const rendered = themed ? `\x1b[2;32m${safe}\x1b[0m` : safe;
      history.setContent(historyBuffer.appendLine(rendered));
      tailIfFollowing();
      screen.render();
    },
    replaceLastLine(line) {
      const safe = escapeMarkup(line);
      const rendered = themed ? `\x1b[2;32m${safe}\x1b[0m` : safe;
      const content = historyBuffer.replaceLastLine(rendered);
      if (content === null) return false;
      history.setContent(content);
      tailIfFollowing();
      screen.render();
      return true;
    },
    // Built here rather than by the caller: every cell is escaped on the way in,
    // so no name, path or translation can smuggle markup into the frame.
    // Collects `addLine` output instead of showing it, until `stopLineCapture`.
    // Nested captures are refused rather than stacked: there is one AI command
    // in flight at a time, and a silent second capture would strand the first.
    startLineCapture() {
      if (captured) return false;
      captured = [];
      return true;
    },
    stopLineCapture() {
      const lines = captured ?? [];
      captured = null;
      return lines;
    },
    addSection(title, rows) {
      // Measured from the widget, not guessed from the screen, and one cell short
      // of it: blessed wraps a final word when a line exactly fills the box, which
      // strands it on a row of its own.
      const fallbackWidth = Number(screen.width) - (Number(screen.width) >= 80 && rosterItems.length > 0 ? 29 : 2) - infoReserve();
      const width = Math.max(20, (Number(history.width) || fallbackWidth + 1) - 1);
      if (title) {
        const label = safeTerminalText(title);
        const rule = '─'.repeat(Math.max(0, width - displayWidth(label) - 5));
        const line = `── ${label} ${rule}`;
        addRaw(themed
          ? `{green-bg}{black-fg}{bold}${escapeMarkup(line)}{/bold}{/black-fg}{/green-bg}`
          : escapeMarkup(line));
      }
      for (const cell of layoutTable({ rows, width })) {
        const pad = ' '.repeat(cell.indent);
        const left = cell.left
          ? (themed
            ? `{cyan-fg}${escapeMarkup(cell.left)}{/cyan-fg}`
            : escapeMarkup(cell.left))
          : '';
        const text = cell.text ? escapeMarkup(cell.text) : '';
        const body = themed && text ? `{green-fg}${text}{/green-fg}` : text;
        addRaw(`${pad}${left}${' '.repeat(cell.gap)}${body}`.replace(/\s+$/, ''));
      }
    },
    // An image preview is already markup: half-block cells with hex colours. It
    // lands in the transcript as-is, not escaped — there is nothing to escape.
    // One append for the whole picture, because every append reparses the
    // transcript: a preview row at a time cost fourteen of those for one photo.
    // The buffer keeps the file, so a click on the picture can still open it
    // after the history has trimmed or /clear has moved everything up.
    addArt(lines, file, afterMessageId = null) {
      history.setContent(historyBuffer.appendArt(lines, file, afterMessageId));
      tailIfFollowing();
      screen.render();
    },
    addMessage(message) {
      history.setContent(historyBuffer.appendMessage(message));
      // A message is the point of the app: never leave it unseen below the fold,
      // even if the reader had scrolled up. Status noise does not get this.
      followTail = true;
      history.setScrollPerc(100);
      screen.render();
    },
    // A whole conversation at once: the disk cache, or the relay's answer for it.
    // `addMessage` hands blessed the transcript once per message, and blessed
    // rewraps every line of it on every one of those calls — so opening a
    // 400-message conversation cost about 400× the work of opening a one-message
    // one, and walking the roster with Ctrl+→ froze the screen for the duration
    // of each step. One append of the finished batch is one rewrap, which is
    // what makes a switch instant.
    addMessages(messages) {
      if (!Array.isArray(messages) || messages.length === 0) return 0;
      history.setContent(historyBuffer.appendMessages(messages));
      followTail = true;
      history.setScrollPerc(100);
      screen.render();
      return messages.length;
    },
    // Switches the accent palette live: the border repaints immediately and
    // every message already on screen is recoloured, not just new ones. An
    // unknown name changes nothing and reports failure, so a mangled config
    // value or a mistyped /theme argument cannot blank the frame.
    setTheme(name) {
      if (!Object.hasOwn(THEMES, name)) return false;
      paletteName = name;
      palette = THEMES[name];
      if (themed) {
        frame.style.border.fg = palette.border;
        for (const rule of [headerRule, logoRule, menuRule, composerRule, rosterRule, infoRule]) rule.style.fg = palette.border;
        lockScreen.style.fg = palette.border;
      }
      history.setContent(historyBuffer.recolor());
      if (!lockScreen.hidden && lockState) renderLockContent();
      tailIfFollowing();
      screen.render();
      return true;
    },
    themeName() { return paletteName; },
    setNameBadge(enabled) {
      badgeEnabled = Boolean(enabled);
      history.setContent(historyBuffer.recolor());
      tailIfFollowing();
      screen.render();
    },
    nameBadge() { return badgeEnabled; },
    setMessageMarker(id, marker) {
      if (!historyBuffer.setMarker(id, marker)) return false;
      // Markers change in place, so keep the reader's scroll position.
      history.setContent(historyBuffer.content());
      tailIfFollowing();
      screen.render();
      return true;
    },
    markReadUpTo(id) {
      if (historyBuffer.markReadUpTo(id) === 0) return false;
      history.setContent(historyBuffer.content());
      tailIfFollowing();
      screen.render();
      return true;
    },
    markerOf(id) { return historyBuffer.markerOf(id); },
    updateMessage(id, text, options) {
      if (!historyBuffer.updateMessage(id, text, options)) return false;
      history.setContent(historyBuffer.content());
      tailIfFollowing();
      screen.render();
      return true;
    },
    // A reaction lands on a message already on screen, so the reader's scroll
    // position is kept exactly as `setMessageMarker` keeps it.
    setMessageReactions(id, reactions) {
      if (!historyBuffer.setReactions(id, reactions)) return false;
      history.setContent(historyBuffer.content());
      tailIfFollowing();
      screen.render();
      return true;
    },
    applyReaction(id, emoji, by, add) {
      if (!historyBuffer.applyReaction(id, emoji, by, add)) return false;
      history.setContent(historyBuffer.content());
      tailIfFollowing();
      screen.render();
      return true;
    },
    reactionsOf(id) { return historyBuffer.reactionsOf(id); },
    // Exposed for the same reason as `composerRuleContent`: what did or did not
    // reach the transcript is a contract worth asserting without a terminal.
    transcript() { return historyBuffer.content(); },
    removeMessages(ids) {
      const gone = historyBuffer.remove(ids);
      if (gone === 0) return 0;
      history.setContent(historyBuffer.content());
      tailIfFollowing();
      screen.render();
      return gone;
    },
    recentMessageIds(options) { return historyBuffer.recentIds(options); },
    messageById(id) { return historyBuffer.messageById(id); },
    wheelStep: WHEEL_STEP,
    scrollHistory(lines) { scrollHistory(lines); },
    isFollowingTail() { return followTail; },
    historyScrollOffset() { return history.childBase; },
    // Full-screen raw terminal drawing (the kitty-graphics viewer). Blessed is
    // locked out while a view is up — every key is swallowed and the first
    // input, mouse gesture or resize runs `onExit` — so the caller paints with
    // writeRaw and erases its own drawing inside onExit before leaveRawView.
    enterRawView(onExit = () => {}) {
      if (rawViewExit || destroyed) return false;
      // No half-drawn frame may sit between what blessed last flushed and the
      // raw escapes that replace the screen.
      screen.program.flush?.();
      rawViewExit = onExit;
      screen.lockKeys = true;
      return true;
    },
    // Bring the blessed UI back over a raw view. The caller deletes its own
    // kitty placements first; alloc(true) blanks the terminal and forgets the
    // last frame so the render after it repaints everything. Keys stay locked
    // until the deferred unlock in closeRawView has run, so the key that
    // dismissed the view never falls through into the composer.
    leaveRawView() {
      composer.focus();
      screen.alloc(true);
      render();
    },
    writeRaw(text) { screen.program.write(String(text)); },
    rawViewActive() { return Boolean(rawViewExit); },
    // The logo band. Given lines it takes exactly their height and pushes the
    // transcript down by that much; given nothing it disappears and the
    // transcript gets the rows back. Every click and selection is measured off
    // the history box's own coordinates, so both follow the move by themselves.
    setLogo(lines) {
      // Whatever was running on the band stops here: a loop left ticking would
      // paint over the very thing this was called to show.
      stopLogo();
      const rows = Array.isArray(lines) ? lines.length : 0;
      if (rows === 0) {
        logo.setContent('');
        logo.height = 0;
        logo.hide();
      } else {
        logo.setContent(lines.join('\n'));
        logo.height = rows;
        logo.show();
      }
      logoRule.top = 2 + rows;
      history.top = 2 + rows + 1;
      tailIfFollowing();
      render();
      return rows > 0;
    },
    // The width blessed actually draws with. `process.stdout.columns` disagrees
    // with it under tmux at startup, and the frame is what has to fit.
    width() { return screen.width; },
    height() { return screen.height; },
    onResize(cb) { screen.on('resize', cb); },
    // The same band, arriving frame by frame. The band is sized from the last
    // frame up front, so the transcript is not shoved down a row at a time while
    // the sweep runs; the timer is a chain of timeouts rather than an interval,
    // because a slow paint must delay the next frame instead of stacking behind
    // it. Replaying cancels whatever was still running: two sweeps on one band
    // would fight over the same rows.
    playLogo(frames, { interval = LOGO_FRAME_MS, loop = false, onDone = null } = {}) {
      if (!Array.isArray(frames) || frames.length === 0) return false;
      stopLogo();
      const last = frames[frames.length - 1];
      logo.height = last.length;
      logo.show();
      logoRule.top = 2 + last.length;
      history.top = 2 + last.length + 1;
      let index = 0;
      const step = () => {
        logoTimer = null;
        if (destroyed) return;
        logo.setContent(frames[index].join('\n'));
        render();
        index += 1;
        if (index >= frames.length) {
          // A one-shot leaves its last frame on the band — which is why the last
          // frame of the sweep is the plain logo. A loop starts over; either way
          // the caller may want to know it is over, to decide what shows next.
          if (!loop) return onDone?.();
          index = 0;
        }
        logoTimer = setTimeout(step, interval);
        logoTimer.unref?.();
        return undefined;
      };
      step();
      return true;
    },
    // The scanline plays once; the living scene then loops until its owner
    // presses a key or clicks. A slow phosphor pulse moves independently of the
    // twinkling sky.
    playSaverScreen(
      frames,
      {
        intro = [], interval = LOGO_FRAME_MS, introInterval = 55,
        // Only an automatic saver hands the mouse a way out; see `saverWakeOnMouse`.
        wakeOnMouse = false,
      } = {},
    ) {
      if (!Array.isArray(frames) || frames.length === 0) return false;
      // Over a secret prompt the saver would hide the card while keys still
      // went into it — typing blind under a picture.
      if (!lockScreen.hidden && lockState?.kind === 'secret') return false;
      const opening = Array.isArray(intro) ? intro : [];
      const sequence = [...opening, ...frames];
      stopSaverTimer();
      saverGeometry = {
        width: Math.max(...frames[0].map((row) => [...row].length)),
        height: frames[0].length,
      };
      saverWakeOnMouse = Boolean(wakeOnMouse);
      // The mouse can only end it if the terminal reports the mouse at all, and
      // by default tailchat leaves it to the terminal so selection works. Borrow
      // it for as long as this saver is up; `closeSaver` gives it back.
      if (saverWakeOnMouse && saverMouseWas === null) {
        saverMouseWas = mouseCaptured;
        if (!mouseCaptured) setMouseCapture(true);
      }
      saverScreen.show();
      screen.lockKeys = true;
      let index = 0;
      let glow = 0;
      const step = () => {
        saverTimer = null;
        if (destroyed || saverScreen.hidden) return;
        const openingFrame = index < opening.length;
        saverScreen.setContent(sequence[index].join('\n'));
        if (themed) saverScreen.style.fg = SAVER_GLOW[glow % SAVER_GLOW.length];
        render();
        glow += 1;
        index += 1;
        if (index >= sequence.length) index = opening.length;
        saverTimer = setTimeout(step, openingFrame ? introInterval : interval);
        saverTimer.unref?.();
      };
      step();
      return true;
    },
    // Focus returning on its own — not a key — also ends an automatic saver.
    // No `activityCb` here: the caller already reported the focus event.
    hideSaverScreen() { closeSaver(false); },
    showLockScreen({ verifyPassword = () => true, onUnlock = () => {}, hasPass = true, t = null } = {}) {
      if (!lockScreen.hidden) return false;
      if (!saverScreen.hidden) closeSaver(false);
      lockState = {
        kind: 'lock',
        verifyPassword,
        onUnlock,
        hasPass,
        t,
        entered: '',
        error: false,
        openedBy: keypressSeq,
      };
      lockScreen.show();
      lockScreen.setFront();
      screen.lockKeys = true;
      renderLockContent();
      return true;
    },
    // A masked one-line prompt over the whole screen, for a secret that must not
    // pass through the composer — a recovery key, a password. Resolves with what
    // was typed or pasted on Enter, or null on Esc, on `destroy()`, or when the
    // lock or another prompt already holds the screen. The text is never drawn
    // (bullets only) and never reaches the draft or the input history; keys come
    // through the same single keypress path as the lock screen (AGENTS §1–2).
    promptSecret({ title = '', subtitle = '', prompt = '', hint = '' } = {}) {
      if (destroyed || !lockScreen.hidden) return Promise.resolve(null);
      if (!saverScreen.hidden) closeSaver(false);
      return new Promise((resolve) => {
        lockState = {
          kind: 'secret',
          title,
          subtitle,
          prompt,
          hint,
          hasPass: true,
          entered: '',
          error: false,
          openedBy: keypressSeq,
          settle: resolve,
        };
        lockScreen.show();
        lockScreen.setFront();
        screen.lockKeys = true;
        renderLockContent();
      });
    },
    secretPromptOpen() { return !lockScreen.hidden && lockState?.kind === 'secret'; },
    // What the lock / prompt card draws — the contract "bullets, never the
    // text" is asserted on this, not on internal state.
    overlayContent() { return lockScreen.hidden ? '' : lockScreen.getContent(); },
    hideLockScreen() {
      // The lock only: a timer that hides "the lock" must not cancel a prompt.
      if (lockState?.kind === 'secret') return;
      closeLockScreen();
    },
    isLocked() { return !lockScreen.hidden; },
    saverActive() { return !saverScreen.hidden; },
    // Whether the frames in flight still fit the window they are playing in.
    // False after a resize means the picture would wrap: re-pick or close.
    saverFits() {
      if (!saverGeometry) return true;
      return screen.width >= saverGeometry.width && screen.height >= saverGeometry.height;
    },
    logoRows() { return logo.hidden ? 0 : logo.height; },
    clearHistory() {
      history.setContent(historyBuffer.clear());
      history.scrollTo(0);
      followTail = true;
      render();
    },
    clear() {
      history.setContent(historyBuffer.clear());
      history.scrollTo(0);
      followTail = true;
      render();
    },
    setDraft(text) {
      editor.setValue(safeTerminalText(text));
      syncComposer();
      render();
    },
    composerRows() { return draftRows(); },
    // Exposed so the caret contract can be asserted without a real terminal.
    draft() { return editor.value(); },
    composerContent() { return composer.value; },
    // The rule carries both passing indicators, so what it says is a contract
    // worth asserting without a terminal to read it off. Markup and all: the
    // shimmer wraps every character, so a caller that wants the words strips it.
    composerRuleContent() { return composerRule.content; },
    // Exposed for the same reason composerRuleContent is: the info panel's
    // presence and content are a contract worth asserting without a real
    // wide terminal to look at.
    infoPanelShown() { return infoPanelShown(); },
    infoPanelContent() { return infoPanel.content; },
    cursorCell() { return cursorCell(); },
    draftScroll() { return composer.childBase || 0; },
    clearDraft() {
      editor.clear();
      repaint();
      syncComposer();
      render();
    },
    setStatus(text) {
      status = text;
      render();
    },
    // The completion menu reads the same table the dispatcher does, so a new
    // command can never be missing from it.
    setCommands(list) {
      commandList = Array.isArray(list) ? list : [];
      render();
    },
    setUpdateAvailable(value) {
      const next = Boolean(value);
      if (next === updateAvailable) return;
      updateAvailable = next;
      render();
    },
    // The modal list /peer drives: same widget, same keys, same colours as the
    // command completion it borrows. Resolves the chosen row's `value` (or its
    // `name`), or null when the list is dismissed.
    pickFromList({ label = 'menu', rows = [] }) {
      return new Promise((resolve) => {
        picker = { label, rows, resolve };
        menuIndex = 0;
        menuOffset = 0;
        render();
      });
    },
    completionMenu() {
      return matchingCommands().map((c) => c.name);
    },
    completionRows() { return Math.min(MENU_ROWS, matchingCommands().length); },
    // Exposed so the Enter contract can be asserted without a real terminal.
    acceptCompletion() { return acceptCompletion(); },
    selectCompletion(index) { menuIndex = index; render(); },
    isExactCommand(value) { return isExactCommand(value); },
    completionIndex() { return menuIndex; },
    setPeerDevice(name) {
      const next = String(name ?? '');
      if (next === peerDevice) return;
      peerDevice = next;
      render();
    },
    setPeerName(name) {
      peerName = name;
      render();
    },
    setTransport(next) {
      const clean = String(next ?? '');
      if (clean === transportLabel) return;
      transportLabel = clean;
      render();
    },
    setPeerClient(next) {
      const clean = String(next ?? '');
      if (clean === peerClientLabel) return;
      peerClientLabel = clean;
      render();
    },
    setUnreadBadge(summary) {
      const next = String(summary ?? '').trim();
      if (next === unreadSummary) return;
      unreadSummary = next;
      render();
    },
    setRoster(items, activeLogin) {
      const next = Array.isArray(items) ? [...items] : [];
      const nextActive = activeLogin ?? null;
      // A bar the reader scrolled by hand stays where they put it — an unread
      // count arriving must not yank it back. A roster that changed shape (a
      // contact added or removed, another conversation opened) is a different
      // bar, and there the window follows the selection again.
      if (next.length !== rosterItems.length || nextActive !== activeRosterLogin) rosterScrollTop = null;
      rosterItems = next;
      activeRosterLogin = nextActive;
      render();
    },
    setRosterRows(n) {
      const next = clamp(Number(n) || 3, 1, 3);
      if (next === activeRosterRows) return;
      activeRosterRows = next;
      render();
    },
    rosterRows() { return activeRosterRows; },
    onRosterSelect(cb) {
      rosterSelectCb = typeof cb === 'function' ? cb : () => {};
    },
    onPeerPicker(cb) { peerPickerCb = typeof cb === 'function' ? cb : () => {}; },
    isFocused() { return focused; },
    focusTracked() { return focusTracked; },
    __emitFocus(value) { (value ? onFocus : onBlur)(); },
    bell() { screen.program.bell(); },
    onInput(cb) { inputCb = cb; },
    onTyping(cb) { typingCb = cb; },
    setPeerTyping(value, name = null) {
      const next = Boolean(value);
      // No name means the peer themselves; a name is another voice (normally
      // their AI). Each stop removes only the voice named by that frame.
      const voice = typeof name === 'string' && name !== '' ? name : PEER_TYPING_VOICE;
      const active = peerTypingVoices.has(voice);
      if (next === active) return;
      if (next) peerTypingVoices.add(voice);
      else peerTypingVoices.delete(voice);
      syncShimmer();
      render();
    },
    clearPeerTyping() {
      if (peerTypingVoices.size === 0) return;
      peerTypingVoices.clear();
      syncShimmer();
      render();
    },
    setSelfTyping(value) {
      const next = Boolean(value);
      if (next === selfTyping) return;
      selfTyping = next;
      syncShimmer();
      render();
    },
    // The name of the file on its way out, or null when it has left. The rule
    // shows it for as long as the bytes are actually still going.
    setSending(name) {
      const next = name === null || name === undefined ? null : String(name);
      if (next === sending) return;
      sending = next;
      syncShimmer();
      render();
    },
    // The AI's composing name, or null when it is quiet. Same rule and same
    // verb as a person typing — setSending is for bytes, this is for a voice.
    setAiTyping(name) {
      const next = name === null || name === undefined ? null : String(name);
      if (next === aiTyping) return;
      aiTyping = next;
      syncShimmer();
      render();
    },
    sendingLabel() { return sending; },
    shimmerRunning() { return shimmerTimer !== null; },
    setPeerPresence(state) {
      const next = readPresenceState(state);
      if (next === peerPresence) return;
      peerPresence = next;
      render();
    },
    headerStatus() { return headerStatus(); },
    setMouseCapture(enabled) { return setMouseCapture(enabled); },
    isMouseCaptured() { return mouseCaptured; },
    onQuit(cb) { quitCb = cb; },
    onFocusChange(cb) { focusCb = cb; },
    onPasteImage(cb) { pasteImageCb = cb; },
    onMouseToggle(cb) { mouseToggleCb = cb; },
    onPasteText(cb) { pasteTextCb = cb; },
    onCopy(cb) { copyCb = cb; },
    onActivity(cb) { activityCb = cb; },
    onSaverWake(cb) { saverWakeCb = typeof cb === 'function' ? cb : () => {}; },
    onOpenImage(cb) { openImageCb = cb; },
    onOpenLink(cb) { openLinkCb = cb; },
    // Exposed so the selection contract can be asserted without a real mouse.
    selectLines(from, to) {
      anchorLine = from;
      headLine = to;
      render();
    },
    selectionRange() { return selection(); },
    selectedText() {
      return selectedText(history._clines?.fake ?? [], selection(), historyBuffer.copyPadding());
    },
    clearSelection() {
      anchorLine = null;
      headLine = null;
      render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      // A prompt still open answers "nothing" rather than hang its caller.
      const settle = lockState?.settle;
      lockState = null;
      settle?.(null);
      screen.program.resetMode('?2004');
      stopShimmer();
      stopLogo();
      stopEdgeScroll();
      screen.program.removeListener('focus', onFocus);
      screen.program.removeListener('blur', onBlur);
      paste.destroy();
      screen.destroy();
    },
  };
}
