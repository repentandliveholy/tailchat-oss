import crypto from 'node:crypto';

import { CLOUD_E2EE_FRAME_MAX_CHARS } from './limits.js';

// The server half of end-to-end encryption, stage 6a of the Rust core
// (docs/specs/2026-11-04-e2ee.md §4–5). The server never sees a key it could
// decrypt with and never checks a signature: every one of these values is
// verified by the clients that read it. What it does check is shape and size,
// so that nothing it stores or relays can grow without bound or reach a client
// as a kind of value that client has no case for — and the one rule a server
// must hold itself, that a device's identity keys never change under its id
// (§4.1).

export const E2EE_CAP = 'e2ee-v1';
// What a session that never declared `e2ee-v1` sees instead of an envelope it
// cannot open: an installed APK or an old web bundle would otherwise draw an
// empty bubble (§5).
export const E2EE_STUB_TEXT = '🔒 Зашифрованное сообщение — обновите приложение';

export const E2EE_DEVICE_LIMIT = 20;
export const E2EE_OTK_LIMIT = 50;
// Claims one account may make against another per minute. Without it anybody
// allowed to claim could drain a device's one-time keys and leave every new
// session to the fallback key (§4.1).
export const E2EE_CLAIMS_PER_MINUTE = 10;
export const E2EE_CLAIM_BATCH_MAX = 50;
export const E2EE_QUERY_BATCH_MAX = 50;
export const E2EE_INBOX_LIMIT = 1000;
// One sending device's share of somebody's inbox: a friend must not be able to
// fill it and hold back everybody else's keys (§4.4).
export const E2EE_INBOX_PER_SENDER = 100;
// A session without a device key counts as a device that cannot read only
// while it has been used this recently (§4.1, confirmed by the owner 2026-11-05).
export const E2EE_LEGACY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const E2EE_TO_DEVICE_MAX_CHARS = 64 * 1024;
// An envelope larger than this carries an attachment, and counts against the
// same media budgets an inline picture does (§4.3).
export const E2EE_INLINE_CHARS = 64 * 1024;

export const E2EE_BACKUP_SESSION_LIMIT = 5000;
export const E2EE_BACKUP_BATCH_MAX = 100;
// Whom one account may vouch for (`peerTrust`), and per request: one entry per
// person verified, so an account cannot grow it past the people it knows.
export const E2EE_TRUST_LIMIT = 1000;
export const E2EE_TRUST_BATCH_MAX = 50;
const TRUST_STATEMENT_MAX_CHARS = 1024;

const BACKUP_ENTRY_MAX_CHARS = 4096;
const NONCE_B64 = /^[A-Za-z0-9+/]{16}$/;
const SALT_B64 = /^[A-Za-z0-9+/]{22,86}$/;
const DEVICE_KEYS_MAX_CHARS = 4096;
const SIGNED_KEY_MAX_CHARS = 1024;
const CROSS_SIGNING_MAX_CHARS = 4096;
const DEVICE_NAME_MAX = 64;
const DEVICE_KINDS = new Set(['client', 'assistant']);

// vodozemac's `to_base64`: standard alphabet, no padding, 32 bytes.
const PUBLIC_KEY = /^[A-Za-z0-9+/]{43}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{16}$/;
const KEY_ID = /^[A-Za-z0-9+/=:_.-]{1,64}$/;
const SESSION_ID = /^[A-Za-z0-9+/]{1,128}$/;
const CIPHERTEXT = /^[A-Za-z0-9+/]+$/;
const NAME_DROP = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;

// Fields that carry what a reader would call the message. An encrypted frame
// carries all of them inside its ciphertext, so one that also carries any of
// them in the clear is a client bug that would leak exactly what it encrypted.
const CONTENT_FIELDS = ['image', 'voice', 'replyTo', 'forwardedFrom', 'buttons', 'linkPreview'];

export function newDeviceId() {
  return crypto.randomBytes(12).toString('base64url');
}

