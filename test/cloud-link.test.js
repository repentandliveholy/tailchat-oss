import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createAccountStore } from '../src/cloud/accounts.js';
import { createCloudHub } from '../src/cloud/hub.js';
import { createCloudService } from '../src/cloud/server.js';
import { createCloudApi } from '../src/cloud/api.js';
import { startCloudSession } from '../src/cloud/link.js';
import { MAX_FRAME_CHARS } from '../src/frames.js';

// The point of these tests is the seam: `startCloudSession` has to be
// interchangeable with `startRendezvous`, and the only honest way to show that
// is to run the real client transport against the real server and watch the
// events src/cli.js subscribes to arrive in the right order.

function makeWebRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-link-web-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>cloud</title>\n');
  fs.writeFileSync(path.join(dir, 'app.js'), '\n');
  fs.writeFileSync(path.join(dir, 'app.css'), '\n');
  return dir;
}

async function startService(context) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-link-data-'));
  const keyFile = `${dataDir}.master-key`;
  fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const webRoot = makeWebRoot();
  const store = createAccountStore({ dir: dataDir, keyFile, initialize: true });
  const hub = createCloudHub({ store });
  const service = createCloudService({ host: '127.0.0.1', port: 0, dataDir, webRoot, store, hub, trustProxy: true });
  const address = await service.listen();
  const server = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
    fs.rmSync(webRoot, { recursive: true, force: true });
  });
  return { service, store, server, socketUrl: `ws://127.0.0.1:${address.port}/tailchat/ws` };
}

async function makeAccount(server, login, name) {
  const api = createCloudApi({ server });
  const out = await api.register({ login, password: 'correct horse battery', name });
  return out.token;
}

async function befriend(server, tokenA, tokenB) {
  const apiA = createCloudApi({ server, token: tokenA });
  const invite = await apiA.createInvite();
  const apiB = createCloudApi({ server, token: tokenB });
  await apiB.acceptInvite(invite);
}

// The classic link announces `media-ref-v1`, so a picture reaches it as a
// reference and its bytes come from `/api/media` — the way src/cli.js fetches
// them. Whole means: the bytes the sender embedded, every one of them.
async function assertPictureWhole(picture, { server, token, peer, dataUrl, width, height }) {
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  assert.deepEqual(picture.image, { mime: 'image/jpeg', size: bytes.length, width, height },
    'the picture arrives as a reference, not as its caption alone');
  const fetched = await createCloudApi({ server, token }).media({ peer, id: picture.id, slot: 'image' });
  assert.equal(fetched.mime, 'image/jpeg');
  assert.equal(Buffer.compare(fetched.bytes, bytes), 0, 'and the reference resolves to the whole picture');
}

function link({ socketUrl, token, name, peer, peerLabel }) {
  return startCloudSession({ url: socketUrl, token, name, peer, peerLabel });
}

// Resolves on the first matching event, and rejects rather than hanging when the
// transport never gets there: a stuck link must fail the test, not the suite.
function waitFor(ev, kind, { timeoutMs = 10000, match = () => true } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ev.off(kind, onEvent);
      reject(new Error(`no ${kind} within ${timeoutMs}ms`));
    }, timeoutMs);
    function onEvent(payload) {
      if (!match(payload)) return;
      clearTimeout(timer);
      ev.off(kind, onEvent);
      resolve(payload);
    }
    ev.on(kind, onEvent);
  });
}

// A stand-in for the browser client, speaking the server's control protocol
// directly. Nothing else can put an inline picture on the wire: the CLI's own
// sender is the other half of the ceiling under test, so a link-to-link pair
// would prove only that the sender agreed with itself.
async function webClient(socketUrl, token, peer, context) {
  const ws = new WebSocket(socketUrl);
  const control = new EventEmitter();
  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    control.emit(String(message?.k), message);
  });
  ws.on('error', () => {});
  context.after(() => ws.close());
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const ready = waitFor(control, 'ready');
  ws.send(JSON.stringify({ k: 'auth', token }));
  await ready;
  const subscribed = waitFor(control, 'subscribed');
  ws.send(JSON.stringify({ k: 'subscribe', peer }));
  await subscribed;
  return { control, frame: (d) => ws.send(JSON.stringify({ k: 'frame', to: peer, d })) };
}

test('two cloud links exchange a message and its receipts, exactly as the P2P transport does', async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const romanToken = await makeAccount(server, 'roman', 'Роман');
  await befriend(server, annaToken, romanToken);

  const anna = link({ socketUrl, token: annaToken, name: 'Анна', peer: 'roman', peerLabel: 'Роман' });
  const annaOnline = waitFor(anna, 'online');
  const roman = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  const romanOnline = waitFor(roman, 'online');
  context.after(() => { anna.stop(); roman.stop(); });

  // Both sides see the other appear, and the hello behind that event is what
  // every feature gate in the client reads.
  const [annaOnlineResult, romanOnlineResult] = await Promise.all([annaOnline, romanOnline]);
  assert.equal(annaOnlineResult.peerName, 'Роман');
  assert.equal(romanOnlineResult.peerName, 'Анна');
  assert.equal(annaOnlineResult.peerVersion !== null, true, 'the peer version rides on the hello');
  assert.equal(anna.isOnline(), true);
  assert.equal(anna.peerOnline(), true);

  const incoming = waitFor(roman, 'message');
  const id = anna.send('привет из облака', 1000);
  assert.equal(typeof id, 'string');
  const message = await incoming;
  assert.deepEqual(
    { name: message.name, text: message.text, id: message.id },
    { name: 'Анна', text: 'привет из облака', id },
  );
  // A sender whose clock says 1970 does not get to sort itself above the rest
  // of the conversation: the hub stamps anything outside its skew tolerance
  // with its own clock (CLOCK_SKEW_TOLERANCE_MS).
  assert.equal(Math.abs(message.ts - Date.now()) < 60_000, true, 'restamped with server time');

  // Receipts are the same frames as in P2P, which is the whole reason the ✓ and
  // ✓✓ markers work over the cloud without the UI knowing there is a server.
  // The link surfaces only the id of either receipt — `src/session.js` reduces
  // them to `{ id }`, so the `deliveredTs`/`readTs` watermark the hub rides on
  // the wire belongs to `/api/history`'s catch-up path, not this event.
  const ack = waitFor(anna, 'ack');
  roman.sendReceipt('ack', id);
  assert.deepEqual(await ack, { id });
  const read = waitFor(anna, 'read');
  roman.sendReceipt('read', id);
  assert.deepEqual(await read, { id });

  // Typing and a ping answered by the peer's own session code, untouched.
  const typing = waitFor(roman, 'typing');
  anna.sendFrame({ t: 'typing', state: 'start' });
  assert.equal((await typing).state, 'start');
  const pong = waitFor(anna, 'pong');
  const sent = anna.sendPing();
  assert.equal((await pong).id, sent.id);
});

