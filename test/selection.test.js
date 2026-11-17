import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripSgr,
  selectionRange,
  rangeCovers,
  selectedText,
  edgeScroll,
} from '../src/selection.js';

test('a selection dragged upwards covers the same lines as one dragged down', () => {
  // The anchor is wherever the button went down, which is as often below the
  // head as above it. A range that only counted forwards would copy nothing.
  assert.deepEqual(selectionRange(7, 3), { from: 3, to: 7 });
  assert.deepEqual(selectionRange(3, 7), { from: 3, to: 7 });
  assert.deepEqual(selectionRange(5, 5), { from: 5, to: 5 });
  assert.equal(selectionRange(null, 4), null);
});

test('copied text carries no terminal control codes', () => {
  // blessed turns its tags into real SGR sequences inside the lines it lays out,
  // so copying them verbatim would paste escape codes into the next window.
  const lines = [
    '\x1b[32m12:00\x1b[39m you  \x1b[1mhello\x1b[22m',
    '\x1b[36m12:01\x1b[39m Roman  answer',
  ];
  assert.equal(
    selectedText(lines, { from: 0, to: 1 }),
    '12:00 you  hello\n12:01 Roman  answer',
  );
  assert.equal(stripSgr('\x1b[30m\x1b[42mx\x1b[49m'), 'x');
});

test('copied text keeps indentation but drops the padding of the frame', () => {
  // A pasted code block is worthless without its leading spaces; the trailing
  // ones only exist because the transcript is drawn inside a box.
  const lines = ['    if (x) {          ', '      run();     '];
  assert.equal(selectedText(lines, { from: 0, to: 1 }), '    if (x) {\n      run();');
});

test('a range asked for more lines than exist stops at the end', () => {
  // The last drag position can outlive the lines under it when the transcript
  // is short or has just been cleared.
  assert.equal(selectedText(['one', 'two'], { from: 1, to: 40 }), 'two');
  assert.equal(selectedText(['one'], null), '');
  assert.equal(selectedText(null, { from: 0, to: 1 }), '');
});

test('a line is inside a range only between its ends', () => {
  const range = { from: 4, to: 6 };
  assert.deepEqual([3, 4, 5, 6, 7].map((n) => rangeCovers(range, n)), [
    false, true, true, true, false,
  ]);
  assert.equal(rangeCovers(null, 4), false);
});

test('the view only scrolls when the pointer is held at an edge', () => {
  // Scrolling anywhere else would make an ordinary selection slide away from
  // under the pointer.
  assert.equal(edgeScroll(3, 3, 19), -1);
  assert.equal(edgeScroll(2, 3, 19), -1);
  assert.equal(edgeScroll(11, 3, 19), 0);
  assert.equal(edgeScroll(19, 3, 19), 1);
  assert.equal(edgeScroll(25, 3, 19), 1);
});
