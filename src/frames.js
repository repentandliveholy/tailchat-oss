import { StringDecoder } from 'node:string_decoder';

// The largest legitimate frame in this protocol is a file chunk: CHUNK_BYTES
// (48 KiB) of payload travels base64-encoded, which is 64 KiB of characters,
// wrapped in a JSON envelope carrying a transfer id and a sequence number.
// 256 KiB clears that four times over, and every other frame — a message, a
// receipt, the device list — is smaller by orders of magnitude. What the ceiling
// buys is that a peer streaming bytes that never contain a newline, whether out
// of malice or through a wedged encoder on its side, can no longer grow this
// buffer until the process is killed by the kernel.
export const MAX_FRAME_CHARS = 256 * 1024;

export function encodeFrame(obj) {
  return JSON.stringify(obj) + '\n';
}

// Takes the sizes rather than the buffer so the caller's own `indexOf` is not
// repeated: `terminatedAt` is the offset of the first newline, or -1 while the
// frame is still arriving. The ceiling counts UTF-16 code units instead of bytes
// because that is what the buffer actually costs in memory, and for the base64
// payload that dominates a large frame the two numbers are the same anyway.
export function overflowsFrameLimit(buffered, terminatedAt, limit) {
  // A newline inside the window means the frame is complete and legal, however
  // much unread data follows it: the ceiling is per frame, not per chunk.
  return terminatedAt === -1 ? buffered > limit : terminatedAt > limit;
}

export function createFrameParser(onFrame, { maxChars = MAX_FRAME_CHARS, onOverflow = null } = {}) {
  let buf = '';
  // An over-limit frame is dropped whole rather than truncated and parsed: a
  // truncated frame is indistinguishable from a forged one. Everything the peer
  // sends until the next newline still belongs to that frame, so the parser
  // stays in this state and reports the overflow once per frame instead of once
  // per chunk, then resynchronises on the following frame boundary.
  let skipping = false;
  const decoder = new StringDecoder('utf8');
  return function push(chunk) {
    buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    for (;;) {
      const idx = buf.indexOf('\n');
      if (skipping) {
        if (idx === -1) { buf = ''; return; } // the refused frame is still coming
        buf = buf.slice(idx + 1);
        skipping = false;
        continue;
      }
      if (overflowsFrameLimit(buf.length, idx, maxChars)) {
        skipping = true;
        // What an over-limit peer deserves is the caller's decision — session.js
        // drops the channel — but the parser has to be usable either way, so it
        // recovers on its own regardless of what the callback does.
        onOverflow?.({ size: idx === -1 ? buf.length : idx, limit: maxChars });
        continue;
      }
      if (idx === -1) return;
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.length === 0) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // skip malformed frame
      }
      onFrame(obj);
    }
  };
}
