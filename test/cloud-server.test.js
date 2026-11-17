import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { createAccountStore } from '../src/cloud/accounts.js';
import { createCloudHub } from '../src/cloud/hub.js';
import { createCloudService } from '../src/cloud/server.js';

const INDEX_HTML = '<!doctype html><title>cloud</title>\n';
const APP_JS = 'window.tailchatCloud = true;\n';
const APP_CSS = ':root { color-scheme: dark; }\n';
const INSTALL_SH = '#!/usr/bin/env bash\necho install\n';

// A temporary web root keeps these tests independent of whatever is currently in
// `web/cloud/`, and lets them assert the exact bytes that came back.
function makeWebRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-cloud-web-'));
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX_HTML);
  fs.writeFileSync(path.join(dir, 'app.js'), APP_JS);
  fs.writeFileSync(path.join(dir, 'app.css'), APP_CSS);
  fs.writeFileSync(path.join(dir, 'install.sh'), INSTALL_SH);
  return dir;
}

async function startService(context, { authTimeoutMs = 5000, fetchPreview, trustProxy = false, turnConfig, ownerLogin = null, heartbeatMs, presenceGraceMs } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-cloud-data-'));
  const keyFile = `${dataDir}.master-key`;
  fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const webRoot = makeWebRoot();
  const store = createAccountStore({ dir: dataDir, keyFile, initialize: true });
  const hub = createCloudHub({
    store,
    authTimeoutMs,
    ...(presenceGraceMs ? { presenceGraceMs } : {}),
  });
  const service = createCloudService({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    webRoot,
    store,
    hub,
    // Explicit: a loopback bind without the flag now refuses to start (see
    // `createCloudService`), and what this harness wants is a working server,
    // not that failure.
    trustProxy,
    // Explicit too, and null by default: who may mint an invite for somebody
    // else is otherwise read from `TAILCHAT_CLOUD_AI_OWNER`, and a test run on a
    // machine that happens to export it must not silently become an
    // owner-configured deployment.
    ownerLogin,
    ...(fetchPreview ? { fetchPreview } : {}),
    ...(turnConfig ? { turnConfig } : {}),
    ...(heartbeatMs ? { heartbeatMs } : {}),
  });
  const address = await service.listen();
  context.after(async () => {
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
    fs.rmSync(webRoot, { recursive: true, force: true });
  });
  return { service, store, hub, port: address.port, dataDir, webRoot };
}

function request(port, method, requestPath, { token, body, raw, forwardedFor } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    if (forwardedFor) headers['X-Forwarded-For'] = forwardedFor;

    const clientRequest = http.request(
      { host: '127.0.0.1', port, method, path: requestPath, headers },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.once('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { json = null; }
          resolve({ status: response.statusCode, headers: response.headers, text, json });
        });
      },
    );
    // An oversized body is answered before it has been read, so the socket is
    // closed under our feet; the response has already resolved by then.
    clientRequest.once('error', (error) => reject(error));
    if (payload !== null) clientRequest.write(payload);
    clientRequest.end();
  }).catch((error) => {
    if (error.code === 'EPIPE' || error.code === 'ECONNRESET') return { status: 0, headers: {}, text: '', json: null };
    throw error;
  });
}

function collector() {
  const frames = [];
  const emitter = new EventEmitter();
  return {
    add(frame) {
      frames.push(frame);
      emitter.emit('frame', frame);
    },
    frames,
    waitFor(kind, timeoutMs = 4000) {
      const found = frames.find((frame) => frame.k === kind);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          emitter.off('frame', onFrame);
          reject(new Error(`timed out waiting for ${kind}; saw ${JSON.stringify(frames)}`));
        }, timeoutMs);
        const onFrame = (frame) => {
          if (frame.k !== kind) return;
          clearTimeout(timer);
          emitter.off('frame', onFrame);
          resolve(frame);
        };
        emitter.on('frame', onFrame);
      });
    },
  };
}

