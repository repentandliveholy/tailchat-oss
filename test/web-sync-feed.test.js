import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');

// The account feed, seen from the browser.
//
// This tab holds exactly one subscription — the conversation on screen — so a
// message read on the phone, an old message edited, or a receipt for something
// sent from another device reaches it as a roster line and nothing else. The
// feed (`sync-v1`) is what lets a *cached* conversation be corrected without
// being reopened, and the nudge (`sync-nudge-v1`) is what makes a pass start
// while the socket is up instead of at the next reconnect.
//
// Two things are pinned here: the reducer's own meaning for each event kind
// (especially the two directions one `read` record carries), and the pump's
// contract that there is never more than one pass in flight, with at most one
// more owed.
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

function bindingSource(name) {
  const match = new RegExp(`^(?:const|let) ${name} = .*$`, 'm').exec(appSource);
  assert.ok(match, `${name} is declared at module scope in web/cloud/app.js`);
  return match[0];
}

const FUNCTIONS = [
  'applySyncEvent', 'applyPeerReadWatermark', 'applySyncPage', 'startSyncPump',
  'finishSyncPass', 'queueSyncWork', 'resetSyncCursor', 'loadSyncCursor',
  'saveSyncCursor', 'syncCursorStoreKey', 'fillSyncGap', 'setMark', 'markCommitted', 'settleCommittedMark',
];
const BINDINGS = [
  'SYNC_CURSOR_KEY', 'SYNC_PAGE_LIMIT', 'SYNC_MAX_PAGES', 'SYNC_REFRESH_LIMIT',
  'SYNC_BACKFILL_MAX_PAGES', 'serverCaps', 'syncCursor', 'syncCursorLoaded',
  'syncInFlight', 'syncAgain', 'syncPages', 'syncOwed', 'syncFlushBusy',
  'syncFlushTimer', 'threads', 'authed', 'socket', 'self', 'activePeer', 'users',
  // The core is off here (`null`): this is the classic feed reader.
  'coreSession',
];

