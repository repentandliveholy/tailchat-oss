import unicode from 'blessed/lib/unicode.js';

// blessed@0.1.81 predates modern emoji: `charWidth` only knows CJK plus the
// enclosed-ideograph block, and its wide-char regex only covers the CJK
// extension planes. A terminal paints emoji in two cells, so blessed's own
// wrapping drifts one cell per emoji, pushing text past the frame and shifting
// whole rows. Correct both tables together — patching one alone re-desyncs the
// screen buffer, because `charWidth` measures while `chars.all` inserts the
// filler cell that keeps the next character from being eaten.

const BMP_EMOJI_RANGES = [
  [0x231a, 0x231b], [0x2328, 0x2328], [0x23cf, 0x23cf], [0x23e9, 0x23f3],
  [0x23f8, 0x23fa], [0x24c2, 0x24c2], [0x25aa, 0x25ab], [0x25b6, 0x25b6],
  [0x25c0, 0x25c0], [0x25fb, 0x25fe], [0x2600, 0x2604], [0x260e, 0x260e],
  [0x2611, 0x2611], [0x2614, 0x2615], [0x2618, 0x2618], [0x261d, 0x261d],
  [0x2620, 0x2620], [0x2622, 0x2623], [0x2626, 0x2626], [0x262a, 0x262a],
  [0x262e, 0x262f], [0x2638, 0x263a], [0x2640, 0x2640], [0x2642, 0x2642],
  [0x2648, 0x2653], [0x265f, 0x265f], [0x2668, 0x2668], [0x267b, 0x267b],
  [0x267e, 0x267f], [0x2692, 0x2697], [0x2699, 0x2699], [0x269b, 0x269c],
  [0x26a0, 0x26a1], [0x26a7, 0x26a7], [0x26aa, 0x26ab], [0x26b0, 0x26b1],
  [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26c8, 0x26c8], [0x26ce, 0x26cf],
  [0x26d1, 0x26d1], [0x26d3, 0x26d4], [0x26e9, 0x26ea], [0x26f0, 0x26f5],
  [0x26f7, 0x26fa], [0x26fd, 0x26fd], [0x2702, 0x2702], [0x2705, 0x2705],
  [0x2708, 0x270d], [0x270f, 0x270f], [0x2712, 0x2712], [0x2714, 0x2714],
  [0x2716, 0x2716], [0x271d, 0x271d], [0x2721, 0x2721], [0x2728, 0x2728],
  [0x2733, 0x2734], [0x2744, 0x2744], [0x2747, 0x2747], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27a1, 0x27a1], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2934, 0x2935],
  [0x2b05, 0x2b07], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x3030, 0x3030], [0x303d, 0x303d], [0x3297, 0x3297], [0x3299, 0x3299],
];

const ASTRAL_EMOJI_RANGES = [
  [0x1f000, 0x1faff],
];

const EMOJI_RANGES = [...BMP_EMOJI_RANGES, ...ASTRAL_EMOJI_RANGES];
const EMOJI_BMP_CLASS = `[\\u231a-\\u231b\\u2328\\u23cf\\u23e9-\\u23f3\\u23f8-\\u23fa\\u24c2\\u25aa-\\u25ab\\u25b6\\u25c0\\u25fb-\\u25fe\\u2600-\\u2604\\u260e\\u2611\\u2614-\\u2615\\u2618\\u261d\\u2620\\u2622-\\u2623\\u2626\\u262a\\u262e-\\u262f\\u2638-\\u263a\\u2640\\u2642\\u2648-\\u2653\\u265f\\u2668\\u267b\\u267e-\\u267f\\u2692-\\u2697\\u2699\\u269b-\\u269c\\u26a0-\\u26a1\\u26a7\\u26aa-\\u26ab\\u26b0-\\u26b1\\u26bd-\\u26be\\u26c4-\\u26c5\\u26c8\\u26ce-\\u26cf\\u26d1\\u26d3-\\u26d4\\u26e9-\\u26ea\\u26f0-\\u26f5\\u26f7-\\u26fa\\u26fd\\u2702\\u2705\\u2708-\\u270d\\u270f\\u2712\\u2714\\u2716\\u271d\\u2721\\u2728\\u2733-\\u2734\\u2744\\u2747\\u274c\\u274e\\u2753-\\u2755\\u2757\\u2795-\\u2797\\u27a1\\u27b0\\u27bf\\u2934-\\u2935\\u2b05-\\u2b07\\u2b1b-\\u2b1c\\u2b50\\u2b55\\u3030\\u303d\\u3297\\u3299]`;
const EMOJI_SURROGATES = '[\\ud83c-\\ud83f][\\udc00-\\udfff]';

function isWideEmoji(point) {
  return EMOJI_RANGES.some(([low, high]) => point >= low && point <= high);
}

