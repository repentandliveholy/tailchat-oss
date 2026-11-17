// The core in the browser (stage 7): the real `tailchat-web` WebAssembly with
// `web/cloud/core/core-client.js` as its host, against an isolated cloud.
// Node stands in for the page: its global WebSocket and fetch are the
// browser's own APIs; the storage is the in-memory one (IndexedDB has its own
// check in a real browser, see docs/worklog.md).
//
// The wasm is built on demand (`npm run build:web-core`, not in git); without
// it these tests are skipped, not failed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { createAccountStore } from '../src/cloud/accounts.js';
import { createCloudHub } from '../src/cloud/hub.js';
import { createCloudService } from '../src/cloud/server.js';
import { memoryStorage, openCore } from '../web/cloud/core/core-client.js';
import { startWebCoreSession } from '../web/cloud/core/web-session.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = path.join(root, 'web', 'cloud', 'core', 'pkg');
const built = fs.existsSync(path.join(pkg, 'tailchat_web_bg.wasm'));
const skip = built ? false : 'web core not built (npm run build:web-core)';

let wasmModule = null;
async function wasm() {
  if (!wasmModule) {
    wasmModule = await import(path.join(pkg, 'tailchat_web.js'));
    wasmModule.initSync({ module: fs.readFileSync(path.join(pkg, 'tailchat_web_bg.wasm')) });
  }
  return wasmModule;
}

async function startService(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-webcore-data-'));
  const keyFile = `${dir}.master-key`;
  fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-webcore-web-'));
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

function post(port, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: requestPath,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.once('end', () => resolve({ status: response.statusCode, json: JSON.parse(text || 'null') }));
    });
    req.once('error', reject);
    req.end(payload);
  });
}

async function account(port, login) {
  const response = await post(port, '/tailchat/api/register', { login, password: 'correct horse', name: login });
  assert.equal(response.status, 201);
  return response.json.token;
}

/** Waits for the first item of a growing list that matches. */
function waiter(list, emitter, what) {
  return (predicate, timeoutMs = 5000) => {
    const found = list.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        emitter.off('item', onItem);
        reject(new Error(`timed out waiting for a ${what}; saw ${JSON.stringify(list).slice(0, 3000)}`));
      }, timeoutMs);
      const onItem = (item) => {
        if (!predicate(item)) return;
        clearTimeout(timer);
        emitter.off('item', onItem);
        resolve(item);
      };
      emitter.on('item', onItem);
    });
  };
}

/** A classic WebSocket client: the other side of the conversation. */
async function classic(port, token, context, subscribeTo) {
  const frames = [];
  const emitter = new EventEmitter();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/tailchat/ws`);
  socket.on('message', (data) => {
    const frame = JSON.parse(String(data));
    frames.push(frame);
    emitter.emit('item', frame);
  });
  await once(socket, 'open');
  context.after(() => socket.close());
  const peer = {
    frames,
    waitFor: waiter(frames, emitter, 'frame'),
    send(payload) { socket.send(JSON.stringify(payload)); },
  };
  peer.send({ k: 'auth', token, caps: ['addressed-send'] });
  await peer.waitFor((f) => f.k === 'ready');
  // Live frames of a conversation reach only a socket that has it open.
  if (subscribeTo) peer.send({ k: 'subscribe', peer: subscribeTo });
  return peer;
}

/** A core client on the wasm, with its notices collected. */
async function core(port, login, token, context, storage = memoryStorage(), extra = {}) {
  const notices = [];
  const emitter = new EventEmitter();
  const client = await openCore({
    wasm: await wasm(),
    account: {
      login,
      token,
      socketUrl: `ws://127.0.0.1:${port}/tailchat/ws`,
      httpBase: `http://127.0.0.1:${port}/tailchat`,
      ...extra.account,
    },
    storage,
    onNotice(notice) {
      notices.push(notice);
      emitter.emit('item', notice);
    },
    ...extra.host,
  });
  context.after(() => client.stop());
  return { client, notices, storage, waitFor: waiter(notices, emitter, 'notice') };
}

