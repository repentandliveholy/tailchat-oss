import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAccountStore as createLegacyStore } from '../src/cloud/accounts.js';
import { CLOUD_MEDIA_MAX_CHARS } from '../src/cloud/limits.js';
import { createJournal } from '../src/cloud/journal.js';

const createAccountStore = (options) => createLegacyStore({ allowPlaintextLegacy: true, keyFile: null, ...options });

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-cloud-accounts-'));
}

function openStore(dir, { start = 1_756_500_000_000, writeDelayMs = 5000, ...rest } = {}) {
  let clock = start;
  const store = createAccountStore({
    dir, now: () => clock, writeDelayMs, ...rest,
  });
  return { store, advance: (ms) => { clock += ms; return clock; }, at: () => clock };
}

function withStore(t, options) {
  const dir = tempDir();
  const opened = openStore(dir, options);
  t.after(async () => {
    await opened.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file: path.join(dir, 'accounts.json'), ...opened };
}

function readFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('register normalises the login, keeps the name and issues a token', async (t) => {
  const { store, file } = withStore(t);

  const created = await store.register({ login: '  ROMAN  ', password: 'correct horse', name: '  Роман  ' });
  assert.equal(created.ok, true);
  assert.deepEqual(created.user, { login: 'roman', name: 'Роман', extraPasswordEnabled: false });
  assert.match(created.token, /^[0-9a-f]{64}$/);

  await store.flush();
  const saved = readFile(file);
  assert.equal(saved.version, 1);
  assert.equal(saved.accounts.roman.login, 'roman');
  assert.match(saved.accounts.roman.salt, /^[0-9a-f]{32}$/);
  assert.match(saved.accounts.roman.hash, /^[0-9a-f]{128}$/);
  assert.equal(saved.accounts.roman.createdAt, 1_756_500_000_000);
});

test('an empty name falls back to the login and a name that sanitises away is refused', async (t) => {
  const { store } = withStore(t);

  const blank = await store.register({ login: 'anna', password: 'longenough', name: '   ' });
  assert.deepEqual(blank.user, { login: 'anna', name: 'anna', extraPasswordEnabled: false });

  const missing = await store.register({ login: 'boris', password: 'longenough' });
  assert.deepEqual(missing.user, { login: 'boris', name: 'boris', extraPasswordEnabled: false });

  assert.deepEqual(await store.register({ login: 'vera', password: 'longenough', name: '🙂' }), {
    ok: false,
    code: 'invalid_name',
  });
  assert.deepEqual(await store.register({ login: 'vera', password: 'longenough', name: 42 }), {
    ok: false,
    code: 'invalid_name',
  });
});

test('register reports every validation code', async (t) => {
  const { store } = withStore(t);

  for (const login of ['ab', 'Роман', 'bad login', '_leading', 'x'.repeat(33), '']) {
    assert.deepEqual(await store.register({ login, password: 'longenough' }), {
      ok: false,
      code: 'invalid_login',
    }, `login ${JSON.stringify(login)}`);
  }

  for (const password of ['', 'x'.repeat(201), 12345678, null]) {
    assert.deepEqual(await store.register({ login: 'roman', password }), {
      ok: false,
      code: 'invalid_password',
    }, `password ${JSON.stringify(password)}`);
  }

  assert.equal((await store.register({ login: 'roman', password: '123' })).ok, true);
  assert.deepEqual(await store.register({ login: 'ROMAN', password: 'otherpassword' }), {
    ok: false,
    code: 'login_taken',
  });
});

test('recover resets password with valid recovery key and rejects invalid key', async (t) => {
  const { store } = withStore(t);
  const registered = await store.register({ login: 'roman', password: 'oldpassword', name: 'Роман' });
  assert.equal(registered.ok, true);
  assert.ok(registered.recoveryKey);

  // Wrong recovery key
  const bad = await store.recover({ login: 'roman', recoveryKey: 'TC-0000-0000-0000-0000', newPassword: 'newpassword' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_recovery_key');

  // Correct recovery key
  const recovered = await store.recover({ login: 'roman', recoveryKey: registered.recoveryKey, newPassword: 'newpassword' });
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.user, { login: 'roman', name: 'Роман', extraPasswordEnabled: false });
  assert.ok(recovered.token);
  assert.ok(recovered.newRecoveryKey);
  assert.notEqual(recovered.newRecoveryKey, registered.recoveryKey);

  // Old password no longer works
  assert.equal((await store.login({ login: 'roman', password: 'oldpassword' })).ok, false);

  // New password works
  assert.equal((await store.login({ login: 'roman', password: 'newpassword' })).ok, true);
});
test('profile update changes the display name and verifies the current password', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'roman', password: 'oldpassword', name: 'Роман' });

  assert.deepEqual(await store.updateProfile({ login: 'roman', name: 'Рома' }), {
    ok: true,
    user: { login: 'roman', name: 'Рома', extraPasswordEnabled: false },
  });
  assert.deepEqual(await store.updateProfile({
    login: 'roman',
    currentPassword: 'wrongpassword',
    newPassword: 'newpassword',
  }), { ok: false, code: 'bad_credentials' });

  const changed = await store.updateProfile({
    login: 'roman',
    currentPassword: 'oldpassword',
    newPassword: 'newpassword',
  });
  assert.deepEqual(changed, { ok: true, user: { login: 'roman', name: 'Рома', extraPasswordEnabled: false } });
  assert.equal(store.langOf('roman'), 'ru');
  const langUpdated = await store.updateProfile({ login: 'roman', lang: 'en' });
  assert.equal(langUpdated.ok, true);
  assert.equal(store.langOf('roman'), 'en');
});

test('an additional password gates login once set, can be changed or cleared, and survives a reopen', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { store } = openStore(dir);
  await store.register({ login: 'roman', password: 'oldpassword', name: 'Роман' });

  // No additional password yet: the primary one is enough, and the account
  // reports the feature off.
  const before = await store.login({ login: 'roman', password: 'oldpassword' });
  assert.equal(before.ok, true);
  assert.equal(before.user.extraPasswordEnabled, false);

  // Setting one without the current password proves nothing and is refused,
  // same rule as changing the primary password.
  assert.deepEqual(
    await store.updateProfile({ login: 'roman', extraPassword: 'extrasecret' }),
    { ok: false, code: 'bad_credentials' },
  );
  assert.equal((await store.login({ login: 'roman', password: 'oldpassword' })).ok, true, 'still unset');

  const set = await store.updateProfile({
    login: 'roman', currentPassword: 'oldpassword', extraPassword: 'extrasecret',
  });
  assert.equal(set.ok, true);
  assert.equal(set.user.extraPasswordEnabled, true);

  // The primary password alone now names the requirement instead of logging
  // in — this is the step `handleLogin` in server.js answers plainly rather
  // than folding into `bad_credentials`.
  assert.deepEqual(
    await store.login({ login: 'roman', password: 'oldpassword' }),
    { ok: false, code: 'extra_password_required' },
  );
  assert.deepEqual(
    await store.login({ login: 'roman', password: 'oldpassword', extraPassword: 'wrong' }),
    { ok: false, code: 'bad_credentials' },
  );
  const in1 = await store.login({ login: 'roman', password: 'oldpassword', extraPassword: 'extrasecret' });
  assert.equal(in1.ok, true);
  assert.equal(in1.user.extraPasswordEnabled, true);

  // Changing it retires the old value immediately.
  const changed = await store.updateProfile({
    login: 'roman', currentPassword: 'oldpassword', extraPassword: 'secondsecret',
  });
  assert.equal(changed.ok, true);
  assert.deepEqual(
    await store.login({ login: 'roman', password: 'oldpassword', extraPassword: 'extrasecret' }),
    { ok: false, code: 'bad_credentials' },
  );
  assert.equal(
    (await store.login({ login: 'roman', password: 'oldpassword', extraPassword: 'secondsecret' })).ok, true,
  );

  // Clearing it (empty string, not omitted) removes the requirement again.
  const cleared = await store.updateProfile({
    login: 'roman', currentPassword: 'oldpassword', extraPassword: '',
  });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.user.extraPasswordEnabled, false);
  const in2 = await store.login({ login: 'roman', password: 'oldpassword' });
  assert.equal(in2.ok, true);
  assert.equal(in2.user.extraPasswordEnabled, false);

  // Re-set it, then reopen the store from disk: a restart must not silently
  // drop the requirement (this is what `adoptState`'s account whitelist has
  // to carry through).
  await store.updateProfile({ login: 'roman', currentPassword: 'oldpassword', extraPassword: 'thirdsecret' });
  await store.flush();
  await store.close();

  const reopened = createAccountStore({ dir });
  t.after(() => reopened.close());
  assert.deepEqual(
    await reopened.login({ login: 'roman', password: 'oldpassword' }),
    { ok: false, code: 'extra_password_required' },
  );
  const reopenedIn = await reopened.login({ login: 'roman', password: 'oldpassword', extraPassword: 'thirdsecret' });
  assert.equal(reopenedIn.ok, true);
});

test('recovering the account with the emergency key also clears an additional password', async (t) => {
  const { store } = withStore(t);
  const registered = await store.register({ login: 'roman', password: 'oldpassword', name: 'Роман' });
  await store.updateProfile({ login: 'roman', currentPassword: 'oldpassword', extraPassword: 'extrasecret' });
  assert.deepEqual(
    await store.login({ login: 'roman', password: 'oldpassword' }),
    { ok: false, code: 'extra_password_required' },
  );

  // Someone who forgot both has no other way back in — leaving the second
  // one standing after the recovery key already re-keyed everything else
  // would be a permanent lockout, not extra security.
  const recovered = await store.recover({
    login: 'roman', recoveryKey: registered.recoveryKey, newPassword: 'newpassword',
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.user.extraPasswordEnabled, false);

  const after = await store.login({ login: 'roman', password: 'newpassword' });
  assert.equal(after.ok, true);
  assert.equal(after.user.extraPasswordEnabled, false);
});


test('login answers bad_credentials for a wrong password, an unknown and a malformed login', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'roman', password: 'correct horse', name: 'Роман' });

  const ok = await store.login({ login: 'Roman', password: 'correct horse' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.user, { login: 'roman', name: 'Роман', extraPasswordEnabled: false });
  assert.match(ok.token, /^[0-9a-f]{64}$/);

  for (const attempt of [
    { login: 'roman', password: 'correct horsf' },
    { login: 'roman', password: '' },
    { login: 'nobody', password: 'correct horse' },
    { login: 'bad login', password: 'correct horse' },
  ]) {
    assert.deepEqual(await store.login(attempt), { ok: false, code: 'bad_credentials' }, JSON.stringify(attempt));
  }
});

test('tokens resolve, refresh lastUsed, revoke once and never reach the file in the clear', async (t) => {
  const { store, file, advance } = withStore(t);
  const { token } = await store.register({ login: 'roman', password: 'longenough', name: 'Роман' });

  assert.deepEqual(store.resolveToken(token), { login: 'roman', name: 'Роман', extraPasswordEnabled: false });
  assert.equal(store.resolveToken(`${token}x`), null);
  assert.equal(store.resolveToken(''), null);
  assert.equal(store.resolveToken(undefined), null);

  const used = advance(60_000);
  assert.deepEqual(store.resolveToken(token), { login: 'roman', name: 'Роман', extraPasswordEnabled: false });

  await store.flush();
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes(token), false);
  const digest = crypto.createHash('sha256').update(token).digest('hex');
  assert.deepEqual(readFile(file).tokens[digest], {
    login: 'roman',
    createdAt: 1_756_500_000_000,
    lastUsed: used,
  });

  assert.equal(store.revokeToken(token), true);
  assert.equal(store.revokeToken(token), false);
  assert.equal(store.resolveToken(token), null);
});

