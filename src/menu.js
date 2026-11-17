import './wide-chars.js'; // must load before blessed builds any screen
import blessed from 'blessed';
import { renderMenuMarkup, menuRuleLabel } from './ui.js';

// A list chosen with the arrows, drawn exactly like the app's command menu:
// same cursor, same reverse video, same two-column colours. Used before the TUI
// exists — the startup picker, the first-run questions — so it owns its own
// blessed screen and hands the terminal back before the app takes it.

export function interactive(input = process.stdin, output = process.stdout) {
  return Boolean(input?.isTTY && output?.isTTY);
}

// How many list rows fit between the title rule and the hint line of this
// full-screen frame. The list used to be capped at a fixed six whatever the
// terminal, so on a short window the surplus rows were drawn straight through
// the hint and the bottom border and clipped by blessed — a roster of a dozen
// people showed as four or five, with the hint buried under the spill. Derived
// from the screen instead, so a tall terminal shows the whole list and a short
// one scrolls a list that actually fits. cloud/prompt.js draws the same chrome
// (title at top:1, list at top:3, hint at bottom:1) and re-uses this rather
// than keeping its own copy.
export function menuListRoom(screenHeight) {
  // 3 for the border and title rule above, 2 for the hint and border below, and
  // one spare line so the selection never sits flush against the hint.
  const room = Number(screenHeight) - 6;
  // Three is the floor worth drawing at all: a chosen row with one neighbour
  // either side. Below that the terminal is too small to pick from anyway, and
  // blessed clipping a row is better than rendering nothing.
  return Number.isFinite(room) ? Math.max(3, room) : 10;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// A lone ESC means "cancel", but ESC also opens every arrow sequence — the
// difference is only time. Anything split longer than this by a laggy link
// reads as a cancel, which is still a reasonable answer to a stray escape.
const ESC_MS = 300;

function rule(label, width) {
  const prefix = `─ ${label} `;
  const dashes = '─'.repeat(Math.max(0, width - prefix.length));
  return `${prefix}${dashes}`;
}

// Resolves the chosen row's `value` (or its `name` when there is none), or null
// when the person cancelled or there is no terminal to ask (a pipe, a script):
// a menu nobody can see is a hang.
export function runListMenu({
  title = 'menu',
  rows = [], // [{ name, help, value? }] — the shape renderMenuMarkup eats
  keysHint = '',
  themed = true,
  termux = false,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  return new Promise((resolve) => {
    if (!interactive(input, output) || rows.length === 0) return resolve(null);

    const screen = blessed.screen({
      smartCSR: !termux,
      title: 'tailchat',
      fullUnicode: true,
      input,
      output,
    });
    const frame = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      border: 'line',
      style: themed
        ? { border: { fg: 'green' } }
        : { border: { fg: 'white' } },
    });
    const titleBox = blessed.box({
      parent: frame, top: 1, left: 1, right: 1, height: 1, tags: true,
    });
    // No `keys: true`: a key-grabbing child of a bordered frame renders blank
    // on this blessed version.
    const list = blessed.box({
      parent: frame, top: 3, left: 1, right: 1, height: 1, tags: true,
    });
    const hint = blessed.box({
      parent: frame, bottom: 1, left: 1, right: 1, height: 1, tags: true,
    });

    let index = 0;
    let offset = 0;
    const nameWidth = Math.max(1, ...rows.map(({ name }) => String(name).length));

    const render = () => {
      const visible = Math.min(menuListRoom(screen.height), rows.length);
      if (index < offset) offset = index;
      else if (index >= offset + visible) offset = index - visible + 1;
      offset = clamp(offset, 0, Math.max(0, rows.length - visible));
      const shown = rows.slice(offset, offset + visible);
      const hidden = rows.length - shown.length;
      list.height = shown.length;
      const label = menuRuleLabel({
        index, total: rows.length, shown: shown.length, word: title,
      });
      const width = Math.max(1, Number(screen.width) - 4);
      titleBox.setContent(themed
        ? `{green-fg}{bold}${blessed.escape(rule(label, width))}{/bold}{/green-fg}`
        : blessed.escape(rule(label, width)));
      list.setContent(renderMenuMarkup({
        shown, hidden, chosenIndex: index - offset, width, themed, nameWidth,
      }));
      hint.setContent(themed
        ? `{green-fg}${blessed.escape(keysHint)}{/green-fg}`
        : blessed.escape(keysHint));
      screen.render();
    };

    // Navigation has one decoder: Blessed's program keypress stream. `finish`
    // only guards callbacks that race during teardown; adding a raw data
    // fallback here would process each arrow twice.
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      screen.program.removeListener('keypress', onKeypress);
      screen.destroy();
      resolve(value);
    };
    const pick = () => finish(rows[index]?.value ?? rows[index]?.name ?? null);
    const cancel = () => finish(null);
    const move = (delta) => {
      index = Math.min(Math.max(0, index + delta), rows.length - 1);
      render();
    };
    const pickDigit = (digit) => {
      const at = Number(digit) - 1;
      if (at >= 0 && at < rows.length) {
        index = at;
        pick();
      }
    };

    const onKeypress = (ch, key) => {
      const name = key?.name;
      if (name === 'up') return move(-1);
      if (name === 'down') return move(1);
      if (name === 'enter' || name === 'return') return pick();
      if (name === 'escape' || key?.full === 'C-c') return cancel();
      if (typeof ch === 'string' && /^[1-9]$/.test(ch)) return pickDigit(ch);
      return undefined;
    };
    screen.program.on('keypress', onKeypress);

    render();
  });
}
