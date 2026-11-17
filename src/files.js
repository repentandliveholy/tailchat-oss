import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDeviceStore } from './secure-store.js';

export const CHUNK_BYTES = 48 * 1024;
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

// Every accepted offer buffers its whole payload in memory until the digest
// checks out, so the receiver needs ceilings a peer cannot argue with: a cap on
// how many transfers may be in flight at once, a cap on the bytes they have
// promised between them, and a window after which a stream that stopped
// arriving is forgotten instead of held for the life of the process.
export const DEFAULT_MAX_TRANSFERS = 8;
export const DEFAULT_MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
export const DEFAULT_TRANSFER_IDLE_MS = 5 * 60 * 1000;

// Where a received file has to land to be of any use. Inside Termux the home
// directory is private to the app: a photo saved there is invisible to the
// gallery, the player and every share sheet, so the transfer arrives and then
// cannot be opened by anything.
//
// The shared Download folder is the one place both sides reach. It is looked for
// by these paths in order rather than by one of them, because
// `termux-setup-storage` is often half-done: on the phone this was written for,
// `~/storage/downloads` existed as an ordinary private directory — writable,
// tidy-looking and just as invisible as the home folder. So the genuinely shared
// paths are tried first, and only a writable one counts.
export const SHARED_DOWNLOADS = [
  'storage/shared/Download',
  '/sdcard/Download',
  '/storage/emulated/0/Download',
];

export function defaultFilesDir({
  home,
  termux = false,
  writable = (dir) => {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  },
} = {}) {
  if (termux) {
    for (const candidate of SHARED_DOWNLOADS) {
      const dir = path.isAbsolute(candidate) ? candidate : path.join(home, candidate);
      if (writable(dir)) return path.join(dir, 'tailchat');
    }
  }
  return path.join(home, '.tailchat', 'files');
}

// State is the opposite case: an outbox, a roster and a pid file have no business
// sitting in a folder the person browses, and shared storage on Android drops
// permissions besides.
export function defaultStateDir(home) {
  return path.join(home, '.tailchat');
}
// A peer controls this string, so reduce it to a bare name; the digest keeps
// different raw keys apart. The same stem names the peer memory, the transcript
// and every other per-conversation file, so they sit together in one place.
export function peerFileStem(key) {
  const safe = String(key ?? '').replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 48);
  const digest = crypto.createHash('sha256').update(String(key ?? '')).digest('hex').slice(0, 8);
  return `peer-${safe || 'peer'}-${digest}`;
}

// A one-shot instruction from an in-app /peer: the next process starts with this
// peer even though the shell (supervised or not) restarts it with the same
// arguments as before.
const NEXT_PEER = 'next-peer';

export function nextPeerFile(stateDir) {
  return path.join(stateDir, NEXT_PEER);
}

export function takeNextPeer(stateDir, {
  readFile = fs.readFileSync, unlink = fs.unlinkSync,
  truncate = (file) => fs.writeFileSync(file, ''),
  onError = () => {},
} = {}) {
  const file = nextPeerFile(stateDir);
  let value;
  try {
    value = String(readFile(file, 'utf8')).trim();
  } catch {
    return null; // no note, or one nobody can read: nothing was asked for
  }
  if (!value) return null;
  try {
    unlink(file);
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return value; // already gone; the value stands
    // Windows refuses to unlink a file any handle still holds — an antivirus
    // scan, an indexer, or the editor the person left open — and this note is
    // read at every start. Swallowing that error meant a single in-app /peer
    // dragged them back to the same conversation on every supervised restart,
    // for as long as the file survived. Emptying it consumes it a second way,
    // because a blank note reads as no note at all.
    try {
      truncate(file);
      return value;
    } catch (fallbackError) {
      // Neither way worked, so the switch will happen again. Say so rather than
      // let the person guess why they keep landing in the same chat.
      onError(fallbackError);
      return value;
    }
  }
}

export function writeNextPeer(stateDir, peer) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(nextPeerFile(stateDir), `${String(peer).trim()}\n`, { mode: 0o600 });
}