test('accounts survive a reopen and the store writes with restrictive modes', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'accounts.json');

  const first = openStore(dir);
  await first.store.register({ login: 'roman', password: 'longenough', name: 'Роман' });
  first.store.enqueue('roman', { from: 'anna', d: { t: 'msg', text: 'позже' }, at: 5 });
  first.store.recordHistory('roman', 'anna', { id: 'm1', from: 'anna', text: 'привет', ts: 7, kind: 'human' });
  assert.equal(fs.existsSync(file), false, 'writes are coalesced, not immediate');
  await first.store.close();

  assert.equal(fs.existsSync(`${file}.tmp`), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }

  const second = openStore(dir);
  t.after(() => second.store.close());
  assert.deepEqual(second.store.users(), [{ login: 'roman', name: 'Роман', lastSeen: 1_756_500_000_000 }]);
  assert.equal((await second.store.login({ login: 'roman', password: 'longenough' })).ok, true);
  assert.deepEqual(second.store.pending('roman'), { anna: 1 });
  assert.equal(second.store.history('anna', 'roman')[0].text, 'привет');
});


test('unusable entries are dropped without taking the readable ones with them', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({
    version: 1,
    accounts: {
      roman: { login: 'roman', name: 'Роман', salt: 'aa', hash: 'bb', createdAt: 1, lastSeen: 2 },
      'Bad Login': { login: 'Bad Login', name: 'x', salt: 'aa', hash: 'bb' },
      broken: { login: 'broken' },
    },
    tokens: { short: { login: 'roman' }, ['c'.repeat(64)]: { login: 'ghost' } },
    queue: { roman: [{ from: 'anna', d: { t: 'msg' } }, { from: 'anna' }, 7], ghost: [{ from: 'anna', d: { t: 'msg' } }] },
    history: { 'roman|anna': [{ id: 'x', from: 'anna', text: 'привет', ts: 3, kind: 'human' }] },
  }));

  const { store } = openStore(dir);
  t.after(() => store.close());
  assert.deepEqual(store.users(), [{ login: 'roman', name: 'Роман', lastSeen: 2 }]);
  assert.deepEqual(store.pending('roman'), { anna: 1 });
  assert.deepEqual(store.pending('ghost'), { anna: 1 });
  // Sides out of order are not this format's key, so that conversation is not adopted.
  assert.deepEqual(store.history('roman', 'anna'), []);
});

test('the queue keeps every message and gives up the oldest attachments instead', async (t) => {
  const { store } = withStore(t, { queueMediaBudgetChars: 40 });
  await store.register({ login: 'roman', password: 'longenough' });

  let size = 0;
  for (let n = 1; n <= 505; n += 1) {
    size = store.enqueue('roman', { from: 'anna', d: { t: 'msg', n }, at: n });
  }
  assert.equal(size, 505, 'nothing is evicted by count');
  assert.deepEqual(store.pending('roman'), { anna: 505 });

  // Three attachments of 20 chars each against a 40-char budget: the oldest
  // one loses its picture, the message itself stays queued.
  const picture = (mark) => ({ dataUrl: `${mark}`.repeat(20).slice(0, 20) });
  store.enqueue('roman', { from: 'anna', d: { t: 'msg', n: 506, image: picture('a') }, at: 506 });
  store.enqueue('roman', { from: 'anna', d: { t: 'msg', n: 507, image: picture('b') }, at: 507 });
  store.enqueue('roman', { from: 'anna', d: { t: 'msg', n: 508, image: picture('c') }, at: 508 });

  const drained = store.drain('roman', 'anna');
  assert.equal(drained.length, 508, 'every queued message is handed over');
  assert.equal(drained[0].d.n, 1, 'the oldest message is still the first one');
  const evicted = drained.find((item) => item.d.n === 506);
  assert.equal(evicted.d.image, undefined, 'the oldest attachment is the one given up');
  assert.equal(evicted.d.mediaDropped, true, 'and the client is told why');
  assert.equal(drained.find((item) => item.d.n === 508).d.image.dataUrl.length, 20, 'the newest keeps its picture');
  assert.deepEqual(store.pending('roman'), {});
});

test('unreadCounts ignores control frames the operational queue still counts', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'roman', password: 'longenough' });

  const controlTypes = ['ack', 'read', 'edit', 'del', 'react'];
  for (let n = 0; n < 499; n += 1) {
    store.enqueue('roman', { from: 'anna', d: { t: controlTypes[n % controlTypes.length], id: `c${n}` }, at: n });
  }
  store.enqueue('roman', { from: 'anna', d: { t: 'msg', id: 'm1' }, at: 500 });

  assert.deepEqual(store.pending('roman'), { anna: 500 }, 'the operational queue depth is unchanged');
  assert.deepEqual(store.unreadCounts('roman'), { anna: 1 }, 'only the human message moves the badge');
});

test('unreadCounts dedupes a repeated message id and counts distinct ids separately', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'roman', password: 'longenough' });

  store.enqueue('roman', { from: 'anna', d: { t: 'msg', id: 'm1' }, at: 1 });
  store.enqueue('roman', { from: 'anna', d: { t: 'msg', id: 'm1' }, at: 2 });
  assert.deepEqual(store.unreadCounts('roman'), { anna: 1 }, 'the same id queued twice is one unread item');

  store.enqueue('roman', { from: 'anna', d: { t: 'msg', id: 'm2' }, at: 3 });
  assert.deepEqual(store.unreadCounts('roman'), { anna: 2 }, 'a distinct id is a second unread item');
});

test('unreadCounts is zero for a control-only queue', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'roman', password: 'longenough' });

  store.enqueue('roman', { from: 'anna', d: { t: 'ack', id: 'a1' }, at: 1 });
  store.enqueue('roman', { from: 'anna', d: { t: 'read', id: 'r1' }, at: 2 });
  assert.equal(Object.keys(store.unreadCounts('roman')).length, 0);
  assert.deepEqual(store.pending('roman'), { anna: 2 }, 'the operational count still sees them');
});

test('unreadCounts treats legacy id-less msg/ai frames as separate unread items', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'roman', password: 'longenough' });

  store.enqueue('roman', { from: 'anna', d: { t: 'msg' }, at: 1 });
  store.enqueue('roman', { from: 'anna', d: { t: 'msg' }, at: 2 });
  assert.deepEqual(store.unreadCounts('roman'), { anna: 2 });
});

test('drain takes only the requested sender and enqueue refuses unknown accounts', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'roman', password: 'longenough' });

  store.enqueue('roman', { from: 'anna', d: { t: 'msg', n: 1 } });
  store.enqueue('roman', { from: 'boris', d: { t: 'msg', n: 2 } });
  store.enqueue('roman', { from: 'anna', d: { t: 'ack', n: 3 } });
  assert.equal(store.enqueue('ghost', { from: 'anna', d: { t: 'msg' } }), 0);
  assert.equal(store.enqueue('roman', { from: 'anna', d: null }), 3);
  assert.deepEqual(store.pending('roman'), { anna: 2, boris: 1 });

  const fromAnna = store.drain('roman', 'ANNA');
  assert.deepEqual(fromAnna.map((item) => item.d.n), [1, 3]);
  assert.deepEqual(store.pending('roman'), { boris: 1 });
  assert.deepEqual(store.drain('ghost', 'anna'), []);
});

test('history is symmetric, ascending by ts, preserves all messages and limited on read', async (t) => {
  const { store } = withStore(t);

  for (let n = 1; n <= 505; n += 1) {
    store.recordHistory('roman', 'anna', { id: `m${n}`, from: n % 2 ? 'roman' : 'anna', text: `#${n}`, ts: 1000 + n, kind: 'human' });
  }

  const all = store.history('anna', 'roman', 900);
  assert.equal(all.length, 505);
  assert.equal(all[0].id, 'm1');
  assert.equal(all[504].id, 'm505');
  assert.deepEqual([...all].sort((one, other) => one.ts - other.ts).map((item) => item.id), all.map((item) => item.id));

  assert.deepEqual(store.history('roman', 'anna').map((item) => item.id).length, 200);
  assert.equal(store.history('roman', 'anna', 3).map((item) => item.id).join(','), 'm503,m504,m505');
  assert.deepEqual(store.history('roman', 'nobody'), []);
});
test('history preserves bounded image and voice payloads across a reopen', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = openStore(dir);
  const image = { dataUrl: 'data:image/jpeg;base64,YQ==', width: 640, height: 480 };
  const voice = { dataUrl: 'data:audio/webm;codecs=opus;base64,YQ==', duration: 8 };
  first.store.recordHistory('roman', 'anna', { id: 'image', from: 'roman', text: 'photo', image });
  first.store.recordHistory('roman', 'anna', { id: 'voice', from: 'anna', text: 'voice', voice });
  first.store.recordHistory('roman', 'anna', {
    id: 'oversized',
    from: 'anna',
    text: 'bad',
    image: { dataUrl: `data:image/jpeg;base64,${'a'.repeat(CLOUD_MEDIA_MAX_CHARS)}`, width: 1, height: 1 },
  });
  await first.store.close();

  const second = openStore(dir);
  t.after(() => second.store.close());
  const history = second.store.history('anna', 'roman');
  assert.deepEqual(history[0].image, image);
  assert.deepEqual(history[1].voice, voice);
  assert.equal('image' in history[2], false);
});


test('a record written out of order is returned in ts order and defaults are filled in', async (t) => {
  const { store, at } = withStore(t);

  store.recordHistory('roman', 'anna', { id: 'late', from: 'anna', text: 'второе', ts: 2000, kind: 'ai' });
  store.recordHistory('roman', 'anna', { id: 'early', from: 'roman', text: 'первое', ts: 1000 });
  store.recordHistory('roman', 'anna', {});
  assert.equal(store.recordHistory('roman', 'bad login', { id: 'x' }), false);

  const log = store.history('roman', 'anna');
  assert.deepEqual(log.map((item) => [item.id, item.kind]), [['early', 'human'], ['late', 'ai'], ['', 'human']]);
  // `seq` is the commit number every record carries, and is incidental to the
  // defaults this test is about.
  assert.deepEqual({ ...log[2], seq: undefined }, {
    id: '', from: '', text: '', ts: at(), kind: 'human', seq: undefined,
  });
});

test('touch moves lastSeen and reports unknown logins', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'roman', password: 'longenough' });

  assert.equal(store.touch('ROMAN', 1_756_600_000_000), true);
  assert.equal(store.users()[0].lastSeen, 1_756_600_000_000);
  assert.equal(store.touch('ghost', 1), false);
});

test('users are listed alphabetically by display name', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'roman', password: 'longenough', name: 'Роман' });
  await store.register({ login: 'anna', password: 'longenough', name: 'Анна' });
  await store.register({ login: 'boris', password: 'longenough', name: 'Борис' });

  assert.deepEqual(store.users().map((user) => user.login), ['anna', 'boris', 'roman']);
});

test('invites and friends lifecycle: creation, rotation, acceptance, and friend queries', async (t) => {
  const { store, dir } = withStore(t);
  await store.register({ login: 'anna', password: 'longenough', name: 'Анна' });
  await store.register({ login: 'boris', password: 'longenough', name: 'Борис' });
  await store.register({ login: 'clara', password: 'longenough', name: 'Клара' });

  assert.deepEqual(store.friends('anna'), []);
  assert.equal(store.areFriends('anna', 'boris'), false);

  const inv1 = store.createInvite('anna');
  assert.match(inv1, /^[0-9a-f]{64}$/);

  const inv2 = store.createInvite('anna');
  assert.notEqual(inv1, inv2);

  assert.deepEqual(store.acceptInvite('boris', inv1), { ok: false, code: 'invite_not_found' });
  assert.deepEqual(store.acceptInvite('anna', inv2), { ok: false, code: 'self_invite' });
  assert.deepEqual(store.acceptInvite('boris', 'short'), { ok: false, code: 'invalid_invite' });
  assert.deepEqual(store.acceptInvite('ghost', inv2), { ok: false, code: 'unknown_token' });

  const accepted = store.acceptInvite('boris', inv2);
  assert.deepEqual(accepted, { ok: true, friend: { login: 'anna', name: 'Анна' } });
  assert.deepEqual(store.acceptInvite('clara', inv2), { ok: false, code: 'invite_not_found' });

  assert.equal(store.areFriends('anna', 'boris'), true);
  assert.equal(store.areFriends('boris', 'anna'), true);
  assert.equal(store.areFriends('anna', 'clara'), false);

  assert.deepEqual(store.friends('anna').map((u) => u.login), ['boris']);
  assert.deepEqual(store.friends('boris').map((u) => u.login), ['anna']);

  await store.flush();
  const reloaded = openStore(dir);
  t.after(() => reloaded.store.close());
  assert.equal(reloaded.store.areFriends('anna', 'boris'), true);
  assert.deepEqual(reloaded.store.friends('anna').map((u) => u.login), ['boris']);
});

