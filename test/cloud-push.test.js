import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { PUSH_FAILURE_LIMIT, createPushSender, loadOrCreateVapidKeys } from '../src/cloud/push.js';
import { readyCipher } from '../src/cloud/storage-crypto.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-cloud-push-'));
}

function fakeStore(subs = {}) {
  const state = new Map(Object.entries(subs));
  const removed = [];
  return {
    state,
    removed,
    pushSubscriptions(login) {
      return state.get(login) ?? [];
    },
    removePushSubscription(login, endpoint) {
      removed.push([login, endpoint]);
      const kept = (state.get(login) ?? []).filter((s) => s.endpoint !== endpoint);
      state.set(login, kept);
      return true;
    },
  };
}

test('with no VAPID keypair, the sender is disabled and never calls send', async () => {
  const store = fakeStore({ anna: [{ endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } }] });
  let calls = 0;
  const sender = createPushSender({ store, send: async () => { calls += 1; } });

  assert.equal(sender.enabled, false);
  assert.equal(sender.publicKey(), null);
  await sender.notify('anna', { title: 'x', body: 'y' });
  assert.equal(calls, 0);
});

test('a configured sender delivers to every subscription of the recipient with the JSON payload', async () => {
  const store = fakeStore({
    anna: [
      { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } },
      { endpoint: 'https://push.example/2', keys: { p256dh: 'c', auth: 'd' } },
    ],
  });
  const calls = [];
  const sender = createPushSender({
    store,
    publicKey: 'pub',
    privateKey: 'priv',
    setVapidDetails: (...args) => calls.push(['vapid', ...args]),
    send: async (subscription, body) => calls.push(['send', subscription, body]),
  });

  assert.equal(sender.enabled, true);
  assert.equal(sender.publicKey(), 'pub');
  assert.deepEqual(calls[0], ['vapid', 'mailto:admin@repentandliveholy.org', 'pub', 'priv']);

  await sender.notify('anna', { title: 'Anna', body: 'hi', peer: 'anna' });
  const sends = calls.filter((c) => c[0] === 'send');
  assert.equal(sends.length, 2);
  assert.deepEqual(sends.map((c) => c[1].endpoint).sort(), ['https://push.example/1', 'https://push.example/2']);
  assert.deepEqual(JSON.parse(sends[0][2]), { title: 'Anna', body: 'hi', peer: 'anna' });
});

test('a 410 Gone from one endpoint prunes it without touching the others', async () => {
  const store = fakeStore({
    anna: [
      { endpoint: 'https://push.example/dead', keys: { p256dh: 'a', auth: 'b' } },
      { endpoint: 'https://push.example/alive', keys: { p256dh: 'c', auth: 'd' } },
    ],
  });
  const sender = createPushSender({
    store,
    publicKey: 'pub',
    privateKey: 'priv',
    setVapidDetails: () => {},
    send: async (subscription) => {
      if (subscription.endpoint.endsWith('/dead')) {
        const error = new Error('gone');
        error.statusCode = 410;
        throw error;
      }
    },
  });

  await sender.notify('anna', { title: 'x', body: 'y' });
  assert.deepEqual(store.removed, [['anna', 'https://push.example/dead']]);
});

test('a transient failure (e.g. 429/500) leaves the subscription in place', async () => {
  const store = fakeStore({ anna: [{ endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } }] });
  const sender = createPushSender({
    store,
    publicKey: 'pub',
    privateKey: 'priv',
    setVapidDetails: () => {},
    send: async () => {
      const error = new Error('rate limited');
      error.statusCode = 429;
      throw error;
    },
  });

  await sender.notify('anna', { title: 'x', body: 'y' });
  assert.deepEqual(store.removed, []);
});

test('an endpoint that fails every time is dropped once the run hits the limit', async () => {
  const endpoint = 'https://push.example/dead';
  const store = fakeStore({ anna: [{ endpoint, keys: { p256dh: 'a', auth: 'b' } }] });
  const sender = createPushSender({
    store,
    publicKey: 'pub',
    privateKey: 'priv',
    setVapidDetails: () => {},
    send: async () => {
      const error = new Error('rate limited');
      error.statusCode = 429;
      throw error;
    },
  });

  // One short of the limit: still kept, because a rate limit is not proof the
  // endpoint is gone.
  for (let i = 0; i < PUSH_FAILURE_LIMIT - 1; i += 1) {
    await sender.notify('anna', { title: 'x', body: 'y' });
  }
  assert.deepEqual(store.removed, [], 'a short run of failures must not silence the device');

  await sender.notify('anna', { title: 'x', body: 'y' });
  assert.deepEqual(store.removed, [['anna', endpoint]], 'a whole run of failures drops the endpoint');

  // And the run is forgotten with the subscription it described.
  await sender.notify('anna', { title: 'x', body: 'y' });
  assert.deepEqual(store.removed, [['anna', endpoint]], 'nothing left to remove twice');
});

