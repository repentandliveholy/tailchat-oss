import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccountStore } from '../src/cloud/accounts.js';
import { createJournal } from '../src/cloud/journal.js';
import { migrateCloudStorage, initCloudStorage } from '../src/cloud/migrate-storage.js';
import { createCloudCipher, readCloudSidecar } from '../src/cloud/storage-crypto.js';
import { loadOrCreateVapidKeys } from '../src/cloud/push.js';
import { loadFcmServiceAccount } from '../src/cloud/fcm.js';
import { loadTurnConfig } from '../src/cloud/server.js';
import { createGithubIssues } from '../src/cloud/github-issues.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-encrypted-cloud-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'plain');
  const target = path.join(root, 'encrypted');
  const keyFile = path.join(root, 'master.key');
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  return { root, source, target, keyFile };
}

async function legacyHistory({ source }) {
  const old = createAccountStore({ dir: source, keyFile: null, allowPlaintextLegacy: true, writeDelayMs: 60_000 });
  await old.register({ login: 'anna', password: 'secret' });
  await old.register({ login: 'boris', password: 'secret' });
  await old.close();
  const checkpoint = fs.readFileSync(path.join(source, 'accounts.json'));
  const writer = createAccountStore({ dir: source, keyFile: null, allowPlaintextLegacy: true, writeDelayMs: 60_000 });
  const image = { dataUrl: 'data:image/png;base64,QUJDRA==', width: 2, height: 2 };
  await writer.commitHistory('anna', 'boris', { id: 'original', from: 'anna', text: 'secret message', image });
  const journal = fs.readFileSync(path.join(source, 'accounts.journal'));
  await writer.close();
  fs.writeFileSync(path.join(source, 'accounts.json'), checkpoint);
  fs.writeFileSync(path.join(source, 'accounts.journal'), journal);
  fs.writeFileSync(path.join(source, 'vapid_key.json'), JSON.stringify({ publicKey: 'public-test', privateKey: 'private-test' }));
  return image;
}

function alter(file) {
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  envelope.ciphertext = Buffer.from('tampered data').toString('base64');
  fs.writeFileSync(file, JSON.stringify(envelope));
}

test('offline migration preserves acknowledged journal records and inline media without touching plaintext', async (t) => {
  const f = fixture(t);
  const image = await legacyHistory(f);
  const sourceSnapshot = fs.readFileSync(path.join(f.source, 'accounts.json'));
  const sourceJournal = fs.readFileSync(path.join(f.source, 'accounts.journal'));
  fs.writeFileSync(path.join(f.source, 'turn_secret'), 'turn-credential\n');
  fs.writeFileSync(path.join(f.source, 'github_token'), 'github-credential\n');
  fs.writeFileSync(path.join(f.source, 'fcm_service_account.json'), JSON.stringify({ project_id: 'sample', private_key: 'test-private-key' }));
  const report = migrateCloudStorage(f);
  assert.equal(report.files.length, 7);
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'accounts.json')), sourceSnapshot);
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'accounts.journal')), sourceJournal);
  for (const name of ['accounts.json', 'accounts.journal', 'server_key.json', 'vapid_key.json', 'fcm_service_account.json', 'turn_secret', 'github_token']) {
    assert.equal(fs.readFileSync(path.join(f.target, name), 'utf8').includes('secret message'), false, name);
  }
  const store = createAccountStore({ dir: f.target, keyFile: f.keyFile, writeDelayMs: 60_000 });
  assert.equal(store.history('boris', 'anna')[0].image.dataUrl, image.dataUrl);
  assert.equal((await store.login({ login: 'anna', password: 'secret' })).ok, true);
  assert.deepEqual(loadOrCreateVapidKeys(f.target, store.storageCipher), { publicKey: 'public-test', privateKey: 'private-test' });
  assert.equal(loadFcmServiceAccount(f.target, store.storageCipher).project_id, 'sample');
  assert.equal(loadTurnConfig(f.target, store.storageCipher).secret, 'turn-credential');
  assert.ok(createGithubIssues({ dataDir: f.target, cipher: store.storageCipher, repo: 'owner/reports' }));
  assert.equal(readCloudSidecar(f.target, 'github_token', store.storageCipher), 'github-credential\n');
  await store.close();
  const reopened = createAccountStore({ dir: f.target, keyFile: f.keyFile });
  assert.equal(reopened.history('boris', 'anna')[0].image.dataUrl, image.dataUrl);
  await reopened.close();
});

