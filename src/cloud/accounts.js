import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { normalizeGatewayName } from '../gateway-core.js';

import { generateEd25519KeyPair, signCertificate, setServerVerifyKey } from '../identity.js';
import { createJournal } from './journal.js';
import { readyCipher, readCloudSidecar, writeCloudSidecar } from './storage-crypto.js';
import {
  E2EE_BACKUP_BATCH_MAX, E2EE_BACKUP_SESSION_LIMIT, E2EE_CLAIM_BATCH_MAX, E2EE_CLAIMS_PER_MINUTE,
  E2EE_DEVICE_LIMIT, E2EE_INBOX_LIMIT, E2EE_INBOX_PER_SENDER, E2EE_LEGACY_WINDOW_MS, E2EE_OTK_LIMIT,
  E2EE_QUERY_BATCH_MAX, E2EE_STUB_TEXT, E2EE_TRUST_BATCH_MAX, E2EE_TRUST_LIMIT, envelopeMediaChars, isSealedEdit, newDeviceId, normalizeBackupEntry,
  normalizeBackupSessions, normalizeCrossSigning, normalizeDeviceCaps, normalizeDeviceKeys, normalizeDeviceName,
  normalizeEnvelope, normalizeFallbackKey, normalizeOneTimeKeys, normalizePassphraseSlot,
  normalizeToDeviceBody, normalizeTrustStatement, sameDeviceIdentity, sameEnvelope, validDeviceId,
} from './e2ee.js';
import {
  CLOUD_HISTORY_MEDIA_BUDGET_CHARS, CLOUD_MEDIA_MAX_CHARS, CLOUD_QUEUE_MEDIA_BUDGET_CHARS,
  CLOUD_SAVED_MEDIA_BUDGET_CHARS,
} from './limits.js';

const FILE_VERSION = 1;
const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const PASSWORD_MIN = 1;
const PASSWORD_MAX = 200;

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
const SALT_BYTES = 16;
const TOKEN_BYTES = 32;
const KEY_LENGTH = 64;
// The cost the stored hashes were computed with. Changing any of these numbers
// invalidates every password in the file, so they live here as one frozen block
// rather than as three call-site arguments that could drift apart.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
// The offline queue has no count ceiling: a frame in it is a message this
// account has not been handed yet, and dropping the oldest was silent data
// loss for anyone who stayed offline through more than 500 of them. Memory is
// bounded by `evictQueueMedia` — attachments, not messages.
const HISTORY_DEFAULT_LIMIT = 200;
// How far back `lastMessage` keeps looking once it has a candidate. Records are
// written in the order they are drained rather than the order they were sent,
// so the newest timestamp can sit a little way from the end of the log — but
// only a little, and scanning the whole log per friend is what this avoids.
const OUT_OF_ORDER_WINDOW_MS = 60 * 60 * 1000;
const PUSH_SUB_LIMIT = 12;
// A push destination is a *lease*, not a fact: the device that owns it has to
// keep claiming it, or the deployment keeps waking a browser that was
// uninstalled months ago. Web Push has no uninstall signal — deleting an
// installed PWA leaves its subscription alive in Chrome, and the endpoint
// keeps accepting (201) pushes that the OS then renders, so a phone can show
// two notifications for one message long after the person believes the web
// copy is gone. Hence: every subscription carries the claiming device's id,
// a new claim replaces that device's previous endpoint, and a claim nobody
// renews for this long is dropped.
const PUSH_SUB_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const FCM_TOKEN_LIMIT = 12;
const TOKEN_KEY_PATTERN = /^[0-9a-f]{64}$/;
const HISTORY_MEDIA_MAX_CHARS = CLOUD_MEDIA_MAX_CHARS;
const HIDDEN_LIMIT = 1000;
// How many events one account's resumable-sync log keeps. A client that has
// been away for longer than this is told to re-seed the conversation from
// `/api/history` instead of being handed a log with a hole in it.
const EVENT_LIMIT = 2000;
const EVENT_PAGE_DEFAULT = 200;
const EVENT_PAGE_MAX = 500;
const EVENT_KINDS = new Set(['message', 'edit', 'delete', 'react', 'read']);
// A friend request is a *pending* edge: it exists only until the other side
// answers it, and it is the one piece of state a stranger can create on
// somebody else's account. Hence both bounds — how many unanswered requests
// one account may have in flight, and how many an account will hold before it
// stops accepting new ones. Without the second, «попросить в друзья» is an
// unbounded write primitive aimed at a person who never agreed to anything.
const FRIEND_REQUESTS_OUT_LIMIT = 20;
const FRIEND_REQUESTS_IN_LIMIT = 100;

// How stale `lastUsed` may be before a token lookup bothers writing it down.
// Nothing reads it to make a decision, and the write is what marked a
// multi-megabyte store dirty on every authenticated request; see `resolveToken`.
const COARSE_TOUCH_MS = 60 * 1000;

// The snapshot is a checkpoint, not the durable record — `journal.js` fsyncs
// every commit, so a snapshot that lags loses nothing a crash could lose. What
// it costs is a synchronous `JSON.stringify` of the whole store followed by a
// write of the same size, on the event loop, so how often it is taken has to
// follow the store's own size. Measured on Node 24 / Apple M1 for a store of
// this shape: `JSON.stringify` of 23 MB is 40-55 ms, plus ~5 ms to buffer it;
// the numbers are deliberately pessimistic for a small VPS.
const SNAPSHOT_COST_MS_PER_MB = 8;
// Wait this many times the last snapshot's own cost before taking the next one,
// which keeps the event loop's share of wall time near 5%.
const SNAPSHOT_COST_MULTIPLE = 20;
// Floors and ceiling: a small store is still written promptly (a fresh
// deployment would otherwise wait out the same interval as a busy one), and a
// huge one cannot go unwritten for minutes on end.
const SNAPSHOT_MIN_MS = 1_000;
const SNAPSHOT_MAX_MS = 30_000;

export function generateRecoveryKey() {
  const bytes = crypto.randomBytes(8).toString('hex').toUpperCase();
  return `TC-${bytes.slice(0, 4)}-${bytes.slice(4, 8)}-${bytes.slice(8, 12)}-${bytes.slice(12, 16)}`;
}

export function normalizeRecoveryKey(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

export function normalizeLogin(value) {
  return String(value ?? '').trim().toLowerCase();
}

// Which client read something: the browser, a terminal, or the phone with the
// build it is running (`clientKind` in hub.js). Written into the snapshot and
// then handed to *another* account's client as «прочитано с телефона», so it is
// validated on the way in and on the way back from disk for the same reason the
// logins are: a snapshot is a file a future version has to be able to trust.
const CLIENT_KIND_PATTERN = /^(?:web|cli|android\/\d{1,10})$/;
export function normalizeClientKind(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return CLIENT_KIND_PATTERN.test(text) ? text : '';
}

function validLogin(login) {
  return LOGIN_PATTERN.test(login);
}

// How long a nickname for a contact may be. Generous for a label that only ever
// fills a roster row, and bounded because it also lands in notifications.
const ALIAS_MAX = 32;
// A nickname is free text — «Босс», «🎉», «Мама (работа)» — and the only thing
// that must never survive is what would break the surface it is drawn on:
// controls (a newline, an ANSI escape), the line separators and the bidi
// overrides. NOT `normalizeGatewayName`, which is the right rule for an
// *account* name (a public identity, always rendered as `{name}`) but would
// silently rewrite or refuse nicknames people already have on their phones:
// it keeps only letters, numbers and a handful of punctuation, so «🎉» came back
// empty and «Бо\u0007ря» lost its shape differently than it ever displayed.
const ALIAS_SEPARATOR = /[\t\n\r\f\v\u0085\u2028\u2029]/g;
const ALIAS_DROP = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;

// Code points, not UTF-16 units: a cap that splits a surrogate pair turns one
// emoji into a replacement box in the middle of somebody's roster.
function cleanNickname(value) {
  const text = String(value ?? '')
    .normalize('NFKC')
    .replace(ALIAS_SEPARATOR, ' ')
    .replace(ALIAS_DROP, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(text).slice(0, ALIAS_MAX).join('');
}

// Every container is prototype-less: the keys are logins and conversation keys
// read back from a file on disk, and a crafted `__proto__` entry there must land
// as an ordinary dead key instead of reaching Object.prototype.
function emptyState() {
  return {
    version: FILE_VERSION,
    accounts: Object.create(null),
    tokens: Object.create(null),
    friends: Object.create(null),
    // Asymmetric: state.blocked[login] lists the logins that `login` has
    // blocked. Blocking does not touch `friends` — the contact stays in the
    // roster, it just can no longer exchange live frames with the blocker in
    // either direction (see `hasBlocked`/hub.js `blockedPair`).
    blocked: Object.create(null),
    invites: Object.create(null),
    // Keyed by the *recipient*: state.friendRequests[to] lists the logins that
    // have asked `to` to be friends and have not been answered yet. Kept on
    // the recipient's side because that is who decides, and because the
    // question every read asks is «что мне ответить», never «кому я написал».
    friendRequests: Object.create(null),
    queue: Object.create(null),
    history: Object.create(null),
    // Per-user, per-conversation ids the owner deleted «only for me»: the
    // record stays in the shared log for the other side, and is filtered out
    // on the way to this reader.
    hidden: Object.create(null),
    // Asymmetric, like `blocked`: state.removed[login] lists the contacts that
    // login has deleted from its own list. Deleting a contact is «у себя» — it
    // never touches `friends`, so the other side keeps both the contact and
    // the thread (see `removeContact`).
    removed: Object.create(null),
    // Per-owner, per-conversation commit watermark: every record whose `seq`
    // is at or below it is gone for this owner, while the shared log keeps it
    // for the other side. A watermark rather than a list of hidden ids,
    // because a deleted contact takes the whole conversation with it and the
    // id list is already capped (see `HIDDEN_LIMIT`). Nothing ever lowers a
    // watermark: re-adding the contact restores the roster, not the thread.
    purges: Object.create(null),
    // Per-reader, per-conversation timestamp of the newest message that
    // reader has read. A read receipt is a live frame, so before this a
    // reload replayed history with no memory of it and every message the
    // peer had already read fell back to a single ✓ — «мои сообщения хотя
    // прочитаны но одна галочка». One number per conversation, not a set of
    // ids: reads are monotonic, and the newest read timestamp answers the
    // question for every older message at once.
    reads: Object.create(null),
    // Per-reader, per-conversation timestamp of the newest message the peer's
    // *device* holds — the ✓✓ rung of the mark ladder, told apart from the ✓
    // that only means the server committed it. The same shape as `reads` and
    // for the same reason: the ack that carries it is a live frame, so a reload
    // would otherwise forget it and drop every delivered message back to a
    // single ✓. Reading implies delivery, so this watermark is never behind
    // `reads` — a reader who reached a message held it first (see `deliveredTs`).
    deliveries: Object.create(null),
    // Actual wall-clock time when the watermark advanced. Kept separately
    // from `reads`: that value is the message timestamp used for ordering,
    // not the moment the peer looked at it. Old snapshots simply have no
    // entry and clients show «прочитано» without inventing a time.
    readAts: Object.create(null),
    // Which client last moved that watermark: `web`, `cli` or `android/<build>`,
    // read off what a connection declared for other reasons (see `clientKind`
    // in hub.js). Stored for the same reason `readAts` is — the author's
    // transcript is rebuilt from `/api/history` on every reload, and «прочитано
    // браузером» that vanished on refresh would be worse than not saying it at
    // all. One value per conversation, not per message: the watermark is
    // monotonic, so this names the client that reached it, which is the client
    // that last read the thread.
    readVias: Object.create(null),
    // A deliberate local inbox flag. It never moves the monotonic read
    // watermark backwards — that would lie to the peer's receipts — but it
    // overlays the owner's roster badge until the conversation is opened or
    // explicitly marked read again.
    markedUnread: Object.create(null),
    // The name this account gave one of its contacts — «изменение ника
    // собеседника». Asymmetric and private, like `blocked`: nothing here is
    // ever sent to the peer or to anybody else. It lives on the server so the
    // rename reaches every client the owner signs in with, which is the whole
    // point: the phone, the browser and the terminal used to keep three
    // different local nicknames for the same person. Keyed by login rather
    // than by conversation, because a nickname is about a person: a contact
    // deleted and added again comes back under the name it was given.
    aliases: Object.create(null),
    // Accounts that are a program, not a person. A bot says so itself: the
    // `hello` its own socket sends carries `v: 'bot'` (`bots/client.mjs`), and
    // the hub records the login the first time it relays one. Durable, because
    // it is a property of the account rather than of a connection — a roster
    // that shows it only while the daemon happens to be dialling would make
    // «N в сети» flicker. `official` is a different fact: those two accounts
    // *are* the server, and they are never offline.
    bots: Object.create(null),
    // Durable «напомнить ответить» records, per owner. A fired reminder stays
    // here until one of the owner's clients acknowledges it, so being offline
    // at dueAt cannot lose it.
    replyReminders: Object.create(null),
    pushSubs: Object.create(null),
    fcmTokens: Object.create(null),
    // End-to-end encryption, per account: cross-signing keys, devices with
    // their one-time keys, and each device's to-device inbox
    // (docs/specs/2026-11-04-e2ee.md §4–5). Opaque to the server: it checks
    // shape and size, never a signature.
    e2ee: Object.create(null),
    // What changed, per account, oldest first: the log a client resumes from
    // after being offline. One counter for the whole store rather than one
    // per account — a sequence number is only ever compared with another from
    // the same log, and one counter puts both sides of a conversation in the
    // same order for free. Gaps are expected and mean nothing.
    events: Object.create(null),
    seq: 0,
    // The release version every account has already been told about (see
    // `service-account.js`). One string for the whole deployment: the
    // announcement goes to everybody at once.
    announcedVersion: null,
  };
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function validQueueItem(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && validLogin(normalizeLogin(value.from))
    && Boolean(value.d)
    && typeof value.d === 'object'
    && !Array.isArray(value.d);
}

// A push subscription is exactly what the browser's PushManager handed back:
// an endpoint URL it will accept encrypted payloads on, and two base64url
// keys needed to encrypt them (RFC 8291). Anything else is not a subscription
// this store can use, whether it came from a client's JSON body or from a
// hand-edited file.
function normalizePushSubscription(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const endpoint = typeof value.endpoint === 'string' ? value.endpoint : '';
  if (endpoint.length === 0 || endpoint.length > 2048 || !/^https:\/\//i.test(endpoint)) return null;
  const keys = value.keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return null;
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : '';
  const auth = typeof keys.auth === 'string' ? keys.auth : '';
  if (p256dh.length === 0 || p256dh.length > 256 || auth.length === 0 || auth.length > 256) return null;
  return { endpoint, keys: { p256dh, auth } };
}

// An FCM registration token is just an opaque string the client's Firebase
// SDK handed back — unlike a Web Push subscription there is no endpoint/key
// pair to validate, only a sane length so a malformed or hostile body can't
// bloat the store.
function normalizeFcmToken(value) {
  const token = typeof value === 'string' ? value : '';
  if (token.length === 0 || token.length > 4096) return null;
  return token;
}

// The id a browser makes up once and keeps in localStorage for as long as its
// site data lives: it is what turns "some endpoint" into "this device's
// endpoint", so a re-subscribe replaces the dead one instead of stacking a
// second notification on top of it. Opaque and client-chosen on purpose —
// there is nothing here for the server to verify, only to bound.
export function normalizeDeviceId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return DEVICE_ID_PATTERN.test(id) ? id : null;
}

function normalizeMedia(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const dataUrl = typeof value.dataUrl === 'string' ? value.dataUrl : '';
  if (dataUrl.length === 0 || dataUrl.length > HISTORY_MEDIA_MAX_CHARS) return null;

  if (/^data:image\/(?:jpeg|png|gif|webp);base64,/i.test(dataUrl)) {
    return {
      type: 'image',
      dataUrl,
      width: Math.max(1, Math.min(8192, Math.round(finiteOr(value.width, 1)))),
      height: Math.max(1, Math.min(8192, Math.round(finiteOr(value.height, 1)))),
    };
  }
  if (/^data:audio\/[a-z0-9.+-]+(?:;codecs=[^;,]+)?;base64,/i.test(dataUrl)) {
    return {
      type: 'voice',
      dataUrl,
      duration: Math.max(0, Math.min(600, finiteOr(value.duration, 0))),
    };
  }
  return null;
}

function normalizeReactions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const reactions = Object.create(null);
  for (const [emoji, members] of Object.entries(value)) {
    if (emoji.length === 0 || emoji.length > 16 || !Array.isArray(members)) continue;
    const logins = [...new Set(members.map(normalizeLogin).filter(validLogin))].slice(0, 100);
    if (logins.length > 0) reactions[emoji] = logins;
  }
  return Object.keys(reactions).length > 0 ? reactions : undefined;
}

// A reply carries a snapshot of the message it points at, not a live
// reference: the original can be edited or deleted for one side only, and a
// dangling id would force every reader to re-resolve it against a history
// that may no longer have it. Truncated the same way a roster preview is —
// this is a quote, not a copy of the whole thread.
function normalizeReplyTo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const id = typeof value.id === 'string' ? value.id : '';
  if (id === '') return undefined;
  const from = normalizeLogin(value.from);
  if (!validLogin(from)) return undefined;
  const text = typeof value.text === 'string' ? value.text.slice(0, 200) : '';
  const media = ['image', 'voice', 'file'].includes(value.media) ? value.media : undefined;
  const reply = { id, from, text };
  if (media) reply.media = media;
  return reply;
}

// «Переслано от …»: who said it originally, carried on the copy. Only a name
// and a login — a forward is a new message, not a live link to the old one, so
// nothing here can leak the source conversation.
function normalizeForwardedFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const login = normalizeLogin(value.login);
  const name = typeof value.name === 'string' ? value.name.slice(0, 64) : '';
  if (!validLogin(login) && name === '') return undefined;
  const out = {};
  if (validLogin(login)) out.login = login;
  if (name !== '') out.name = name;
  return out;
}
function normalizeButtons(value) {
  if (!Array.isArray(value)) return undefined;
  const buttons = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const val = typeof item.value === 'string' ? item.value.trim() : '';
    if (id === '' || id.length > 40 || label === '' || label.length > 40 || val === '' || val.length > 200) continue;
    buttons.push({ id, label, value: val });
    if (buttons.length >= 8) break;
  }
  return buttons.length > 0 ? buttons : undefined;
}


function reactionsFor(record) {
  return record.reactions ? Object.fromEntries(
    Object.entries(record.reactions).map(([emoji, members]) => [emoji, [...members]]),
  ) : undefined;
}

function publicRecord(record) {
  const out = {
    id: record.id,
    from: record.from,
    text: record.text,
    reactions: reactionsFor(record),
  };
  if (record.buttons) out.buttons = record.buttons.map((b) => ({ ...b }));
  return out;
}


function normalizeMessage(value, fallbackTs) {
  const msg = {
    id: typeof value?.id === 'string' ? value.id : '',
    from: normalizeLogin(value?.from),
    text: typeof value?.text === 'string' ? value.text : '',
    ts: finiteOr(value?.ts, fallbackTs),
    kind: value?.kind === 'ai' ? 'ai' : 'human',
  };
  if (typeof value?.author === 'string' && value.author !== '') {
    msg.author = value.author;
  }
  const image = normalizeMedia(value?.image);
  if (image?.type === 'image') {
    delete image.type;
    msg.image = image;
  }
  const voice = normalizeMedia(value?.voice);
  if (voice?.type === 'voice') {
    delete voice.type;
    msg.voice = voice;
  }
  const reactions = normalizeReactions(value?.reactions);
  if (reactions) msg.reactions = reactions;
  const replyTo = normalizeReplyTo(value?.replyTo);
  if (replyTo) msg.replyTo = replyTo;
  const forwardedFrom = normalizeForwardedFrom(value?.forwardedFrom);
  if (forwardedFrom) msg.forwardedFrom = forwardedFrom;
  const buttons = normalizeButtons(value?.buttons);
  if (buttons) msg.buttons = buttons;
  // An end-to-end encrypted message: its words and attachment are inside this
  // envelope, and `text` stays empty.
  const e2ee = normalizeEnvelope(value?.e2ee);
  if (e2ee) msg.e2ee = e2ee;
  // An encrypted edit (`isSealedEdit`): kept so that history knows it is no
  // conversation's last line.
  if (e2ee && value?.sealedEdit === true) msg.sealedEdit = true;
  // Set once the conversation's media budget evicted this record's attachment:
  // the text stays, and the client knows the picture is gone for good rather
  // than still loading.
  if (value?.mediaDropped === true) msg.mediaDropped = true;
  // The sequence number the commit assigned. Only committed messages carry
  // one: it is what lets a retry of the same id be answered with the receipt
  // the sender missed rather than a second, different one.
  if (Number.isFinite(value?.seq)) msg.seq = value.seq;
  if (Number.isFinite(value?.editedAt)) msg.editedAt = value.editedAt;
  if (Number.isFinite(value?.deletedAt)) {
    msg.deletedAt = value.deletedAt;
    msg.text = '';
    delete msg.image; delete msg.voice; delete msg.reactions; delete msg.replyTo;
    delete msg.forwardedFrom; delete msg.buttons; delete msg.e2ee; delete msg.sealedEdit;
  }
  if (Array.isArray(value?.reactionEvents) && !msg.deletedAt) {
    msg.reactionEvents = value.reactionEvents.filter(event => event && typeof event.id === 'string'
      && validLogin(event.by) && typeof event.emoji === 'string' && event.emoji.length <= 16
      && Number.isFinite(event.ts)).slice(-100).map(event => ({
        id: event.id, by: event.by, emoji: event.emoji, ts: event.ts, read: event.read === true,
      }));
  }
  return msg;
}

