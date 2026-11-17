import fs from 'node:fs';
import path from 'node:path';
import { normalizeIp } from './addr.js';

// Termux has no `tailscale` binary, so a client there cannot turn a person's
// login into the list of their devices — the very thing that lets you write
// `tailchat roman` instead of an address. MagicDNS still resolves device names
// there, which is the gap this file closes: whoever does have the CLI tells the
// peer which devices it owns, and both sides remember it.
//
// The roster is a convenience, never an authority: inbound connections are still
// authorised by the local daemon, so a peer cannot talk its way in by claiming
// to own an address.

const FILE = 'roster.json';
const MAX_DEVICES = 20;

const fileFor = (dir) => path.join(dir, FILE);

const cleanText = (value, limit) => {
  const text = String(value ?? '').trim().toLowerCase();
  return text.length > 0 && text.length <= limit ? text : null;
};

// Only shapes we could act on: a device needs at least one address to dial.
export function sanitiseDevices(devices) {
  if (!Array.isArray(devices)) return [];
  const seen = new Set();
  const out = [];
  for (const device of devices.slice(0, MAX_DEVICES)) {
    const ips = (Array.isArray(device?.ips) ? device.ips : [])
      .map((ip) => cleanText(ip, 64))
      .filter((ip) => ip && /^[0-9a-f.:]+$/.test(ip));
    if (ips.length === 0) continue;
    const host = cleanText(device?.host, 128);
    const dns = cleanText(device?.dns, 253);
    const key = ips.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host, dns, ips });
  }
  return out;
}

// A devices frame lists only the announcer's own login's devices, so "contains
// one of my addresses" is the CLI-less proof that the frame is about me.
function entryIsSelf(login, devices, self) {
  if (!self) return false;
  if (self.login && String(login ?? '').toLowerCase() === String(self.login).toLowerCase()) return true;
  const own = new Set(
    (Array.isArray(self.ips) ? self.ips : []).map((ip) => normalizeIp(ip).toLowerCase()),
  );
  return (Array.isArray(devices) ? devices : []).some((device) =>
    (Array.isArray(device?.ips) ? device.ips : [])
      .some((ip) => own.has(normalizeIp(ip).toLowerCase())));
}

export function isSelfAnnouncement({ login, devices }, self) {
  return entryIsSelf(login, devices, self);
}

const MAX_NAMES = 5;

// The display name a person chose in the chat. Tailscale knows nothing about it,
// but it is what the other side reads in the header — so it is the first thing
// they type when told to "connect by name".
export function sanitiseNames(names) {
  if (!Array.isArray(names)) return [];
  const out = [];
  for (const value of names.slice(0, MAX_NAMES)) {
    const name = cleanText(value, 64);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

export function readRoster(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(dir), 'utf8'));
    const logins = {};
    for (const [login, entry] of Object.entries(parsed?.logins ?? {})) {
      const key = cleanText(login, 254);
      const devices = sanitiseDevices(entry?.devices);
      if (key && devices.length > 0) {
        logins[key] = { devices, names: sanitiseNames(entry?.names), seen: entry?.seen ?? null };
      }
    }
    return { logins };
  } catch {
    return { logins: {} };
  }
}

export function rememberDevices(dir, login, devices, names = []) {
  const key = cleanText(login, 254);
  const clean = sanitiseDevices(devices);
  if (!key || clean.length === 0) return false;
  const roster = readRoster(dir);
  // Names accumulate: a person may be `godsheep` on one machine and something
  // else on another, and both should reach them.
  const known = sanitiseNames([...sanitiseNames(names), ...(roster.logins[key]?.names ?? [])]);
  roster.logins[key] = { devices: clean, names: known, seen: new Date().toISOString() };
  return saveRoster(dir, roster);
}

function saveRoster(dir, roster) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${fileFor(dir)}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(roster, null, 2), { mode: 0o600 });
    fs.renameSync(temp, fileFor(dir));
    return true;
  } catch {
    return false;
  }
}

export function forgetDevices(dir, login) {
  const key = cleanText(login, 254);
  if (!key) return false;
  const roster = readRoster(dir);
  if (!Object.hasOwn(roster.logins, key)) return false;
  delete roster.logins[key];
  return saveRoster(dir, roster);
}

// Matches the way people actually name a peer: the whole login, the part before
// the @, or a device name — the same latitude the CLI-backed lookup allows.
export function lookupRoster(dir, selector, self = null) {
  const needle = cleanText(selector, 254);
  if (!needle) return null;
  const { logins } = readRoster(dir);
  for (const [login, entry] of Object.entries(logins)) {
    const local = login.split('@')[0];
    const deviceNames = entry.devices.flatMap((d) => [d.host, d.dns, d.dns?.split('.')[0]]);
    const matches = login === needle
      || local === needle
      || (entry.names ?? []).includes(needle)
      || deviceNames.filter(Boolean).includes(needle)
      || entry.devices.some((d) => d.ips.includes(needle));
    if (!matches) continue;
    if (entryIsSelf(login, entry.devices, self)) return null;
    return { login, devices: entry.devices, names: entry.names ?? [], seen: entry.seen };
  }
  return null;
}

// Every address of the person, most recently learned device first, so a caller
// can try them in order without knowing how the roster is stored.
export function rosterAddresses(entry) {
  return entry ? entry.devices.flatMap((device) => device.ips) : [];
}

// What the person could have typed instead, so a dead end names its own way out.
export function rosterSelectors(dir, self = null) {
  const { logins } = readRoster(dir);
  return Object.entries(logins)
    .filter(([login, entry]) => !entryIsSelf(login, entry.devices, self))
    .map(([login, entry]) => ({
      login,
      names: entry.names ?? [],
      devices: entry.devices.map((d) => d.dns?.split('.')[0] || d.host).filter(Boolean),
    }));
}
