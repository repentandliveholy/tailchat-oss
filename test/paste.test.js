import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import {
  createPasteInput, looksPasted, compactPastedText, transcriptKeys, MARKER_WAIT_MS,
} from '../src/paste.js';

async function exercise(chunks) {
  const source = new PassThrough();
  const paste = createPasteInput(source);
  const values = [];
  let forwarded = '';
  paste.onPaste((value) => values.push(value));
  paste.input.setEncoding('utf8');
  paste.input.on('data', (chunk) => { forwarded += chunk; });
  const ended = once(paste.input, 'end');
  for (const chunk of chunks) source.write(chunk);
  source.end();
  await ended;
  return { values, forwarded };
}

test('normal bytes pass through unchanged', async () => {
  const result = await exercise([Buffer.from('hello')]);
  assert.equal(result.forwarded, 'hello');
  assert.deepEqual(result.values, []);
});

test('multiline bracketed paste is emitted once and never forwarded as Enter', async () => {
  const result = await exercise([
    Buffer.from('\x1b[20'),
    Buffer.from('0~первая\r\nвторая\n'),
    Buffer.from('\x1b[201~'),
  ]);
  assert.deepEqual(result.values, ['первая\nвторая\n']);
  assert.equal(result.forwarded, '');
});

test('paste markers may split at every byte boundary', async () => {
  const start = Buffer.from('\x1b[200~');
  const end = Buffer.from('\x1b[201~');
  const payload = Buffer.from('😀 alpha\rbravo');

  for (let startSplit = 1; startSplit < start.length; startSplit++) {
    for (let endSplit = 1; endSplit < end.length; endSplit++) {
      const result = await exercise([
        start.subarray(0, startSplit),
        start.subarray(startSplit),
        payload.subarray(0, 3),
        payload.subarray(3),
        end.subarray(0, endSplit),
        end.subarray(endSplit),
      ]);
      assert.deepEqual(result, {
        values: ['😀 alpha\nbravo'],
        forwarded: '',
      });
    }
  }
});

// The live input, not `exercise`: these are about what arrives *before* the
// source ends, which is when a person presses a key and waits.
function liveInput() {
  const source = new PassThrough();
  const paste = createPasteInput(source);
  const forwarded = [];
  const values = [];
  paste.onPaste((value) => values.push(value));
  paste.input.on('data', (chunk) => forwarded.push(chunk.toString('utf8')));
  return { source, paste, forwarded, values };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a lone Esc reaches the screen on its own, not glued to the next key', async () => {
  const { source, paste, forwarded } = liveInput();
  try {
    source.write('\x1b');
    await wait(MARKER_WAIT_MS + 30);
    // Before the fix it sat here until the next key and left as "\x1bj" —
    // blessed's Alt+J: Esc did nothing and the J was lost.
    assert.deepEqual(forwarded, ['\x1b']);
    source.write('j');
    await wait(10);
    assert.deepEqual(forwarded, ['\x1b', 'j']);
  } finally {
    paste.destroy();
  }
});

test('a marker split across writes inside the wait is still a paste', async () => {
  const { source, paste, forwarded, values } = liveInput();
  try {
    source.write('\x1b[2');
    await wait(Math.floor(MARKER_WAIT_MS / 3));
    source.write('00~key\x1b[201~');
    await wait(MARKER_WAIT_MS + 30);
    assert.deepEqual(values, ['key']);
    assert.deepEqual(forwarded, []);
  } finally {
    paste.destroy();
  }
});

test('Alt+key and arrow keys, written whole, pass through untouched and at once', async () => {
  const { source, paste, forwarded } = liveInput();
  try {
    source.write('\x1bj');
    source.write('\x1b[B');
    await wait(5);
    assert.equal(forwarded.join(''), '\x1bj\x1b[B');
  } finally {
    paste.destroy();
  }
});

test('ordinary bytes surrounding paste remain ordered', async () => {
  const result = await exercise([
    Buffer.from('before'),
    Buffer.from('\x1b[200~one\ntwo\x1b[201~'),
    Buffer.from('after'),
  ]);
  assert.deepEqual(result, {
    values: ['one\ntwo'],
    forwarded: 'beforeafter',
  });
});