// An event describes a mutation from one account's side. Read back from disk
// like everything else here, so a hand-edited or truncated entry is dropped
// rather than handed to a client as a kind it has no case for.
function normalizeEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!EVENT_KINDS.has(value.kind) || !Number.isFinite(value.seq)) return null;
  const peer = normalizeLogin(value.peer);
  if (!validLogin(peer)) return null;
  const event = { seq: Math.floor(value.seq), kind: value.kind, peer };
  if (typeof value.id === 'string' && value.id !== '') event.id = value.id;
  if (Number.isFinite(value.ts)) event.ts = value.ts;
  if (typeof value.text === 'string') event.text = value.text;
  if (typeof value.emoji === 'string') event.emoji = value.emoji;
  if (validLogin(normalizeLogin(value.by))) event.by = normalizeLogin(value.by);
  if (typeof value.add === 'boolean') event.add = value.add;
  if (Number.isFinite(value.readAt)) event.readAt = value.readAt;
  if (Array.isArray(value.ids)) {
    event.ids = value.ids.filter((id) => typeof id === 'string' && id !== '').slice(0, HIDDEN_LIMIT);
  }
  if (value.scope === 'self' || value.scope === 'all') event.scope = value.scope;
  if (Number.isFinite(value.readTs)) event.readTs = value.readTs;
  if (typeof value.via === 'string') {
    const kind = normalizeClientKind(value.via);
    if (kind !== '') event.via = kind;
  }
  if (validLogin(normalizeLogin(value.from))) event.from = normalizeLogin(value.from);
  if (value.self === true) event.self = true;
  return event;
}

// How many removed device ids an account remembers. A removal is kept only so
// that replaying an older journal line cannot bring the device back, and the
// journal is truncated at every snapshot, so a short memory is enough.
const E2EE_REMOVED_KEEP = 100;

function adoptE2eeDevice(login, deviceId, value, accounts) {
  if (!validDeviceId(deviceId) || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const deviceKeys = normalizeDeviceKeys(value.deviceKeys, { login, deviceId });
  if (!deviceKeys) return null;
  const fallback = value.fallback && typeof value.fallback === 'object'
    ? normalizeFallbackKey({ [value.fallback.keyId]: value.fallback.key })
    : null;
  const inbox = [];
  for (const item of Array.isArray(value.inbox) ? value.inbox : []) {
    const from = normalizeLogin(item?.from);
    const body = normalizeToDeviceBody(item?.body);
    if (!Number.isFinite(item?.seq) || item.seq <= 0 || !validLogin(from) || !accounts[from]) continue;
    if (!validDeviceId(item.fromDevice) || !body) continue;
    inbox.push({ seq: Math.floor(item.seq), from, fromDevice: item.fromDevice, body, at: finiteOr(item.at, 0) });
  }
  inbox.sort((a, b) => a.seq - b.seq);
  return {
    deviceKeys,
    name: normalizeDeviceName(value.name),
    caps: normalizeDeviceCaps(value.caps),
    createdAt: finiteOr(value.createdAt, 0),
    keysSeq: finiteOr(value.keysSeq, 0),
    otks: normalizeOneTimeKeys(value.otks ?? {}) ?? Object.create(null),
    fallback,
    inbox: inbox.slice(-E2EE_INBOX_LIMIT),
    ackedThrough: finiteOr(value.ackedThrough, 0),
  };
}

// Read back like everything else in the snapshot: a value that is not the
// shape this release writes is dropped, never handed to a client.
function adoptE2ee(parsed, state) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  for (const [key, value] of Object.entries(parsed)) {
    const login = normalizeLogin(key);
    if (!validLogin(login) || !state.accounts[login] || !value || typeof value !== 'object') continue;
    const rawBackup = value.backup && typeof value.backup === 'object' ? value.backup : null;
    const backupVersion = Number.isInteger(rawBackup?.version) && rawBackup.version >= 1 ? rawBackup.version : 0;
    const backupCross = backupVersion > 0 ? normalizeBackupEntry(rawBackup?.crossSigning) : null;
    const backup = backupVersion > 0 && backupCross ? {
      version: backupVersion,
      seq: finiteOr(rawBackup.seq, 0),
      crossSigning: backupCross,
      passphrase: rawBackup.passphrase ? normalizePassphraseSlot(rawBackup.passphrase) : null,
      sessions: normalizeBackupSessions(rawBackup.sessions ?? {}, E2EE_BACKUP_SESSION_LIMIT) ?? Object.create(null),
    } : {
      version: 0,
      seq: 0,
      crossSigning: null,
      passphrase: null,
      sessions: Object.create(null),
    };
    const account = {
      cross: normalizeCrossSigning(value.cross ?? {}) ?? {},
      crossSeq: finiteOr(value.crossSeq, 0),
      devices: Object.create(null),
      removed: Object.create(null),
      backup,
      trust: Object.create(null),
      trustSeq: finiteOr(value.trustSeq, 0),
    };
    for (const [peer, statement] of Object.entries(value.trust ?? {})) {
      if (Object.keys(account.trust).length >= E2EE_TRUST_LIMIT) break;
      const adopted = validLogin(peer) ? normalizeTrustStatement(statement, { login, peer }) : null;
      if (adopted) account.trust[peer] = adopted;
    }
    if (account.crossSeq > state.seq) state.seq = account.crossSeq;
    if (account.trustSeq > state.seq) state.seq = account.trustSeq;
    if (account.backup.seq > state.seq) state.seq = account.backup.seq;
    for (const [id, seq] of Object.entries(value.removed ?? {})) {
      if (validDeviceId(id) && Number.isFinite(seq)) {
        account.removed[id] = seq;
        if (seq > state.seq) state.seq = seq;
      }
    }
    for (const [deviceId, device] of Object.entries(value.devices ?? {})) {
      if (Object.keys(account.devices).length >= E2EE_DEVICE_LIMIT) break;
      const adopted = adoptE2eeDevice(login, deviceId, device, state.accounts);
      if (!adopted) continue;
      account.devices[deviceId] = adopted;
      if (adopted.keysSeq > state.seq) state.seq = adopted.keysSeq;
      if (adopted.ackedThrough > state.seq) state.seq = adopted.ackedThrough;
      // Inbox items carry numbers from the shared counter: it must never hand
      // one of them out again.
      for (const item of adopted.inbox) if (item.seq > state.seq) state.seq = item.seq;
    }
    state.e2ee[login] = account;
  }
}

// Reading is deliberately forgiving about individual entries and strict about
// the shape: a single unparseable account should cost that account, not the
// whole file, while a file that is not this format at all is not ours to edit.
function adoptState(parsed, at) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.version !== FILE_VERSION) return null;

  const state = emptyState();

  for (const [key, value] of Object.entries(parsed.accounts ?? {})) {
    if (!validLogin(key) || !value || typeof value !== 'object') continue;
    if (typeof value.salt !== 'string' || typeof value.hash !== 'string') continue;
    state.accounts[key] = {
      login: key,
      name: typeof value.name === 'string' && value.name !== '' ? value.name : key,
      salt: value.salt,
      hash: value.hash,
      recoverySalt: typeof value.recoverySalt === 'string' ? value.recoverySalt : null,
      recoveryHash: typeof value.recoveryHash === 'string' ? value.recoveryHash : null,
      // Both null together, like the recovery pair above: an account with no
      // additional password set carries no hash to check one against.
      extraPasswordSalt: typeof value.extraPasswordSalt === 'string' ? value.extraPasswordSalt : null,
      extraPasswordHash: typeof value.extraPasswordHash === 'string' ? value.extraPasswordHash : null,
      pubKey: typeof value.pubKey === 'string' ? value.pubKey : null,
      createdAt: finiteOr(value.createdAt, 0),
      lastSeen: finiteOr(value.lastSeen, 0),
    };
  }

  for (const [key, value] of Object.entries(parsed.tokens ?? {})) {
    if (!TOKEN_KEY_PATTERN.test(key) || !value || typeof value !== 'object') continue;
    const login = normalizeLogin(value.login);
    if (!state.accounts[login]) continue;
    state.tokens[key] = {
      login,
      createdAt: finiteOr(value.createdAt, 0),
      lastUsed: finiteOr(value.lastUsed, 0),
    };
    // The end-to-end encryption device this session is (§4.1 of the E2EE spec).
    if (validDeviceId(value.deviceId)) state.tokens[key].deviceId = value.deviceId;
  }

  for (const [key, value] of Object.entries(parsed.friends ?? {})) {
    const login = normalizeLogin(key);
    if (!validLogin(login) || !state.accounts[login] || !Array.isArray(value)) continue;
    const friendsList = [];
    for (const friend of value) {
      const f = normalizeLogin(friend);
      if (validLogin(f) && state.accounts[f] && f !== login && !friendsList.includes(f)) {
        friendsList.push(f);
      }
    }
    if (friendsList.length > 0) state.friends[login] = friendsList;
  }

  for (const [key, value] of Object.entries(parsed.blocked ?? {})) {
    const login = normalizeLogin(key);
    if (!validLogin(login) || !state.accounts[login] || !Array.isArray(value)) continue;
    const blockedList = [];
    for (const target of value) {
      const t = normalizeLogin(target);
      if (validLogin(t) && state.accounts[t] && t !== login && !blockedList.includes(t)) {
        blockedList.push(t);
      }
    }
    if (blockedList.length > 0) state.blocked[login] = blockedList;
  }

  for (const [key, value] of Object.entries(parsed.removed ?? {})) {
    const login = normalizeLogin(key);
    if (!validLogin(login) || !state.accounts[login] || !Array.isArray(value)) continue;
    const removedList = [];
    for (const target of value) {
      const t = normalizeLogin(target);
      if (validLogin(t) && state.accounts[t] && t !== login && !removedList.includes(t)) {
        removedList.push(t);
      }
    }
    if (removedList.length > 0) state.removed[login] = removedList;
  }

  // Nicknames the owner gave contacts. Read back through the same cleaner as a
  // live write, so a snapshot edited by hand cannot smuggle controls or a bidi
  // override into somebody's roster.
  for (const [key, value] of Object.entries(parsed.aliases ?? {})) {
    const login = normalizeLogin(key);
    if (!validLogin(login) || !state.accounts[login] || !value || typeof value !== 'object') continue;
    if (Array.isArray(value)) continue;
    const byPeer = Object.create(null);
    for (const [target, name] of Object.entries(value)) {
      const t = normalizeLogin(target);
      if (!validLogin(t) || !state.accounts[t] || t === login) continue;
      if (typeof name !== 'string') continue;
      const clean = cleanNickname(name);
      if (clean === '') continue;
      byPeer[t] = clean;
    }
    if (Object.keys(byPeer).length > 0) state.aliases[login] = byPeer;
  }

  // Bot accounts, as their own sockets announced them. A snapshot edited by
  // hand cannot mark an account that does not exist, and `false` is not a
  // mark — the flag is written only ever as `true`.
  for (const [key, value] of Object.entries(parsed.bots ?? {})) {
    const login = normalizeLogin(key);
    if (!validLogin(login) || !state.accounts[login] || value !== true) continue;
    state.bots[login] = true;
  }

  for (const [key, value] of Object.entries(parsed.invites ?? {})) {
    if (!TOKEN_KEY_PATTERN.test(key) || !value || typeof value !== 'object') continue;
    const login = normalizeLogin(value.login);
    if (!state.accounts[login]) continue;
    state.invites[key] = {
      login,
      createdAt: finiteOr(value.createdAt, 0),
    };
  }

  for (const [key, value] of Object.entries(parsed.friendRequests ?? {})) {
    const to = normalizeLogin(key);
    if (!validLogin(to) || !state.accounts[to] || !Array.isArray(value)) continue;
    const pending = [];
    for (const item of value) {
      const from = normalizeLogin(item?.from);
      // An account deleted since the snapshot, a self-request that should
      // never have been written, a pair that became friends by some other
      // route (an invite) — all of them are answered questions, dropped here
      // rather than shown to somebody as a live one.
      if (!validLogin(from) || !state.accounts[from] || from === to) continue;
      if (pending.some((entry) => entry.from === from)) continue;
      if (state.friends[to]?.includes(from)) continue;
      pending.push({ from, at: finiteOr(item?.at, 0) });
      if (pending.length >= FRIEND_REQUESTS_IN_LIMIT) break;
    }
    if (pending.length > 0) state.friendRequests[to] = pending;
  }

  for (const [key, value] of Object.entries(parsed.queue ?? {})) {
    if (!validLogin(key) || !Array.isArray(value)) continue;
    // Every persisted frame is restored: the queue is a replay buffer whose
    // contents nobody has been handed yet, so truncating it on load was the
    // same data loss as truncating it on append.
    const items = value.filter(validQueueItem).map((item) => ({
      from: normalizeLogin(item.from),
      d: item.d,
      at: finiteOr(item.at, 0),
    }));
    if (items.length > 0) state.queue[key] = items;
  }

  for (const [key, value] of Object.entries(parsed.pushSubs ?? {})) {
    if (!validLogin(key) || !state.accounts[key] || !Array.isArray(value)) continue;
    const subs = [];
    for (const item of value) {
      const sub = normalizePushSubscription(item);
      if (!sub) continue;
      // Subscriptions written before devices had to claim their endpoint have
      // no owner to renew them — exactly the state that let a deleted PWA go
      // on notifying from every browser that ever installed it. They are
      // dropped here rather than kept on trust: a live browser re-claims on
      // its next open (`/api/push/subscribe`), an abandoned one never does.
      const deviceId = normalizeDeviceId(item.deviceId);
      if (!deviceId) continue;
      const seenAt = finiteOr(item.seenAt, finiteOr(item.addedAt, 0));
      if (at - seenAt > PUSH_SUB_TTL_MS) continue;
      if (subs.some((existing) => existing.endpoint === sub.endpoint || existing.deviceId === deviceId)) continue;
      subs.push({ ...sub, deviceId, addedAt: finiteOr(item.addedAt, 0), seenAt });
    }
    if (subs.length > 0) state.pushSubs[key] = subs.slice(-PUSH_SUB_LIMIT);
  }

  for (const [key, value] of Object.entries(parsed.fcmTokens ?? {})) {
    if (!validLogin(key) || !state.accounts[key] || !Array.isArray(value)) continue;
    const tokens = [];
    for (const item of value) {
      const token = normalizeFcmToken(item?.token);
      if (!token || tokens.some((existing) => existing.token === token)) continue;
      const scope = typeof item?.scope === 'string' && /^[a-f0-9]{64}$/.test(item.scope)
        ? item.scope
        : '';
      tokens.push({ token, scope, addedAt: finiteOr(item.addedAt, 0) });
    }
    if (tokens.length > 0) state.fcmTokens[key] = tokens.slice(-FCM_TOKEN_LIMIT);
  }

  for (const [key, value] of Object.entries(parsed.history ?? {})) {
    if (!Array.isArray(value)) continue;
    const sides = key.split('|');
    if (sides.length !== 2 || !sides.every(validLogin)) continue;
    if (sides[0] > sides[1]) continue;
    const messages = value
      .filter((item) => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      .map((item) => normalizeMessage(item, 0));
    if (messages.length > 0) state.history[key] = messages;
  }

  for (const [owner, conversations] of Object.entries(parsed.hidden ?? {})) {
    if (!validLogin(owner) || !conversations || typeof conversations !== 'object') continue;
    if (Array.isArray(conversations)) continue;
    const byConversation = Object.create(null);
    for (const [key, value] of Object.entries(conversations)) {
      if (!Array.isArray(value)) continue;
      const sides = key.split('|');
      if (sides.length !== 2 || !sides.every(validLogin)) continue;
      if (sides[0] > sides[1] || !sides.includes(owner)) continue;
      const ids = [];
      for (const id of value) {
        if (typeof id !== 'string' || id === '' || ids.includes(id)) continue;
        ids.push(id);
      }
      if (ids.length > 0) byConversation[key] = ids.slice(-HIDDEN_LIMIT);
    }
    if (Object.keys(byConversation).length > 0) state.hidden[owner] = byConversation;
  }

  for (const [owner, conversations] of Object.entries(parsed.purges ?? {})) {
    if (!validLogin(owner) || !conversations || typeof conversations !== 'object') continue;
    if (Array.isArray(conversations)) continue;
    const byConversation = Object.create(null);
    for (const [key, value] of Object.entries(conversations)) {
      if (!Number.isFinite(value) || value <= 0) continue;
      const sides = key.split('|');
      if (sides.length !== 2 || !sides.every(validLogin)) continue;
      if (sides[0] > sides[1] || !sides.includes(owner)) continue;
      byConversation[key] = Math.floor(value);
    }
    if (Object.keys(byConversation).length > 0) state.purges[owner] = byConversation;
  }

  for (const [reader, conversations] of Object.entries(parsed.reads ?? {})) {
    if (!validLogin(reader) || !conversations || typeof conversations !== 'object') continue;
    if (Array.isArray(conversations)) continue;
    const byConversation = Object.create(null);
    for (const [key, value] of Object.entries(conversations)) {
      if (!Number.isFinite(value) || value <= 0) continue;
      const sides = key.split('|');
      if (sides.length !== 2 || !sides.every(validLogin)) continue;
      if (sides[0] > sides[1] || !sides.includes(reader)) continue;
      byConversation[key] = Math.floor(value);
    }
    if (Object.keys(byConversation).length > 0) state.reads[reader] = byConversation;
  }

  for (const [reader, conversations] of Object.entries(parsed.deliveries ?? {})) {
    if (!validLogin(reader) || !conversations || typeof conversations !== 'object') continue;
    if (Array.isArray(conversations)) continue;
    const byConversation = Object.create(null);
    for (const [key, value] of Object.entries(conversations)) {
      if (!Number.isFinite(value) || value <= 0) continue;
      const sides = key.split('|');
      if (sides.length !== 2 || !sides.every(validLogin)) continue;
      if (sides[0] > sides[1] || !sides.includes(reader)) continue;
      byConversation[key] = Math.floor(value);
    }
    if (Object.keys(byConversation).length > 0) state.deliveries[reader] = byConversation;
  }

  for (const [reader, conversations] of Object.entries(parsed.readAts ?? {})) {
    if (!validLogin(reader) || !conversations || typeof conversations !== 'object') continue;
    if (Array.isArray(conversations)) continue;
    const byConversation = Object.create(null);
    for (const [key, value] of Object.entries(conversations)) {
      if (!Number.isFinite(value) || value <= 0) continue;
      const sides = key.split('|');
      if (sides.length !== 2 || !sides.every(validLogin)) continue;
      if (sides[0] > sides[1] || !sides.includes(reader)) continue;
      byConversation[key] = Math.floor(value);
    }
    if (Object.keys(byConversation).length > 0) state.readAts[reader] = byConversation;
  }

  for (const [reader, conversations] of Object.entries(parsed.readVias ?? {})) {
    if (!validLogin(reader) || !conversations || typeof conversations !== 'object') continue;
    if (Array.isArray(conversations)) continue;
    const byConversation = Object.create(null);
    for (const [key, value] of Object.entries(conversations)) {
      const kind = normalizeClientKind(value);
      if (kind === '') continue;
      const sides = key.split('|');
      if (sides.length !== 2 || !sides.every(validLogin)) continue;
      if (sides[0] > sides[1] || !sides.includes(reader)) continue;
      byConversation[key] = kind;
    }
    if (Object.keys(byConversation).length > 0) state.readVias[reader] = byConversation;
  }

  for (const [owner, peers] of Object.entries(parsed.markedUnread ?? {})) {
    if (!validLogin(owner) || !state.accounts[owner] || !Array.isArray(peers)) continue;
    const clean = [];
    for (const value of peers) {
      const peer = normalizeLogin(value);
      if (validLogin(peer) && state.accounts[peer] && peer !== owner && !clean.includes(peer)) clean.push(peer);
    }
    if (clean.length > 0) state.markedUnread[owner] = clean;
  }

  for (const [owner, reminders] of Object.entries(parsed.replyReminders ?? {})) {
    if (!validLogin(owner) || !state.accounts[owner] || !Array.isArray(reminders)) continue;
    const clean = [];
    for (const value of reminders) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const peer = normalizeLogin(value.peer);
      if (!validLogin(peer) || !state.accounts[peer] || peer === owner) continue;
      if (typeof value.id !== 'string' || value.id === '' || value.id.length > 128) continue;
      if (typeof value.messageId !== 'string' || value.messageId === '' || value.messageId.length > 256) continue;
      if (!Number.isFinite(value.dueAt) || !Number.isFinite(value.createdAt)) continue;
      const item = { id: value.id, peer, messageId: value.messageId, dueAt: value.dueAt, createdAt: value.createdAt };
      if (Number.isFinite(value.firedAt)) item.firedAt = value.firedAt;
      clean.push(item);
    }
    if (clean.length > 0) state.replyReminders[owner] = clean;
  }

  // The counter is taken from the file, then raised to whatever the logs
  // actually contain: a snapshot written by a release that did not know about
  // events, or one hand-edited, must never hand out a number twice.
  state.seq = Math.max(0, Math.floor(finiteOr(parsed.seq, 0)));
  for (const [key, value] of Object.entries(parsed.events ?? {})) {
    if (!validLogin(key) || !Array.isArray(value)) continue;
    const events = [];
    for (const item of value) {
      const event = normalizeEvent(item);
      if (!event) continue;
      events.push(event);
      if (event.seq > state.seq) state.seq = event.seq;
    }
    if (events.length > 0) state.events[key] = events.slice(-EVENT_LIMIT);
  }

  // A value that is not a version string is no announcement record at all, and
  // announcing again is the safe direction to fail in: a repeated note beats
  // never mentioning a release.
  if (typeof parsed.announcedVersion === 'string' && parsed.announcedVersion !== '') {
    state.announcedVersion = parsed.announcedVersion;
  }
  adoptE2ee(parsed.e2ee, state);

  return state;
}

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LENGTH, SCRYPT_PARAMS, (error, key) => {
      if (error) reject(error);
      else resolve(key.toString('hex'));
    });
  });
}

