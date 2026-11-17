import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ownTailnetIps } from './addr.js';
// Tailscale ships as an app bundle on macOS and a plain binary elsewhere. On
// Termux nothing lives under /usr: the whole prefix sits inside the app's own
// data directory, so that path has to come from the environment. Without it a
// phone that does have the CLI installed is told it has none — and then no
// login, no MagicDNS name and no roster entry can be resolved there.
const CANDIDATE_PATHS = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
];

// Windows has no single install location. The MSI honours INSTALLDIR, the
// 32-bit package lands under Program Files (x86), a 32-bit process sees its own
// redirected ProgramFiles and needs ProgramW6432 to reach the real one, older
// releases installed into a "Tailscale IPN" directory, and Scoop and Chocolatey
// never touch Program Files at all. Guessing C:\Program Files alone left every
// such machine believing it had no CLI, and that one wrong answer costs it
// authoritative identity, the roster and whois together.
const WINDOWS_PROGRAM_DIR_VARS = ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)'];
const WINDOWS_APP_DIRS = ['Tailscale', 'Tailscale IPN'];
const WINDOWS_EXE = 'tailscale.exe';
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

// The win32 rules are asked for by name instead of using the ambient ones, so
// this list is identical whatever machine builds it and can be asserted on by a
// test that is not running on Windows.
function windowsCliPaths(env) {
  const paths = [];
  for (const variable of WINDOWS_PROGRAM_DIR_VARS) {
    const root = env[variable];
    // An unset variable has to be dropped rather than joined: "undefined\Tailscale"
    // is a relative path, which access() resolves against the working directory,
    // so a file dropped beside the client could end up being spawned as the CLI.
    if (!root) continue;
    for (const dir of WINDOWS_APP_DIRS) paths.push(path.win32.join(root, dir, WINDOWS_EXE));
  }
  if (env.LOCALAPPDATA) paths.push(path.win32.join(env.LOCALAPPDATA, 'Tailscale', WINDOWS_EXE));
  // Scoop installs per user and keeps a "current" junction pointing at whichever
  // version is active; the root lives under the profile unless SCOOP moves it.
  const scoopRoots = [
    env.USERPROFILE ? path.win32.join(env.USERPROFILE, 'scoop') : '',
    env.SCOOP ?? '',
  ];
  for (const root of scoopRoots) {
    if (root) paths.push(path.win32.join(root, 'apps', 'tailscale', 'current', WINDOWS_EXE));
  }
  if (env.ChocolateyInstall) paths.push(path.win32.join(env.ChocolateyInstall, 'bin', WINDOWS_EXE));
  return paths;
}

// Every install location above is a guess; PATH is a statement of fact, and the
// only durable cover for a custom INSTALLDIR or for a Scoop or Chocolatey shim
// whose directory the user is free to move. Windows resolves a bare command
// name by appending each PATHEXT suffix in turn, so a shim called tailscale.cmd
// is reachable only if we do the same. Asking where.exe would answer the same
// question, but that is a process launch on the startup path and one more thing
// that can hang, so the search is plain path joins against the same probe.
export function pathSearchCliPaths(env = process.env, platform = process.platform) {
  const windows = platform === 'win32';
  const join = windows ? path.win32.join : path.posix.join;
  const suffixes = windows
    ? String(env.PATHEXT || DEFAULT_PATHEXT).split(';').filter((ext) => ext !== '')
    : [''];
  const paths = [];
  for (const entry of String(env.PATH ?? '').split(windows ? ';' : ':')) {
    // A trailing separator is common and yields an empty entry, and Windows
    // tolerates entries wrapped in quotes. Left alone both become relative
    // candidates resolved against the working directory.
    const dir = windows ? entry.trim().replace(/^"(.*)"$/, '$1') : entry;
    if (dir === '') continue;
    for (const suffix of suffixes) paths.push(join(dir, `tailscale${suffix}`));
  }
  return paths;
}

// Every location in this file is guesswork and always will be: nobody can
// enumerate a custom MSI INSTALLDIR, a portable copy on a memory stick or a
// layout somebody assembled by hand. TAILCHAT_TS_CLI is the way out of that. It
// is tried before all the guessing and before the PATH scan, so a user whose
// install we cannot find has a one-line fix instead of an unsupported machine.
export const CLI_OVERRIDE_VAR = 'TAILCHAT_TS_CLI';

