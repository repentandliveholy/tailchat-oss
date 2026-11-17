import zlib from 'node:zlib';
import path from 'node:path';
import { spawn } from 'node:child_process';
import colors from 'blessed/lib/colors.js';

// A picture in a chat is worth a glance before it is worth opening. The glance is
// drawn with quadrant-block characters: one cell carries a 2x2 grid of pixels —
// two foreground, two background — which doubles the horizontal resolution a
// terminal can show, at the cost of collapsing four pixels to two colours.
//
// PNG is decoded here rather than shelled out for, because no image tool is
// present on all three machines this runs on — the Mac has `sips`, the phone has
// `ffmpeg`, Windows has PowerShell — and zlib is already in Node. Other formats go
// through whatever the platform does have.

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 8
    && buffer.subarray(0, 8).equals(SIGNATURE);
}

// Paeth, the one filter that needs explaining: it picks whichever of the three
// neighbours the gradient predicts, which is why it beats the others on photos.
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilter(raw, height, bytesPerLine, bytesPerPixel) {
  const out = Buffer.alloc(height * bytesPerLine);
  let inPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[inPos++];
    const line = raw.subarray(inPos, inPos + bytesPerLine);
    inPos += bytesPerLine;
    const at = y * bytesPerLine;
    const prev = at - bytesPerLine;
    for (let x = 0; x < bytesPerLine; x++) {
      const left = x >= bytesPerPixel ? out[at + x - bytesPerPixel] : 0;
      const up = y > 0 ? out[prev + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? out[prev + x - bytesPerPixel] : 0;
      const value = line[x];
      let restored;
      if (filter === 0) restored = value;
      else if (filter === 1) restored = value + left;
      else if (filter === 2) restored = value + up;
      else if (filter === 3) restored = value + ((left + up) >> 1);
      else if (filter === 4) restored = value + paeth(left, up, upLeft);
      else return null; // an unknown filter means the file is not what it claims
      out[at + x] = restored & 0xff;
    }
  }
  return out;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// Returns { width, height, rgba } or null when the file is one of the shapes this
// decoder does not claim to read. Null is an answer, not a failure: the caller
// falls back to naming the file.
export function decodePng(buffer) {
  if (!isPng(buffer)) return null;
  let pos = 8;
  let header = null;
  let palette = null;
  let alpha = null;
  const data = [];

  while (pos + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const body = buffer.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length; // length, type, body, crc
    if (type === 'IHDR') {
      // A truncated header would throw out of bounds on the read below.
      if (body.length < 13) return null;
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colour: body[9],
        interlace: body[12],
      };
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') alpha = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
  }

  if (!header || data.length === 0) return null;
  // Sixteen bits per channel and Adam7 interlacing are rare enough in a chat that
  // reading them would be code nobody exercises.
  if (header.depth !== 8 || header.interlace !== 0) return null;
  const channels = CHANNELS[header.colour];
  if (!channels) return null;
  if (header.colour === 3 && !palette) return null;

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(data));
  } catch {
    return null;
  }

  const { width, height } = header;
  const bytesPerLine = width * channels;
  if (raw.length < height * (bytesPerLine + 1)) return null;
  const pixels = unfilter(raw, height, bytesPerLine, channels);
  if (!pixels) return null;

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const at = i * channels;
    const to = i * 4;
    if (header.colour === 0 || header.colour === 4) {
      const grey = pixels[at];
      rgba[to] = grey;
      rgba[to + 1] = grey;
      rgba[to + 2] = grey;
      rgba[to + 3] = header.colour === 4 ? pixels[at + 1] : 255;
    } else if (header.colour === 2 || header.colour === 6) {
      rgba[to] = pixels[at];
      rgba[to + 1] = pixels[at + 1];
      rgba[to + 2] = pixels[at + 2];
      rgba[to + 3] = header.colour === 6 ? pixels[at + 3] : 255;
    } else {
      const index = pixels[at];
      rgba[to] = palette[index * 3] ?? 0;
      rgba[to + 1] = palette[index * 3 + 1] ?? 0;
      rgba[to + 2] = palette[index * 3 + 2] ?? 0;
      rgba[to + 3] = alpha ? (alpha[index] ?? 255) : 255;
    }
  }
  return { width, height, rgba };
}

// Nearest-neighbour, deliberately: at this size a smooth resample turns detail
// into porridge, and the point is to recognise the picture, not to admire it.
export function sample({ width, height, rgba }, columns, rows) {
  const out = [];
  for (let row = 0; row < rows; row++) {
    const line = [];
    for (let column = 0; column < columns; column++) {
      const x = Math.min(width - 1, Math.floor(((column + 0.5) / columns) * width));
      const y = Math.min(height - 1, Math.floor(((row + 0.5) / rows) * height));
      const at = (y * width + x) * 4;
      line.push([rgba[at], rgba[at + 1], rgba[at + 2], rgba[at + 3]]);
    }
    out.push(line);
  }
  return out;
}

