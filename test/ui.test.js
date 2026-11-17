import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import blessed from 'blessed';
import colors from 'blessed/lib/colors.js';
import {
  createHistoryBuffer,
  statusPresentation,
  isCompact,
  renderHeaderMarkup,
  renderInfoPanelMarkup,
  renderMessageMarkup,
  continuationPrefixWidth,
  displayWidth,
  renderBodyMarkup,
  findLink,
  createUI,
  shimmerMarkup,
  shimmerSpan,
  layoutTable,
  worstCaseWidth,
  renderMenuMarkup,
  menuRuleLabel,
  THEMES,
  THEME_NAMES,
  DEFAULT_THEME,
  renderRosterBarMarkup,
  fileLinkLine,
  mergeMessageState,
  climbs,
  RECEIPT_MARKERS,
} from '../src/ui.js';
import { transcriptKeys } from '../src/paste.js';

test('status presentation distinguishes online, reconnecting, and offline', () => {
  assert.deepEqual(statusPresentation('online', true), {
    symbol: '●', label: 'ONLINE', color: 'green',
  });
  assert.deepEqual(statusPresentation('reconnecting…', true), {
    symbol: '◌', label: 'RECONNECTING', color: 'yellow',
  });
  assert.deepEqual(statusPresentation('offline', true), {
    symbol: '●', label: 'OFFLINE', color: 'red',
  });
});

test('markup only uses colour names blessed can actually parse', () => {
  // `{brightgreen-fg}` is a valid style value but blessed's tag parser prints
  // it as literal text, which once wiped the status out of the header.
  const PARSEABLE = new Set([
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', 'grey',
  ]);
  const statuses = ['active', 'idle', 'away', 'online', 'reconnecting…', 'offline', ''];
  for (const status of statuses) {
    const { color } = statusPresentation(status, true);
    assert.ok(PARSEABLE.has(color), `${status || 'connecting'} uses untaggable colour ${color}`);
  }

  const rendered = renderMessageMarkup({
    ts: Date.now(), name: 'Roman', text: 'hi', self: false, themed: true, marker: '✓✓',
  });
  for (const tag of rendered.matchAll(/\{\/?([a-z]+)-fg\}/g)) {
    assert.ok(PARSEABLE.has(tag[1]), `message markup uses untaggable colour ${tag[1]}`);
  }
});

test('the default theme reproduces the original self/peer colours, and others exist', () => {
  assert.equal(DEFAULT_THEME, 'green');
  assert.equal(THEMES[DEFAULT_THEME].self, 'green');
  assert.equal(THEMES[DEFAULT_THEME].peer, 'cyan');
  assert.ok(THEME_NAMES.includes('green'));
  assert.ok(THEME_NAMES.includes('nord'));
  assert.ok(THEME_NAMES.includes('catppuccin'));
  assert.ok(THEME_NAMES.includes('tokyo'));
  assert.ok(THEME_NAMES.includes('gruvbox'));
  assert.ok(THEME_NAMES.includes('solarized'));
  assert.ok(THEME_NAMES.length > 1, '/theme only means something with more than one choice');
});

test('every theme border resolves to a real colour, not blessed\'s untagged fallback', () => {
  // `Element.prototype.sattr` (blessed/lib/widgets/element.js) feeds a widget's
  // own `style.border.fg` through `colors.convert`, which only special-cases
  // `typeof number` and a leading `#`. A numeric *string* like `'220'` matches
  // neither, so it silently resolved to blessed's untagged default (0x1ff) and
  // the border for that theme never actually changed colour. Only markup tags
  // (`{220-fg}`) go through a different, digit-aware path — this is why a
  // theme's border needs its own check.
  const FALLBACK = 0x1ff;
  for (const name of THEME_NAMES) {
    const converted = colors.convert(THEMES[name].border);
    assert.notEqual(converted, FALLBACK, `${name}'s border does not resolve to a real colour`);
  }
});

test('self, the peer and a bot each read as a different labelled voice', () => {
  const colorOf = (markup) => /\{(\w+)-bg\}\{black-fg\}\{bold\}/.exec(markup)[1];
  const self = renderMessageMarkup({
    ts: Date.now(), name: 'me', text: 'hi', self: true, themed: true,
  });
  const peer = renderMessageMarkup({
    ts: Date.now(), name: 'Roman', text: 'hi', self: false, themed: true,
  });
  const bot = renderMessageMarkup({
    ts: Date.now(), name: 'tailik', text: 'hi', self: false, bot: true, themed: true,
  });
  assert.equal(colorOf(self), THEMES[DEFAULT_THEME].self);
  assert.equal(colorOf(peer), THEMES[DEFAULT_THEME].peer);
  assert.equal(colorOf(bot), THEMES[DEFAULT_THEME].bot);
  assert.equal(new Set([colorOf(self), colorOf(peer), colorOf(bot)]).size, 3);
});

test('a marker colour tells a delivered ✓✓ from a read one', () => {
  const ts = new Date('2026-08-12T13:09:00').getTime();
  // Delivered is quiet: the peer's device holds the message, but nothing about
  // the peer's own reading has been claimed.
  const delivered = renderMessageMarkup({
    ts, name: 'Roman', text: 'hi', self: false, marker: '✓✓', themed: true,
  });
  assert.match(delivered, /\[13:09\]\{\/245-fg\} \{245-fg\}✓✓/);
  assert.doesNotMatch(delivered, /\{green-fg\}✓✓/, 'delivered must not wear the read accent');

  // The same glyph with the read flag is the accent.
  const read = renderMessageMarkup({
    ts, name: 'Roman', text: 'hi', self: false, marker: '✓✓', markerRead: true, themed: true,
  });
  assert.match(read, /\[13:09\]\{\/245-fg\} \{green-fg\}✓✓/);
});

test('monochrome status removes color and decorative symbol', () => {
  assert.deepEqual(statusPresentation('online', false), {
    symbol: '', label: 'ONLINE', color: null,
  });
});

test('layout becomes compact below 60 columns', () => {
  assert.equal(isCompact(80), false);
  assert.equal(isCompact(60), false);
  assert.equal(isCompact(59), true);
});

test('message markup escapes blessed tags and preserves newlines', () => {
  const out = renderMessageMarkup({
    ts: new Date('2026-08-12T13:09:00').getTime(),
    name: '{red-fg}Roman{/red-fg}',
    text: 'hello {bold}world{/bold}\nsecond line',
    self: false,
    themed: true,
  });
  assert.match(out, /\{open\}red-fg\{close\}Roman/);
  assert.match(out, /\{open\}bold\{close\}world/);
  assert.match(out, /\n/);
  assert.doesNotMatch(out, /\{red-fg\}Roman/);
});

test('message markup removes terminal control bytes', () => {
  const out = renderMessageMarkup({
    ts: new Date('2026-08-12T13:09:00').getTime(),
    name: 'Roman\x1b[8m',
    text: 'visible\x1b[31mred',
    self: false,
    themed: true,
  });
  assert.doesNotMatch(out, /\x1b/);
  assert.match(out, /Roman/);
  assert.match(out, /visiblered/);
});

test('history buffer does not reparse escaped peer markup', () => {
  const history = createHistoryBuffer();
  history.appendMessage({
    ts: new Date('2026-08-12T13:09:00').getTime(),
    name: '{red-fg}Roman{/red-fg}',
    text: '{bold}first{/bold}',
    self: false,
  });
  history.appendMessage({
    ts: new Date('2026-08-12T13:10:00').getTime(),
    name: 'Roman',
    text: 'second',
    self: false,
  });
  assert.match(history.content(), /\{open\}red-fg\{close\}Roman/);
  assert.doesNotMatch(history.content(), /\{red-fg\}Roman/);
});

test('header keeps full online status inside its exact widget width', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  const screen = blessed.screen({
    input,
    output,
    terminal: 'xterm-256color',
    fullUnicode: true,
  });
  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: 76,
    height: 1,
    tags: true,
  });
  header.setContent(renderHeaderMarkup({
    width: 76,
    selfName: 'Alice',
    peerName: '{red-fg}Roman{/red-fg}',
    status: 'online',
    themed: true,
  }));
  screen.render();
  const cells = screen.lines[0].slice(0, 76).map((cell) => cell[1]).join('');
  screen.destroy();
  assert.match(cells, /\{red-fg\}Roman\{\/red-fg\}/);
  assert.match(cells, /● ONLINE/);
});

// Regression: the transport badge (⚡/🌐) and peerClient suffix are cells,
// not code points — displayWidth(2) each — but the header's gap/limit math
// used Array.from(...).length (code points) until this fix, undercounting
// the badge by a cell and pushing the status text past the widget's exact
// width, where blessed drops the overflow instead of wrapping it. This is
// exactly "ACTIVE disappeared from the header" once a P2P/Cloud badge
// started rendering.
test('a transport badge does not push the status text off the header width', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  const screen = blessed.screen({
    input,
    output,
    terminal: 'xterm-256color',
    fullUnicode: true,
  });
  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: 76,
    height: 1,
    tags: true,
  });
  header.setContent(renderHeaderMarkup({
    width: 76,
    selfName: 'Alice',
    peerName: 'Roman',
    peerDevice: 'macbook',
    status: 'active',
    themed: true,
    transport: 'p2p',
    peerClient: 'cli',
  }));
  screen.render();
  const cells = screen.lines[0].slice(0, 76).map((cell) => cell[1]).join('');
  screen.destroy();
  assert.match(cells, /⚡/, 'the transport badge itself must still render');
  assert.match(cells, /● ACTIVE/, 'status text must survive the badge, not be pushed off the widget');
});

// Regression: an emoji badge next to the "↔" separator could still land the
// rendered line a cell or two past the header's exact width even after
// displayWidth() was used throughout (residual blessed wrap-width quirks
// with mixed wide/narrow runs) — and without `wrap: false` on the header
// box, blessed silently word-wrapped the overflow (the status text) onto a
// second line a height:1 box never shows, instead of clipping it visibly.
test('header content that slightly overflows is clipped, not wrapped onto an invisible line', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  const screen = blessed.screen({
    input, output, terminal: 'xterm-256color', fullUnicode: true,
  });
  const header = blessed.box({
    parent: screen, top: 0, left: 0, width: 76, height: 1, tags: true, wrap: false,
  });
  header.setContent(renderHeaderMarkup({
    width: 76,
    selfName: 'godsheep',
    peerName: 'roman',
    peerDevice: 'macbook',
    status: 'idle',
    themed: true,
    transport: 'cloud',
    peerClient: 'cli',
    version: '0.81k',
  }));
  screen.render();
  const cells = screen.lines[0].slice(0, 76).map((cell) => cell[1]).join('');
  screen.destroy();
  assert.match(cells, /◐ IDLE/, `status text must stay visible: ${JSON.stringify(cells)}`);
});

function headlessUI({ columns = 80, ...options } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = columns;
  output.rows = 24;
  output.resume();
  return createUI({
    selfName: 'Alice',
    peerLabel: 'Roman',
    input,
    output,
    ...options,
  });
}

test('history follows the tail until the reader scrolls up', () => {
  const ui = headlessUI();
  try {
    for (let n = 0; n < 60; n++) {
      ui.addMessage({ name: 'Roman', text: `line ${n}`, ts: Date.now(), self: false });
    }
    assert.equal(ui.isFollowingTail(), true);

    ui.scrollHistory(-10);
    assert.equal(ui.isFollowingTail(), false);
  } finally {
    ui.destroy();
  }
});

test('a batch of messages paints the whole transcript and keeps the tail', () => {
  const ui = headlessUI();
  try {
    const batch = Array.from({ length: 40 }, (_, n) => ({
      id: `m${n}`, name: 'Roman', text: `batch line ${n}`, ts: Date.now(), self: false,
    }));
    // A replayed conversation is painted with one call: the buffer renders each
    // entry and joins it once, instead of handing blessed the whole transcript
    // per message (which blessed rewraps line by line, every time).
    assert.equal(ui.addMessages(batch), batch.length);
    const transcript = ui.transcript();
    for (const message of batch) {
      assert.ok(transcript.includes(message.text), `${message.text} is missing from the batch`);
    }
    assert.equal(ui.isFollowingTail(), true);

    // And it belongs at the end of the conversation like any other message: a
    // reader who had scrolled up is brought back down to it.
    ui.scrollHistory(-5);
    assert.equal(ui.isFollowingTail(), false);
    ui.addMessages([{ id: 'm-late', name: 'Roman', text: 'arrives in a batch', ts: Date.now(), self: false }]);
    assert.equal(ui.isFollowingTail(), true);
    assert.ok(ui.transcript().includes('arrives in a batch'));
  } finally {
    ui.destroy();
  }
});

test('a new message brings a scrolled-back reader down to it', () => {
  const ui = headlessUI();
  try {
    for (let n = 0; n < 60; n++) {
      ui.addMessage({ name: 'Roman', text: `line ${n}`, ts: Date.now(), self: false });
    }
    ui.scrollHistory(-10);
    assert.equal(ui.isFollowingTail(), false);

    ui.addMessage({ name: 'Roman', text: 'arrives while reading', ts: Date.now(), self: false });
    assert.equal(ui.isFollowingTail(), true, 'a message you would otherwise miss wins');

    ui.scrollHistory(-10);
    ui.addMessage({ name: 'me', text: 'my own reply', ts: Date.now(), self: true });
    assert.equal(ui.isFollowingTail(), true, 'sending also returns to the tail');
  } finally {
    ui.destroy();
  }
});

test('a status line does not move a reader who is browsing history', () => {
  const ui = headlessUI();
  try {
    for (let n = 0; n < 60; n++) {
      ui.addMessage({ name: 'Roman', text: `line ${n}`, ts: Date.now(), self: false });
    }
    ui.scrollHistory(-10);
    const anchored = ui.historyScrollOffset();

    ui.addLine('* peer disconnected, reconnecting…');

    assert.equal(ui.isFollowingTail(), false, 'noise must not steal the view');
    assert.equal(ui.historyScrollOffset(), anchored);
  } finally {
    ui.destroy();
  }
});

test('scrolling back to the bottom resumes following the tail', () => {
  const ui = headlessUI();
  try {
    for (let n = 0; n < 60; n++) {
      ui.addMessage({ name: 'Roman', text: `line ${n}`, ts: Date.now(), self: false });
    }
    ui.scrollHistory(-10);
    assert.equal(ui.isFollowingTail(), false);

    ui.scrollHistory(1000);
    assert.equal(ui.isFollowingTail(), true);

    ui.addMessage({ name: 'Roman', text: 'tail again', ts: Date.now(), self: false });
    assert.equal(ui.isFollowingTail(), true);
  } finally {
    ui.destroy();
  }
});

test('displayWidth counts emoji as double-width and ignores zero-width marks', () => {
  assert.equal(displayWidth('ab'), 2);
  assert.equal(displayWidth('привет'), 6);
  assert.equal(displayWidth('❤️'), 2, 'U+2764 U+FE0F renders in two cells');
  assert.equal(displayWidth('🚀'), 2);
  assert.equal(displayWidth('❤️'.repeat(10)), 20);
  assert.equal(displayWidth(''), 0);
});

test('emoji draft is normalised to terminal-safe width', () => {
  const ui = headlessUI();
  try {
    // Variation selectors are stripped so blessed and the terminal agree on
    // width; 60 text-presentation hearts still fit one 80-column row.
    ui.setDraft('❤️'.repeat(60));
    assert.equal(ui.composerRows(), 1);

    ui.setDraft('❤️'.repeat(300));
    const rows = ui.composerRows();
    assert.ok(rows > 1, 'an over-long emoji draft must wrap');
    assert.ok(rows <= 5, `composer must stay within its budget, got ${rows}`);
  } finally {
    ui.destroy();
  }
});

test('long plain draft wraps within the composer budget', () => {
  const ui = headlessUI();
  try {
    ui.setDraft('a'.repeat(400));
    const rows = ui.composerRows();
    assert.ok(rows > 1, 'long draft must wrap');
    assert.ok(rows <= 5, `composer must stay within its budget, got ${rows}`);
  } finally {
    ui.destroy();
  }
});

test('one wheel notch scrolls a few lines, not half a page', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  output.resume();

  const ui = createUI({ selfName: 'Alice', peerLabel: 'Roman', input, output });
  try {
    for (let n = 0; n < 80; n++) {
      ui.addMessage({ name: 'Roman', text: `line ${n}`, ts: Date.now(), self: false });
    }
    const atTail = ui.historyScrollOffset();

    // SGR wheel-up (button 64) over the history region.
    input.write('\x1b[<64;10;5M');
    await new Promise((resolve) => setTimeout(resolve, 120));

    const moved = atTail - ui.historyScrollOffset();
    assert.equal(moved, ui.wheelStep, `one notch must move exactly ${ui.wheelStep} lines`);
    assert.ok(ui.wheelStep <= 4, `wheel step must stay small, got ${ui.wheelStep}`);
  } finally {
    ui.destroy();
  }
});