test('one delivery in between clears the failure run', async () => {
  const endpoint = 'https://push.example/flaky';
  const store = fakeStore({ anna: [{ endpoint, keys: { p256dh: 'a', auth: 'b' } }] });
  let failing = true;
  const sender = createPushSender({
    store,
    publicKey: 'pub',
    privateKey: 'priv',
    setVapidDetails: () => {},
    send: async () => {
      if (failing) {
        const error = new Error('rate limited');
        error.statusCode = 503;
        throw error;
      }
    },
  });

  for (let i = 0; i < PUSH_FAILURE_LIMIT - 1; i += 1) {
    await sender.notify('anna', { title: 'x', body: 'y' });
  }
  failing = false;
  await sender.notify('anna', { title: 'x', body: 'y' });
  failing = true;
  for (let i = 0; i < PUSH_FAILURE_LIMIT - 1; i += 1) {
    await sender.notify('anna', { title: 'x', body: 'y' });
  }
  assert.deepEqual(store.removed, [], 'a device that answered once is not a dead endpoint');
});

test('an outage that hits every endpoint of one account is charged to nobody', async () => {
  const store = fakeStore({
    anna: [
      { endpoint: 'https://push.example/a', keys: { p256dh: 'a', auth: 'b' } },
      { endpoint: 'https://push.example/b', keys: { p256dh: 'c', auth: 'd' } },
    ],
  });
  const sender = createPushSender({
    store,
    publicKey: 'pub',
    privateKey: 'priv',
    setVapidDetails: () => {},
    // A transport error and no HTTP answer at all: the push services never
    // spoke, so this says something about the box, not about those devices.
    send: async () => {
      const error = new Error('socket hang up');
      error.code = 'ETIMEDOUT';
      throw error;
    },
  });

  for (let i = 0; i < PUSH_FAILURE_LIMIT * 3; i += 1) {
    await sender.notify('anna', { title: 'x', body: 'y' });
  }
  assert.deepEqual(store.removed, [], 'our own outage must not prune anybody’s subscriptions');
});

test('a transport failure is counted once the same account’s other endpoint answered', async () => {
  const answers = 'https://push.example/answers';
  const silent = 'https://push.example/quiet';
  const store = fakeStore({
    anna: [
      { endpoint: answers, keys: { p256dh: 'a', auth: 'b' } },
      { endpoint: silent, keys: { p256dh: 'c', auth: 'd' } },
    ],
  });
  const sender = createPushSender({
    store,
    publicKey: 'pub',
    privateKey: 'priv',
    setVapidDetails: () => {},
    send: async ({ endpoint }) => {
      const error = new Error(endpoint === silent ? 'timeout' : 'rate limited');
      if (endpoint === silent) error.code = 'ETIMEDOUT';
      else error.statusCode = 429;
      throw error;
    },
  });

  for (let i = 0; i < PUSH_FAILURE_LIMIT; i += 1) {
    await sender.notify('anna', { title: 'x', body: 'y' });
  }
  // The push service did answer for one of the two, so the failure is not this
  // box's — every one of the batch must be answerless for the guard to hold.
  assert.deepEqual(store.removed.map(([, endpoint]) => endpoint).sort(), [answers, silent]);
});

test('notify on a recipient with no subscriptions never calls send', async () => {
  const store = fakeStore();
  let calls = 0;
  const sender = createPushSender({ store, publicKey: 'pub', privateKey: 'priv', setVapidDetails: () => {}, send: async () => { calls += 1; } });

  await sender.notify('nobody', { title: 'x', body: 'y' });
  assert.equal(calls, 0);
});

test('loadOrCreateVapidKeys generates encrypted credentials once and preserves them across calls', () => {
  const dir = tempDir();
  const keyFile = `${dir}.master-key`;
  fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  try {
    const cipher = readyCipher(dir, keyFile, { initialize: true });
    const first = loadOrCreateVapidKeys(dir, cipher);
    assert.match(first.publicKey, /^[A-Za-z0-9_-]+$/);
    assert.match(first.privateKey, /^[A-Za-z0-9_-]+$/);
    assert.ok(fs.existsSync(path.join(dir, 'vapid_key.json')));
    assert.equal(fs.readFileSync(path.join(dir, 'vapid_key.json'), 'utf8').includes(first.privateKey), false);

    const second = loadOrCreateVapidKeys(dir, cipher);
    assert.deepEqual(second, first);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
  }
});

test('a call is never sent as a web push: no browser can answer it', async () => {
  const store = fakeStore({ anna: [{ endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } }] });
  let calls = 0;
  const sender = createPushSender({
    store, publicKey: 'pub', privateKey: 'priv', setVapidDetails: () => {}, send: async () => { calls += 1; },
  });
  await sender.notify('anna', { kind: 'call', callId: 'c1', peer: 'boris', title: 'Boris' });
  assert.equal(calls, 0);
});
