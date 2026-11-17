import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ART, MOODS, MAX_ART_WIDTH, MAX_ART_ROWS, pickArt,
} from '../src/art.js';
import { displayWidth } from '../src/ui.js';

const everyPicture = Object.entries(ART)
  .flatMap(([mood, list]) => list.map((rows, index) => [`${mood}#${index}`, rows]));

test('every picture is pure ASCII, so it is one cell per character everywhere', () => {
  for (const [id, rows] of everyPicture) {
    for (const row of rows) {
      assert.match(row, /^[\x20-\x7e]*$/, `${id} has a non-ASCII character: ${row}`);
      // A wide glyph would push the picture past the frame on the peer's side.
      assert.equal(displayWidth(row), row.length, `${id} is not one cell per character`);
    }
  }
});

test('a picture cannot bury the conversation it is sent into', () => {
  for (const [id, rows] of everyPicture) {
    assert.ok(rows.length > 0, `${id} is empty`);
    assert.ok(rows.length <= MAX_ART_ROWS, `${id} is ${rows.length} rows`);
    for (const row of rows) {
      assert.ok(row.length <= MAX_ART_WIDTH, `${id} is ${row.length} columns: ${row}`);
    }
  }
});

test('a picture carries no markup the renderer would have to escape away', () => {
  for (const [id, rows] of everyPicture) {
    for (const row of rows) {
      assert.equal(row.includes('{'), false, `${id} would be mangled as a tag: ${row}`);
      assert.equal(row.includes('}'), false, `${id} would be mangled as a tag: ${row}`);
    }
  }
});

test('the moods a user is told about all exist', () => {
  // The help text names these four; a rename that drops one must fail here.
  for (const mood of ['happy', 'sad', 'ok', 'no']) {
    assert.ok(MOODS.includes(mood), `${mood} is advertised but missing`);
    assert.ok(ART[mood].length > 0, `${mood} has no pictures`);
  }
});

test('a mood returns one of its own pictures, never another mood', () => {
  for (const mood of MOODS) {
    const own = new Set(ART[mood].map((rows) => rows.join('\n')));
    for (let n = 0; n < 30; n++) {
      const result = pickArt(mood);
      assert.equal(result.ok, true);
      assert.ok(own.has(result.art), `${mood} produced a picture from elsewhere`);
    }
  }
});

test('no mood means any picture', () => {
  const all = new Set(Object.values(ART).flat().map((rows) => rows.join('\n')));
  for (const empty of ['', '   ', undefined, null]) {
    const result = pickArt(empty);
    assert.equal(result.ok, true);
    assert.ok(all.has(result.art));
  }
});

test('an unknown mood lists the real ones instead of guessing', () => {
  // "sadd" is a typo, and sending the wrong feeling is worse than saying no.
  const result = pickArt('sadd');
  assert.equal(result.ok, false);
  assert.deepEqual(result.moods, MOODS);
});

test('a mood is matched regardless of case or stray spaces', () => {
  assert.equal(pickArt('  HAPPY ').ok, true);
});

test('the draw stays inside the list at both ends', () => {
  const first = ART.happy[0].join('\n');
  const last = ART.happy[ART.happy.length - 1].join('\n');
  assert.equal(pickArt('happy', () => 0).art, first);
  // Math.random() never returns 1, but a caller passing it must not fall off.
  assert.equal(pickArt('happy', () => 1).art, last);
  assert.equal(pickArt('happy', () => 0.999999).art, last);
});