test('clearHistory empties the transcript and resumes tail following', () => {
  const ui = headlessUI();
  try {
    for (let n = 0; n < 40; n++) {
      ui.addMessage({ name: 'Roman', text: `line ${n}`, ts: Date.now(), self: false });
    }
    ui.scrollHistory(-5);
    ui.clearHistory();
    assert.equal(ui.isFollowingTail(), true);
    assert.equal(ui.historyScrollOffset(), 0);
  } finally {
    ui.destroy();
  }
});

test('history buffer renders entries and updates one marker in place', () => {
  const buffer = createHistoryBuffer();
  buffer.appendLine('* system note');
  buffer.appendMessage({ id: 'aa', name: 'me', text: 'first', ts: 0, self: true, marker: '⧗' });
  buffer.appendMessage({ id: 'bb', name: 'me', text: 'second', ts: 0, self: true, marker: '⧗' });

  assert.equal(buffer.setMarker('aa', '✓'), true);
  const content = buffer.content();
  const rows = content.split('\n');
  assert.match(rows[1], /\{open\}you\{close\}.*first.*\[\d\d:\d\d\].*✓/);
  assert.match(rows[2], /\{open\}you\{close\}.*second.*\[\d\d:\d\d\].*⧗/);
  assert.match(content, /second.*⧗/s, 'untouched entry keeps its marker');
  assert.equal(buffer.markerOf('aa'), '✓', 'addressed entry state is updated independently of its neighbor');
  assert.ok(content.includes('* system note'), 'system lines survive a marker update');

  assert.equal(buffer.setMarker('missing', '✓'), false, 'unknown id is reported');
});

test('live delivery and history replay merge ids without losing distinct messages or receipts', () => {
  const buffer = createHistoryBuffer();
  const own = { id: 'own', name: 'Me', text: 'sent body', ts: 1000, self: true, marker: '✓' };
  const incoming = { id: 'incoming', name: 'Peer', text: 'same words', ts: 2000, self: false };
  buffer.appendMessage(own);
  buffer.markReadUpTo(own.id);
  buffer.appendMessage(incoming);
  buffer.appendArt(['[image preview]'], '/tmp/incoming.png', incoming.id);

  // The live row wins the race to the screen; HTTP then brings older history
  // plus that same id. A subsequent cache replay is the third delivery path.
  const snapshot = [
    { id: 'older', name: 'Peer', text: 'older body', ts: 500, self: false },
    { ...own, text: 'edited body', edited: true },
    { ...incoming, reactions: { '👍': ['me'] } },
  ];
  buffer.appendMessages(snapshot);
  buffer.appendMessages(snapshot);
  buffer.appendMessage({ ...incoming, id: 'distinct' });
  buffer.appendMessage({ ...incoming, id: null, text: 'legacy words' });
  buffer.appendMessage({ ...incoming, id: null, text: 'legacy words' });

  assert.deepEqual(buffer.recentIds({ limit: 10 }), ['distinct', 'incoming', 'own', 'older']);
  assert.equal((buffer.content().match(/same words/g) ?? []).length, 2, 'same text/time with different ids are distinct');
  assert.equal((buffer.content().match(/legacy words/g) ?? []).length, 2, 'idless peers must not be content-deduplicated');
  assert.equal((buffer.content().match(/\[image preview\]/g) ?? []).length, 1);
  assert.match(buffer.content(), /older body[\s\S]*edited body[\s\S]*same words/);
  assert.doesNotMatch(buffer.content(), /sent body/);
  assert.match(buffer.content(), /\{green-fg\}✓✓/, 'a sent history row cannot undo a live read');
  assert.deepEqual(buffer.reactionsOf('incoming'), { '👍': ['me'] });

  buffer.clear();
  buffer.appendMessage({ ...incoming, text: 'another conversation' });
  assert.equal(buffer.messageById('incoming').text, 'another conversation', 'identity is scoped to the displayed conversation');
});

test('history buffer updates message text and marks it as edited', () => {
  const buffer = createHistoryBuffer();
  buffer.appendMessage({ id: 'msg-1', name: 'Roman', text: 'original text', ts: 0, self: false });
  assert.equal(buffer.updateMessage('msg-1', 'corrected text'), true);
  const content = buffer.content();
  assert.ok(content.includes('corrected text'), 'content is updated with new text');
  assert.ok(!content.includes('original text'), 'old text is replaced');
  assert.ok(content.includes('✎'), 'edited marker is present');
  assert.equal(buffer.updateMessage('unknown-id', 'test'), false);
});