test('block/unblock: asymmetric, scoped to friends, idempotent, and survives a reopen', async (t) => {
  const { store, dir } = withStore(t);
  await store.register({ login: 'anna', password: 'longenough', name: 'Анна' });
  await store.register({ login: 'boris', password: 'longenough', name: 'Борис' });
  await store.register({ login: 'clara', password: 'longenough', name: 'Клара' });

  assert.deepEqual(store.blockUser('anna', 'anna'), { ok: false, code: 'self_block' });
  assert.deepEqual(store.blockUser('anna', 'ghost'), { ok: false, code: 'unknown_user' });
  assert.deepEqual(store.blockUser('anna', 'clara'), { ok: false, code: 'not_friends' });

  const inv = store.createInvite('anna');
  store.acceptInvite('boris', inv);

  assert.deepEqual(store.blockUser('anna', 'boris'), { ok: true });
  // Asymmetric: anna blocking boris says nothing about boris having blocked anna.
  assert.equal(store.hasBlocked('anna', 'boris'), true);
  assert.equal(store.hasBlocked('boris', 'anna'), false);
  // Friendship is untouched by blocking.
  assert.equal(store.areFriends('anna', 'boris'), true);

  // Blocking twice does not duplicate the entry.
  assert.deepEqual(store.blockUser('anna', 'boris'), { ok: true });
  assert.deepEqual(store.blockedLogins('anna'), ['boris']);

  assert.deepEqual(store.unblockUser('anna', 'boris'), { ok: true });
  assert.equal(store.hasBlocked('anna', 'boris'), false);
  // Unblocking someone never blocked is a no-op success, not an error.
  assert.deepEqual(store.unblockUser('anna', 'clara'), { ok: true });

  store.blockUser('anna', 'boris');
  await store.flush();
  const reloaded = openStore(dir);
  t.after(() => reloaded.store.close());
  assert.equal(reloaded.store.hasBlocked('anna', 'boris'), true);
  assert.equal(reloaded.store.hasBlocked('boris', 'anna'), false);
});

test('setAlias: private, scoped to friends, free text with controls stripped, and survives a reopen', async (t) => {
  const { store, dir } = withStore(t);
  await store.register({ login: 'anna', password: 'longenough', name: 'Анна' });
  await store.register({ login: 'boris', password: 'longenough', name: 'Борис' });
  await store.register({ login: 'clara', password: 'longenough', name: 'Клара' });

  assert.deepEqual(store.setAlias('anna', 'anna', 'Я'), { ok: false, code: 'self_alias' });
  assert.deepEqual(store.setAlias('anna', 'ghost', 'Призрак'), { ok: false, code: 'unknown_user' });
  assert.deepEqual(store.setAlias('anna', 'clara', 'Клара'), { ok: false, code: 'not_friends' });
  assert.equal(store.aliasOf('anna', 'boris'), '');

  const inv = store.createInvite('anna');
  store.acceptInvite('boris', inv);

  assert.deepEqual(store.setAlias('anna', 'boris', '  Боря  '), { ok: true, alias: 'Боря' });
  assert.equal(store.aliasOf('anna', 'boris'), 'Боря');
  // Asymmetric and private: the peer keeps its own name and never learns this.
  assert.equal(store.aliasOf('boris', 'anna'), '');

  // A nickname is free text, not an account name: an emoji or punctuation is
  // exactly what it may be, and it is the rule the clients that already have
  // local nicknames use (trim only). Refusing these here would refuse the
  // nicknames the owner already has on his phone.
  assert.deepEqual(store.setAlias('anna', 'boris', '🎉 Босс (работа)'), { ok: true, alias: '🎉 Босс (работа)' });
  assert.equal(store.aliasOf('anna', 'boris'), '🎉 Босс (работа)');

  // What must never survive is what would break the surface it is drawn on:
  // controls go, and the bidi overrides with them — a nickname is one row in a
  // roster, not a document.
  store.setAlias('anna', 'boris', 'Бо\u0007ря\u202E!');
  assert.equal(store.aliasOf('anna', 'boris'), 'Боря!');
  store.setAlias('anna', 'boris', 'А\nБ\tВ');
  assert.equal(store.aliasOf('anna', 'boris'), 'А Б В');
  // Nothing but controls is not a nickname — that is what clearing looks like,
  // and it already has a way of being spelled.
  assert.deepEqual(store.setAlias('anna', 'boris', '\u0007\u0001  '), { ok: false, code: 'invalid_alias' });
  assert.equal(store.aliasOf('anna', 'boris'), 'А Б В', 'a refused nickname changes nothing');
  // The cap counts code points, so it can never split an emoji in half.
  assert.equal(store.setAlias('anna', 'boris', '🎉'.repeat(40)).alias, '🎉'.repeat(32));
  assert.equal(Array.from(store.aliasOf('anna', 'boris')).length, 32);

  // An empty name is how a nickname is taken back, and it is idempotent.
  assert.deepEqual(store.setAlias('anna', 'boris', ''), { ok: true, alias: '' });
  assert.equal(store.aliasOf('anna', 'boris'), '');

  store.setAlias('anna', 'boris', 'Боря');
  await store.flush();
  const reloaded = openStore(dir);
  t.after(() => reloaded.store.close());
  assert.equal(reloaded.store.aliasOf('anna', 'boris'), 'Боря');
  assert.equal(reloaded.store.aliasOf('boris', 'anna'), '');
});

test('removeContact deletes the contact and the thread for its owner alone', async (t) => {
  const { store, dir } = withStore(t);
  await store.register({ login: 'anna', password: 'longenough', name: 'Анна' });
  await store.register({ login: 'boris', password: 'longenough', name: 'Борис' });
  await store.register({ login: 'clara', password: 'longenough', name: 'Клара' });

  assert.deepEqual(await store.removeContact('anna', 'anna'), { ok: false, code: 'self_remove' });
  assert.deepEqual(await store.removeContact('anna', 'ghost'), { ok: false, code: 'unknown_user' });
  assert.deepEqual(await store.removeContact('anna', 'clara'), { ok: false, code: 'not_friends' });

  const inv = store.createInvite('anna');
  store.acceptInvite('boris', inv);
  await store.commitHistory('anna', 'boris', { id: 'm1', from: 'anna', text: 'привет' });
  await store.commitHistory('boris', 'anna', { id: 'm2', from: 'boris', text: 'и тебе' });

  assert.deepEqual(await store.removeContact('anna', 'boris'), { ok: true, removed: true });
  // Asymmetric, like blocking: boris keeps anna and is never told.
  assert.equal(store.isRemoved('anna', 'boris'), true);
  assert.equal(store.isRemoved('boris', 'anna'), false);
  assert.equal(store.areFriends('anna', 'boris'), true);
  assert.deepEqual(store.removedLogins('anna'), ['boris']);

  // The thread is gone for anna and untouched for boris: the shared log keeps
  // what the other side knows, and only the roster preview is cut with it.
  assert.deepEqual(store.history('anna', 'boris'), []);
  assert.deepEqual(store.history('boris', 'anna').map((m) => m.id), ['m1', 'm2']);
  assert.equal(store.lastMessage('anna', 'boris'), null);
  assert.equal(store.lastMessage('boris', 'anna').id, 'm2');

  // Idempotent: a retry after a lost response is the same answer, not an error.
  assert.deepEqual(await store.removeContact('anna', 'boris'), { ok: true, removed: true });
  assert.deepEqual(store.removedLogins('anna'), ['boris']);

  await store.flush();
  const reloaded = openStore(dir);
  t.after(() => reloaded.store.close());
  assert.equal(reloaded.store.isRemoved('anna', 'boris'), true);
  assert.deepEqual(reloaded.store.history('anna', 'boris'), []);
  assert.equal(reloaded.store.history('boris', 'anna').length, 2);
});

test('re-adding a deleted contact restores the contact and never the thread', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'anna', password: 'longenough', name: 'Анна' });
  await store.register({ login: 'boris', password: 'longenough', name: 'Борис' });

  store.acceptInvite('boris', store.createInvite('anna'));
  await store.commitHistory('boris', 'anna', { id: 'm1', from: 'boris', text: 'старое' });
  await store.removeContact('anna', 'boris');

  // Boris invites anna back. Friendship is what re-adds a contact, and the
  // invite is the only path that makes one.
  store.acceptInvite('anna', store.createInvite('boris'));
  assert.equal(store.isRemoved('anna', 'boris'), false);
  assert.deepEqual(store.removedLogins('anna'), []);
  assert.equal(store.areFriends('anna', 'boris'), true);

  // The deleted conversation does not come back with the contact.
  assert.deepEqual(store.history('anna', 'boris'), []);

  await store.commitHistory('boris', 'anna', { id: 'm2', from: 'boris', text: 'новое' });
  assert.deepEqual(store.history('anna', 'boris').map((m) => m.id), ['m2']);
  assert.deepEqual(store.history('boris', 'anna').map((m) => m.id), ['m1', 'm2']);
});

test('a record written through the non-durable path still carries a seq, so a purge never hides it', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'anna', password: 'longenough' });
  await store.register({ login: 'boris', password: 'longenough' });
  store.acceptInvite('boris', store.createInvite('anna'));

  store.recordHistory('boris', 'anna', { id: 'm1', from: 'boris', text: 'старое', ts: 1000 });
  assert.ok(store.history('anna', 'boris')[0].seq > 0, 'the relay path stamps a seq, not only the durable one');

  await store.removeContact('anna', 'boris');
  // A message written after the cut — the service account and the assistant
  // reach the log through this same non-durable door — has to be visible to the
  // owner who deleted the contact, or the two paths disagree about how far the
  // deletion reached.
  store.recordHistory('boris', 'anna', { id: 'm2', from: 'boris', text: 'после', ts: 2000 });
  assert.deepEqual(store.history('anna', 'boris').map((m) => m.id), ['m2']);
  assert.deepEqual(store.history('boris', 'anna').map((m) => m.id), ['m1', 'm2']);
});

test('deleting a contact drops that contact\'s queued frames and nobody else\'s', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'anna', password: 'longenough' });
  await store.register({ login: 'boris', password: 'longenough' });
  await store.register({ login: 'clara', password: 'longenough' });
  store.acceptInvite('boris', store.createInvite('anna'));
  store.acceptInvite('clara', store.createInvite('anna'));

  store.enqueue('anna', { from: 'boris', d: { t: 'msg', id: 'q1', text: 'от бориса' }, at: 1 });
  store.enqueue('anna', { from: 'clara', d: { t: 'msg', id: 'q2', text: 'от клары' }, at: 2 });

  await store.removeContact('anna', 'boris');
  // The badge for a conversation that no longer exists must not survive it.
  assert.deepEqual(store.drain('anna', 'boris'), []);
  assert.deepEqual(store.drain('anna', 'clara').map((item) => item.d.id), ['q2']);
});

test('a deleted contact is not lost if the process is killed before the next debounced snapshot', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = createAccountStore({ dir, writeDelayMs: 60_000 });
  await first.register({ login: 'roman', password: 'longenough' });
  await first.register({ login: 'anna', password: 'longenough' });
  first.linkFriends('roman', 'anna');
  await first.commitHistory('roman', 'anna', { id: 'm1', from: 'roman', text: 'старое' });
  assert.deepEqual(await first.removeContact('roman', 'anna'), { ok: true, removed: true });

  const recovered = createAccountStore({ dir });
  t.after(() => recovered.close());
  assert.equal(recovered.isRemoved('roman', 'anna'), true, 'the removal is replayed from the journal');
  assert.deepEqual(recovered.history('roman', 'anna'), []);
  assert.equal(recovered.history('anna', 'roman').length, 1, 'the peer keeps its copy');
});

test('a prototype-poisoning key in the file stays an inert entry', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'accounts.json'), '{"version":1,"accounts":{"__proto__":{"salt":"aa","hash":"bb","polluted":true}}}');

  const { store } = openStore(dir);
  t.after(() => store.close());
  assert.deepEqual(store.users(), []);
  assert.equal({}.polluted, undefined);
  assert.equal((await store.register({ login: 'roman', password: 'longenough' })).ok, true);
});