// Regression: media in the cloud protocol is sent inline — a picture or a voice
// note travels as a base64 data URL on the message frame itself, up to
// CLOUD_FRAME_MAX_CHARS (a receiver that announced `media-ref-v1` is handed a
// reference instead). The CLI built this
// channel with the P2P frame ceiling instead, so every such frame was read as
// an overflow: the media was thrown away, the session destroyed the socket
// under the link, and — with nothing listening for that — the link went on
// believing it had a channel, swallowing every frame after it in both
// directions. That is the report "pictures sent from the browser never show up
// in the terminal, and then the conversation goes quiet".
test('a picture from the web client reaches the terminal and leaves the channel alive', async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const romanToken = await makeAccount(server, 'roman', 'Роман');
  await befriend(server, annaToken, romanToken);

  const anna = await webClient(socketUrl, annaToken, 'roman', context);
  const roman = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  context.after(() => roman.stop());
  const problems = [];
  roman.on('status', (s) => { if (s.key === 'cloud.protocolError') problems.push(s); });
  // The browser's hello is what makes the session admit anything, and it has to
  // go out after the subscription has built the channel that receives it.
  await waitFor(roman, 'status', { match: (s) => s.key === 'cloud.peerHere' });
  const online = waitFor(roman, 'online');
  anna.frame({ t: 'hello', name: 'Анна', connId: 'web', v: '0.80.0' });
  await online;

  const dataUrl = `data:image/jpeg;base64,${'a'.repeat(MAX_FRAME_CHARS + 64 * 1024)}`;
  assert.ok(dataUrl.length > MAX_FRAME_CHARS, 'the frame under test has to exceed the P2P ceiling');
  const incoming = waitFor(roman, 'message');
  anna.frame({
    t: 'msg', id: 'pic', text: 'из браузера', ts: 7000, image: { dataUrl, width: 1024, height: 768 },
  });
  const picture = await incoming;
  assert.equal(picture.text, 'из браузера');
  await assertPictureWhole(picture, { server, token: romanToken, peer: 'anna', dataUrl, width: 1024, height: 768 });
  assert.deepEqual(problems, [], 'a legal cloud frame is not a protocol error');

  // The wedge, not the picture: the dropped frame used to take the channel with
  // it, so everything after it — in either direction — was swallowed in silence.
  const next = waitFor(roman, 'message');
  anna.frame({ t: 'msg', id: 'txt', text: 'и словами', ts: 7001 });
  assert.equal((await next).id, 'txt');
  const answered = waitFor(anna.control, 'frame', {
    match: (m) => m.d?.t === 'msg' && m.d?.text === 'вижу',
  });
  assert.ok(roman.send('вижу', 7002), 'the terminal can still answer');
  await answered;
});

// And the same ceiling the other way round: what the terminal itself attaches —
// `/img`, a voice note — has to be accepted by its own sender and survive the
// trip through the server to the other side.
test('inline media the terminal sends is not refused by its own frame ceiling', async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const romanToken = await makeAccount(server, 'roman', 'Роман');
  await befriend(server, annaToken, romanToken);

  const anna = link({ socketUrl, token: annaToken, name: 'Анна', peer: 'roman', peerLabel: 'Роман' });
  const annaOnline = waitFor(anna, 'online');
  const roman = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  const romanOnline = waitFor(roman, 'online');
  context.after(() => { anna.stop(); roman.stop(); });
  await Promise.all([annaOnline, romanOnline]);

  const dataUrl = `data:image/jpeg;base64,${'a'.repeat(MAX_FRAME_CHARS + 64 * 1024)}`;
  assert.ok(dataUrl.length > MAX_FRAME_CHARS, 'the frame under test has to exceed the P2P ceiling');
  const incoming = waitFor(roman, 'message');
  assert.equal(
    anna.sendFrame({
      t: 'msg', id: 'pic', text: 'смотри', ts: 4000, image: { dataUrl, width: 800, height: 600 },
    }),
    true,
    'a frame the server would relay must not be refused by the sender',
  );
  const picture = await incoming;
  assert.equal(picture.text, 'смотри');
  await assertPictureWhole(picture, { server, token: romanToken, peer: 'anna', dataUrl, width: 800, height: 600 });

  // The wedge, not the picture: an overflow used to leave both directions dead
  // for the rest of the session, so a plain message either way is the proof.
  const next = waitFor(roman, 'message');
  const id = anna.send('и ещё словами', 4001);
  assert.equal((await next).id, id);
  const back = waitFor(anna, 'message');
  roman.send('видно', 4002);
  assert.equal((await back).text, 'видно');
});

