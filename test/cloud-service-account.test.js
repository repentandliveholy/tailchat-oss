import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAccountStore as createLegacyStore } from '../src/cloud/accounts.js';
import { createCloudHub } from '../src/cloud/hub.js';
import {
  ANDROID_NOTES_FILE,
  SERVICE_LOGIN,
  SERVICE_NAME,
  androidNotes,
  announceAppBuild,
  announceRelease,
  ensureServiceAccount,
  parseAnnouncements,
  releaseNotes,
} from '../src/cloud/service-account.js';

const createAccountStore = (options) => createLegacyStore({ allowPlaintextLegacy: true, keyFile: null, ...options });

const tick = () => new Promise((resolve) => setImmediate(resolve));

function accountWorld(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-cloud-service-account-'));
  const store = createAccountStore({ dir, writeDelayMs: 5000 });
  t.after(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, hub: createCloudHub({ store }) };
}

test('ensureServiceAccount creates the official account once and discards its session', async (t) => {
  const { store } = accountWorld(t);
  const register = store.register;
  let registrations = 0;
  let issuedToken = null;
  store.register = async (details) => {
    registrations += 1;
    const result = await register(details);
    issuedToken = result.token;
    return result;
  };

  assert.equal(await ensureServiceAccount(store), true);
  assert.equal(await ensureServiceAccount(store), false);
  assert.equal(registrations, 1);
  const official = store.users().filter((user) => user.login === SERVICE_LOGIN);
  assert.equal(official.length, 1);
  assert.equal(official[0].name, SERVICE_NAME);
  assert.equal(store.resolveToken(issuedToken), null, 'the creation token is revoked immediately');
});

test('releaseNotes is concise, localized and explains how to update', () => {
  for (const lang of ['ru', 'en', 'fr']) {
    const found = releaseNotes('9.9', { lang });
    assert.ok(found.startsWith('Tailchat 9.9\n\n'));
    assert.ok(found.length < 500);
  }
  assert.match(releaseNotes('9.9', { lang: 'ru' }), /Обновить.*перезагрузите/s);
  assert.match(releaseNotes('9.9', { lang: 'en' }), /Update.*reload/s);
  assert.match(releaseNotes('9.9', { lang: 'fr' }), /Mettre à jour.*rechargez/s);
});

