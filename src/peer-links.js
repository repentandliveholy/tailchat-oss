import fs from 'node:fs';
import path from 'node:path';

// Tailscale and Cloud are two parallel, unconnected identity systems (see
// docs/specs/2026-09-01-unify-p2p-cloud-conversation.md): a tailnet login and
// a Cloud login can name the same human under two different strings, and
// nothing in either system says so on its own. LAN discovery already closes
// this gap for itself — a verified beacon's `login` field IS the announcer's
// Cloud login (see lan-discovery.js) — but a Tailscale peer carries no such
// certificate today. `/link` is the one place a person says "this tailnet
// peer and this Cloud friend are the same person"; nothing here is inferred
// from a name or hostname match, only ever set by that explicit command.
//
// Once linked, computePeerKey (cli.js) resolves every transport for that
// selector onto the one `cloud-<login>` peerKey, so /p2p and /cloud stop
// looking like two different correspondents. History written before the link
// existed is left exactly where it was: linking only changes where new lines
// land, never merges or deletes what is already on disk.

const FILE = 'peer-links.json';
const fileFor = (dir) => path.join(dir, FILE);

const cleanSelector = (value) => {
  const text = String(value ?? '').trim().toLowerCase();
  return text.length > 0 && text.length <= 254 ? text : null;
};

const cleanLogin = (value) => {
  const text = String(value ?? '').trim();
  return text.length > 0 && text.length <= 254 ? text : null;
};

export function readPeerLinks(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(dir), 'utf8'));
    const links = {};
    for (const [selector, cloudLogin] of Object.entries(parsed?.links ?? {})) {
      const key = cleanSelector(selector);
      const login = cleanLogin(cloudLogin);
      if (key && login) links[key] = login;
    }
    return { links };
  } catch {
    return { links: {} }; // absent or hand-mangled: no links rather than a crash
  }
}

function saveLinks(dir, state) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${fileFor(dir)}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, fileFor(dir));
    return true;
  } catch {
    return false;
  }
}

// Ties a Tailscale/LAN peer selector (their tailnet login, most often) to a
// Cloud login. Both sides are stored case-insensitively-on-lookup for the
// selector (a tailnet login is not case sensitive in practice) but the Cloud
// login is kept exactly as given, since that is what the server and every
// other lookup here already compares verbatim.
export function linkPeer(dir, selector, cloudLogin) {
  const key = cleanSelector(selector);
  const login = cleanLogin(cloudLogin);
  if (!key || !login) return false;
  const state = readPeerLinks(dir);
  state.links[key] = login;
  return saveLinks(dir, state);
}

export function unlinkPeer(dir, selector) {
  const key = cleanSelector(selector);
  if (!key) return false;
  const state = readPeerLinks(dir);
  if (!Object.hasOwn(state.links, key)) return false;
  delete state.links[key];
  return saveLinks(dir, state);
}

// The Cloud login this Tailscale/LAN selector was explicitly linked to, or
// null when never linked — the ordinary, unmerged case every peer starts in.
export function resolveLinkedCloudLogin(dir, selector) {
  const key = cleanSelector(selector);
  if (!key) return null;
  return readPeerLinks(dir).links[key] ?? null;
}
