import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseWhois,
  createWhois,
  parseStatus,
  findUserDevices,
  nearbyDevices,
  looksLikeIp,
  ownDeviceList,
  candidateCliPaths,
  pathSearchCliPaths,
  findTailscaleCli,
  runTailscale,
  CLI_TIMEOUT_MS,
  CLI_OVERRIDE_VAR,
  describeCliSearch,
  isPrivateIp,
  resolveRouteKind,
  inspectPeerRoute,
  parseTailscalePing,
  tailscalePingPeer,
  isTailnetIp,
  isNonTailscaleLan,
  probeTailscaleStatus,
} from '../src/tailscale.js';

test('the CLI is looked for inside the Termux prefix too', () => {
  // Nothing lives under /usr on Termux: the prefix is the app's data directory,
  // and it is the only place a phone's tailscale binary can be.
  const termux = candidateCliPaths({ PREFIX: '/data/data/com.termux/files/usr' });
  assert.ok(termux.includes('/data/data/com.termux/files/usr/bin/tailscale'));
  // Off Termux the well-known path is still tried, because PREFIX says nothing
  // on a desktop and a wrong path costs one failed access() call.
  assert.ok(candidateCliPaths({}).includes('/data/data/com.termux/files/usr/bin/tailscale'));
  assert.ok(candidateCliPaths({}).includes('/usr/bin/tailscale'));
});

test('an executable candidate is picked, and a missing one is not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-cli-'));
  const bin = path.join(dir, 'tailscale');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(findTailscaleCli([path.join(dir, 'absent'), bin]), bin);
  assert.equal(findTailscaleCli([path.join(dir, 'absent')]), null);
});

test('a Windows box with a non-default install is still given the CLI to find', () => {
  // A single hardcoded C:\Program Files told every other kind of Windows
  // install that it had no CLI at all, and with it no authoritative identity,
  // no roster and no whois.
  const paths = candidateCliPaths({
    ProgramFiles: 'C:\\Program Files',
    ProgramW6432: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\ada\\AppData\\Local',
    USERPROFILE: 'C:\\Users\\ada',
    SCOOP: 'D:\\scoop',
    ChocolateyInstall: 'C:\\ProgramData\\chocolatey',
  }, 'win32');
  for (const expected of [
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    'C:\\Program Files\\Tailscale IPN\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale IPN\\tailscale.exe',
    'C:\\Users\\ada\\AppData\\Local\\Tailscale\\tailscale.exe',
    'C:\\Users\\ada\\scoop\\apps\\tailscale\\current\\tailscale.exe',
    'D:\\scoop\\apps\\tailscale\\current\\tailscale.exe',
    'C:\\ProgramData\\chocolatey\\bin\\tailscale.exe',
  ]) assert.ok(paths.includes(expected), expected);
  // ProgramFiles and ProgramW6432 name the same directory on a 64-bit box, and
  // every duplicate is one more access() call before the client can say who it
  // is, so the list is expected to collapse them.
  assert.equal(new Set(paths).size, paths.length, 'candidates must be unique');
});

test('a Windows variable that is not set produces no candidate at all', () => {
  // Joining an absent variable would yield "undefined\Tailscale\tailscale.exe",
  // a relative path that access() resolves against the working directory — so a
  // file dropped beside the client could be spawned as if it were the CLI.
  const paths = candidateCliPaths({ ProgramFiles: 'C:\\Program Files' }, 'win32');
  assert.ok(!paths.some((p) => p.includes('undefined')), 'no undefined segments');
  assert.ok(!paths.some((p) => p.includes('scoop')), 'no scoop path without a profile');
  assert.ok(
    paths.every((p) => p.startsWith('/') || /^[A-Za-z]:\\/.test(p)),
    'every candidate stays absolute',
  );
});

test('the Windows PATH is searched with every executable suffix', () => {
  // Scoop and Chocolatey leave a shim in a directory the user is free to move,
  // so PATH is the only durable way to find it — and Windows itself only
  // resolves a bare `tailscale` there by appending each PATHEXT suffix.
  const paths = candidateCliPaths({ PATH: 'C:\\shims;;"C:\\Quoted Dir" ', PATHEXT: '.EXE;.CMD' }, 'win32');
  assert.ok(paths.includes('C:\\shims\\tailscale.EXE'));
  assert.ok(paths.includes('C:\\shims\\tailscale.CMD'));
  assert.ok(paths.includes('C:\\Quoted Dir\\tailscale.EXE'), 'a quoted PATH entry still counts');
  // A trailing semicolon is ordinary on Windows and leaves an empty entry,
  // which must not turn into a bare relative name.
  assert.ok(!paths.includes('tailscale.EXE'));

  const fallback = candidateCliPaths({ PATH: 'C:\\shims' }, 'win32');
  assert.ok(fallback.includes('C:\\shims\\tailscale.CMD'), 'PATHEXT falls back to the default set');
  assert.ok(fallback.includes('C:\\shims\\tailscale.BAT'));
});

