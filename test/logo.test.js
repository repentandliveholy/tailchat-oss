import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGO, LOGO_COMPACT, LOGO_ROWS, MIN_LOGO_WIDTH, MIN_COMPACT_WIDTH,
  MIN_HOLIDAY_COMPACT_WIDTH,
  SAVER_SCENE, SAVER_WORDMARK, SAVER_WORDMARK_BLINK,
  SAVER_FRAME_OPEN, SAVER_FRAME_PLAIN,
  MIN_SAVER_WIDTH, MIN_SAVER_HEIGHT, MIN_FULL_SAVER_WIDTH, MIN_FULL_SAVER_HEIGHT,
  minimumLogoWidth, logoRows, logoFrames, sleepFrames, saverIdleFrames, saverIntroFrames,
} from '../src/logo.js';

const width = (rows) => Math.max(...rows.map((row) => [...row].length));

test('both arts are one cell per character, so neither can reflow anywhere', () => {
  for (const rows of [LOGO, LOGO_COMPACT]) {
    for (const row of rows) {
      // Braces would be read as markup by blessed, and a wide glyph would push
      // the rest of the row out of line on the peer's terminal.
      assert.equal(/[{}]/.test(row), false, `braces in: ${row}`);
      assert.equal(/[\u1100-\u115F\u2E80-\uA4CF\uFF00-\uFF60]/.test(row), false, `wide glyph in: ${row}`);
    }
    assert.equal(rows.length, LOGO_ROWS, 'the band is the same height either way');
    // The cat has to occupy the same eleven columns in both, or the pacing and
    // the snore would land on the wordmark of one of them.
    assert.equal([...rows[1]].slice(0, 11).join(''), '  ( o.o )  '.slice(0, 11));
  }
});

test('holiday mode adds the heavy Greek cross to either logo', () => {
  const cross = ['✚', ' ', ' '];
  for (const rows of [LOGO, LOGO_COMPACT]) {
    assert.deepEqual(rows.map((row) => row.slice(-1)), cross);
  }
  const plain = logoRows(200);
  assert.notDeepEqual(plain, LOGO, 'holiday is off for a fresh config');
  assert.deepEqual(logoRows(200, { holiday: true }), LOGO);
});

test('the art is chosen by what the window can hold', () => {
  assert.ok(MIN_COMPACT_WIDTH < MIN_LOGO_WIDTH, 'the compact one is the narrow fallback');
  assert.equal(minimumLogoWidth(), MIN_COMPACT_WIDTH);
  assert.equal(minimumLogoWidth({ holiday: true }), MIN_HOLIDAY_COMPACT_WIDTH);
  assert.ok(MIN_HOLIDAY_COMPACT_WIDTH <= 39,
    'the cross must fit in the window that held the old compact logo');
  assert.deepEqual(logoRows(MIN_LOGO_WIDTH, { holiday: true }), LOGO);
  assert.deepEqual(logoRows(MIN_LOGO_WIDTH - 1, { holiday: true }), LOGO_COMPACT);
  assert.deepEqual(
    logoRows(MIN_HOLIDAY_COMPACT_WIDTH, { holiday: true }),
    LOGO_COMPACT,
  );
  assert.equal(logoRows(MIN_COMPACT_WIDTH).length, LOGO_ROWS);
  // Narrower than the plain compact art: nothing, rather than half a picture.
  assert.deepEqual(logoRows(MIN_COMPACT_WIDTH - 1), []);
  assert.deepEqual(logoRows(0), []);
  assert.deepEqual(logoRows(Number.NaN), []);
});


test('every animation works on the compact art too', () => {
  assert.deepEqual(logoFrames(LOGO_COMPACT).at(-1), LOGO_COMPACT);
  assert.equal(sleepFrames(LOGO_COMPACT)[0][1].includes('( -.- )'), true);
  for (const frame of sleepFrames(LOGO_COMPACT)) {
    assert.equal([...frame[1]].length, [...LOGO_COMPACT[1]].length);
  }
});