const ready = (n) => n.kind === 'connection' && n.state === 'ready';

test('a message goes out through the wasm core, comes back as rows, and survives a reload', { skip }, async (context) => {
  const { port, store } = await startService(context);
  const aliceToken = await account(port, 'alice');
  const bobToken = await account(port, 'bob');
  store.linkFriends('alice', 'bob');
  const bob = await classic(port, bobToken, context, 'alice');

  const alice = await core(port, 'alice', aliceToken, context);
  await alice.waitFor(ready);

  alice.client.sendText('m-web-1', 'bob', 'hello from wasm');
  await alice.waitFor((n) => n.kind === 'message-added' && n.id === 'm-web-1' && n.receipt === 'queued');
  const relayed = await bob.waitFor((f) => f.k === 'frame' && f.d?.id === 'm-web-1');
  assert.equal(relayed.d.text, 'hello from wasm');
  await alice.waitFor((n) => n.kind === 'receipt' && n.id === 'm-web-1' && n.receipt === 'sent');

  bob.send({ k: 'frame', to: 'alice', d: { t: 'msg', id: 'm-bob-1', text: 'hi back', ts: Date.now() } });
  await alice.waitFor((n) => n.kind === 'stored' && n.id === 'm-bob-1');

  const rows = alice.client.conversation('bob', 50);
  assert.deepEqual(rows.map((r) => [r.source, r.id, r.text]), [
    ['sent', 'm-web-1', 'hello from wasm'],
    ['message', 'm-bob-1', 'hi back'],
  ]);
  // The feed brought the rest of the account too: registration's menu from
  // the service account (AGENTS §9), the one message nobody asked for.
  assert.deepEqual(alice.client.peers(), ['bob', 'tailchat']);
  assert.deepEqual(alice.client.conversation('tailchat', 50).map((r) => r.id), ['service-menu-v1']);

  // A reload: the same records, a new client. Nothing is lost, nothing doubles.
  alice.client.stop();
  const records = new Map(alice.storage.records);
  assert.ok(records.size > 0, 'the journal reached the storage');
  const again = await core(port, 'alice', aliceToken, context, memoryStorage(records));
  assert.deepEqual(
    again.client.conversation('bob', 50).map((r) => [r.source, r.id]),
    [['sent', 'm-web-1'], ['message', 'm-bob-1']],
  );
  await again.waitFor(ready);
  // Paging: older than the newest row, one at a time.
  const newest = again.client.conversation('bob', 1);
  assert.deepEqual(newest.map((r) => r.id), ['m-bob-1']);
  const older = again.client.conversation('bob', 1, newest[0].ts, newest[0].id);
  assert.deepEqual(older.map((r) => r.id), ['m-web-1']);
});

test('nothing leaves the device before the journal that covers it is durable', { skip }, async (context) => {
  const { port, store } = await startService(context);
  const aliceToken = await account(port, 'alice');
  const bobToken = await account(port, 'bob');
  store.linkFriends('alice', 'bob');
  const bob = await classic(port, bobToken, context, 'alice');

  // A slow disk: every commit takes 150 ms. The frame must still reach the
  // peer only after the commit that holds its queue row has finished.
  const order = [];
  const storage = memoryStorage();
  const commit = storage.commit;
  let refuse = false;
  storage.commit = async (entries) => {
    const keys = entries.map((e) => e.key);
    order.push({ at: 'begin', keys });
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (refuse) throw new Error('disk full');
    await commit(entries);
    order.push({ at: 'end', keys });
  };
  const alice = await core(port, 'alice', aliceToken, context, storage);
  await alice.waitFor(ready);

  alice.client.sendText('m-1', 'bob', 'durable first');
  await bob.waitFor((f) => f.k === 'frame' && f.d?.id === 'm-1');
  const arrived = order.length;
  const covering = order.findIndex((o) => o.at === 'end' && o.keys.includes('["pending","bob","m-1"]'));
  assert.ok(covering !== -1 && covering < arrived, JSON.stringify(order));

  // A disk that refuses: the message is never written to the socket, and the
  // page hears that the store failed.
  refuse = true;
  alice.client.sendText('m-2', 'bob', 'never sent');
  await alice.waitFor((n) => n.kind === 'storage-failed');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(bob.frames.some((f) => f.d?.id === 'm-2'), false, 'nothing reached the peer');
});