// Fixtures go to a temp directory: the real docs/announcements.md is the file
// the default path resolves to, and a test that wrote there would change what
// production sends.
function announcementFile(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-announcements-'));
  const file = path.join(dir, 'announcements.md');
  fs.writeFileSync(file, text);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

test('parseAnnouncements keeps sections apart and ignores unknown subheadings', () => {
  const sections = parseAnnouncements([
    '# Release messages',
    'preamble outside every section',
    '',
    '## 0.55.0',
    '### ru',
    'Новый Android.',
    '',
    '### en',
    'A new Android build.',
    '### notes',
    'internal reminder, never shipped',
    '',
    '## 0.54.0',
    '### ru',
    'Прошлый релиз.',
    '',
  ].join('\n'));

  assert.deepEqual(Object.keys(sections).sort(), ['0.54.0', '0.55.0']);
  assert.deepEqual(sections['0.55.0'], { ru: 'Новый Android.', en: 'A new Android build.' });
  assert.deepEqual(sections['0.54.0'], { ru: 'Прошлый релиз.' });
  assert.equal(sections['0.55.0'].notes, undefined, 'a `### notes` block is not a language');
  assert.ok(!sections['0.55.0'].en.includes('internal reminder'), 'an unknown subheading ends the body');
  assert.ok(!sections['0.55.0'].ru.includes('Прошлый'), 'the next version does not leak backwards');
  assert.ok(!sections['0.54.0'].ru.includes('Новый'), 'the previous version does not leak forwards');
  assert.equal(sections['0.55.0'].fr, undefined, 'a language without a subsection is absent');
});

test('releaseNotes prefers the announcement file over the generic sentence', (t) => {
  const file = announcementFile(t, [
    '## 0.55.0',
    '### ru',
    'Нативный Android-клиент.',
    '### en',
    'A native Android client.',
    '',
    '## 0.54.0',
    '### ru',
    'Только по-русски.',
    '',
  ].join('\n'));

  assert.equal(releaseNotes('0.55.0', { file, lang: 'ru' }), 'Tailchat 0.55.0\n\nНативный Android-клиент.');
  assert.equal(releaseNotes('0.55.0', { file, lang: 'en' }), 'Tailchat 0.55.0\n\nA native Android client.');
  assert.equal(
    releaseNotes('0.55.0', { file, lang: 'fr' }),
    'Tailchat 0.55.0\n\nНативный Android-клиент.',
    'a language missing from the section falls back to the Russian text of that version',
  );
  assert.equal(releaseNotes('0.54.0', { file, lang: 'en' }), 'Tailchat 0.54.0\n\nТолько по-русски.');
  assert.match(
    releaseNotes('0.53.0', { file, lang: 'ru' }),
    /^Tailchat 0\.53\.0\n\nДоступна новая версия/,
    'a version the file says nothing about still gets the generic sentence',
  );
});

test('releaseNotes survives an unreadable or malformed announcement file', (t) => {
  const missing = path.join(os.tmpdir(), 'tailchat-announcements-absent', 'announcements.md');
  assert.match(releaseNotes('0.55.0', { file: missing, lang: 'ru' }), /Доступна новая версия/);
  assert.match(releaseNotes('0.55.0', { file: os.tmpdir(), lang: 'en' }), /A new Tailchat version/);

  const malformed = announcementFile(t, '##0.55.0\n### ru\nno space after the hashes\n\n### ru\n');
  assert.match(releaseNotes('0.55.0', { file: malformed, lang: 'ru' }), /Доступна новая версия/);
});

test('releaseNotes rereads the announcement file after it is rewritten', (t) => {
  const file = announcementFile(t, '## 0.55.0\n### ru\nПервая редакция.\n');
  assert.equal(releaseNotes('0.55.0', { file, lang: 'ru' }), 'Tailchat 0.55.0\n\nПервая редакция.');

  // A deploy rewrites the checkout under a live process; the cache key carries
  // mtime and size so the next announcement uses the new text without a restart.
  fs.writeFileSync(file, '## 0.55.0\n### ru\nВторая редакция, длиннее первой.\n');
  assert.equal(releaseNotes('0.55.0', { file, lang: 'ru' }), 'Tailchat 0.55.0\n\nВторая редакция, длиннее первой.');
});

test('releaseNotes caps an oversized announcement body', (t) => {
  const file = announcementFile(t, `## 0.55.0\n### ru\n${'я'.repeat(4000)}\n`);
  const notes = releaseNotes('0.55.0', { file, lang: 'ru' });
  const body = notes.slice('Tailchat 0.55.0\n\n'.length);

  assert.equal(body.length, 1200);
  assert.ok(body.endsWith('…'), 'the cut is visible to the reader');
});

test('the shipped announcement file describes the current release in three languages', () => {
  // Resolved from this file, not from the shell's cwd: `releaseNotes`' default
  // path is resolved the same way, and the two must name the same file.
  const shipped = new URL('../docs/announcements.md', import.meta.url);
  const sections = parseAnnouncements(fs.readFileSync(shipped, 'utf8'));
  const current = sections['1.26'];
  assert.ok(current, 'docs/announcements.md carries a section for 1.26');
  for (const lang of ['ru', 'en', 'fr']) {
    assert.ok(current[lang], `1.26 has a ${lang} body`);
    assert.ok(current[lang].length < 600, `the ${lang} body stays chat-sized`);
    assert.ok(current[lang].includes('https://repentandliveholy.org/tailchat/tailchat.apk'));
  }
  assert.match(current.ru, /Android/);
  assert.equal(releaseNotes('1.26', { lang: 'ru' }), `Tailchat 1.26\n\n${current.ru}`);
});

test('release announcements reach every user once per version through live and queued delivery', async (t) => {
  const { store, hub } = accountWorld(t);
  const anna = await store.register({ login: 'anna', password: 'longenough', name: 'Анна' });
  await store.register({ login: 'boris', password: 'longenough', name: 'Борис' });
  await ensureServiceAccount(store);

  assert.equal(announceRelease({
    store, hub, version: '1.11', notes: 'Tailchat 1.11\n\nПервый релиз.', now: () => 1100,
  }), 2);
  assert.equal(store.announcedVersion(), '1.11');
  for (const login of ['anna', 'boris']) {
    assert.deepEqual(
      store.history(SERVICE_LOGIN, login).map((message) => [message.id, message.from, message.text, message.ts]),
      [['release-1.11', SERVICE_LOGIN, 'Tailchat 1.11\n\nПервый релиз.', 1100]],
    );
    assert.equal(store.pending(login)[SERVICE_LOGIN], 1);
    assert.equal(store.areFriends(login, SERVICE_LOGIN), true);
  }
  assert.deepEqual(store.history(SERVICE_LOGIN, SERVICE_LOGIN), []);
  assert.deepEqual(store.pending(SERVICE_LOGIN), {});

  assert.equal(announceRelease({ store, hub, version: '1.11', notes: 'duplicate' }), 0);
  assert.equal(store.pending('anna')[SERVICE_LOGIN], 1);
  assert.equal(store.pending('boris')[SERVICE_LOGIN], 1);

  assert.equal(announceRelease({
    store, hub, version: '1.12', notes: 'Tailchat 1.12\n\nВторой релиз.', now: () => 1200,
  }), 2);
  assert.equal(store.announcedVersion(), '1.12');
  assert.equal(store.history(SERVICE_LOGIN, 'anna').length, 2);
  assert.equal(store.history(SERVICE_LOGIN, 'boris').length, 2);

  const events = [];
  const connection = hub.connect((payload) => events.push(payload));
  connection.receive({ k: 'auth', token: anna.token });
  await tick();
  connection.receive({ k: 'subscribe', peer: SERVICE_LOGIN });
  assert.deepEqual(
    events.filter((event) => event.k === 'frame').map((event) => [event.from, event.d.id]),
    [[SERVICE_LOGIN, 'release-1.11'], [SERVICE_LOGIN, 'release-1.12']],
    'an offline account drains both queued release notes when it opens the official chat',
  );
  assert.equal(store.pending('anna')[SERVICE_LOGIN], undefined);

  assert.equal(announceRelease({
    store, hub, version: '1.13', notes: 'Tailchat 1.13', now: () => 1300,
  }), 2);
  assert.deepEqual(
    events.filter((event) => event.k === 'frame').map((event) => event.d.id),
    ['release-1.11', 'release-1.12', 'release-1.13'],
    'a subscribed account receives the next release live',
  );
  assert.equal(store.pending('anna')[SERVICE_LOGIN], undefined);
  assert.equal(store.pending('boris')[SERVICE_LOGIN], 3);
  connection.close();
});

test('announceRelease uses recipient account language for release notes', async (t) => {
  const { store, hub } = accountWorld(t);
  await store.register({ login: 'jean', password: 'longenough', name: 'Jean', lang: 'fr' });
  await store.register({ login: 'john', password: 'longenough', name: 'John', lang: 'en' });
  await ensureServiceAccount(store);

  assert.equal(announceRelease({ store, hub, version: '1.99' }), 2);
  const jeanHistory = store.history(SERVICE_LOGIN, 'jean');
  const johnHistory = store.history(SERVICE_LOGIN, 'john');

  assert.equal(jeanHistory.length, 1);
  assert.equal(johnHistory.length, 1);
  assert.ok(jeanHistory[0].text.includes('Tailchat 1.99'));
  assert.ok(jeanHistory[0].text.includes('succès'));
  assert.ok(johnHistory[0].text.includes('Tailchat 1.99'));
  assert.ok(johnHistory[0].text.includes('successfully'));
});

test('androidNotes is per build and per language, and silent without a section', (t) => {
  const file = announcementFile(t, [
    '## 174',
    '',
    '### ru',
    '',
    'Что нового: поиск всегда на виду.',
    '',
    '### en',
    '',
    "What's new: the search field is always visible.",
    '',
  ].join('\n'));

  assert.equal(androidNotes(174, { file, lang: 'en' }), "What's new: the search field is always visible.");
  assert.equal(androidNotes(174, { file, lang: 'ru' }), 'Что нового: поиск всегда на виду.');
  // Russian is the language these are authored in, so it is the fallback —
  // the same order `releaseNotes` uses.
  assert.equal(androidNotes(174, { file, lang: 'fr' }), 'Что нового: поиск всегда на виду.');
  // No generic sentence here, unlike a release note: this message is about a
  // specific build, and there is nothing honest to say about one whose text
  // nobody wrote.
  assert.equal(androidNotes(175, { file, lang: 'ru' }), null);
  assert.equal(androidNotes(174, { file: path.join(os.tmpdir(), 'tailchat-absent-notes.md') }), null);

  const long = announcementFile(t, ['## 174', '', '### ru', '', 'я'.repeat(3000)].join('\n'));
  const capped = androidNotes(174, { file: long });
  assert.equal(capped.length, 1200);
  assert.ok(capped.endsWith('…'));
});

test('announceAppBuild writes one message about the build, once, and only with notes', async (t) => {
  const { store, hub } = accountWorld(t);
  await store.register({ login: 'anna', password: 'longenough', name: 'Анна' });
  await ensureServiceAccount(store);
  const file = announcementFile(t, ['## 174', '', '### ru', '', 'Что нового.'].join('\n'));

  const sent = announceAppBuild({ store, hub, login: 'anna', build: 174, file, now: () => 4242 });
  assert.equal(sent, true);
  assert.deepEqual(
    store.history(SERVICE_LOGIN, 'anna').map((message) => [message.id, message.text, message.ts]),
    [['android-174', 'Что нового.', 4242]],
  );
  // The thread is the bookkeeping: whatever re-runs this (a reconnect, a
  // reinstall, a restored snapshot) finds the message already there.
  assert.equal(announceAppBuild({ store, hub, login: 'anna', build: 174, file }), false);
  assert.equal(store.history(SERVICE_LOGIN, 'anna').length, 1);
  // A build nobody wrote notes for says nothing at all.
  assert.equal(announceAppBuild({ store, hub, login: 'anna', build: 175, file }), false);
  // And the account nobody signs into is never an audience.
  assert.equal(announceAppBuild({ store, hub, login: SERVICE_LOGIN, build: 174, file }), false);
  assert.equal(announceAppBuild({ store, hub, login: 'anna', build: 0, file }), false);
  assert.equal(store.history(SERVICE_LOGIN, 'anna').length, 1);
});

test('a client that reports its build is told about it once, on its own language', async (t) => {
  const { store, hub } = accountWorld(t);
  const anna = await store.register({ login: 'anna', password: 'longenough', name: 'Анна', lang: 'fr' });
  await ensureServiceAccount(store);

  // Taken from the shipped file rather than pinned here: the test is about the
  // delivery, not about which build the repository currently documents.
  const sections = parseAnnouncements(fs.readFileSync(ANDROID_NOTES_FILE, 'utf8'));
  const build = Object.keys(sections).find((key) => sections[key].ru);
  assert.ok(build, 'docs/android-notes.md documents at least one build in Russian');

  const first = hub.connect(() => {});
  // No `appVersion`: an old client, or a browser — nothing is owed to it.
  first.receive({ k: 'auth', token: anna.token });
  await tick();
  assert.deepEqual(store.history(SERVICE_LOGIN, 'anna'), []);
  first.close();

  const secondFrames = [];
  const second = hub.connect((payload) => secondFrames.push(payload));
  second.receive({ k: 'auth', token: anna.token, appVersion: Number(build) });
  await tick();
  assert.deepEqual(
    store.history(SERVICE_LOGIN, 'anna').map((message) => [message.id, message.text]),
    [[`android-${build}`, sections[build].fr ?? sections[build].ru]],
    'the build note arrives in the account language',
  );
  const ready = secondFrames.find((msg) => msg.k === 'ready');
  assert.ok(ready, 'client receives ready frame');
  const tailchatContact = ready.users.find((u) => u.login === SERVICE_LOGIN);
  assert.equal(tailchatContact?.pending, 1, 'build note leaves tailchat unread (pending = 1) in the ready roster');
  assert.equal(store.unreadCounts('anna')[SERVICE_LOGIN], 1, 'store records 1 unread message from tailchat');
  second.close();

  const thirdFrames = [];
  const third = hub.connect((payload) => thirdFrames.push(payload));
  third.receive({ k: 'auth', token: anna.token, appVersion: Number(build) });
  await tick();
  assert.equal(store.history(SERVICE_LOGIN, 'anna').length, 1, 'a reconnect repeats nothing');
  const thirdReady = thirdFrames.find((msg) => msg.k === 'ready');
  const thirdTailchat = thirdReady?.users.find((u) => u.login === SERVICE_LOGIN);
  assert.equal(thirdTailchat?.pending, 1, 'reconnect still shows unread until user reads the conversation');
  third.close();
});