test('the animation ends on exactly the static logo', () => {
  const frames = logoFrames();
  assert.ok(frames.length > width(LOGO), 'one frame per column, plus the blink');
  assert.deepEqual(frames[frames.length - 1], LOGO,
    'whatever happens in between, the screen is left holding the plain logo');
});

test('the sweep uncovers the logo column by column and never overruns it', () => {
  const frames = logoFrames(['abcd', 'efgh']);
  // Each frame is the row so far plus the bar on the column being uncovered.
  assert.deepEqual(frames.slice(0, 4), [
    ['▌', '▌'],
    ['a▌', 'e▌'],
    ['ab▌', 'ef▌'],
    ['abc▌', 'efg▌'],
  ]);
  for (const frame of frames) {
    assert.equal(frame.length, 2, 'a frame always has every row');
    for (const row of frame) {
      assert.ok([...row].length <= 4, `frame row is too wide: ${row}`);
    }
  }
});

test('every frame keeps the height of the logo, so the band cannot jump', () => {
  const frames = logoFrames();
  for (const frame of frames) assert.equal(frame.length, LOGO_ROWS);
});

test('the eyes shut once and open again, and only in the middle rows', () => {
  const frames = logoFrames(LOGO, { hold: 2 });
  const blinks = frames.filter((frame) => frame.some((row) => row.includes('( -.- )')));
  assert.equal(blinks.length, 2, 'hold repeats the same frame rather than timing it');
  // The blink is a punctuation change, not a redraw: the wordmark beside the cat
  // is identical in both.
  const open = frames[frames.length - 1];
  const shut = blinks[0];
  assert.equal(shut.length, open.length);
  for (let i = 0; i < open.length; i += 1) {
    assert.equal(shut[i].replace('( -.- )', '( o.o )'), open[i]);
  }
});

test('nothing to draw yields no frames rather than an empty animation', () => {
  assert.deepEqual(logoFrames([]), []);
  assert.deepEqual(logoFrames(null), []);
});

test('the sleeping cat keeps its eyes shut and snores in its own columns', () => {
  const frames = sleepFrames();
  assert.ok(frames.length > 20, 'a slow count, so many held frames');
  const wordmark = (row) => [...row].slice(11).join('');
  for (const frame of frames) {
    assert.equal(frame.length, LOGO_ROWS);
    assert.ok(frame[1].includes('( -.- )'), 'asleep the whole time, never blinking awake');
    for (let i = 0; i < frame.length; i += 1) {
      assert.equal(wordmark(frame[i]), wordmark(LOGO[i]), 'the letters stay put');
      assert.equal([...frame[i]].length, [...LOGO[i]].length, 'and the width never moves');
    }
  }
  const snoring = frames.filter((frame) => /[zZ]/.test(frame[0]));
  assert.ok(snoring.length > 0, 'a z appears');
  const quiet = frames.filter((frame) => !/[zZ]/.test(frame[0]));
  assert.ok(quiet.length > 0, 'and goes away again, or it is not a rhythm');
});

test('sleep is the only idle animation, and it is not the plain logo', () => {
  // A cat pacing back and forth was tried and dropped: quiet should look quiet.
  // What is left has to be plainly different from the logo standing still.
  assert.notDeepEqual(sleepFrames()[0], LOGO);
  assert.equal(sleepFrames()[0][1].includes('( -.- )'), true);
  assert.equal(LOGO[1].includes('( o.o )'), true);
});

test('nothing to sleep on yields no frames', () => {
  assert.deepEqual(sleepFrames([]), []);
  assert.deepEqual(sleepFrames(null), []);
});

