// A picture or a voice note described instead of carried
// (docs/specs/2026-11-03-history-media-refs.md §5–6).
//
// A history record keeps its attachment as a `data:` URL, and until now every
// page of `/api/history` and every live `msg` frame carried those bytes inline:
// one page of 200 records could weigh 64 MiB. A client that asks for it now gets
// `{mime, size, width, height}` / `{mime, size, duration}` and fetches the bytes
// from `GET /api/media?peer=&id=&slot=` when it wants them. The stored record is
// never changed — the description is built on the way out.

import { createHash } from 'node:crypto';

/** What a client announces in `auth.caps`, and the server in `ready.caps`. */
export const MEDIA_REF_CAP = 'media-ref-v1';
export const MEDIA_SLOTS = Object.freeze(['image', 'voice']);
// A message id is checked only for being non-empty when it is stored; the
// media route has to name a bound, or a query string would become an
// unbounded lookup key (§5.1, §6.2).
export const MEDIA_ID_MAX_BYTES = 1024;

const DATA_URL = /^data:([^,]*?);base64,/i;

function decode(dataUrl) {
  const match = DATA_URL.exec(dataUrl);
  if (!match) return null;
  const bytes = Buffer.from(dataUrl.slice(match[0].length), 'base64');
  return bytes.length > 0 ? { mime: match[1], bytes } : null;
}

// Decoding a 7 MiB attachment for every page and every socket is the cost this
// whole change exists to avoid, so the decoded size and the ETag are computed
// once per attachment object and kept — the bytes are not: holding a decoded
// copy beside every stored base64 string would add three quarters again to
// what `accounts.json` already costs in memory. A stored record's attachment is
// one object for as long as the record lives (history copies are shallow), and
// a live frame's is one object for every connection it is sent to. `size` is
// what decoding actually yields, never a formula on the string's length, so it
// is always the `Content-Length` the media route then sends.
const facts = new WeakMap();

/** `{mime, size, etag}` for a stored `{dataUrl,…}`, or null when it holds no bytes. */
export function mediaFacts(media) {
  if (!media || typeof media !== 'object' || typeof media.dataUrl !== 'string') return null;
  const known = facts.get(media);
  if (known && known.dataUrl === media.dataUrl) return known.value;
  const decoded = decode(media.dataUrl);
  const value = decoded
    ? {
      mime: decoded.mime,
      size: decoded.bytes.length,
      etag: `"${createHash('sha256').update(decoded.bytes).digest('base64url').slice(0, 22)}"`,
    }
    : null;
  facts.set(media, { dataUrl: media.dataUrl, value });
  return value;
}

/** `{mime, size, etag, bytes}`: the facts plus the bytes themselves, decoded now. */
export function mediaBytes(media) {
  const found = mediaFacts(media);
  if (!found) return null;
  const decoded = decode(media.dataUrl);
  return decoded ? { ...found, bytes: decoded.bytes } : null;
}

/** The description that replaces `media` in `slot`, or null when there is nothing to fetch. */
export function mediaRef(media, slot) {
  const found = mediaFacts(media);
  if (!found) return null;
  if (slot === 'image') {
    return { mime: found.mime, size: found.size, width: media.width, height: media.height };
  }
  if (slot === 'voice') {
    return { mime: found.mime, size: found.size, duration: media.duration };
  }
  return null;
}

/** A reference as the server hands it out: `{mime, size, …}` and no bytes. */
export function isMediaRefShape(media) {
  return Boolean(media) && typeof media === 'object' && typeof media.dataUrl !== 'string'
    && typeof media.mime === 'string' && Number.isFinite(media.size) && media.size > 0;
}

/**
 * What a receiving client keeps of a frame's `image`/`voice`: inline bytes or
 * a reference, and `undefined` for anything else — omitted rather than null so
 * a receiver's destructuring default still applies.
 */
export function frameAttachment(media) {
  if (!media || typeof media !== 'object') return undefined;
  return typeof media.dataUrl === 'string' || isMediaRefShape(media) ? media : undefined;
}

/** Whether `id` can address an attachment: present, bounded, printable. */
export function addressableId(id) {
  if (typeof id !== 'string' || id === '') return false;
  if (Buffer.byteLength(id, 'utf8') > MEDIA_ID_MAX_BYTES) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(id);
}

/**
 * `message` with every inline attachment replaced by its description. The
 * same object comes back when there is nothing to replace, and never a mutated
 * one: a live frame is shared by every connection it is sent to.
 *
 * A record without an addressable id keeps its inline form — there is no way
 * to fetch it otherwise. An attachment whose bytes decode to nothing is left
 * out: there is nothing to download, and no client draws an empty `data:` URL.
 */
export function withMediaRefs(message) {
  if (!message || typeof message !== 'object') return message;
  const slots = MEDIA_SLOTS.filter((slot) => typeof message[slot]?.dataUrl === 'string');
  if (slots.length === 0 || !addressableId(message.id)) return message;
  const out = { ...message };
  for (const slot of slots) {
    const ref = mediaRef(message[slot], slot);
    if (ref) out[slot] = ref;
    else delete out[slot];
  }
  return out;
}

/**
 * One `Range` header against `size` bytes: `{start, end}` (inclusive) for a
 * single satisfiable range, `'unsatisfiable'`, or null for "send it whole" —
 * no header, a syntax this does not serve (several ranges), or nonsense, which
 * RFC 9110 says to ignore rather than refuse.
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!match) return null;
  const [, first, last] = match;
  if (first === '' && last === '') return null;
  if (first === '') {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix)) return null;
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (!Number.isSafeInteger(start)) return null;
  if (start >= size) return 'unsatisfiable';
  let end = last === '' ? size - 1 : Number(last);
  if (!Number.isSafeInteger(end) || end < start) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}
