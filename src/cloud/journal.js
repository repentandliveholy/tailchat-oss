import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { READY_FILE } from './storage-crypto.js';

// The write-ahead log that stands between «принято» and the disk.
//
// `accounts.json` is rewritten whole and debounced, so between a message being
// accepted and the next rename there is a window in which the only copy of it
// is in memory — a kill -9 there loses a message the sender was already told
// had arrived. Every commit is appended here as one NDJSON line and fsynced
// first; the snapshot is a checkpoint of the same data, and the lines it
// already contains are dropped once the rename has succeeded.
//
// Nothing here knows what an entry means. The one field it reads is `seq`,
// which orders entries against the snapshot the checkpoint just wrote.
export function createJournal({ file, mode = 0o600, cipher = null } = {}) {
  if (typeof file !== 'string' || file === '') throw new TypeError('createJournal requires file');
  if (!cipher && fs.existsSync(path.join(path.dirname(file), READY_FILE))) {
    throw new Error('Encrypted cloud journal requires a cipher; plaintext writes are refused');
  }

  const temp = `${file}.rewrite`;
  let handle = null;
  // Every write is queued behind the previous one: two appends racing on one
  // O_APPEND fd would still both land, but a checkpoint must never see half a
  // line, and `lastSeq` must never be read while an append is deciding it.
  let chain = Promise.resolve();
  let lastSeq = 0;
  let closed = false;

  function enqueue(step) {
    const run = chain.then(step, step);
    // A failed write belongs to the caller that queued it; the next one starts
    // from a clean promise rather than inheriting the rejection.
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function fd() {
    if (!handle) handle = await fsp.open(file, 'a', mode);
    return handle;
  }

  async function reopen() {
    const previous = handle;
    handle = null;
    if (previous) await previous.close().catch(() => {});
  }

  // Resolves only once the line is on the platter. A caller that acknowledges
  // before this promise settles is promising something it does not know.
  function append(entry) {
    if (closed) return Promise.reject(new Error('journal is closed'));
    const line = `${cipher ? cipher.seal(Buffer.from(JSON.stringify(entry)), 'accounts.journal') : JSON.stringify(entry)}\n`;
    const seq = Number.isFinite(entry?.seq) ? entry.seq : 0;
    return enqueue(async () => {
      const target = await fd();
      await target.write(line);
      await target.sync();
      if (seq > lastSeq) lastSeq = seq;
    });
  }

  // Read back at start-up, before anything else can write: synchronous because
  // the store it feeds is built synchronously, and this happens once.
  //
  // A process killed mid-append can leave a partial final envelope. Only that
  // unterminated, unparseable fragment is unacknowledged and removable.
  // Complete encrypted entries, including a final entry without a newline,
  // must authenticate; tampering must stop boot, never skip a valid commit.
  function replay(apply) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
    let applied = 0;
    const lines = raw.split('\n');
    for (const [index, line] of lines.entries()) {
      if (line === '') continue;
      let entry = null;
      try {
        entry = JSON.parse(cipher ? cipher.open(line, 'accounts.journal').toString('utf8') : line);
      } catch (error) {
        if (cipher) {
          let partial = false;
          try { JSON.parse(line); } catch { partial = true; }
          if (!partial || index !== lines.length - 1 || raw.endsWith('\n')) throw error;
        }
        continue;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        if (cipher) throw new Error('Encrypted cloud journal contains an invalid entry');
        continue;
      }
      if (Number.isFinite(entry.seq) && entry.seq > lastSeq) lastSeq = entry.seq;
      try {
        if (apply(entry) !== false) applied += 1;
      } catch (error) {
        if (cipher) throw error;
      }
    }
    if (cipher && raw && !raw.endsWith('\n')) {
      const lastLine = lines.at(-1);
      let complete = false;
      try { JSON.parse(lastLine); complete = true; } catch {}
      const target = fs.openSync(file, 'r+');
      try {
        if (complete) fs.writeSync(target, '\n', Buffer.byteLength(raw), 'utf8');
        else fs.ftruncateSync(target, Buffer.byteLength(raw.slice(0, raw.lastIndexOf('\n') + 1)));
        fs.fsyncSync(target);
      } finally { fs.closeSync(target); }
    }
    return applied;
  }

  // Drop everything the caller has just written elsewhere. `throughSeq` is the
  // highest sequence number that snapshot contains: an entry appended while it
  // was being written is newer than that and has to survive, which is the whole
  // reason this is not an unconditional truncate.
  function truncate(throughSeq = Infinity) {
    return enqueue(async () => {
      if (lastSeq <= throughSeq) {
        const target = await fd();
        await target.truncate(0);
        await target.sync();
        lastSeq = 0;
        return;
      }

      let raw = '';
      try {
        raw = await fsp.readFile(file, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT' || cipher) throw error;
        return;
      }
      const survivors = [];
      let highest = 0;
      for (const line of raw.split('\n')) {
        if (line === '') continue;
        let entry = null;
        try {
          entry = JSON.parse(cipher ? cipher.open(line, 'accounts.journal').toString('utf8') : line);
        } catch (error) {
          if (cipher) throw error;
          continue;
        }
        if (!Number.isFinite(entry?.seq) || entry.seq <= throughSeq) continue;
        survivors.push(line);
        if (entry.seq > highest) highest = entry.seq;
      }
      // Replaced by rename rather than rewritten in place: a crash here leaves
      // the whole journal, which replay handles, instead of a half-written one.
      await fsp.writeFile(temp, survivors.length > 0 ? `${survivors.join('\n')}\n` : '', { mode });
      const pending = await fsp.open(temp, 'r');
      try { await pending.sync(); } finally { await pending.close(); }
      await fsp.rename(temp, file);
      // The open fd still points at the replaced inode.
      await reopen();
      lastSeq = highest;
    });
  }

  // Resolves once every write queued so far has finished, however it
  // finished: what a checkpoint waits on so its snapshot covers them.
  function settled() {
    return chain;
  }

  async function close() {
    closed = true;
    await chain;
    await reopen();
  }

  return { append, replay, truncate, settled, close, file };
}
