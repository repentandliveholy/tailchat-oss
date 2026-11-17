import net from 'node:net';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createConnection } from './session.js';
import { normalizeIp } from './addr.js';

const RETRY_MS = 1000;
// A peer switched off for an hour was costing 3600 connect attempts. The delay
// grows instead, and that is safe because the rendezvous is symmetric: our
// listener stays up, so a peer coming back reaches us on its own first attempt
// without waiting for ours.
const RETRY_MAX_MS = 30_000;
const HELLO_MS = 5000;
// A socket is accepted long before we know whether we are allowed to talk to it,
// and finding out means asking the Tailscale daemon. A daemon that never answers
// used to leave every socket it was asked about open for the rest of the
// session, so the question is given a deadline of its own.
const AUTH_MS = 5000;
// One status line per rejected source is the point of remembering them at all,
// but a scanner walking a /24 would otherwise leave us holding every address it
// ever probed until the process exits.
const REJECTION_MEMORY = 64;

export function connIdWins(a, b) {
  return a < b; // lexicographically smaller connId wins the dedup
}

// Pure, order-independent channel selection. Both peers run this identically;
// a physical channel's connId is the same on both ends, so min(connId) selects
// the same physical channel on both sides — no split, no leader protocol needed.
//
// One exception: a candidate from a *different* address is another device of the
// same person, not a duplicate of this channel. Deduplicating those by connId
// would pick a winner at random and could kill the session the user just opened,
// so the newcomer takes over and the old device is told it was replaced.
export function arbitrate(state, cand) {
  const { active, activeConnId, activeAddress = null } = state;
  if (!active) {
    return { active: cand.conn, activeConnId: cand.connId, destroy: [], event: 'online' };
  }
  if (cand.conn === active) {
    return { active, activeConnId, destroy: [], event: null };
  }
  const candAddress = cand.address ?? null;
  if (activeAddress && candAddress && candAddress !== activeAddress) {
    return {
      active: cand.conn,
      activeConnId: cand.connId,
      destroy: [active],
      event: 'replaced',
    };
  }
  if (connIdWins(cand.connId, activeConnId)) {
    return { active: cand.conn, activeConnId: cand.connId, destroy: [active], event: 'swap' };
  }
  return { active, activeConnId, destroy: [cand.conn], event: null };
}

const randomId = () => crypto.randomBytes(16).toString('hex');

export function dedupeTargets(candidates, defaultPort) {
  const unique = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const host = String(candidate?.host ?? '').trim();
    const port = Number(candidate?.port ?? defaultPort);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    const key = JSON.stringify([normalizeIp(host).toLowerCase(), port]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ host, port });
  }
  return unique;
}