// The self-heal that picture depends on, exercised directly: whatever ends the
// channel socket — an over-limit frame from a peer speaking a newer protocol, a
// session that gives up on its own — must cost this link one channel, not every
// frame that follows.
test('a destroyed channel socket is rebuilt instead of wedging the link', async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const romanToken = await makeAccount(server, 'roman', 'Роман');
  await befriend(server, annaToken, romanToken);

  const anna = link({ socketUrl, token: annaToken, name: 'Анна', peer: 'roman', peerLabel: 'Роман' });
  const annaOnline = waitFor(anna, 'online');
  const roman = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  const romanOnline = waitFor(roman, 'online');
  context.after(() => { anna.stop(); roman.stop(); });
  await Promise.all([annaOnline, romanOnline]);

  const dead = roman.activeSocket();
  assert.ok(dead, 'there is a channel to lose');
  dead.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rebuilt = roman.activeSocket();
  assert.notEqual(rebuilt, dead, 'the channel is replaced rather than left destroyed');
  assert.equal(rebuilt.writable, true);

  const inbound = waitFor(roman, 'message');
  const sent = anna.send('после разрыва', 5000);
  assert.equal((await inbound).id, sent, 'inbound frames reach the rebuilt channel');
  const outbound = waitFor(anna, 'message');
  const answered = roman.send('и обратно', 5001);
  assert.equal((await outbound).id, answered, 'outbound frames leave the rebuilt channel');
});

// A hello is the one frame the server never keeps (QUEUEABLE in
// src/cloud/hub.js) — so one that reaches a connection which is present but
// not yet subscribed to the sender is dropped: the ordinary order when two
// clients start at the same moment, or one switches conversations. The server
// is the only party that can see the later subscription, so it holds that
// hello on the connection and delivers it the moment the subscription makes
// it useful again.
test('a hello that crossed an unsubscribed connection is delivered once that connection subscribes', async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const romanToken = await makeAccount(server, 'roman', 'Роман');
  await befriend(server, annaToken, romanToken);

  // Роман connects but deliberately does not subscribe: a present connection
  // with no conversation yet, which is exactly what Анна's hello finds.
  const roman = new WebSocket(socketUrl);
  const control = new EventEmitter();
  roman.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    control.emit(String(message?.k), message);
  });
  roman.on('error', () => {});
  context.after(() => roman.close());
  await new Promise((resolve, reject) => {
    roman.once('open', resolve);
    roman.once('error', reject);
  });
  const ready = waitFor(control, 'ready');
  roman.send(JSON.stringify({ k: 'auth', token: romanToken }));
  await ready;

  const anna = link({ socketUrl, token: annaToken, name: 'Анна', peer: 'roman', peerLabel: 'Роман' });
  context.after(() => anna.stop());
  // Анна subscribes while Роман is present but conversationless, so her hello
  // reaches a socket that is not listening for it.
  await waitFor(anna, 'status', { match: (s) => s.key === 'cloud.peerHere' });

  // The subscription is what makes the held hello deliverable.
  const greeting = waitFor(control, 'frame', {
    match: (m) => m.d?.t === 'hello' && m.from === 'anna',
  });
  roman.send(JSON.stringify({ k: 'subscribe', peer: 'anna' }));
  const held = await greeting;
  assert.equal(held.d.name, 'Анна');
  assert.equal(typeof held.d.connId === 'string' && held.d.v !== null, true, 'the delivered hello is the real one, not a stand-in');
});

test('a message sent to an absent account is kept by the server and arrives when that account returns', async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const romanToken = await makeAccount(server, 'roman', 'Роман');
  await befriend(server, annaToken, romanToken);

  const anna = link({ socketUrl, token: annaToken, name: 'Анна', peer: 'roman', peerLabel: 'Роман' });
  context.after(() => anna.stop());

  // Nobody is there, and yet sending must work: this is the one thing the cloud
  // has that the direct connection cannot have.
  await waitFor(anna, 'status', { match: (s) => s.key === 'cloud.peerAway' });
  assert.equal(anna.isOnline(), true, 'the cloud will take a message for an absent peer');
  assert.equal(anna.peerOnline(), false);
  const id = anna.send('это дождётся', 2000);
  assert.equal(typeof id, 'string');

  const roman = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  context.after(() => roman.stop());
  const message = await waitFor(roman, 'message');
  assert.deepEqual(
    { text: message.text, id: message.id },
    { text: 'это дождётся', id },
  );
  assert.equal(Math.abs(message.ts - Date.now()) < 60_000, true, 'restamped with server time');
  // And the queue is not a replay: reconnecting must not deliver it twice.
  const again = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  context.after(() => again.stop());
  await waitFor(again, 'status', { match: (s) => s.key === 'cloud.linked' });
  let repeats = 0;
  again.on('message', () => { repeats++; });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(repeats, 0);
});

// Regression: `admit()` fabricates a stand-in local hello (`v: null`) so a
// queued message — replayed without a hello in front of it, since "hellos
// are not kept" — can still pass the local session parser's hello-first
// gate. That stand-in must never be mistaken for the peer's real version:
// src/cli.js gates AI-frame support on exactly this field
// (isAtLeast(peerVersion, AI_FRAME_VERSION)), and a wrongly-null version
// silently downgrades every AI answer to the pre-0.43.0 plain-text
// fallback — sent as an ordinary message under the replying person's own
// name, which is the bug reported as "the AI answers under my own name".
test('a queued message delivered on reconnect does not blank out the sender\'s known version', async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const romanToken = await makeAccount(server, 'roman', 'Роман');
  await befriend(server, annaToken, romanToken);

  const anna = link({ socketUrl, token: annaToken, name: 'Анна', peer: 'roman', peerLabel: 'Роман' });
  context.after(() => anna.stop());
  await waitFor(anna, 'status', { match: (s) => s.key === 'cloud.peerAway' });
  anna.send('это дождётся', 3000);

  const roman = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  context.after(() => roman.stop());
  // Subscribed before the connect settles: `online` can fire in the very
  // same synchronous pass that admits the queued message (see admit()'s
  // stand-in hello), so waiting for `message` first and only then asking
  // for `online` can miss an `online` that already happened.
  const onlinePromise = waitFor(roman, 'online', { timeoutMs: 15000 });
  await waitFor(roman, 'message');
  const online = await onlinePromise;
  assert.equal(online.peerVersion !== null, true, 'the stand-in hello for a queued message must not blank the real version once known');
});

