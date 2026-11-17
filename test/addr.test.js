import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePeerAddr, normalizeIp, detectBindAddr, ownTailnetIps } from '../src/addr.js';

test('parsePeerAddr: bare host uses default port', () => {
  assert.deepEqual(parsePeerAddr('lit', 4747), { host: 'lit', port: 4747 });
});
test('parsePeerAddr: host:port', () => {
  assert.deepEqual(parsePeerAddr('lit:5000', 4747), { host: 'lit', port: 5000 });
});
test('parsePeerAddr: ipv4 with port', () => {
  assert.deepEqual(parsePeerAddr('100.71.187.60:22', 4747), { host: '100.71.187.60', port: 22 });
});
test('parsePeerAddr: bracketed ipv6 with port', () => {
  assert.deepEqual(parsePeerAddr('[fd7a::1]:4747', 4747), { host: 'fd7a::1', port: 4747 });
});
test('parsePeerAddr: bracketed ipv6 without port', () => {
  assert.deepEqual(parsePeerAddr('[fd7a::1]', 4747), { host: 'fd7a::1', port: 4747 });
});
test('parsePeerAddr: bare ipv6 (multiple colons) is host, default port', () => {
  assert.deepEqual(parsePeerAddr('fd7a::1', 4747), { host: 'fd7a::1', port: 4747 });
});
test('parsePeerAddr: rejects empty', () => {
  assert.throws(() => parsePeerAddr('', 4747));
});
test('parsePeerAddr: rejects bad port', () => {
  assert.throws(() => parsePeerAddr('lit:99999', 4747));
});
test('normalizeIp: strips v4-mapped prefix', () => {
  assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
});
test('normalizeIp: strips scope id', () => {
  assert.equal(normalizeIp('fe80::1%en0'), 'fe80::1');
});
test('normalizeIp: passes plain ipv4', () => {
  assert.equal(normalizeIp('100.64.0.1'), '100.64.0.1');
});
test('detectBindAddr: picks tailnet 100.64/10 address', () => {
  const ifaces = {
    lo0: [{ family: 'IPv4', address: '127.0.0.1' }],
    tailscale0: [{ family: 'IPv4', address: '100.71.187.60' }],
    en0: [{ family: 'IPv4', address: '192.168.1.5' }],
  };
  assert.equal(detectBindAddr(ifaces), '100.71.187.60');
});
test('detectBindAddr: falls back to 0.0.0.0 without tailnet', () => {
  const ifaces = { en0: [{ family: 'IPv4', address: '192.168.1.5' }] };
  assert.equal(detectBindAddr(ifaces), '0.0.0.0');
});
test('detectBindAddr: 100.128.x is NOT tailnet (out of /10)', () => {
  const ifaces = { x: [{ family: 'IPv4', address: '100.128.0.1' }] };
  assert.equal(detectBindAddr(ifaces), '0.0.0.0');
});

test('ownTailnetIps: collects tailnet v4 and v6, ignores the rest', () => {
  const ifaces = {
    lo0: [{ family: 'IPv4', address: '127.0.0.1' }, { family: 'IPv6', address: '::1' }],
    en0: [{ family: 'IPv4', address: '192.168.1.5' }, { family: 'IPv6', address: 'fe80::1' }],
    tailscale0: [
      { family: 'IPv4', address: '100.71.187.60' },
      { family: 'IPv6', address: 'fd7a:115c:a1e0::1001:6211' },
      { family: 'IPv6', address: 'fd00::2' },
    ],
  };
  assert.deepEqual(ownTailnetIps(ifaces), ['100.71.187.60', 'fd7a:115c:a1e0::1001:6211']);
});
