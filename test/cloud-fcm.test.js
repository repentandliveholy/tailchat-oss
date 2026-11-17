import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import { createFcmSender, createCombinedPushSender } from '../src/cloud/fcm.js';

const SCOPE = 'a'.repeat(64);

function fakeStore(tokens = {}) {
  const state = new Map(Object.entries(tokens));
  const removed = [];
  return {
    fcmTokens: (login) => state.get(login) ?? [],
    removeFcmToken: (login, token) => {
      removed.push([login, token]);
      const kept = (state.get(login) ?? []).filter((t) => t.token !== token);
      if (kept.length > 0) state.set(login, kept);
      else state.delete(login);
      return true;
    },
    removed,
  };
}

test('with no service account, the sender is disabled and never calls send', async () => {
  const store = fakeStore({ anna: [{ token: 'tok-1' }] });
  let calls = 0;
  const sender = createFcmSender({ store, send: async () => { calls += 1; } });

  assert.equal(sender.enabled, false);
  await sender.notify('anna', { title: 'x', body: 'y' });
  assert.equal(calls, 0);
});

// Regression: without an injected `send`, `createFcmSender` builds a real
// `firebase-admin/app` + `firebase-admin/messaging` client from the service
// account — this is the exact construction path a production incident hit
// (`admin.credential.cert` — the old namespaced API — is not what this
// package's ESM exports expose; the fix is the modular
// `import { cert } from 'firebase-admin/app'`). This never calls `.send()`
// (no network I/O in a unit test), only proves construction itself does not
// throw for a structurally valid service account.
test('a real (non-injected) sender builds without throwing given a valid-shaped service account', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const store = fakeStore({});
  const sender = createFcmSender({
    serviceAccount: {
      project_id: 'tailchat-test',
      private_key: privateKey,
      client_email: 'test@tailchat-test.iam.gserviceaccount.com',
    },
    store,
  });
  assert.equal(sender.enabled, true);
});

test('a configured sender delivers to every token of the recipient', async () => {
  const store = fakeStore({
    anna: [{ token: 'tok-1', scope: SCOPE }, { token: 'tok-2', scope: SCOPE }],
  });
  const calls = [];
  const sender = createFcmSender({
    serviceAccount: { project_id: 'test-project', private_key: 'x' },
    store,
    send: async (message) => { calls.push(message); },
  });

  assert.equal(sender.enabled, true);
  await sender.notify('anna', {
    title: 'Anna', body: 'hi', peer: 'anna', messageId: 'm-1', tag: 'tailchat-msg-anna',
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.token).sort(), ['tok-1', 'tok-2']);
  // Data-only on purpose: an FCM `notification` block is rendered by the OS
  // itself whenever the app is not foregrounded, which put a second tray
  // entry beside ChatService's own notification for the same message.
  assert.equal(calls[0].notification, undefined);
  assert.deepEqual(calls[0].data, {
    peer: 'anna',
    messageId: 'm-1',
    login: 'anna',
    scope: SCOPE,
    tag: 'tailchat-msg-anna',
  });
});

test('an unregistered-token error prunes that token without touching the others', async () => {
  const store = fakeStore({
    anna: [{ token: 'stale' }, { token: 'fresh' }],
  });
  const sender = createFcmSender({
    serviceAccount: { project_id: 'test-project', private_key: 'x' },
    store,
    send: async (message) => {
      if (message.token === 'stale') {
        const error = new Error('not registered');
        error.code = 'messaging/registration-token-not-registered';
        throw error;
      }
    },
  });

  await sender.notify('anna', { title: 'x', body: 'y' });
  assert.deepEqual(store.removed, [['anna', 'stale']]);
});

test('a transient failure leaves every token in place', async () => {
  const store = fakeStore({ anna: [{ token: 'tok-1' }] });
  const sender = createFcmSender({
    serviceAccount: { project_id: 'test-project', private_key: 'x' },
    store,
    send: async () => {
      const error = new Error('rate limited');
      error.code = 'messaging/internal-error';
      throw error;
    },
  });

  await sender.notify('anna', { title: 'x', body: 'y' });
  assert.equal(store.removed.length, 0);
});

test('notify on a recipient with no tokens never calls send', async () => {
  const store = fakeStore({});
  let calls = 0;
  const sender = createFcmSender({
    serviceAccount: { project_id: 'test-project', private_key: 'x' },
    store,
    send: async () => { calls += 1; },
  });

  await sender.notify('nobody', { title: 'x', body: 'y' });
  assert.equal(calls, 0);
});

test('createCombinedPushSender fans out to every configured channel', async () => {
  const calls = [];
  const webPush = { enabled: true, notify: async (login, payload) => { calls.push(['web', login, payload]); }, publicKey: () => 'pub' };
  const fcm = { enabled: true, notify: async (login, payload) => { calls.push(['fcm', login, payload]); } };
  const combined = createCombinedPushSender(webPush, fcm);

  assert.equal(combined.enabled, true);
  assert.equal(combined.publicKey(), 'pub');
  await combined.notify('anna', { title: 'x', body: 'y' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c[0]).sort(), ['fcm', 'web']);
});

test('createCombinedPushSender is disabled only when every channel is disabled', () => {
  const disabled = createCombinedPushSender({ enabled: false }, { enabled: false });
  assert.equal(disabled.enabled, false);
  const partial = createCombinedPushSender({ enabled: false }, { enabled: true });
  assert.equal(partial.enabled, true);
});

test('one channel throwing does not stop the other from being tried', async () => {
  const calls = [];
  const failing = { enabled: true, notify: async () => { throw new Error('boom'); } };
  const working = { enabled: true, notify: async (login) => { calls.push(login); } };
  const combined = createCombinedPushSender(failing, working);

  await combined.notify('anna', { title: 'x', body: 'y' });
  assert.deepEqual(calls, ['anna']);
});

test('a call payload is high priority, expires with the caller ring, and carries no notification block', async () => {
  const store = fakeStore({ anna: [{ token: 'tok-1', scope: SCOPE }] });
  const calls = [];
  const sender = createFcmSender({
    serviceAccount: { project_id: 'test-project', private_key: 'x' },
    store,
    send: async (message) => { calls.push(message); },
  });
  await sender.notify('anna', { kind: 'call', callId: 'c-1', peer: 'boris', title: 'Boris' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].notification, undefined);
  // Not 0: a device unreachable for the instant of the send (radio handoff,
  // tunnel blip) had its call push discarded outright and never rang.
  assert.deepEqual(calls[0].android, { priority: 'high', ttl: 45_000 });
  assert.deepEqual(calls[0].data, { kind: 'call', callId: 'c-1', peer: 'boris', login: 'anna', scope: SCOPE });
});

test('a reply reminder wakes Android by routing identity without replaying message content', async () => {
  const store = fakeStore({ anna: [{ token: 'tok-1', scope: SCOPE }] });
  const calls = [];
  const sender = createFcmSender({
    serviceAccount: { project_id: 'test-project', private_key: 'x' },
    store,
    send: async (message) => { calls.push(message); },
  });
  await sender.notify('anna', {
    kind: 'reply-reminder',
    peer: 'boris',
    messageId: 'm-1',
    reminderId: 'r-1',
    title: 'private title',
    body: 'private body',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].notification, undefined);
  assert.deepEqual(calls[0].data, {
    kind: 'reply-reminder',
    peer: 'boris',
    messageId: 'm-1',
    reminderId: 'r-1',
    login: 'anna',
    scope: SCOPE,
  });
});
