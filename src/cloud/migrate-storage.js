import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createCloudCipher, DATA_FILES, READY_FILE } from './storage-crypto.js';

function readSource(source) {
  const files = fs.readdirSync(source);
  const unknown = files.filter((name) => !DATA_FILES.includes(name));
  if (unknown.length) throw new Error(`Unexpected files in source directory; inspect before migrating: ${unknown.join(', ')}`);
  if (!files.includes('server_key.json')) throw new Error('Source server_key.json is missing; refusing to regenerate server identity');
  if (!files.includes('vapid_key.json')) throw new Error('Source VAPID identity is missing; recover push credentials before migration');
  if (!files.includes('accounts.json') && !files.includes('accounts.journal')) throw new Error('Source has no account snapshot or journal');
  const contents = new Map();
  for (const name of files) {
    const full = path.join(source, name);
    if (!fs.lstatSync(full).isFile()) throw new Error(`Source ${name} is not a regular file`);
    contents.set(name, fs.readFileSync(full));
  }
  if (contents.has('accounts.json')) {
    const snapshot = JSON.parse(contents.get('accounts.json').toString());
    if (snapshot?.version !== 1 || !snapshot.accounts || typeof snapshot.accounts !== 'object' || Array.isArray(snapshot.accounts)) {
      throw new Error('Source snapshot is not a supported accounts version; do not migrate corrupt data');
    }
  }
  if (contents.has('accounts.journal')) {
    const journal = contents.get('accounts.journal').toString();
    const lines = journal.split('\n');
    for (const [index, line] of lines.entries()) {
      if (!line) continue;
      if (index === lines.length - 1 && !journal.endsWith('\n')) continue; // unacknowledged partial append
      JSON.parse(line);
    }
  }
  const identity = JSON.parse(contents.get('server_key.json').toString());
  if (typeof identity?.pubKey !== 'string' || typeof identity?.privKey !== 'string') throw new Error('Source server identity is invalid');
  const vapid = JSON.parse(contents.get('vapid_key.json').toString());
  if (typeof vapid?.publicKey !== 'string' || typeof vapid?.privateKey !== 'string') throw new Error('Source VAPID identity is invalid');
  if (contents.has('fcm_service_account.json')) {
    const fcm = JSON.parse(contents.get('fcm_service_account.json').toString());
    if (typeof fcm?.project_id !== 'string' || typeof fcm?.private_key !== 'string') throw new Error('Source FCM credential is invalid');
  }
  return contents;
}

function fingerprint(files) {
  const digest = crypto.createHash('sha256');
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    digest.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  return digest.digest('hex');
}

function journalEntries(bytes) {
  const text = bytes.toString('utf8');
  const parts = text.split('\n');
  const entries = [];
  for (const [index, line] of parts.entries()) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Source journal contains an invalid entry');
      entries.push(line);
    } catch (error) {
      if (index !== parts.length - 1 || text.endsWith('\n')) throw error;
      // Only this incomplete, unacknowledged tail is excluded. The original
      // source remains intact, including its partial bytes.
    }
  }
  return entries;
}

function sealFile(cipher, name, bytes) {
  if (name !== 'accounts.journal') return cipher.seal(bytes, name);
  const entries = journalEntries(bytes);
  return entries.map((line) => cipher.seal(Buffer.from(line), name)).join('\n') + (entries.length ? '\n' : '');
}

function verifyFile(cipher, name, raw, bytes) {
  if (name !== 'accounts.journal') return cipher.open(raw, name).equals(bytes);
  const entries = journalEntries(bytes);
  const encrypted = raw.split('\n').filter(Boolean);
  return encrypted.length === entries.length && encrypted.every((line, index) =>
    cipher.open(line, name).toString('utf8') === entries[index]);
}

export function migrateCloudStorage({ source, target, keyFile }) {
  if (!source || !target || !keyFile) throw new Error('Migration requires --source, --target, and --key-file');
  const oldDir = fs.realpathSync(source);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const newDir = fs.realpathSync(target);
  if (oldDir === newDir || oldDir.startsWith(`${newDir}${path.sep}`) || newDir.startsWith(`${oldDir}${path.sep}`)) {
    throw new Error('Source and target must be disjoint directories');
  }
  // The master key must never be stored beside either generation of account
  // data: a backup of one data directory must not contain both.
  createCloudCipher(keyFile, oldDir);
  if (fs.existsSync(path.join(oldDir, READY_FILE))) throw new Error('Source is already encrypted');
  const cipher = createCloudCipher(keyFile, newDir);
  const files = readSource(oldDir);
  const originalFingerprint = fingerprint(files);
  const names = fs.readdirSync(newDir);
  const unknown = names.filter((name) => !files.has(name) && name !== READY_FILE && ![...files.keys()].some((file) => name === `.${file}.encrypting`));
  if (unknown.length) throw new Error(`Unexpected files in encrypted target: ${unknown.join(', ')}`);
  if (names.includes(READY_FILE)) throw new Error('Target is already active; refuse to overwrite encrypted storage');
  for (const [name, bytes] of files) {
    const destination = path.join(newDir, name);
    if (fs.existsSync(destination)) {
      if (!fs.lstatSync(destination).isFile()) throw new Error(`Target ${name} is not a regular file`);
      if (!verifyFile(cipher, name, fs.readFileSync(destination, 'utf8'), bytes)) {
        throw new Error(`Interrupted migration target ${name} differs from source; do not overwrite it`);
      }
      const abandoned = path.join(newDir, `.${name}.encrypting`);
      if (fs.existsSync(abandoned)) fs.unlinkSync(abandoned);
      continue;
    }
    const temporary = path.join(newDir, `.${name}.encrypting`);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary); // incomplete encrypted temporary, never a plaintext source
    fs.writeFileSync(temporary, sealFile(cipher, name, bytes), { flag: 'wx', mode: 0o600 });
    const handle = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, destination);
    if (!verifyFile(cipher, name, fs.readFileSync(destination, 'utf8'), bytes)) throw new Error(`Migration verification failed for ${name}`);
  }
  if (fingerprint(readSource(oldDir)) !== originalFingerprint) throw new Error('Source changed during migration; stop the old server and retry from a consistent offline copy');
  const marker = path.join(newDir, READY_FILE);
  fs.writeFileSync(marker, cipher.seal(Buffer.from('ready'), READY_FILE), { flag: 'wx', mode: 0o600 });
  const handle = fs.openSync(marker, 'r');
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  const directory = fs.openSync(newDir, 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  return { source: oldDir, target: newDir, keyId: cipher.keyId, files: [...files].map(([name, bytes]) => ({ name, bytes: bytes.length })), fingerprint: originalFingerprint };
}

export function initCloudStorage({ target, keyFile }) {
  if (!target || !keyFile) throw new Error('Bootstrap requires --target and --key-file');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const newDir = fs.realpathSync(target);
  const cipher = createCloudCipher(keyFile, newDir);
  const existing = fs.readdirSync(newDir);
  if (existing.includes(READY_FILE)) throw new Error('Target directory is already initialized');
  if (existing.length) throw new Error(`Target directory is not empty: ${newDir}; bootstrap requires an empty directory`);
  const marker = path.join(newDir, READY_FILE);
  fs.writeFileSync(marker, cipher.seal(Buffer.from('ready'), READY_FILE), { flag: 'wx', mode: 0o600 });
  const handle = fs.openSync(marker, 'r');
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  const directory = fs.openSync(newDir, 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  return { target: newDir, keyId: cipher.keyId, initialized: true };
}
