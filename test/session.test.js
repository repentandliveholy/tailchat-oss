import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import {
  createConnection, messageTooLarge, MAX_MESSAGE_CHARS,
} from '../src/session.js';

// Helper: a connected TCP socket pair on loopback.
async function socketPair() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const clientP = new Promise((resolve) => {
    const c = net.connect({ host: '127.0.0.1', port }, () => resolve(c));
  });
  const serverP = once(server, 'connection').then(([s]) => s);
  const [client, srv] = await Promise.all([clientP, serverP]);
  server.close();
  return { client, srv };
}

test('hello handshake: channelConnId is the initiator connId on both ends', async () => {
  const { client, srv } = await socketPair();
  // client is the initiator (initiatedByMe: true) with connId "aaaa"
  const a = createConnection(client, { name: 'A', connId: 'aaaa', initiatedByMe: true });
  const b = createConnection(srv, { name: 'B', connId: 'bbbb', initiatedByMe: false });
  const [[ha], [hb]] = await Promise.all([once(a, 'hello'), once(b, 'hello')]);
  assert.equal(ha.peerName, 'B');
  assert.equal(hb.peerName, 'A');
  assert.equal(ha.channelConnId, 'aaaa'); // initiator's id
  assert.equal(hb.channelConnId, 'aaaa'); // both agree
  a.destroy();
  b.destroy();
});

test('message delivery carries peer name from hello', async () => {
  const { client, srv } = await socketPair();
  const a = createConnection(client, { name: 'A', connId: 'aaaa', initiatedByMe: true });
  const b = createConnection(srv, { name: 'B', connId: 'bbbb', initiatedByMe: false });
  await Promise.all([once(a, 'hello'), once(b, 'hello')]);
  const msgP = once(b, 'message');
  a.send('hi there');
  const [m] = await msgP;
  assert.equal(m.name, 'A');
  assert.equal(m.text, 'hi there');
  assert.equal(typeof m.ts, 'number');
  a.destroy();
  b.destroy();
});

test('message delivery forwards reply snapshots and reaction tallies', async () => {
  const { client, srv } = await socketPair();
  const a = createConnection(client, { name: 'A', connId: 'aaaa', initiatedByMe: true });
  const b = createConnection(srv, { name: 'B', connId: 'bbbb', initiatedByMe: false });
  await Promise.all([once(a, 'hello'), once(b, 'hello')]);
  const messageP = once(b, 'message');
  const replyTo = {
    id: 'older', from: 'B', text: 'the original',
  };
  const reactions = { '👍': ['A', 'B'] };

  assert.equal(a.sendFrame({
    t: 'msg', id: 'newer', text: 'the answer', ts: 123, replyTo, reactions,
  }), true);
  const [message] = await messageP;
  assert.deepEqual(message.replyTo, replyTo);
  assert.deepEqual(message.reactions, reactions);

  a.destroy();
  b.destroy();
});

test('message delivery drops malformed reply snapshots', async () => {
  const { client, srv } = await socketPair();
  const a = createConnection(client, { name: 'A', connId: 'aaaa', initiatedByMe: true });
  const b = createConnection(srv, { name: 'B', connId: 'bbbb', initiatedByMe: false });
  await Promise.all([once(a, 'hello'), once(b, 'hello')]);

  for (const replyTo of ['older', null, ['older']]) {
    const messageP = once(b, 'message');
    assert.equal(a.sendFrame({
      t: 'msg', id: `message-${String(replyTo)}`, text: 'answer', replyTo,
    }), true);
    const [message] = await messageP;
    assert.equal(message.replyTo, undefined);
  }

  a.destroy();
  b.destroy();
});

test('close event fires when peer socket closes', async () => {
  const { client, srv } = await socketPair();
  const a = createConnection(client, { name: 'A', connId: 'aaaa', initiatedByMe: true });
  const b = createConnection(srv, { name: 'B', connId: 'bbbb', initiatedByMe: false });
  await Promise.all([once(a, 'hello'), once(b, 'hello')]);
  const closed = once(b, 'close');
  a.destroy();
  await closed; // resolves → close emitted
  b.destroy();
});

