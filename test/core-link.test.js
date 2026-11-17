import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { startCloudSession, CLIENT_CAPS, CLASSIC_CAPS } from '../src/cloud/link.js';
import { MEDIA_REF_CAP } from '../src/cloud/media-ref.js';
import {
  startCoreCloudSession,
  routeOutbound,
  ownsInbound,
  inboundKind,
  CoreSocket,
  CoreUnavailable,
  coreRequested,
  coreDbPath,
  httpBaseOf,
  loadNativeCore,
  describeCoreError,
  CORE_KEY_INFO,
  retireStaleCoreStore,
} from '../src/cloud/core-link.js';

// The native module is Rust and is built on demand (`npm run build:core`), so
// none of this needs it: a fake client records what the terminal asks of the
// core and plays notices back, exactly as `native.open`'s callback would. The
// point under test is the seam — what is swallowed, what is forwarded and what
// is handed to the core — because that is where two sources of the receipt
// marks could silently become one wrong one.

const TOKEN = 'a'.repeat(64);
const SOCKET_URL = 'ws://127.0.0.1:7699/tailchat/ws';
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

function fakeNative({ failOpen = null, legacy = false } = {}) {
  const native = { clients: [], lastKey: null };
  native.open = (options, sink) => {
    // The module copies the key and keeps nothing; the fake keeps the reference
    // the caller handed over so a test can see it was wiped afterwards.
    native.lastKey = options.key;
    if (failOpen) throw failOpen;
    const client = {
      options: { ...options, key: Buffer.from(options.key) },
      sink,
      texts: [],
      retries: [],
      raws: [],
      reconnects: 0,
      closed: 0,
      rows: [],
      conversationCalls: [],
      sendTextError: null,
      sendText(id, peer, text) {
        if (client.sendTextError) throw client.sendTextError;
        client.texts.push({ id, peer, text });
      },
      retry(peer, id) { client.retries.push({ peer, id }); },
      // A module built before the sealed actions has neither (`legacy`).
      ...(legacy ? {} : {
        sendWith(id, peer, text, options) {
          if (client.sendWithError) throw client.sendWithError;
          (client.withs ??= []).push({ id, peer, text, options });
        },
        editText(id, peer, target, text) {
          if (client.sendWithError) throw client.sendWithError;
          (client.edits ??= []).push({ id, peer, target, text });
        },
      }),
      sendUnencrypted(peer, id) { (client.unencrypted ??= []).push({ peer, id }); },
      acceptPeerKey(peer) { (client.acceptedKeys ??= []).push(peer); },
      startSas(peer, device) { (client.sasStarted ??= []).push({ peer, device }); },
      confirmSas(txId) { (client.sasConfirmed ??= []).push(txId); },
      cancelSas(txId) { (client.sasCancelled ??= []).push(txId); },
      verifyWithQr(qr) { (client.qrVerified ??= []).push(qr); },
      safetyCode(peer) { (client.safetyAsked ??= []).push(peer); },
      confirmSafetyCode(peer, masterKey) { (client.safetyConfirmed ??= []).push([peer, masterKey]); },
      createBackup(passphrase) { (client.backupsCreated ??= []).push(passphrase); },
      fetchBackup() { client.backupsFetched = (client.backupsFetched ?? 0) + 1; },
      restoreBackupWithRecoveryKey(rk) { (client.restoredKeys ??= []).push(rk); },
      restoreBackupWithPassphrase(pw, salt) { (client.restoredPassphrases ??= []).push({ pw, salt }); },
      resetCrossSigning(password) { (client.resets ??= []).push(password); },
      sendRaw(raw) { client.raws.push(JSON.parse(raw)); },
      reconnect() { client.reconnects += 1; },
      conversation(peer, limit, before) {
        client.conversationCalls.push({ peer, limit, before });
        return client.rows;
      },
      close() { client.closed += 1; },
      notify(notice) { sink(notice); },
      frame(object) { sink({ kind: 'frame', raw: JSON.stringify(object) }); },
    };
    native.clients.push(client);
    return client;
  };
  return native;
}

// link.js asks for timers (redial, watchdog); the tests decide when they fire.
function manualTimers() {
  const timers = { pending: [] };
  timers.setTimer = (fn, ms) => {
    const handle = { fn, ms, cleared: false, unref() {} };
    timers.pending.push(handle);
    return handle;
  };
  timers.clearTimer = (handle) => { if (handle) handle.cleared = true; };
  timers.fire = (predicate = () => true) => {
    const due = timers.pending.filter((handle) => !handle.cleared && predicate(handle));
    timers.pending = timers.pending.filter((handle) => !due.includes(handle));
    for (const handle of due) handle.fn();
  };
  return timers;
}

