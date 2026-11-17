// History with media references instead of inline bytes, and the route that
// serves those bytes (docs/specs/2026-11-03-history-media-refs.md §5–6, §13.1).
// Everything runs against an isolated server with temporary data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { createAccountStore } from '../src/cloud/accounts.js';
import { createCloudHub } from '../src/cloud/hub.js';
import { createCloudService } from '../src/cloud/server.js';
import { MEDIA_REF_CAP, parseRange, withMediaRefs } from '../src/cloud/media-ref.js';
import { MEDIA_INFLIGHT_PER_ACCOUNT } from '../src/cloud/limits.js';

// Real bytes that are not base64-shaped text, so a server that sent the
// encoded string instead of the decoded bytes could not pass by accident.
const IMAGE_BYTES = randomBytes(3000);
const VOICE_BYTES = randomBytes(1001);
const IMAGE = { dataUrl: `data:image/png;base64,${IMAGE_BYTES.toString('base64')}`, width: 640, height: 480 };
const VOICE = { dataUrl: `data:audio/webm;codecs=opus;base64,${VOICE_BYTES.toString('base64')}`, duration: 12.34 };

async function startService(context) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-media-data-'));
  const keyFile = `${dataDir}.master-key`;
  fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-media-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html>\n');
  const store = createAccountStore({ dir: dataDir, keyFile, initialize: true });
  const hub = createCloudHub({ store });
  const logs = [];
  const service = createCloudService({
    host: '127.0.0.1', port: 0, dataDir, webRoot, store, hub, trustProxy: false, ownerLogin: null,
    mediaLog: (line) => logs.push(line),
  });
  const address = await service.listen();
  context.after(async () => {
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
    fs.rmSync(webRoot, { recursive: true, force: true });
  });
  return { store, port: address.port, logs };
}