test('reactions stay on their message and disappear with the last login', () => {
  const buffer = createHistoryBuffer();
  buffer.appendMessage({
    id: 'first', name: 'Roman', text: 'one', ts: 0, self: false,
  });
  buffer.appendMessage({
    id: 'second', name: 'Alice', text: 'two', ts: 0, self: true,
  });

  assert.equal(buffer.setReactions('first', {
    '👍': ['roman'],
    '❤️': ['roman', 'alice'],
  }), true);
  let content = buffer.content();
  assert.match(content, /one .*?\(❤ x2, 👍 x1\).*?\[\d\d:\d\d\]/);
  assert.doesNotMatch(content, /two \(.*x\d/);

  assert.equal(buffer.applyReaction('first', '👍', 'roman', false), true);
  assert.deepEqual(buffer.reactionsOf('first'), { '❤️': ['roman', 'alice'] });
  assert.doesNotMatch(buffer.content(), /👍 x/);
  assert.equal(buffer.applyReaction('first', '❤️', 'roman', false), true);
  assert.equal(buffer.applyReaction('first', '❤️', 'alice', false), true);
  assert.equal(buffer.reactionsOf('first'), null);
  assert.doesNotMatch(buffer.content(), /❤️ x/);
});

test('inline reactions do not change multiline selection-copy padding', () => {
  const buffer = createHistoryBuffer();
  buffer.appendMessage({
    id: 'message', name: 'Roman', text: 'first\n  second', ts: 0, self: false,
  });
  const before = buffer.copyPadding();

  buffer.applyReaction('message', '👍', 'alice', true);

  assert.deepEqual(buffer.copyPadding(), before);
  assert.deepEqual(before, [0, continuationPrefixWidth({ name: 'Roman', self: false })]);
});

test('a reply quote is a dim row above the answer and resolves its author', () => {
  const rendered = renderMessageMarkup({
    ts: 0,
    name: 'Roman',
    text: 'answer',
    self: false,
    replyTo: {
      id: 'original',
      from: 'alice@example.com',
      text: 'first line\nsecond line',
    },
    replyLabel: (from) => (from === 'alice@example.com' ? 'you' : from),
    themed: true,
  });
  const [quote, body] = rendered.split('\n');
  const prefix = continuationPrefixWidth({ name: 'Roman', self: false });

  assert.equal(quote, `${' '.repeat(prefix)}{245-fg}↩ you: first line second line{/245-fg}`);
  assert.match(body, /Roman.* answer .*\[\d\d:\d\d\]/s);
});

test('the UI recognises either local login as you in a reply quote', () => {
  const ui = headlessUI({
    selfLogin: ['alice@cloud.example', 'alice@tailnet.example'],
  });
  try {
    ui.addMessage({
      id: 'reply',
      name: 'Roman',
      text: 'answer',
      ts: 0,
      self: false,
      replyTo: {
        id: 'original',
        from: 'alice@tailnet.example',
        text: 'original',
      },
    });
    assert.match(ui.transcript(), /↩ you: original/);
  } finally {
    ui.destroy();
  }
});

test('history buffer inserts an asynchronous preview after its message', () => {
  const buffer = createHistoryBuffer(2000, (message) => message.text);
  buffer.appendMessage({ id: 'image-message', text: 'image caption' });
  buffer.appendMessage({ id: 'later-message', text: 'later text' });
  buffer.appendArt(['[preview]'], '/tmp/image.png', 'image-message');

  assert.equal(buffer.content(), 'image caption\n[preview]\nlater text');
});

test('markers escalate but never regress', () => {
  const buffer = createHistoryBuffer();
  buffer.appendMessage({ id: 'aa', name: 'me', text: 'x', ts: 0, self: true, marker: '⧗' });

  buffer.setMarker('aa', '✓✓');
  buffer.setMarker('aa', '✓'); // a late ack must not undo a read receipt
  assert.match(buffer.content(), /✓✓/);
  assert.doesNotMatch(buffer.content(), /(?<!✓)✓(?!✓)/);
});

test('a read receipt lifts both a sent and a delivered row to the read colour', () => {
  const buffer = createHistoryBuffer();
  buffer.appendMessage({ id: 'sent', name: 'me', text: 'one', ts: 0, self: true, marker: '✓' });
  buffer.appendMessage({ id: 'acked', name: 'me', text: 'two', ts: 60 * 60 * 1000, self: true, marker: '⧗' });

  // The ack: the peer's device holds it, but nobody has claimed to read it.
  assert.equal(buffer.setMarker('acked', '✓✓'), true);
  assert.doesNotMatch(buffer.content(), /\{green-fg\}✓✓/, 'delivered is not read');

  // The receipt then raises everything at or below the watermark, including
  // the row that was merely delivered.
  buffer.markReadUpTo('acked');
  const content = buffer.content();
  assert.doesNotMatch(content, /\{245-fg\}✓✓/, 'no delivered ✓✓ may be left quiet');
  assert.equal((content.match(/\{green-fg\}✓✓/g) ?? []).length, 2);
  assert.doesNotMatch(content, /(?<!✓)✓(?!✓)/, 'no lone ✓ is left behind');
});

// The FAILME case: a later message was read while an earlier one never left
// this device. The receipt is a watermark, but ⧗ never reached the server, so
// the peer cannot have read it — unless it is the very message they name.
test('a read receipt leaves an earlier ⧗ alone and lifts only committed rows', () => {
  const buffer = createHistoryBuffer();
  buffer.appendMessage({ id: 'stuck', name: 'me', text: 'stuck', ts: 0, self: true, marker: '⧗' });
  buffer.appendMessage({ id: 'sent', name: 'me', text: 'sent', ts: 1000, self: true, marker: '✓' });

  assert.equal(buffer.markReadUpTo('sent'), 1);
  const content = buffer.content();
  assert.match(content, /⧗/, 'the unsent row keeps its hourglass');
  assert.equal((content.match(/\{green-fg\}✓✓/g) ?? []).length, 1);

  buffer.appendMessage({ id: 'late', name: 'me', text: 'late', ts: 2000, self: true, marker: '⧗' });
  assert.equal(buffer.markReadUpTo('late'), 1, 'the named message itself was plainly read');
  const after = buffer.content();
  assert.equal((after.match(/⧗/g) ?? []).length, 1, 'only the never-sent row still waits');
  assert.equal((after.match(/\{green-fg\}✓✓/g) ?? []).length, 2);
});

test('recolor drops cached message text but leaves plain lines untouched', () => {
  // A tiny render function stands in for renderMessageMarkup: it reads a
  // mutable "palette" from the closure, exactly like historyBuffer's real one
  // reads createUI's `palette` variable. recolor() is what makes an already
  // cached message pick the new value up instead of showing the one it was
  // first drawn with.
  let colour = 'green';
  const buffer = createHistoryBuffer(2000, (message) => `${colour}:${message.text}`);
  buffer.appendLine('* system note');
  const before = buffer.appendMessage({ text: 'hi' });
  assert.equal(before, '* system note\ngreen:hi');

  colour = 'amber';
  assert.equal(buffer.content(), '* system note\ngreen:hi', 'nothing recolours on its own');
  const after = buffer.recolor();
  assert.equal(after, '* system note\namber:hi', 'the message re-renders under the new palette');
});

test('setTheme switches the active palette live and rejects an unknown name', () => {
  const ui = headlessUI();
  try {
    assert.equal(ui.themeName(), DEFAULT_THEME);
    ui.addMessage({ id: 'm1', name: 'Alice', text: 'hello', ts: Date.now(), self: true });
    assert.equal(ui.setTheme('ocean'), true);
    assert.equal(ui.themeName(), 'ocean');
    assert.equal(ui.setTheme('not-a-real-theme'), false);
    assert.equal(ui.themeName(), 'ocean', 'a rejected name must not change the current theme');
  } finally {
    ui.destroy();
  }
});

test('UI escalates a message marker from queued to sent to delivered to read', () => {
  const ui = headlessUI();
  try {
    ui.addMessage({ id: 'm1', name: 'Alice', text: 'hi', ts: Date.now(), self: true, marker: '⧗' });
    assert.equal(ui.markerOf('m1'), '⧗');

    ui.setMessageMarker('m1', '✓');
    assert.equal(ui.markerOf('m1'), '✓');
    assert.match(ui.transcript(), /\{245-fg\}✓\{/, 'sent is quiet, not green any more');

    // The ack: the peer's device holds it. The same glyph as read, still quiet.
    ui.setMessageMarker('m1', '✓✓');
    assert.equal(ui.markerOf('m1'), '✓✓');
    assert.match(ui.transcript(), /\{245-fg\}✓✓\{/);
    assert.doesNotMatch(ui.transcript(), /\{green-fg\}✓✓/, 'delivered is not read');

    // The read receipt then raises it to the accent.
    ui.markReadUpTo('m1');
    assert.match(ui.transcript(), /\{green-fg\}✓✓\{/);
  } finally {
    ui.destroy();
  }
});

test('UI draws a failed message in red, and a retry puts it back in the queue', () => {
  const ui = headlessUI();
  try {
    ui.addMessage({ id: 'm1', name: 'Alice', text: 'hi', ts: Date.now(), self: true, marker: '⧗' });
    assert.equal(ui.setMessageMarker('m1', '⚠'), true);
    assert.equal(ui.markerOf('m1'), '⚠');
    assert.match(ui.transcript(), /\{red-fg\}⚠\{/);

    assert.equal(ui.setMessageMarker('m1', '⧗'), true, '/retry');
    assert.match(ui.transcript(), /\{yellow-fg\}⧗\{/);

    ui.setMessageMarker('m1', '✓');
    assert.equal(ui.setMessageMarker('m1', '⚠'), false, 'a late failure cannot undo a confirmed send');
    assert.match(ui.transcript(), /\{245-fg\}✓\{/);
  } finally {
    ui.destroy();
  }
});

// AGENTS.md §12: ⧗ queued · ✓ sent · ✓✓ delivered · ✓✓ read · ⚠ failed, one
// ladder in every client. ⚠ is the rung the terminal did not draw before the
// native core: the queue gives up on a message, and a retry puts it back.
test('⧗ and ⚠ share the bottom rung: a row moves between them, never down from a confirmed mark', () => {
  const buffer = createHistoryBuffer();
  buffer.appendMessage({ id: 'aa', name: 'me', text: 'x', ts: 0, self: true, marker: '⧗' });

  assert.equal(buffer.setMarker('aa', '⚠'), true, 'the queue gave up');
  assert.equal(buffer.markerOf('aa'), '⚠');
  assert.equal(buffer.setMarker('aa', '⚠'), false, 'the same mark again changes nothing');
  assert.equal(buffer.setMarker('aa', '⧗'), true, 'the person asked again');
  assert.equal(buffer.markerOf('aa'), '⧗');

  assert.equal(buffer.setMarker('aa', '✓'), true);
  assert.equal(buffer.setMarker('aa', '⚠'), false, 'a failure never overwrites what the server confirmed');
  assert.equal(buffer.setMarker('aa', '⧗'), false, 'nor does a clock');
  assert.equal(buffer.markerOf('aa'), '✓');

  buffer.setMarker('aa', '✓✓');
  assert.equal(buffer.setMarker('aa', '⚠'), false);
  assert.equal(buffer.markerOf('aa'), '✓✓');
});

test('a row that failed and is then confirmed climbs straight to the confirmed rung', () => {
  const buffer = createHistoryBuffer();
  buffer.appendMessage({ id: 'aa', name: 'me', text: 'x', ts: 0, self: true, marker: '⚠' });
  assert.equal(buffer.setMarker('aa', '✓'), true, 'retried and accepted');
  assert.equal(buffer.markerOf('aa'), '✓');
});

test('⚠ is drawn in red, ⧗ stays amber, and the glyph survives the unthemed rendering', () => {
  const themed = renderMessageMarkup({ ts: 0, name: 'me', text: 'x', self: true, marker: '⚠' });
  assert.match(themed, /\{red-fg\}⚠\{\/red-fg\}/);
  assert.match(renderMessageMarkup({ ts: 0, name: 'me', text: 'x', self: true, marker: '⧗' }), /\{yellow-fg\}⧗/);
  const plain = renderMessageMarkup({ ts: 0, name: 'me', text: 'x', self: true, marker: '⚠', themed: false });
  assert.match(plain, / ⚠$/);
});

test('a read receipt skips a failed row exactly as it skips a queued one, unless it names it', () => {
  const buffer = createHistoryBuffer();
  buffer.appendMessage({ id: 'failed', name: 'me', text: 'never left', ts: 0, self: true, marker: '⚠' });
  buffer.appendMessage({ id: 'sent', name: 'me', text: 'went', ts: 1000, self: true, marker: '✓' });

  assert.equal(buffer.markReadUpTo('sent'), 1, 'only the committed row is lifted');
  assert.equal(buffer.markerOf('failed'), '⚠', 'the peer cannot have read what never left this device');

  buffer.appendMessage({ id: 'named', name: 'me', text: 'odd', ts: 2000, self: true, marker: '⚠' });
  assert.equal(buffer.markReadUpTo('named'), 1, 'the message the receipt names was plainly read');
  assert.equal(buffer.markerOf('named'), '✓✓');
  assert.equal(buffer.markerOf('failed'), '⚠');
});

test('a repaint from the store cannot lower a mark, but may swap ⧗ and ⚠', () => {
  const sent = { marker: '✓', markerRead: false };
  assert.equal(mergeMessageState(sent, { marker: '⚠' }).marker, '✓');
  assert.equal(mergeMessageState(sent, { marker: '⧗' }).marker, '✓');
  assert.equal(mergeMessageState({ marker: '⧗' }, { marker: '⚠' }).marker, '⚠');
  assert.equal(mergeMessageState({ marker: '⚠' }, { marker: '⧗' }).marker, '⧗');
  assert.equal(mergeMessageState({ marker: '⚠' }, { marker: '✓' }).marker, '✓');
  const read = mergeMessageState({ marker: '✓✓', markerRead: true }, { marker: '⚠' });
  assert.deepEqual([read.marker, read.markerRead], ['✓✓', true]);
});

test('climbs is the ladder rule: upward, plus the one sideways step at the bottom', () => {
  assert.equal(climbs(undefined, '⧗'), true, 'a row without a mark may take one');
  assert.equal(climbs('⧗', '✓'), true);
  assert.equal(climbs('✓', '✓✓'), true);
  assert.equal(climbs('✓✓', '✓'), false);
  assert.equal(climbs('⧗', '⚠'), true);
  assert.equal(climbs('⚠', '⧗'), true);
  assert.equal(climbs('⚠', '⚠'), false);
  assert.equal(climbs('✓', '✓'), false);
  assert.equal(climbs('✓', 'nonsense'), false);
  assert.equal(climbs('✓', undefined), false);
});

test('the core\'s five receipts are drawn on the one ladder', () => {
  assert.deepEqual({ ...RECEIPT_MARKERS }, {
    queued: '⧗', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '⚠',
  });
  assert.ok(Object.isFrozen(RECEIPT_MARKERS));
});

test('mouse capture starts off and --mouse turns it on', () => {
  const ui = headlessUI();
  try {
    assert.equal(ui.isMouseCaptured(), false, 'released by default: the terminal selects');

    assert.equal(ui.setMouseCapture(false), false);
    assert.equal(ui.isMouseCaptured(), false);

    assert.equal(ui.setMouseCapture(true), true);
    assert.equal(ui.isMouseCaptured(), true);
  } finally {
    ui.destroy();
  }
});

test('mouse capture starts off when the caller asks for it', () => {
  const ui = headlessUI({ mouse: false });
  try {
    assert.equal(ui.isMouseCaptured(), false);
  } finally {
    ui.destroy();
  }
});
test('the shimmer paints the label without changing a single visible cell', () => {
  // The band is drawn on the composer rule, whose dashes are measured from the
  // plain label and painted from the marked-up one. Markup that added or ate a
  // character would move the end of the rule every frame.
  const label = 'Roman typing';
  const visible = new Set();
  const frames = new Set();
  for (let phase = 0; phase < shimmerSpan(label) * 2; phase++) {
    const markup = shimmerMarkup(label, phase);
    visible.add(markup.replace(/\{[^}]*\}/g, ''));
    frames.add(markup);
  }
  assert.deepEqual([...visible], [label], 'the visible text must be the label, untouched');
  assert.ok(frames.size > 3, 'the band has to actually move');
});

test('the header never animates: typing is not a header status', () => {
  // 0.29.0 moved the indicator to the composer rule because the header is for
  // state that lasts, and presence has to stay readable while the peer types.
  // The dead `typing` branch stayed in statusPresentation until 0.42.28.
  assert.equal(statusPresentation('typing', true).label, 'WAITING');
  const options = {
    width: 96, selfName: 'Alice', peerName: 'Roman', status: 'active', themed: true,
  };
  const header = renderHeaderMarkup(options);
  assert.ok(header.includes('ACTIVE'), `presence must reach the header: ${header}`);
  assert.doesNotMatch(header, /TYPING/);
  const update = renderHeaderMarkup({ ...options, updateAvailable: true });
  assert.match(update, /update!/);
  // No phase to pass and none accepted: an argument that changed the frame would
  // mean the header is animating again.
  assert.equal(renderHeaderMarkup({ ...options, shimmerPhase: 7 }), header);
});

test('renderHeaderMarkup shows which transport the conversation is on', () => {
  const options = {
    width: 96, selfName: 'Alice', peerName: 'Roman', status: 'online', themed: false,
  };
  const plain = renderHeaderMarkup(options);
  assert.doesNotMatch(plain, /⚡|🌐/, 'no transport given draws no badge');
  assert.match(renderHeaderMarkup({ ...options, transport: 'p2p' }), /⚡ Roman/);
  assert.match(renderHeaderMarkup({ ...options, transport: 'cloud' }), /🌐 Roman/);
});

test('renderHeaderMarkup shows what the peer is running once known', () => {
  const options = {
    width: 96, selfName: 'Alice', peerName: 'Roman', status: 'online', themed: false,
  };
  assert.doesNotMatch(renderHeaderMarkup(options), /\(web\)|\(cli\)/, 'unknown client draws nothing');
  assert.match(renderHeaderMarkup({ ...options, peerClient: 'web' }), /Roman \(web\)/);
  assert.match(renderHeaderMarkup({ ...options, peerClient: 'cli' }), /Roman \(cli\)/);
});

test('renderInfoPanelMarkup names the peer, their status, and the connection', () => {
  const plain = renderInfoPanelMarkup({
    width: 26, peerName: 'Roman', status: 'online', themed: false,
  });
  assert.match(plain, /Roman/);
  assert.match(plain, /ONLINE/);
  assert.match(plain, /—/, 'no transport/client/device given reads as unknown, not blank');
  const full = renderInfoPanelMarkup({
    width: 26,
    peerName: 'Roman',
    peerDevice: 'iPhone',
    status: 'online',
    transport: 'p2p',
    peerClient: 'cli',
    themed: false,
  });
  assert.match(full, /p2p/);
  assert.match(full, /cli/);
  assert.match(full, /iPhone/);
});

test('the info panel only shows once the terminal is wide enough, independent of the roster', () => {
  const narrow = headlessUI({ columns: 90 });
  try {
    narrow.setRoster([{ login: 'roman', name: 'Roman', online: true }], 'roman');
    assert.equal(narrow.infoPanelShown(), false, '90 columns is wide enough for the roster but not a second column too');
  } finally {
    narrow.destroy();
  }

  const wide = headlessUI({ columns: 130 });
  try {
    // Shown by width alone, even with an empty roster — a conversation with
    // nobody in it yet still deserves to see its own connection facts.
    wide.setRoster([], null);
    assert.equal(wide.infoPanelShown(), true);
    wide.setRoster([{ login: 'roman', name: 'Roman', online: true }], 'roman');
    wide.setTransport('p2p');
    wide.setPeerClient('cli');
    wide.setStatus('online');
    const content = wide.infoPanelContent();
    assert.match(content, /Roman/);
    assert.match(content, /p2p/);
    assert.match(content, /cli/);
  } finally {
    wide.destroy();
  }
});

test('the shimmer runs while the peer types or a file is going out', async () => {
  const ui = headlessUI();
  try {
    assert.equal(ui.shimmerRunning(), false);
    ui.setPeerTyping(true);
    assert.equal(ui.shimmerRunning(), true);
    ui.setPeerTyping(false);
    assert.equal(ui.shimmerRunning(), false, 'the timer must not leak');

    // The shimmer wraps every character, so read the rule with the tags off.
    const rule = () => ui.composerRuleContent().replace(/\{[^}]*\}/g, '');
    ui.setSending('photo.jpg');
    assert.equal(ui.shimmerRunning(), true, 'a transfer animates too');
    assert.match(rule(), /sending photo\.jpg/);
    // And it has to move, not just say the words: the band is what tells the
    // reader the bytes are still going out. Sampled past the lead-in — the band
    // spends its first five frames off the label, and those frames are identical
    // by design.
    const first = ui.composerRuleContent();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.notEqual(ui.composerRuleContent(), first, 'the band stood still');
    assert.match(rule(), /sending photo\.jpg/, 'and it is still the same label');
    // Both at once: one rule, one timer, and the transfer has it — it is this
    // side's own doing and the reader is waiting on it.
    ui.setPeerTyping(true);
    assert.match(rule(), /sending photo\.jpg/);
    assert.doesNotMatch(rule(), /typing/);
    ui.setSending(null);
    assert.equal(ui.shimmerRunning(), true, 'the peer is still typing');
    assert.match(rule(), /typing/);
    ui.setPeerTyping(false);
    assert.equal(ui.shimmerRunning(), false);
    assert.match(rule(), /Message/);
  } finally {
    ui.destroy();
  }
});

test('the composer shows two and three simultaneous typing voices', () => {
  const ui = headlessUI();
  try {
    const rule = () => ui.composerRuleContent().replace(/\{[^}]*\}/g, '');
    // Own typing is visible too: the composer names every active voice.
    ui.setSelfTyping(true);
    assert.equal(ui.shimmerRunning(), true);
    assert.match(rule(), /Alice typing/);
    ui.setPeerTyping(true);
    assert.match(rule(), /Alice \+ Roman typing/);
    ui.setAiTyping('tailik');
    assert.match(rule(), /Alice \+ Roman \+ tailik typing/);

    // A transfer temporarily owns the rule; all three voices return afterward.
    ui.setSending('photo.jpg');
    assert.match(rule(), /sending photo\.jpg/);
    ui.setSending(null);
    assert.match(rule(), /Alice \+ Roman \+ tailik typing/);

    ui.setAiTyping(null);
    assert.match(rule(), /Alice \+ Roman typing/);
    ui.setPeerTyping(false);
    assert.equal(ui.shimmerRunning(), true, 'self typing still animates alone');
    assert.match(rule(), /Alice typing/);
    ui.setSelfTyping(false);
    assert.equal(ui.shimmerRunning(), false);
    assert.match(rule(), /Message/);
  } finally {
    ui.destroy();
  }
});

test('human and named peer typing frames stop independently', () => {
  const ui = headlessUI();
  try {
    const rule = () => ui.composerRuleContent().replace(/\{[^}]*\}/g, '');
    ui.setPeerTyping(true, 'tailik');
    ui.setPeerTyping(true);
    assert.match(rule(), /tailik/);
    assert.match(rule(), /Roman/);
    ui.setPeerTyping(false);
    assert.match(rule(), /tailik typing/, 'the named voice is still typing');
    ui.setPeerTyping(false, 'tailik');
    assert.equal(ui.shimmerRunning(), false);

    ui.setPeerTyping(true);
    ui.setPeerTyping(true, 'tailik');
    ui.clearPeerTyping();
    assert.equal(ui.shimmerRunning(), false, 'disconnect clears every remote voice');
  } finally {
    ui.destroy();
  }
});

test('destroy stops a running shimmer', () => {
  const ui = headlessUI();
  ui.setPeerTyping(true);
  ui.destroy();
  assert.equal(ui.shimmerRunning(), false);
});
test('focus tracking is claimed only after the terminal proves it', () => {
  const ui = headlessUI();
  try {
    // Termux never sends FocusIn/FocusOut. Assuming "focused" there makes the
    // peer show ACTIVE for a phone in a pocket, which is worse than saying
    // nothing, so support has to be observed before it is trusted.
    assert.equal(ui.focusTracked(), false, 'nothing observed yet');
    assert.equal(ui.isFocused(), true, 'we still behave as if visible');

    ui.__emitFocus(false);
    assert.equal(ui.focusTracked(), true, 'one real event proves support');
    assert.equal(ui.isFocused(), false);
  } finally {
    ui.destroy();
  }
});
test('presence statuses cover attentive, distracted and absent peers', () => {
  assert.deepEqual(statusPresentation('active', true), {
    symbol: '●', label: 'ACTIVE', color: 'green',
  });
  assert.deepEqual(statusPresentation('idle', true), {
    symbol: '◐', label: 'IDLE', color: 'cyan',
  });
  assert.deepEqual(statusPresentation('away', true), {
    symbol: '○', label: 'AWAY', color: 'yellow',
  });
  assert.deepEqual(statusPresentation('away', false), {
    symbol: '', label: 'AWAY', color: null,
  });
});

test('peer presence reaches the header and unknown presence stays neutral', () => {
  const ui = headlessUI();
  try {
    ui.setStatus('online');
    assert.equal(ui.headerStatus(), 'online', 'an old peer reports nothing');

    ui.setPeerPresence('active');
    assert.equal(ui.headerStatus(), 'active');

    ui.setPeerPresence('idle');
    assert.equal(ui.headerStatus(), 'idle');

    ui.setPeerPresence('away');
    assert.equal(ui.headerStatus(), 'away');

    ui.setPeerPresence(null);
    assert.equal(ui.headerStatus(), 'online', 'presence can go back to unknown');
  } finally {
    ui.destroy();
  }
});

test('the header keeps lasting state while typing shows at the composer', () => {
  const ui = headlessUI();
  try {
    ui.setStatus('online');
    ui.setPeerPresence('away');
    ui.setPeerTyping(true);
    // Typing is a passing event and is shown next to the draft now, so it must
    // not displace the presence the header exists to report.
    assert.equal(ui.headerStatus(), 'away');

    ui.setStatus('reconnecting…');
    assert.equal(ui.headerStatus(), 'reconnecting…', 'connection state wins over both');
  } finally {
    ui.destroy();
  }
});

test('the caret is measured in screen cells, not code points', () => {
  const ui = headlessUI();
  try {
    // Cyrillic occupies one cell per character, so the column equals the length.
    ui.setDraft('привет');
    assert.deepEqual(ui.cursorCell(), { row: 0, col: 6 });

    // An emoji occupies two, and a caret that counted characters would sit
    // one cell to the left of the text it is supposed to follow.
    ui.setDraft('ab🙂');
    assert.deepEqual(ui.cursorCell(), { row: 0, col: 4 });
  } finally {
    ui.destroy();
  }
});

test('the caret follows explicit newlines down the draft', () => {
  const ui = headlessUI();
  try {
    ui.setDraft('one\ntwo\nthree');
    assert.deepEqual(ui.cursorCell(), { row: 2, col: 5 });
  } finally {
    ui.destroy();
  }
});

test('a draft longer than the composer scrolls to keep the caret visible', () => {
  const ui = headlessUI();
  try {
    ui.setDraft(Array.from({ length: 20 }, (_, n) => `line ${n}`).join('\n'));
    const rows = ui.composerRows();
    const { row } = ui.cursorCell();
    const scroll = ui.draftScroll();
    assert.ok(row >= scroll && row < scroll + rows,
      `caret row ${row} must sit inside the visible window ${scroll}..${scroll + rows - 1}`);
  } finally {
    ui.destroy();
  }
});

test('clearing the draft empties it and returns the view to the top', () => {
  const ui = headlessUI();
  try {
    ui.setDraft(Array.from({ length: 20 }, (_, n) => `line ${n}`).join('\n'));
    assert.ok(ui.draftScroll() > 0, 'a long draft starts scrolled');

    ui.clearDraft();
    assert.equal(ui.draft(), '');
    assert.equal(ui.draftScroll(), 0);
    assert.equal(ui.composerRows(), 1);
    assert.deepEqual(ui.cursorCell(), { row: 0, col: 0 });
  } finally {
    ui.destroy();
  }
});
const COMMANDS = [
  { name: '/help', alias: '/h', help: 'help' },
  { name: '/send', alias: '/s', help: 'send' },
  { name: '/sad', alias: '/d', help: 'sad' },
  { name: '/quit', alias: '/q', help: 'quit' },
];

test('a bare slash offers every command', () => {
  const ui = headlessUI();
  try {
    ui.setCommands(COMMANDS);
    ui.setDraft('/');
    assert.deepEqual(ui.completionMenu(), ['/help', '/send', '/sad', '/quit']);
  } finally {
    ui.destroy();
  }
});

test('typing narrows the menu by name and by alias', () => {
  const ui = headlessUI();
  try {
    ui.setCommands(COMMANDS);
    ui.setDraft('/s');
    assert.deepEqual(ui.completionMenu(), ['/send', '/sad']);

    ui.setDraft('/sa');
    assert.deepEqual(ui.completionMenu(), ['/sad']);

    // The short form is a way to reach the command, so it must match too.
    ui.setDraft('/d');
    assert.deepEqual(ui.completionMenu(), ['/sad']);
  } finally {
    ui.destroy();
  }
});

test('the menu closes once the draft stops being a bare command', () => {
  const ui = headlessUI();
  try {
    ui.setCommands(COMMANDS);
    ui.setDraft('/send ~/photo.jpg');
    assert.deepEqual(ui.completionMenu(), [], 'an argument is not a command choice');

    ui.setDraft('hello');
    assert.deepEqual(ui.completionMenu(), [], 'ordinary text never opens the menu');

    ui.setDraft('/zzz');
    assert.deepEqual(ui.completionMenu(), [], 'a command that cannot exist offers nothing');
  } finally {
    ui.destroy();
  }
});

test('the menu never grows past its visible rows', () => {
  const ui = headlessUI();
  try {
    ui.setCommands(Array.from({ length: 20 }, (_, n) => ({
      name: `/c${n}`, alias: '/x', help: 'x',
    })));
    ui.setDraft('/');
    assert.equal(ui.completionMenu().length, 20, 'every match stays reachable');
    assert.ok(ui.completionRows() <= 6, 'the menu must not swallow the transcript');
  } finally {
    ui.destroy();
  }
});

test('an unfinished command completes instead of being posted as a message', () => {
  const ui = headlessUI();
  try {
    ui.setCommands(COMMANDS);
    // A bare slash used to be sent into the conversation as the text "/".
    ui.setDraft('/');
    assert.equal(ui.isExactCommand('/'), false);
    assert.equal(ui.acceptCompletion(), true);
    assert.equal(ui.draft(), '/help ');
  } finally {
    ui.destroy();
  }
});

test('a command already spelled out is run, not rewritten', () => {
  const ui = headlessUI();
  try {
    ui.setCommands(COMMANDS);
    assert.equal(ui.isExactCommand('/help'), true);
    assert.equal(ui.isExactCommand('/h'), true, 'the short form counts too');
    assert.equal(ui.isExactCommand('/hel'), false);
    assert.equal(ui.isExactCommand('hello'), false);
  } finally {
    ui.destroy();
  }
});

test('a selection scrolled past the visible rows still completes', () => {
  const ui = headlessUI();
  try {
    const many = Array.from({ length: 12 }, (_, n) => ({
      name: `/c${n}`, alias: `/${n}`, help: 'x',
    }));
    ui.setCommands(many);
    ui.setDraft('/');
    // Row 9 is below the window; indexing the visible slice returned nothing
    // and Tab silently did nothing.
    ui.selectCompletion(9);
    assert.equal(ui.acceptCompletion(), true);
    assert.equal(ui.draft(), '/c9 ');
  } finally {
    ui.destroy();
  }
});

test('ordinary text never claims to be a completion', () => {
  const ui = headlessUI();
  try {
    ui.setCommands(COMMANDS);
    ui.setDraft('hello there');
    assert.equal(ui.acceptCompletion(), false, 'plain text must fall through to send');
  } finally {
    ui.destroy();
  }
});

test('a multiline message keeps its rows in one grid', () => {
  // An ASCII picture stops being a picture the moment its first row starts at
  // a different column from the rest.
  const rendered = renderMessageMarkup({
    ts: new Date('2026-08-13T13:17:00').getTime(),
    name: 'Roman',
    text: 'aaa\nbbb\nccc',
    self: true,
    marker: '✓✓',
    themed: false,
  });
  const [first, ...rest] = rendered.split('\n');
  const bodyColumn = first.indexOf('aaa');
  assert.ok(bodyColumn > 0);
  for (const line of rest) {
    assert.equal(line.search(/\S/), bodyColumn, `row "${line}" is out of the grid`);
  }
});

test('a longer name shifts the whole picture, not just its first row', () => {
  const rendered = renderMessageMarkup({
    ts: new Date('2026-08-13T13:17:00').getTime(),
    name: 'RomanA12',
    text: 'aaa\nbbb',
    self: false,
    marker: null,
    themed: false,
  });
  const [first, second] = rendered.split('\n');
  assert.equal(second.search(/\S/), first.indexOf('aaa'));
});

test('a fenced block loses its backticks and keeps its indentation', () => {
  // Printing the fence would put the marker in the transcript instead of the
  // formatting, and re-trimming the code would destroy its structure.
  const out = renderBodyMarkup('try:\n```js\nif (a) {\n  b();\n}\n```\ndone', { themed: true });
  assert.equal(out, [
    'try:',
    // The language is named above the block, the way a chat app labels it.
    '{gray-fg}js{/gray-fg}',
    '{bold}{33-fg}if{/33-fg}{/bold}{188-fg} {/188-fg}{145-fg}({/145-fg}{41-fg}a{/41-fg}{145-fg}){/145-fg}{188-fg} {/188-fg}{145-fg}{open}{/145-fg}',
    '{188-fg}  {/188-fg}{198-fg}b{/198-fg}{145-fg}({/145-fg}{145-fg}){/145-fg}{145-fg};{/145-fg}',
    '{145-fg}{close}{/145-fg}',
    'done',
  ].join('\n'));
});

test('markdown inside a fenced block stays literal code', () => {
  // A snippet that talks about `**` or a `#` comment must survive verbatim;
  // interpreting it would silently rewrite the user's code.
  const out = renderBodyMarkup('```\n# not a heading\n**not bold**\n```', { themed: true });
  const plain = out.replace(/\{[^}]*\}/g, '');
  assert.doesNotMatch(out, /\{bold\}/, 'no markdown becomes a blessed tag');
  assert.ok(plain.includes('# not a heading'), 'the comment line survives');
  assert.ok(plain.includes('**not bold**'), 'the asterisks survive');
});

test('an unterminated fence colours the rest instead of eating it', () => {
  // A half-typed block used to swallow every line after the opening fence.
  const out = renderBodyMarkup('intro\n```\nfirst\nsecond', { themed: true });
  const plain = out.replace(/\{[^}]*\}/g, '');
  assert.equal(plain, 'intro\nfirst\nsecond', 'every line survives the open fence');
  assert.doesNotMatch(plain, /```/, 'the fence itself is not printed');
});

test('inline code is coloured without printing its backticks', () => {
  // Backticks in the output mean the span was matched but not consumed.
  const out = renderBodyMarkup('run `npm test` now', { themed: true });
  assert.equal(out, 'run {cyan-fg}npm test{/cyan-fg} now');
});

test('bold text becomes blessed bold without printing its asterisks', () => {
  const out = renderBodyMarkup('this is **very** clear', { themed: true });
  assert.equal(out, 'this is {bold}very{/bold} clear');
});

test('a heading is bold and coloured with the hashes dropped', () => {
  // One to three hashes only, and only when a space follows: `#5` and `####`
  // are ordinary chat characters.
  assert.equal(
    renderBodyMarkup('## Notes', { themed: true }),
    '{bold}{green-fg}Notes{/green-fg}{/bold}',
  );
  assert.equal(renderBodyMarkup('#5 in line', { themed: true }), '#5 in line');
  assert.equal(renderBodyMarkup('#### deep', { themed: true }), '#### deep');
});

test('monochrome mode strips markdown syntax without emitting colour', () => {
  // NO_COLOR must not mean "read the raw markers": the text still has to read
  // cleanly, it just does it without tags.
  const out = renderBodyMarkup('# Title\n```js\ncode()\n```\n`x` and **y**', { themed: false });
  assert.equal(out, 'Title\ncode()\nx and y');
  assert.doesNotMatch(out, /\{/);
});

test('text without markdown passes through untouched', () => {
  // Every character of an ordinary message is load bearing; a greedy matcher
  // that trimmed a lone backtick or a stray `**` would corrupt real chat.
  const plain = 'a lone ` and a stray ** and 2*3*4 and C#';
  assert.equal(renderBodyMarkup(plain, { themed: true }), plain);
  assert.equal(renderBodyMarkup(plain, { themed: false }), plain);
});

test('a message containing {bold} cannot inject real markup', () => {
  // Markdown is applied after escaping, so the user's braces stay literal.
  const out = renderBodyMarkup('look: {bold}fake{/bold} **real**', { themed: true });
  assert.equal(out, 'look: {open}bold{close}fake{open}/bold{close} {bold}real{/bold}');
});

test('markdown body markup only uses colour names blessed can parse', () => {
  // Same trap as the header: `{brightcyan-fg}` would print as literal text.
  const PARSEABLE = new Set([
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', 'grey',
  ]);
  const out = renderBodyMarkup('# H\n`c` **b**\n```\ncode\n```', { themed: true });
  for (const tag of out.matchAll(/\{\/?([a-z]+)-fg\}/g)) {
    assert.ok(PARSEABLE.has(tag[1]), `body markup uses untaggable colour ${tag[1]}`);
  }
});

test('a pasted list keeps its markers and its nesting', () => {
  // People paste reports far more often than they write fences, and a report is
  // mostly bullets. The marker is coloured but never removed: the text has to
  // survive being copied back out.
  const out = renderBodyMarkup('- один\n  - вложенный\n* звёздочка', { themed: true });
  assert.equal(out.split('\n')[0], '{green-fg}- {/green-fg}один');
  assert.equal(out.split('\n')[1], '  {green-fg}- {/green-fg}вложенный');
  assert.equal(out.split('\n')[2], '{green-fg}* {/green-fg}звёздочка');
});

test('a dash inside a sentence is not a list', () => {
  const out = renderBodyMarkup('строка с - дефисом внутри', { themed: true });
  assert.equal(out, 'строка с - дефисом внутри');
});

test('a quoted line is marked without losing its angle bracket', () => {
  const out = renderBodyMarkup('> Вы в среде WSL2', { themed: true });
  assert.equal(out, '{cyan-fg}> {/cyan-fg}{67-fg}Вы в среде WSL2{/67-fg}');
});

test('lists and quotes inside a fence stay literal code', () => {
  const out = renderBodyMarkup('```\n- not a list\n> not a quote\n```', { themed: true });
  const plain = out.replace(/\{[^}]*\}/g, '');
  assert.equal(plain, '- not a list\n> not a quote');
});

test('monochrome keeps list and quote characters exactly', () => {
  const source = '- один\n> цитата';
  assert.equal(renderBodyMarkup(source, { themed: false }), source);
});

test('inline markup still applies inside a list item', () => {
  const out = renderBodyMarkup('- смотри `npm i` и **важно**', { themed: true });
  assert.equal(out, '{green-fg}- {/green-fg}смотри {cyan-fg}npm i{/cyan-fg} и {bold}важно{/bold}');
});

test('emphasis is the doubled asterisk, and only that', () => {
  assert.equal(renderBodyMarkup('**жирный**', { themed: true }), '{bold}жирный{/bold}');
  // The single form and `__x__` were both removed after they ate real content:
  // `'*.db*'` is a glob and `__init__` is a method name. A missing way to write
  // emphasis costs nothing; a missing character in a pasted command costs a lot.
  assert.equal(renderBodyMarkup('*не жирный*', { themed: true }), '*не жирный*');
  assert.equal(renderBodyMarkup('__как есть__', { themed: true }), '__как есть__');
});

test('a shell glob and a Python dunder survive untouched', () => {
  for (const plain of [
    "rsync --exclude '*.db*' ./",
    'def __init__(self):',
    'def f(*args, **kwargs):',
    '__main__ and __init__',
  ]) {
    assert.equal(renderBodyMarkup(plain, { themed: true }), plain, plain);
  }
});

test('identifiers and arithmetic are not emphasis', () => {
  // A developer's chat is full of both, and turning them into markup would make
  // the feature a nuisance rather than a help.
  // Glued markers are the hard case: `2*3*4` has no spaces to save it, and
  // `snake__case` doubles the underscore an identifier already uses.
  for (const plain of [
    'snake_case_name', '2 * 3 * 4', 'a_b_c_d', '5 * 5',
    '2*3*4', 'snake__case__name', 'a**b**c', '3*4',
  ]) {
    assert.equal(renderBodyMarkup(plain, { themed: true }), plain);
  }
});

test('a single asterisk at the start of a line is still a bullet', () => {
  assert.equal(
    renderBodyMarkup('* пункт', { themed: true }),
    '{green-fg}* {/green-fg}пункт',
  );
});

test('emphasis inside a code span stays literal', () => {
  assert.equal(
    renderBodyMarkup('`код с *звёздочкой*`', { themed: true }),
    '{cyan-fg}код с *звёздочкой*{/cyan-fg}',
  );
});

test('monochrome strips emphasis without colouring it', () => {
  assert.equal(renderBodyMarkup('**a** and *b* and __c__', { themed: false }), 'a and *b* and __c__');
});

test('the caret follows a word-wrapped paste to its end', () => {
  const ui = headlessUI();
  try {
    // blessed breaks at spaces, not every N cells. Counting cells left the caret
    // stranded on the first row of a pasted paragraph while typing went on at
    // the end, so the wrap is read back from the widget that paints it.
    const paragraph = "dummy text for Letraset's Body Type sheets. It has survived not"
      + ' only many decades, but also the leap into electronic typesetting.';
    ui.setDraft(paragraph);
    const rows = ui.composerRows();
    assert.ok(rows > 1, 'the paragraph has to wrap for this to mean anything');
    const { row } = ui.cursorCell();
    assert.equal(row, rows - 1, 'the caret belongs on the last row of the draft');
  } finally {
    ui.destroy();
  }
});

test('the caret lands on the right row with newlines and wrapping mixed', () => {
  const ui = headlessUI();
  try {
    ui.setDraft(`первая\n${'x'.repeat(200)}`);
    const { row } = ui.cursorCell();
    assert.equal(row, ui.composerRows() - 1);

    ui.setDraft('один\nдва\nтри');
    assert.deepEqual(ui.cursorCell(), { row: 2, col: 3 });
  } finally {
    ui.destroy();
  }
});

// A real terminal reports a left-button drag as button 32 with an `M`, which
// blessed only rewrites into `mousemove` for the VTE family. Everywhere else the
// drag arrives as a stream of `mousedown`, so these tests drive the raw bytes
// rather than the events we wish we got.
function mouseUI(options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  output.resume();
  const ui = createUI({
    selfName: 'Alice', peerLabel: 'Roman', input, output, mouse: true, ...options,
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    ui,
    // The transcript starts at screen row 4: the frame, the header, its rule
    // and the new rule between the band and the transcript.
    async press(row) { input.write(`\x1b[<0;4;${row + 5}M`); await settle(); },
    async drag(row) { input.write(`\x1b[<32;4;${row + 5}M`); await settle(); },
    async release(row) { input.write(`\x1b[<0;4;${row + 5}m`); await settle(); },
    // Column 0 of the transcript is screen column 3, one for the frame border and
    // one for the transcript's own inset, and SGR counts from one.
    async pressAt(row, col) { input.write(`\x1b[<0;${col + 3};${row + 5}M`); await settle(); },
    async dragAt(row, col) { input.write(`\x1b[<32;${col + 3};${row + 5}M`); await settle(); },
    async releaseAt(row, col) { input.write(`\x1b[<0;${col + 3};${row + 5}m`); await settle(); },
  };
}

test('dragging the transcript scrollbar scrolls without selecting text', async () => {
  const m = mouseUI();
  try {
    for (let n = 0; n < 80; n++) m.ui.addLine(`строка ${n}`);
    const copies = [];
    m.ui.onCopy((text) => copies.push(text));
    // The visible scrollbar is the last transcript column: screen column 78
    // at this 80-column fixture, or logical transcript column 75.
    await m.pressAt(0, 75);
    await m.dragAt(11, 75);
    await m.releaseAt(11, 75);

    assert.ok(m.ui.historyScrollOffset() > 0, 'the thumb moves the history');
    assert.equal(m.ui.isFollowingTail(), false, 'a dragged thumb leaves tail-follow mode');
    assert.deepEqual(copies, [], 'a scrollbar gesture is never a text selection');
    assert.equal(m.ui.selectionRange(), null);
  } finally {
    m.ui.destroy();
  }
});

test('a drag reported as repeated presses still selects every line it crossed', async () => {
  // The whole point of selecting inside the app is reaching more than one line.
  // Treating each press as a fresh anchor collapsed this to the last row.
  const m = mouseUI();
  try {
    for (let n = 0; n < 10; n++) m.ui.addLine(`строка ${n}`);
    const copied = [];
    m.ui.onCopy((text, count) => copied.push({ text, count }));
    await m.press(2);
    await m.drag(4);
    await m.drag(6);
    await m.release(6);
    assert.equal(copied.length, 1, 'the release must copy once');
    assert.equal(copied[0].count, 5);
    assert.equal(
      copied[0].text,
      ['строка 2', 'строка 3', 'строка 4', 'строка 5', 'строка 6'].join('\n'),
    );
  } finally {
    m.ui.destroy();
  }
});

test('a selection dragged back upwards copies the same lines', async () => {
  const m = mouseUI();
  try {
    for (let n = 0; n < 10; n++) m.ui.addLine(`строка ${n}`);
    const copied = [];
    m.ui.onCopy((text) => copied.push(text));
    await m.press(6);
    await m.drag(2);
    await m.release(2);
    assert.equal(copied[0], ['строка 2', 'строка 3', 'строка 4', 'строка 5', 'строка 6'].join('\n'));
  } finally {
    m.ui.destroy();
  }
});

test('a click without a drag copies the one line under it', async () => {
  const m = mouseUI();
  try {
    for (let n = 0; n < 10; n++) m.ui.addLine(`строка ${n}`);
    const copied = [];
    m.ui.onCopy((text, count) => copied.push({ text, count }));
    await m.press(3);
    await m.release(3);
    assert.deepEqual(copied, [{ text: 'строка 3', count: 1 }]);
  } finally {
    m.ui.destroy();
  }
});

test('a drag across a multiline message copies it without the alignment padding', async () => {
  // Continuation rows are indented on screen so the picture stays in one
  // grid (see 'a multiline message keeps its rows in one grid' above); a copy
  // must undo that indent, or pasting a message elsewhere hands back every
  // row after the first wearing spaces that were never part of what was sent.
  const m = mouseUI();
  try {
    m.ui.addMessage({
      id: 'm1',
      name: 'Roman',
      text: 'aaa\nbbb\nccc',
      ts: new Date('2026-08-13T13:17:00').getTime(),
      self: false,
    });
    const copied = [];
    m.ui.onCopy((text) => copied.push(text));
    await m.press(0);
    await m.drag(2);
    await m.release(2);
    assert.equal(copied.length, 1);
    const lines = copied[0].split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[0], '{Roman} aaa');
    assert.equal(lines[1], 'bbb');
    assert.equal(lines[2], 'ccc [13:17]');
  } finally {
    m.ui.destroy();
  }
});

test('the selection is dropped once it has been copied', async () => {
  // Leaving it highlighted would keep painting over messages that arrive next.
  const m = mouseUI();
  try {
    for (let n = 0; n < 10; n++) m.ui.addLine(`строка ${n}`);
    await m.press(2);
    await m.drag(4);
    assert.deepEqual(m.ui.selectionRange(), { from: 2, to: 4 });
    await m.release(4);
    assert.equal(m.ui.selectionRange(), null);
  } finally {
    m.ui.destroy();
  }
});

test('released mouse leaves selecting to the terminal', async () => {
  // With the mouse released the terminal owns it, and the app must not fight for
  // the same drag.
  const m = mouseUI({ mouse: false });
  try {
    for (let n = 0; n < 10; n++) m.ui.addLine(`строка ${n}`);
    let copies = 0;
    m.ui.onCopy(() => { copies += 1; });
    await m.press(2);
    await m.drag(4);
    await m.release(4);
    assert.equal(copies, 0);
    assert.equal(m.ui.selectionRange(), null);
  } finally {
    m.ui.destroy();
  }
});

test('a wrapped message is copied whole, not by the row that was crossed', async () => {
  // The transcript wraps, and half a wrapped row is not a thing anyone wants in
  // their clipboard.
  const m = mouseUI();
  try {
    m.ui.addLine('короткая');
    m.ui.addLine(`длинная ${'слово '.repeat(30)}конец`);
    const copied = [];
    m.ui.onCopy((text, count) => copied.push({ text, count }));
    await m.press(2);
    await m.release(2);
    assert.equal(copied[0].count, 1, 'one line, however many rows it took');
    assert.ok(copied[0].text.startsWith('длинная '), copied[0].text.slice(0, 40));
    assert.ok(copied[0].text.endsWith('конец'), 'the tail past the wrap must come too');
  } finally {
    m.ui.destroy();
  }
});

test('a drag released over the composer still finishes', async () => {
  // Dragging downwards ends where the pointer runs out of transcript, which is
  // the composer. blessed tells an element nothing once the pointer leaves it, so
  // a release handled by the transcript alone left the selection armed and the
  // edge scroll running for the rest of the session.
  const m = mouseUI();
  try {
    for (let n = 0; n < 10; n++) m.ui.addLine(`строка ${n}`);
    const copied = [];
    m.ui.onCopy((text, count) => copied.push({ text, count }));
    await m.press(2);
    await m.drag(4);
    // Row 30 is past the transcript: the composer and its rule live there.
    await m.drag(30);
    await m.release(30);
    assert.equal(copied.length, 1, 'the release outside must still copy');
    assert.equal(m.ui.selectionRange(), null, 'the selection must be disarmed');

    // A fresh press must start a new selection rather than extend the old one.
    copied.length = 0;
    await m.press(1);
    await m.release(1);
    assert.deepEqual(copied, [{ text: 'строка 1', count: 1 }]);
  } finally {
    m.ui.destroy();
  }
});

test('a press outside the transcript selects nothing', async () => {
  // Clicking into the composer to move the caret must not start a selection.
  const m = mouseUI();
  try {
    for (let n = 0; n < 10; n++) m.ui.addLine(`строка ${n}`);
    let copies = 0;
    m.ui.onCopy(() => { copies += 1; });
    await m.press(30);
    await m.drag(28);
    await m.release(28);
    assert.equal(copies, 0);
    assert.equal(m.ui.selectionRange(), null);
  } finally {
    m.ui.destroy();
  }
});

test('the typing indicator animates without anyone touching the keyboard', async () => {
  // The band is drawn on the composer rule inside layout(), and the animation
  // only refreshed the header — so it stood still until the reader happened to
  // type, which is the opposite of when a typing indicator is worth having.
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  const frames = [];
  output.on('data', (chunk) => frames.push(chunk.toString('binary')));
  const ui = createUI({
    selfName: 'Alice', peerLabel: 'Roman', input, output, themed: true,
  });
  try {
    ui.setStatus('online');
    ui.setPeerTyping(true);
    frames.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(frames.length >= 2, `only ${frames.length} paints in half a second`);
    assert.ok(
      new Set(frames).size >= 2,
      'every paint was identical, so nothing actually moved',
    );

    ui.setPeerTyping(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    frames.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(frames.length, 0, 'a still screen must not be repainted');
  } finally {
    ui.destroy();
  }
});

test('the shimmer sweeps the whole label and rests dark between passes', () => {
  // The phase was cycled modulo four while the band spans fourteen steps, so the
  // light shuffled between a few positions and snapped back. It then wrapped, so
  // the sweep never ended and the label never sat still.
  const crest = /^\{bold\}\{\d+-fg\}/;
  for (const label of ['Roman typing', 'repentandliveholy typing', 'ab']) {
    const span = shimmerSpan(label);
    const chars = Array.from(label);
    const last = chars[chars.length - 1];
    const frames = Array.from(
      { length: span },
      (_, phase) => shimmerMarkup(label, phase),
    );
    // Both ends have to take a turn under the head: a band that wrapped left the
    // first and last characters permanently short of full brightness.
    assert.ok(
      frames.some((frame) => crest.test(frame)),
      `${label}: the first character is never the crest`,
    );
    const tail = new RegExp(`\\{bold\\}\\{\\d+-fg\\}${last}\\{/\\}$`);
    assert.ok(
      frames.some((frame) => tail.test(frame)),
      `${label}: the last character is never the crest`,
    );
    // And the pass has to end: one flat frame in a single shade is the rest the
    // eye reads as breathing rather than a spinning barber pole.
    assert.ok(
      frames.some((frame) => {
        if (frame.includes('{bold}')) return false;
        const shades = new Set(frame.match(/\{(\d+)-fg\}/g) ?? []);
        return shades.size === 1;
      }),
      `${label}: the band never leaves the label`,
    );
    assert.ok(
      new Set(frames).size > span / 2,
      `${label}: only ${new Set(frames).size} of ${span} frames differ`,
    );
    for (const frame of frames) {
      // A band shorter than the label indexed past the palette and painted
      // `{undefined-fg}`, which blessed prints as literal text in the frame.
      assert.doesNotMatch(frame, /undefined/, `${label}: ran out of palette`);
    }
  }
});

test('the header says CONNECTING only while a call is actually open', () => {
  // With the backoff, most of a wait is spent with nothing in flight. A header
  // that said CONNECTING through all of it was claiming work it was not doing.
  assert.deepEqual(statusPresentation('waiting', true), {
    symbol: '◌', label: 'WAITING', color: 'gray',
  });
  assert.deepEqual(statusPresentation('connecting…', true), {
    symbol: '◌', label: 'CONNECTING', color: 'yellow',
  });
  // Before the first dial there is nothing open either.
  assert.equal(statusPresentation('', true).label, 'WAITING');
  assert.equal(statusPresentation(undefined, true).label, 'WAITING');
});

test('help rows line up in a column and stay inside the frame', () => {
  // Fifty lines of prose in one colour is not a reference, it is a wall. The
  // column is what makes a name findable by scanning.
  const rows = [
    ['/help  /h', 'show commands, keys and flags'],
    ['/mouse /m', 'toggle mouse capture — turn it off to select and copy text with the terminal'],
    ['Home / End or Ctrl+A / Ctrl+E', 'start and end of the draft line'],
  ];
  const width = 76;
  const cells = layoutTable({ rows, width });
  const rendered = cells.map((c) => ' '.repeat(c.indent) + c.left + ' '.repeat(c.gap) + c.text);

  for (const line of rendered) {
    // An em dash is ambiguous width: a terminal may draw it at two cells, and a
    // line that fitted on paper then pushed its last word past the border.
    assert.ok(worstCaseWidth(line) <= width, `${worstCaseWidth(line)} > ${width}: ${line}`);
  }
  const starts = cells.filter((c) => c.left && c.text).map((c) => c.indent + c.column + c.gap);
  assert.equal(new Set(starts).size, 1, 'descriptions must share one column');
  // A wrapped line hangs under the text, not under the name.
  const continuation = cells.find((c) => !c.left && c.text);
  assert.equal(continuation.indent, starts[0]);
});

test('a name too wide for its column keeps its own line', () => {
  // Squeezing the description into a ribbon beside a long key is worse than
  // giving the key a line of its own.
  const rows = [['x', 'short'], ['a very long key combination indeed for one row', 'text here']];
  const cells = layoutTable({ rows, width: 40 });
  const wide = cells.find((c) => c.left.startsWith('a very long'));
  assert.equal(wide.text, '', 'the name takes the line');
  assert.equal(cells[cells.indexOf(wide) + 1].text, 'text here');
});

test('ambiguous-width characters are budgeted at their widest', () => {
  // Guessing narrow costs a wrapped word and a broken frame; guessing wide costs
  // a trailing space nobody sees.
  assert.equal(worstCaseWidth('ab'), 2);
  assert.equal(worstCaseWidth('a—b'), 4, 'the em dash may take two cells');
  assert.equal(worstCaseWidth('✓✓'), 4);
});

test('the command menu is a panel, not more chat', () => {
  // It used to float in the same green as the conversation, with only boldness
  // marking the selection — the eye kept missing both the list and the choice.
  const shown = [
    { name: '/help', alias: '/h', help: 'show commands, keys and flags' },
    { name: '/history', alias: '/i', help: 'show the transcript kept on disk' },
  ];
  const rows = renderMenuMarkup({
    shown, hidden: 11, chosenIndex: 0, width: 80, nameWidth: 8,
  }).split('\n');

  // Reverse video on the selection, not another shade of green.
  assert.match(rows[0], /\{green-bg\}\{black-fg\}/);
  assert.doesNotMatch(rows[1], /green-bg/, 'only one row is chosen');
  // Name and explanation in different hues, so the list is scanned by name.
  assert.match(rows[1], /\{cyan-fg\} {2}\/history \/i {2}\{\/cyan-fg\}/);
  assert.match(rows[1], /\{green-fg\}show the transcript/);
  // The names line up in a column whatever their length.
  const plain = rows.map((row) => row.replace(/\{[^}]*\}/g, ''));
  assert.equal(plain[0].indexOf('/h '), plain[1].indexOf('/i '));
  // What did not fit is counted rather than silently dropped.
  assert.match(plain[1], /… \+11$/);
});

test('a choice without help text never renders undefined', () => {
  const row = renderMenuMarkup({
    shown: [{ name: 'создать аккаунт', value: 'yes' }],
    chosenIndex: 0,
    themed: false,
    nameWidth: 16,
  });
  assert.doesNotMatch(row, /undefined/);
  assert.match(row, /создать аккаунт/);
});

test('no menu row may fill its box, or the selection falls off the bottom', () => {
  // blessed wraps a row that exactly fills a one-line widget. The menu box is
  // sized to the number of commands, so a wrapped row steals a line from it —
  // the last line, which is the selected one for as long as the list scrolls.
  // Reproduced with a real screen at every width below 116 columns: the marked
  // row was painted outside the box and could not be seen at all.
  const shown = [
    { name: '/mouse', alias: '/m', help: 'toggle mouse capture: on selects and copies whole lines, off returns selection to the terminal' },
    { name: '/files', alias: '/f', help: 'list the files of this session, sent and received, with their indexes' },
    { name: '/send', alias: '/s', help: 'send a file or image: /send ~/photo.jpg (quotes are fine)' },
    { name: '/peer', alias: '', help: 'switch to another remembered person' },
    { name: '/happy', alias: '/a', help: 'send a happy face (^_^)' },
    { name: '/sad', alias: '/d', help: 'send a sad face (;_;)' },
  ];
  for (const width of [40, 50, 60, 72, 80, 96, 110, 116, 130]) {
    // The chosen row is the interesting one: `❯` is ambiguous-width, so it is
    // the row a terminal may draw one cell wider than a character count says.
    for (const chosenIndex of [0, 3, 5]) {
      for (const themed of [true, false]) {
        const rows = renderMenuMarkup({
          shown, hidden: 14, chosenIndex, width, themed, nameWidth: 8,
        }).split('\n');
        assert.equal(rows.length, shown.length, `${width}: one line per command`);
        for (const [index, row] of rows.entries()) {
          const plain = row.replace(/\{[^}]*\}/g, '');
          // width - 4: the frame border and the box's own inset on both sides.
          // Strictly less, because filling it exactly is what wraps.
          assert.ok(
            worstCaseWidth(plain) < width - 4,
            `${width} cols, row ${index}, chosen ${chosenIndex}: `
            + `${worstCaseWidth(plain)} cells in a ${width - 4}-cell box: ${plain}`,
          );
        }
      }
    }
  }
});

test('the panel says how far down the list the choice is', () => {
  // Six rows of seventeen: without the count the list looks complete.
  assert.equal(menuRuleLabel({ index: 0, total: 17, shown: 6 }), 'commands 1/17');
  assert.equal(menuRuleLabel({ index: 8, total: 17, shown: 6 }), 'commands 9/17');
  // Nothing hidden, nothing to count.
  assert.equal(menuRuleLabel({ index: 1, total: 2, shown: 2 }), 'commands');
  assert.equal(menuRuleLabel({ index: 0, total: 3, shown: 3, word: 'peers' }), 'peers');
  assert.equal(menuRuleLabel({ index: 1, total: 9, shown: 6, word: 'peers' }), 'peers 2/9');
});

test('a monochrome menu still shows which row is chosen', () => {
  // With no colour at all the marker is the only thing left to say it.
  const shown = [
    { name: '/help', alias: '/h', help: 'show help' },
    { name: '/quit', alias: '/q', help: 'close tailchat' },
  ];
  const rows = renderMenuMarkup({ shown, chosenIndex: 1, themed: false, nameWidth: 8 })
    .split('\n');
  assert.doesNotMatch(rows.join(''), /\{[a-z-]+\}/, 'no markup at all');
  assert.ok(rows[1].startsWith('❯'), 'the marker must survive without colour');
  assert.ok(rows[0].startsWith(' '), 'the unchosen row is not marked');
});

test('a click on an image preview opens the file, not a selection', async () => {
  // A preview is made of half-block cells; selecting those into the clipboard is
  // nonsense. A click on the picture must open it instead.
  const m = mouseUI();
  try {
    for (let n = 0; n < 3; n++) m.ui.addLine(`строка ${n}`);
    m.ui.addArt(['{#ff0000-fg}▀{/}'], '/tmp/photo.png');
    const opened = [];
    const copied = [];
    m.ui.onOpenImage((file) => opened.push(file));
    m.ui.onCopy((text) => copied.push(text));
    await m.press(3);
    await m.release(3);
    assert.deepEqual(opened, ['/tmp/photo.png']);
    assert.deepEqual(copied, [], 'a click on a preview must not copy its cells');
  } finally {
    m.ui.destroy();
  }
});

test('a preview without a file is just art, not a click target', async () => {
  // The sender's clipboard paste has no surviving path to reopen.
  const m = mouseUI();
  try {
    m.ui.addArt(['{#ff0000-fg}▀{/}']);
    let opened = 0;
    let copied = 0;
    m.ui.onOpenImage(() => { opened += 1; });
    m.ui.onCopy(() => { copied += 1; });
    await m.press(0);
    await m.release(0);
    assert.equal(opened, 0);
    assert.equal(copied, 1, 'plain art still selects');
  } finally {
    m.ui.destroy();
  }
});

test('a preview still opens after the history has trimmed past it', async () => {
  // The click target used to be a line number written down when the picture was
  // appended. The buffer trims its head, every line below moves up, and the
  // number then pointed at the wrong row — so in any session long enough to
  // trim, clicking a photo did nothing at all. Two thousand entries is the
  // limit, so this walks past it.
  const m = mouseUI();
  try {
    for (let n = 0; n < 2100; n++) m.ui.addLine(`строка ${n}`);
    m.ui.addArt(['', '{#ff0000-fg}▀{/}', ''], '/tmp/photo.png');
    m.ui.addLine('после картинки');
    const opened = [];
    m.ui.onOpenImage((file) => opened.push(file));
    // The transcript is 18 rows tall: the picture sits just above the last line.
    await m.press(15);
    await m.release(15);
    assert.deepEqual(opened, ['/tmp/photo.png']);
  } finally {
    m.ui.destroy();
  }
});

test('a preview appended after /clear opens at its new position', async () => {
  // /clear empties the transcript, so every offset written down before it is
  // wrong afterwards — including the one belonging to a picture that no longer
  // exists. Positions have to be read off the entries still there.
  const m = mouseUI();
  try {
    m.ui.addMessage({ name: 'Roman', text: 'смотри', ts: Date.now(), self: false });
    m.ui.addArt(['{#ff0000-fg}▀{/}'], '/tmp/gone.png');
    const opened = [];
    m.ui.onOpenImage((file) => opened.push(file));
    m.ui.clearHistory();
    m.ui.addArt(['{#ff0000-fg}▀{/}'], '/tmp/photo.png');
    await m.press(0);
    await m.release(0);
    assert.deepEqual(opened, ['/tmp/photo.png']);
  } finally {
    m.ui.destroy();
  }
});

test('the logo band pushes the transcript down and clicks follow it', async () => {
  // The band is not part of the transcript, so a click three rows lower must
  // still land on the first line of it — every coordinate is measured off the
  // history box, which the band moves.
  const m = mouseUI();
  try {
    const opened = [];
    m.ui.onOpenImage((file) => opened.push(file));
    m.ui.setLogo(['LOGO', 'LOGO', 'LOGO']);
    assert.equal(m.ui.logoRows(), 3);
    m.ui.addArt(['{#ff0000-fg}▀{/}'], '/tmp/photo.png');
    await m.press(3);
    await m.release(3);
    assert.deepEqual(opened, ['/tmp/photo.png'], 'the picture sits under the band');

    // Taking the band away gives the rows back, and the same picture is at the top.
    m.ui.setLogo(null);
    assert.equal(m.ui.logoRows(), 0);
    await m.press(0);
    await m.release(0);
    assert.deepEqual(opened, ['/tmp/photo.png', '/tmp/photo.png']);
  } finally {
    m.ui.destroy();
  }
});

test('/clear cannot take the logo: it is not in the transcript', () => {
  const ui = headlessUI();
  try {
    ui.setLogo(['LOGO', 'LOGO', 'LOGO']);
    ui.addLine('* greeting');
    ui.addMessage({ name: 'you', text: 'one', ts: Date.now(), self: true });
    ui.clearHistory();
    assert.equal(ui.logoRows(), 3, 'the band survives the clear');
    assert.equal(ui.isFollowingTail(), true);
    assert.equal(ui.historyScrollOffset(), 0);
  } finally {
    ui.destroy();
  }
});

test('the animation sizes the band once and settles on the last frame', () => {
  const ui = headlessUI();
  try {
    // Three rows from the first frame on, or the transcript would be shoved down
    // a row at a time while the sweep runs.
    assert.equal(ui.playLogo([['a', 'b', 'c'], ['aa', 'bb', 'cc']]), true);
    assert.equal(ui.logoRows(), 3);
    assert.equal(ui.playLogo([]), false, 'nothing to draw is not an animation');
  } finally {
    ui.destroy();
  }
});

test('the fullscreen saver consumes its waking key and releases typing afterwards', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  output.resume();
  const ui = createUI({ selfName: 'Alice', peerLabel: 'Roman', input, output });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    // Textarea binds its input listener one immediate after initial focus.
    await settle();
    input.write('a');
    await settle();
    assert.equal(ui.draft(), 'a', 'the composer is in its real steady state');

    assert.equal(ui.playSaverScreen([['zzz'], ['ZZZ']], { interval: 5 }), true);
    assert.equal(ui.saverActive(), true);
    input.write('q');
    await settle();
    assert.equal(ui.saverActive(), false, 'any key wakes it');
    assert.equal(ui.draft(), 'a', 'the waking key is not drafted');

    input.write('b');
    await settle();
    assert.equal(ui.draft(), 'ab', 'typing resumes after the saver closes');
  } finally {
    ui.destroy();
  }
});

