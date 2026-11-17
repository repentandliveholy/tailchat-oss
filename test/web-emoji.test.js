import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
const dataSource = fs.readFileSync(new URL('../web/cloud/emoji-data.js', import.meta.url), 'utf8');
function loadEmojiHelpers() {
  const storage = new Map();
  const context = {
    Node: { TEXT_NODE: 3 },
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    renderQuickReactionSettings() {},
    document: {
      createElement(tag) {
        return {
          tag, nodeType: 1, children: [], handlers: {},
          append(...children) { this.children.push(...children); },
          addEventListener(name, handler) { this.handlers[name] = handler; },
          matches(selector) { return selector === 'img.emoji' && this.tag === 'img' && this.className === 'emoji'; },
          replaceWith(text) { this.replacement = text; },
        };
      },
      createTreeWalker(element) {
        const nodes = element.children.map(child => typeof child === 'string' ? { nodeType: 3, data: child } : child);
        let index = 0;
        return { nextNode: () => nodes[index++] ?? null };
      },
    },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  };
  const constants = ['EMOJI_RE', 'EMOJI_TONE_RE', 'EMOJI_SEGMENTER', 'EMOJI_IMAGE_BASE', 'JUMBO_EMOJI_MAX', 'DEFAULT_QUICK_REACTIONS', 'EMOJI_SELECTION_EXCLUDED_POINTS', 'QUICK_REACTIONS_KEY', 'EMOJI_RECENT_KEY', 'EMOJI_RECENT_MAX'];
  const functions = ['emojiImageName', 'emojiRenderGlyph', 'emojiImage', 'appendEmojiText', 'emojiPlainText', 'isJumboEmoji', 'isReactionEmoji', 'isEmojiChoiceAllowed', 'quickReactions', 'setQuickReaction', 'recentEmoji', 'rememberEmoji', 'emojiSearchTerms'];
  const definitions = constants.map(name => {
    const found = source.match(new RegExp(`^const ${name} = .+;$`, 'm'));
    assert.ok(found, name);
    return found[0];
  });
  for (const name of functions) {
    const found = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(found, name);
    definitions.push(found[0]);
  }
  vm.createContext(context);
  vm.runInContext(`${definitions.join('\n')}\n${dataSource}\nthis.api = { ${functions.join(',')}, EMOJI_RE };`, context);
  return { api: context.api, table: context.TAILCHAT_EMOJI, storage, document: context.document };
}

test('every Apple asset has one fully-qualified glyph and matching picker metadata', () => {
  const { api, table } = loadEmojiHelpers();
  const dir = new URL('../web/cloud/emoji/apple/64/', import.meta.url);
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1903);
  let bytes = 0;
  for (const file of files) {
    const glyph = String.fromCodePoint(...file.slice(0, -4).split('-').map(hex => parseInt(hex, 16)));
    const matches = [...glyph.matchAll(api.EMOJI_RE)];
    assert.equal(matches.length, 1, file);
    assert.equal(matches[0][0], glyph, file);
    assert.equal(api.emojiRenderGlyph(glyph), glyph, `${file}: full grapheme lookup`);
    assert.equal(`${api.emojiImageName(glyph)}.png`, file);
    assert.doesNotMatch(glyph, /\p{Emoji_Modifier}/u);
    bytes += fs.statSync(new URL(file, dir)).size;
  }
  assert.equal(bytes, 9534133);
  assert.ok(bytes <= 10_000_000);
  const entries = table.flatMap(([, list]) => list);
  assert.equal(entries.length, files.length);
  for (const [glyph, words, image, sort, names] of entries) {
    assert.equal(image, `${api.emojiImageName(glyph)}.png`);
    assert.equal(typeof sort, 'number');
    assert.ok(names.length > 0);
    assert.ok(words.length > 0);
  }
  const thumb = entries.find(([glyph]) => glyph === '👍');
  assert.match(thumb[1], /thumbs/);
  assert.match(thumb[1], /палец/);
  assert.match(entries.find(([glyph]) => glyph === '🇷🇺')[1], /россия/);
});