// Regression: a socket `ws` still believes is open, but on which nothing has
// arrived in a long while, used to sit forever — only `ws.on('close')`
// triggered a reconnect, and nothing made that fire if the server's own
// termination of a dead client never reached this process (a laptop that
// slept through the network path breaking is exactly this: no FIN, no RST,
// just silence). The bug this reproduces is "после включения компьютера cli
// не обновил переписку" — the transport looked connected and nothing synced.
test('a socket that never hears from the server again is terminated and relinked by the local watchdog', async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const romanToken = await makeAccount(server, 'roman', 'Роман');
  await befriend(server, annaToken, romanToken);

  const roman = startCloudSession({
    url: socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна',
    retryMs: 20, retryMaxMs: 20, staleMs: 200, watchdogMs: 30,
  });
  context.after(() => roman.stop());
  await waitFor(roman, 'status', { match: (s) => s.key === 'cloud.linked' });

  // Nothing arrives on the socket from here on — the server's own heartbeat
  // ping is a real 12s away, far outside this window — so a link that only
  // reacted to `ws.on('close')` would sit here indefinitely. The watchdog is
  // what has to notice instead, and reconnect on its own.
  await waitFor(roman, 'status', { match: (s) => s.key === 'cloud.linkLost', timeoutMs: 2000 });
  await waitFor(roman, 'status', { match: (s) => s.key === 'cloud.linked', timeoutMs: 2000 });
});

// The positive test above can't catch a wiring mistake where the transport
// `ping` listener silently never fires (e.g. only 'message' is observed) —
// an idle conversation with a genuinely healthy link never sends or
// receives an application frame between two of the server's real 12s
// heartbeats, so that listener is the only thing standing between "nothing
// happened for a while" and a spurious reconnect loop in production. A raw
// `WebSocket`-shaped stub in full control of the timing is what makes this
// checkable in milliseconds instead of real 12s cycles.
test('the local watchdog leaves a socket alone while genuine pings keep arriving', async (context) => {
  let terminated = false;
  const listeners = new Map();
  const fakeWs = {
    readyState: WebSocket.OPEN,
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return fakeWs;
    },
    send() {},
    close() {},
    terminate() { terminated = true; },
  };
  const emit = (event, ...args) => {
    for (const cb of listeners.get(event) ?? []) cb(...args);
  };

  // Virtual time: on real timers a loaded machine (the full parallel run, a
  // shared CI runner) can stall the 30 ms pinger past `staleMs` and the
  // watchdog then rightly kills the socket — a failure of the test's clock,
  // not of the watchdog.
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const stalled = startCloudSession({
    url: 'ws://example.invalid', token: 't', name: 'x', peer: 'y', peerLabel: 'y',
    connect: () => fakeWs,
    staleMs: 100, watchdogMs: 20,
  });
  context.after(() => stalled.stop());
  emit('open');

  const pinger = setInterval(() => emit('ping', Buffer.alloc(0)), 30);
  context.after(() => clearInterval(pinger));
  for (let step = 0; step < 40; step += 1) context.mock.timers.tick(10);
  clearInterval(pinger);
  assert.equal(terminated, false, 'a socket that keeps receiving heartbeat pings must never be terminated as stale');
});

// Regression: a reaction added from one of an account's own devices (the
// browser) never reached another of that account's own live devices (the
// CLI) on the same conversation — `broadcastWebEvent` only ever reached
// `webFeatures` connections, and the CLI declares none. Reported as
// "реакция в web не видна в cli".
test("a reaction added on one of this account's own devices reaches another live on the same conversation", async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const romanToken = await makeAccount(server, 'roman', 'Роман');
  await befriend(server, annaToken, romanToken);

  // Two of roman's own sessions — both CLI-shaped, not the browser — open on
  // the same conversation with anna.
  const romanCli1 = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  context.after(() => romanCli1.stop());
  const romanCli2 = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  context.after(() => romanCli2.stop());
  await waitFor(romanCli1, 'status', { match: (s) => s.key === 'cloud.linked' });
  await waitFor(romanCli2, 'status', { match: (s) => s.key === 'cloud.linked' });

  // `sync-outgoing` on the second session is the existing self-sync signal
  // for an ordinary message and only fires once the server has durably
  // committed it — waiting for it is what makes the react that follows land
  // on a message `reactHistory` can actually find, without a timing guess.
  const committed = waitFor(romanCli2, 'sync-outgoing');
  const id = romanCli1.send('о чём поговорим?', Date.now());
  assert.equal(typeof id, 'string');
  await committed;

  romanCli1.sendFrame({ t: 'react', id, emoji: '👍', add: true });
  const reacted = await waitFor(romanCli2, 'react');
  assert.deepEqual(reacted, { id, emoji: '👍', by: 'roman', add: true });
});