test('encrypted snapshot and journal reject tampering, wrong key, plaintext and missing key', async (t) => {
  const f = fixture(t);
  await legacyHistory(f);
  migrateCloudStorage(f);
  const wrong = path.join(f.root, 'wrong.key');
  fs.writeFileSync(wrong, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  fs.chmodSync(wrong, 0o644);
  assert.throws(() => createAccountStore({ dir: f.target, keyFile: wrong }), /readable only by its owner/);
  fs.chmodSync(wrong, 0o600);
  assert.throws(() => createAccountStore({ dir: f.target, keyFile: wrong }), /keyId mismatch/);
  assert.throws(() => createAccountStore({ dir: f.target, keyFile: null }), /required/);
  assert.throws(() => createJournal({ file: path.join(f.target, 'accounts.journal') }), /plaintext writes are refused/);
  assert.throws(() => createAccountStore({ dir: f.target, keyFile: null, allowPlaintextLegacy: true }), /required/);
  assert.throws(() => createAccountStore({ dir: f.source, keyFile: null }), /required/);
  assert.throws(() => createAccountStore({ dir: f.source, keyFile: f.keyFile }), /offline migration/);
  const emptyDir = path.join(f.root, 'empty-data');
  fs.mkdirSync(emptyDir, { mode: 0o700 });
  assert.throws(() => createAccountStore({ dir: emptyDir, keyFile: f.keyFile }), /offline migration/);
  assert.equal(fs.existsSync(path.join(emptyDir, '.cloud-encrypted')), false, 'marker must never be auto-created on empty dir');
  assert.equal(fs.existsSync(path.join(emptyDir, 'server_key.json')), false, 'server keys must never be auto-generated on empty dir');
  const snapshot = path.join(f.target, 'accounts.json');
  const original = fs.readFileSync(snapshot);
  alter(snapshot);
  const tamperedSnapshot = fs.readFileSync(snapshot);
  assert.throws(() => createAccountStore({ dir: f.target, keyFile: f.keyFile }), /authentication failed/);
  assert.deepEqual(fs.readFileSync(snapshot), tamperedSnapshot, 'a rejected snapshot remains available for operator recovery');
  fs.writeFileSync(snapshot, original);
  const journal = path.join(f.target, 'accounts.journal');
  const originalLog = fs.readFileSync(journal, 'utf8');
  const line = JSON.parse(originalLog.trim());
  line.tag = Buffer.from('0000000000000000').toString('base64');
  fs.writeFileSync(journal, `${JSON.stringify(line)}\n`);
  assert.throws(() => createAccountStore({ dir: f.target, keyFile: f.keyFile }), /authentication failed/);
});

test('migration resumes verified files and interrupted encrypted temporary writes, never overwrites a mismatch', async (t) => {
  const f = fixture(t);
  await legacyHistory(f);
  const cipher = createCloudCipher(f.keyFile, f.target);
  const serverKey = fs.readFileSync(path.join(f.source, 'server_key.json'));
  fs.writeFileSync(path.join(f.target, 'server_key.json'), cipher.seal(serverKey, 'server_key.json'));
  fs.writeFileSync(path.join(f.target, '.accounts.json.encrypting'), 'truncated encrypted temporary');
  migrateCloudStorage(f);
  assert.deepEqual(cipher.open(fs.readFileSync(path.join(f.target, 'server_key.json'), 'utf8'), 'server_key.json'), serverKey);
  assert.equal(fs.existsSync(path.join(f.target, '.accounts.json.encrypting')), false);
  const next = path.join(f.root, 'another-target');
  fs.mkdirSync(next);
  const anotherCipher = createCloudCipher(f.keyFile, next);
  fs.writeFileSync(path.join(next, 'server_key.json'), anotherCipher.seal(Buffer.from('wrong identity'), 'server_key.json'));
  assert.throws(() => migrateCloudStorage({ ...f, target: next }), /differs from source/);
  assert.equal(fs.existsSync(path.join(next, '.cloud-encrypted')), false);
});

test('initCloudStorage bootstraps an empty encrypted directory and refuses non-empty directory', (t) => {
  const f = fixture(t);
  const fresh = path.join(f.root, 'fresh-encrypted');
  const report = initCloudStorage({ target: fresh, keyFile: f.keyFile });
  assert.equal(report.initialized, true);
  assert.equal(fs.existsSync(path.join(fresh, '.cloud-encrypted')), true);
  const store = createAccountStore({ dir: fresh, keyFile: f.keyFile });
  assert.equal(store.announcedVersion(), null);
  store.close();
  assert.throws(() => initCloudStorage({ target: fresh, keyFile: f.keyFile }), /already initialized/);
});

test('multi-megabyte snapshot seals and opens without regex or stack size regression', (t) => {
  const f = fixture(t);
  const cipher = createCloudCipher(f.keyFile, f.target);
  const chunk = 'data:image/jpeg;base64,' + 'B'.repeat(1_000_000);
  // 10 MB ciphertext exceeds the 8 MB V8 RegExp call-stack overflow threshold
  const bigState = Buffer.from(JSON.stringify({
    version: 1,
    accounts: { alice: { login: 'alice', name: 'Alice' } },
    history: { 'alice:bob': Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, text: chunk })) },
  }));
  const sealed = cipher.seal(bigState, 'accounts.json');
  assert.ok(sealed.length > bigState.length);
  const opened = cipher.open(sealed, 'accounts.json');
  assert.deepEqual(opened, bigState);
});

test('streamed snapshots retain UTF-8 and authenticate with the existing envelope reader', async (t) => {
  const f = fixture(t);
  const cipher = createCloudCipher(f.keyFile, f.target);
  const file = path.join(f.target, 'accounts.json');
  const text = 'x'.repeat(16_383) + '😀' + 'я'.repeat(32_768) + '\ud800';
  await cipher.sealFile(text, 'accounts.json', file);
  const raw = fs.readFileSync(file, 'utf8');
  assert.deepEqual(cipher.open(raw, 'accounts.json'), Buffer.from(text));
  assert.throws(() => cipher.open(raw, 'accounts.journal'), /authentication failed/);
  alter(file);
  assert.throws(() => cipher.open(fs.readFileSync(file, 'utf8'), 'accounts.json'), /authentication failed/);
});