test('an empty fullscreen saver does not cover the UI', () => {
  const ui = headlessUI();
  try {
    assert.equal(ui.playSaverScreen([]), false);
    assert.equal(ui.saverActive(), false);
  } finally {
    ui.destroy();
  }
});

test('focus returning alone ends an automatic saver and releases typing', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  output.resume();
  const ui = createUI({ selfName: 'Alice', peerLabel: 'Roman', input, output });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    await settle();
    assert.equal(ui.playSaverScreen([['zzz'], ['ZZZ']], { interval: 5 }), true);
    assert.equal(ui.saverActive(), true);

    // No keypress here: this is the window regaining focus on its own.
    ui.hideSaverScreen();
    assert.equal(ui.saverActive(), false);
    await settle(); // lock release is deferred one turn

    input.write('x');
    await settle();
    assert.equal(ui.draft(), 'x', 'typing works after a focus-only wake');
  } finally {
    ui.destroy();
  }
});

test('a saver asked for by hand ignores the mouse entirely', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 30;
  output.resume();
  const ui = createUI({ selfName: 'Alice', peerLabel: 'Roman', input, output });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    await settle();
    input.write('draft');
    await settle();

    // With /mouse on, the terminal really is reporting the mouse, so these
    // bytes really do become mouse events — the test is not vacuous.
    assert.equal(ui.setMouseCapture(true), true);

    // No `wakeOnMouse`: this is `/saver`, something the reader chose to watch.
    assert.equal(ui.playSaverScreen([['zzz'], ['ZZZ']], { interval: 5 }), true);

    // Raw SGR motion, then a left-button press. Outside the VTE family blessed
    // reports movement as `mousedown` too, so both arrive the same way — and
    // neither may end a saver somebody asked for.
    for (const bytes of ['\u001b[<35;10;5M', '\u001b[<0;10;5M', '\u001b[<0;10;5m']) {
      input.write(bytes);
      await settle();
      assert.equal(ui.saverActive(), true, `${JSON.stringify(bytes)} must not end it`);
    }
    assert.equal(ui.isMouseCaptured(), true, 'and it left mouse capture alone');

    input.write('q');
    await settle();
    assert.equal(ui.saverActive(), false, 'a key still ends it');
    await settle();
    input.write('x');
    await settle();
    assert.equal(ui.draft(), 'draftx', 'the waking key is not typed, and typing resumes');
  } finally {
    ui.destroy();
  }
});

