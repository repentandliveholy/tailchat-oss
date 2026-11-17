import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeListenerPid, readListenerPid, clearListenerPid, isAlive,
  readListenerPeer, lockVerdict,
} from '../src/listener.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-listener-'));

test('a listening client leaves a note another one can read', () => {
  const dir = tempDir();
  try {
    assert.equal(writeListenerPid(dir, 4747, 4242), true);
    assert.equal(readListenerPid(dir, 4747, { alive: () => true }), 4242);
    // The note is per port: a client on another port must not be blamed.
    assert.equal(readListenerPid(dir, 4748, { alive: () => true }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a note left by a dead process is ignored', () => {
  const dir = tempDir();
  try {
    writeListenerPid(dir, 4747, 4242);
    // Otherwise a crash would tell the next run to kill a pid that has since
    // been recycled by something unrelated.
    assert.equal(readListenerPid(dir, 4747, { alive: () => false }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a client never reports itself as the culprit', () => {
  const dir = tempDir();
  try {
    writeListenerPid(dir, 4747, 777);
    assert.equal(readListenerPid(dir, 4747, { alive: () => true, self: 777 }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or damaged note reports nothing rather than guessing', () => {
  const dir = tempDir();
  try {
    assert.equal(readListenerPid(dir, 4747), null, 'no note at all');

    fs.writeFileSync(path.join(dir, 'listener-4747.pid'), 'not a number');
    assert.equal(readListenerPid(dir, 4747, { alive: () => true }), null);

    fs.writeFileSync(path.join(dir, 'listener-4747.pid'), '');
    assert.equal(readListenerPid(dir, 4747, { alive: () => true }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the note is removed when the client releases the port', () => {
  const dir = tempDir();
  try {
    writeListenerPid(dir, 4747, 4242);
    assert.equal(clearListenerPid(dir, 4747), true);
    assert.equal(readListenerPid(dir, 4747, { alive: () => true }), null);
    // Clearing twice is normal: shutdown and /update both do it.
    assert.equal(clearListenerPid(dir, 4747), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('liveness is checked without touching the process', () => {
  const signals = [];
  assert.equal(isAlive(1234, (pid, signal) => { signals.push([pid, signal]); }), true);
  // Signal 0 asks the kernel; anything else would actually hit the process.
  assert.deepEqual(signals, [[1234, 0]]);

  const gone = () => { const err = new Error('no such process'); err.code = 'ESRCH'; throw err; };
  assert.equal(isAlive(1234, gone), false);

  // A process owned by another user exists, even though we may not signal it.
  const foreign = () => { const err = new Error('denied'); err.code = 'EPERM'; throw err; };
  assert.equal(isAlive(1234, foreign), true);

  assert.equal(isAlive(0), false, 'pid 0 is not a process to kill');
  assert.equal(isAlive(1), false, 'pid 1 is never our forgotten client');
  assert.equal(isAlive(Number.NaN), false);
});

test('a real live process is recognised', () => {
  assert.equal(isAlive(process.pid), true);
});

test('the conversation is recorded beside the pid, not inside it', () => {
  const dir = tempDir();
  try {
    writeListenerPid(dir, 4747, 4242, 'roman@example.com');
    assert.equal(readListenerPeer(dir, 4747), 'roman@example.com');
    // A client older than this release parses the pid file with parseInt, so the
    // conversation must not land in it: NaN there would read as "a stranger holds
    // the port" and it would dial in parallel.
    assert.equal(readListenerPid(dir, 4747, { alive: () => true }), 4242);
    assert.equal(fs.readFileSync(path.join(dir, 'listener-4747.pid'), 'utf8'), '4242');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a note without a conversation reports none rather than guessing', () => {
  const dir = tempDir();
  try {
    writeListenerPid(dir, 4747, 4242);
    assert.equal(readListenerPeer(dir, 4747), null, 'no .peer file written');

    fs.writeFileSync(path.join(dir, 'listener-4747.peer'), '   ');
    assert.equal(readListenerPeer(dir, 4747), null, 'blank is not a conversation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('releasing the port removes the conversation note too', () => {
  const dir = tempDir();
  try {
    writeListenerPid(dir, 4747, 4242, 'roman');
    clearListenerPid(dir, 4747);
    // Left behind, it would name the wrong conversation for the next client.
    assert.equal(readListenerPeer(dir, 4747), null);
    assert.equal(readListenerPid(dir, 4747, { alive: () => true }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the lock is keyed on the conversation, so two chats coexist', () => {
  // The lock exists to stop two clients fighting over ONE peer's channel. Two
  // different conversations have nothing to fight over, and standing down left
  // the second chat permanently dead.
  assert.equal(
    lockVerdict({ holderPid: 4242, holderPeer: 'alice', myPeer: 'bob' }),
    'coexist',
  );
  assert.equal(
    lockVerdict({ holderPid: 4242, holderPeer: 'alice', myPeer: 'alice' }),
    'takeover',
  );
});

test('no live holder leaves the port to whoever actually has it', () => {
  assert.equal(lockVerdict({ holderPid: null, holderPeer: null, myPeer: 'alice' }), 'free');
});

test('an unnamed conversation keeps the old cautious behaviour', () => {
  // An older holder left a pid and no .peer file. Killing a process whose
  // conversation cannot be named is not ours to do, and dialling beside it risks
  // the flapping the lock prevents.
  assert.equal(lockVerdict({ holderPid: 4242, holderPeer: null, myPeer: 'alice' }), 'stand-down');
  assert.equal(lockVerdict({ holderPid: 4242, holderPeer: 'alice', myPeer: null }), 'stand-down');
});