export function candidateCliPaths(env = process.env, platform = process.platform) {
  const prefix = String(env.PREFIX ?? '');
  const termux = prefix.includes('com.termux')
    ? `${prefix}/bin/tailscale`
    : '/data/data/com.termux/files/usr/bin/tailscale';
  // Trimmed because a variable set from a shell profile or a Windows dialog
  // routinely carries a stray space, and " /usr/bin/tailscale" is not a path.
  const override = String(env[CLI_OVERRIDE_VAR] ?? '').trim();
  const paths = override === ''
    ? [...CANDIDATE_PATHS, termux]
    : [override, ...CANDIDATE_PATHS, termux];
  if (platform === 'win32') {
    paths.push(...windowsCliPaths(env), ...pathSearchCliPaths(env, platform));
  }
  // One directory reaches us from several variables on an ordinary box —
  // ProgramFiles and ProgramW6432 agree on 64-bit Windows, and a shim's own
  // directory is usually on PATH twice — and every duplicate is another
  // access() call before the client can say who it is. The first occurrence
  // wins, which is what keeps the override at the front of the queue.
  return [...new Set(paths)];
}

// What to tell someone when discovery came back empty. The candidate list is
// twenty-odd paths on Windows and printing it helps nobody, whereas the number
// of places tried plus the name of the variable that fixes it is actionable.
// The wording belongs to the caller, so only the facts are returned here.
export function describeCliSearch(paths = candidateCliPaths(), { env = process.env } = {}) {
  const override = String(env[CLI_OVERRIDE_VAR] ?? '').trim();
  return {
    count: paths.length,
    overrideVar: CLI_OVERRIDE_VAR,
    override: override === '' ? null : override,
  };
}

// fs.accessSync(p, X_OK) is the right probe on both families, but it proves
// less on Windows: the execute bit is not a thing there, so the call only tells
// us the file exists. That is still what we need to decide whether to try it.
export function findTailscaleCli(paths = candidateCliPaths()) {
  for (const candidate of paths) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* try the next location */ }
  }
  return null;
}

// A tailscaled that is wedged rather than absent answers nothing at all, and
// execFile waits for a child forever by default. whois sits on the inbound
// authorisation path, so that silence would stall every new connection instead
// of denying it; a bounded wait turns the hang into an ordinary rejection, which
// createWhois already knows how to treat as "no identity, do not cache".
// SIGKILL rather than the default SIGTERM because a process that has stopped
// answering may equally have stopped handling signals it is allowed to ignore.
export const CLI_TIMEOUT_MS = 5000;

export function runTailscale(cliPath, args, { timeoutMs = CLI_TIMEOUT_MS, exec = execFile } = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    };
    exec(cliPath, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

const trimDns = (name) => String(name ?? '').replace(/\.$/, '');

// A node name is a full DNS name (desktop-iru.tailc80816.ts.net); the first
// label is the part a human recognises as "which machine".
export function deviceLabel(node) {
  return trimDns(node).split('.')[0] || '';
}

const SHAREE_PLACEHOLDER = 'device-of-shared-to-user';

export function parseWhois(raw) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const login = json?.UserProfile?.LoginName;
  if (typeof login !== 'string' || login === '') return null;
  const node = trimDns(json?.Node?.Name);
  // A node shared in from another tailnet is deliberately anonymised: its name
  // is blank and its hostname is the literal placeholder below. We cannot know
  // which machine it is, and printing "device-of-shared-to-user" would be worse
  // than admitting we do not know.
  const shared = json?.Node?.Hostinfo?.ShareeNode === true;
  const computed = String(json?.Node?.ComputedName ?? '');
  const device = shared || computed === SHAREE_PLACEHOLDER
    ? ''
    : (deviceLabel(node) || deviceLabel(computed));
  return { login, node, device, shared };
}

// Answers "who owns this address" from the local daemon's view of the tailnet.
// A peer cannot forge that, which is what makes it usable for authorisation.
//
// The answers are kept, but not forever: a long-lived client on a busy tailnet
// is dialled by far more addresses than it has peers, and an unbounded map of
// them is memory the process never gets back. A Map iterates in insertion
// order, so dropping its first key when the cap is reached evicts the oldest
// answer, which is also the one most likely to have gone stale.
export const WHOIS_CACHE_LIMIT = 256;