test('a PATH search splits on the separator the platform actually uses', () => {
  assert.deepEqual(
    pathSearchCliPaths({ PATH: '/opt/bin:/usr/local/bin' }, 'linux'),
    ['/opt/bin/tailscale', '/usr/local/bin/tailscale'],
  );
});

test('the candidates off Windows are exactly what they always were', () => {
  // A PATH search is a Windows answer to a Windows problem: on Linux and macOS
  // the list stays the four known locations, the Windows literal that costs one
  // failed access() call, and the Termux prefix, in that order.
  const posix = [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    '/data/data/com.termux/files/usr/bin/tailscale',
  ];
  const env = { PATH: '/opt/weird/bin', PATHEXT: '.EXE', ProgramFiles: 'C:\\Program Files' };
  assert.deepEqual(candidateCliPaths(env, 'linux'), posix);
  assert.deepEqual(candidateCliPaths(env, 'darwin'), posix);
  assert.deepEqual(
    candidateCliPaths({ PREFIX: '/data/data/com.termux/files/usr.2' }, 'linux'),
    [...posix.slice(0, 5), '/data/data/com.termux/files/usr.2/bin/tailscale'],
  );
});

test('a pointed-at CLI is tried before anything we guessed', () => {
  // No list can cover a custom MSI INSTALLDIR or a hand-made layout, and until
  // there was a variable such a user had no way at all to be found: the client
  // insisted the CLI was absent on a machine where it was installed.
  const override = 'D:\\Tools\\ts\\tailscale.exe';
  const win = candidateCliPaths({
    [CLI_OVERRIDE_VAR]: override,
    ProgramFiles: 'C:\\Program Files',
    PATH: 'C:\\shims',
  }, 'win32');
  assert.equal(win[0], override, 'the override outranks every guess and the PATH scan');
  const posix = candidateCliPaths({ [CLI_OVERRIDE_VAR]: '/opt/ts/bin/tailscale' }, 'linux');
  assert.equal(posix[0], '/opt/ts/bin/tailscale');

  // A variable set from a shell profile or a Windows dialog often carries a
  // stray space, and " /opt/ts/bin/tailscale" is not a path.
  assert.equal(candidateCliPaths({ [CLI_OVERRIDE_VAR]: '  /opt/ts/bin/tailscale ' }, 'linux')[0],
    '/opt/ts/bin/tailscale');

  // Naming a location we already guess must still put it first, not twice.
  const same = candidateCliPaths({ [CLI_OVERRIDE_VAR]: '/usr/bin/tailscale' }, 'linux');
  assert.equal(same[0], '/usr/bin/tailscale');
  assert.equal(same.filter((p) => p === '/usr/bin/tailscale').length, 1);
});

test('an unset or blank override changes nothing', () => {
  const untouched = candidateCliPaths({}, 'linux');
  assert.deepEqual(candidateCliPaths({ [CLI_OVERRIDE_VAR]: '' }, 'linux'), untouched);
  assert.deepEqual(candidateCliPaths({ [CLI_OVERRIDE_VAR]: '   ' }, 'linux'), untouched);
  assert.deepEqual(candidateCliPaths({ [CLI_OVERRIDE_VAR]: undefined }, 'linux'), untouched);
});

test('a failed search can be explained without printing twenty paths', () => {
  // The count and the name of the variable that fixes it are what a user can
  // act on; the wording is the caller's business, so only facts come back.
  const plain = describeCliSearch(['/usr/bin/tailscale', '/opt/tailscale'], { env: {} });
  assert.deepEqual(plain, { count: 2, overrideVar: 'TAILCHAT_TS_CLI', override: null });
  const set = describeCliSearch(['/opt/ts'], { env: { [CLI_OVERRIDE_VAR]: ' /opt/ts ' } });
  assert.equal(set.override, '/opt/ts', 'a set-but-wrong override is worth quoting back');
});

