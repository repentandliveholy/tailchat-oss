// The wordmark, and the way it arrives. Pure ASCII and half-blocks on purpose,
// like the emoticons: one character is one cell, so the picture cannot reflow on
// a narrow terminal or on a peer whose font lacks a glyph. Curly braces are
// excluded because blessed would read them as markup.
//
// Nothing here draws or waits — a frame is a list of rows, and whoever owns the
// screen decides when to paint the next one. That keeps the animation testable
// without a terminal and without a clock.

const LOGO_PLAIN = [
  '   /\\_/\\    ▀█▀ ▄▀█ █ █   █▀▀ █ █ ▄▀█ ▀█▀',
  '  ( o.o )    █  █▀█ █ █▄▄ █▄▄ █▀█ █▀█  █ ',
  '   > ^ <    p2p over your own tailnet',
];

// Heavy Greek cross (&#10010; / U+271A ✚) on the top row.
const HOLIDAY_CROSS = ['✚', ' ', ' '];
const widestOf = (rows) => Math.max(...rows.map((row) => [...row].length));

const withHolidayCross = (rows) => {
  const width = widestOf(rows);
  return rows.map((row, index) => `${row.padEnd(width)}  ${HOLIDAY_CROSS[index]}`);
};

export const LOGO = withHolidayCross(LOGO_PLAIN);

// The same cat, a plain wordmark and a shorter tailnet line: it leaves enough
// room for the cross in the same width where the old compact logo fitted.
const LOGO_COMPACT_PLAIN = [
  '   /\\_/\\    tailchat',
  '  ( o.o )   p2p on tailnet',
  '   > ^ <',
];

export const LOGO_COMPACT = withHolidayCross(LOGO_COMPACT_PLAIN);

export const LOGO_ROWS = LOGO.length;

// Frame borders plus the transcript's own inset, on top of the art itself.
export const MIN_LOGO_WIDTH = widestOf(LOGO) + 6;
export const MIN_COMPACT_WIDTH = widestOf(LOGO_COMPACT_PLAIN) + 6;
export const MIN_HOLIDAY_COMPACT_WIDTH = widestOf(LOGO_COMPACT) + 6;
const MIN_PLAIN_LOGO_WIDTH = widestOf(LOGO_PLAIN) + 6;

export function minimumLogoWidth({ holiday = false } = {}) {
  return holiday ? MIN_HOLIDAY_COMPACT_WIDTH : MIN_COMPACT_WIDTH;
}

// The widest art the window can hold, or nothing at all. Silently drawing half a
// wordmark would be worse than an empty band. Holiday is off for a fresh config;
// if an exceptionally narrow window cannot hold the cross, it keeps the plain
// compact identity instead of dropping the entire band.
export function logoRows(width, { holiday = false } = {}) {
  const usable = Number(width);
  if (!Number.isFinite(usable)) return [];
  if (holiday) {
    if (usable >= MIN_LOGO_WIDTH) return LOGO.slice();
    if (usable >= MIN_HOLIDAY_COMPACT_WIDTH) return LOGO_COMPACT.slice();
    if (usable >= MIN_COMPACT_WIDTH) return LOGO_COMPACT_PLAIN.slice();
    return [];
  }
  if (usable >= MIN_PLAIN_LOGO_WIDTH) return LOGO_PLAIN.slice();
  if (usable >= MIN_COMPACT_WIDTH) return LOGO_COMPACT_PLAIN.slice();
  return [];
}

// A bar sweeping left to right, uncovering the logo as it goes: it reads as the
// wordmark being drawn rather than as a picture blinking into place, and it is
// the one effect that costs a single character per row per frame. The half-block
// is the same glyph family the wordmark is built from, so nothing new has to
// render.
const SWEEP = '▌';

const pad = (row, width) => {
  const chars = [...row];
  return chars.length >= width ? chars : [...chars, ...Array(width - chars.length).fill(' ')];
};

// The eyes shut for a moment once the wordmark is up. Two frames of nothing but
// a punctuation change, and the cat stops looking like a decal.
const blink = (rows) => rows.map((row) => row.replace('( o.o )', '( -.- )'));

