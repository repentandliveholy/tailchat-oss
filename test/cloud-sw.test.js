import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const workerSource = fs.readFileSync(new URL('../web/cloud/sw.js', import.meta.url), 'utf8');

class FakeMessageChannel {
  constructor() {
    this.port1 = {
      onmessage: null,
      close() {},
    };
    this.port2 = {
      postMessage: (data) => this.port1.onmessage?.({ data }),
    };
  }
}

function loadWorker({
  keys = [],
  addAll = async () => {},
  deleted = [],
  matchAllClients = async () => [],
  showNotification = async () => {},
  indexedDB: idb = undefined,
  fetch: fetchImpl = undefined,
} = {}) {
  const listeners = new Map();
  const opened = [];
  let claimed = false;
  const context = {
    URL,
    MessageChannel: FakeMessageChannel,
    console: { warn() {} },
    setTimeout,
    clearTimeout,
    indexedDB: idb,
    fetch: fetchImpl,
    caches: {
      async open(name) {
        opened.push(name);
        return { addAll, put: async () => {} };
      },
      async keys() { return keys; },
      async delete(name) { deleted.push(name); return true; },
      async match() { return undefined; },
    },
    self: {
      addEventListener(type, listener) { listeners.set(type, listener); },
      skipWaiting() {},
      clients: {
        async claim() { claimed = true; },
        async matchAll() { return matchAllClients(); },
        async openWindow() {},
      },
      registration: {
        showNotification,
        pushManager: {
          async subscribe() { return { toJSON: () => ({ endpoint: 'https://push.example/x' }) }; },
        },
      },
    },
  };
  vm.runInNewContext(workerSource, context, { filename: 'web/cloud/sw.js' });
  return { listeners, opened, claimed: () => claimed };
}

// A client stub whose `postMessage` answers a QUERY_ACTIVE_PEER request over the port it was
// handed, the same way `app.js`'s message listener does for a real page.
function fakeClient({ focused, activePeer }) {
  return {
    focused,
    postMessage(message, ports) {
      if (message?.type === 'QUERY_ACTIVE_PEER' && ports?.[0]) {
        ports[0].postMessage({ activePeer });
      }
    },
  };
}

test('PWA release markers and required offline assets match the package version', async () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const html = fs.readFileSync(new URL('../web/cloud/index.html', import.meta.url), 'utf8');
  const prefetched = [];
  const worker = loadWorker({ addAll: async (assets) => prefetched.push(...Array.from(assets)) });
  let installed;

  worker.listeners.get('install')({ waitUntil(promise) { installed = promise; } });
  await Promise.resolve(installed);

  assert.match(html, new RegExp(`/tailchat/app\\.css\\?v=${pkg.version}`));
  assert.match(html, new RegExp(`/tailchat/app\\.js\\?v=${pkg.version}`));
  assert.deepEqual(prefetched.filter((asset) => /app\.(?:css|js)/.test(asset)), [
    `/tailchat/app.css?v=${pkg.version}`,
    `/tailchat/app.js?v=${pkg.version}`,
  ]);
  assert.match(html, new RegExp(`/tailchat/icons/icon-192\\.png\\?v=${pkg.version}`));
  assert.deepEqual(prefetched.filter((asset) => /icons\/.*\.png/.test(asset)), [
    `/tailchat/icons/icon-192.png?v=${pkg.version}`,
    `/tailchat/icons/icon-512.png?v=${pkg.version}`,
    `/tailchat/icons/icon-180.png?v=${pkg.version}`,
  ]);
  // Bumped by hand with every release that touches web/cloud (AGENTS.md rule
  // 7): the literal is what forces the counter to be incremented, because
  // `activate` only evicts the previous cache when the name actually changes.
  assert.deepEqual(worker.opened, ['tailchat-cloud-v188']);
});
test('message history bypasses persistent service-worker caching', () => {
  const worker = loadWorker();
  let intercepted = false;
  worker.listeners.get('fetch')({
    request: {
      url: 'https://example.test/tailchat/api/history?peer=bob',
      method: 'GET',
    },
    respondWith() { intercepted = true; },
  });
  assert.equal(intercepted, false);
  assert.deepEqual(worker.opened, []);
});