async function wsClient(port, options = {}) {
  const seen = collector();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/tailchat/ws`, options);
  socket.on('message', (data) => seen.add(JSON.parse(data.toString('utf8'))));
  await once(socket, 'open');
  return {
    socket,
    seen,
    send(payload) { socket.send(JSON.stringify(payload)); },
    async closed() {
      if (socket.readyState === WebSocket.CLOSED) return { code: socket.__code, reason: '' };
      const [code, reason] = await once(socket, 'close');
      return { code, reason: String(reason) };
    },
    close() { socket.close(); },
  };
}

async function makeAccount(port, login, name = login) {
  const response = await request(port, 'POST', '/tailchat/api/register', {
    body: { login, password: 'correct horse', name },
  });
  assert.equal(response.status, 201, response.text);
  return response.json.token;
}

test('health check answers with the hardened header set', async (context) => {
  const { port } = await startService(context);
  const response = await request(port, 'GET', '/health');

  assert.equal(response.status, 200);
  assert.equal(response.text, '{"ok":true,"aiBridge":false}\n');
  assert.equal(
    response.headers['content-security-policy'],
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; img-src 'self' data: blob: https:; media-src 'self' data: blob:; worker-src 'self'; manifest-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('a service-account store failure is logged without preventing the server from listening', async (context) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-cloud-data-'));
  const keyFile = `${dataDir}.master-key`;
  fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const webRoot = makeWebRoot();
  const store = createAccountStore({ dir: dataDir, keyFile, initialize: true });
  const hub = createCloudHub({ store });
  store.users = () => { throw new Error('account store unavailable'); };
  const service = createCloudService({
    host: '127.0.0.1', port: 0, dataDir, webRoot, store, hub, trustProxy: true, aiBridge: null, pushSender: null,
  });
  context.after(async () => {
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
    fs.rmSync(webRoot, { recursive: true, force: true });
  });

  const address = await service.listen();
  assert.ok(address.port > 0);
  const health = await request(address.port, 'GET', '/health');
  assert.equal(health.status, 200);
});

test('the bare cloud path redirects permanently to the directory form', async (context) => {
  const { port } = await startService(context);
  const response = await request(port, 'GET', '/tailchat');

  assert.equal(response.status, 308);
  assert.equal(response.headers.location, '/tailchat/');
});

test('only the three known assets are served, everything else is 404', async (context) => {
  const { port } = await startService(context);

  const index = await request(port, 'GET', '/tailchat/');
  assert.equal(index.status, 200);
  assert.equal(index.text, INDEX_HTML);
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');

  const script = await request(port, 'GET', '/tailchat/app.js');
  assert.equal(script.status, 200);
  assert.equal(script.text, APP_JS);
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');

  const style = await request(port, 'GET', '/tailchat/app.css');
  assert.equal(style.status, 200);
  assert.equal(style.text, APP_CSS);
  assert.equal(style.headers['content-type'], 'text/css; charset=utf-8');

  const indexHtml = await request(port, 'GET', '/tailchat/index.html');
  assert.equal(indexHtml.status, 200);
  assert.equal(indexHtml.text, INDEX_HTML);

  for (const probe of ['/', '/tailchat/app.js.map', '/tailchat/api/nope', '/etc/passwd']) {
    const response = await request(port, 'GET', probe);
    assert.equal(response.status, 404, `${probe} should not be served`);
    assert.equal(response.json.error, 'not_found');
  }
});

test('an edited asset is served without restarting the service', async (context) => {
  const { port, webRoot } = await startService(context);

  assert.equal((await request(port, 'GET', '/tailchat/')).text, INDEX_HTML);
  // The mtime clock has a coarse resolution on some filesystems, so the second
  // write has to be distinguishable from the first by more than luck.
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>edited</title>\n');

  const edited = await request(port, 'GET', '/tailchat/');
  assert.equal(edited.status, 200);
  assert.equal(edited.text, '<!doctype html><title>edited</title>\n');

  fs.rmSync(path.join(webRoot, 'index.html'));
  assert.equal((await request(port, 'GET', '/tailchat/')).status, 404);
});

test('the browser core is served from its eight fixed paths, the wasm as application/wasm', async (context) => {
  const { port, webRoot } = await startService(context);
  const files = ['core/core-client.js', 'core/idb-storage.js', 'core/routing.js', 'core/web-session.js', 'core/e2ee-commands.js', 'core/e2ee-strings.js', 'core/pkg/tailchat_web.js', 'core/pkg/tailchat_web_bg.wasm'];
  for (const file of files) {
    assert.equal((await request(port, 'GET', `/tailchat/${file}`)).status, 404, `${file} absent`);
  }
  fs.mkdirSync(path.join(webRoot, 'core/pkg'), { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(webRoot, file), file.endsWith('.wasm') ? '\0asm' : 'export {};\n');
  const wasm = await request(port, 'GET', '/tailchat/core/pkg/tailchat_web_bg.wasm');
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers['content-type'], 'application/wasm');
  const glue = await request(port, 'GET', '/tailchat/core/pkg/tailchat_web.js');
  assert.equal(glue.headers['content-type'], 'text/javascript; charset=utf-8');
  for (const probe of ['/tailchat/core/', '/tailchat/core/pkg/other.wasm', '/tailchat/core/..%2Fapp.js', '/tailchat/core/pkg/../core-client.js']) {
    const response = await request(port, 'GET', probe);
    assert.ok(response.status === 404 || response.status === 200 && probe.endsWith('core-client.js'), `${probe}: ${response.status}`);
  }
});

test('Apple emoji PNGs are served by code-point name only, with a long cache', async (context) => {
  const { port, webRoot } = await startService(context);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.mkdirSync(path.join(webRoot, 'emoji/apple/64'), { recursive: true });
  fs.writeFileSync(path.join(webRoot, 'emoji/apple/64/1f44d.png'), png);
  fs.writeFileSync(path.join(webRoot, 'emoji/apple/64/2764-fe0f.png'), png);
  fs.writeFileSync(path.join(webRoot, 'emoji-data.js'), 'globalThis.TAILCHAT_EMOJI = [];\n');

  for (const name of ['1f44d', '2764-fe0f']) {
    const glyph = await request(port, 'GET', `/tailchat/emoji/apple/64/${name}.png`);
    assert.equal(glyph.status, 200, name);
    assert.equal(glyph.headers['content-type'], 'image/png');
    assert.equal(glyph.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(glyph.headers['x-content-type-options'], 'nosniff');
  }
  const data = await request(port, 'GET', '/tailchat/emoji-data.js');
  assert.equal(data.status, 200);
  assert.equal(data.headers['content-type'], 'text/javascript; charset=utf-8');

  for (const probe of [
    '/tailchat/emoji/apple/64/1f600.png',
    '/tailchat/emoji/apple/64/1F44D.png',
    '/tailchat/emoji/apple/64/..%2F..%2F..%2Fapp.js',
    '/tailchat/emoji/apple/64/%2e%2e%2fapp.png',
    '/tailchat/emoji/apple/64/1f44d.png.png',
    '/tailchat/emoji/apple/64/1f44d',
    '/tailchat/emoji/apple/32/1f44d.png',
    '/tailchat/emoji/apple/64/',
  ]) {
    const response = await request(port, 'GET', probe);
    assert.equal(response.status, 404, `${probe} should not be served`);
    assert.equal(response.json.error, 'not_found');
  }
  const posted = await request(port, 'POST', '/tailchat/emoji/apple/64/1f44d.png', { body: {} });
  assert.equal(posted.status, 405);
});

test('a known path with the wrong method is 405, not 404', async (context) => {
  const { port } = await startService(context);

  const users = await request(port, 'POST', '/tailchat/api/users', { body: {} });
  assert.equal(users.status, 405);
  assert.equal(users.json.error, 'method_not_allowed');
  assert.match(users.json.message, /[А-Яа-я]/);

  const login = await request(port, 'GET', '/tailchat/api/login');
  assert.equal(login.status, 405);
});

test('every authorised endpoint refuses a request without a usable token', async (context) => {
  const { port } = await startService(context);

  for (const probe of ['/tailchat/api/me', '/tailchat/api/users', '/tailchat/api/history?peer=roman', '/tailchat/api/media?peer=roman&id=m-1&slot=image', '/tailchat/api/link-preview?url=http%3A%2F%2Fexample.com']) {
    const anonymous = await request(port, 'GET', probe);
    assert.equal(anonymous.status, 401, probe);
    assert.equal(anonymous.json.error, 'unknown_token');

    const bogus = await request(port, 'GET', probe, { token: 'ffff' });
    assert.equal(bogus.status, 401, probe);
  }

  const logout = await request(port, 'POST', '/tailchat/api/logout');
  assert.equal(logout.status, 401);
});

test('register, login, me and users walk through one account lifecycle', async (context) => {
  const { port } = await startService(context);

  const registered = await request(port, 'POST', '/tailchat/api/register', {
    body: { login: 'Roman', password: 'correct horse', name: 'Роман' },
  });
  assert.equal(registered.status, 201, registered.text);
  assert.equal(registered.json.user.login, 'roman');
  assert.equal(registered.json.user.name, 'Роман');
  assert.equal(typeof registered.json.token, 'string');
  assert.equal(registered.json.token.length, 64);

  const loggedIn = await request(port, 'POST', '/tailchat/api/login', {
    body: { login: 'roman', password: 'correct horse' },
  });
  assert.equal(loggedIn.status, 200, loggedIn.text);
  const token = loggedIn.json.token;

  const me = await request(port, 'GET', '/tailchat/api/me', { token });
  assert.equal(me.status, 200);
  assert.deepEqual(me.json, { user: { login: 'roman', name: 'Роман', extraPasswordEnabled: false } });

  const olgaToken = await makeAccount(port, 'olga', 'Ольга');

  const initialUsers = await request(port, 'GET', '/tailchat/api/users', { token });
  assert.equal(initialUsers.status, 200);
  // Two contacts nobody has to add: the official account and the assistant.
  // Neither announces a release (RELEASE_ANNOUNCEMENTS is off), and the
  // assistant's thread is how you talk to it without mentioning it in somebody
  // else's conversation.
  assert.deepEqual(
    initialUsers.json.users.map((user) => [user.login, user.official]).sort(),
    [['tailchat', true], ['tailik', true]],
  );
  const official = initialUsers.json.users.find((user) => user.login === 'tailchat');
  assert.equal(official.pending, 1, 'the one thing waiting there is the menu, never a release note');
  assert.equal(official.online, true, 'the server accounts are up whenever the server is');

  const officialHistory = await request(port, 'GET', '/tailchat/api/history?peer=tailchat', { token });
  assert.equal(officialHistory.status, 200);
  // Not empty, and not a release note either: registration writes the menu
  // into a thread that has never been written to, because the account that has
  // something to offer was otherwise a blank screen with nothing to press.
  assert.deepEqual(
    officialHistory.json.messages.map((message) => message.id),
    ['service-menu-v1'],
    'the official chat opens on its own menu, and on nothing else',
  );
  assert.deepEqual(
    officialHistory.json.messages[0].buttons.map((button) => button.value),
    ['/help', '/bug', '/friend'],
  );

  const notFriendsHistory = await request(port, 'GET', '/tailchat/api/history?peer=olga', { token });
  assert.equal(notFriendsHistory.status, 403);
  assert.equal(notFriendsHistory.json.error, 'not_friends');

  const createdInvite = await request(port, 'POST', '/tailchat/api/invite', { token });
  assert.equal(createdInvite.status, 201);
  assert.equal(typeof createdInvite.json.invite, 'string');
  assert.equal(createdInvite.json.invite.length, 64);
  const inviteCode = createdInvite.json.invite;

  const selfAccept = await request(port, 'POST', '/tailchat/api/invite/accept', { token, body: { invite: inviteCode } });
  assert.equal(selfAccept.status, 400);
  assert.equal(selfAccept.json.error, 'self_invite');

  const accepted = await request(port, 'POST', '/tailchat/api/invite/accept', { token: olgaToken, body: { invite: inviteCode } });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.json, { friend: { login: 'roman', name: 'Роман' } });

  const secondAccept = await request(port, 'POST', '/tailchat/api/invite/accept', { token: olgaToken, body: { invite: inviteCode } });
  assert.equal(secondAccept.status, 404);
  assert.equal(secondAccept.json.error, 'invite_not_found');

  const users = await request(port, 'GET', '/tailchat/api/users', { token });
  assert.equal(users.status, 200);
  assert.deepEqual([...users.json.users.map((user) => user.login)].sort(), ['olga', 'tailchat', 'tailik']);
  const olgaEntry = users.json.users.find((user) => user.login === 'olga');
  assert.equal(olgaEntry.online, false);
  assert.equal(olgaEntry.state, 'away', 'an offline friend is nowhere near the keyboard');
  assert.equal(olgaEntry.pending, 0);
  assert.equal(typeof olgaEntry.lastSeen, 'number');

  const history = await request(port, 'GET', '/tailchat/api/history?peer=olga', { token });
  assert.equal(history.status, 200);
  assert.equal(history.headers['cache-control'], 'no-store');
  assert.deepEqual(history.json, { messages: [], peerReadTs: 0, peerDeliveredTs: 0, peerReadAt: 0, peerReadVia: '' });

  const badPeer = await request(port, 'GET', '/tailchat/api/history?peer=%20', { token });
  assert.equal(badPeer.status, 400);
  assert.equal(badPeer.json.error, 'invalid_login');

  const logout = await request(port, 'POST', '/tailchat/api/logout', { token });
  assert.equal(logout.status, 204);
  const afterLogout = await request(port, 'GET', '/tailchat/api/me', { token });
  assert.equal(afterLogout.status, 401);
});

test('POST /api/block and /api/unblock: scoped to friends, idempotent, roster reflects only the blocker\'s side', async (context) => {
  const { port } = await startService(context);
  const romanToken = await makeAccount(port, 'roman', 'Роман');
  const olgaToken = await makeAccount(port, 'olga', 'Ольга');

  const strangerBlock = await request(port, 'POST', '/tailchat/api/block', { token: romanToken, body: { login: 'olga' } });
  assert.equal(strangerBlock.status, 403);
  assert.equal(strangerBlock.json.error, 'not_friends');

  const selfBlock = await request(port, 'POST', '/tailchat/api/block', { token: romanToken, body: { login: 'roman' } });
  assert.equal(selfBlock.status, 400);
  assert.equal(selfBlock.json.error, 'self_block');

  const ghostBlock = await request(port, 'POST', '/tailchat/api/block', { token: romanToken, body: { login: 'ghost' } });
  assert.equal(ghostBlock.status, 404);
  assert.equal(ghostBlock.json.error, 'unknown_user');

  const inviteRes = await request(port, 'POST', '/tailchat/api/invite', { token: romanToken });
  await request(port, 'POST', '/tailchat/api/invite/accept', { token: olgaToken, body: { invite: inviteRes.json.invite } });

  const blocked = await request(port, 'POST', '/tailchat/api/block', { token: romanToken, body: { login: 'olga' } });
  assert.equal(blocked.status, 200);
  assert.deepEqual(blocked.json, { blocked: true });

  const romanUsers = await request(port, 'GET', '/tailchat/api/users', { token: romanToken });
  assert.equal(romanUsers.json.users.find((u) => u.login === 'olga').blocked, true);

  // Olga is never told roman blocked her — friendship and her own roster
  // entry for him stay unmarked.
  const olgaUsers = await request(port, 'GET', '/tailchat/api/users', { token: olgaToken });
  assert.equal(olgaUsers.json.users.find((u) => u.login === 'roman').blocked, undefined);

  const unblocked = await request(port, 'POST', '/tailchat/api/unblock', { token: romanToken, body: { login: 'olga' } });
  assert.equal(unblocked.status, 200);
  assert.deepEqual(unblocked.json, { blocked: false });
  // Idempotent: unblocking again is still a success, not an error.
  const unblockedAgain = await request(port, 'POST', '/tailchat/api/unblock', { token: romanToken, body: { login: 'olga' } });
  assert.equal(unblockedAgain.status, 200);

  const romanUsersAfter = await request(port, 'GET', '/tailchat/api/users', { token: romanToken });
  assert.equal(romanUsersAfter.json.users.find((u) => u.login === 'olga').blocked, undefined);
});

test('POST /api/alias: private to the owner, scoped to friends, and reflected in both rosters (issue #28)', async (context) => {
  const { port } = await startService(context);
  const romanToken = await makeAccount(port, 'roman', 'Роман');
  const olgaToken = await makeAccount(port, 'olga', 'Ольга');

  const unauthorised = await request(port, 'POST', '/tailchat/api/alias', { body: { login: 'olga', name: 'Оля' } });
  assert.equal(unauthorised.status, 401);

  const stranger = await request(port, 'POST', '/tailchat/api/alias', { token: romanToken, body: { login: 'olga', name: 'Оля' } });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.json.error, 'not_friends');

  const self = await request(port, 'POST', '/tailchat/api/alias', { token: romanToken, body: { login: 'roman', name: 'Я' } });
  assert.equal(self.status, 400);
  assert.equal(self.json.error, 'self_alias');

  const ghost = await request(port, 'POST', '/tailchat/api/alias', { token: romanToken, body: { login: 'ghost', name: 'Призрак' } });
  assert.equal(ghost.status, 404);
  assert.equal(ghost.json.error, 'unknown_user');

  const badLogin = await request(port, 'POST', '/tailchat/api/alias', { token: romanToken, body: { login: ' ' } });
  assert.equal(badLogin.status, 400);
  assert.equal(badLogin.json.error, 'invalid_login');

  // A nickname is free text: an emoji or punctuation is a nickname, not a
  // validation error. Only a value that is nothing but controls is refused,
  // and so is a value that is not a string at all.
  const invite = await request(port, 'POST', '/tailchat/api/invite', { token: romanToken });
  await request(port, 'POST', '/tailchat/api/invite/accept', { token: olgaToken, body: { invite: invite.json.invite } });

  const emoji = await request(port, 'POST', '/tailchat/api/alias', { token: romanToken, body: { login: 'olga', name: '🎉 Оля' } });
  assert.equal(emoji.status, 200);
  assert.deepEqual(emoji.json, { login: 'olga', alias: '🎉 Оля' });
  const blank = await request(port, 'POST', '/tailchat/api/alias', { token: romanToken, body: { login: 'olga', name: '\u0007' } });
  assert.equal(blank.status, 400);
  assert.equal(blank.json.error, 'invalid_alias');
  const wrongType = await request(port, 'POST', '/tailchat/api/alias', { token: romanToken, body: { login: 'olga', name: 42 } });
  assert.equal(wrongType.status, 400);
  assert.equal(wrongType.json.error, 'invalid_alias');

  const set = await request(port, 'POST', '/tailchat/api/alias', { token: romanToken, body: { login: 'olga', name: '  Оля  ' } });
  assert.equal(set.status, 200);
  assert.deepEqual(set.json, { login: 'olga', alias: 'Оля' });

  // The owner's own roster carries it, HTTP and socket alike.
  const romanUsers = await request(port, 'GET', '/tailchat/api/users', { token: romanToken });
  assert.equal(romanUsers.json.users.find((u) => u.login === 'olga').alias, 'Оля');

  // The peer is never told: its roster shows the name it chose, and no nickname
  // of roman's can reach it through any roster.
  const olgaUsers = await request(port, 'GET', '/tailchat/api/users', { token: olgaToken });
  assert.equal(olgaUsers.json.users.find((u) => u.login === 'roman').alias, undefined);

  // Clearing restores the real name.
  const cleared = await request(port, 'POST', '/tailchat/api/alias', { token: romanToken, body: { login: 'olga', name: '' } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.json, { login: 'olga', alias: '' });
  const after = await request(port, 'GET', '/tailchat/api/users', { token: romanToken });
  assert.equal(after.json.users.find((u) => u.login === 'olga').alias, undefined);
});

test('POST /api/contact/remove: one-sided for the roster and the thread, refused for the official contacts', async (context) => {
  const { port, store } = await startService(context);
  const romanToken = await makeAccount(port, 'roman', 'Роман');
  const olgaToken = await makeAccount(port, 'olga', 'Ольга');

  const unauthorised = await request(port, 'POST', '/tailchat/api/contact/remove', { body: { login: 'olga' } });
  assert.equal(unauthorised.status, 401);

  const stranger = await request(port, 'POST', '/tailchat/api/contact/remove', { token: romanToken, body: { login: 'olga' } });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.json.error, 'not_friends');

  const self = await request(port, 'POST', '/tailchat/api/contact/remove', { token: romanToken, body: { login: 'roman' } });
  assert.equal(self.status, 400);
  assert.equal(self.json.error, 'self_remove');

  const badLogin = await request(port, 'POST', '/tailchat/api/contact/remove', { token: romanToken, body: { login: ' ' } });
  assert.equal(badLogin.status, 400);
  assert.equal(badLogin.json.error, 'invalid_login');

  // The official contacts belong on every roster by construction (AGENTS.md
  // §9 re-links them at boot), so deleting one is refused rather than done and
  // quietly undone on the next restart.
  const official = await request(port, 'POST', '/tailchat/api/contact/remove', { token: romanToken, body: { login: 'tailchat' } });
  assert.equal(official.status, 403);
  assert.equal(official.json.error, 'official_contact');

  const invite = await request(port, 'POST', '/tailchat/api/invite', { token: romanToken });
  await request(port, 'POST', '/tailchat/api/invite/accept', { token: olgaToken, body: { invite: invite.json.invite } });
  store.recordHistory('roman', 'olga', { id: 'm1', from: 'roman', text: 'привет', ts: 1000 });
  store.recordHistory('olga', 'roman', { id: 'm2', from: 'olga', text: 'и тебе', ts: 2000 });

  const before = await request(port, 'GET', '/tailchat/api/history?peer=olga', { token: romanToken });
  assert.deepEqual(before.json.messages.map((m) => m.id), ['m1', 'm2']);

  const removed = await request(port, 'POST', '/tailchat/api/contact/remove', { token: romanToken, body: { login: 'olga' } });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json, { ok: true });

  // Roman's roster and his own view of the thread are both gone...
  const romanUsers = await request(port, 'GET', '/tailchat/api/users', { token: romanToken });
  assert.deepEqual(romanUsers.json.users.map((u) => u.login).sort(), ['tailchat', 'tailik']);
  const romanHistory = await request(port, 'GET', '/tailchat/api/history?peer=olga', { token: romanToken });
  assert.equal(romanHistory.status, 200);
  assert.deepEqual(romanHistory.json.messages, []);

  // ...while Olga keeps the contact and every message: deleting is «у себя».
  const olgaUsers = await request(port, 'GET', '/tailchat/api/users', { token: olgaToken });
  assert.ok(olgaUsers.json.users.some((u) => u.login === 'roman'));
  const olgaHistory = await request(port, 'GET', '/tailchat/api/history?peer=roman', { token: olgaToken });
  assert.deepEqual(olgaHistory.json.messages.map((m) => m.id), ['m1', 'm2']);

  // A retry whose response was lost is answered the same way, not with an error.
  const again = await request(port, 'POST', '/tailchat/api/contact/remove', { token: romanToken, body: { login: 'olga' } });
  assert.equal(again.status, 200);

  // An invite re-adds the contact; the deleted thread stays deleted.
  const back = await request(port, 'POST', '/tailchat/api/invite', { token: olgaToken });
  await request(port, 'POST', '/tailchat/api/invite/accept', { token: romanToken, body: { invite: back.json.invite } });
  const romanUsersBack = await request(port, 'GET', '/tailchat/api/users', { token: romanToken });
  assert.ok(romanUsersBack.json.users.some((u) => u.login === 'olga'));
  const romanHistoryBack = await request(port, 'GET', '/tailchat/api/history?peer=olga', { token: romanToken });
  assert.deepEqual(romanHistoryBack.json.messages, []);
});

test('a Saved Messages history request for your own login is never a friend check', async (context) => {
  const { port, store } = await startService(context);

  const registered = await request(port, 'POST', '/tailchat/api/register', {
    body: { login: 'roman', password: 'correct horse', name: 'Роман' },
  });
  const token = registered.json.token;

  const selfHistory = await request(port, 'GET', '/tailchat/api/history?peer=roman', { token });
  assert.equal(selfHistory.status, 200);
  assert.deepEqual(selfHistory.json, { messages: [], peerReadTs: 0, peerDeliveredTs: 0, peerReadAt: 0, peerReadVia: '' });

  for (let n = 1; n <= 620; n += 1) {
    store.recordHistory('roman', 'roman', {
      id: `saved-${n}`, from: 'roman', text: `#${n}`, ts: n,
    });
  }
  const completeHistory = await request(
    port,
    'GET',
    '/tailchat/api/history?peer=roman&limit=5000',
    { token },
  );
  assert.equal(completeHistory.status, 200);
  assert.equal(completeHistory.json.messages.length, 620, 'Saved Messages may return more than the normal 500-message ceiling');
  assert.equal(completeHistory.json.messages[0].id, 'saved-1');
});

