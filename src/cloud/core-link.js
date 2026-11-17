import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCloudSession, CLIENT_CAPS } from './link.js';
import { newMessageId } from '../session.js';
import { terminalDeviceName } from '../../web/cloud/core/e2ee-commands.js';
import {
  routeOutbound, inboundKind, ownsInbound, rememberRawSent,
} from '../../web/cloud/core/routing.js';

// The terminal on the Rust core (`crates/tailchat-node`), behind a flag.
//
// `startCloudSession` (link.js) is the one client transport src/cli.js knows: an
// EventEmitter with a fixed set of methods and events. This module returns that
// same object, built by that same code, but with the WebSocket underneath
// replaced by the native driver — which owns the real socket, the SQLCipher
// store, the send queue (⧗ → ✓ → ✓✓ → ⚠), the receipts and the account feed.
// link.js is not forked: it is handed a WebSocket-shaped object through its
// existing `connect` option, and what crosses that object is routed here.
//
//   JS → server  (link.js writes `ws.send(text)`; see `routeOutbound`)
//     auth                      swallowed — the core authenticated on its own
//     inner msg, plain text     client.sendText  (durable: the core queues it)
//     inner ack                 swallowed — the core acks once the row is on disk
//     sync                      swallowed — the core owns the feed
//     everything else           client.sendRaw   (subscribe, read, typing, media,
//                               replies, forwards, mark-unread, reminders, …)
//
//   server → JS  (the core hands over every inbound text frame, after it has
//                 handled it; see `ownsInbound`)
//     message-accepted, sync-page, sync-nudge, peer ack/read   core only
//     everything else           delivered to link.js as a WebSocket message, so
//                               presence, typing, hello, AI, unread counts and
//                               the live transcript work exactly as before
//
// Receipt marks come only from the core's own notices, which this module turns
// into `receipt` events; what the store learned is announced as `core-stored` /
// `core-removed` so the terminal can repaint from `conversation()`.

export const CORE_FLAG = 'TAILCHAT_CORE';
// The SQLCipher key is an HKDF subkey of the device key (secure-store.js
// `deriveKey`): a second consumer of the vault never holds the key the CLI's own
// files are sealed with.
export const CORE_KEY_INFO = 'tailchat-core-sqlcipher-v1';

// `ws`'s readyState values; link.js compares against the real constants.
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

// Only an exact "1" opts in: a stray `TAILCHAT_CORE=0` or an empty variable must
// leave the terminal exactly as it was.
export function coreRequested(env = process.env) {
  return env?.[CORE_FLAG] === '1';
}

// One store per account, in the state dir the terminal already keeps its other
// files in. The login is the server's own lowercase form, so it is also a safe
// file name.
export function coreDbPath(stateDir, login) {
  return path.join(stateDir, 'core', `${String(login).toLowerCase()}.db`);
}

// The server binds a device id to the token's session (`accounts.js`
// `e2eeUpload`), so a new token is always a new device: a store made under
// another token holds an account signed for a device id the server no longer
// has, and every key upload it makes is refused. Such a store is moved aside —
// never deleted: its reading sessions still open old encrypted history — and
// the core starts a fresh one. The token itself is never written down, only a
// hash beside the store. A store with no hash predates this check and is kept.
const SESSION_MARK_BYTES = 16;

function sessionMark(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, SESSION_MARK_BYTES * 2);
}

export function retireStaleCoreStore({ dbPath, token, now = Date.now, fsImpl = fs }) {
  const markFile = `${dbPath}.session`;
  const mark = sessionMark(token);
  let stored = null;
  try {
    stored = fsImpl.readFileSync(markFile, 'utf8').trim();
  } catch {
    stored = null;
  }
  const hasStore = fsImpl.existsSync(dbPath);
  let retired = null;
  if (hasStore && stored && stored !== mark) {
    retired = `${dbPath}.retired-${now()}`;
    // SQLite's companions travel with the database, or the moved file is torn.
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (fsImpl.existsSync(`${dbPath}${suffix}`)) fsImpl.renameSync(`${dbPath}${suffix}`, `${retired}${suffix}`);
    }
  }
  if (stored !== mark) fsImpl.writeFileSync(markFile, `${mark}\n`, { mode: 0o600 });
  return { retired };
}

// The core fetches history over HTTP beside its socket: `ws://host/tailchat/ws`
// pairs with `http://host/tailchat`.
export function httpBaseOf(socketUrl) {
  return String(socketUrl).replace(/^ws/i, 'http').replace(/\/ws\/?$/, '');
}