test('a saver that came up on its own ends on the mouse and hands it back', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 30;
  output.resume();
  const ui = createUI({ selfName: 'Alice', peerLabel: 'Roman', input, output });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    await settle();
    input.write('draft');
    await settle();

    // Selection is left to the terminal by default, so an automatic saver has to
    // borrow the mouse to hear it at all — and hand it back when it closes.
    assert.equal(ui.isMouseCaptured(), false, 'the terminal owns the mouse first');
    assert.equal(
      ui.playSaverScreen([['zzz'], ['ZZZ']], { interval: 5, wakeOnMouse: true }),
      true,
    );
    assert.equal(ui.isMouseCaptured(), true, 'the automatic saver borrows it');

    // A nudged mouse is proof somebody is at the machine, which is exactly what
    // an automatic saver was waiting for. Raw SGR motion, as a terminal sends it.
    input.write('\u001b[<35;10;5M');
    await settle();
    assert.equal(ui.saverActive(), false, 'the mouse ends it');
    assert.equal(ui.isMouseCaptured(), false, 'and the mouse goes back to the terminal');
    await settle(); // lock release is deferred one turn

    input.write('x');
    await settle();
    assert.equal(ui.draft(), 'draftx', 'nothing of the mouse reached the composer');
  } finally {
    ui.destroy();
  }
});

