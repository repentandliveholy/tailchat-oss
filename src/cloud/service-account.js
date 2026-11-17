import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The official account every release note comes from. It is a real account —
// it has to be, or it could not appear in a roster or own a conversation — but
// it is the one account nobody signs into: the password below is thrown away
// the moment it has been hashed.
export const SERVICE_LOGIN = 'tailchat';
// Imported as a plain literal, not from ai-account.js: that module imports
// this one for the same reason, and a cycle between two constants helps
// nobody.
const AI_LOGIN = 'tailik';
export const SERVICE_NAME = 'Tailchat';

// Owner policy, 2026-09-18: the official account writes to nobody. A cloud,
// web or CLI release is not news anybody asked for in their conversation list,
// and an APK release announces itself where the decision is actually made —
// the app's own update popup, fed by `web/cloud/android-version.json` through
// `AppUpdateApi` — never as a chat message and never as a push.
//
// Both broadcast paths are gated on this in `src/cloud/server.js`: the boot
// pass and the registration pass. The machinery below is deliberately kept
// whole — the texts, the per-version ids, the idempotence — so reviving the
// notes is this one line, and a revival announces the then-current version
// exactly once. The contact itself is not part of the policy: the official
// account stays in every roster (`linkServiceAccountToEveryone`), only its
// messages are gone.
//
// Narrowed by the owner on 2026-09-28, and this is the shape in force: the
// broadcast stays off, and the one message the official account may write on
// its own initiative is about the *build the recipient is running*. It goes to
// a client that reports its `versionCode` when it connects (the Android app
// does, `CloudSocket.sendAuth`), it is written once per build per person
// (`android-<build>`, idempotent on the message id itself), and only when
// `docs/android-notes.md` carries a section for that build — a curation
// decision by whoever cut the release, not a restatement of the worklog. See
// `announceAppBuild`.
export const RELEASE_ANNOUNCEMENTS = false;

const PASSWORD_BYTES = 32;

// One id per version per recipient, so «has this person already been told
// about this release?» is answerable from the conversation itself rather than
// from a second bookkeeping structure that could disagree with it.
function announcementId(version) {
  return `release-${version}`;
}

// A chat message, not a release page: the worklog entry for a version runs to
// pages of Russian prose, and what belongs in a conversation is the top of it,
// per language. Those texts live in the repository next to the worklog, newest
// first. Resolved from this module's own location — same reason as
// `CHANGELOG_FILE` in src/changelog.js:8 — so the path holds no matter which
// directory the cloud process was started from.
export const ANNOUNCEMENTS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'announcements.md',
);

// What each Android build changed, for the people who installed it. Same shape
// as the file above (`## <versionCode>` then `### ru`/`### en`/`### fr`), same
// parser, different numbers: the headings here are Android `versionCode`s, not
// release versions, because the message is about the build the client is
// actually running.
export const ANDROID_NOTES_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'android-notes.md',
);

const ANNOUNCEMENT_LANGS = ['ru', 'en', 'fr'];
const ANNOUNCEMENT_VERSION = /^##\s+v?(\d+(?:\.\d+)*)\s*$/;
const ANNOUNCEMENT_LANG = /^###\s+([A-Za-z-]+)\s*$/;

// One announcement can outgrow a chat bubble by accident (a pasted worklog
// entry); a bubble nobody scrolls to the end of is worse than a cut one.
const MAX_NOTES_CHARS = 1200;

// Pure split of docs/announcements.md into `version -> { ru, en, fr }`.
// A language is present only when its subsection carries text, so a caller can
// fall through to another language on `undefined` rather than on an empty
// string. Both heading kinds close the block they follow: `##` because the
// next version must not inherit this one's body, and an unrecognised `###`
// (a `### notes` block, a typo'd code) because its lines belong to no
// language — appending them to the previous one would ship them to a reader.
export function parseAnnouncements(text) {
  const buffers = new Map();
  let version = null;
  let bucket = null;
  for (const line of String(text ?? '').split('\n')) {
    const head = ANNOUNCEMENT_VERSION.exec(line);
    if (head) {
      version = head[1];
      if (!buffers.has(version)) buffers.set(version, new Map());
      bucket = null;
      continue;
    }
    const sub = ANNOUNCEMENT_LANG.exec(line);
    if (sub) {
      const lang = sub[1].toLowerCase();
      bucket = null;
      if (version !== null && ANNOUNCEMENT_LANGS.includes(lang)) {
        bucket = [];
        buffers.get(version).set(lang, bucket);
      }
      continue;
    }
    if (bucket) bucket.push(line);
  }

  const sections = {};
  for (const [found, langs] of buffers) {
    const section = {};
    for (const [lang, lines] of langs) {
      const body = lines.join('\n').trim();
      if (body !== '') section[lang] = body;
    }
    sections[found] = section;
  }
  return sections;
}