// Same gap, two more frame kinds: `commitEdit`/`commitDelete` already sent
// their mutation to the peer and to this account's other `webFeatures`
// sessions (`broadcastWebEvent`) but never to a native session of the same
// account. Both now also call `selfSync` (mirroring `commitHide`'s existing
// use of it for `scope:'self'` deletes), and the CLI link falls the self
// frame through to the ordinary parser (`admit`) instead of a bespoke
// event, so it reuses the exact `edit`/`del` handling a peer-originated
// mutation already gets.
test("an edit made on one of this account's own devices reaches another live on the same conversation", async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const romanToken = await makeAccount(server, 'roman', 'Роман');
  await befriend(server, annaToken, romanToken);

  const romanCli1 = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  context.after(() => romanCli1.stop());
  const romanCli2 = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  context.after(() => romanCli2.stop());
  await waitFor(romanCli1, 'status', { match: (s) => s.key === 'cloud.linked' });
  await waitFor(romanCli2, 'status', { match: (s) => s.key === 'cloud.linked' });

  const committed = waitFor(romanCli2, 'sync-outgoing');
  const id = romanCli1.send('опечатка', Date.now());
  assert.equal(typeof id, 'string');
  await committed;

  romanCli1.sendFrame({ t: 'edit', id, text: 'исправлено' });
  const edited = await waitFor(romanCli2, 'edit');
  assert.deepEqual(edited, { id, text: 'исправлено' });
});

test("a read-sync or markRead on one of this account's devices reaches another live session via read-sync", async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const romanToken = await makeAccount(server, 'roman', 'Роман');
  await befriend(server, annaToken, romanToken);

  const romanCli1 = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  context.after(() => romanCli1.stop());
  const romanCli2 = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  context.after(() => romanCli2.stop());
  await waitFor(romanCli1, 'status', { match: (s) => s.key === 'cloud.linked' });
  await waitFor(romanCli2, 'status', { match: (s) => s.key === 'cloud.linked' });

  const readPromise = waitFor(romanCli2, 'read-sync');
  romanCli1.markRead('anna');
  const received = await readPromise;
  assert.equal(received.peer, 'anna');
});

test("a deletion made on one of this account's own devices reaches another live on the same conversation", async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const romanToken = await makeAccount(server, 'roman', 'Роман');
  await befriend(server, annaToken, romanToken);

  const romanCli1 = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  context.after(() => romanCli1.stop());
  const romanCli2 = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  context.after(() => romanCli2.stop());
  await waitFor(romanCli1, 'status', { match: (s) => s.key === 'cloud.linked' });
  await waitFor(romanCli2, 'status', { match: (s) => s.key === 'cloud.linked' });

  const committed = waitFor(romanCli2, 'sync-outgoing');
  const id = romanCli1.send('лишнее', Date.now());
  assert.equal(typeof id, 'string');
  await committed;

  romanCli1.sendFrame({ t: 'del', ids: [id], scope: 'all' });
  const deleted = await waitFor(romanCli2, 'del');
  assert.deepEqual(deleted, { ids: [id] });
});

// `commitHide` (scope:'self' — "delete for me alone") already called
// `selfSync` before this round; nothing on the CLI side ever consumed it,
// so it was dead weight. Distinct code path from the scope:'all' test
// above — `commitHide`, not `commitDelete` — and the peer must see nothing
// at all, which is the entire point of "delete for me".
test("a self-scope deletion reaches this account's other devices, and never the peer", async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const romanToken = await makeAccount(server, 'roman', 'Роман');
  await befriend(server, annaToken, romanToken);

  const anna = link({ socketUrl, token: annaToken, name: 'Анна', peer: 'roman', peerLabel: 'Роман' });
  context.after(() => anna.stop());
  const romanCli1 = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  context.after(() => romanCli1.stop());
  const romanCli2 = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  context.after(() => romanCli2.stop());
  await waitFor(romanCli1, 'status', { match: (s) => s.key === 'cloud.linked' });
  await waitFor(romanCli2, 'status', { match: (s) => s.key === 'cloud.linked' });

  const committed = waitFor(romanCli2, 'sync-outgoing');
  const id = romanCli1.send('только у меня', Date.now());
  assert.equal(typeof id, 'string');
  await committed;

  let annaSawIt = false;
  anna.on('del', () => { annaSawIt = true; });
  romanCli1.sendFrame({ t: 'del', ids: [id], scope: 'self' });
  const deleted = await waitFor(romanCli2, 'del');
  assert.deepEqual(deleted, { ids: [id] });
  assert.equal(annaSawIt, false, '"delete for me" must never reach the peer');
});

test('a peer coming and going is reported as online and offline, and a transfer is refused while they are away', async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const romanToken = await makeAccount(server, 'roman', 'Роман');
  await befriend(server, annaToken, romanToken);

  const anna = link({ socketUrl, token: annaToken, name: 'Анна', peer: 'roman', peerLabel: 'Роман' });
  context.after(() => anna.stop());
  const roman = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  await waitFor(anna, 'online');

  // A file into an absent account would be bytes the server drops, so the
  // transport refuses the frame instead of letting a progress bar lie.
  const gone = waitFor(anna, 'offline');
  roman.stop();
  await gone;
  assert.equal(anna.peerOnline(), false);
  assert.equal(anna.writable(), false);
  assert.equal(anna.sendFrame({ t: 'file-offer', id: 'abc', name: 'x', size: 1 }), false);
  assert.equal(anna.sendFrame({ t: 'msg', id: 'def', text: 'а это можно', ts: 3000 }), true);

  const back = link({ socketUrl, token: romanToken, name: 'Роман', peer: 'anna', peerLabel: 'Анна' });
  context.after(() => back.stop());
  const returned = await waitFor(anna, 'online');
  assert.equal(returned.peerName, 'Роман');
  assert.equal(anna.writable(), true);
  assert.equal(anna.sendFrame({ t: 'file-offer', id: 'abc', name: 'x', size: 1 }), true);
});