// `/api/history` carries the delivery watermark beside the read one: without it
// the author's rebuilt transcript cannot tell ✓✓ (the peer's device holds it)
// from ✓ (only the server has it), and the middle rung collapses into "not
// read" on every reload.
test('GET /api/history reports delivery separately from read', async (context) => {
  const { port, store } = await startService(context);
  const romanToken = await makeAccount(port, 'roman', 'Роман');
  const olgaToken = await makeAccount(port, 'olga', 'Ольга');
  const invite = await request(port, 'POST', '/tailchat/api/invite', { token: romanToken });
  await request(port, 'POST', '/tailchat/api/invite/accept', { token: olgaToken, body: { invite: invite.json.invite } });

  store.recordHistory('roman', 'olga', { id: 'm1', from: 'roman', text: 'привет', ts: 1000 });
  store.recordHistory('roman', 'olga', { id: 'm2', from: 'roman', text: 'ещё', ts: 2000 });

  // Olga's device holds m1 but has read nothing: roman's rebuild shows ✓✓ on m1
  // and a single ✓ on m2.
  assert.equal(await store.markDelivered('olga', 'roman', 'm1'), 1000);
  const delivered = await request(port, 'GET', '/tailchat/api/history?peer=olga', { token: romanToken });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.json.peerDeliveredTs, 1000);
  assert.equal(delivered.json.peerReadTs, 0, 'a delivery is not a read');

  // Reading m2 implies delivery of it, so both watermarks answer from there.
  await store.markRead('olga', 'roman', 'm2');
  const read = await request(port, 'GET', '/tailchat/api/history?peer=olga', { token: romanToken });
  assert.equal(read.json.peerDeliveredTs, 2000);
  assert.equal(read.json.peerReadTs, 2000);
});

