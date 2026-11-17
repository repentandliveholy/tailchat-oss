// The browser on the core, behind its flag (stage 7, step 3): the shared
// routing table, the page-side bridge `web/cloud/core/web-session.js` that
// app.js dials instead of a WebSocket, and that bridge on the real wasm against
// an isolated cloud. The wasm half is skipped when `npm run build:web-core` has
// not been run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createAccountStore } from '../src/cloud/accounts.js';
import { createCloudHub } from '../src/cloud/hub.js';
import { createCloudService } from '../src/cloud/server.js';
import { memoryStorage } from '../web/cloud/core/core-client.js';
import { ownsInbound, rememberRawSent, routeOutbound, RAW_SENT_LIMIT } from '../web/cloud/core/routing.js';
import {
  acquireCoreLock, coreStoreName, createCoreBridge, startWebCoreSession,
} from '../web/cloud/core/web-session.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = path.join(root, 'web', 'cloud', 'core', 'pkg');
const built = fs.existsSync(path.join(pkg, 'tailchat_web_bg.wasm'));
const skip = built ? false : 'web core not built (npm run build:web-core)';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- routing ---------------------------------------------------------------

test('a message sent raw keeps its acceptance; one sent through the core does not', () => {
  const accepted = JSON.stringify({ k: 'message-accepted', peer: 'bob', id: 'm-reply', ts: 5 });
  assert.equal(ownsInbound(accepted), true, 'the core owns acceptance by default');
  const rawSent = new Set();
  rememberRawSent(rawSent, 'm-reply');
  assert.equal(ownsInbound(accepted, rawSent), false, 'a reply the core never saw: its sender hears it');
  const other = JSON.stringify({ k: 'message-accepted', peer: 'bob', id: 'm-text', ts: 5 });
  assert.equal(ownsInbound(other, rawSent), true);
});

test('the raw-sent memory is bounded, oldest first out', () => {
  const rawSent = new Set();
  for (let i = 0; i <= RAW_SENT_LIMIT; i += 1) rememberRawSent(rawSent, `m-${i}`);
  assert.equal(rawSent.size, RAW_SENT_LIMIT);
  assert.equal(rawSent.has('m-0'), false);
  assert.equal(rawSent.has(`m-${RAW_SENT_LIMIT}`), true);
});

test('the page\'s plain text goes to the core, a reply stays raw, auth/sync/ack are swallowed', () => {
  const frame = (d) => JSON.stringify({ k: 'frame', to: 'bob', d });
  assert.deepEqual(routeOutbound(JSON.stringify({ k: 'auth', token: 't', webFeatures: true })), { route: 'swallow' });
  assert.deepEqual(routeOutbound(JSON.stringify({ k: 'sync', since: 0 })), { route: 'swallow' });
  assert.deepEqual(routeOutbound(frame({ t: 'ack', id: 'm-1' })), { route: 'swallow' });
  assert.deepEqual(routeOutbound(frame({ t: 'msg', id: 'm-1', ts: 1, text: 'hi' })), { route: 'text', peer: 'bob', id: 'm-1', text: 'hi' });
  assert.deepEqual(
    routeOutbound(frame({ t: 'msg', id: 'm-2', ts: 1, text: 'hi', replyTo: { id: 'm-1' } })),
    { route: 'raw', sent: { peer: 'bob', id: 'm-2' } },
  );
  assert.deepEqual(routeOutbound(frame({ t: 'read', id: 'm-1', readTs: 1 })), { route: 'raw' });
});

// --- the bridge, with a stand-in client -------------------------------------

function fakeClient() {
  const calls = [];
  return {
    calls,
    sendText(id, peer, text) { calls.push(['sendText', id, peer, text]); },
    sendWith(id, peer, text, options) {
      if (options?.fail) throw new Error('invalid-argument: refused');
      calls.push(['sendWith', id, peer, text, options]);
    },
    editText(id, peer, target, text) {
      if (text === 'fail') throw new Error('invalid-argument: refused');
      calls.push(['editText', id, peer, target, text]);
    },
    sendRaw(raw) { calls.push(['sendRaw', JSON.parse(raw)]); },
    conversation(peer, limit) { calls.push(['conversation', peer, limit]); return [{ id: 'x' }]; },
    retry(peer, id) { calls.push(['retry', peer, id]); },
    reconnect() { calls.push(['reconnect']); },
    probe() { calls.push(['probe']); },
    stop() { calls.push(['stop']); },
  };
}

