import { Transform } from 'node:stream';

const START = Buffer.from('\x1b[200~');
const END = Buffer.from('\x1b[201~');
// How long a chunk that ends in what could be the start of a paste marker
// (`\x1b`, `\x1b[`, `\x1b[2`…) waits for the rest before it is let through as
// typed. A terminal writes the whole marker at once, so the wait never splits a
// real one; without it, a lone Esc keystroke sat in `pending` until the next
// key arrived and was then delivered glued to it (`\x1bj`, which blessed reads
// as Alt+J) — Esc did nothing, and the key after it was lost.
export const MARKER_WAIT_MS = 50;

function longestMarkerPrefixAtEnd(data, marker) {
  const limit = Math.min(data.length, marker.length - 1);
  for (let length = limit; length > 0; length--) {
    if (data.subarray(data.length - length).equals(marker.subarray(0, length))) {
      return length;
    }
  }
  return 0;
}
// Terminals that do not implement bracketed paste (Windows Terminal over RDP
// among them) deliver a paste as ordinary keystrokes, so every newline in it
// arrives as Enter and one pasted block explodes into a dozen messages. A file
// dragged onto the window arrives the same way, as a bare path.
//
// The evidence is the shape of the chunk. A person pressing Enter ends the read
// there — the terminal cannot know what they will type next — so text after a
// line break can only have arrived together. Without a break, sheer size gives
// it away: a tty delivers keystrokes one at a time, and no one types sixteen
// characters inside a single read.
const PASTE_MIN_BYTES = 16;

export function looksPasted(data) {
  const text = data.toString('utf8');
  const breaks = (text.match(/[\r\n]/g) ?? []).length;
  if (breaks === 0) {
    // Escape sequences arrive whole and are short; anything this long is text.
    return text.length >= PASTE_MIN_BYTES && !text.startsWith('\x1b');
  }
  return breaks > 1 || /[\r\n][\s\S]/.test(text);
}

// Terminal output is full of blank lines and trailing spaces that carry no
// meaning once it lands in a chat. One blank line separates paragraphs; a run
// of six just pushes the conversation off the screen.
export function compactPastedText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

// A copy taken out of the transcript cannot be folded back from its own rows.
// blessed breaks a line wherever the width runs out and looks only ten
// characters back for a space (element.js:688), so a long word or a URL is cut
// mid-token; and where it does break on a space, that space ends the row, which
// the terminal trims away on the trip to the clipboard. The two seams arrive
// looking exactly alike, so no amount of rejoining is honest.
//
// What the rows can still do is name the message, and the app holds every
// message verbatim. Dropping the head and then every space leaves a key to look
// it up with — which is why a cut mid-token does no harm here.
//
// The head is also the evidence that this is a transcript at all, and it is
// built from the names on this conversation. New transcripts put the clock at
// the tail; the former clock-first form remains recognisable so a copied older
// conversation still quotes correctly.
export function matchKey(text) {
  return String(text ?? '').replace(/\s+/g, '');
}