test('the night scene is verbatim, one cell per character, and one fixed grid', () => {
  assert.equal(SAVER_SCENE.length, 21);
  for (const row of SAVER_SCENE) {
    assert.equal(/[{}]/.test(row), false, `braces in: ${row}`);
    assert.equal([...row].length, 44);
    assert.equal(row.length, [...row].length, `not one cell per char: ${row}`);
  }
  // The three landmarks of the original, at the rows they arrive on: the moon,
  // the cat's head with its back to us, and the fence it sits on.
  assert.match(SAVER_SCENE[0], /,MMM8&&&\./);
  assert.equal(SAVER_SCENE[7].trimEnd(), '        |\\___/|');
  assert.match(SAVER_SCENE[15], /^_\/\\_\/\\_\/\\__/);
  assert.match(SAVER_SCENE[20], /^jgs\|/, "the artist's signature stays on the art");
});

test('the wordmark letters carry the one embedded face', () => {
  for (const pose of [SAVER_WORDMARK, SAVER_WORDMARK_BLINK]) {
    assert.equal(pose.length, 5);
    for (const row of pose) {
      assert.equal(/[{}]/.test(row), false, `braces in: ${row}`);
      assert.equal([...row].length, MIN_FULL_SAVER_WIDTH);
    }
  }
  assert.match(SAVER_WORDMARK[1], /█o o█/, 'the first A owns the cat eyes');
  assert.match(SAVER_WORDMARK_BLINK[1], /█- -█/, 'the same counter blinks shut');
  for (let row = 0; row < SAVER_WORDMARK.length; row += 1) {
    if (row !== 1) assert.equal(SAVER_WORDMARK[row], SAVER_WORDMARK_BLINK[row]);
  }
});

test('two compositions: letters over the scene, or the scene alone', () => {
  assert.equal(MIN_FULL_SAVER_WIDTH, 47);
  assert.equal(MIN_FULL_SAVER_HEIGHT, 29);
  assert.equal(SAVER_FRAME_OPEN.length, MIN_FULL_SAVER_HEIGHT);
  assert.ok(SAVER_FRAME_OPEN.every((row) => [...row].length === MIN_FULL_SAVER_WIDTH));
  assert.equal(SAVER_FRAME_OPEN[0], SAVER_WORDMARK[0], 'letters lead');
  assert.equal(SAVER_FRAME_OPEN[5].trim(), '', 'a blank row under the letters');
  assert.match(SAVER_FRAME_OPEN[13], /\|\\___\/\|/, 'the cat sits under the letters');
  assert.equal(SAVER_FRAME_OPEN.at(-1).trim(), 'p2p over your own tailnet');

  // The gate cli.js checks is the smaller layout, so a window too short for the
  // letters still gets a screensaver instead of a refusal.
  assert.equal(MIN_SAVER_WIDTH, 44);
  assert.equal(MIN_SAVER_HEIGHT, 23);
  assert.ok(MIN_SAVER_WIDTH < MIN_FULL_SAVER_WIDTH);
  assert.ok(MIN_SAVER_HEIGHT < MIN_FULL_SAVER_HEIGHT);
  assert.equal(SAVER_FRAME_PLAIN.length, MIN_SAVER_HEIGHT);
  assert.ok(SAVER_FRAME_PLAIN.every((row) => [...row].length === MIN_SAVER_WIDTH));
  assert.deepEqual(SAVER_FRAME_PLAIN.slice(0, 21), SAVER_SCENE, 'the scene leads');
  assert.equal(
    SAVER_FRAME_PLAIN.at(-1).trim(),
    'tailchat - p2p over your own tailnet',
    'without the letters the caption says the name',
  );
});

test('the window decides which composition it gets', () => {
  assert.deepEqual(saverIdleFrames(120, 40)[0], SAVER_FRAME_OPEN, 'room for letters');
  assert.deepEqual(
    saverIdleFrames(MIN_FULL_SAVER_WIDTH, MIN_FULL_SAVER_HEIGHT)[0],
    SAVER_FRAME_OPEN,
    'exactly enough room still counts',
  );
  assert.deepEqual(
    saverIdleFrames(MIN_FULL_SAVER_WIDTH - 1, MIN_FULL_SAVER_HEIGHT)[0],
    SAVER_FRAME_PLAIN,
    'one column short of the letters',
  );
  assert.deepEqual(
    saverIdleFrames(MIN_FULL_SAVER_WIDTH, MIN_FULL_SAVER_HEIGHT - 1)[0],
    SAVER_FRAME_PLAIN,
    'one row short of the letters',
  );
  assert.deepEqual(saverIdleFrames()[0], SAVER_FRAME_OPEN, 'asked blind: the full one');
});

