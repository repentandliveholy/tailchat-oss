import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Buffer } from 'node:buffer';

// A link preview means the *server* fetches a URL a friend merely pasted
// into a chat — the one place in this codebase that turns untrusted user
// input into an outbound request the server itself makes. Every limit here
// exists to keep that request from being aimable at anything but the public
// web: the server's own metadata endpoint, its LAN, its Tailscale tailnet
// peers, all sit behind addresses this module refuses to connect to,
// however a hostname resolves.
const FETCH_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 400;
const USER_AGENT = 'TailchatLinkPreview/1.0 (+https://repentandliveholy.org/tailchat/)';

// Loopback, private LAN, CGNAT (100.64.0.0/10 — this is also Tailscale's own
// range; the cloud server itself lives at a 100.x address on its tailnet),
// link-local (which is also where a cloud provider's instance-metadata
// service lives, e.g. 169.254.169.254), and the reserved/multicast tail of
// the IPv4 space.
export function isPrivateAddress(address, family) {
  if (family === 4) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  const lower = address.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length);
    return net.isIPv4(mapped) ? isPrivateAddress(mapped, 4) : true;
  }
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
  return false;
}

// Resolves and validates a hostname once, up front — the same address is
// then pinned for the actual connection via `lookup`, so nothing between
// this check and the socket opening can hand the request a different
// address for the same name. A response mixing a public decoy with a
// private target is treated as hostile as a whole: a legitimate public site
// has no reason to ever answer with a private address, so any one showing up
// voids the whole hostname rather than quietly picking around it.
export async function resolvePinned(hostname) {
  if (net.isIP(hostname)) {
    const family = net.isIPv6(hostname) ? 6 : 4;
    if (isPrivateAddress(hostname, family)) return null;
    return { address: hostname, family };
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return null;
  }
  if (records.length === 0 || records.some((r) => isPrivateAddress(r.address, r.family))) return null;
  return records[0];
}

export function extractMeta(html) {
  const head = html.slice(0, 65536);
  const pick = (re) => {
    const m = re.exec(head);
    return m ? m[1] : null;
  };
  const decode = (s) => s
    .replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  const metaContent = (prop) => {
    for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
      const attrs = Object.create(null);
      for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
        attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
      }
      if ((attrs.property || attrs.name || '').toLowerCase() === prop) return attrs.content || null;
    }
    return null;
  };
  const title = metaContent('og:title') || pick(/<title[^>]*>([^<]*)<\/title>/i);
  const description = metaContent('og:description') || metaContent('description');
  const image = metaContent('og:image');
  const siteName = metaContent('og:site_name');
  return {
    title: title ? decode(title).slice(0, MAX_TITLE_CHARS) : null,
    description: description ? decode(description).slice(0, MAX_DESCRIPTION_CHARS) : null,
    image: image ? decode(image) : null,
    siteName: siteName ? decode(siteName).slice(0, 80) : null,
  };
}

// One hop: connect to the pinned address, send the request for the original
// host, and read at most `MAX_RESPONSE_BYTES` before giving up on the rest —
// a preview needs the `<head>`, never the whole page.
export function fetchOnce(urlObj, pinned) {
  return new Promise((resolve, reject) => {
    const transport = urlObj.protocol === 'https:' ? https : http;
    const req = transport.request({
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: `${urlObj.pathname}${urlObj.search}`,
      method: 'GET',
      timeout: FETCH_TIMEOUT_MS,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
      },
      // The one thing pinning changes: whatever DNS is doing right now is
      // irrelevant, because `lookup` is never actually asked to look up
      // anything — it hands back the address `resolvePinned` already cleared.
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'function') { callback = options; options = {}; }
        // Node asks for the array form (`all: true`) when it wants to race
        // multiple addresses (Happy Eyeballs); answering with the scalar
        // form regardless of what was asked handed back `undefined` for the
        // address and failed every single request through this path.
        if (options && options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
        else callback(null, pinned.address, pinned.family);
      },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve({ redirect: new URL(res.headers.location, urlObj) });
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        resolve({ error: `status_${status}` });
        return;
      }
      const contentType = String(res.headers['content-type'] || '');
      if (!/text\/html|application\/xhtml/i.test(contentType)) {
        res.resume();
        resolve({ error: 'not_html' });
        return;
      }
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (error) => resolve({ error: error.message }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// The public entry point: validates the URL, resolves and pins its address,
// follows a bounded number of redirects (re-validating and re-pinning the
// address at every hop, since a redirect target is just as untrusted as the
// original link), and returns a preview or `null` for anything that fails,
// looks unsafe, or is not actually an HTML page.
//
// `resolve`/`fetchPage` default to the real, SSRF-guarded implementations;
// production code (server.js) never overrides them. Tests inject a `resolve`
// that points at a local fixture server so the full pipeline — connect,
// follow a redirect, cap the response, parse the meta tags — runs for real
// without either reaching the public internet or weakening the address
// check itself, which is tested separately and unmocked.
export async function fetchLinkPreview(rawUrl, { resolve = resolvePinned, fetchPage = fetchOnce } = {}) {
  let urlObj;
  try {
    urlObj = new URL(rawUrl);
  } catch {
    return null;
  }
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') return null;

  let current = urlObj;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') return null;
    const pinned = await resolve(current.hostname);
    if (!pinned) return null;
    let result;
    try {
      result = await fetchPage(current, pinned);
    } catch {
      return null;
    }
    if (result.redirect) {
      current = result.redirect;
      continue;
    }
    if (result.error || !result.html) return null;
    const meta = extractMeta(result.html);
    if (!meta.title && !meta.description && !meta.image) return null;
    if (meta.image) {
      try { meta.image = new URL(meta.image, current).toString(); } catch { meta.image = null; }
    }
    return { url: current.toString(), ...meta };
  }
  return null;
}