// Transparency has to become something: a chat has one background, and pretending
// otherwise would show a photo pasted on black holes.
function overComposite([r, g, b, a], [br, bg, bb]) {
  const weight = a / 255;
  return [
    Math.round(r * weight + br * (1 - weight)),
    Math.round(g * weight + bg * (1 - weight)),
    Math.round(b * weight + bb * (1 - weight)),
  ];
}

// Blessed builds its 8-colour fallback table by truncating the palette to eight
// entries and matching all 256 colours against that — through the very memo
// `match` reads afterwards. So every colour that is exactly a palette entry
// stays stuck on an 8-colour answer for the rest of the process: pure yellow
// came back as white. Dropping the memo once, after that table is built, is what
// makes a palette colour mean itself again.
colors._cache = {};

// A terminal cell gets one of 256 colours, and the index is what the renderer
// ultimately wants, so the index is what a preview carries. Naming the colour
// any other way — `{#rrggbb-fg}` markup, say — means blessed converts the same
// few hundred colours to escape codes again for every line ever appended below
// the picture, which is most of what made a photo in the transcript expensive.
// `match` memoises, so the search over the palette happens once per colour.
const paletteIndex = (rgb) => colors.match(rgb[0], rgb[1], rgb[2]);
// A quadrant cell has four pixels but a terminal cell only two colours, so the
// four collapse to a foreground and a background and the character carries which
// pixel takes which. Two-means over four pixels is the cheap, honest pick.
export const QUADRANTS = {
  0b0000: ' ', 0b1000: '▘', 0b0100: '▝', 0b0010: '▖', 0b0001: '▗',
  0b1100: '▀', 0b0011: '▄', 0b1010: '▌', 0b0101: '▐',
  0b1111: '█', 0b1001: '▚', 0b0110: '▞',
  0b1011: '▙', 0b1101: '▜', 0b1110: '▛', 0b0111: '▟',
};

const rgbDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const rgbAverage = (pixels) => pixels
  .reduce((acc, [r, g, b]) => [acc[0] + r, acc[1] + g, acc[2] + b], [0, 0, 0])
  .map((v) => Math.round(v / pixels.length));

function quantizeQuad(pixels) {
  let fg = pixels[0], bg = pixels[1], best = -1;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const d = rgbDistance(pixels[i], pixels[j]);
    if (d > best) { best = d; fg = pixels[i]; bg = pixels[j]; }
  }
  for (let iter = 0; iter < 3; iter++) {
    const a = [], b = [];
    for (const p of pixels) (rgbDistance(p, fg) <= rgbDistance(p, bg) ? a : b).push(p);
    if (!a.length || !b.length) break;
    fg = rgbAverage(a); bg = rgbAverage(b);
  }
  let mask = 0; const a = [], b = [];
  for (let i = 0; i < 4; i++) {
    if (rgbDistance(pixels[i], fg) <= rgbDistance(pixels[i], bg)) { mask |= 1 << (3 - i); a.push(pixels[i]); }
    else b.push(pixels[i]);
  }
  return { fg: a.length ? rgbAverage(a) : fg, bg: b.length ? rgbAverage(b) : bg, mask };
}


// Keeps the picture's proportions inside the box it is allowed, remembering that
// a cell is about twice as tall as it is wide and carries four pixels (2x2).
export function previewSize({ width, height }, { columns = 36, rows = 16 } = {}) {
  const maxRows = Math.max(1, rows);
  const maxColumns = Math.max(1, columns);
  const pixelRows = maxRows * 2;
  const scale = Math.min(maxColumns / width, pixelRows / height, 1);
  const cols = Math.max(1, Math.round(width * scale));
  const lines = Math.max(1, Math.ceil((height * scale) / 2));
  return { columns: Math.min(cols, maxColumns), rows: Math.min(lines, maxRows) };
}