test('link-preview requires a url param, returns the fetched preview, and caches repeat requests', async (context) => {
  const calls = [];
  const fetchPreview = async (url) => {
    calls.push(url);
    return url === 'http://example.com/ok' ? { url, title: 'Example', description: null, image: null, siteName: null } : null;
  };
  const { port } = await startService(context, { fetchPreview });
  const token = await makeAccount(port, 'roman', 'Роман');

  const missing = await request(port, 'GET', '/tailchat/api/link-preview', { token });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, 'bad_request');

  const ok = await request(port, 'GET', '/tailchat/api/link-preview?url=http%3A%2F%2Fexample.com%2Fok', { token });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.preview, {
    url: 'http://example.com/ok', title: 'Example', description: null, image: null, siteName: null,
  });

  const refused = await request(port, 'GET', '/tailchat/api/link-preview?url=http%3A%2F%2F127.0.0.1%2F', { token });
  assert.equal(refused.status, 200);
  assert.equal(refused.json.preview, null);

  // Same URL again: the handler's cache answers without a second call to
  // the injected fetcher.
  await request(port, 'GET', '/tailchat/api/link-preview?url=http%3A%2F%2Fexample.com%2Fok', { token });
  assert.deepEqual(calls, ['http://example.com/ok', 'http://127.0.0.1/']);
});

test('profile endpoint updates name and password without invalidating the active session', async (context) => {
  const { port } = await startService(context);
  const registered = await request(port, 'POST', '/tailchat/api/register', {
    body: { login: 'roman', password: 'oldpassword', name: 'Роман' },
  });
  const token = registered.json.token;

  const anonymous = await request(port, 'PATCH', '/tailchat/api/profile', {
    body: { name: 'Рома' },
  });
  assert.equal(anonymous.status, 401);

  const wrong = await request(port, 'PATCH', '/tailchat/api/profile', {
    token,
    body: { name: 'Рома', currentPassword: 'wrongpassword', newPassword: 'newpassword' },
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error, 'bad_credentials');

  const changed = await request(port, 'PATCH', '/tailchat/api/profile', {
    token,
    body: { name: 'Рома', currentPassword: 'oldpassword', newPassword: 'newpassword' },
  });
  assert.equal(changed.status, 200, changed.text);
  assert.deepEqual(changed.json, { user: { login: 'roman', name: 'Рома', extraPasswordEnabled: false } });

  const me = await request(port, 'GET', '/tailchat/api/me', { token });
  assert.deepEqual(me.json, { user: { login: 'roman', name: 'Рома', extraPasswordEnabled: false } });
  assert.equal((await request(port, 'POST', '/tailchat/api/login', {
    body: { login: 'roman', password: 'oldpassword' },
  })).status, 401);
  assert.equal((await request(port, 'POST', '/tailchat/api/login', {
    body: { login: 'roman', password: 'newpassword' },
  })).status, 200);
});

test('login requires the additional password once profile sets one, without counting the prompt as a failed attempt', async (context) => {
  const { port } = await startService(context);
  const registered = await request(port, 'POST', '/tailchat/api/register', {
    body: { login: 'roman', password: 'oldpassword', name: 'Роман' },
  });
  const token = registered.json.token;

  const set = await request(port, 'PATCH', '/tailchat/api/profile', {
    token,
    body: { name: 'Роман', currentPassword: 'oldpassword', extraPassword: 'extrasecret' },
  });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.json.user.extraPasswordEnabled, true);

  // Primary password alone is answered with a distinct code, not folded into
  // `bad_credentials` — reachable only once the primary password already
  // checked out, so this is the normal first step, not a failed guess.
  const needsExtra = await request(port, 'POST', '/tailchat/api/login', {
    body: { login: 'roman', password: 'oldpassword' },
  });
  assert.equal(needsExtra.status, 401);
  assert.equal(needsExtra.json.error, 'extra_password_required');

  // Repeating that same prompt ten times must never trip the failed-attempt
  // limiter (contrast with the wrong-password case below, and with "ten
  // failed logins from one address exhaust the attempt limiter").
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const prompted = await request(port, 'POST', '/tailchat/api/login', {
      body: { login: 'roman', password: 'oldpassword' },
    });
    assert.equal(prompted.status, 401, `attempt ${attempt}`);
    assert.equal(prompted.json.error, 'extra_password_required');
  }
  const stillOpen = await request(port, 'POST', '/tailchat/api/login', {
    body: { login: 'roman', password: 'oldpassword', extraPassword: 'wrongextra' },
  });
  assert.equal(stillOpen.status, 401);
  assert.equal(stillOpen.json.error, 'bad_credentials', 'the limiter never engaged, so this reaches the real check');

  const in1 = await request(port, 'POST', '/tailchat/api/login', {
    body: { login: 'roman', password: 'oldpassword', extraPassword: 'extrasecret' },
  });
  assert.equal(in1.status, 200, in1.text);
  assert.equal(in1.json.user.extraPasswordEnabled, true);

  // A wrong additional password, unlike the bare prompt above, is a real
  // failed attempt and does count toward the limiter. One was already spent
  // above (`stillOpen`); nine more reaches the same ten-failure ceiling the
  // "ten failed logins" test pins, without going a request past it.
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const wrong = await request(port, 'POST', '/tailchat/api/login', {
      body: { login: 'roman', password: 'oldpassword', extraPassword: 'wrongextra' },
    });
    assert.equal(wrong.status, 401, `attempt ${attempt}`);
    assert.equal(wrong.json.error, 'bad_credentials');
  }
  const blocked = await request(port, 'POST', '/tailchat/api/login', {
    body: { login: 'roman', password: 'oldpassword', extraPassword: 'extrasecret' },
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error, 'too_many_attempts');
});