test('jumbo is exactly one to three emoji, including joined glyphs', () => {
  const { api } = loadEmojiHelpers();
  for (const text of ['👍', ' ❤️ 🔥 ', '👨‍👩‍👧‍👦🇷🇺1️⃣']) assert.equal(api.isJumboEmoji(text), true, text);
  for (const text of ['', 'hello 👍', '👍👍👍👍', 'plain']) assert.equal(api.isJumboEmoji(text), false, text);
});

test('rendering and plain-text copy preserve entire unqualified ZWJ and toned graphemes', () => {
  const { api, document } = loadEmojiHelpers();
  for (const glyph of ['🏳‍🌈', '❤‍🔥', '👍🏽', '👨‍👩‍👧']) {
    const container = document.createElement('span');
    api.appendEmojiText(container, glyph);
    assert.equal(container.children.length, 1, `${glyph}: no partial replacement`);
    const rendered = container.children[0];
    assert.equal(api.emojiPlainText(container), glyph, `${glyph}: copy retains original Unicode`);
    if (typeof rendered === 'string') {
      assert.equal(rendered, glyph);
    } else {
      assert.equal(rendered.alt, glyph);
      const filename = rendered.src.split('/').pop();
      assert.ok(fs.existsSync(new URL(`../web/cloud/emoji/apple/64/${filename}`, import.meta.url)), glyph);
      rendered.handlers.error();
      assert.equal(rendered.replacement, glyph, `${glyph}: failure restores the whole glyph`);
    }
    if (glyph === '👍🏽') assert.equal(typeof rendered, 'string');
  }
  for (const glyph of ['🏳‍🦄', '👍🏽‍🔥', '😀\u0301']) {
    const container = document.createElement('span');
    api.appendEmojiText(container, glyph);
    assert.equal(container.children.length, 1, glyph);
    assert.equal(api.emojiPlainText(container), glyph);
  }
});

test('picker Enter selects from search/grid but preserves native category-tab activation', () => {
  const handlerSource = source.match(/picker\.addEventListener\('keydown', \(event\) => \{[\s\S]*?\n  \}\);/);
  assert.ok(handlerSource);
  let handler;
  let picked = null;
  const search = { value: '', closest: () => null };
  const context = {
    picker: { addEventListener: (_name, callback) => { handler = callback; } },
    state: { active: { dataset: { emoji: '👍' } } },
    search,
    pick: glyph => { picked = glyph; },
  };
  vm.createContext(context);
  vm.runInContext(handlerSource[0], context);
  let prevented = false;
  const event = target => ({ key: 'Enter', target, preventDefault() { prevented = true; } });
  handler(event({ closest: () => null }));
  assert.equal(picked, null);
  assert.equal(prevented, false);
  handler(event(search));
  assert.equal(picked, '👍');
  assert.equal(prevented, true);
  picked = null;
  handler(event({ closest: selector => selector === '.emoji-picker-grid' ? {} : null }));
  assert.equal(picked, '👍');
});

