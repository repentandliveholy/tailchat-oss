import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function extractFunction(source, name) {
  const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `${name} exists in web/cloud/app.js`);
  return match[0];
}

function extractConst(source, name) {
  const match = source.match(new RegExp(`^const ${name} = '[^']*';$`, 'm'));
  assert.ok(match, `${name} exists in web/cloud/app.js`);
  return match[0];
}

/** A thread node with just enough of the DOM for `botActionsFor`'s one
 *  question: does this conversation hold a message? */
function fakeThread(peer, { loaded = true, rows = [] } = {}) {
  return { peer, loaded, node: { rows, querySelector: (selector) => (selector === '.row' ? rows[0] ?? null : null) } };
}

function loadActions({ activePeer = 'reminder', threads = new Map() } = {}) {
  const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
  const constants = source.match(/const BOT_ACTION_LIMIT[\s\S]*?const BOT_ACTION_VALUE_MAX = 200;/);
  assert.ok(constants, 'bot action bounds exist');
  const sent = [];
  const bar = {
    hidden: true,
    children: [],
    replaceChildren() { this.children = []; },
    append(node) { this.children.push(node); },
  };
  const context = {
    activePeer,
    botActionsByPeer: new Map(),
    threads,
    elements: { botActions: bar },
    isBlockedPeer: () => false,
    // The real one appends the row before it returns, which is what makes a
    // seeded menu leave the bar the moment its own button is pressed.
    sendPlainMessage(value) {
      sent.push(value);
      threads.get(activePeer)?.node.rows.push({ text: value });
    },
    t: (key) => key,
    document: {
      createElement() {
        return {
          dataset: {},
          disabled: false,
          listeners: {},
          addEventListener(type, fn) { this.listeners[type] = fn; },
          click() { this.listeners.click(); },
        };
      },
    },
  };
  vm.createContext(context);
  vm.runInContext([
    extractConst(source, 'OFFICIAL_ACCOUNT_LOGIN'),
    constants[0],
    extractFunction(source, 'normalizeBotActions'),
    extractFunction(source, 'botActionsFor'),
    extractFunction(source, 'renderBotActions'),
    extractFunction(source, 'applyBotActions'),
    'globalThis.applyBotActions = applyBotActions;',
    'globalThis.renderBotActions = renderBotActions;',
  ].join('\n'), context);
  // Every path into a conversation ends in this call (`selectPeer`, the roster
  // render, a loaded history), so the harness starts from the painted state.
  context.renderBotActions();
  return { context, bar, sent };
}

test('bot actions render above the draft and send their transport-neutral value', () => {
  const { context, bar, sent } = loadActions();
  context.applyBotActions('reminder', [
    { id: 'done', label: '✅ Готово', value: 'готово' },
    { id: '', label: 'invalid', value: 'ignored' },
  ]);
  assert.equal(bar.hidden, false);
  assert.equal(bar.children.length, 1);
  assert.equal(bar.children[0].textContent, '✅ Готово');
  assert.equal(bar.children[0].dataset.actionId, 'done');

  bar.children[0].click();
  assert.deepEqual(sent, ['готово']);
  assert.equal(bar.hidden, true, 'stale actions disappear until the bot answers');
  assert.equal(bar.children.length, 0);
});

test('actions from another conversation wait until that peer is active', () => {
  const { context, bar } = loadActions();
  context.applyBotActions('other', [{ id: 'list', label: 'Список', value: 'список' }]);
  assert.equal(bar.hidden, true);
  assert.equal(bar.children.length, 0);
});

test('an empty {tailchat} thread offers the menu, and pressing it asks for it', () => {
  const threads = new Map([['tailchat', fakeThread('tailchat')]]);
  const { bar, sent } = loadActions({ activePeer: 'tailchat', threads });

  // Nothing has ever been said in this thread: the one conversation in this
  // client that can open blank, because the account never speaks first and a
  // cleared history is empty again.
  assert.equal(bar.hidden, false);
  assert.equal(bar.children.length, 1);
  assert.equal(bar.children[0].textContent, 'botMenu');
  assert.equal(bar.children[0].dataset.actionId, 'service-menu');

  // `/help` as a bot value, not as a typed command: the same road every other
  // button on this bar takes (`sendPlainMessage`, which skips the local
  // command parser).
  bar.children[0].click();
  assert.deepEqual(sent, ['/help']);
  assert.equal(bar.hidden, true, 'the menu leaves with the message it put on screen');
});

test('the menu is only ever the service account\'s, and only while the thread is empty', () => {
  // Somebody else's empty conversation.
  const other = new Map([['olga', fakeThread('olga')]]);
  assert.equal(loadActions({ activePeer: 'olga', threads: other }).bar.children.length, 0);

  // The service account, with a message in the thread: the account's own menu
  // message is the way in there, and a second button would only be a second
  // answer to the same question.
  const withMessages = new Map([['tailchat', fakeThread('tailchat', { rows: [{ text: 'привет' }] })]]);
  assert.equal(loadActions({ activePeer: 'tailchat', threads: withMessages }).bar.children.length, 0);

  // Still on its way — an empty node here means "we do not know yet", and a
  // button that appears and then vanishes under the reader is worse than none.
  const loading = new Map([['tailchat', fakeThread('tailchat', { loaded: false })]]);
  assert.equal(loadActions({ activePeer: 'tailchat', threads: loading }).bar.children.length, 0);
});

test('what the server said the bot offers wins over the seeded menu', () => {
  const threads = new Map([['tailchat', fakeThread('tailchat')]]);
  const { context, bar } = loadActions({ activePeer: 'tailchat', threads });

  context.applyBotActions('tailchat', [{ id: 'help', label: 'Помощь', value: '/help' }]);

  assert.equal(bar.children.length, 1);
  assert.equal(bar.children[0].dataset.actionId, 'help');
});