test('a taken login is a conflict and bad input is a validation error', async (context) => {
  const { port } = await startService(context);
  await makeAccount(port, 'roman');

  const conflict = await request(port, 'POST', '/tailchat/api/register', {
    body: { login: 'ROMAN', password: 'correct horse', name: 'Roman II' },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error, 'login_taken');
  assert.match(conflict.json.message, /[А-Яа-я]/);

  const shortPassword = await request(port, 'POST', '/tailchat/api/register', {
    body: { login: 'olga', password: '', name: 'Olga' },
  });
  assert.equal(shortPassword.status, 400);
  assert.equal(shortPassword.json.error, 'invalid_password');

  const badLogin = await request(port, 'POST', '/tailchat/api/register', {
    body: { login: 'no', password: 'correct horse' },
  });
  assert.equal(badLogin.status, 400);
  assert.equal(badLogin.json.error, 'invalid_login');
});

test('malformed and oversized request bodies are rejected before any store work', async (context) => {
  const { port } = await startService(context);

  const broken = await request(port, 'POST', '/tailchat/api/login', { raw: '{"login":' });
  assert.equal(broken.status, 400);
  assert.equal(broken.json.error, 'invalid_json');

  const notAnObject = await request(port, 'POST', '/tailchat/api/login', { raw: '"roman"' });
  assert.equal(notAnObject.status, 400);
  assert.equal(notAnObject.json.error, 'invalid_json');

  const huge = await request(port, 'POST', '/tailchat/api/register', {
    raw: JSON.stringify({ login: 'roman', password: 'correct horse', name: 'x'.repeat(9000) }),
  });
  assert.equal(huge.status, 413);
  assert.equal(huge.json.error, 'body_too_large');
});

test('ten failed logins from one address exhaust the attempt limiter', async (context) => {
  const { port } = await startService(context);
  await makeAccount(port, 'roman');

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await request(port, 'POST', '/tailchat/api/login', {
      body: { login: 'roman', password: 'wrong password' },
    });
    assert.equal(response.status, 401, `attempt ${attempt}`);
    assert.equal(response.json.error, 'bad_credentials');
  }

  const blocked = await request(port, 'POST', '/tailchat/api/login', {
    body: { login: 'roman', password: 'correct horse' },
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error, 'too_many_attempts');

  // The same bucket guards registration, so the limiter is not endpoint-local.
  const alsoBlocked = await request(port, 'POST', '/tailchat/api/register', {
    body: { login: 'olga', password: 'correct horse' },
  });
  assert.equal(alsoBlocked.status, 429);
});

test('X-Forwarded-For is ignored unless the proxy is trusted, and then only its last hop', async (context) => {
  const previous = process.env.TAILCHAT_CLOUD_TRUST_PROXY;
  context.after(() => {
    if (previous === undefined) delete process.env.TAILCHAT_CLOUD_TRUST_PROXY;
    else process.env.TAILCHAT_CLOUD_TRUST_PROXY = previous;
  });

  delete process.env.TAILCHAT_CLOUD_TRUST_PROXY;
  // Explicitly untrusted: the environment does not decide it here, because a
  // loopback bind with the flag unset refuses to start at all — which is what
  // the test below this one pins.
  const untrusting = await startService(context, { trustProxy: false });
  await makeAccount(untrusting.port, 'roman');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    // A fresh address on every request would be a fresh bucket if the header
    // were believed, so the limiter must never fire — unless it is.
    const response = await request(untrusting.port, 'POST', '/tailchat/api/login', {
      body: { login: 'roman', password: 'wrong password' },
      forwardedFor: `203.0.113.${attempt}`,
    });
    assert.equal(response.status, 401, `attempt ${attempt}`);
  }
  const stillCounted = await request(untrusting.port, 'POST', '/tailchat/api/login', {
    body: { login: 'roman', password: 'correct horse' },
    forwardedFor: '203.0.113.99',
  });
  assert.equal(stillCounted.status, 429);

  process.env.TAILCHAT_CLOUD_TRUST_PROXY = '1';
  // Behind the proxy, which is what this half is about: the harness passes the
  // flag explicitly rather than leaving it to the environment, because the
  // environment is not what decides a loopback bind any more — see the test
  // below, which is where TAILCHAT_CLOUD_TRUST_PROXY itself is exercised.
  const trusting = await startService(context, { trustProxy: true });
  await makeAccount(trusting.port, 'roman');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    // Only the hop the proxy appended counts, so the client-supplied first hop
    // cannot spread the failures over ten separate buckets.
    const response = await request(trusting.port, 'POST', '/tailchat/api/login', {
      body: { login: 'roman', password: 'wrong password' },
      forwardedFor: `198.51.100.${attempt}, 203.0.113.7`,
    });
    assert.equal(response.status, 401, `attempt ${attempt}`);
  }
  const sameHop = await request(trusting.port, 'POST', '/tailchat/api/login', {
    body: { login: 'roman', password: 'correct horse' },
    forwardedFor: '198.51.100.42, 203.0.113.7',
  });
  assert.equal(sameHop.status, 429);

  const otherHop = await request(trusting.port, 'POST', '/tailchat/api/login', {
    body: { login: 'roman', password: 'correct horse' },
    forwardedFor: '198.51.100.42, 203.0.113.8',
  });
  assert.equal(otherHop.status, 200, otherHop.text);
});

test('a loopback bind without the proxy flag refuses to start, and the environment is what sets it', async (context) => {
  const previous = process.env.TAILCHAT_CLOUD_TRUST_PROXY;
  context.after(() => {
    if (previous === undefined) delete process.env.TAILCHAT_CLOUD_TRUST_PROXY;
    else process.env.TAILCHAT_CLOUD_TRUST_PROXY = previous;
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-cloud-proxy-'));
  const keyFile = `${dataDir}.master-key`;
  fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const webRoot = makeWebRoot();
  context.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
    fs.rmSync(webRoot, { recursive: true, force: true });
  });
  const options = { host: '127.0.0.1', port: 0, dataDir, webRoot, keyFile };

  delete process.env.TAILCHAT_CLOUD_TRUST_PROXY;
  // Behind a proxy with the flag unset every request looks like 127.0.0.1, so
  // one person's ten failed logins would lock out the whole deployment. Refusing
  // to start is the only failure an operator can actually see.
  //
  // The store is built here rather than left to the refused call: it is created
  // before the check runs (it is a default parameter), so anything that keeps a
  // handle open has to be closed by the test.
  const refusedStore = createAccountStore({ dir: dataDir, keyFile, initialize: true });
  assert.throws(
    () => createCloudService({ ...options, store: refusedStore }),
    /TAILCHAT_CLOUD_TRUST_PROXY=1/,
  );
  await refusedStore.close();

  // A bind that is not loopback is not necessarily behind a proxy, so there the
  // flag stays optional.
  const direct = createCloudService({ ...options, host: '0.0.0.0' });
  await direct.close();

  // And the flag is what the environment supplies, exactly as pm2 supplies it.
  process.env.TAILCHAT_CLOUD_TRUST_PROXY = '1';
  const behindProxy = createCloudService(options);
  await behindProxy.close();
});

test('a websocket upgrade from another origin is refused', async (context) => {
  const { port } = await startService(context);

  const socket = new WebSocket(`ws://127.0.0.1:${port}/tailchat/ws`, {
    headers: { Origin: 'http://evil.example' },
  });
  const [error] = await once(socket, 'error');
  assert.match(error.message, /403/);

  const wrongPath = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const [pathError] = await once(wrongPath, 'error');
  assert.match(pathError.message, /403/);
});

