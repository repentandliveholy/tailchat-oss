#!/usr/bin/env node
// A Tailchat transcript drawn straight into the terminal's own scrollback —
// no blessed, no alternate screen, no full-screen repaint. This is the
// question "should Tailchat move to a native terminal UI?" as something you
// can look at: same wordmark, same `{name}` bubbles, same voice card and read
// marks as the TUI, but every picture is real pixels through the terminal's
// graphics protocol instead of a 36-column block-art stamp.
//
// Run it, then scroll up: the pictures are still there, and so is everything
// the app said. That is the whole argument, and its cost (see
// docs/native-terminal.md) is every interactive affordance the TUI has.
//
// Usage: node bin/native-terminal-demo.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  terminalViewProtocol,
  convertToPngBytes,
  pngDimensions,
  itermInlineImage,
  encodeKittyGraphics,
  kittyPut,
  renderPreview,
  decodeImage,
} from '../src/preview.js';
import { computeWaveform, formatVoiceCard } from '../src/voice.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = (text) => process.stdout.write(text);

// The palette the green theme uses, as plain SGR: a native front end has no
// blessed tags, so every colour here is what the terminal itself understands.
const C = {
  signal: '\x1b[38;2;0;255;102m',
  cobalt: '\x1b[38;2;95;175;255m',
  muted: '\x1b[38;2;122;138;134m',
  text: '\x1b[38;2;226;236;232m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  off: '\x1b[0m',
};

const LOGO = [
  '   /\\_/\\    ▀█▀ ▄▀█ █ █   █▀▀ █ █ ▄▀█ ▀█▀',
  '  ( o.o )    █  █▀█ █ █▄▄ █▄▄ █▀█ █▀█  █ ',
  '   > ^ <    p2p over cloud & tailnet',
];

const columns = process.stdout.columns || 80;

function rule() {
  out(`${C.dim}${'─'.repeat(Math.min(columns, 72))}${C.off}\n`);
}

function header() {
  out('\n');
  for (const row of LOGO) out(`${C.signal}${row}${C.off}\n`);
  out(`${C.muted}[ TAILCHAT / CLOUD ]  peer: ${C.off}${C.cobalt}{Anna}${C.off}`
    + ` ${C.signal}●${C.off} ${C.muted}online${C.off}\n`);
  rule();
}

// The transcript's own message shape: `[hh:mm] {name}: text`, with the two
// read marks the app uses (✓ delivered, ✓✓ read) on one's own lines.
function line(name, text, { own = false, mark = null } = {}) {
  const now = new Date();
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const who = own ? C.signal : C.cobalt;
  const tick = mark ? ` ${C.muted}${mark}${C.off}` : '';
  out(`${C.muted}[${clock}]${C.off} ${who}{${name}}${C.off}: ${C.text}${text}${C.off}${tick}\n`);
}

function note(text) {
  out(`${C.muted}* ${text}${C.off}\n`);
}

// One picture, drawn as pixels when the terminal speaks a graphics protocol
// and as the TUI's block art when it does not — so the same run shows both
// halves of the comparison on a terminal that supports images, and degrades
// to exactly today's output on one that does not.
async function picture(file, { cells = 24 } = {}) {
  const payload = fs.readFileSync(file);
  const protocol = terminalViewProtocol();
  const label = path.basename(file);

  if (!protocol) {
    const image = await decodeImage(payload);
    const art = image ? renderPreview(image, { columns: 36, rows: 30, themed: false }) : [];
    note(`${label} — block art (no graphics protocol in this terminal)`);
    for (const row of art) out(`${row}\n`);
    return;
  }

  const png = await convertToPngBytes(payload);
  const dims = png ? pngDimensions(png) : null;
  if (!png || !dims) {
    note(`${label} — could not be decoded`);
    return;
  }
  note(`${label} — ${dims.width}x${dims.height}, real pixels via ${protocol}`);
  if (protocol === 'kitty') {
    for (const chunk of encodeKittyGraphics(png)) out(chunk);
    out(kittyPut(cells));
    out('\n');
  } else {
    // A cell is about 9px wide; `cells` keeps the two protocols the same size.
    out(itermInlineImage(png, { width: cells * 9 }));
    out('\n');
  }
}

// A voice note exactly as the transcript draws one: the waveform is computed
// from real samples, not faked, so the card is the same card.
function voiceCard() {
  const samples = Array.from({ length: 4000 }, (_, i) => (
    Math.sin(i / 9) * Math.exp(-((i - 1400) ** 2) / 900_000)
  ));
  const card = formatVoiceCard(7, computeWaveform(samples, 24), { openWith: '/open 1' });
  out(`${C.signal}${card}${C.off}\n`);
}

async function main() {
  header();
  line('Anna', 'привет! смотри подборку', {});
  line('Roman', 'смотрю', { own: true, mark: '✓✓' });
  out('\n');
  await picture(path.join(root, 'web/cloud/icons/icon-512.png'), { cells: 20 });
  out('\n');
  line('Anna', 'и второй вариант иконки:', {});
  await picture(path.join(root, 'web/cloud/icons/maskable-512.png'), { cells: 20 });
  out('\n');
  line('Anna', 'голосом объясню', {});
  voiceCard();
  out('\n');
  line('Roman', 'принял, отвечу текстом', { own: true, mark: '✓' });
  note('unread ─────────── new messages ───────────');
  line('Anna', 'ещё одно, уже после того как ты отошёл', {});
  rule();
  const protocol = terminalViewProtocol() || 'none';
  note(`terminal: ${process.env.TERM_PROGRAM || process.env.TERM || 'unknown'}`
    + `  graphics: ${protocol}  width: ${columns} cols`);
  note('scroll up: every picture and every line is in this terminal\'s own scrollback');
  note('read docs/native-terminal.md for what this design gains and what it costs');
  out('\n');
}

main().catch((error) => {
  process.stderr.write(`native demo failed: ${error.message}\n`);
  process.exit(1);
});
