import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudApiError, createCloudApi } from '../src/cloud/api.js';

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});

function recorder(payload, status = 200) {
  const seen = [];
  const api = createCloudApi({
    server: 'https://cloud.example',
    token: 'token',
    fetchImpl: async (url, options) => {
      seen.push({ url, method: options.method, body: options.body, headers: options.headers });
      return jsonResponse(payload, status);
    },
  });
  return { api, seen };
}

test('setAlias posts the contact and the typed nickname, and returns the stored one', async () => {
  const { api, seen } = recorder({ login: 'roman@example.com', alias: 'Ромыч' });

  assert.equal(await api.setAlias('roman@example.com', 'Ромыч'), 'Ромыч');
  assert.equal(seen[0].method, 'POST');
  assert.match(seen[0].url, /\/tailchat\/api\/alias$/);
  assert.equal(seen[0].body, JSON.stringify({ login: 'roman@example.com', name: 'Ромыч' }));
  assert.equal(seen[0].headers.authorization, 'Bearer token');
});

test('an empty name clears the nickname and the server answer says so', async () => {
  const { api, seen } = recorder({ login: 'roman@example.com', alias: '' });

  assert.equal(await api.setAlias('roman@example.com', ''), '');
  assert.equal(seen[0].body, JSON.stringify({ login: 'roman@example.com', name: '' }));
});

test('a nickname is sent exactly as typed — the server does the normalising', async () => {
  const { api, seen } = recorder({ login: 'roman@example.com', alias: '🔥 Ромыч 🔥' });

  await api.setAlias('roman@example.com', '🔥 Ромыч 🔥');
  assert.equal(seen[0].body, JSON.stringify({ login: 'roman@example.com', name: '🔥 Ромыч 🔥' }));
});

test('a refused nickname reaches the caller as its server code and status', async () => {
  const { api } = recorder({ error: 'invalid_alias' }, 400);

  await assert.rejects(
    () => api.setAlias('roman@example.com', '\n\n'),
    (error) => {
      assert.ok(error instanceof CloudApiError);
      assert.equal(error.code, 'invalid_alias');
      assert.equal(error.status, 400);
      return true;
    },
  );
});

test('a missing alias in the answer reads as cleared', async () => {
  const { api } = recorder({ login: 'roman@example.com' });
  assert.equal(await api.setAlias('roman@example.com', 'x'), '');
});

test('history leaves out an edit\'s carrier: it is the server\'s envelope for an edit, never a message', async () => {
  const { api } = recorder({
    messages: [
      { id: 'm-1', text: 'hello' },
      { id: 'e-1', text: '🔒 stub', sealedEdit: true },
      { id: 'm-2', text: 'again', sealedEdit: false },
    ],
  });
  assert.deepEqual((await api.history('bob')).map((message) => message.id), ['m-1', 'm-2']);
});