export class CoreUnavailable extends Error {
  constructor(message, code = 'core-unavailable') {
    super(message);
    this.name = 'CoreUnavailable';
    this.code = code;
  }
}

function nativeModuleFile() {
  return fileURLToPath(new URL('../../native/tailchat_core.node', import.meta.url));
}

// `npm run build:core` puts the module here; there is no prebuilt binary and no
// install-time build, so a checkout that never built it is the ordinary case.
export function loadNativeCore({
  file = nativeModuleFile(),
  load = (target) => createRequire(import.meta.url)(target),
} = {}) {
  if (!fs.existsSync(file)) {
    throw new CoreUnavailable('module not built — run "npm run build:core"', 'core-missing');
  }
  let native;
  try {
    native = load(file);
  } catch (error) {
    throw new CoreUnavailable(`cannot load ${path.basename(file)}: ${error?.message ?? error}`, 'core-unloadable');
  }
  if (typeof native?.open !== 'function') {
    throw new CoreUnavailable(`${path.basename(file)} does not export open()`, 'core-unloadable');
  }
  return native;
}

// What a refused `open` says, in words a person can act on. The native module
// tags its errors with a `code`.
export function describeCoreError(error) {
  switch (error?.code) {
    case 'locked': return 'another tailchat already holds this account\'s local store';
    case 'bad-token': return 'the cloud token is not usable';
    case 'bad-url': return 'the cloud address is not usable';
    default: return String(error?.message ?? error);
  }
}

// The routing table (what the core owns, what link.js keeps) is shared with
// the browser's core session: `web/cloud/core/routing.js`.
export { routeOutbound, inboundKind, ownsInbound };

// The WebSocket link.js believes it dials. It is only ever as open as the
// native driver's connection is, and it closes when that closes: link.js's own
// redial then asks `connect` for the next one.
export class CoreSocket extends EventEmitter {
  #route;

  constructor(route) {
    super();
    this.#route = route;
    this.readyState = CONNECTING;
  }

  // The native connection is up. `replay` holds what the server already said on
  // it — the `ready` (and roster) a socket that attached late has missed — so
  // link.js still learns the server's capabilities and subscribes. Emitted on a
  // microtask: link.js attaches its listeners right after `connect` returns.
  open(replay = []) {
    queueMicrotask(() => {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      this.emit('open');
      for (const raw of replay) {
        if (this.readyState !== OPEN) return;
        this.emit('message', raw);
      }
    });
  }

  receive(raw) {
    if (this.readyState === OPEN) this.emit('message', raw);
  }

  send(text) {
    if (this.readyState === OPEN) this.#route(text);
  }

  close() {
    this.finish();
  }

  // link.js terminates a socket it believes is stale; its own watchdog is off
  // here (see `staleMs` below), but the method is part of the shape.
  terminate() {
    this.finish();
  }

  finish() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    queueMicrotask(() => this.emit('close'));
  }
}

// Sends handed to the core and not yet confirmed (`message-added`). A refusal
// names its message; one found here was a send whose row comes back off the
// screen, one not found was a retry, whose row stays ⚠.
const PROVISIONAL_LIMIT = 256;