test('a saver whose window shrank under it reports that it no longer fits', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 30;
  output.resume();
  const ui = createUI({ selfName: 'Alice', peerLabel: 'Roman', input, output });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    await settle();
    assert.equal(ui.saverFits(), true, 'nothing playing fits by definition');

    const frame = Array.from({ length: 12 }, () => 'x'.repeat(50));
    assert.equal(ui.playSaverScreen([frame], { interval: 5 }), true);
    assert.equal(ui.saverFits(), true, '50 columns inside 80');

    output.columns = 45;
    output.rows = 30;
    output.emit('resize');
    await settle();
    assert.equal(ui.saverActive(), true, 'the saver is still up');
    assert.equal(ui.saverFits(), false, '50 columns cannot fit 45 without wrapping');

    output.columns = 80;
    output.emit('resize');
    await settle();
    assert.equal(ui.saverFits(), true, 'and it fits again when the window grows back');

    // Closing forgets the geometry rather than leaving a stale verdict behind.
    ui.hideSaverScreen();
    output.columns = 10;
    output.emit('resize');
    await settle();
    assert.equal(ui.saverFits(), true);
  } finally {
    ui.destroy();
  }
});

test('the buffer moves its click targets when it trims and when /clear runs', async () => {
  // The same staleness that broke previews broke links, and both are cheap to
  // pin down at the source: positions must be read off the entries that are
  // still there, never off numbers written down when they were appended.
  const buffer = createHistoryBuffer(2);
  buffer.appendLine('первая');
  buffer.appendArt(['▀', '▄'], '/tmp/photo.png');
  assert.deepEqual(buffer.artSpans(), [{ from: 1, to: 2, file: '/tmp/photo.png' }]);

  // A third entry pushes the first one out, so the picture moves up a line.
  buffer.appendMessage({ name: 'Roman', text: 'см https://example.dev', ts: 0, self: false });
  assert.deepEqual(buffer.artSpans(), [{ from: 0, to: 1, file: '/tmp/photo.png' }]);

  const body = 2 + 'Roman'.length + 1;
  assert.equal(buffer.linkAt(2, body + 'см '.length), 'https://example.dev');
  assert.equal(buffer.linkAt(2, body), null, 'the words before the link are not it');
  assert.equal(buffer.linkAt(0, body + 'см '.length), null, 'the picture holds no link');

  // /clear takes the message out from under the picture — and the picture too:
  // the transcript is emptied outright, the logo lives outside it.
  buffer.clear();
  assert.deepEqual(buffer.artSpans(), []);
  assert.equal(buffer.linkAt(0, 0), null);
});

test('a URL in a message is coloured and underlined', () => {
  const out = renderBodyMarkup('смотри https://example.com и http://x.dev и www.example.org', { themed: true });
  assert.match(out, /\{underline\}\{39-fg\}https:\/\/example\.com\{\/39-fg\}\{\/underline\}/);
  assert.match(out, /\{39-fg\}www\.example\.org\{\/39-fg\}/);
});

test('a local path in a message is a link too', () => {
  // «в cli не могу нажать на ссылку /Users/…/image-…webp, она не
  // подчеркивается»: a received attachment is announced as a path, and a path
  // the terminal paints as a link is one Cmd+click opens.
  const path = '/Users/me/.tailchat/files/image-1789844915865-7ea4ec.webp';
  const out = renderBodyMarkup(`фото ${path}`, { themed: true });
  assert.match(out, new RegExp(`\\{underline\\}\\{39-fg\\}${path.replace(/[.]/g, '\\.')}\\{/39-fg\\}\\{/underline\\}`));
  const links = [];
  renderBodyMarkup(`фото ${path}`, { themed: true, onLink: (l) => links.push(l) });
  assert.deepEqual(links, [{ url: path, line: 0, col: 5 }], 'a click on it reports what to open');
});

test('a slash in prose, or a path with no extension, is not a link', () => {
  // Underlining is a promise that a click opens something. A command, a
  // directory or a fraction must not make that promise.
  for (const text of ['используй /help для справки', 'иду в /Users/me/Downloads', '3/4 готово', '~/bin']) {
    const links = [];
    const out = renderBodyMarkup(text, { themed: true, onLink: (l) => links.push(l) });
    assert.deepEqual(links, [], `${text} is not a link`);
    assert.equal(out, text, `${text} is painted as written`);
  }
});

test('a home-relative path is reported whole, for the opener to expand', () => {
  const out = renderBodyMarkup('готово: ~/.tailchat/files/shot.png', { themed: true, onLink: () => {} });
  assert.match(out, /\{39-fg\}~\/\.tailchat\/files\/shot\.png\{\/39-fg\}/);
});

test('a URL inside code is left as code, not a link', () => {
  const out = renderBodyMarkup('`https://example.com`', { themed: true });
  assert.doesNotMatch(out, /\{39-fg\}/, 'the code span wins');
});

test('monochrome keeps the URL text and drops the tag', () => {
  const out = renderBodyMarkup('смотри https://example.com', { themed: false });
  assert.equal(out, 'смотри https://example.com');
});

test('time is grey, trails the text, and the quote body is tinted', () => {
  const msg = renderMessageMarkup({
    ts: new Date('2026-08-11T14:02:00').getTime(), name: 'Roman', text: '> цитата', self: false, themed: true,
  });
  const clock = '{245-fg}[14:02]{/245-fg}';
  assert.ok(msg.endsWith(` ${clock}`), 'the clock trails the message');
  assert.match(msg, /\{67-fg\}цитата\{\/67-fg\}/, 'the quote body is tinted');
});

test('a link reports its position for click handling', () => {
  const links = [];
  renderBodyMarkup('ab https://x.dev cd', { themed: true, onLink: (l) => links.push(l) });
  assert.equal(links.length, 1);
  assert.equal(links[0].url, 'https://x.dev');
  assert.equal(links[0].line, 0);
  assert.equal(links[0].col, 3, 'the visible column after "ab "');
});

test('findLink matches a link by line and column', () => {
  const spans = [
    { line: 0, col: 3, url: 'https://x.dev' },
    { line: 2, col: 5, url: 'https://y.dev' },
  ];
  assert.equal(findLink(spans, 0, 3), 'https://x.dev');
  assert.equal(findLink(spans, 0, 10), 'https://x.dev', 'inside the url text');
  assert.equal(findLink(spans, 0, 30), null, 'past the url end');
  assert.equal(findLink(spans, 1, 5), null, 'a line with no link');
  assert.equal(findLink(spans, 2, 5), 'https://y.dev');
});

test('a copy of the transcript quotes what was sent, mid-token cut and all', () => {
  // blessed looks only ten characters back for a space, so a URL at the edge is
  // cut in the middle of itself, and a row that does end on a space loses it to
  // the terminal on the way to the clipboard. Neither seam can be rebuilt, so
  // the copy is used to recognise the message instead of to rejoin it.
  const text = 'see https://example.com/very/long/path/x and electronic typesetting, remaining';
  const history = createHistoryBuffer();
  history.appendMessage({ name: 'you', text, ts: Date.now(), self: true, marker: '✓' });

  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 60;
  output.rows = 20;
  output.resume();
  const screen = blessed.screen({ input, output, smartCSR: true, fullUnicode: true });
  try {
    const box = blessed.box({
      parent: screen, top: 0, left: 0, width: 40, height: 12, tags: true,
    });
    box.setContent(history.content());
    screen.render();
    // A clipboard carries characters, not attributes, so the colours the header
    // paints are not part of what a copy hands over.
    const rows = [...box._clines].map((row) => row.replace(/\x1b\[[0-9;]*m/g, ''));
    assert.ok(rows.length > 2, 'the message has to wrap for this to prove anything');
    assert.ok(
      rows.some((row) => displayWidth(row) === 40 && /\S$/.test(row)),
      'a row must reach the edge on a non-space: that is the cut mid-token',
    );
    // What the terminal hands over: those rows, each behind the transcript margin.
    const copied = rows.map((row) => `  ${row}`).join('\n');
    assert.equal(history.lookup(transcriptKeys(copied, ['you'])), text);
  } finally {
    screen.destroy();
  }
});

test('a quote this client never stored is left exactly as it came', () => {
  const history = createHistoryBuffer();
  history.appendMessage({ name: 'you', text: 'hello', ts: Date.now(), self: true });
  assert.equal(history.lookup(null), null);
  assert.equal(history.lookup([]), null);
  assert.equal(history.lookup(transcriptKeys('  [16:48] {you} never sent ✓', ['you'])), null);
});

test('two different messages behind one key leave the paste alone', () => {
  const ts = Date.now();
  const history = createHistoryBuffer();
  history.appendMessage({ name: 'you', text: 'a b', ts, self: true });
  history.appendMessage({ name: 'you', text: 'ab', ts, self: true });
  // Spacing is what the key throws away, so these two collide. Guessing between
  // them would rewrite a paste into something that was never sent.
  assert.equal(history.lookup(['ab']), null);

  const twice = createHistoryBuffer();
  twice.appendMessage({ name: 'you', text: 'same', ts, self: true });
  twice.appendMessage({ name: 'you', text: 'same', ts, self: true });
  // The same words twice are one quote, not an ambiguity.
  assert.equal(twice.lookup(['same']), 'same');
});

test('pasting a copy of the conversation drafts the message that was sent', async () => {
  const text = 'see https://example.com/very/long/path/x and electronic typesetting, remaining';
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const ui = headlessUI({ input });
  try {
    ui.addMessage({ name: 'Alice', text, ts: Date.now(), self: true });
    // The rows a terminal hands over for that message, cut mid-token by the wrap
    // exactly as blessed cuts them.
    const copied = [
      '  {you} see https://example.com/very/long/path/x and electronic typesettin',
      '  g, remaining ✓ [16:48]',
    ].join('\n');
    input.write(`\x1b[200~${copied}\x1b[201~`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ui.draft(), text, 'the quote is the message, not the rows it was shown on');
  } finally {
    ui.destroy();
  }
});

test('pasting something that is not a quote still lands verbatim', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const ui = headlessUI({ input });
  try {
    ui.addMessage({ name: 'Alice', text: 'hello', ts: Date.now(), self: true });
    const log = '12:35 Roman: jkdsklj\n12:36 godsheep: __test__';
    input.write(`\x1b[200~${log}\x1b[201~`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ui.draft(), log);
  } finally {
    ui.destroy();
  }
});