function sameHash(left, right) {
  // Both sides are hex of the same fixed length, but a file edited by hand can
  // break that, and timingSafeEqual throws on a length mismatch instead of
  // answering false.
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function tokenKey(token) {
  return crypto.createHash('sha256').update(String(token ?? '')).digest('hex');
}

function conversationKey(a, b) {
  return [normalizeLogin(a), normalizeLogin(b)].sort().join('|');
}

// Whether a record is on the far side of a contact deletion's watermark: at or
// below the cut means gone for that owner. A record written before sequence
// numbers existed carries none at all, and by definition predates every cut,
// so it goes with the rest of the conversation.
function beforePurge(record, cut) {
  return cut > 0 && !(Number.isFinite(record?.seq) && record.seq > cut);
}

export function createAccountStore({
  dir,
  now = Date.now,
  // Days a session token may sit unused before it stops working; 0 keeps
  // tokens until they are revoked, which is how existing deployments behave.
  // A token can carry an E2EE device, so a public server that turns this on
  // also signs that device out — the person logs in again and re-verifies.
  tokenIdleDays = envNumber('TAILCHAT_CLOUD_TOKEN_IDLE_DAYS', 0),
  // Shortest password accepted for a *new* password (register, recover,
  // change). Signing in never applies it, so raising it cannot lock anybody
  // out of an account whose password predates the rule.
  passwordMin = envNumber('TAILCHAT_CLOUD_PASSWORD_MIN', PASSWORD_MIN),
  // Fixed override for the coalescing delay; when omitted the delay follows the
  // store's own size (see `snapshotDelayMs`). A number here is what a test uses
  // to make snapshots predictable, and what an operator would use to pin the
  // old behaviour.
  writeDelayMs = null,
  // How much inline media one conversation may keep. Overridable so a test can
  // watch the eviction happen without allocating tens of megabytes of base64.
  historyMediaBudgetChars = CLOUD_HISTORY_MEDIA_BUDGET_CHARS,
  // What decides when a *new* Saved Messages attachment is stored as text
  // only. Nothing already saved is ever evicted, so this is a refusal
  // threshold rather than a size to shrink back to.
  savedMediaBudgetChars = CLOUD_SAVED_MEDIA_BUDGET_CHARS,
  // How much inline media the offline queue may hold across every recipient's
  // pending frames. The queue never drops a message, so this is what bounds
  // it: attachments are stripped from the oldest queued frames, whose full
  // copies stay in history.
  queueMediaBudgetChars = CLOUD_QUEUE_MEDIA_BUDGET_CHARS,
  // The write-ahead log every commit goes through. Overridable so a test can
  // watch what a store does when the disk refuses the write, which is the one
  // case that must never end in an acknowledged message.
  journal = null,
  keyFile = process.env.TAILCHAT_CLOUD_MASTER_KEY_FILE,
  initialize = false,
  // For offline legacy fixtures only. Production must never opt into this.
  allowPlaintextLegacy = false,
} = {}) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('createAccountStore requires dir');

  const file = path.join(dir, 'accounts.json');
  const temp = `${file}.tmp`;
  const journalFile = path.join(dir, 'accounts.journal');

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A directory created by an earlier release, or by an unlucky umask, keeps
    // its old mode through mkdir: the file inside holds password hashes, so the
    // permissions are re-asserted rather than assumed.
    fs.chmodSync(dir, 0o700);
  } catch {
    // A read-only or foreign data directory is the server operator's problem to
    // see in the write error, not a reason to refuse to start.
  }
  const cipher = readyCipher(dir, keyFile, { initialize, allowPlaintextLegacy });
  if (!cipher && !allowPlaintextLegacy) throw new Error('Cloud encryption key is required; plaintext Cloud storage is disabled');
  if (cipher && journal) throw new Error('Encrypted cloud storage cannot use a caller-supplied plaintext journal');
  const wal = journal ?? createJournal({ file: journalFile, cipher });

  let serverKeys = null;
  try {
    const rawKeys = readCloudSidecar(dir, 'server_key.json', cipher, allowPlaintextLegacy);
    const parsed = JSON.parse(rawKeys);
    if (parsed && typeof parsed.pubKey === 'string' && typeof parsed.privKey === 'string') {
      serverKeys = parsed;
    } else {
      throw new Error('Invalid server identity key');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (cipher && !serverKeys && (fs.existsSync(file) || fs.existsSync(journalFile))) {
    throw new Error('Cloud server identity is missing; refusing to replace an existing identity');
  }
  if (!serverKeys) {
    serverKeys = generateEd25519KeyPair();
    writeCloudSidecar(dir, 'server_key.json', JSON.stringify(serverKeys, null, 2), cipher, allowPlaintextLegacy);
  }
  setServerVerifyKey(serverKeys.pubKey);

  const state = load();
  const newPasswordMin = Math.max(1, Math.min(PASSWORD_MAX, passwordMin));
  const tokenIdleMs = tokenIdleDays * 24 * 60 * 60 * 1000;
  // A reserved feed sequence may still be waiting on fsync. Only journal
  // entries already applied to state belong to a checkpoint's truncate range.
  // The journal serializes commits; each caller applies before the next one.
  let appliedJournalSeq = state.seq;

  let dirty = false;
  let timer = null;
  let writing = Promise.resolve();
  let snapshotInFlight = false;
  // Serialized size of the last snapshot, which is what `snapshotDelayMs` uses
  // to decide how long the next one may wait. Zero before the first one, so a
  // fresh store is written on the floor of that rule rather than on the ceiling.
  let lastSnapshotBytes = 0;

  // `accounts.json` is the snapshot of the last successful rename; the journal
  // holds every commit accepted since. Replay is idempotent — a checkpoint
  // that renamed and then died before truncating leaves lines the snapshot
  // already contains — and it runs after the writer's own state is set up,
  // because applying an entry schedules the save that will retire it.
  if (wal.replay(applyJournalEntry) > 0) schedule();
  appliedJournalSeq = state.seq;

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState();
      throw error;
    }
    const adopted = adoptState(JSON.parse(cipher ? cipher.open(raw, 'accounts.json').toString('utf8') : raw), now());
    if (!adopted) throw new Error('Cloud snapshot contains invalid account data; refusing to replace existing data');
    return adopted;
  }

  async function writeState(text) {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    if (cipher) await cipher.sealFile(text, 'accounts.json', temp);
    else await fsp.writeFile(temp, text, { mode: 0o600 });
    const pending = await fsp.open(temp, 'r');
    try { await pending.sync(); } finally { await pending.close(); }
    await fsp.rename(temp, file);
    const directory = await fsp.open(dir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    await fsp.chmod(file, 0o600);
  }

  function persist() {
    if (snapshotInFlight || !dirty) return writing;
    snapshotInFlight = true;
    dirty = false;
    const text = `${JSON.stringify(state)}\n`;
    lastSnapshotBytes = text.length;
    const through = appliedJournalSeq;
    // Only one serialized snapshot may exist. Mutations during I/O are
    // coalesced into the next checkpoint, not retained as full-size strings.
    writing = writeState(text)
      .then(() => wal.truncate(through))
      .catch((error) => {
        dirty = true;
        throw error;
      })
      .finally(() => {
        snapshotInFlight = false;
        if (dirty) schedule();
      });
    return writing;
  }

  /**
   * How long `schedule` coalesces before snapshotting.
   *
   * A flat delay is wrong in both directions: short enough to be prompt on an
   * empty store is far too short for a 26 MB one, where it turns the event loop
   * into a serialiser that also blocks `withinRate`'s answer to everybody else's
   * frames — the client whose frames arrive in a burst while the loop is stalled
   * is the one the hub closes with `rate_limited`. What this does instead is
   * wait [SNAPSHOT_COST_MULTIPLE] times what the previous snapshot actually cost
   * to produce, clamped at both ends. A `writeDelayMs` passed in by a caller
   * replaces the whole calculation.
   */
  function snapshotDelayMs() {
    if (typeof writeDelayMs === 'number') return writeDelayMs;
    const cost = (lastSnapshotBytes / 1_000_000) * SNAPSHOT_COST_MS_PER_MB;
    const delay = Math.round(cost * SNAPSHOT_COST_MULTIPLE);
    return Math.min(SNAPSHOT_MAX_MS, Math.max(SNAPSHOT_MIN_MS, delay));
  }

  function schedule() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      persist().catch(() => {
        process.stderr.write('Tailchat cloud: snapshot write failed; checkpoint remains pending\n');
      });
    }, snapshotDelayMs());
    // A pending save must never be the reason the process stays alive; `close`
    // is what guarantees the data reaches the disk.
    timer.unref?.();
  }

  function accountOf(login) {
    return state.accounts[login] ?? null;
  }

  function publicUser(account) {
    return { login: account.login, name: account.name, extraPasswordEnabled: Boolean(account.extraPasswordHash) };
  }

  function issueToken(login, at) {
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    // Only the digest is stored: a leaked file then hands over no usable
    // session, exactly as with the password hashes beside it.
    state.tokens[tokenKey(token)] = { login, createdAt: at, lastUsed: at };
    schedule();
    return token;
  }

  function resolveName(name, login) {
    if (name === undefined || name === null) return login;
    if (typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (trimmed === '') return login;
    // Something was typed and none of it survived sanitising — an all-emoji
    // name, say. Silently answering to the login instead would rename the person
    // without telling them, so this is refused rather than replaced.
    return normalizeGatewayName(trimmed) || null;
  }

  function issueCertificate(login, pubKey) {
    const id = normalizeLogin(login);
    const account = accountOf(id);
    if (!account || !pubKey || typeof pubKey !== 'string') return null;
    return signCertificate(serverKeys.privKey, {
      login: id,
      name: account.name,
      pubKey,
      issuedAt: now(),
      expiresAt: now() + 365 * 24 * 60 * 60 * 1000,
    });
  }

  // `register` and `login` are promises because scrypt runs on the thread pool:
  // 16 MiB of memory-hard hashing on the event loop would stall every other
  // connection this service is holding for the duration.
  async function register({ login, password, name, pubKey, lang } = {}) {
    const id = normalizeLogin(login);
    if (!validLogin(id)) return { ok: false, code: 'invalid_login' };
    if (typeof password !== 'string' || password.length < newPasswordMin || password.length > PASSWORD_MAX) {
      return { ok: false, code: 'invalid_password' };
    }
    const display = resolveName(name, id);
    if (display === null) return { ok: false, code: 'invalid_name' };
    if (accountOf(id)) return { ok: false, code: 'login_taken' };

    const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
    const pwd = password.length >= 8 ? password : password.padEnd(8, '0');
    const hash = await hashPassword(pwd, salt);
    if (accountOf(id)) return { ok: false, code: 'login_taken' };

    const recoveryKey = generateRecoveryKey();
    const recoverySalt = crypto.randomBytes(SALT_BYTES).toString('hex');
    const recoveryHash = await hashPassword(normalizeRecoveryKey(recoveryKey), recoverySalt);

    const validLangs = ['ru', 'en', 'fr'];
    const userLang = validLangs.includes(String(lang).toLowerCase()) ? String(lang).toLowerCase() : 'ru';

    const at = now();
    const account = {
      login: id,
      name: display,
      salt,
      hash,
      recoverySalt,
      recoveryHash,
      extraPasswordSalt: null,
      extraPasswordHash: null,
      pubKey: typeof pubKey === 'string' ? pubKey : null,
      lang: userLang,
      createdAt: at,
      lastSeen: at,
    };
    state.accounts[id] = account;
    const token = issueToken(id, at);
    const cert = pubKey ? issueCertificate(id, pubKey) : null;
    schedule();
    return { ok: true, user: publicUser(account), token, recoveryKey, cert };
  }

  async function signIn({ login, password, pubKey, extraPassword } = {}) {
    const id = normalizeLogin(login);
    const account = validLogin(id) ? accountOf(id) : null;
    const secret = typeof password === 'string' ? password : '';

    // Every refusal before the real comparison costs one hash, so the time an
    // answer takes says nothing about whether the login exists.
    if (!account || secret.length < PASSWORD_MIN || secret.length > PASSWORD_MAX) {
      await hashPassword(secret.slice(0, PASSWORD_MAX), crypto.randomBytes(SALT_BYTES).toString('hex'));
      return { ok: false, code: 'bad_credentials' };
    }

    const pwd = secret.length >= 8 ? secret : secret.padEnd(8, '0');
    const hash = await hashPassword(pwd, account.salt);
    if (!sameHash(hash, account.hash)) return { ok: false, code: 'bad_credentials' };

    // An account with an additional password is not fully authenticated by the
    // primary one alone. This branch is only reached after the primary
    // password above was already proven correct, so naming the requirement
    // costs nothing to a wrong-password guesser — they never get here — and
    // `handleLogin` in server.js relies on exactly that to answer it plainly
    // instead of folding it into the generic `bad_credentials`.
    if (account.extraPasswordHash) {
      const extraSecret = typeof extraPassword === 'string' ? extraPassword : '';
      if (extraSecret === '') {
        return { ok: false, code: 'extra_password_required' };
      }
      if (extraSecret.length < PASSWORD_MIN || extraSecret.length > PASSWORD_MAX) {
        return { ok: false, code: 'bad_credentials' };
      }
      const extraPwd = extraSecret.length >= 8 ? extraSecret : extraSecret.padEnd(8, '0');
      const extraHash = await hashPassword(extraPwd, account.extraPasswordSalt);
      if (!sameHash(extraHash, account.extraPasswordHash)) return { ok: false, code: 'bad_credentials' };
    }

    const at = now();
    account.lastSeen = at;
    if (pubKey && typeof pubKey === 'string') account.pubKey = pubKey;
    const token = issueToken(id, at);
    const cert = account.pubKey ? issueCertificate(id, account.pubKey) : null;
    schedule();
    return { ok: true, user: publicUser(account), token, cert };
  }

  async function recoverAccount({ login, recoveryKey, newPassword } = {}) {
    const id = normalizeLogin(login);
    if (!validLogin(id)) return { ok: false, code: 'invalid_login' };
    if (typeof newPassword !== 'string' || newPassword.length < newPasswordMin || newPassword.length > PASSWORD_MAX) {
      return { ok: false, code: 'invalid_password' };
    }

    const account = accountOf(id);
    const key = normalizeRecoveryKey(recoveryKey);

    if (!account || !account.recoverySalt || !account.recoveryHash || key.length === 0) {
      await hashPassword(key, crypto.randomBytes(SALT_BYTES).toString('hex'));
      return { ok: false, code: 'bad_recovery_key' };
    }

    const hash = await hashPassword(key, account.recoverySalt);
    if (!sameHash(hash, account.recoveryHash)) {
      return { ok: false, code: 'bad_recovery_key' };
    }

    const newSalt = crypto.randomBytes(SALT_BYTES).toString('hex');
    const pwd = newPassword.length >= 8 ? newPassword : newPassword.padEnd(8, '0');
    const newHash = await hashPassword(pwd, newSalt);

    const newRecoveryKey = generateRecoveryKey();
    const newRecoverySalt = crypto.randomBytes(SALT_BYTES).toString('hex');
    const newRecoveryHash = await hashPassword(normalizeRecoveryKey(newRecoveryKey), newRecoverySalt);

    const at = now();
    account.salt = newSalt;
    account.hash = newHash;
    account.recoverySalt = newRecoverySalt;
    account.recoveryHash = newRecoveryHash;
    // The recovery key is already the strongest proof of ownership this
    // account has — it alone re-keys the primary password and mints a new
    // recovery key too. Leaving an additional password standing behind it
    // would strand someone who forgot both with no way back in at all, since
    // there is no separate recovery path for it.
    account.extraPasswordSalt = null;
    account.extraPasswordHash = null;
    account.lastSeen = at;

    const token = issueToken(id, at);
    schedule();
    return { ok: true, user: publicUser(account), token, newRecoveryKey };
  }
  async function updateProfile({ login, name, currentPassword, newPassword, extraPassword, lang } = {}) {
    const id = normalizeLogin(login);
    const account = validLogin(id) ? accountOf(id) : null;
    if (!account) return { ok: false, code: 'unknown_token' };

    let display = account.name;
    if (name !== undefined) {
      display = resolveName(name, id);
      if (display === null) return { ok: false, code: 'invalid_name' };
    }

    if (lang !== undefined) {
      const validLangs = ['ru', 'en', 'fr'];
      if (validLangs.includes(String(lang).toLowerCase())) {
        account.lang = String(lang).toLowerCase();
      }
    }

    const changingMainPassword = newPassword !== undefined && newPassword !== '';
    // `undefined` leaves the additional password untouched; `''`/`null` clears
    // it; anything else sets/replaces it. That three-way split is the whole
    // reason this is a separate flag from `changingMainPassword` rather than
    // folded into the same `newPassword` check.
    const changingExtraPassword = extraPassword !== undefined;
    const clearingExtraPassword = changingExtraPassword && (extraPassword === null || extraPassword === '');

    if (changingMainPassword && (typeof newPassword !== 'string' || newPassword.length < newPasswordMin || newPassword.length > PASSWORD_MAX)) {
      return { ok: false, code: 'invalid_password' };
    }
    if (changingExtraPassword && !clearingExtraPassword
        && (typeof extraPassword !== 'string' || extraPassword.length < newPasswordMin || extraPassword.length > PASSWORD_MAX)) {
      return { ok: false, code: 'invalid_password' };
    }

    let passwordChange = null;
    let extraPasswordChange; // undefined: no change; null: clear; {salt,hash}: set
    if (changingMainPassword || changingExtraPassword) {
      // Both kinds of password change are security-lowering or security-adding
      // enough to require proving the account's primary password first — same
      // rule the pre-existing password change already followed.
      if (typeof currentPassword !== 'string' || currentPassword.length < PASSWORD_MIN || currentPassword.length > PASSWORD_MAX) {
        return { ok: false, code: 'bad_credentials' };
      }
      const previousSalt = account.salt;
      const previousHash = account.hash;
      const current = currentPassword.length >= 8 ? currentPassword : currentPassword.padEnd(8, '0');
      const currentHash = await hashPassword(current, previousSalt);
      if (!sameHash(currentHash, previousHash)) return { ok: false, code: 'bad_credentials' };

      if (changingMainPassword) {
        const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
        const next = newPassword.length >= 8 ? newPassword : newPassword.padEnd(8, '0');
        const hash = await hashPassword(next, salt);
        if (account.salt !== previousSalt || account.hash !== previousHash) {
          return { ok: false, code: 'bad_credentials' };
        }
        passwordChange = { salt, hash };
      }

      if (changingExtraPassword) {
        if (clearingExtraPassword) {
          extraPasswordChange = null;
        } else {
          const extraSalt = crypto.randomBytes(SALT_BYTES).toString('hex');
          const extraPwd = extraPassword.length >= 8 ? extraPassword : extraPassword.padEnd(8, '0');
          const extraHash = await hashPassword(extraPwd, extraSalt);
          extraPasswordChange = { salt: extraSalt, hash: extraHash };
        }
      }
    }

    account.name = display;
    if (passwordChange) {
      account.salt = passwordChange.salt;
      account.hash = passwordChange.hash;
    }
    if (extraPasswordChange !== undefined) {
      account.extraPasswordSalt = extraPasswordChange ? extraPasswordChange.salt : null;
      account.extraPasswordHash = extraPasswordChange ? extraPasswordChange.hash : null;
    }
    account.lastSeen = now();
    schedule();
    return { ok: true, user: publicUser(account) };
  }


  function resolveToken(token) {
    if (typeof token !== 'string' || token === '') return null;
    const entry = state.tokens[tokenKey(token)];
    if (!entry) return null;
    if (tokenIdleMs > 0) {
      const used = finiteOr(entry.lastUsed, finiteOr(entry.createdAt, null));
      if (used !== null && now() - used > tokenIdleMs) {
        delete state.tokens[tokenKey(token)];
        schedule();
        return null;
      }
    }
    const account = accountOf(entry.login);
    if (!account) {
      delete state.tokens[tokenKey(token)];
      schedule();
      return null;
    }
    // `lastUsed` is informational — nothing reads it to make a decision — and
    // this function runs on *every* authenticated HTTP request and every
    // WebSocket auth. Writing it each time marked the whole store dirty, and a
    // dirty store is a synchronous `JSON.stringify` of everything (accounts,
    // every conversation, every inline attachment) plus a write of the same
    // size: measured at 40-55 ms for a 23 MB store on a desktop, worse on the
    // server, repeated every `writeDelayMs` for as long as anybody was using
    // the deployment. Coarse by a minute costs nothing that anyone can observe
    // and takes the busiest path in the process off the disk.
    const at = now();
    if (at - finiteOr(entry.lastUsed, 0) >= COARSE_TOUCH_MS) {
      entry.lastUsed = at;
      schedule();
    }
    return { login: account.login, name: account.name, extraPasswordEnabled: Boolean(account.extraPasswordHash) };
  }

  function revokeToken(token) {
    if (typeof token !== 'string' || token === '') return false;
    const key = tokenKey(token);
    if (!state.tokens[key]) return false;
    delete state.tokens[key];
    schedule();
    return true;
  }

  function users() {
    return Object.values(state.accounts)
      .map((account) => ({ login: account.login, name: account.name, lastSeen: account.lastSeen }))
      .sort((left, right) => left.name.localeCompare(right.name, 'ru') || left.login.localeCompare(right.login));
  }

  function friends(login) {
    const id = normalizeLogin(login);
    const list = state.friends[id] ?? [];
    return list
      .map((friendLogin) => accountOf(friendLogin))
      .filter((acc) => Boolean(acc))
      .map((acc) => ({ login: acc.login, name: acc.name, lastSeen: acc.lastSeen }))
      .sort((left, right) => left.name.localeCompare(right.name, 'ru') || left.login.localeCompare(right.login));
  }

  function areFriends(a, b) {
    const left = normalizeLogin(a);
    const right = normalizeLogin(b);
    if (left === right || !validLogin(left) || !validLogin(right)) return false;
    return Boolean(state.friends[left]?.includes(right) && state.friends[right]?.includes(left));
  }

  function createInvite(login) {
    const id = normalizeLogin(login);
    if (!accountOf(id)) return null;

    for (const [hash, inv] of Object.entries(state.invites)) {
      if (inv.login === id) delete state.invites[hash];
    }

    const raw = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    state.invites[tokenKey(raw)] = { login: id, createdAt: now() };
    schedule();
    return raw;
  }

  function acceptInvite(login, rawToken) {
    const id = normalizeLogin(login);
    if (!accountOf(id)) return { ok: false, code: 'unknown_token' };
    if (typeof rawToken !== 'string' || !/^[0-9a-f]{64}$/i.test(rawToken.trim())) {
      return { ok: false, code: 'invalid_invite' };
    }

    const key = tokenKey(rawToken.trim());
    const invite = state.invites[key];
    if (!invite) return { ok: false, code: 'invite_not_found' };

    const hostLogin = normalizeLogin(invite.login);
    if (hostLogin === id) return { ok: false, code: 'self_invite' };

    const hostAccount = accountOf(hostLogin);
    if (!hostAccount) {
      delete state.invites[key];
      schedule();
      return { ok: false, code: 'invite_not_found' };
    }

    delete state.invites[key];

    const myFriends = state.friends[id] ?? (state.friends[id] = []);
    if (!myFriends.includes(hostLogin)) myFriends.push(hostLogin);

    const theirFriends = state.friends[hostLogin] ?? (state.friends[hostLogin] = []);
    if (!theirFriends.includes(id)) theirFriends.push(id);

    // Either side may have deleted the other before this invite: a fresh
    // friendship puts the contact back on both rosters.
    clearRemoval(id, hostLogin);
    clearRemoval(hostLogin, id);
    dropFriendRequest(id, hostLogin);
    dropFriendRequest(hostLogin, id);

    schedule();
    return { ok: true, friend: { login: hostAccount.login, name: hostAccount.name } };
  }

  // Friendship for the two sides that never exchange an invite: the official
  // announcement account and everybody it has to be visible to (see
  // `service-account.js`). The roster is built from `friends`, so this is what
  // puts that account in the list at all.
  function linkFriends(a, b) {
    const left = normalizeLogin(a);
    const right = normalizeLogin(b);
    if (left === right || !accountOf(left) || !accountOf(right)) return false;

    const mine = state.friends[left] ?? (state.friends[left] = []);
    if (!mine.includes(right)) mine.push(right);

    const theirs = state.friends[right] ?? (state.friends[right] = []);
    if (!theirs.includes(left)) theirs.push(left);

    // A linked pair is a visible pair: whatever either side deleted earlier,
    // the contact belongs on both rosters again.
    clearRemoval(left, right);
    clearRemoval(right, left);
    // Whatever either side had asked for is now answered by the friendship
    // itself; a question left pending would be answerable a second time.
    dropFriendRequest(left, right);
    dropFriendRequest(right, left);

    schedule();
    return true;
  }

  /** Pending questions waiting for [login]'s answer, oldest first. */
  function friendRequests(login) {
    const id = normalizeLogin(login);
    if (!validLogin(id)) return [];
    return (state.friendRequests[id] ?? []).map((entry) => ({ ...entry }));
  }

  /** Removes `from`'s question to `to`, answered or obsolete. Returns whether
   *  there was one — the caller decides whether that is an error. */
  function dropFriendRequest(to, from) {
    const owner = normalizeLogin(to);
    const asker = normalizeLogin(from);
    const pending = state.friendRequests[owner];
    if (!pending) return false;
    const index = pending.findIndex((entry) => entry.from === asker);
    if (index < 0) return false;
    pending.splice(index, 1);
    if (pending.length === 0) delete state.friendRequests[owner];
    return true;
  }

  /**
   * «@login, add me» — the half of adding a contact that does not need a code
   * passed out of band.
   *
   * Never links the two by itself: an invite is consent given in advance, a
   * request is consent still being asked for, and the only thing that turns
   * one into a friendship is the recipient's own answer
   * ([answerFriendRequest]). The two exceptions are not exceptions to that
   * rule: an existing friendship has nothing left to ask, and a *mutual*
   * request is both sides having asked, which is the same agreement arriving
   * in two messages.
   *
   * `{ delivered }` tells the caller whether anything is owed to the
   * recipient. It is deliberately `false` both for a repeat (the question is
   * already on their screen) and for a recipient who has blocked the asker —
   * and the *answer* in the second case is indistinguishable from success,
   * because a block that can be detected by probing is not a block.
   */
  function requestFriend(fromLogin, toLogin) {
    const from = normalizeLogin(fromLogin);
    const to = normalizeLogin(toLogin);
    if (!validLogin(from) || !accountOf(from)) return { ok: false, code: 'unknown_token' };
    if (!validLogin(to)) return { ok: false, code: 'invalid_login' };
    if (from === to) return { ok: false, code: 'self_request' };
    const target = accountOf(to);
    if (!target) return { ok: false, code: 'unknown_user' };

    if (areFriends(from, to)) {
      // Already contacts — but the asker may be looking for somebody they
      // deleted from their own list, in which case «добавить» means exactly
      // «верни его в список», and there is nobody to ask for that.
      const restored = isRemoved(from, to);
      if (restored) {
        clearRemoval(from, to);
        schedule();
      }
      return {
        ok: true, state: 'friends', delivered: false, restored,
        friend: { login: target.login, name: target.name },
      };
    }

    // The asker's own block is theirs to lift, so it is answered plainly;
    // the recipient's block is never revealed (see the doc comment).
    if (hasBlocked(from, to)) return { ok: false, code: 'blocked' };
    if (hasBlocked(to, from)) return { ok: true, state: 'requested', delivered: false };

    // They asked first: two people who have both asked are two people who
    // agree, and making either of them press a button to confirm what they
    // already said would be ceremony.
    if ((state.friendRequests[from] ?? []).some((entry) => entry.from === to)) {
      linkFriends(from, to);
      return {
        ok: true, state: 'friends', delivered: false, mutual: true,
        friend: { login: target.login, name: target.name },
      };
    }

    const pending = state.friendRequests[to] ?? (state.friendRequests[to] = []);
    if (pending.some((entry) => entry.from === from)) {
      return { ok: true, state: 'requested', delivered: false };
    }
    if (pending.length >= FRIEND_REQUESTS_IN_LIMIT) return { ok: false, code: 'request_limit' };

    let outstanding = 0;
    for (const list of Object.values(state.friendRequests)) {
      for (const entry of list) if (entry.from === from) outstanding += 1;
    }
    if (outstanding >= FRIEND_REQUESTS_OUT_LIMIT) {
      if (pending.length === 0) delete state.friendRequests[to];
      return { ok: false, code: 'request_limit' };
    }

    pending.push({ from, at: now() });
    schedule();
    return { ok: true, state: 'requested', delivered: true };
  }

  /**
   * The recipient's answer. `accept` links the pair exactly as an invite
   * would; a refusal only drops the question — the asker is never told, which
   * is what keeps «нет» from being a message somebody has to receive.
   */
  function answerFriendRequest(ownerLogin, fromLogin, accept) {
    const owner = normalizeLogin(ownerLogin);
    const asker = normalizeLogin(fromLogin);
    if (!validLogin(owner) || !accountOf(owner)) return { ok: false, code: 'unknown_token' };
    if (!validLogin(asker)) return { ok: false, code: 'invalid_login' };
    if (!dropFriendRequest(owner, asker)) return { ok: false, code: 'request_not_found' };

    const account = accountOf(asker);
    if (!account || !accept) {
      schedule();
      return { ok: true, accepted: false };
    }
    // `linkFriends` schedules its own write.
    linkFriends(owner, asker);
    return { ok: true, accepted: true, friend: { login: account.login, name: account.name } };
  }

  // Asymmetric, unlike `areFriends`: A having blocked B says nothing about
  // whether B has blocked A. hub.js checks both directions before letting a
  // frame through (`hasBlocked(a,b) || hasBlocked(b,a)`), so either side
  // blocking is enough to stop the pair exchanging new messages.
  function hasBlocked(blocker, target) {
    const left = normalizeLogin(blocker);
    const right = normalizeLogin(target);
    if (left === right || !validLogin(left) || !validLogin(right)) return false;
    return Boolean(state.blocked[left]?.includes(right));
  }

  function blockedLogins(login) {
    const id = normalizeLogin(login);
    return (state.blocked[id] ?? []).slice();
  }

  // Asymmetric, unlike `areFriends`: only the account that deleted the contact
  // stops seeing it. The other side is never told, and nothing about the pair
  // changes for it (see `removeContact`).
  function isRemoved(owner, target) {
    const id = normalizeLogin(owner);
    const other = normalizeLogin(target);
    if (id === other || !validLogin(id) || !validLogin(other)) return false;
    return Boolean(state.removed[id]?.includes(other));
  }

  function removedLogins(login) {
    return (state.removed[normalizeLogin(login)] ?? []).slice();
  }

  // How far this owner's view of a conversation was cut by a contact deletion.
  // 0 is every conversation that never went through one.
  function purgeSeq(owner, other) {
    return state.purges[normalizeLogin(owner)]?.[conversationKey(owner, other)] ?? 0;
  }

  // Becoming friends again — an invite accepted from either side, or the
  // boot-time link of an official account — puts the contact back on the
  // roster. The watermark is deliberately left alone: the deleted conversation
  // stays deleted, and the thread starts over from the new messages.
  function clearRemoval(owner, other) {
    const mine = state.removed[owner];
    if (!mine) return;
    const index = mine.indexOf(other);
    if (index < 0) return;
    mine.splice(index, 1);
    if (mine.length === 0) delete state.removed[owner];
  }

  // Blocking is scoped to existing friends: the roster (and every client's
  // block UI) only ever shows friends, so a target that is not one is either
  // a stale request or a crafted call — same gate `not_friends` already
  // enforces elsewhere (history, addressed-send).
  function blockUser(login, target) {
    const id = normalizeLogin(login);
    const other = normalizeLogin(target);
    if (id === other) return { ok: false, code: 'self_block' };
    if (!accountOf(id) || !accountOf(other)) return { ok: false, code: 'unknown_user' };
    if (!areFriends(id, other)) return { ok: false, code: 'not_friends' };

    const mine = state.blocked[id] ?? (state.blocked[id] = []);
    if (!mine.includes(other)) mine.push(other);
    schedule();
    return { ok: true };
  }

  // Idempotent: unblocking someone never-blocked is not an error, the same
  // way `removePushSubscription` of an absent endpoint is not.
  function unblockUser(login, target) {
    const id = normalizeLogin(login);
    const other = normalizeLogin(target);
    const mine = state.blocked[id];
    if (!mine) return { ok: true };
    const index = mine.indexOf(other);
    if (index !== -1) {
      mine.splice(index, 1);
      if (mine.length === 0) delete state.blocked[id];
      schedule();
    }
    return { ok: true };
  }

  function touch(login, at) {
    const account = accountOf(normalizeLogin(login));
    if (!account) return false;
    account.lastSeen = finiteOr(at, now());
    schedule();
    return true;
  }

  // «Изменение ника собеседника»: the name *this* account calls one of its
  // contacts. Private and asymmetric, exactly like `blocked` — the peer is
  // never told, and never sees it; the point is that the owner's own clients
  // (phone, browser, terminal) all read the one name back from here instead of
  // each keeping its own local nickname. `name` empty clears it.
  //
  // Scoped to friends for the same reason `blockUser` is: the roster is the
  // only place a nickname is ever shown, so a target that is not a contact is
  // either a stale request or a crafted call.
  function setAlias(login, peer, name) {
    const owner = normalizeLogin(login);
    const other = normalizeLogin(peer);
    if (owner === other) return { ok: false, code: 'self_alias' };
    if (!accountOf(owner) || !accountOf(other)) return { ok: false, code: 'unknown_user' };
    if (!areFriends(owner, other)) return { ok: false, code: 'not_friends' };

    const raw = name === undefined || name === null ? '' : String(name).trim();
    if (raw === '') {
      const mine = state.aliases[owner];
      if (mine && mine[other] !== undefined) {
        delete mine[other];
        if (Object.keys(mine).length === 0) delete state.aliases[owner];
        schedule();
      }
      return { ok: true, alias: '' };
    }
    // Nothing but controls and separators was typed. Refused rather than
    // stored as something else: an empty nickname is how one is cleared, and a
    // blank row would say nothing about why.
    const display = cleanNickname(raw);
    if (display === '') return { ok: false, code: 'invalid_alias' };
    const mine = state.aliases[owner] ?? (state.aliases[owner] = Object.create(null));
    if (mine[other] !== display) {
      mine[other] = display;
      schedule();
    }
    return { ok: true, alias: display };
  }

  // '' when the account has no nickname for this contact: the roster renders
  // `alias || name || login`, so an absent nickname has to be distinguishable
  // from one that happens to be empty.
  function aliasOf(login, peer) {
    const owner = normalizeLogin(login);
    const other = normalizeLogin(peer);
    return state.aliases[owner]?.[other] ?? '';
  }

  // Chars of inline media a queued frame carries. Its own function rather than
  // `mediaChars`: a queue item holds a raw client frame, where `image` may be
  // present without a `dataUrl` at all.
  function frameMediaChars(frame) {
    const size = (value) => (typeof value?.dataUrl === 'string' ? value.dataUrl.length : 0);
    return size(frame?.image) + size(frame?.voice) + envelopeMediaChars(frame?.e2ee);
  }

  // What bounds the offline queue now that nothing is evicted from it by
  // count: inline media is given up from the oldest queued frames, the frame
  // and its text stay, and the full attachment is still in history for the
  // client to fetch. The frame is replaced rather than mutated — the same `d`
  // object is handed to other recipients and to the live relay.
  function evictQueueMedia(queue) {
    let total = 0;
    for (const item of queue) total += frameMediaChars(item.d);
    if (total <= queueMediaBudgetChars) return;
    for (const item of queue) {
      if (total <= queueMediaBudgetChars) return;
      const size = frameMediaChars(item.d);
      if (size === 0) continue;
      const stripped = { ...item.d, mediaDropped: true };
      delete stripped.image;
      delete stripped.voice;
      // An envelope cannot give up its attachment and keep its text: both are
      // one ciphertext. The frame goes without it and the client fetches the
      // message from `/api/history`, exactly as for a dropped picture.
      delete stripped.e2ee;
      item.d = stripped;
      total -= size;
    }
  }

  function enqueue(login, item) {
    const id = normalizeLogin(login);
    // Queueing for a login nobody owns would grow the file for a recipient who
    // can never drain it.
    if (!accountOf(id) || !validQueueItem(item)) return state.queue[id]?.length ?? 0;

    const queue = state.queue[id] ?? (state.queue[id] = []);
    queue.push({ from: normalizeLogin(item.from), d: item.d, at: finiteOr(item.at, now()) });
    // Only a frame that actually carries an attachment can put the queue over
    // budget, so a queue of text costs nothing to append to.
    if (frameMediaChars(item.d) > 0) evictQueueMedia(queue);
    schedule();
    return queue.length;
  }

  function drain(login, from) {
    const id = normalizeLogin(login);
    const sender = normalizeLogin(from);
    const queue = state.queue[id];
    if (!queue || queue.length === 0) return [];

    const taken = [];
    const kept = [];
    for (const item of queue) {
      if (item.from === sender) taken.push(item);
      else kept.push(item);
    }
    if (taken.length === 0) return [];
    if (kept.length > 0) state.queue[id] = kept;
    else delete state.queue[id];
    schedule();
    return taken;
  }

  // A plain object, not a prototype-less one: this map is handed straight to
  // JSON responses and to tests that compare it, and the keys can only be
  // logins the pattern above already accepted.
  function pending(login, messagesOnly = false) {
    const counts = {};
    for (const item of state.queue[normalizeLogin(login)] ?? []) {
      if (messagesOnly && !['msg', 'ai'].includes(item.d?.t)) continue;
      counts[item.from] = (counts[item.from] ?? 0) + 1;
    }
    return counts;
  }

  // The unread *badge*, as opposed to the operational `pending()` above: only
  // human/AI messages move it, never the ack/read/edit/delete/react control
  // frames that share the same offline queue (a burst of receipts for other
  // people's messages must not read as hundreds of unread). A message id repeated in
  // the queue — the same id queued twice because the recipient stayed
  // offline across two sends, or drained twice in one batch — counts once;
  // an id-less legacy frame has no identity to dedupe against, so each one
  // is its own unread item.
  function dedupedMessageCounts(items) {
    const counts = {};
    const seenIds = new Map();
    for (const item of items) {
      if (!['msg', 'ai'].includes(item.d?.t)) continue;
      // An encrypted edit changes a message the reader already has.
      if (isSealedEdit(item.d)) continue;
      const sender = item.from;
      const id = typeof item.d?.id === 'string' ? item.d.id : '';
      if (id !== '') {
        let ids = seenIds.get(sender);
        if (!ids) { ids = new Set(); seenIds.set(sender, ids); }
        if (ids.has(id)) continue;
        ids.add(id);
      }
      counts[sender] = (counts[sender] ?? 0) + 1;
    }
    return counts;
  }

  // Per-sender unread counts for a login's whole offline queue — what every
  // UI-facing surface (roster badge, HTTP /api/users, `ready`/`users`) should
  // show. Deliberately separate from `pending()`, which stays a raw
  // operational queue-depth count and must not change: callers that need the
  // raw frame count (rate limiting, queue ordering) still want every frame
  // type.
  function unreadCounts(login) {
    const owner = normalizeLogin(login);
    const counts = dedupedMessageCounts(state.queue[owner] ?? []);
    for (const peer of state.markedUnread[owner] ?? []) {
      if ((counts[peer] ?? 0) === 0) counts[peer] = 1;
    }
    return counts;
  }

  // Same dedup rule applied to an already-drained batch (see `subscribe` in
  // hub.js): how many of the frames just handed to a client were actually
  // unread messages, not control frames replayed alongside them.
  function countMessageItems(items) {
    return Object.values(dedupedMessageCounts(items)).reduce((sum, n) => sum + n, 0);
  }

  function nameOf(login) {
    return accountOf(normalizeLogin(login))?.name ?? normalizeLogin(login);
  }

  function langOf(login) {
    return accountOf(normalizeLogin(login))?.lang || 'ru';
  }

  // A device claims its endpoint and keeps claiming it: `deviceId` is the
  // browser's own persistent id, so re-subscribing after the push service
  // rotates an endpoint replaces this device's previous entry instead of
  // leaving it behind to notify twice. Unclaimed subscriptions never enter
  // the store at all — see `normalizeDeviceId`.
  function addPushSubscription(login, subscription, deviceId) {
    const id = normalizeLogin(login);
    const sub = normalizePushSubscription(subscription);
    const device = normalizeDeviceId(deviceId);
    if (!accountOf(id) || !sub || !device) return false;

    const at = now();
    const subs = (state.pushSubs[id] ?? []).filter((existing) => (
      existing.endpoint !== sub.endpoint
      && existing.deviceId !== device
      && at - finiteOr(existing.seenAt, existing.addedAt) <= PUSH_SUB_TTL_MS
    ));
    subs.push({ ...sub, deviceId: device, addedAt: at, seenAt: at });
    while (subs.length > PUSH_SUB_LIMIT) subs.shift();
    state.pushSubs[id] = subs;
    schedule();
    return true;
  }

  function removePushSubscription(login, endpoint) {
    const id = normalizeLogin(login);
    const subs = state.pushSubs[id];
    if (!subs || typeof endpoint !== 'string' || endpoint === '') return false;
    const kept = subs.filter((existing) => existing.endpoint !== endpoint);
    if (kept.length === subs.length) return false;
    if (kept.length > 0) state.pushSubs[id] = kept;
    else delete state.pushSubs[id];
    schedule();
    return true;
  }

  function pushSubscriptions(login) {
    const subs = state.pushSubs[normalizeLogin(login)] ?? [];
    // A lease nobody renewed is filtered out on the way to the sender even
    // before a restart gets around to rewriting the file: the whole point is
    // that an abandoned browser stops being woken.
    const at = now();
    // And what the sender gets is the endpoint and its keys, nothing else: the
    // repair hash is this store's own bookkeeping, compared here and never
    // needed anywhere else, so it does not travel to another component — or into
    // anything that component might log.
    return subs
      .filter((sub) => at - finiteOr(sub.seenAt, sub.addedAt) <= PUSH_SUB_TTL_MS)
      .map((sub) => ({ endpoint: sub.endpoint, keys: sub.keys }));
  }

  // The key a browser hands to its *own service worker*, so a rotated push
  // endpoint can be re-registered with the app closed (`pushsubscriptionchange`
  // in `web/cloud/sw.js` — the only code that is awake at that moment).
  //
  // It is deliberately not the session token: a worker cannot read
  // sessionStorage at all, and putting a credential that opens the whole
  // account into storage a worker *can* read would trade a notification gap for
  // a much worse one (issue #17's decision about where the web token lives).
  // This key can do exactly one thing — replace this device's push
  // subscription — so a copy that outlives the tab costs notification
  // redirection in the worst case, and nothing else. It is stored hashed, bound
  // to the device it belongs to, and rotated on every use.
  function mintPushRepairKey(login, deviceId) {
    const id = normalizeLogin(login);
    const device = normalizeDeviceId(deviceId);
    const subs = state.pushSubs[id];
    if (!subs || !device) return null;
    const index = subs.findIndex((existing) => existing.deviceId === device);
    if (index < 0) return null;
    const key = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    subs[index] = { ...subs[index], repairHash: tokenKey(key), repairAt: now() };
    schedule();
    return key;
  }

  /**
   * Replaces one device's subscription, using the key that device was given.
   * The endpoint changes; the device, its login and its lease age do not —
   * which is exactly what a rotated endpoint is.
   */
  function repairPushSubscription(login, deviceId, repairKey, subscription) {
    const id = normalizeLogin(login);
    const device = normalizeDeviceId(deviceId);
    const sub = normalizePushSubscription(subscription);
    if (!id || !device || !sub || typeof repairKey !== 'string' || repairKey === '') {
      return { ok: false, code: 'invalid_subscription' };
    }
    const subs = state.pushSubs[id];
    const index = subs?.findIndex((existing) => existing.deviceId === device) ?? -1;
    if (index < 0) return { ok: false, code: 'unknown_device' };
    const existing = subs[index];
    if (!existing.repairHash || !sameHash(existing.repairHash, tokenKey(repairKey))) {
      return { ok: false, code: 'bad_repair_key' };
    }
    const key = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const at = now();
    subs[index] = {
      ...sub,
      deviceId: device,
      addedAt: finiteOr(existing.addedAt, at),
      seenAt: at,
      repairHash: tokenKey(key),
      repairAt: at,
    };
    state.pushSubs[id] = subs;
    schedule();
    return { ok: true, repairKey: key };
  }

  // Same shape as addPushSubscription: a token re-registering (app
  // reinstall, token rotation) replaces its old entry rather than piling up
  // duplicates for one physical device.
  //
  // A scope is *optional*, and that is load-bearing: every Android build up to
  // 0.71.0 registers without one, and a release that started refusing them
  // would answer those devices `400 invalid_token` on every retry — silent,
  // permanent push loss for exactly the people this field was added for. A
  // scope that is present but malformed is a different thing: a client bug
  // worth surfacing, so it is refused.
  function addFcmToken(login, token, scope) {
    const id = normalizeLogin(login);
    const clean = normalizeFcmToken(token);
    const absent = scope === undefined || scope === null || scope === '';
    const cleanScope = absent
      ? ''
      : (typeof scope === 'string' && /^[a-f0-9]{64}$/.test(scope) ? scope : null);
    if (!accountOf(id) || !clean || cleanScope === null) return false;

    const tokens = (state.fcmTokens[id] ?? []).filter((existing) => existing.token !== clean);
    tokens.push({ token: clean, scope: cleanScope, addedAt: now() });
    while (tokens.length > FCM_TOKEN_LIMIT) tokens.shift();
    state.fcmTokens[id] = tokens;
    schedule();
    return true;
  }

  function removeFcmToken(login, token) {
    const id = normalizeLogin(login);
    const tokens = state.fcmTokens[id];
    if (!tokens || typeof token !== 'string' || token === '') return false;
    const kept = tokens.filter((existing) => existing.token !== token);
    if (kept.length === tokens.length) return false;
    if (kept.length > 0) state.fcmTokens[id] = kept;
    else delete state.fcmTokens[id];
    schedule();
    return true;
  }

  function fcmTokens(login) {
    return state.fcmTokens[normalizeLogin(login)] ?? [];
  }

  function mediaChars(record) {
    return (record.image?.dataUrl.length ?? 0) + (record.voice?.dataUrl.length ?? 0) + envelopeMediaChars(record.e2ee);
  }

  // Inline media lives in `accounts.json`, which is held whole in memory and
  // rewritten atomically on every change, so keeping full-size attachments
  // indefinitely would result in a multi-gigabyte file and RSS. The oldest
  // pictures and recordings are given up first — the text of every message
  // is kept forever, only its attachment goes.
  function evictMedia(log, selfChat) {
    // Saved Messages is the one conversation nothing is ever taken out of, and
    // an attachment is precisely what a person saves there. Its budget is
    // enforced by refusing the newest attachment instead (see below).
    if (selfChat) return;
    let total = 0;
    for (const record of log) total += mediaChars(record);
    if (total <= historyMediaBudgetChars) return;

    for (const record of log) {
      if (total <= historyMediaBudgetChars) return;
      const size = mediaChars(record);
      if (size === 0) continue;
      delete record.image;
      delete record.voice;
      // Only an envelope large enough to carry an attachment counts here
      // (`envelopeMediaChars`), and it goes whole: its text is inside it.
      delete record.e2ee;
      record.mediaDropped = true;
      total -= size;
    }
  }

  // Whether this incoming attachment would take Saved Messages over budget.
  // Only ever asked when there is one: the log has no count ceiling, so
  // summing it per message would put a full scan behind every line of text
  // saved to a large archive.
  function savedMediaOverBudget(log, incoming) {
    let total = incoming;
    for (const record of log) {
      total += mediaChars(record);
      if (total > savedMediaBudgetChars) return true;
    }
    return false;
  }

  // The stored record itself, or null. A retry of a message the sender never
  // saw acknowledged is answered from this: same id and same content means
  // the receipt was lost, not that a second message was written.
  function findHistoryMessage(a, b, id, from = null) {
    const messageId = typeof id === 'string' ? id : '';
    if (messageId === '') return null;
    const log = state.history[conversationKey(a, b)] || [];
    const sender = from == null ? null : normalizeLogin(from);
    return log.find((record) => record.id === messageId && (sender == null || record.from === sender)) ?? null;
  }

  // One record of a conversation as `reader` is allowed to see it, for the
  // media route (docs/specs/2026-11-03-history-media-refs.md §6.2). The rules
  // are `history()`'s — a contact's removal cut, messages hidden "for me" — so
  // the route can never hand out an attachment the history would not.
  // `deleted` is answered separately: a tombstone is a different refusal (410)
  // from a record that is not there (404).
  function visibleRecord(reader, peer, id) {
    if (typeof id !== 'string' || id === '') return { status: 'missing' };
    const log = state.history[conversationKey(reader, peer)];
    if (!log) return { status: 'missing' };
    const hidden = state.hidden[normalizeLogin(reader)]?.[conversationKey(reader, peer)];
    const cut = purgeSeq(reader, peer);
    const record = log.find((item) => item.id === id);
    if (!record || beforePurge(record, cut) || hidden?.includes(id)) return { status: 'missing' };
    if (record.deletedAt) return { status: 'deleted' };
    return { status: 'ok', record };
  }

  function nextSeq() {
    state.seq += 1;
    return state.seq;
  }

  // One account's view of one mutation. An event already carrying a sequence
  // number keeps it — that is how a replayed journal line lands in the same
  // order it was committed in.
  function appendEvent(login, event) {
    const id = normalizeLogin(login);
    if (!validLogin(id)) return null;
    const stored = normalizeEvent({
      ...event,
      seq: Number.isFinite(event?.seq) ? event.seq : nextSeq(),
    });
    if (!stored) return null;
    const log = state.events[id] ?? (state.events[id] = []);
    log.push(stored);
    while (log.length > EVENT_LIMIT) log.shift();
    if (stored.seq > state.seq) state.seq = stored.seq;
    schedule();
    return stored;
  }

  // Both sides of a conversation record the same mutation from their own
  // angle: `peer` is whoever they are talking to, and the number is shared, so
  // neither can order two mutations differently from the other. `author`
  // marks the copy belonging to whoever performed it. Shared by every
  // durable mutation (message, edit, react, delete) so a journal-replayed
  // entry reconstructs exactly the same per-account event pair the live path
  // produced, seq for seq.
  function twoSidedEvents(left, right, event, seq, author = null) {
    const owner = author === null ? null : normalizeLogin(author);
    const events = [{ login: left, event: { ...event, seq, peer: right, ...(owner === left ? { self: true } : {}) } }];
    if (right !== left) {
      events.push({ login: right, event: { ...event, seq, peer: left, ...(owner === right ? { self: true } : {}) } });
    }
    return events;
  }

  function recordEvent(a, b, event, author = null) {
    const left = normalizeLogin(a);
    const right = normalizeLogin(b);
    if (!validLogin(left) || !validLogin(right)) return null;
    const seq = nextSeq();
    for (const { login, event: item } of twoSidedEvents(left, right, event, seq, author)) appendEvent(login, item);
    return seq;
  }

  // The events one durable message produces, as journal-ready pairs.
  function messageEvents(left, right, record, seq) {
    return twoSidedEvents(left, right, { kind: 'message', id: record.id, ts: record.ts, from: record.from }, seq, record.from);
  }

  // Where a message actually enters the log, whichever door it came through:
  // a committed relay, a server-generated reply, or a journal line replayed at
  // start-up.
  function applyHistoryRecord(left, right, message, seq = null) {
    const key = conversationKey(left, right);
    const log = state.history[key] ?? (state.history[key] = []);
    const record = normalizeMessage(message, now());
    if (seq !== null) record.seq = seq;
    // Saved Messages is where a person puts what they want to keep, so
    // automatic deletion there is data loss and not housekeeping: no count
    // ceiling, no media eviction. Memory is still bounded — by refusing this
    // attachment and keeping its text, the only way to bound anything without
    // touching what is already stored.
    const selfChat = left === right;
    const incoming = mediaChars(record);
    if (selfChat && incoming > 0 && savedMediaOverBudget(log, incoming)) {
      delete record.image;
      delete record.voice;
      delete record.e2ee;
      record.mediaDropped = true;
    }
    log.push(record);
    evictMedia(log, selfChat);
    return record;
  }

  function recordHistory(a, b, message) {
    const left = normalizeLogin(a);
    const right = normalizeLogin(b);
    if (!validLogin(left) || !validLogin(right)) return false;
    const record = applyHistoryRecord(left, right, message);
    const seq = recordEvent(left, right, {
      kind: 'message', id: record.id, ts: record.ts, from: record.from,
    }, record.from);
    // Every record in the log carries the number it was committed under,
    // whichever door it came through (`applyHistoryRecord`). Without this the
    // event would have a seq and the record none, and a reader whose side of
    // the conversation a contact deletion cut (`beforePurge` in `history`)
    // would count this message as older than the cut and never see it again.
    if (Number.isFinite(seq)) record.seq = seq;
    schedule();
    return true;
  }

  // A commit already on its way to disk for this exact (conversation, id):
  // the WAL write is real fs I/O with a genuine await boundary, and a retry
  // whose ack never arrived can reach `receive()` again before that boundary
  // resolves. `findHistoryMessage` alone only catches a retry that arrives
  // *after* the first commit applied — this closes the window in between,
  // where two calls would otherwise both assign a seq and both push a row
  // under the same id. Keyed by id only when the frame carries one: a
  // legacy/id-less frame has nothing to join against and always commits on
  // its own, exactly as before.
  const commitInFlight = new Map();

  function samePayload(a, b) {
    if (a?.e2ee || b?.e2ee) return sameEnvelope(normalizeEnvelope(a?.e2ee), normalizeEnvelope(b?.e2ee));
    const text = (v) => (typeof v?.text === 'string' ? v.text : '');
    if (text(a) !== text(b)) return false;
    const dataUrl = (v) => (v && typeof v === 'object' && typeof v.dataUrl === 'string' ? v.dataUrl : '');
    return dataUrl(a?.image) === dataUrl(b?.image) && dataUrl(a?.voice) === dataUrl(b?.voice);
  }

  // The durable path, and the only one whose result may be acknowledged: the
  // sequence number is assigned, the line is fsynced into the journal, and
  // only a journal that took it lets the message into memory. A caller that
  // catches here must not tell the sender the message arrived — it is still
  // theirs to retry, under the same id.
  async function commitHistory(a, b, message) {
    const left = normalizeLogin(a);
    const right = normalizeLogin(b);
    if (!validLogin(left) || !validLogin(right)) throw new TypeError('commitHistory requires two logins');

    const id = typeof message?.id === 'string' ? message.id : '';
    const key = id !== '' ? `${conversationKey(left, right)}\u0000${id}` : null;
    if (key) {
      const pending = commitInFlight.get(key);
      // Same id, same text/attachment while the first is still mid-flight: the
      // second call is the retry, not a second message. A differing payload
      // under a colliding id is not this join's problem — it commits on its
      // own, same as it always has.
      if (pending && samePayload(pending.message, message)) return pending.promise;
    }

    const task = (async () => {
      const record = normalizeMessage(message, now());
      const seq = nextSeq();
      record.seq = seq;
      const events = messageEvents(left, right, record, seq);

      await wal.append({ v: 1, kind: 'history', seq, a: left, b: right, record, events });

      const stored = applyHistoryRecord(left, right, record, seq);
      for (const { login, event } of events) appendEvent(login, event);
      appliedJournalSeq = Math.max(appliedJournalSeq, seq);
      schedule();
      return stored;
    })();

    if (key) {
      commitInFlight.set(key, { message, promise: task });
      task.then(
        () => { if (commitInFlight.get(key)?.promise === task) commitInFlight.delete(key); },
        () => { if (commitInFlight.get(key)?.promise === task) commitInFlight.delete(key); },
      );
    }

    return task;
  }

  // A journal line, back from the disk. Everything here has already happened
  // once, so it is applied only where the snapshot did not already contain
  // it. Every mutation kind's apply step is idempotent by construction (a
  // record already carrying an edit's text, or already holding a reaction,
  // or already missing a deleted id, is left exactly as it is), which is what
  // lets a truncate-boundary replay re-run a line the snapshot already
  // covered without corrupting state.
  function applyJournalEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    const seq = Math.max(0, Math.floor(finiteOr(entry.seq, 0)));
    if (seq > state.seq) state.seq = seq;

    let applied = false;
    if (entry.kind === 'history') {
      const left = normalizeLogin(entry.a);
      const right = normalizeLogin(entry.b);
      if (validLogin(left) && validLogin(right) && entry.record
        && !findHistoryMessage(left, right, entry.record.id, entry.record.from)) {
        applyHistoryRecord(left, right, entry.record, seq);
        applied = true;
      }
    } else if (entry.kind === 'edit') {
      const left = normalizeLogin(entry.a);
      const right = normalizeLogin(entry.b);
      if (validLogin(left) && validLogin(right)
        && applyEditMutation(left, right, entry.id, entry.text, entry.editedAt)) applied = true;
    } else if (entry.kind === 'react') {
      const left = normalizeLogin(entry.a);
      const right = normalizeLogin(entry.b);
      if (validLogin(left) && validLogin(right)
        && applyReactMutation(left, right, entry.id, entry.by, entry.emoji, entry.add)) applied = true;
    } else if (entry.kind === 'delete') {
      const left = normalizeLogin(entry.a);
      const right = normalizeLogin(entry.b);
      if (validLogin(left) && validLogin(right) && Array.isArray(entry.ids)) {
        if (entry.tombstone === true) applyTombstoneMutation(left, right, entry.ids, entry.deletedAt);
        else applyDeleteMutation(left, right, entry.ids);
        applied = true;
      }
    } else if (entry.kind === 'hide') {
      const owner = normalizeLogin(entry.owner);
      const other = normalizeLogin(entry.other);
      if (validLogin(owner) && validLogin(other) && Array.isArray(entry.ids)) {
        applyHideMutation(owner, other, entry.ids);
        applied = true;
      }
    } else if (entry.kind === 'remove') {
      const owner = normalizeLogin(entry.owner);
      const other = normalizeLogin(entry.other);
      if (validLogin(owner) && validLogin(other)) {
        applyRemoveMutation(owner, other, seq);
        applied = true;
      }
    } else if (entry.kind === 'receipt') {
      const owner = normalizeLogin(entry.owner);
      const other = normalizeLogin(entry.other);
      if (validLogin(owner) && validLogin(other) && Number.isFinite(entry.ts) && entry.ts >= 0) {
        applyReceipt(owner, other, entry);
        applied = true;
      }
    } else if (typeof entry.kind === 'string' && entry.kind.startsWith('e2ee-')) {
      applied = applyE2eeEntry(entry);
    } else {
      return false;
    }

    for (const item of Array.isArray(entry.events) ? entry.events : []) {
      const owner = normalizeLogin(item?.login);
      if (state.events[owner]?.some((existing) => existing.seq === item?.event?.seq)) continue;
      if (appendEvent(owner, item?.event)) applied = true;
    }
    return applied;
  }

  // What changed for this account since `since`, oldest first. `reset` says
  // the cursor is older than anything retained: the client cannot close that
  // gap from here and has to re-seed from history instead — so it is handed
  // the start of the window rather than nothing.
  function eventsSince(login, since = 0, limit = EVENT_PAGE_DEFAULT) {
    const id = normalizeLogin(login);
    const log = state.events[id] ?? [];
    const from = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
    const oldest = log.length > 0 ? log[0].seq : 0;
    const reset = from > 0 && from < oldest;
    const size = Number.isFinite(limit) && limit > 0
      ? Math.min(EVENT_PAGE_MAX, Math.floor(limit))
      : EVENT_PAGE_DEFAULT;

    const start = reset ? 0 : log.findIndex((event) => event.seq > from);
    const remaining = start < 0 ? [] : log.slice(start);
    const events = remaining.slice(0, size).map((event) => ({ ...event }));
    return {
      events,
      cursor: events.length > 0 ? events[events.length - 1].seq : from,
      more: remaining.length > events.length,
      reset,
    };
  }

  // A deletion keeps only an id and timestamp: the original content and media
  // are gone, while clients that opt in can still render a harmless marker in
  // the message's original position. The id also blocks stale history pages
  // from bringing the content back.
  function deletableIds(left, right, ids) {
    const wanted = new Set(ids);
    return (state.history[conversationKey(left, right)] || [])
      .filter(record => wanted.has(record.id) && record.from === left && !record.deletedAt)
      .map(record => record.id);
  }

  function removeQueuedCopies(left, right, ids) {
    const wanted = new Set(ids);
    for (const owner of [left, right]) {
      const queue = state.queue[owner];
      if (!queue) continue;
      const kept = queue.filter(item => !wanted.has(item.d?.id));
      if (kept.length > 0) state.queue[owner] = kept;
      else delete state.queue[owner];
    }
  }

  // Legacy journal entries predate tombstones and have already permanently
  // removed their records. Preserve that replay contract; new entries below
  // carry `tombstone: true`.
  function applyDeleteMutation(left, right, ids) {
    const wanted = new Set(ids);
    const key = conversationKey(left, right);
    const log = state.history[key];
    if (log) {
      const kept = log.filter(record => !wanted.has(record.id));
      if (kept.length > 0) state.history[key] = kept;
      else delete state.history[key];
    }
    removeQueuedCopies(left, right, ids);
  }

  function applyTombstoneMutation(left, right, ids, deletedAt = now()) {
    const accepted = deletableIds(left, right, ids);
    if (accepted.length === 0) return [];
    const wanted = new Set(accepted);
    for (const record of state.history[conversationKey(left, right)] || []) {
      if (!wanted.has(record.id)) continue;
      record.deletedAt = Number.isFinite(deletedAt) ? deletedAt : now();
      record.text = '';
      delete record.image; delete record.voice; delete record.reactions;
      delete record.reactionEvents; delete record.replyTo; delete record.mediaDropped; delete record.forwardedFrom;
    }
    removeQueuedCopies(left, right, accepted);
    return accepted;
  }

  // The same WAL-backed operation serves every client. A terminal, phone and
  // browser all receive the original ids; each local preference decides whether
  // a marker is visible, never whether the deleted content survives.
  async function deleteHistory(a, b, ids) {
    const left = normalizeLogin(a);
    const right = normalizeLogin(b);
    if (!validLogin(left) || !validLogin(right) || !Array.isArray(ids)) return [];
    const wanted = [...new Set(ids.filter(id => typeof id === 'string' && id !== ''))];
    const accepted = deletableIds(left, right, wanted);
    if (accepted.length === 0) return [];
    const deletedAt = now();
    const seq = nextSeq();
    const events = twoSidedEvents(left, right, { kind: 'delete', ids: accepted, scope: 'all' }, seq, null);
    await wal.append({
      v: 1, kind: 'delete', tombstone: true, seq, a: left, b: right, ids: accepted, deletedAt, events,
    });
    applyTombstoneMutation(left, right, accepted, deletedAt);
    for (const { login, event } of events) appendEvent(login, event);
    appliedJournalSeq = Math.max(appliedJournalSeq, seq);
    schedule();
    return accepted;
  }

  function reactionEvents(reader, peer) {
    const hidden = state.hidden[normalizeLogin(reader)]?.[conversationKey(reader, peer)] || [];
    const cut = purgeSeq(reader, peer);
    return (state.history[conversationKey(reader, peer)] || []).flatMap(record =>
      hidden.includes(record.id) || beforePurge(record, cut) ? [] : (record.reactionEvents || [])
        .filter(event => event.by !== normalizeLogin(reader) && !event.read)
        .map(event => ({ ...event, messageId: record.id })));
  }

  function readReactionEvents(reader, peer, ids) {
    if (!Array.isArray(ids)) return;
    const wanted = new Set(ids.slice(0, 100));
    for (const record of state.history[conversationKey(reader, peer)] || []) {
      for (const event of record.reactionEvents || []) {
        if (event.by !== normalizeLogin(reader) && wanted.has(event.id)) event.read = true;
      }
    }
    schedule();
  }

  // Shared by the live path and journal replay. Looks the record up fresh by
  // id rather than trusting a reference a caller captured before an `await`
  // boundary: a concurrent delete could have filtered it out of the array
  // (though not out of memory) while this edit's WAL entry was still being
  // fsynced. Setting the same text/editedAt twice is a harmless no-op, which
  // is what makes replaying an already-snapshotted edit safe.
  function applyEditMutation(left, right, id, text, editedAt) {
    const record = state.history[conversationKey(left, right)]?.find((item) => item.id === id);
    if (!record || record.e2ee) return null;
    record.text = text;
    editedAt = Number.isFinite(editedAt) ? editedAt : now();
    record.editedAt = editedAt;
    return record;
  }

  // WAL-durable: the seq and event pair are computed and fsynced before the
  // record is touched, so a kill between "the peer was told" and the next
  // debounced snapshot cannot revert the edit on restart.
  async function editHistory(a, b, id, author, text) {
    const left = normalizeLogin(a);
    const right = normalizeLogin(b);
    const record = state.history[conversationKey(left, right)]?.find((item) => item.id === id);
    if (!record || record.deletedAt || record.e2ee || record.from !== normalizeLogin(author) || typeof text !== 'string' || text === '') return null;

    const messageId = record.id;
    const from = record.from;
    const editedAt = now();
    const seq = nextSeq();
    const events = twoSidedEvents(left, right, { kind: 'edit', id: messageId, text, ts: editedAt }, seq, from);
    await wal.append({
      v: 1, kind: 'edit', seq, a: left, b: right, id: messageId, text, editedAt, events,
    });

    const applied = applyEditMutation(left, right, messageId, text, editedAt);
    appliedJournalSeq = Math.max(appliedJournalSeq, seq);
    if (!applied) return null;
    for (const { login, event } of events) appendEvent(login, event);
    schedule();
    return publicRecord(applied);
  }

  // Shared by the live path and journal replay; see `applyEditMutation` for
  // why the record is re-fetched fresh rather than trusted from a pre-`await`
  // reference. `present` is always recomputed against the *current* reaction
  // set, which is what makes re-running an "add" the store already applied
  // (or the target message already gone) an idempotent no-op instead of a
  // duplicate membership entry or a duplicate notification.
  function applyReactMutation(left, right, id, actor, emoji, add) {
    const record = state.history[conversationKey(left, right)]?.find((item) => item.id === id);
    if (!record) return null;
    const reactions = record.reactions ?? (record.reactions = Object.create(null));
    const members = reactions[emoji] ?? (reactions[emoji] = []);
    const present = members.includes(actor);
    if (add && !present) {
      members.push(actor);
      const events = record.reactionEvents ?? (record.reactionEvents = []);
      events.push({ id: crypto.randomUUID(), by: actor, emoji, ts: now(), read: left === right });
      if (events.length > 100) events.splice(0, events.length - 100);
    }
    if (!add && present) {
      reactions[emoji] = members.filter((login) => login !== actor);
      for (const event of record.reactionEvents || []) if (event.by === actor && event.emoji === emoji) event.read = true;
    }
    if (reactions[emoji]?.length === 0) delete reactions[emoji];
    if (Object.keys(reactions).length === 0) delete record.reactions;
    return record;
  }

  // WAL-durable, same shape as `editHistory`.
  async function reactHistory(a, b, id, author, emoji, add) {
    const left = normalizeLogin(a);
    const right = normalizeLogin(b);
    const actor = normalizeLogin(author);
    const record = state.history[conversationKey(left, right)]?.find((item) => item.id === id);
    if (!record || record.deletedAt || !validLogin(actor) || typeof emoji !== 'string' || emoji.length === 0 || emoji.length > 16) return null;

    const messageId = record.id;
    const seq = nextSeq();
    const events = twoSidedEvents(left, right, { kind: 'react', id: messageId, emoji, by: actor, add }, seq, actor);
    await wal.append({
      v: 1, kind: 'react', seq, a: left, b: right, id: messageId, emoji, by: actor, add, events,
    });

    const applied = applyReactMutation(left, right, messageId, actor, emoji, add);
    appliedJournalSeq = Math.max(appliedJournalSeq, seq);
    if (!applied) return null;
    for (const { login, event } of events) appendEvent(login, event);
    schedule();
    return publicRecord(applied);
  }

  // «Удалить у себя»: the record stays exactly as the other party knows it,
  // and only this reader stops being shown it. Shared by the live path and
  // journal replay; merging into `merged` is set-like (an id already in the
  // list is skipped), so re-running an already-snapshotted hide changes
  // nothing.
  function applyHideMutation(owner, other, ids) {
    const key = conversationKey(owner, other);
    const byConversation = state.hidden[owner] ?? (state.hidden[owner] = Object.create(null));
    const merged = [...(byConversation[key] ?? [])];
    for (const id of ids) {
      if (typeof id !== 'string' || id === '' || merged.includes(id)) continue;
      merged.push(id);
    }
    // Newest wins: the cap exists so a client that hides thousands of records
    // cannot grow the file without bound, and bounds the per-reader hidden list.
    byConversation[key] = merged.slice(-HIDDEN_LIMIT);
    // A record hidden for this reader may still be sitting in that same
    // reader's own offline queue — a message to Saved Messages is enqueued
    // for the very session that sent it, and every queued copy is replayed
    // on the next connect. Without this the row deleted «у себя» came back
    // on the next reload, which is exactly what «saved messages не
    // удаляются» looked like. Only this owner's queue: the peer's copy is
    // untouched by a hide, that is what makes it a hide.
    const queue = state.queue[owner];
    if (queue) {
      const kept = queue.filter((item) => !ids.includes(item.d?.id));
      if (kept.length !== queue.length) {
        if (kept.length > 0) state.queue[owner] = kept;
        else delete state.queue[owner];
      }
    }
    return byConversation[key].length;
  }

  // WAL-durable: the "у себя" hide is journaled and fsynced before the hidden
  // list is touched, so a kill before the next debounced snapshot cannot
  // bring the record back on restart. Only the owner hears about it: a hide
  // the peer were told of would not be a hide.
  async function hideHistory(login, peer, ids) {
    const owner = normalizeLogin(login);
    const other = normalizeLogin(peer);
    if (!validLogin(owner) || !validLogin(other) || !Array.isArray(ids)) return 0;

    const seq = nextSeq();
    const events = [{ login: owner, event: { kind: 'delete', peer: other, ids, seq, scope: 'self' } }];
    await wal.append({
      v: 1, kind: 'hide', seq, owner, other, ids, events,
    });

    const total = applyHideMutation(owner, other, ids);
    for (const { login: eventLogin, event } of events) appendEvent(eventLogin, event);
    appliedJournalSeq = Math.max(appliedJournalSeq, seq);
    schedule();
    return total;
  }

  // «Удалить контакт вместе с перепиской», applied. Shared by the live path
  // and journal replay, and idempotent by construction: the login list is a
  // set, and the watermark only ever moves forward.
  function applyRemoveMutation(owner, other, seq) {
    const mine = state.removed[owner] ?? (state.removed[owner] = []);
    if (!mine.includes(other)) mine.push(other);

    const key = conversationKey(owner, other);
    const byConversation = state.purges[owner] ?? (state.purges[owner] = Object.create(null));
    if (seq > (byConversation[key] ?? 0)) byConversation[key] = seq;

    // Frames from that contact still waiting in this owner's offline queue are
    // part of what was deleted: replayed, they would put the conversation back
    // on the unread badge with nothing behind it to open. Only this owner's
    // queue — the peer's copy is untouched, which is what makes the deletion
    // one-sided (the same reasoning as `applyHideMutation`'s queue sweep).
    const queue = state.queue[owner];
    if (queue) {
      const kept = queue.filter((item) => item.from !== other);
      if (kept.length !== queue.length) {
        if (kept.length > 0) state.queue[owner] = kept;
        else delete state.queue[owner];
      }
    }
  }

  // Deleting a contact is per-owner and durable: this account stops seeing the
  // contact and its whole side of the conversation, while the other side keeps
  // both — nothing here touches `friends`, the peer's roster or the shared log
  // (see `removed`/`purges` in `emptyState`). WAL-first, the same way every
  // other mutation is: a kill between the fsync and the snapshot cannot bring
  // the thread back on restart, because the watermark is replayed from the
  // journal. Re-adding the contact later clears the removal, never the
  // watermark — a deleted conversation does not come back.
  async function removeContact(login, peer) {
    const owner = normalizeLogin(login);
    const other = normalizeLogin(peer);
    if (!validLogin(owner) || !validLogin(other) || !accountOf(other)) {
      return { ok: false, code: 'unknown_user' };
    }
    if (owner === other) return { ok: false, code: 'self_remove' };
    if (!areFriends(owner, other)) return { ok: false, code: 'not_friends' };
    // Already deleted: the same answer as the first call, so a client retrying
    // after a lost response is not handed an error it has to special-case.
    if (isRemoved(owner, other)) return { ok: true, removed: true };

    const seq = nextSeq();
    await wal.append({ v: 1, kind: 'remove', seq, owner, other });
    applyRemoveMutation(owner, other, seq);
    appliedJournalSeq = Math.max(appliedJournalSeq, seq);
    schedule();
    return { ok: true, removed: true };
  }

  // Queued copies of messages the reader has just read, dropped. The offline
  // queue is what every unread badge is computed from (`unreadCounts`), so a
  // per-message receipt that only moved the watermark left the badge standing
  // until some *other* client of the same account happened to drain the queue
  // — which is exactly what made a thread read in the web stay unread there
  // until it was opened in the Android app. Only `msg`/`ai` frames go: the
  // edit/react/delete frames queued alongside them are state the client still
  // has to be handed, and every dropped message is already in history.
  function dropQueuedMessagesUpTo(owner, other, upTo) {
    const queue = state.queue[owner];
    if (!queue || queue.length === 0 || !Number.isFinite(upTo) || upTo <= 0) return 0;
    const kept = queue.filter((item) => {
      if (item.from !== other || !['msg', 'ai'].includes(item.d?.t)) return true;
      const ts = Number.isFinite(item.d?.ts) ? item.d.ts : item.at;
      return !(Number.isFinite(ts) && ts <= upTo);
    });
    const dropped = queue.length - kept.length;
    if (dropped === 0) return 0;
    if (kept.length > 0) state.queue[owner] = kept;
    else delete state.queue[owner];
    return dropped;
  }

  function clearMarkedUnread(owner, other) {
    const peers = state.markedUnread[owner];
    if (!peers) return false;
    const index = peers.indexOf(other);
    if (index === -1) return false;
    peers.splice(index, 1);
    if (peers.length === 0) delete state.markedUnread[owner];
    return true;
  }

  function markConversationUnread(reader, peer) {
    const owner = normalizeLogin(reader);
    const other = normalizeLogin(peer);
    if (!validLogin(owner) || !validLogin(other) || owner === other) return false;
    if (!accountOf(owner) || !accountOf(other) || !areFriends(owner, other)) return false;
    const peers = state.markedUnread[owner] ?? (state.markedUnread[owner] = []);
    if (!peers.includes(other)) {
      peers.push(other);
      schedule();
    }
    return true;
  }

  function isMarkedUnread(reader, peer) {
    const owner = normalizeLogin(reader);
    const other = normalizeLogin(peer);
    return Boolean(state.markedUnread[owner]?.includes(other));
  }

  // Receipt acceptance has the same WAL-first boundary as a message. A
  // checkpoint delay or a killed process must not resurrect confirmed unread.
  function applyReceipt(owner, other, receipt) {
    const key = conversationKey(owner, other);
    const delivered = state.deliveries[owner] ?? (state.deliveries[owner] = Object.create(null));
    delivered[key] = Math.max(delivered[key] ?? 0, receipt.ts);
    if (!receipt.read) return;
    clearMarkedUnread(owner, other);
    const reads = state.reads[owner] ?? (state.reads[owner] = Object.create(null));
    if (receipt.ts > (reads[key] ?? 0)) {
      reads[key] = receipt.ts;
      const ats = state.readAts[owner] ?? (state.readAts[owner] = Object.create(null));
      ats[key] = receipt.at;
      const vias = state.readVias[owner] ?? (state.readVias[owner] = Object.create(null));
      const via = normalizeClientKind(receipt.via);
      if (via) vias[key] = via;
      else delete vias[key];
    }
    dropQueuedMessagesUpTo(owner, other, reads[key] ?? 0);
    if (receipt.bulk) {
      for (const record of state.history[key] ?? []) {
        if (record.ts > receipt.ts) continue;
        for (const event of record.reactionEvents ?? []) {
          if (event.by !== owner) event.read = true;
        }
      }
    }
  }

  async function commitReceipt(owner, other, receipt) {
    const seq = nextSeq();
    const events = receipt.read && receipt.ts > 0
      ? twoSidedEvents(owner, other, {
        kind: 'read', readTs: receipt.ts, readAt: receipt.at,
        id: receipt.id, via: receipt.via,
      }, seq, owner)
      : [];
    const entry = { v: 1, kind: 'receipt', seq, owner, other, ...receipt, events };
    await wal.append(entry);
    applyReceipt(owner, other, entry);
    for (const { login, event } of events) appendEvent(login, event);
    appliedJournalSeq = Math.max(appliedJournalSeq, seq);
    schedule();
    return receipt.read ? readTs(owner, other) : deliveredTs(owner, other);
  }

  async function markRead(reader, peer, id, via = '') {
    const owner = normalizeLogin(reader);
    const other = normalizeLogin(peer);
    if (!validLogin(owner) || !validLogin(other) || typeof id !== 'string' || id === '') return 0;
    const record = state.history[conversationKey(owner, other)]?.find((item) => item.id === id);
    if (!record || !Number.isFinite(record.ts)) return 0;
    const mark = readTs(owner, other);
    // Repeated receipts retain the original attribution, but still durably
    // clear manually marked unread and any replayed queued copies.
    return commitReceipt(owner, other, {
      read: true, ts: Math.max(mark, record.ts), id,
      at: record.ts > mark ? now() : readAt(owner, other),
      via: record.ts > mark ? normalizeClientKind(via) : readVia(owner, other),
    });
  }

  async function markDelivered(reader, peer, id) {
    const owner = normalizeLogin(reader);
    const other = normalizeLogin(peer);
    if (!validLogin(owner) || !validLogin(other) || typeof id !== 'string' || id === '') return 0;
    const record = state.history[conversationKey(owner, other)]?.find((item) => item.id === id);
    if (!record || !Number.isFinite(record.ts) || deliveredTs(owner, other) >= record.ts) return 0;
    return commitReceipt(owner, other, { read: false, ts: record.ts });
  }

  async function markConversationRead(reader, peer, via = '') {
    const owner = normalizeLogin(reader);
    const other = normalizeLogin(peer);
    if (!validLogin(owner) || !validLogin(other)) return 0;
    const previous = readTs(owner, other);
    let newest = previous;
    for (const record of state.history[conversationKey(owner, other)] ?? []) {
      if (Number.isFinite(record.ts)) newest = Math.max(newest, record.ts);
    }
    return commitReceipt(owner, other, {
      read: true, bulk: true, ts: newest,
      at: newest > previous ? now() : readAt(owner, other),
      via: newest > previous ? normalizeClientKind(via) : readVia(owner, other),
    });
  }

  // How far `reader` has read this conversation, as a timestamp. 0 means
  // «nothing known», which the caller must read as "not read", never as
  // "read at the epoch".
  function readTs(reader, peer) {
    const owner = normalizeLogin(reader);
    const other = normalizeLogin(peer);
    if (!validLogin(owner) || !validLogin(other)) return 0;
    return state.reads[owner]?.[conversationKey(owner, other)] ?? 0;
  }

  // How far the peer's *device* is known to hold this conversation: the higher
  // of the delivery watermark and the read one, because reading implies
  // delivery. Folding them here is what heals a snapshot written before
  // `deliveries` existed — a message the peer has plainly read must never be
  // reported as "not delivered" just because no ack was ever stored for it.
  function deliveredTs(reader, peer) {
    const owner = normalizeLogin(reader);
    const other = normalizeLogin(peer);
    if (!validLogin(owner) || !validLogin(other)) return 0;
    const key = conversationKey(owner, other);
    const delivered = state.deliveries[owner]?.[key] ?? 0;
    const read = state.reads[owner]?.[key] ?? 0;
    return delivered > read ? delivered : read;
  }

  // When the current watermark was first reached. This is intentionally
  // absent for snapshots written before read-time tracking existed.
  function readAt(reader, peer) {
    const owner = normalizeLogin(reader);
    const other = normalizeLogin(peer);
    if (!validLogin(owner) || !validLogin(other)) return 0;
    return state.readAts[owner]?.[conversationKey(owner, other)] ?? 0;
  }

  // Which client reached it: `web`, `cli`, `android/<build>`, or '' when the
  // snapshot predates this (or the reader never advanced the watermark), which
  // the caller must render as "not known", never as one of the three.
  function readVia(reader, peer) {
    const owner = normalizeLogin(reader);
    const other = normalizeLogin(peer);
    if (!validLogin(owner) || !validLogin(other)) return '';
    return state.readVias[owner]?.[conversationKey(owner, other)] ?? '';
  }

  function history(a, b, limit, { includeDeleted = false, before = null, beforeId = null, since = null } = {}) {
    const log = state.history[conversationKey(a, b)];
    if (!log || log.length === 0) return [];
    // Saved Messages holds more than the ceiling a normal conversation is
    // trimmed to, so a caller that names no limit is given all of it rather
    // than the newest page of an archive it asked for whole.
    const selfChat = normalizeLogin(a) === normalizeLogin(b);
    const size = Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : (selfChat ? log.length : HISTORY_DEFAULT_LIMIT);
    const hidden = state.hidden[normalizeLogin(a)]?.[conversationKey(a, b)];
    const cut = purgeSeq(a, b);
    const beforeTs = Number.isFinite(before) ? before : null;
    const sinceTs = Number.isFinite(since) ? since : null;
    const visible = log.filter(item => {
      if (beforePurge(item, cut)) return false;
      if (hidden?.includes(item.id)) return false;
      if (!includeDeleted && item.deletedAt) return false;
      if (sinceTs !== null && item.ts < sinceTs) return false;
      if (!beforeId && beforeTs !== null && item.ts >= beforeTs) return false;
      return true;
    });
    // Two clients can record out of order — a queued frame is written when it
    // was sent — so the reader sorts rather than trusting insertion order.
    let sorted = [...visible].sort((one, other) => one.ts - other.ts);
    if (beforeId && typeof beforeId === 'string') {
      const idx = sorted.findIndex(item => item.id === beforeId);
      if (idx >= 0) sorted = sorted.slice(0, idx);
      else if (beforeTs !== null) sorted = sorted.filter(item => item.ts < beforeTs);
    }
    return sorted
      .slice(-size)
      .map((item) => {
        const copy = { ...item };
        if (item.reactions) copy.reactions = reactionsFor(item);
        if (item.reactionEvents) copy.reactionEvents = item.reactionEvents.map(event => ({ ...event }));
        return copy;
      });
  }

  // The newest message of a conversation, as that account sees it — the roster
  // shows this under each name. Deliberately not `history(a, b, 1)`: that sorts
  // and copies the whole log, and the roster asks this for every friend every
  // time anyone's presence moves. Scanning backwards touches one record in the
  // ordinary case.
  function lastMessage(a, b) {
    const log = state.history[conversationKey(a, b)];
    if (!log || log.length === 0) return null;
    const hidden = state.hidden[normalizeLogin(a)]?.[conversationKey(a, b)];
    const cut = purgeSeq(a, b);
    let best = null;
    for (let i = log.length - 1; i >= 0; i -= 1) {
      const item = log[i];
      if (beforePurge(item, cut)) continue;
      if (hidden?.length && hidden.includes(item.id)) continue;
      if (item.deletedAt) continue;
      if (item.sealedEdit) continue;
      // Records can land out of order — a queued frame is written when it is
      // drained, not when it was sent — so the last entry is not always the
      // latest one. Only the tail is worth checking for that.
      if (!best || item.ts > best.ts) best = item;
      if (best && best.ts - item.ts > OUT_OF_ORDER_WINDOW_MS) break;
    }
    if (!best) return null;
    const preview = {
      id: best.id,
      from: best.from,
      ts: best.ts,
      kind: best.kind === 'ai' ? 'ai' : 'human',
      // A roster line cannot open an envelope; it says that there is one.
      text: best.e2ee ? E2EE_STUB_TEXT : (typeof best.text === 'string' ? best.text : ''),
      // Named rather than embedded: a roster line needs to say «a photo», not
      // carry one. The data URL would be megabytes per friend.
      media: best.image ? 'image' : (best.voice ? 'voice' : null),
    };
    // Only when there is one: an explicit `undefined` would ride the wire as a
    // key that the client then has to distinguish from a real absence.
    if (typeof best.author === 'string' && best.author !== '') preview.author = best.author;
    if (best.e2ee) preview.encrypted = true;
    return preview;
  }

  // Which release every account has already been told about. Persisted so that
  // a restart is not by itself an announcement.
  function announcedVersion() {
    return state.announcedVersion;
  }

  // See `emptyState`'s `bots`: called from the hub on the sender's own
  // `hello`, never on the receiving side, and once per account — a roster pass
  // is owed only when the answer actually changed.
  function markBot(login) {
    const target = normalizeLogin(login);
    if (!validLogin(target) || !state.accounts[target]) return false;
    if (state.bots[target] === true) return false;
    state.bots[target] = true;
    schedule();
    return true;
  }

  function isBot(login) {
    const target = normalizeLogin(login);
    return validLogin(target) && state.bots[target] === true;
  }

  function setAnnouncedVersion(version) {
    const value = typeof version === 'string' && version !== '' ? version : null;
    if (state.announcedVersion === value) return state.announcedVersion;
    state.announcedVersion = value;
    schedule();
    return state.announcedVersion;
  }

  function scheduleReplyReminder(ownerLogin, peerLogin, messageId, dueAt) {
    const owner = normalizeLogin(ownerLogin);
    const peer = normalizeLogin(peerLogin);
    const at = now();
    if (!validLogin(owner) || !validLogin(peer) || owner === peer) return null;
    if (!accountOf(owner) || !accountOf(peer) || !areFriends(owner, peer)) return null;
    if (typeof messageId !== 'string' || messageId === '' || messageId.length > 256) return null;
    if (!Number.isFinite(dueAt) || dueAt <= at || dueAt > at + 365 * 24 * 60 * 60 * 1000) return null;
    if (!findHistoryMessage(owner, peer, messageId)) return null;
    const reminders = state.replyReminders[owner] ?? (state.replyReminders[owner] = []);
    const previous = reminders.findIndex((item) => item.peer === peer && item.messageId === messageId);
    const reminder = {
      id: crypto.randomUUID(),
      peer,
      messageId,
      dueAt: Math.round(dueAt),
      createdAt: at,
    };
    if (previous === -1) reminders.push(reminder);
    else reminders[previous] = reminder;
    schedule();
    return { ...reminder };
  }

  function dueReplyReminders(at = now()) {
    const due = [];
    for (const [owner, reminders] of Object.entries(state.replyReminders)) {
      for (const reminder of reminders) {
        if (Number.isFinite(reminder.firedAt) || reminder.dueAt > at) continue;
        reminder.firedAt = at;
        due.push({ owner, ...reminder });
      }
    }
    if (due.length > 0) schedule();
    return due;
  }

  function firedReplyReminders(ownerLogin) {
    const owner = normalizeLogin(ownerLogin);
    return (state.replyReminders[owner] ?? [])
      .filter((item) => Number.isFinite(item.firedAt))
      .map((item) => ({ ...item }));
  }

  // The other half of `firedReplyReminders`: what the owner has set and what
  // has not come due yet. A client redraws the mark on those messages from
  // this, so the mark is state of the message rather than of the connection
  // that happened to set it.
  function pendingReplyReminders(ownerLogin) {
    const owner = normalizeLogin(ownerLogin);
    return (state.replyReminders[owner] ?? [])
      .filter((item) => !Number.isFinite(item.firedAt))
      .map((item) => ({ ...item }));
  }

  function nextReplyReminderAt() {
    let next = null;
    for (const reminders of Object.values(state.replyReminders)) {
      for (const reminder of reminders) {
        if (Number.isFinite(reminder.firedAt)) continue;
        if (next === null || reminder.dueAt < next) next = reminder.dueAt;
      }
    }
    return next;
  }

  function ackReplyReminder(ownerLogin, reminderId) {
    const owner = normalizeLogin(ownerLogin);
    if (typeof reminderId !== 'string' || reminderId === '') return false;
    const reminders = state.replyReminders[owner];
    if (!reminders) return false;
    const index = reminders.findIndex((item) => item.id === reminderId && Number.isFinite(item.firedAt));
    if (index === -1) return false;
    reminders.splice(index, 1);
    if (reminders.length === 0) delete state.replyReminders[owner];
    schedule();
    return true;
  }

  // End-to-end encryption: the device registry, one-time key claims and the
  // per-device to-device inbox (docs/specs/2026-11-04-e2ee.md §4–5). Every
  // mutation is a journal line, because each one is acknowledged: a device told
  // its keys are published, a claimer handed a one-time key, a sender told its
  // key message is held — none of them may be undone by a crash. Mutations run
  // one at a time, so what was validated is what gets written.
  let e2eeChain = Promise.resolve();
  function e2eeSerial(task) {
    const run = e2eeChain.then(task, task);
    e2eeChain = run.catch(() => {});
    return run;
  }

  // Claims per (claimer, target) in the last minute. In memory: a restart that
  // forgets the window lets through at most one more minute's worth.
  const e2eeClaimLog = new Map();

  function e2eeEnsure(login) {
    return state.e2ee[login] ?? (state.e2ee[login] = {
      cross: {},
      crossSeq: 0,
      devices: Object.create(null),
      removed: Object.create(null),
      backup: { version: 0, seq: 0, crossSigning: null, passphrase: null, sessions: Object.create(null) },
      trust: Object.create(null),
      trustSeq: 0,
    });
  }

  function e2eeDevice(login, deviceId) {
    return validDeviceId(deviceId) ? state.e2ee[login]?.devices[deviceId] ?? null : null;
  }

  async function e2eeCommit(entry) {
    await wal.append(entry);
    applyE2eeEntry(entry);
    appliedJournalSeq = Math.max(appliedJournalSeq, entry.seq);
    schedule();
  }

  // One journal line, live or replayed. Idempotent by watermark: a line the
  // snapshot already contains changes nothing — above all, a replayed upload
  // never brings back a one-time key a later claim took, and a replayed send
  // never brings back a message its device acknowledged.
  function applyE2eeEntry(entry) {
    const seq = Math.floor(finiteOr(entry.seq, 0));
    if (entry.kind === 'e2ee-claim') {
      let applied = false;
      for (const item of Array.isArray(entry.taken) ? entry.taken : []) {
        const device = e2eeDevice(normalizeLogin(item?.login), item?.deviceId);
        if (device && typeof item.keyId === 'string' && device.otks[item.keyId]) {
          delete device.otks[item.keyId];
          applied = true;
        }
      }
      return applied;
    }
    if (entry.kind === 'e2ee-trust') {
      const login = normalizeLogin(entry.login);
      if (!validLogin(login) || !state.accounts[login]) return false;
      const account = e2eeEnsure(login);
      if (seq <= account.trustSeq) return false;
      let applied = false;
      for (const [peer, statement] of Object.entries(entry.trust ?? {})) {
        const adopted = validLogin(peer) ? normalizeTrustStatement(statement, { login, peer }) : null;
        if (!adopted) continue;
        if (!account.trust[peer] && Object.keys(account.trust).length >= E2EE_TRUST_LIMIT) continue;
        account.trust[peer] = adopted;
        applied = true;
      }
      if (applied) account.trustSeq = seq;
      return applied;
    }
    const login = normalizeLogin(entry.login);
    if (!validLogin(login) || !state.accounts[login] || !validDeviceId(entry.deviceId)) return false;
    const deviceId = entry.deviceId;

    if (entry.kind === 'e2ee-upload') {
      const account = e2eeEnsure(login);
      let applied = false;
      let device = account.devices[deviceId] ?? null;
      const fresh = !device || seq > device.keysSeq;
      if (entry.device && fresh && !(finiteOr(account.removed[deviceId], -1) >= seq)) {
        const keys = normalizeDeviceKeys(entry.device.deviceKeys, { login, deviceId });
        if (keys && (!device || sameDeviceIdentity(device.deviceKeys, keys))) {
          if (!device) {
            device = {
              deviceKeys: keys, name: '', caps: [], createdAt: finiteOr(entry.device.createdAt, now()), keysSeq: 0,
              otks: Object.create(null), fallback: null, inbox: [], ackedThrough: 0,
            };
            account.devices[deviceId] = device;
          }
          device.deviceKeys = keys;
          device.name = normalizeDeviceName(entry.device.name);
          device.caps = normalizeDeviceCaps(entry.device.caps);
          applied = true;
        }
      }
      if (device && fresh) {
        const otks = entry.otks ? normalizeOneTimeKeys(entry.otks) : null;
        for (const [keyId, key] of Object.entries(otks ?? {})) device.otks[keyId] = key;
        const fallback = entry.fallback ? normalizeFallbackKey({ [entry.fallback.keyId]: entry.fallback.key }) : null;
        if (fallback) device.fallback = fallback;
        device.keysSeq = seq;
        applied = true;
      }
      const cross = entry.cross ? normalizeCrossSigning(entry.cross) : null;
      if (cross && seq > account.crossSeq) {
        // Fills slots. A replacement carries every slot there is (`e2eeUpload`
        // refuses half a set), so filling them is replacing them.
        account.cross = { ...account.cross, ...cross };
        account.crossSeq = seq;
        applied = true;
      }
      const token = TOKEN_KEY_PATTERN.test(entry.tokenKey ?? '') ? state.tokens[entry.tokenKey] : null;
      if (token && token.login === login && !token.deviceId && device) token.deviceId = deviceId;
      return applied;
    }

    if (entry.kind === 'e2ee-backup') {
      const account = e2eeEnsure(login);
      const backup = account.backup;
      const version = Number.isInteger(entry.version) && entry.version >= 1 ? entry.version : 0;
      if (version === 0 || seq <= backup.seq || version < backup.version) return false;
      if (entry.replace === true || version > backup.version) {
        const crossSigning = normalizeBackupEntry(entry.crossSigning);
        if (!crossSigning) return false;
        const passphrase = entry.passphrase ? normalizePassphraseSlot(entry.passphrase) : null;
        const sessions = normalizeBackupSessions(entry.sessions ?? {}, E2EE_BACKUP_SESSION_LIMIT) ?? Object.create(null);
        account.backup = { version, seq, crossSigning, passphrase, sessions };
        return true;
      }
      let applied = false;
      if (entry.crossSigning) {
        const crossSigning = normalizeBackupEntry(entry.crossSigning);
        if (crossSigning) {
          backup.crossSigning = crossSigning;
          applied = true;
        }
      }
      if (entry.passphrase !== undefined) {
        if (entry.passphrase === null) {
          backup.passphrase = null;
          applied = true;
        } else {
          const slot = normalizePassphraseSlot(entry.passphrase);
          if (slot) {
            backup.passphrase = slot;
            applied = true;
          }
        }
      }
      const sessions = entry.sessions ? normalizeBackupSessions(entry.sessions, E2EE_BACKUP_SESSION_LIMIT) : null;
      for (const [sid, item] of Object.entries(sessions ?? {})) {
        const current = backup.sessions[sid];
        if (!current && Object.keys(backup.sessions).length >= E2EE_BACKUP_SESSION_LIMIT) continue;
        if (!current || item.firstKnownIndex < current.firstKnownIndex) {
          backup.sessions[sid] = item;
          applied = true;
        }
      }
      if (applied) backup.seq = seq;
      return applied;
    }

    const device = e2eeDevice(login, deviceId);
    if (entry.kind === 'e2ee-remove') {
      const account = state.e2ee[login];
      if (!account) return false;
      account.removed[deviceId] = Math.max(finiteOr(account.removed[deviceId], 0), seq);
      const kept = Object.entries(account.removed).sort((a, b) => b[1] - a[1]).slice(0, E2EE_REMOVED_KEEP);
      account.removed = Object.assign(Object.create(null), Object.fromEntries(kept));
      if (!device) return false;
      delete account.devices[deviceId];
      return true;
    }
    if (!device) return false;
    if (entry.kind === 'e2ee-send') {
      const item = entry.item;
      const from = normalizeLogin(item?.from);
      const body = normalizeToDeviceBody(item?.body);
      if (seq <= device.ackedThrough || device.inbox.some((held) => held.seq === seq)) return false;
      if (!validLogin(from) || !validDeviceId(item.fromDevice) || !body) return false;
      device.inbox.push({ seq, from, fromDevice: item.fromDevice, body, at: finiteOr(item.at, 0) });
      return true;
    }
    if (entry.kind === 'e2ee-ack') {
      const through = Math.floor(finiteOr(entry.through, 0));
      if (through <= device.ackedThrough) return false;
      device.inbox = device.inbox.filter((item) => item.seq > through);
      device.ackedThrough = through;
      return true;
    }
    return false;
  }

  // The digest a connection keeps instead of the token itself: enough to find
  // the session's device later, worthless as a credential.
  function e2eeTokenKey(token) {
    const key = tokenKey(token);
    return state.tokens[key] ? key : null;
  }

  // The registered device of a session, or null — also when the session has
  // an id but has not uploaded keys under it yet.
  function e2eeDeviceForTokenKey(key) {
    const entry = typeof key === 'string' ? state.tokens[key] : null;
    return entry && e2eeDevice(entry.login, entry.deviceId) ? entry.deviceId : null;
  }

  // The account's primary password, checked the way sign-in checks it. Used by
  // the one E2EE change that can lock everybody's view of an account onto new
  // keys: replacing its cross-signing (spec E2EE §8.7, "сброс ключей").
  async function primaryPasswordMatches(login, password) {
    const account = accountOf(login);
    if (!account || typeof password !== 'string') return false;
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return false;
    const pwd = password.length >= 8 ? password : password.padEnd(8, '0');
    return sameHash(await hashPassword(pwd, account.salt), account.hash);
  }

  /**
   * Publish this session's device keys, one-time keys, fallback key and the
   * account's cross-signing keys — any subset. The first call of a session
   * gives it a device id; the keys must then name it (`normalizeDeviceKeys`),
   * so a second call carries them. Identity keys never change under an id.
   */
  function e2eeUpload(token, body = {}) {
    // Replacing published account keys needs the password, proven before the
    // serial queue so a slow hash never holds up anybody's key traffic. Only a
    // *replacement*: the first keys of an account, or a body without the flag,
    // need nothing more than the token, as before.
    const replacing = body?.replaceCrossSigning === true && body.crossSigning !== undefined;
    const proof = replacing
      ? (async () => {
        const session = state.tokens[tokenKey(token)];
        // No published keys yet: nothing to replace, no proof asked. `null`,
        // not `true` — should keys land before this body reaches the queue,
        // it is a replacement after all and is refused (no password checked).
        if (!session || !state.e2ee[session.login]?.cross?.master) return null;
        return primaryPasswordMatches(session.login, body.password);
      })()
      : Promise.resolve(null);
    return proof.then((proven) => e2eeSerial(async () => {
      const key = tokenKey(token);
      const session = state.tokens[key];
      if (!session) return { ok: false, code: 'unknown_token' };
      const { login } = session;
      if (!validDeviceId(session.deviceId)) {
        session.deviceId = newDeviceId();
        schedule();
      }
      const { deviceId } = session;
      const account = state.e2ee[login] ?? null;
      const existing = account?.devices[deviceId] ?? null;
      const fail = (code) => ({ ok: false, code, deviceId });

      let device = null;
      if (body.deviceKeys !== undefined) {
        const keys = normalizeDeviceKeys(body.deviceKeys, { login, deviceId });
        if (!keys) return fail('invalid_device_keys');
        if (existing && !sameDeviceIdentity(existing.deviceKeys, keys)) return fail('device_keys_changed');
        if (!existing && Object.keys(account?.devices ?? {}).length >= E2EE_DEVICE_LIMIT) return fail('device_limit');
        device = {
          deviceKeys: keys,
          name: normalizeDeviceName(body.name),
          caps: normalizeDeviceCaps(body.caps),
          createdAt: existing?.createdAt ?? now(),
        };
      }
      let otks = null;
      if (body.oneTimeKeys !== undefined) {
        otks = normalizeOneTimeKeys(body.oneTimeKeys);
        if (!otks) return fail('invalid_one_time_keys');
      }
      let fallback = null;
      if (body.fallbackKey !== undefined) {
        fallback = normalizeFallbackKey(body.fallbackKey);
        if (!fallback) return fail('invalid_fallback_key');
      }
      let cross = null;
      let replaceCross = false;
      if (body.crossSigning !== undefined) {
        cross = normalizeCrossSigning(body.crossSigning);
        if (!cross) return fail('invalid_cross_signing');
        if (account?.cross?.master && body.replaceCrossSigning !== true) {
          cross = null;
        } else if (account?.cross?.master) {
          // A replacement: the password, and a whole new set — a master key
          // without its self-signing key (or the reverse) would publish half
          // of the old identity next to half of the new one.
          if (proven !== true) return fail('bad_credentials');
          if (!cross.master || !cross.selfSigning) return fail('invalid_cross_signing');
          replaceCross = true;
        }
      }
      if ((otks || fallback || cross) && !existing && !device) return fail('device_required');
      if (otks) {
        const stored = existing?.otks ?? {};
        let count = Object.keys(stored).length;
        for (const [keyId, value] of Object.entries(otks)) {
          if (stored[keyId]) {
            if (JSON.stringify(stored[keyId]) !== JSON.stringify(value)) return fail('one_time_key_conflict');
            delete otks[keyId];
            continue;
          }
          count += 1;
        }
        if (count > E2EE_OTK_LIMIT) return fail('one_time_key_limit');
        if (Object.keys(otks).length === 0) otks = null;
      }

      const deviceChanged = Boolean(device) && (!existing
        || JSON.stringify(existing.deviceKeys) !== JSON.stringify(device.deviceKeys)
        || existing.name !== device.name
        || JSON.stringify(existing.caps ?? []) !== JSON.stringify(device.caps));
      const crossChanged = Boolean(cross) && Object.entries(cross)
        .some(([slot, value]) => JSON.stringify(account?.cross?.[slot]) !== JSON.stringify(value));
      if (deviceChanged || otks || fallback || crossChanged) {
        await e2eeCommit({
          v: 1,
          kind: 'e2ee-upload',
          seq: nextSeq(),
          login,
          deviceId,
          tokenKey: key,
          device: deviceChanged ? device : null,
          otks,
          fallback,
          cross: crossChanged ? cross : null,
        });
      }
      const current = e2eeDevice(login, deviceId);
      return {
        ok: true,
        deviceId,
        registered: Boolean(current),
        oneTimeKeyCount: current ? Object.keys(current.otks).length : 0,
        fallbackKey: Boolean(current?.fallback),
        changed: deviceChanged || crossChanged,
        crossReplaced: crossChanged && replaceCross,
      };
    }));
  }

  /**
   * Keep this account's signed statements on whom it verified (`peerTrust`,
   * `{ peer: statement }`), newest per peer. All or nothing, like the other
   * key uploads. Only for accounts the session's owner may query anyway, and
   * only from a session whose device holds keys — nothing else can sign one.
   */
  function e2eeTrust(token, body = {}) {
    return e2eeSerial(async () => {
      const session = state.tokens[tokenKey(token)];
      if (!session) return { ok: false, code: 'unknown_token' };
      const { login } = session;
      if (!e2eeDevice(login, session.deviceId)) return { ok: false, code: 'device_required' };
      const raw = body?.peerTrust;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'invalid_trust' };
      const entries = Object.entries(raw);
      if (entries.length === 0 || entries.length > E2EE_TRUST_BATCH_MAX) return { ok: false, code: 'invalid_trust' };
      const account = state.e2ee[login] ?? null;
      const trust = Object.create(null);
      let added = 0;
      for (const [rawPeer, value] of entries) {
        const peer = normalizeLogin(rawPeer);
        if (peer !== rawPeer || peer === login || !state.accounts[peer] || !areFriends(login, peer)) {
          return { ok: false, code: 'invalid_trust' };
        }
        const statement = normalizeTrustStatement(value, { login, peer });
        if (!statement) return { ok: false, code: 'invalid_trust' };
        const current = account?.trust?.[peer];
        if (current && JSON.stringify(current) === JSON.stringify(statement)) continue;
        if (!current) added += 1;
        trust[peer] = statement;
      }
      if (Object.keys(account?.trust ?? {}).length + added > E2EE_TRUST_LIMIT) return { ok: false, code: 'trust_limit' };
      const changed = Object.keys(trust).length > 0;
      if (changed) await e2eeCommit({ v: 1, kind: 'e2ee-trust', seq: nextSeq(), login, trust });
      return { ok: true, changed, login };
    });
  }

  // Sessions of `login` that can read nothing encrypted: no registered device,
  // and used recently enough to still count (§4.1).
  function e2eeLegacySessions(login) {
    const since = now() - E2EE_LEGACY_WINDOW_MS;
    let count = 0;
    for (const entry of Object.values(state.tokens)) {
      if (entry.login !== login || finiteOr(entry.lastUsed, 0) < since) continue;
      if (e2eeDevice(login, entry.deviceId)) continue;
      count += 1;
    }
    return count;
  }

  /** Keys of the asking account itself and of its friends; anyone else is left out. */
  function e2eeQuery(requester, logins) {
    const self = normalizeLogin(requester);
    const users = {};
    for (const raw of (Array.isArray(logins) ? logins : []).slice(0, E2EE_QUERY_BATCH_MAX)) {
      const login = normalizeLogin(raw);
      if (!validLogin(login) || !state.accounts[login]) continue;
      if (login !== self && !areFriends(self, login)) continue;
      const account = state.e2ee[login];
      const devices = {};
      for (const [deviceId, device] of Object.entries(account?.devices ?? {})) {
        devices[deviceId] = {
          deviceKeys: structuredClone(device.deviceKeys),
          name: device.name,
          caps: [...(device.caps ?? [])],
          createdAt: device.createdAt,
        };
      }
      users[login] = {
        crossSigning: structuredClone(account?.cross ?? {}),
        devices,
        legacySessions: e2eeLegacySessions(login),
      };
      // Whom an account verified is its own business: only it reads it.
      if (login === self) users[login].peerTrust = structuredClone(account?.trust ?? {});
    }
    return users;
  }

  /**
   * One one-time key per named device, or its fallback key when none are left.
   * `claims` is `{ login: [deviceId, …] }`. A one-time key is handed out once:
   * the answer exists only after the line removing it is on disk.
   */
  function e2eeClaim(requester, claims) {
    return e2eeSerial(async () => {
      const self = normalizeLogin(requester);
      const at = now();
      const keys = {};
      const taken = [];
      let budget = E2EE_CLAIM_BATCH_MAX;
      let rateLimited = false;
      const entries = claims && typeof claims === 'object' && !Array.isArray(claims) ? Object.entries(claims) : [];
      for (const [raw, ids] of entries) {
        const login = normalizeLogin(raw);
        if (!validLogin(login) || !state.accounts[login] || !Array.isArray(ids)) continue;
        if (login !== self && !areFriends(self, login)) continue;
        const pair = `${self}|${login}`;
        const recent = (e2eeClaimLog.get(pair) ?? []).filter((ts) => at - ts < 60_000);
        for (const deviceId of ids) {
          if (budget <= 0) break;
          const device = e2eeDevice(login, deviceId);
          if (!device || keys[login]?.[deviceId]) continue;
          if (recent.length >= E2EE_CLAIMS_PER_MINUTE) {
            rateLimited = true;
            break;
          }
          recent.push(at);
          budget -= 1;
          const keyId = Object.keys(device.otks)[0];
          let result = null;
          if (keyId !== undefined) {
            result = { keyId, key: structuredClone(device.otks[keyId]), fallback: false };
            taken.push({ login, deviceId, keyId });
          } else if (device.fallback) {
            result = { keyId: device.fallback.keyId, key: structuredClone(device.fallback.key), fallback: true };
          }
          if (result) (keys[login] ??= {})[deviceId] = result;
        }
        if (recent.length > 0) e2eeClaimLog.set(pair, recent);
        else e2eeClaimLog.delete(pair);
      }
      if (taken.length > 0) {
        await e2eeCommit({ v: 1, kind: 'e2ee-claim', seq: nextSeq(), taken });
      }
      return { keys, rateLimited };
    });
  }

  /**
   * Hold `body` for one device until that device acknowledges it. Answers only
   * once the line is on disk, so `to-device-accepted` means what it says.
   */
  function e2eeSend(from, fromDevice, to, toDevice, body) {
    return e2eeSerial(async () => {
      const sender = normalizeLogin(from);
      const target = normalizeLogin(to);
      if (!e2eeDevice(sender, fromDevice)) return { ok: false, code: 'device_required' };
      if (!validLogin(target) || !state.accounts[target] || (target !== sender && !areFriends(sender, target))) {
        return { ok: false, code: 'peer_not_found' };
      }
      const device = e2eeDevice(target, toDevice);
      if (!device) return { ok: false, code: 'device_not_found' };
      const payload = normalizeToDeviceBody(body);
      if (!payload) return { ok: false, code: 'invalid_to_device' };
      if (device.inbox.length >= E2EE_INBOX_LIMIT) return { ok: false, code: 'to_device_full' };
      let mine = 0;
      for (const item of device.inbox) if (item.from === sender && item.fromDevice === fromDevice) mine += 1;
      if (mine >= E2EE_INBOX_PER_SENDER) return { ok: false, code: 'to_device_full' };
      const seq = nextSeq();
      const item = { seq, from: sender, fromDevice, body: payload, at: now() };
      await e2eeCommit({ v: 1, kind: 'e2ee-send', seq, login: target, deviceId: toDevice, item });
      return { ok: true, item: structuredClone(item) };
    });
  }

  function e2eeInbox(login, deviceId) {
    const device = e2eeDevice(normalizeLogin(login), deviceId);
    return device ? device.inbox.map((item) => structuredClone(item)) : [];
  }

  /** Drops everything up to and including `through`; true when anything went. */
  function e2eeAck(login, deviceId, through) {
    return e2eeSerial(async () => {
      const owner = normalizeLogin(login);
      const device = e2eeDevice(owner, deviceId);
      if (!device || !Number.isFinite(through)) return false;
      const upto = Math.floor(through);
      if (upto <= device.ackedThrough || !device.inbox.some((item) => item.seq <= upto)) return false;
      await e2eeCommit({ v: 1, kind: 'e2ee-ack', seq: nextSeq(), login: owner, deviceId, through: upto });
      return true;
    });
  }

  /**
   * Signing out ends the device: its keys leave the registry, so every peer's
   * next query no longer finds it and they rotate (§4.3). Returns what was
   * removed, or null when the session had no registered device.
   */
  function e2eeRemoveTokenDevice(token) {
    return e2eeSerial(async () => {
      const session = state.tokens[tokenKey(token)];
      if (!session || !e2eeDevice(session.login, session.deviceId)) return null;
      await e2eeCommit({ v: 1, kind: 'e2ee-remove', seq: nextSeq(), login: session.login, deviceId: session.deviceId });
      return { login: session.login, deviceId: session.deviceId };
    });
  }

  /**
   * Read or update the account's encrypted key backup (`docs/specs/2026-11-04-e2ee.md` §4.5, §5).
   * A call without `version` reads the current backup metadata (and `sessions` when
   * `includeSessions` is true); a call with `version` creates/rotates the backup or
   * uploads encrypted Megolm session keys (keeping the earliest `firstKnownIndex` per session).
   */
  function e2eeBackup(token, body = {}) {
    return e2eeSerial(async () => {
      const session = state.tokens[tokenKey(token)];
      if (!session) return { ok: false, code: 'unknown_token' };
      const { login, deviceId } = session;
      if (!e2eeDevice(login, deviceId)) return { ok: false, code: 'device_required' };
      const account = e2eeEnsure(login);
      const current = account.backup;

      if (body.version === undefined) {
        return {
          ok: true,
          version: current.version,
          crossSigning: current.crossSigning ? structuredClone(current.crossSigning) : null,
          passphrase: current.passphrase ? structuredClone(current.passphrase) : null,
          sessionCount: Object.keys(current.sessions).length,
          ...(body.includeSessions === true ? { sessions: structuredClone(current.sessions) } : {}),
        };
      }

      if (!Number.isInteger(body.version) || body.version < 1) {
        return { ok: false, code: 'invalid_backup' };
      }
      const version = body.version;
      const creating = current.version === 0 && version === 1;
      const replacing = current.version > 0 && body.replace === true && version === current.version + 1;
      if (creating || replacing) {
        const crossSigning = normalizeBackupEntry(body.crossSigning);
        if (!crossSigning) return { ok: false, code: 'invalid_backup' };
        let passphrase = null;
        if (body.passphrase !== undefined && body.passphrase !== null) {
          passphrase = normalizePassphraseSlot(body.passphrase);
          if (!passphrase) return { ok: false, code: 'invalid_backup' };
        }
        let sessions = null;
        if (body.sessions !== undefined) {
          sessions = normalizeBackupSessions(body.sessions, E2EE_BACKUP_BATCH_MAX);
          if (!sessions) return { ok: false, code: 'invalid_backup' };
        }
        await e2eeCommit({
          v: 1,
          kind: 'e2ee-backup',
          seq: nextSeq(),
          login,
          deviceId,
          version,
          replace: true,
          crossSigning,
          passphrase,
          sessions,
        });
      } else {
        if (version !== current.version) {
          return { ok: false, code: 'backup_version_mismatch' };
        }
        let passphrase;
        if (body.passphrase !== undefined) {
          if (body.passphrase === null) {
            passphrase = null;
          } else {
            passphrase = normalizePassphraseSlot(body.passphrase);
            if (!passphrase) return { ok: false, code: 'invalid_backup' };
          }
        }
        let sessions = null;
        if (body.sessions !== undefined) {
          const normalized = normalizeBackupSessions(body.sessions, E2EE_BACKUP_BATCH_MAX);
          if (!normalized) return { ok: false, code: 'invalid_backup' };
          const toWrite = Object.create(null);
          let total = Object.keys(current.sessions).length;
          for (const [sid, item] of Object.entries(normalized)) {
            const existing = current.sessions[sid];
            if (!existing) {
              if (total >= E2EE_BACKUP_SESSION_LIMIT) return { ok: false, code: 'backup_session_limit' };
              total += 1;
              toWrite[sid] = item;
            } else if (item.firstKnownIndex < existing.firstKnownIndex) {
              toWrite[sid] = item;
            }
          }
          if (Object.keys(toWrite).length > 0) sessions = toWrite;
        }
        const passphraseChanged = passphrase !== undefined
          && JSON.stringify(passphrase) !== JSON.stringify(current.passphrase);
        if (passphraseChanged || sessions) {
          await e2eeCommit({
            v: 1,
            kind: 'e2ee-backup',
            seq: nextSeq(),
            login,
            deviceId,
            version,
            replace: false,
            ...(passphraseChanged ? { passphrase } : {}),
            ...(sessions ? { sessions } : {}),
          });
        }
      }

      const updated = account.backup;
      return {
        ok: true,
        version: updated.version,
        crossSigning: updated.crossSigning ? structuredClone(updated.crossSigning) : null,
        passphrase: updated.passphrase ? structuredClone(updated.passphrase) : null,
        sessionCount: Object.keys(updated.sessions).length,
        ...(body.includeSessions === true ? { sessions: structuredClone(updated.sessions) } : {}),
      };
    });
  }

  // Everything on the disk, including whatever the journal is still writing:
  // a caller that awaits this may assume a commit made before it is durable
  // and a snapshot covering it has landed.
  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await wal.settled();
    const pendingSnapshot = snapshotInFlight;
    await persist();
    // A snapshot already running predates this flush. Take one final pass
    // for its coalesced mutations; do not chase writes arriving after flush.
    if (pendingSnapshot && dirty) await persist();
  }

  async function close() {
    await flush();
    await wal.close();
  }

  return {
    register,
    login: signIn,
    recover: recoverAccount,
    storageCipher: cipher,
    updateProfile,
    issueCertificate,
    serverPublicKey: () => serverKeys?.pubKey || null,
    resolveToken,
    revokeToken,
    users,
    friends,
    areFriends,
    createInvite,
    acceptInvite,
    linkFriends,
    friendRequests,
    requestFriend,
    answerFriendRequest,
    hasBlocked,
    blockedLogins,
    blockUser,
    unblockUser,
    isRemoved,
    removedLogins,
    removeContact,
    touch,
    enqueue,
    drain,
    pending,
    unreadCounts,
    countMessageItems,
    nameOf,
    langOf,
    setAlias,
    aliasOf,
    addPushSubscription,
    removePushSubscription,
    pushSubscriptions,
    mintPushRepairKey,
    repairPushSubscription,
    addFcmToken,
    removeFcmToken,
    fcmTokens,
    recordHistory,
    commitHistory,
    findHistoryMessage,
    visibleRecord,
    appendEvent,
    eventsSince,
    history,
    lastMessage,
    deleteHistory,
    reactionEvents,
    readReactionEvents,
    editHistory,
    reactHistory,
    hideHistory,
    markRead,
    markDelivered,
    markConversationRead,
    markConversationUnread,
    isMarkedUnread,
    readTs,
    deliveredTs,
    readAt,
    readVia,
    announcedVersion,
    setAnnouncedVersion,
    markBot,
    isBot,
    scheduleReplyReminder,
    dueReplyReminders,
    firedReplyReminders,
    pendingReplyReminders,
    nextReplyReminderAt,
    ackReplyReminder,
    e2eeTokenKey,
    e2eeDeviceForTokenKey,
    e2eeUpload,
    e2eeQuery,
    e2eeTrust,
    e2eeClaim,
    e2eeSend,
    e2eeInbox,
    e2eeAck,
    e2eeRemoveTokenDevice,
    e2eeBackup,
    flush,
    close,
  };
}
