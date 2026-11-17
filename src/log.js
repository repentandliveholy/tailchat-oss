import fs from 'node:fs';
import path from 'node:path';
import { peerFileStem } from './files.js';
import { openDeviceStore } from './secure-store.js';

// A dropped transcript line would otherwise be invisible, so the note that
// stands in for the missing lines is written into the file like any other line:
// readLogTail hands it straight back to the history pane.
const dropNote = (count) => (
  `[transcript: ${count} line${count === 1 ? '' : 's'} dropped, the disk could not keep up]`
);

// A transcript that cannot be written must not stop the chat, so both the
// no-file case and every later failure collapse onto the same inert object.
function inertLog() {
  return {
    stream: null,
    append() { return false; },
    droppedLines() { return 0; },
    close(cb) { if (cb) cb(); },
  };
}
// A session-level cache of verified log targets and decrypted lines so switching
// conversations doesn't re-verify and re-decrypt thousands of lines every time.
const verifiedLogFiles = new WeakMap();
const logTailCache = new WeakMap();

export function createLog(file, {
  store = file ? openDeviceStore() : null,
  openStream = (target) => fs.createWriteStream(target, { flags: 'a', mode: 0o600 }),
  chmod = fs.chmodSync,
  onError = () => {},
} = {}) {
  if (!file) return inertLog();
  const target = store.fileFor(file);
  if (fs.existsSync(file) && !fs.existsSync(target)) {
    throw new Error(`Legacy plaintext transcript needs explicit migration: ${file}`);
  }
  let verifiedSet = verifiedLogFiles.get(store);
  if (!verifiedSet) {
    verifiedSet = new Set();
    verifiedLogFiles.set(store, verifiedSet);
  }
  try { chmod(target, 0o600); } catch { /* new file */ }
  if (fs.existsSync(target) && !verifiedSet.has(target)) {
    readLogTail(file, Infinity, store);
    verifiedSet.add(target);
  }
  let stream;
  try {
    stream = openStream(target);
    verifiedSet.add(target);
  } catch (error) {
    // Some targets fail synchronously rather than through an error event: a
    // path Windows refuses outright, a name with a NUL in it, a directory where
    // a file was expected. There is nothing to write to, but the session itself
    // is unharmed, so say so once and carry on without a transcript.
    onError(error);
    return inertLog();
  }

  let stopped = false; // the stream died; further writes would only fail again
  let saturated = false; // write() reported a full queue; waiting for 'drain'
  let dropped = 0;

  const push = (line) => {
    // Backpressure is honoured rather than queued around. The writable buffer is
    // the only thing between a fast peer and unbounded memory growth, so once
    // write() says it is full the lines that arrive are counted and dropped, not
    // buffered and not coalesced: merging chat lines would silently rewrite what
    // people said, while a counted gap is honest and costs one integer.
    saturated = !stream.write(`${store.seal(Buffer.from(`${line}\n`), file).toString('base64')}\n`);
  };

  stream.on('error', (error) => {
    // Without this listener the special 'error' event terminates the process,
    // and it does so with the blessed TUI still owning the terminal: a full
    // disk, a revoked permission, a mount that went away, or on Windows a
    // locked --log target would take the whole conversation down. Stop logging
    // instead and let the caller tell the user once.
    stopped = true;
    saturated = false;
    dropped = 0;
    onError(error);
  });

  stream.on('drain', () => {
    saturated = false;
    if (stopped || dropped === 0) return;
    const lost = dropped;
    dropped = 0; // reset first: push() may saturate the stream again
    push(dropNote(lost));
  });

  return {
    stream,
    append(line) {
      if (stopped) return false;
      if (saturated) {
        dropped += 1;
        return false;
      }
      push(line);
      return true;
    },
    droppedLines() { return dropped; },
    close(cb) {
      // Safe after a failure: the stream is already destroyed, so end() would
      // only raise a second error and might never call back — and the callers
      // use this callback to exit the process.
      if (stopped) {
        if (cb) cb();
        return;
      }
      try {
        stream.end(cb);
      } catch {
        if (cb) cb();
      }
    },
  };
}

// Restores recent transcript lines so a reconnect keeps prior context.
export function readLogTail(file, maxLines = 200, store = file ? openDeviceStore() : null) {
  if (!file) return [];
  const target = store.fileFor(file);
  if (fs.existsSync(file) && !fs.existsSync(target)) {
    throw new Error(`Legacy plaintext transcript needs explicit migration: ${file}`);
  }
  let stat;
  try { stat = fs.statSync(target); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  let storeCache = logTailCache.get(store);
  if (!storeCache) {
    storeCache = new Map();
    logTailCache.set(store, storeCache);
  }
  const cached = storeCache.get(target);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return maxLines > 0 ? cached.lines.slice(-maxLines) : [];
  }
  let raw;
  try { raw = fs.readFileSync(target, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = raw.split('\n').filter(Boolean);
  const canAppendIncrementally = cached
    && cached.rawCount <= entries.length
    && (cached.rawCount === 0 || entries[cached.rawCount - 1] === cached.lastRawEntry);
  let lines;
  if (canAppendIncrementally) {
    const newEntries = entries.slice(cached.rawCount);
    const newLines = newEntries.flatMap((entry) => {
      const decoded = Buffer.from(entry, 'base64');
      if (decoded.toString('base64') !== entry) throw new Error(`Corrupted encrypted transcript: ${file}`);
      return store.unseal(decoded, file).toString('utf8').split('\n').filter(Boolean);
    });
    lines = cached.lines.concat(newLines);
  } else {
    lines = entries.flatMap((entry) => {
      const decoded = Buffer.from(entry, 'base64');
      if (decoded.toString('base64') !== entry) throw new Error(`Corrupted encrypted transcript: ${file}`);
      return store.unseal(decoded, file).toString('utf8').split('\n').filter(Boolean);
    });
  }
  storeCache.set(target, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    rawCount: entries.length,
    lastRawEntry: entries[entries.length - 1] ?? null,
    lines,
  });
  return maxLines > 0 ? lines.slice(-maxLines) : [];
}
// The default transcript: one file per conversation, keyed like the peer memory
// so a chat's notes, history and transcript all sit under the same stem.
export function defaultLogPath(stateDir, peerKey) {
  return path.join(stateDir, `${peerFileStem(peerKey)}.log`);
}

// On by default: the transcript lands in the state directory unless an explicit
// --log names a file, --no-log refuses, or the first-run wizard was told "No".
export function resolveLogFile({
  logFlag, noLogFlag, configLog, stateDir, peerKey,
}) {
  if (logFlag) return logFlag;
  if (noLogFlag) return null;
  if (configLog === false) return null;
  return defaultLogPath(stateDir, peerKey);
}