test('addPushSubscription validates shape, dedupes by endpoint, and persists across reload', async (t) => {
  const { store, dir } = withStore(t);
  await store.register({ login: 'anna', password: 'longenough' });
  const device = 'deviceaaaaaaaaaaaa';

  assert.equal(store.addPushSubscription('ghost', { endpoint: 'https://x', keys: { p256dh: 'a', auth: 'b' } }, device), false);
  assert.equal(store.addPushSubscription('anna', { endpoint: 'not-https', keys: { p256dh: 'a', auth: 'b' } }, device), false);
  assert.equal(store.addPushSubscription('anna', { endpoint: 'https://push.example/1' }, device), false);
  // No claiming device — see `normalizeDeviceId`: a subscription nothing can
  // renew is exactly the kind that keeps notifying from an uninstalled PWA.
  assert.equal(store.addPushSubscription('anna', { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } }), false);
  assert.deepEqual(store.pushSubscriptions('anna'), []);

  assert.equal(store.addPushSubscription('anna', { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } }, device), true);
  assert.equal(store.addPushSubscription('anna', { endpoint: 'https://push.example/2', keys: { p256dh: 'c', auth: 'd' } }, 'devicebbbbbbbbbbbb'), true);
  // Re-subscribing the same endpoint (token rotation) replaces, not duplicates.
  assert.equal(store.addPushSubscription('anna', { endpoint: 'https://push.example/1', keys: { p256dh: 'e', auth: 'f' } }, device), true);

  const subs = store.pushSubscriptions('anna');
  assert.equal(subs.length, 2);
  assert.deepEqual(subs.find((s) => s.endpoint === 'https://push.example/1').keys, { p256dh: 'e', auth: 'f' });

  await store.flush();
  const reloaded = openStore(dir);
  t.after(() => reloaded.store.close());
  assert.equal(reloaded.store.pushSubscriptions('anna').length, 2);
});

// The reported bug: one message, several notifications «as if from different
// Tailchat», with the web installs already deleted. A push service hands out
// a new endpoint when it rotates one, and the browser cannot tell the server
// its old endpoint is dead — so without a per-device identity the store keeps
// the previous endpoint too and every message notifies from both.
test('a device re-claiming its subscription replaces its previous endpoint', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'anna', password: 'longenough' });

  store.addPushSubscription('anna', { endpoint: 'https://push.example/old', keys: { p256dh: 'a', auth: 'b' } }, 'devicesame');
  store.addPushSubscription('anna', { endpoint: 'https://push.example/new', keys: { p256dh: 'c', auth: 'd' } }, 'devicesame');

  assert.deepEqual(store.pushSubscriptions('anna').map((s) => s.endpoint), ['https://push.example/new']);
});

// The worker-side half of endpoint rotation: the browser's push service hands
// out a new endpoint at a moment when no page is open, so the only thing awake
// is the service worker, and the only credential it is trusted with is a key
// that can replace exactly one device's subscription (`web/cloud/sw.js`).
test('a repair key replaces one device’s endpoint, is spent on use, and fits no other device', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'anna', password: 'longenough' });
  const device = 'deviceaaaaaaaaaaaa';
  const other = 'devicebbbbbbbbbbbb';
  const sub = (n, keys) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: keys, auth: keys } });
  store.addPushSubscription('anna', sub(1, 'a'), device);
  store.addPushSubscription('anna', sub(2, 'b'), other);

  assert.equal(store.mintPushRepairKey('anna', 'devicenobodynobody'), null, 'a device the store does not know has no key');
  assert.equal(store.mintPushRepairKey('ghost', device), null);

  const key = store.mintPushRepairKey('anna', device);
  assert.match(key, /^[0-9a-f]{64}$/);

  // A wrong key changes nothing at all.
  assert.deepEqual(store.repairPushSubscription('anna', device, `0${'f'.repeat(63)}`, sub(3, 'c')), { ok: false, code: 'bad_repair_key' });
  assert.deepEqual(store.pushSubscriptions('anna').map((s) => s.endpoint).sort(), ['https://push.example/1', 'https://push.example/2']);

  const repaired = store.repairPushSubscription('anna', device, key, sub(3, 'c'));
  assert.equal(repaired.ok, true);
  assert.match(repaired.repairKey, /^[0-9a-f]{64}$/);
  assert.deepEqual(store.pushSubscriptions('anna').map((s) => s.endpoint).sort(), ['https://push.example/2', 'https://push.example/3']);
  assert.deepEqual(store.pushSubscriptions('anna').find((s) => s.endpoint === 'https://push.example/3').keys, { p256dh: 'c', auth: 'c' });

  // Spent: the key that was just used is refused, the rotated one works.
  assert.deepEqual(store.repairPushSubscription('anna', device, key, sub(4, 'd')), { ok: false, code: 'bad_repair_key' });
  assert.equal(store.repairPushSubscription('anna', device, repaired.repairKey, sub(4, 'd')).ok, true);

  // A key belongs to the device it was minted for, and to no other.
  const fresh = store.mintPushRepairKey('anna', device);
  assert.deepEqual(store.repairPushSubscription('anna', other, fresh, sub(5, 'e')), { ok: false, code: 'bad_repair_key' });
  assert.deepEqual(store.pushSubscriptions('anna').find((s) => s.endpoint === 'https://push.example/2').keys, { p256dh: 'b', auth: 'b' }, 'the other device is untouched');

  // A device the store has forgotten, and a body that is not a subscription,
  // are told apart from a wrong key.
  assert.deepEqual(store.repairPushSubscription('anna', 'devicenobodynobody', fresh, sub(6, 'f')), { ok: false, code: 'unknown_device' });
  assert.deepEqual(store.repairPushSubscription('anna', device, fresh, { endpoint: 'not-https' }), { ok: false, code: 'invalid_subscription' });
});

test('a lease nobody renewed expires, and a legacy unclaimed entry is dropped on load', async (t) => {
  const { store, dir, at } = withStore(t);
  await store.register({ login: 'anna', password: 'longenough' });
  store.addPushSubscription('anna', { endpoint: 'https://push.example/now', keys: { p256dh: 'a', auth: 'b' } }, 'devicenow');
  await store.flush();
  await store.close();

  const raw = readFile(path.join(dir, 'accounts.json'));
  const longAgo = at() - (40 * 24 * 60 * 60 * 1000);
  raw.pushSubs.anna.push({ ...raw.pushSubs.anna[0], endpoint: 'https://push.example/stale', seenAt: longAgo, addedAt: longAgo });
  // A browser that uninstalled the PWA before subscriptions carried an owner
  // at all — nothing can ever renew it, so it must not survive the reload.
  raw.pushSubs.anna.push({ endpoint: 'https://push.example/legacy', keys: { p256dh: 'a', auth: 'b' }, addedAt: at() });
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(raw));

  const reloaded = openStore(dir);
  t.after(() => reloaded.store.close());
  assert.deepEqual(reloaded.store.pushSubscriptions('anna').map((s) => s.endpoint), ['https://push.example/now']);
});

test('removePushSubscription drops one endpoint and is idempotent on the second call', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'anna', password: 'longenough' });
  store.addPushSubscription('anna', { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } }, 'devicelongenough');

  assert.equal(store.removePushSubscription('anna', 'https://push.example/1'), true);
  assert.deepEqual(store.pushSubscriptions('anna'), []);
  assert.equal(store.removePushSubscription('anna', 'https://push.example/1'), false);
});

test('pushSubs caps at the per-account limit, dropping the oldest subscription first', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'anna', password: 'longenough' });

  for (let i = 0; i < 20; i += 1) {
    store.addPushSubscription('anna', { endpoint: `https://push.example/${i}`, keys: { p256dh: 'a', auth: 'b' } }, `device000000${i}`);
  }

  const subs = store.pushSubscriptions('anna');
  assert.equal(subs.length, 12);
  assert.equal(subs[0].endpoint, 'https://push.example/8');
  assert.equal(subs[subs.length - 1].endpoint, 'https://push.example/19');
});

test('a malformed pushSubs entry in the file stays an inert, unloaded record', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createAccountStore({ dir });
  await store.register({ login: 'anna', password: 'longenough' });
  await store.flush();
  await store.close();

  const raw = readFile(path.join(dir, 'accounts.json'));
  const fresh = Date.now();
  raw.pushSubs = {
    anna: [
      { endpoint: 'https://push.example/ok', keys: { p256dh: 'a', auth: 'b' }, deviceId: 'deviceaaaaaaaaaa', addedAt: fresh, seenAt: fresh },
      { endpoint: 'not-https', keys: { p256dh: 'a', auth: 'b' }, deviceId: 'devicebbbbbbbbbb', addedAt: fresh, seenAt: fresh },
      { endpoint: 'https://push.example/no-keys', deviceId: 'devicecccccccccc', addedAt: fresh, seenAt: fresh },
    ],
    ghost: [{ endpoint: 'https://push.example/orphan', keys: { p256dh: 'a', auth: 'b' }, deviceId: 'devicedddddddddd', addedAt: fresh, seenAt: fresh }],
  };
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(raw));

  const reloaded = createAccountStore({ dir });
  t.after(() => reloaded.close());
  assert.deepEqual(reloaded.pushSubscriptions('anna').map((s) => s.endpoint), ['https://push.example/ok']);
  assert.deepEqual(reloaded.pushSubscriptions('ghost'), []);
});

const FCM_SCOPE = 'a'.repeat(64);

test('addFcmToken validates shape, dedupes by token, and persists across reload', async (t) => {
  const { store, dir } = withStore(t);
  await store.register({ login: 'anna', password: 'longenough' });

  assert.equal(store.addFcmToken('ghost', 'tok-1', FCM_SCOPE), false);
  assert.equal(store.addFcmToken('anna', '', FCM_SCOPE), false);
  assert.equal(store.addFcmToken('anna', 123, FCM_SCOPE), false);
  assert.equal(store.addFcmToken('anna', 'tok-1', 'bad-scope'), false);
  assert.deepEqual(store.fcmTokens('anna'), []);

  // A build that predates the scope field — every release up to 0.71.0 — sends
  // none at all and must keep registering: refusing it would answer those
  // devices 400 on every retry and leave them permanently silent, which is the
  // failure the field exists to fix.
  assert.equal(store.addFcmToken('anna', 'legacy-token'), true);
  assert.equal(store.fcmTokens('anna')[0].scope, '');

  assert.equal(store.addFcmToken('anna', 'tok-1', FCM_SCOPE), true);
  assert.equal(store.addFcmToken('anna', 'tok-2', FCM_SCOPE), true);
  // Re-registering the same token (a duplicate onNewToken callback) replaces, not duplicates.
  assert.equal(store.addFcmToken('anna', 'tok-1', FCM_SCOPE), true);

  const tokens = store.fcmTokens('anna');
  assert.equal(tokens.length, 3);
  assert.deepEqual(tokens.map((t2) => t2.token).sort(), ['legacy-token', 'tok-1', 'tok-2']);

  await store.flush();
  const reloaded = openStore(dir);
  t.after(() => reloaded.store.close());
  assert.equal(reloaded.store.fcmTokens('anna').length, 3);
  assert.deepEqual(
    reloaded.store.fcmTokens('anna').map((t2) => t2.token).sort(),
    ['legacy-token', 'tok-1', 'tok-2'],
  );
});

test('removeFcmToken drops one token and is idempotent on the second call', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'anna', password: 'longenough' });
  store.addFcmToken('anna', 'tok-1', FCM_SCOPE);

  assert.equal(store.removeFcmToken('anna', 'tok-1'), true);
  assert.deepEqual(store.fcmTokens('anna'), []);
  assert.equal(store.removeFcmToken('anna', 'tok-1'), false);
});

test('fcmTokens caps at the per-account limit, dropping the oldest token first', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'anna', password: 'longenough' });

  for (let i = 0; i < 20; i += 1) {
    store.addFcmToken('anna', `tok-${i}`, FCM_SCOPE);
  }

  const tokens = store.fcmTokens('anna');
  assert.equal(tokens.length, 12);
  assert.equal(tokens[0].token, 'tok-8');
  assert.equal(tokens[tokens.length - 1].token, 'tok-19');
});