test('send() returns the message id when writable and delivers the message', async () => {
  const { client, srv } = await socketPair();
  const a = createConnection(client, { name: 'A', connId: 'aaaa', initiatedByMe: true });
  const b = createConnection(srv, { name: 'B', connId: 'bbbb', initiatedByMe: false });
  await Promise.all([once(a, 'hello'), once(b, 'hello')]);
  const msgP = once(b, 'message');
  const id = a.send('x'); // writable → id (never backpressure-false)
  assert.match(id, /^[0-9a-f]{16}$/);
  const [m] = await msgP;
  assert.equal(m.text, 'x'); // and it actually reaches the peer
  assert.equal(m.id, id);
  a.destroy();
  b.destroy();
});

test('send() returns null once the socket is gone', async () => {
  const { client, srv } = await socketPair();
  const a = createConnection(client, { name: 'A', connId: 'aaaa', initiatedByMe: true });
  client.destroy();
  await once(a, 'close');
  assert.equal(a.send('lost'), null);
  srv.destroy();
});


test('send preserves an explicit compose timestamp for queued messages', async () => {
  const { client, srv } = await socketPair();
  const a = createConnection(client, { name: 'A', connId: 'aaaa', initiatedByMe: true });
  const b = createConnection(srv, { name: 'B', connId: 'bbbb', initiatedByMe: false });
  await once(b, 'hello');

  const composedAt = Date.now() - 60_000; // written a minute ago while offline
  a.send('queued while offline', composedAt);
  const [message] = await once(b, 'message');
  assert.equal(message.text, 'queued while offline');
  assert.equal(message.ts, composedAt, 'peer must see when it was written');

  a.send('live message');
  const [live] = await once(b, 'message');
  assert.ok(live.ts >= composedAt, 'a normal send still stamps now');

  client.destroy();
  srv.destroy();
});

// The reported symptom this serves: switching the AI off on one side handed the
// answering to the other, and the assistant went on replying under the same
// name. `ai` on the wire means "answers here are mine" — a muted side claims it
// so the peer defers — and `aiMuted` carries the reason so the peer can say why
// nothing answers instead of leaving a question hanging.
test('caps carries both who owns the answering and whether anyone answers', async () => {
  const { client, srv } = await socketPair();
  const a = createConnection(client, { name: 'A', connId: 'aaaa', initiatedByMe: true });
  const b = createConnection(srv, { name: 'B', connId: 'bbbb', initiatedByMe: false });
  await once(b, 'hello');

  a.sendFrame({ t: 'caps', focus: true, ai: true, aiMuted: true });
  const [muted] = await once(b, 'caps');
  assert.deepEqual(muted, { focus: true, ai: true, muted: true });

  a.sendFrame({ t: 'caps', focus: true, ai: true, aiMuted: false });
  const [answering] = await once(b, 'caps');
  assert.deepEqual(answering, { focus: true, ai: true, muted: false });

  // A 0.52.0 peer sends neither field. Reading a missing flag as `true` would
  // silence an AI that is perfectly willing to answer.
  a.sendFrame({ t: 'caps', focus: true });
  const [old] = await once(b, 'caps');
  assert.deepEqual(old, { focus: true, ai: false, muted: false });

  client.destroy();
  srv.destroy();
});

test('holiday frames carry one shared boolean after hello', async () => {
  const { client, srv } = await socketPair();
  const a = createConnection(client, { name: 'A', connId: 'aaaa', initiatedByMe: true });
  const b = createConnection(srv, { name: 'B', connId: 'bbbb', initiatedByMe: false });
  await once(b, 'hello');

  a.sendFrame({ t: 'holiday', on: true });
  assert.deepEqual((await once(b, 'holiday'))[0], { on: true });
  a.sendFrame({ t: 'holiday', on: false });
  assert.deepEqual((await once(b, 'holiday'))[0], { on: false });

  client.destroy();
  srv.destroy();
});

