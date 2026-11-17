import fs from 'node:fs';
import path from 'node:path';

// A forgotten instance holding the port has now broken a conversation three
// times, and "another tailchat is probably running" leaves the person hunting
// for it. So a listening client records its own pid, and one that cannot bind
// reads that note and names the process to close.
//
// A pidfile rather than lsof or /proc: those are missing on Termux and differ
// on every platform, while the process we are looking for is always ours.

const fileFor = (dir, port) => path.join(dir, `listener-${port}.pid`);
// The conversation lives BESIDE the pid, never inside it. A client older than
// this release reads the pid file with parseInt: JSON there would come back NaN,
// it would conclude that a stranger holds the port, and dial in parallel —
// producing exactly the channel flapping this lock exists to prevent.
const peerFileFor = (dir, port) => path.join(dir, `listener-${port}.peer`);

export function writeListenerPid(dir, port, pid = process.pid, peerKey = null) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fileFor(dir, port), String(pid), { mode: 0o600 });
    if (peerKey) {
      fs.writeFileSync(peerFileFor(dir, port), String(peerKey), { mode: 0o600 });
    }
    return true;
  } catch {
    // The note is a convenience; failing to leave it must not stop the client.
    return false;
  }
}

export function clearListenerPid(dir, port) {
  try {
    fs.rmSync(fileFor(dir, port), { force: true });
    // Left behind, it would name the wrong conversation for the next client.
    fs.rmSync(peerFileFor(dir, port), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function readListenerPeer(dir, port, { read = fs.readFileSync } = {}) {
  let value;
  try {
    value = String(read(peerFileFor(dir, port), 'utf8')).trim();
  } catch {
    return null; // absent: an older holder, or none at all
  }
  return value === '' ? null : value;
}

// What a second client on this machine may do with the port. Keyed on the
// conversation rather than the port: the lock is there to stop two clients
// fighting over ONE peer's channel, and two different conversations have nothing
// to fight over — standing down left the second chat permanently dead.
export function lockVerdict({ holderPid, holderPeer, myPeer }) {
  if (!holderPid) return 'free'; // nobody of ours vouched for it
  // An older holder left a pid and no conversation. Killing a process we cannot
  // name is not ours to do, and dialling beside it risks the flapping.
  if (!holderPeer || !myPeer) return 'stand-down';
  return holderPeer === myPeer ? 'takeover' : 'coexist';
}

// Signal 0 asks the kernel "does this pid exist and may I signal it" without
// touching the process, which is how we tell a live owner from a stale note.
export function isAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return err?.code === 'EPERM';
  }
}

export function readListenerPid(dir, port, {
  read = fs.readFileSync,
  alive = isAlive,
  self = process.pid,
} = {}) {
  let pid;
  try {
    pid = Number.parseInt(String(read(fileFor(dir, port), 'utf8')).trim(), 10);
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid === self) return null;
  return alive(pid) ? pid : null;
}
