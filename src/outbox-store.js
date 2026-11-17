import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createOutbox } from './outbox.js';
import { openDeviceStore } from './secure-store.js';

// One queue per peer, named from a hash so a crafted peer address cannot climb
// out of the directory while the file stays recognisable.
export function outboxFileFor(dir, peerHost) {
  const safe = String(peerHost ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
  const digest = crypto.createHash('sha256').update(String(peerHost ?? '')).digest('hex').slice(0, 8);
  return path.join(dir, `outbox-${safe || 'peer'}-${digest}.json`);
}

function load(file, store) {
  let raw;
  try {
    raw = store.read(file).toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(file)) return [];
    throw error;
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`Corrupted encrypted outbox: ${file}`); }
  if (!Array.isArray(parsed) || parsed.some((item) => !item
    || typeof item !== 'object' || typeof item.text !== 'string' || !Number.isFinite(item.ts))) {
    throw new Error(`Invalid encrypted outbox: ${file}`);
  }
  return parsed;
}

// Windows answers with a sharing violation where POSIX would simply have
// succeeded: antivirus, Windows Search or the previous rename can hold the JSON
// or its temp file for a few milliseconds. The codes it uses for that are the
// same ones a genuine permission problem uses, which is why the retry below is
// short and bounded — a real EACCES costs three sleeps and then reports.
const SHARING_VIOLATION_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const SHARING_RETRY_DELAYS_MS = [2, 8, 25];

export function isSharingViolation(error) {
  return Boolean(error) && SHARING_VIOLATION_CODES.has(error.code);
}

// The queue is saved from send and reconnect paths that are synchronous event
// handlers, so the back-off has to be synchronous too. Atomics.wait on a
// throwaway buffer is the only sanctioned way to park the thread; tests inject
// their own pause so they never actually sleep.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeQueue(file, items, { store }) {
  // An empty encrypted queue is a durable tombstone, not an unlink: a stale
  // plaintext migration source must never be replayed after delivery.
  store.write(file, Buffer.from(JSON.stringify(items)));
}

// Returns the outcome instead of throwing: the callers are message sends and
// reconnects, and losing the queue file is a far smaller problem than losing the
// session it belongs to.
export function saveOutbox(file, items, {
  store = openDeviceStore(),
  delays = SHARING_RETRY_DELAYS_MS,
  pause = sleepSync,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      writeQueue(file, items, { store });
      return { ok: true };
    } catch (error) {
      if (attempt < delays.length && isSharingViolation(error)) {
        pause(delays[attempt]);
        continue;
      }
      return { ok: false, code: error?.code ?? null, error };
    }
  }
}

// Wraps the in-memory queue so undelivered messages outlive the process. The
// core stays free of I/O; only this layer knows about the disk.
export function createPersistentOutbox({
  file, limit = 500, store = openDeviceStore(), save = saveOutbox, onPersistError = () => {},
}) {
  const inner = createOutbox(limit);
  for (const item of load(file, store)) inner.add(item.text, item.ts, item.id ?? null);

  // The queue stays correct in memory whatever the disk did; only its survival
  // across a restart is at risk, so the failure is handed to the caller to
  // report rather than thrown into a send or a reconnect.
  const persist = () => {
    const result = save(file, inner.pending(), { store });
    if (!result.ok) onPersistError(result);
    return result;
  };

  return {
    add(text, ts, id) {
      const depth = inner.add(text, ts, id);
      persist();
      return depth;
    },
    flush(send) {
      const delivered = inner.flush(send);
      if (delivered > 0) persist();
      return delivered;
    },
    remove(id) {
      const removed = inner.remove(id);
      if (removed) persist();
      return removed;
    },
    size() { return inner.size(); },
    pending() { return inner.pending(); },
    file,
  };
}
