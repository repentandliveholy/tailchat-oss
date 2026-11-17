import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeFrame,
  createFrameParser,
  overflowsFrameLimit,
  MAX_FRAME_CHARS,
} from '../src/frames.js';
import { CHUNK_BYTES } from '../src/files.js';

test('encodeFrame appends newline', () => {
  assert.equal(encodeFrame({ a: 1 }), '{"a":1}\n');
});
test('parser emits one complete frame', () => {
  const got = [];
  const push = createFrameParser((o) => got.push(o));
  push('{"t":"msg","text":"hi"}\n');
  assert.deepEqual(got, [{ t: 'msg', text: 'hi' }]);
});
test('parser reassembles frame split across chunks', () => {
  const got = [];
  const push = createFrameParser((o) => got.push(o));
  push('{"t":"ms');
  push('g","text":"hi"}\n');
  assert.deepEqual(got, [{ t: 'msg', text: 'hi' }]);
});
test('parser emits multiple frames in one chunk', () => {
  const got = [];
  const push = createFrameParser((o) => got.push(o));
  push('{"a":1}\n{"b":2}\n');
  assert.deepEqual(got, [{ a: 1 }, { b: 2 }]);
});
test('parser skips malformed line without throwing', () => {
  const got = [];
  const push = createFrameParser((o) => got.push(o));
  push('not json\n{"ok":true}\n');
  assert.deepEqual(got, [{ ok: true }]);
});
test('parser ignores empty lines', () => {
  const got = [];
  const push = createFrameParser((o) => got.push(o));
  push('\n\n{"a":1}\n');
  assert.deepEqual(got, [{ a: 1 }]);
});
test('parser handles Buffer input (utf8)', () => {
  const got = [];
  const push = createFrameParser((o) => got.push(o));
  push(Buffer.from('{"t":"msg","text":"привет"}\n', 'utf8'));
  assert.deepEqual(got, [{ t: 'msg', text: 'привет' }]);
});
test('parser reassembles multibyte char split across Buffer chunks', () => {
  const got = [];
  const push = createFrameParser((o) => got.push(o));
  const full = Buffer.from('{"t":"msg","text":"привет😀"}\n', 'utf8');
  // Find a byte offset that lands inside a multibyte sequence (continuation byte 0x80-0xBF).
  let cut = -1;
  for (let i = 1; i < full.length; i++) {
    if ((full[i] & 0xc0) === 0x80) { cut = i; break; }
  }
  assert.notEqual(cut, -1);
  push(full.subarray(0, cut));
  push(full.subarray(cut));
  assert.deepEqual(got, [{ t: 'msg', text: 'привет😀' }]);
});

test('overflowsFrameLimit: an unterminated frame is judged on what has arrived', () => {
  assert.equal(overflowsFrameLimit(10, -1, 16), false);
  assert.equal(overflowsFrameLimit(17, -1, 16), true);
});
test('overflowsFrameLimit: a terminated frame is judged on its own length', () => {
  // The frame ends at offset 4, so the 900 characters queued behind it are
  // somebody else's frames and none of its business.
  assert.equal(overflowsFrameLimit(900, 4, 16), false);
  assert.equal(overflowsFrameLimit(900, 17, 16), true);
  assert.equal(overflowsFrameLimit(900, 16, 16), false); // exactly the limit fits
});
test('parser reports an over-limit frame and recovers on the next one', () => {
  const got = [];
  const overflows = [];
  const push = createFrameParser((o) => got.push(o), {
    maxChars: 64,
    onOverflow: (o) => overflows.push(o),
  });
  push(`{"t":"msg","text":"${'x'.repeat(200)}"}\n{"a":1}\n`);
  assert.deepEqual(overflows, [{ size: 221, limit: 64 }]);
  // The oversized frame is dropped whole — never truncated and parsed — and the
  // frame behind it in the same chunk still arrives.
  assert.deepEqual(got, [{ a: 1 }]);
});
test('a peer that never sends a newline is reported once, not per chunk', () => {
  const overflows = [];
  const push = createFrameParser(() => {}, {
    maxChars: 32,
    onOverflow: (o) => overflows.push(o),
  });
  for (let i = 0; i < 100; i++) push('x'.repeat(64));
  assert.equal(overflows.length, 1, 'one refused frame is one report');
  const got = [];
  const resumed = createFrameParser((o) => got.push(o), { maxChars: 32 });
  resumed('x'.repeat(64));
  resumed('more of the same, still no newline');
  resumed('\n{"a":1}\n'); // the frame ends; the parser is back in step
  assert.deepEqual(got, [{ a: 1 }]);
});
test('an over-limit frame without an overflow callback does not throw', () => {
  const got = [];
  const push = createFrameParser((o) => got.push(o), { maxChars: 8 });
  push('{"much":"too long"}\n{"a":1}\n');
  assert.deepEqual(got, [{ a: 1 }]);
});
test('the default ceiling clears a full file chunk with room to spare', () => {
  // A file chunk is the largest legitimate frame there is, so if the default
  // refused one, receiving a file would kill the channel it arrived on.
  const got = [];
  const overflows = [];
  const push = createFrameParser((o) => got.push(o), { onOverflow: (o) => overflows.push(o) });
  const frame = encodeFrame({
    t: 'file-chunk',
    id: 'abcdef0123456789',
    seq: 4095,
    data: Buffer.alloc(CHUNK_BYTES, 0xa5).toString('base64'),
  });
  assert.ok(frame.length < MAX_FRAME_CHARS, `a chunk frame is ${frame.length} chars`);
  push(frame);
  assert.deepEqual(overflows, []);
  assert.equal(got.length, 1);
  assert.equal(Buffer.from(got[0].data, 'base64').length, CHUNK_BYTES);
});
