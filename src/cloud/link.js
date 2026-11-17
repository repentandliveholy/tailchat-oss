import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { createConnection } from '../session.js';
import { DEFAULT_AI_NAME } from '../ai.js';
import { CLOUD_FRAME_MAX_CHARS } from './limits.js';
import { MEDIA_REF_CAP, frameAttachment } from './media-ref.js';

// The same schedule the P2P rendezvous uses, and for the same reason: a server
// that is down for an hour must not cost 3600 connection attempts, and a server
// that is merely restarting must be back within a second or two.
const RETRY_MS = 1000;
const RETRY_MAX_MS = 30_000;

// The server pings every socket on a 12s cycle and terminates one that
// misses a pong (src/cloud/server.js's `heartbeat`), so a genuinely alive
// link is never quiet for long: this client sees either a real frame or the
// low-level ping that heartbeat sends, at least that often. That guarantee
// only holds while both directions of the path actually work. A laptop that
// sleeps and wakes on a new Wi-Fi association, or a NAT/VPN hop that silently
// drops one direction, can leave `ws` believing the socket is still open —
// no 'close', no 'error', nothing — while the other side has already given up
// or can no longer be reached. Nothing then ever prompts a reconnect, and the
// person sees a stale transcript until they notice and run /reconnect by
// hand. `STALE_MS` is the upper bound on how long that can last: long enough
// that ordinary jitter across two heartbeat cycles never trips it, short
// enough that "I turned my laptop back on" is a matter of seconds, not
// minutes, before the queued messages and reactions are drained.
const STALE_MS = 35_000;
const WATCHDOG_MS = 10_000;

// Frames that arrived from the queue before the peer's own hello did. They
// cannot be handed to the session yet — it drops everything before a hello — and
// they must not be thrown away either, because they are exactly the messages
// somebody sent while this client was switched off. Bounded, because the peer
// controls how many there are.
const PENDING_LIMIT = 500;
// How long a queued message waits for the peer's own hello before the link
// gives up and admits it behind a stand-in. Long enough to cover the round trip
// through the relay, short enough that nobody watches a blank screen for it.
const HELLO_GRACE_MS = 1500;

const FILE_FRAME = /^file-/;

// Everything this client actually consumes. `durable-ack` is what makes
// `message-accepted` meaningful: a terminal's write reaching the socket
// proves nothing about the server having committed it, and the CLI uses
// that receipt (see `cli.js`'s cloud outbox) instead of the write.
// `addressed-send` lets a queued frame be addressed to the linked
// conversation without borrowing a subscription, and `sync-v1` /
// `sync-nudge-v1` are the account feed the terminal keeps its cached
// conversations in step with. Nothing is declared that `handle()` below
// does not turn into a real event.
//
// Exported because the native-core transport (`core-link.js`) authenticates
// on its own and must claim exactly what this module's `handle()` consumes.
export const CLIENT_CAPS = Object.freeze([
  'marked-unread-v1', 'reply-reminder-v1',
  'durable-ack', 'addressed-send', 'sync-v1', 'sync-nudge-v1', 'read-ack-v1',
]);

// What the classic transport claims on top: pictures and voice notes as
// references to `/api/media` (docs/specs/2026-11-03-history-media-refs.md).
// Not in CLIENT_CAPS, which the native core claims on this client's behalf
// (src/cloud/core-link.js): the core's codec reads a reference as no
// attachment at all and would store the message without it, so under
// TAILCHAT_CORE=1 the server keeps sending bytes until the core learns the
// shape (spec §10).
export const CLASSIC_CAPS = Object.freeze([...CLIENT_CAPS, MEDIA_REF_CAP]);

// Everything `createConnection` asks of a socket, over a channel that is not
// one: a WebSocket to the cloud server carrying frames for one conversation.
// Keeping this shape is what lets the whole client — receipts, files, typing,
// presence, the AI, the transcript — work over the cloud without a second
// implementation of the protocol living next to the first.
export class CloudSocket extends EventEmitter {
  #deliver;