// Regression: the roster's green dot and the header's status come from the same
// fact — the relay's presence answer — but the header waited for the peer's
// *hello* before saying anything but «connecting…», and a client sitting in
// another conversation never sends one. A contact the roster showed as online
// therefore looked unreachable in the conversation for the whole session.
// Reported as «cli показывает connecting — тогда как контакты online».
test("the relay's presence answer reaches the client without the peer's hello", async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const romanToken = await makeAccount(server, 'roman', 'Роман');
  await befriend(server, annaToken, romanToken);

  // Роман is on the relay in another conversation: authorised and present, no
  // subscription here, and he never greets this side.
  const roman = new WebSocket(socketUrl);
  roman.on('error', () => {});
  context.after(() => roman.close());
  await new Promise((resolve, reject) => {
    roman.once('open', resolve);
    roman.once('error', reject);
  });
  const ready = new Promise((resolve) => {
    roman.on('message', (data) => {
      try {
        if (JSON.parse(String(data))?.k === 'ready') resolve();
      } catch { /* not ours */ }
    });
  });
  roman.send(JSON.stringify({ k: 'auth', token: romanToken }));
  await ready;

  const anna = link({ socketUrl, token: annaToken, name: 'Анна', peer: 'roman', peerLabel: 'Роман' });
  context.after(() => anna.stop());
  const present = await waitFor(anna, 'present');
  assert.deepEqual(present, { present: true, peerName: 'Роман' });
  assert.equal(anna.peerOnline(), true, 'the relay says they are here');

  // And nothing is claimed about who they are: no hello has been exchanged, so
  // the identity — the name and version every capability gate reads — is still
  // unknown rather than invented.
  let greeted = false;
  anna.on('online', () => { greeted = true; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(greeted, false, 'presence without a greeting is presence, and only that');

  // The same answer the other way round when they leave.
  const gone = waitFor(anna, 'present', { match: (answer) => answer.present === false });
  roman.close();
  assert.equal((await gone).present, false);
  assert.equal(anna.peerOnline(), false);
});

// The other half of the same bug: a peer who is away when the conversation
// opens was answered `subscribed: online false`, which no longer moved any
// state the header listens to — so a switch to an offline contact sat on
// «connecting…» exactly like a switch to an online one.
test('a peer who is away when the conversation opens is answered present:false', async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const romanToken = await makeAccount(server, 'roman', 'Роман');
  await befriend(server, annaToken, romanToken);

  // Роман exists as a friend but has no connection at all.
  assert.equal(typeof romanToken, 'string');
  const anna = link({ socketUrl, token: annaToken, name: 'Анна', peer: 'roman', peerLabel: 'Роман' });
  context.after(() => anna.stop());
  const answer = await waitFor(anna, 'present');
  assert.equal(answer.present, false);
  assert.equal(answer.peerName, 'Роман');
  assert.equal(anna.peerOnline(), false);
});

// The answer names the peer the conversation was opened on, not whoever was in
// it last: the header is painted from this name, and one carried over from the
// conversation just left would show the wrong person until they greeted us.
test('a switch reports the new peer, never the greeting of the one left behind', async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const bobToken = await makeAccount(server, 'bob', 'Боб');
  const carolToken = await makeAccount(server, 'carol', 'Кэрол');
  await befriend(server, annaToken, bobToken);
  await befriend(server, annaToken, carolToken);

  // Боб is here and greets, so the link knows exactly who he is.
  const bob = await webClient(socketUrl, bobToken, 'anna', context);
  const anna = link({ socketUrl, token: annaToken, name: 'Анна', peer: 'bob', peerLabel: 'Боб' });
  context.after(() => anna.stop());
  await waitFor(anna, 'present');
  const greeted = waitFor(anna, 'online');
  bob.frame({ t: 'hello', name: 'Боб', connId: 'web', v: 'web' });
  assert.equal((await greeted).peerName, 'Боб');

  // Кэрол is not connected at all, and the answer for her must name her.
  const answer = waitFor(anna, 'present', { match: (a) => a.present === false });
  anna.switchPeer('carol', 'Кэрол');
  assert.deepEqual(await answer, { present: false, peerName: 'Кэрол' });
});

test('a token the server does not know stops the link instead of looping on it', async (context) => {
  const { socketUrl } = await startService(context);
  const link = startCloudSession({
    url: socketUrl,
    token: 'not-a-token',
    name: 'Анна',
    peer: 'roman',
    peerLabel: 'Роман',
    retryMs: 10,
    retryMaxMs: 10,
  });
  context.after(() => link.stop());
  const said = await waitFor(link, 'status', { match: (s) => s.key === 'cloud.tokenRejected' });
  assert.equal(said.key, 'cloud.tokenRejected');
  assert.equal(link.isOnline(), false);
  // Nothing may be dialled again: a rejected token fails identically forever.
  let retried = false;
  link.on('reaching', () => { retried = true; });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(retried, false);
});

test('the transport answers everything src/cli.js asks of a rendezvous', async (context) => {
  const { server, socketUrl } = await startService(context);
  const token = await makeAccount(server, 'anna', 'Анна');
  const anna = link({ socketUrl, token, name: 'Анна', peer: 'roman', peerLabel: 'Роман' });
  context.after(() => anna.stop());
  for (const method of [
    'send', 'sendFrame', 'sendReceipt', 'sendPing', 'writable', 'writeFrame', 'flushed',
    'isOnline', 'isDialling', 'boundPort', 'target', 'targets', 'setTarget', 'setTargets',
    'refreshAllowed', 'retryDelay', 'activeSocket', 'reconnect', 'standDown', 'stop',
    // The account feed and the acceptance receipt: `cli.js` asks for both, and a
    // transport missing either is one the terminal has to special-case.
    'sendSync', 'markRead', 'markUnread',
  ]) {
    assert.equal(typeof anna[method], 'function', `rz.${method} must exist in cloud mode`);
  }
  assert.equal(anna.boundPort(), null, 'nothing is listening in cloud mode');
  assert.deepEqual(anna.target(), { host: 'roman', port: 0 });
  assert.equal(anna.caps instanceof Set, true, 'the server\'s caps are read live off the link');
});