test('/clear empties the transcript, greeting and status lines included', () => {
  const history = createHistoryBuffer();
  history.appendLine('* greeting');
  history.appendMessage({ name: 'you', text: 'one', ts: Date.now(), self: true });
  history.appendMessage({ name: 'Roman', text: 'two', ts: Date.now(), self: false });
  history.appendLine('* status');
  assert.equal(history.clear(), '');
  assert.equal(history.content(), '');
  // Everything really went: clearing again changes nothing.
  assert.equal(history.clear(), '');
});

test('the head trims the oldest lines and nothing is pinned in the transcript', () => {
  const history = createHistoryBuffer(2);
  history.appendLine('* greeting');
  history.appendLine('one');
  history.appendLine('two');
  assert.equal(history.content(), 'one\ntwo', 'the logo is not in here to protect');
});

test('a multiline paste collapses to a marker; the draft keeps the full text', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const ui = headlessUI({ input });
  try {
    input.write('\x1b[200~alpha\nbeta\x1b[201~');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ui.draft(), 'alpha\nbeta');
    assert.match(ui.composerContent(), /pasted 2 lines/);
  } finally {
    ui.destroy();
  }
});

test('showLockScreen displays overlay, blocks input, and unlocks on correct password', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const ui = headlessUI({ input });
  try {
    let unlocked = false;
    assert.equal(ui.isLocked(), false);
    assert.equal(ui.showLockScreen({
      hasPass: true,
      verifyPassword: (pwd) => pwd === 'secret123',
      onUnlock: () => { unlocked = true; },
    }), true);
    assert.equal(ui.isLocked(), true);

    // Can't show duplicate lock screen
    assert.equal(ui.showLockScreen(), false);

    // Type wrong password + Enter -> still locked
    input.write('wrong\r');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(ui.isLocked(), true);
    assert.equal(unlocked, false);

    // Type correct password + Enter -> unlocked
    input.write('secret123\r');
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(ui.isLocked(), false);
    assert.equal(unlocked, true);
  } finally {
    ui.destroy();
  }
});

test('promptSecret masks what is typed, resolves it on Enter, and leaves no trace in the draft', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const ui = headlessUI({ input });
  try {
    input.write('draft');
    await new Promise((r) => setTimeout(r, 20));
    const answer = ui.promptSecret({ title: 'RESTORE', subtitle: 'sub', prompt: 'Key:', hint: '[Esc] Cancel' });
    assert.equal(ui.secretPromptOpen(), true);
    assert.equal(ui.isLocked(), true);
    // A second prompt, or the lock, cannot take the screen from it.
    assert.equal(await ui.promptSecret({}), null);
    assert.equal(ui.showLockScreen(), false);

    input.write('s3cr');
    await new Promise((r) => setTimeout(r, 20));
    input.write('\x7f'); // one Backspace
    input.write('et');
    await new Promise((r) => setTimeout(r, 20));
    const card = ui.overlayContent();
    assert.match(card, /RESTORE/);
    assert.match(card, /Key:/);
    assert.match(card, /•{5}/, 's3cet is five bullets');
    assert.doesNotMatch(card, /s3c|cet/, 'the secret itself is never drawn');

    input.write('\r');
    assert.equal(await answer, 's3cet');
    assert.equal(ui.secretPromptOpen(), false);
    assert.equal(ui.draft(), 'draft', 'the composer kept its draft and got none of the secret');
    // The screen takes keys again once the prompt is gone.
    await new Promise((r) => setTimeout(r, 20));
    input.write('!');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ui.draft(), 'draft!');
  } finally {
    ui.destroy();
  }
});

test('an overlay opened by the Enter that sent a command does not take that Enter as its answer', async () => {
  // `/keys reset` and `/lock` open their overlay synchronously while blessed is
  // still dispatching the Enter: the card used to "cancel" before it was seen,
  // and a lock without a password unlocked at once.
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const ui = headlessUI({ input });
  try {
    let answer = null;
    ui.onInput((text) => {
      if (text === '/keys reset') answer = ui.promptSecret({ prompt: 'Password:' });
      if (text === '/lock') ui.showLockScreen({ hasPass: false });
    });
    input.write('/keys reset');
    await new Promise((r) => setTimeout(r, 20));
    input.write('\r');
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(answer, 'the command ran');
    assert.equal(ui.secretPromptOpen(), true, 'the card is still up after the Enter that opened it');
    input.write('pw');
    await new Promise((r) => setTimeout(r, 20));
    input.write('\r');
    assert.equal(await answer, 'pw');

    await new Promise((r) => setTimeout(r, 20));
    input.write('/lock');
    await new Promise((r) => setTimeout(r, 20));
    input.write('\r');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ui.isLocked(), true, '/lock without a password stays locked until the next Enter');
    input.write('\r');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ui.isLocked(), false);
  } finally {
    ui.destroy();
  }
});

test('promptSecret: Esc cancels with null, Ctrl+U clears, a long entry stays a short card', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const ui = headlessUI({ input });
  try {
    const first = ui.promptSecret({ prompt: 'Key:' });
    input.write('x'.repeat(65));
    await new Promise((r) => setTimeout(r, 20));
    assert.match(ui.overlayContent(), /… 65/, 'a 65-character key shows its length, not 65 bullets');
    input.write('\x15'); // Ctrl+U
    await new Promise((r) => setTimeout(r, 20));
    assert.doesNotMatch(ui.overlayContent(), /•/);
    input.write('abc');
    await new Promise((r) => setTimeout(r, 20));
    input.write('\x1b');
    assert.equal(await first, null);
    assert.equal(ui.secretPromptOpen(), false);
    assert.equal(ui.draft(), '');
  } finally {
    ui.destroy();
  }
});

test('promptSecret: a bracketed paste goes into the prompt, one line, never into the composer', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const ui = headlessUI({ input });
  try {
    const answer = ui.promptSecret({ prompt: 'Key:' });
    input.write('\x1b[200~tailchat-backup:v1:2:KEY\n\x1b[201~');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ui.draft(), '');
    assert.equal(ui.secretPromptOpen(), true, 'a pasted newline does not submit');
    input.write('\r');
    assert.equal(await answer, 'tailchat-backup:v1:2:KEY');
    assert.equal(ui.draft(), '');
  } finally {
    ui.destroy();
  }
});

test('promptSecret: the saver cannot cover an open prompt, and destroy() answers null', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const ui = headlessUI({ input });
  const answer = ui.promptSecret({ prompt: 'Key:' });
  assert.equal(ui.playSaverScreen([['cat']]), false);
  assert.equal(ui.saverActive(), false);
  // A timer hiding "the lock" leaves the prompt alone.
  ui.hideLockScreen();
  assert.equal(ui.secretPromptOpen(), true);
  ui.destroy();
  assert.equal(await answer, null);
});

test('showLockScreen while saver is active does not leak lockKeys on deferred saver teardown', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const ui = headlessUI({ input });
  try {
    ui.playSaverScreen([['cat']]);
    assert.equal(ui.saverActive(), true);

    ui.showLockScreen({
      hasPass: true,
      verifyPassword: () => true,
    });
    assert.equal(ui.isLocked(), true);

    // Wait for closeSaver's setImmediate to execute
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(ui.isLocked(), true);
  } finally {
    ui.destroy();
  }
});

test('unlock Enter does not submit composer or draft a newline', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  let submitted = null;
  const ui = headlessUI({ input });
  ui.onInput((text) => { submitted = text; });
  try {
    ui.setDraft('pending-message');
    ui.showLockScreen({
      hasPass: true,
      verifyPassword: (p) => p === 'secret',
    });

    input.write('secret\r');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(ui.isLocked(), false);
    assert.equal(submitted, null, 'Enter on lock screen must not submit the composer draft');
    assert.equal(ui.draft(), 'pending-message', 'draft remains unchanged');
  } finally {
    ui.destroy();
  }
});

test('typing after lock/unlock does not duplicate keystrokes', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const ui = headlessUI({ input });
  try {
    ui.setDraft('');
    ui.showLockScreen({
      hasPass: true,
      verifyPassword: (p) => p === 'secret',
    });

    input.write('secret\r');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(ui.isLocked(), false);

    input.write('/pass');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(ui.draft(), '/pass', 'each typed character is inserted exactly once');
  } finally {
    ui.destroy();
  }
});

test('ui.onTyping callback is triggered on typing in composer', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const ui = headlessUI({ input });
  try {
    let typingCount = 0;
    ui.onTyping(() => { typingCount++; });

    input.write('h');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(typingCount, 1, 'typing character triggers typing callback');

    input.write('i');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(typingCount, 2, 'subsequent character triggers typing callback');

    input.write('\x7f'); // backspace
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(typingCount, 3, 'backspace triggers typing callback');
  } finally {
    ui.destroy();
  }
});

test('ui.onSaverWake triggers callback on screensaver wake and allows immediate lock', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const ui = headlessUI({ input });
  try {
    let woken = false;
    ui.onSaverWake(() => {
      woken = true;
      ui.showLockScreen({ hasPass: true, verifyPassword: () => true });
    });
    ui.playSaverScreen([['cat']]);
    assert.equal(ui.saverActive(), true);

    // Press a key to wake the screensaver
    input.write(' ');
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(woken, true, 'onSaverWake called on saver keypress wake');
    assert.equal(ui.saverActive(), false, 'saver closed');
    assert.equal(ui.isLocked(), true, 'screen transitioned to lockscreen');
  } finally {
    ui.destroy();
  }
});



// blessed autofocuses any clickable element that gets clicked, and the
// transcript has to be clickable so previews and links can be opened. Letting
// it keep focus took the keyboard away from the composer, and since typing was
// the thing it broke, there was no way to type /mouse and turn the capture back
// off — the session had to be killed.
test('a click with the mouse captured leaves the keyboard working', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  output.resume();

  const ui = createUI({ selfName: 'Alice', peerLabel: 'Roman', input, output });
  try {
    ui.setMouseCapture(true);
    input.write('abc');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(ui.draft(), 'abc');

    // SGR press and release over the transcript.
    input.write('\x1b[<0;10;5M');
    await new Promise((resolve) => setTimeout(resolve, 50));
    input.write('\x1b[<0;10;5m');
    await new Promise((resolve) => setTimeout(resolve, 80));

    input.write('def');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(ui.draft(), 'abcdef', 'typing must still reach the composer after a click');
  } finally {
    ui.destroy();
  }
});

// /help and /diagnose write straight to the transcript, which is right when a
// person typed them and wrong when the model did: the output is raw material
// for its answer, and showing it too turned one question into a screenful.
test('captured lines are collected instead of painted, and the transcript resumes after', () => {
  const ui = headlessUI();
  try {
    ui.addLine('* before');
    assert.ok(ui.transcript().includes('before'));

    assert.equal(ui.startLineCapture(), true);
    ui.addLine('* help line one');
    ui.addLine('* help line two');
    // A second capture must not strand the first.
    assert.equal(ui.startLineCapture(), false);
    const printed = ui.stopLineCapture();

    assert.deepEqual(printed, ['* help line one', '* help line two']);
    assert.ok(!ui.transcript().includes('help line one'), 'captured output must never reach the transcript');

    ui.addLine('* after');
    assert.ok(ui.transcript().includes('after'), 'painting resumes once the capture is closed');
    assert.deepEqual(ui.stopLineCapture(), [], 'stopping twice is harmless');
  } finally {
    ui.destroy();
  }
});

// `/del` has no message to point at with a mouse, so it works off "the last
// thing I said" — which means the buffer has to be able to name its own recent
// ids and then take those messages out again.
test('the transcript can name its recent messages and remove them', () => {
  const ui = headlessUI();
  try {
    ui.addMessage({ id: 'a', name: 'Alice', text: 'mine one', ts: 1, self: true });
    ui.addMessage({ id: 'b', name: 'Roman', text: 'theirs', ts: 2, self: false });
    ui.addMessage({ id: 'c', name: 'Alice', text: 'mine two', ts: 3, self: true });

    // Newest first, and only one's own words: deleting for everyone is never
    // offered for what somebody else said.
    assert.deepEqual(ui.recentMessageIds({ self: true, limit: 2 }), ['c', 'a']);
    assert.deepEqual(ui.recentMessageIds({ self: true, limit: 1 }), ['c']);
    assert.deepEqual(ui.recentMessageIds({ self: false, limit: 5 }), ['b']);

    assert.equal(ui.removeMessages(['c']), 1);
    assert.ok(!ui.transcript().includes('mine two'));
    assert.ok(ui.transcript().includes('mine one'), 'only the named message goes');
    assert.ok(ui.transcript().includes('theirs'));
  } finally {
    ui.destroy();
  }
});

test('removing messages reports how many were really there', () => {
  const ui = headlessUI();
  try {
    ui.addMessage({ id: 'a', name: 'Alice', text: 'hello', ts: 1, self: true });
    // An id for something this session never saw removes nothing, and the count
    // is what stops the caller announcing a deletion that did not happen.
    assert.equal(ui.removeMessages(['nope']), 0);
    assert.equal(ui.removeMessages([]), 0);
    assert.equal(ui.removeMessages(['a', 'nope']), 1);
    assert.equal(ui.removeMessages(['a']), 0, 'a second delete of the same id is a no-op');
  } finally {
    ui.destroy();
  }
});

test('the scrollbar is grabbed a column short of the bar and tracks the pointer', async () => {
  // One column is a target a pointer misses, and missing it used to start a
  // text selection instead of scrolling.
  const m = mouseUI();
  try {
    for (let n = 0; n < 200; n++) m.ui.addLine(`строка ${n}`);
    const copies = [];
    m.ui.onCopy((text) => copies.push(text));
    await m.pressAt(0, 74);
    const top = m.ui.historyScrollOffset();
    await m.dragAt(4, 74);
    const quarter = m.ui.historyScrollOffset();
    await m.dragAt(9, 74);
    const middle = m.ui.historyScrollOffset();
    await m.releaseAt(9, 74);
    assert.ok(
      quarter > top && middle > quarter,
      `the view follows the hand, not one notch per gesture: ${top} → ${quarter} → ${middle}`,
    );
    assert.deepEqual(copies, [], 'a scrollbar gesture is never a text selection');
    assert.equal(m.ui.selectionRange(), null);
  } finally {
    m.ui.destroy();
  }
});

test('a scrollbar dragged back to the bottom follows the tail again', async () => {
  const m = mouseUI();
  try {
    for (let n = 0; n < 200; n++) m.ui.addLine(`строка ${n}`);
    await m.pressAt(1, 75);
    assert.equal(m.ui.isFollowingTail(), false, 'a grab near the top leaves the tail');
    await m.dragAt(15, 75);
    await m.releaseAt(15, 75);
    assert.equal(m.ui.isFollowingTail(), true, 'the bottom of the track is the tail');
    m.ui.addLine('и следующая строка');
    assert.equal(m.ui.isFollowingTail(), true);
  } finally {
    m.ui.destroy();
  }
});

test('an attachment path is drawn as a link, and cannot smuggle markup into the frame', () => {
  // «отправляемые файлы (фото прежде всего) сделать как ссылки (подчеркнуто),
  // чтобы через cmd+click можно было их открыть»: underlined and in the same
  // blue `renderBodyMarkup` gives a URL, which is what a terminal's own path
  // detection (Warp, iTerm2, Terminal.app) reads out of the text on screen.
  assert.equal(
    fileLinkLine('/Users/me/.tailchat/files/image-1-ab.jpg'),
    '{underline}{39-fg}/Users/me/.tailchat/files/image-1-ab.jpg{/39-fg}{/underline}',
  );
  assert.equal(fileLinkLine('photo.jpg', { themed: false }), 'photo.jpg');
  assert.equal(fileLinkLine(''), '', 'no path, no line');
  assert.equal(fileLinkLine('   '), '');

  // A file name is user data: braces in it must not become blessed tags.
  const smuggled = fileLinkLine('/tmp/{bold}{/bold}oops.jpg');
  assert.ok(!smuggled.includes('{bold}'), 'the brace is escaped, not honoured');
  assert.ok(smuggled.includes('oops.jpg'), 'and the name still reads');
});