// Parsed once per file revision, per file. Keyed by path, mtime and size
// rather than by path alone: `bin/production-deploy.js` rewrites the checkout
// under a running process, and the notes being sent right after that deploy are
// exactly the ones whose text just changed. Size joins mtime because a deploy
// can land two writes inside one filesystem timestamp tick. One slot per path
// rather than one slot for everything: two files are read now (the release
// announcements and the per-build Android notes), and a shared slot would
// re-parse each of them on every read of the other.
const announcementCache = new Map();

// Never throws: the announcement is decoration on a release, and a missing or
// unparsable file must degrade to the generic sentence, not stop a boot from
// telling everyone the version changed.
function loadAnnouncements(file) {
  try {
    const stat = fs.statSync(file);
    const key = `${stat.mtimeMs}\u0000${stat.size}`;
    const cached = announcementCache.get(file);
    if (cached && cached.key === key) return cached.sections;
    const sections = parseAnnouncements(fs.readFileSync(file, 'utf8'));
    announcementCache.set(file, { key, sections });
    return sections;
  } catch {
    return {};
  }
}

// The body of the announcement, in order of preference: this version's text in
// the recipient's language, this version's Russian text (written first, and a
// concrete sentence in the wrong language beats a vague one in the right one),
// then the generic sentence — which is all a version whose section has not
// been written yet can honestly say, since the version is bumped before the
// notes are.
export function releaseNotes(version, { file = ANNOUNCEMENTS_FILE, lang = 'ru' } = {}) {
  const title = `Tailchat ${version}`;
  const generic = {
    ru: 'Доступна новая версия Tailchat. Улучшены интерфейс и надёжность. Нажмите «Обновить» внизу экрана. Если кнопки нет, перезагрузите страницу.',
    en: 'A new Tailchat version is available and will be installed successfully. It includes interface and reliability improvements. Press “Update” at the bottom of the screen. If the button is not visible, reload the page.',
    fr: 'Une nouvelle version de Tailchat est disponible et sera installée avec succès. Elle améliore l’interface et la fiabilité. Appuyez sur « Mettre à jour » en bas de l’écran. Si le bouton n’est pas visible, rechargez la page.',
  }[lang] || 'A new Tailchat version is available. Reload the page to update.';

  const section = loadAnnouncements(file)[version];
  let message = (section && (section[lang] ?? section.ru)) || generic;
  if (message.length > MAX_NOTES_CHARS) message = `${message.slice(0, MAX_NOTES_CHARS - 1)}…`;
  return `${title}\n\n${message}`;
}

/**
 * What one Android build changed, in the reader's language, or `null` when
 * nobody has written its section.
 *
 * No generic fallback, unlike [releaseNotes]: this message is *about* a
 * specific build, and «доступна новая версия» is not something a person who
 * already installed it can be told — a build whose notes have not been written
 * writes nothing at all.
 *
 * Russian is the fallback before English because it is the language these are
 * authored in (`docs/android-notes.md`), the same reason `releaseNotes` falls
 * back to it.
 */
export function androidNotes(build, { file = ANDROID_NOTES_FILE, lang = 'ru' } = {}) {
  const section = loadAnnouncements(file)[String(build)];
  if (!section) return null;
  const message = section[lang] ?? section.ru ?? section.en;
  if (typeof message !== 'string' || message === '') return null;
  return message.length > MAX_NOTES_CHARS
    ? `${message.slice(0, MAX_NOTES_CHARS - 1)}…`
    : message;
}

/**
 * One message per build per person, when the client says which build it is
 * running. The only message the official account writes on its own initiative
 * (`RELEASE_ANNOUNCEMENTS` above): it is addressed at the build the recipient
 * actually installed, and reaches nobody who did not.
 *
 * The conversation itself is the bookkeeping — the same trick
 * [announceReleaseTo] uses — so a reinstall, a re-login, a restored snapshot or
 * a re-run can only ever find the message already there. Nothing is recorded
 * anywhere else: a build whose section is missing leaves no trace, and writing
 * its notes later still reaches the people running it.
 */