test('a wedged daemon is waited on for a bounded time and then reported as failed', async () => {
  // A tailscaled that stopped answering is worse than one that is absent:
  // execFile waits for its child forever, and whois runs on the inbound
  // authorisation path, so the handshake would hang rather than be refused.
  let seen = null;
  const exec = (cliPath, args, options, done) => {
    seen = options;
    done(Object.assign(new Error('tailscale whois ETIMEDOUT'), { killed: true, signal: 'SIGKILL' }), '', '');
  };
  await assert.rejects(runTailscale('/usr/bin/tailscale', ['whois'], { exec }), /ETIMEDOUT/);
  assert.equal(seen.timeout, CLI_TIMEOUT_MS, 'execFile must be given a deadline');
  assert.ok(Number.isFinite(seen.timeout) && seen.timeout > 0);
  assert.equal(seen.killSignal, 'SIGKILL');

  await assert.rejects(runTailscale('/usr/bin/tailscale', ['whois'], { exec, timeoutMs: 250 }));
  assert.equal(seen.timeout, 250, 'the deadline is injectable for tests and for slow links');

  // The rejection has to reach createWhois, because that is the path which
  // refuses the peer without remembering the refusal.
  const whois = createWhois({
    exec: (cliPath, args) => runTailscale(cliPath, args, { exec }),
    cliPath: '/usr/bin/tailscale',
  });
  assert.equal(await whois('100.64.0.1'), null, 'a timeout is not an identity');
});

test('the whois cache stops growing and forgets the oldest answer first', async () => {
  // A long-lived client is dialled by far more addresses than it has peers, and
  // an unbounded map of them is memory the process never gets back.
  let calls = 0;
  const whois = createWhois({
    exec: async () => { calls++; return WHOIS; },
    cliPath: '/usr/bin/tailscale',
    cacheLimit: 2,
  });
  await whois('100.64.0.1');
  await whois('100.64.0.2');
  await whois('100.64.0.1');
  assert.equal(calls, 2, 'a remembered answer costs no subprocess');

  await whois('100.64.0.3');
  assert.equal(calls, 3);
  await whois('100.64.0.2');
  assert.equal(calls, 3, 'the newer entries survive the eviction');
  await whois('100.64.0.1');
  assert.equal(calls, 4, 'the oldest entry was the one dropped');
});

// Shapes copied from a real `tailscale status --json`. Two quirks are load
// bearing: one login owns several user ids once the same person is both a member
// of our tailnet and the owner of a shared device, and Tailscale invents
// `device-of-shared-to-user` placeholder nodes for the sharing relationship.
const STATUS = JSON.stringify({
  Self: { UserID: 5183146081479262, HostName: 'macbook-pro', TailscaleIPs: ['100.122.98.16'] },
  User: {
    5183146081479262: { LoginName: 'me@example.com', DisplayName: 'r. h.' },
    1051864253759740: { LoginName: 'roman@example.com', DisplayName: 'Roman Cuisset' },
    875658184097055: { LoginName: 'roman@example.com', DisplayName: 'Roman Cuisset' },
  },
  Peer: {
    // The same machine as a member of our tailnet…
    a: {
      HostName: 'DESKTOP-AG8B8U4',
      DNSName: 'desktop-ag8b8u4.tail6ab02b.ts.net.',
      TailscaleIPs: ['100.74.56.8'],
      UserID: 1051864253759740,
      Online: false,
      LastSeen: '2026-08-11T10:00:00Z',
    },
    // …and again through the older cross-tailnet share, on another address.
    b: {
      HostName: 'DESKTOP-AG8B8U4',
      DNSName: 'desktop-iru.tailc80816.ts.net.',
      TailscaleIPs: ['100.105.157.69'],
      UserID: 875658184097055,
      Online: true,
      LastSeen: '0001-01-01T00:00:00Z',
    },
    // Sharing bookkeeping, not a machine anyone can connect to.
    c: {
      HostName: 'device-of-shared-to-user',
      DNSName: '',
      TailscaleIPs: ['100.125.19.43'],
      UserID: 875658184097055,
      Online: true,
      ShareeNode: true,
      LastSeen: '0001-01-01T00:00:00Z',
    },
    // A second real device of the same person, currently offline.
    d: {
      HostName: 'roman-phone',
      DNSName: 'roman-phone.tailc80816.ts.net.',
      TailscaleIPs: ['100.99.1.1'],
      UserID: 875658184097055,
      Online: false,
      LastSeen: '2026-08-12T09:00:00Z',
    },
    e: {
      HostName: 'polished-bug',
      DNSName: 'polished-bug.tail6ab02b.ts.net.',
      TailscaleIPs: ['100.71.187.60'],
      UserID: 5183146081479262,
      Online: true,
      LastSeen: '0001-01-01T00:00:00Z',
    },
  },
});