test('a websocket without Origin is accepted but must authenticate first', async (context) => {
  const { port } = await startService(context, { authTimeoutMs: 150 });
  const client = await wsClient(port);

  client.send({ k: 'who' });
  const refused = await client.seen.waitFor('error');
  assert.equal(refused.code, 'auth_required');

  const closed = await client.closed();
  assert.equal(closed.code, 4401);
  assert.ok(client.seen.frames.some((frame) => frame.code === 'auth_failed'));
});

test('two authorised clients subscribed to each other exchange protocol frames', async (context) => {
  const { port } = await startService(context);
  const romanToken = await makeAccount(port, 'roman', 'Роман');
  const olgaToken = await makeAccount(port, 'olga', 'Ольга');

  const inviteRes = await request(port, 'POST', '/tailchat/api/invite', { token: romanToken });
  await request(port, 'POST', '/tailchat/api/invite/accept', { token: olgaToken, body: { invite: inviteRes.json.invite } });

  const roman = await wsClient(port);
  const olga = await wsClient(port);
  context.after(() => { roman.close(); olga.close(); });

  roman.send({ k: 'auth', token: romanToken });
  olga.send({ k: 'auth', token: olgaToken });
  const romanReady = await roman.seen.waitFor('ready');
  await olga.seen.waitFor('ready');
  assert.equal(romanReady.self.login, 'roman');

  roman.send({ k: 'subscribe', peer: 'olga' });
  olga.send({ k: 'subscribe', peer: 'roman' });
  const romanSubscribed = await roman.seen.waitFor('subscribed');
  await olga.seen.waitFor('subscribed');
  assert.equal(romanSubscribed.peer, 'olga');

  const sent = { t: 'msg', id: 'm-1', text: 'привет из облака', ts: 1_756_500_000_000 };
  roman.send({ k: 'frame', to: 'olga', d: sent });

  const delivered = await olga.seen.waitFor('frame');
  assert.equal(delivered.from, 'roman');
  // `ts` is the server's, not the sender's: a fixture timestamp from last year
  // is exactly the skew the hub refuses to propagate.
  assert.deepEqual(delivered.d, { ...sent, ts: delivered.d.ts });
  assert.equal(Math.abs(delivered.d.ts - Date.now()) < 60_000, true);

  const history = await request(port, 'GET', '/tailchat/api/history?peer=roman', { token: olgaToken });
  assert.equal(history.status, 200);
  assert.deepEqual(history.json.messages.map((message) => message.text), ['привет из облака']);
});

test('history hides tombstones by default and returns only blank markers on request', async (context) => {
  const { port, store } = await startService(context);
  const romanToken = await makeAccount(port, 'roman', 'Роман');
  const olgaToken = await makeAccount(port, 'olga', 'Ольга');
  const invite = await request(port, 'POST', '/tailchat/api/invite', { token: romanToken });
  await request(port, 'POST', '/tailchat/api/invite/accept', { token: olgaToken, body: { invite: invite.json.invite } });

  store.recordHistory('roman', 'olga', { id: 'gone', from: 'roman', text: 'secret', ts: 1_756_500_000_000 });
  assert.deepEqual(await store.deleteHistory('roman', 'olga', ['gone']), ['gone']);

  const hidden = await request(port, 'GET', '/tailchat/api/history?peer=roman', { token: olgaToken });
  assert.deepEqual(hidden.json.messages, []);
  const markers = await request(port, 'GET', '/tailchat/api/history?peer=roman&deleted=1', { token: olgaToken });
  assert.equal(markers.json.messages.length, 1);
  assert.equal(markers.json.messages[0].text, '');
  assert.ok(markers.json.messages[0].deletedAt);
});

test('a full-duration web voice payload reaches the subscribed peer', async (context) => {
  const { port } = await startService(context);
  const olgaToken = await makeAccount(port, 'olga', 'Ольга');
  const romanToken = await makeAccount(port, 'roman', 'Роман');
  const inviteRes = await request(port, 'POST', '/tailchat/api/invite', { token: olgaToken });
  await request(port, 'POST', '/tailchat/api/invite/accept', { token: romanToken, body: { invite: inviteRes.json.invite } });

  const olga = await wsClient(port);
  const roman = await wsClient(port);
  context.after(() => { olga.close(); roman.close(); });
  olga.send({ k: 'auth', token: olgaToken });
  roman.send({ k: 'auth', token: romanToken });
  await olga.seen.waitFor('ready');
  await roman.seen.waitFor('ready');
  olga.send({ k: 'subscribe', peer: 'roman' });
  roman.send({ k: 'subscribe', peer: 'olga' });
  await olga.seen.waitFor('subscribed');
  await roman.seen.waitFor('subscribed');

  // 64 kbit/s × 600 seconds is about 6.1 MiB after base64: inside the ten-MiB
  // retained-media limit, message envelope included.
  const dataUrl = `data:audio/webm;codecs=opus;base64,${'A'.repeat(6_400_000)}`;
  const sent = {
    t: 'msg',
    id: 'voice-1',
    text: '🎙 Голосовое сообщение (10:00)',
    ts: 1_756_500_000_000,
    voice: { dataUrl, duration: 600 },
  };
  olga.send({ k: 'frame', to: 'roman', d: sent });

  const delivered = await roman.seen.waitFor('frame');
  assert.equal(delivered.from, 'olga');
  assert.deepEqual(delivered.d, { ...sent, ts: delivered.d.ts });
  const history = await request(port, 'GET', '/tailchat/api/history?peer=olga', { token: romanToken });
  assert.deepEqual(history.json.messages[0].voice, sent.voice);
});

test('GET /users reports the presence state a connected friend last announced', async (context) => {
  const { port } = await startService(context);
  const romanToken = await makeAccount(port, 'roman', 'Роман');
  const olgaToken = await makeAccount(port, 'olga', 'Ольга');
  const inviteRes = await request(port, 'POST', '/tailchat/api/invite', { token: romanToken });
  await request(port, 'POST', '/tailchat/api/invite/accept', { token: olgaToken, body: { invite: inviteRes.json.invite } });

  const olga = await wsClient(port);
  context.after(() => olga.close());
  olga.send({ k: 'auth', token: olgaToken });
  await olga.seen.waitFor('ready');

  const connected = await request(port, 'GET', '/tailchat/api/users', { token: romanToken });
  assert.deepEqual(
    connected.json.users.filter((user) => !['tailchat', 'tailik'].includes(user.login))
      .map((user) => [user.login, user.online, user.state]),
    [['olga', true, 'active']],
  );

  olga.send({ k: 'state', state: 'away' });
  await olga.seen.waitFor('users');
  const idle = await request(port, 'GET', '/tailchat/api/users', { token: romanToken });
  assert.equal(idle.json.users.find((user) => user.login === 'olga').state, 'away');
});

test('binary websocket frames are refused with the unsupported-data code', async (context) => {
  const { port } = await startService(context);
  const client = await wsClient(port);

  client.socket.send(Buffer.from([1, 2, 3]));
  const closed = await client.closed();
  assert.equal(closed.code, 1003);
});

test('POST /tailchat/api/recover resets password and returns new recovery key', async (context) => {
  const { port } = await startService(context);
  const regRes = await request(port, 'POST', '/tailchat/api/register', {
    body: { login: 'roman', password: 'oldpassword', name: 'Роман' },
  });
  assert.equal(regRes.status, 201);
  assert.ok(regRes.json.recoveryKey);

  // Wrong recovery key
  const badRes = await request(port, 'POST', '/tailchat/api/recover', {
    body: { login: 'roman', recoveryKey: 'TC-0000-0000-0000-0000', newPassword: 'newpassword' },
  });
  assert.equal(badRes.status, 401);
  assert.equal(badRes.json.error, 'bad_recovery_key');

  // Correct recovery key
  const okRes = await request(port, 'POST', '/tailchat/api/recover', {
    body: { login: 'roman', recoveryKey: regRes.json.recoveryKey, newPassword: 'newpassword' },
  });
  assert.equal(okRes.status, 200);
  assert.ok(okRes.json.token);
  assert.ok(okRes.json.newRecoveryKey);

  // Login with new password
  const loginRes = await request(port, 'POST', '/tailchat/api/login', {
    body: { login: 'roman', password: 'newpassword' },
  });
  assert.equal(loginRes.status, 200);
});

