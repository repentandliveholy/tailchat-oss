// Adding a contact by `@username`, and the service account that carries the
// question.
//
// The rule these tests exist to hold: a request is *not* a friendship. Before
// this path, the only way into somebody's roster was an invite code — consent
// given in advance, out of band. `@username` removes the out-of-band step, so
// the consent has to move to the other end: a message in the recipient's own
// `{tailchat}` thread with two buttons, and nothing in the roster until one of
// them is pressed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAccountStore } from '../src/cloud/accounts.js';
import { createCloudHub } from '../src/cloud/hub.js';
import { createCloudService } from '../src/cloud/server.js';
import WebSocket from 'ws';
import { EventEmitter, once } from 'node:events';
import { createServiceBot } from '../src/cloud/service-bot.js';
import { issueBody, issueTitle } from '../src/cloud/github-issues.js';
import { SERVICE_LOGIN } from '../src/cloud/service-account.js';

function makeWebRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-friends-web-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>cloud</title>\n');
  fs.writeFileSync(path.join(dir, 'app.js'), 'window.tailchatCloud = true;\n');
  fs.writeFileSync(path.join(dir, 'app.css'), ':root{}\n');
  return dir;
}

// Same two helpers `cloud-server.test.js` uses: one socket, every frame it
// saw, and a wait keyed by frame kind.
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
      return this.waitForMatching((frame) => frame.k === kind, kind, timeoutMs);
    },
    /**
     * The first frame [matches] — for a test that expects *two* frames of one
     * kind and cannot say "the first one" and "the second one" apart by kind
     * alone, which is what `waitFor` answers with.
     */
    waitForMatching(matches, description, timeoutMs = 4000) {
      const found = frames.find(matches);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          emitter.off('frame', onFrame);
          reject(new Error(`timed out waiting for ${description}; saw ${JSON.stringify(frames)}`));
        }, timeoutMs);
        const onFrame = (frame) => {
          if (!matches(frame)) return;
          clearTimeout(timer);
          emitter.off('frame', onFrame);
          resolve(frame);
        };
        emitter.on('frame', onFrame);
      });
    },
  };
}

