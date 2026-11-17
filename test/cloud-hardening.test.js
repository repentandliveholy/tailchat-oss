// Public-release hardening: the knobs a self-hosted server can turn on, and the
// limiter keys that stop one IPv6 host from looking like billions of clients.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAccountStore as createLegacyStore } from '../src/cloud/accounts.js';
import { limiterAddress } from '../src/cloud/server.js';

const DAY = 24 * 60 * 60 * 1000;

function withStore(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-hardening-'));
  let clock = 1_756_500_000_000;
  const store = createLegacyStore({
    allowPlaintextLegacy: true, keyFile: null, dir, now: () => clock, writeDelayMs: 5000, ...options,
  });
  t.after(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, advance: (ms) => { clock += ms; } };
}

test('limiterAddress counts IPv6 per /64 and IPv4-mapped as IPv4', () => {
  assert.equal(limiterAddress('203.0.113.7'), '203.0.113.7');
  assert.equal(limiterAddress('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(limiterAddress('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(limiterAddress('2001:db8:1:2::1'), limiterAddress('2001:db8:1:2:ffff::9'));
  assert.notEqual(limiterAddress('2001:db8:1:2::1'), limiterAddress('2001:db8:1:3::1'));
  assert.equal(limiterAddress('::1'), '0:0:0:0::/64');
  assert.equal(limiterAddress('unknown'), 'unknown');
});

test('token idle expiry is off by default', async (t) => {
  const { store, advance } = withStore(t);
  const { token } = await store.register({ login: 'anna', password: 'longenough' });
  advance(3650 * DAY);
  assert.equal(store.resolveToken(token)?.login, 'anna');
});

test('an idle token stops working once TOKEN_IDLE_DAYS is set, a used one does not', async (t) => {
  const { store, advance } = withStore(t, { tokenIdleDays: 30 });
  const { token: kept } = await store.register({ login: 'anna', password: 'longenough' });
  const { token: idle } = await store.register({ login: 'boris', password: 'longenough' });
  for (let day = 0; day < 40; day += 10) {
    advance(10 * DAY);
    assert.equal(store.resolveToken(kept)?.login, 'anna');
  }
  assert.equal(store.resolveToken(idle), null);
  // Gone for good, not merely refused this once.
  assert.equal(store.resolveToken(idle), null);
});

test('PASSWORD_MIN applies to new passwords only, never to signing in', async (t) => {
  const { store } = withStore(t, { passwordMin: 1 });
  await store.register({ login: 'anna', password: 'abc' });

  const strict = withStore(t, { passwordMin: 10 });
  const refused = await strict.store.register({ login: 'boris', password: 'short' });
  assert.equal(refused.code, 'invalid_password');
  const ok = await strict.store.register({ login: 'boris', password: 'long enough pw' });
  assert.equal(ok.ok, true);
  const change = await strict.store.updateProfile({
    login: 'boris', currentPassword: 'long enough pw', newPassword: 'tiny',
  });
  assert.equal(change.code, 'invalid_password');
});

test('the served installer is the same file as the one in the repository root', () => {
  const root = fs.readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
  const served = fs.readFileSync(new URL('../web/cloud/install.sh', import.meta.url), 'utf8');
  assert.equal(served, root, 'copy install.sh to web/cloud/install.sh');
  assert.doesNotMatch(root, /\|\s*sudo\b/, 'no remote script is piped into sudo');
});
