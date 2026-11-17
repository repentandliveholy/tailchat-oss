import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSecureStore } from '../src/secure-store.js';
import {
  createSharedHistory, resolveSharedHistory, sharedHistoryStateFile,
} from '../src/shared-history.js';

function stateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-history-'));
}
const store = createSecureStore(crypto.randomBytes(32));

const config = {
  sharedHistory: { url: 'http://100.64.0.1:4748', room: 'roman-tailik-2026' },
};
const message = { id: 'm-1', name: 'Roman', text: 'привет', ts: 100, kind: 'human' };

function response(body, ok = true) {
  return { ok, json: async () => body };
}

test('shared history is opt-in and only accepts a bounded HTTP room setting', () => {
  assert.equal(resolveSharedHistory({}), null);
  assert.equal(resolveSharedHistory({ sharedHistory: { url: 'file:///tmp', room: 'roman-tailik-2026' } }), null);
  assert.equal(resolveSharedHistory({ sharedHistory: { url: 'https://history.example', room: 'short' } }), null);
  assert.deepEqual(resolveSharedHistory(config), config.sharedHistory);
  assert.match(sharedHistoryStateFile('/state', '../../hostile-room'), /^\/state\/shared-history-[a-f0-9]{16}\.json$/);
});

test('a local message is durably queued then uploaded without blocking the caller', async () => {
  const calls = [];
  const sync = createSharedHistory(config, stateDir(), {
    store,
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return response({ ok: true });
    },
  });

  assert.equal(sync.record(message), true);
  await sync.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'http://100.64.0.1:4748/v1/history/messages');
  assert.deepEqual(JSON.parse(calls[0][1].body), { room: 'roman-tailik-2026', message });
  assert.equal(fs.statSync(store.fileFor(sync.file)).mode & 0o777, 0o600);
});

test('restore returns only unseen records and clears a queue already stored remotely', async () => {
  const sync = createSharedHistory(config, stateDir(), {
    store,
    fetchImpl: async (url) => {
      if (url.includes('?')) return response({ messages: [message, { ...message, id: 'm-2', text: 'второе' }] });
      return response({ ok: true });
    },
  });

  sync.record(message);
  const restored = await sync.restore();
  assert.deepEqual(restored, [{ ...message, id: 'm-2', text: 'второе' }]);
  assert.equal(sync.has('m-1'), true);
  assert.equal(sync.has('m-2'), true);
  await sync.flush();
});

test('a history outage preserves the local queue for a later restart', async () => {
  const dir = stateDir();
  const sync = createSharedHistory(config, dir, { store, fetchImpl: async () => { throw new Error('offline'); } });
  sync.record(message);
  await sync.flush();

  const reopened = createSharedHistory(config, dir, { store, fetchImpl: async () => response({ ok: true }) });
  await reopened.flush();
  const state = JSON.parse(store.read(reopened.file).toString('utf8'));
  assert.deepEqual(state.pending, []);
});