function session(context, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-core-link-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const native = overrides.native ?? fakeNative();
  const timers = manualTimers();
  const key = Buffer.alloc(32, 7);
  const link = startCoreCloudSession({
    url: SOCKET_URL,
    token: TOKEN,
    name: 'Alice',
    peer: 'bob',
    peerLabel: 'Bob',
    login: 'alice',
    dbPath: path.join(dir, 'core', 'alice.db'),
    key,
    native,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  context.after(() => link.stop());
  const client = native.clients[0];
  const events = [];
  for (const kind of [
    'accepted', 'sync-page', 'sync-nudge', 'ack', 'read', 'message', 'receipt', 'core-stored', 'core-removed',
    'core-refused', 'read-sync', 'status', 'present', 'offline', 'online', 'users', 'unread',
    'core-device-registered', 'core-plaintext-held', 'core-encryption-state', 'core-key-changed',
    'core-unverified-device', 'core-sas-started', 'core-sas-code-ready', 'core-sas-cancelled', 'core-device-keys-conflict', 'core-device-verified',
    'core-safety-code',
    'core-backup-created', 'core-backup-info', 'core-backup-restored', 'core-bad-frame',
    'core-cross-signing-reset', 'core-cross-signing-reset-failed',
  ]) {
    link.on(kind, (payload) => events.push({ kind, payload }));
  }
  const seen = (kind) => events.filter((event) => event.kind === kind).map((event) => event.payload);
  return {
    dir, native, client, link, timers, key, events, seen,
  };
}

// The native connection is up and the server has said `ready`: link.js has
// subscribed and built its channel.
async function ready(s, { online = false } = {}) {
  s.client.notify({ kind: 'connection', state: 'connecting' });
  s.client.notify({ kind: 'connection', state: 'open' });
  await tick();
  s.client.notify({ kind: 'connection', state: 'ready' });
  s.client.frame({
    k: 'ready',
    self: { login: 'alice' },
    users: [{ login: 'bob', name: 'Bob' }],
    caps: ['durable-ack', 'sync-v1', 'read-ack-v1'],
  });
  s.client.frame({ k: 'subscribed', peer: 'bob', online, state: 'active' });
  await tick();
}

const rawFrames = (client) => client.raws.filter((raw) => raw.k === 'frame');
const innerTypes = (client) => rawFrames(client).map((raw) => raw.d.t);

test('opens the native client with the account, a private copy of the key and the caps link.js claims', async (context) => {
  const s = session(context);
  const options = s.client.options;
  assert.equal(options.login, 'alice');
  assert.equal(options.token, TOKEN);
  assert.equal(options.socketUrl, SOCKET_URL);
  assert.equal(options.httpBase, 'http://127.0.0.1:7699/tailchat');
  assert.equal(options.dbPath, path.join(s.dir, 'core', 'alice.db'));
  assert.deepEqual([...options.key], [...Buffer.alloc(32, 7)]);
  // What link.js would have put in its own `auth`, so the core claims exactly
  // what the terminal's handlers consume; the core merges it with its own list.
  assert.deepEqual(options.extraCaps, [...CLIENT_CAPS]);
  assert.ok(options.extraCaps.includes('read-ack-v1'), 'read-accepted is why the terminal keeps unread ids');
  assert.equal(options.e2ee, true, 'E2EE is enabled under TAILCHAT_CORE=1 in stage 6f');
  // What the other side's verification lines call this device — no host name.
  assert.match(options.deviceName, /^Terminal( · \w+)?$/);
  assert.equal(s.link.isCore, true);
});

test('the key the native side was handed is wiped, and the caller\'s own copy is left alone', (context) => {
  const s = session(context);
  assert.ok(s.native.lastKey.every((byte) => byte === 0), 'the private copy is wiped once open() returned');
  assert.deepEqual([...s.key], [...Buffer.alloc(32, 7)], 'the caller still owns its key');
});

test('the store directory is created private to the user', (context) => {
  const s = session(context);
  const mode = fs.statSync(path.join(s.dir, 'core')).mode & 0o777;
  assert.equal(mode, 0o700);
});

test('a refused open throws what the module said, with its code, and still wipes the key', (context) => {
  const failure = Object.assign(new Error('store is locked'), { code: 'locked' });
  const native = fakeNative({ failOpen: failure });
  assert.throws(() => session(context, { native }), (error) => error === failure && error.code === 'locked');
  assert.ok(native.lastKey.every((byte) => byte === 0), 'the copy is wiped on the failure path too');
});

// The auth frame is link.js's own business to write and the core's to send: a
// second one on the wire would be the very double bookkeeping this layer avoids.
test('link.js\'s auth never reaches the wire; the ready frame makes it subscribe through the core', async (context) => {
  const s = session(context);
  await ready(s);
  assert.equal(s.client.raws.some((raw) => raw.k === 'auth'), false);
  assert.deepEqual(s.client.raws.filter((raw) => raw.k === 'subscribe'), [{ k: 'subscribe', peer: 'bob' }]);
  assert.equal(s.link.caps.has('read-ack-v1'), true, 'the server\'s caps reach the terminal');
  assert.equal(s.link.isOnline(), true);
});

test('the core claims CLIENT_CAPS; only the classic link adds media-ref-v1 on top', async () => {
  const sent = [];
  const fake = new EventEmitter();
  fake.readyState = 1;
  fake.send = (text) => sent.push(JSON.parse(text));
  fake.close = () => {};
  const classic = startCloudSession({
    url: SOCKET_URL, token: TOKEN, name: 'Alice', peer: 'bob', connect: () => fake, setTimer: () => ({ unref() {} }),
  });
  fake.emit('open');
  classic.stop();
  // The classic link draws references itself; the core's codec would read one
  // as no attachment and store the message without it (history-media-refs §10),
  // so the list the core claims on this client's behalf must not carry it.
  assert.deepEqual(sent, [{ k: 'auth', token: TOKEN, caps: [...CLASSIC_CAPS] }]);
  assert.deepEqual(CLASSIC_CAPS, [...CLIENT_CAPS, MEDIA_REF_CAP]);
  assert.equal(CLIENT_CAPS.includes(MEDIA_REF_CAP), false);
});

test('outbound: what link.js writes is swallowed, handed to the core as text, or sent raw', async (context) => {
  const s = session(context);
  await ready(s);
  const baseline = s.client.raws.length;

  // plain text → the core's durable queue
  assert.ok(s.link.sendFrame({ t: 'msg', id: 'm1', text: 'hello', ts: 1 }));
  assert.deepEqual(s.client.texts, [{ id: 'm1', peer: 'bob', text: 'hello' }]);

  // a reply, a forward, a picture and a voice note carry more than the core's
  // text action has room for: raw, untouched
  const reply = {
    t: 'msg', id: 'm2', text: 'answer', ts: 1, replyTo: { id: 'x', from: 'bob', author: 'Bob', text: 'q' },
  };
  const forward = {
    t: 'msg', id: 'm3', text: 'again', ts: 1, forwardedFrom: { login: 'carol', name: 'Carol' },
  };
  const image = {
    t: 'msg', id: 'm4', text: '', ts: 1, image: { dataUrl: 'data:image/png;base64,AA==', width: 1, height: 1 },
  };
  const voice = {
    t: 'msg', id: 'm5', text: '', ts: 1, voice: { dataUrl: 'data:audio/wav;base64,AA==', duration: 1 },
  };
  for (const frame of [reply, forward, image, voice]) assert.ok(s.link.sendFrame(frame));
  assert.equal(s.client.texts.length, 1, 'none of them went through sendText');
  const raws = rawFrames(s.client).slice(-4);
  assert.deepEqual(raws.map((raw) => raw.d), [reply, forward, image, voice]);
  assert.ok(raws.every((raw) => raw.to === 'bob'));

  // ack: the core acks once the row is on disk — a second, earlier one from the
  // terminal would claim a message the core might still lose
  const before = s.client.raws.length;
  assert.ok(s.link.sendReceipt('ack', 'incoming-1'));
  // sync: the core owns the feed
  assert.equal(s.link.sendSync(0, 200), true);
  assert.equal(s.client.raws.length, before, 'ack and sync wrote nothing');

  // everything else travels as it always did
  assert.ok(s.link.sendReceipt('read', 'incoming-1'));
  assert.deepEqual(rawFrames(s.client).at(-1), { k: 'frame', to: 'bob', d: { t: 'read', id: 'incoming-1' } });
  assert.ok(s.link.sendFrame({ t: 'typing', state: 'start' }));
  assert.deepEqual(rawFrames(s.client).at(-1).d, { t: 'typing', state: 'start' });
  assert.ok(s.link.markUnread());
  assert.deepEqual(s.client.raws.at(-1), { k: 'mark-unread', peer: 'bob' });
  const due = Date.now() + 60_000;
  assert.ok(s.link.scheduleReplyReminder('bob', 'm1', due));
  assert.deepEqual(s.client.raws.at(-1), {
    k: 'reply-reminder', peer: 'bob', messageId: 'm1', dueAt: due,
  });
  assert.ok(s.client.raws.length > baseline);
});

test('a blank or oddly shaped text is not the core\'s to judge: the server decides, as before', async (context) => {
  const s = session(context);
  await ready(s);
  s.link.sendFrame({ t: 'msg', id: 'blank', text: '   ', ts: 1 });
  s.link.sendFrame({ t: 'msg', id: 'extra', text: 'x', ts: 1, buttons: [] });
  assert.deepEqual(s.client.texts, []);
  assert.deepEqual(rawFrames(s.client).slice(-2).map((raw) => raw.d.id), ['blank', 'extra']);
});

test('a login or id the core cannot parse falls back to a raw frame instead of losing the message', async (context) => {
  const s = session(context);
  await ready(s);
  s.client.sendTextError = Object.assign(new Error('invalid id'), { code: 'invalid-argument' });
  assert.ok(s.link.sendFrame({ t: 'msg', id: 'weird', text: 'still sent', ts: 1 }));
  assert.deepEqual(rawFrames(s.client).at(-1).d, { t: 'msg', id: 'weird', text: 'still sent', ts: 1 });
});

test('send() goes straight to the core for the open conversation, with or without a channel', async (context) => {
  const s = session(context);
  // Nothing connected yet: link.js has no channel and would answer null. The
  // core queues durably while offline, which is the point of the whole thing.
  assert.equal(s.link.send('offline words', 1, 'q1'), 'q1');
  assert.deepEqual(s.client.texts, [{ id: 'q1', peer: 'bob', text: 'offline words' }]);

  const generated = s.link.send('no id given');
  assert.match(generated, /^[0-9a-f]{16}$/);
  assert.equal(s.client.texts.at(-1).id, generated);

  s.link.switchPeer('carol', 'Carol');
  assert.equal(s.link.send('to carol', 1, 'q2'), 'q2');
  assert.deepEqual(s.client.texts.at(-1), { id: 'q2', peer: 'carol', text: 'to carol' });

  s.link.switchPeer(null);
  assert.equal(s.link.send('nobody', 1, 'q3'), null, 'no conversation open: nothing to send to');

  s.link.switchPeer('bob', 'Bob');
  s.client.sendTextError = new Error('stopped');
  assert.equal(s.link.send('refused', 1, 'q4'), null, 'the caller\'s own fallback still applies');
});

test('sendWith and editText go to the core for the open conversation; a refusal takes the row back', async (context) => {
  const s = session(context);
  await ready(s);
  // `undefined` fields are dropped: a reply without `media` is the common case.
  const reply = { replyTo: { id: 'm-0', from: 'bob', author: 'Bob', text: 'q', media: undefined }, forwardedFrom: null };
  assert.equal(s.link.sendWith('answer', reply, 'w-1'), 'w-1');
  assert.deepEqual(s.client.withs, [{
    id: 'w-1', peer: 'bob', text: 'answer',
    options: { replyTo: { id: 'm-0', from: 'bob', author: 'Bob', text: 'q' }, forwardedFrom: null },
  }]);
  assert.match(s.link.sendWith('caption'), /^[0-9a-f]{16}$/, 'an id is made when none is given');
  assert.deepEqual(s.client.withs.at(-1).options, {});
  assert.equal(s.link.editText('w-1', 'fixed', 'e-1'), 'e-1');
  assert.deepEqual(s.client.edits, [{ id: 'e-1', peer: 'bob', target: 'w-1', text: 'fixed' }]);

  // No message or edit is written as a raw frame on the way (the `hello` is
  // link.js's own): the core carries them.
  assert.deepEqual(innerTypes(s.client).filter((type) => type !== 'hello'), []);

  // The core refuses one of them by name: the terminal takes that row back.
  s.client.notify({ kind: 'action-refused', peer: 'bob', id: 'e-1', reason: 'pending message' });
  assert.deepEqual(s.seen('core-refused'), [{ peer: 'bob', id: 'e-1', reason: 'pending message' }]);

  s.client.sendWithError = new Error('invalid-argument: refused');
  assert.equal(s.link.sendWith('x', {}, 'w-2'), null, 'the caller\'s own message says so');
  assert.equal(s.link.editText('w-1', 'x', 'e-2'), null);
  s.link.switchPeer(null);
  s.client.sendWithError = null;
  assert.equal(s.link.sendWith('nobody', {}, 'w-3'), null);
  assert.equal(s.link.editText('w-1', 'nobody', 'e-3'), null);
});

test('a refusal that comes back inside the call still names its message', async (context) => {
  const s = session(context);
  await ready(s);
  const answer = (id) => s.client.notify({ kind: 'action-refused', peer: 'bob', id, reason: 'not ready' });
  s.client.editText = (id) => answer(id);
  s.client.sendWith = (id) => answer(id);
  assert.equal(s.link.editText('w-1', 'fixed', 'e-1'), 'e-1');
  assert.equal(s.link.sendWith('hi', {}, 'w-9'), 'w-9');
  assert.deepEqual(s.seen('core-refused'), [
    { peer: 'bob', id: 'e-1', reason: 'not ready' },
    { peer: 'bob', id: 'w-9', reason: 'not ready' },
  ], 'an id with no owner would have come out as null, and the edit could not be undone');
});

test('an edit carrier that reaches the link as the server\'s stub is no message and no unread, in any conversation', async (context) => {
  const s = session(context);
  await ready(s);
  const stub = { t: 'msg', ts: 5, text: '🔒 Encrypted message — update the app', sealedEdit: true };
  s.client.frame({ k: 'frame', from: 'bob', d: { ...stub, id: 'c-1' } });
  s.client.frame({ k: 'frame', from: 'carol', d: { ...stub, id: 'c-2' } });
  s.client.frame({ k: 'frame', from: 'bob', self: true, d: { ...stub, id: 'c-3' } });
  await tick();
  assert.deepEqual(s.seen('message'), []);
  assert.deepEqual(s.seen('unread'), []);
  assert.deepEqual(s.seen('sync-outgoing'), []);
  // The same frames without the flag are what they always were.
  s.client.frame({ k: 'frame', from: 'bob', d: { t: 'msg', id: 'n-1', ts: 6, text: 'hello' } });
  s.client.frame({ k: 'frame', from: 'carol', d: { t: 'msg', id: 'n-2', ts: 7, text: 'psst' } });
  await tick();
  assert.deepEqual(s.seen('message').map((m) => m.id), ['n-1']);
  assert.deepEqual(s.seen('unread').map((u) => u.from), ['carol']);
});

test('a native module built before the sealed actions leaves them off the link, so the terminal keeps its open frames', (context) => {
  const s = session(context, { native: fakeNative({ legacy: true }) });
  assert.equal(typeof s.link.sendWith, 'undefined');
  assert.equal(typeof s.link.editText, 'undefined');
  assert.equal(typeof s.link.send, 'function', 'plain text is untouched');
});

test('inbound: the core\'s own frames are withheld from link.js, everything else is delivered', async (context) => {
  const s = session(context);
  await ready(s, { online: true });
  s.client.frame({ k: 'frame', from: 'bob', d: { t: 'hello', name: 'Bob', connId: 'c1', v: '1.2.3' } });
  await tick();

  // owned by the core: no second source of marks
  s.client.frame({ k: 'message-accepted', peer: 'bob', id: 'm1', ts: 5, seq: 1 });
  s.client.frame({ k: 'sync-page', events: [], cursor: 3, more: false, reset: false });
  s.client.frame({ k: 'sync-nudge' });
  s.client.frame({ k: 'frame', from: 'bob', d: { t: 'ack', id: 'm1', deliveredTs: 6 } });
  s.client.frame({ k: 'frame', from: 'bob', d: { t: 'read', id: 'm1', readTs: 7 } });
  assert.deepEqual(s.seen('accepted'), []);
  assert.deepEqual(s.seen('sync-page'), []);
  assert.deepEqual(s.seen('sync-nudge'), []);
  assert.deepEqual(s.seen('ack'), []);
  assert.deepEqual(s.seen('read'), []);

  // the live transcript, presence and the rest reach the terminal as before
  s.client.frame({ k: 'frame', from: 'bob', d: { t: 'msg', id: 'in1', text: 'hi Alice', ts: 8 } });
  assert.deepEqual(s.seen('message').map((message) => [message.id, message.text, message.name]), [
    ['in1', 'hi Alice', 'Bob'],
  ]);
  s.client.frame({ k: 'presence', peer: 'bob', online: false });
  assert.deepEqual(s.seen('present').at(-1), { present: false, peerName: 'Bob' });
  s.client.frame({ k: 'unread', from: 'carol', text: 'psst', ts: 9, count: 2 });
  assert.deepEqual(s.seen('unread'), [{ from: 'carol', text: 'psst', ts: 9, count: 2 }]);
  s.client.frame({ k: 'error', code: 'blocked' });
  assert.deepEqual(s.seen('status').at(-1), { key: 'cloud.serverError', params: { code: 'blocked' } });
});

test('a receipt for a message link.js sent raw still reaches the terminal: the core never saw it go out', async (context) => {
  const s = session(context);
  await ready(s, { online: true });
  s.client.frame({ k: 'frame', from: 'bob', d: { t: 'hello', name: 'Bob', connId: 'c1', v: '1.2.3' } });
  await tick();
  s.link.sendFrame({
    t: 'msg', id: 'reply-1', text: 'answer', ts: 1, replyTo: { id: 'x', from: 'bob', text: 'q' },
  });

  s.client.frame({ k: 'frame', from: 'bob', d: { t: 'ack', id: 'reply-1', deliveredTs: 2 } });
  s.client.frame({ k: 'frame', from: 'bob', d: { t: 'read', id: 'reply-1', readTs: 3 } });
  assert.deepEqual(s.seen('ack'), [{ id: 'reply-1' }]);
  assert.deepEqual(s.seen('read'), [{ id: 'reply-1' }]);

  // …while one for a message the core carries still does not
  s.link.sendFrame({ t: 'msg', id: 'plain-1', text: 'plain', ts: 1 });
  s.client.frame({ k: 'frame', from: 'bob', d: { t: 'ack', id: 'plain-1', deliveredTs: 4 } });
  assert.equal(s.seen('ack').length, 1);
});

test('the core\'s notices become the terminal\'s receipt and store events', async (context) => {
  const s = session(context);
  await ready(s);

  s.client.notify({
    kind: 'message-added', peer: 'bob', id: 'm1', ts: 10, text: 'private words', receipt: 'queued',
  });
  s.client.notify({ kind: 'receipt', peer: 'bob', id: 'm1', ts: 11, receipt: 'sent' });
  s.client.notify({ kind: 'receipt', peer: 'bob', id: 'm1', ts: 11, receipt: 'delivered' });
  s.client.notify({ kind: 'receipt', peer: 'bob', id: 'm1', ts: 11, receipt: 'read' });
  s.client.notify({ kind: 'receipt', peer: 'bob', id: 'm2', ts: 12, receipt: 'failed' });
  assert.deepEqual(s.seen('receipt'), [
    { peer: 'bob', id: 'm1', ts: 10, receipt: 'queued' },
    { peer: 'bob', id: 'm1', ts: 11, receipt: 'sent' },
    { peer: 'bob', id: 'm1', ts: 11, receipt: 'delivered' },
    { peer: 'bob', id: 'm1', ts: 11, receipt: 'read' },
    { peer: 'bob', id: 'm2', ts: 12, receipt: 'failed' },
  ], 'the message text never rides on an event');

  s.client.notify({ kind: 'stored', peer: 'bob', id: 'in1' });
  s.client.notify({ kind: 'removed', peer: 'bob', ids: ['a', 'b'] });
  s.client.notify({ kind: 'own-read', peer: 'bob', readTs: 99 });
  assert.deepEqual(s.seen('core-stored'), [{ peer: 'bob', id: 'in1' }]);
  assert.deepEqual(s.seen('core-removed'), [{ peer: 'bob', ids: ['a', 'b'] }]);
  assert.deepEqual(s.seen('read-sync'), [{ peer: 'bob', id: '', readTs: 99 }],
    'the same fact link.js reports when another device reads');
});

test('server-error and bad-frame notices are link.js\'s to say, not a second line', async (context) => {
  const s = session(context);
  await ready(s);
  const before = s.events.length;
  s.client.notify({ kind: 'server-error', code: 'blocked', peer: 'bob', id: 'm1' });
  s.client.notify({ kind: 'bad-frame', reason: 'not json' });
  s.client.notify({ kind: 'connection', state: 'auth-failed' });
  // No line: nothing on the status bus. The bad frame is handed on as an event
  // only, for /backup restore — which says something solely while a restore
  // waits and the reason is about the backup (test/e2ee-commands.test.js).
  const after = s.events.slice(before);
  assert.deepEqual(after, [{ kind: 'core-bad-frame', payload: { reason: 'not json' } }]);
});

test('a dropped native connection closes link.js\'s socket; its redial reattaches and replays the server\'s ready', async (context) => {
  const s = session(context);
  await ready(s, { online: true });
  const subscribes = () => s.client.raws.filter((raw) => raw.k === 'subscribe').length;
  assert.equal(subscribes(), 1);

  s.client.notify({ kind: 'connection', state: 'closed', retryInMs: 1000 });
  await tick();
  assert.deepEqual(s.seen('status').map((status) => status.key).slice(-1), ['cloud.linkLost']);
  assert.equal(s.link.isOnline(), false);

  // The driver redials faster than link.js's own timer: by the time link.js
  // asks for a new socket the connection is already up and its `ready` has gone
  // by — it is replayed, or the terminal would never subscribe again.
  s.client.notify({ kind: 'connection', state: 'connecting' });
  s.client.notify({ kind: 'connection', state: 'open' });
  s.client.notify({ kind: 'connection', state: 'ready' });
  s.client.frame({ k: 'ready', self: { login: 'alice' }, users: [], caps: ['durable-ack'] });
  s.client.frame({ k: 'users', users: [{ login: 'bob', name: 'Bob' }] });
  s.timers.fire();
  await tick();
  assert.equal(subscribes(), 2, 'link.js subscribed again from the replayed ready');
  assert.equal(s.link.caps.has('durable-ack'), true);
  assert.equal(s.link.caps.has('read-ack-v1'), false, 'the caps are the new connection\'s, not the old one\'s');
  assert.deepEqual(s.seen('users').at(-1), { users: [{ login: 'bob', name: 'Bob' }] }, 'the roster is replayed too');
});

test('a socket link.js dials while the driver is still down waits for it and opens when it does', async (context) => {
  const s = session(context);
  await ready(s, { online: true });
  s.client.notify({ kind: 'connection', state: 'closed', retryInMs: 1000 });
  await tick();
  s.timers.fire();
  await tick();
  const subscribes = () => s.client.raws.filter((raw) => raw.k === 'subscribe').length;
  assert.equal(subscribes(), 1, 'nothing is sent into a connection that is not there');
  assert.equal(s.link.isDialling(), true);

  s.client.notify({ kind: 'connection', state: 'connecting' });
  s.client.notify({ kind: 'connection', state: 'open' });
  await tick();
  s.client.notify({ kind: 'connection', state: 'ready' });
  s.client.frame({ k: 'ready', self: { login: 'alice' }, users: [], caps: ['sync-v1'] });
  await tick();
  assert.equal(subscribes(), 2);
  assert.equal(s.link.caps.has('sync-v1'), true);
});

test('link.js\'s own staleness watchdog is off: the driver owns liveness and answers the pings', async (context) => {
  const s = session(context);
  await ready(s);
  // Its watchdog timer is still scheduled, but it can never call a quiet socket
  // stale, which `staleMs: Infinity` guarantees even after a very long silence.
  const real = Date.now;
  Date.now = () => real() + 24 * 3600 * 1000;
  try {
    s.timers.fire((handle) => handle.ms === 10_000);
    await tick();
  } finally {
    Date.now = real;
  }
  assert.equal(s.link.isOnline(), true, 'a day of silence on a healthy connection is not staleness');
});

test('a refused send is taken back by name, and only that one', async (context) => {
  const s = session(context);
  await ready(s);

  s.link.send('lost', 1, 'p-lost');
  s.link.send('kept', 1, 'p-kept');
  s.link.send('later', 1, 'p-later');
  s.client.notify({ kind: 'message-added', peer: 'bob', id: 'p-kept', ts: 5, text: 'kept', receipt: 'queued' });
  s.client.notify({ kind: 'action-refused', peer: 'bob', id: 'p-lost', reason: 'queue full' });
  assert.deepEqual(s.seen('core-refused'), [{ peer: 'bob', id: 'p-lost', reason: 'queue full' }]);

  // a send the core has not answered yet is not given up on with it, and a
  // confirmed one is never refused afterwards
  s.client.notify({ kind: 'action-refused', peer: 'bob', id: 'p-kept', reason: 'duplicate id' });
  assert.deepEqual(s.seen('core-refused').at(-1), { peer: null, id: null, reason: 'duplicate id' });
  assert.equal(s.seen('core-refused').length, 2);
});

test('a refused retry leaves its row and only says why', async (context) => {
  const s = session(context);
  await ready(s);
  s.link.retry('bob', 'old-failed');
  s.client.notify({ kind: 'action-refused', peer: 'bob', id: 'old-failed', reason: 'not retryable' });
  assert.deepEqual(s.seen('core-refused'), [{ peer: null, id: null, reason: 'not retryable' }]);
});

test('a send that reused an id the core holds is not taken back', async (context) => {
  const s = session(context);
  await ready(s);
  const held = [];
  s.link.on('core-held', (payload) => held.push(payload));
  s.link.send('handed over again', 1, 'old-queued');
  s.client.notify({ kind: 'action-refused', peer: 'bob', id: 'old-queued', held: true, reason: 'message id is already used' });
  assert.deepEqual(held, [{ peer: 'bob', id: 'old-queued' }]);
  assert.deepEqual(s.seen('core-refused'), [], 'the message exists: nothing to take back');
});

test('a failing store is announced at once; the send it lost is refused by the core by name', async (context) => {
  const s = session(context);
  await ready(s);
  s.link.send('lost with the store', 1, 'p1');
  s.client.notify({ kind: 'storage-failed', reason: 'disk I/O error' });
  assert.deepEqual(s.seen('status').at(-1), { key: 'core.storageFailed', params: { reason: 'disk I/O error' } });
  assert.deepEqual(s.seen('core-refused'), [], 'the failure alone takes nothing back');
  s.client.notify({ kind: 'action-refused', peer: 'bob', id: 'p1', reason: 'the local store failed' });
  assert.deepEqual(s.seen('core-refused'), [{ peer: 'bob', id: 'p1', reason: 'the local store failed' }]);
});

// R3: the core refuses, before the wire, an attachment an old device of the
// conversation could not read in a frame; the terminal says why. The server's
// own refusals stay link.js's, said from the very frame.
test('the core\'s peer_outdated refusal is said once; a server refusal is not repeated', async (context) => {
  const s = session(context);
  await ready(s);
  const before = s.seen('status').length;
  s.client.notify({ kind: 'server-error', code: 'store_failed', peer: 'bob', id: 'p1' });
  assert.equal(s.seen('status').length, before);
  s.client.notify({ kind: 'server-error', code: 'peer_outdated', peer: 'bob', id: 'p2' });
  assert.deepEqual(s.seen('status').slice(before), [{ key: 'core.peerOutdated', params: {} }]);
});

test('a raw message the driver dropped for want of a connection is given back, a dropped control frame is not', async (context) => {
  const s = session(context);
  await ready(s);
  const reply = JSON.stringify({
    k: 'frame', to: 'bob', d: { t: 'msg', id: 'r1', text: 'answer', ts: 1, replyTo: { id: 'x', from: 'bob', text: 'q' } },
  });
  s.client.notify({ kind: 'raw-dropped', raw: reply });
  assert.deepEqual(s.seen('core-refused'), [{ peer: 'bob', id: 'r1', reason: 'not connected' }]);

  s.client.notify({ kind: 'raw-dropped', raw: JSON.stringify({ k: 'frame', to: 'bob', d: { t: 'typing', state: 'start' } }) });
  s.client.notify({ kind: 'raw-dropped', raw: JSON.stringify({ k: 'subscribe', peer: 'bob' }) });
  s.client.notify({ kind: 'raw-dropped', raw: 'not json' });
  assert.equal(s.seen('core-refused').length, 1);
});

test('the conversation and retry go to the core as asked', async (context) => {
  const s = session(context);
  s.client.rows = [{ id: 'a', source: 'sent' }];
  assert.deepEqual(s.link.conversation('bob', 50, { ts: 7, id: 'z' }), [{ id: 'a', source: 'sent' }]);
  assert.deepEqual(s.link.conversation('bob'), [{ id: 'a', source: 'sent' }]);
  assert.deepEqual(s.client.conversationCalls, [
    { peer: 'bob', limit: 50, before: { ts: 7, id: 'z' } },
    { peer: 'bob', limit: 200, before: null },
  ]);
  s.link.retry('bob', 'm9');
  assert.deepEqual(s.client.retries, [{ peer: 'bob', id: 'm9' }]);
});

test('reconnect asks the driver to redial; stop closes it once and silences everything after', async (context) => {
  const s = session(context);
  await ready(s);
  s.link.reconnect();
  assert.equal(s.client.reconnects, 1);

  s.link.stop();
  s.link.stop();
  assert.equal(s.client.closed, 1, 'the store lock is released exactly once');
  const before = s.events.length;
  s.client.notify({ kind: 'receipt', peer: 'bob', id: 'm1', ts: 1, receipt: 'sent' });
  s.client.frame({ k: 'frame', from: 'bob', d: { t: 'msg', id: 'late', text: 'x', ts: 1 } });
  assert.equal(s.events.length, before, 'no notice is acted on after stop');
  assert.equal(s.link.send('too late', 1, 'z'), null);
});

test('a frame written after the socket closed goes nowhere', async (context) => {
  const s = session(context);
  await ready(s, { online: true });
  s.client.notify({ kind: 'connection', state: 'closed', retryInMs: 1000 });
  await tick();
  const before = s.client.raws.length;
  assert.equal(s.link.sendFrame({ t: 'typing', state: 'start' }), false, 'no channel: link.js refuses before the core is asked');
  assert.equal(s.client.raws.length, before);
});

test('routeOutbound is the routing table, on the wire shapes link.js writes', () => {
  const frame = (to, d) => JSON.stringify({ k: 'frame', to, d });
  assert.deepEqual(routeOutbound(JSON.stringify({ k: 'auth', token: 'x', caps: [] })), { route: 'swallow' });
  assert.deepEqual(routeOutbound(JSON.stringify({ k: 'sync', since: 0, limit: 200 })), { route: 'swallow' });
  assert.deepEqual(routeOutbound(frame('bob', { t: 'ack', id: 'a' })), { route: 'swallow' });
  assert.deepEqual(routeOutbound(frame('bob', { t: 'msg', id: 'm', text: 'x', ts: 1 })), {
    route: 'text', peer: 'bob', id: 'm', text: 'x',
  });
  assert.deepEqual(routeOutbound(frame('bob', { t: 'msg', id: 'm', text: 'x' })), {
    route: 'text', peer: 'bob', id: 'm', text: 'x',
  }, 'the timestamp is the core\'s to stamp');
  assert.deepEqual(routeOutbound(frame('bob', { t: 'msg', id: 'm', text: 'x', replyTo: {} })), {
    route: 'raw', sent: { peer: 'bob', id: 'm' },
  });
  assert.deepEqual(routeOutbound(frame('bob', { t: 'msg', text: 'no id' })), { route: 'raw' });
  assert.deepEqual(routeOutbound(frame('', { t: 'msg', id: 'm', text: 'x' })), { route: 'raw', sent: { peer: '', id: 'm' } });
  assert.deepEqual(routeOutbound(frame('bob', { t: 'msg', id: 'm', text: 7 })), {
    route: 'raw', sent: { peer: 'bob', id: 'm' },
  });
  for (const t of ['read', 'typing', 'focus', 'hello', 'ai', 'edit', 'del', 'react', 'ping', 'pong', 'file-offer']) {
    assert.deepEqual(routeOutbound(frame('bob', { t, id: 'z' })), { route: 'raw' }, t);
  }
  for (const k of ['subscribe', 'mark-read', 'mark-unread', 'reply-reminder', 'reply-reminder-ack']) {
    assert.deepEqual(routeOutbound(JSON.stringify({ k, peer: 'bob' })), { route: 'raw' }, k);
  }
  assert.deepEqual(routeOutbound('not json'), { route: 'raw' });
  assert.deepEqual(routeOutbound('null'), { route: 'raw' });
  assert.deepEqual(routeOutbound(JSON.stringify({ k: 'frame', to: 'bob' })), { route: 'raw' });
  assert.deepEqual(routeOutbound(JSON.stringify({ k: 'frame', to: 'bob', d: [] })), { route: 'raw' });
});

test('ownsInbound withholds exactly what the core keeps, and nothing the terminal needs', () => {
  const envelope = (k, extra = {}) => JSON.stringify({ k, ...extra });
  const inner = (d, extra = {}) => JSON.stringify({ k: 'frame', from: 'bob', d, ...extra });
  for (const k of ['message-accepted', 'sync-page', 'sync-nudge']) assert.equal(ownsInbound(envelope(k)), true, k);
  assert.equal(ownsInbound(inner({ t: 'ack', id: 'a' })), true);
  assert.equal(ownsInbound(inner({ t: 'read', id: 'a', readTs: 5, via: 'web' })), true);
  assert.equal(ownsInbound(inner({ t: 'ack', id: 'a' }), new Set(['a'])), false, 'a raw-sent message\'s receipt is the terminal\'s');
  assert.equal(ownsInbound(inner({ t: 'ack', id: 'b' }), new Set(['a'])), true);
  for (const k of [
    'ready', 'subscribed', 'presence', 'users', 'unread', 'error', 'react-sync', 'read-sync', 'read-accepted',
    'reply-reminder-fired', 'throttle', 'something-new',
  ]) assert.equal(ownsInbound(envelope(k)), false, k);
  for (const t of ['msg', 'ai', 'hello', 'typing', 'edit', 'del', 'react', 'focus']) {
    assert.equal(ownsInbound(inner({ t, id: 'x' })), false, t);
  }
  assert.equal(ownsInbound(inner({ t: 'msg', id: 'x', text: 'ack' }, { self: true })), false);
});

test('ownsInbound reads the envelope without parsing a media frame, and never withholds one', () => {
  const big = JSON.stringify({
    k: 'frame', from: 'bob', d: { t: 'msg', id: 'm', text: '', image: { dataUrl: `data:image/png;base64,${'A'.repeat(200_000)}` } },
  });
  assert.equal(inboundKind(big), 'frame');
  assert.equal(ownsInbound(big), false);
  // a very large feed page is still the core's
  const page = `{"k":"sync-page","events":[${'{"seq":1,"kind":"message","peer":"bob"},'.repeat(5000)}{"seq":2}],"cursor":2,"more":false}`;
  assert.equal(ownsInbound(page), true);
  // another key order: small frames are parsed, large ones are not guessed at
  assert.equal(inboundKind('{"from":"bob","k":"message-accepted"}'), 'message-accepted');
  assert.equal(ownsInbound('{"from":"bob","k":"message-accepted"}'), true);
  assert.equal(inboundKind(`{"x":"${'a'.repeat(70_000)}","k":"sync-page"}`), null);
  assert.equal(inboundKind('not json'), null);
  assert.equal(inboundKind('{"k":7}'), null);
});

test('CoreSocket is only as open as it is told, speaks once, and closes once', async () => {
  const written = [];
  const socket = new CoreSocket((text) => written.push(text));
  const events = [];
  for (const kind of ['open', 'message', 'close']) socket.on(kind, (payload) => events.push([kind, payload]));

  socket.send('too early');
  socket.receive('too early');
  assert.equal(socket.readyState, 0);
  socket.open(['{"k":"ready"}']);
  assert.equal(socket.readyState, 0, 'the open is announced on a microtask, after link.js attached its listeners');
  await tick();
  assert.equal(socket.readyState, 1);
  assert.deepEqual(events, [['open', undefined], ['message', '{"k":"ready"}']]);

  socket.send('hello');
  socket.receive('{"k":"users"}');
  assert.deepEqual(written, ['hello']);

  socket.close();
  socket.terminate();
  await tick();
  assert.equal(socket.readyState, 3);
  assert.equal(events.filter(([kind]) => kind === 'close').length, 1);
  socket.send('after');
  socket.receive('after');
  socket.open();
  await tick();
  assert.deepEqual(written, ['hello']);
  assert.equal(socket.readyState, 3);
});

test('TAILCHAT_CORE is on for exactly "1" and nothing else', () => {
  assert.equal(coreRequested({ TAILCHAT_CORE: '1' }), true);
  for (const value of [undefined, '', '0', 'true', 'yes', ' 1', '11', 'on']) {
    assert.equal(coreRequested({ TAILCHAT_CORE: value }), false, String(value));
  }
  assert.equal(coreRequested({}), false);
  assert.equal(coreRequested(undefined), coreRequested(process.env));
});

test('the store is one file per account under the state directory\'s core/', () => {
  assert.equal(coreDbPath('/s', 'Alice'), path.join('/s', 'core', 'alice.db'));
  assert.equal(httpBaseOf('ws://127.0.0.1:7699/tailchat/ws'), 'http://127.0.0.1:7699/tailchat');
  assert.equal(httpBaseOf('wss://chat.example.org/tailchat/ws'), 'https://chat.example.org/tailchat');
  assert.equal(httpBaseOf('wss://chat.example.org/tailchat/ws/'), 'https://chat.example.org/tailchat');
});

test('a module that was never built, or cannot load, is a CoreUnavailable the terminal can explain', () => {
  const missing = path.join(os.tmpdir(), 'tailchat-no-such-core.node');
  assert.throws(() => loadNativeCore({ file: missing }), (error) => (
    error instanceof CoreUnavailable && error.code === 'core-missing' && /build:core/.test(error.message)
  ));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-core-load-'));
  try {
    const file = path.join(dir, 'tailchat_core.node');
    fs.writeFileSync(file, 'not a library');
    assert.throws(() => loadNativeCore({ file, load: () => { throw new Error('invalid ELF header'); } }), (error) => (
      error instanceof CoreUnavailable && error.code === 'core-unloadable' && /invalid ELF header/.test(error.message)
    ));
    assert.throws(() => loadNativeCore({ file, load: () => ({}) }), (error) => (
      error instanceof CoreUnavailable && error.code === 'core-unloadable' && /open\(\)/.test(error.message)
    ));
    const native = { open() {} };
    assert.equal(loadNativeCore({ file, load: () => native }), native);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('open errors are described by their code, and anything else by its own words', () => {
  assert.match(describeCoreError({ code: 'locked' }), /another tailchat/);
  assert.match(describeCoreError({ code: 'bad-token' }), /token/);
  assert.match(describeCoreError({ code: 'bad-url' }), /address/);
  assert.equal(describeCoreError(new Error('unable to open database')), 'unable to open database');
  assert.equal(describeCoreError(new CoreUnavailable('module not built')), 'module not built');
});

test('E2EE frames are withheld by ownsInbound, notices are forwarded, and actions reach the native client', async (context) => {
  const s = session(context);
  await ready(s, { online: true });

  // E2EE control envelopes and encrypted message frames belong to the core, not link.js.
  for (const frame of [
    { k: 'to-device', seq: 1, from: 'bob', fromDevice: 'BBBBBBBBBBBBBBBB', body: { v: 1 } },
    { k: 'to-device-accepted', id: 'td-1', seq: 1 },
    { k: 'device-list-changed', login: 'bob' },
    { k: 'frame', from: 'bob', d: { t: 'msg', id: 'enc-1', e2ee: { v: 1, dev: 'BBBBBBBBBBBBBBBB', sid: 's1', ct: 'QUJD' } } },
  ]) {
    assert.equal(ownsInbound(JSON.stringify(frame)), true);
    s.client.frame(frame);
  }
  assert.deepEqual(s.seen('message'), [], 'encrypted wire frame never reaches link.js as an empty message');

  // E2EE notices from the core reach the terminal.
  s.client.notify({ kind: 'device-registered', deviceId: 'AAAAAAAAAAAAAAAA' });
  s.client.notify({ kind: 'encryption-state', peer: 'bob', encrypted: true });
  s.client.notify({ kind: 'plaintext-held', peer: 'bob', id: 'm-held' });
  s.client.notify({ kind: 'key-changed', peer: 'bob' });
  s.client.notify({ kind: 'unverified-device', peer: 'bob', device: 'DDDDDDDDDDDDDDDD', name: 'Chrome · macOS' });
  s.client.notify({ kind: 'sas-started', transactionId: 'tx-1', peer: 'bob', device: 'BBBBBBBBBBBBBBBB' });
  s.client.notify({ kind: 'sas-code-ready', transactionId: 'tx-1', peer: 'bob', device: 'BBBBBBBBBBBBBBBB', emojiIndices: [1, 2, 3, 4, 5, 6, 7], decimals: [1000, 2000, 3000] });
  s.client.notify({ kind: 'device-keys-conflict' });
  s.client.notify({ kind: 'sas-cancelled', transactionId: 'tx-0', peer: 'bob', device: 'BBBBBBBBBBBBBBBB', reason: 'user_cancelled' });
  s.client.notify({ kind: 'device-verified', peer: 'bob', device: 'BBBBBBBBBBBBBBBB', name: 'Terminal · Linux' });
  s.client.notify({ kind: 'safety-code', peer: 'bob', status: 'ready', halves: [{ login: 'alice', emojiIndices: [1] }], masterKey: 'K', verified: true });
  s.client.notify({ kind: 'backup-created', version: 1, recoveryKey: 'tailchat-backup:v1:1:secret' });
  s.client.notify({ kind: 'backup-info', version: 1, passphraseSalt: 'salt123', sessionCount: 3 });
  s.client.notify({ kind: 'backup-restored', version: 1, sessions: 3 });
  s.client.notify({ kind: 'bad-frame', reason: 'backup: cannot decrypt crossSigning' });
  s.client.notify({ kind: 'cross-signing-reset' });
  s.client.notify({ kind: 'cross-signing-reset-failed', reason: 'bad_password' });
  s.client.notify({ kind: 'encryption-failed', reason: 'keys refused' });

  assert.deepEqual(s.seen('core-device-registered'), [{ deviceId: 'AAAAAAAAAAAAAAAA' }]);
  assert.deepEqual(s.seen('core-encryption-state'), [{ peer: 'bob', encrypted: true }]);
  assert.deepEqual(s.seen('core-plaintext-held'), [{ peer: 'bob', id: 'm-held' }]);
  assert.deepEqual(s.seen('core-key-changed'), [{ peer: 'bob' }]);
  assert.deepEqual(s.seen('core-unverified-device'), [{ peer: 'bob', device: 'DDDDDDDDDDDDDDDD', name: 'Chrome · macOS' }]);
  assert.deepEqual(s.seen('core-sas-started'), [{ transactionId: 'tx-1', peer: 'bob', device: 'BBBBBBBBBBBBBBBB' }]);
  assert.deepEqual(s.seen('core-sas-code-ready')[0].decimals, [1000, 2000, 3000]);
  assert.deepEqual(s.seen('core-device-keys-conflict'), [{}]);
  // A core older than names sends none: the module falls back to the id.
  assert.deepEqual(s.seen('core-sas-cancelled'), [{ transactionId: 'tx-0', peer: 'bob', device: 'BBBBBBBBBBBBBBBB', name: '', reason: 'user_cancelled' }]);
  assert.deepEqual(s.seen('core-device-verified'), [{ peer: 'bob', device: 'BBBBBBBBBBBBBBBB', name: 'Terminal · Linux' }]);
  assert.deepEqual(s.seen('core-safety-code'), [{ peer: 'bob', status: 'ready', halves: [{ login: 'alice', emojiIndices: [1] }], masterKey: 'K', verified: true }]);
  assert.deepEqual(s.seen('core-backup-created'), [{ version: 1, recoveryKey: 'tailchat-backup:v1:1:secret' }]);
  assert.deepEqual(s.seen('core-backup-info'), [{ version: 1, passphraseSalt: 'salt123', sessionCount: 3 }]);
  assert.deepEqual(s.seen('core-backup-restored'), [{ version: 1, sessions: 3 }]);
  // A refused restore reaches /backup restore, which alone knows one is waiting.
  assert.deepEqual(s.seen('core-bad-frame'), [{ reason: 'backup: cannot decrypt crossSigning' }]);
  assert.deepEqual(s.seen('core-cross-signing-reset'), [{}]);
  assert.deepEqual(s.seen('core-cross-signing-reset-failed'), [{ reason: 'bad_password' }]);
  assert.equal(s.seen('status').at(-1).key, 'core.encryptionFailed');

  // E2EE actions on link delegate to the native client.
  s.link.sendUnencrypted('bob', 'm-held');
  s.link.acceptPeerKey('bob');
  s.link.startSas('bob', 'BBBBBBBBBBBBBBBB');
  s.link.confirmSas('tx-1');
  s.link.cancelSas('tx-2');
  s.link.verifyWithQr('tailchat-verify:v1:bob:BBBBBBBBBBBBBBBB:k1:k2');
  s.link.safetyCode('bob');
  s.link.confirmSafetyCode('bob', 'K');
  s.link.createBackup('correct horse battery staple');
  s.link.fetchBackup();
  s.link.restoreBackupWithRecoveryKey('tailchat-backup:v1:1:secret');
  s.link.restoreBackupWithPassphrase('correct horse battery staple', 'salt123');
  s.link.resetCrossSigning('account password');

  assert.deepEqual(s.client.unencrypted, [{ peer: 'bob', id: 'm-held' }]);
  assert.deepEqual(s.client.acceptedKeys, ['bob']);
  assert.deepEqual(s.client.sasStarted, [{ peer: 'bob', device: 'BBBBBBBBBBBBBBBB' }]);
  assert.deepEqual(s.client.sasConfirmed, ['tx-1']);
  assert.deepEqual(s.client.sasCancelled, ['tx-2']);
  assert.deepEqual(s.client.qrVerified, ['tailchat-verify:v1:bob:BBBBBBBBBBBBBBBB:k1:k2']);
  assert.deepEqual(s.client.safetyAsked, ['bob']);
  assert.deepEqual(s.client.safetyConfirmed, [['bob', 'K']]);
  assert.deepEqual(s.client.backupsCreated, ['correct horse battery staple']);
  assert.equal(s.client.backupsFetched, 1);
  assert.deepEqual(s.client.restoredKeys, ['tailchat-backup:v1:1:secret']);
  assert.deepEqual(s.client.restoredPassphrases, [{ pw: 'correct horse battery staple', salt: 'salt123' }]);
  assert.deepEqual(s.client.resets, ['account password']);
});

// A new token is a new device on the server (the device id is bound to the
// token's session), so a store made under another token can never upload its
// keys again. It is moved aside — kept, because its reading sessions still open
// old encrypted history — and only ever on a real change of sign-in.
test('a store from another sign-in is moved aside with its companions; the same sign-in keeps it', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-core-retire-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'alice.db');
  const now = () => 1700000000000;

  // First run: nothing to retire, the sign-in is written down as a hash only.
  assert.deepEqual(retireStaleCoreStore({ dbPath, token: 'tok-one', now }), { retired: null });
  const mark = fs.readFileSync(`${dbPath}.session`, 'utf8');
  assert.match(mark, /^[0-9a-f]{32}\n$/);
  assert.equal(mark.includes('tok-one'), false, 'the token itself is never on disk');
  assert.equal(fs.statSync(`${dbPath}.session`).mode & 0o777, 0o600);

  // The core created its store; the same token opens it again untouched.
  fs.writeFileSync(dbPath, 'db');
  fs.writeFileSync(`${dbPath}-wal`, 'wal');
  assert.deepEqual(retireStaleCoreStore({ dbPath, token: 'tok-one', now }), { retired: null });
  assert.equal(fs.readFileSync(dbPath, 'utf8'), 'db');

  // A new sign-in: the old store and its WAL move together, nothing is lost.
  const out = retireStaleCoreStore({ dbPath, token: 'tok-two', now });
  assert.equal(out.retired, `${dbPath}.retired-1700000000000`);
  assert.equal(fs.existsSync(dbPath), false);
  assert.equal(fs.readFileSync(out.retired, 'utf8'), 'db');
  assert.equal(fs.readFileSync(`${out.retired}-wal`, 'utf8'), 'wal');
  assert.notEqual(fs.readFileSync(`${dbPath}.session`, 'utf8'), mark, 'the new sign-in is now the mark');
  assert.deepEqual(retireStaleCoreStore({ dbPath, token: 'tok-two', now }), { retired: null });
});

test('a store older than the sign-in mark is adopted, not retired', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-core-adopt-'));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'bob.db');
  fs.writeFileSync(dbPath, 'legacy');
  assert.deepEqual(retireStaleCoreStore({ dbPath, token: 'tok', now: () => 1 }), { retired: null });
  assert.equal(fs.readFileSync(dbPath, 'utf8'), 'legacy');
  assert.equal(fs.existsSync(`${dbPath}.session`), true);
});