// Decrypted attachment bytes must never land in a cache on disk
// (docs/specs/2026-11-03-history-media-refs.md §8.2): the server says
// `private, no-store`, and the worker must not keep a copy of its own either.
test('attachment bytes from /api/media bypass the service worker, Range requests included', () => {
  const worker = loadWorker();
  let intercepted = false;
  for (const headers of [{}, { Range: 'bytes=0-99' }]) {
    worker.listeners.get('fetch')({
      request: { url: 'https://example.test/tailchat/api/media?peer=bob&id=m-1&slot=voice', method: 'GET', headers },
      respondWith() { intercepted = true; },
    });
  }
  assert.equal(intercepted, false);
  assert.deepEqual(worker.opened, []);
});

test('service worker installation fails closed when a required shell asset is unavailable', async () => {
  const worker = loadWorker({
    addAll: async () => { throw new Error('required asset unavailable'); },
  });
  let installed;

  worker.listeners.get('install')({ waitUntil(promise) { installed = promise; } });

  await assert.rejects(installed, /required asset unavailable/);
});

test('service worker activation removes only obsolete Tailchat caches', async () => {
  const deleted = [];
  const worker = loadWorker({
    keys: ['tailchat-cloud-v10', 'tailchat-cloud-v11', 'other-app-v4'],
    deleted,
  });
  let activated;

  worker.listeners.get('activate')({ waitUntil(promise) { activated = promise; } });
  await Promise.resolve(activated);

  assert.deepEqual(deleted, ['tailchat-cloud-v10', 'tailchat-cloud-v11']);
  assert.equal(worker.claimed(), true);
});

// The smallest IndexedDB the worker's repair record needs: one store,
// `get`/`put`, and results delivered the way the real API delivers them — an
// event whose `result` is read in `onsuccess`.
function fakeIndexedDB(initial = {}) {
  const data = new Map(Object.entries(initial));
  const store = {
    get(key) {
      const request = {};
      queueMicrotask(() => {
        request.result = data.get(key);
        request.onsuccess?.();
      });
      return request;
    },
    put(value, key) {
      const request = {};
      queueMicrotask(() => {
        data.set(key, value);
        request.result = key;
        request.onsuccess?.();
      });
      return request;
    },
    delete(key) {
      const request = {};
      queueMicrotask(() => {
        data.delete(key);
        request.onsuccess?.();
      });
      return request;
    },
  };
  return {
    data,
    open() {
      const request = {
        result: {
          objectStoreNames: { contains: () => true },
          transaction: () => ({ objectStore: () => store }),
          close() {},
        },
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

test('a rotated endpoint is registered with the server by the worker itself', async () => {
  const store = fakeIndexedDB({
    current: { login: 'anna', deviceId: 'deviceaaaaaaaaaa', repairKey: 'a'.repeat(64) },
  });
  const calls = [];
  const posted = [];
  const worker = loadWorker({
    indexedDB: store,
    matchAllClients: async () => [{ focused: true, postMessage: (m) => posted.push(m) }],
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, repairKey: 'b'.repeat(64) }) };
    },
  });

  let waited;
  worker.listeners.get('pushsubscriptionchange')({
    oldSubscription: { options: { applicationServerKey: 'key' } },
    waitUntil(promise) { waited = promise; },
  });
  await waited;

  assert.equal(calls.length, 1, 'one request, to the one endpoint that exists for this');
  assert.equal(calls[0].url, '/tailchat/api/push/resubscribe');
  assert.equal(calls[0].body.login, 'anna');
  assert.equal(calls[0].body.deviceId, 'deviceaaaaaaaaaa');
  assert.equal(calls[0].body.repairKey, 'a'.repeat(64));
  assert.equal(calls[0].body.subscription.endpoint, 'https://push.example/x');
  assert.equal(store.data.get('current').repairKey, 'b'.repeat(64), 'the spent key is replaced by the rotated one');
  assert.deepEqual(posted, [], 'a repaired device does not need its open tabs to do anything');
});