export function renderPreview(image, {
  columns = 36, rows = 16, themed = true, background = [0, 0, 0],
} = {}) {
  if (!image || !image.width || !image.height) return [];
  const size = previewSize(image, { columns, rows });
  const grid = sample(image, size.columns * 2, size.rows * 2);
  const out = [];
  for (let row = 0; row < size.rows; row++) {
    const top = grid[row * 2];
    const bottom = grid[row * 2 + 1] ?? top;
    let line = '';
    // A colour holds until something changes it, so a code is only worth writing
    // where the colour actually moves — and both colours of a cell travel in one
    // sequence. Blessed rescans every escape code of every visible cell on every
    // frame, so a picture that named two colours per cell made a single wheel
    // notch cost more than the rest of the frame put together.
    let lastFg = -1;
    let lastBg = -1;
    for (let column = 0; column < size.columns; column++) {
      const tl = overComposite(top[column * 2], background);
      const tr = overComposite(top[column * 2 + 1], background);
      const bl = overComposite(bottom[column * 2], background);
      const br = overComposite(bottom[column * 2 + 1], background);
      if (!themed) {
        // Without colour the only honest signal left is brightness.
        const shade = ' .:-=+*#%@';
        const light = (tl[0] + tl[1] + tl[2] + tr[0] + tr[1] + tr[2] + bl[0] + bl[1] + bl[2] + br[0] + br[1] + br[2]) / 12;
        line += shade[Math.min(shade.length - 1, Math.floor((light / 255) * shade.length))];
      } else {
        const q = quantizeQuad([tl, tr, bl, br]);
        // A full block shows no background and a blank one shows no foreground:
        // naming the colour nothing is painted in would cost a code and change
        // nothing on screen.
        const fg = q.mask === 0b0000 ? -1 : paletteIndex(q.fg);
        const bg = q.mask === 0b1111 ? -1 : paletteIndex(q.bg);
        let codes = '';
        if (fg !== -1 && fg !== lastFg) {
          codes = `38;5;${fg}`;
          lastFg = fg;
        }
        if (bg !== -1 && bg !== lastBg) {
          codes += `${codes ? ';' : ''}48;5;${bg}`;
          lastBg = bg;
        }
        if (codes) line += `\x1b[${codes}m`;
        line += QUADRANTS[q.mask];
      }
    }
    // One reset per row: without it the last colour of a picture would bleed
    // into whatever the transcript prints next.
    out.push(themed ? `${line}\x1b[0m` : line);
  }
  return out;
}

// A PNG is decoded in-process at its full resolution; every other format goes
// through whatever the platform has, downscaled first. The ceiling is generous —
// 288px — so a JPEG is never pre-shrunk below any detail the renderer's
// nearest-neighbour sample could still show, while the decoder still reads only
// ~80k pixels.
const PREVIEW_MAX_EDGE = 288;

const IMAGE_EXT = /.(png|jpe?g|gif|webp|bmp|heic|tiff?)$/i;