test('a malformed fcmTokens entry in the file stays an inert, unloaded record', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createAccountStore({ dir });
  await store.register({ login: 'anna', password: 'longenough' });
  await store.flush();
  await store.close();

  const raw = readFile(path.join(dir, 'accounts.json'));
  raw.fcmTokens = {
    anna: [
      { token: 'ok-token' },
      { token: '' },
      { token: 123 },
    ],
    ghost: [{ token: 'orphan-token' }],
  };
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(raw));

  const reloaded = createAccountStore({ dir });
  t.after(() => reloaded.close());
  assert.deepEqual(reloaded.fcmTokens('anna').map((t2) => t2.token), ['ok-token']);
  assert.deepEqual(reloaded.fcmTokens('ghost'), []);
});

test('edits and reactions update a stored message without changing its author', async (t) => {
  const { store } = withStore(t);
  store.recordHistory('anna', 'boris', { id: 'm1', from: 'anna', text: 'before', ts: 1 });

  assert.deepEqual(await store.editHistory('anna', 'boris', 'm1', 'anna', 'after'), {
    id: 'm1', from: 'anna', text: 'after', reactions: undefined,
  });
  assert.equal(await store.editHistory('anna', 'boris', 'm1', 'boris', 'nope'), null);
  assert.deepEqual(await store.reactHistory('anna', 'boris', 'm1', 'boris', '👍', true), {
    id: 'm1', from: 'anna', text: 'after', reactions: { '👍': ['boris'] },
  });
  const record = store.history('anna', 'boris')[0];
  assert.equal(record.editedAt, 1_756_500_000_000);
  assert.equal(record.reactionEvents.length, 1);
  // `seq` is the commit number every record carries (`recordHistory` stamps the
  // one its event was given) and is incidental here, like `editedAt`.
  assert.deepEqual({ ...record, seq: undefined, editedAt: undefined, reactionEvents: undefined }, {
    id: 'm1', from: 'anna', text: 'after', ts: 1, kind: 'human', reactions: { '👍': ['boris'] }, seq: undefined, editedAt: undefined, reactionEvents: undefined,
  });
});

test('a reply carries a truncated snapshot of the original, and a malformed one is dropped', async (t) => {
  const { store } = withStore(t);
  store.recordHistory('anna', 'boris', { id: 'm1', from: 'anna', text: 'первое' });
  store.recordHistory('anna', 'boris', {
    id: 'm2', from: 'boris', text: 'второе', replyTo: { id: 'm1', from: 'anna', text: 'x'.repeat(300) },
  });
  store.recordHistory('anna', 'boris', { id: 'm3', from: 'anna', text: 'третье', replyTo: { id: 'm1' } });
  store.recordHistory('anna', 'boris', { id: 'm4', from: 'anna', text: 'четвёртое', replyTo: 'm1' });

  const log = store.history('anna', 'boris');
  assert.equal(log[1].replyTo.text.length, 200);
  assert.deepEqual(log[1].replyTo, { id: 'm1', from: 'anna', text: 'x'.repeat(200) });
  assert.equal('replyTo' in log[2], false, 'no login on the snapshot drops it, not just the field');
  assert.equal('replyTo' in log[3], false, 'a bare string is not a snapshot');
});

test('a 600-second voice note is accepted whole and a longer one is clamped', async (t) => {
  const { store } = withStore(t);

  store.recordHistory('roman', 'anna', {
    id: 'long', from: 'roman', voice: { dataUrl: 'data:audio/webm;codecs=opus;base64,YQ==', duration: 600 },
  });
  store.recordHistory('roman', 'anna', {
    id: 'longer', from: 'roman', voice: { dataUrl: 'data:audio/webm;codecs=opus;base64,YQ==', duration: 601 },
  });

  assert.deepEqual(
    store.history('roman', 'anna').map((item) => item.voice.duration),
    [600, 600],
  );
});

test('the conversation media budget strips the oldest attachments and says so', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const media = (n) => ({ dataUrl: `data:image/jpeg;base64,${'a'.repeat(n)}`, width: 4, height: 4 });
  const first = createAccountStore({ dir, writeDelayMs: 5000, historyMediaBudgetChars: 1000 });

  first.recordHistory('roman', 'anna', { id: 'oldest', from: 'roman', text: 'первое', image: media(400) });
  first.recordHistory('roman', 'anna', { id: 'text-only', from: 'anna', text: 'без картинки' });
  first.recordHistory('roman', 'anna', { id: 'middle', from: 'roman', text: 'второе', image: media(400) });
  assert.deepEqual(
    first.history('anna', 'roman').map((item) => 'image' in item),
    [true, false, true],
    'two attachments still fit',
  );

  first.recordHistory('roman', 'anna', { id: 'newest', from: 'anna', text: 'третье', image: media(400) });
  const evicted = first.history('anna', 'roman');
  assert.deepEqual(
    evicted.map((item) => [item.id, 'image' in item, item.mediaDropped === true]),
    [['oldest', false, true], ['text-only', false, false], ['middle', true, false], ['newest', true, false]],
  );
  assert.equal(evicted[0].text, 'первое', 'the message itself is never removed');
  await first.close();

  const reloaded = createAccountStore({ dir, historyMediaBudgetChars: 1000 });
  t.after(() => reloaded.close());
  assert.deepEqual(
    reloaded.history('anna', 'roman').map((item) => [item.id, item.mediaDropped === true]),
    [['oldest', true], ['text-only', false], ['middle', false], ['newest', false]],
  );
});

test('Saved Messages keeps every message past the conversation ceiling, including across a reopen', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = createAccountStore({ dir, writeDelayMs: 5000 });

  for (let n = 1; n <= 620; n += 1) {
    first.recordHistory('roman', 'roman', { id: `s${n}`, from: 'roman', text: `#${n}`, ts: 1000 + n });
    first.recordHistory('roman', 'anna', { id: `m${n}`, from: 'roman', text: `#${n}`, ts: 1000 + n });
  }

  const saved = first.history('roman', 'roman', 5000);
  assert.equal(saved.length, 620, 'nothing is ever taken out of Saved Messages');
  assert.equal(saved[0].id, 's1');
  assert.equal(first.history('roman', 'anna', 5000).length, 620, 'an ordinary conversation also keeps all messages');
  await first.close();

  const reloaded = createAccountStore({ dir });
  t.after(() => reloaded.close());
  assert.equal(reloaded.history('roman', 'roman', 5000).length, 620, 'a restart does not re-trim what it just protected');
  assert.equal(reloaded.history('roman', 'roman')[0].id, 's1', 'and with no limit named the whole archive comes back');
  assert.equal(reloaded.history('roman', 'anna', 5000).length, 620);
});

test('an attachment already in Saved Messages is never given up, unlike a conversation\'s', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const media = (n) => ({ dataUrl: `data:image/jpeg;base64,${'a'.repeat(n)}`, width: 4, height: 4 });
  const store = createAccountStore({
    dir, writeDelayMs: 5000, historyMediaBudgetChars: 1000, savedMediaBudgetChars: 100_000,
  });
  t.after(() => store.close());

  for (const id of ['first', 'second', 'third']) {
    store.recordHistory('roman', 'roman', { id, from: 'roman', text: id, image: media(400) });
    store.recordHistory('roman', 'anna', { id, from: 'roman', text: id, image: media(400) });
  }

  assert.deepEqual(
    store.history('roman', 'roman').map((item) => 'image' in item),
    [true, true, true],
  );
  assert.deepEqual(
    store.history('roman', 'anna').map((item) => [item.id, 'image' in item, item.mediaDropped === true]),
    [['first', false, true], ['second', true, false], ['third', true, false]],
  );
});

test('a Saved Messages attachment over budget is refused, not swapped for an older one', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const media = (n) => ({ dataUrl: `data:image/jpeg;base64,${'a'.repeat(n)}`, width: 4, height: 4 });
  const store = createAccountStore({ dir, writeDelayMs: 5000, savedMediaBudgetChars: 1000 });
  t.after(() => store.close());

  store.recordHistory('roman', 'roman', { id: 'kept', from: 'roman', text: 'первая', image: media(400) });
  store.recordHistory('roman', 'roman', {
    id: 'also-kept',
    from: 'roman',
    text: 'вторая',
    voice: { dataUrl: `data:audio/webm;codecs=opus;base64,${'a'.repeat(400)}`, duration: 8 },
  });
  store.recordHistory('roman', 'roman', { id: 'refused', from: 'roman', text: 'третья', image: media(400) });
  store.recordHistory('roman', 'roman', { id: 'text', from: 'roman', text: 'четвёртая' });

  const saved = store.history('roman', 'roman');
  assert.deepEqual(
    saved.map((item) => [item.id, 'image' in item || 'voice' in item, item.mediaDropped === true]),
    [['kept', true, false], ['also-kept', true, false], ['refused', false, true], ['text', false, false]],
  );
  assert.equal(saved[2].text, 'третья', 'the text of a refused attachment is saved all the same');
});

test('linkFriends is a two-way friendship and announcedVersion outlives the process', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = createAccountStore({ dir, writeDelayMs: 5000 });
  await first.register({ login: 'roman', password: 'longenough', name: 'Роман' });
  await first.register({ login: 'tailchat', password: 'longenough', name: 'Tailchat' });

  assert.equal(first.linkFriends('roman', 'ghost'), false, 'an account nobody owns has no friendships');
  assert.equal(first.linkFriends('roman', 'roman'), false);
  assert.equal(first.linkFriends('ROMAN', 'tailchat'), true);
  assert.equal(first.linkFriends('roman', 'tailchat'), true, 'linking twice is still one friendship');
  assert.deepEqual(first.friends('roman').map((friend) => friend.login), ['tailchat']);
  assert.deepEqual(first.friends('tailchat').map((friend) => friend.login), ['roman']);
  assert.equal(first.areFriends('roman', 'tailchat'), true);

  assert.equal(first.announcedVersion(), null, 'a fresh store has announced nothing');
  first.setAnnouncedVersion('1.12');
  await first.close();

  const reloaded = createAccountStore({ dir });
  t.after(() => reloaded.close());
  assert.equal(reloaded.announcedVersion(), '1.12');
  assert.deepEqual(reloaded.friends('roman').map((friend) => friend.login), ['tailchat']);
});

test('the default media budget leaves ordinary attachments alone', async (t) => {
  const { store } = withStore(t);
  const image = { dataUrl: `data:image/jpeg;base64,${'a'.repeat(8 * 1024 * 1024)}`, width: 4, height: 4 };

  store.recordHistory('roman', 'anna', { id: 'one', from: 'roman', image });
  store.recordHistory('roman', 'anna', { id: 'two', from: 'anna', image });

  assert.deepEqual(store.history('roman', 'anna').map((item) => 'image' in item), [true, true]);
});

test('deleteHistory tombstones own records for both sides and clears pending copies', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'roman', password: 'longenough' });
  await store.register({ login: 'anna', password: 'longenough' });

  store.recordHistory('roman', 'anna', { id: 'm1', from: 'roman', text: 'первое' });
  store.recordHistory('roman', 'anna', { id: 'm2', from: 'anna', text: 'второе' });
  store.recordHistory('roman', 'anna', {});
  store.enqueue('anna', { from: 'roman', d: { t: 'msg', id: 'm1' } });
  store.enqueue('anna', { from: 'roman', d: { t: 'msg', id: 'm2' } });
  store.enqueue('roman', { from: 'anna', d: { t: 'msg', id: 'm2' } });

  assert.deepEqual(await store.deleteHistory('anna', 'roman', ['m2', '', 'unknown']), ['m2']);
  assert.deepEqual(store.history('roman', 'anna').map((item) => item.id), ['m1', '']);
  assert.deepEqual(store.pending('anna'), { roman: 1 });

  assert.deepEqual(await store.deleteHistory('roman', 'anna', ['']), [], 'an empty id matches nothing');
  assert.deepEqual(store.history('roman', 'anna').map((item) => item.id), ['m1', '']);

  assert.deepEqual(await store.deleteHistory('roman', 'anna', ['m1', '']), ['m1']);
  assert.deepEqual(store.pending('anna'), {}, 'the queued copy went with the record');
  assert.deepEqual(store.pending('roman'), {});
  assert.deepEqual(
    store.history('roman', 'anna', 60, { includeDeleted: true }).map((item) => [item.id, item.text, Boolean(item.deletedAt)]),
    [['m1', '', true], ['m2', '', true], ['', '', false]],
  );

  assert.deepEqual(await store.deleteHistory('roman', 'anna', ['']), []);
  assert.deepEqual(await store.deleteHistory('roman', 'anna', 'm2'), []);
  assert.deepEqual(await store.deleteHistory('roman', 'bad login', ['m2']), []);
});

