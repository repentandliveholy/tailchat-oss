import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');

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

function loadPreloader(fetchInitialHistory) {
  const threads = new Map();
  const populated = [];
  const context = {
    authed: true,
    activePeer: null,
    users: Array.from({ length: 10 }, (_, index) => ({ login: `peer-${index}` })),
    threads,
    navigator: {},
    fetchInitialHistory,
    threadFor(login) {
      if (!threads.has(login)) threads.set(login, { peer: login, loaded: false });
      return threads.get(login);
    },
    // The real signature, so what the preload hands the painter can be read
    // back by name: a keyword-less call would have hidden the delivered
    // watermark behind a positional argument.
    populateHistory(thread, messages, peerReadTs = 0, peerReadAt = 0, peerReadVia = '', peerDeliveredTs = 0) {
      populated.push({
        peer: thread.peer, messages, peerReadTs, peerReadAt, peerReadVia, peerDeliveredTs,
      });
    },
    PRELOAD_CONCURRENCY: 3,
    initialHistoryLoads: new Map(),
  };
  vm.createContext(context);
  vm.runInContext([
    functionSource('loadInitialHistory'),
    functionSource('shouldPreloadHistory'),
    functionSource('preloadThreads'),
    'globalThis.loadInitialHistory = loadInitialHistory;',
    'globalThis.preloadThreads = preloadThreads;',
  ].join('\n'), context);
  return { context, threads, populated };
}

test('web preload fills every roster conversation with bounded concurrency', async () => {
  let active = 0;
  let peak = 0;
  const fetched = [];
  const { context, threads, populated } = loadPreloader(async (peer) => {
    fetched.push(peer);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return { msgs: [{ id: peer }], peerReadTs: 0, reachedBeginning: true };
  });

  await context.preloadThreads();

  assert.equal(fetched.length, 10, 'a fixed first-page cap must not leave later roster rows cold');
  assert.ok(peak <= 3, `expected at most three concurrent history requests, saw ${peak}`);
  assert.equal(populated.length, 10);
  assert.ok([...threads.values()].every((thread) => thread.loaded));
});

test('opening a chat shares the history request already started by preload', async () => {
  let resolveFetch;
  let calls = 0;
  const { context } = loadPreloader((peer) => {
    calls += 1;
    return new Promise((resolve) => { resolveFetch = () => resolve({ msgs: [{ id: peer }], peerReadTs: 0, reachedBeginning: true }); });
  });
  context.users = [{ login: 'roman' }];

  const preload = context.preloadThreads();
  await Promise.resolve();
  const opened = context.loadInitialHistory('roman');
  assert.equal(calls, 1, 'preload and click must not duplicate the same history request');
  resolveFetch();
  await Promise.all([preload, opened]);
});

// A conversation filled in the background is still drawn in the roster — its
// own last word, with its own mark — so the delivered watermark has to survive
// this path: dropping it here would leave the roster saying ✓ for a message the
// peer's phone has held since the last page load.
test('preload carries the peer’s delivery watermark onto the thread it fills', async () => {
  const { context, populated } = loadPreloader(async (peer) => ({
    msgs: [{ id: peer, from: 'olga', ts: 1000 }],
    peerReadTs: 0,
    peerDeliveredTs: 1700,
    reachedBeginning: true,
  }));
  context.users = [{ login: 'roman' }];

  await context.preloadThreads();

  assert.equal(populated.length, 1);
  assert.equal(populated[0].peerDeliveredTs, 1700, 'the roster rung is drawn from this number');
  assert.equal(populated[0].peerReadTs, 0, 'and it is not confused with the read watermark beside it');
});

test('message menu reports only known read times and preserves edit times', () => {
  const context = {
    messageEventTime: (value) => `at-${value}`,
    t: (key, value) => `${key}:${value}`,
  };
  vm.createContext(context);
  vm.runInContext(`${functionSource('readViaLabel')}\n${functionSource('messageMenuDetails')}\nglobalThis.messageMenuDetails = messageMenuDetails;`, context);

  assert.deepEqual(
    Array.from(context.messageMenuDetails({ own: true, readAt: 2000, editedAt: 3000 })),
    ['msgReadAt:at-2000', 'msgEditedAt:at-3000'],
  );
  assert.deepEqual(
    Array.from(context.messageMenuDetails({ own: false, readAt: 2000, editedAt: 3000 })),
    ['msgEditedAt:at-3000'],
    'a peer message cannot expose this account’s receipt watermark',
  );
  assert.deepEqual(
    Array.from(context.messageMenuDetails({ own: true, readAt: 0, editedAt: 0 })),
    [],
    'legacy messages without readAt must not invent a time',
  );
});