function bridged() {
  const events = [];
  const bridge = createCoreBridge({ onEvent: (e) => events.push(e) });
  const client = fakeClient();
  bridge.attach(client);
  return { bridge, client, events };
}

function listen(socket) {
  const seen = [];
  socket.onopen = () => seen.push(['open']);
  socket.onmessage = (event) => seen.push(['message', event.data]);
  socket.onclose = () => seen.push(['close']);
  return seen;
}

test('the page\'s socket opens with the core\'s connection and closes with it', async () => {
  const { bridge } = bridged();
  const socket = bridge.connect();
  const seen = listen(socket);
  assert.equal(socket.readyState, 0);
  assert.throws(() => socket.send('{}'), /not open/);
  bridge.notice({ kind: 'connection', state: 'open' });
  await tick();
  assert.equal(socket.readyState, 1);
  bridge.notice({ kind: 'connection', state: 'closed' });
  await tick();
  assert.equal(socket.readyState, 3);
  assert.deepEqual(seen, [['open'], ['close']]);
});

test('a socket asked for after `ready` gets the ready and the roster replayed', async () => {
  const { bridge } = bridged();
  bridge.notice({ kind: 'connection', state: 'open' });
  const readyFrame = JSON.stringify({ k: 'ready', self: { login: 'alice' }, caps: ['sync-v1'] });
  const usersFrame = JSON.stringify({ k: 'users', users: [] });
  bridge.notice({ kind: 'frame', raw: readyFrame });
  bridge.notice({ kind: 'frame', raw: usersFrame });
  bridge.notice({ kind: 'connection', state: 'ready' });
  const socket = bridge.connect();
  const seen = listen(socket);
  await tick();
  assert.deepEqual(seen, [['open'], ['message', readyFrame], ['message', usersFrame]]);
});

test('frames the core owns never reach the page; the rest do, receipts of raw sends included', async () => {
  const { bridge, client } = bridged();
  const socket = bridge.connect();
  const seen = listen(socket);
  bridge.notice({ kind: 'connection', state: 'open' });
  await tick();
  socket.send(JSON.stringify({ k: 'frame', to: 'bob', d: { t: 'msg', id: 'm-r', ts: 1, text: 'hi', replyTo: { id: 'm-0' } } }));
  const owned = [
    { k: 'message-accepted', peer: 'bob', id: 'm-core', ts: 1 },
    { k: 'sync-page', events: [] },
    { k: 'frame', from: 'bob', d: { t: 'ack', id: 'm-core' } },
    { k: 'frame', from: 'bob', d: { t: 'msg', id: 'm-e', e2ee: { v: 1 } } },
  ];
  const handed = [
    { k: 'message-accepted', peer: 'bob', id: 'm-r', ts: 1 },
    { k: 'frame', from: 'bob', d: { t: 'read', id: 'm-r', readTs: 1 } },
    { k: 'frame', from: 'bob', d: { t: 'msg', id: 'm-b', text: 'plain' } },
    { k: 'presence', peer: 'bob', online: true },
  ];
  for (const frame of [...owned, ...handed]) bridge.notice({ kind: 'frame', raw: JSON.stringify(frame) });
  assert.deepEqual(seen.slice(1).map(([, raw]) => JSON.parse(raw)), handed);
  assert.deepEqual(client.calls, [['sendRaw', { k: 'frame', to: 'bob', d: { t: 'msg', id: 'm-r', ts: 1, text: 'hi', replyTo: { id: 'm-0' } } }]]);
});

test('what the page writes is routed: text to the queue, auth/ack swallowed, the rest raw', async () => {
  const { bridge, client } = bridged();
  const socket = bridge.connect();
  bridge.notice({ kind: 'connection', state: 'open' });
  await tick();
  socket.send(JSON.stringify({ k: 'auth', token: 't', webFeatures: true, caps: [] }));
  socket.send(JSON.stringify({ k: 'frame', to: 'bob', d: { t: 'ack', id: 'm-b' } }));
  socket.send(JSON.stringify({ k: 'frame', to: 'bob', d: { t: 'msg', id: 'm-1', ts: 1, text: 'hello' } }));
  socket.send(JSON.stringify({ k: 'who' }));
  assert.deepEqual(client.calls, [['sendText', 'm-1', 'bob', 'hello'], ['sendRaw', { k: 'who' }]]);
  assert.equal(bridge.sendText('bob', 'm-2', 'direct'), true);
  assert.deepEqual(client.calls.at(-1), ['sendText', 'm-2', 'bob', 'direct']);
});

