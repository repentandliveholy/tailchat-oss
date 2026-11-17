import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readRoster, rememberDevices, lookupRoster, rosterAddresses, sanitiseDevices,
  sanitiseNames, rosterSelectors, isSelfAnnouncement, forgetDevices,
} from '../src/roster.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-roster-'));

const DEVICES = [
  { host: 'desktop-iru', dns: 'desktop-iru.tailc80816.ts.net', ips: ['100.105.157.69'] },
  { host: 'DESKTOP-AG8B8U4', dns: '', ips: ['100.74.56.8'] },
];

test('a login learned once can be named instead of an address', () => {
  const dir = tempDir();
  try {
    assert.equal(rememberDevices(dir, 'alice@example.com', DEVICES), true);

    // The whole login, the part before the @, a device name, or an address:
    // the same latitude the CLI-backed lookup allows.
    for (const selector of [
      'alice@example.com', 'alice', 'desktop-iru',
      'desktop-iru.tailc80816.ts.net', '100.105.157.69',
    ]) {
      const found = lookupRoster(dir, selector);
      assert.ok(found, `${selector} was not matched`);
      assert.equal(found.login, 'alice@example.com');
    }
    assert.deepEqual(rosterAddresses(lookupRoster(dir, 'alice')), [
      '100.105.157.69', '100.74.56.8',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a name nobody claimed matches nothing rather than the first entry', () => {
  const dir = tempDir();
  try {
    rememberDevices(dir, 'alice@example.com', DEVICES);
    assert.equal(lookupRoster(dir, 'someone-else'), null);
    assert.equal(lookupRoster(dir, ''), null);
    assert.equal(lookupRoster(dir, null), null);
    assert.deepEqual(rosterAddresses(null), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a later list replaces the earlier one, so a retired device is forgotten', () => {
  const dir = tempDir();
  try {
    rememberDevices(dir, 'me@example.com', DEVICES);
    rememberDevices(dir, 'me@example.com', [{ host: 'laptop', ips: ['100.64.0.9'] }]);
    assert.deepEqual(rosterAddresses(lookupRoster(dir, 'me@example.com')), ['100.64.0.9']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two people are kept apart', () => {
  const dir = tempDir();
  try {
    rememberDevices(dir, 'a@example.com', [{ host: 'one', ips: ['100.64.0.1'] }]);
    rememberDevices(dir, 'b@example.com', [{ host: 'two', ips: ['100.64.0.2'] }]);
    assert.equal(lookupRoster(dir, 'a').login, 'a@example.com');
    assert.equal(lookupRoster(dir, 'two').login, 'b@example.com');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a peer cannot fill the roster with junk it made up', () => {
  // The list arrives over the wire, so it is data, not instructions: a device
  // without an address cannot be dialled, and the rest is bounded.
  assert.deepEqual(sanitiseDevices(null), []);
  assert.deepEqual(sanitiseDevices([{ host: 'no-address' }]), []);
  assert.deepEqual(sanitiseDevices([{ ips: ['not an ip'] }]), []);
  assert.deepEqual(
    sanitiseDevices([{ host: 'A', ips: ['100.64.0.1'] }]),
    [{ host: 'a', dns: null, ips: ['100.64.0.1'] }],
    'names are folded so matching does not depend on case',
  );
  // Duplicates and an unbounded list would grow the file forever.
  assert.equal(sanitiseDevices(Array.from({ length: 50 }, (_, n) => ({
    host: `h${n}`, ips: [`100.64.0.${n}`],
  }))).length, 20);
  assert.equal(sanitiseDevices([
    { host: 'a', ips: ['100.64.0.1'] },
    { host: 'b', ips: ['100.64.0.1'] },
  ]).length, 1);
});

test('a damaged roster reads as empty instead of crashing the client', () => {
  const dir = tempDir();
  try {
    assert.deepEqual(readRoster(dir), { logins: {} }, 'no file at all');

    fs.writeFileSync(path.join(dir, 'roster.json'), 'not json');
    assert.deepEqual(readRoster(dir), { logins: {} });

    fs.writeFileSync(path.join(dir, 'roster.json'), JSON.stringify({ logins: { '': {} } }));
    assert.deepEqual(readRoster(dir), { logins: {} });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nothing is written for a login or a list that says nothing', () => {
  const dir = tempDir();
  try {
    assert.equal(rememberDevices(dir, '', DEVICES), false);
    assert.equal(rememberDevices(dir, 'me@example.com', []), false);
    assert.deepEqual(readRoster(dir), { logins: {} });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the name shown in the chat also reaches the person', () => {
  const dir = tempDir();
  try {
    // The header says `godsheep`, so that is what the other side types first —
    // even though Tailscale has never heard of it.
    rememberDevices(dir, 'bob@example.com', DEVICES, ['godsheep']);
    const found = lookupRoster(dir, 'godsheep');
    assert.ok(found, 'the chat name was not matched');
    assert.equal(found.login, 'bob@example.com');
    assert.equal(lookupRoster(dir, 'GODSHEEP').login, 'bob@example.com');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a person keeps the names they were known by', () => {
  const dir = tempDir();
  try {
    rememberDevices(dir, 'me@example.com', DEVICES, ['onlaptop']);
    rememberDevices(dir, 'me@example.com', DEVICES, ['onphone']);
    // Renaming on one machine must not make the other name stop working.
    assert.ok(lookupRoster(dir, 'onlaptop'));
    assert.ok(lookupRoster(dir, 'onphone'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a peer cannot bury the roster under names it made up', () => {
  assert.deepEqual(sanitiseNames(null), []);
  assert.deepEqual(sanitiseNames(['A', 'a', '', '  ']), ['a'], 'folded and de-duplicated');
  assert.equal(sanitiseNames(Array.from({ length: 40 }, (_, n) => `n${n}`)).length, 5);
  assert.deepEqual(sanitiseNames(['x'.repeat(100)]), [], 'a name nobody could type is not one');
});

test('a dead end can name its own way out', () => {
  const dir = tempDir();
  try {
    rememberDevices(dir, 'me@example.com', DEVICES, ['godsheep']);
    assert.deepEqual(rosterSelectors(dir), [{
      login: 'me@example.com',
      names: ['godsheep'],
      devices: ['desktop-iru', 'desktop-ag8b8u4'],
    }]);
    assert.deepEqual(rosterSelectors(tempDir()), [], 'nothing learned yet, nothing to offer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isSelfAnnouncement: own login or own ip means the frame is us', () => {
  const self = { login: 'me@example.com', ips: ['100.71.187.60', 'fd7a:115c:a1e0::1'] };
  assert.equal(isSelfAnnouncement({ login: 'ME@example.com', devices: [] }, self), true);
  assert.equal(isSelfAnnouncement({ login: 'someone@else.com', devices: [{ ips: ['100.71.187.60'] }] }, self), true);
  assert.equal(isSelfAnnouncement({ login: null, devices: [{ ips: ['FD7A:115C:A1E0::1'] }] }, self), true);
  assert.equal(isSelfAnnouncement({ login: 'someone@else.com', devices: [{ ips: ['100.90.1.1'] }] }, self), false);
  assert.equal(isSelfAnnouncement({ login: 'me@example.com', devices: [] }, null), false);
});

test('forgetDevices: removes the login and persists; absent key is a no-op', () => {
  const dir = tempDir();
  try {
    rememberDevices(dir, 'me@example.com', DEVICES);
    rememberDevices(dir, 'roman@example.com', DEVICES);
    assert.equal(forgetDevices(dir, 'me@example.com'), true);
    assert.equal(lookupRoster(dir, 'me@example.com'), null);
    assert.ok(lookupRoster(dir, 'roman@example.com'));
    assert.equal(forgetDevices(dir, 'nobody@example.com'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rosterSelectors and lookupRoster never offer the local user', () => {
  const dir = tempDir();
  try {
    rememberDevices(dir, 'me@example.com', [
      { host: 'macbook-pro', dns: 'macbook-pro.tail6ab02b.ts.net', ips: ['100.122.98.16'] },
    ]);
    rememberDevices(dir, 'roman@example.com', DEVICES);
    // Termux parity: no CLI, so only the local address is known.
    const self = { login: null, ips: ['100.122.98.16'] };
    assert.deepEqual(rosterSelectors(dir, self).map((s) => s.login), ['roman@example.com']);
    assert.equal(lookupRoster(dir, 'me@example.com', self), null);
    assert.equal(lookupRoster(dir, 'macbook-pro', self), null);
    assert.ok(lookupRoster(dir, 'roman@example.com', self));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rosterSelectors: a login match also excludes self', () => {
  const dir = tempDir();
  try {
    rememberDevices(dir, 'me@example.com', [{ host: 'x', dns: '', ips: ['100.50.50.1'] }]);
    assert.deepEqual(rosterSelectors(dir, { login: 'me@example.com', ips: [] }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
