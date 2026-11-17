import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { encodeFrame, createFrameParser, MAX_FRAME_CHARS } from './frames.js';
import { VERSION } from './version.js';
import { frameAttachment } from './cloud/media-ref.js';

const RECEIPTS = new Set(['ack', 'read']);
// The same ceiling `src/cloud/hub.js` puts on a deletion batch: one tap on
// «выделить всё» in a long thread must not become one frame carrying a
// thousand ids of unbounded length.
const DEL_MAX_IDS = 200;
const FILE_FRAMES = new Set(['file-offer', 'file-chunk', 'file-done', 'file-deny']);
const ACTION_LIMIT = 8;
const ACTION_ID_MAX = 40;
const ACTION_LABEL_MAX = 40;
const ACTION_VALUE_MAX = 200;

function frameActions(value) {
  if (!Array.isArray(value)) return [];
  const actions = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    const actionValue = typeof item.value === 'string' ? item.value.trim() : '';
    if (!id || id.length > ACTION_ID_MAX || !label || label.length > ACTION_LABEL_MAX
      || !actionValue || actionValue.length > ACTION_VALUE_MAX) continue;
    actions.push({ id, label, value: actionValue });
    if (actions.length === ACTION_LIMIT) break;
  }
  return actions;
}
// A chat is idle for hours at a time, and idle is exactly when a route can
// vanish without either side being told: a NAT forgets the mapping, a Tailscale
// path is rebuilt through a different relay, and the socket stays open with
// nothing behind it. No FIN, no RST, so no 'close' — the rendezvous keeps
// thinking it has a channel, suppresses reconnect, and quietly buffers every
// message the person types. Keepalive probes turn that silence into
// ETIMEDOUT/ECONNRESET, which is a 'close', which is all the reconnect needs.
// Twenty seconds before the first probe is invisible on a metered link and puts
// the whole detection inside the operating system's own probe schedule, roughly
// ten minutes; that is the bound available without changing the protocol.
//
// Deliberately no application-level heartbeat on top: a 0.52.0 peer answers
// nothing it does not recognise, so unanswered pings could never be read as
// failure, and a ping nobody may answer costs bytes while proving nothing.
const KEEPALIVE_MS = 20_000;
export const newMessageId = () => crypto.randomBytes(8).toString('hex');
// What one message may hold, as opposed to what the wire will carry: the
// difference is the JSON envelope around it, and being generous about that costs
// nothing next to the frame ceiling. This exists so the sender can say no where
// a person can read the answer. `sendFrame` also refuses an over-limit frame,
// but its `false` already means "the channel is gone, keep the message", so the
// outbox would queue such a message and retry it on every reconnect forever —
// which is exactly the silent failure the ceiling was added to prevent.
export const MAX_MESSAGE_CHARS = MAX_FRAME_CHARS - 1024;

export function messageTooLarge(text, limit = MAX_MESSAGE_CHARS) {
  return String(text ?? '').length > limit;
}

// A quote and a tally of reactions ride on a message frame the same way an
// attachment does, and both are maps the renderer walks. A string, a null or
// an array where one belongs is a malformed frame, not a quote — dropped
// rather than passed on, so nothing downstream has to re-check the shape.
const frameObject = (value) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
);