export function createWhois({
  exec = runTailscale,
  cliPath = findTailscaleCli(),
  cacheLimit = WHOIS_CACHE_LIMIT,
} = {}) {
  const cache = new Map();

  return async function whois(ip) {
    if (!cliPath) return null;
    if (cache.has(ip)) return cache.get(ip);
    let identity = null;
    try {
      identity = parseWhois(await exec(cliPath, ['whois', '--json', ip]));
    } catch {
      return null; // never cache a failure: tailscaled may still be starting
    }
    if (identity) {
      if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value);
      cache.set(ip, identity);
    }
    return identity;
  };
}

export function parseStatus(raw) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  // One login can own several user ids: the same person may be both a member of
  // our tailnet and the owner of a device shared in from theirs. Logins, not
  // ids, are therefore the identity worth matching on.
  const logins = new Map();
  const displayNames = new Map();
  for (const [id, user] of Object.entries(json?.User ?? {})) {
    if (typeof user?.LoginName === 'string') logins.set(id, user.LoginName);
    if (typeof user?.DisplayName === 'string') displayNames.set(id, user.DisplayName);
  }

  const selfId = String(json?.Self?.UserID ?? '');
  const peers = Object.values(json?.Peer ?? {}).map((peer) => {
    const id = String(peer?.UserID ?? '');
    return {
      host: String(peer?.HostName ?? ''),
      dnsName: trimDns(peer?.DNSName),
      ips: Array.isArray(peer?.TailscaleIPs) ? peer.TailscaleIPs.slice() : [],
      login: logins.get(id) ?? null,
      displayName: displayNames.get(id) ?? null,
      online: peer?.Online === true,
      lastSeen: typeof peer?.LastSeen === 'string' ? peer.LastSeen : '',
      sharee: peer?.ShareeNode === true,
      curAddr: typeof peer?.CurAddr === 'string' ? peer.CurAddr : '',
      relay: typeof peer?.Relay === 'string' ? peer.Relay : '',
      active: peer?.Active === true,
      rxBytes: Number(peer?.RxBytes || 0),
      txBytes: Number(peer?.TxBytes || 0),
    };
  });
  return {
    self: {
      login: logins.get(selfId) ?? null,
      host: String(json?.Self?.HostName ?? ''),
      dnsName: trimDns(json?.Self?.DNSName),
      ips: json?.Self?.TailscaleIPs ?? [],
    },
    peers,
  };
}

// Ranks a person's devices so the most promising target is probed first:
// whatever worked last time, then anything online, then the most recently seen.
export function findUserDevices(status, selector, { preferHost = null } = {}) {
  if (!status) return [];
  const needle = String(selector ?? '').trim().toLowerCase();
  if (needle === '') return [];

  // An address is a legitimate way to name a device, so match those too:
  // otherwise pasting an IP silently drops us to single-address mode.
  const matches = (peer) => peer.ips.includes(needle)
    || [peer.login, peer.displayName, peer.host, peer.dnsName]
      .some((field) => typeof field === 'string' && field.toLowerCase().includes(needle));

  // Collapse the routes of one machine into a single device. Both addresses stay
  // usable: the route that is down today may be the only one working tomorrow.
  const byHost = new Map();
  for (const peer of status.peers) {
    if (peer.sharee) continue;           // sharing bookkeeping, not a machine
    if (peer.ips.length === 0) continue;
    if (!matches(peer)) continue;

    const key = peer.host || peer.dnsName;
    const existing = byHost.get(key);
    if (!existing) {
      byHost.set(key, {
        host: peer.host,
        dnsNames: peer.dnsName ? [peer.dnsName] : [],
        ips: peer.ips.slice(),
        login: peer.login,
        online: peer.online,
        lastSeen: peer.lastSeen,
      });
      continue;
    }
    // Put the live route first: within one machine the address seen as online
    // is the one worth trying before a stale one.
    const fresher = peer.online && !existing.online;
    if (peer.lastSeen > existing.lastSeen) existing.lastSeen = peer.lastSeen;
    existing.online = existing.online || peer.online;
    if (peer.dnsName) existing.dnsNames.push(peer.dnsName);
    const added = peer.ips.filter((ip) => !existing.ips.includes(ip));
    existing.ips = fresher ? [...added, ...existing.ips] : [...existing.ips, ...added];
  }

  const preferred = String(preferHost ?? '').toLowerCase();
  return [...byHost.values()].sort((a, b) => {
    if (preferred) {
      const aPref = a.host.toLowerCase() === preferred;
      const bPref = b.host.toLowerCase() === preferred;
      if (aPref !== bPref) return aPref ? -1 : 1;
    }
    if (a.online !== b.online) return a.online ? -1 : 1;
    return b.lastSeen.localeCompare(a.lastSeen);
  });
}

