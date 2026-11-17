import fs from 'node:fs';
import path from 'node:path';

// P2P has no server to enforce blocking, so the CLI itself is the only
// authority: it refuses to send to a blocked peer and drops whatever a
// blocked peer sends back. Cloud mode also calls the server's `/block`
// endpoint, but this file is what makes blocking work at all offline.

const FILE = 'blocked.json';

const fileFor = (dir) => path.join(dir, FILE);

const cleanText = (value, limit) => {
  const text = String(value ?? '').trim().toLowerCase();
  return text.length > 0 && text.length <= limit ? text : null;
};

export function readBlocklist(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(dir), 'utf8'));
    const logins = {};
    for (const login of Array.isArray(parsed?.logins) ? parsed.logins : []) {
      const key = cleanText(login, 254);
      if (key) logins[key] = true;
    }
    return { logins };
  } catch {
    return { logins: {} };
  }
}

function saveBlocklist(dir, blocklist) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${fileFor(dir)}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ logins: Object.keys(blocklist.logins) }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, fileFor(dir));
    return true;
  } catch {
    return false;
  }
}

export function blockLogin(dir, login) {
  const key = cleanText(login, 254);
  if (!key) return false;
  const blocklist = readBlocklist(dir);
  blocklist.logins[key] = true;
  return saveBlocklist(dir, blocklist);
}

export function unblockLogin(dir, login) {
  const key = cleanText(login, 254);
  if (!key) return false;
  const blocklist = readBlocklist(dir);
  if (!Object.hasOwn(blocklist.logins, key)) return false;
  delete blocklist.logins[key];
  return saveBlocklist(dir, blocklist);
}

export function isBlocked(dir, login) {
  const key = cleanText(login, 254);
  if (!key) return false;
  const blocklist = readBlocklist(dir);
  return Object.hasOwn(blocklist.logins, key);
}