test('with nothing to repair with, the worker still tells the open clients', async () => {
  const posted = [];
  const worker = loadWorker({
    indexedDB: fakeIndexedDB(),
    matchAllClients: async () => [{ focused: true, postMessage: (m) => posted.push(m) }],
    fetch: async () => { throw new Error('nothing to repair with — this must not be reached'); },
  });

  let waited;
  worker.listeners.get('pushsubscriptionchange')({
    oldSubscription: { options: { applicationServerKey: 'key' } },
    waitUntil(promise) { waited = promise; },
  });
  await waited;

  assert.deepEqual(posted.map((m) => m.type), ['PUSH_RESUBSCRIBE_NEEDED'], 'the messages come from the worker realm, so the shape is what is compared');
});

test('a rejected repair falls back to telling the open clients', async () => {
  const store = fakeIndexedDB({
    current: { login: 'anna', deviceId: 'deviceaaaaaaaaaa', repairKey: 'c'.repeat(64) },
  });
  const posted = [];
  const worker = loadWorker({
    indexedDB: store,
    matchAllClients: async () => [{ focused: true, postMessage: (m) => posted.push(m) }],
    fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: 'bad_repair_key' }) }),
  });

  let waited;
  worker.listeners.get('pushsubscriptionchange')({
    oldSubscription: null,
    waitUntil(promise) { waited = promise; },
  });
  await waited;

  assert.deepEqual(posted.map((m) => m.type), ['PUSH_RESUBSCRIBE_NEEDED'], 'the messages come from the worker realm, so the shape is what is compared');
  assert.equal(store.data.get('current').repairKey, 'c'.repeat(64), 'a key that was not accepted is not replaced');
});

test('a push is shown when no focused window is looking at that peer', async () => {
  const shown = [];
  const worker = loadWorker({
    matchAllClients: async () => [fakeClient({ focused: false, activePeer: 'anna' })],
    showNotification: async (title, options) => shown.push({ title, options }),
  });

  let waited;
  worker.listeners.get('push')({
    data: { json: () => ({ title: 'Anna', body: 'hi', peer: 'anna', tag: 'tailchat-msg-anna' }) },
    waitUntil(promise) { waited = promise; },
  });
  await waited;

  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Anna');
  assert.equal(shown[0].options.tag, 'tailchat-msg-anna');
});

test('a push for the conversation already on screen is shown silently, never skipped', async () => {
  const shown = [];
  const worker = loadWorker({
    matchAllClients: async () => [fakeClient({ focused: true, activePeer: 'anna' })],
    showNotification: async (title, options) => shown.push({ title, options }),
  });

  let waited;
  worker.listeners.get('push')({
    data: { json: () => ({ title: 'Anna', body: 'hi', peer: 'anna', tag: 'tailchat-msg-anna' }) },
    waitUntil(promise) { waited = promise; },
  });
  await waited;

  // A userVisibleOnly subscription that shows nothing makes Chrome post its
  // own «Site updated in background» notice instead — worse than a silent
  // notification for the one device that already rendered the message.
  assert.equal(shown.length, 1);
  assert.equal(shown[0].options.silent, true);
  assert.equal(shown[0].options.renotify, false);
  assert.equal(shown[0].options.vibrate, undefined);
});

test('a push still shows when the focused window is on a different conversation', async () => {
  const shown = [];
  const worker = loadWorker({
    matchAllClients: async () => [fakeClient({ focused: true, activePeer: 'boris' })],
    showNotification: async (title, options) => shown.push({ title, options }),
  });

  let waited;
  worker.listeners.get('push')({
    data: { json: () => ({ title: 'Anna', body: 'hi', peer: 'anna', tag: 'tailchat-msg-anna' }) },
    waitUntil(promise) { waited = promise; },
  });
  await waited;

  assert.equal(shown.length, 1);
});

test('a push with no clients open at all is still shown', async () => {
  const shown = [];
  const worker = loadWorker({
    matchAllClients: async () => [],
    showNotification: async (title, options) => shown.push({ title, options }),
  });

  let waited;
  worker.listeners.get('push')({
    data: { json: () => ({ title: 'Anna', body: 'hi', peer: 'anna' }) },
    waitUntil(promise) { waited = promise; },
  });
  await waited;

  assert.equal(shown.length, 1);
});