/**
 * What the terminal needs from the cloud, beyond messages arriving: the
 * server's own proof that a message it wrote is committed, and the account feed
 * that tells it about everything that happened while it was not the subscribed
 * conversation.
 *
 * Over the cloud the write reaching the socket proves nothing — the hub can drop
 * the frame over its frame budget, and the socket can die between the write and
 * the answer — so `cli.js` keeps its queue entry until `message-accepted`
 * (`durable-ack`) or the peer's own receipt proves the server has it. Both
 * halves are checked here against the real server: the receipt for a send, and a
 * nudge followed by the `sync` the terminal answers it with.
 */
test('a send over the cloud is confirmed by the server and the feed answers a nudge', async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const romanToken = await makeAccount(server, 'roman', 'Роман');
  await befriend(server, annaToken, romanToken);

  const roman = await webClient(socketUrl, romanToken, 'anna', context);
  const anna = link({ socketUrl, token: annaToken, name: 'Анна', peer: 'roman', peerLabel: 'Роман' });
  context.after(() => anna.stop());
  // The relay says the peer's account is here. Not `online`: that one needs a
  // hello from the peer, and the browser is the one client that does not send
  // one — a terminal is reachable without it (`cloud.peerHere`), which is
  // exactly why `cli.js` tracks that state separately.
  await waitFor(anna, 'status', { match: (s) => s.key === 'cloud.peerHere' });

  const accepted = waitFor(anna, 'accepted');
  const id = anna.send('подтверди', 1000);
  const receipt = await accepted;
  assert.equal(receipt.id, id, 'the receipt names the message the queue is holding');
  assert.equal(typeof receipt.seq, 'number', 'the sequence is what the cursor is compared against');
  assert.equal(Number.isFinite(receipt.ts), true, 'and the committed time, which the peer also has');

  // The peer replies: the terminal is subscribed here, so the frame arrives —
  // and the account feed has moved as well, which is what the nudge says.
  const nudge = waitFor(anna, 'sync-nudge');
  roman.frame({ t: 'msg', id: 'm-reply', text: 'ответ', ts: Date.now() });
  await nudge;

  const page = waitFor(anna, 'sync-page');
  anna.sendSync(0, 200);
  const first = await page;
  assert.equal(Array.isArray(first.events), true);
  assert.equal(first.events.length > 0, true, 'the feed carries the mutations, not just a cursor');
  assert.equal(
    first.events.every((event) => typeof event.kind === 'string' && typeof event.seq === 'number'),
    true,
  );
  assert.equal(
    first.events.some((event) => event.kind === 'message' && event.id === 'm-reply'),
    true,
    'the reply this account did receive is in the log the terminal pages through',
  );
});

// Regression: walking the bottom roster with Ctrl+←/→ mixed conversations up.
// A frame from a peer who is connected but has not greeted this side waits for
// that hello (see `admit`), and `openChannel` keeps the queue across a channel
// replacement on purpose. Across a *peer* change that rule handed the held
// frame to the next conversation's channel the moment the new peer greeted us:
// the previous person's message printed under the current person's name.
// Reported as «cli roster глючит, путает беседы и даже сообщения».
test('a frame held for one peer is not admitted into the conversation switched to', async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const bobToken = await makeAccount(server, 'bob', 'Боб');
  const carolToken = await makeAccount(server, 'carol', 'Кэрол');
  await befriend(server, annaToken, bobToken);
  await befriend(server, annaToken, carolToken);

  const bob = await webClient(socketUrl, bobToken, 'anna', context);
  const carol = await webClient(socketUrl, carolToken, 'anna', context);
  const anna = link({ socketUrl, token: annaToken, name: 'Анна', peer: 'bob', peerLabel: 'Боб' });
  context.after(() => anna.stop());
  await waitFor(anna, 'status', { match: (s) => s.key === 'cloud.peerHere' });

  const seen = [];
  anna.on('message', (m) => seen.push(m));
  // Боб is here and says something without greeting first, so the frame is
  // held for the hello the server says is coming. The wait is what makes it
  // genuinely held rather than merely in flight — and it is well inside the
  // 1500ms hello grace, so nothing releases it before the switch.
  bob.frame({ t: 'msg', id: 'from-bob', text: 'от боба', ts: Date.now() });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(seen, [], 'the frame under test has to be waiting for a hello, not delivered');

  anna.switchPeer('carol', 'Кэрол');
  await waitFor(anna, 'status', { match: (s) => s.key === 'cloud.peerHere' });
  const incoming = waitFor(anna, 'message');
  carol.frame({ t: 'hello', name: 'Кэрол', connId: 'web', v: '0.80.0' });
  carol.frame({ t: 'msg', id: 'from-carol', text: 'от кэрол', ts: Date.now() });
  assert.equal((await incoming).text, 'от кэрол');
  // Long enough that a flush riding the hello would have landed by now.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(
    seen.map((m) => m.id), ['from-carol'],
    "a held frame from the previous conversation must never enter this one",
  );
});

