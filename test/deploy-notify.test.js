import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_ENV,
  ENV_FILE,
  TOKEN_ENV,
  deployStatusMessage,
  loadDeployEnv,
  notifyDeploy,
} from '../src/deploy-notify.js';

const configured = { [TOKEN_ENV]: '123:abc', [CHAT_ENV]: '-1001' };

function recordingFetch(response = { ok: true, status: 200 }) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return response;
    },
  };
}

test('a successful deploy reports the commit and the apps it restarted', () => {
  const text = deployStatusMessage({
    ok: true,
    version: '1.12',
    commit: 'abcdef0123456789',
    apps: ['tailchat-cloud', 'tailchat-gateway'],
    host: 'ovh',
  });
  assert.match(text, /^✅ Tailchat deploy ok — v1\.12$/m);
  assert.match(text, /^commit: abcdef012345$/m);
  assert.match(text, /^restarted: tailchat-cloud, tailchat-gateway$/m);
});

test('a failed deploy reports the reason and whether the rollback held', () => {
  const failed = deployStatusMessage({
    ok: false,
    version: '1.12',
    commit: '',
    reason: 'npm ci failed',
    rollback: { ok: true, commit: 'fedcba9876543210' },
    host: 'ovh',
  });
  assert.match(failed, /^❌ Tailchat deploy FAILED — v1\.12$/m);
  assert.match(failed, /^reason: npm ci failed$/m);
  assert.match(failed, /^rolled back to fedcba987654$/m);

  const stuck = deployStatusMessage({
    ok: false,
    version: '1.12',
    reason: 'reset failed',
    rollback: { ok: false, commit: 'fedcba9876543210', reason: 'detached head' },
  });
  assert.match(stuck, /^ROLLBACK FAILED at fedcba987654: detached head$/m);
  assert.doesNotMatch(stuck, /restarted:/);
});

test('nothing is sent, and nothing throws, when no channel is configured', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const result = await notifyDeploy({ ok: true }, { env: {}, fetchImpl });
  assert.deepEqual(result, { sent: false, reason: 'not configured' });
  assert.equal(calls.length, 0);
});

test('a configured channel receives the report as plain text on the bot token', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const result = await notifyDeploy({ ok: true, version: '1.12', apps: [] }, { env: configured, fetchImpl });
  assert.deepEqual(result, { sent: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telegram.org/bot123:abc/sendMessage');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].body.chat_id, '-1001');
  assert.match(calls[0].body.text, /Tailchat deploy ok/);
  // No parse_mode: a rollback reason may contain anything at all.
  assert.equal(calls[0].body.parse_mode, undefined);
});

test('a failure is announced loudly while a routine success stays silent', async () => {
  const ok = recordingFetch();
  await notifyDeploy({ ok: true }, { env: configured, fetchImpl: ok.fetchImpl });
  assert.equal(ok.calls[0].body.disable_notification, true);

  const bad = recordingFetch();
  await notifyDeploy({ ok: false, reason: 'boom' }, { env: configured, fetchImpl: bad.fetchImpl });
  assert.equal(bad.calls[0].body.disable_notification, false);
});

test('a telegram outage is reported back, never thrown at the deploy', async () => {
  const rejected = await notifyDeploy({ ok: true }, {
    env: configured,
    fetchImpl: async () => ({ ok: false, status: 502 }),
  });
  assert.deepEqual(rejected, { sent: false, reason: 'telegram http 502' });

  const exploded = await notifyDeploy({ ok: true }, {
    env: configured,
    fetchImpl: async () => { throw new Error('ENETUNREACH'); },
  });
  assert.deepEqual(exploded, { sent: false, reason: 'ENETUNREACH' });
});

test('a hung telegram request gives up instead of holding the deploy open', async () => {
  const started = Date.now();
  const result = await notifyDeploy({ ok: true }, {
    env: configured,
    timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }),
  });
  assert.deepEqual(result, { sent: false, reason: 'timeout' });
  assert.ok(Date.now() - started < 2000);
});

test('the checkout .env supplies the channel a deploy over ssh has no other way to learn', () => {
  const files = new Map([['/repo/' + ENV_FILE, `export ${TOKEN_ENV}="123:abc"\n# comment\n${CHAT_ENV}=289081163\n`]]);
  const readFile = (file) => {
    if (!files.has(file)) throw new Error('ENOENT');
    return files.get(file);
  };

  const env = {};
  assert.deepEqual(loadDeployEnv({ root: '/repo', env, readFile }).loaded, [TOKEN_ENV, CHAT_ENV]);
  assert.equal(env[TOKEN_ENV], '123:abc');
  assert.equal(env[CHAT_ENV], '289081163');

  // An explicit value on the command line outranks the file.
  const exported = { [CHAT_ENV]: '-1009999' };
  assert.deepEqual(loadDeployEnv({ root: '/repo', env: exported, readFile }).loaded, [TOKEN_ENV]);
  assert.equal(exported[CHAT_ENV], '-1009999');

  // Only the two channel names are read: the file cannot smuggle anything else
  // into a deploy's environment.
  files.set('/repo/' + ENV_FILE, `PATH=/tmp/evil\n${TOKEN_ENV}=123:abc\n`);
  const guarded = {};
  loadDeployEnv({ root: '/repo', env: guarded, readFile });
  assert.deepEqual(Object.keys(guarded), [TOKEN_ENV]);

  // A machine that never deploys has no such file, and that is not an error.
  assert.deepEqual(loadDeployEnv({ root: '/nowhere', env: {}, readFile }).loaded, []);
});