test('actions frames carry only bounded button values after hello', async () => {
  const { client, srv } = await socketPair();
  const a = createConnection(client, { name: 'A', connId: 'aaaa', initiatedByMe: true });
  const b = createConnection(srv, { name: 'B', connId: 'bbbb', initiatedByMe: false });
  await Promise.all([once(a, 'hello'), once(b, 'hello')]);
  const actionsP = once(b, 'actions');
  a.sendFrame({
    t: 'actions',
    actions: [
      { id: 'done', label: '✅ Готово', value: 'готово' },
      { id: '', label: 'invalid', value: 'ignored' },
      { id: 'long', label: 'x'.repeat(41), value: 'ignored' },
    ],
  });
  const [frame] = await actionsP;
  assert.deepEqual(frame, {
    actions: [{ id: 'done', label: '✅ Готово', value: 'готово' }],
  });
  a.destroy();
  b.destroy();
});

test('send stamps a unique id and the peer reports it back on ack and read', async () => {
  const { client, srv } = await socketPair();
  const a = createConnection(client, { name: 'A', connId: 'aaaa', initiatedByMe: true });
  const b = createConnection(srv, { name: 'B', connId: 'bbbb', initiatedByMe: false });
  await once(b, 'hello');

  const firstId = a.send('one');
  const secondId = a.send('two');
  assert.match(firstId, /^[0-9a-f]{16}$/);
  assert.notEqual(firstId, secondId, 'ids must not collide within a millisecond');

  const [received] = await once(b, 'message');
  assert.equal(received.id, firstId, 'receiver sees the sender id');

  b.sendReceipt('ack', firstId);
  const [ack] = await once(a, 'ack');
  assert.deepEqual(ack, { id: firstId });

  b.sendReceipt('read', firstId);
  const [read] = await once(a, 'read');
  assert.deepEqual(read, { id: firstId });

  client.destroy();
  srv.destroy();
});

test('a message without an id is delivered but carries no receipt handle', async () => {
  const { client, srv } = await socketPair();
  const a = createConnection(client, { name: 'A', connId: 'aaaa', initiatedByMe: true });
  const b = createConnection(srv, { name: 'B', connId: 'bbbb', initiatedByMe: false });
  await once(b, 'hello');

  // Simulate an older client that predates message ids.
  client.write(`${JSON.stringify({ t: 'msg', text: 'legacy', ts: Date.now() })}\n`);
  const [received] = await once(b, 'message');
  assert.equal(received.text, 'legacy');
  assert.equal(received.id, null, 'no id means the sender cannot be acked');

  client.destroy();
  srv.destroy();
});

test('an established socket gets bounded TCP keepalive', async () => {
  // Without this a blackholed route never produces a FIN, so 'close' never
  // fires, the rendezvous keeps believing it has a channel and every message
  // typed from then on is buffered into nothing.
  const { client, srv } = await socketPair();
  const calls = [];
  client.setKeepAlive = (enable, delay) => { calls.push({ enable, delay }); return client; };
  const a = createConnection(client, {
    name: 'A', connId: 'aaaa', initiatedByMe: true, keepAliveMs: 1234,
  });
  assert.deepEqual(calls, [{ enable: true, delay: 1234 }]);

  const seen = [];
  srv.setKeepAlive = (enable, delay) => { seen.push({ enable, delay }); return srv; };
  const b = createConnection(srv, { name: 'B', connId: 'bbbb', initiatedByMe: false });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].enable, true);
  assert.ok(seen[0].delay > 0, `the default delay must be a real one, got ${seen[0].delay}`);

  a.destroy();
  b.destroy();
});