test('two wasm cores talk end-to-end encrypted; the server keeps only the placeholder', { skip, timeout: 30_000 }, async (context) => {
  const { port, store } = await startService(context);
  const aliceToken = await account(port, 'alice');
  const bobToken = await account(port, 'bob');
  store.linkFriends('alice', 'bob');
  const e2ee = { account: { e2ee: true } };
  const alice = await core(port, 'alice', aliceToken, context, memoryStorage(), e2ee);
  const bob = await core(port, 'bob', bobToken, context, memoryStorage(), e2ee);
  await alice.waitFor((n) => n.kind === 'device-registered', 15_000);
  await bob.waitFor((n) => n.kind === 'device-registered', 15_000);

  alice.client.sendText('m-secret', 'bob', 'only bob reads this');
  const stored = await bob.waitFor((n) => n.kind === 'stored' && n.id === 'm-secret', 15_000);
  assert.equal(stored.peer, 'alice');
  const [row] = bob.client.conversation('alice', 50).filter((r) => r.id === 'm-secret');
  assert.equal(row.text, 'only bob reads this');
  assert.equal(row.protection, 'encrypted');

  const history = await new Promise((resolve, reject) => {
    http.get({
      host: '127.0.0.1', port, path: '/tailchat/api/history?peer=alice&limit=50',
      headers: { Authorization: `Bearer ${bobToken}` },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.once('end', () => resolve(text));
    }).once('error', reject);
  });
  assert.ok(history.includes('m-secret'), history.slice(0, 500));
  assert.equal(history.includes('only bob reads this'), false, 'the server never saw the text');
});

