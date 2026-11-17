import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  isPrivateAddress, extractMeta, resolvePinned, fetchLinkPreview,
} from '../src/cloud/link-preview.js';

test('isPrivateAddress rejects loopback, RFC1918, CGNAT/Tailscale, link-local and reserved ranges', () => {
  const blocked = [
    ['127.0.0.1', 4], ['10.0.0.5', 4], ['172.16.0.1', 4], ['172.31.255.255', 4],
    ['192.168.1.1', 4], ['169.254.169.254', 4], // cloud metadata
    ['100.64.0.1', 4], ['100.100.100.100', 4], ['100.127.255.255', 4], // CGNAT / Tailscale
    ['0.0.0.0', 4], ['224.0.0.1', 4],
    ['::1', 6], ['fe80::1', 6], ['fc00::1', 6], ['fd12:3456::1', 6], ['::ffff:127.0.0.1', 6],
  ];
  for (const [address, family] of blocked) {
    assert.equal(isPrivateAddress(address, family), true, `${address} should be blocked`);
  }
});

test('isPrivateAddress allows ordinary public addresses', () => {
  const allowed = [
    ['8.8.8.8', 4], ['1.1.1.1', 4], ['93.184.216.34', 4],
    ['2606:4700:4700::1111', 6],
  ];
  for (const [address, family] of allowed) {
    assert.equal(isPrivateAddress(address, family), false, `${address} should be allowed`);
  }
  // 172.15/172.32 sit just outside the private 172.16-31 band.
  assert.equal(isPrivateAddress('172.15.0.1', 4), false);
  assert.equal(isPrivateAddress('172.32.0.1', 4), false);
  // 100.63/100.128 sit just outside the CGNAT 100.64-127 band.
  assert.equal(isPrivateAddress('100.63.255.255', 4), false);
  assert.equal(isPrivateAddress('100.128.0.0', 4), false);
});

test('resolvePinned rejects a hostname that resolves to loopback', async () => {
  assert.equal(await resolvePinned('localhost'), null);
  assert.equal(await resolvePinned('127.0.0.1'), null);
});

test('resolvePinned accepts a literal public IP without a DNS round trip', async () => {
  const pinned = await resolvePinned('8.8.8.8');
  assert.deepEqual(pinned, { address: '8.8.8.8', family: 4 });
});

test('extractMeta reads Open Graph tags, falls back to <title>, decodes entities and truncates', () => {
  const withOg = extractMeta(`<html><head>
    <meta property="og:title" content="Caf\u00e9 &amp; Co">
    <meta property="og:description" content="A place with &quot;great&quot; coffee">
    <meta property="og:image" content="https://example.com/img.png">
    <meta property="og:site_name" content="Example">
  </head></html>`);
  assert.deepEqual(withOg, {
    title: 'Café & Co', description: 'A place with "great" coffee', image: 'https://example.com/img.png', siteName: 'Example',
  });

  const titleOnly = extractMeta('<html><head><title>Just a title</title></head></html>');
  assert.equal(titleOnly.title, 'Just a title');
  assert.equal(titleOnly.description, null);

  const none = extractMeta('<html><head></head><body>hi</body></html>');
  assert.deepEqual(none, {
    title: null, description: null, image: null, siteName: null,
  });

  const long = extractMeta(`<title>${'x'.repeat(300)}</title>`);
  assert.equal(long.title.length, 200);
});

test('extractMeta accepts reordered, unquoted and multiline meta attributes', () => {
  assert.deepEqual(extractMeta(`<head>
    <meta content='Reordered title' property='og:title'>
    <meta name=description
      content="Readable description">
  </head>`), {
    title: 'Reordered title', description: 'Readable description', image: null, siteName: null,
  });
});

// A tiny fixture server plus an injected `resolve` that hands back its real
// loopback address: this exercises the actual `fetchOnce` — connect, follow
// a redirect, cap an oversized body, reject a non-HTML content type — without
// either touching the public internet or weakening the real SSRF check,
// which is tested unmocked above (`resolvePinned` really does refuse
// `localhost`).
function withFixtureServer(t, handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ port, resolveLocal: async () => ({ address: '127.0.0.1', family: 4 }) });
    });
  });
}

test('fetchLinkPreview follows the real pipeline against a fixture server', async (t) => {
  const { port, resolveLocal } = await withFixtureServer(t, (req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><head><meta property="og:title" content="Fixture Page"></head></html>');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const preview = await fetchLinkPreview(`http://example.test:${port}/page`, { resolve: resolveLocal });
  assert.deepEqual(preview, {
    url: `http://example.test:${port}/page`, title: 'Fixture Page', description: null, image: null, siteName: null,
  });
});

test('fetchLinkPreview follows one redirect to the final page', async (t) => {
  const { port, resolveLocal } = await withFixtureServer(t, (req, res) => {
    if (req.url === '/old') {
      res.writeHead(302, { location: '/new' });
      res.end();
      return;
    }
    if (req.url === '/new') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Landed</title>');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const preview = await fetchLinkPreview(`http://example.test:${port}/old`, { resolve: resolveLocal });
  assert.equal(preview.title, 'Landed');
  assert.equal(preview.url, `http://example.test:${port}/new`);
});

test('fetchLinkPreview resolves relative preview images against the final page', async () => {
  const preview = await fetchLinkPreview('https://example.test/articles/post', {
    resolve: async () => ({ address: '203.0.113.1', family: 4 }),
    fetchPage: async () => ({ html: '<meta property="og:title" content="Post"><meta property="og:image" content="/cover.jpg">' }),
  });
  assert.equal(preview.image, 'https://example.test/cover.jpg');
});

test('fetchLinkPreview rejects a non-HTML response and a non-2xx status', async (t) => {
  const { port, resolveLocal } = await withFixtureServer(t, (req, res) => {
    if (req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(500);
    res.end('boom');
  });
  assert.equal(await fetchLinkPreview(`http://example.test:${port}/json`, { resolve: resolveLocal }), null);
  assert.equal(await fetchLinkPreview(`http://example.test:${port}/error`, { resolve: resolveLocal }), null);
});

test('fetchLinkPreview gives up on a response past the size ceiling instead of hanging', async (t) => {
  const { port, resolveLocal } = await withFixtureServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 10; i += 1) res.write(chunk);
    res.end();
  });
  assert.equal(await fetchLinkPreview(`http://example.test:${port}/huge`, { resolve: resolveLocal }), null);
});

test('fetchLinkPreview refuses non-http(s) schemes and unparsable URLs', async () => {
  assert.equal(await fetchLinkPreview('ftp://example.com/file'), null);
  assert.equal(await fetchLinkPreview('not a url'), null);
  assert.equal(await fetchLinkPreview('javascript:alert(1)'), null);
});

test('fetchLinkPreview refuses a URL whose hostname resolves privately, unmocked', async () => {
  assert.equal(await fetchLinkPreview('http://127.0.0.1/'), null);
  assert.equal(await fetchLinkPreview('http://localhost/'), null);
  assert.equal(await fetchLinkPreview('http://169.254.169.254/latest/meta-data/'), null);
  assert.equal(await fetchLinkPreview('http://100.64.0.1/'), null);
});