function loadFeed({ caps = ['sync-v1', 'sync-nudge-v1'] } = {}) {
  const stored = new Map();
  const envelopes = [];
  const syncedReads = [];
  const rosterRenders = [];
  const owed = [];
  const context = {
    localStorage: {
      getItem: (key) => (stored.has(key) ? stored.get(key) : null),
      setItem: (key, value) => { stored.set(key, String(value)); },
      removeItem: (key) => { stored.delete(key); },
    },
    WebSocket: { OPEN: 1 },
    // The account-local half of a receipt: this account read, on this device or
    // another one. `applySyncEvent` must call exactly this for `self: true` and
    // never for the peer's.
    applySyncedRead: (peer) => syncedReads.push(peer),
    scheduleRosterRender: () => rosterRenders.push(true),
    sendEnvelope: (payload) => { envelopes.push(payload); return true; },
    setTimeout: (fn) => { owed.push(fn); return owed.length; },
    clearTimeout: () => {},
    flushSyncOwed: async () => {},
    reconcileActiveThread: async () => {},
    refreshNewestPage: async () => true,
    loadOlderMessages: async () => {},
    fillSyncGapAsync: null,
    errorText: (code) => code,
  };
  vm.createContext(context);
  vm.runInContext([
    ...BINDINGS.map(bindingSource),
    `serverCaps = new Set(${JSON.stringify(caps)});`,
    'self = { login: \'olga\', name: \'Olga\' };',
    'users = [{ login: \'roman\' }];',
    "socket = { readyState: 1 };",
    'authed = true;',
    'activePeer = null;',
    // `threads` and `syncOwed` are `const` in app.js — the maps are the state,
    // they are never replaced.
    'threads.clear();',
    'syncOwed.clear();',
    ...FUNCTIONS.map((name) => functionSource(name)),
    ...FUNCTIONS.map((name) => `globalThis.${name} = ${name};`),
  ].join('\n'), context);

  const run = (code) => vm.runInContext(code, context);
  return {
    context,
    stored,
    envelopes,
    syncedReads,
    rosterRenders,
    run,
    read: (expression) => JSON.parse(run(`JSON.stringify(${expression})`)),
    // Scalars and live handles: `JSON.stringify(undefined)` would throw, and a
    // mark is a real object rather than a snapshot of one.
    value: (expression) => run(expression),
    addThread: (peer, rows = []) => {
      run(`threads.set(${JSON.stringify(peer)}, { peer: ${JSON.stringify(peer)}, ` +
        'oldestTs: null, oldestId: null, loaded: true, reachedBeginning: false, peerReadTs: 0, ' +
        'marks: new Map(), seen: new Set() })');
      for (const [id, state, ts] of rows) {
        run(`{ const thread = threads.get(${JSON.stringify(peer)});` +
          `thread.seen.add(${JSON.stringify(id)});` +
          `thread.marks.set(${JSON.stringify(id)}, { dataset: { state: ${JSON.stringify(state)}, ts: ${JSON.stringify(String(ts))} }, textContent: '' }); }`);
      }
    },
    markOf: (peer, id) => run(`threads.get(${JSON.stringify(peer)}).marks.get(${JSON.stringify(id)})`),
  };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('the peer\'s read is a watermark over this account\'s own messages', () => {
  const feed = loadFeed();
  feed.addThread('anna', [['m-early', 'ack', 1000], ['m-late', 'ack', 4000]]);

  feed.context.applySyncEvent({ kind: 'read', peer: 'anna', readTs: 3000, readAt: 9000 });

  assert.equal(feed.markOf('anna', 'm-early').dataset.state, 'read');
  assert.equal(feed.markOf('anna', 'm-early').textContent, '✓✓');
  assert.equal(feed.markOf('anna', 'm-early').dataset.readAt, '9000');
  assert.equal(feed.markOf('anna', 'm-late').dataset.state, 'ack', 'past the watermark: still one tick');
  assert.equal(
    feed.value('threads.get("anna").peerReadTs'),
    3000,
    'the roster preview reads the same watermark',
  );
  assert.deepEqual(feed.syncedReads, [], 'a peer\'s reading is not this account\'s reading');
});

test('this account\'s own read is the other direction entirely', () => {
  const feed = loadFeed();
  feed.addThread('anna', [['m-early', 'ack', 1000]]);

  feed.context.applySyncEvent({ kind: 'read', peer: 'anna', readTs: 3000, self: true });

  assert.deepEqual(feed.syncedReads, ['anna'], 'the badge for this conversation is what it clears');
  assert.equal(feed.markOf('anna', 'm-early').dataset.state, 'ack', 'and no outgoing tick is invented by it');
  assert.equal(
    feed.value('threads.get("anna").peerReadTs'),
    0,
    'our own reading says nothing about what the peer has read',
  );
});

test('a message the tab has never seen is a fetch, not a row', () => {
  const feed = loadFeed();
  feed.addThread('anna');

  feed.context.applySyncEvent({ kind: 'message', peer: 'anna', id: 'm-gap', ts: 500 });

  // The feed carries no content on purpose, so the id has to become work rather
  // than a rendered bubble with an empty body.
  assert.deepEqual(feed.read('[...syncOwed.keys()]'), ['anna']);
  assert.deepEqual(feed.read('[...syncOwed.get("anna")]'), ['m-gap']);
});

test('a message already on screen takes the server\'s time and nothing else', () => {
  const feed = loadFeed();
  feed.addThread('anna', [['m-own', 'queued', 1000]]);

  feed.context.applySyncEvent({ kind: 'message', peer: 'anna', id: 'm-own', ts: 4242, self: true });

  assert.equal(feed.value('syncOwed.size'), 0, 'nothing is owed for a message this tab already has');
  assert.equal(
    feed.markOf('anna', 'm-own').dataset.state,
    'sent',
    'the feed is proof the server has it — ✓, not the ✓✓ that only the peer’s device can claim',
  );
  assert.equal(feed.markOf('anna', 'm-own').textContent, '✓');
  assert.equal(
    feed.markOf('anna', 'm-own').dataset.ts,
    '4242',
    'and the row carries the server\'s clock, which is what a read watermark is measured against',
  );
});

test('an edit, a delete or a reaction re-reads the conversation instead of guessing', () => {
  const feed = loadFeed();
  feed.addThread('anna');

  for (const kind of ['edit', 'delete', 'react']) {
    feed.context.applySyncEvent({ kind, peer: 'anna', id: 'm-1' });
  }

  assert.deepEqual(
    feed.read('[...syncOwed.keys()]'),
    ['anna'],
    'one conversation, one refresh — a second reducer that could disagree with the history merge is what this avoids',
  );
  assert.deepEqual(feed.read('[...syncOwed.get("anna")]'), [], 'no ids: this is a refresh, not a gap to walk');
});

test('nothing is queued for a conversation this tab does not hold', () => {
  const feed = loadFeed();

  feed.context.applySyncEvent({ kind: 'message', peer: 'anna', id: 'm-1', ts: 1 });
  feed.context.applySyncEvent({ kind: 'edit', peer: 'anna', id: 'm-1' });

  assert.equal(feed.value('syncOwed.size'), 0, 'opening the conversation fetches it with the change already in it');
});

test('one feed pass at a time, with at most one more owed', () => {
  const feed = loadFeed();

  feed.context.startSyncPump();
  assert.deepEqual(plain(feed.envelopes), [{ k: 'sync', since: 0, limit: 200 }]);

  // A nudge arriving mid-pass must not race the page in hand: it is folded into
  // a single owed re-run that happens when the pass ends.
  feed.context.startSyncPump();
  feed.context.startSyncPump();
  assert.equal(feed.envelopes.length, 1, 'no second request while one is in flight');
  assert.equal(feed.value('syncAgain'), true);

  feed.context.applySyncPage({ events: [], cursor: 9, more: false });

  assert.equal(feed.envelopes.length, 2, 'the folded nudge is honoured once the pass ends');
  assert.deepEqual(plain(feed.envelopes[1]), { k: 'sync', since: 9, limit: 200 }, 'from the stored cursor');
  assert.equal(feed.value('syncAgain'), false);
  assert.equal(feed.stored.get('tailchat-sync-cursor:olga'), '9', 'the cursor is kept for the next page load');
});

test('a truncated pass continues from the cursor it stored', () => {
  const feed = loadFeed();

  feed.context.startSyncPump();
  feed.context.applySyncPage({ events: [], cursor: 200, more: true });

  assert.equal(feed.envelopes.length, 2);
  assert.deepEqual(plain(feed.envelopes[1]), { k: 'sync', since: 200, limit: 200 });
  assert.equal(feed.value('syncInFlight'), true, 'still the same pass');
});

test('a reset drops the cursor and re-reads what is on screen', () => {
  const feed = loadFeed();
  feed.context.startSyncPump();
  feed.context.applySyncPage({ events: [], cursor: 900, more: false });
  assert.equal(feed.stored.get('tailchat-sync-cursor:olga'), '900');

  feed.context.applySyncPage({ events: [], cursor: 12, more: false, reset: true });

  assert.equal(
    feed.stored.get('tailchat-sync-cursor:olga'),
    '12',
    'the page that starts from the beginning of the log is what the cursor becomes',
  );
  assert.equal(feed.value('syncCursor'), 12);
});

test('a server without the feed is not asked for one', () => {
  const feed = loadFeed({ caps: ['durable-ack'] });

  feed.context.startSyncPump();

  assert.deepEqual(feed.envelopes, []);
});