test('a scanline writes the whole frame, then only the sky and the eyes move', () => {
  const intro = saverIntroFrames();
  assert.equal(intro.length, MIN_FULL_SAVER_WIDTH + 1);
  assert.ok(intro[0].every((row) => row.startsWith('▌')));
  assert.deepEqual(intro.at(-1), SAVER_FRAME_OPEN);
  for (const frame of intro) {
    assert.equal(frame.length, MIN_FULL_SAVER_HEIGHT);
    assert.ok(frame.every((row) => [...row].length === MIN_FULL_SAVER_WIDTH));
  }
  // The scanline is built from whatever frame it was handed, so the smaller
  // composition arrives the same way rather than borrowing the big geometry.
  const plainIntro = saverIntroFrames(SAVER_FRAME_PLAIN);
  assert.equal(plainIntro.length, MIN_SAVER_WIDTH + 1);
  assert.deepEqual(plainIntro.at(-1), SAVER_FRAME_PLAIN);

  // Whatever the animation does, it may only ever touch the sky marks the scene
  // already has and the two eyes inside the first A. Anything else means a
  // twinkle drifted onto the moon, the cat, the fence or the letters.
  const moving = (frames, base) => {
    const moved = new Set();
    for (const frame of frames) {
      for (let row = 0; row < frame.length; row += 1) {
        const now = [...frame[row]];
        const was = [...base[row]];
        for (let col = 0; col < now.length; col += 1) {
          if (now[col] !== was[col]) moved.add(`${row},${col}`);
        }
      }
    }
    return moved;
  };

  const idle = saverIdleFrames();
  assert.ok(idle.length > 30, 'a long quiet loop');
  assert.deepEqual(idle[0], SAVER_FRAME_OPEN, 'the loop opens on the untouched art');
  assert.ok(
    idle.every((frame) => frame.length === MIN_FULL_SAVER_HEIGHT
      && frame.every((row) => [...row].length === MIN_FULL_SAVER_WIDTH)),
    'a twinkle never changes the shape of a frame',
  );
  // Sky marks, shifted by the five letter rows and the blank one, and by the
  // single column the 44-wide scene gains when centred in 47.
  const SKY = ['6,12', '7,32', '9,4', '12,33', '14,29', '14,44', '16,22', '6,39'];
  const EYES = ['1,7', '1,9'];
  assert.deepEqual(
    [...moving(idle, SAVER_FRAME_OPEN)].sort(),
    [...SKY, ...EYES].sort(),
    'only the sky twinkles and only the eyes blink',
  );
  for (const cell of [...SKY, ...EYES]) {
    const [row, col] = cell.split(',').map(Number);
    assert.ok(
      idle.some((frame) => [...frame[row]][col] !== [...SAVER_FRAME_OPEN[row]][col]),
      `the mark at ${cell} never changes`,
    );
  }
  assert.ok(new Set(idle.map((frame) => frame.join('\n'))).size > 8, 'more than a state or two');

  // The smaller composition has no letters, so nothing but its sky may move.
  const plain = saverIdleFrames(MIN_SAVER_WIDTH, MIN_SAVER_HEIGHT);
  assert.deepEqual(plain[0], SAVER_FRAME_PLAIN);
  assert.deepEqual(
    [...moving(plain, SAVER_FRAME_PLAIN)].sort(),
    ['0,11', '0,38', '1,31', '10,21', '3,3', '6,32', '8,28', '8,43'].sort(),
    'only the sky twinkles',
  );
});

test('nothing to scan yields no intro frames', () => {
  assert.deepEqual(saverIntroFrames([]), []);
  assert.deepEqual(saverIntroFrames(null), []);
});