test('a chunk carrying a line break and real text was pasted, not typed', () => {
  // Terminals without bracketed paste deliver a paste as plain keystrokes, and
  // every newline in it would otherwise fire Enter and split one block into a
  // dozen messages. The operating system hands a paste over in one chunk.
  assert.equal(looksPasted(Buffer.from('npm error ENOENT\r~ $ ')), true);
  assert.equal(looksPasted(Buffer.from('one\ntwo')), true, 'text after a break');
  assert.equal(looksPasted(Buffer.from('one\ntwo\n')), true, 'more than one break');

  // Typing ends the chunk at Enter, however fast the person is, so a trailing
  // line break with nothing after it must still send the draft.
  assert.equal(looksPasted(Buffer.from('a')), false);
  assert.equal(looksPasted(Buffer.from('\r')), false);
  assert.equal(looksPasted(Buffer.from('ab\r')), false);
  assert.equal(looksPasted(Buffer.from('a whole typed sentence\r')), false);
  // An escape sequence is several bytes at once but carries no line break.
  assert.equal(looksPasted(Buffer.from('\x1b[A')), false);
});

test('an unbracketed multiline paste is delivered whole, not as keystrokes', async () => {
  const source = new PassThrough();
  const paste = createPasteInput(source);
  const pasted = [];
  const passedThrough = [];
  paste.onPaste((text) => pasted.push(text));
  paste.input.on('data', (chunk) => passedThrough.push(chunk.toString('utf8')));

  source.write('line one\rline two\r~ $ ');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(pasted, ['line one\nline two\n~ $ ']);
  assert.deepEqual(passedThrough, [], 'nothing reaches the key handler as Enter');
  paste.destroy();
});

test('pasted terminal output is compacted to one blank line between blocks', () => {
  const messy = 'npm error ENOENT\r\n\r\n\r\n\r\nnpm error no such file   \r\n\r\n\r\n~ $ ';
  assert.equal(
    compactPastedText(messy),
    'npm error ENOENT\n\nnpm error no such file\n\n~ $',
  );
});

test('compacting keeps single blank lines and drops the surrounding ones', () => {
  assert.equal(compactPastedText('\n\n\nтекст\n\nещё\n\n\n'), 'текст\n\nещё');
  assert.equal(compactPastedText('одна строка'), 'одна строка');
  assert.equal(compactPastedText(''), '');
  // Indentation is meaning in pasted code, so only trailing space is stripped.
  assert.equal(compactPastedText('  keep\ttrailing gone   '), '  keep\ttrailing gone');
});

test('a key ignores the wrap, so a copy keys the same however it broke', () => {
  // The first is what the terminal hands over once blessed has wrapped the
  // message — cut mid-token, because no space was within ten characters of the
  // edge. The second is the same message on one line.
  const wrapped = [
    '  [16:48] {you} see https://example.com/ve',
    '  ry/long/path and electronic typesettin',
    '  g, remaining ✓',
  ].join('\n');
  const whole = '  [16:48] {you} see https://example.com/very/long/path'
    + ' and electronic typesetting, remaining ✓';
  assert.deepEqual(transcriptKeys(wrapped, ['you']), transcriptKeys(whole, ['you']));
});

test('a timestamp before its receipt still identifies the copied message', () => {
  const copied = '  {you} delivered text [16:48] ✓✓';
  assert.deepEqual(transcriptKeys(copied, ['you']), ['deliveredtext']);
});

// The ladder's ⚠ ends a failed message's line exactly as ✓/⧗ end the others: a
// copy of it must still identify the message, not carry the glyph into the key.
test('every rung of the ladder, ⚠ included, is stripped from the tail of a copied message', () => {
  for (const marker of ['⧗', '✓', '✓✓', '⚠']) {
    assert.deepEqual(transcriptKeys(`  {you} some words [16:48] ${marker}`, ['you']), ['somewords'], marker);
    assert.deepEqual(transcriptKeys(`  {you} some words ${marker}`, ['you']), ['somewords'], marker);
    assert.deepEqual(transcriptKeys(`  [16:48] {you} some words ${marker}`, ['you']), ['somewords'], marker);
  }
});

test('each message in a copy gets its own key', () => {
  const two = [
    '  [16:48] {you} first one ✓',
    '  [16:49] {Roman} second',
    '  one',
  ].join('\n');
  assert.deepEqual(transcriptKeys(two, ['you', 'Roman']), ['firstone', 'secondone']);
});

test('a paste with no head of its own is not a quote', () => {
  // A log line starts with a time, and a table is indented, but neither carries
  // the head this conversation writes.
  assert.equal(transcriptKeys('12:35 Roman: jkdsklj\n12:36 godsheep: __test__', ['you', 'Roman']), null);
  assert.equal(transcriptKeys('100.71.187.60   lit   linux   -', ['you', 'Roman']), null);
  // Text above the first head belongs to something else entirely.
  assert.equal(transcriptKeys('look at this:\n  [16:48] {you} one ✓', ['you']), null);
  // Without a name there is nothing to recognise a head by.
  assert.equal(transcriptKeys('  [16:48] {you} one ✓', []), null);
});