// A mistyped tailnet address looks exactly like a peer that is switched off:
// both sit at "connecting" forever. So an address the daemon does not know is
// worth saying out loud, together with the devices it was probably meant to be.
const editDistance = (a, b) => {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = a[i - 1] === b[j - 1]
        ? rows[i - 1][j - 1]
        : 1 + Math.min(rows[i - 1][j], rows[i][j - 1], rows[i - 1][j - 1]);
    }
  }
  return rows[a.length][b.length];
};

export function looksLikeIp(value) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(value ?? '').trim());
}
export function isPrivateIp(ipStr) {
  if (!ipStr) return false;
  let ip = String(ipStr).trim();
  if (ip.startsWith('[') && ip.includes(']')) {
    ip = ip.slice(1, ip.indexOf(']'));
  } else if (ip.includes(':') && ip.split(':').length === 2 && !ip.includes('::')) {
    ip = ip.split(':')[0];
  }
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    const c = Number(v4[3]);
    const d = Number(v4[4]);
    if (a > 255 || b > 255 || c > 255 || d > 255) return false;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16
    return false;
  }
  const lower = ip.toLowerCase();
  if (
    lower.startsWith('fe80:') ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower === '::1'
  ) {
    return true;
  }
  return false;
}

function directRouteFor(endpoint) {
  const host = String(endpoint ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!isPrivateIp(host)) return { kind: 'direct-wan', endpoint };
  // A private endpoint belongs to the peer's network, not necessarily ours:
  // Tailscale can report remote CGNAT/RFC1918 addresses such as 10.66.x.x.
  // Only link-local addresses prove the link cannot leave the local network.
  const linkLocal = host.toLowerCase().startsWith('fe80:') || host.startsWith('169.254.');
  return { kind: linkLocal ? 'direct-lan' : 'direct-private', endpoint };
}

export function resolveRouteKind({ curAddr, relay, remoteIp = null }) {
  if (curAddr && typeof curAddr === 'string') return directRouteFor(curAddr);
  if (relay && typeof relay === 'string') {
    return { kind: 'derp-relay', relay, endpoint: `derp-${relay}` };
  }
  if (remoteIp && typeof remoteIp === 'string') {
    const host = remoteIp.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (host.startsWith('100.')) return { kind: 'tailnet', endpoint: remoteIp };
    return directRouteFor(remoteIp);
  }
  return { kind: 'unknown', endpoint: '' };
}

export function inspectPeerRoute(status, peerAddressOrHost, remoteIp = null) {
  if (!status || !Array.isArray(status.peers)) {
    return resolveRouteKind({ curAddr: null, relay: null, remoteIp });
  }
  const needle = String(peerAddressOrHost ?? '').trim().toLowerCase();
  const remote = String(remoteIp ?? '').trim().toLowerCase();
  const match = status.peers.find((p) => {
    if (p.ips.some((ip) => ip.toLowerCase() === needle || (remote && ip.toLowerCase() === remote))) return true;
    if (p.host.toLowerCase() === needle) return true;
    if (p.dnsName.toLowerCase() === needle) return true;
    return false;
  });
  if (match) {
    return resolveRouteKind({ curAddr: match.curAddr, relay: match.relay, remoteIp });
  }
  return resolveRouteKind({ curAddr: null, relay: null, remoteIp });
}
export function parseTailscalePing(output) {
  const text = String(output ?? '');
  const match = text.match(/pong from\s+([^\s]+)\s+\(([^)]+)\)\s+via\s+([^\s]+)\s+in\s+(\d+(?:\.\d+)?)ms/i);
  if (!match) return null;
  const [, host, ip, via, latencyStr] = match;
  const latency = parseFloat(latencyStr);
  let route;
  if (via.toLowerCase().startsWith('derp(')) {
    const relayMatch = via.match(/derp\(([^)]+)\)/i);
    const relay = relayMatch ? relayMatch[1] : 'relay';
    route = { kind: 'derp-relay', relay, endpoint: `derp-${relay}` };
  } else {
    route = directRouteFor(via);
  }
  return {
    host,
    ip,
    rtt: latency,
    route,
  };
}