test('parseStatus reads our own login and keeps every peer for later filtering', () => {
  const status = parseStatus(STATUS);
  assert.equal(status.self.login, 'me@example.com');
  assert.equal(status.peers.length, 5);
});

test('parseStatus survives junk instead of crashing the client', () => {
  assert.equal(parseStatus(''), null);
  assert.equal(parseStatus('not json'), null);
  assert.deepEqual(parseStatus('{}'), {
    self: { login: null, host: '', dnsName: '', ips: [] },
    peers: [],
  });
});

test('sharing placeholders are never offered as devices', () => {
  const found = findUserDevices(parseStatus(STATUS), 'roman@example.com');
  assert.ok(
    !found.some((d) => d.host === 'device-of-shared-to-user'),
    'device-of-shared-to-user is tailnet bookkeeping, not a machine',
  );
});

test('one machine under two user ids becomes one device holding both addresses', () => {
  const found = findUserDevices(parseStatus(STATUS), 'roman@example.com');
  const desktop = found.filter((d) => d.host === 'DESKTOP-AG8B8U4');
  assert.equal(desktop.length, 1, 'the same machine must not be listed twice');
  assert.deepEqual(desktop[0].ips, ['100.105.157.69', '100.74.56.8'], 'both routes kept');
  assert.equal(desktop[0].online, true, 'online on any route counts as online');
});

test('a login selector finds every real device of that person', () => {
  const found = findUserDevices(parseStatus(STATUS), 'roman@example.com');
  assert.deepEqual(found.map((d) => d.host), ['DESKTOP-AG8B8U4', 'roman-phone']);
});

test('online devices are probed before ones last seen earlier', () => {
  const found = findUserDevices(parseStatus(STATUS), 'roman@example.com');
  assert.equal(found[0].online, true);
  assert.equal(found[1].host, 'roman-phone');
});

test('the device that worked last time is tried first', () => {
  const status = parseStatus(STATUS);
  // roman-phone is offline and seen later, so it would normally lose to the
  // online desktop — but it is where the conversation actually happened.
  const found = findUserDevices(status, 'roman@example.com', { preferHost: 'roman-phone' });
  assert.deepEqual(found.map((d) => d.host), ['roman-phone', 'DESKTOP-AG8B8U4']);
});

test('an unknown or stale preference changes nothing', () => {
  const status = parseStatus(STATUS);
  const found = findUserDevices(status, 'roman@example.com', { preferHost: 'sold-laptop' });
  assert.deepEqual(found.map((d) => d.host), ['DESKTOP-AG8B8U4', 'roman-phone']);
});

test('a selector matches a login, a display name or a host', () => {
  const status = parseStatus(STATUS);
  assert.equal(findUserDevices(status, 'Roman Cuisset').length, 2);
  assert.equal(findUserDevices(status, 'roman').length, 2, 'a partial login is enough');
  assert.equal(findUserDevices(status, 'ROMAN@EXAMPLE.COM').length, 2, 'case does not matter');
  assert.deepEqual(findUserDevices(status, 'nobody'), []);
});

test('a selector given as a tailnet address still identifies the owner', () => {
  const status = parseStatus(STATUS);
  // Pasting an address around is how people name devices; that must not silently
  // fall back to single-address mode and lock out the person's other machines.
  assert.deepEqual(
    findUserDevices(status, '100.105.157.69').map((d) => d.host),
    ['DESKTOP-AG8B8U4'],
  );
  // Even the route that is currently down identifies the same machine.
  assert.deepEqual(
    findUserDevices(status, '100.74.56.8').map((d) => d.host),
    ['DESKTOP-AG8B8U4'],
  );
  assert.deepEqual(findUserDevices(status, '100.0.0.254'), [], 'an unknown address matches nothing');
});

test('selecting my own login lists my devices', () => {
  const found = findUserDevices(parseStatus(STATUS), 'me@example.com');
  assert.deepEqual(found.map((d) => d.host), ['polished-bug']);
});

test('every address of the selected user is available for the allowlist', () => {
  const found = findUserDevices(parseStatus(STATUS), 'roman@example.com');
  const ips = found.flatMap((d) => d.ips).sort();
  assert.deepEqual(ips, ['100.105.157.69', '100.74.56.8', '100.99.1.1']);
  assert.ok(!ips.includes('100.125.19.43'), 'placeholder addresses are excluded');
});

