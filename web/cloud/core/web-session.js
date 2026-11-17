// The browser on the core (stage 7), behind a flag: the page's twin of the
// terminal's `src/cloud/core-link.js`.
//
// app.js knows one transport — a WebSocket it dials in `connectSocket` and
// reads in `onmessage`. This module hands it a WebSocket-shaped object instead
// (`connect()`), whose bytes are routed through the core by the shared table in
// `routing.js`: the core owns the real socket, the IndexedDB store, the send
// queue (⧗ → ✓ → ✓✓ → ⚠), the receipts and the account feed; everything the
// core does not own (presence, typing, hello, AI, roster, read-accepted, the
// live transcript) reaches app.js exactly as it did off the wire.
//
// What the core learned that app.js cannot see on the wire comes out as
// `onEvent(notice)` — the driver's own notices (`tailchat_net::json`), minus
// the four this module consumes (`connection`, `frame`, `raw-dropped`,
// `action-refused`), plus two of its own:
//
//   { kind: 'refused', peer, id, reason }   a send never made it into the queue
//   { kind: 'held', peer, id }              a send reused an id the core holds
//
// Plain ES module, no DOM: the browser and the Node tests load the same file.

import { openCore } from './core-client.js';
import {
  inboundKind, ownsInbound, rememberRawSent, routeOutbound,
} from './routing.js';

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

// Sends handed to the core and not yet confirmed (`message-added`). A refusal
// that names one was a send whose row must come back off the screen.
const PROVISIONAL_LIMIT = 256;

/**
 * The WebSocket app.js believes it dials: `onopen`/`onmessage`/`onclose`/
 * `onerror`, `readyState`, `send`, `close`, `bufferedAmount`. It is only ever as
 * open as the core's connection is, and closes when that closes — app.js's own
 * redial then asks for the next one.
 */
export class CoreSocket {
  #route;

  constructor(route) {
    this.#route = route;
    this.readyState = CONNECTING;
    this.bufferedAmount = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }

  // `replay`: what the server already said on this connection (its `ready` and
  // roster) for a socket that attached late. On a microtask: app.js assigns its
  // handlers right after `connect` returns.
  open(replay = []) {
    queueMicrotask(() => {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      this.onopen?.({ type: 'open' });
      for (const raw of replay) {
        if (this.readyState !== OPEN) return;
        this.onmessage?.({ type: 'message', data: raw });
      }
    });
  }

  receive(raw) {
    if (this.readyState === OPEN) this.onmessage?.({ type: 'message', data: raw });
  }

  send(text) {
    if (this.readyState !== OPEN) throw new Error('InvalidStateError: the socket is not open');
    this.#route(String(text));
  }

  // app.js giving up on this socket. The core's connection is the core's
  // business (it watches its own silence); a page that wants it redialled says
  // `reconnect()` on the session.
  close() {
    this.finish();
  }

  finish() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    queueMicrotask(() => this.onclose?.({ type: 'close', code: 1000 }));
  }
}

/**
 * The page side of one core session, without the wasm: routing, the socket
 * app.js holds, and the notices. `attach(client)` gives it the running
 * `WebClient` (or a stand-in in tests).
 */