export async function tailscalePingPeer(cliPath, ipOrHost, { timeoutMs = 4000, exec = execFile } = {}) {
  if (!cliPath || !ipOrHost) return null;
  return new Promise((resolve) => {
    const options = {
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    };
    exec(cliPath, ['ping', '-c', '1', ipOrHost], options, (error, stdout, stderr) => {
      const combined = `${stdout ?? ''}\n${stderr ?? ''}`;
      resolve(parseTailscalePing(combined));
    });
  });
}

export function nearbyDevices(status, address, { limit = 3, maxDistance = 2 } = {}) {
  if (!status || !looksLikeIp(address)) return [];
  const typed = String(address).trim();
  return status.peers
    // Service placeholders are not machines anyone can be asked to connect to.
    .filter((peer) => !peer.sharee && peer.ips.length > 0)
    .map((peer) => {
      const best = peer.ips
        .filter(looksLikeIp)
        .map((ip) => ({ ip, distance: editDistance(typed, ip) }))
        .sort((a, b) => a.distance - b.distance)[0];
      if (!best) return null;
      // Android reports its hostname as "localhost", which names nothing; the
      // DNS label is what the person recognises.
      const label = deviceLabel(peer.dnsName) || peer.host;
      return { host: label, ip: best.ip, online: peer.online, distance: best.distance };
    })
    .filter((candidate) => candidate && candidate.distance <= maxDistance)
    .sort((a, b) => (a.distance - b.distance) || (Number(b.online) - Number(a.online)))
    .slice(0, limit);
}

// The devices to tell a peer about, so a client with no CLI can dial us by name.
// This machine comes first and stays a separate entry: several devices report
// their hostname as "localhost" — Android among them — and grouping by host
// would merge strangers, hiding the very address the peer needs to reach us on.
export function ownDeviceList(status) {
  if (!status?.self?.login) return [];
  const login = status.self.login.toLowerCase();
  const entry = (host, dnsName, ips) => ({
    host: host || null,
    dns: dnsName || null,
    ips: (ips ?? []).slice(),
  });
  const devices = [entry(status.self.host, status.self.dnsName, status.self.ips)];
  const mine = status.peers
    .filter((peer) => !peer.sharee && String(peer.login ?? '').toLowerCase() === login)
    // Whatever is online is the more useful address to hand over first.
    .sort((a, b) => (Number(b.online) - Number(a.online)) || b.lastSeen.localeCompare(a.lastSeen));
  for (const peer of mine) devices.push(entry(peer.host, peer.dnsName, peer.ips));
  return devices.filter((device) => device.ips.length > 0);
}

export function isTailnetIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const clean = ip.replace(/^\[|\]$/g, '').trim();
  const parts = clean.split('.');
  if (parts.length === 4) {
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    return a === 100 && b >= 64 && b <= 127;
  }
  return clean.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

export function isNonTailscaleLan(peerHost, remoteIp = null) {
  if (isTailnetIp(peerHost)) return false;
  if (String(peerHost ?? '').endsWith('.ts.net')) return false;
  if (remoteIp && isTailnetIp(remoteIp)) return false;
  return isPrivateIp(peerHost) || (remoteIp ? isPrivateIp(remoteIp) : false);
}

export async function probeTailscaleStatus({
  cliPath = findTailscaleCli(),
  interfaces = os.networkInterfaces(),
  run = null,
} = {}) {
  const ownIps = ownTailnetIps(interfaces);
  if (cliPath) {
    try {
      const exec = run ?? ((args) => new Promise((resolve, reject) => {
        execFile(cliPath, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      }));
      const raw = await exec(['status', '--json']);
      const parsed = JSON.parse(raw);
      const backendState = parsed?.BackendState ?? 'Unknown';
      const active = backendState === 'Running';
      return {
        hasCli: true,
        active,
        backendState,
        self: parsed?.Self ? {
          login: parsed.Self.UserID ? parsed.User?.[parsed.Self.UserID]?.LoginName : null,
          ips: parsed.Self.TailscaleIPs || [],
          node: parsed.Self.DNSName || parsed.Self.HostName,
        } : null,
        status: parseStatus(raw),
      };
    } catch {
      return {
        hasCli: true,
        active: ownIps.length > 0,
        backendState: ownIps.length > 0 ? 'Running' : 'Stopped',
        self: null,
        status: null,
      };
    }
  }
  return {
    hasCli: false,
    active: ownIps.length > 0,
    backendState: ownIps.length > 0 ? 'Running' : 'NoTailnetInterface',
    self: null,
    status: null,
  };
}