const WHOIS = JSON.stringify({
  Node: { Name: 'desktop-iru.tailc80816.ts.net.' },
  UserProfile: { LoginName: 'roman@example.com', DisplayName: 'Roman' },
});

test('parseWhois pulls the owning login, node name and device', () => {
  assert.deepEqual(parseWhois(WHOIS), {
    login: 'roman@example.com',
    node: 'desktop-iru.tailc80816.ts.net',
    device: 'desktop-iru',
    shared: false,
  });
});

test('a node shared in from another tailnet has no device to name', () => {
  // Tailscale anonymises those on purpose: the name is blank and the hostname
  // is a placeholder. Reporting "device-of-shared-to-user" as a machine name
  // would be inventing an answer we do not have.
  const shared = JSON.stringify({
    UserProfile: { LoginName: 'roman@example.com' },
    Node: {
      Name: '',
      ComputedName: 'device-of-shared-to-user',
      Hostinfo: { Hostname: 'device-of-shared-to-user', ShareeNode: true },
    },
  });
  const parsed = parseWhois(shared);
  assert.equal(parsed.login, 'roman@example.com', 'the owner is still known');
  assert.equal(parsed.device, '', 'but the machine is not');
  assert.equal(parsed.shared, true);
});

test('a node with no DNS name falls back to the name Tailscale computed', () => {
  const computed = JSON.stringify({
    UserProfile: { LoginName: 'me@example.com' },
    Node: { Name: '', ComputedName: 'laptop-2.tail1234.ts.net' },
  });
  assert.equal(parseWhois(computed).device, 'laptop-2');
});

test('parseWhois refuses anything it cannot trust', () => {
  assert.equal(parseWhois(''), null);
  assert.equal(parseWhois('not json'), null);
  assert.equal(parseWhois('{}'), null, 'no login means no identity');
  assert.equal(parseWhois(JSON.stringify({ UserProfile: { LoginName: '' } })), null);
});

test('whois asks the local daemon and fails closed', async () => {
  const calls = [];
  const ok = createWhois({
    exec: async (cmd, args) => { calls.push(args); return WHOIS; },
    cliPath: '/usr/bin/tailscale',
  });
  assert.equal((await ok('100.105.157.69')).login, 'roman@example.com');
  assert.deepEqual(calls, [['whois', '--json', '100.105.157.69']]);

  const noCli = createWhois({ exec: async () => WHOIS, cliPath: null });
  assert.equal(await noCli('100.105.157.69'), null, 'no CLI means no identity claim');

  const failing = createWhois({
    exec: async () => { throw new Error('command failed'); },
    cliPath: '/usr/bin/tailscale',
  });
  assert.equal(await failing('100.64.0.1'), null, 'an error must never look like a match');
});

test('whois caches hits per address but retries failures', async () => {
  let calls = 0;
  const whois = createWhois({
    exec: async () => {
      calls++;
      if (calls === 1) throw new Error('tailscaled starting');
      return WHOIS;
    },
    cliPath: '/usr/bin/tailscale',
  });

  assert.equal(await whois('100.64.0.1'), null);
  assert.notEqual(await whois('100.64.0.1'), null, 'a transient failure is retried');
  await whois('100.64.0.1');
  assert.equal(calls, 2, 'a successful answer is cached');
});

const NEARBY_STATUS = JSON.stringify({
  User: { 1: { LoginName: 'me@example.com' } },
  Self: { UserID: 1, TailscaleIPs: ['100.64.0.1'] },
  Peer: {
    a: { HostName: 'localhost', DNSName: 'realme-rmx3624.tail.ts.net.', TailscaleIPs: ['100.72.63.41'], UserID: 1, Online: true },
    b: { HostName: 'polished-bug', DNSName: 'polished-bug.tail.ts.net.', TailscaleIPs: ['100.71.187.60'], UserID: 1, Online: false },
    c: { HostName: 'shared', DNSName: '', TailscaleIPs: ['100.105.157.69'], UserID: 1, ShareeNode: true },
  },
});