test('push routes: key is public, subscribe/unsubscribe require auth and validate shape', async (context) => {
  const { port, store } = await startService(context);
  const registered = await request(port, 'POST', '/tailchat/api/register', {
    body: { login: 'roman', password: 'longenough', name: 'Роман' },
  });
  const token = registered.json.token;

  const key = await request(port, 'GET', '/tailchat/api/push/key');
  assert.equal(key.status, 200);
  assert.match(key.json.key, /^[A-Za-z0-9_-]+$/);

  const subscription = { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } };

  const anonymous = await request(port, 'POST', '/tailchat/api/push/subscribe', { body: { subscription } });
  assert.equal(anonymous.status, 401);

  const invalid = await request(port, 'POST', '/tailchat/api/push/subscribe', {
    token, body: { subscription: { endpoint: 'not-https' } },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error, 'invalid_subscription');

  // No claiming device: the subscription could never be renewed or replaced,
  // which is the state that left an uninstalled PWA notifying forever.
  const unclaimed = await request(port, 'POST', '/tailchat/api/push/subscribe', {
    token, body: { subscription },
  });
  assert.equal(unclaimed.status, 400);
  assert.equal(unclaimed.json.error, 'invalid_subscription');
  assert.equal(store.pushSubscriptions('roman').length, 0);

  const subscribed = await request(port, 'POST', '/tailchat/api/push/subscribe', {
    token, body: { subscription, deviceId: 'deviceaaaaaaaaaa' },
  });
  assert.equal(subscribed.status, 200);
  assert.equal(subscribed.json.ok, true);
  // The answer carries the key this device's service worker will use to repair a
  // rotated endpoint with no page open; it is minted per subscribe and rotated
  // on every use (see `/api/push/resubscribe`).
  assert.match(subscribed.json.repairKey, /^[0-9a-f]{64}$/);
  assert.equal(store.pushSubscriptions('roman').length, 1);

  const unauthUnsub = await request(port, 'POST', '/tailchat/api/push/unsubscribe', { body: { endpoint: subscription.endpoint } });
  assert.equal(unauthUnsub.status, 401);

  const unsubscribed = await request(port, 'POST', '/tailchat/api/push/unsubscribe', {
    token, body: { endpoint: subscription.endpoint },
  });
  assert.equal(unsubscribed.status, 200);
  assert.deepEqual(unsubscribed.json, { ok: true });
  assert.equal(store.pushSubscriptions('roman').length, 0);
});

// The worker-side half of endpoint rotation: the push service hands out a new
// endpoint at a moment when no page is open, so the only thing awake is the
// service worker and the only credential it holds is the repair key
// `/api/push/subscribe` gave it (`web/cloud/sw.js`). Own service rather than a
// splice into the test above: that one is about subscribe/unsubscribe, and its
// tail asserts the subscription it started with is gone.
test('push resubscribe: the key a device holds rotates its endpoint, once, and says nothing about other logins', async (context) => {
  const { port, store } = await startService(context);
  const registered = await request(port, 'POST', '/tailchat/api/register', {
    body: { login: 'roman', password: 'longenough', name: 'Роман' },
  });
  const token = registered.json.token;
  const deviceId = 'deviceaaaaaaaaaa';

  const subscribed = await request(port, 'POST', '/tailchat/api/push/subscribe', {
    token, body: { subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } }, deviceId },
  });
  const key = subscribed.json.repairKey;
  assert.match(key, /^[0-9a-f]{64}$/);

  const rotated = 'https://push.example/rotated';
  const repaired = await request(port, 'POST', '/tailchat/api/push/resubscribe', {
    body: {
      login: 'roman',
      deviceId,
      repairKey: key,
      subscription: { endpoint: rotated, keys: { p256dh: 'c', auth: 'd' } },
    },
  });
  assert.equal(repaired.status, 200);
  assert.match(repaired.json.repairKey, /^[0-9a-f]{64}$/, 'a fresh key comes back for the next rotation');
  assert.deepEqual(store.pushSubscriptions('roman').map((s) => s.endpoint), [rotated]);

  const resubscribe = (body) => request(port, 'POST', '/tailchat/api/push/resubscribe', { body });

  // Spent, so replaying it fails — and every way of failing that names somebody
  // gives the same answer, because the route takes no token and a difference
  // would say which logins have a device.
  const replay = await resubscribe({
    login: 'roman', deviceId, repairKey: key,
    subscription: { endpoint: 'https://push.example/replay', keys: { p256dh: 'e', auth: 'f' } },
  });
  assert.equal(replay.status, 403);
  assert.equal(replay.json.error, 'bad_repair_key');

  const stranger = await resubscribe({
    login: 'nobody', deviceId, repairKey: repaired.json.repairKey,
    subscription: { endpoint: 'https://push.example/stranger', keys: { p256dh: 'g', auth: 'h' } },
  });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.json.error, 'bad_repair_key', 'an unknown login is not told apart from a wrong key');

  const unknownDevice = await resubscribe({
    login: 'roman', deviceId: 'devicebbbbbbbbbbbb', repairKey: repaired.json.repairKey,
    subscription: { endpoint: 'https://push.example/elsewhere', keys: { p256dh: 'i', auth: 'j' } },
  });
  assert.equal(unknownDevice.status, 403);
  assert.equal(unknownDevice.json.error, 'bad_repair_key', 'nor is an unknown device');

  // A body that is not a subscription is the one distinct answer: it names
  // nobody and reveals nothing about accounts.
  const malformed = await resubscribe({
    login: 'roman', deviceId, repairKey: repaired.json.repairKey, subscription: { endpoint: 'not-https' },
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.error, 'invalid_subscription');
  assert.deepEqual(store.pushSubscriptions('roman').map((s) => s.endpoint), [rotated], 'none of the failures changed the store');
});

test('fcm routes: register/unregister require auth and validate shape', async (context) => {
  const { port, store } = await startService(context);
  const registered = await request(port, 'POST', '/tailchat/api/register', {
    body: { login: 'roman', password: 'longenough', name: 'Роман' },
  });
  const token = registered.json.token;

  const anonymous = await request(port, 'POST', '/tailchat/api/fcm/register', { body: { token: 'device-token' } });
  assert.equal(anonymous.status, 401);

  const invalid = await request(port, 'POST', '/tailchat/api/fcm/register', { token, body: { token: '' } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error, 'invalid_token');

  const scope = 'a'.repeat(64);
  const registered1 = await request(port, 'POST', '/tailchat/api/fcm/register', {
    token, body: { token: 'device-token', scope },
  });
  assert.equal(registered1.status, 200);
  assert.deepEqual(registered1.json, { ok: true });
  assert.deepEqual(store.fcmTokens('roman').map((entry) => entry.scope), [scope]);

  const unauthUnreg = await request(port, 'POST', '/tailchat/api/fcm/unregister', { body: { token: 'device-token' } });
  assert.equal(unauthUnreg.status, 401);

  const unregistered = await request(port, 'POST', '/tailchat/api/fcm/unregister', { token, body: { token: 'device-token' } });
  assert.equal(unregistered.status, 200);
  assert.deepEqual(unregistered.json, { ok: true });
  assert.equal(store.fcmTokens('roman').length, 0);
});

test('GET /.well-known/assetlinks.json is served at the domain root', async (context) => {
  const { port, webRoot } = await startService(context);
  fs.mkdirSync(path.join(webRoot, 'well-known'), { recursive: true });
  fs.writeFileSync(path.join(webRoot, 'well-known', 'assetlinks.json'), '[{"ok":true}]\n');

  const res = await request(port, 'GET', '/.well-known/assetlinks.json');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, [{ ok: true }]);
  assert.match(res.headers['content-type'], /application\/json/);
});

// Regression: `sw.js` fails its `install` event (and never activates) if any
// path in SHELL_ASSETS 404s, since `cache.addAll` rejects on the first bad
// response — which is exactly what silently broke push notifications before
// `/tailchat/index.html` was added to the route table.
test('every asset the service worker pre-caches on install is actually servable', async (context) => {
  const swSource = fs.readFileSync(new URL('../web/cloud/sw.js', import.meta.url), 'utf8');
  const match = swSource.match(/const SHELL_ASSETS = \[([\s\S]*?)\];/);
  assert.ok(match, 'SHELL_ASSETS not found in sw.js');
  const assets = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(assets.length > 0);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-cloud-shell-'));
  const keyFile = `${dataDir}.master-key`;
  fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const service = createCloudService({ host: '127.0.0.1', port: 0, dataDir, keyFile, initializeStore: true, trustProxy: true });
  const address = await service.listen();
  context.after(async () => {
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
  });

  for (const assetPath of assets) {
    const res = await request(address.port, 'GET', assetPath);
    assert.equal(res.status, 200, `${assetPath} should be servable (got ${res.status})`);
  }
});