const originalCharWidth = unicode.charWidth;

unicode.charWidth = function charWidth(str, i) {
  const point = typeof str !== 'number'
    ? unicode.codePointAt(str, i || 0)
    : str;
  if (isWideEmoji(point)) return 2;
  return originalCharWidth.call(this, str, i);
};

unicode.chars.wide = new RegExp(
  `(${EMOJI_BMP_CLASS}|${unicode.chars.wide.source.slice(1, -1)})`,
  'g',
);

unicode.chars.swide = new RegExp(
  `(${EMOJI_SURROGATES}|${unicode.chars.swide.source.slice(1, -1)})`,
  'g',
);

unicode.chars.all = new RegExp(
  `(${EMOJI_BMP_CLASS}|${unicode.chars.swide.source.slice(1, -1)}|${unicode.chars.wide.source.slice(1, -1)})`,
  'g',
);

export const patchedEmojiRanges = EMOJI_RANGES;

// blessed@0.1.81 duplicates keypress events when Node's native readline has
// also touched the input stream, because Node's `emitKeypressEvents` leaves an
// active `onData` listener on `input`. When blessed subsequently attaches its
// own decoder, every keystroke fires twice. Purging Node's keypress decoder
// before blessed listens guarantees exactly 1 keypress per keystroke.
import Screen from 'blessed/lib/widgets/screen.js';
import Program from 'blessed/lib/program.js';

export function cleanupStreamKeypress(stream) {
  if (!stream) return;
  const syms = Object.getOwnPropertySymbols(stream);
  for (const s of syms) {
    if (String(s).toLowerCase().includes('keypress') || String(s).toLowerCase().includes('escape')) {
      delete stream[s];
    }
  }
  if (typeof stream.listeners === 'function') {
    stream.listeners('data').forEach((fn) => {
      if (fn.name === 'onData') stream.removeListener('data', fn);
    });
    stream.listeners('newListener').forEach((fn) => {
      if (fn.name === 'onNewListener') stream.removeListener('newListener', fn);
    });
  }
  delete stream._keypressDecoder;
}

const originalListenInput = Program.prototype._listenInput;
Program.prototype._listenInput = function _listenInput() {
  cleanupStreamKeypress(this.input);
  if (this.input && !this.input._tailchatNormalized) {
    this.input._tailchatNormalized = true;
    const origEmit = this.input.emit;
    this.input.emit = function(event, ...args) {
      if (event === 'data' && args[0]) {
        let str = typeof args[0] === 'string' ? args[0] : args[0].toString('binary');
        if (str.includes('\x1b')) {
          str = str
            .replace(/\x1b\t/g, '\x1b[1;3I')
            .replace(/\x1b\x1b\[Z/g, '\x1b[1;4I')
            .replace(/\x1b\[27;3;9~/g, '\x1b[1;3I')
            .replace(/\x1b\[9;3u/g, '\x1b[1;3I')
            .replace(/\x1b\[27;4;9~/g, '\x1b[1;4I')
            .replace(/\x1b\[9;4u/g, '\x1b[1;4I')
            .replace(/\x1b\[1;3Z/g, '\x1b[1;4I')
            .replace(/\x1b\[1;4Z/g, '\x1b[1;4I')
            .replace(/\x1b\[27;5;9~/g, '\x1b[1;5I')
            .replace(/\x1b\[9;5u/g, '\x1b[1;5I')
            .replace(/\x1b\[27;6;9~/g, '\x1b[1;6I')
            .replace(/\x1b\[9;6u/g, '\x1b[1;6I')
            .replace(/\x1b\[1;5Z/g, '\x1b[1;6I');
          args[0] = Buffer.isBuffer(args[0]) ? Buffer.from(str, 'binary') : str;
        }
      } else if (event === 'keypress' && args[1]) {
        const key = args[1];
        if (key && (key.code === '[I' || (typeof key.sequence === 'string' && key.sequence.startsWith('\x1b[1;') && key.sequence.endsWith('I')))) {
          key.name = 'tab';
        }
      }
      return origEmit.apply(this, [event, ...args]);
    };
  }
  return originalListenInput.call(this);
};

// blessed retains all created Program and Screen instances in global arrays
// even after screen.destroy(), causing keypress and resize leaks on multi-screen flows.
const originalScreenDestroy = Screen.prototype.destroy;
Screen.prototype.destroy = function destroy() {
  if (this.program) {
    const pIdx = Program.instances.indexOf(this.program);
    if (pIdx !== -1) Program.instances.splice(pIdx, 1);
    this.program.removeAllListeners();
  }
  const sIdx = Screen.instances.indexOf(this);
  if (sIdx !== -1) Screen.instances.splice(sIdx, 1);
  if (originalScreenDestroy) originalScreenDestroy.call(this);
};