test('a mistyped tailnet address is matched to the device it nearly was', () => {
  const status = parseStatus(NEARBY_STATUS);
  // A dropped digit and a moved dot are the two slips people actually make.
  assert.deepEqual(
    nearbyDevices(status, '100.72.63.4').map((d) => `${d.host} ${d.ip}`),
    ['realme-rmx3624 100.72.63.41'],
  );
  assert.deepEqual(
    nearbyDevices(status, '100.72.6.41').map((d) => d.ip),
    ['100.72.63.41'],
  );
  // Android calls itself "localhost", which names nothing: the DNS label wins.
  assert.equal(nearbyDevices(status, '100.72.63.4')[0].host, 'realme-rmx3624');
});

test('a far-off address gets no invented suggestion', () => {
  const status = parseStatus(NEARBY_STATUS);
  assert.deepEqual(nearbyDevices(status, '10.0.0.5'), []);
  assert.deepEqual(nearbyDevices(status, '100.99.99.99'), []);
  // A name is not an address, so there is nothing to compare it against.
  assert.deepEqual(nearbyDevices(status, 'realme'), []);
  assert.deepEqual(nearbyDevices(null, '100.72.63.4'), []);
});

test('service placeholders are never offered as a device to connect to', () => {
  const status = parseStatus(NEARBY_STATUS);
  const offered = nearbyDevices(status, '100.105.157.6').map((d) => d.ip);
  assert.equal(offered.includes('100.105.157.69'), false, 'a sharee node is not a machine');
});

test('an exact address is still recognised as an address', () => {
  assert.equal(looksLikeIp('100.72.63.41'), true);
  assert.equal(looksLikeIp('lit'), false);
  assert.equal(looksLikeIp('lit:4747'), false);
  assert.equal(looksLikeIp(''), false);
});

const OWN_STATUS = JSON.stringify({
  User: { 1: { LoginName: 'me@example.com' }, 2: { LoginName: 'other@example.com' } },
  Self: {
    UserID: 1, HostName: 'MacBook Pro', DNSName: 'macbook-pro.tail.ts.net.',
    TailscaleIPs: ['100.122.98.16'],
  },
  Peer: {
    a: { HostName: 'localhost', DNSName: 'realme.tail.ts.net.', TailscaleIPs: ['100.72.63.41'], UserID: 1, Online: true, LastSeen: '2026-08-13T10:00:00Z' },
    b: { HostName: 'localhost', DNSName: 'kali.tail.ts.net.', TailscaleIPs: ['100.78.12.77'], UserID: 1, Online: false, LastSeen: '2026-08-01T10:00:00Z' },
    c: { HostName: 'theirs', DNSName: 'theirs.tail.ts.net.', TailscaleIPs: ['100.99.0.1'], UserID: 2, Online: true },
    d: { HostName: 'shared', DNSName: '', TailscaleIPs: ['100.105.157.69'], UserID: 1, ShareeNode: true },
  },
});

test('the device list we hand a peer starts with this machine', () => {
  const own = ownDeviceList(parseStatus(OWN_STATUS));
  // Without self in the list a peer without the CLI could never dial us back —
  // which is the entire point of sending it.
  assert.equal(own[0].dns, 'macbook-pro.tail.ts.net');
  assert.deepEqual(own[0].ips, ['100.122.98.16']);
});

test('devices that merely share a hostname stay separate', () => {
  const own = ownDeviceList(parseStatus(OWN_STATUS));
  // Android calls itself "localhost"; grouping by host would merge two machines
  // and hide one of the addresses a peer needs.
  const localhosts = own.filter((d) => d.host === 'localhost');
  assert.equal(localhosts.length, 2);
  assert.deepEqual(localhosts.map((d) => d.dns), ['realme.tail.ts.net', 'kali.tail.ts.net']);
});

test('the list holds only our own real machines', () => {
  const own = ownDeviceList(parseStatus(OWN_STATUS));
  const ips = own.flatMap((d) => d.ips);
  assert.equal(ips.includes('100.99.0.1'), false, 'another person is not ours to announce');
  assert.equal(ips.includes('100.105.157.69'), false, 'a sharing placeholder is not a machine');
});

test('an online device is offered before a stale one', () => {
  const own = ownDeviceList(parseStatus(OWN_STATUS));
  const order = own.slice(1).map((d) => d.dns);
  assert.deepEqual(order, ['realme.tail.ts.net', 'kali.tail.ts.net']);
});

test('nothing is announced when the daemon says nothing', () => {
  assert.deepEqual(ownDeviceList(null), []);
  assert.deepEqual(ownDeviceList(parseStatus('{}')), []);
});