export function validDeviceId(value) {
  return typeof value === 'string' && DEVICE_ID.test(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// A detached copy no larger than `max` characters of JSON, or null. Copied so
// that nothing a caller keeps a reference to can change what was stored.
function boundedCopy(value, max) {
  if (!isPlainObject(value)) return null;
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (typeof text !== 'string' || text.length > max) return null;
  return JSON.parse(text);
}

/**
 * The device's own signed statement of who it is. It names the account and the
 * device id itself, so a client that reads it can tell when the server filed it
 * under somebody else.
 */
export function normalizeDeviceKeys(value, { login, deviceId }) {
  const copy = boundedCopy(value, DEVICE_KEYS_MAX_CHARS);
  if (!copy) return null;
  if (copy.login !== login || copy.deviceId !== deviceId) return null;
  if (!DEVICE_KINDS.has(copy.kind)) return null;
  if (!isPlainObject(copy.keys)) return null;
  if (!PUBLIC_KEY.test(copy.keys.curve25519 ?? '') || !PUBLIC_KEY.test(copy.keys.ed25519 ?? '')) return null;
  return copy;
}

// Identity keys and kind are what a device *is*; signatures may grow.
export function sameDeviceIdentity(a, b) {
  return a.kind === b.kind
    && a.keys.curve25519 === b.keys.curve25519
    && a.keys.ed25519 === b.keys.ed25519;
}

// What a device's core says it can read (`caps` beside `deviceKeys`, unsigned
// like the name): `e2ee-blob-v1` means an attachment may travel as raw bytes
// inside the ciphertext (docs/specs/2026-11-04-e2ee.md §4.3). A device that
// lists nothing — every core before 1.148 — is sent the inline form, which
// every core reads. Short tokens, a few of them, sorted, so a re-upload of the
// same list is not a change.
const DEVICE_CAP = /^[a-z0-9][a-z0-9.-]{0,31}$/;
const DEVICE_CAPS_MAX = 8;
export function normalizeDeviceCaps(value) {
  if (!Array.isArray(value)) return [];
  const caps = new Set();
  for (const cap of value) {
    if (typeof cap === 'string' && DEVICE_CAP.test(cap)) caps.add(cap);
    if (caps.size >= DEVICE_CAPS_MAX) break;
  }
  return [...caps].sort();
}

export function normalizeDeviceName(value) {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(NAME_DROP, '').trim()).slice(0, DEVICE_NAME_MAX).join('');
}

function normalizeSignedKey(value) {
  const copy = boundedCopy(value, SIGNED_KEY_MAX_CHARS);
  return copy && PUBLIC_KEY.test(copy.key ?? '') ? copy : null;
}

/**
 * `{ keyId: signedKey }`, all or nothing: a request with one bad key is refused
 * whole rather than stored in part, so the device never has to guess which of
 * its keys the server took.
 */
export function normalizeOneTimeKeys(value) {
  if (!isPlainObject(value)) return null;
  const out = Object.create(null);
  for (const [keyId, key] of Object.entries(value)) {
    if (!KEY_ID.test(keyId)) return null;
    const signed = normalizeSignedKey(key);
    if (!signed) return null;
    out[keyId] = signed;
  }
  return out;
}

export function normalizeFallbackKey(value) {
  if (!isPlainObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length !== 1) return null;
  const [keyId, key] = entries[0];
  if (!KEY_ID.test(keyId)) return null;
  const signed = normalizeSignedKey(key);
  return signed ? { keyId, key: signed } : null;
}

export function normalizeCrossSigning(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const slot of ['master', 'selfSigning']) {
    if (value[slot] === undefined) continue;
    const copy = boundedCopy(value[slot], CROSS_SIGNING_MAX_CHARS);
    if (!copy || !PUBLIC_KEY.test(copy.key ?? '')) return null;
    out[slot] = copy;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * An account's signed word that it verified `peer`'s master key
 * (`CrossSigning::attest_peer`): `{login, usage: "peer_verified", peer, key,
 * signatures}`. The signature is the reader's to check against the account's
 * self-signing key; the server only makes sure the statement is about whom it
 * is filed under and from whom it came.
 */
export function normalizeTrustStatement(value, { login, peer }) {
  const copy = boundedCopy(value, TRUST_STATEMENT_MAX_CHARS);
  if (!copy || copy.login !== login || copy.peer !== peer || copy.usage !== 'peer_verified') return null;
  if (!PUBLIC_KEY.test(copy.key ?? '') || !isPlainObject(copy.signatures)) return null;
  return copy;
}

export function normalizeToDeviceBody(value) {
  return boundedCopy(value, E2EE_TO_DEVICE_MAX_CHARS);
}

export function normalizeBackupEntry(value) {
  const copy = boundedCopy(value, BACKUP_ENTRY_MAX_CHARS);
  if (!copy || !NONCE_B64.test(copy.nonce ?? '')) return null;
  if (typeof copy.ct !== 'string' || copy.ct.length < 22 || copy.ct.length > BACKUP_ENTRY_MAX_CHARS || !CIPHERTEXT.test(copy.ct)) {
    return null;
  }
  return { nonce: copy.nonce, ct: copy.ct };
}

export function normalizePassphraseSlot(value) {
  const copy = boundedCopy(value, BACKUP_ENTRY_MAX_CHARS);
  if (!copy || !SALT_B64.test(copy.salt ?? '')) return null;
  const entry = normalizeBackupEntry(copy);
  return entry ? { salt: copy.salt, nonce: entry.nonce, ct: entry.ct } : null;
}

export function normalizeBackupSessions(value, maxCount = E2EE_BACKUP_BATCH_MAX) {
  if (!isPlainObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > maxCount) return null;
  const out = Object.create(null);
  for (const [sid, item] of entries) {
    if (!SESSION_ID.test(sid) || !isPlainObject(item)) return null;
    if (!Number.isInteger(item.firstKnownIndex) || item.firstKnownIndex < 0 || item.firstKnownIndex > 0xFFFFFFFF) return null;
    const entry = normalizeBackupEntry(item);
    if (!entry) return null;
    out[sid] = { firstKnownIndex: item.firstKnownIndex, nonce: entry.nonce, ct: entry.ct };
  }
  return out;
}

/** The encrypted envelope of a message (§4.3), or null. */
export function normalizeEnvelope(value) {
  if (!isPlainObject(value) || value.v !== 1) return null;
  const { dev, sid, ct } = value;
  if (!validDeviceId(dev) || typeof sid !== 'string' || !SESSION_ID.test(sid)) return null;
  if (typeof ct !== 'string' || ct.length === 0 || ct.length > CLOUD_E2EE_FRAME_MAX_CHARS || !CIPHERTEXT.test(ct)) return null;
  return { v: 1, dev, sid, ct };
}

export function sameEnvelope(a, b) {
  return Boolean(a) && Boolean(b) && a.v === b.v && a.dev === b.dev && a.sid === b.sid && a.ct === b.ct;
}

// What an envelope weighs against a media budget: nothing unless it is large
// enough to be carrying an attachment, so a conversation's text is never what
// a budget evicts.
export function envelopeMediaChars(envelope) {
  const size = typeof envelope?.ct === 'string' ? envelope.ct.length : 0;
  return size > E2EE_INLINE_CHARS ? size : 0;
}

// An encrypted edit (`sealedEdit: true` beside an envelope): new text for a
// message, sealed like any message so the server never learns which one or
// what it says. It is stored, relayed and queued like a message — the other
// devices need it — but it is not one to the reader: it moves no unread
// badge, sends no push and is no conversation's last line. The flag alone,
// without an envelope, means nothing (an open edit is `t: 'edit'`).
export function isSealedEdit(d) {
  return Boolean(d) && d.sealedEdit === true && Boolean(d.e2ee);
}

export function carriesPlainContent(d) {
  if (typeof d.text === 'string' && d.text !== '') return true;
  return CONTENT_FIELDS.some((field) => d[field] !== undefined && d[field] !== null);
}

/**
 * The frame a session is handed. Unchanged for a session that can open it;
 * otherwise the envelope is replaced by the stub text — except an edit's
 * carrier, which is nothing a reader can use: it becomes a tombstone for the
 * same id (`deletedAt`, no words), which every client already knows how to
 * hold without drawing. The flag stays beside it so a client that filters
 * carriers drops it before it ever reads the tombstone. A live frame (`t`) has
 * no `text` — a client that requires one drops it unread — while a history
 * record is the deleted-record shape the store itself answers (`text: ''`), so
 * the id is found and the backfill closes instead of walking to the beginning.
 */
export function frameForCaps(caps, d) {
  if (!d || typeof d !== 'object' || !d.e2ee) return d;
  if (Array.isArray(caps) && caps.includes(E2EE_CAP)) return d;
  if (isSealedEdit(d)) {
    const tombstone = { id: d.id, ts: d.ts, deletedAt: d.ts, sealedEdit: true };
    if (d.t !== undefined) tombstone.t = d.t;
    else tombstone.text = '';
    if (d.from !== undefined) tombstone.from = d.from;
    if (d.kind !== undefined) tombstone.kind = d.kind;
    return tombstone;
  }
  const stub = { ...d, text: E2EE_STUB_TEXT };
  delete stub.e2ee;
  return stub;
}