test('sendWith and editText hand the sealed actions to the core, args in the core\'s order', () => {
  const { bridge, client, events } = bridged();
  // `undefined` fields (a reply with no media) are dropped, as JSON would.
  const options = { replyTo: { id: 'm-0', from: 'bob', author: 'Bob', text: 'q', media: undefined } };
  assert.equal(bridge.sendWith('bob', 'm-1', 'answer', options), true);
  assert.deepEqual(client.calls.at(-1), ['sendWith', 'm-1', 'bob', 'answer', { replyTo: { id: 'm-0', from: 'bob', author: 'Bob', text: 'q' } }]);
  assert.equal(bridge.sendWith('bob', 'm-2', 'caption'), true, 'options are optional');
  assert.deepEqual(client.calls.at(-1), ['sendWith', 'm-2', 'bob', 'caption', {}]);
  assert.equal(bridge.editText('bob', 'm-3', 'm-1', 'fixed'), true);
  assert.deepEqual(client.calls.at(-1), ['editText', 'm-3', 'bob', 'm-1', 'fixed']);
  // A call the core throws on is `false`, and a refusal that names it is the
  // page's ⚠: both are tracked like a text.
  assert.equal(bridge.sendWith('bob', 'm-4', 'x', { fail: true }), false);
  assert.equal(bridge.editText('bob', 'm-5', 'm-1', 'fail'), false);
  bridge.notice({ kind: 'action-refused', id: 'm-3', reason: 'pending' });
  assert.deepEqual(events, [{ kind: 'refused', peer: 'bob', id: 'm-3', reason: 'pending' }]);
  assert.equal(client.calls.some((c) => c[0] === 'sendRaw'), false, 'nothing falls back to an open frame');
});

test('a core without the sealed calls says so: false, never an open frame', () => {
  const bridge = createCoreBridge();
  const calls = [];
  bridge.attach({ sendText() { calls.push('sendText'); }, sendRaw() { calls.push('sendRaw'); } });
  assert.equal(bridge.sealedActions, false);
  assert.equal(bridge.sendWith('bob', 'm-1', 'x', {}), false);
  assert.equal(bridge.editText('bob', 'm-2', 'm-1', 'x'), false);
  assert.deepEqual(calls, []);
  const { bridge: full } = bridged();
  assert.equal(full.sealedActions, true);
  full.stop();
  assert.equal(full.sealedActions, true);
  assert.equal(full.sendWith('bob', 'm-3', 'late', {}), false, 'a stopped bridge takes nothing');
  assert.equal(full.editText('bob', 'm-4', 'm-1', 'late'), false);
});

test('the core\'s notices reach the page; a refused send is named, a held one is not a loss', () => {
  const { bridge, events } = bridged();
  bridge.sendText('bob', 'm-1', 'one');
  bridge.sendText('bob', 'm-2', 'two');
  bridge.notice({ kind: 'action-refused', id: 'm-1', reason: 'queue full' });
  bridge.notice({ kind: 'action-refused', id: 'm-2', held: true, reason: 'duplicate' });
  bridge.notice({ kind: 'action-refused', reason: 'not a send' });
  const receipt = { kind: 'receipt', peer: 'bob', id: 'm-3', ts: 9, receipt: 'read' };
  bridge.notice(receipt);
  bridge.notice({ kind: 'stored', peer: 'bob', id: 'm-4' });
  bridge.notice({ kind: 'sas-started', transactionId: 't', peer: 'bob', device: 'D' });
  assert.deepEqual(events, [
    { kind: 'refused', peer: 'bob', id: 'm-1', reason: 'queue full' },
    { kind: 'held', peer: 'bob', id: 'm-2' },
    { kind: 'refused', peer: null, id: null, reason: 'not a send' },
    receipt,
    { kind: 'stored', peer: 'bob', id: 'm-4' },
    { kind: 'sas-started', transactionId: 't', peer: 'bob', device: 'D' },
  ]);
});

