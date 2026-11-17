import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEditor } from '../src/editor.js';

const state = (e) => ({ value: e.value(), cursor: e.cursor() });

test('typing inserts at the cursor and advances it', () => {
  const e = createEditor();
  e.insert('abc');
  assert.deepEqual(state(e), { value: 'abc', cursor: 3 });
});

test('left and right move within the text and stop at the ends', () => {
  const e = createEditor();
  e.insert('abc');
  e.left();
  e.left();
  assert.equal(e.cursor(), 1);
  e.insert('X');
  assert.equal(e.value(), 'aXbc', 'insertion happens at the cursor, not the end');

  e.home();
  e.left();
  assert.equal(e.cursor(), 0, 'cursor never goes negative');
  e.end();
  e.right();
  assert.equal(e.cursor(), 4, 'cursor never passes the end');
});

test('backspace removes before the cursor, delete removes at it', () => {
  const e = createEditor();
  e.insert('abcd');
  e.left();          // between c and d
  e.backspace();     // removes c
  assert.deepEqual(state(e), { value: 'abd', cursor: 2 });
  e.del();           // removes d
  assert.deepEqual(state(e), { value: 'ab', cursor: 2 });
  e.del();           // nothing to the right
  assert.deepEqual(state(e), { value: 'ab', cursor: 2 });
});

test('editing treats an astral emoji as one unit', () => {
  const e = createEditor();
  e.insert('a🚀b');
  e.left();          // before b
  e.backspace();     // must remove the whole rocket, not half a surrogate pair
  assert.equal(e.value(), 'ab');

  e.setValue('🚀🚀');
  e.end();
  e.left();
  assert.equal(e.cursor(), 1, 'one step skips the whole pair');
  assert.equal(e.value().length, 4, 'the string still holds two surrogate pairs');
});

test('home and end work per line in a multiline draft', () => {
  const e = createEditor();
  e.insert('one\ntwo');
  e.home();
  assert.equal(e.cursor(), 4, 'home stops at the start of the current line');
  e.end();
  assert.equal(e.cursor(), 7);
});

test('up and down move between lines keeping the column', () => {
  const e = createEditor();
  e.insert('hello\nworld');
  e.home();
  e.right();
  e.right();         // column 2 on line 2
  e.up();
  assert.equal(e.cursor(), 2, 'same column on the previous line');
  e.down();
  assert.equal(e.cursor(), 8, 'back to the same column on the next line');
});

test('up on a shorter previous line clamps to its end', () => {
  const e = createEditor();
  e.insert('ab\nlonger');
  e.end();           // end of "longer"
  e.up();
  assert.equal(e.cursor(), 2, 'clamped to the end of "ab"');
});

test('up from the first line and down from the last do nothing', () => {
  const e = createEditor();
  e.insert('only');
  const before = e.cursor();
  e.up();
  e.down();
  assert.equal(e.cursor(), before);
});

test('setValue places the cursor at the end and clear resets both', () => {
  const e = createEditor();
  e.setValue('preset');
  assert.deepEqual(state(e), { value: 'preset', cursor: 6 });
  e.clear();
  assert.deepEqual(state(e), { value: '', cursor: 0 });
});

test('cursorPosition reports the line and column for rendering', () => {
  const e = createEditor();
  e.insert('ab\ncdef');
  assert.deepEqual(e.cursorPosition(), { line: 1, column: 4 });
  e.up();
  assert.deepEqual(e.cursorPosition(), { line: 0, column: 2 });
});

test('killLine clears from the cursor to the end of the line', () => {
  const e = createEditor();
  e.insert('keep this away');
  e.home();
  for (let i = 0; i < 5; i++) e.right();
  e.killLine();
  assert.deepEqual(state(e), { value: 'keep ', cursor: 5 });
});

test('killToStart clears from the line start up to the cursor', () => {
  const e = createEditor();
  e.insert('drop this keep');
  e.home();
  for (let i = 0; i < 10; i++) e.right();
  e.killToStart();
  assert.deepEqual(state(e), { value: 'keep', cursor: 0 });
});

test('killWord removes the word before the cursor including its spaces', () => {
  const e = createEditor();
  e.insert('раз два три');
  e.killWord();
  assert.deepEqual(state(e), { value: 'раз два ', cursor: 8 });
  e.killWord();
  assert.deepEqual(state(e), { value: 'раз ', cursor: 4 });
});