  constructor({ deliver, remoteAddress = null }) {
    super();
    this.#deliver = deliver;
    // A plain field, not a getter: session.js reads `socket.writable` directly.
    this.writable = true;
    this.writableLength = 0;
    this.remoteAddress = remoteAddress;
    this.localAddress = null;
    this.localPort = null;
  }

  // The keepalive that matters here belongs to the WebSocket, which the server
  // pings every 30 seconds; there is no TCP option to set on this side.
  setKeepAlive() {}

  // `flushed()` writes an empty string purely to queue its callback, so an empty
  // write has to settle it rather than travel.
  write(chunk, callback) {
    if (!this.writable) {
      callback?.();
      return false;
    }
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    let ok = true;
    for (const line of text.split('\n')) {
      if (line === '') continue;
      if (!this.#deliver(line)) ok = false;
    }
    callback?.();
    return ok;
  }

  // Frames arrive from the server already parsed; the session's parser wants
  // them back as the newline-delimited text it was written for.
  push(frame) {
    if (!this.writable) return;
    this.emit('data', `${JSON.stringify(frame)}\n`);
  }

  destroy() {
    if (!this.writable) return;
    this.writable = false;
    this.emit('close');
  }
}

// Returns an object interchangeable with `startRendezvous`'s: the same events
// and the same methods, so src/cli.js only has to choose which one to build.
export function startCloudSession({
  url,
  token,
  name,
  peer,
  peerLabel = peer,
  connect = (target) => new WebSocket(target),
  retryMs = RETRY_MS,
  retryMaxMs = RETRY_MAX_MS,
  staleMs = STALE_MS,
  watchdogMs = WATCHDOG_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const ev = new EventEmitter();

  // What the deployment announced on `ready`, kept live across reconnects.
  const caps = new Set();

  let ws = null;
  let socket = null;
  let conn = null;
  let timer = null;
  let delay = retryMs;
  let stopped = false;
  let standingDown = false;
  let dialling = false;
  let linked = false;        // authorised and subscribed: the cloud will take a frame
  let peerHere = false;      // the server says the other account has a connection
  let online = false;        // a hello has been exchanged with a peer who is here
  let helloSeen = false;
  let helloName = null;
  let helloVersion = null;
  let label = peerLabel;
  let pending = [];
  // Set while queued frames are being held for a hello that the peer is
  // expected to send; see `admit`.
  let helloWait = null;
  // Last time anything genuinely arrived from the server on the current
  // socket — a parsed message or a transport-level ping. Reset whenever a
  // fresh `ws` is opened so a slow-but-honest handshake is never mistaken
  // for staleness before it has had a chance to prove itself.
  let lastSeen = Date.now();
  let watchdogTimer = null;

  const status = (key, params = {}) => ev.emit('status', { key, params });

  function sendControl(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }

  function deliver(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return false; // nothing we wrote is unparseable; a corrupt line is not sent
    }
    // A file into a peer who is not there is bytes into a void: the server keeps
    // messages for later, deliberately not transfers. Refusing here is what turns
    // that into one honest line instead of a progress bar that lies.
    if (!peerHere && FILE_FRAME.test(String(frame.t))) return false;
    return sendControl({ k: 'frame', to: peer, d: frame });
  }

  function closeChannel() {
    if (!conn) return;
    // Detached first: the destroy below would otherwise arrive as a peer that
    // went away, and the only thing that decides that here is the server.
    conn.removeAllListeners();
    socket.destroy();
    conn = null;
    socket = null;
  }

  function goOnline() {
    if (!peerHere) return;
    if (online) return;
    online = true;
    // No address to name: the route is the server, and the peer's own is none of
    // this client's business. src/cli.js reads a null address as "nothing to
    // whois" and says nothing rather than inventing a device name.
    ev.emit('online', { peerName: helloName ?? label, peerVersion: helloVersion, remoteAddress: null });
  }

  function goOffline() {
    if (!online) return;
    online = false;
    ev.emit('offline', {});
  }

  function clearHelloWait() {
    if (!helloWait) return;
    clearTimeout(helloWait);
    helloWait = null;
  }

  function openChannel() {
    // Queue frames may arrive before `subscribed`; they deliberately survive
    // this replacement until the peer hello makes the session admit them.
    closeChannel();
    clearHelloWait();
    helloSeen = false;
    online = false;
    helloName = null;
    helloVersion = null;
    socket = new CloudSocket({ deliver, remoteAddress: hostOf(url) });
    conn = createConnection(socket, {
      name,
      connId: crypto.randomBytes(16).toString('hex'),
      initiatedByMe: true,
      // Not the P2P ceiling: this channel carries the cloud protocol, where a
      // picture or a voice note rides inline on the message frame as a base64
      // data URL and the server itself accepts up to CLOUD_FRAME_MAX_CHARS
      // (src/cloud/hub.js relays it verbatim). Left at the 256 KiB default, the
      // parser read every such frame as an overflow: the media was dropped and
      // the channel with it, which is why media sent from the browser never
      // appeared in the terminal — and why nothing the terminal sent back
      // could be larger either.
      maxFrameChars: CLOUD_FRAME_MAX_CHARS,
    });
    conn.on('hello', ({ peerName, peerVersion }) => {
      clearHelloWait();
      helloSeen = true;
      helloName = peerName;
      helloVersion = peerVersion;
      flushPending();
      goOnline();
    });
    for (const kind of [
      'message', 'ai', 'ack', 'read', 'del', 'edit', 'react', 'typing', 'actions', 'focus', 'wake', 'logo', 'holiday',
      'caps', 'update', 'devices', 'ping', 'pong', 'bye',
      'file-offer', 'file-chunk', 'file-done', 'file-deny',
    ]) {
      conn.on(kind, (payload) => ev.emit(kind, payload));
    }
    conn.on('protocol-error', ({ reason }) => status('cloud.protocolError', { reason }));
    // The session drops its own channel when a frame breaks the protocol, and
    // every deliberate replacement here goes through `closeChannel`, which
    // detaches these listeners first — so a 'close' arriving here is always
    // that unilateral teardown. Ignoring it wedged the link for good: `conn`
    // stayed set while the socket under it was unwritable, so `CloudSocket`
    // swallowed every later inbound frame and refused every outbound one until
    // some presence flip happened to rebuild the channel. Rebuilding it here,
    // and replaying the hello this side had already accepted, restores both
    // directions at once — and does it without a stand-in hello, which would
    // blank out the peer's known version.
    conn.on('close', () => {
      conn = null;
      socket = null;
      if (stopped || standingDown || !ws) return;
      const resume = helloSeen ? { name: helloName ?? label, v: helloVersion } : null;
      openChannel();
      if (resume) socket.push({ t: 'hello', name: resume.name, connId: 'cloud', v: resume.v });
    });
  }

  function flushPending() {
    if (pending.length === 0) return;
    const held = pending;
    pending = [];
    for (const frame of held) socket?.push(frame);
  }

  // A message from the queue has no hello in front of it: hellos are not kept,
  // because a hello from an hour ago says nothing true about now. So hold such
  // frames until either the peer's own hello arrives — they are here after all —
  // or the server confirms they are not, in which case a stand-in hello lets the
  // session accept what was sent while this client was off.
  function standInHello() {
    if (helloSeen) return;
    helloSeen = true;
    socket?.push({ t: 'hello', name: label, connId: 'cloud', v: null });
  }

  function admit(frame) {
    if (!conn) openChannel();
    if (!helloSeen && frame.t !== 'hello') {
      // `createConnection` accepts exactly one hello per channel and ignores
      // every later one, so whichever hello arrives first decides what this
      // side believes about the peer for the rest of the session. Pushing the
      // stand-in the moment a queued message shows up therefore locked the
      // peer's version at null even when their real hello was a few
      // milliseconds behind — which is what made the CLI tell people running
      // the current web build to go and update it.
      //
      // So when the server says the peer is there, the frame waits for the
      // hello that is genuinely coming. The timer is the safety net: a peer
      // who is connected but reading another conversation never greets us at
      // all, and their messages must still arrive.
      if (peerHere) {
        if (pending.length >= PENDING_LIMIT) pending.shift();
        pending.push(frame);
        if (!helloWait) {
          helloWait = setTimeout(() => {
            helloWait = null;
            if (helloSeen) return;
            standInHello();
            flushPending();
            goOnline();
          }, HELLO_GRACE_MS);
          helloWait.unref?.();
        }
        return;
      }
      standInHello();
    }
    socket.push(frame);
  }

  function admitAbsentPeer() {
    if (pending.length === 0 || helloSeen) return;
    // The server has confirmed there is nobody on the other end, so no real
    // hello is coming and the queue is released behind the stand-in.
    clearHelloWait();
    standInHello();
    flushPending();
  }

  // The relay's answer to "is that account online?" — the same fact the
  // roster's green dot is drawn from, and by itself enough to say so. The
  // peer's hello is an identity exchange (name, version, which frames they can
  // be sent), not a liveness signal: a client sitting in another conversation
  // never greets us at all, and one whose greeting crossed us before this side
  // was even connected had it dropped, since the server keeps no hello. Gating
  // «online» on that hello therefore left the header saying «connecting…»
  // about a contact the roster showed as online — and about one it plainly
  // showed as away, which `reaching` cannot repaint here either: by the time
  // it arrives the link is up and that handler returns early.
  function reportPresence(present) {
    ev.emit('present', { present, peerName: helloName ?? label });
  }

  function setPeerHere(next) {
    if (next === peerHere) return;
    peerHere = next;
    if (next) {
      status('cloud.peerHere', { peer: label });
      // A newly subscribed or returning peer gets a fresh hello after the
      // server has made the subscription routable.
      openChannel();
      ev.emit('reaching', { active: true });
      reportPresence(true);
      return;
    }
    status('cloud.peerAway', { peer: label });
    goOffline();
    reportPresence(false);
    // Nothing is coming from a peer who has left, so anything still waiting for
    // their hello is released behind the stand-in instead of being held for a
    // greeting that will not arrive until they are back.
    clearHelloWait();
    helloSeen = false;
    if (pending.length > 0) {
      standInHello();
      flushPending();
    }
  }

  function rememberUsers(users) {
    if (!Array.isArray(users)) return;
    const found = users.find((user) => user?.login === peer);
    if (!found) return;
    // The alias is this account's own private nickname for the contact (issue
    // #28), so it outranks the name the contact chose for itself — the rosters
    // the server sends only carry it here, in the owner's own copy.
    const shown = found.alias || found.name;
    if (typeof shown === 'string' && shown !== '') label = shown;
  }

  function handle(message) {
    switch (message?.k) {
      case 'ready':
        rememberUsers(message.users);
        // What the deployment says it implements, kept so a caller can gate on
        // it instead of guessing (`cli.js` checks `durable-ack` before it trusts
        // an acceptance that an older server would never send).
        caps.clear();
        for (const cap of Array.isArray(message.caps) ? message.caps : []) {
          if (typeof cap === 'string') caps.add(cap);
        }
        if (peer) {
          sendControl({ k: 'subscribe', peer });
          openChannel();
        }
        return;
      case 'subscribed': {
        // Walking the roster with Ctrl+←/→ puts several subscribes on the wire
        // before the first ack comes back. An ack for a conversation already
        // left would otherwise decide `peerHere`, the focus state and the
        // release of held frames for the conversation now open: the previous
        // peer's presence shown under the current peer's name, and their
        // queued frames let into this thread.
        const acked = typeof message.peer === 'string' ? message.peer.toLowerCase() : '';
        if (acked !== '' && acked !== String(peer ?? '').toLowerCase()) return;
        linked = true;
        dialling = false;
        delay = retryMs;
        status('cloud.linked', {});
        // Order matters: the server flushed the queue before this frame, so the
        // stand-in hello has something to admit.
        if (message.online) {
          setPeerHere(true);
          if (typeof message.state === 'string') ev.emit('focus', { state: message.state });
          return;
        }
        admitAbsentPeer();
        status('cloud.peerAway', { peer: label });
        // An answer in its own right, not only a transition: switching from one
        // absent peer to another has to leave the header saying OFFLINE rather
        // than whatever the previous conversation left it at. `reaching` below
        // cannot do it over the relay — the link is up by now, so src/cli.js's
        // handler for it returns early.
        reportPresence(false);
        ev.emit('reaching', { active: false });
        return;
      }
      case 'frame':
        // A sealed edit's carrier reaches a client without the core as a
        // stub bubble ("update the app") carrying the server's `sealedEdit`
        // flag. It says nothing a person can read, so it is neither a
        // message, an unread nor a notification.
        if (message.d?.sealedEdit === true) return;
        if (message.self) {
          // The server's AI bridge answers *as* the owner account, so its reply
          // comes back down this socket wearing the same `self` flag as a
          // message the owner really did write on another device. Treating the
          // two alike is what made tailik's answers appear in the transcript
          // signed with the owner's own name — so the AI frame is separated
          // out here and handed to the `ai` listener, which exists precisely to
          // show a third voice as a third voice.
          if (message.d?.t === 'ai') {
            ev.emit('ai', {
              id: message.d?.id,
              // A server too old to name the model still produced one, and an
              // unsigned line is worse than one signed with the default.
              name: message.d?.name || DEFAULT_AI_NAME,
              text: message.d?.text || '',
              ts: message.d?.ts || Date.now(),
            });
            return;
          }
          if (message.d?.t === 'msg') {
            ev.emit('sync-outgoing', {
              id: message.d?.id,
              text: message.d?.text || '',
              ts: message.d?.ts || Date.now(),
              // A picture or a voice note the account sent from another device
              // rides on the frame the same way it does for the recipient.
              // Dropping it here is why a voice note recorded in the browser
              // reached the owner's own terminal as its caption and nothing
              // else — no card, no waveform, no file to open.
              image: frameAttachment(message.d?.image),
              voice: frameAttachment(message.d?.voice),
            });
          }
          // An edit or a delete on one of this account's own other devices
          // must land exactly the way the same mutation would coming from
          // the peer — no "outgoing echo" distinction the way msg/ai need
          // (nothing here renders a duplicate of a message this client
          // already shows optimistically). So, unlike those two, this falls
          // through to the ordinary parser instead of a bespoke event:
          // `admit()` is what already turns a wire frame into the `edit`/
          // `del` events src/cli.js listens for, regardless of who
          // authored the message being changed. `message.from === peer` is
          // a belt-and-braces check — the server's `selfSync` (hub.js) only
          // ever delivers this to a connection already subscribed to
          // exactly this peer, so it always holds in practice.
          if ((message.d?.t === 'edit' || message.d?.t === 'del') && message.from === peer) {
            admit(message.d);
          }
          return;
        }
        if (message.from !== peer) {
          if ((message.d?.t === 'msg' || message.d?.t === 'ai') && message.d?.text) {
            ev.emit('unread', {
              from: message.from,
              text: message.d.text,
              ts: message.d?.ts || Date.now(),
            });
          }
          return;
        }
        admit(message.d ?? {});
        return;
      case 'unread':
        if (message.text) {
          ev.emit('unread', {
            from: message.from,
            text: message.text,
            ts: message.ts || Date.now(),
            // The server's absolute count for that sender's whole queue, not
            // an increment: a client counting its own +1s on top of a snapshot
            // it never had drifts away from the roster everything else shows.
            // Absent on the envelope synthesised above from a live frame for
            // another conversation, where the client's own tally is all there is.
            count: Number.isFinite(message.count) ? message.count : undefined,
          });
        }
        return;
      // Account-local: this account reacted from another of its own
      // devices (see hub.js's `syncReact`). Relevant only while this link is
      // actually subscribed to the same conversation the reaction happened
      // in — nothing local holds a message from any other conversation to
      // apply it to.
      case 'react-sync':
        if (message.peer !== peer) return;
        if (typeof message.id === 'string' && message.id !== ''
          && typeof message.emoji === 'string' && message.emoji !== ''
          && typeof message.by === 'string' && message.by !== '') {
          ev.emit('react', { id: message.id, emoji: message.emoji, by: message.by, add: message.add !== false });
        }
        return;
      case 'presence':
        if (message.peer !== peer) return;
        setPeerHere(Boolean(message.online));
        if (typeof message.state === 'string') ev.emit('focus', { state: message.state });
        if (!message.online) admitAbsentPeer();
        return;
      case 'read-sync':
        if (typeof message.peer === 'string' && message.peer !== '') {
          ev.emit('read-sync', { peer: message.peer, id: message.id || '', readTs: message.readTs || 0 });
        }
        return;
      case 'read-accepted':
        if (typeof message.peer === 'string' && Number.isFinite(message.readTs)) {
          ev.emit('read-accepted', { peer: message.peer, id: message.id, readTs: message.readTs });
        }
        return;
      // The server's proof that a message of this account's is committed —
      // `message-accepted` is sent for every accepted `msg`/`ai`, and from a
      // capability server it is the only honest end to a queued send. Passing
      // it on rather than swallowing it: the owner of the outbox is `cli.js`,
      // not this transport.
      case 'message-accepted':
        if (typeof message.id === 'string' && message.id !== '') {
          ev.emit('accepted', {
            peer: message.peer || null,
            id: message.id,
            ts: Number.isFinite(message.ts) ? message.ts : null,
            seq: Number.isFinite(message.seq) ? message.seq : null,
          });
        }
        return;
      // The account feed. Both envelopes are forwarded untouched: what to do
      // with an event is a question about the terminal's own caches, which this
      // layer knows nothing about.
      case 'sync-page':
        ev.emit('sync-page', {
          events: Array.isArray(message.events) ? message.events : [],
          cursor: Number.isFinite(message.cursor) ? message.cursor : 0,
          more: message.more === true,
          reset: message.reset === true,
        });
        return;
      case 'sync-nudge':
        ev.emit('sync-nudge', {});
        return;
      case 'reply-reminder-fired': {
        const reminder = message.reminder;
        if (!reminder || typeof reminder.id !== 'string' || typeof reminder.peer !== 'string'
          || typeof reminder.messageId !== 'string') return;
        ev.emit('reply-reminder', reminder);
        sendControl({ k: 'reply-reminder-ack', id: reminder.id });
        return;
      }
      case 'users':
        rememberUsers(message.users);
        if (Array.isArray(message.users)) ev.emit('users', { users: message.users });
        return;
      case 'error':
        if (message.code === 'auth_failed' || message.code === 'auth_required') {
          // Retrying a rejected token is a loop that cannot end well. Say it
          // once and stop dialling; `--cloud-logout` is the way back.
          standingDown = true;
          status('cloud.tokenRejected', {});
          return;
        }
        if (message.code === 'peer_not_found') {
          // About one conversation, not about this account: the server refused
          // to move the subscription and kept the one it already had, so every
          // other conversation is still reachable. Standing the whole link down
          // here — as this did — meant that conversation cost the session its
          // redial: the next socket drop (a redeploy, or the memory-ceiling
          // restart PM2 performs) was never recovered, and the terminal sat
          // offline until it was restarted by hand. A refused name is worth a
          // line, not the connection.
          status('cloud.peerUnknown', { peer });
          return;
        }
        status('cloud.serverError', { code: String(message.code ?? 'error') });
        return;
      default:
        return; // an older or newer server may say more than this client knows
    }
  }

  function down() {
    ws = null;
    linked = false;
    dialling = false;
    goOffline();
    closeChannel();
    peerHere = false;
    helloSeen = false;
    if (stopped || standingDown) return;
    status('cloud.linkLost', {});
    ev.emit('reaching', { active: false });
    timer = setTimer(open, delay);
    timer?.unref?.();
    delay = Math.min(delay * 2, retryMaxMs);
  }

  function open() {
    timer = null;
    if (stopped || standingDown || ws) return;
    dialling = true;
    ev.emit('reaching', { active: true });
    let candidate;
    try {
      candidate = connect(url);
    } catch (error) {
      dialling = false;
      status('cloud.linkFailed', { error: error?.message ?? 'error' });
      timer = setTimer(open, delay);
      timer?.unref?.();
      delay = Math.min(delay * 2, retryMaxMs);
      return;
    }
    lastSeen = Date.now();
    ws = candidate;
    ws.on('open', () => sendControl({ k: 'auth', token, caps: [...CLASSIC_CAPS] }));
    ws.on('message', (data) => {
      lastSeen = Date.now();
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return; // a frame we cannot read is a frame we cannot act on
      }
      handle(message);
    });
    // The server's heartbeat ping (src/cloud/server.js) is answered
    // automatically by `ws` — this listener only observes it, it does not
    // replace that auto-pong. It is the one thing guaranteed to arrive every
    // ~12s on a socket that still actually reaches the server, which is
    // exactly what `checkStale` below needs on a link nobody is talking on.
    ws.on('ping', () => { lastSeen = Date.now(); });
    ws.on('close', () => { if (ws === candidate) down(); });
    // 'close' always follows, and it carries the reconnect; an error handler is
    // here only because an unhandled 'error' on a socket is a process-level throw.
    ws.on('error', () => {});
  }

