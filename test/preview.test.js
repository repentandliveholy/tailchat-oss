import {
  test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPng,
  decodePng,
  decodeImage,
  sample,
  previewSize,
  renderPreview,
  looksLikeImage,
  fileIconLines,
  isKittyGraphicsSupported,
  terminalViewProtocol,
  encodeKittyGraphics,
  kittyViewPlan,
  kittyPut,
  KITTY_DELETE_ALL,
  itermInlineImage,
  itermViewPlan,
  pngDimensions,
  convertToPngBytes,
  QUADRANTS,
} from '../src/preview.js';

// A 3x2 RGBA PNG, non-interlaced, 8-bit, with a valid CRC. Top row red, green,
// blue; bottom row yellow, magenta, cyan.
const FIXTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAFElEQVR4nGP4z8DwHwwZ/v9HRv8Bqm8O8smQ8ZMAAAAASUVORK5CYII=',
  'base64',
);

test('a png is recognised by its signature, not its name', () => {
  assert.equal(isPng(FIXTURE), true);
  assert.equal(isPng(Buffer.from('not a png')), false);
  assert.equal(isPng(Buffer.alloc(3)), false);
});

test('a png decodes to the pixels it claims', () => {
  const image = decodePng(FIXTURE);
  assert.equal(image.width, 3);
  assert.equal(image.height, 2);
  assert.deepEqual([...image.rgba.subarray(0, 4)], [255, 0, 0, 255], 'top-left is red');
  assert.deepEqual([...image.rgba.subarray(12, 16)], [255, 255, 0, 255], 'bottom-left is yellow');
});

test('a truncated or foreign buffer decodes to null, not an exception', () => {
  // A corrupt frame must cost a preview, never the conversation.
  assert.equal(decodePng(Buffer.from('garbage bytes')), null);
  assert.equal(decodePng(FIXTURE.subarray(0, 20)), null);
});

test('sampling keeps the shape and reads the nearest pixel', () => {
  const image = decodePng(FIXTURE);
  const grid = sample(image, 3, 2);
  assert.equal(grid.length, 2);
  assert.deepEqual(grid[0][0], [255, 0, 0, 255], 'top-left stays red');
  assert.deepEqual(grid[1][0], [255, 255, 0, 255], 'bottom-left stays yellow');
  assert.deepEqual(grid[0][2], [0, 0, 255, 255], 'top-right stays blue');
});

test('the preview stays inside its box and keeps the proportions', () => {
  const wide = previewSize({ width: 1000, height: 500 }, { columns: 36, rows: 12 });
  assert.ok(wide.columns <= 36 && wide.rows <= 12);
  const ratio = wide.columns / wide.rows;
  assert.ok(ratio > 1.5, `a 2:1 image must stay wide, got ${wide.columns}x${wide.rows}`);
});

