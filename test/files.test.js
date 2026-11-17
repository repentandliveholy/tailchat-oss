import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSecureStore } from '../src/secure-store.js';
import {
  safeFileName,
  createFileReceiver,
  admitOffer,
  chunkFile,
  formatBytes,
  defaultFilesDir,
  defaultStateDir,
  peerFileStem,
  writeNextPeer,
  takeNextPeer,
  nextPeerFile,
} from '../src/files.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-files-'));
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const store = createSecureStore(crypto.randomBytes(32));

test('safeFileName strips any path so a peer cannot escape the download dir', () => {
  assert.equal(safeFileName('photo.jpg'), 'photo.jpg');
  assert.equal(safeFileName('../../.ssh/authorized_keys'), 'authorized_keys');
  assert.equal(safeFileName('/etc/passwd'), 'passwd');
  assert.equal(safeFileName('..\\..\\windows\\system32\\evil.dll'), 'evil.dll');
  assert.equal(safeFileName('..'), 'file');
  assert.equal(safeFileName('.'), 'file');
  assert.equal(safeFileName(''), 'file');
  assert.equal(safeFileName('a/b/'), 'b', 'a trailing slash still yields a safe basename');
});

test('formatBytes is human readable', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});

test('a complete transfer lands on disk owner-only with a verified digest', async () => {
  const dir = tmpDir();
  const payload = Buffer.from('привет файл 🚀'.repeat(50), 'utf8');
  const receiver = createFileReceiver({ dir, store, maxBytes: 1024 * 1024 });

  const offer = receiver.offer({
    id: 'f1', name: 'photo.jpg', size: payload.length, sha256: sha(payload),
  });
  assert.equal(offer.accepted, true);

  for (const chunk of chunkFile(payload, 64)) {
    receiver.chunk({ id: 'f1', data: chunk.toString('base64') });
  }
  const done = receiver.done({ id: 'f1' });

  assert.equal(done.ok, true);
  assert.equal(path.dirname(done.path), dir);
  assert.deepEqual(store.read(done.path), payload);
  assert.equal(fs.statSync(store.fileFor(done.path)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('an oversized offer is refused without touching the disk', () => {
  const dir = tmpDir();
  const receiver = createFileReceiver({ dir, store, maxBytes: 10 });
  const offer = receiver.offer({ id: 'big', name: 'huge.bin', size: 999, sha256: 'x' });

  assert.equal(offer.accepted, false);
  assert.match(offer.reason, /too large/i);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a chunk stream that overruns the offered size is aborted', () => {
  const dir = tmpDir();
  const receiver = createFileReceiver({ dir, store, maxBytes: 1024 });
  receiver.offer({ id: 'f2', name: 'x.bin', size: 4, sha256: 'unused' });

  const first = receiver.chunk({ id: 'f2', data: Buffer.from('abcd').toString('base64') });
  assert.equal(first.ok, true);
  const overrun = receiver.chunk({ id: 'f2', data: Buffer.from('more').toString('base64') });

  assert.equal(overrun.ok, false);
  assert.match(overrun.reason, /size/i);
  assert.deepEqual(fs.readdirSync(dir), [], 'partial data must not survive');
});

test('a corrupted transfer is rejected and leaves nothing behind', () => {
  const dir = tmpDir();
  const payload = Buffer.from('good bytes');
  const receiver = createFileReceiver({ dir, store, maxBytes: 1024 });
  receiver.offer({
    id: 'f3', name: 'x.bin', size: payload.length, sha256: sha(Buffer.from('other bytes!')),
  });
  receiver.chunk({ id: 'f3', data: payload.toString('base64') });

  const done = receiver.done({ id: 'f3' });
  assert.equal(done.ok, false);
  assert.match(done.reason, /checksum/i);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a name collision never overwrites the existing file', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'photo.jpg'), 'original');
  const payload = Buffer.from('second');
  const receiver = createFileReceiver({ dir, store, maxBytes: 1024 });

  receiver.offer({ id: 'f4', name: 'photo.jpg', size: payload.length, sha256: sha(payload) });
  receiver.chunk({ id: 'f4', data: payload.toString('base64') });
  const done = receiver.done({ id: 'f4' });

  assert.equal(done.ok, true);
  assert.notEqual(path.basename(done.path), 'photo.jpg');
  assert.equal(fs.readFileSync(path.join(dir, 'photo.jpg'), 'utf8'), 'original');
  assert.deepEqual(store.read(done.path), payload);
});

test('abort discards an in-flight transfer', () => {
  const dir = tmpDir();
  const receiver = createFileReceiver({ dir, store, maxBytes: 1024 });
  receiver.offer({ id: 'f5', name: 'x.bin', size: 100, sha256: 'x' });
  receiver.chunk({ id: 'f5', data: Buffer.from('partial').toString('base64') });

  receiver.abortAll();
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(receiver.inFlight(), 0);
});

test('chunkFile splits on the requested boundary and preserves bytes', () => {
  const payload = Buffer.from('0123456789');
  const chunks = [...chunkFile(payload, 4)];
  assert.deepEqual(chunks.map((c) => c.length), [4, 4, 2]);
  assert.deepEqual(Buffer.concat(chunks), payload);
});

test('a received file lands where other apps can open it', () => {
  // Termux home is private to the app: a photo saved there is invisible to the
  // gallery and every share sheet, so the transfer arrived and then could not be
  // used for anything.
  const home = '/data/data/com.termux/files/home';
  const only = (path) => (dir) => dir === path;

  assert.equal(
    defaultFilesDir({ home, termux: true, writable: only(`${home}/storage/shared/Download`) }),
    `${home}/storage/shared/Download/tailchat`,
  );
  assert.equal(
    defaultFilesDir({ home, termux: true, writable: only('/sdcard/Download') }),
    '/sdcard/Download/tailchat',
  );
  // The trap this ordering exists for: `~/storage/downloads` can be an ordinary
  // private directory left by a half-finished `termux-setup-storage` — writable,
  // tidy-looking and just as invisible as the home folder.
  assert.equal(
    defaultFilesDir({ home, termux: true, writable: only(`${home}/storage/downloads`) }),
    `${home}/.tailchat/files`,
  );
  assert.equal(
    defaultFilesDir({ home, termux: true, writable: () => false }),
    `${home}/.tailchat/files`,
  );
  assert.equal(
    defaultFilesDir({ home: '/home/me', writable: () => true }),
    '/home/me/.tailchat/files',
    'a desktop keeps its own folder',
  );
});

test('state never follows the files into shared storage', () => {
  // An outbox, a roster and a pid file in the person's Downloads folder would be
  // both noise and a permissions problem on Android.
  assert.equal(defaultStateDir('/home/me'), '/home/me/.tailchat');
  assert.notEqual(
    defaultStateDir('/data/data/com.termux/files/home'),
    defaultFilesDir({ home: '/data/data/com.termux/files/home', termux: true, exists: () => true }),
  );
});

test('a folder that stops being writable is reported, not thrown', () => {
  // Received files now land in Android's shared Download folder, where the
  // permission can be revoked while a transfer is in flight. Throwing out of
  // done() would take the whole conversation down with the file.
  const payload = Buffer.from('данные');
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-rx-'));
  const receiver = createFileReceiver({
    dir,
    store,
    writeFile: () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    },
  });
  assert.equal(receiver.offer({
    id: 'a', name: 'фото.jpg', size: payload.length, sha256: digest,
  }).accepted, true);
  assert.equal(receiver.chunk({ id: 'a', data: payload.toString('base64') }).ok, true);
  const result = receiver.done({ id: 'a' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /EACCES/);
  // The failed transfer must not stay half-remembered.
  assert.equal(receiver.inFlight(), 0);
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing half-written left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});
test('peerFileStem is stable per peer and keeps raw keys apart', () => {
  assert.equal(peerFileStem('a@example.com'), peerFileStem('a@example.com'));
  assert.notEqual(peerFileStem('a@example.com'), peerFileStem('b@example.com'));
  assert.ok(!peerFileStem('../etc/passwd').includes('/'), 'no separators survive');
  assert.ok(!peerFileStem('../etc/passwd').includes('\\'));
});

test('the next-peer note is one-shot: taken once, then gone', () => {
  const dir = tmpDir();
  writeNextPeer(dir, '  roman@example.com\n');
  assert.ok(fs.existsSync(nextPeerFile(dir)));
  assert.equal(takeNextPeer(dir), 'roman@example.com');
  assert.equal(takeNextPeer(dir), null, 'the instruction is consumed, not repeated');
  assert.ok(!fs.existsSync(nextPeerFile(dir)));
});

test('a missing next-peer note reads as null, not an error', () => {
  assert.equal(takeNextPeer(tmpDir()), null);
});

test('a note that cannot be unlinked is still consumed exactly once', () => {
  // Windows refuses to unlink a file another handle holds, and the note is read
  // at every start: ignoring that error meant one /peer switch re-applied itself
  // on every supervised restart and the person could not get out of that chat.
  const dir = tmpDir();
  const unlink = () => {
    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  };
  writeNextPeer(dir, 'roman@example.com');

  assert.equal(takeNextPeer(dir, { unlink }), 'roman@example.com');
  assert.equal(
    takeNextPeer(dir, { unlink }), null,
    'a note that survived the unlink must still not be served twice',
  );
  assert.equal(fs.readFileSync(nextPeerFile(dir), 'utf8'), '');
});

test('a note nothing can consume is still reported', () => {
  const dir = tmpDir();
  writeNextPeer(dir, 'roman@example.com');
  const failures = [];
  const value = takeNextPeer(dir, {
    unlink: () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); },
    truncate: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    onError: (error) => failures.push(error.code),
  });

  assert.equal(value, 'roman@example.com', 'the switch the person asked for still happens');
  assert.deepEqual(failures, ['EACCES'], 'and the reason it will happen again is observable');
});

test('a name that only Windows objects to still lands there', () => {
  // The sender does not choose the receiver's filesystem: these names are
  // unremarkable on a Mac and simply cannot be created on Windows, so the
  // transfer used to die at the last step with a raw errno in the chat.
  const win = (name) => safeFileName(name, { platform: 'win32' });

  assert.equal(win('Q3: notes?.txt'), 'Q3_ notes_.txt');
  assert.equal(win('a<b>c|d"e*f.bin'), 'a_b_c_d_e_f.bin');
  // Windows strips trailing dots and spaces silently, so two distinct offers
  // would land on one file with the collision check none the wiser.
  assert.equal(win('report. '), 'report');
  assert.equal(win('notes...'), 'notes');
  assert.equal(win('...'), 'file', 'a name that sanitises away still needs one');
  // Device names are handed to hardware however they are spelled and whatever
  // extension is glued on.
  assert.equal(win('nul'), '_nul');
  assert.equal(win('CON'), '_CON');
  assert.equal(win('NUL.txt'), '_NUL.txt');
  assert.equal(win('com9.dat'), '_com9.dat');
  assert.equal(win('lpt1'), '_lpt1');
  assert.equal(win('com10.dat'), 'com10.dat', 'only COM1-COM9 are devices');
  assert.equal(win('console.log'), 'console.log', 'a device name is the whole stem or nothing');
  // The traversal defence and the ordinary case are untouched by any of it.
  assert.equal(win('../../.ssh/authorized_keys'), 'authorized_keys');
  assert.equal(win('..\\..\\windows\\system32\\evil.dll'), 'evil.dll');
  assert.equal(win('..'), 'file');
  assert.equal(win('photo.jpg'), 'photo.jpg');
});

test('the Windows rules stay on Windows', () => {
  // All of these are legal filenames on a POSIX filesystem, and mangling them
  // there would be a regression for every existing peer.
  const posix = (name) => safeFileName(name, { platform: 'linux' });

  assert.equal(posix('Q3: notes?.txt'), 'Q3: notes?.txt');
  assert.equal(posix('a<b>c|d"e*f.bin'), 'a<b>c|d"e*f.bin');
  assert.equal(posix('report. '), 'report. ');
  assert.equal(posix('nul.txt'), 'nul.txt');
  assert.equal(posix('COM1'), 'COM1');
  assert.equal(posix('photo.jpg'), 'photo.jpg');
  assert.equal(posix('..'), 'file');
});

test('a receiver on Windows renames the offer it could not have written', () => {
  const dir = tmpDir();
  const payload = Buffer.from('windows bytes');
  const receiver = createFileReceiver({ dir, store, maxBytes: 1024, platform: 'win32' });

  const offer = receiver.offer({
    id: 'w1', name: 'Q3: notes?.txt', size: payload.length, sha256: sha(payload),
  });
  assert.equal(offer.accepted, true);
  assert.equal(offer.name, 'Q3_ notes_.txt');

  receiver.chunk({ id: 'w1', data: payload.toString('base64') });
  const done = receiver.done({ id: 'w1' });
  assert.equal(done.ok, true);
  assert.equal(path.basename(done.path), 'Q3_ notes_.txt');
});

test('a peer cannot open more transfers than the receiver will hold', () => {
  const dir = tmpDir();
  const receiver = createFileReceiver({
    dir, maxBytes: 1024, maxTransfers: 2, maxBufferedBytes: 1024 * 1024,
    store,
  });
  const payload = Buffer.from('done at last');

  assert.equal(receiver.offer({ id: 'a', name: 'a.bin', size: 10, sha256: 'x' }).accepted, true);
  assert.equal(receiver.offer({
    id: 'b', name: 'b.bin', size: payload.length, sha256: sha(payload),
  }).accepted, true);

  const refused = receiver.offer({ id: 'c', name: 'c.bin', size: 10, sha256: 'x' });
  assert.equal(refused.accepted, false);
  assert.match(refused.reason, /too many/i);
  assert.equal(receiver.inFlight(), 2, 'the refused offer reserved nothing');

  // Finishing one hands its slot back, or a single stalled peer would wedge the
  // receiver shut for good.
  receiver.chunk({ id: 'b', data: payload.toString('base64') });
  assert.equal(receiver.done({ id: 'b' }).ok, true);
  assert.equal(receiver.offer({ id: 'c', name: 'c.bin', size: 10, sha256: 'x' }).accepted, true);
});

test('a peer cannot buffer more bytes than the receiver will hold', () => {
  const dir = tmpDir();
  const receiver = createFileReceiver({ dir, store, maxBytes: 1024, maxBufferedBytes: 150 });

  assert.equal(receiver.offer({ id: 'a', name: 'a.bin', size: 100, sha256: 'x' }).accepted, true);
  const refused = receiver.offer({ id: 'b', name: 'b.bin', size: 100, sha256: 'x' });

  assert.equal(refused.accepted, false);
  assert.match(refused.reason, /in flight/i);
  assert.equal(receiver.reservedBytes(), 100, 'the refusal costs nothing');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a transfer that stopped arriving does not hold its bytes for the run', () => {
  const dir = tmpDir();
  let clock = 1_000;
  const receiver = createFileReceiver({
    dir, maxBytes: 1024, maxBufferedBytes: 150, idleMs: 30_000, now: () => clock,
    store,
  });
  receiver.offer({ id: 'gone', name: 'gone.bin', size: 100, sha256: 'x' });
  receiver.chunk({ id: 'gone', data: Buffer.from('partial').toString('base64') });

  clock += 29_000;
  assert.deepEqual(receiver.sweep(), { dropped: 0, inFlight: 1, reservedBytes: 100 });

  clock += 2_000;
  assert.deepEqual(receiver.sweep(), { dropped: 1, inFlight: 0, reservedBytes: 0 });
  assert.equal(
    receiver.chunk({ id: 'gone', data: 'AA==' }).ok, false,
    'a resumed stream has nothing to resume into',
  );
  // And with the room back, the offer that the dead transfer would have blocked
  // is accepted without anyone having to call sweep().
  assert.equal(receiver.offer({ id: 'next', name: 'n.bin', size: 100, sha256: 'x' }).accepted, true);
});

test('a new offer ages out the transfers nobody is going to finish', () => {
  const dir = tmpDir();
  let clock = 0;
  const receiver = createFileReceiver({
    dir, maxBytes: 1024, maxTransfers: 1, idleMs: 10_000, now: () => clock,
    store,
  });
  receiver.offer({ id: 'stalled', name: 's.bin', size: 10, sha256: 'x' });

  clock += 5_000;
  assert.equal(receiver.offer({ id: 'live', name: 'l.bin', size: 10, sha256: 'x' }).accepted, false);

  clock += 6_000;
  assert.equal(receiver.offer({ id: 'live', name: 'l.bin', size: 10, sha256: 'x' }).accepted, true);
  assert.equal(receiver.inFlight(), 1);
});

test('a transfer still being fed is never aged out from under it', () => {
  const dir = tmpDir();
  let clock = 0;
  const payload = Buffer.from('slow but alive'.repeat(20));
  const receiver = createFileReceiver({
    dir, maxBytes: 1024, idleMs: 1_000, now: () => clock,
    store,
  });
  receiver.offer({
    id: 'slow', name: 'slow.bin', size: payload.length, sha256: sha(payload),
  });

  for (const chunk of chunkFile(payload, 16)) {
    clock += 900; // each chunk pushes the deadline out again
    assert.equal(receiver.chunk({ id: 'slow', data: chunk.toString('base64') }).ok, true);
    receiver.sweep();
  }

  const done = receiver.done({ id: 'slow' });
  assert.equal(done.ok, true);
  assert.deepEqual(store.read(done.path), payload);
  assert.equal(receiver.reservedBytes(), 0);
});

test('a filesystem lookup that fails during file-done is reported, not thrown', () => {
  // Choosing a non-colliding name looks up the directory, and on a share that
  // stopped answering that lookup throws. It used to happen outside the guard,
  // so the error left through the socket's data callback and took the whole
  // conversation down with the one file it could not name.
  const dir = tmpDir();
  const payload = Buffer.from('bytes');
  const receiver = createFileReceiver({
    dir,
    store,
    maxBytes: 1024,
    exists: () => {
      throw Object.assign(new Error('EIO: i/o error, stat'), { code: 'EIO' });
    },
  });

  receiver.offer({ id: 'x', name: 'x.bin', size: payload.length, sha256: sha(payload) });
  receiver.chunk({ id: 'x', data: payload.toString('base64') });
  const done = receiver.done({ id: 'x' });

  assert.equal(done.ok, false);
  assert.match(done.reason, /EIO/);
  assert.equal(receiver.inFlight(), 0);
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing half-written left behind');
});

test('admitOffer answers on the numbers alone', () => {
  const room = { maxBytes: 100, maxTransfers: 2, maxBufferedBytes: 150 };
  assert.equal(admitOffer({ declared: 10, ...room }).accepted, true);
  assert.equal(admitOffer({ declared: Number.NaN, ...room }).reason, 'bad size');
  assert.equal(admitOffer({ declared: -1, ...room }).reason, 'bad size');
  assert.match(admitOffer({ declared: 101, ...room }).reason, /too large/i);
  assert.match(admitOffer({ declared: 10, transfers: 2, ...room }).reason, /too many/i);
  assert.match(admitOffer({ declared: 100, reserved: 100, ...room }).reason, /in flight/i);
  assert.equal(
    admitOffer({ declared: 50, transfers: 1, reserved: 100, ...room }).accepted, true,
    'a transfer that exactly fills the remaining room is allowed',
  );
});