test('a message too large for the wire is refused, not buffered', async () => {
  const { client, srv } = await socketPair();
  const a = createConnection(client, {
    name: 'A', connId: 'aaaa', initiatedByMe: true, maxFrameChars: 200,
  });
  const b = createConnection(srv, { name: 'B', connId: 'bbbb', initiatedByMe: false });
  await Promise.all([once(a, 'hello'), once(b, 'hello')]);

  assert.equal(a.send('x'.repeat(500)), null, 'nothing was written, so there is no id');
  assert.equal(a.sendFrame({ t: 'msg', id: 'big', text: 'x'.repeat(500) }), false);

  // The next message arriving first is the proof: had the oversized one been
  // written it would have been ahead of this one on the same socket.
  assert.ok(a.send('hi'));
  const [received] = await once(b, 'message');
  assert.equal(received.text, 'hi');

  a.destroy();
  b.destroy();
});
// The sender needs an answer it can act on before it writes anything, because
// `sendFrame`'s refusal is indistinguishable from a dead channel — and the
// caller's response to a dead channel is to queue the message and retry it on
// every reconnect, which for an over-limit message means forever.
test('the sender can tell an over-long message from a lost channel', () => {
  assert.equal(messageTooLarge('hello'), false);
  assert.equal(messageTooLarge('x'.repeat(MAX_MESSAGE_CHARS)), false, 'the limit itself fits');
  assert.equal(messageTooLarge('x'.repeat(MAX_MESSAGE_CHARS + 1)), true);
  assert.equal(messageTooLarge(null), false, 'an empty draft is not an oversized one');
  assert.equal(messageTooLarge('xxx', 2), true, 'the ceiling is injectable for tests');
});

// The envelope has to fit inside the frame limit too, or a message that passed
// the composer check would still be refused by the socket write — the exact
// silent queue-forever failure this pair of limits exists to rule out.
test('a message at the ceiling still fits in a frame', async () => {
  const { client, srv } = await socketPair();
  const a = createConnection(client, { name: 'A', connId: 'aaaa', initiatedByMe: true });
  const b = createConnection(srv, { name: 'B', connId: 'bbbb', initiatedByMe: false });
  await Promise.all([once(a, 'hello'), once(b, 'hello')]);

  const longest = 'x'.repeat(MAX_MESSAGE_CHARS);
  assert.ok(a.send(longest), 'the largest message a person may type is written');
  const [received] = await once(b, 'message');
  assert.equal(received.text.length, MAX_MESSAGE_CHARS);

  a.destroy();
  b.destroy();
});

test('a peer that sends an oversized frame loses the connection', async () => {
  const { client, srv } = await socketPair();
  const a = createConnection(client, {
    name: 'A', connId: 'aaaa', initiatedByMe: true, maxFrameChars: 256,
  });
  const failure = once(a, 'protocol-error');
  const closed = once(a, 'close');
  // A raw peer, so nothing here answers the hello: an overflow is not a
  // conversation, it is a channel that has to go.
  srv.write(`{"t":"msg","text":"${'x'.repeat(4000)}"}\n`);
  const [reported] = await failure;
  assert.equal(reported.reason, 'frame-overflow');
  assert.equal(reported.limit, 256);
  assert.ok(reported.size > 256);
  await closed;
  assert.equal(a.writable(), false);

  srv.destroy();
});

test('ping frame triggers automatic pong and measures rtt', async () => {
  const { client, srv } = await socketPair();
  const a = createConnection(client, { name: 'A', connId: 'aaaa', initiatedByMe: true });
  const b = createConnection(srv, { name: 'B', connId: 'bbbb', initiatedByMe: false });
  await Promise.all([once(a, 'hello'), once(b, 'hello')]);

  const pingReceivedP = once(b, 'ping');
  const pongReceivedP = once(a, 'pong');

  const ping = a.sendPing('test-ping-id', Date.now() - 50);
  assert.ok(ping);
  assert.equal(ping.id, 'test-ping-id');

  const [bPing] = await pingReceivedP;
  assert.equal(bPing.id, 'test-ping-id');

  const [aPong] = await pongReceivedP;
  assert.equal(aPong.id, 'test-ping-id');
  assert.ok(aPong.rtt >= 0);
  assert.ok(typeof aPong.echoTs === 'number');

  a.destroy();
  b.destroy();
});