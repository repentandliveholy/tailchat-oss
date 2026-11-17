import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import {
  connIdWins,
  arbitrate,
  startRendezvous,
  rememberRejection,
  dedupeTargets,
} from '../src/rendezvous.js';
import { encodeFrame, createFrameParser } from '../src/frames.js';
import { CHUNK_BYTES } from '../src/files.js';

// Anything that escapes as an unhandled rejection or an unhandled 'error' event
// takes the whole TUI with it in production. Capturing both here turns that into
// a failed assertion instead of a crashed test run, so the reason is readable.
function catchEscapes() {
  const escaped = [];
  const record = (err) => escaped.push(err);
  process.on('unhandledRejection', record);
  process.on('uncaughtException', record);
  return {
    escaped,
    release() {
      process.off('unhandledRejection', record);
      process.off('uncaughtException', record);
    },
  };
}

// Waits for a frame the rendezvous put on the wire, without guessing how many
// TCP reads it took to get there.
async function waitForFrame(frames, matches, ms = 2000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = frames.find(matches);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`no matching frame in ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Network tests need distinct loopback aliases (127.0.0.2/127.0.0.3) sharing a
// port. Available by default on Linux; on macOS they are NOT present unless
// aliased (`sudo ifconfig lo0 alias 127.0.0.2`). Detect at runtime and skip the
// network tests when unavailable — the pure connIdWins/arbitrate tests always
// run. Assertions are left verbatim so they execute intact where aliases exist.
function canBind(addr) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.on('error', () => resolve(false));
    s.listen(0, addr, () => s.close(() => resolve(true)));
  });
}

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const selected = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return selected;
}
const aliasesUsable = (await canBind('127.0.0.2')) && (await canBind('127.0.0.3'));
const NET = aliasesUsable
  ? {}
  : { skip: 'loopback aliases 127.0.0.2/127.0.0.3 unavailable in this environment (EADDRNOTAVAIL)' };

test('connIdWins: smaller connId wins', () => {
  assert.equal(connIdWins('aaaa', 'bbbb'), true);
  assert.equal(connIdWins('bbbb', 'aaaa'), false);
});

test('candidate targets keep their order and discard duplicate or unusable routes', () => {
  assert.deepEqual(dedupeTargets([
    { host: '100.64.0.1', port: 4747 },
    { host: '100.64.0.1', port: 4747 },
    { host: 'fd7a:115c:a1e0::1', port: 4747 },
    { host: '', port: 4747 },
    { host: 'peer.example.ts.net', port: 0 },
    { host: 'peer.example.ts.net' },
  ], 4747), [
    { host: '100.64.0.1', port: 4747 },
    { host: 'fd7a:115c:a1e0::1', port: 4747 },
    { host: 'peer.example.ts.net', port: 4747 },
  ]);
});

// --- arbitrate: deterministic, order-independent channel selection ---

// Fold one peer's candidates (in a given arrival order) through arbitrate.
function runPeer(candidates) {
  let state = { active: null, activeConnId: null };
  const destroyed = [];
  const events = [];
  for (const c of candidates) {
    const r = arbitrate(state, c);
    state = { active: r.active, activeConnId: r.activeConnId };
    for (const d of r.destroy) destroyed.push(d.connId);
    if (r.event) events.push(r.event);
  }
  return { activeConnId: state.activeConnId, destroyed, events };
}

test('arbitrate: first candidate becomes active (online)', () => {
  const r = arbitrate({ active: null, activeConnId: null }, { conn: { connId: 'x' }, connId: 'x' });
  assert.equal(r.activeConnId, 'x');
  assert.equal(r.event, 'online');
  assert.deepEqual(r.destroy, []);
});

test('arbitrate: smaller connId swaps and destroys old active', () => {
  const oldC = { connId: 'y' };
  const r = arbitrate({ active: oldC, activeConnId: 'y' }, { conn: { connId: 'x' }, connId: 'x' });
  assert.equal(r.activeConnId, 'x');
  assert.equal(r.event, 'swap');
  assert.deepEqual(r.destroy.map((c) => c.connId), ['y']);
});

test('arbitrate: larger connId loses and is destroyed', () => {
  const active = { connId: 'x' };
  const r = arbitrate({ active, activeConnId: 'x' }, { conn: { connId: 'y' }, connId: 'y' });
  assert.equal(r.activeConnId, 'x');
  assert.equal(r.event, null);
  assert.deepEqual(r.destroy.map((c) => c.connId), ['y']);
});

// The critical race: two physical channels exist (connIds cid1, cid2). Peer A
// sees {outbound:cid1, inbound:cid2}; peer B sees {outbound:cid2, inbound:cid1}.
// For EVERY arrival order on each side, both MUST keep the SAME channel (min).
test('arbitrate: cross-order convergence for all permutations', () => {
  const cid1 = 'aaaa';
  const cid2 = 'bbbb';
  const min = cid1 < cid2 ? cid1 : cid2;
  const aCands = [{ conn: { connId: cid1, side: 'A-out' }, connId: cid1 },
                  { conn: { connId: cid2, side: 'A-in' }, connId: cid2 }];
  const bCands = [{ conn: { connId: cid2, side: 'B-out' }, connId: cid2 },
                  { conn: { connId: cid1, side: 'B-in' }, connId: cid1 }];
  const orders = [[0, 1], [1, 0]];
  for (const oa of orders) {
    for (const ob of orders) {
      const a = runPeer(oa.map((i) => aCands[i]));
      const b = runPeer(ob.map((i) => bCands[i]));
      assert.equal(a.activeConnId, min, `A order ${oa}`);
      assert.equal(b.activeConnId, min, `B order ${ob}`);
      assert.equal(a.activeConnId, b.activeConnId); // same physical channel
    }
  }
});
// A different device of the same person is not a duplicate channel: min(connId)
// would pick a winner at random and could kill the session the user just opened.
test('arbitrate: a connection from another device replaces the active one', () => {
  const active = { connId: 'aaaa' };
  const r = arbitrate(
    { active, activeConnId: 'aaaa', activeAddress: '100.0.0.1' },
    { conn: { connId: 'zzzz' }, connId: 'zzzz', address: '100.0.0.2' },
  );
  assert.equal(r.activeConnId, 'zzzz', 'the newcomer wins regardless of connId order');
  assert.equal(r.event, 'replaced');
  assert.deepEqual(r.destroy.map((c) => c.connId), ['aaaa']);
});

test('arbitrate: the same device still uses the connId tie-break', () => {
  const active = { connId: 'aaaa' };
  const r = arbitrate(
    { active, activeConnId: 'aaaa', activeAddress: '100.0.0.1' },
    { conn: { connId: 'zzzz' }, connId: 'zzzz', address: '100.0.0.1' },
  );
  assert.equal(r.activeConnId, 'aaaa', 'two channels to one machine must not flap');
  assert.equal(r.event, null);
  assert.deepEqual(r.destroy.map((c) => c.connId), ['zzzz']);
});

test('arbitrate: an unknown address falls back to the connId tie-break', () => {
  const active = { connId: 'aaaa' };
  const r = arbitrate(
    { active, activeConnId: 'aaaa', activeAddress: null },
    { conn: { connId: 'zzzz' }, connId: 'zzzz', address: '100.0.0.2' },
  );
  assert.equal(r.activeConnId, 'aaaa', 'never guess a device switch without evidence');
  assert.equal(r.event, null);
});

test('isInboundAllowed: Tailscale CGNAT source still requires an exact peer match', async () => {
  const { isInboundAllowed } = await import('../src/rendezvous.js');
  assert.equal(isInboundAllowed?.('100.99.0.1', new Set(['100.100.0.1'])), false);
  assert.equal(isInboundAllowed?.('100.99.0.1', new Set(['100.99.0.1'])), true);
});

test('isInboundAllowed: non-Tailscale source requires an exact peer match', async () => {
  const { isInboundAllowed } = await import('../src/rendezvous.js');
  assert.equal(isInboundAllowed?.('192.168.1.10', new Set()), false);
  assert.equal(isInboundAllowed?.('192.168.1.10', new Set(['192.168.1.10'])), true);
});

// Two peers on distinct loopback IPs sharing one port. Requires 127.0.0.2
// to be a usable loopback alias (default on macOS and Linux).
test('two peers converge to one channel and exchange messages', NET, async () => {
  const port = 47470;
  const a = startRendezvous({ peerHost: '127.0.0.2', peerPort: port, bindAddr: '127.0.0.1', port, name: 'A' });
  const b = startRendezvous({ peerHost: '127.0.0.1', peerPort: port, bindAddr: '127.0.0.2', port, name: 'B' });
  const [[onA], [onB]] = await Promise.all([once(a, 'online'), once(b, 'online')]);
  assert.equal(onA.peerName, 'B');
  assert.equal(onB.peerName, 'A');

  const gotB = once(b, 'message');
  a.send('ping');
  const [m] = await gotB;
  assert.equal(m.name, 'A');
  assert.equal(m.text, 'ping');

  a.stop();
  b.stop();
});

test('inbound from a non-peer IP is rejected before online', NET, async () => {
  const port = 47471;
  // Peer only allows 127.0.0.2; we connect from 127.0.0.3 (not in allowlist).
  const a = startRendezvous({ peerHost: '127.0.0.2', peerPort: port, bindAddr: '127.0.0.1', port, name: 'A' });
  // Give the listener a moment to bind.
  await new Promise((r) => setTimeout(r, 200));
  const intruder = net.connect({ host: '127.0.0.1', port, localAddress: '127.0.0.3' });
  const closed = once(intruder, 'close');
  // 'a' must NOT go online from the intruder.
  let online = false;
  a.on('online', () => { online = true; });
  await closed; // intruder socket is destroyed by the allowlist filter
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(online, false);
  a.stop();
});

test('auto-reconnect: after active peer drops, peer comes back online', NET, async () => {
  const port = 47472;
  const a = startRendezvous({ peerHost: '127.0.0.2', peerPort: port, bindAddr: '127.0.0.1', port, name: 'A' });
  let b = startRendezvous({ peerHost: '127.0.0.1', peerPort: port, bindAddr: '127.0.0.2', port, name: 'B' });
  await once(a, 'online');
  const offlineP = once(a, 'offline');
  b.stop();                 // drop B
  await offlineP;           // A notices the drop
  b = startRendezvous({ peerHost: '127.0.0.1', peerPort: port, bindAddr: '127.0.0.2', port, name: 'B' });
  await once(a, 'online');  // A reconnects
  a.stop();
  b.stop();
});

// stop() must destroy EVERY registered connection, including an allowed inbound
// still awaiting hello (neither active nor outgoing). Uses 127.0.0.1 only — no
// loopback aliases — so it runs everywhere and must exit cleanly. peerPort points
// at a dead port so the rendezvous never connects to its own listener; the only
// registered connection is the pending inbound intruder.
test('stop() releases a pending inbound connection', async () => {
  const port = 47473;
  const deadPeerPort = 47474; // nothing listens here → no self-connection
  const rz = startRendezvous({ peerHost: '127.0.0.1', peerPort: deadPeerPort, bindAddr: '127.0.0.1', port, name: 'A' });
  await once(rz, 'status'); // 'listening on ...' → server bound
  const intruder = net.connect({ host: '127.0.0.1', port });
  intruder.resume(); // flowing mode: drain server's hello + observe FIN on stop()
  await new Promise((r) => setTimeout(r, 100)); // server accepts → register() runs
  const closed = once(intruder, 'close');
  rz.stop();
  await closed; // resolves quickly: stop() destroyed the pending inbound
  if (!intruder.destroyed) intruder.destroy();
});

test('inbound outside the peer allowlist is rejected with its remote address', async () => {
  const deadPeerPort = 47476;
  const rz = startRendezvous({
    peerHost: '192.0.2.1',
    peerPort: deadPeerPort,
    bindAddr: '127.0.0.1',
    port: 0, // let the OS pick: a fixed port collides with anything else running
    name: 'A',
  });
  let client;
  let timeout;
  try {
    const [listening] = await once(rz, 'status');
    assert.equal(listening.key, 'rz.listening');
    const port = rz.boundPort();
    assert.ok(port > 0, `expected a bound port, got ${port}`);

    const rejected = once(rz, 'status');
    client = net.connect({ host: '127.0.0.1', port });
    // Being hung up on is the point of this test, and a peer destroying the
    // socket surfaces as ECONNRESET as often as a clean FIN. Either way the
    // connection is closed, which is what the assertion below checks.
    client.on('error', () => {});
    client.on('connect', () => {
      client.write('{"t":"hello","name":"cross-tailnet-peer","connId":"peer-channel"}\n');
    });
    const outcome = await Promise.race([
      once(rz, 'online').then(() => 'online'),
      new Promise((resolve) => client.once('close', () => resolve('closed'))),
      new Promise((resolve) => { timeout = setTimeout(() => resolve('timeout'), 1000); }),
    ]);
    clearTimeout(timeout);
    assert.equal(outcome, 'closed');
    const [status] = await rejected;
    // The network layer reports facts, not prose: the CLI owns the wording and
    // the language it is rendered in.
    assert.deepEqual(status, {
      key: 'rz.rejected',
      params: { ip: '127.0.0.1', expected: '192.0.2.1' },
    });
  } finally {
    if (client && !client.destroyed) client.destroy();
    clearTimeout(timeout);
    rz.stop();
  }
});

test('every conversational event a session emits is relayed to the caller', async () => {
  // A frame the rendezvous layer forgets to forward is invisible: the peer
  // sends it, the wire carries it, and the UI never hears about it. That is
  // exactly how presence broke, so the relay list is checked against the
  // session's own list rather than trusted.
  const session = await readFile(new URL('../src/session.js', import.meta.url), 'utf8');
  const emitted = new Set(
    [...session.matchAll(/ev\.emit\('([a-z-]+)'/g)].map((m) => m[1]),
  );
  const relay = await readFile(new URL('../src/rendezvous.js', import.meta.url), 'utf8');
  const relayed = new Set(
    [...relay.matchAll(/conn\.on\('([a-z-]+)'/g)].map((m) => m[1]),
  );
  // `hello` and `close` drive arbitration inside the module itself.
  const internal = new Set(['hello', 'close']);
  const dropped = [...emitted].filter((name) => !internal.has(name) && !relayed.has(name));
  assert.deepEqual(dropped, [], `these frames never reach the UI: ${dropped.join(', ')}`);
});

test('a peer that stays away costs less and less', async () => {
  // Retrying every second for an hour is 3600 connect attempts at a machine that
  // is switched off. The delay grows, and a working channel resets it.
  const rz = startRendezvous({
    peerHost: '127.0.0.1',
    peerPort: 47997, // nothing listens: the attempt is refused at once
    bindAddr: '127.0.0.1',
    port: 0,
    name: 'A',
  });
  try {
    const first = rz.retryDelay();
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const later = rz.retryDelay();
    assert.ok(later > first, `the delay must grow, went ${first} -> ${later}`);
    assert.ok(later <= 30_000, 'and stay bounded');
  } finally {
    rz.stop();
  }
});

test('a failed route tries the next candidate before the sweep earns backoff', async () => {
  const deadPort = await unusedPort();
  const peer = startRendezvous({
    peerHost: '127.0.0.1',
    peerPort: deadPort,
    bindAddr: '127.0.0.1',
    port: 0,
    name: 'B',
  });
  let rz;
  try {
    await once(peer, 'status');
    const livePort = peer.boundPort();
    let delayAtAlternate = null;
    const statuses = [];
    rz = startRendezvous({
      peerHost: '127.0.0.1',
      peerPort: deadPort,
      peerTargets: [
        { host: '127.0.0.1', port: deadPort },
        { host: '127.0.0.1', port: deadPort },
        { host: '127.0.0.1', port: livePort },
      ],
      bindAddr: '127.0.0.1',
      port: 0,
      name: 'A',
    });
    rz.on('status', (status) => {
      statuses.push(status);
      if (status.key === 'rz.tryingAlternate') delayAtAlternate = rz.retryDelay();
    });

    const [online] = await once(rz, 'online');
    assert.equal(online.peerName, 'B');
    assert.equal(delayAtAlternate, 1000, 'backoff must not grow inside a candidate sweep');
    assert.ok(statuses.some((status) => (
      status.key === 'rz.tryingAlternate'
      && status.params.address === `127.0.0.1:${livePort}`
    )), 'the live alternate was not announced');
    assert.deepEqual(rz.target(), { host: '127.0.0.1', port: livePort });
    assert.deepEqual(rz.targets()[0], { host: '127.0.0.1', port: livePort });
  } finally {
    rz?.stop();
    peer.stop();
  }
});

test('a returning peer is answered at once, not on our schedule', async () => {
  // This is why growing the delay is safe: the listener never sleeps, so whoever
  // comes back connects immediately instead of waiting for the other side.
  const rz = startRendezvous({
    peerHost: '127.0.0.1',
    peerPort: 47996,
    bindAddr: '127.0.0.1',
    port: 0,
    name: 'A',
  });
  let client;
  try {
    const [listening] = await once(rz, 'status');
    assert.equal(listening.key, 'rz.listening');
    await new Promise((resolve) => setTimeout(resolve, 2500)); // let the delay grow
    const patient = rz.retryDelay();
    assert.ok(patient > 1000, 'the delay had to grow for this to prove anything');

    client = net.connect({ host: '127.0.0.1', port: rz.boundPort() });
    client.on('error', () => {});
    client.on('connect', () => {
      client.write('{"t":"hello","name":"B","connId":"aaaa","v":"9.9.9"}\n');
    });
    const [online] = await once(rz, 'online');
    assert.equal(online.peerName, 'B');
    assert.equal(rz.retryDelay(), 1000, 'a working channel resets the patience');
  } finally {
    if (client && !client.destroyed) client.destroy();
    rz.stop();
  }
});
test('manual reconnect drops an active channel and immediately starts a fresh dial', async () => {
  const rz = startRendezvous({
    peerHost: '127.0.0.1', peerPort: 47995, bindAddr: '127.0.0.1', port: 0, name: 'A',
  });
  let client;
  try {
    await once(rz, 'status');
    client = net.connect({ host: '127.0.0.1', port: rz.boundPort() });
    client.on('error', () => {});
    client.on('connect', () => {
      client.write('{"t":"hello","name":"B","connId":"aaaa","v":"9.9.9"}\n');
    });
    await once(rz, 'online');
    const offline = once(rz, 'offline');
    const reaching = once(rz, 'reaching');
    assert.equal(rz.reconnect(), true);
    await offline;
    const [state] = await reaching;
    assert.equal(state.active, true, 'manual reconnect starts a call without waiting for backoff');
  } finally {
    if (client && !client.destroyed) client.destroy();
    rz.stop();
  }
});


test('the dialler announces when a call is open and when it is over', async () => {
  // The header distinguishes waiting from connecting, and it can only do that if
  // the one place that opens the socket says so.
  const rz = startRendezvous({
    peerHost: '127.0.0.1', peerPort: 47903, bindAddr: '127.0.0.1', port: 0, name: 'A',
  });
  const seen = [];
  rz.on('reaching', ({ active }) => seen.push(active));
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.ok(seen.length >= 2, `only ${seen.length} announcements`);
    assert.equal(seen[0], true, 'the first thing it does is open a call');
    assert.equal(seen[1], false, 'a refused call must be announced as over');
    // Never twice in a row: the state and the announcement cannot drift.
    for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1]);
  } finally {
    rz.stop();
  }
});

test('the rejected-source memory stays bounded', () => {
  // Whoever dials us decides how many distinct addresses this set is offered, so
  // it cannot be allowed to grow with them.
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    assert.equal(rememberRejection(seen, `100.64.0.${i}`, 8), true);
  }
  assert.ok(seen.size <= 8, `the set grew to ${seen.size}`);
  // A source still in memory is still reported only once.
  assert.equal(rememberRejection(seen, '100.64.0.499', 8), false);
});

test('a stalled authorisation costs the socket, not the session', async () => {
  const guard = catchEscapes();
  const rz = startRendezvous({
    peerHost: '192.0.2.1', // never us, so the answer has to come from verifyInbound
    peerPort: 47905,
    bindAddr: '127.0.0.1',
    port: 0,
    name: 'A',
    verifyInbound: () => new Promise(() => {}), // a whois that never answers
    authTimeoutMs: 150,
  });
  let client;
  try {
    await once(rz, 'status'); // rz.listening
    const statuses = [];
    rz.on('status', (s) => statuses.push(s));
    client = net.connect({ host: '127.0.0.1', port: rz.boundPort() });
    client.on('error', () => {});
    const closed = once(client, 'close');
    await closed; // the deadline, not the peer, ends this connection
    assert.deepEqual(statuses, [{ key: 'rz.authTimeout', params: { ip: '127.0.0.1' } }]);
    assert.deepEqual(guard.escaped, []);
  } finally {
    if (client && !client.destroyed) client.destroy();
    rz.stop();
    guard.release();
  }
});

test('a socket that dies mid-authorisation is dropped quietly', async () => {
  // Until the session owns it, an accepted socket has no 'error' listener of its
  // own, and an unhandled 'error' event is a process-wide throw: a peer that
  // reset the connection while we were asking the daemon about it used to kill
  // the client outright.
  const guard = catchEscapes();
  const rz = startRendezvous({
    peerHost: '192.0.2.1',
    peerPort: 47906,
    bindAddr: '127.0.0.1',
    port: 0,
    name: 'A',
    verifyInbound: () => new Promise(() => {}),
    authTimeoutMs: 200,
  });
  try {
    await once(rz, 'status'); // rz.listening
    const statuses = [];
    rz.on('status', (s) => statuses.push(s));
    const client = net.connect({ host: '127.0.0.1', port: rz.boundPort() });
    client.on('error', () => {});
    await once(client, 'connect');
    client.resetAndDestroy(); // RST, so the accepted socket errors rather than ends
    await new Promise((resolve) => setTimeout(resolve, 500)); // past the deadline
    assert.deepEqual(guard.escaped, []);
    // A socket that is already gone needs no deadline report either: losing it
    // stops the clock.
    assert.deepEqual(statuses, []);
  } finally {
    rz.stop();
    guard.release();
  }
});

test('an authority that throws admits nobody and takes nothing with it', async () => {
  const guard = catchEscapes();
  const rz = startRendezvous({
    peerHost: '192.0.2.1',
    peerPort: 47907,
    bindAddr: '127.0.0.1',
    port: 0,
    name: 'A',
    verifyInbound: async () => { throw new Error('tailscale cli is gone'); },
  });
  let client;
  try {
    await once(rz, 'status'); // rz.listening
    const rejected = once(rz, 'status');
    client = net.connect({ host: '127.0.0.1', port: rz.boundPort() });
    client.on('error', () => {});
    const [status] = await rejected;
    assert.deepEqual(status, {
      key: 'rz.rejected',
      params: { ip: '127.0.0.1', expected: '192.0.2.1' },
    });
    await once(client, 'close');
    assert.deepEqual(guard.escaped, []);
  } finally {
    if (client && !client.destroyed) client.destroy();
    rz.stop();
    guard.release();
  }
});

test('a resolver that fails is a retry, not the end of the process', async () => {
  const guard = catchEscapes();
  const rz = startRendezvous({
    peerHost: 'peer-that-cannot-be-resolved',
    peerPort: 47908,
    bindAddr: '127.0.0.1',
    port: 0,
    name: 'A',
    resolveAllowed: async () => { throw new Error('tailscale status failed'); },
  });
  try {
    const [unresolved] = await once(rz, 'unresolved');
    assert.equal(unresolved.peer, 'peer-that-cannot-be-resolved');
    // The listener still comes up: not knowing who our peer is has never been a
    // reason to be unreachable.
    const [listening] = await once(rz, 'status');
    assert.equal(listening.key, 'rz.listening');
    await once(rz, 'reaching'); // and it still dials, on the existing backoff
    assert.ok(rz.retryDelay() >= 1000);
    assert.deepEqual(guard.escaped, []);
  } finally {
    rz.stop();
    guard.release();
  }
});

test('a resolver that fails on disconnect still schedules the reconnect', async () => {
  // The 'close' handler resolves the allowlist again before retrying, and this
  // is the path a rejection used to escape from — on every single disconnect.
  const guard = catchEscapes();
  const rz = startRendezvous({
    peerHost: '127.0.0.1',
    peerPort: 47909,
    bindAddr: '127.0.0.1',
    port: 0,
    name: 'A',
    resolveAllowed: async () => { throw new Error('tailscale status failed'); },
    verifyInbound: async () => true, // the allowlist is empty, so this admits the peer
  });
  let client;
  try {
    await once(rz, 'unresolved');
    await once(rz, 'status'); // rz.listening
    client = net.connect({ host: '127.0.0.1', port: rz.boundPort() });
    client.on('error', () => {});
    await once(client, 'connect');
    client.write('{"t":"hello","name":"B","connId":"aaaa","v":"0.52.0"}\n');
    await once(rz, 'online');
    const offline = once(rz, 'offline');
    const resolvedAgain = once(rz, 'unresolved');
    client.destroy();
    await offline;
    await resolvedAgain; // the failure was reported, not thrown
    await once(rz, 'reaching'); // and the retry was scheduled all the same
    assert.deepEqual(guard.escaped, []);
  } finally {
    if (client && !client.destroyed) client.destroy();
    rz.stop();
    guard.release();
  }
});

test('an oversized frame from a peer is reported and the channel dropped', async () => {
  const rz = startRendezvous({
    peerHost: '127.0.0.1', peerPort: 47910, bindAddr: '127.0.0.1', port: 0, name: 'A',
  });
  let client;
  try {
    await once(rz, 'status'); // rz.listening
    client = net.connect({ host: '127.0.0.1', port: rz.boundPort() });
    client.on('error', () => {});
    await once(client, 'connect');
    client.write('{"t":"hello","name":"B","connId":"aaaa","v":"0.52.0"}\n');
    await once(rz, 'online');
    const reported = once(rz, 'status');
    const offline = once(rz, 'offline');
    client.write(`{"t":"msg","text":"${'x'.repeat(400 * 1024)}"}\n`);
    const [status] = await reported;
    assert.equal(status.key, 'rz.frameOverflow');
    assert.equal(status.params.ip, '127.0.0.1');
    assert.ok(status.params.size > status.params.limit);
    await offline; // a channel out of step is no channel at all
  } finally {
    if (client && !client.destroyed) client.destroy();
    rz.stop();
  }
});

test('a peer speaking only 0.52.0 frames connects, chats and sends a file', async () => {
  // Everything above adds a ceiling, a deadline or a keepalive. None of it may
  // ask the other side for anything it does not already say, because a 0.52.0
  // client answers nothing it does not recognise.
  const rz = startRendezvous({
    peerHost: '127.0.0.1', peerPort: 47911, bindAddr: '127.0.0.1', port: 0, name: 'A',
  });
  let client;
  try {
    await once(rz, 'status'); // rz.listening
    client = net.connect({ host: '127.0.0.1', port: rz.boundPort() });
    client.on('error', () => {});
    await once(client, 'connect');
    const fromUs = [];
    const feed = createFrameParser((f) => fromUs.push(f));
    client.on('data', (chunk) => feed(chunk));
    client.write('{"t":"hello","name":"B","connId":"aaaa","v":"0.52.0"}\n');

    const [online] = await once(rz, 'online');
    assert.equal(online.peerName, 'B');
    assert.equal(online.peerVersion, '0.52.0');
    await waitForFrame(fromUs, (f) => f.t === 'hello' && f.name === 'A');

    const incoming = once(rz, 'message');
    client.write(encodeFrame({ t: 'msg', id: 'm1', text: 'still on the old client', ts: 1 }));
    const [received] = await incoming;
    assert.equal(received.text, 'still on the old client');

    assert.ok(rz.send('and this reaches it'));
    await waitForFrame(fromUs, (f) => f.t === 'msg' && f.text === 'and this reaches it');

    // A whole chunk at the size the old client actually sends them: base64 of
    // CHUNK_BYTES is the largest frame the protocol has, and the new receive
    // ceiling has to clear it or a file would kill the channel it arrived on.
    const payload = Buffer.alloc(CHUNK_BYTES, 0x5a);
    const offer = once(rz, 'file-offer');
    client.write(encodeFrame({ t: 'file-offer', id: 'f1', name: 'old.bin', size: payload.length }));
    await offer;
    const chunk = once(rz, 'file-chunk');
    client.write(encodeFrame({ t: 'file-chunk', id: 'f1', seq: 0, data: payload.toString('base64') }));
    const [got] = await chunk;
    assert.equal(Buffer.from(got.data, 'base64').length, CHUNK_BYTES);
    const done = once(rz, 'file-done');
    client.write(encodeFrame({ t: 'file-done', id: 'f1' }));
    await done;

    // Nothing was asked of the old peer that it could fail to answer, so the
    // channel is still the one it opened.
    assert.equal(rz.isOnline(), true);
  } finally {
    if (client && !client.destroyed) client.destroy();
    rz.stop();
  }
});