test('a stopped bridge closes its socket, stops the client and hears nothing more', async () => {
  const { bridge, client, events } = bridged();
  const socket = bridge.connect();
  const seen = listen(socket);
  bridge.notice({ kind: 'connection', state: 'open' });
  await tick();
  bridge.stop();
  bridge.stop();
  await tick();
  bridge.notice({ kind: 'stored', peer: 'bob', id: 'm' });
  assert.equal(bridge.sendText('bob', 'm-9', 'late'), false);
  assert.deepEqual(seen, [['open'], ['close']]);
  assert.deepEqual(client.calls, [['stop']]);
  assert.deepEqual(events, []);
});

// --- the tab's hold and the store's name -------------------------------------

test('one tab per account holds the core; the second is refused at once', async () => {
  const held = new Set();
  const locks = {
    async request(name, options, callback) {
      assert.equal(options.ifAvailable, true);
      if (held.has(name)) return callback(null);
      held.add(name);
      await callback({ name });
      held.delete(name);
      return undefined;
    },
  };
  const release = await acquireCoreLock('alice', locks);
  await assert.rejects(acquireCoreLock('alice', locks), /another tab/);
  const other = await acquireCoreLock('bob', locks);
  release();
  await tick();
  const again = await acquireCoreLock('alice', locks);
  again();
  other();
  await assert.rejects(acquireCoreLock('alice', {}), /no Web Locks/);
});

test('a new token is a new store; the token itself is not in the name', async () => {
  const a = await coreStoreName('Alice', 'a'.repeat(64));
  const b = await coreStoreName('alice', 'b'.repeat(64));
  assert.match(a, /^alice\.[0-9a-f]{32}$/);
  assert.notEqual(a, b);
  assert.equal(a, await coreStoreName('alice', 'a'.repeat(64)));
  assert.ok(!a.includes('aaaa'));
});

// --- on the real wasm --------------------------------------------------------

let wasmModule = null;
async function wasm() {
  if (!wasmModule) {
    wasmModule = await import(path.join(pkg, 'tailchat_web.js'));
    wasmModule.initSync({ module: fs.readFileSync(path.join(pkg, 'tailchat_web_bg.wasm')) });
  }
  return wasmModule;
}

async function startService(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-websession-data-'));
  const keyFile = `${dir}.master-key`;
  fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-websession-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html>\n');
  const store = createAccountStore({ dir, keyFile, initialize: true });
  const hub = createCloudHub({ store });
  const service = createCloudService({
    host: '127.0.0.1', port: 0, dataDir: dir, webRoot, store, hub, trustProxy: true, ownerLogin: null,
  });
  const address = await service.listen();
  context.after(async () => {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
    fs.rmSync(webRoot, { recursive: true, force: true });
  });
  return { store, port: address.port };
}

function register(port, login) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ login, password: 'correct horse', name: login });
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/tailchat/api/register',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.once('end', () => resolve(JSON.parse(text).token));
    });
    req.once('error', reject);
    req.end(payload);
  });
}

function collector(what) {
  const items = [];
  const emitter = new EventEmitter();
  return {
    items,
    push(item) {
      items.push(item);
      emitter.emit('item', item);
    },
    waitFor(predicate, timeoutMs = 8000) {
      const found = items.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          emitter.off('item', onItem);
          reject(new Error(`timed out waiting for a ${what}; saw ${JSON.stringify(items).slice(0, 3000)}`));
        }, timeoutMs);
        const onItem = (item) => {
          if (!predicate(item)) return;
          clearTimeout(timer);
          emitter.off('item', onItem);
          resolve(item);
        };
        emitter.on('item', onItem);
      });
    },
  };
}