test('isPrivateIp detects RFC 1918, loopback, and link-local addresses', () => {
  // Private IPv4 (LAN)
  assert.equal(isPrivateIp('192.168.1.1'), true);
  assert.equal(isPrivateIp('192.168.100.50:41641'), true);
  assert.equal(isPrivateIp('10.0.0.1'), true);
  assert.equal(isPrivateIp('10.200.1.5:1234'), true);
  assert.equal(isPrivateIp('172.16.0.1'), true);
  assert.equal(isPrivateIp('172.31.255.254'), true);
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('169.254.1.1'), true);

  // Private IPv6 (ULA / link-local)
  assert.equal(isPrivateIp('fe80::1'), true);
  assert.equal(isPrivateIp('[fe80::1234]:41641'), true);
  assert.equal(isPrivateIp('fd00::1'), true);
  assert.equal(isPrivateIp('::1'), true);

  // Public WAN / Tailnet
  assert.equal(isPrivateIp('95.24.12.33'), false);
  assert.equal(isPrivateIp('95.24.12.33:41641'), false);
  assert.equal(isPrivateIp('100.105.157.69'), false);
  assert.equal(isPrivateIp('100.96.226.28:4747'), false);
  assert.equal(isPrivateIp('172.32.0.1'), false);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp(''), false);
  assert.equal(isPrivateIp(null), false);
});

test('resolveRouteKind calls only link-local endpoints direct LAN', () => {
  assert.deepEqual(resolveRouteKind({ curAddr: '192.168.1.100:41641' }), {
    kind: 'direct-private',
    endpoint: '192.168.1.100:41641',
  });
  assert.deepEqual(resolveRouteKind({ curAddr: '10.66.66.254:41641' }), {
    kind: 'direct-private',
    endpoint: '10.66.66.254:41641',
  });
  assert.deepEqual(resolveRouteKind({ curAddr: '[fe80::1]:41641' }), {
    kind: 'direct-lan',
    endpoint: '[fe80::1]:41641',
  });

  assert.deepEqual(resolveRouteKind({ curAddr: '95.24.12.33:41641' }), {
    kind: 'direct-wan',
    endpoint: '95.24.12.33:41641',
  });
  assert.deepEqual(resolveRouteKind({ curAddr: '', relay: 'fra' }), {
    kind: 'derp-relay',
    relay: 'fra',
    endpoint: 'derp-fra',
  });
  assert.deepEqual(resolveRouteKind({ curAddr: '', relay: '', remoteIp: '192.168.1.5' }), {
    kind: 'direct-private',
    endpoint: '192.168.1.5',
  });
  assert.deepEqual(resolveRouteKind({ curAddr: '', relay: '', remoteIp: '100.78.12.77' }), {
    kind: 'tailnet',
    endpoint: '100.78.12.77',
  });
});

test('inspectPeerRoute locates peer in Tailscale status and resolves route', () => {
  const status = {
    peers: [
      {
        host: 'rb5009ug',
        dnsName: 'rb5009ug.tail.ts.net',
        ips: ['100.96.226.28'],
        curAddr: '192.168.1.1:41641',
        relay: '',
      },
      {
        host: 'ovs-server-linux',
        dnsName: 'ovs-server-linux.tail.ts.net',
        ips: ['100.79.54.35'],
        curAddr: '',
        relay: 'fra',
      },
    ],
  };

  const privateRoute = inspectPeerRoute(status, '100.96.226.28');
  assert.equal(privateRoute.kind, 'direct-private');
  assert.equal(privateRoute.endpoint, '192.168.1.1:41641');

  const relayRoute = inspectPeerRoute(status, 'ovs-server-linux');
  assert.equal(relayRoute.kind, 'derp-relay');
  assert.equal(relayRoute.relay, 'fra');
});