// The whole animation as data: `frames[i]` is what the band shows at step i, and
// the last frame is exactly the static logo — so a client that drops every frame
// but the last one still ends up in the right place.
//
// `hold` repeats a frame instead of introducing a per-frame duration: one
// interval is easier to reason about than a schedule, and a repeated frame costs
// nothing to paint because the content does not change.
export function logoFrames(rows = LOGO, { hold = 4 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const width = Math.max(...rows.map((row) => [...row].length));
  const padded = rows.map((row) => pad(row, width));
  const frames = [];
  for (let col = 1; col <= width; col += 1) {
    frames.push(padded.map((chars) => {
      const seen = chars.slice(0, col - 1);
      // The sweep sits on the column being uncovered, so the bar is always the
      // rightmost thing on the row and the row never looks half-erased.
      return [...seen, SWEEP].join('').trimEnd();
    }));
  }
  const settled = rows.slice();
  const closed = blink(settled);
  // Eyes open, shut, open: the last frame has to be the plain logo, because it
  // is also what stays on the screen afterwards.
  for (let n = 0; n < hold; n += 1) frames.push(settled);
  for (let n = 0; n < hold; n += 1) frames.push(closed);
  for (let n = 0; n < hold; n += 1) frames.push(settled);
  return frames;
}

const eyes = (rows, face) => rows.map((row) => row.replace('( o.o )', `( ${face} )`));

// Where a `z` fits: the cat block ends in spaces on the top row, past the ears
// and before the wordmark, so a snore can be drawn without moving anything.
const Z_COLUMN = 9;

const withZ = (rows, ch, col = Z_COLUMN) => rows.map((row, index) => {
  if (index !== 0) return row;
  const chars = [...row];
  if (chars[col] === undefined) return row;
  chars[col] = ch;
  return chars.join('');
});

// Nobody typing, or nobody on the other end at all: the cat sleeps. Eyes shut
// and a `z` that comes and goes on a slow count — a screensaver in three rows,
// where no part of the conversation is covered and the wordmark never moves, so
// the window still says what it is at a glance. A cat pacing back and forth was
// tried first and was simply movement for its own sake.
const SLEEP_STEPS = [[' ', 12], ['z', 8], ['Z', 8], ['z', 6]];

export function sleepFrames(rows = LOGO) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const shut = eyes(rows, '-.-');
  const frames = [];
  for (const [ch, hold] of SLEEP_STEPS) {
    const frame = withZ(shut, ch);
    for (let n = 0; n < hold; n += 1) frames.push(frame);
  }
  return frames;
}

// Full-screen /saver identity: the block TAILCHAT over Joan Stark's "cat on a
// fence" — the cat sitting with its back to us under a waning moon, a fence
// running the whole width, and a sky with room to breathe. The scene is kept
// verbatim from the original (https://asciiart.website/art/7597), her `jgs`
// signature included: it is her drawing, and she asked that her signature stay
// on it, so cropping it would be both rude and against the terms it came under.
//
// Every row is padded to one width, so blessed centres the picture as a block
// instead of centring each line on its own.
export const SAVER_SCENE = [
  '           *     ,MMM8&&&.            *     ',
  '                MMMM88&&&&&    .            ',
  '               MMMM88&&&&&&&                ',
  '   *           MMM88&&&&&&&&                ',
  '               MMM88&&&&&&&&                ',
  '               \'MMM88&&&&&&\'                ',
  '                 \'MMM8&&&\'      *           ',
  '        |\\___/|                             ',
  '        )     (             .              \'',
  '       =\\     /=                            ',
  '         )===(       *                      ',
  '        /     \\                             ',
  '        |     |                             ',
  '       /       \\                            ',
  '       \\       /                            ',
  '_/\\_/\\_/\\__  _/_/\\_/\\_/\\_/\\_/\\_/\\_/\\_/\\_/\\_ ',
  '|  |  |  |( (  |  |  |  |  |  |  |  |  |  | ',
  '|  |  |  | ) ) |  |  |  |  |  |  |  |  |  | ',
  '|  |  |  |(_(  |  |  |  |  |  |  |  |  |  | ',
  '|  |  |  |  |  |  |  |  |  |  |  |  |  |  | ',
  'jgs|  |  |  |  |  |  |  |  |  |  |  |  |  | ',
];

// The only thing that moves. The moon, the cat and the fence are the drawing;
// the sky is where a screensaver may breathe. `cycle[0]` is the glyph the
// original already has at that cell, so frame zero is the untouched picture and
// a mark can never silently drift onto the art — a test anchors on both.
const TWINKLES = [
  { row: 0, col: 11, cycle: ['*', '+', '.', '+'], dwell: 3, offset: 0 },
  { row: 0, col: 38, cycle: ['*', '.', '+', '.'], dwell: 4, offset: 1 },
  { row: 1, col: 31, cycle: ['.', ' ', '.', ' '], dwell: 6, offset: 4 },
  { row: 3, col: 3, cycle: ['*', '+', '.', '+'], dwell: 6, offset: 2 },
  { row: 6, col: 32, cycle: ['*', '.', '+', '.'], dwell: 3, offset: 1 },
  { row: 8, col: 28, cycle: ['.', '.', ' ', '.'], dwell: 4, offset: 2 },
  { row: 8, col: 43, cycle: ['\'', ' ', '\'', ' '], dwell: 6, offset: 5 },
  { row: 10, col: 21, cycle: ['*', '+', '.', '+'], dwell: 4, offset: 3 },
];

// Every star's own period is `dwell * 4`, and 3, 4 and 6 all divide the loop
// into a whole number of cycles — so the sky never pulses in unison, yet the
// last frame hands back to the first without a jump. An `offset` below `dwell`
// shifts when a star turns without moving frame zero off the original art.
const TWINKLE_LOOP = 48;

function twinkledScene(frame) {
  const rows = SAVER_SCENE.slice();
  for (const { row, col, cycle, dwell, offset } of TWINKLES) {
    const chars = [...rows[row]];
    chars[col] = cycle[Math.floor((frame + offset) / dwell) % cycle.length];
    rows[row] = chars.join('');
  }
  return rows;
}

