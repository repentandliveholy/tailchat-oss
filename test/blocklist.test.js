import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readBlocklist, blockLogin, unblockLogin, isBlocked,
} from '../src/blocklist.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-blocklist-'));

test('a blocked login round-trips through the file', () => {
  const dir = tempDir();
  try {
    assert.equal(isBlocked(dir, 'roman@example.com'), false, 'nothing blocked yet');
    assert.equal(blockLogin(dir, 'roman@example.com'), true);
    assert.equal(isBlocked(dir, 'roman@example.com'), true);
    assert.equal(isBlocked(dir, 'ROMAN@EXAMPLE.COM'), true, 'case-folded like roster logins');
    assert.deepEqual(readBlocklist(dir), { logins: { 'roman@example.com': true } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unblocking removes the login and persists', () => {
  const dir = tempDir();
  try {
    blockLogin(dir, 'roman@example.com');
    blockLogin(dir, 'anna@example.com');
    assert.equal(unblockLogin(dir, 'roman@example.com'), true);
    assert.equal(isBlocked(dir, 'roman@example.com'), false);
    assert.equal(isBlocked(dir, 'anna@example.com'), true, 'unrelated block untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('block and unblock are idempotent', () => {
  const dir = tempDir();
  try {
    assert.equal(blockLogin(dir, 'roman@example.com'), true);
    assert.equal(blockLogin(dir, 'roman@example.com'), true, 'blocking twice is not an error');
    assert.deepEqual(readBlocklist(dir).logins, { 'roman@example.com': true });

    assert.equal(unblockLogin(dir, 'nobody@example.com'), false, 'unblocking someone never blocked is a no-op, not an error');
    assert.equal(unblockLogin(dir, 'roman@example.com'), true);
    assert.equal(unblockLogin(dir, 'roman@example.com'), false, 'a second unblock has nothing left to remove');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('logins are normalised the same way roster.js folds them', () => {
  const dir = tempDir();
  try {
    assert.equal(blockLogin(dir, '  Roman@Example.com  '), true);
    assert.equal(isBlocked(dir, 'roman@example.com'), true);
    assert.equal(blockLogin(dir, ''), false, 'nothing to block');
    assert.equal(blockLogin(dir, null), false);
    assert.equal(isBlocked(dir, ''), false);
    assert.equal(isBlocked(dir, null), false);
    assert.equal(blockLogin(dir, 'x'.repeat(255)), false, 'a login nobody could have is not one');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged blocklist reads as empty instead of crashing the client', () => {
  const dir = tempDir();
  try {
    assert.deepEqual(readBlocklist(dir), { logins: {} }, 'no file at all');

    fs.writeFileSync(path.join(dir, 'blocked.json'), 'not json');
    assert.deepEqual(readBlocklist(dir), { logins: {} });

    fs.writeFileSync(path.join(dir, 'blocked.json'), JSON.stringify({ logins: ['', 'ok@example.com', 'x'.repeat(300)] }));
    assert.deepEqual(readBlocklist(dir), { logins: { 'ok@example.com': true } });

    fs.writeFileSync(path.join(dir, 'blocked.json'), JSON.stringify({ logins: 'not-an-array' }));
    assert.deepEqual(readBlocklist(dir), { logins: {} });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two people are kept apart', () => {
  const dir = tempDir();
  try {
    blockLogin(dir, 'a@example.com');
    assert.equal(isBlocked(dir, 'a@example.com'), true);
    assert.equal(isBlocked(dir, 'b@example.com'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