function describeTarget(target) {
  if (!target || !target.host) return '';
  const host = String(target.host);
  const port = target.port ?? 49878;
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

export function isInboundAllowed(ip, allow) {
  return allow.has(ip);
}

// Records a rejected source and answers whether it is worth reporting. The set
// is bounded because it is fed by whoever dials us, which is not something we
// control; a Set keeps insertion order, so the first key is the oldest and goes
// first. An address that ages out can be reported once more later, which is a
// far better failure than an ever-growing set of addresses nobody will read.
export function rememberRejection(seen, ip, limit = REJECTION_MEMORY) {
  if (seen.has(ip)) return false;
  seen.add(ip);
  while (seen.size > limit) seen.delete(seen.values().next().value);
  return true;
}

export function startRendezvous({
  peerHost,
  peerPort,
  bindAddr,
  peerTargets = [],
  port,
  name,
  // Injected so the caller can widen "who is my peer" from one address to one
  // Tailscale user without this module learning about Tailscale at all.
  resolveAllowed = null,
  verifyInbound = null,
  // Bounded so a stalled authority costs one socket, not the listener.
  authTimeoutMs = AUTH_MS,
}) {
  const ev = new EventEmitter();
  let stopped = false;
  // One reconnect loop owns every route. The last successful route comes first;
  // alternatives are exhausted without delay before a failed sweep earns the
  // existing exponential backoff.
  let targets = dedupeTargets([
    ...(Array.isArray(peerTargets) ? peerTargets : []),
    { host: peerHost, port: peerPort },
  ], peerPort);
  if (targets.length === 0) targets = [{ host: peerHost, port: peerPort }];
  let targetIndex = 0;
  let target = targets[0];
  let active = null;        // established connection (EventEmitter from session)
  let activeConnId = null;
  let outgoing = null;      // in-flight OUTGOING connection, pre-hello only
  let forceReconnect = false;

  // The header must say CONNECTING only while a call is genuinely open, and with
  // the backoff most of the wait is spent with nothing in flight at all. Routed
  // through one setter so the announcement cannot drift from the state.
  function setOutgoing(conn) {
    const was = Boolean(outgoing);
    outgoing = conn;
    if (Boolean(conn) !== was) ev.emit('reaching', { active: Boolean(conn) });
  }
  let retryTimer = null;
  let retryDelay = RETRY_MS;
  let listenTimer = null;
  let reportedPortTaken = false;
  // A client that lost the port must not dial either: two of us on one machine
  // would take the peer's channel from each other. It stays a listener in
  // waiting, and becomes a full participant the moment the port frees up.
  let dialling = true;
  let allow = new Set();
  let conns = new Set();    // every registered connection (inbound + outgoing)
  const reportedRejections = new Set(); // one line per rejected source, bounded
  const reportedAlternates = new Set(); // each route is named once, not every retry sweep

  function addTargets(candidates) {
    targets = dedupeTargets([...targets, ...(Array.isArray(candidates) ? candidates : [])], peerPort);
    target = targets[targetIndex] ?? targets[0] ?? target;
    return targets;
  }

  function promoteTarget(candidate) {
    targets = dedupeTargets([candidate, ...targets], peerPort);
    targetIndex = 0;
    target = targets[0];
    return target;
  }

  function replaceTargets(candidates) {
    targets = dedupeTargets([
      target,
      ...(Array.isArray(candidates) ? candidates : []),
      { host: peerHost, port: peerPort },
    ], peerPort);
    targetIndex = 0;
    target = targets[0];
    return targets;
  }

  async function resolveAllow() {
    if (resolveAllowed) {
      const ips = await resolveAllowed();
      allow = new Set([...ips].map(normalizeIp));
      addTargets([...allow].map((host) => ({ host, port: peerPort })));
      if (allow.size === 0) ev.emit('unresolved', { peer: peerHost });
      return;
    }
    try {
      const recs = await dns.lookup(peerHost, { all: true });
      allow = new Set(recs.map((r) => normalizeIp(r.address)));
      addTargets([...allow].map((host) => ({ host, port: peerPort })));
    } catch {
      // Cannot resolve → accept nothing this round; retries continue. Say so:
      // a silent forever-connecting screen hides a plain typo or a missing CLI.
      allow = new Set();
      ev.emit('unresolved', { peer: peerHost });
    }
  }

  // The one guarded way in. `resolveAllow` can reject — the injected resolver
  // shells out to the Tailscale CLI, and a daemon that is restarting fails the
  // call outright — and its callers are a fire-and-forget IIFE and a 'close'
  // handler, neither of which had anywhere to put a rejection. That made a peer
  // being briefly unreachable enough to kill the process with an unhandled
  // rejection, on the most travelled path in the module. A failed round now
  // admits nobody until the next one and says so, which is the same
  // conservative answer the DNS failure has always given.
  function refreshAllow() {
    return resolveAllow().catch(() => {
      allow = new Set();
      ev.emit('unresolved', { peer: peerHost });
    });
  }

  // A candidate's hello completed. Decide via arbitrate; NEVER pre-kill peers.
  function onCandidate(conn, channelConnId, peerName, peerVersion) {
    if (stopped) { conn.destroy(); return; }
    const previous = active;
    const r = arbitrate(
      {
        active,
        activeConnId,
        activeAddress: normalizeIp(active?.socket?.remoteAddress),
      },
      {
        conn,
        connId: channelConnId,
        address: normalizeIp(conn?.socket?.remoteAddress),
      },
    );
    active = r.active;
    activeConnId = r.activeConnId;
    if (r.event === 'replaced' && previous) {
      // Tell the displaced device why, so it stops trying to take the channel
      // back; otherwise the two devices would trade it every second.
      previous.sendFrame({ t: 'bye', reason: 'replaced' });
    }
    for (const c of r.destroy) c.destroy();
    if (r.event === 'online' || r.event === 'replaced') {
      stopRetry();             // stop only NEW retries; in-flight outgoing lives on
      retryDelay = RETRY_MS;   // a working channel earns a fast retry next time
      const remoteAddress = normalizeIp(active?.socket?.remoteAddress);
      if (remoteAddress) promoteTarget({ host: remoteAddress, port: target.port });
      ev.emit('online', {
        peerName,
        peerVersion,
        remoteAddress,
      });
    }
    // 'swap' is transparent to the UI (same peer); retry already stopped.
  }

  function register(conn, isOutgoing) {
    conns.add(conn);
    const helloTimer = setTimeout(() => conn.destroy(), HELLO_MS);
    conn.once('hello', ({ peerName, channelConnId, peerVersion }) => {
      clearTimeout(helloTimer);
      if (isOutgoing && conn === outgoing) setOutgoing(null); // now a full candidate
      onCandidate(conn, channelConnId, peerName, peerVersion);
    });
    conn.on('bye', ({ reason }) => {
      if (conn !== active) return;
      // The peer moved the conversation to another of our devices. Retrying
      // would only fight that device for the channel, so stand down.
      if (reason === 'replaced') {
        stopped = true;
        stopRetry();
        server.close();
      }
      ev.emit('bye', { reason });
    });
    conn.on('message', (m) => { if (conn === active) ev.emit('message', m); });
    conn.on('ai', (m) => { if (conn === active) ev.emit('ai', m); });
    conn.on('ack', (r) => { if (conn === active) ev.emit('ack', r); });
    conn.on('read', (r) => { if (conn === active) ev.emit('read', r); });
    conn.on('del', (d) => { if (conn === active) ev.emit('del', d); });
    conn.on('edit', (m) => { if (conn === active) ev.emit('edit', m); });
    conn.on('react', (m) => { if (conn === active) ev.emit('react', m); });
    conn.on('typing', (t) => { if (conn === active) ev.emit('typing', t); });
    conn.on('actions', (a) => { if (conn === active) ev.emit('actions', a); });
    conn.on('focus', (f) => { if (conn === active) ev.emit('focus', f); });
    conn.on('wake', () => { if (conn === active) ev.emit('wake'); });
    conn.on('logo', () => { if (conn === active) ev.emit('logo'); });
    conn.on('holiday', (h) => { if (conn === active) ev.emit('holiday', h); });
    conn.on('caps', (c) => { if (conn === active) ev.emit('caps', c); });
    conn.on('update', (u) => { if (conn === active) ev.emit('update', u); });
    conn.on('devices', (d) => { if (conn === active) ev.emit('devices', d); });
    conn.on('ping', (p) => { if (conn === active) ev.emit('ping', p); });
    conn.on('pong', (p) => { if (conn === active) ev.emit('pong', p); });
    conn.on('protocol-error', ({ reason, size, limit }) => {
      // The channel is already gone: the session dropped it the moment the frame
      // came in. This is only about telling the person why the chat fell over,
      // instead of leaving them with a reconnect that has no explanation.
      if (reason !== 'frame-overflow') return;
      ev.emit('status', {
        key: 'rz.frameOverflow',
        params: { ip: normalizeIp(conn?.socket?.remoteAddress), size, limit },
      });
    });
    for (const kind of ['file-offer', 'file-chunk', 'file-done', 'file-deny']) {
      conn.on(kind, (f) => { if (conn === active) ev.emit(kind, f); });
    }
    conn.once('close', () => {
      const wasActive = conn === active;
      const wasOutgoing = conn === outgoing;
      const immediate = forceReconnect && (wasActive || wasOutgoing);
      if (immediate) forceReconnect = false;
      conns.delete(conn);
      clearTimeout(helloTimer); // ensure the hello-timeout handle is released on any close
      if (wasActive) {
        active = null;
        activeConnId = null;
        ev.emit('offline');
        if (!stopped) refreshAllow().then(immediate ? connectOnce : scheduleConnect);
      } else if (wasOutgoing) {
        setOutgoing(null);
        if (!active && !stopped) refreshAllow().then(immediate ? connectOnce : advanceTargetOrBackoff);
      }
      // a losing candidate we destroyed is neither active nor outgoing → ignored
    });
  }

  // Fails closed: an authority that throws — the CLI gone, the daemon
  // restarting, a whois that answers with nonsense — admits nobody rather than
  // everybody, and does it without the rejection escaping the accept handler.
  async function isAdmissible(ip) {
    if (isInboundAllowed(ip, allow)) return true;
    if (!verifyInbound) return false;
    try {
      return Boolean(await verifyInbound(ip));
    } catch {
      return false;
    }
  }

  // Between accept and `createConnection` the socket belongs to nobody: nothing
  // is listening for 'error' on it, and an unhandled EventEmitter 'error' is a
  // process-wide throw, so a peer that reset the connection while we were asking
  // the daemon about it took the whole TUI down. The listeners go on before the
  // first await, and the wait itself is bounded, because a whois that never
  // answers used to leave the socket open for the rest of the session.
  async function admitInbound(socket) {
    if (stopped) { socket.destroy(); return; }
    const ip = normalizeIp(socket.remoteAddress);
    let lost = false;
    let authTimer = null;
    const abandon = () => { lost = true; clearTimeout(authTimer); };
    socket.on('error', abandon);
    socket.once('close', abandon);
    authTimer = setTimeout(() => {
      lost = true;
      ev.emit('status', { key: 'rz.authTimeout', params: { ip } });
      socket.destroy();
    }, authTimeoutMs);
    const permitted = await isAdmissible(ip);
    clearTimeout(authTimer);
    // The answer arrived too late to be of any use: the socket is already gone,
    // or on its way out, and admitting it now would register a dead channel.
    if (lost) { socket.destroy(); return; }
    if (!permitted || stopped) {
      // A stale instance elsewhere retries every second forever. The fact is
      // worth stating once per source; repeating it only buries the transcript.
      if (rememberRejection(reportedRejections, ip)) {
        ev.emit('status', { key: 'rz.rejected', params: { ip, expected: peerHost } });
      }
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    retryDelay = RETRY_MS; // the peer is alive, so stop being patient
    ev.emit('inbound', { ip });
    // `abandon` stays attached. It costs nothing once the timer is cleared, and
    // detaching it would reopen, for the length of one statement, the very window
    // in which the socket has no 'error' listener at all.
    register(createConnection(socket, { name, connId: randomId(), initiatedByMe: false }), false);
  }

  const server = net.createServer((socket) => {
    // Floated deliberately, but never bare: `admitInbound` settles for every
    // outcome it knows about, and the tail is here so that anything it does not
    // costs one connection instead of the process.
    admitInbound(socket).catch(() => socket.destroy());
  });
  server.on('error', (err) => {
    // Losing the listener is not fatal by design — an outgoing channel still
    // works — but a port already taken usually means a forgotten instance, and
    // then nobody can reach us at all. Say that plainly instead of a bare code.
    if (err.code === 'EADDRINUSE') {
      // Report once, then keep trying quietly: whoever holds the port will let
      // go eventually, and picking it up then is better than making the person
      // restart the client they are already looking at.
      if (!reportedPortTaken) {
        reportedPortTaken = true;
        ev.emit('port-taken', { port, bindAddr });
      }
      scheduleListen();
      return;
    }
    ev.emit('status', { key: 'rz.listenError', params: { error: err.code || err.message } });
  });

  function connectOnce() {
    if (stopped || active || outgoing || !dialling) return;
    target = targets[targetIndex] ?? targets[0] ?? (peerHost ? { host: peerHost, port: peerPort } : null);
    if (!target || !target.host) return;
    const socket = net.connect({ host: target.host, port: target.port || peerPort });
    socket.setNoDelay(true);
    const conn = createConnection(socket, { name, connId: randomId(), initiatedByMe: true });
    setOutgoing(conn);
    register(conn, true);
  }

  function scheduleConnect() {
    if (stopped || active || outgoing || retryTimer || !dialling) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    retryTimer = setTimeout(() => { retryTimer = null; connectOnce(); }, delay);
  }

  function advanceTargetOrBackoff() {
    if (stopped || active || outgoing || !dialling) return;
    if (targetIndex + 1 < targets.length) {
      targetIndex += 1;
      target = targets[targetIndex] ?? targets[0] ?? null;
      if (!target || !target.host) return;
      const address = describeTarget(target);
      if (address && !reportedAlternates.has(address)) {
        reportedAlternates.add(address);
        ev.emit('status', {
          key: 'rz.tryingAlternate',
          params: { address },
        });
      }
      connectOnce();
      return;
    }
    targetIndex = 0;
    target = targets[0] ?? (peerHost ? { host: peerHost, port: peerPort } : null);
    scheduleConnect();
  }

  function stopRetry() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  // Registered once, not per attempt: `listen(port, cb)` adds a one-shot
  // 'listening' listener that survives a failed bind, so retrying with a
  // callback would report the same success as many times as it was tried.
  server.on('listening', () => {
    // Report what we actually bound: with port 0 the OS picks one, and a stale
    // guess in the log would send people chasing the wrong port.
    reportedPortTaken = false; // a later conflict is worth reporting again
    ev.emit('status', { key: 'rz.listening', params: { address: `${bindAddr}:${server.address()?.port ?? port}` } });
    // Winning the port means the duplicate that held it is gone, so there is
    // nobody left to fight and we can start reaching out again.
    if (!dialling) {
      dialling = true;
      ev.emit('took-over', { port: server.address()?.port ?? port });
      connectOnce();
    }
  });

  function listenOnce() {
    if (stopped || server.listening) return;
    if (bindAddr === '0.0.0.0') server.listen(port);
    else server.listen(port, bindAddr);
  }

  function scheduleListen() {
    if (stopped || listenTimer) return;
    listenTimer = setTimeout(() => { listenTimer = null; listenOnce(); }, RETRY_MS);
    listenTimer.unref?.();
  }

  // Startup, guarded end to end: whatever goes wrong here — an unresolvable peer
  // name, a port the OS refuses outright — has to become a line on screen, not a
  // process that dies before it has drawn one.
  (async () => {
    try {
      await refreshAllow();
      if (stopped) return; // stop() during the async resolve → do not (re)open the listener
      listenOnce();
      connectOnce();
    } catch (err) {
      ev.emit('status', { key: 'rz.listenError', params: { error: err.code || err.message } });
    }
  })();

  ev.send = (text, ts, id) => (active ? active.send(text, ts, id) : null);
  ev.sendReceipt = (kind, id) => (active ? active.sendReceipt(kind, id) : false);
  ev.sendFrame = (frame) => (active ? active.sendFrame(frame) : false);
  ev.sendPing = (id, ts) => (active?.sendPing ? active.sendPing(id, ts) : null);
  ev.activeSocket = () => (active?.socket ?? null);
  // Backpressure, for the one payload that can outrun the wire. `false` from
  // `writeFrame` means "wait", not "lost" — `writable` is what says "lost", and
  // it says so immediately, while `isOnline` still waits for 'close'.
  ev.writable = () => Boolean(active?.writable?.());
  ev.writeFrame = (frame) => (active ? active.writeFrame(frame) : false);
  ev.flushed = () => (active ? active.flushed() : Promise.resolve());
  ev.isOnline = () => active !== null;
  ev.boundPort = () => server.address()?.port ?? null;
  ev.setTarget = (host, portOverride = target.port) => {
    if (!host) return { ...target };
    return { ...promoteTarget({ host, port: portOverride }) };
  };
  ev.setTargets = (candidates) => replaceTargets(candidates).map((candidate) => ({ ...candidate }));
  ev.target = () => ({ ...target });
  ev.targets = () => targets.map((candidate) => ({ ...candidate }));
  ev.refreshAllowed = () => refreshAllow();
  // Not stop(): the listener keeps retrying, so this client takes over as soon
  // as whoever holds the port lets go.
  ev.standDown = () => {
    dialling = false;
    stopRetry();
    if (outgoing) { outgoing.destroy(); setOutgoing(null); }
  };
  ev.isDialling = () => dialling;
  ev.retryDelay = () => retryDelay;
  ev.reconnect = () => {
    if (stopped || !dialling) return false;
    retryDelay = RETRY_MS;
    stopRetry();
    if (active) {
      forceReconnect = true;
      active.destroy();
      return true;
    }
    if (outgoing) {
      forceReconnect = true;
      outgoing.destroy();
      return true;
    }
    refreshAllow()
      .then(connectOnce)
      .catch((err) => ev.emit('status', { key: 'rz.listenError', params: { error: err.code || err.message } }));
    return true;
  };
  ev.stop = () => {
    stopped = true;
    stopRetry();
    if (listenTimer) { clearTimeout(listenTimer); listenTimer = null; }
    for (const c of conns) c.destroy();
    conns.clear();
    outgoing = null;
    active = null;
    server.close();
  };
  return ev;
}