export function createConnection(socket, {
  name,
  connId,
  initiatedByMe,
  keepAliveMs = KEEPALIVE_MS,
  maxFrameChars = MAX_FRAME_CHARS,
}) {
  const ev = new EventEmitter();
  let peerName = null;
  let gotHello = false;

  const parser = createFrameParser((frame) => {
    if (frame.t === 'hello') {
      if (gotHello) return;
      gotHello = true;
      peerName = typeof frame.name === 'string' ? frame.name : 'peer';
      const channelConnId = initiatedByMe ? connId : String(frame.connId);
      const peerVersion = typeof frame.v === 'string' ? frame.v : null;
      ev.emit('hello', { peerName, channelConnId, peerVersion });
    } else if (frame.t === 'msg' && gotHello) {
      const text = typeof frame.text === 'string' ? frame.text : '';
      const ts = Number.isFinite(frame.ts) ? frame.ts : Date.now();
      // A peer that predates message ids cannot be acked; surface that as null
      // instead of inventing an id the sender would never recognise.
      const id = typeof frame.id === 'string' ? frame.id : null;
      // A cloud peer — including a browser client that never speaks this file-chunk
      // protocol at all — attaches a picture or a voice note as a base64 data URL
      // right on the message frame — or, from a server that knows this client
      // announced `media-ref-v1`, a reference to `/api/media`. Passed through only
      // when it actually looks like one of the two, and omitted rather than null so a receiver's destructuring default
      // still applies.
      const image = frameAttachment(frame.image);
      const voice = frameAttachment(frame.voice);
      const replyTo = frameObject(frame.replyTo);
      const reactions = frameObject(frame.reactions);
      // «Переслано от …»: who said it first, carried on the copy.
      const forwardedFrom = frameObject(frame.forwardedFrom);
      ev.emit('message', {
        name: peerName, text, ts, id, image, voice, replyTo, reactions, forwardedFrom,
      });
    } else if (frame.t === 'ai' && gotHello) {
      // A third voice the peer's client produced. It is not their message, so it
      // carries its own author and takes no receipts: there is nobody on the
      // other end waiting to see a ✓ against it.
      const text = typeof frame.text === 'string' ? frame.text : '';
      const image = frameAttachment(frame.image);
      const voice = frameAttachment(frame.voice);
      if (text !== '' || image || voice) {
        ev.emit('ai', {
          name: typeof frame.name === 'string' && frame.name !== '' ? frame.name : 'ai',
          text,
          ts: Number.isFinite(frame.ts) ? frame.ts : Date.now(),
          id: typeof frame.id === 'string' ? frame.id : null,
          image,
          voice,
        });
      }
    } else if (frame.t === 'del' && gotHello) {
      const ids = Array.isArray(frame.ids)
        ? frame.ids.filter((id) => typeof id === 'string' && id !== '').slice(0, DEL_MAX_IDS)
        : [];
      if (ids.length > 0) ev.emit('del', { ids });
    } else if (frame.t === 'edit' && gotHello) {
      const id = typeof frame.id === 'string' ? frame.id : '';
      const text = typeof frame.text === 'string' ? frame.text : '';
      if (id !== '') ev.emit('edit', { id, text });
    } else if (frame.t === 'react' && gotHello) {
      const id = typeof frame.id === 'string' ? frame.id : '';
      const emoji = typeof frame.emoji === 'string' ? frame.emoji : '';
      const by = typeof frame.by === 'string' ? frame.by : '';
      if (id !== '' && emoji !== '' && by !== '') {
        ev.emit('react', { id, emoji, by, add: frame.add !== false });
      }
    } else if (RECEIPTS.has(frame.t) && gotHello) {
      if (typeof frame.id === 'string') ev.emit(frame.t, { id: frame.id });
    } else if (FILE_FRAMES.has(frame.t) && gotHello) {
      if (typeof frame.id === 'string') ev.emit(frame.t, frame);
    } else if (frame.t === 'typing' && gotHello) {
      // The name is optional: a plain "the person is typing" from an old
      // client, or a named voice — the AI — composing under its own name.
      ev.emit('typing', {
        state: frame.state === 'start' ? 'start' : 'stop',
        name: typeof frame.name === 'string' ? frame.name : undefined,
      });
    } else if (frame.t === 'actions' && gotHello) {
      ev.emit('actions', { actions: frameActions(frame.actions) });
    } else if (frame.t === 'focus' && gotHello) {
      // Presence: whether the peer's window is in front of them, and for how
      // long. Validation lives with the state machine, not here.
      ev.emit('focus', { state: frame.state });
    } else if (frame.t === 'wake' && gotHello) {
      ev.emit('wake', {});
    } else if (frame.t === 'logo' && gotHello) {
      // The peer replayed the logo and wants it seen on both screens. It carries
      // nothing: what to draw is the client's own art, at the client's own width.
      ev.emit('logo', {});
    } else if (frame.t === 'holiday' && gotHello && typeof frame.on === 'boolean') {
      // A shared visual switch. Only an actual boolean changes the peer's
      // persisted choice; malformed or older experimental frames are ignored.
      ev.emit('holiday', { on: frame.on });
    } else if (frame.t === 'bye' && gotHello) {
      ev.emit('bye', { reason: typeof frame.reason === 'string' ? frame.reason : '' });
    } else if (frame.t === 'devices' && gotHello) {
      // Which machines the peer owns. Data, not permission: inbound is still
      // authorised by the local daemon, so this cannot talk anyone in.
      ev.emit('devices', { login: frame.login, name: frame.name, devices: frame.devices });
    } else if (frame.t === 'update' && gotHello) {
      // The peer noticed we are behind and says so, instead of both sides
      // guessing from a version string nobody reads.
      ev.emit('update', { version: typeof frame.version === 'string' ? frame.version : null });
    } else if (frame.t === 'caps' && gotHello) {
      // What the peer's terminal can actually do, so the other side never has
      // to guess why a receipt is missing — and who owns the answering, so the
      // two do not both answer the same mention.
      //
      // `ai` says "answers here are mine", not "I hold an API key": that is what
      // the receiver does with it, deferring while it is true. `aiMuted` carries
      // the reason when the answer is that nobody answers, so a client can say
      // why it is silent instead of leaving a question hanging. An older peer
      // sends neither field and reads as neither.
      ev.emit('caps', {
        focus: frame.focus === true,
        ai: frame.ai === true,
        muted: frame.aiMuted === true,
      });
    } else if (frame.t === 'ping' && gotHello) {
      const id = typeof frame.id === 'string' ? frame.id : newMessageId();
      const ts = Number.isFinite(frame.ts) ? frame.ts : Date.now();
      ev.sendFrame({ t: 'pong', id, ts, echoTs: Date.now() });
      ev.emit('ping', { id, ts });
    } else if (frame.t === 'pong' && gotHello) {
      const id = typeof frame.id === 'string' ? frame.id : null;
      const ts = Number.isFinite(frame.ts) ? frame.ts : Date.now();
      const rtt = Math.max(0, Date.now() - ts);
      ev.emit('pong', { id, ts, echoTs: Number.isFinite(frame.echoTs) ? frame.echoTs : Date.now(), rtt });
    }
    // unknown t, or msg before hello → ignored
  }, {
    maxChars: maxFrameChars,
    onOverflow: ({ size, limit }) => {
      // A peer that puts a frame this size on the wire is either broken or
      // hostile, and either way there is nothing left to say here: the frame was
      // thrown away, so the conversation is out of step with whatever the sender
      // thinks it said. Report the fact — the rendezvous turns it into a line
      // the person can read — and drop the socket so the ordinary reconnect
      // takes over instead of a channel that silently eats frames.
      ev.emit('protocol-error', { reason: 'frame-overflow', size, limit });
      socket.destroy();
    },
  });

  socket.on('data', (chunk) => parser(chunk));
  socket.on('close', () => ev.emit('close'));
  socket.on('error', () => {}); // 'close' follows; surface via close only
  // Node queues this until the socket connects, so it covers a dialled socket as
  // well as one that arrived already established.
  socket.setKeepAlive(true, keepAliveMs);

  // send our hello immediately (queued until TCP connect completes)
  // Version rides along so each side can warn about a stale peer; older
  // clients simply omit it and are reported as unknown.
  socket.write(encodeFrame({ t: 'hello', name, connId, v: VERSION }));

  ev.sendFrame = (frame) => {
    if (!socket.writable) return false;
    const line = encodeFrame(frame);
    // Node's write queue has no ceiling of its own: a pasted logfile becomes one
    // frame and sits in memory until the wire has drained it, and a burst of
    // them piles up the same way. Refusing it is not merely tidier — a peer
    // running this same ceiling on its parser drops the connection the moment
    // such a frame arrives, so writing it would trade one rejected message for a
    // dead channel. `false` already means "not delivered, keep it", which is
    // exactly what the caller must do with something it cannot put on the wire.
    if (line.length > maxFrameChars) return false;
    socket.write(line);
    return true;
  };

  // A file is the only thing big enough to outrun the socket, and `sendFrame`
  // cannot report that: its `false` already means "the channel is gone", which
  // the outbox reads as "queue it again". So a separate set.
  // `writeFrame` returns false when the buffer is full — the frame is written
  // either way, so the caller waits rather than resends. `writable` is how the
  // caller tells that apart from a channel that has actually gone: a peer that
  // quits sends FIN, Node ends this side too, and the socket is unwritable long
  // before 'close' reaches anyone.
  ev.writable = () => socket.writable;

  // No frame ceiling here, on purpose: this path carries only frames we built
  // ourselves, chunked at CHUNK_BYTES and therefore far below it, and `false`
  // here means "wait for drain". A refusal expressed that way would leave the
  // sender waiting for a frame that was never written, which is worse than the
  // oversized write it was meant to prevent.
  ev.writeFrame = (frame) => {
    if (!socket.writable) return false;
    return socket.write(encodeFrame(frame));
  };

  // Resolves once everything written so far has left Node's buffer — or as soon
  // as the channel stops being able to take it. An empty write is a no-op that
  // still queues its callback behind the real bytes, which is what makes this
  // work after a `write` that returned true as well as after one that returned
  // false ('drain' only ever follows the latter). But that callback waits for a
  // peer that may never read again: a peer that quits mid-transfer sends FIN and
  // then reads nothing, and the queue never empties. So 'end', 'error' and
  // 'close' settle it too, and the caller finds `writable` false and says so
  // instead of hanging with an indicator spinning over a dead socket.
  ev.flushed = () => new Promise((resolve) => {
    if (!socket.writable || socket.writableLength === 0) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.off('end', finish);
      socket.off('error', finish);
      socket.off('close', finish);
      resolve();
    };
    socket.on('end', finish);
    socket.on('error', finish);
    socket.on('close', finish);
    socket.write('', finish);
  });

  // Returns the message id so the caller can track its receipt state, or null
  // when the channel is gone and nothing was written. The caller may supply the
  // id so a message queued while offline keeps one identity end to end.
  ev.send = (text, ts = Date.now(), id = newMessageId()) => (
    ev.sendFrame({ t: 'msg', id, text, ts }) ? id : null
  );

  ev.sendReceipt = (kind, id) => {
    if (!RECEIPTS.has(kind)) throw new Error(`unknown receipt: ${kind}`);
    return ev.sendFrame({ t: kind, id });
  };
  ev.sendPing = (id = newMessageId(), ts = Date.now()) => (
    ev.sendFrame({ t: 'ping', id, ts }) ? { id, ts } : null
  );
  ev.sendPong = (id, ts = Date.now()) => (
    ev.sendFrame({ t: 'pong', id, ts, echoTs: Date.now() })
  );
  ev.destroy = () => socket.destroy();
  ev.socket = socket;
  return ev;
}