test('hideHistory removes a record from one side only and survives a reopen', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = createAccountStore({ dir, writeDelayMs: 5000 });
  await first.register({ login: 'roman', password: 'longenough' });
  await first.register({ login: 'anna', password: 'longenough' });

  first.recordHistory('roman', 'anna', { id: 'm1', from: 'roman', text: 'первое' });
  first.recordHistory('roman', 'anna', { id: 'm2', from: 'anna', text: 'второе' });

  assert.equal(await first.hideHistory('roman', 'anna', ['m1', '', 'm1']), 1);
  assert.deepEqual(first.history('roman', 'anna').map((item) => item.id), ['m2']);
  assert.deepEqual(first.history('anna', 'roman').map((item) => item.id), ['m1', 'm2']);
  assert.equal(await first.hideHistory('roman', 'bad login', ['m2']), 0);
  await first.close();

  const reloaded = createAccountStore({ dir });
  t.after(() => reloaded.close());
  assert.deepEqual(reloaded.history('roman', 'anna').map((item) => item.id), ['m2']);
  assert.deepEqual(reloaded.history('anna', 'roman').map((item) => item.id), ['m1', 'm2']);
});

// A message to Saved Messages is queued for the very session that sent it, so
// «удалить у себя» that only touched the shared log left a copy in the queue
// and the next connect replayed it — the row came back and looked undeletable.
test('hiding a record also drops this owner\'s queued copy of it, not the peer\'s', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createAccountStore({ dir });
  t.after(() => store.close());
  await store.register({ login: 'roman', password: 'longenough' });
  await store.register({ login: 'anna', password: 'longenough' });

  store.recordHistory('roman', 'roman', { id: 'm1', from: 'roman', text: 'заметка' });
  store.enqueue('roman', { from: 'roman', d: { t: 'msg', id: 'm1' }, at: 1 });
  store.enqueue('anna', { from: 'roman', d: { t: 'msg', id: 'm1' }, at: 1 });

  await store.hideHistory('roman', 'roman', ['m1']);

  assert.deepEqual(store.drain('roman', 'roman'), []);
  assert.equal(store.drain('anna', 'roman').length, 1);
});

// A read receipt is a live frame; without remembering it, every reload of the
// author's client redrew already-read messages with a single ✓.
test('markRead remembers how far a reader got, never moves backwards, and survives a reopen', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 9000;
  const first = createAccountStore({ dir, writeDelayMs: 5000, now: () => clock });
  await first.register({ login: 'roman', password: 'longenough' });
  await first.register({ login: 'anna', password: 'longenough' });

  first.recordHistory('roman', 'anna', { id: 'm1', from: 'roman', text: 'первое', ts: 1000 });
  first.recordHistory('roman', 'anna', { id: 'm2', from: 'roman', text: 'второе', ts: 2000 });

  assert.equal(first.readTs('anna', 'roman'), 0);
  assert.equal(await first.markRead('anna', 'roman', 'm2', 'web'), 2000);
  assert.equal(first.readAt('anna', 'roman'), 9000);
  assert.equal(first.readVia('anna', 'roman'), 'web');
  // An older receipt draining late must not un-read the newer message — and a
  // repeat says nothing about which client is holding the phone now, so it must
  // not relabel a read that already happened somewhere else either.
  clock = 10_000;
  assert.equal(await first.markRead('anna', 'roman', 'm1', 'android/175'), 2000);
  assert.equal(first.readTs('anna', 'roman'), 2000);
  assert.equal(first.readAt('anna', 'roman'), 9000, 'a late older receipt keeps the original read time');
  assert.equal(first.readVia('anna', 'roman'), 'web', 'a repeat receipt does not relabel the advance');
  // The other direction is a different reader: roman has read nothing.
  assert.equal(first.readTs('roman', 'anna'), 0);
  assert.equal(first.readVia('roman', 'anna'), '');
  // An id the shared log does not hold is not a timestamp to guess at.
  assert.equal(await first.markRead('anna', 'roman', 'nope', 'cli'), 0);
  assert.equal(first.readVia('anna', 'roman'), 'web');
  await first.close();

  const reloaded = createAccountStore({ dir });
  t.after(() => reloaded.close());
  assert.equal(reloaded.readTs('anna', 'roman'), 2000);
  assert.equal(reloaded.readAt('anna', 'roman'), 9000);
  assert.equal(reloaded.readVia('anna', 'roman'), 'web');

  // What a client may hand over is not always what gets stored: a snapshot is a
  // file a future version has to trust, and this string is painted on another
  // account's screen. An advance whose kind is unknown *clears* the client: the
  // old value described the watermark this receipt just moved past, so keeping
  // it would label the new reading with whoever did the old one.
  reloaded.recordHistory('roman', 'anna', { id: 'm3', from: 'roman', text: 'третье', ts: 3000 });
  assert.equal(await reloaded.markRead('anna', 'roman', 'm3', '<img src=x>'), 3000);
  assert.equal(reloaded.readVia('anna', 'roman'), '', 'an unknown kind clears the client');
  reloaded.recordHistory('roman', 'anna', { id: 'm4', from: 'roman', text: 'четвёртое', ts: 4000 });
  assert.equal(await reloaded.markRead('anna', 'roman', 'm4', 'android/175'), 4000);
  assert.equal(reloaded.readVia('anna', 'roman'), 'android/175', 'a later advance names its own client');
});

// The ✓✓ rung is a message the peer's *device* holds, one rung above the server
// committing it and one below the peer having read it. It is remembered with
// the same forward-only rule as a read receipt, and survives a reopen for the
// same reason: the ack that carries it is a live frame.
test('markDelivered remembers how far a peer\'s device got, never backwards, and survives a reopen', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = createAccountStore({ dir, writeDelayMs: 5000 });

  await first.register({ login: 'roman', password: 'longenough' });
  await first.register({ login: 'anna', password: 'longenough' });
  first.recordHistory('roman', 'anna', { id: 'm1', from: 'roman', text: 'первое', ts: 1000 });
  first.recordHistory('roman', 'anna', { id: 'm2', from: 'roman', text: 'второе', ts: 2000 });

  assert.equal(first.deliveredTs('anna', 'roman'), 0);
  assert.equal(await first.markDelivered('anna', 'roman', 'm2'), 2000);
  assert.equal(first.deliveredTs('anna', 'roman'), 2000);
  // An older ack draining late must not un-deliver the newer message, and one
  // for a message at or below the watermark is not an advance at all.
  assert.equal(await first.markDelivered('anna', 'roman', 'm1'), 0, 'the watermark does not move backwards');
  assert.equal(first.deliveredTs('anna', 'roman'), 2000);
  // An id the shared log does not hold is not a timestamp to guess at.
  assert.equal(await first.markDelivered('anna', 'roman', 'nope'), 0);
  assert.equal(first.deliveredTs('anna', 'roman'), 2000);
  // Delivery is not reading: the read watermark stays put, and a merely
  // delivered message is still owed to a reader who has not read it.
  assert.equal(first.readTs('anna', 'roman'), 0, 'a delivery never claims a read');
  first.enqueue('anna', { from: 'roman', d: { t: 'msg', id: 'm2', ts: 2000 }, at: 2000 });
  assert.equal(await first.markDelivered('anna', 'roman', 'm2'), 0);
  assert.deepEqual(
    first.drain('anna', 'roman').map((item) => item.d.id),
    ['m2'],
    'the delivered-but-unread copy is still replayed',
  );
  await first.close();

  const reloaded = createAccountStore({ dir });
  t.after(() => reloaded.close());
  assert.equal(reloaded.deliveredTs('anna', 'roman'), 2000);
});

// Reading implies delivery, so a read advance raises the delivery watermark too,
// and both a per-message receipt and «отметить прочитанным» say the same thing.
// `deliveredTs` reads the two watermarks together, which is what stops a
// snapshot written before `deliveries` existed from reporting a plainly read
// message as undelivered.
test('a read receipt also delivers, and deliveredTs is the max of the two watermarks', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'roman', password: 'longenough' });
  await store.register({ login: 'anna', password: 'longenough' });
  store.recordHistory('roman', 'anna', { id: 'm1', from: 'roman', text: 'первое', ts: 1000 });
  store.recordHistory('roman', 'anna', { id: 'm2', from: 'roman', text: 'второе', ts: 2000 });
  store.recordHistory('roman', 'anna', { id: 'm3', from: 'roman', text: 'третье', ts: 3000 });

  assert.equal(await store.markRead('anna', 'roman', 'm2'), 2000);
  assert.equal(store.readTs('anna', 'roman'), 2000);
  assert.equal(store.deliveredTs('anna', 'roman'), 2000, 'reading delivers what it read');
  // A later ack can carry delivery past the read watermark: the device has the
  // message but has not looked at it yet.
  assert.equal(await store.markDelivered('anna', 'roman', 'm3'), 3000);
  assert.equal(store.deliveredTs('anna', 'roman'), 3000);
  assert.equal(store.readTs('anna', 'roman'), 2000, 'delivery never moves the read watermark');
  // «Отметить прочитанным» reads — and therefore delivers — the whole thread,
  // and a repeated receipt for an already-delivered message changes nothing.
  assert.equal(await store.markConversationRead('anna', 'roman'), 3000);
  assert.equal(store.deliveredTs('anna', 'roman'), 3000);
});

// A snapshot is a file a future version has to trust: the delivery watermark is
// parsed with the same shape rules as `reads`, and an entry that reaches a
// foreign, reversed or malformed key is dropped rather than adopted.
test('the delivery watermark is validated on load and heals from the read watermark', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createAccountStore({ dir });
  for (const login of ['anna', 'roman', 'boris']) await store.register({ login, password: 'longenough' });
  store.recordHistory('roman', 'anna', { id: 'm1', from: 'roman', text: 'первое', ts: 1000 });
  store.recordHistory('roman', 'anna', { id: 'm2', from: 'roman', text: 'второе', ts: 2000 });
  store.recordHistory('boris', 'anna', { id: 'b1', from: 'boris', text: 'третье', ts: 3000 });
  store.recordHistory('boris', 'anna', { id: 'b2', from: 'boris', text: 'четвёртое', ts: 4000 });
  assert.equal(await store.markDelivered('anna', 'roman', 'm2'), 2000);
  assert.equal(await store.markRead('anna', 'boris', 'b2'), 4000);
  await store.flush();
  await store.close();

  const raw = readFile(path.join(dir, 'accounts.json'));
  assert.deepEqual(raw.deliveries, { anna: { 'anna|roman': 2000, 'anna|boris': 4000 } });
  // A snapshot is a file a future version has to trust: an entry with reversed
  // sides, a non-positive value or a key that is not a conversation at all is
  // dropped rather than adopted, exactly like `reads`.
  raw.deliveries = {
    anna: {
      'anna|roman': 2000,
      'boris|anna': 2000,
      'anna|anna|roman': 6000,
      'anna|boris': -1,
    },
    __proto__: { 'anna|roman': 9000 },
  };
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(raw));

  const reloaded = createAccountStore({ dir });
  t.after(() => reloaded.close());
  assert.equal(reloaded.deliveredTs('anna', 'roman'), 2000, 'the valid entry survives');
  // The malformed entry for this conversation was dropped, and no delivery
  // entry is left for it — a snapshot written before delivery tracking existed.
  // `deliveredTs` still answers with the read watermark rather than reporting a
  // plainly read message as undelivered.
  assert.equal(reloaded.deliveredTs('anna', 'boris'), 4000, 'a read watermark answers delivery too');
  assert.equal(reloaded.deliveredTs('roman', 'anna'), 0, 'a missing entry is not invented');
});