async function wsClient(port) {
  const seen = collector();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/tailchat/ws`);
  socket.on('message', (data) => seen.add(JSON.parse(data.toString('utf8'))));
  await once(socket, 'open');
  return {
    socket,
    seen,
    send(payload) { socket.send(JSON.stringify(payload)); },
    close() { socket.close(); },
  };
}

async function startService(context, { withServiceBot = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-friends-data-'));
  const keyFile = `${dataDir}.master-key`;
  fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const webRoot = makeWebRoot();
  const store = createAccountStore({ dir: dataDir, keyFile, initialize: true });
  // The bot needs the store this service was built on, so it is made here
  // rather than handed in — and left out entirely by default, because most of
  // these tests drive it directly and only one needs the hub to do it.
  const serviceBot = withServiceBot ? createServiceBot({ store }) : undefined;
  const hub = createCloudHub({ store, serviceBot });
  const service = createCloudService({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    webRoot,
    store,
    hub,
    trustProxy: false,
    ownerLogin: null,
    ...(serviceBot ? { serviceBot } : {}),
  });
  const address = await service.listen();
  context.after(async () => {
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(keyFile, { force: true });
    fs.rmSync(webRoot, { recursive: true, force: true });
  });
  return { service, store, hub, port: address.port };
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
    const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function makeAccount(port, login, name = login) {
  const response = await request(port, 'POST', '/tailchat/api/register', {
    body: { login, password: 'correct horse', name },
  });
  assert.equal(response.status, 201, response.text);
  return response.json.token;
}

/** What `{tailchat}` has actually said to [login]: the answers and questions
 *  this account earned. The menu registration writes into a thread nobody has
 *  spoken in yet is not one of them — it is the one record that is there
 *  before anybody says anything, and those tests are about what happened
 *  after. */
function serviceThread(store, login) {
  return store.history(SERVICE_LOGIN, login)
    .filter((record) => record.from === SERVICE_LOGIN && record.id !== 'service-menu-v1');
}

test('a request by @username asks rather than adds, and the question carries its own answers', async (context) => {
  const { port, store } = await startService(context);
  const romanToken = await makeAccount(port, 'roman', 'Roman');
  await makeAccount(port, 'olga', 'Olga');

  const response = await request(port, 'POST', '/tailchat/api/friend/request', {
    token: romanToken,
    // With the `@` a person actually types, and the case they see.
    body: { login: '@Olga' },
  });

  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json, { ok: true, state: 'requested' });
  assert.equal(store.areFriends('roman', 'olga'), false, 'asking is not adding');
  assert.deepEqual(store.friendRequests('olga').map((entry) => entry.from), ['roman']);

  const [question] = serviceThread(store, 'olga');
  assert.ok(question, 'the question has to reach the person who answers it');
  assert.match(question.text, /@roman/);
  assert.deepEqual(
    question.buttons.map((button) => button.value),
    ['/friend accept roman', '/friend decline roman'],
  );
  // Nothing is said to the asker: an unanswered request is not news.
  assert.deepEqual(serviceThread(store, 'roman'), []);
});

test('the accept button links both rosters and tells the asker', async (context) => {
  const { port, store } = await startService(context);
  const romanToken = await makeAccount(port, 'roman', 'Roman');
  await makeAccount(port, 'olga', 'Olga');
  await request(port, 'POST', '/tailchat/api/friend/request', { token: romanToken, body: { login: 'olga' } });

  const bot = createServiceBot({ store });
  const replies = await bot.handle({ from: 'olga', text: '/friend accept roman' });

  assert.equal(store.areFriends('roman', 'olga'), true);
  assert.deepEqual(store.friendRequests('olga'), []);
  assert.deepEqual(replies.map((reply) => reply.to), ['olga', 'roman']);
  assert.match(replies[1].text, /Olga|olga/, 'the asker is told who answered, not their own name');

  // A second press answers nothing — the question is gone with the first.
  const again = await bot.handle({ from: 'olga', text: '/friend accept roman' });
  assert.equal(again.length, 1);
  assert.match(again[0].text, /отвечена/);
});

test('a declined request leaves no friendship and says nothing to the asker', async (context) => {
  const { port, store } = await startService(context);
  const romanToken = await makeAccount(port, 'roman', 'Roman');
  await makeAccount(port, 'olga', 'Olga');
  await request(port, 'POST', '/tailchat/api/friend/request', { token: romanToken, body: { login: 'olga' } });

  const bot = createServiceBot({ store });
  const replies = await bot.handle({ from: 'olga', text: '/friend decline roman' });

  assert.equal(store.areFriends('roman', 'olga'), false);
  assert.deepEqual(store.friendRequests('olga'), []);
  assert.deepEqual(replies.map((reply) => reply.to), ['olga'], 'a refusal is not a message somebody receives');
});

test('two people who both asked are friends without a button', async (context) => {
  const { port, store } = await startService(context);
  const romanToken = await makeAccount(port, 'roman', 'Roman');
  const olgaToken = await makeAccount(port, 'olga', 'Olga');

  await request(port, 'POST', '/tailchat/api/friend/request', { token: romanToken, body: { login: 'olga' } });
  const second = await request(port, 'POST', '/tailchat/api/friend/request', { token: olgaToken, body: { login: 'roman' } });

  assert.equal(second.status, 200, second.text);
  assert.equal(second.json.state, 'friends');
  assert.equal(second.json.friend.login, 'roman');
  assert.equal(store.areFriends('roman', 'olga'), true);
  assert.deepEqual(store.friendRequests('olga'), [], 'the answered question is gone');
});

test('a request to somebody who blocked you is indistinguishable from one that landed', async (context) => {
  const { port, store } = await startService(context);
  const romanToken = await makeAccount(port, 'roman', 'Roman');
  const olgaToken = await makeAccount(port, 'olga', 'Olga');
  // Blocking needs an existing contact, so the pair is linked first; the
  // request below is the deleted-and-blocked case, which a stranger must not
  // be able to tell from a fresh one.
  store.linkFriends('roman', 'olga');
  await request(port, 'POST', '/tailchat/api/block', { token: olgaToken, body: { login: 'roman' } });
  await store.removeContact('roman', 'olga');

  const response = await request(port, 'POST', '/tailchat/api/friend/request', {
    token: romanToken, body: { login: 'olga' },
  });

  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.ok, true);
});

test('the service and AI accounts are not somebody you ask to be friends', async (context) => {
  const { port } = await startService(context);
  const token = await makeAccount(port, 'roman', 'Roman');

  const service = await request(port, 'POST', '/tailchat/api/friend/request', { token, body: { login: 'tailchat' } });
  const ai = await request(port, 'POST', '/tailchat/api/friend/request', { token, body: { login: '@tailik' } });

  assert.equal(service.status, 403);
  assert.equal(service.json.error, 'official_request');
  assert.equal(ai.status, 403);
});

test('an unknown login and your own login are told apart', async (context) => {
  const { port } = await startService(context);
  const token = await makeAccount(port, 'roman', 'Roman');

  const missing = await request(port, 'POST', '/tailchat/api/friend/request', { token, body: { login: 'nobody' } });
  const self = await request(port, 'POST', '/tailchat/api/friend/request', { token, body: { login: 'roman' } });

  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'unknown_user');
  assert.equal(self.status, 400);
  assert.equal(self.json.error, 'self_request');
});

test('asking for a contact you deleted yourself restores it instead of asking them again', async (context) => {
  const { port, store } = await startService(context);
  const romanToken = await makeAccount(port, 'roman', 'Roman');
  await makeAccount(port, 'olga', 'Olga');
  store.linkFriends('roman', 'olga');
  await store.removeContact('roman', 'olga');
  assert.equal(store.isRemoved('roman', 'olga'), true);

  const response = await request(port, 'POST', '/tailchat/api/friend/request', {
    token: romanToken, body: { login: 'olga' },
  });

  assert.equal(response.json.state, 'friends');
  assert.equal(store.isRemoved('roman', 'olga'), false);
  assert.deepEqual(serviceThread(store, 'olga'), [], 'the other side was never asked anything');
});

test('a bug report reaches the tracker and comes back with its own link', async (context) => {
  const { port, store } = await startService(context);
  await makeAccount(port, 'roman', 'Roman');
  const filed = [];
  const bot = createServiceBot({
    store,
    issues: {
      async report(payload) {
        filed.push(payload);
        return { url: 'https://github.com/repentandliveholy/tailchat-oss/issues/42', number: 42 };
      },
    },
  });

  const prompt = await bot.handle({ from: 'roman', text: '/bug' });
  assert.equal(filed.length, 0, 'the button only asks; the description is the report');
  assert.match(prompt[0].text, /Опишите/);

  const done = await bot.handle({ from: 'roman', text: 'Звонок падает, когда сворачиваешь приложение' });
  assert.equal(filed.length, 1);
  assert.equal(filed[0].login, 'roman');
  assert.match(done[0].text, /issues\/42/);

  // Same text, filed shape: the title is the first line, the body keeps who
  // reported it.
  assert.equal(issueTitle(filed[0].text), 'Звонок падает, когда сворачиваешь приложение');
  assert.match(issueBody({ text: filed[0].text, login: 'roman', at: 0 }), /@roman/);
});

test('a report with no tracker configured is passed to the owner rather than dropped', async (context) => {
  const { port, store } = await startService(context);
  await makeAccount(port, 'roman', 'Roman');
  await makeAccount(port, 'owner', 'Owner');
  const bot = createServiceBot({ store, ownerLogin: 'owner' });

  await bot.handle({ from: 'roman', text: '/bug' });
  const replies = await bot.handle({ from: 'roman', text: 'Не приходит пуш на втором устройстве' });

  assert.deepEqual(replies.map((reply) => reply.to), ['roman', 'owner']);
  assert.match(replies[1].text, /@roman/);
  assert.match(replies[1].text, /пуш/);
});

test('the fourth report in an hour is refused, and the third still lands', async (context) => {
  const { port, store } = await startService(context);
  await makeAccount(port, 'roman', 'Roman');
  let filed = 0;
  const bot = createServiceBot({
    store,
    issues: { async report() { filed += 1; return { url: 'https://example.invalid/1', number: 1 }; } },
  });

  for (let i = 0; i < 3; i += 1) {
    await bot.handle({ from: 'roman', text: `/bug описание номер ${i} с подробностями` });
  }
  const refused = await bot.handle({ from: 'roman', text: '/bug ещё одно описание с подробностями' });

  assert.equal(filed, 3);
  assert.match(refused[0].text, /через час/);
});

test('an unknown message to the service account answers with what it can do', async (context) => {
  const { port, store } = await startService(context);
  await makeAccount(port, 'roman', 'Roman');
  const bot = createServiceBot({ store });

  const [menu] = await bot.handle({ from: 'roman', text: 'привет' });

  assert.equal(menu.to, 'roman');
  assert.deepEqual(menu.buttons.map((button) => button.value), ['/help', '/bug', '/friend']);
  // AGENTS.md §10: one group, one style — no row carries decoration its
  // siblings lack.
  assert.ok(menu.buttons.every((button) => !/\p{Extended_Pictographic}/u.test(button.label)));
});

test('the welcome is the menu itself, under one fixed id', async (context) => {
  const { store } = await startService(context);
  await store.register({ login: 'roman', password: 'correct horse', name: 'Roman' });
  const bot = createServiceBot({ store });

  const [menu] = bot.welcome('roman');

  assert.equal(menu.to, 'roman');
  // Fixed, so a second delivery of the same menu is the same record in the
  // conversation rather than another one beside it.
  assert.equal(menu.id, 'service-menu-v1');
  // The menu's own sentence, not the help body `/help` answers with.
  assert.match(menu.text, /Служебный аккаунт|service account/);
  assert.deepEqual(menu.buttons.map((button) => button.value), ['/help', '/bug', '/friend']);
  // AGENTS.md §10: one group, one style — no row carries decoration its
  // siblings lack.
  assert.ok(menu.buttons.every((button) => !/\p{Extended_Pictographic}/u.test(button.label)));

  assert.deepEqual(bot.welcome(''), []);
  assert.deepEqual(bot.welcome('@'), []);
});

test('registration writes the menu into {tailchat} once, and nothing else', async (context) => {
  const { port, store } = await startService(context, { withServiceBot: true });
  const token = await makeAccount(port, 'roman', 'Roman');

  // The account that has a menu to offer is no longer a blank screen with
  // nothing to press — and it is the menu, not a release note.
  const written = () => store.history(SERVICE_LOGIN, 'roman')
    .filter((record) => record.from === SERVICE_LOGIN)
    .map((record) => record.id);
  assert.deepEqual(written(), ['service-menu-v1']);

  const history = await request(port, 'GET', '/tailchat/api/history?peer=tailchat', { token });
  assert.equal(history.status, 200);
  assert.deepEqual(history.json.messages.map((message) => message.id), ['service-menu-v1']);
  assert.deepEqual(
    history.json.messages[0].buttons.map((button) => button.value),
    ['/help', '/bug', '/friend'],
  );

  // A retried registration is refused by the store, and the thread it already
  // has is not written to a second time.
  const again = await request(port, 'POST', '/tailchat/api/register', {
    body: { login: 'roman', password: 'correct horse', name: 'Roman' },
  });
  assert.equal(again.status, 409, again.text);
  assert.deepEqual(written(), ['service-menu-v1']);
});

test('a message to {tailchat} over the socket is answered by the service account itself', async (context) => {
  const { port } = await startService(context, { withServiceBot: true });
  const token = await makeAccount(port, 'roman', 'Roman');
  const client = await wsClient(port);
  context.after(() => client.close());

  client.send({ k: 'auth', token });
  await client.seen.waitFor('ready');
  client.send({ k: 'subscribe', peer: SERVICE_LOGIN });
  await client.seen.waitFor('subscribed');

  // Registration already wrote the menu into this thread, so subscribing
  // drains it before anything is asked: that record is the first frame here,
  // and the proof the queue carried the welcome to a client that was not
  // connected when it was written.
  const welcome = await client.seen.waitFor('frame');
  assert.equal(welcome.from, SERVICE_LOGIN);
  assert.equal(welcome.d.id, 'service-menu-v1');

  client.send({ k: 'frame', to: SERVICE_LOGIN, d: { t: 'msg', id: 'm-1', text: '/help', ts: 1_756_500_000_000 } });

  // The hook is the whole point of this test: `handle` is proven elsewhere,
  // but nothing else proves the hub actually calls it for a message addressed
  // to the service account — and a bot nobody invokes answers nothing.
  const answer = await client.seen.waitForMatching(
    (frame) => frame.k === 'frame' && frame.from === SERVICE_LOGIN && frame.d?.id !== welcome.d.id,
    'the answer to /help',
  );
  assert.equal(answer.from, SERVICE_LOGIN);
  assert.match(answer.d.text, /Добавить друга|Add a friend/);
  assert.deepEqual(answer.d.buttons.map((button) => button.value), ['/help', '/bug', '/friend']);
});
