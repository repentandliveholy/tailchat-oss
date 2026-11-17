import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

import { createAccountStore } from '../src/cloud/accounts.js';
import { createCloudHub } from '../src/cloud/hub.js';
import { createCloudService } from '../src/cloud/server.js';
import { createBotClient } from '../bots/client.mjs';

// The bot keeps one socket per peer (`bots/client.mjs`), and the server hands a
// message only to the connections of its sender with the right subscription
// (`hub.js`: `target.peer !== fromLogin` skips). A reply therefore goes out on
// whichever socket is open — `anyOpenSocket` — and for every peer except the
// first that is *not* the socket watching them. The server then self-syncs the
// account's own message back down the watching socket, wearing the peer's name
// (`selfSync`: `from: toLogin`, `self: true`), and a bot that cannot tell that
// envelope apart answers itself: «помощь» came back as the help text, the help
// text came back as a reminder about the help text, and so on until the frame
// budget closed the socket. This is that scenario, on a real server.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('condition never became true');
    await sleep(10);
  }
}

async function startService(context) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-bot-data-'));
  const keyFile = `${dataDir}.master-key`;
  fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-bot-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>cloud</title>\n');
  const store = createAccountStore({ dir: dataDir, keyFile, initialize: true });
  const hub = createCloudHub({ store });
  const service = createCloudService({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    webRoot,
    store,
    hub,
    // A loopback bind without the proxy flag refuses to start, and this is not
    // a deployment: one shared attempt bucket is exactly right here.
    trustProxy: false,
    ownerLogin: null,
  });
  const address = await service.listen();
  context.after(async () => {
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
    fs.rmSync(webRoot, { recursive: true, force: true });
  });
  return { port: address.port, store };
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
    const clientRequest = http.request(
      { host: '127.0.0.1', port, method, path: requestPath, headers },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.once('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { json = null; }
          resolve({ status: response.statusCode, text, json });
        });
      },
    );
    clientRequest.once('error', reject);
    if (payload !== null) clientRequest.write(payload);
    clientRequest.end();
  });
}

async function register(port, login) {
  const response = await request(port, 'POST', '/tailchat/api/register', {
    body: { login, password: 'correct horse', name: login },
  });
  assert.equal(response.status, 201, response.text);
  return response.json.token;
}

// A peer of the bot: an ordinary subscriber that watches the bot and records
// what comes back.
async function peerSocket(port, token, botLogin, context) {
  const frames = [];
  const emitter = new EventEmitter();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/tailchat/ws`);
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString('utf8'));
    frames.push(frame);
    emitter.emit('frame', frame);
  });
  await new Promise((resolve) => socket.once('open', resolve));
  context.after(() => socket.close());
  socket.send(JSON.stringify({ k: 'auth', token }));
  await new Promise((resolve) => {
    emitter.on('frame', (frame) => { if (frame.k === 'ready') resolve(); });
  });
  socket.send(JSON.stringify({ k: 'subscribe', peer: botLogin }));
  await new Promise((resolve) => {
    emitter.on('frame', (frame) => { if (frame.k === 'subscribed') resolve(); });
  });
  return {
    frames,
    send: (payload) => socket.send(JSON.stringify(payload)),
    waitForText(text, timeoutMs = 4000) {
      const found = frames.find((frame) => frame.k === 'frame' && frame.d?.text === text);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`never received «${text}»`)), timeoutMs);
        emitter.on('frame', (frame) => {
          if (frame.k !== 'frame' || frame.d?.text !== text) return;
          clearTimeout(timer);
          resolve(frame);
        });
      });
    },
  };
}

// bots/client.mjs is dependency-free by design: it relies on Node 22's global
// WebSocket, which `engines` guarantees.
test('a bot never answers its own message coming back down another socket', async (context) => {
  const { port } = await startService(context);
  const olgaToken = await register(port, 'olga');
  const romanToken = await register(port, 'roman');

  const heard = [];
  const rosters = [];
  const client = createBotClient({
    server: `http://127.0.0.1:${port}`,
    login: 'bot',
    password: 'correct horse',
    displayName: 'Напоминалка',
    onMessage: (peer, frame) => heard.push({ peer, text: frame.text }),
    onPeers: (peers) => rosters.push(peers),
  });
  context.after(() => client.stop());

  // The bot is registered like any account, then befriends two people: the
  // second friend is the one whose replies used to loop.
  await register(port, 'bot');
  const first = await client.createInvite();
  assert.equal((await request(port, 'POST', '/tailchat/api/invite/accept', {
    token: olgaToken, body: { invite: first },
  })).status, 200);
  const second = await client.createInvite();
  assert.equal((await request(port, 'POST', '/tailchat/api/invite/accept', {
    token: romanToken, body: { invite: second },
  })).status, 200);

  const olga = await peerSocket(port, olgaToken, 'bot', context);
  const roman = await peerSocket(port, romanToken, 'bot', context);

  client.start();
  await until(() => client.peers().length === 2);
  assert.deepEqual(rosters.at(-1)?.sort(), ['olga', 'roman']);

  // Both of the bot's sockets have to be watching before the echo path exists,
  // and a message arriving from each peer is what proves they are: the server
  // delivers to a connection only while it is subscribed to the sender.
  olga.send({ k: 'frame', to: 'bot', d: { t: 'msg', id: 'm-o', text: 'от ольги', ts: Date.now() } });
  roman.send({ k: 'frame', to: 'bot', d: { t: 'msg', id: 'm-r', text: 'от романа', ts: Date.now() } });
  await until(() => heard.length === 2);
  assert.deepEqual(heard.map((entry) => entry.text).sort(), ['от ольги', 'от романа']);

  // Now the reply that used to loop. One of these two goes out over the socket
  // of the *other* peer — that is what `anyOpenSocket` does — so pre-fix the
  // account's own copy came back on the watching socket, named as the peer.
  heard.length = 0;
  assert.equal(client.sendText('olga', 'ответ ольге'), true);
  assert.equal(client.sendText('roman', 'ответ роману'), true);

  // Addressed-send still works: the socket a frame goes out on is not the one
  // watching its recipient, and that is deliberate.
  await olga.waitForText('ответ ольге');
  await roman.waitForText('ответ роману');

  await sleep(400);
  assert.deepEqual(heard, [], 'the bot answered its own message coming back as the peer');
});