// «Отметить прочитанным» is the same fact as a per-message receipt, so it names
// its client the same way — from the stored value both the reader's other
// devices and the author's rebuilt transcript read.
test('markConversationRead records the client that marked it read', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'anna', password: 'longenough' });
  await store.register({ login: 'boris', password: 'longenough' });
  store.recordHistory('boris', 'anna', { id: 'b1', from: 'boris', text: 'привет', ts: 1000 });
  store.recordHistory('boris', 'anna', { id: 'b2', from: 'boris', text: 'ещё', ts: 2000 });

  assert.equal(store.readVia('anna', 'boris'), '');
  assert.equal(await store.markConversationRead('anna', 'boris', 'android/175'), 2000);
  assert.equal(store.readVia('anna', 'boris'), 'android/175');
  assert.equal(store.readTs('anna', 'boris'), 2000);

  // Nothing new to read: the value describes the advance, so a second call for
  // the same newest message must not invent another client for it.
  assert.equal(await store.markConversationRead('anna', 'boris', 'cli'), 2000);
  assert.equal(store.readVia('anna', 'boris'), 'android/175');
});

test('a read receipt clears the queued copies behind it, so the unread badge does not outlive the reading', async (t) => {
  const { store } = withStore(t);
  await store.register({ login: 'roman', password: 'longenough' });
  await store.register({ login: 'anna', password: 'longenough' });

  store.recordHistory('roman', 'anna', { id: 'm1', from: 'roman', text: 'первое', ts: 1000 });
  store.recordHistory('roman', 'anna', { id: 'm2', from: 'roman', text: 'второе', ts: 2000 });
  store.recordHistory('roman', 'anna', { id: 'm3', from: 'roman', text: 'третье', ts: 3000 });
  // The frames anna's account was never handed live, plus a control frame that
  // still has to be replayed whatever she has read.
  store.enqueue('anna', { from: 'roman', d: { t: 'msg', id: 'm1', ts: 1000 }, at: 1000 });
  store.enqueue('anna', { from: 'roman', d: { t: 'msg', id: 'm2', ts: 2000 }, at: 2000 });
  store.enqueue('anna', { from: 'roman', d: { t: 'msg', id: 'm3', ts: 3000 }, at: 3000 });
  store.enqueue('anna', { from: 'roman', d: { t: 'react', id: 'm1', emoji: '👍' }, at: 2500 });
  assert.deepEqual(store.unreadCounts('anna'), { roman: 3 });

  assert.equal(await store.markRead('anna', 'roman', 'm2'), 2000);
  assert.deepEqual(store.unreadCounts('anna'), { roman: 1 }, 'only the message above the watermark is still unread');
  assert.deepEqual(
    store.drain('anna', 'roman').map((item) => `${item.d.t}:${item.d.id}`),
    ['msg:m3', 'react:m1'],
    'the read messages are gone, the reaction is still replayed',
  );

  // A repeated receipt for an already-read message is exactly the case where
  // the badge was still standing, so it purges too.
  store.enqueue('anna', { from: 'roman', d: { t: 'msg', id: 'm1', ts: 1000 }, at: 4000 });
  assert.equal(await store.markRead('anna', 'roman', 'm1'), 2000, 'the watermark does not move backwards');
  assert.deepEqual(store.unreadCounts('anna'), {});

  // Anna reading says nothing about what roman has read.
  store.enqueue('roman', { from: 'anna', d: { t: 'msg', id: 'a1', ts: 5000 }, at: 5000 });
  assert.deepEqual(store.unreadCounts('roman'), { anna: 1 });
});

test('the hidden set is deduped, capped and inert for a foreign conversation in the file', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createAccountStore({ dir });
  await store.register({ login: 'roman', password: 'longenough' });
  await store.hideHistory('roman', 'anna', Array.from({ length: 1200 }, (_, index) => `m${index}`));
  await store.flush();
  assert.deepEqual(readFile(path.join(dir, 'accounts.json')).hidden.roman['anna|roman'].length, 1000);
  await store.close();

  const raw = readFile(path.join(dir, 'accounts.json'));
  raw.hidden = {
    roman: { 'anna|roman': ['m1', 'm1', 7, ''], 'anna|boris': ['x'], broken: ['y'] },
    __proto__: { 'anna|roman': ['z'] },
  };
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(raw));

  const reloaded = createAccountStore({ dir });
  t.after(() => reloaded.close());
  reloaded.recordHistory('roman', 'anna', { id: 'm1', from: 'roman', text: 'первое' });
  reloaded.recordHistory('roman', 'anna', { id: 'm2', from: 'anna', text: 'второе' });
  assert.deepEqual(reloaded.history('roman', 'anna').map((item) => item.id), ['m2']);
  assert.deepEqual(reloaded.history('anna', 'roman').map((item) => item.id), ['m1', 'm2']);
});

test('deleteHistory discards content, survives reload and hides tombstones by default', async (t) => {
  const { store, dir } = withStore(t);
  store.recordHistory('anna', 'boris', { id: 'own', from: 'anna', text: 'secret', ts: 100 });
  store.recordHistory('anna', 'boris', { id: 'peer', from: 'boris', text: 'theirs', ts: 200 });
  assert.deepEqual(await store.deleteHistory('anna', 'boris', ['own', 'peer']), ['own']);
  assert.deepEqual(store.history('anna', 'boris').map((item) => item.id), ['peer']);
  const markers = store.history('anna', 'boris', 60, { includeDeleted: true });
  assert.equal(markers[0].text, '');
  assert.ok(markers[0].deletedAt);
  assert.equal(await store.editHistory('anna', 'boris', 'own', 'anna', 'restore'), null);
  assert.equal(await store.reactHistory('anna', 'boris', 'own', 'boris', '👍', true), null);
  await store.hideHistory('anna', 'boris', ['peer']);
  assert.equal(store.history('anna', 'boris', 60, { includeDeleted: true }).length, 1);
  assert.equal(store.history('boris', 'anna', 60, { includeDeleted: true })[1].text, 'theirs');
  await store.flush();
  const reopened = createAccountStore({ dir });
  assert.equal(reopened.history('boris', 'anna', 60, { includeDeleted: true })[0].text, '');
  await reopened.close();
});

// The unread badge has three independent sources — a receipt watermark, the
// offline queue and reaction notifications — and before this only the first
// two could ever be cleared without the reacted message being on screen.
// A forward is a copy that remembers whose words it is: the attribution has to
// survive the store, or history reload turns every forward into a plain
// message the reader believes the sender wrote.
test('a forwarded message keeps its attribution and loses it when tombstoned', async (t) => {
  const { store } = withStore(t);
  for (const login of ['anna', 'boris']) await store.register({ login, password: 'longenough' });
  store.recordHistory('anna', 'boris', {
    id: 'f1',
    from: 'anna',
    text: 'чужие слова',
    ts: 1000,
    forwardedFrom: { login: 'roman', name: 'Роман' },
  });
  assert.deepEqual(store.history('anna', 'boris')[0].forwardedFrom, { login: 'roman', name: 'Роман' });

  store.recordHistory('anna', 'boris', { id: 'f2', from: 'anna', text: 'своё', ts: 2000, forwardedFrom: { name: '' } });
  assert.equal(store.history('anna', 'boris')[1].forwardedFrom, undefined, 'an empty attribution is not stored');

  await store.deleteHistory('anna', 'boris', ['f1']);
  assert.equal(store.history('anna', 'boris', 60, { includeDeleted: true })[0].forwardedFrom, undefined);
});

test('markConversationRead ends every kind of unread this conversation holds', async (t) => {
  const { store } = withStore(t);
  for (const login of ['anna', 'boris', 'roman']) await store.register({ login, password: 'longenough' });
  store.recordHistory('anna', 'boris', { id: 'm1', from: 'boris', text: 'первое', ts: 1000 });
  store.recordHistory('anna', 'boris', { id: 'm2', from: 'boris', text: 'второе', ts: 2000 });
  await store.reactHistory('anna', 'boris', 'm1', 'boris', '👍', true);
  store.enqueue('anna', { from: 'boris', d: { t: 'msg', id: 'm2' }, at: 2000 });
  store.enqueue('anna', { from: 'roman', d: { t: 'msg', id: 'r1' }, at: 2100 });

  assert.equal(await store.markConversationRead('anna', 'boris'), 2000);
  assert.equal(store.readTs('anna', 'boris'), 2000);
  assert.deepEqual(store.pending('anna'), { roman: 1 }, 'only this peer\'s queue is dropped');
  assert.equal(store.reactionEvents('anna', 'boris').length, 0);
  // The peer's own view of the thread is untouched: they have read nothing.
  assert.equal(store.readTs('boris', 'anna'), 0);
});

test('reaction events are deduplicated, isolated by reader and persist read acknowledgement', async (t) => {
  const { store, dir } = withStore(t);
  store.recordHistory('anna', 'boris', { id: 'm', from: 'anna', text: 'hello', ts: 1 });
  await store.reactHistory('anna', 'boris', 'm', 'boris', '👍', true);
  await store.reactHistory('anna', 'boris', 'm', 'boris', '👍', true);
  const events = store.reactionEvents('anna', 'boris');
  assert.equal(events.length, 1);
  assert.equal(store.reactionEvents('boris', 'anna').length, 0);
  store.readReactionEvents('boris', 'anna', [events[0].id]);
  assert.equal(store.reactionEvents('anna', 'boris').length, 1);
  store.readReactionEvents('anna', 'boris', [events[0].id]);
  assert.equal(store.reactionEvents('anna', 'boris').length, 0);
  await store.reactHistory('anna', 'boris', 'm', 'boris', '❤️', true);
  await store.reactHistory('anna', 'boris', 'm', 'boris', '❤️', false);
  assert.equal(store.reactionEvents('anna', 'boris').length, 0);
  await store.flush();
  const reopened = createAccountStore({ dir });
  assert.equal(reopened.reactionEvents('anna', 'boris').length, 0);
  await reopened.close();
});

// A client retry: the ack for a commit never arrived, so the client resends
// the exact same message under the same id before the first attempt's WAL
// fsync has resolved. Both calls race commitHistory synchronously — this is
// what an in-flight join must catch, since findHistoryMessage alone only
// sees a retry that arrives after the first commit already applied.
test('two concurrent commitHistory retries with the same id and text settle on one committed row', async (t) => {
  const { store } = withStore(t);

  const [a, b] = await Promise.all([
    store.commitHistory('roman', 'anna', { id: 'retry-1', from: 'roman', text: 'let me know when you land' }),
    store.commitHistory('roman', 'anna', { id: 'retry-1', from: 'roman', text: 'let me know when you land' }),
  ]);

  assert.equal(a.seq, b.seq);
  assert.equal(a.ts, b.ts);
  assert.equal(Number.isFinite(a.seq), true);

  const rows = store.history('roman', 'anna').filter((item) => item.id === 'retry-1');
  assert.equal(rows.length, 1);
});

test('two concurrent commitHistory retries with a matching image dataUrl also settle on one row', async (t) => {
  const { store } = withStore(t);
  const image = { dataUrl: 'data:image/jpeg;base64,YQ==', width: 640, height: 480 };

  const [a, b] = await Promise.all([
    store.commitHistory('roman', 'anna', { id: 'retry-2', from: 'roman', text: 'photo', image: { ...image } }),
    store.commitHistory('roman', 'anna', { id: 'retry-2', from: 'roman', text: 'photo', image: { ...image } }),
  ]);

  assert.equal(a.seq, b.seq);

  const rows = store.history('roman', 'anna').filter((item) => item.id === 'retry-2');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].image, image);
});

// §3b, process-death half: edit/react/delete/hide now route through the same
// WAL `commitHistory` already used for messages, so a kill -9 between "the
// peer was told" and the next debounced snapshot must not lose the mutation.
// Each test below never calls `close()` on the first store — the whole point
// is that nothing here ever reaches accounts.json; a second store opened on
// the same directory is exactly what a restarted process sees, and it can
// only be right if it replayed the journal, since the snapshot has nothing.
test('an edit is not lost if the process is killed before the next debounced snapshot', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = createAccountStore({ dir, writeDelayMs: 60_000 });
  await first.register({ login: 'roman', password: 'longenough' });
  await first.register({ login: 'anna', password: 'longenough' });
  await first.commitHistory('roman', 'anna', { id: 'm1', from: 'roman', text: 'before' });
  const edited = await first.editHistory('roman', 'anna', 'm1', 'roman', 'after');
  assert.equal(edited.text, 'after');

  const recovered = createAccountStore({ dir });
  t.after(() => recovered.close());
  const record = recovered.history('roman', 'anna').find((item) => item.id === 'm1');
  assert.ok(record, 'the message itself was never snapshotted either, and still exists');
  assert.equal(record.text, 'after');
  assert.equal(record.editedAt, first.history('roman', 'anna').find((item) => item.id === 'm1').editedAt);
});