test('a preview paints one colour per 2x2 block', () => {
  const image = decodePng(FIXTURE);
  const lines = renderPreview(image, { columns: 3, rows: 1, themed: true });
  assert.equal(lines.length, 1);
  // Palette indices, not markup: red is 9 and yellow is 11, both named in one
  // sequence, and blessed carries them to the screen without converting a tag.
  assert.match(lines[0], /^\x1b\[38;5;9;48;5;11m▀/);
  assert.match(lines[0], /▀\x1b\[0m$/); // the row is closed so no colour leaks
  assert.doesNotMatch(lines[0], /\{/, 'a preview costs blessed no tag parsing');
});

test('a preview names a colour only where it changes', () => {
  // The same colour twice is one escape code, not two: blessed rescans every
  // code of every visible cell on every frame, so repeats are what made
  // scrolling crawl with pictures on screen.
  const flat = { width: 4, height: 2, rgba: Buffer.alloc(4 * 2 * 4, 0x40) };
  flat.rgba.fill(0xff);
  const [line] = renderPreview(flat, { columns: 2, rows: 1, themed: true });
  assert.equal(line.match(/\x1b\[/g).length, 2, 'one colour code and one reset');
  assert.match(line, /^\x1b\[38;5;\d+m██\x1b\[0m$/);
});

test('every 2x2 quadrant mask maps to the right glyph', () => {
  // bit3=tl, bit2=tr, bit1=bl, bit0=br (quantizeQuad writes 1 << (3 - i)).
  const glyphs = [
    ' ', '▗', '▖', '▄', '▝', '▐', '▞', '▟',
    '▘', '▚', '▌', '▙', '▀', '▜', '▛', '█',
  ];
  assert.equal(Object.keys(QUADRANTS).length, 16, 'all sixteen masks covered');
  for (let mask = 0; mask < 16; mask++) {
    assert.equal(QUADRANTS[mask], glyphs[mask], `mask 0b${mask.toString(2).padStart(4, '0')}`);
  }
});

test('a monochrome preview maps colour to brightness instead of tags', () => {
  const image = decodePng(FIXTURE);
  const lines = renderPreview(image, { columns: 3, rows: 1, themed: false });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /\{/);
  assert.match(lines[0], /^[ .:\-=+*#%@]+$/);
});

test('an image is told apart from any other file by its name', () => {
  for (const name of ['a.png', 'photo.JPG', 'x.jpeg', 'gif.gif', 'screen.webp']) {
    assert.equal(looksLikeImage(name), true, name);
  }
  assert.equal(looksLikeImage('notes.txt'), false);
  assert.equal(looksLikeImage('archive.tar.gz'), false);
});


test('a non-image file renders a small card with its extension', () => {
  // A transfer of anything that is not a picture still deserves a preview: the
  // same half-block grid, a fixed colour, and the extension so it reads as a file.
  const lines = fileIconLines('report.PDF', { themed: true });
  assert.equal(lines.length, 3, 'three rows: a top, a middle, a bottom');
  assert.match(lines[1], /PDF/);
  assert.match(lines[0], /\{#5fafff-fg\}/, 'coloured in the themed path');
  assert.equal(lines.every((line) => line.length === lines[0].length), true, 'the card is a rectangle');

  const plain = fileIconLines('archive.tar.gz', { themed: false });
  assert.doesNotMatch(plain.join(''), /\{/, 'monochrome drops the tags');
  assert.match(plain[1], /GZ/, 'the last extension wins');
});

test('isKittyGraphicsSupported detects Kitty, Ghostty and WezTerm only', () => {
  assert.equal(isKittyGraphicsSupported({ KITTY_WINDOW_ID: '1' }), true);
  assert.equal(isKittyGraphicsSupported({ TERM: 'xterm-kitty' }), true);
  assert.equal(isKittyGraphicsSupported({ GHOSTTY_RESOURCES_DIR: '/opt' }), true);
  assert.equal(isKittyGraphicsSupported({ TERM: 'xterm-ghostty' }), true);
  assert.equal(isKittyGraphicsSupported({ WEZTERM_PANE: '0' }), true);
  assert.equal(isKittyGraphicsSupported({ TERM: 'wezterm' }), true);
  // Warp does not render the kitty protocol (verified by hand), so it is not
  // a kitty terminal — terminalViewProtocol sends it OSC 1337 instead.
  assert.equal(isKittyGraphicsSupported({ WARP_TERMINAL: '1' }), false);
  assert.equal(isKittyGraphicsSupported({ TERM_PROGRAM: 'WarpTerminal' }), false);
  assert.equal(isKittyGraphicsSupported({ TERM: 'xterm-256color' }), false);
  assert.equal(isKittyGraphicsSupported({}), false);
  assert.equal(isKittyGraphicsSupported(null), false);
});

test('terminalViewProtocol picks kitty, OSC 1337 (Warp/iTerm2) or nothing', () => {
  assert.equal(terminalViewProtocol({ TERM: 'xterm-kitty' }), 'kitty');
  assert.equal(terminalViewProtocol({ TERM_PROGRAM: 'WarpTerminal' }), 'iterm');
  assert.equal(terminalViewProtocol({ TERM_PROGRAM: 'iTerm.app' }), 'iterm');
  assert.equal(terminalViewProtocol({ TERM: 'xterm-256color' }), null);
  assert.equal(terminalViewProtocol({}), null);
  assert.equal(terminalViewProtocol(null), null);
});

test('itermInlineImage emits one OSC 1337 escape with the PNG and a width', () => {
  const esc = itermInlineImage(FIXTURE, { width: 400 });
  assert.ok(esc.startsWith('\x1b]1337;File=inline=1;width=400:'));
  assert.ok(esc.endsWith('\x07'));
  assert.ok(esc.includes(FIXTURE.toString('base64')));
  const noSize = itermInlineImage(FIXTURE, {});
  assert.ok(noSize.startsWith('\x1b]1337;File=inline=1:'));
  assert.equal(itermInlineImage(Buffer.from('nope'), { width: 400 }), '');
});

test('itermViewPlan fits the pixel box without upscaling small pictures', () => {
  // A 4000x3000 photo in a 100x30 window (900x504px box after hint rows):
  // scaled down to the box, aspect kept.
  const photo = itermViewPlan({ width: 4000, height: 3000 }, { columns: 100, rows: 30 });
  assert.ok(photo.width <= 900 && photo.height <= 504, `${photo.width}x${photo.height}`);
  assert.equal(Math.round((photo.width / photo.height) * 1000), Math.round((4000 / 3000) * 1000));
  // A 192px icon stays 1:1.
  const icon = itermViewPlan({ width: 192, height: 192 }, { columns: 100, rows: 30 });
  assert.equal(icon.width, 192);
  assert.equal(icon.height, 192);
  assert.equal(itermViewPlan(null, {}), null);
});

test('encodeKittyGraphics produces valid APC escape sequences and chunks large payloads', () => {
  const small = Buffer.from('small-image-bytes');
  const seqs = encodeKittyGraphics(small, { cols: 20, rows: 10 });
  assert.equal(seqs.length, 1);
  assert.ok(seqs[0].startsWith('\x1b_Ga=T,f=100,m=0,c=20,r=10;'));
  assert.ok(seqs[0].endsWith('\x1b\\'));
  assert.ok(seqs[0].includes(small.toString('base64')));

  // Large payload requiring chunking (> 4096 base64 chars = 3072 raw bytes)
  const large = Buffer.alloc(6000, 0x41);
  const largeSeqs = encodeKittyGraphics(large);
  assert.ok(largeSeqs.length > 1);
  assert.ok(largeSeqs[0].startsWith('\x1b_Ga=T,f=100,m=1;'));
  assert.ok(largeSeqs[largeSeqs.length - 1].startsWith('\x1b_Gm=0;'));
  assert.ok(largeSeqs.every((s) => s.endsWith('\x1b\\')));
});

test('kittyViewPlan scales a picture into the terminal without stretching it', () => {
  // A 4000x3000 photo on a 100x30 window: the width binds (the picture is far
  // wider than the terminal), but the height must leave the hint rows alone.
  const photo = kittyViewPlan({ width: 4000, height: 3000 }, { columns: 100, rows: 30 });
  assert.equal(photo.cols, 74); // floor((30-2) * 2 * 4000 / 3000) = 74
  assert.ok(photo.rows <= 28, `rows ${photo.rows} must clear the hint rows`);

  // A small picture is never upscaled past its own pixels: 192px wide at a
  // 9px cell is 22 columns, not the full 100.
  const icon = kittyViewPlan({ width: 192, height: 192 }, { columns: 100, rows: 30 });
  assert.equal(icon.cols, 22);

  // A tall portrait binds by height and stays narrow.
  const tall = kittyViewPlan({ width: 1000, height: 3000 }, { columns: 100, rows: 30 });
  assert.ok(tall.cols < 30 && tall.cols >= 1, `portrait cols ${tall.cols}`);
  assert.ok(tall.rows <= 28);

  // Unknown geometry or size degrades to a sane default rather than a crash.
  assert.equal(kittyViewPlan(null, {}), null);
  assert.ok(kittyViewPlan({ width: 4000, height: 3000 }, {}).cols >= 24);
});

test('pngDimensions reads the header without decoding the pixels', () => {
  assert.deepEqual(pngDimensions(FIXTURE), { width: 3, height: 2 });
  assert.equal(pngDimensions(Buffer.from('not a png at all, just text')), null);
  assert.equal(pngDimensions(Buffer.alloc(8)), null);
});

test('convertToPngBytes passes a PNG through untouched', async () => {
  const png = await convertToPngBytes(FIXTURE);
  assert.equal(png, FIXTURE);
  assert.equal(await convertToPngBytes(Buffer.alloc(0)), null);
});

test('kittyPut sizes the placement and KITTY_DELETE_ALL clears the screen', () => {
  assert.equal(kittyPut(40), '\x1b_Ga=p,c=40,q=2\x1b\\');
  assert.equal(kittyPut(0), '\x1b_Ga=p,c=1,q=2\x1b\\');
  assert.equal(KITTY_DELETE_ALL, '\x1b_Ga=d,d=A\x1b\\');
});

test('the stamp is 36 wide whatever the window; height is free', () => {
  // An art row wider than the transcript wraps in a narrow window and the
  // quadrant halves tear into noise — every terminal-sized attempt did this —
  // so columns must never grow with the window. Height is safe (a taller
  // picture scrolls like any other line): a wide panorama spans the full 36
  // columns, and nothing about the output depends on a window that is not
  // there.
  const noise = (width, height) => {
    const rgba = Buffer.alloc(width * height * 4, 0xff);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = (i * 7) % 256;
      rgba[i * 4 + 1] = (i * 13) % 256;
      rgba[i * 4 + 2] = (i * 29) % 256;
    }
    return { width, height, rgba };
  };
  const clean = (line) => line.replace(/\x1b\[[\d;]*m/g, '');
  const panorama = renderPreview(noise(480, 80), { columns: 36, rows: 30 });
  assert.ok(panorama.every((line) => clean(line).length <= 36), 'never wider than 36');
  assert.ok(clean(panorama[0]).length >= 36, 'a wide picture spans the full stamp');

  // A tall portrait uses the height it was always denied: the old 12-row cap
  // bound it to a 9-column sliver, the 30-row box lets it grow to a real
  // picture (23 columns here — its height binds first).
  const portrait = renderPreview(noise(600, 1600), { columns: 36, rows: 30 });
  assert.ok(portrait.length > 12, `${portrait.length} rows must beat the old cap`);
  assert.ok(clean(portrait[0]).length > 12, 'the portrait is far wider than the old 9-column sliver');

  // Still palette indices and one reset per row: the transcript's cell buffer
  // cannot carry anything richer than a 256-colour index.
  for (const line of renderPreview(noise(240, 160), { columns: 36, rows: 30 })) {
    assert.match(line, /\x1b\[0m$/);
    assert.doesNotMatch(line, /38;2;/);
  }
});
