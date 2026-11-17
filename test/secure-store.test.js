import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSecureStore, migrateCliFiles, openDeviceStore } from '../src/secure-store.js';
import { createPersistentOutbox } from '../src/outbox-store.js';
import { createSharedHistory } from '../src/shared-history.js';
import { createLog, readLogTail } from '../src/log.js';
import { createFileReceiver } from '../src/files.js';

const makeDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-secure-test-'));
const key = () => crypto.randomBytes(32);
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const config = { sharedHistory: { url: 'http://localhost:4748', room: 'secure-room-test' } };

test('AES-GCM binds ciphertext to path and device key and rejects corruption', () => {
  const dir = makeDir();
  const store = createSecureStore(key());
  const file = path.join(dir, 'cache.json');
  const body = Buffer.from('sensitive Cloud history');
  store.write(file, body);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(store.fileFor(file)).includes(body), false);
  assert.deepEqual(store.read(file), body);
  assert.throws(() => createSecureStore(key()).read(file), /authentication failed/);
  assert.throws(() => store.unseal(fs.readFileSync(store.fileFor(file)), `${file}.wrong`), /authentication failed/);
  const damaged = fs.readFileSync(store.fileFor(file));
  damaged[damaged.length - 1] ^= 1;
  fs.writeFileSync(store.fileFor(file), damaged);
  assert.throws(() => store.read(file), /authentication failed/);
});

test('outbox survives restart and wrong key never replaces pending messages', () => {
  const dir = makeDir();
  const file = path.join(dir, 'outbox.json');
  const store = createSecureStore(key());
  const first = createPersistentOutbox({ file, store });
  first.add('one', 1, 'id-1');
  first.add('two', 2, 'id-2');
  const saved = fs.readFileSync(store.fileFor(file));
  assert.throws(() => createPersistentOutbox({ file, store: createSecureStore(key()) }), /authentication failed/);
  assert.deepEqual(fs.readFileSync(store.fileFor(file)), saved);
  const reopened = createPersistentOutbox({ file, store });
  reopened.flush((text) => text === 'one');
  assert.deepEqual(createPersistentOutbox({ file, store }).pending().map((item) => item.id), ['id-2']);
  assert.equal(fs.existsSync(file), false);
});

