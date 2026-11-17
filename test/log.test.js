import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createSecureStore } from '../src/secure-store.js';
import { createLog, readLogTail, resolveLogFile, defaultLogPath } from '../src/log.js';

const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-log-'));
  return { file: path.join(dir, 'chat.log'), store: createSecureStore(crypto.randomBytes(32)) };
};

test('no-log writes no file even when secure storage is unavailable', () => {
  const log = createLog(null);
  assert.equal(log.append('nothing'), false);
  assert.deepEqual(readLogTail(null), []);
});

test('encrypted transcript appends across restarts and preserves multiline messages', async () => {
  const { file, store } = fixture();
  const first = createLog(file, { store });
  first.append('[12:00] peer: first\ncontinuation');
  await new Promise((done) => first.close(done));
  const reopened = createLog(file, { store });
  reopened.append('[12:01] me: next');
  await new Promise((done) => reopened.close(done));
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(store.fileFor(file), 'utf8').includes('continuation'), false);
  assert.deepEqual(readLogTail(file, 2, store), ['continuation', '[12:01] me: next']);
  assert.equal(fs.statSync(store.fileFor(file)).mode & 0o777, 0o600);
});

test('wrong key or malformed transcript fails closed rather than showing empty history', async () => {
  const { file, store } = fixture();
  const log = createLog(file, { store });
  log.append('irreplaceable P2P history');
  await new Promise((done) => log.close(done));
  assert.throws(() => readLogTail(file, 20, createSecureStore(crypto.randomBytes(32))), /authentication failed/);
  fs.appendFileSync(store.fileFor(file), 'not-base64\n');
  assert.throws(() => readLogTail(file, 20, store), /Corrupted encrypted transcript/);
});

test('explicit log path wins; no-log suppresses default transcript', () => {
  const selected = resolveLogFile({ logFlag: '/tmp/custom.log', stateDir: '/state', peerKey: 'peer' });
  assert.equal(selected, '/tmp/custom.log');
  assert.equal(resolveLogFile({ noLogFlag: true, stateDir: '/state', peerKey: 'peer' }), null);
  assert.equal(resolveLogFile({ stateDir: '/state', peerKey: 'peer' }), defaultLogPath('/state', 'peer'));
});

test('backpressure counts dropped lines and encrypts the gap notice', () => {
  const { file, store } = fixture();
  const stream = new EventEmitter();
  stream.chunks = [];
  stream.accepts = false;
  stream.write = (chunk) => { stream.chunks.push(chunk); return stream.accepts; };
  stream.end = (cb) => cb?.();
  const log = createLog(file, { store, openStream: () => stream });
  assert.equal(log.append('first'), true);
  assert.equal(log.append('dropped'), false);
  stream.accepts = true;
  stream.emit('drain');
  const chunks = stream.chunks.map((line) => store.unseal(Buffer.from(line.trim(), 'base64'), file).toString('utf8'));
  assert.deepEqual(chunks, ['first\n', '[transcript: 1 line dropped, the disk could not keep up]\n']);
});

test('readLogTail caches decrypted lines and only unseals new appended entries', async () => {
  const { file, store } = fixture();
  let unsealCount = 0;
  const originalUnseal = store.unseal;
  store.unseal = (bytes, targetFile) => {
    unsealCount += 1;
    return originalUnseal(bytes, targetFile);
  };
  const log = createLog(file, { store });
  log.append('line 1');
  log.append('line 2');
  await new Promise((done) => log.close(done));

  // First readLogTail: unseals 2 lines
  unsealCount = 0;
  const first = readLogTail(file, 20, store);
  assert.deepEqual(first, ['line 1', 'line 2']);
  assert.equal(unsealCount, 2);

  // Second readLogTail without changes: cache hit, 0 unseals!
  unsealCount = 0;
  const second = readLogTail(file, 20, store);
  assert.deepEqual(second, ['line 1', 'line 2']);
  assert.equal(unsealCount, 0);

  // Reopen log with createLog: file is already verified for this store, 0 unseals!
  unsealCount = 0;
  const reopened = createLog(file, { store });
  assert.equal(unsealCount, 0);

  // Append new line: only the new line is unsealed on subsequent read!
  reopened.append('line 3');
  await new Promise((done) => reopened.close(done));
  unsealCount = 0;
  const third = readLogTail(file, 20, store);
  assert.deepEqual(third, ['line 1', 'line 2', 'line 3']);
  assert.equal(unsealCount, 1);
});

test('readLogTail falls back to full re-read if existing file is replaced with a different transcript', async () => {
  const { file, store } = fixture();
  const log1 = createLog(file, { store });
  log1.append('old 1');
  log1.append('old 2');
  await new Promise((done) => log1.close(done));

  const firstRead = readLogTail(file, 20, store);
  assert.deepEqual(firstRead, ['old 1', 'old 2']);

  // Overwrite the file with completely different content having more entries
  const replacementLog = createLog(file, {
    store,
    openStream: (target) => fs.createWriteStream(target, { flags: 'w', mode: 0o600 }),
  });
  replacementLog.append('new 1');
  replacementLog.append('new 2');
  replacementLog.append('new 3');
  await new Promise((done) => replacementLog.close(done));

  // Prefix check fails (old 2 !== new 2), so readLogTail must NOT concatenate 'old' with 'new'
  const secondRead = readLogTail(file, 20, store);
  assert.deepEqual(secondRead, ['new 1', 'new 2', 'new 3']);
});