test('expanded quick reactions preserve original custom slots and persist slot swaps', () => {
  const { api, storage } = loadEmojiHelpers();
  const required = ['🤝', '👌', '🆗', '👍', '👎', '❤️', '🙏'];
  for (const emoji of required) assert.ok(api.quickReactions().includes(emoji), emoji);
  const custom = ['😀', '👎', '👌', '❤️', '🙏', '🔥'];
  storage.set('tailchat-cloud-quick-reactions', JSON.stringify(custom));
  const expanded = Array.from(api.quickReactions());
  assert.deepEqual(expanded.slice(0, custom.length), custom);
  for (const emoji of required) assert.ok(expanded.includes(emoji), emoji);
  assert.equal(new Set(expanded).size, expanded.length);
  expanded[expanded.length - 1] = '🐱';
  storage.set('tailchat-cloud-quick-reactions', JSON.stringify(expanded));
  assert.deepEqual(Array.from(api.quickReactions()), expanded);
  const handshakeSlot = expanded.indexOf('🤝');
  api.setQuickReaction(0, '🤝');
  const swapped = JSON.parse(storage.get('tailchat-cloud-quick-reactions'));
  assert.equal(swapped[0], '🤝');
  assert.equal(swapped[handshakeSlot], '😀');
  assert.equal(swapped.at(-1), '🐱');
  assert.deepEqual(Array.from(api.quickReactions()), swapped);
  for (const value of ['bad-json', '[]', JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f'])]) {
    storage.set('tailchat-cloud-quick-reactions', value);
    for (const emoji of required) assert.ok(api.quickReactions().includes(emoji), `${value}: ${emoji}`);
  }
});

test('emoji recents are shared and capped at 24', () => {
  const { api } = loadEmojiHelpers();
  for (let i = 0; i < 30; i += 1) api.rememberEmoji(String.fromCodePoint(0x1f600 + i));
  assert.equal(api.recentEmoji().length, 24);
  api.rememberEmoji('👍');
  api.rememberEmoji('👍');
  assert.equal(api.recentEmoji()[0], '👍');
  assert.equal(api.recentEmoji().filter(glyph => glyph === '👍').length, 1);
  assert.deepEqual(Array.from(api.emojiSearchTerms(' ЁЖ  THUMBS ')), ['еж', 'thumbs']);
});

test('selection exclusions cover composed variants without censoring message rendering', () => {
  const { api, document } = loadEmojiHelpers();
  for (const emoji of ['🎃', '🖕', '🤬', '💩', '😈', '👻', '🧙‍♀️', '🧛‍♂️', '🧟', '🔮', '🧹', '🥠', '🔯', '♈', '⚧', '⚧️', '🏳️‍⚧️', '🏳‍⚧', '🏳️‍🌈', '🏳‍🌈']) {
    assert.equal(api.isEmojiChoiceAllowed(emoji), false, emoji);
    const rendered = document.createElement('span');
    api.appendEmojiText(rendered, emoji);
    assert.equal(api.emojiPlainText(rendered), emoji, `${emoji}: original message preserved`);
  }
  for (const emoji of ['🌈', '🍆', '🍑', '💦', '🤝', '🙏', '❤️', '😇', '👽', '🤡', '📿']) {
    assert.equal(api.isEmojiChoiceAllowed(emoji), true, emoji);
  }
});

test('excluded saved choices are replaced in place and never reenter recents', () => {
  const { api, storage } = loadEmojiHelpers();
  const original = ['😀', '🎃', '🌈', '🏳️‍🌈', '🙏', '🍆'];
  storage.set('tailchat-cloud-quick-reactions', JSON.stringify(original));
  const choices = Array.from(api.quickReactions());
  for (const slot of [0, 2, 4, 5]) assert.equal(choices[slot], original[slot]);
  assert.ok(choices.every(api.isEmojiChoiceAllowed));
  assert.equal(new Set(choices).size, choices.length);
  const storedBefore = storage.get('tailchat-cloud-quick-reactions');
  api.setQuickReaction(0, '🎃');
  assert.equal(storage.get('tailchat-cloud-quick-reactions'), storedBefore);
  storage.set('tailchat-cloud-emoji-recent', JSON.stringify(['🎃', '😀', '🏳️‍⚧️', '🌈', '🖕', '🙏']));
  assert.deepEqual(Array.from(api.recentEmoji()), ['😀', '🌈', '🙏']);
  api.rememberEmoji('🏳️‍🌈');
  assert.deepEqual(Array.from(api.recentEmoji()), ['😀', '🌈', '🙏']);
});

test('emoji PNGs enter a separate runtime cache on first display, not installation', async () => {
  const workerSource = fs.readFileSync(new URL('../web/cloud/sw.js', import.meta.url), 'utf8');
  const handlers = new Map();
  const saved = new Map();
  const opened = [];
  let downloads = 0;
  const response = { status: 200, type: 'basic', clone() { return this; } };
  const context = {
    URL,
    self: { addEventListener: (name, handler) => handlers.set(name, handler) },
    caches: {
      async open(name) {
        opened.push(name);
        return {
          match: async key => saved.get(typeof key === 'string' ? key : key.url),
          put: async (key, value) => { saved.set(typeof key === 'string' ? key : key.url, value); },
        };
      },
    },
    fetch: async () => { downloads += 1; return response; },
  };
  vm.createContext(context);
  vm.runInContext(workerSource, context);
  const request = { method: 'GET', url: 'https://example.org/tailchat/emoji/apple/64/1f44d.png' };
  const show = async () => {
    let result;
    handlers.get('fetch')({ request, respondWith: promise => { result = promise; } });
    assert.equal(await result, response);
  };
  assert.equal(downloads, 0);
  await show();
  await show();
  request.url += '?x=1';
  await show();
  request.url = request.url.replace('x=1', 'x=2');
  await show();
  assert.equal(downloads, 1);
  assert.equal(saved.size, 1);
  assert.equal(saved.keys().next().value, 'https://example.org/tailchat/emoji/apple/64/1f44d.png');
  assert.ok(opened.every(name => name === 'tailchat-emoji-apple-64'));
  const shell = workerSource.match(/const SHELL_ASSETS = \[([\s\S]*?)\];/)[1];
  assert.doesNotMatch(shell, /emoji\/apple/);
});

test('reaction hover survives stationary layout events and closes only after the pointer leaves', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rowTarget = {};
  const panelTarget = {};
  let removed = false;
  const state = {
    x: 100, y: 100, leaveTimer: null,
    row: { contains: target => target === rowTarget },
    panel: {
      contains: target => target === panelTarget,
      remove() { removed = true; },
    },
    observer: { disconnect() {} },
  };
  const context = {
    hoverQuickReactions: state,
    quickReactionHoverTimer: null,
    setTimeout, clearTimeout,
    document: { removeEventListener() {} },
    window: { removeEventListener() {} },
  };
  vm.createContext(context);
  for (const name of ['cancelQuickReactionHover', 'hideQuickReactions', 'trackQuickReactions', 'dismissQuickReactions', 'placeQuickReactions']) {
    vm.runInContext(source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0], context);
  }
  const move = (target, x, y) => context.trackQuickReactions({ target, clientX: x, clientY: y });
  // A layout shift changes the element under a stationary cursor.
  move({}, 100, 100);
  t.mock.timers.tick(1000);
  assert.equal(removed, false);
  // Crossing the gap is allowed; entering the panel cancels dismissal.
  move({}, 101, 100);
  t.mock.timers.tick(100);
  move(panelTarget, 102, 100);
  t.mock.timers.tick(1000);
  assert.equal(removed, false);
  // Leaving for the row is also safe, but leaving both surfaces is not.
  move(rowTarget, 103, 100);
  t.mock.timers.tick(1000);
  assert.equal(removed, false);
  move({}, 104, 100);
  t.mock.timers.tick(200);
  assert.equal(removed, true);
  assert.equal(context.hoverQuickReactions, null);
});

test('quick reaction hover waits before showing and cancels brief visits or a closed surface', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shown = [];
  const context = {
    quickReactionHoverTimer: null, hoverQuickReactions: null,
    setTimeout, clearTimeout,
    showQuickReactions: row => shown.push(row),
  };
  vm.createContext(context);
  for (const name of ['cancelQuickReactionHover', 'scheduleQuickReactions', 'hideQuickReactions']) {
    vm.runInContext(source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0], context);
  }
  const mouse = { pointerType: 'mouse' };
  context.scheduleQuickReactions('brief', mouse);
  t.mock.timers.tick(499);
  assert.deepEqual(shown, []);
  context.cancelQuickReactionHover();
  t.mock.timers.tick(500);
  assert.deepEqual(shown, []);
  context.scheduleQuickReactions('old', mouse);
  t.mock.timers.tick(100);
  context.scheduleQuickReactions('current', mouse);
  t.mock.timers.tick(499);
  assert.deepEqual(shown, []);
  t.mock.timers.tick(1);
  assert.deepEqual(shown, ['current']);
  context.scheduleQuickReactions('closed', mouse);
  context.hideQuickReactions();
  t.mock.timers.tick(500);
  assert.deepEqual(shown, ['current']);
});