// Opens the native store and driver and returns the same object
// `startCloudSession` does, plus:
//
//   isCore                       true — the terminal branches on it
//   conversation(peer, limit, before)   rows of the open conversation, oldest first
//   retry(peer, id)              send a failed (⚠) message again
//
// and these events on top of link.js's:
//
//   receipt       { peer, id, ts, receipt }  receipt: queued|sent|delivered|read|failed
//   core-stored   { peer, id }               a row was written or changed
//   core-removed  { peer, ids }              rows are gone from this device
//   core-refused  { peer, id, reason }       a send never made it into the queue
//   core-held     { peer, id }               a send reused an id the core already
//                                            holds: that message exists, nothing
//                                            new was queued, its row stays
//   read-sync     { peer, id: '', readTs }   (link.js's own event) this account
//                                            read the conversation elsewhere
//
// Throws what `native.open` throws (with its `code`: locked, store, bad-token,
// bad-url) so the caller can fall back to `startCloudSession`.
export function startCoreCloudSession({
  url,
  token,
  name,
  peer,
  peerLabel = peer,
  login,
  dbPath,
  key,
  httpBase = httpBaseOf(url),
  e2ee = true,
  native = loadNativeCore(),
  retryMs,
  retryMaxMs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const { retired } = retireStaleCoreStore({ dbPath, token });

  let state = 'connecting';
  let current = null; // the socket link.js holds right now
  let ready = null; // the server's `ready` on this connection, kept for a late socket
  let roster = null; // and its latest roster
  let closed = false;
  const rawSent = new Set();
  const provisional = new Map(); // id -> peer, for text handed to the core

  // The native side copies the key; this copy is wiped the moment it has.
  const secret = Buffer.from(key);
  let client;
  try {
    client = native.open({
      login,
      token,
      socketUrl: url,
      httpBase,
      dbPath,
      key: secret,
      // link.js claims what its `handle()` consumes (minus `media-ref-v1`, see
      // CLASSIC_CAPS: the core's codec cannot store a reference yet); the core merges that with
      // its own list. `read-ack-v1` is why `read-accepted` still reaches the
      // terminal, which keeps unread ids until the server accepts them.
      extraCaps: [...CLIENT_CAPS],
      e2ee: Boolean(e2ee),
      // What the other side's verification lines call this device. A
      // native module built before names ignores the field.
      deviceName: terminalDeviceName(process.platform),
    }, onNotice);
  } finally {
    secret.fill(0);
  }

  const link = startCloudSession({
    url,
    token,
    name,
    peer,
    peerLabel,
    retryMs,
    retryMaxMs,
    setTimer,
    clearTimer,
    // Liveness is the native driver's: it watches the socket and redials. This
    // watchdog cannot see the WebSocket pings the driver answers, so it would
    // call a healthy, quiet connection stale every 35 seconds.
    staleMs: Number.POSITIVE_INFINITY,
    connect,
  });

  function connect() {
    const socket = new CoreSocket(dispatch);
    current = socket;
    if (state === 'open' || state === 'ready') {
      socket.open(state === 'ready' ? [ready, roster].filter(Boolean) : []);
    }
    return socket;
  }

  function dispatch(text) {
    if (closed) return;
    const out = routeOutbound(text);
    if (out.route === 'swallow') return;
    if (out.route === 'text') {
      try {
        client.sendText(out.id, out.peer, out.text);
        track(out.id, out.peer);
        return;
      } catch {
        // A shape the core will not take (a login or id it cannot parse) is
        // still the server's to judge, as it was before the core existed.
      }
    }
    if (out.sent) rememberRawSent(rawSent, out.sent.id);
    try {
      client.sendRaw(text);
    } catch {
      // The driver is stopped: nothing is left to write to.
    }
  }

  function track(id, to) {
    provisional.delete(id);
    provisional.set(id, to);
    if (provisional.size > PROVISIONAL_LIMIT) provisional.delete(provisional.keys().next().value);
  }

  // The core refused an action and named its message. A send it refused never
  // became a message: its row is taken back. A send that reused an id the core
  // already holds (a handed-over outbox entry it took on an earlier run) is not
  // a loss at all: `core-held`. A retry it refused names a row that stays as it
  // was (⚠), so only the reason is said.
  function onRefused({ peer: to, id, held, reason }) {
    const text = String(reason ?? 'refused');
    if (typeof id === 'string' && provisional.has(id)) {
      const owner = provisional.get(id);
      provisional.delete(id);
      const peerName = typeof to === 'string' ? to : owner;
      if (held === true) link.emit('core-held', { peer: peerName, id });
      else link.emit('core-refused', { peer: peerName, id, reason: text });
      return;
    }
    link.emit('core-refused', { peer: null, id: null, reason: text });
  }

  function onConnection(notice) {
    switch (notice.state) {
      case 'connecting':
        state = 'connecting';
        return;
      case 'open':
        state = 'open';
        if (current?.readyState === CONNECTING) current.open([]);
        return;
      case 'ready':
        state = 'ready';
        return;
      case 'closed':
        state = 'closed';
        ready = null;
        roster = null;
        current?.finish();
        return;
      case 'auth-failed':
        // The server's own `error` frame follows through link.js, which stands
        // down and says so; the driver has already stopped dialling.
        state = 'auth-failed';
        return;
      default:
    }
  }

  function onFrame(raw) {
    if (typeof raw !== 'string') return;
    const kind = inboundKind(raw);
    if (kind === 'ready') ready = raw;
    else if (kind === 'users') roster = raw;
    if (ownsInbound(raw, rawSent, kind)) return;
    current?.receive(raw);
  }

  // A raw write the driver refused because it was not connected. Control frames
  // (typing, focus, read receipts) are best effort and retried by their owners;
  // a lost message is not, and the terminal has to take its row back.
  function onRawDropped(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame?.k !== 'frame' || frame.d?.t !== 'msg' || typeof frame.d.id !== 'string') return;
    rawSent.delete(frame.d.id);
    link.emit('core-refused', {
      peer: typeof frame.to === 'string' ? frame.to : null,
      id: frame.d.id,
      reason: 'not connected',
    });
  }

  function onNotice(notice) {
    if (closed || !notice || typeof notice !== 'object') return;
    switch (notice.kind) {
      case 'connection':
        onConnection(notice);
        return;
      case 'frame':
        onFrame(notice.raw);
        return;
      case 'raw-dropped':
        onRawDropped(notice.raw);
        return;
      case 'action-refused':
        onRefused(notice);
        return;
      case 'storage-failed':
        // A send whose row the failure kept off the disk is refused by name
        // (`action-refused`); this is the failure itself.
        link.emit('status', { key: 'core.storageFailed', params: { reason: String(notice.reason ?? 'error') } });
        return;
      case 'message-added':
      case 'receipt':
        provisional.delete(notice.id);
        link.emit('receipt', {
          peer: notice.peer,
          id: notice.id,
          ts: notice.ts,
          receipt: notice.kind === 'message-added' ? 'queued' : notice.receipt,
        });
        return;
      case 'stored':
        link.emit('core-stored', { peer: notice.peer, id: notice.id });
        return;
      case 'removed':
        link.emit('core-removed', { peer: notice.peer, ids: Array.isArray(notice.ids) ? notice.ids : [] });
        return;
      case 'own-read':
        // The same fact link.js reports from `read-sync`: this account read the
        // conversation on another device. The feed delivers it after a gap too.
        link.emit('read-sync', { peer: notice.peer, id: '', readTs: notice.readTs || 0 });
        return;
      case 'device-registered':
        link.emit('core-device-registered', { deviceId: notice.deviceId });
        return;
      case 'encryption-failed':
        link.emit('status', { key: 'core.encryptionFailed', params: { reason: String(notice.reason ?? 'error') } });
        return;
      case 'plaintext-held':
        link.emit('core-plaintext-held', { peer: notice.peer, id: notice.id });
        return;
      case 'encryption-state':
        link.emit('core-encryption-state', { peer: notice.peer, encrypted: Boolean(notice.encrypted) });
        return;
      case 'key-changed':
        link.emit('core-key-changed', { peer: notice.peer });
        return;
      case 'unverified-device':
        link.emit('core-unverified-device', { peer: notice.peer, device: notice.device, name: notice.name ?? '' });
        return;
      case 'sas-started':
        link.emit('core-sas-started', {
          transactionId: notice.transactionId,
          peer: notice.peer,
          device: notice.device,
        });
        return;
      case 'sas-code-ready':
        link.emit('core-sas-code-ready', {
          transactionId: notice.transactionId,
          peer: notice.peer,
          device: notice.device,
          emojiIndices: notice.emojiIndices,
          decimals: notice.decimals,
        });
        return;
      case 'device-keys-conflict':
        link.emit('core-device-keys-conflict', {});
        return;
      case 'sas-cancelled':
        link.emit('core-sas-cancelled', {
          transactionId: notice.transactionId,
          peer: notice.peer,
          device: notice.device,
          name: notice.name ?? '',
          reason: String(notice.reason ?? 'unknown'),
        });
        return;
      case 'device-verified':
        link.emit('core-device-verified', { peer: notice.peer, device: notice.device, name: notice.name ?? '' });
        return;
      case 'safety-code':
        link.emit('core-safety-code', {
          peer: notice.peer,
          status: String(notice.status ?? 'unavailable'),
          halves: Array.isArray(notice.halves) ? notice.halves : [],
          masterKey: String(notice.masterKey ?? ''),
          verified: Boolean(notice.verified),
        });
        return;
      case 'backup-created':
        link.emit('core-backup-created', { version: notice.version, recoveryKey: notice.recoveryKey });
        return;
      case 'backup-info':
        link.emit('core-backup-info', {
          version: notice.version,
          passphraseSalt: notice.passphraseSalt ?? null,
          sessionCount: notice.sessionCount ?? 0,
        });
        return;
      case 'backup-restored':
        link.emit('core-backup-restored', { version: notice.version, sessions: notice.sessions ?? 0 });
        return;
      case 'cross-signing-reset':
        link.emit('core-cross-signing-reset', {});
        return;
      case 'cross-signing-reset-failed':
        link.emit('core-cross-signing-reset-failed', { reason: String(notice.reason ?? 'refused') });
        return;
      case 'bad-frame':
        // Emitted, not said: the core reports a refused backup restore (wrong
        // key, no backup, …) this way, and only /backup restore, which knows a
        // restore is waiting, can tell that apart from a frame it could not read.
        link.emit('core-bad-frame', { reason: String(notice.reason ?? '') });
        return;
      case 'server-error':
        // The server's own refusals are said by link.js from the very frame
        // that caused it. `peer_outdated` is the core's, before the wire: a
        // device of the conversation reads only the inline form of an
        // attachment and this one does not fit a frame that way (R3).
        if (notice.code === 'peer_outdated') link.emit('status', { key: 'core.peerOutdated', params: {} });
        return;
      default:
        // Nothing else a notice can carry is for the terminal.
    }
  }

  // Text goes straight to the core, with or without a channel: the core queues
  // it durably while offline, which link.js's `conn`-based send cannot. `null`
  // means "not handed over", exactly as before, so the caller's own fallback
  // still applies.
  link.send = (text, _ts, id = newMessageId()) => {
    const to = link.getPeer();
    if (closed || !to) return null;
    try {
      client.sendText(id, to, text);
    } catch {
      return null;
    }
    track(id, to);
    return id;
  };

  // Replies, forwards, voice notes, pictures and edits go through the core as
  // well, so a sealed conversation carries them inside the ciphertext. Absent
  // from a native module built before they existed (`typeof` is the detect):
  // the terminal then keeps the open frames it always used.
  if (typeof client.sendWith === 'function') {
    link.sendWith = (text, options = {}, id = newMessageId()) => {
      const to = link.getPeer();
      if (closed || !to) return null;
      // Tracked before the call: a refusal can come back before it returns, and
      // one with no owner loses the id it names.
      track(id, to);
      try {
        // `undefined` fields (a reply with no `media`) are dropped here: the
        // native side reads `null` and absent alike, and nothing else.
        client.sendWith(id, to, text, JSON.parse(JSON.stringify(options ?? {})));
      } catch {
        provisional.delete(id);
        return null;
      }
      return id;
    };
  }
  if (typeof client.editText === 'function') {
    link.editText = (target, text, id = newMessageId()) => {
      const to = link.getPeer();
      if (closed || !to) return null;
      track(id, to);
      try {
        client.editText(id, to, target, text);
      } catch {
        provisional.delete(id);
        return null;
      }
      return id;
    };
  }

  link.isCore = true;
  // Where a store from an earlier sign-in was moved, for the terminal to say.
  link.retiredStore = retired;
  link.conversation = (to, limit = 200, before = null) => client.conversation(to, limit, before);
  link.retry = (to, id) => {
    client.retry(to, id);
  };
  link.sendUnencrypted = (to, id) => {
    client.sendUnencrypted(to, id);
  };
  link.acceptPeerKey = (to) => {
    client.acceptPeerKey(to);
  };
  link.startSas = (to, device) => {
    client.startSas(to, device);
  };
  // One request to several devices; absent from a native module built before
  // it existed, and `e2ee-commands.js` then asks the first device alone.
  if (typeof client.startSasAny === 'function') {
    link.startSasAny = (to, devices) => {
      client.startSasAny(to, devices);
    };
  }
  link.confirmSas = (transactionId) => {
    client.confirmSas(transactionId);
  };
  link.cancelSas = (transactionId) => {
    client.cancelSas(transactionId);
  };
  link.verifyWithQr = (qr) => {
    client.verifyWithQr(qr);
  };
  // The safety code; absent from a native module built before it existed,
  // and /safety then says the code is not available here.
  if (typeof client.safetyCode === 'function') {
    link.safetyCode = (to) => {
      client.safetyCode(to);
    };
    link.confirmSafetyCode = (to, masterKey) => {
      client.confirmSafetyCode(to, masterKey);
    };
  }
  link.createBackup = (passphrase = null) => {
    client.createBackup(passphrase ?? null);
  };
  link.fetchBackup = () => {
    client.fetchBackup();
  };
  link.restoreBackupWithRecoveryKey = (recoveryKey) => {
    client.restoreBackupWithRecoveryKey(recoveryKey);
  };
  link.restoreBackupWithPassphrase = (passphrase, salt) => {
    client.restoreBackupWithPassphrase(passphrase, salt);
  };
  // The password goes to the core and from there, once, to the server; nothing
  // here keeps it.
  link.resetCrossSigning = (password) => {
    client.resetCrossSigning(password);
  };
  const baseReconnect = link.reconnect;
  link.reconnect = () => {
    const result = baseReconnect();
    if (!closed) {
      try {
        client.reconnect();
      } catch {
        // stopped
      }
    }
    return result;
  };

  const baseStop = link.stop;
  link.stop = () => {
    baseStop();
    if (closed) return;
    closed = true;
    client.close();
  };

  return link;
}