test('the page on the wasm core: dials as a browser, sends through the queue, reads and is read', { skip, timeout: 30_000 }, async (context) => {
  const { port, store } = await startService(context);
  const aliceToken = await register(port, 'alice');
  const bobToken = await register(port, 'bob');
  store.linkFriends('alice', 'bob');

  // Bob: a classic socket with the conversation open.
  const bobFrames = collector('bob frame');
  const bob = new WebSocket(`ws://127.0.0.1:${port}/tailchat/ws`);
  bob.on('message', (data) => bobFrames.push(JSON.parse(String(data))));
  await once(bob, 'open');
  context.after(() => bob.close());
  bob.send(JSON.stringify({ k: 'auth', token: bobToken, caps: ['addressed-send', 'durable-ack'] }));
  await bobFrames.waitFor((f) => f.k === 'ready');
  bob.send(JSON.stringify({ k: 'subscribe', peer: 'alice' }));
  await bobFrames.waitFor((f) => f.k === 'subscribed');

  // Alice: what app.js does under the flag.
  const events = collector('core event');
  const session = await startWebCoreSession({
    wasm: await wasm(),
    storage: memoryStorage(),
    onEvent: (e) => events.push(e),
    account: {
      login: 'alice',
      token: aliceToken,
      socketUrl: `ws://127.0.0.1:${port}/tailchat/ws`,
      httpBase: `http://127.0.0.1:${port}/tailchat`,
      extraCaps: ['durable-ack', 'addressed-send', 'sync-v1', 'sync-nudge-v1', 'read-ack-v1'],
    },
  });
  context.after(() => session.stop());
  const page = collector('page frame');
  const socket = session.connect();
  socket.onopen = () => socket.send(JSON.stringify({ k: 'auth', token: aliceToken, webFeatures: true, caps: [] }));
  socket.onmessage = (event) => page.push(JSON.parse(event.data));
  const ready = await page.waitFor((f) => f.k === 'ready');
  assert.equal(ready.self.login, 'alice');
  assert.ok(ready.caps.includes('sync-v1'), 'the page learns the server\'s capabilities from the core\'s ready');
  // The page opens the conversation, as `subscribeActivePeer` does.
  socket.send(JSON.stringify({ k: 'subscribe', peer: 'bob' }));
  await page.waitFor((f) => f.k === 'subscribed' && f.peer === 'bob');

  // Out: a plain text through the socket goes into the core's queue.
  socket.send(JSON.stringify({ k: 'frame', to: 'bob', d: { t: 'msg', id: 'm-a1', ts: Date.now(), text: 'from the page' } }));
  await events.waitFor((e) => e.kind === 'message-added' && e.id === 'm-a1');
  assert.equal((await bobFrames.waitFor((f) => f.d?.id === 'm-a1')).d.text, 'from the page');
  await events.waitFor((e) => e.kind === 'receipt' && e.id === 'm-a1' && e.receipt === 'sent');
  assert.equal(page.items.some((f) => f.k === 'message-accepted'), false, 'the core\'s acceptance stays the core\'s');

  // Bob's device acks and reads: the marks come from the core, not the wire.
  bob.send(JSON.stringify({ k: 'frame', to: 'alice', d: { t: 'ack', id: 'm-a1' } }));
  await events.waitFor((e) => e.kind === 'receipt' && e.id === 'm-a1' && e.receipt === 'delivered');

  // In: Bob's message reaches the page as a frame; the page's ack is swallowed
  // (the core acks once the row is stored) and Bob still gets one.
  bob.send(JSON.stringify({ k: 'frame', to: 'alice', d: { t: 'msg', id: 'm-b1', ts: Date.now(), text: 'hi page' } }));
  const incoming = await page.waitFor((f) => f.k === 'frame' && f.d?.id === 'm-b1');
  assert.equal(incoming.d.text, 'hi page');
  socket.send(JSON.stringify({ k: 'frame', to: 'bob', d: { t: 'ack', id: 'm-b1' } }));
  await bobFrames.waitFor((f) => f.k === 'frame' && f.d?.t === 'ack' && f.d.id === 'm-b1');

  // The page reads it: a raw `read`, and the server names the reader a browser —
  // which it knows only from `webFeatures` in the core's own `auth`.
  socket.send(JSON.stringify({ k: 'frame', to: 'bob', d: { t: 'read', id: 'm-b1', readTs: incoming.d.ts } }));
  const read = await bobFrames.waitFor((f) => f.k === 'frame' && f.d?.t === 'read' && f.d.id === 'm-b1');
  assert.equal(read.d.via, 'web');
  await page.waitFor((f) => f.k === 'read-accepted' && f.peer === 'bob');

  // A reply goes raw; its acceptance reaches the page, which keeps it queued.
  socket.send(JSON.stringify({ k: 'frame', to: 'bob', d: { t: 'msg', id: 'm-a2', ts: Date.now(), text: 're', replyTo: { id: 'm-b1', from: 'bob', text: 'hi page' } } }));
  await page.waitFor((f) => f.k === 'message-accepted' && f.id === 'm-a2');

  assert.deepEqual(session.conversation('bob', 10).map((r) => r.id), ['m-a1', 'm-b1']);
});