test('parseTailscalePing parses DERP, private, and WAN ping responses', () => {
  // DERP relay
  const derpRaw = 'pong from desktop-iru (100.105.157.69) via DERP(fra) in 110ms\n2026/08/29 direct connection not established';
  const derpParsed = parseTailscalePing(derpRaw);
  assert.equal(derpParsed.host, 'desktop-iru');
  assert.equal(derpParsed.ip, '100.105.157.69');
  assert.equal(derpParsed.rtt, 110);
  assert.equal(derpParsed.route.kind, 'derp-relay');
  assert.equal(derpParsed.route.relay, 'fra');

  const privateRaw = 'pong from roman (100.96.226.28) via 10.66.66.254:41641 in 52ms';
  const privateParsed = parseTailscalePing(privateRaw);
  assert.equal(privateParsed.host, 'roman');
  assert.equal(privateParsed.rtt, 52);
  assert.equal(privateParsed.route.kind, 'direct-private');
  assert.equal(privateParsed.route.endpoint, '10.66.66.254:41641');

  // Direct WAN
  const wanRaw = 'pong from remote-node (100.78.12.77) via 95.24.12.33:41641 in 24ms';
  const wanParsed = parseTailscalePing(wanRaw);
  assert.equal(wanParsed.host, 'remote-node');
  assert.equal(wanParsed.ip, '100.78.12.77');
  assert.equal(wanParsed.rtt, 24);
  assert.equal(wanParsed.route.kind, 'direct-wan');
  assert.equal(wanParsed.route.endpoint, '95.24.12.33:41641');

  // Unrelated text
  assert.equal(parseTailscalePing('no route to host'), null);
});

test('tailscalePingPeer runs ping command and parses output even on non-zero exit', async () => {
  const mockExec = (cmd, args, options, cb) => {
    const err = new Error('exit code 1');
    const stdout = 'pong from desktop-iru (100.105.157.69) via DERP(fra) in 95ms\n';
    cb(err, stdout, '');
  };
  const res = await tailscalePingPeer('/bin/tailscale', '100.105.157.69', { exec: mockExec });
  assert.ok(res);
  assert.equal(res.host, 'desktop-iru');
  assert.equal(res.rtt, 95);
  assert.equal(res.route.kind, 'derp-relay');
});

test('isTailnetIp recognizes Tailscale CGNAT and IPv6 ranges', () => {
  assert.equal(isTailnetIp('100.64.0.1'), true);
  assert.equal(isTailnetIp('100.105.157.69'), true);
  assert.equal(isTailnetIp('100.127.255.254'), true);
  assert.equal(isTailnetIp('fd7a:115c:a1e0:ab12:4843:cd96:6269:9d45'), true);

  assert.equal(isTailnetIp('100.128.0.1'), false); // out of /10
  assert.equal(isTailnetIp('192.168.1.1'), false);
  assert.equal(isTailnetIp('10.0.0.1'), false);
  assert.equal(isTailnetIp('127.0.0.1'), false);
  assert.equal(isTailnetIp(null), false);
});

test('isNonTailscaleLan identifies non-tailscale private local endpoints', () => {
  assert.equal(isNonTailscaleLan('192.168.1.50'), true);
  assert.equal(isNonTailscaleLan('10.0.0.5'), true);
  assert.equal(isNonTailscaleLan('172.20.1.1'), true);

  assert.equal(isNonTailscaleLan('100.105.157.69'), false);
  assert.equal(isNonTailscaleLan('desktop.tailc80816.ts.net'), false);
  assert.equal(isNonTailscaleLan('8.8.8.8'), false);
});

test('probeTailscaleStatus parses backend status when CLI is running', async () => {
  const mockExec = (args) => Promise.resolve(JSON.stringify({
    BackendState: 'Running',
    Self: {
      UserID: 1,
      DNSName: 'my-laptop.ts.net',
      TailscaleIPs: ['100.100.100.1'],
    },
    User: {
      '1': { LoginName: 'alice@example.com' },
    },
  }));

  const res = await probeTailscaleStatus({
    cliPath: '/bin/tailscale',
    run: mockExec,
  });

  assert.equal(res.hasCli, true);
  assert.equal(res.active, true);
  assert.equal(res.backendState, 'Running');
  assert.equal(res.self.login, 'alice@example.com');
  assert.equal(res.self.node, 'my-laptop.ts.net');
});

test('probeTailscaleStatus detects disconnected Tailscale when daemon is stopped', async () => {
  const mockExec = () => Promise.reject(new Error('daemon stopped'));
  const res = await probeTailscaleStatus({
    cliPath: '/bin/tailscale',
    interfaces: {}, // no tailscale interface
    run: mockExec,
  });

  assert.equal(res.hasCli, true);
  assert.equal(res.active, false);
  assert.equal(res.backendState, 'Stopped');
});

test('probeTailscaleStatus detects active status via network interfaces without CLI', async () => {
  const mockInterfaces = {
    tun0: [{ family: 'IPv4', address: '100.90.80.70' }],
  };
  const res = await probeTailscaleStatus({
    cliPath: null,
    interfaces: mockInterfaces,
  });

  assert.equal(res.hasCli, false);
  assert.equal(res.active, true);
  assert.equal(res.backendState, 'Running');
});