export function createCoreBridge({ onEvent = () => {} } = {}) {
  let client = null;
  let state = 'connecting';
  let current = null;
  let ready = null;
  let roster = null;
  let closed = false;
  const rawSent = new Set();
  const provisional = new Map(); // id -> peer

  function live() {
    if (closed || !client) throw new Error('stopped: client is closed');
    return client;
  }

  function track(id, peer) {
    provisional.delete(id);
    provisional.set(id, peer);
    if (provisional.size > PROVISIONAL_LIMIT) provisional.delete(provisional.keys().next().value);
  }

  function dispatch(text) {
    if (closed || !client) return;
    const out = routeOutbound(text);
    if (out.route === 'swallow') return;
    if (out.route === 'text') {
      try {
        client.sendText(out.id, out.peer, out.text);
        track(out.id, out.peer);
        return;
      } catch {
        // A shape the core will not take is still the server's to judge.
      }
    }
    if (out.sent) rememberRawSent(rawSent, out.sent.id);
    try {
      client.sendRaw(text);
    } catch {
      // Stopped: nothing is left to write to.
    }
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
        // The server's own `error` frame follows as a frame notice; app.js
        // expires the session from it. The driver has stopped dialling.
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

  // A raw write refused while offline. Control frames are retried by their
  // owners; a raw message (a reply) is app.js's durable queue's to resend, so
  // it is only forgotten here.
  function onRawDropped(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame?.k === 'frame' && frame.d?.t === 'msg' && typeof frame.d.id === 'string') rawSent.delete(frame.d.id);
  }

  function onRefused({ peer, id, held, reason }) {
    const text = String(reason ?? 'refused');
    if (typeof id === 'string' && provisional.has(id)) {
      const owner = provisional.get(id);
      provisional.delete(id);
      const to = typeof peer === 'string' ? peer : owner;
      onEvent(held === true ? { kind: 'held', peer: to, id } : { kind: 'refused', peer: to, id, reason: text });
      return;
    }
    onEvent({ kind: 'refused', peer: null, id: typeof id === 'string' ? id : null, reason: text });
  }

  function notice(value) {
    if (closed || !value || typeof value !== 'object') return;
    switch (value.kind) {
      case 'connection':
        onConnection(value);
        return;
      case 'frame':
        onFrame(value.raw);
        return;
      case 'raw-dropped':
        onRawDropped(value.raw);
        return;
      case 'action-refused':
        onRefused(value);
        return;
      case 'message-added':
      case 'receipt':
        provisional.delete(value.id);
        onEvent(value);
        return;
      default:
        onEvent(value);
    }
  }

  return {
    notice,
    attach(value) {
      client = value;
    },
    get client() {
      return client;
    },
    get state() {
      return state;
    },
    /** A fresh socket for app.js; open now if the core already is. */
    connect() {
      const socket = new CoreSocket(dispatch);
      current = socket;
      if (state === 'open' || state === 'ready') {
        socket.open(state === 'ready' ? [ready, roster].filter(Boolean) : []);
      }
      return socket;
    },
    /**
     * Text straight into the core's durable queue, with or without a live
     * connection. Returns false when the core would not take it, so the caller
     * keeps its own fallback.
     */
    sendText(peer, id, text) {
      if (closed || !client) return false;
      try {
        client.sendText(id, peer, text);
      } catch {
        return false;
      }
      track(id, peer);
      return true;
    },
    /**
     * A reply, a forward, a picture or a voice note: `options` is
     * `{image?, replyTo?, forwardedFrom?, voice?}` (`tailchat_net::json::send_with`).
     * In a sealed conversation every part of it travels inside the ciphertext.
     * Like `sendText`, false means the core would not take it — a core older
     * than the call, or options it refused — and the caller says so; it never
     * means "send the same thing in the open".
     */
    sendWith(peer, id, text, options = {}) {
      if (closed || !client || typeof client.sendWith !== 'function') return false;
      // Tracked before the call: a refusal can come back before it returns, and
      // one with no owner loses the id it names.
      track(id, peer);
      try {
        // `undefined` fields (a reply with no `media`) are not a value the
        // binding reads; JSON drops them the way a frame would.
        client.sendWith(id, peer, text, JSON.parse(JSON.stringify(options ?? {})));
      } catch {
        provisional.delete(id);
        return false;
      }
      return true;
    },
    /**
     * An edit of `target` under the new id `id`: in a sealed conversation the
     * core sends a carrier whose target is inside the ciphertext, otherwise the
     * open `edit` frame. False when the core would not take it.
     */
    editText(peer, id, target, text) {
      if (closed || !client || typeof client.editText !== 'function') return false;
      track(id, peer);
      try {
        client.editText(id, peer, target, text);
      } catch {
        provisional.delete(id);
        return false;
      }
      return true;
    },
    /** Whether this core has the sealed-action calls (a page cached before them has not). */
    get sealedActions() {
      return typeof client?.sendWith === 'function' && typeof client?.editText === 'function';
    },
    retry(peer, id) {
      client?.retry(peer, id);
    },
    // The encryption actions, under the names the terminal's core link uses,
    // so `e2ee-commands.js` drives either one. Each throws when the core has
    // stopped, and the command says so.
    isCore: true,
    startSas: (peer, device) => live().startSas(peer, device),
    startSasAny: (peer, devices) => live().startSasAny(peer, devices),
    confirmSas: (id) => live().confirmSas(id),
    cancelSas: (id) => live().cancelSas(id),
    acceptPeerKey: (peer) => live().acceptPeerKey(peer),
    safetyCode: (peer) => live().safetyCode(peer),
    confirmSafetyCode: (peer, masterKey) => live().confirmSafetyCode(peer, masterKey),
    createBackup: (passphrase = null) => live().createBackup(passphrase),
    fetchBackup: () => live().fetchBackup(),
    restoreBackupWithRecoveryKey: (key) => live().restoreBackupWithRecoveryKey(key),
    restoreBackupWithPassphrase: (passphrase, salt) => live().restoreBackupWithPassphrase(passphrase, salt),
    resetCrossSigning: (password) => live().resetCrossSigning(password),
    /** Rows of one conversation, oldest first (`tailchat_net::json::row`). */
    conversation(peer, limit = 200, beforeTs = undefined, beforeId = undefined) {
      if (!client) return [];
      try {
        return client.conversation(peer, limit, beforeTs, beforeId);
      } catch {
        return [];
      }
    },
    reconnect() {
      try {
        client?.reconnect();
      } catch {
        // stopped
      }
    },
    probe() {
      try {
        client?.probe();
      } catch {
        // stopped
      }
    },
    stop() {
      if (closed) return;
      closed = true;
      current?.finish();
      current = null;
      try {
        client?.stop();
      } catch {
        // already stopped
      }
    },
  };
}