test('native and wasm cores exchange encrypted pictures and retain them after reopening', {
  skip: skip || (!fs.existsSync(path.join(root, 'native/tailchat_core.node')) && 'native core not built'),
  timeout: 30_000,
}, async (context) => {
  let bob;
  context.after(() => bob?.close());
  const { port, store } = await startService(context);
  const aliceToken = await account(port, 'alice');
  const bobToken = await account(port, 'bob');
  store.linkFriends('alice', 'bob');
  const alice = await core(port, 'alice', aliceToken, context, memoryStorage(), { account: { e2ee: true } });
  const native = createRequire(import.meta.url)(path.join(root, 'native/tailchat_core.node'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taily-native-wasm-'));
  const options = {
    login: 'bob', token: bobToken, key: randomBytes(32), dbPath: path.join(dir, 'bob.db'),
    socketUrl: `ws://127.0.0.1:${port}/tailchat/ws`, httpBase: `http://127.0.0.1:${port}/tailchat`,
    extraCaps: ['sync-v1', 'read-ack-v1'], e2ee: true, deviceName: 'Test native',
  };
  const notices = [];
  const emitter = new EventEmitter();
  const onNotice = (notice) => { notices.push(notice); emitter.emit('item', notice); };
  bob = native.open(options, onNotice);
  context.after(() => { bob.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const waitBob = waiter(notices, emitter, 'native notice');
  await Promise.all([
    alice.waitFor((n) => n.kind === 'device-registered', 15_000),
    waitBob((n) => n.kind === 'device-registered', 15_000),
  ]);
  const picture = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  alice.client.sendImage('wasm-picture', 'bob', '', picture, 1, 1);
  await waitBob((n) => n.kind === 'stored' && n.id === 'wasm-picture', 15_000);
  let row = bob.conversation('alice', 50).find((r) => r.id === 'wasm-picture');
  assert.equal(row.image.dataUrl, picture);
  assert.equal(row.protection, 'encrypted');
  assert.equal(row.text, '', 'a captionless picture remains a picture');
  bob.sendImage('native-picture', 'alice', 'caption', picture, 1, 1);
  await alice.waitFor((n) => n.kind === 'stored' && n.id === 'native-picture', 15_000);
  row = alice.client.conversation('bob', 50).find((r) => r.id === 'native-picture');
  assert.equal(row.image.dataUrl, picture);
  assert.equal(row.protection, 'encrypted');
  assert.equal(row.text, 'caption');
  await waitBob((n) => n.kind === 'receipt' && n.id === 'native-picture' && n.receipt === 'sent');

  const history = await fetch(`http://127.0.0.1:${port}/tailchat/api/history?peer=bob&limit=50`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  }).then((r) => r.text());
  assert.ok(history.includes('wasm-picture') && history.includes('native-picture'));
  assert.equal(history.includes('data:image/'), false, 'the server holds neither image');
  assert.equal(history.includes('caption'), false, 'the caption stays encrypted too');

  bob.close();
  bob = native.open(options, onNotice);
  const reopened = bob.conversation('alice', 50);
  assert.equal(reopened.find((r) => r.id === 'wasm-picture').image.dataUrl, picture);
  assert.equal(reopened.find((r) => r.id === 'native-picture').image.dataUrl, picture);
  alice.client.stop();
  const again = await core(port, 'alice', aliceToken, context, memoryStorage(alice.storage.records), { account: { e2ee: true } });
  assert.equal(again.client.conversation('bob', 50).find((r) => r.id === 'native-picture').image.dataUrl, picture);
});

test('quotes, forwards, voice notes and edits travel sealed between the native and wasm cores', {
  skip: skip || (!fs.existsSync(path.join(root, 'native/tailchat_core.node')) && 'native core not built'),
  timeout: 60_000,
}, async (context) => {
  let bob;
  context.after(() => bob?.close());
  const { port, store } = await startService(context);
  const aliceToken = await account(port, 'alice');
  const bobToken = await account(port, 'bob');
  store.linkFriends('alice', 'bob');
  const alice = await core(port, 'alice', aliceToken, context, memoryStorage(), { account: { e2ee: true } });
  const native = createRequire(import.meta.url)(path.join(root, 'native/tailchat_core.node'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-sealed-actions-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = {
    login: 'bob', token: bobToken, key: randomBytes(32), dbPath: path.join(dir, 'bob.db'),
    socketUrl: `ws://127.0.0.1:${port}/tailchat/ws`, httpBase: `http://127.0.0.1:${port}/tailchat`,
    extraCaps: ['sync-v1', 'read-ack-v1'], e2ee: true, deviceName: 'Test native',
  };
  const notices = [];
  const emitter = new EventEmitter();
  const onNotice = (notice) => { notices.push(notice); emitter.emit('item', notice); };
  bob = native.open(options, onNotice);
  const waitBob = waiter(notices, emitter, 'native notice');
  await Promise.all([
    alice.waitFor((n) => n.kind === 'device-registered', 15_000),
    waitBob((n) => n.kind === 'device-registered', 15_000),
  ]);
  const aliceRow = (id) => alice.client.conversation('bob', 100).find((r) => r.id === id);
  const bobRow = (id) => bob.conversation('alice', 100).find((r) => r.id === id);

  alice.client.sendText('w-0', 'bob', 'исходный текст');
  await waitBob((n) => n.kind === 'stored' && n.id === 'w-0', 15_000);

  // A reply from the native side, its quote inside the ciphertext.
  bob.sendWith('n-1', 'alice', 'ответ на цитату', {
    replyTo: { id: 'w-0', from: 'alice', text: 'исходный текст', author: 'Alice' },
    forwardedFrom: null,
  });
  await alice.waitFor((n) => n.kind === 'stored' && n.id === 'n-1', 15_000);
  assert.deepEqual(aliceRow('n-1').replyTo, { id: 'w-0', from: 'alice', text: 'исходный текст' });
  assert.equal(aliceRow('n-1').protection, 'encrypted');

  // A forward and a voice note from the wasm side.
  alice.client.sendWith('w-fwd', 'bob', 'пересланные слова', { forwardedFrom: { login: 'carol', name: 'Кэрол' } });
  const voice = { dataUrl: `data:audio/mp4;base64,${Buffer.from('голосовые байты').toString('base64')}`, duration: 1.5, waveform: [1, 128, 255] };
  alice.client.sendWith('w-voice', 'bob', '', { voice });
  await waitBob((n) => n.kind === 'stored' && n.id === 'w-voice', 15_000);
  assert.deepEqual(bobRow('w-fwd').forwardedFrom, { login: 'carol', name: 'Кэрол' });
  assert.equal(bobRow('w-voice').voice.dataUrl, voice.dataUrl);
  assert.equal(bobRow('w-voice').voice.duration, 1.5);

  // Edits both ways: the target changes on both sides, the carrier row is
  // kept and names its target, and the author's own queue says so too.
  alice.client.editText('w-edit', 'bob', 'w-0', 'новый текст');
  const added = await alice.waitFor((n) => n.kind === 'message-added' && n.id === 'w-edit');
  assert.equal(added.editOf, 'w-0');
  assert.equal(aliceRow('w-0').text, 'новый текст', 'the author sees the edit at once');
  await waitBob((n) => n.kind === 'stored' && n.id === 'w-edit', 15_000);
  assert.equal(bobRow('w-0').text, 'новый текст');
  assert.ok(bobRow('w-0').editedAt > 0);
  assert.equal(bobRow('w-edit').editOf, 'w-0');
  bob.editText('n-edit', 'alice', 'n-1', 'исправленный ответ');
  await alice.waitFor((n) => n.kind === 'stored' && n.id === 'n-edit', 15_000);
  assert.equal(aliceRow('n-1').text, 'исправленный ответ');
  assert.equal(aliceRow('n-edit').editOf, 'n-1');
  await waitBob((n) => n.kind === 'receipt' && n.id === 'n-edit' && n.receipt === 'sent', 15_000);

  // Malformed options are refused at the call, on both bindings.
  assert.throws(() => bob.sendWith('n-x', 'alice', 'x', { editOf: 'n-1' }), /editText/);
  assert.throws(() => alice.client.sendWith('w-x', 'bob', 'x', { buttons: [] }), /invalid-argument: unknown option/);

  const history = await fetch(`http://127.0.0.1:${port}/tailchat/api/history?peer=bob&limit=50&e2ee=1`, {
    headers: { Authorization: `Bearer ${aliceToken}` },
  }).then((r) => r.json());
  const wire = JSON.stringify(history);
  for (const secret of ['исходный', 'новый текст', 'ответ на цитату', 'исправленный', 'пересланные', 'Кэрол', 'carol',
    'replyTo', 'forwardedFrom', 'editOf', voice.dataUrl.slice(-24)]) {
    assert.equal(wire.includes(secret), false, `the server holds ${secret}`);
  }
  assert.deepEqual(history.messages.filter((m) => m.sealedEdit).map((m) => m.id).sort(), ['n-edit', 'w-edit'],
    'the carriers, and only they, say they are edits');
  assert.ok(history.messages.every((m) => m.e2ee), 'every record is an envelope');

  // Both stores kept the applied edits.
  bob.close();
  bob = native.open(options, onNotice);
  assert.equal(bobRow('w-0').text, 'новый текст');
  assert.equal(bobRow('n-1').text, 'исправленный ответ');
  alice.client.stop();
  const again = await core(port, 'alice', aliceToken, context, memoryStorage(alice.storage.records), { account: { e2ee: true } });
  const reloaded = (id) => again.client.conversation('bob', 100).find((r) => r.id === id);
  assert.equal(reloaded('w-0').text, 'новый текст');
  assert.equal(reloaded('n-1').text, 'исправленный ответ');
  assert.equal(reloaded('n-edit').editOf, 'n-1');
});

test('a bad token stops the driver instead of redialling', { skip }, async (context) => {
  const { port } = await startService(context);
  const alice = await core(port, 'alice', 'ab'.repeat(32), context);
  await alice.waitFor((n) => n.kind === 'connection' && n.state === 'auth-failed');
  await alice.waitFor((n) => n.kind === 'connection' && n.state === 'closed' && n.retryInMs === undefined);
});

test('the constructor refuses what the native client refuses', { skip }, async () => {
  const { WebClient } = await wasm();
  const host = { connect() {}, send() { return false; }, close() {}, notice() {} };
  const base = { login: 'alice', token: 'ab'.repeat(32), socketUrl: 'wss://x/ws', httpBase: 'https://x/tailchat' };
  assert.throws(() => new WebClient({ ...base, token: 'short' }, [], host), /invalid-argument/);
  assert.throws(() => new WebClient({ ...base, login: 'Not A Login' }, [], host), /invalid-argument/);
  assert.throws(() => new WebClient({ ...base, socketUrl: 'https://x/ws' }, [], host), /invalid-argument/);
  assert.throws(() => new WebClient(base, ['{"t":"nope"}'], host), /store/);
});

// The page's own bridge (`web-session.js`, the object app.js holds as
// `coreSession`) on the real wasm: what E2 calls from the composer, the forward
// menu, the voice recorder, the picture sheet and the edit action.
test('the page\'s bridge sends replies, forwards, voice, pictures and edits sealed, and the carrier is flagged for the pages that cannot read it', {
  skip, timeout: 60_000,
}, async (context) => {
  const { port, store } = await startService(context);
  const aliceToken = await account(port, 'alice');
  const bobToken = await account(port, 'bob');
  store.linkFriends('alice', 'bob');
  const open = async (login, token) => {
    const events = [];
    const emitter = new EventEmitter();
    const bridge = await startWebCoreSession({
      wasm: await wasm(),
      account: {
        login, token, e2ee: true,
        socketUrl: `ws://127.0.0.1:${port}/tailchat/ws`, httpBase: `http://127.0.0.1:${port}/tailchat`,
      },
      storage: memoryStorage(),
      onEvent: (event) => { events.push(event); emitter.emit('item', event); },
    });
    context.after(() => bridge.stop());
    return { bridge, waitFor: waiter(events, emitter, 'page event') };
  };
  const alice = await open('alice', aliceToken);
  const bob = await open('bob', bobToken);
  await Promise.all([
    alice.waitFor((n) => n.kind === 'device-registered', 15_000),
    bob.waitFor((n) => n.kind === 'device-registered', 15_000),
  ]);
  const bobRow = (id) => bob.bridge.conversation('alice', 100).find((r) => r.id === id);
  const aliceRow = (id) => alice.bridge.conversation('bob', 100).find((r) => r.id === id);

  assert.equal(alice.bridge.sendText('bob', 'a-0', 'исходный текст'), true);
  await bob.waitFor((n) => n.kind === 'stored' && n.id === 'a-0', 15_000);

  // A reply, the way the composer calls it: the page's own quote shape, with its
  // extra `author` and an `undefined` media.
  assert.equal(bob.bridge.sendWith('alice', 'b-1', 'ответ на цитату', {
    replyTo: { id: 'a-0', from: 'alice', author: 'Alice', text: 'исходный текст', media: undefined },
  }), true);
  await alice.waitFor((n) => n.kind === 'stored' && n.id === 'b-1', 15_000);
  assert.deepEqual(aliceRow('b-1').replyTo, { id: 'a-0', from: 'alice', text: 'исходный текст' });

  // A forward with a picture, and a voice note with the caption the page writes.
  const picture = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const voice = { dataUrl: `data:audio/mp4;base64,${Buffer.from('голосовые байты').toString('base64')}`, duration: 1.5 };
  assert.equal(alice.bridge.sendWith('bob', 'a-fwd', '🖼 [Image]', {
    forwardedFrom: { login: 'carol', name: 'Кэрол' }, image: { dataUrl: picture, width: 1, height: 1 },
  }), true);
  assert.equal(alice.bridge.sendWith('bob', 'a-voice', '🎙 Voice message (0:02)', { voice }), true);
  await bob.waitFor((n) => n.kind === 'stored' && n.id === 'a-voice', 15_000);
  assert.deepEqual(bobRow('a-fwd').forwardedFrom, { login: 'carol', name: 'Кэрол' });
  assert.equal(bobRow('a-fwd').image.dataUrl, picture);
  assert.equal(bobRow('a-voice').voice.dataUrl, voice.dataUrl);
  assert.equal(bobRow('a-voice').text, '🎙 Voice message (0:02)', 'the caption is there for a core that cannot play it');

  // Edits both ways, called the way editMessage calls them.
  assert.equal(alice.bridge.editText('bob', 'a-edit', 'a-0', 'новый текст'), true);
  await bob.waitFor((n) => n.kind === 'stored' && n.id === 'a-edit', 15_000);
  assert.equal(bobRow('a-0').text, 'новый текст');
  assert.ok(bobRow('a-0').editedAt > 0);
  assert.equal(bobRow('a-edit').editOf, 'a-0', 'the store keeps the carrier as a row; the page hides it');
  assert.equal(bob.bridge.editText('alice', 'b-edit', 'b-1', 'исправленный ответ'), true);
  await alice.waitFor((n) => n.kind === 'stored' && n.id === 'b-edit', 15_000);
  assert.equal(aliceRow('b-1').text, 'исправленный ответ');
  const added = await alice.waitFor((n) => n.kind === 'message-added' && n.id === 'a-edit');
  assert.equal(added.editOf, 'a-0', 'the page can tell a carrier\'s notice from a message\'s');

  // A call the core refuses is false, with nothing sent.
  assert.equal(alice.bridge.sendWith('bob', 'a-bad', 'x', { buttons: [] }), false);
  assert.equal(alice.bridge.sendWith('bob', 'a-bad2', 'x', { editOf: 'a-0' }), false);

  // The server holds none of the words, quotes, labels or bytes; the carriers
  // are the only records that say they are edits, and a page that cannot open
  // envelopes still sees that flag beside its stub.
  const get = (query, token) => fetch(`http://127.0.0.1:${port}/tailchat/api/history?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  const sealed = await get('peer=bob&limit=50&e2ee=1', aliceToken);
  const wire = JSON.stringify(sealed);
  // The check can fail: the same records are all there, by id, and the stub
  // history below does show the stub's own words.
  for (const id of ['a-0', 'b-1', 'a-fwd', 'a-voice', 'a-edit', 'b-edit']) assert.ok(wire.includes(`"${id}"`), id);
  for (const secret of ['исходный', 'новый текст', 'ответ на цитату', 'исправленный', 'Кэрол', 'Voice message',
    'replyTo', 'forwardedFrom', 'editOf', picture.slice(-24), voice.dataUrl.slice(-24)]) {
    assert.equal(wire.includes(secret), false, `the server holds ${secret}`);
  }
  assert.deepEqual(sealed.messages.filter((m) => m.sealedEdit).map((m) => m.id).sort(), ['a-edit', 'b-edit']);
  const stub = await get('peer=bob&limit=50', aliceToken);
  assert.deepEqual(stub.messages.filter((m) => m.sealedEdit).map((m) => m.id).sort(), ['a-edit', 'b-edit'],
    'the classic page reads the flag from the tombstone');
  assert.ok(stub.messages.filter((m) => m.sealedEdit).every((m) => !m.e2ee && m.text === '' && m.deletedAt > 0),
    'a carrier reaches a page without the capability as a tombstone: no envelope, no stub words');
  assert.ok(JSON.stringify(stub).includes('Зашифрованное сообщение'), 'what a classic page is shown for a message is the stub, so the scan above reads real output');
});