function transcriptHead(names) {
  const who = names
    .filter(Boolean)
    .map((name) => String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (who.length === 0) return null;
  return new RegExp(`^(?:\\[\\d{2}:\\d{2}\\] )?\\{(?:${who.join('|')})\\} (?=\\S)`);
}

// One key per message in the block, or null when this is not a quote at all.
export function transcriptKeys(text, names = []) {
  const head = transcriptHead(names);
  if (!head) return null;
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const messages = [];
  for (const line of lines) {
    // The left margin and the hanging indent are layout, not content, and the
    // key ignores spacing anyway.
    const bare = line.replace(/^\s+/, '');
    const start = head.exec(bare);
    if (start) messages.push([bare.slice(start[0].length)]);
    else if (messages.length > 0) messages[messages.length - 1].push(bare);
    // Anything before the first head belongs to something else entirely.
    else if (bare !== '') return null;
  }
  if (messages.length === 0) return null;
  // Current messages put the clock before an optional delivery marker. Accept
  // the former marker-before-clock form and marker-only tails too, so copied
  // transcripts remain quoteable across the presentation change.
  const TRAILING_CLOCK = /(?:\s(?:⧗|⚠|→|✓{1,2}))?\s\[\d{2}:\d{2}\](?:\s(?:⧗|⚠|→|✓{1,2}))?$/;
  const TRAILING_MARKER = /\s(?:⧗|⚠|→|✓{1,2})$/;
  return messages.map((rows) => {
    const last = rows.length - 1;
    rows[last] = rows[last].replace(TRAILING_CLOCK, '').replace(TRAILING_MARKER, '');
    return matchKey(rows.join(''));
  });
}

export function createPasteInput(source) {
  let state = 'normal';
  let pending = Buffer.alloc(0);
  let pasteChunks = [];
  let markerTimer = null;
  const callbacks = new Set();
  const stopMarkerTimer = () => {
    if (markerTimer) clearTimeout(markerTimer);
    markerTimer = null;
  };

  const input = new Transform({
    transform(chunk, encoding, done) {
      stopMarkerTimer();
      let data = Buffer.concat([
        pending,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding),
      ]);
      pending = Buffer.alloc(0);

      while (data.length > 0) {
        const marker = state === 'normal' ? START : END;
        const markerAt = data.indexOf(marker);
        if (markerAt !== -1) {
          const body = data.subarray(0, markerAt);
          if (state === 'normal') {
            if (body.length > 0) this.push(body);
            state = 'paste';
            pasteChunks = [];
          } else {
            if (body.length > 0) pasteChunks.push(body);
            const value = Buffer.concat(pasteChunks)
              .toString('utf8')
              .replace(/\r\n?/g, '\n');
            for (const callback of callbacks) callback(value);
            state = 'normal';
            pasteChunks = [];
          }
          data = data.subarray(markerAt + marker.length);
          continue;
        }

        const suffixLength = longestMarkerPrefixAtEnd(data, marker);
        const body = data.subarray(0, data.length - suffixLength);
        if (body.length > 0) {
          if (state === 'normal') {
            if (looksPasted(body)) {
              for (const callback of callbacks) {
                callback(body.toString('utf8').replace(/\r\n?/g, '\n'));
              }
            } else {
              this.push(body);
            }
          } else {
            pasteChunks.push(body);
          }
        }
        pending = data.subarray(data.length - suffixLength);
        break;
      }
      // Only outside a paste: inside one, a partial END is just paste text
      // still arriving, and the paste is not over until END is whole.
      if (state === 'normal' && pending.length > 0) {
        markerTimer = setTimeout(() => {
          markerTimer = null;
          if (state !== 'normal' || pending.length === 0 || input.destroyed) return;
          const held = pending;
          pending = Buffer.alloc(0);
          input.push(held);
        }, MARKER_WAIT_MS);
        markerTimer.unref?.();
      }
      done();
    },
    flush(done) {
      stopMarkerTimer();
      if (state === 'normal') {
        if (pending.length > 0) this.push(pending);
      } else {
        // Preserve an incomplete control sequence if the source closes midway.
        this.push(Buffer.concat([START, ...pasteChunks, pending]));
      }
      pending = Buffer.alloc(0);
      pasteChunks = [];
      done();
    },
  });

  Object.defineProperties(input, {
    isTTY: { configurable: true, get: () => source.isTTY },
    isRaw: { configurable: true, get: () => source.isRaw },
    columns: { configurable: true, get: () => source.columns },
    rows: { configurable: true, get: () => source.rows },
  });
  input.setRawMode = (enabled) => {
    source.setRawMode?.(enabled);
    return input;
  };

  source.pipe(input);

  return {
    input,
    onPaste(callback) {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    destroy() {
      stopMarkerTimer();
      callbacks.clear();
      source.unpipe(input);
      input.destroy();
    },
  };
}