/**
 * Loads the wasm, opens the account's IndexedDB store and starts the core.
 *
 * @param {object} options
 * @param {{login: string, token: string, socketUrl: string, httpBase: string, e2ee?: boolean, extraCaps?: string[]}} options.account
 * @param {object} options.wasm the initialised `pkg/tailchat_web.js` module
 * @param {{load(): Promise<string[]>, commit(entries): Promise<void>}} options.storage
 * @param {(notice: object) => void} [options.onEvent]
 */
export async function startWebCoreSession({ wasm, account, storage, onEvent, ...hostOptions }) {
  const bridge = createCoreBridge({ onEvent });
  const client = await openCore({ wasm, account, storage, onNotice: bridge.notice, ...hostOptions });
  bridge.attach(client);
  return bridge;
}

/**
 * Holds the account's core for this tab (Web Locks): the store is one per
 * account, and two drivers writing it would race. Resolves to the release
 * function; rejects at once when another tab already holds it, or when the
 * browser has no Web Locks to make that promise with.
 */
export function acquireCoreLock(login, locks = globalThis.navigator?.locks) {
  return new Promise((resolve, reject) => {
    if (!locks?.request) {
      reject(new Error('this browser has no Web Locks'));
      return;
    }
    locks.request(`tailchat-core:${login}`, { ifAvailable: true }, (lock) => {
      if (!lock) {
        reject(new Error('another tab runs the core for this account'));
        return undefined;
      }
      // Held until released: the lock lives as long as this promise is pending.
      return new Promise((release) => resolve(release));
    }).catch(reject);
  });
}

const SESSION_MARK_HEX = 32;

/**
 * The store's name for this account under this token. The server binds a
 * device id to the token's session, so a store made under another token holds
 * an account signed for a device the server no longer has: a new sign-in gets
 * a fresh store, and the old one is left as it was — never deleted, the same
 * rule as the terminal's `retireStaleCoreStore`. The token is never written
 * down, only a hash in the name.
 */
export async function coreStoreName(login, token, subtle = globalThis.crypto?.subtle) {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
  const mark = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, SESSION_MARK_HEX);
  return `${String(login).toLowerCase()}.${mark}`;
}