test('killWord on trailing spaces removes them with the previous word', () => {
  const e = createEditor();
  e.insert('one two   ');
  e.killWord();
  assert.deepEqual(state(e), { value: 'one ', cursor: 4 });
});

test('kill operations stay within the current line', () => {
  const e = createEditor();
  e.insert('first\nsecond');
  e.home();
  e.killLine();
  assert.equal(e.value(), 'first\n', 'the previous line is untouched');
});
test('a multiline paste collapses to a marker and keeps the full value', () => {
  const ed = createEditor();
  assert.equal(ed.insertPaste('alpha\nbeta'), true);
  assert.equal(ed.value(), 'alpha\nbeta');
  assert.equal(ed.displayValue(), 'pasted 2 lines');
});

test('a single-line paste is a plain insert, not a block', () => {
  const ed = createEditor();
  assert.equal(ed.insertPaste('alpha'), false);
  assert.equal(ed.displayValue(), 'alpha');
});

test('togglePaste expands and re-collapses the block under the cursor', () => {
  const ed = createEditor();
  ed.insertPaste('a\nb\nc');
  assert.equal(ed.displayValue(), 'pasted 3 lines');
  assert.equal(ed.togglePaste(), true);
  assert.equal(ed.displayValue(), 'a\nb\nc');
  assert.equal(ed.cursor(), 5);
  assert.equal(ed.togglePaste(), true);
  assert.equal(ed.displayValue(), 'pasted 3 lines');
  assert.equal(ed.cursor(), 5); // collapsing puts the cursor at the block end
});

test('two pastes stay two separate markers', () => {
  const ed = createEditor();
  ed.insertPaste('a\nb');
  ed.insert(' ');
  ed.insertPaste('c\nd\ne');
  assert.equal(ed.displayValue(), 'pasted 2 lines pasted 3 lines');
  assert.equal(ed.value(), 'a\nb c\nd\ne');
});

test('backspace over a marker deletes the whole block', () => {
  const ed = createEditor();
  ed.insert('hi ');
  ed.insertPaste('a\nb\nc');
  ed.backspace(); // cursor sits at the block end
  assert.equal(ed.value(), 'hi ');
  assert.equal(ed.displayValue(), 'hi ');
});

test('left and right skip a collapsed block as one atom', () => {
  const ed = createEditor();
  ed.insertPaste('a\nb\nc');
  ed.left();
  assert.equal(ed.cursor(), 0);
  ed.right();
  assert.equal(ed.cursor(), 5);
  ed.left();
  assert.equal(ed.cursor(), 0);
});

test('home and end treat a marker as one cell on its line', () => {
  const ed = createEditor();
  ed.insert('hey ');
  ed.insertPaste('a\nb');
  ed.end();
  assert.equal(ed.cursor(), 7); // end of the display line, past the marker
  ed.home();
  assert.equal(ed.cursor(), 0);
});

test('typing after a marker keeps the block intact', () => {
  const ed = createEditor();
  ed.insertPaste('a\nb');
  ed.insert('!');
  assert.equal(ed.value(), 'a\nb!');
  assert.equal(ed.displayValue(), 'pasted 2 lines!');
  ed.backspace();
  assert.equal(ed.value(), 'a\nb');
  assert.equal(ed.displayValue(), 'pasted 2 lines');
});

test('killLine across a marker deletes the whole block', () => {
  const ed = createEditor();
  ed.insertPaste('a\nb');
  ed.insert(' tail');
  ed.left(); ed.left(); ed.left(); ed.left(); ed.left(); // cursor before "tail", after the marker
  assert.equal(ed.cursor(), 3);
  ed.killLine();
  assert.equal(ed.value(), 'a\nb');
  assert.equal(ed.displayValue(), 'pasted 2 lines');
});

test('setValue and clear drop every block', () => {
  const ed = createEditor();
  ed.insertPaste('a\nb');
  ed.setValue('plain');
  assert.equal(ed.displayValue(), 'plain');
  assert.equal(ed.togglePaste(), false);
  ed.insertPaste('a\nb');
  ed.clear();
  assert.equal(ed.value(), '');
  assert.equal(ed.displayValue(), '');
});
