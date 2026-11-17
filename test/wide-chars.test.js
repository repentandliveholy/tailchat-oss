import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import '../src/wide-chars.js';
import blessed from 'blessed';
import unicode from 'blessed/lib/unicode.js';

test('astral emoji measure two cells like a terminal paints them', () => {
  assert.equal(unicode.strWidth('🚀'), 2);
  assert.equal(unicode.strWidth('😀'), 2);
  assert.equal(unicode.strWidth('🎉'), 2);
  assert.equal(unicode.strWidth('🚀🚀🚀'), 6);
  assert.equal(unicode.strWidth('⏰'), 2, 'alarm clock emoji is wide');
  assert.equal(unicode.strWidth('✅'), 2, 'check mark emoji is wide');
  assert.equal(unicode.strWidth('⚠️'), 2, 'warning emoji is wide');
  assert.equal(unicode.strWidth('🎙'), 2, 'microphone emoji is wide');
});
test('patch leaves narrow and CJK widths untouched', () => {
  assert.equal(unicode.strWidth('a'), 1);
  assert.equal(unicode.strWidth('привет'), 6);
  assert.equal(unicode.strWidth('中'), 2, 'CJK stays double-width');
  assert.equal(unicode.strWidth('❤'), 1, 'text-presentation heart stays single');
});

test('wide-char regex covers emoji surrogates so filler cells are inserted', () => {
  const all = new RegExp(unicode.chars.all.source, 'g');
  assert.match('🚀', all, 'emoji must be recognised as wide');
  const cjkExtension = new RegExp(unicode.chars.all.source, 'g');
  assert.match('\u{20000}', cjkExtension, 'existing CJK extension must still match');
});

test('blessed wraps an emoji run inside the widget instead of past it', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 40;
  output.rows = 12;
  output.resume();

  const screen = blessed.screen({
    input, output, terminal: 'xterm-256color', fullUnicode: true,
  });
  try {
    const box = blessed.box({
      parent: screen, top: 0, left: 0, width: 22, height: 10, tags: false,
    });
    // 20 rockets = 40 cells, so a 22-wide box must use at least two rows.
    box.setContent('🚀'.repeat(20));
    screen.render();
    assert.ok(
      box._clines.length >= 2,
      `emoji run must wrap, got ${box._clines.length} line(s)`,
    );
    const firstRow = screen.lines[0].slice(0, 22).map((cell) => cell[1]).join('');
    assert.ok(
      !firstRow.includes('🚀'.repeat(15)),
      'a single row must not absorb the whole emoji run',
    );
  } finally {
    screen.destroy();
  }
});

test('keypress deduplication: 1 key press results in exactly 1 keypress event across multi-screen flows and readline', async () => {
  const readline = (await import('node:readline')).default;

  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;

  // 1. First-run wizard or prompt uses readline
  const rl = readline.createInterface({ input, output });
  rl.close();

  // 2. Peer menu / setup uses blessed screen 1
  const screen1 = blessed.screen({ input, output });
  screen1.destroy();

  // 3. Cloud sign-in / picker uses blessed screen 2
  const screen2 = blessed.screen({ input, output });
  const received = [];
  screen2.program.on('keypress', (ch, key) => {
    received.push({ ch, name: key?.name });
  });

  input.write('r');
  input.write('o');
  input.write('m');
  input.write('a');
  input.write('n');

  assert.equal(received.length, 5, '5 key presses must yield exactly 5 keypress events');
  assert.deepEqual(received.map((r) => r.ch), ['r', 'o', 'm', 'a', 'n']);

  screen2.destroy();
});

test('wide-chars normalizes Opt+Tab and Ctrl+Tab escape sequences without breaking plain Tab', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;

  const prog = blessed.program({ input, output });
  const keysEmitted = [];
  prog.on('keypress', (ch, key) => {
    keysEmitted.push(key);
  });

  // Opt+Tab via ESC+TAB
  input.write('\x1b\t');
  // Opt+Tab via Kitty sequence
  input.write('\x1b[9;3u');
  // Shift+Opt+Tab via ESC+backtab
  input.write('\x1b\x1b[Z');
  // Ctrl+Tab via CSI u
  input.write('\x1b[1;5I');
  // Plain Tab
  input.write('\t');
  // Plain Shift+Tab
  input.write('\x1b[Z');

  assert.equal(keysEmitted.length, 6);
  // 1. Opt+Tab: name=tab, meta=true, ctrl=false, shift=false
  assert.equal(keysEmitted[0].name, 'tab');
  assert.equal(keysEmitted[0].meta, true);
  assert.equal(keysEmitted[0].ctrl, false);
  assert.equal(keysEmitted[0].shift, false);

  // 2. Opt+Tab Kitty: name=tab, meta=true, ctrl=false, shift=false
  assert.equal(keysEmitted[1].name, 'tab');
  assert.equal(keysEmitted[1].meta, true);
  assert.equal(keysEmitted[1].ctrl, false);
  assert.equal(keysEmitted[1].shift, false);

  // 3. Shift+Opt+Tab: name=tab, meta=true, shift=true
  assert.equal(keysEmitted[2].name, 'tab');
  assert.equal(keysEmitted[2].meta, true);
  assert.equal(keysEmitted[2].shift, true);

  // 4. Ctrl+Tab: name=tab, ctrl=true, meta=false
  assert.equal(keysEmitted[3].name, 'tab');
  assert.equal(keysEmitted[3].ctrl, true);
  assert.equal(keysEmitted[3].meta, false);

  // 5. Plain Tab: name=tab, meta=false, ctrl=false, shift=false
  assert.equal(keysEmitted[4].name, 'tab');
  assert.equal(keysEmitted[4].meta, false);
  assert.equal(keysEmitted[4].ctrl, false);
  assert.equal(keysEmitted[4].shift, false);

  // 6. Plain Shift+Tab: name=tab, shift=true, meta=false, ctrl=false
  assert.equal(keysEmitted[5].name, 'tab');
  assert.equal(keysEmitted[5].shift, true);
  assert.equal(keysEmitted[5].meta, false);
  assert.equal(keysEmitted[5].ctrl, false);

  prog.destroy();
});

