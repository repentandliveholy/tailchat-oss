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
import { E2EE_STUB_TEXT } from '../src/cloud/e2ee.js';

// Stage 6a of the Rust core (docs/specs/2026-11-04-e2ee.md §5): the device
// registry, key claims, the to-device inbox, and what the server does with an
// encrypted message. The server checks shape only, so the "keys" here are
// random bytes of the right length.

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-e2ee-data-'));
  const keyFile = `${dir}.master-key`;
  fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  return { dir, keyFile };
}

async function startService(context, hubOptions = {}) {
  const { dir, keyFile } = tempStore();
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-e2ee-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html>\n');
  const store = createAccountStore({ dir, keyFile, initialize: true });
  const hub = createCloudHub({ store, ...hubOptions });
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

function request(port, method, requestPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.once('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: response.statusCode, text, json });
      });
    });
    req.once('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function wsClient(port, context) {
  const frames = [];
  const emitter = new EventEmitter();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/tailchat/ws`);
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString('utf8'));
    frames.push(frame);
    emitter.emit('frame', frame);
  });
  await once(socket, 'open');
  context.after(() => socket.close());
  const client = {
    frames,
    send(payload) { socket.send(JSON.stringify(payload)); },
    close() { socket.close(); return once(socket, 'close'); },
    waitFor(predicate, timeoutMs = 4000) {
      const match = typeof predicate === 'string' ? (frame) => frame.k === predicate : predicate;
      const found = frames.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          emitter.off('frame', onFrame);
          reject(new Error(`timed out; saw ${JSON.stringify(frames).slice(0, 2000)}`));
        }, timeoutMs);
        const onFrame = (frame) => {
          if (!match(frame)) return;
          clearTimeout(timer);
          emitter.off('frame', onFrame);
          resolve(frame);
        };
        emitter.on('frame', onFrame);
      });
    },
    async auth(token, caps = ['e2ee-v1', 'addressed-send']) {
      client.send({ k: 'auth', token, caps });
      return client.waitFor('ready');
    },
  };
  return client;
}

const publicKey = () => randomBytes(32).toString('base64').replace(/=+$/, '');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deviceKeys(login, deviceId) {
  return {
    login,
    deviceId,
    kind: 'client',
    keys: { curve25519: publicKey(), ed25519: publicKey() },
    signatures: { [login]: { [`ed25519:${deviceId}`]: 'signature' } },
  };
}

async function account(port, login) {
  const response = await request(port, 'POST', '/tailchat/api/register', {
    body: { login, password: 'correct horse', name: login },
  });
  assert.equal(response.status, 201, response.text);
  return response.json.token;
}

async function registerDevice(port, token, login, { oneTimeKeys = 0 } = {}) {
  const first = await request(port, 'POST', '/tailchat/api/e2ee/keys/upload', { token, body: {} });
  assert.equal(first.status, 200, first.text);
  const { deviceId } = first.json;
  const otks = {};
  for (let i = 0; i < oneTimeKeys; i += 1) otks[`otk${i}`] = { key: publicKey() };
  const keys = deviceKeys(login, deviceId);
  const second = await request(port, 'POST', '/tailchat/api/e2ee/keys/upload', {
    token, body: { deviceKeys: keys, oneTimeKeys: otks, fallbackKey: { fallback: { key: publicKey() } } },
  });
  assert.equal(second.status, 200, second.text);
  return { deviceId, keys };
}

function envelope(dev, ct = 'QUJD') {
  return { v: 1, dev, sid: 'c2Vzc2lvbg', ct };
}

test('a device is registered under the id its session was given, and its identity keys never change', async (context) => {
  const { port } = await startService(context);
  const token = await account(port, 'roman');

  const first = await request(port, 'POST', '/tailchat/api/e2ee/keys/upload', { token, body: {} });
  assert.equal(first.status, 200);
  assert.equal(first.json.registered, false);
  const { deviceId } = first.json;
  assert.match(deviceId, /^[A-Za-z0-9_-]{16}$/);

  // Keys that name another device are not this session's keys.
  const elsewhere = await request(port, 'POST', '/tailchat/api/e2ee/keys/upload', {
    token, body: { deviceKeys: deviceKeys('roman', 'AAAAAAAAAAAAAAAA') },
  });
  assert.equal(elsewhere.status, 400);
  assert.equal(elsewhere.json.error, 'invalid_device_keys');
  assert.equal(elsewhere.json.deviceId, deviceId);

  // One-time keys need a device to belong to.
  const orphan = await request(port, 'POST', '/tailchat/api/e2ee/keys/upload', {
    token, body: { oneTimeKeys: { a: { key: publicKey() } } },
  });
  assert.equal(orphan.json.error, 'device_required');

  const keys = deviceKeys('roman', deviceId);
  const registered = await request(port, 'POST', '/tailchat/api/e2ee/keys/upload', {
    token, body: { deviceKeys: keys, oneTimeKeys: { a: { key: publicKey() }, b: { key: publicKey() } } },
  });
  assert.equal(registered.status, 200, registered.text);
  assert.deepEqual(
    { ...registered.json },
    { deviceId, registered: true, oneTimeKeyCount: 2, fallbackKey: false },
  );

  const swapped = await request(port, 'POST', '/tailchat/api/e2ee/keys/upload', {
    token, body: { deviceKeys: { ...keys, keys: { ...keys.keys, curve25519: publicKey() } } },
  });
  assert.equal(swapped.status, 409);
  assert.equal(swapped.json.error, 'device_keys_changed');

  const reused = await request(port, 'POST', '/tailchat/api/e2ee/keys/upload', {
    token, body: { oneTimeKeys: { a: { key: publicKey() } } },
  });
  assert.equal(reused.status, 409);
  assert.equal(reused.json.error, 'one_time_key_conflict');

  // More signatures on the same keys are not a change of identity.
  const resigned = await request(port, 'POST', '/tailchat/api/e2ee/keys/upload', {
    token, body: { deviceKeys: { ...keys, signatures: { roman: { a: 'one', b: 'two' } } } },
  });
  assert.equal(resigned.status, 200, resigned.text);
});

test('keys are answered to the account and its friends only, with the sessions that cannot read counted', async (context) => {
  const { port, store } = await startService(context);
  const roman = await account(port, 'roman');
  const olga = await account(port, 'olga');
  await account(port, 'carol');
  store.linkFriends('roman', 'olga');

  const { deviceId, keys } = await registerDevice(port, roman, 'roman');
  const watcher = await wsClient(port, context);
  await watcher.auth(olga);

  const answer = await request(port, 'POST', '/tailchat/api/e2ee/keys/query', {
    token: olga, body: { logins: ['roman', 'carol'] },
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(Object.keys(answer.json.users), ['roman']);
  assert.deepEqual(answer.json.users.roman.devices[deviceId].deviceKeys, keys);
  assert.equal(answer.json.users.roman.legacySessions, 0);

  // A second sign-in is a session that has no device yet: it cannot read, and
  // whoever encrypts to roman is told to look again.
  const login = await request(port, 'POST', '/tailchat/api/login', {
    body: { login: 'roman', password: 'correct horse' },
  });
  assert.equal(login.status, 200);
  await watcher.waitFor((frame) => frame.k === 'device-list-changed' && frame.login === 'roman');
  const again = await request(port, 'POST', '/tailchat/api/e2ee/keys/query', { token: olga, body: { logins: ['roman'] } });
  assert.equal(again.json.users.roman.legacySessions, 1);

  // First device's crossSigning is kept when a second device registers without replaceCrossSigning.
  const master1 = { login: 'roman', usage: 'master', key: publicKey() };
  const self1 = { login: 'roman', usage: 'self_signing', key: publicKey() };
  await request(port, 'POST', '/tailchat/api/e2ee/keys/upload', {
    token: roman, body: { crossSigning: { master: master1, selfSigning: self1 } },
  });
  const roman2 = login.json.token;
  const { deviceId: dev2 } = (await request(port, 'POST', '/tailchat/api/e2ee/keys/upload', { token: roman2, body: {} })).json;
  await request(port, 'POST', '/tailchat/api/e2ee/keys/upload', {
    token: roman2,
    body: {
      deviceKeys: deviceKeys('roman', dev2),
      crossSigning: { master: { login: 'roman', usage: 'master', key: publicKey() }, selfSigning: { login: 'roman', usage: 'self_signing', key: publicKey() } },
    },
  });
  const queried = await request(port, 'POST', '/tailchat/api/e2ee/keys/query', { token: olga, body: { logins: ['roman'] } });
  assert.deepEqual(queried.json.users.roman.crossSigning.master, master1);
});

test('replacing published account keys takes the password, a whole set, and tells the friends', async (context) => {
  const { port, store } = await startService(context);
  const roman = await account(port, 'roman');
  const olga = await account(port, 'olga');
  store.linkFriends('roman', 'olga');
  await registerDevice(port, roman, 'roman');
  const cross = () => ({
    master: { login: 'roman', usage: 'master', key: publicKey() },
    selfSigning: { login: 'roman', usage: 'self_signing', key: publicKey() },
  });
  const first = cross();
  const upload = (body) => request(port, 'POST', '/tailchat/api/e2ee/keys/upload', { token: roman, body });
  const published = async () => (await request(port, 'POST', '/tailchat/api/e2ee/keys/query', {
    token: olga, body: { logins: ['roman'] },
  })).json.users.roman.crossSigning;

  // The first set needs no password: there is nothing to replace.
  assert.equal((await upload({ crossSigning: first })).status, 200);
  assert.deepEqual(await published(), first);

  // Without a password, or with a wrong one: 403 (not 401 — that would read as
  // "this token is dead" and sign the client out), and nothing changes.
  const next = cross();
  for (const password of [undefined, 'wrong horse', '']) {
    const refused = await upload({ crossSigning: next, replaceCrossSigning: true, ...(password === undefined ? {} : { password }) });
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.json.error, 'bad_credentials');
  }
  assert.deepEqual(await published(), first);

  // Half a set would publish half the old identity beside half the new one.
  const half = await upload({ crossSigning: { master: next.master }, replaceCrossSigning: true, password: 'correct horse' });
  assert.equal(half.status, 400);
  assert.equal(half.json.error, 'invalid_cross_signing');
  assert.deepEqual(await published(), first);

  // The password and a whole set: replaced, and roman's friends are told to look again.
  const watcher = await wsClient(port, context);
  await watcher.auth(olga);
  const replaced = await upload({ crossSigning: next, replaceCrossSigning: true, password: 'correct horse' });
  assert.equal(replaced.status, 200, replaced.text);
  assert.deepEqual(await published(), next);
  await watcher.waitFor((frame) => frame.k === 'device-list-changed' && frame.login === 'roman');

  // A plain upload afterwards (the flag absent) still cannot replace anything.
  const third = cross();
  assert.equal((await upload({ crossSigning: third, password: 'correct horse' })).status, 200);
  assert.deepEqual(await published(), next);
});

test('guessing the password through a key replacement hits the same brake as sign-in', async (context) => {
  const { port } = await startService(context);
  const roman = await account(port, 'roman');
  await registerDevice(port, roman, 'roman');
  const set = () => ({
    master: { login: 'roman', usage: 'master', key: publicKey() },
    selfSigning: { login: 'roman', usage: 'self_signing', key: publicKey() },
  });
  await request(port, 'POST', '/tailchat/api/e2ee/keys/upload', { token: roman, body: { crossSigning: set() } });
  const statuses = [];
  for (let i = 0; i < 12; i += 1) {
    const answer = await request(port, 'POST', '/tailchat/api/e2ee/keys/upload', {
      token: roman, body: { crossSigning: set(), replaceCrossSigning: true, password: `guess-${i}-xx` },
    });
    statuses.push(answer.status);
  }
  assert.ok(statuses.includes(429), `no 429 in ${statuses}`);
  assert.equal(statuses[0], 403);
  // Ordinary key traffic is not braked by it.
  const plain = await request(port, 'POST', '/tailchat/api/e2ee/keys/upload', { token: roman, body: {} });
  assert.equal(plain.status, 200);
});

test('a replacement survives a restart of the store', async () => {
  const { dir, keyFile } = tempStore();
  try {
    let store = createAccountStore({ dir, keyFile, initialize: true });
    const reg = await store.register({ login: 'roman', password: 'correct horse', name: 'roman' });
    const token = reg.token;
    const { deviceId } = await store.e2eeUpload(token, {});
    assert.equal((await store.e2eeUpload(token, { deviceKeys: deviceKeys('roman', deviceId) })).ok, true);
    const set = () => ({
      master: { login: 'roman', usage: 'master', key: publicKey() },
      selfSigning: { login: 'roman', usage: 'self_signing', key: publicKey() },
    });
    const first = set();
    const next = set();
    assert.equal((await store.e2eeUpload(token, { crossSigning: first })).ok, true);
    const replaced = await store.e2eeUpload(token, { crossSigning: next, replaceCrossSigning: true, password: 'correct horse' });
    assert.equal(replaced.ok, true);
    assert.equal(replaced.crossReplaced, true);
    await store.close();
    store = createAccountStore({ dir, keyFile });
    assert.deepEqual(store.e2eeQuery('roman', ['roman']).roman.crossSigning, next);
    await store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
  }
});

// R3 (taily R34): a device says which forms of a sealed attachment its core
// reads. The list rides beside the signed keys like the name, every upload
// says it again, an upload without it (a core before 1.148) clears it, a
// change tells whoever encrypts to the device, and a restart keeps it.
test('a device\'s caps are kept beside its keys, re-announced, cleared by an older core, and survive a restart', async (context) => {
  const { dir, keyFile } = tempStore();
  context.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
  });
  let store = createAccountStore({ dir, keyFile, initialize: true });
  const roman = (await store.register({ login: 'roman', password: 'correct horse', name: 'roman' })).token;
  await store.register({ login: 'olga', password: 'correct horse', name: 'olga' });
  store.linkFriends('roman', 'olga');
  const { deviceId } = await store.e2eeUpload(roman, {});
  const keys = deviceKeys('roman', deviceId);
  const caps = () => store.e2eeQuery('olga', ['roman']).roman.devices[deviceId].caps;

  const first = await store.e2eeUpload(roman, { deviceKeys: keys, caps: ['e2ee-blob-v1', 'e2ee-blob-v1', 'NOT OK', 7, 'x'.repeat(40)] });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.deepEqual(caps(), ['e2ee-blob-v1']);
  // The same list again is no change: nobody re-reads the device list.
  assert.equal((await store.e2eeUpload(roman, { deviceKeys: keys, caps: ['e2ee-blob-v1'] })).changed, false);
  // An older core on the same device uploads no list: the device is old again.
  const older = await store.e2eeUpload(roman, { deviceKeys: keys });
  assert.equal(older.changed, true);
  assert.deepEqual(caps(), []);
  assert.equal((await store.e2eeUpload(roman, { deviceKeys: keys, caps: ['e2ee-blob-v1'] })).changed, true);
  // The account itself reads the same list.
  assert.deepEqual(store.e2eeQuery('roman', ['roman']).roman.devices[deviceId].caps, ['e2ee-blob-v1']);
  await store.close();
  store = createAccountStore({ dir, keyFile });
  assert.deepEqual(caps(), ['e2ee-blob-v1']);
  await store.close();
});

test('a one-time key is handed out once, then the fallback key, and claims are rate limited', async (context) => {
  const { port, store } = await startService(context);
  const roman = await account(port, 'roman');
  const olga = await account(port, 'olga');
  store.linkFriends('roman', 'olga');
  const { deviceId } = await registerDevice(port, roman, 'roman', { oneTimeKeys: 2 });

  const claim = () => request(port, 'POST', '/tailchat/api/e2ee/keys/claim', {
    token: olga, body: { claims: { roman: [deviceId] } },
  }).then((response) => response.json);

  const first = await claim();
  const second = await claim();
  const third = await claim();
  assert.equal(first.keys.roman[deviceId].fallback, false);
  assert.equal(second.keys.roman[deviceId].fallback, false);
  assert.notEqual(first.keys.roman[deviceId].keyId, second.keys.roman[deviceId].keyId);
  assert.equal(third.keys.roman[deviceId].fallback, true);

  const status = await request(port, 'POST', '/tailchat/api/e2ee/keys/upload', { token: roman, body: {} });
  assert.equal(status.json.oneTimeKeyCount, 0);

  for (let i = 3; i < 10; i += 1) assert.equal((await claim()).rateLimited, false);
  const eleventh = await claim();
  assert.equal(eleventh.rateLimited, true);
  assert.deepEqual(eleventh.keys, {});

  // A stranger cannot claim at all.
  const carol = await account(port, 'carol');
  const stranger = await request(port, 'POST', '/tailchat/api/e2ee/keys/claim', {
    token: carol, body: { claims: { roman: [deviceId] } },
  });
  assert.deepEqual(stranger.json.keys, {});
});

test('a replayed journal line never brings back a one-time key a later claim took', async (context) => {
  const { dir, keyFile } = tempStore();
  context.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
  });
  const journal = path.join(dir, 'accounts.journal');
  const first = createAccountStore({ dir, keyFile, initialize: true });
  const roman = (await first.register({ login: 'roman', password: 'correct horse' })).token;
  await first.register({ login: 'olga', password: 'correct horse' });
  first.linkFriends('roman', 'olga');
  await first.flush();

  const { deviceId } = await first.e2eeUpload(roman, {});
  const uploaded = await first.e2eeUpload(roman, {
    deviceKeys: deviceKeys('roman', deviceId), oneTimeKeys: { only: { key: publicKey() } },
  });
  assert.equal(uploaded.oneTimeKeyCount, 1);
  // The upload line as it stood before the checkpoint that will contain it.
  const beforeCheckpoint = fs.readFileSync(journal);

  const claimed = await first.e2eeClaim('olga', { roman: [deviceId] });
  assert.equal(claimed.keys.roman[deviceId].keyId, 'only');
  await first.close();

  // A checkpoint that renamed and then died before truncating: the snapshot
  // already has the claim, the journal still has the upload.
  fs.writeFileSync(journal, beforeCheckpoint);
  const second = createAccountStore({ dir, keyFile });
  context.after(() => second.close());
  const again = await second.e2eeClaim('olga', { roman: [deviceId] });
  assert.deepEqual(again.keys, {});
});

test('to-device messages are held per device until that device acknowledges them', async (context) => {
  const { port, store } = await startService(context);
  const romanToken = await account(port, 'roman');
  const olgaToken = await account(port, 'olga');
  store.linkFriends('roman', 'olga');
  const romanDevice = await registerDevice(port, romanToken, 'roman');
  const olgaDevice = await registerDevice(port, olgaToken, 'olga');

  const roman = await wsClient(port, context);
  const olga = await wsClient(port, context);
  await roman.auth(romanToken);
  await olga.auth(olgaToken);

  const body = { type: 'olm', ciphertext: 'b2xt' };
  roman.send({ k: 'to-device', id: 't-1', to: 'olga', device: olgaDevice.deviceId, body });
  const accepted = await roman.waitFor('to-device-accepted');
  assert.equal(accepted.id, 't-1');
  const live = await olga.waitFor('to-device');
  assert.deepEqual(
    { seq: live.seq, from: live.from, fromDevice: live.fromDevice, body: live.body },
    { seq: accepted.seq, from: 'roman', fromDevice: romanDevice.deviceId, body },
  );

  // Not acknowledged: the next session of that device gets it again.
  await olga.close();
  const back = await wsClient(port, context);
  await back.auth(olgaToken);
  assert.equal((await back.waitFor('to-device')).seq, accepted.seq);
  back.send({ k: 'to-device-ack', seq: accepted.seq });
  await delay(100);
  await back.close();
  const after = await wsClient(port, context);
  await after.auth(olgaToken);
  await delay(100);
  assert.equal(after.frames.some((frame) => frame.k === 'to-device'), false);

  // A device nobody registered, and a session that never declared the
  // capability, get nothing held.
  roman.send({ k: 'to-device', id: 't-2', to: 'olga', device: 'BBBBBBBBBBBBBBBB', body });
  assert.equal((await roman.waitFor((frame) => frame.k === 'error' && frame.id === 't-2')).code, 'device_not_found');
  const legacy = await wsClient(port, context);
  await legacy.auth(romanToken, []);
  legacy.send({ k: 'to-device', id: 't-3', to: 'olga', device: olgaDevice.deviceId, body });
  assert.equal((await legacy.waitFor('error')).code, 'unknown_action');
});

test('an encrypted message reaches a capable session as its envelope and any other as the stub', async (context) => {
  const { port, store } = await startService(context);
  const romanToken = await account(port, 'roman');
  const olgaToken = await account(port, 'olga');
  store.linkFriends('roman', 'olga');
  const { deviceId } = await registerDevice(port, romanToken, 'roman');
  await registerDevice(port, olgaToken, 'olga');
  const olgaOldToken = (await request(port, 'POST', '/tailchat/api/login', {
    body: { login: 'olga', password: 'correct horse' },
  })).json.token;

  const roman = await wsClient(port, context);
  const olga = await wsClient(port, context);
  const olgaOld = await wsClient(port, context);
  await roman.auth(romanToken);
  await olga.auth(olgaToken);
  await olgaOld.auth(olgaOldToken, []);
  for (const client of [olga, olgaOld]) {
    client.send({ k: 'subscribe', peer: 'roman' });
    await client.waitFor('subscribed');
  }

  const sealed = envelope(deviceId);
  roman.send({ k: 'frame', to: 'olga', d: { t: 'msg', id: 'm-1', e2ee: sealed } });
  assert.equal((await roman.waitFor('message-accepted')).id, 'm-1');
  const opened = await olga.waitFor('frame');
  assert.deepEqual(opened.d.e2ee, sealed);
  assert.equal(opened.d.text, undefined);
  const stubbed = await olgaOld.waitFor('frame');
  assert.equal(stubbed.d.text, E2EE_STUB_TEXT);
  assert.equal(stubbed.d.e2ee, undefined);

  const plain = await request(port, 'GET', '/tailchat/api/history?peer=roman', { token: olgaToken });
  assert.equal(plain.json.messages[0].text, E2EE_STUB_TEXT);
  assert.equal(plain.json.messages[0].e2ee, undefined);
  const capable = await request(port, 'GET', '/tailchat/api/history?peer=roman&e2ee=1', { token: olgaToken });
  assert.deepEqual(capable.json.messages[0].e2ee, sealed);
  assert.equal(capable.json.messages[0].text, '');

  // A retry is the same bytes and is answered with the receipt it missed;
  // other bytes under the same id are another message.
  roman.send({ k: 'frame', to: 'olga', d: { t: 'msg', id: 'm-1', e2ee: sealed } });
  await roman.waitFor((frame) => frame.k === 'message-accepted' && roman.frames.filter((f) => f.k === 'message-accepted').length === 2);
  roman.send({ k: 'frame', to: 'olga', d: { t: 'msg', id: 'm-1', e2ee: envelope(deviceId, 'WFla') } });
  assert.equal((await roman.waitFor((frame) => frame.code === 'message_id_conflict')).id, 'm-1');

  // What the envelope encrypts must not also travel in the clear, and the
  // envelope must name the device of the session that sends it.
  roman.send({ k: 'frame', to: 'olga', d: { t: 'msg', id: 'm-2', text: 'секрет', e2ee: envelope(deviceId) } });
  assert.equal((await roman.waitFor((frame) => frame.code === 'bad_envelope' && frame.id === 'm-2')).peer, 'olga');
  roman.send({ k: 'frame', to: 'olga', d: { t: 'msg', id: 'm-3', e2ee: envelope('CCCCCCCCCCCCCCCC') } });
  await roman.waitFor((frame) => frame.code === 'bad_envelope' && frame.id === 'm-3');
  // An open-text edit must not attach plaintext to an encrypted record.
  roman.send({ k: 'frame', to: 'olga', d: { t: 'edit', id: 'm-1', text: 'подмена', opId: 'op-edit-1' } });
  await delay(50);
  const stored = await request(port, 'GET', '/tailchat/api/history?peer=olga&e2ee=1', { token: romanToken });
  assert.deepEqual(stored.json.messages.map((message) => ({ id: message.id, text: message.text })), [{ id: 'm-1', text: '' }]);
});

test('an encrypted edit is stored and relayed, but is no unread message, no push and no last line', async (context) => {
  const pushes = [];
  const pushSender = { notify: async (login, payload) => { pushes.push({ login, ...payload }); } };
  const { port, store } = await startService(context, { pushSender });
  const romanToken = await account(port, 'roman');
  const olgaToken = await account(port, 'olga');
  store.linkFriends('roman', 'olga');
  const { deviceId } = await registerDevice(port, romanToken, 'roman');
  await registerDevice(port, olgaToken, 'olga');
  const roman = await wsClient(port, context);
  await roman.auth(romanToken);
  const accepted = (id) => roman.waitFor((frame) => frame.k === 'message-accepted' && frame.id === id);

  // The flag means something only beside an envelope: on open text it is
  // dropped, and the message is an ordinary one.
  roman.send({ k: 'frame', to: 'olga', d: { t: 'msg', id: 'o-1', text: 'открыто', sealedEdit: true } });
  await accepted('o-1');
  roman.send({ k: 'frame', to: 'olga', d: { t: 'msg', id: 'm-1', e2ee: envelope(deviceId) } });
  await accepted('m-1');
  roman.send({ k: 'frame', to: 'olga', d: { t: 'msg', id: 'e-1', e2ee: envelope(deviceId, 'RURJVA'), sealedEdit: true } });
  await accepted('e-1');
  await delay(50);

  assert.equal(store.unreadCounts('olga').roman, 2, 'the edit is not an unread message');
  const fromRoman = pushes.filter((push) => push.peer === 'roman').map((push) => push.messageId);
  assert.deepEqual(fromRoman, ['o-1', 'm-1'], 'nor a push');
  assert.equal(store.lastMessage('olga', 'roman').id, 'm-1', 'nor the last line of the conversation');
  const users = await request(port, 'GET', '/tailchat/api/users', { token: olgaToken });
  assert.equal(users.json.users.find((user) => user.login === 'roman').pending, 2);

  const history = await request(port, 'GET', '/tailchat/api/history?peer=roman&e2ee=1', { token: olgaToken });
  const byId = Object.fromEntries(history.json.messages.map((message) => [message.id, message]));
  assert.equal(byId['e-1'].sealedEdit, true, 'the store keeps the flag');
  assert.deepEqual(byId['e-1'].e2ee, envelope(deviceId, 'RURJVA'));
  assert.equal(byId['m-1'].sealedEdit, undefined);
  assert.equal(byId['o-1'].sealedEdit, undefined);
  assert.equal(byId['o-1'].text, 'открыто');
  // A client that cannot open envelopes gets a tombstone for the carrier's id
  // — never the stub — with the flag beside it.
  const plain = await request(port, 'GET', '/tailchat/api/history?peer=roman', { token: olgaToken });
  const stub = plain.json.messages.find((message) => message.id === 'e-1');
  assert.equal(stub.text, '');
  assert.ok(stub.deletedAt > 0);
  assert.equal(stub.sealedEdit, true);
  assert.equal(stub.e2ee, undefined);

  // Every device still gets it: the reader's core applies it to its target.
  const olga = await wsClient(port, context);
  await olga.auth(olgaToken);
  olga.send({ k: 'subscribe', peer: 'roman' });
  const subscribed = await olga.waitFor('subscribed');
  assert.equal(subscribed.pending, 2);
  const carrier = await olga.waitFor((frame) => frame.k === 'frame' && frame.d?.id === 'e-1');
  assert.equal(carrier.d.sealedEdit, true);
  assert.deepEqual(carrier.d.e2ee, envelope(deviceId, 'RURJVA'));
});

test('an edit\'s carrier reaches a session without e2ee-v1 as a tombstone on every path, a capable one as it was', async (context) => {
  const { port, store } = await startService(context);
  const romanToken = await account(port, 'roman');
  const olgaToken = await account(port, 'olga');
  store.linkFriends('roman', 'olga');
  const { deviceId } = await registerDevice(port, romanToken, 'roman');
  await registerDevice(port, olgaToken, 'olga');
  const romanOldToken = (await request(port, 'POST', '/tailchat/api/login', {
    body: { login: 'roman', password: 'correct horse' },
  })).json.token;
  const olgaOldToken = (await request(port, 'POST', '/tailchat/api/login', {
    body: { login: 'olga', password: 'correct horse' },
  })).json.token;

  const roman = await wsClient(port, context);
  const romanOld = await wsClient(port, context);
  const olga = await wsClient(port, context);
  const olgaOld = await wsClient(port, context);
  await roman.auth(romanToken);
  await romanOld.auth(romanOldToken, []);
  await olga.auth(olgaToken);
  await olgaOld.auth(olgaOldToken, []);
  // Said while nobody of olga's is subscribed: it waits in her queue.
  const sealed = envelope(deviceId, 'RURJVA');
  roman.send({ k: 'frame', to: 'olga', d: { t: 'msg', id: 'e-0', e2ee: sealed, sealedEdit: true } });
  await roman.waitFor((frame) => frame.k === 'message-accepted' && frame.id === 'e-0');
  for (const [client, peer] of [[romanOld, 'olga'], [olgaOld, 'roman'], [olga, 'roman']]) {
    client.send({ k: 'subscribe', peer });
    await client.waitFor('subscribed');
  }
  roman.send({ k: 'frame', to: 'olga', d: { t: 'msg', id: 'e-1', e2ee: sealed, sealedEdit: true } });
  await roman.waitFor((frame) => frame.k === 'message-accepted' && frame.id === 'e-1');

  const isCarrier = (frame) => frame.k === 'frame' && frame.d?.id === 'e-1';
  const queuedCarrier = (frame) => frame.k === 'frame' && frame.d?.id === 'e-0';
  // The peer's live frame, and the sender's own other session (self echo).
  for (const old of [olgaOld, romanOld]) {
    const frame = await old.waitFor(isCarrier);
    assert.equal(frame.d.e2ee, undefined);
    assert.equal(frame.d.text, undefined, 'a live tombstone has no words to draw');
    assert.equal(frame.d.sealedEdit, true);
    assert.ok(frame.d.deletedAt > 0);
    assert.equal(frame.d.t, 'msg');
  }
  assert.deepEqual((await olga.waitFor(isCarrier)).d.e2ee, sealed, 'a capable session gets the carrier');

  // The queue drained on subscribe (the capable session's drain is pinned by the test above).
  const drained = await olgaOld.waitFor(queuedCarrier);
  assert.equal(drained.d.e2ee, undefined);
  assert.ok(drained.d.deletedAt > 0);
  assert.equal(drained.d.text, undefined);

  // History: the deleted-record shape the store itself answers.
  const history = await request(port, 'GET', '/tailchat/api/history?peer=roman&deleted=1', { token: olgaOldToken });
  const [row] = history.json.messages.filter((message) => message.id === 'e-1');
  assert.equal(row.from, 'roman');
  assert.equal(row.text, '');
  assert.ok(row.deletedAt > 0);
  assert.equal(row.e2ee, undefined);
  assert.equal(row.sealedEdit, true);
  const capable = await request(port, 'GET', '/tailchat/api/history?peer=roman&e2ee=1', { token: olgaToken });
  assert.deepEqual(capable.json.messages.find((message) => message.id === 'e-1').e2ee, sealed);

  // §12: a tombstone moves neither watermark, and no unread is counted.
  assert.equal(store.unreadCounts('olga').roman ?? 0, 0);
  assert.equal(history.json.peerReadTs, 0);
  assert.equal(history.json.peerDeliveredTs, 0);
});

test('a web tab that is not in the conversation hears of a message, never of an edit\'s carrier', async (context) => {
  const { port, store } = await startService(context);
  const romanToken = await account(port, 'roman');
  const olgaToken = await account(port, 'olga');
  store.linkFriends('roman', 'olga');
  const { deviceId } = await registerDevice(port, romanToken, 'roman');
  await registerDevice(port, olgaToken, 'olga');
  const roman = await wsClient(port, context);
  await roman.auth(romanToken);
  // olga's tab: web features, looking at nobody — the shape that bumps a badge.
  const olga = await wsClient(port, context);
  olga.send({ k: 'auth', token: olgaToken, caps: ['e2ee-v1', 'addressed-send'], webFeatures: true });
  await olga.waitFor('ready');

  roman.send({ k: 'frame', to: 'olga', d: { t: 'msg', id: 'm-1', e2ee: envelope(deviceId) } });
  await olga.waitFor((frame) => frame.k === 'conversation-update' && frame.from === 'roman');
  roman.send({ k: 'frame', to: 'olga', d: { t: 'msg', id: 'e-1', e2ee: envelope(deviceId, 'RURJVA'), sealedEdit: true } });
  await roman.waitFor((frame) => frame.k === 'message-accepted' && frame.id === 'e-1');
  await delay(100);
  assert.equal(olga.frames.filter((frame) => frame.k === 'conversation-update').length, 1,
    'one update, for the message: the carrier added none');
});

test('signing out removes the device and tells the friends who encrypt to it', async (context) => {
  const { port, store } = await startService(context);
  const romanToken = await account(port, 'roman');
  const olgaToken = await account(port, 'olga');
  store.linkFriends('roman', 'olga');
  const { deviceId } = await registerDevice(port, romanToken, 'roman');
  const olga = await wsClient(port, context);
  await olga.auth(olgaToken);

  const out = await request(port, 'POST', '/tailchat/api/logout', { token: romanToken });
  assert.equal(out.status, 204);
  await olga.waitFor((frame) => frame.k === 'device-list-changed' && frame.login === 'roman');
  const answer = await request(port, 'POST', '/tailchat/api/e2ee/keys/query', { token: olgaToken, body: { logins: ['roman'] } });
  assert.equal(answer.json.users.roman.devices[deviceId], undefined);
});

test('encrypted key backup stores cross-signing and Megolm sessions, keeps the earliest index, and survives journal replay', async (context) => {
  const { port } = await startService(context);
  const romanToken = await account(port, 'roman');
  const nonce = () => randomBytes(12).toString('base64').replace(/=+$/, '');
  const ct = () => randomBytes(48).toString('base64').replace(/=+$/, '');
  const salt = () => randomBytes(16).toString('base64').replace(/=+$/, '');

  // Requires a registered E2EE device first.
  const unreg = await request(port, 'POST', '/tailchat/api/e2ee/backup', { token: romanToken, body: {} });
  assert.equal(unreg.status, 400);
  assert.equal(unreg.json.error, 'device_required');

  await registerDevice(port, romanToken, 'roman');
  const empty = await request(port, 'POST', '/tailchat/api/e2ee/backup', { token: romanToken, body: {} });
  assert.equal(empty.status, 200);
  assert.equal(empty.json.version, 0);
  assert.equal(empty.json.sessionCount, 0);

  const cross1 = { nonce: nonce(), ct: ct() };
  const pw1 = { salt: salt(), nonce: nonce(), ct: ct() };
  const sess5 = { firstKnownIndex: 5, nonce: nonce(), ct: ct() };
  const created = await request(port, 'POST', '/tailchat/api/e2ee/backup', {
    token: romanToken,
    body: { version: 1, crossSigning: cross1, passphrase: pw1, sessions: { sessA: sess5 } },
  });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.json.version, 1);
  assert.equal(created.json.sessionCount, 1);
  assert.deepEqual(created.json.crossSigning, cross1);
  assert.deepEqual(created.json.passphrase, pw1);

  // A later upload for the same session with a higher firstKnownIndex does not clobber index 5;
  // an earlier index (0 < 5) upgrades it.
  const sess9 = { firstKnownIndex: 9, nonce: nonce(), ct: ct() };
  await request(port, 'POST', '/tailchat/api/e2ee/backup', {
    token: romanToken,
    body: { version: 1, sessions: { sessA: sess9 } },
  });
  const fetched1 = await request(port, 'POST', '/tailchat/api/e2ee/backup', {
    token: romanToken,
    body: { includeSessions: true },
  });
  assert.deepEqual(fetched1.json.sessions.sessA, sess5);

  const sess0 = { firstKnownIndex: 0, nonce: nonce(), ct: ct() };
  await request(port, 'POST', '/tailchat/api/e2ee/backup', {
    token: romanToken,
    body: { version: 1, sessions: { sessA: sess0 } },
  });
  const fetched2 = await request(port, 'POST', '/tailchat/api/e2ee/backup', {
    token: romanToken,
    body: { includeSessions: true },
  });
  assert.deepEqual(fetched2.json.sessions.sessA, sess0);

  // Wrong version without replace:true is refused with 409 backup_version_mismatch.
  const wrongVer = await request(port, 'POST', '/tailchat/api/e2ee/backup', {
    token: romanToken,
    body: { version: 2, sessions: { sessB: sess0 } },
  });
  assert.equal(wrongVer.status, 409);
  assert.equal(wrongVer.json.error, 'backup_version_mismatch');

  // Replaying an earlier journal line over a newer snapshot never reverts backup v2 back to v1.
  const { dir, keyFile } = tempStore();
  context.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
  });
  const journal = path.join(dir, 'accounts.journal');
  const first = createAccountStore({ dir, keyFile, initialize: true });
  const token1 = (await first.register({ login: 'alice', password: 'correct horse' })).token;
  const { deviceId: devA } = await first.e2eeUpload(token1, {});
  await first.e2eeUpload(token1, { deviceKeys: deviceKeys('alice', devA) });
  await first.e2eeBackup(token1, { version: 1, crossSigning: cross1, sessions: { sessA: sess5 } });
  const beforeRotate = fs.readFileSync(journal);
  const cross2 = { nonce: nonce(), ct: ct() };
  await first.e2eeBackup(token1, { version: 2, replace: true, crossSigning: cross2, sessions: { sessA: sess0 } });
  await first.close();

  fs.writeFileSync(journal, beforeRotate);
  const second = createAccountStore({ dir, keyFile });
  context.after(() => second.close());
  const replayed = await second.e2eeBackup(token1, { includeSessions: true });
  assert.equal(replayed.version, 2);
  assert.deepEqual(replayed.crossSigning, cross2);
  assert.deepEqual(replayed.sessions.sessA, sess0);
});

// Owner, 2026-11-11: a code confirmed in the terminal was "not verified" in
// the browser. The account's signed word on whom it verified is kept by the
// server for that account alone; its own sessions are told when it changes.
test('whom an account verified is kept for that account alone and told only to its own sessions', async (context) => {
  const { port, store } = await startService(context);
  const roman = await account(port, 'roman');
  const olga = await account(port, 'olga');
  await account(port, 'carol');
  store.linkFriends('roman', 'olga');
  store.linkFriends('olga', 'carol');
  const statement = (peer, extra = {}) => ({
    login: 'roman', usage: 'peer_verified', peer, key: publicKey(), signatures: { roman: { 'ed25519:x': 'sig' } }, ...extra,
  });
  const trust = (token, peerTrust) => request(port, 'POST', '/tailchat/api/e2ee/trust', { token, body: { peerTrust } });

  // Only a session whose device holds keys can have signed anything.
  assert.equal((await trust(roman, { olga: statement('olga') })).json.error, 'device_required');
  await registerDevice(port, roman, 'roman');
  assert.equal((await trust('f'.repeat(64), { olga: statement('olga') })).status, 401);

  const romanSocket = await wsClient(port, context);
  await romanSocket.auth(roman);
  const olgaSocket = await wsClient(port, context);
  await olgaSocket.auth(olga);

  const first = statement('olga');
  const stored = await trust(roman, { olga: first });
  assert.equal(stored.status, 200, stored.text);
  await romanSocket.waitFor((frame) => frame.k === 'device-list-changed' && frame.login === 'roman');

  const own = await request(port, 'POST', '/tailchat/api/e2ee/keys/query', { token: roman, body: { logins: ['roman', 'olga'] } });
  assert.deepEqual(own.json.users.roman.peerTrust, { olga: first });
  assert.equal(own.json.users.olga.peerTrust, undefined, 'nobody reads another account’s');
  const theirs = await request(port, 'POST', '/tailchat/api/e2ee/keys/query', { token: olga, body: { logins: ['roman'] } });
  assert.equal(theirs.json.users.roman.peerTrust, undefined, 'not even the friend it is about');
  await delay(100);
  assert.ok(!olgaSocket.frames.some((frame) => frame.k === 'device-list-changed'), 'friends are not told');

  // The same statement again changes nothing and tells nobody; a newer one replaces it.
  const told = romanSocket.frames.length;
  assert.equal((await trust(roman, { olga: first })).status, 200);
  await delay(100);
  assert.equal(romanSocket.frames.length, told);
  const second = statement('olga');
  await trust(roman, { olga: second });
  const replaced = await request(port, 'POST', '/tailchat/api/e2ee/keys/query', { token: roman, body: { logins: ['roman'] } });
  assert.deepEqual(replaced.json.users.roman.peerTrust, { olga: second });

  // Refused whole: about somebody else's account, filed under another peer,
  // another usage, a stranger, oneself, or not a key.
  for (const peerTrust of [
    { olga: statement('olga', { login: 'olga' }) },
    { olga: statement('carol') },
    { olga: statement('olga', { usage: 'self_signing' }) },
    { carol: statement('carol') },
    { roman: statement('roman') },
    { olga: statement('olga', { key: 'short' }) },
    {},
  ]) {
    const refused = await trust(roman, peerTrust);
    assert.equal(refused.status, 400, JSON.stringify(peerTrust));
    assert.equal(refused.json.error, 'invalid_trust');
  }
  const unchanged = await request(port, 'POST', '/tailchat/api/e2ee/keys/query', { token: roman, body: { logins: ['roman'] } });
  assert.deepEqual(unchanged.json.users.roman.peerTrust, { olga: second });
});

test('statements of trust survive a restart of the store', async (context) => {
  const { dir, keyFile } = tempStore();
  context.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
  });
  const first = createAccountStore({ dir, keyFile, initialize: true });
  const alice = (await first.register({ login: 'alice', password: 'correct horse' })).token;
  await first.register({ login: 'bobby', password: 'correct horse' });
  first.linkFriends('alice', 'bobby');
  const { deviceId } = await first.e2eeUpload(alice, {});
  await first.e2eeUpload(alice, { deviceKeys: deviceKeys('alice', deviceId) });
  const statement = {
    login: 'alice', usage: 'peer_verified', peer: 'bobby', key: publicKey(), signatures: { alice: { 'ed25519:x': 'sig' } },
  };
  assert.deepEqual(await first.e2eeTrust(alice, { peerTrust: { bobby: statement } }), { ok: true, changed: true, login: 'alice' });
  await first.close();

  const second = createAccountStore({ dir, keyFile });
  context.after(() => second.close());
  assert.deepEqual(second.e2eeQuery('alice', ['alice']).alice.peerTrust, { bobby: statement });
});