  // Independent of the server's own heartbeat: that one detects a dead
  // *client* from the server's side and only helps here if the resulting
  // `terminate()` actually reaches this process. A socket this side believes
  // is open but that nothing has arrived on in too long is terminated
  // locally instead of waited out — `ws.on('close')` above then runs the
  // ordinary reconnect exactly as if the server had dropped it.
  function checkStale() {
    watchdogTimer = null;
    if (stopped) return;
    if (ws && !standingDown && Date.now() - lastSeen > staleMs) {
      try { ws.terminate(); } catch { /* already gone */ }
    }
    watchdogTimer = setTimer(checkStale, watchdogMs);
    watchdogTimer?.unref?.();
  }

  open();
  watchdogTimer = setTimer(checkStale, watchdogMs);
  watchdogTimer?.unref?.();

  ev.send = (text, ts = Date.now(), id = undefined) => (
    conn ? conn.send(text, ts, ...(id === undefined ? [] : [id])) : null
  );
  const canSendFrame = (frame) => peerHere || !FILE_FRAME.test(String(frame?.t ?? ''));
  ev.sendFrame = (frame) => (conn && canSendFrame(frame) ? conn.sendFrame(frame) : false);
  ev.sendReceipt = (kind, id) => (conn ? conn.sendReceipt(kind, id) : false);
  ev.markRead = (targetPeer = peer) => (targetPeer ? sendControl({ k: 'mark-read', peer: targetPeer }) : false);
  ev.markUnread = (targetPeer = peer) => (targetPeer ? sendControl({ k: 'mark-unread', peer: targetPeer }) : false);
  // The account feed is asked for the same way the mobile client asks for it: a
  // cursor and a page size, answered with `sync-page`. Not rate limited
  // server-side (`receive` in hub.js), because a client that fell a long way
  // behind pages through its log as fast as it can read it.
  ev.sendSync = (since = 0, limit = 200) => sendControl({ k: 'sync', since, limit });
  // Live view of what the server announced on `ready`, mutated in place on every
  // (re)connect: a caller that reads it at send time cannot act on a capability
  // from a socket that is already gone.
  ev.caps = caps;
  ev.scheduleReplyReminder = (targetPeer, messageId, dueAt) => (
    targetPeer && messageId && Number.isFinite(dueAt)
      ? sendControl({ k: 'reply-reminder', peer: targetPeer, messageId, dueAt })
      : false
  );
  ev.sendPing = (id, ts) => (conn ? conn.sendPing(...(id === undefined ? [] : [id, ts])) : null);
  ev.writeFrame = (frame) => (conn && canSendFrame(frame) ? conn.writeFrame(frame) : false);
  // The CLI uses this for file-transfer backpressure. Ordinary messages go
  // through send()/sendFrame() and remain queueable while the peer is absent.
  ev.writable = () => Boolean(conn && linked && peerHere);
  ev.flushed = () => (conn ? conn.flushed() : Promise.resolve());
  ev.isOnline = () => Boolean(conn && linked);
  ev.isDialling = () => dialling;
  ev.peerOnline = () => peerHere;
  ev.boundPort = () => null; // nothing is listening: the server does the reaching
  ev.target = () => ({ host: peer, port: 0 });
  ev.targets = () => [ev.target()];
  ev.setTarget = () => {};
  ev.setTargets = () => {};
  ev.refreshAllowed = () => {};
  ev.retryDelay = () => delay;
  ev.activeSocket = () => socket;
  ev.reconnect = () => {
    if (stopped) return;
    standingDown = false;
    delay = retryMs;
    if (timer) clearTimer(timer);
    timer = null;
    if (ws) {
      const going = ws;
      ws = null;
      try {
        going.close();
      } catch { /* already gone */ }
      goOffline();
      closeChannel();
      linked = false;
    }
    open();
  };
  ev.getPeer = () => peer;
  ev.switchPeer = (newPeer, newPeerLabel = newPeer) => {
    const changed = newPeer !== peer;
    peer = newPeer;
    label = newPeerLabel;
    goOffline();
    closeChannel();
    peerHere = false;
    helloSeen = false;
    // Frames still waiting for a hello belong to the conversation being left.
    // `openChannel` keeps `pending` across a channel replacement on purpose —
    // a queue replay must survive the channel the subscription rebuilds — but
    // across a *peer* change that same rule handed the old thread's messages
    // to the new channel the moment the new peer greeted us, printed under
    // the new peer's name. Dropping them loses nothing: the server re-drains
    // that conversation's queue on the next subscribe to it.
    if (changed) {
      clearHelloWait();
      pending = [];
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      // No peer is the hub's unsubscribe (`k:'subscribe'` with an empty peer).
      // Leaving it unsent kept this connection registered as an active viewer
      // of the conversation just closed, so everything that peer said
      // afterwards was routed here as live traffic — dropped by the detached
      // transport and never queued, never counted as unread, never seen.
      sendControl({ k: 'subscribe', peer: peer || '' });
      if (peer) openChannel();
    }
  };
  ev.standDown = () => {
    standingDown = true;
    if (timer) clearTimer(timer);
    timer = null;
  };
  ev.stop = () => {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
    if (watchdogTimer) clearTimer(watchdogTimer);
    watchdogTimer = null;
    clearHelloWait();
    closeChannel();
    if (ws) {
      try {
        ws.close();
      } catch { /* already gone */ }
      ws = null;
    }
  };
  return ev;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