const SAVER_TEXT = 'TAILCHAT';
const PIXEL_FONT = {
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  '],
  A: [' ### ', '#   #', '#####', '#   #', '#   #'],
  I: ['#####', '  #  ', '  #  ', '  #  ', '#####'],
  L: ['#    ', '#    ', '#    ', '#    ', '#####'],
  C: [' ####', '#    ', '#    ', '#    ', ' ####'],
  H: ['#   #', '#   #', '#####', '#   #', '#   #'],
};

// The first A owns the only character detail in the letters: its counter is a
// pair of cat eyes. They shut for two frames once a loop — enough to notice,
// not enough to become a metronome beside the twinkling sky.
const BLINK_AT = 20;
const BLINK_HOLD = 2;
const blinking = (frame) => frame >= BLINK_AT && frame < BLINK_AT + BLINK_HOLD;

function renderSaverWordmark(face) {
  const rows = Array.from({ length: 5 }, () => []);
  for (let letter = 0; letter < SAVER_TEXT.length; letter += 1) {
    const glyph = PIXEL_FONT[SAVER_TEXT[letter]];
    for (let row = 0; row < glyph.length; row += 1) {
      let pixels = glyph[row];
      if (letter === 1 && row === 1) pixels = face === 'blink' ? '#- -#' : '#o o#';
      rows[row].push([...pixels].map((cell) => (cell === '#' ? '█' : cell)).join(''));
    }
  }
  return rows.map((row) => row.join(' '));
}

export const SAVER_WORDMARK = renderSaverWordmark('open');
export const SAVER_WORDMARK_BLINK = renderSaverWordmark('blink');

const centre = (text, width) => {
  const gap = Math.max(0, width - [...text].length);
  const left = Math.floor(gap / 2);
  return `${' '.repeat(left)}${text}${' '.repeat(gap - left)}`;
};

// The letters already say the name, so the caption under them only says what
// tailchat is. The layout without letters has the caption carry the name too.
const SAVER_TAGLINE = 'p2p over your own tailnet';
const SAVER_NAMED_TAGLINE = 'tailchat - p2p over your own tailnet';

// Two compositions, and the one shown is the one that fits — the same rule the
// band already follows with LOGO and LOGO_COMPACT. Letters plus the scene need
// 29 rows; raising the single global minimum to that would have silently killed
// `/saver` on every narrow terminal, Termux included, which is worse than a
// screensaver without block letters.
function composeFull(letters, scene) {
  const width = Math.max(widestOf(letters), widestOf(scene));
  return [
    ...letters.map((row) => centre(row, width)),
    ' '.repeat(width),
    ...scene.map((row) => centre(row, width)),
    ' '.repeat(width),
    centre(SAVER_TAGLINE, width),
  ];
}

function composePlain(scene) {
  const width = widestOf(scene);
  return [...scene, ' '.repeat(width), centre(SAVER_NAMED_TAGLINE, width)];
}

export const SAVER_FRAME_OPEN = composeFull(SAVER_WORDMARK, SAVER_SCENE);
export const SAVER_FRAME_PLAIN = composePlain(SAVER_SCENE);

// The gate `fullscreenFits()` uses: the smallest window that can still show
// something at all. The full composition has its own, larger minimum.
export const MIN_SAVER_WIDTH = widestOf(SAVER_FRAME_PLAIN);
export const MIN_SAVER_HEIGHT = SAVER_FRAME_PLAIN.length;
export const MIN_FULL_SAVER_WIDTH = widestOf(SAVER_FRAME_OPEN);
export const MIN_FULL_SAVER_HEIGHT = SAVER_FRAME_OPEN.length;

// A vertical phosphor bar writes every row left-to-right. All rows are padded
// to their final width from frame one, so centring never shifts during arrival.
export function saverIntroFrames(rows = SAVER_FRAME_OPEN) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const width = widestOf(rows);
  const padded = rows.map((row) => pad(row, width));
  const frames = [];
  for (let col = 0; col < width; col += 1) {
    frames.push(padded.map((row) => row.map((cell, index) => {
      if (index < col) return cell;
      if (index === col) return SWEEP;
      return ' ';
    }).join('')));
  }
  frames.push(padded.map((row) => row.join('')));
  return frames;
}

// Almost still after the entrance: nothing in the drawing moves, the sky
// twinkles one mark at a time on its own count, and the letters blink once. The
// loop closes exactly on the untouched art, so it can run for as long as nobody
// is there. The window decides which composition it gets; asked without a size,
// it hands back the full one.
export function saverIdleFrames(
  width = MIN_FULL_SAVER_WIDTH,
  height = MIN_FULL_SAVER_HEIGHT,
) {
  const full = width >= MIN_FULL_SAVER_WIDTH && height >= MIN_FULL_SAVER_HEIGHT;
  const frames = [];
  for (let frame = 0; frame < TWINKLE_LOOP; frame += 1) {
    const scene = twinkledScene(frame);
    frames.push(full
      ? composeFull(blinking(frame) ? SAVER_WORDMARK_BLINK : SAVER_WORDMARK, scene)
      : composePlain(scene));
  }
  return frames;
}

