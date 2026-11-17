import os from 'node:os';

export function parsePeerAddr(input, defaultPort) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('peer address required');
  }
  if (input.startsWith('[')) {
    const end = input.indexOf(']');
    if (end === -1) throw new Error(`bad address: ${input}`);
    const host = input.slice(1, end);
    const rest = input.slice(end + 1);
    if (rest === '') return { host, port: defaultPort };
    if (rest.startsWith(':')) return { host, port: parsePort(rest.slice(1)) };
    throw new Error(`bad address: ${input}`);
  }
  const first = input.indexOf(':');
  const last = input.lastIndexOf(':');
  if (first !== -1 && first === last) {
    return { host: input.slice(0, first), port: parsePort(input.slice(first + 1)) };
  }
  return { host: input, port: defaultPort }; // bare host or bare IPv6
}

function parsePort(s) {
  const p = Number(s);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`bad port: ${s}`);
  return p;
}

export function normalizeIp(addr) {
  if (!addr) return addr;
  let a = addr;
  const pct = a.indexOf('%');
  if (pct !== -1) a = a.slice(0, pct);
  if (a.startsWith('::ffff:')) a = a.slice('::ffff:'.length);
  return a;
}

export function ownTailnetIps(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const name of Object.keys(interfaces)) {
    for (const ni of interfaces[name] || []) {
      const address = normalizeIp(ni.address);
      if (ni.family === 'IPv4' && isTailnet(address)) out.push(address);
      else if (ni.family === 'IPv6' && address.toLowerCase().startsWith('fd7a:115c:a1e0:')) out.push(address);
    }
  }
  return out;
}

export function detectBindAddr(interfaces = os.networkInterfaces()) {
  return ownTailnetIps(interfaces).find((ip) => !ip.includes(':')) ?? '0.0.0.0';
}

function isTailnet(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  return a === 100 && b >= 64 && b <= 127; // 100.64.0.0/10 (CGNAT / Tailscale)
}