export function looksLikeImage(name) {
  return IMAGE_EXT.test(String(name ?? ''));
}
// Sensitive attachments never touch os.tmpdir for conversion. Linux ffmpeg and
// Windows System.Drawing can operate entirely through pipes; macOS sips cannot,
// so unsupported formats have no thumbnail instead of a plaintext temp copy.
function convertInMemory(payload, { platform, edge = null, spawnProcess = spawn }) {
  const size = Number.isFinite(edge) && edge > 0 ? Math.floor(edge) : null;
  let cmd;
  let args;
  let input = payload;
  let base64Output = false;
  if (platform === 'linux') {
    cmd = 'ffmpeg';
    args = ['-loglevel', 'error', '-i', 'pipe:0',
      ...(size ? ['-vf', `scale=${size}:${size}:force_original_aspect_ratio=decrease`] : []),
      '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'];
  } else if (platform === 'win32') {
    cmd = 'powershell.exe';
    args = ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Drawing; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd());'
      + '$i=New-Object System.IO.MemoryStream(,$b); $o=New-Object System.IO.MemoryStream;'
      + 'try {$img=[System.Drawing.Image]::FromStream($i);'
      + (size ? `$s=[Math]::Min(1.0,${size}.0/$img.Width,${size}.0/$img.Height);`
        + '$w=[Math]::Max(1,[int]($img.Width*$s));$h=[Math]::Max(1,[int]($img.Height*$s));'
        : '$w=$img.Width;$h=$img.Height;')
      + '$bmp=New-Object System.Drawing.Bitmap $img,$w,$h;'
      + 'try {$bmp.Save($o,[System.Drawing.Imaging.ImageFormat]::Png);'
      + '[Console]::Out.Write([Convert]::ToBase64String($o.ToArray()))} finally {$bmp.Dispose();$img.Dispose()}}'
      + 'finally {$i.Dispose();$o.Dispose()}'];
    input = Buffer.from(payload.toString('base64'));
    base64Output = true;
  } else return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    try { child = spawnProcess(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { return resolve(null); }
    const output = [];
    let total = 0;
    let failed = false;
    child.on('error', () => { failed = true; resolve(null); });
    child.stdout.on('data', (part) => {
      total += part.length;
      if (total > 64 * 1024 * 1024) { failed = true; child.kill(); return; }
      output.push(part);
    });
    child.on('close', (code) => {
      if (failed || code !== 0) return resolve(null);
      const bytes = Buffer.concat(output);
      const result = base64Output ? Buffer.from(bytes.toString('utf8'), 'base64') : bytes;
      resolve(isPng(result) ? result : null);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// The only entry the chat needs: a buffer in, a decoded image out, or null when
// there is nothing to show. A missing converter is silent — the transfer still
// happened, it just gets no picture.
export function decodeImage(payload, { platform = process.platform, spawnProcess = spawn } = {}) {
  if (isPng(payload)) return Promise.resolve(decodePng(payload));
  return convertInMemory(payload, { platform, edge: PREVIEW_MAX_EDGE, spawnProcess })
    .then((png) => png ? decodePng(png) : null);
}

// A file that is not a picture gets a small card instead of a preview: the same
// half-block cell grid, one fixed colour, and the extension in the middle. It
// reads as "a file", not as text, and it is clickable just like a picture.
export function fileIconLines(name, { themed = true } = {}) {
  const ext = (path.extname(String(name ?? '')) || 'file').replace(/^\./, '').toUpperCase();
  const label = ext ? ext.slice(0, 9) : 'FILE';
  const width = 14;
  const body = `▌ ${label.padEnd(width - 4, ' ')} ▐`;
  const top = `▛${'▀'.repeat(width - 2)}▜`;
  const bottom = `▙${'▄'.repeat(width - 2)}▟`;
  if (!themed) return [top, body, bottom];
  const paint = (line) => `{#5fafff-fg}${line}{/#5fafff-fg}`;
  return [paint(top), paint(body), paint(bottom)];
}

// Terminal graphics, and why the transcript does not use them. The transcript
// lives in a blessed box, and blessed owns every cell of it: content is
// wrapped to the box width and painted cell by cell from its own buffer. Feed
// it an APC payload and it becomes text — measured, a 4125-byte first chunk
// wrapped into 106 lines of 40 characters, the ESC dropped and the base64
// clipped to the visible ten rows, so nothing resembling the sequence ever
// reaches the terminal. Writing the escape past blessed (screen.program.write)
// fares no better: blessed repaints the whole frame from its cell buffer and
// scrolls by rewriting rows rather than by scrolling the terminal, so the
// placement stays pinned to a physical row while the message it belongs to
// moves. The same cell buffer caps colour at a 9-bit palette index — blessed's
// attrCode turns `38;2;r;g;b` into colors.match() the moment it reads it — so
// a 24-bit path inside the transcript is not available either, whatever
// COLORTERM says. Hence quadrant cells at the real window size, and these two
// helpers stay a tested, unwired capability for any surface that is not the
// blessed transcript.
export function isKittyGraphicsSupported(env = process.env) {
  if (!env) return false;
  return Boolean(
    env.KITTY_WINDOW_ID
    || env.TERM === 'xterm-kitty'
    || env.GHOSTTY_RESOURCES_DIR
    || env.TERM === 'xterm-ghostty'
    || env.WEZTERM_PANE
    || env.TERM === 'wezterm',
  );
}

// Which terminal-graphics protocol this terminal actually renders. Warp claims
// neither marker yet does render iTerm2's OSC 1337 inline images (verified by
// hand); real kitty-protocol terminals (kitty, Ghostty, WezTerm) are detected
// above. Returns the protocol to emit, or null when the terminal shows no
// inline pictures at all.
export function terminalViewProtocol(env = process.env) {
  if (!env) return null;
  if (isKittyGraphicsSupported(env)) return 'kitty';
  if (env.TERM_PROGRAM === 'WarpTerminal' || env.TERM_PROGRAM === 'iTerm.app') return 'iterm';
  return null;
}

export function encodeKittyGraphics(bufferOrBase64, { cols = null, rows = null, format = 100 } = {}) {
  const base64 = Buffer.isBuffer(bufferOrBase64) ? bufferOrBase64.toString('base64') : String(bufferOrBase64);
  if (!base64) return [];
  const CHUNK_SIZE = 4096;
  const chunks = [];
  for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
    chunks.push(base64.slice(i, i + CHUNK_SIZE));
  }
  return chunks.map((chunk, i) => {
    const isLast = i === chunks.length - 1;
    const m = isLast ? 0 : 1;
    if (i === 0) {
      const colStr = cols ? `,c=${cols}` : '';
      const rowStr = rows ? `,r=${rows}` : '';
      return `\x1b_Ga=T,f=${format},m=${m}${colStr}${rowStr};${chunk}\x1b\\`;
    }
    return `\x1b_Gm=${m};${chunk}\x1b\\`;
  });
}

// The full-screen viewer sends PNG bytes to the terminal. Non-PNG formats
// are converted through pipes without writing plaintext temporary files.

export function convertToPngBytes(payload, {
  platform = process.platform,
  maxEdge = null,
  spawnProcess = spawn,
} = {}) {
  if (isPng(payload)) return Promise.resolve(payload);
  return convertInMemory(payload, { platform, edge: maxEdge, spawnProcess });
}

// The picture's size straight from the PNG header — the viewer transmits the
// file rather than decoding it, and the header is all the sizing needs.
export function pngDimensions(payload) {
  if (!isPng(payload) || !payload || payload.length < 24) return null;
  try {
    const width = payload.readUInt32BE(16);
    const height = payload.readUInt32BE(20);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

// Where a viewer picture goes. The kitty protocol can scale by one dimension
// alone and derive the other from the picture's own aspect ratio, so the plan
// names only columns and nothing can stretch. A cell is roughly twice as tall
// as it is wide (about 9x18px), which sets both the 1:1 size of a small
// picture and the row estimate that keeps the "press any key" line clear.
export function kittyViewPlan(image, {
  columns = 80,
  rows = 24,
  hintRows = 2,
  cellWidthPx = 9,
} = {}) {
  const width = image?.width;
  const height = image?.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const termCols = Math.max(24, Math.floor(Number(columns) || 80));
  const usableRows = Math.max(8, Math.floor(Number(rows) || 24) - Math.max(0, Math.floor(Number(hintRows) || 0)));
  // Never upscale a small picture past its own pixels: at 1:1 it takes
  // ceil(width / cellWidthPx) columns, and only a picture wider than the
  // terminal is scaled down to fit it.
  const nativeCols = Math.max(1, Math.ceil(width / cellWidthPx));
  const rowsFor = (cols) => Math.max(1, Math.ceil((cols * height) / width / 2));
  let cols = Math.min(termCols, nativeCols);
  if (rowsFor(cols) > usableRows) {
    // Bound by the height instead: the number of columns a usableRows-tall
    // picture of this aspect fits into.
    cols = Math.max(1, Math.floor((usableRows * 2 * width) / height));
  }
  return { cols, rows: rowsFor(cols), width, height };
}

// Draw the most recently transmitted image at the cursor, `cols` cells wide;
// the terminal derives the height from the image's own aspect ratio.
export function kittyPut(cols) {
  const c = Math.max(1, Math.floor(Number(cols) || 1));
  return `\x1b_Ga=p,c=${c},q=2\x1b\\`;
}

// Take every kitty placement off the screen. Overlays survive a screen clear,
// so the viewer deletes them when it blanks the terminal and again on the way
// out, before blessed repaints.
export const KITTY_DELETE_ALL = '\x1b_Ga=d,d=A\x1b\\';

// iTerm2's OSC 1337 inline image — the protocol Warp actually renders (verified
// by hand; its kitty support is absent). The PNG rides base64 in one escape.
// Only one of width/height is sent, so the terminal derives the other from the
// picture's own aspect ratio and nothing can stretch.
export function itermInlineImage(png, { width = null, height = null } = {}) {
  if (!isPng(png)) return '';
  const attrs = ['inline=1'];
  if (Number.isFinite(width) && width > 0) attrs.push(`width=${Math.round(width)}`);
  if (Number.isFinite(height) && height > 0) attrs.push(`height=${Math.round(height)}`);
  return `\x1b]1337;File=${attrs.join(';')}:${png.toString('base64')}\x07`;
}

// Where an OSC 1337 picture goes, in screen pixels. The terminal's pixel box
// is estimated from a cell of ~9x18px (the same assumption the kitty plan
// makes); a picture smaller than the box is shown 1:1, a larger one is scaled
// down to fit it, and the hint rows at the bottom stay clear.
export function itermViewPlan(image, {
  columns = 80,
  rows = 24,
  hintRows = 2,
  cellWidthPx = 9,
} = {}) {
  const width = image?.width;
  const height = image?.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const boxW = Math.max(1, Math.floor(Number(columns) || 80) * cellWidthPx);
  const usableRows = Math.max(1, Math.floor(Number(rows) || 24) - Math.max(0, Math.floor(Number(hintRows) || 0)));
  const boxH = usableRows * cellWidthPx * 2;
  const scale = Math.min(boxW / width, boxH / height, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
