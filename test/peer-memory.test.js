import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPeerMemory } from '../src/peer-memory.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-mem-'));

test('a fresh memory knows nothing', () => {
  const memory = createPeerMemory({ dir: tmp(), key: 'roman@example.com' });
  assert.equal(memory.lastHost(), null);
  assert.equal(memory.lastAddress(), null);
  assert.equal(memory.nickname(), null);
});

test('the last device survives a restart', () => {
  const dir = tmp();
  const first = createPeerMemory({ dir, key: 'roman@example.com' });
  first.remember({ host: 'roman-phone', address: '100.99.1.1' });

  const reopened = createPeerMemory({ dir, key: 'roman@example.com' });
  assert.equal(reopened.lastHost(), 'roman-phone');
  assert.equal(reopened.lastAddress(), '100.99.1.1');
});

test('a nickname survives a restart, and remembering a device does not erase it', () => {
  const dir = tmp();
  const first = createPeerMemory({ dir, key: 'roman@example.com' });
  first.setNickname('Ромыч');
  // A reconnect calls remember() for the device — that write must not
  // silently drop the nickname the person chose, only refresh the device.
  first.remember({ host: 'roman-phone', address: '100.99.1.1' });
  assert.equal(first.nickname(), 'Ромыч');

  const reopened = createPeerMemory({ dir, key: 'roman@example.com' });
  assert.equal(reopened.nickname(), 'Ромыч');
  assert.equal(reopened.lastHost(), 'roman-phone');
});

test('clearing a nickname is the way back to the peer\'s own name', () => {
  const dir = tmp();
  const memory = createPeerMemory({ dir, key: 'roman@example.com' });
  memory.setNickname('Ромыч');
  memory.setNickname(null);
  assert.equal(memory.nickname(), null);
  // Blank and whitespace-only both read as clearing it, not as a literal name.
  memory.setNickname('Ромыч');
  memory.setNickname('   ');
  assert.equal(memory.nickname(), null);
});

test('each peer keeps its own memory', () => {
  const dir = tmp();
  createPeerMemory({ dir, key: 'roman@example.com' }).remember({ host: 'a', address: '1.1.1.1' });
  createPeerMemory({ dir, key: 'elisabeth@example.com' }).remember({ host: 'b', address: '2.2.2.2' });

  assert.equal(createPeerMemory({ dir, key: 'roman@example.com' }).lastHost(), 'a');
  assert.equal(createPeerMemory({ dir, key: 'elisabeth@example.com' }).lastHost(), 'b');
});

test('the file is owner-only because it records who you talk to', () => {
  const dir = tmp();
  const memory = createPeerMemory({ dir, key: 'roman@example.com' });
  memory.remember({ host: 'roman-phone', address: '100.99.1.1' });
  assert.equal(fs.statSync(memory.file).mode & 0o777, 0o600);
});

test('a key that looks like a path cannot escape the directory', () => {
  const dir = tmp();
  const memory = createPeerMemory({ dir, key: '../../etc/passwd' });
  memory.remember({ host: 'x', address: '1.1.1.1' });
  assert.equal(path.dirname(memory.file), dir);
});

test('a corrupted file is ignored rather than fatal', () => {
  const dir = tmp();
  const memory = createPeerMemory({ dir, key: 'roman@example.com' });
  fs.writeFileSync(memory.file, '{ not json');

  const reopened = createPeerMemory({ dir, key: 'roman@example.com' });
  assert.equal(reopened.lastHost(), null);
  reopened.remember({ host: 'fresh', address: '3.3.3.3' });
  assert.equal(createPeerMemory({ dir, key: 'roman@example.com' }).lastHost(), 'fresh');
});

test('remembering again replaces the previous device', () => {
  const dir = tmp();
  const memory = createPeerMemory({ dir, key: 'roman@example.com' });
  memory.remember({ host: 'desktop', address: '100.1.1.1' });
  memory.remember({ host: 'phone', address: '100.2.2.2' });

  assert.equal(createPeerMemory({ dir, key: 'roman@example.com' }).lastHost(), 'phone');
  assert.equal(createPeerMemory({ dir, key: 'roman@example.com' }).lastAddress(), '100.2.2.2');
});

test('a successful remember says so', () => {
  const memory = createPeerMemory({ dir: tmp(), key: 'roman@example.com' });
  assert.deepEqual(memory.remember({ host: 'desktop', address: '100.1.1.1' }), { ok: true });
});

test('a locked memory file is reported instead of ending the connection', () => {
  // Windows answers the rename with EPERM while antivirus holds the file; the
  // same throw used to escape through the connection handlers.
  const memory = createPeerMemory({
    dir: '/state',
    key: 'roman@example.com',
    mkdir: () => {},
    writeFile: () => {},
    rename: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
    chmod: () => {},
  });

  const result = memory.remember({ host: 'phone', address: '100.2.2.2' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EPERM');
  assert.equal(memory.lastHost(), null, 'memory and disk still agree');
});

test('a failed write leaves the device remembered before it in place', () => {
  let allow = true;
  const memory = createPeerMemory({
    dir: '/state',
    key: 'roman@example.com',
    mkdir: () => {},
    writeFile: () => {},
    rename: () => { if (!allow) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); },
    chmod: () => {},
  });

  memory.remember({ host: 'desktop', address: '100.1.1.1' });
  allow = false;
  assert.equal(memory.remember({ host: 'phone', address: '100.2.2.2' }).ok, false);
  assert.equal(memory.lastHost(), 'desktop');
  assert.equal(memory.lastAddress(), '100.1.1.1');
});