test('the attachment link line paints the path itself, not the markup around it', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  output.resume();

  const ui = createUI({ selfName: 'me', peerLabel: 'anna', input, output });
  const screen = blessed.Screen.instances.at(-1);
  try {
    ui.addArt(['', fileLinkLine('/tmp/photo.jpg'), ''], '/tmp/photo.jpg');
    await new Promise((resolve) => setTimeout(resolve, 60));

    const text = screen.lines.map((row) => row.map((cell) => cell[1]).join('')).join('\n');
    assert.match(text, /\/tmp\/photo\.jpg/, 'the path is on screen');
    assert.doesNotMatch(text, /\{underline\}/, 'and its markup is not');
    assert.doesNotMatch(text, /\{39-fg\}/);
  } finally {
    ui.destroy();
  }
});

test('renderRosterBarMarkup formats active and unread contacts', () => {
  const items = [
    { login: 'saved', name: 'Saved' },
    { login: 'anna', name: 'anna', unread: 2 },
    { login: 'boris', name: 'boris' },
  ];
  const themed = renderRosterBarMarkup({ items, activeLogin: 'saved', width: 80, themed: true });
  assert.match(themed, /Saved/, 'includes active contact name');
  assert.match(themed, /anna.*🔔2/, 'includes unread badge with count');
  assert.match(themed, /boris/, 'includes inactive contact');

  const unthemed = renderRosterBarMarkup({ items, activeLogin: 'saved', width: 80, themed: false });
  assert.ok(unthemed.includes('[Saved]*'), 'active contact has unthemed marker');
  assert.ok(unthemed.includes('[anna 🔔2]'), 'unread contact has badge in unthemed');
});

test('the open conversation carries no unread bell in the contact bar', () => {
  const items = [
    { login: 'anna', name: 'anna', unread: 4 },
    { login: 'boris', name: 'boris', unread: 2 },
  ];
  const bar = renderRosterBarMarkup({ items, activeLogin: 'anna', width: 80, themed: false });
  assert.ok(bar.includes('[anna]*'), 'the pill the reader is sitting on is plain');
  assert.ok(bar.includes('[boris 🔔2]'), 'the other contact keeps its count');
  const themed = renderRosterBarMarkup({ items, activeLogin: 'anna', width: 80, themed: true });
  assert.match(themed, /\{green-bg\} anna \{\/green-bg\}/, 'active contact pill is plain');
  assert.doesNotMatch(themed, /\{green-bg\} [^}]*🔔/, 'active contact pill has no bell');
  assert.match(themed, /boris.*🔔2/, 'inactive contact keeps bell');
});

test('renderRosterBarMarkup formats online contacts green and official accounts with the bot palette role', () => {
  const items = [
    { login: 'saved', name: 'Saved', isSaved: true },
    { login: 'tailik', name: 'tailik', official: true },
    { login: 'tailchat', name: 'tailchat', official: true },
    { login: 'anna', name: 'anna', state: 'online' },
    { login: 'boris', name: 'boris', state: 'offline' },
  ];
  const bar = renderRosterBarMarkup({ items, activeLogin: 'boris', width: 120, themed: true });
  // Saved and official accounts use the current theme's bot palette role.
  assert.match(bar, /\{magenta-fg\}\[Saved\]\{\/magenta-fg\}/);
  assert.match(bar, /\{magenta-fg\}\[tailik\]\{\/magenta-fg\}/);
  assert.match(bar, /\{magenta-fg\}\[tailchat\]\{\/magenta-fg\}/);
  // online is green
  assert.match(bar, /\{green-fg\}\[anna\]\{\/green-fg\}/);
  // active boris has background
  assert.match(bar, /\{green-bg\} boris \{\/green-bg\}/);
  // separator is just space, not │ or |
  assert.doesNotMatch(bar, /│/);
  assert.doesNotMatch(bar, / \| /);
});

test('renderRosterBarMarkup supports 1, 2, and 3 rows layout', () => {
  const items = [
    { login: 'anna', name: 'anna' },
    { login: 'boris', name: 'boris', unread: 1 },
    { login: 'charlie', name: 'charlie' },
    { login: 'david', name: 'david' },
    { login: 'elena', name: 'elena' },
    { login: 'fedor', name: 'fedor' },
  ];
  const oneRow = renderRosterBarMarkup({ items, activeLogin: 'anna', width: 40, maxRows: 1, themed: false });
  assert.equal(oneRow.split('\n').length, 1);

  const threeRows = renderRosterBarMarkup({ items, activeLogin: 'anna', width: 40, maxRows: 3, themed: false });
  const lines = threeRows.split('\n');
  assert.ok(lines.length >= 2 && lines.length <= 3, 'chunks pills into multiple lines');
  assert.ok(threeRows.includes('[boris 🔔]'), 'unread is visible');
  assert.ok(threeRows.includes('[anna]*'), 'active contact is plain and marked');
  assert.ok(threeRows.includes('[fedor]'), 'later contacts are also visible in multi-row');
});

test('the roster window follows the cursor, so a switch on a narrow screen is visible', () => {
  // «переключение в ростере иногда идёт без перелистывания; курсор уходит за
  // экран, экран узкий»: the pills wrap into more lines than the bar may show,
  // and the window was pinned to the first line whenever *any* contact had
  // unread — so the selection walked off the bottom and Ctrl+→ changed the
  // conversation with nothing on screen moving to show it.
  const items = Array.from({ length: 12 }, (_, i) => ({
    login: `peer${i}`, name: `peer${i}`, unread: i === 0 ? 1 : 0,
  }));

  for (const maxRows of [1, 3]) {
    const bar = renderRosterBarMarkup({ items, activeLogin: 'peer11', width: 24, maxRows, themed: false });
    assert.ok(bar.includes('[peer11]*'), `rows=${maxRows}: the selected contact is on screen`);
    assert.ok(!bar.includes('[peer0'), `rows=${maxRows}: the window moved off the first contacts`);
  }
});

test('the contact bar is separated from the draft by its own rule, and takes no rows without contacts', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 60;
  output.rows = 20;
  output.resume();

  const ui = createUI({ selfName: 'me', peerLabel: 'anna', input, output });
  const screen = blessed.Screen.instances.at(-1);
  const rowText = (offsetFromBottom) => {
    const y = screen.lines.length - 1 - offsetFromBottom;
    return screen.lines[y].slice(0, 60).map((cell) => cell[1]).join('');
  };
  try {
    ui.addLine('* строка истории');
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Without a roster the row above the draft is the composer's own rule and
    // nothing else moved down.
    assert.match(rowText(1), /❯/, 'the draft sits directly above the frame border');

    ui.setRoster([
      { login: 'anna', name: 'anna' },
      { login: 'boris', name: 'boris' },
    ], 'anna');
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.match(rowText(1), /anna/, 'the pills are the bottom row inside the frame');
    assert.match(rowText(2), /╌╌╌/, 'a rule separates them from the draft');
    assert.match(rowText(3), /❯/, 'the draft moved up by exactly those two rows');

    ui.setRoster([], null);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.match(rowText(1), /❯/, 'an empty roster gives both rows back');
  } finally {
    ui.destroy();
  }
});
// The bar is a control, not decoration: with the mouse captured a click on a
// pill opens that conversation and the wheel over the bar scrolls it. Both are
// resolved against the spans the bar is painted from, so these tests read the
// pointer's target off the painted rows rather than computing it — a test that
// clicks what it drew is a test of the click, not of its own arithmetic.
function rosterMouseUI({ columns = 60, rows = 20 } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = columns;
  output.rows = rows;
  output.resume();

  const ui = createUI({ selfName: 'Alice', peerLabel: 'Roman', input, output, mouse: true });
  const screen = blessed.Screen.instances.at(-1);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const rowText = (y) => screen.lines[y].slice(0, columns).map((cell) => cell[1]).join('');

  // The bar sits at the bottom inside the frame, under its own rule; a taller
  // bar grows upwards from there.
  const barRows = () => {
    const out = [];
    for (let y = rows - 2; y > 0 && !rowText(y).includes('╌'); y--) {
      out.unshift({ y, text: rowText(y) });
    }
    return out;
  };
  // The first cell of a contact's pill: a pill is either `[name]` (the bell
  // rides inside the brackets) or, for the open contact, ` name `.
  const pillCell = (label) => {
    for (const { y, text } of barRows()) {
      let at = text.indexOf(`[${label}`);
      if (at < 0) {
        at = text.indexOf(` ${label} `);
        if (at >= 0) at += 1;
      }
      if (at >= 0) return { y, x: at };
    }
    return null;
  };

  return {
    ui,
    settle,
    barRows,
    pillCell,
    async click({ x, y }) {
      input.write(`\x1b[<0;${x + 1};${y + 1}M`);
      await settle();
      input.write(`\x1b[<0;${x + 1};${y + 1}m`);
      await settle();
    },
    async wheel(down, { x, y }) {
      input.write(`\x1b[<${down ? 65 : 64};${x + 1};${y + 1}M`);
      await settle();
    },
  };
}

test('a click on a contact pill opens that conversation, and a click between pills opens nothing', async () => {
  const bar = rosterMouseUI();
  try {
    const opened = [];
    bar.ui.onRosterSelect((login) => opened.push(login));
    bar.ui.setRoster([
      { login: 'anna', name: 'anna' },
      { login: 'boris', name: 'boris' },
      { login: 'charlie', name: 'charlie' },
    ], 'anna');
    await bar.settle();

    // The pill the reader is already on is where the click would take them:
    // switching again would be a pointless relaunch of the same conversation.
    await bar.click(bar.pillCell('anna'));
    assert.deepEqual(opened, [], 'clicking the open contact switches nothing');

    await bar.click(bar.pillCell('boris'));
    assert.deepEqual(opened, ['boris'], 'the click opens the contact under the pointer');
    assert.ok(
      bar.barRows().some(({ text }) => text.includes(' boris ')),
      'and the bar shows that contact as the open one',
    );

    // The cells between two pills belong to neither of them: a click there is a
    // miss, not a guess at the nearest neighbour.
    await bar.click({ x: bar.pillCell('charlie').x - 1, y: bar.pillCell('charlie').y });
    assert.deepEqual(opened, ['boris']);
  } finally {
    bar.ui.destroy();
  }
});

test('the wheel over the contact bar scrolls the bar, not the transcript', async () => {
  const bar = rosterMouseUI();
  try {
    bar.ui.setRoster(
      Array.from({ length: 30 }, (_, i) => ({ login: `peer${i}`, name: `peer${i}` })),
      'peer0',
    );
    for (let n = 0; n < 60; n++) bar.ui.addLine(`строка ${n}`);
    await bar.settle();

    const before = bar.barRows();
    assert.equal(before.length, 2, 'the narrow bar is capped at two rows');
    assert.ok(before.some(({ text }) => text.includes('peer0')), 'the open contact is on screen');
    assert.ok(!before.some(({ text }) => text.includes('peer29')), 'and the roster does not fit');
    const offset = bar.ui.historyScrollOffset();

    const bottom = before[before.length - 1];
    await bar.wheel(true, { x: 30, y: bottom.y });
    const after = bar.barRows();
    assert.ok(!after[0].text.includes('peer0'), 'the window moved off the first contact');
    assert.ok(after[0].text.includes('‹'), 'and says there is more above');
    assert.equal(bar.ui.historyScrollOffset(), offset, 'the transcript stayed where it was');

    // One notch back is exactly where it started: a notch moves the window a
    // row, and a trackpad sends a burst of them per gesture.
    await bar.wheel(false, { x: 30, y: bottom.y });
    assert.deepEqual(bar.barRows().map(({ text }) => text), before.map(({ text }) => text));
  } finally {
    bar.ui.destroy();
  }
});

test('a one-row bar scrolls sideways with the wheel', async () => {
  const bar = rosterMouseUI();
  try {
    bar.ui.setRosterRows(1);
    bar.ui.setRoster(
      Array.from({ length: 12 }, (_, i) => ({ login: `peer${i}`, name: `peer${i}` })),
      'peer0',
    );
    await bar.settle();

    const before = bar.barRows();
    assert.equal(before.length, 1, 'one configured row, one painted row');
    assert.ok(before[0].text.includes('peer0'), 'the open contact is on screen');
    assert.ok(before[0].text.includes('›'), 'and the row says the roster continues');

    await bar.wheel(true, { x: 30, y: before[0].y });
    const after = bar.barRows();
    assert.ok(!after[0].text.includes('peer0'), 'the row scrolled past the first contact');
    assert.ok(after[0].text.includes('‹'), 'and says there is more before it');
    assert.ok(after[0].text.includes('peer1'), 'the next contacts are the ones shown');
  } finally {
    bar.ui.destroy();
  }
});

test('ui.setRoster and Ctrl/Cmd+arrow contact switching', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  output.resume();

  const ui = createUI({ selfName: 'me', peerLabel: 'anna', input, output });
  try {
    const switched = [];
    ui.onRosterSelect((login) => switched.push(login));
    ui.setRoster([
      { login: 'saved', name: 'Saved' },
      { login: 'anna', name: 'anna' },
      { login: 'boris', name: 'boris' },
    ], 'anna');

    // Press Ctrl+Right (\x1b[1;5C): should switch from anna to boris
    input.write('\x1b[1;5C');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(switched[switched.length - 1], 'boris');

    // Press Cmd+Right (\x1b[1;9C or \x1b[1;3C): should wrap around from boris to saved
    input.write(process.platform === 'darwin' ? '\x1b[1;9C' : '\x1b[1;5C');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(switched[switched.length - 1], 'saved');

    // Press Cmd+Left (\x1b[1;9D or \x1b[1;5D): should wrap back to boris
    input.write(process.platform === 'darwin' ? '\x1b[1;9D' : '\x1b[1;5D');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(switched[switched.length - 1], 'boris');
  } finally {
    ui.destroy();
  }
});

test('ui.setRoster and Opt+Tab / Ctrl+Tab contact switching', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  output.resume();

  const ui = createUI({ selfName: 'me', peerLabel: 'anna', input, output });
  try {
    assert.equal(ui.rosterRows(), 3);
    ui.setRosterRows(2);
    assert.equal(ui.rosterRows(), 2);
    ui.setRosterRows(1);
    assert.equal(ui.rosterRows(), 1);

    const switched = [];
    ui.onRosterSelect((login) => switched.push(login));
    ui.setRoster([
      { login: 'saved', name: 'Saved' },
      { login: 'anna', name: 'anna' },
      { login: 'boris', name: 'boris' },
    ], 'anna');

    // 1. Press Opt+Tab via standard ESC+TAB (\x1b\t): should switch from anna to boris
    input.write('\x1b\t');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(switched[switched.length - 1], 'boris');
    assert.equal(switched.length, 1);

    // 2. Press Opt+Tab via kitty sequence (\x1b[9;3u): should wrap to saved
    input.write('\x1b[9;3u');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(switched[switched.length - 1], 'saved');
    assert.equal(switched.length, 2);

    // 3. Press Opt+Tab via xterm sequence (\x1b[27;3;9~): should switch to anna
    input.write('\x1b[27;3;9~');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(switched[switched.length - 1], 'anna');
    assert.equal(switched.length, 3);

    // 4. Press Shift+Opt+Tab via ESC+backtab (\x1b\x1b[Z): should switch back to saved
    input.write('\x1b\x1b[Z');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(switched[switched.length - 1], 'saved');
    assert.equal(switched.length, 4);

    // 5. Press Shift+Opt+Tab via kitty sequence (\x1b[9;4u): should switch back to boris
    input.write('\x1b[9;4u');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(switched[switched.length - 1], 'boris');
    assert.equal(switched.length, 5);

    // 6. Plain Tab (\t) with empty draft: switches to saved
    input.write('\t');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(switched[switched.length - 1], 'saved');
    assert.equal(switched.length, 6);

    // 7. Plain Shift+Tab (\x1b[Z): switches back to boris
    input.write('\x1b[Z');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(switched[switched.length - 1], 'boris');
    assert.equal(switched.length, 7);
    // 8. Ctrl+Tab (\x1b[1;5I) also switches contacts to saved
    input.write('\x1b[1;5I');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(switched[switched.length - 1], 'saved');
    assert.equal(switched.length, 8);

    // 9. When draft has a matching command like /h, Tab completes the command and does NOT switch contacts
    ui.setCommands([{ name: '/help', alias: '/h' }]);
    input.write('/h');
    await new Promise((r) => setTimeout(r, 80));
    input.write('\t');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(switched.length, 8, 'tab on command completion must not switch contacts');
  } finally {
    ui.destroy();
  }
});