// Characters Windows will not accept in a name, and the device names it hands to
// hardware instead of the filesystem however they are spelled and whatever
// extension is glued on: `NUL.txt` is still the null device.
const WINDOWS_FORBIDDEN = /[<>:"|?*]/g;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// A peer controls this string, so reduce it to a bare name. Without this a
// transfer could write outside the download directory.
//
// The Windows pass exists because the two sides need not agree on what a name
// may contain. `Q3 2025: notes?.txt` is unremarkable on a Mac and simply cannot
// be created on Windows, so the transfer failed at the last step with a raw
// errno in the chat and no way for either person to fix it — the sender does not
// choose the receiver's filesystem. Every offending part is replaced rather than
// refused, so the file still arrives under a name its owner recognises.
export function safeFileName(name, { platform = process.platform } = {}) {
  const raw = String(name ?? '');
  const base = path.basename(raw.replace(/\\/g, '/'));
  if (base === '' || base === '.' || base === '..') return 'file';
  const bare = base.replace(/[\u0000-\u001f\u007f]/g, '');
  if (platform !== 'win32') return bare;
  // Windows strips trailing dots and spaces without saying so, which turns
  // `report .` into `report` behind our back: two distinct offers would then
  // land on one file and the collision check would never see it coming.
  const trimmed = bare.replace(WINDOWS_FORBIDDEN, '_').replace(/[. ]+$/, '');
  const ext = path.extname(trimmed);
  if (WINDOWS_DEVICE.test(path.basename(trimmed, ext))) return `_${trimmed}`;
  return trimmed || 'file';
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function* chunkFile(buffer, size = CHUNK_BYTES) {
  for (let offset = 0; offset < buffer.length; offset += size) {
    yield buffer.subarray(offset, Math.min(offset + size, buffer.length));
  }
}

// The lookup is a parameter because it is the one part of naming the target that
// can fail: a mount that went away or a share that stopped answering makes the
// search throw, and that has to be reportable rather than fatal.
function uniquePath(dir, name, exists = fs.existsSync) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let n = 2;
  while (exists(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n++;
  }
  return candidate;
}

// Whether one more offer may be let in. Separated out because the interesting
// part is arithmetic, not plumbing: a peer that opens offers and never finishes
// them used to grow the receiver's memory without limit, and an abandoned
// transfer stayed resident for the rest of the run. The declared size is what
// gets counted, since the point is to refuse before the bytes are allocated
// rather than notice afterwards.
export function admitOffer({
  declared, maxBytes = DEFAULT_MAX_BYTES, transfers = 0, reserved = 0,
  maxTransfers = DEFAULT_MAX_TRANSFERS,
  maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
}) {
  if (!Number.isFinite(declared) || declared < 0) {
    return { accepted: false, reason: 'bad size' };
  }
  if (declared > maxBytes) {
    return {
      accepted: false,
      reason: `too large: ${formatBytes(declared)} exceeds ${formatBytes(maxBytes)}`,
    };
  }
  if (transfers >= maxTransfers) {
    return {
      accepted: false,
      reason: `too many transfers at once: ${maxTransfers} already in flight`,
    };
  }
  if (reserved + declared > maxBufferedBytes) {
    return {
      accepted: false,
      reason: `too much in flight: ${formatBytes(reserved + declared)}`
        + ` would exceed ${formatBytes(maxBufferedBytes)}`,
    };
  }
  return { accepted: true };
}

export function createFileReceiver({
  dir,
  maxBytes = DEFAULT_MAX_BYTES,
  maxTransfers = DEFAULT_MAX_TRANSFERS,
  // Whichever is larger, so raising --max-file above the aggregate default does
  // not quietly make every single transfer it now permits impossible.
  maxBufferedBytes = Math.max(DEFAULT_MAX_BUFFERED_BYTES, maxBytes),
  idleMs = DEFAULT_TRANSFER_IDLE_MS,
  now = Date.now,
  platform = process.platform,
  exists = fs.existsSync,
  store = null,
  writeFile = (target, payload) => {
    if (store) return store.write(target, payload);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, payload, { mode: 0o600 });
  },
}) {
  const occupied = (candidate) => exists(candidate) || (store ? exists(store.fileFor(candidate)) : false);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700); // an existing directory keeps its old mode
  } catch { /* filesystem without POSIX modes */ }

  const active = new Map();

  const discard = (id) => {
    active.delete(id);
  };

  // What the accepted offers have promised between them. The map holds at most
  // `maxTransfers` entries, so summing on demand is cheaper than keeping a
  // running total honest across every early return.
  const reservedBytes = () => {
    let total = 0;
    for (const transfer of active.values()) total += transfer.size;
    return total;
  };

  // A stream that stopped arriving — the sender crashed, the tailnet dropped,
  // `file-done` never came — holds its bytes and its slot until something says
  // otherwise. This module has nothing to hang a timer on and no shutdown hook
  // to clear one with, so ageing is driven by the calls that already happen and
  // by `sweep()` for a caller with a tick of its own.
  const expire = (at) => {
    let dropped = 0;
    for (const [id, transfer] of active) {
      if (at - transfer.touched >= idleMs) {
        discard(id);
        dropped++;
      }
    }
    return dropped;
  };

  return {
    offer({ id, name, size, sha256 }) {
      const at = now();
      expire(at);
      const verdict = admitOffer({
        declared: Number(size),
        maxBytes,
        transfers: active.size,
        reserved: reservedBytes(),
        maxTransfers,
        maxBufferedBytes,
      });
      if (!verdict.accepted) return verdict;

      const safe = safeFileName(name, { platform });
      // Buffer in memory and only touch the disk once the digest checks out, so
      // a failed or hostile transfer never leaves a partial file behind.
      active.set(id, {
        name: safe,
        size: Number(size),
        sha256: String(sha256 ?? ''),
        received: 0,
        parts: [],
        touched: at,
      });
      return { accepted: true, name: safe };
    },

    chunk({ id, data }) {
      const transfer = active.get(id);
      if (!transfer) return { ok: false, reason: 'unknown transfer' };

      const buf = Buffer.from(String(data ?? ''), 'base64');
      if (transfer.received + buf.length > transfer.size) {
        discard(id);
        return { ok: false, reason: 'stream exceeds the offered size' };
      }
      transfer.touched = now();
      transfer.parts.push(buf);
      transfer.received += buf.length;
      return { ok: true, received: transfer.received, size: transfer.size };
    },

    done({ id }) {
      const transfer = active.get(id);
      if (!transfer) return { ok: false, reason: 'unknown transfer' };
      discard(id);

      const payload = Buffer.concat(transfer.parts);
      if (payload.length !== transfer.size) {
        return { ok: false, reason: 'truncated transfer' };
      }
      const digest = crypto.createHash('sha256').update(payload).digest('hex');
      if (digest !== transfer.sha256) {
        return { ok: false, reason: 'checksum mismatch' };
      }

      let target;
      try {
        // Choosing the name looks up the directory, and a lookup can fail as
        // readily as a write: it used to sit outside this guard and throw out
        // through the socket's data callback, taking the whole conversation down
        // with the one file it could not name.
        target = uniquePath(dir, transfer.name, occupied);
        writeFile(target, payload);
      } catch (error) {
        // Shared storage on Android can stop being writable between the offer and
        // the last chunk — a revoked permission or a full card must be reported,
        // not thrown through the chat loop.
        return { ok: false, reason: error.message };
      }
      try {
        if (store) fs.chmodSync(store.fileFor(target), 0o600);
        else fs.chmodSync(target, 0o600);
      } catch { /* filesystem without POSIX modes */ }
      return { ok: true, path: target, size: payload.length };
    },

    inFlight() {
      return active.size;
    },

    reservedBytes,

    // For a caller with a periodic tick: forget the streams that stopped
    // arriving so their bytes and their slots come back before the next offer
    // needs them.
    sweep() {
      const dropped = expire(now());
      return { dropped, inFlight: active.size, reservedBytes: reservedBytes() };
    },

    abortAll() {
      active.clear();
    },
  };
}