// Regression: the hub keeps treating a connection as an active viewer of the
// conversation it last subscribed to, so switching away from a cloud peer left
// that peer's later messages counted as delivered live — into a transport the
// client had already detached. The client did synthesise a badge from the
// frame, but the account's own unread count stayed at zero, and the next
// `users` broadcast (pending: 0) wiped that badge again.
test('leaving a cloud conversation unsubscribes, so that peer\'s next message comes back as unread', async (context) => {
  const { server, socketUrl } = await startService(context);
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const bobToken = await makeAccount(server, 'bob', 'Боб');
  await befriend(server, annaToken, bobToken);

  const bob = await webClient(socketUrl, bobToken, 'anna', context);
  const anna = link({ socketUrl, token: annaToken, name: 'Анна', peer: 'bob', peerLabel: 'Боб' });
  context.after(() => anna.stop());
  await waitFor(anna, 'status', { match: (s) => s.key === 'cloud.linked' });

  anna.switchPeer(null, null);
  // The unsubscribe is one frame with no ack of its own; it has to be in the
  // server's hands before the message that tests it is sent.
  await new Promise((resolve) => setTimeout(resolve, 150));

  const unread = waitFor(anna, 'unread');
  bob.frame({ t: 'msg', id: 'while-away', text: 'пока ты смотрел в другую беседу', ts: Date.now() });
  const badge = await unread;
  assert.deepEqual(
    { from: badge.from, text: badge.text, count: badge.count },
    { from: 'bob', text: 'пока ты смотрел в другую беседу', count: 1 },
    'the message has to be queued and counted by the server, not merely noticed by the client',
  );
});

// Regression: a burst of roster keypresses puts several subscribes on the wire
// before the first ack returns. An ack for a conversation already left used to
// decide `peerHere` and the focus state of the one now open — the previous
// person's presence shown under the current person's name.
test('a subscription ack for a conversation already left is ignored', (context) => {
  const sent = [];
  const listeners = new Map();
  const fakeWs = {
    readyState: WebSocket.OPEN,
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return fakeWs;
    },
    send(payload) { sent.push(JSON.parse(String(payload))); },
    close() {},
    terminate() {},
  };
  const emit = (event, ...args) => {
    for (const cb of listeners.get(event) ?? []) cb(...args);
  };
  // The channel's own hello rides the same socket right behind a subscribe,
  // so the control frame under test is the last *subscribe*, not the last send.
  const lastSubscribe = () => sent.filter((payload) => payload.k === 'subscribe').at(-1);

  const anna = startCloudSession({
    url: 'ws://example.invalid', token: 't', name: 'Анна', peer: 'bob', peerLabel: 'Боб',
    connect: () => fakeWs,
  });
  context.after(() => anna.stop());
  emit('open');
  emit('message', JSON.stringify({ k: 'ready', users: [] }));
  assert.deepEqual(lastSubscribe(), { k: 'subscribe', peer: 'bob' });

  anna.switchPeer('carol', 'Кэрол');
  assert.deepEqual(lastSubscribe(), { k: 'subscribe', peer: 'carol' });
  const focus = [];
  anna.on('focus', (f) => focus.push(f.state));

  emit('message', JSON.stringify({ k: 'subscribed', peer: 'bob', online: true, state: 'active' }));
  assert.equal(anna.peerOnline(), false, 'presence from the conversation left must not land on this one');
  assert.deepEqual(focus, [], 'nor its focus state');

  emit('message', JSON.stringify({ k: 'subscribed', peer: 'carol', online: true, state: 'idle' }));
  assert.equal(anna.peerOnline(), true);
  assert.deepEqual(focus, ['idle']);

  // No peer left is the hub's unsubscribe, and it has to be said out loud.
  anna.switchPeer(null, null);
  assert.deepEqual(lastSubscribe(), { k: 'subscribe', peer: '' });
});

// Regression: a conversation the server refuses (`peer_not_found` — a name that
// is not a friend, which a stale roster entry or a typed `/peer` reaches easily)
// used to stand the whole link down for the rest of the session. Nothing was
// redialled after that, so the *next* socket drop — a redeploy, or the
// memory-ceiling restart PM2 performs — left the terminal offline until it was
// restarted. Reported as «коннект потерял cli после минут 10 работы — restart
// восстановил его».
test('a refused conversation does not cost the link the next reconnect', async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-link-restart-data-'));
  const keyFile = `${dataDir}.master-key`;
  fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const webRoot = makeWebRoot();
  // A real restart: the process is gone, the data and the port are not.
  const services = [];
  const boot = async (port) => {
    const store = createAccountStore({ dir: dataDir, keyFile, initialize: true });
    const hub = createCloudHub({ store });
    const service = createCloudService({
      host: '127.0.0.1', port, dataDir, webRoot, store, hub, trustProxy: true,
    });
    services.push(service);
    const address = await service.listen();
    return { service, port: address.port ?? port };
  };
  context.after(async () => {
    for (const service of services) await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
    fs.rmSync(webRoot, { recursive: true, force: true });
  });

  let { service, port } = await boot(0);
  const server = `http://127.0.0.1:${port}`;
  const annaToken = await makeAccount(server, 'anna', 'Анна');
  const romanToken = await makeAccount(server, 'roman', 'Роман');
  await befriend(server, annaToken, romanToken);

  const anna = startCloudSession({
    url: `ws://127.0.0.1:${port}/tailchat/ws`,
    token: annaToken, name: 'Анна', peer: 'roman', peerLabel: 'Роман',
    retryMs: 20, retryMaxMs: 20,
  });
  context.after(() => anna.stop());
  await waitFor(anna, 'status', { match: (s) => s.key === 'cloud.linked' });

  // One conversation the server will not open, while the link itself is fine.
  anna.switchPeer('stranger', 'Stranger');
  await waitFor(anna, 'status', { match: (s) => s.key === 'cloud.peerUnknown' });

  await service.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  ({ service, port } = await boot(port));

  // The conversation that does exist has to be reachable again: with the link
  // stood down there is no socket left to carry that subscribe.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  anna.switchPeer('roman', 'Роман');
  await waitFor(anna, 'status', { match: (s) => s.key === 'cloud.linked', timeoutMs: 8000 });
});
