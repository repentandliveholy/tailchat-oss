// Which frames the core owns and which the classic client code keeps — one
// table for every client that puts the core under its existing transport: the
// terminal (`src/cloud/core-link.js`, under link.js) and the browser
// (`web/cloud/core/web-session.js`, under app.js). Pure: no socket, no DOM, no
// Node built-ins, so the browser and the Node tests load the same file.
//
//   client → server  (`routeOutbound`)
//     auth, sync                swallowed — the core authenticates and owns the feed
//     inner msg, plain text     the core's durable send (`sendText`)
//     inner ack                 swallowed — the core acks once the row is on disk
//     everything else           raw (subscribe, read, typing, media, replies, …)
//
//   server → client  (`ownsInbound`)
//     message-accepted, sync-page, sync-nudge, to-device…, peer ack/read,
//     encrypted frames          core only
//     everything else           handed to the classic code as if it came off
//                               the socket
//
// The one exception both ways is a message the classic code sent as a raw frame
// (a reply, a forward, a picture): the core never saw it go out, so its
// acceptance and its receipts keep reaching the code that sent it.

// The inner `msg` frame the core can carry: its own four fields and nothing
// else. A reply, a forward or an inline picture/voice note adds keys the core's
// text action has no place for, and those keep travelling as raw frames.
const PLAIN_MESSAGE_KEYS = new Set(['t', 'id', 'text', 'ts']);

function isPlainMessage(to, d) {
  if (typeof to !== 'string' || to === '') return false;
  if (typeof d.id !== 'string' || d.id === '') return false;
  if (typeof d.text !== 'string' || d.text.trim() === '') return false;
  return Object.keys(d).every((key) => PLAIN_MESSAGE_KEYS.has(key));
}

/**
 * Where one outbound frame goes: `{ route: 'swallow' }`,
 * `{ route: 'text', peer, id, text }` or `{ route: 'raw', sent? }`, where
 * `sent` names an inner `msg` the core does not track.
 */
export function routeOutbound(text) {
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return { route: 'raw' };
  }
  switch (frame?.k) {
    case 'auth':
    case 'sync':
      return { route: 'swallow' };
    case 'frame':
      break;
    default:
      return { route: 'raw' };
  }
  const d = frame.d;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { route: 'raw' };
  if (d.t === 'ack') return { route: 'swallow' };
  if (d.t !== 'msg' || typeof d.id !== 'string' || d.id === '') return { route: 'raw' };
  if (isPlainMessage(frame.to, d)) return { route: 'text', peer: frame.to, id: d.id, text: d.text };
  return { route: 'raw', sent: { peer: frame.to, id: d.id } };
}

// Frames this small are parsed to read an inner `t`; bigger ones are media or
// a long feed page and are never an `ack`/`read`.
export const SMALL_FRAME_CHARS = 64 * 1024;
const ENVELOPE_HEAD = /^\s*\{\s*"k"\s*:\s*"([^"\\]{1,40})"/;

/**
 * The envelope name of one server frame, read without parsing the whole of it
 * when the server's usual key order allows.
 */
export function inboundKind(raw) {
  const head = ENVELOPE_HEAD.exec(raw.length > 96 ? raw.slice(0, 96) : raw);
  if (head) return head[1];
  if (raw.length > SMALL_FRAME_CHARS) return null;
  try {
    const kind = JSON.parse(raw)?.k;
    return typeof kind === 'string' ? kind : null;
  } catch {
    return null;
  }
}

const CORE_ENVELOPES = new Set([
  'message-accepted', 'sync-page', 'sync-nudge',
  'to-device', 'to-device-accepted', 'device-list-changed',
]);
const CORE_RECEIPTS = new Set(['ack', 'read']);

function namesRawSent(raw, rawSent) {
  if (rawSent.size === 0 || raw.length > SMALL_FRAME_CHARS) return false;
  try {
    const id = JSON.parse(raw)?.id;
    return typeof id === 'string' && rawSent.has(id);
  } catch {
    return false;
  }
}

/**
 * Whether the core owns this inbound frame outright. The classic code would
 * mark a row from it — a second, competing source of the marks the core keeps.
 * Encrypted frames (`d.e2ee`) are owned too: the core decrypts them and says
 * `stored`, and the client paints the decrypted row from `conversation()`.
 * `rawSent` holds the ids of messages sent as raw frames (see the header).
 */
export function ownsInbound(raw, rawSent = new Set(), kind = inboundKind(raw)) {
  if (kind === 'message-accepted') return !namesRawSent(raw, rawSent);
  if (CORE_ENVELOPES.has(kind)) return true;
  if (kind !== 'frame') return false;
  if (raw.length > SMALL_FRAME_CHARS && !raw.includes('"e2ee"')) return false;
  let d;
  try {
    d = JSON.parse(raw)?.d;
  } catch {
    return false;
  }
  if (d && typeof d === 'object' && d.e2ee && typeof d.e2ee === 'object') return true;
  if (!CORE_RECEIPTS.has(d?.t)) return false;
  return !(typeof d.id === 'string' && rawSent.has(d.id));
}

// Raw-sent ids remembered at most: a long session sends many replies.
export const RAW_SENT_LIMIT = 256;

/** Remembers one raw-sent id, newest last, bounded. */
export function rememberRawSent(rawSent, id) {
  rawSent.delete(id);
  rawSent.add(id);
  if (rawSent.size > RAW_SENT_LIMIT) rawSent.delete(rawSent.values().next().value);
}
