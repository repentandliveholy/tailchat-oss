import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');

// A message is not sent because the socket took the frame.
//
// `sendFrame` answers `false` whenever this session is subscribed to another
// conversation — the ordinary state of a tab switched a moment ago — and `true`
// whenever the write merely reached the socket: the socket can die before the
// server answers, and the hub can drop the frame over its frame budget. The
// submit path used to render the message, ignore that answer and clear the
// composer, so the message existed on one screen only: the sender saw
// «отправлено» and the text was gone from the draft with nothing left to retry
// from.
//
// What is pinned here is the queue's own contract — written before the first
// attempt, removed only by proof (`message-accepted`, or a history page, or the
// peer's own receipt), retried under the *same* id, and restored from storage
// after a reload — because every one of those is a way for a message to be lost
// that no amount of socket-level care covers.
function functionSource(name) {
  const functionStart = appSource.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `${name} exists in web/cloud/app.js`);
  const start = appSource.slice(Math.max(0, functionStart - 6), functionStart) === 'async '
    ? functionStart - 6
    : functionStart;
  let parameterDepth = 0;
  let body = -1;
  for (let i = appSource.indexOf('(', functionStart); i < appSource.length; i += 1) {
    if (appSource[i] === '(') parameterDepth += 1;
    else if (appSource[i] === ')' && --parameterDepth === 0) {
      body = appSource.indexOf('{', i);
      break;
    }
  }
  assert.notEqual(body, -1, `${name} has a function body`);
  let depth = 0;
  for (let i = body; i < appSource.length; i += 1) {
    if (appSource[i] === '{') depth += 1;
    else if (appSource[i] === '}' && --depth === 0) return appSource.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

// Module-scope state the extracted functions read and write. It has to come
// from app.js rather than be invented here: a constant that has drifted (the
// storage key, the retry period) is exactly what a test should notice.
function bindingSource(name) {
  const match = new RegExp(`^(?:const|let) ${name} = .*$`, 'm').exec(appSource);
  assert.ok(match, `${name} is declared at module scope in web/cloud/app.js`);
  return match[0];
}

const FUNCTIONS = [
  'pendingStoreKey', 'loadPendingSends', 'savePendingSends', 'pendingFor',
  'rememberPendingSend', 'forgetPendingSend', 'failPendingSend', 'flushPendingSends',
  'schedulePendingRetry', 'ensurePendingRows', 'acceptPendingSend', 'sendMessageFrame',
  'setMark', 'markCommitted', 'settleCommittedMark',
];
const BINDINGS = [
  'PENDING_SENDS_KEY', 'PENDING_RETRY_MS', 'PENDING_LIMIT',
  'pendingSends', 'pendingLoaded', 'pendingTimer', 'serverCaps',
  'threads', 'authed', 'socket', 'self', 'users',
  // The core is off here (`null`): this is the page's own queue.
  'coreSession',
];

function loadQueue({ caps = ['durable-ack', 'addressed-send'], subscribed = null } = {}) {
  const stored = new Map();
  const envelopes = [];
  const frames = [];
  const appended = [];
  const timers = [];
  const context = {
    localStorage: {
      getItem: (key) => (stored.has(key) ? stored.get(key) : null),
      setItem: (key, value) => { stored.set(key, String(value)); },
      removeItem: (key) => { stored.delete(key); },
    },
    WebSocket: { OPEN: 1 },
    errorText: (code) => code,
    scheduleRosterRender: () => {},
    appendMessage: (thread, row) => { appended.push(row); if (row.id) thread.marks.set(row.id, makeMark()); },
    sendFrame: (to, frame) => { frames.push({ to, frame }); return subscribed === to; },
    sendEnvelope: (payload) => { envelopes.push(payload); return true; },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
  };
  vm.createContext(context);
  vm.runInContext([
    ...BINDINGS.map(bindingSource),
    `serverCaps = new Set(${JSON.stringify(caps)});`,
    'self = { login: \'olga\', name: \'Olga\' };',
    'users = [{ login: \'roman\' }, { login: \'anna\' }];',
    "socket = { readyState: 1 };",
    'authed = true;',
    ...FUNCTIONS.map((name) => functionSource(name)),
    ...FUNCTIONS.map((name) => `globalThis.${name} = ${name};`),
  ].join('\n'), context);

  const run = (code) => vm.runInContext(code, context);
  const read = (expression) => JSON.parse(run(`JSON.stringify(${expression})`));
  return {
    context,
    stored,
    envelopes,
    frames,
    appended,
    timers,
    run,
    read,
    setPending: (peer, entries) => run(`pendingSends.set(${JSON.stringify(peer)}, ${JSON.stringify(entries)})`),
    getPending: (peer) => read(`pendingSends.get(${JSON.stringify(peer)}) || []`),
    threadFor: (peer) => {
      run(`if (!threads.has(${JSON.stringify(peer)})) ` +
        `threads.set(${JSON.stringify(peer)}, { peer: ${JSON.stringify(peer)}, marks: new Map() })`);
      return run(`threads.get(${JSON.stringify(peer)})`);
    },
    markFor: (peer, id) => run(`threads.get(${JSON.stringify(peer)}).marks.get(${JSON.stringify(id)})`),
  };
}

// Payloads built inside the `vm` context carry that realm's prototypes, and
// `deepStrictEqual` compares those too — so anything compared structurally goes
// through the host realm first.
const plain = (value) => JSON.parse(JSON.stringify(value));

function makeMark(state = 'queued') {
  return { dataset: { state, ts: '1000' }, textContent: '', title: '' };
}

test('a send that cannot be routed yet is kept and goes out under the same id', () => {
  const queue = loadQueue();
  const entry = { id: 'm-1', ts: 1000, text: 'привет', replyTo: null };
  queue.setPending('roman', [entry]);

  queue.context.flushPendingSends();

  assert.equal(queue.envelopes.length, 1, 'the queue falls back to an addressed frame');
  assert.deepEqual(plain(queue.envelopes[0]), {
    k: 'frame',
    to: 'roman',
    d: { t: 'msg', id: 'm-1', ts: 1000, text: 'привет' },
  });
  assert.deepEqual(queue.getPending('roman'), [entry], 'nothing is proven yet, so nothing leaves the queue');

  // The retry repeats the id rather than minting a new one: that is what makes
  // the server answer a repeat of a message it already holds with the receipt
  // the first attempt missed (`findHistoryMessage` in hub.js), instead of
  // storing a second copy.
  queue.envelopes.length = 0;
  queue.context.flushPendingSends();
  assert.equal(queue.envelopes[0].d.id, 'm-1');
});

test('a message addressed to a peer this tab is not watching is refused on a server without the capability', () => {
  const queue = loadQueue({ caps: ['durable-ack'] });
  queue.setPending('roman', [{ id: 'm-2', ts: 1000, text: 'hi', replyTo: null }]);

  queue.context.flushPendingSends();

  assert.deepEqual(queue.envelopes, [], 'no frame the server would answer with not_subscribed');
  assert.equal(queue.getPending('roman').length, 1, 'and it is still owed');
  assert.equal(queue.timers.length, 1, 'the retry is scheduled rather than lost');
});

test('the server\'s acceptance ends the queue and moves the row onto the server\'s clock', () => {
  const queue = loadQueue();
  queue.setPending('roman', [{ id: 'm-3', ts: 1000, text: 'hi', replyTo: null }]);
  const thread = queue.threadFor('roman');
  run(queue, `threads.get('roman').marks.set('m-3', { dataset: { state: 'queued', ts: '1000' }, textContent: '' })`);

  queue.context.acceptPendingSend('roman', 'm-3', 4242);

  assert.deepEqual(queue.getPending('roman'), []);
  assert.equal(
    thread.marks.get('m-3').dataset.state,
    'sent',
    'accepted is one tick — the server has it, which is not the peer’s device having it',
  );
  assert.equal(thread.marks.get('m-3').textContent, '✓');
  assert.equal(
    thread.marks.get('m-3').dataset.ts,
    '4242',
    'the peer\'s read watermark is measured against the stored time, so the row has to carry the server\'s',
  );
});

// The other half of «watermarks skip ⧗»: the peer may already be past a row
// whose acceptance arrives late (its first reply was lost and the retry was a
// duplicate). Committed, it takes the watermark it was too early for.
test('an acceptance below the thread\'s watermarks takes them at once', () => {
  const queue = loadQueue();
  queue.setPending('roman', [{ id: 'm-5', ts: 1000, text: 'hi', replyTo: null }]);
  const thread = queue.threadFor('roman');
  run(queue, `threads.get('roman').marks.set('m-5', { dataset: { state: 'queued', ts: '1000' }, textContent: '' })`);
  thread.peerDeliveredTs = 3000;
  thread.peerReadTs = 2000;
  thread.peerReadAt = 2500;
  thread.peerReadVia = 'web';

  queue.context.acceptPendingSend('roman', 'm-5', 1500);

  assert.equal(thread.marks.get('m-5').dataset.state, 'read', 'read outranks delivered, as everywhere');
  assert.equal(thread.marks.get('m-5').dataset.readVia, 'web');

  queue.setPending('roman', [{ id: 'm-6', ts: 2600, text: 'hi', replyTo: null }]);
  run(queue, `threads.get('roman').marks.set('m-6', { dataset: { state: 'queued', ts: '2600' }, textContent: '' })`);
  queue.context.acceptPendingSend('roman', 'm-6', 2600);
  assert.equal(thread.marks.get('m-6').dataset.state, 'ack', 'below the delivered watermark only');
});

test('a refusal is a decision, not a retry: the row says so and leaves the queue', () => {
  const queue = loadQueue();
  queue.setPending('roman', [{ id: 'm-4', ts: 1000, text: 'hi', replyTo: null }]);
  const thread = queue.threadFor('roman');
  run(queue, `threads.get('roman').marks.set('m-4', { dataset: { state: 'queued', ts: '1000' }, textContent: '' })`);

  queue.context.failPendingSend('roman', 'm-4', 'message_id_conflict');

  assert.deepEqual(queue.getPending('roman'), []);
  assert.equal(thread.marks.get('m-4').dataset.state, 'failed');
  assert.equal(thread.marks.get('m-4').textContent, '⚠');
  assert.equal(thread.marks.get('m-4').title, 'message_id_conflict');
});

test('the queue survives a reload, and its rows are drawn again where history cannot show them', () => {
  const first = loadQueue();
  first.context.rememberPendingSend('roman', { id: 'm-5', ts: 1500, text: 'черновик', replyTo: null });

  const key = [...first.stored.keys()][0];
  assert.equal(key, 'tailchat-pending-sends:olga');
  assert.deepEqual(JSON.parse(first.stored.get(key)), {
    roman: [{ id: 'm-5', ts: 1500, text: 'черновик', replyTo: null }],
  });

  // A new page load: a fresh context reading the same storage.
  const second = loadQueue();
  second.stored.set(key, first.stored.get(key));
  second.context.loadPendingSends();

  assert.deepEqual(
    second.getPending('roman'),
    [{ id: 'm-5', ts: 1500, text: 'черновик', replyTo: null }],
  );

  const thread = second.threadFor('roman');
  second.context.ensurePendingRows(thread, 'roman');
  assert.equal(second.appended.length, 1, 'the unsent message is drawn by the queue, not by history');
  assert.equal(second.appended[0].id, 'm-5');
  assert.equal(second.appended[0].queued, true, 'and it is drawn as queued: the clock, not a tick');
  // Idempotent: a second pass (another history merge) must not draw it twice.
  second.context.ensurePendingRows(thread, 'roman');
  assert.equal(second.appended.length, 1);
});

test('a row the transcript already has is never drawn twice', () => {
  const queue = loadQueue();
  queue.setPending('roman', [{ id: 'm-6', ts: 1000, text: 'hi', replyTo: null }]);
  const thread = queue.threadFor('roman');
  run(queue, `threads.get('roman').marks.set('m-6', { dataset: { state: 'queued', ts: '1000' }, textContent: '' })`);

  queue.context.ensurePendingRows(thread, 'roman');

  assert.deepEqual(queue.appended, [], 'the row is already on screen');
  assert.equal(thread.marks.size, 1);
});

function run(queue, code) {
  return queue.run(code);
}

test('a message typed while the socket is down is queued, not refused', async () => {
  // The guard used to be `authed`, which is false for the whole of every
  // reconnect — a Wi-Fi↔LTE handoff, a server restart, a tab woken from a
  // suspend. A submit there did nothing at all: the text stayed in the
  // composer, and a person who then switched conversations or reloaded the tab
  // lost what they had written. With a durable queue the honest answer is to
  // accept it and send it when the socket is back.
  const posted = [];
  const remembered = [];
  let cleared = false;
  const context = {
    elements: { input: { value: 'пока сервера нет', focus() {} } },
    activePeer: 'roman',
    token: 'token-1',
    authed: false,
    self: { login: 'olga', name: 'Olga' },
    composerContext: null,
    threadFor: () => ({ peer: 'roman', marks: new Map() }),
    appendMessage: (thread, row) => posted.push(row),
    scrollToLatest: () => {},
    rememberPendingSend: (peer, entry) => remembered.push({ peer, entry }),
    flushPendingSends: () => {},
    playSound: () => {},
    stopTyping: () => {},
    clearComposer: () => { cleared = true; },
    hideCommandPalette: () => {},
    randomHex: () => 'abcdef012345',
    executeCommand: () => { throw new Error('a chat line is not a command'); },
    Date,
    coreSession: null,
  };
  vm.createContext(context);
  vm.runInContext([
    functionSource('onComposerSubmit'),
    'globalThis.onComposerSubmit = onComposerSubmit;',
  ].join('\n'), context);

  await context.onComposerSubmit({ preventDefault() {} });

  assert.equal(posted.length, 1, 'the row is drawn immediately, on the clock');
  assert.equal(posted[0].queued, true);
  assert.equal(remembered.length, 1, 'and the intent is written down before any attempt is made');
  assert.equal(remembered[0].peer, 'roman');
  assert.equal(remembered[0].entry.id, posted[0].id, 'the queued entry and the row are the same id');
  assert.equal(cleared, true, 'the composer is cleared because the message is now the queue\'s, not the draft\'s');
});

// Under the core flag (web/cloud/core/web-session.js) a text is the core's to
// queue — durably, in its own store, before the socket — so the page's queue
// must not hold a second copy that would retry it on its own clock. A reply is
// the core's too (`sendWith`, its quote sealed with it). And when the core
// will not take either, the row is a ⚠ and nothing is offered to the page's
// open queue: in an encrypted conversation that would write it in the clear.
test('on the core a text and a reply go to its queue; a refusal is ⚠, never the page\'s queue', async () => {
  for (const reply of [false, true]) {
    for (const accepts of [true, false]) {
      const posted = [];
      const remembered = [];
      const handed = [];
      const marks = new Map();
      const failed = [];
      let cleared = false;
      const context = {
        elements: { input: { value: 'через ядро', focus() {} } },
        activePeer: 'roman',
        token: 'token-1',
        authed: false,
        self: { login: 'olga', name: 'Olga' },
        composerContext: reply ? { mode: 'reply', id: 'm-0', from: 'roman', snippet: 'hi' } : null,
        threadFor: () => ({ peer: 'roman', marks }),
        appendMessage: (thread, row) => posted.push(row),
        scrollToLatest: () => {},
        rememberPendingSend: (peer, entry) => remembered.push({ peer, entry }),
        flushPendingSends: () => {},
        failCoreSend: (thread, id) => failed.push(id),
        playSound: () => {},
        stopTyping: () => {},
        clearComposer: () => { cleared = true; },
        hideCommandPalette: () => {},
        randomHex: () => 'abcdef012345',
        executeCommand: () => { throw new Error('a chat line is not a command'); },
        Date,
        coreSession: {
          sendText: (peer, id, text) => { handed.push({ call: 'sendText', peer, id, text }); return accepts; },
          sendWith: (peer, id, text, options) => { handed.push({ call: 'sendWith', peer, id, text, options }); return accepts; },
        },
      };
      vm.createContext(context);
      vm.runInContext([
        functionSource('onComposerSubmit'),
        'globalThis.onComposerSubmit = onComposerSubmit;',
      ].join('\n'), context);
      await context.onComposerSubmit({ preventDefault() {} });

      const label = `reply=${reply} accepts=${accepts}`;
      assert.equal(posted.length, 1, `the row is drawn either way (${label})`);
      assert.equal(posted[0].queued, true, `on the clock until the core says otherwise (${label})`);
      assert.equal(cleared, true, label);
      assert.deepEqual(remembered, [], `no copy on the page's open queue (${label})`);
      assert.equal(handed.length, 1, label);
      assert.equal(handed[0].call, reply ? 'sendWith' : 'sendText', label);
      if (reply) assert.equal(handed[0].options.replyTo.id, 'm-0', 'the quote rides with the call');
      assert.deepEqual(failed, accepts ? [] : ['m-abcdef012345'], `a refusal is a ⚠ on that row (${label})`);
    }
  }
});

// Under the core flag the unsent texts live in the core's queue, not the
// page's: after a reload they are drawn from `conversation()` — on the clock,
// or ⚠ when the core gave up — beside the page's own (replies) and never twice.
test('on the core, its queued texts are drawn after a reload, a failed one as ⚠', () => {
  const queue = loadQueue();
  run(queue, `coreSession = { conversation: () => [
    { source: 'sent', id: 'm-old', text: 'delivered long ago', ts: 900 },
    { source: 'pending', id: 'm-q', text: 'still queued', ts: 1000, receipt: 'queued' },
    { source: 'pending', id: 'm-f', text: 'gave up', ts: 1100, receipt: 'failed' },
    { source: 'message', id: 'm-in', from: 'roman', text: 'theirs', ts: 1200 },
  ] }`);
  queue.setPending('roman', [{ id: 'm-reply', ts: 1300, text: 'a reply', replyTo: { id: 'm-in' } }]);
  const thread = queue.threadFor('roman');

  queue.context.ensurePendingRows(thread, 'roman');
  assert.deepEqual(plain(queue.appended.map((row) => [row.id, row.queued, row.own])), [
    ['m-q', true, true], ['m-f', true, true], ['m-reply', true, true],
  ]);
  assert.equal(queue.markFor('roman', 'm-q').dataset.state, 'queued');
  assert.equal(queue.markFor('roman', 'm-f').dataset.state, 'failed');

  queue.context.ensurePendingRows(thread, 'roman');
  assert.equal(queue.appended.length, 3, 'a second history merge draws nothing again');
});
