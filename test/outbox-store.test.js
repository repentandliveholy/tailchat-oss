import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createPersistentOutbox, outboxFileFor, saveOutbox } from '../src/outbox-store.js';
import { createSecureStore } from '../src/secure-store.js';

const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-ob-'));
  return { file: path.join(dir, 'queue.json'), store: createSecureStore(crypto.randomBytes(32)) };
};

test('outbox filename cannot escape its directory', () => {
  assert.equal(path.dirname(outboxFileFor('/base', '../../etc/passwd')), '/base');
  assert.notEqual(outboxFileFor('/base', 'alice'), outboxFileFor('/base', 'bob'));
});

test('encrypted queue survives restart and only undelivered tail is replayed', () => {
  const { file, store } = fixture();
  const first = createPersistentOutbox({ file, store });
  first.add('first', 1, 'id-1');
  first.add('second', 2, 'id-2');
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(store.fileFor(file), 'utf8').includes('first'), false);
  const reopened = createPersistentOutbox({ file, store });
  reopened.flush((text) => text === 'first');
  assert.deepEqual(createPersistentOutbox({ file, store }).pending().map((row) => row.id), ['id-2']);
  reopened.flush(() => true);
  assert.deepEqual(createPersistentOutbox({ file, store }).pending(), []);
});

test('corrupt encrypted queue refuses startup without replacing any bytes', () => {
  const { file, store } = fixture();
  store.write(file, Buffer.from('{not-json'));
  const saved = fs.readFileSync(store.fileFor(file));
  assert.throws(() => createPersistentOutbox({ file, store }), /Corrupted encrypted outbox/);
  assert.deepEqual(fs.readFileSync(store.fileFor(file)), saved);
});

test('queue update failure reports without discarding the in-memory unsent message', () => {
  const { file, store } = fixture();
  const failures = [];
  const queue = createPersistentOutbox({
    file, store, save: () => ({ ok: false, code: 'ENOSPC' }),
    onPersistError: (failure) => failures.push(failure.code),
  });
  queue.add('unsent', 1, 'u');
  assert.deepEqual(queue.pending().map((row) => row.text), ['unsent']);
  assert.deepEqual(failures, ['ENOSPC']);
  assert.equal(fs.existsSync(store.fileFor(file)), false);
});

test('sharing violation retries a complete encrypted queue write', () => {
  const { file, store } = fixture();
  let attempts = 0;
  const result = saveOutbox(file, [{ text: 'private', ts: 1 }], {
    store: { write(target, data) {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      store.write(target, data);
    } },
    pause: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(store.fileFor(file), 'utf8').includes('private'), false);
});