test('a reaction is not lost if the process is killed before the next debounced snapshot', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = createAccountStore({ dir, writeDelayMs: 60_000 });
  await first.register({ login: 'roman', password: 'longenough' });
  await first.register({ login: 'anna', password: 'longenough' });
  await first.commitHistory('roman', 'anna', { id: 'm1', from: 'roman', text: 'hello' });
  const reacted = await first.reactHistory('roman', 'anna', 'm1', 'anna', '👍', true);
  assert.deepEqual(reacted.reactions, { '👍': ['anna'] });

  const recovered = createAccountStore({ dir });
  t.after(() => recovered.close());
  const record = recovered.history('roman', 'anna').find((item) => item.id === 'm1');
  assert.ok(record);
  assert.deepEqual(record.reactions, { '👍': ['anna'] });
  assert.equal(record.reactionEvents.length, 1);
});

test('a delete-for-everyone is not lost if the process is killed before the next debounced snapshot', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = createAccountStore({ dir, writeDelayMs: 60_000 });
  await first.register({ login: 'roman', password: 'longenough' });
  await first.register({ login: 'anna', password: 'longenough' });
  await first.commitHistory('roman', 'anna', { id: 'm1', from: 'roman', text: 'oops' });
  assert.deepEqual(await first.deleteHistory('roman', 'anna', ['m1']), ['m1']);

  const recovered = createAccountStore({ dir });
  t.after(() => recovered.close());
  assert.equal(recovered.history('roman', 'anna').find((item) => item.id === 'm1'), undefined);
});

test('a hide-for-self is not lost if the process is killed before the next debounced snapshot', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = createAccountStore({ dir, writeDelayMs: 60_000 });
  await first.register({ login: 'roman', password: 'longenough' });
  await first.register({ login: 'anna', password: 'longenough' });
  await first.commitHistory('roman', 'anna', { id: 'm1', from: 'roman', text: 'секрет' });
  assert.equal(await first.hideHistory('roman', 'anna', ['m1']), 1);

  const recovered = createAccountStore({ dir });
  t.after(() => recovered.close());
  assert.equal(recovered.history('roman', 'anna').find((item) => item.id === 'm1'), undefined, 'hidden for the owner');
  assert.ok(recovered.history('anna', 'roman').find((item) => item.id === 'm1'), 'the peer keeps its own copy');
});

test('manual unread overlays one badge without moving receipts and clears on read', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = createAccountStore({ dir, writeDelayMs: 5000 });
  await first.register({ login: 'roman', password: 'longenough' });
  await first.register({ login: 'anna', password: 'longenough' });
  first.linkFriends('roman', 'anna');
  first.recordHistory('roman', 'anna', { id: 'm1', from: 'anna', text: 'ответь', ts: 1000 });
  assert.equal(await first.markConversationRead('roman', 'anna'), 1000);
  const readTs = first.readTs('roman', 'anna');

  assert.equal(first.markConversationUnread('roman', 'anna'), true);
  assert.deepEqual(first.unreadCounts('roman'), { anna: 1 });
  assert.equal(first.readTs('roman', 'anna'), readTs, 'manual unread never lies to read receipts');
  await first.close();

  const reloaded = createAccountStore({ dir });
  t.after(() => reloaded.close());
  assert.equal(reloaded.isMarkedUnread('roman', 'anna'), true);
  assert.deepEqual(reloaded.unreadCounts('roman'), { anna: 1 });
  await reloaded.markConversationRead('roman', 'anna');
  assert.equal(reloaded.isMarkedUnread('roman', 'anna'), false);
  assert.deepEqual(reloaded.unreadCounts('roman'), {});
});

test('reply reminders persist, fire once while offline and remain until acknowledged', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 10_000;
  const first = createAccountStore({ dir, now: () => clock, writeDelayMs: 5000 });
  await first.register({ login: 'roman', password: 'longenough' });
  await first.register({ login: 'anna', password: 'longenough' });
  first.linkFriends('roman', 'anna');
  first.recordHistory('roman', 'anna', { id: 'm1', from: 'anna', text: 'вопрос', ts: 9000 });

  assert.equal(first.scheduleReplyReminder('roman', 'anna', 'missing', 20_000), null);
  assert.equal(first.scheduleReplyReminder('roman', 'anna', 'm1', 9_999), null);
  const scheduled = first.scheduleReplyReminder('roman', 'anna', 'm1', 20_000);
  assert.equal(scheduled.peer, 'anna');
  assert.equal(scheduled.messageId, 'm1');
  assert.equal(first.nextReplyReminderAt(), 20_000);
  await first.close();

  clock = 20_001;
  const reloaded = createAccountStore({ dir, now: () => clock });
  t.after(() => reloaded.close());
  const due = reloaded.dueReplyReminders();
  assert.equal(due.length, 1);
  assert.equal(due[0].owner, 'roman');
  assert.equal(reloaded.dueReplyReminders().length, 0, 'a reminder fires only once');
  assert.deepEqual(
    reloaded.firedReplyReminders('roman').map(({ id, peer, messageId, dueAt }) => ({ id, peer, messageId, dueAt })),
    [{ id: scheduled.id, peer: 'anna', messageId: 'm1', dueAt: 20_000 }],
  );
  assert.equal(reloaded.ackReplyReminder('anna', scheduled.id), false, 'another owner cannot acknowledge it');
  assert.equal(reloaded.ackReplyReminder('roman', scheduled.id), true);
  assert.deepEqual(reloaded.firedReplyReminders('roman'), []);
});

test('a bot account is marked once, survives a reload, and cannot be a stranger', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = createAccountStore({ dir, writeDelayMs: 5000 });
  await first.register({ login: 'roman', password: 'longenough' });
  await first.register({ login: 'reminder', password: 'longenough' });

  assert.equal(first.isBot('reminder'), false, 'nothing is a bot until its own client says so');
  assert.equal(first.markBot('reminder'), true);
  assert.equal(first.markBot('reminder'), false, 'the flag is written once');
  assert.equal(first.isBot('reminder'), true);
  assert.equal(first.markBot('ghost'), false, 'an account that does not exist cannot be marked');
  assert.equal(first.isBot('ghost'), false);
  assert.equal(first.isBot('roman'), false);
  await first.close();

  const reloaded = createAccountStore({ dir });
  t.after(() => reloaded.close());
  assert.equal(reloaded.isBot('reminder'), true, 'durable: a property of the account, not of a connection');
  assert.equal(reloaded.isBot('roman'), false);
});

test('confirmed read and delivery receipts survive a restart before checkpoint', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = createAccountStore({ dir, writeDelayMs: 60_000 });
  t.after(() => first.close());
  await first.register({ login: 'anna', password: 'longenough' });
  await first.register({ login: 'boris', password: 'longenough' });
  first.linkFriends('anna', 'boris');
  first.recordHistory('anna', 'boris', { id: 'm1', from: 'anna', text: 'read', ts: 1000 });
  first.recordHistory('anna', 'boris', { id: 'm2', from: 'anna', text: 'delivered', ts: 2000 });
  first.enqueue('boris', { from: 'anna', d: { t: 'msg', id: 'm1', ts: 1000 }, at: 1000 });
  first.enqueue('boris', { from: 'anna', d: { t: 'msg', id: 'm2', ts: 2000 }, at: 2000 });
  await first.flush();
  await first.markRead('boris', 'anna', 'm1', 'android/178');
  await first.markDelivered('boris', 'anna', 'm2');
  const recovered = createAccountStore({ dir, writeDelayMs: 60_000 });
  t.after(() => recovered.close());
  assert.equal(recovered.readTs('boris', 'anna'), 1000);
  assert.equal(recovered.readVia('boris', 'anna'), 'android/178');
  assert.equal(recovered.deliveredTs('boris', 'anna'), 2000);
  assert.deepEqual(recovered.unreadCounts('boris'), { anna: 1 });
  await recovered.markConversationRead('boris', 'anna', 'web');
  const again = createAccountStore({ dir, writeDelayMs: 60_000 });
  t.after(() => again.close());
  assert.equal(again.readTs('boris', 'anna'), 2000);
  assert.equal(again.readVia('boris', 'anna'), 'web');
  assert.deepEqual(again.unreadCounts('boris'), {});
});

test('a failed receipt journal write changes neither watermark nor unread queue', async (t) => {
  const journal = {
    replay: () => 0, settled: async () => {}, truncate: async () => {}, close: async () => {},
    append: async () => { throw new Error('disk full'); },
  };
  const { store } = withStore(t, { journal });
  await store.register({ login: 'anna', password: 'longenough' });
  await store.register({ login: 'boris', password: 'longenough' });
  store.recordHistory('anna', 'boris', { id: 'm1', from: 'anna', text: 'still unread', ts: 1000 });
  store.enqueue('boris', { from: 'anna', d: { t: 'msg', id: 'm1', ts: 1000 }, at: 1000 });
  await assert.rejects(store.markRead('boris', 'anna', 'm1', 'web'), /disk full/);
  await assert.rejects(store.markDelivered('boris', 'anna', 'm1'), /disk full/);
  await assert.rejects(store.markConversationRead('boris', 'anna', 'web'), /disk full/);
  assert.equal(store.readTs('boris', 'anna'), 0);
  assert.equal(store.deliveredTs('boris', 'anna'), 0);
  assert.deepEqual(store.unreadCounts('boris'), { anna: 1 });
});

for (const kind of ['receipt', 'history']) {
  test(`a checkpoint overlapping an unfinished ${kind} commit retains its journal entry`, async () => {
    const dir = tempDir();
    const base = createJournal({ file: path.join(dir, 'accounts.journal') });
    let held = false;
    let armed = false;
    let release;
    let checkpointed;
    let retired;
    const gate = new Promise((resolve) => { release = resolve; });
    const checkpoint = new Promise((resolve) => { checkpointed = resolve; });
    const truncated = new Promise((resolve) => { retired = resolve; });
    const journal = {
      replay: base.replay,
      append: async (entry) => {
        await base.append(entry);
        if (armed && entry.kind === kind) {
          held = true;
          await gate;
        }
      },
      truncate: async (through) => {
        if (held) {
          checkpointed();
          await gate;
        }
        await base.truncate(through);
        if (held) retired();
      },
      settled: async () => {
        if (held) await gate;
        await base.settled();
      },
      close: base.close,
    };
    const first = createAccountStore({ dir, journal, writeDelayMs: 100 });
    let recovered;
    let timeout;
    try {
      await first.register({ login: 'anna', password: 'longenough' });
      await first.register({ login: 'boris', password: 'longenough' });
      await first.flush();
      await first.commitHistory('boris', 'anna', { id: 'baseline', from: 'boris', text: 'baseline', ts: 1000 });
      armed = true;
      const accepted = kind === 'receipt'
        ? first.markRead('anna', 'boris', 'baseline', 'web')
        : first.commitHistory('boris', 'anna', { id: 'overlap', from: 'boris', text: 'overlapping commit', ts: 2000 });
      await Promise.race([
        checkpoint,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('checkpoint never ran')), 3000);
        }),
      ]);
      clearTimeout(timeout);
      release();
      await accepted;
      await truncated;
      recovered = createAccountStore({ dir, writeDelayMs: 60_000 });
      if (kind === 'receipt') {
        assert.equal(recovered.readTs('anna', 'boris'), 1000);
        assert.equal(recovered.deliveredTs('anna', 'boris'), 1000);
        assert.equal(recovered.readVia('anna', 'boris'), 'web');
      } else {
        assert.equal(recovered.history('anna', 'boris').find((row) => row.id === 'overlap')?.text, 'overlapping commit');
      }
    } finally {
      clearTimeout(timeout);
      release();
      if (recovered) await recovered.close();
      await first.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