export function announceAppBuild({ store, hub, login, build, file = ANDROID_NOTES_FILE, now = Date.now }) {
  if (!Number.isFinite(build) || build <= 0) return false;
  if (login === SERVICE_LOGIN || login === AI_LOGIN) return false;
  const id = `android-${Math.floor(build)}`;
  if (store.history(SERVICE_LOGIN, login).some((record) => record.id === id)) return false;
  const lang = (typeof store.langOf === 'function' ? store.langOf(login) : null) || 'ru';
  const text = androidNotes(build, { file, lang });
  if (!text) return false;
  linkServiceAccount(store, login);
  return hub.sendServiceMessage(login, { text, id, ts: now() });
}

// Idempotent by design: this runs on every boot, and the second boot must not
// find a second account or a new password on the first one.
export async function ensureServiceAccount(store) {
  if (store.users().some((user) => user.login === SERVICE_LOGIN)) return false;

  const result = await store.register({
    login: SERVICE_LOGIN,
    name: SERVICE_NAME,
    // Random, never returned to a caller and never written down anywhere but
    // as its own scrypt hash. This account only ever sends; there is nothing
    // to sign into it for, and nothing to leak.
    password: crypto.randomBytes(PASSWORD_BYTES).toString('hex'),
  });
  if (!result.ok) return false;
  // `register` issues a session token as a side effect of creating an account.
  // For an account nobody signs into that token is a standing session sitting
  // in `accounts.json` for no one, so it goes straight back.
  store.revokeToken(result.token);
  return true;
}

/** Puts the official account in one account's roster. Cheap and idempotent. */
export function linkServiceAccount(store, login) {
  // The two server-side accounts are not contacts of each other.
  if (!login || login === SERVICE_LOGIN || login === AI_LOGIN) return false;
  store.linkFriends(SERVICE_LOGIN, login);
  return true;
}

/** Every existing account, at boot. The contact outlives the announcements:
 *  it is a roster entry, not a message, so it is restored whether or not
 *  `RELEASE_ANNOUNCEMENTS` is on. */
export function linkServiceAccountToEveryone(store) {
  let linked = 0;
  for (const user of store.users()) {
    if (linkServiceAccount(store, user.login)) linked += 1;
  }
  return linked;
}

// One recipient. Returns true when a message was actually sent, so the caller
// can tell «delivered» from «already had it».
export function announceReleaseTo({ store, hub, version, notes, login, now = Date.now }) {
  // Neither the official account nor the assistant is an audience for a
  // release note.
  if (login === SERVICE_LOGIN || login === AI_LOGIN) return false;
  const lang = (typeof store.langOf === 'function' ? store.langOf(login) : null) || 'ru';
  const text = typeof notes === 'string' && notes !== '' ? notes : releaseNotes(version, { lang });
  const id = announcementId(version);

  // Visibility is repaired even when the message is already present. A boot
  // may have failed after recording the frame but before persisting friendship;
  // deterministic ids prevent a duplicate, while linking first heals the only
  // route the recipient has to open that conversation.
  linkServiceAccount(store, login);

  // A restart, a re-run, or a second registration attempt must not repeat
  // itself in somebody's conversation. The record already sitting there is the
  // authority on that.
  const existing = store.history(SERVICE_LOGIN, login);
  if (existing.some((record) => record.id === id)) return false;

  return hub.sendServiceMessage(login, { text, id, ts: now() });
}

// Every account, once per version. The version marker is advanced only after
// every recipient has been visited. If one delivery throws, the marker stays
// behind and the next boot retries; deterministic per-recipient ids make the
// already completed part of that retry a no-op.
export function announceRelease({ store, hub, version, notes, now = Date.now }) {
  if (store.announcedVersion() === version) return 0;

  let sent = 0;
  for (const user of store.users()) {
    if (user.login === SERVICE_LOGIN || user.login === AI_LOGIN) continue;
    const lang = (typeof store.langOf === 'function' ? store.langOf(user.login) : null) || 'ru';
    const userNotes = typeof notes === 'string' && notes !== ''
      ? notes
      : releaseNotes(version, { lang });
    if (announceReleaseTo({ store, hub, version, notes: userNotes, login: user.login, now })) sent += 1;
  }
  store.setAnnouncedVersion(version);
  return sent;
}
