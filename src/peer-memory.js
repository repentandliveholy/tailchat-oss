import fs from 'node:fs';
import path from 'node:path';
import { peerFileStem } from './files.js';

// Where a peer's memory lives, named the way every other per-conversation file
// is. Exported because `/remove` has to name the file of a person who is not
// the open conversation — the same stem the session would have written, not a
// second formula that could drift from it.
export function peerMemoryFile(dir, key) {
  return path.join(dir, `${peerFileStem(key)}.json`);
}

// Remembers which device of a peer we last talked to, so a reconnect calls that
// machine first instead of whatever the status listing happens to rank highest.
// Also remembers a local nickname, if one was ever set with /nick: the peer's
// own client hands us a name too (its `args.name`, sometimes never customised
// past the OS hostname), but a nickname is ours to choose and never travels to
// them — it does not depend on a resolvable tailscale login the way the roster
// does, which is what makes it work for a shared node with no login at all.
export function createPeerMemory({
  dir,
  key,
  mkdir = fs.mkdirSync,
  writeFile = fs.writeFileSync,
  rename = fs.renameSync,
  chmod = fs.chmodSync,
  now = () => new Date().toISOString(),
}) {
  const file = peerMemoryFile(dir, key);

  const load = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {}; // absent or hand-mangled: start over rather than fail
    }
  };

  let state = load();

  // Shared by remember() and setNickname(): both write the whole file, and
  // each must keep the field the other one owns rather than clobbering it.
  const persist = (next) => {
    try {
      mkdir(dir, { recursive: true, mode: 0o700 });
      const temp = `${file}.tmp`;
      writeFile(temp, JSON.stringify(next), { mode: 0o600 });
      rename(temp, file);
    } catch (error) {
      // The previous state stays in place so memory and disk keep agreeing.
      return { ok: false, code: error?.code ?? null, error };
    }
    state = next;
    try {
      chmod(file, 0o600);
    } catch { /* filesystem without POSIX modes */ }
    return { ok: true };
  };

  return {
    file,
    lastHost() {
      return typeof state.host === 'string' && state.host ? state.host : null;
    },
    lastAddress() {
      return typeof state.address === 'string' && state.address ? state.address : null;
    },
    nickname() {
      return typeof state.nickname === 'string' && state.nickname ? state.nickname : null;
    },
    // Called straight from the connection handlers, where a throw used to end
    // the session: on Windows the rename below hits EPERM or EBUSY whenever
    // antivirus or Windows Search is holding the file for the moment it takes
    // to replace it. Returning the outcome keeps the reconnect alive and lets a
    // caller mention that the preferred device was not remembered.
    remember({ host, address }) {
      return persist({
        host: host ?? null, address: address ?? null, nickname: state.nickname ?? null, at: now(),
      });
    },
    // Empty or omitted clears it, so /nick with nothing after it is the way
    // back to whatever the peer's own client calls itself.
    setNickname(name) {
      const clean = typeof name === 'string' ? name.trim() : '';
      return persist({ ...state, nickname: clean || null, at: now() });
    },
  };
}