test('/api/turn needs a session and offers TURN only with a secret', async (t) => {
  const plain = await startService(t, { turnConfig: { host: '203.0.113.5', port: 3478, secret: null } });
  assert.equal((await request(plain.port, 'GET', '/tailchat/api/turn')).status, 401);
  const token = await makeAccount(plain.port, 'roman', 'Роман');
  const stunOnly = await request(plain.port, 'GET', '/tailchat/api/turn', { token });
  assert.equal(stunOnly.status, 200);
  assert.deepEqual(stunOnly.json, { ttl: 600, iceServers: [{ urls: ['stun:203.0.113.5:3478'] }] });

  const secured = await startService(t, { turnConfig: { host: '203.0.113.5', port: 3478, secret: 's3cret' } });
  const token2 = await makeAccount(secured.port, 'roman', 'Роман');
  const before = Math.floor(Date.now() / 1000);
  const turn = await request(secured.port, 'GET', '/tailchat/api/turn', { token: token2 });
  assert.equal(turn.status, 200);
  const relay = turn.json.iceServers[1];
  assert.deepEqual(relay.urls, ['turn:203.0.113.5:3478?transport=udp', 'turn:203.0.113.5:3478?transport=tcp']);
  const match = /^(\d+):roman$/.exec(relay.username);
  assert.ok(match, relay.username);
  const expiry = Number(match[1]);
  assert.ok(expiry >= before + 600 && expiry <= before + 602);
  assert.equal(relay.credential, createHmac('sha1', 's3cret').update(relay.username).digest('base64'));
});

test('/api/turn without an operator host offers public STUN and no relay, even with a secret', async (t) => {
  const svc = await startService(t, { turnConfig: { host: null, port: 3478, secret: 's3cret' } });
  const token = await makeAccount(svc.port, 'roman', 'Роман');
  const res = await request(svc.port, 'GET', '/tailchat/api/turn', { token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, {
    ttl: 600,
    iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }],
  });
});

test('an invite for somebody else belongs to the owner, and it is that account that gets the friend', async (context) => {
  const { port } = await startService(context, { ownerLogin: 'boss' });
  const bossToken = await makeAccount(port, 'boss', 'Босс');
  const workerToken = await makeAccount(port, 'worker', 'Работник');
  const guestToken = await makeAccount(port, 'guest', 'Гость');

  // No argument, no change: the link is your own, as it has always been.
  const own = await request(port, 'POST', '/tailchat/api/invite', { token: workerToken });
  assert.equal(own.status, 201, own.text);
  assert.equal(own.json.invite.length, 64);

  // Somebody else's link is refused to everybody but the owner.
  const foreign = await request(port, 'POST', '/tailchat/api/invite', { token: workerToken, body: { login: 'boss' } });
  assert.equal(foreign.status, 403, foreign.text);
  assert.equal(foreign.json.error, 'forbidden');

  // The owner naming themselves is not a special case — it is the same as no
  // argument, and it must not go through the refusal above.
  const selfAsOwner = await request(port, 'POST', '/tailchat/api/invite', { token: bossToken, body: { login: 'boss' } });
  assert.equal(selfAsOwner.status, 201, selfAsOwner.text);

  // The link the owner mints belongs to the account they named, not to them:
  // whoever accepts it becomes friends with that account.
  const forWorker = await request(port, 'POST', '/tailchat/api/invite', { token: bossToken, body: { login: 'worker' } });
  assert.equal(forWorker.status, 201, forWorker.text);
  const accepted = await request(port, 'POST', '/tailchat/api/invite/accept', {
    token: guestToken,
    body: { invite: `https://example.org/tailchat/?invite=${forWorker.json.invite}` },
  });
  assert.equal(accepted.status, 200, accepted.text);
  assert.deepEqual(accepted.json, { friend: { login: 'worker', name: 'Работник' } });
  const guestRoster = await request(port, 'GET', '/tailchat/api/users', { token: guestToken });
  assert.deepEqual(
    guestRoster.json.users.map((user) => user.login).sort(),
    ['tailchat', 'tailik', 'worker'],
  );

  // The official contacts are in every roster already (AGENTS.md §9), so a link
  // to one is meaningless and refused.
  for (const login of ['tailchat', 'tailik']) {
    const official = await request(port, 'POST', '/tailchat/api/invite', { token: bossToken, body: { login } });
    assert.equal(official.status, 403, `${login}: ${official.text}`);
    assert.equal(official.json.error, 'official_invite');
  }

  // A typo is answered as a missing account rather than as a refusal — only the
  // owner can reach this answer at all, and it is the one that fixes the typo.
  const missing = await request(port, 'POST', '/tailchat/api/invite', { token: bossToken, body: { login: 'nobody-here' } });
  assert.equal(missing.status, 404, missing.text);
  assert.equal(missing.json.error, 'unknown_user');

  // A login that exists but is not even a friend is still mintable: the link is
  // what creates the friendship, so requiring one first would be circular.
  const stranger = await request(port, 'POST', '/tailchat/api/invite', { token: bossToken, body: { login: 'guest' } });
  assert.equal(stranger.status, 201, stranger.text);
});

test('without a configured owner, nobody can mint anybody else\'s invite', async (context) => {
  // `ownerLogin` is null here, which is what a deployment that never set
  // TAILCHAT_CLOUD_AI_OWNER looks like: the capability is off, not open.
  const { port } = await startService(context);
  const annaToken = await makeAccount(port, 'anna', 'Анна');
  const borisToken = await makeAccount(port, 'boris', 'Борис');

  const foreign = await request(port, 'POST', '/tailchat/api/invite', { token: borisToken, body: { login: 'anna' } });
  assert.equal(foreign.status, 403, foreign.text);
  assert.equal(foreign.json.error, 'forbidden');

  const own = await request(port, 'POST', '/tailchat/api/invite', { token: annaToken, body: { login: 'anna' } });
  assert.equal(own.status, 201, own.text);
});

// Two ticks of the heartbeat, and a poll that does not care which one did it.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, timeoutMs, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(stepMs);
  }
  return predicate();
}

/**
 * The deployment's worst case, at a scale a test can watch.
 *
 * A phone pushing one large frame — a voice note, a photo — up a slow uplink
 * cannot answer a ping until that frame is on the wire: WebSocket framing
 * forbids a control frame inside a data frame, and the client's pong therefore
 * queues behind the whole upload. Pausing this client's socket is that state
 * exactly — the ping is never read, so no pong is ever sent — while the frames
 * it is uploading keep arriving. Bytes still arriving are proof of a live peer,
 * and the heartbeat must not terminate it: doing so used to lose the frame, so
 * the message never landed (no ✓, «Cloud отключён», and the client re-uploaded
 * the whole thing on the next attempt).
 */
test('a socket that is still sending is not dropped for a missed pong', async (context) => {
  const { service, port } = await startService(context, { heartbeatMs: 200 });
  const token = await makeAccount(port, 'roman', 'Роман');
  const client = await wsClient(port);
  context.after(() => client.close());

  client.send({ k: 'auth', token });
  await client.seen.waitFor('ready');
  assert.equal(service.hub.isOnline('roman'), true);

  // Nothing this server pings can be read from here on: no pong, ever.
  client.socket.pause();

  // The upload continues, more often than the heartbeat runs.
  const upload = setInterval(() => client.send({ k: 'who' }), 50);
  context.after(() => clearInterval(upload));

  await delay(1_200); // six heartbeat windows

  assert.equal(
    service.hub.isOnline('roman'),
    true,
    'a peer that is still sending is alive, whatever its pong queue is doing',
  );
});

test('a socket that stops answering and stops sending is dropped', async (context) => {
  // `presenceGraceMs` is shortened for the same reason `heartbeatMs` is: the
  // rule is "the socket goes, and the departure is announced after the hold",
  // and both halves of it are worth watching at this scale rather than waiting
  // out production's five seconds.
  const { service, port } = await startService(context, { heartbeatMs: 200, presenceGraceMs: 200 });
  const token = await makeAccount(port, 'roman', 'Роман');
  const client = await wsClient(port);
  context.after(() => client.close());

  client.send({ k: 'auth', token });
  await client.seen.waitFor('ready');

  client.socket.pause();

  await waitUntil(() => service.hub.isOnline('roman') === false, 4_000);
  assert.equal(service.hub.isOnline('roman'), false, 'a peer that has gone quiet is dropped');
});

// The roster has two doors — the socket (`usersFor` in hub.js) and this HTTP
// list — and a flag that reaches only one of them is a client that believes
// something different about the same account.
test('the roster HTTP clients load marks a bot account as one', async (context) => {
  const { port, store } = await startService(context, {});
  const token = await makeAccount(port, 'roman', 'Роман');
  await store.register({ login: 'olga', password: 'longenough', name: 'Ольга' });
  await store.register({ login: 'reminder', password: 'longenough', name: 'reminder' });
  store.linkFriends('roman', 'olga');
  store.linkFriends('roman', 'reminder');
  assert.equal(store.markBot('reminder'), true);

  const users = await request(port, 'GET', '/tailchat/api/users', { token });
  assert.equal(users.status, 200);
  const entries = new Map(users.json.users.map((user) => [user.login, user]));
  assert.equal(entries.get('reminder').bot, true);
  assert.equal(entries.get('olga').bot, undefined, 'absent, not false, for a person');
  assert.equal(entries.get('tailchat').bot, undefined, 'the server accounts are official, which is another fact');
});