// Bytes back, not text: the media route's body is binary.
function request(port, method, requestPath, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const sent = { ...headers };
    if (payload !== null) {
      sent['Content-Type'] = 'application/json';
      sent['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) sent.Authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers: sent }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch { json = null; }
        resolve({ status: response.statusCode, headers: response.headers, raw, json });
      });
    });
    req.once('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function wsClient(port) {
  const frames = [];
  const emitter = new EventEmitter();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/tailchat/ws`);
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString('utf8'));
    frames.push(frame);
    emitter.emit('frame', frame);
  });
  await once(socket, 'open');
  const waitFor = (match, timeoutMs = 4000) => {
    const test = typeof match === 'string' ? (frame) => frame.k === match : match;
    const found = frames.find(test);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        emitter.off('frame', onFrame);
        reject(new Error(`timed out; saw ${JSON.stringify(frames).slice(0, 2000)}`));
      }, timeoutMs);
      const onFrame = (frame) => {
        if (!test(frame)) return;
        clearTimeout(timer);
        emitter.off('frame', onFrame);
        resolve(frame);
      };
      emitter.on('frame', onFrame);
    });
  };
  return {
    frames,
    waitFor,
    send(payload) { socket.send(JSON.stringify(payload)); },
    close() { socket.close(); },
  };
}

async function makeAccount(port, login) {
  const response = await request(port, 'POST', '/tailchat/api/register', {
    body: { login, password: 'correct horse', name: login },
  });
  assert.equal(response.status, 201, response.raw.toString());
  return response.json.token;
}

async function befriend(port, a, b) {
  const invite = await request(port, 'POST', '/tailchat/api/invite', { token: a });
  await request(port, 'POST', '/tailchat/api/invite/accept', { token: b, body: { invite: invite.json.invite } });
}

// olga and roman, friends, with one picture and one voice note from olga in
// their history, written through the socket the way any client writes them.
async function twoFriendsWithMedia(context) {
  const service = await startService(context);
  const { port } = service;
  const olga = await makeAccount(port, 'olga');
  const roman = await makeAccount(port, 'roman');
  await befriend(port, olga, roman);
  const socket = await wsClient(port);
  context.after(() => socket.close());
  socket.send({ k: 'auth', token: olga, caps: ['op-ack-v1'] });
  await socket.waitFor('ready');
  socket.send({ k: 'subscribe', peer: 'roman' });
  await socket.waitFor('subscribed');
  socket.send({ k: 'frame', to: 'roman', d: { t: 'msg', id: 'pic-1', text: '', ts: 1_756_900_000_000, image: IMAGE } });
  await socket.waitFor((frame) => frame.k === 'message-accepted' && frame.id === 'pic-1');
  socket.send({ k: 'frame', to: 'roman', d: { t: 'msg', id: 'voice-1', text: 'привет', ts: 1_756_900_000_100, voice: VOICE } });
  await socket.waitFor((frame) => frame.k === 'message-accepted' && frame.id === 'voice-1');
  return { ...service, olga, roman, olgaSocket: socket };
}

const media = (port, token, query, headers) => request(port, 'GET', `/tailchat/api/media?${query}`, { token, headers });

test('without media=ref, /api/history is byte for byte what installed clients read', async (context) => {
  const { port, roman } = await twoFriendsWithMedia(context);
  const plain = await request(port, 'GET', '/tailchat/api/history?peer=olga', { token: roman });
  const inline = await request(port, 'GET', '/tailchat/api/history?peer=olga&media=inline', { token: roman });
  assert.equal(plain.status, 200);
  assert.deepEqual(plain.raw, inline.raw, 'media=inline is the same answer as no parameter');
  assert.deepEqual(plain.json.messages.find((m) => m.id === 'pic-1').image, IMAGE);
  assert.deepEqual(plain.json.messages.find((m) => m.id === 'voice-1').voice, VOICE);
  assert.equal('media' in plain.json, false);

  const typo = await request(port, 'GET', '/tailchat/api/history?peer=olga&media=refs', { token: roman });
  assert.equal(typo.status, 400, 'a typo must not silently pick a mode');
  assert.equal(typo.json.error, 'bad_request');
});

test('media=ref describes each attachment, and the route serves exactly that many bytes', async (context) => {
  const { port, roman } = await twoFriendsWithMedia(context);
  const page = await request(port, 'GET', '/tailchat/api/history?peer=olga&media=ref', { token: roman });
  assert.equal(page.status, 200);
  assert.equal(page.json.media, 'ref');
  const pic = page.json.messages.find((m) => m.id === 'pic-1');
  const voice = page.json.messages.find((m) => m.id === 'voice-1');
  assert.deepEqual(pic.image, { mime: 'image/png', size: IMAGE_BYTES.length, width: 640, height: 480 });
  assert.deepEqual(voice.voice, { mime: 'audio/webm;codecs=opus', size: VOICE_BYTES.length, duration: 12.34 });
  assert.equal(page.raw.includes('data:'), false, 'no inline bytes anywhere in the page');
  assert.equal(voice.text, 'привет', 'the rest of the record is untouched');

  const image = await media(port, roman, 'peer=olga&id=pic-1&slot=image');
  assert.equal(image.status, 200);
  assert.deepEqual(image.raw, IMAGE_BYTES);
  assert.equal(Number(image.headers['content-length']), pic.image.size);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.equal(image.headers['cache-control'], 'private, no-store');
  assert.equal(image.headers['accept-ranges'], 'bytes');
  assert.match(image.headers.etag, /^"[A-Za-z0-9_-]{22}"$/);
  assert.equal(image.headers['x-content-type-options'], 'nosniff');
  assert.match(image.headers['content-security-policy'], /default-src 'self'/);

  const sound = await media(port, roman, 'peer=olga&id=voice-1&slot=voice');
  assert.deepEqual(sound.raw, VOICE_BYTES);
  assert.equal(sound.headers['content-type'], 'audio/webm;codecs=opus');

  // The sender reads her own message's bytes the same way.
  const own = await media(port, (await request(port, 'POST', '/tailchat/api/login', {
    body: { login: 'olga', password: 'correct horse' },
  })).json.token, 'peer=roman&id=pic-1&slot=image');
  assert.deepEqual(own.raw, IMAGE_BYTES);

  const head = await request(port, 'HEAD', '/tailchat/api/media?peer=olga&id=pic-1&slot=image', { token: roman });
  assert.equal(head.status, 200);
  assert.equal(head.raw.length, 0);
  assert.equal(Number(head.headers['content-length']), IMAGE_BYTES.length);
  assert.equal(head.headers.etag, image.headers.etag);
});

test('Range, If-Range and If-None-Match follow RFC 9110', async (context) => {
  const { port, roman } = await twoFriendsWithMedia(context);
  const q = 'peer=olga&id=pic-1&slot=image';
  const size = IMAGE_BYTES.length;
  const { etag } = (await media(port, roman, q)).headers;

  const first = await media(port, roman, q, { Range: 'bytes=0-99' });
  assert.equal(first.status, 206);
  assert.deepEqual(first.raw, IMAGE_BYTES.subarray(0, 100));
  assert.equal(first.headers['content-range'], `bytes 0-99/${size}`);

  const tail = await media(port, roman, q, { Range: 'bytes=-100' });
  assert.deepEqual(tail.raw, IMAGE_BYTES.subarray(size - 100));
  const rest = await media(port, roman, q, { Range: 'bytes=2900-' });
  assert.deepEqual(rest.raw, IMAGE_BYTES.subarray(2900));
  const clipped = await media(port, roman, q, { Range: `bytes=2990-${size + 500}` });
  assert.equal(clipped.headers['content-range'], `bytes 2990-${size - 1}/${size}`);

  const beyond = await media(port, roman, q, { Range: `bytes=${size}-` });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers['content-range'], `bytes */${size}`);
  assert.equal((await media(port, roman, q, { Range: 'bytes=-0' })).status, 416);

  const several = await media(port, roman, q, { Range: 'bytes=0-1,5-6' });
  assert.equal(several.status, 200, 'several ranges: the whole thing, no multipart');
  assert.deepEqual(several.raw, IMAGE_BYTES);

  assert.equal((await media(port, roman, q, { Range: 'bytes=0-9', 'If-Range': etag })).status, 206);
  const stale = await media(port, roman, q, { Range: 'bytes=0-9', 'If-Range': '"something-else"' });
  assert.equal(stale.status, 200, 'another version: the whole, current bytes');
  assert.deepEqual(stale.raw, IMAGE_BYTES);

  const cached = await media(port, roman, q, { 'If-None-Match': etag });
  assert.equal(cached.status, 304);
  assert.equal(cached.raw.length, 0);
});

test('the media route refuses exactly what the history would not show', async (context) => {
  const { port, store, roman, olga, olgaSocket } = await twoFriendsWithMedia(context);
  const ok = 'peer=olga&id=pic-1&slot=image';

  assert.equal((await media(port, null, ok)).status, 401);
  assert.equal((await media(port, 'ffff', ok)).status, 401);
  for (const bad of ['peer=olga&id=pic-1&slot=file', 'peer=olga&slot=image', 'peer=x&id=pic-1&slot=image',
    `peer=olga&id=${'a'.repeat(1025)}&slot=image`, 'peer=olga&id=a%0Ab&slot=image']) {
    const refused = await media(port, roman, bad);
    assert.equal(refused.status, 400, bad);
    assert.equal(refused.json.error, 'bad_request');
  }

  const stranger = await makeAccount(port, 'pavel');
  const notFriend = await media(port, stranger, ok);
  assert.equal(notFriend.status, 403);
  assert.equal(notFriend.json.error, 'not_friends');

  assert.equal((await media(port, roman, 'peer=olga&id=nope&slot=image')).status, 404);
  assert.equal((await media(port, roman, 'peer=olga&id=voice-1&slot=image')).status, 404, 'no picture in a voice note');

  // Evicted by the conversation's media budget: the text stays, the bytes are gone for good.
  store.recordHistory('olga', 'roman', { id: 'old-1', from: 'olga', text: 'was a photo', ts: 1_756_800_000_000, mediaDropped: true });
  const evicted = await media(port, roman, 'peer=olga&id=old-1&slot=image');
  assert.equal(evicted.status, 410);
  assert.equal(evicted.json.error, 'media_evicted');

  // Hidden "for me" by roman: gone for him, still there for olga.
  const romanSocket = await wsClient(port);
  context.after(() => romanSocket.close());
  romanSocket.send({ k: 'auth', token: roman, caps: ['op-ack-v1'] });
  await romanSocket.waitFor('ready');
  romanSocket.send({ k: 'subscribe', peer: 'olga' });
  await romanSocket.waitFor('subscribed');
  romanSocket.send({ k: 'frame', to: 'olga', d: { t: 'del', ids: ['voice-1'], scope: 'self', opId: 'h1' } });
  await romanSocket.waitFor((frame) => frame.k === 'op-accepted' || (frame.k === 'frame' && frame.d?.t === 'del'), 4000).catch(() => {});
  await waitUntil(async () => (await media(port, roman, 'peer=olga&id=voice-1&slot=voice')).status === 404);
  assert.equal((await media(port, olga, 'peer=roman&id=voice-1&slot=voice')).status, 200, 'hidden only for roman');

  // Deleted for everyone: a tombstone, which is 410, not 404.
  olgaSocket.send({ k: 'frame', to: 'roman', d: { t: 'del', ids: ['pic-1'], scope: 'all', opId: 'd1' } });
  await waitUntil(async () => (await media(port, roman, ok)).status === 410);
  const deleted = await media(port, roman, ok);
  assert.equal(deleted.json.error, 'media_deleted');
});

test('Saved Messages are served to their owner and to nobody else', async (context) => {
  const { port, store, olga, roman } = await twoFriendsWithMedia(context);
  store.recordHistory('olga', 'olga', { id: 'keep-1', from: 'olga', text: '', ts: 1_756_900_001_000, image: IMAGE });
  const mine = await media(port, olga, 'peer=olga&id=keep-1&slot=image');
  assert.deepEqual(mine.raw, IMAGE_BYTES);
  assert.equal((await media(port, roman, 'peer=olga&id=keep-1&slot=image')).status, 404, 'roman\'s olga thread has no such record');
  assert.equal((await media(port, roman, 'peer=roman&id=keep-1&slot=image')).status, 404, 'nor do roman\'s own Saved Messages');
});

test('a record without an addressable id keeps its inline form even in ref mode', () => {
  assert.deepEqual(withMediaRefs({ id: '', image: IMAGE }), { id: '', image: IMAGE });
  const long = { id: 'x'.repeat(1025), voice: VOICE };
  assert.equal(withMediaRefs(long), long);
  const empty = withMediaRefs({ id: 'e', text: 't', image: { dataUrl: 'data:image/png;base64,', width: 1, height: 1 } });
  assert.deepEqual(empty, { id: 'e', text: 't' }, 'nothing to download: no attachment at all');
  const plain = { id: 'p', text: 'no media' };
  assert.equal(withMediaRefs(plain), plain, 'the same object back when nothing changes');
});

test('parseRange covers the single-range grammar and nothing more', () => {
  assert.deepEqual(parseRange('bytes=0-0', 10), { start: 0, end: 0 });
  assert.deepEqual(parseRange('bytes=4-', 10), { start: 4, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange('bytes=-30', 10), { start: 0, end: 9 });
  assert.equal(parseRange('bytes=10-', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 10), 'unsatisfiable');
  for (const ignored of [undefined, '', 'bytes=5-2', 'bytes=-', 'items=0-1', 'bytes=0-1,3-4']) {
    assert.equal(parseRange(ignored, 10), null, String(ignored));
  }
});

test('more than the per-account number of unfinished downloads is told 429 at once', async (context) => {
  const service = await startService(context);
  const { port, store } = service;
  const olga = await makeAccount(port, 'olga');
  const roman = await makeAccount(port, 'roman');
  await befriend(port, olga, roman);
  // Large enough that a reader who never reads keeps the answer unfinished.
  const big = randomBytes(6 * 1024 * 1024);
  store.recordHistory('olga', 'roman', {
    id: 'big-1', from: 'olga', text: '', ts: 1_756_900_000_000,
    image: { dataUrl: `data:image/png;base64,${big.toString('base64')}`, width: 10, height: 10 },
  });
  const stalled = [];
  for (let i = 0; i < MEDIA_INFLIGHT_PER_ACCOUNT; i += 1) {
    stalled.push(await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'GET', path: '/tailchat/api/media?peer=olga&id=big-1&slot=image',
        headers: { Authorization: `Bearer ${roman}` },
      }, (response) => { response.pause(); resolve({ req, response }); });
      req.once('error', reject);
      req.end();
    }));
  }
  context.after(() => { for (const { req } of stalled) req.destroy(); });
  const refused = await media(port, roman, 'peer=olga&id=big-1&slot=image');
  assert.equal(refused.status, 429);
  assert.equal(refused.json.error, 'too_many_requests');

  for (const { req } of stalled) req.destroy();
  await waitUntil(async () => (await request(port, 'HEAD', '/tailchat/api/media?peer=olga&id=big-1&slot=image', { token: roman })).status === 200);
});

test('a connection that announced media-ref-v1 gets references live; one that did not gets bytes', async (context) => {
  const { port } = await startService(context);
  const olga = await makeAccount(port, 'olga');
  const roman = await makeAccount(port, 'roman');
  await befriend(port, olga, roman);

  const join = async (token, caps, peer) => {
    const client = await wsClient(port);
    context.after(() => client.close());
    client.send({ k: 'auth', token, caps });
    const ready = await client.waitFor('ready');
    client.send({ k: 'subscribe', peer });
    await client.waitFor('subscribed');
    return { client, ready };
  };
  const { client: sender, ready } = await join(olga, ['op-ack-v1'], 'roman');
  assert.ok(ready.caps.includes(MEDIA_REF_CAP), 'the server says it can');
  const { client: newPhone } = await join(roman, [MEDIA_REF_CAP], 'olga');
  const { client: oldPhone } = await join(roman, [], 'olga');
  const { client: olgaTab } = await join(olga, [MEDIA_REF_CAP, 'addressed-send'], 'roman');

  sender.send({ k: 'frame', to: 'roman', d: { t: 'msg', id: 'live-1', text: '', ts: 1_756_900_000_000, image: IMAGE } });
  const isLive = (frame) => frame.k === 'frame' && frame.d?.id === 'live-1';
  const toNew = await newPhone.waitFor(isLive);
  const toOld = await oldPhone.waitFor(isLive);
  assert.deepEqual(toNew.d.image, { mime: 'image/png', size: IMAGE_BYTES.length, width: 640, height: 480 });
  assert.deepEqual(toOld.d.image, IMAGE, 'the same moment, the same account, the old phone: bytes as before');

  // The sender's own other session, which announced the capability.
  const copy = await olgaTab.waitFor(isLive);
  assert.equal(copy.self, true);
  assert.deepEqual(copy.d.image, toNew.d.image, 'own copy follows the receiving connection too');

  // The reference resolves to the bytes the old phone got inline.
  const fetched = await media(port, roman, 'peer=olga&id=live-1&slot=image');
  assert.deepEqual(fetched.raw, IMAGE_BYTES);
  // And the stored record still holds them inline.
  const stored = await request(port, 'GET', '/tailchat/api/history?peer=olga', { token: roman });
  assert.deepEqual(stored.json.messages.find((m) => m.id === 'live-1').image, IMAGE);
});

test('a queued message reaches a capable connection as a reference after subscribe', async (context) => {
  const { port } = await startService(context);
  const olga = await makeAccount(port, 'olga');
  const roman = await makeAccount(port, 'roman');
  await befriend(port, olga, roman);
  const sender = await wsClient(port);
  context.after(() => sender.close());
  sender.send({ k: 'auth', token: olga, caps: ['op-ack-v1'] });
  await sender.waitFor('ready');
  sender.send({ k: 'subscribe', peer: 'roman' });
  await sender.waitFor('subscribed');
  // roman is offline: the message is committed and queued for him.
  sender.send({ k: 'frame', to: 'roman', d: { t: 'msg', id: 'q-1', text: 'later', ts: 1_756_900_000_000, voice: VOICE } });
  await sender.waitFor((frame) => frame.k === 'message-accepted' && frame.id === 'q-1');

  const capable = await wsClient(port);
  context.after(() => capable.close());
  capable.send({ k: 'auth', token: roman, caps: [MEDIA_REF_CAP] });
  await capable.waitFor('ready');
  capable.send({ k: 'subscribe', peer: 'olga' });
  const queued = await capable.waitFor((frame) => frame.k === 'frame' && frame.d?.id === 'q-1');
  assert.deepEqual(queued.d.voice, { mime: 'audio/webm;codecs=opus', size: VOICE_BYTES.length, duration: 12.34 });
});

test('the media log line names who and how it ended, never the message id or its bytes', async (context) => {
  const { port, roman, logs } = await twoFriendsWithMedia(context);
  await media(port, roman, 'peer=olga&id=pic-1&slot=image');
  await media(port, roman, 'peer=olga&id=nope&slot=image');
  const lines = logs.filter((line) => line.startsWith('Tailchat cloud: media '));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Tailchat cloud: media login=roman peer=olga status=200 bytes=3000 ms=\d+$/);
  assert.match(lines[1], /status=404 bytes=0/);
  for (const line of lines) {
    assert.equal(line.includes('pic-1'), false);
    assert.equal(line.includes('nope'), false);
    assert.equal(line.includes(IMAGE_BYTES.toString('base64').slice(0, 16)), false);
  }
});

async function waitUntil(predicate, timeoutMs = 3000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