test('explicit partial migration preserves old sources and can safely resume', async () => {
  const dir = makeDir();
  const filesDir = path.join(dir, 'files');
  fs.mkdirSync(filesDir);
  const store = createSecureStore(key());
  const queue = path.join(dir, 'outbox-device.json');
  const media = path.join(filesDir, 'photo.jpg');
  const transcript = path.join(dir, 'peer-demo.log');
  fs.writeFileSync(queue, '[{"text":"unsent","ts":4,"id":"u"}]');
  fs.writeFileSync(media, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fs.writeFileSync(transcript, '[12:00] peer: first\n[12:01] me: second\n');
  store.migrate(queue);
  const result = migrateCliFiles(store, { stateDir: dir, filesDir });
  // Only the transcript: a received file is not a store this migration owns.
  assert.equal(result.migrated, 1);
  assert.equal(migrateCliFiles(store, { stateDir: dir, filesDir }).migrated, 0);
  assert.equal(fs.readFileSync(queue, 'utf8').includes('unsent'), true);
  assert.deepEqual(createPersistentOutbox({ file: queue, store }).pending().map((item) => item.text), ['unsent']);
  // `filesDir` holds what a person received and has to be able to open in another
  // app. Converting it would leave an unopenable `.enc` behind, and converting it
  // with `--drop-plaintext` would delete the only usable copy — so it stays as it is.
  assert.equal(fs.existsSync(store.fileFor(media)), false, 'a received file is not encrypted');
  assert.deepEqual(fs.readFileSync(media), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.deepEqual(readLogTail(transcript, 20, store), ['[12:00] peer: first', '[12:01] me: second']);
  const log = createLog(transcript, { store });
  log.append('[12:02] me: after migration');
  await new Promise((done) => log.close(done));
  assert.deepEqual(readLogTail(transcript, 20, store).at(-1), '[12:02] me: after migration');
});

test('legacy queue is refused until explicit migration; missing vault fails closed', () => {
  const dir = makeDir();
  const file = path.join(dir, 'outbox-test.json');
  fs.writeFileSync(file, '[{"text":"unsent","ts":1}]');
  const store = createSecureStore(key());
  // The refusal has to name the remedy: this is the error an existing install
  // meets on its first launch after the upgrade, with no other clue on screen.
  assert.throws(() => createPersistentOutbox({ file, store }), /explicit migration/);
  assert.throws(() => store.read(file), /--migrate-encryption/);
  assert.equal(fs.existsSync(store.fileFor(file)), false);
  assert.throws(() => openDeviceStore({ platform: 'no-vault' }), /No supported secure storage/);
  store.migrate(file);
  assert.equal(createPersistentOutbox({ file, store }).size(), 1);
});

test('the startup pass converts only the files that have no ciphertext yet', () => {
  const dir = makeDir();
  const store = createSecureStore(key());
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const converted = path.join(stateDir, 'peer-a.log');
  const pending = path.join(stateDir, 'peer-b.log');
  fs.writeFileSync(converted, '[12:00] a: already encrypted\n');
  fs.writeFileSync(pending, '[12:01] b: never converted\n');
  assert.equal(store.migrateLog(converted), true);

  // A signature that only touches the unconverted file: re-proving thousands of
  // finished pairs byte-for-byte is what made every launch pay for the whole profile.
  const seen = [];
  const spy = {
    ...store,
    migrateLog: (file) => { seen.push(path.basename(file)); return store.migrateLog(file); },
    migrate: (file) => { seen.push(path.basename(file)); return store.migrate(file); },
  };
  const outcome = migrateCliFiles(spy, { stateDir, onlyMissing: true });
  assert.deepEqual(seen, ['peer-b.log'], 'an already-converted file is not even opened');
  assert.equal(outcome.migrated, 1);
  assert.deepEqual(readLogTail(pending, 20, store), ['[12:01] b: never converted']);
});

test('dropPlaintext removes only the originals whose ciphertext verifiably matches', () => {
  const dir = makeDir();
  const store = createSecureStore(key());
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const queue = path.join(stateDir, 'outbox-x.json');
  const transcript = path.join(stateDir, 'peer-c.log');
  fs.writeFileSync(queue, '[{"text":"unsent","ts":7,"id":"q"}]');
  fs.writeFileSync(transcript, '[09:00] c: line one\n[09:01] me: line two\n');

  const outcome = migrateCliFiles(store, { stateDir, dropPlaintext: true });
  assert.equal(outcome.migrated, 2);
  assert.equal(outcome.dropped, 2);
  assert.equal(outcome.sourcesRetained, false);
  assert.equal(fs.existsSync(queue), false, 'a verified original is removed');
  assert.equal(fs.existsSync(transcript), false, 'the transcript original is removed too');
  // The encrypted side still carries everything the original did.
  assert.deepEqual(createPersistentOutbox({ file: queue, store }).pending().map((i) => i.text), ['unsent']);
  assert.deepEqual(readLogTail(transcript, 20, store), ['[09:00] c: line one', '[09:01] me: line two']);
});

test('a divergent pair is reported and never silently dropped', () => {
  const dir = makeDir();
  const store = createSecureStore(key());
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'outbox-y.json');
  fs.writeFileSync(file, '[{"text":"older","ts":1,"id":"a"}]');
  store.migrate(file);
  // Now the two copies disagree: the ciphertext holds the older state, the plaintext
  // a newer one. That is two divergent copies of real history, which an operator has
  // to see rather than have one side deleted.
  fs.writeFileSync(file, '[{"text":"newer local state","ts":1,"id":"a"}]');
  assert.equal(store.verify(file), false);
  assert.throws(() => migrateCliFiles(store, { stateDir, dropPlaintext: true }), /Migration conflict/);
  assert.equal(fs.existsSync(file), true, 'nothing was deleted when the two copies disagree');
});
test('dropPlaintext removes originals when ciphertext was appended or updated after migration', async () => {
  const dir = makeDir();
  const store = createSecureStore(key());
  const stateDir = path.join(dir, 'state');
  const cacheDir = path.join(stateDir, 'cloud-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const log = path.join(stateDir, 'peer-user.log');
  const cache = path.join(cacheDir, 'user.json');
  fs.writeFileSync(log, '[09:00] user: hello\n');
  fs.writeFileSync(cache, '{"messages":["old"]}');

  // Step 1: Initial migration (as happens on startup)
  store.migrateLog(log);
  store.migrate(cache);

  // Step 2: Active session appends to encrypted log and updates encrypted cache
  const logStream = createLog(log, { store });
  logStream.append('[09:01] me: reply');
  await new Promise((done) => logStream.close(done));
  store.write(cache, Buffer.from('{"messages":["old","new"]}'));

  // Step 3: Run dropPlaintext later
  const outcome = migrateCliFiles(store, { stateDir, dropPlaintext: true });
  assert.equal(outcome.dropped, 2);
  assert.equal(fs.existsSync(log), false, 'plaintext log is dropped because ciphertext contains full prefix');
  assert.equal(fs.existsSync(cache), false, 'stale plaintext cache is dropped because ciphertext is newer');
  assert.deepEqual(readLogTail(log, 10, store), ['[09:00] user: hello', '[09:01] me: reply']);
  assert.equal(store.read(cache).toString('utf8'), '{"messages":["old","new"]}');
});

test('received media is encrypted and collisions never replace a previous transfer', () => {
  const dir = makeDir();
  const store = createSecureStore(key());
  const receiver = createFileReceiver({ dir, store });
  const payload = Buffer.from('media-payload');
  const transfer = (id) => {
    receiver.offer({ id, name: 'photo.jpg', size: payload.length, sha256: sha(payload) });
    receiver.chunk({ id, data: payload.toString('base64') });
    return receiver.done({ id });
  };
  const a = transfer('a');
  const b = transfer('b');
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.path, b.path);
  assert.equal(fs.existsSync(a.path), false);
  assert.deepEqual(store.read(a.path), payload);
  assert.deepEqual(store.read(b.path), payload);
});

test('shared history queue restart retains pending messages and refuses key loss', async () => {
  const dir = makeDir();
  const store = createSecureStore(key());
  const offline = async () => { throw new Error('offline'); };
  const first = createSharedHistory(config, dir, { store, fetchImpl: offline });
  const message = { id: 'm', name: 'peer', text: 'private message', ts: 42, kind: 'human' };
  first.record(message);
  await first.flush();
  const saved = fs.readFileSync(store.fileFor(first.file));
  assert.throws(() => createSharedHistory(config, dir, { store: createSecureStore(key()), fetchImpl: offline }), /authentication failed/);
  assert.deepEqual(fs.readFileSync(store.fileFor(first.file)), saved);
  const sent = [];
  const reopened = createSharedHistory(config, dir, {
    store, fetchImpl: async (url, request) => { sent.push(JSON.parse(request.body).message); return { ok: true }; },
  });
  await reopened.flush();
  assert.deepEqual(sent, [message]);
});

test('Linux Secret Service lookup/store roundtrip and unavailable vault fail closed', () => {
  let saved = '';
  const fakeSpawn = (command, args, options) => {
    assert.equal(command, 'secret-tool');
    if (args[0] === 'lookup') return saved
      ? { status: 0, stdout: `${saved}\n`, stderr: '' }
      : { status: 1, stdout: '', stderr: '' };
    saved = options.input.trim();
    return { status: 0, stdout: '', stderr: '' };
  };
  const first = openDeviceStore({ platform: 'linux', spawn: fakeSpawn });
  const again = openDeviceStore({ platform: 'linux', spawn: fakeSpawn, create: false });
  const dir = makeDir();
  const file = path.join(dir, 'queue.json');
  first.write(file, Buffer.from('persisted message'));
  assert.equal(again.read(file).toString(), 'persisted message');
  assert.throws(() => openDeviceStore({
    platform: 'linux',
    spawn: () => ({ status: 1, stdout: '', stderr: 'Service unavailable' }),
  }), /Secure storage unavailable/);
});

test('Windows Credential Manager key retrieval is authenticated across starts', () => {
  let saved = '';
  const fakeSpawn = (command, args, options) => {
    assert.equal(command, 'powershell.exe');
    const mode = args.at(-1).includes("'put'") ? 'put' : 'get';
    if (mode === 'put') {
      saved = options.input.trim();
      return { status: 0, stdout: '', stderr: '' };
    }
    return saved ? { status: 0, stdout: saved, stderr: '' } : { status: 3, stdout: '', stderr: '' };
  };
  const first = openDeviceStore({ platform: 'win32', spawn: fakeSpawn });
  const second = openDeviceStore({ platform: 'win32', spawn: fakeSpawn, create: false });
  const file = path.join(makeDir(), 'history.json');
  first.write(file, Buffer.from('win message'));
  assert.equal(second.read(file).toString(), 'win message');
});

test('write verifies existing file once per session and skips redundant unseal on subsequent overwrites', () => {
  const dir = makeDir();
  const rawKey = key();
  const store = createSecureStore(rawKey);
  const file = path.join(dir, 'conversation.json');
  store.write(file, Buffer.from('v1'));

  // Corrupt the ciphertext on disk
  const encFile = store.fileFor(file);
  const corrupted = Buffer.from(fs.readFileSync(encFile));
  corrupted[corrupted.length - 1] ^= 0xff;
  fs.writeFileSync(encFile, corrupted);

  // A fresh store touching this corrupted file must throw /authentication failed/
  const freshStore = createSecureStore(rawKey);
  assert.throws(() => freshStore.write(file, Buffer.from('fail')), /authentication failed/);

  // The existing store already verified this file path, so subsequent write succeeds without re-unsealing
  store.write(file, Buffer.from('v2'));
  assert.equal(store.read(file).toString(), 'v2');
});

// The native core's SQLCipher file is opened with this subkey, never with the
// key that seals the CLI's own files. Cross-checked against RFC 5869 written
// out by hand, so the derivation is HKDF-SHA256 and not merely "some hash".
test('deriveKey is HKDF-SHA256 of the device key under a purpose label, and never the key itself', () => {
  const info = 'tailchat-core-sqlcipher-v1';
  const device = key();
  const store = createSecureStore(device);
  const derived = store.deriveKey(info);

  assert.equal(derived.length, 32);
  assert.ok(!derived.equals(device), 'a subkey is not the device key');
  // extract: PRK = HMAC(salt, IKM) — an empty salt stands for HashLen zero bytes
  const prk = crypto.createHmac('sha256', Buffer.alloc(32)).update(device).digest();
  // expand: one block is enough for 32 bytes, T(1) = HMAC(PRK, info | 0x01)
  const expected = crypto.createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest();
  assert.deepEqual(derived, expected);

  assert.deepEqual(createSecureStore(device).deriveKey(info), derived, 'stable: the same store file opens next time');
  assert.notDeepEqual(store.deriveKey('another-purpose'), derived, 'a label separates the uses of one key');
  assert.notDeepEqual(createSecureStore(key()).deriveKey(info), derived, 'a different device key gives a different subkey');

  // The caller owns what it was given: wiping it cannot change the next derivation.
  derived.fill(0);
  assert.deepEqual(store.deriveKey(info), expected);
  assert.throws(() => store.deriveKey(''), /purpose label/);
  assert.throws(() => store.deriveKey(undefined), /purpose label/);
  assert.throws(() => store.deriveKey(Buffer.from(info)), /purpose label/);
});

test('a store opened from the vault derives from the key the vault holds', () => {
  const info = 'tailchat-core-sqlcipher-v1';
  let saved = '';
  const fakeSpawn = (command, args, options) => {
    if (args[0] === 'lookup') return saved
      ? { status: 0, stdout: `${saved}\n`, stderr: '' }
      : { status: 1, stdout: '', stderr: '' };
    saved = options.input.trim();
    return { status: 0, stdout: '', stderr: '' };
  };
  const first = openDeviceStore({ platform: 'linux', spawn: fakeSpawn });
  const second = openDeviceStore({ platform: 'linux', spawn: fakeSpawn, create: false });
  assert.deepEqual(second.deriveKey(info), first.deriveKey(info), 'the same vault key, the same store key on the next start');
  assert.deepEqual(first.deriveKey(info), createSecureStore(Buffer.from(saved, 'base64')).deriveKey(info));
});
