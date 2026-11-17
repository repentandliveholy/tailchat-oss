import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const READY_FILE = '.cloud-encrypted';
export const DATA_FILES = ['accounts.json', 'accounts.journal', 'server_key.json', 'vapid_key.json', 'fcm_service_account.json', 'turn_secret', 'github_token'];
const FORMAT = 'tailchat-cloud-aead';

export function createCloudCipher(keyFile, dir) {
  if (!keyFile) throw new Error('TAILCHAT_CLOUD_MASTER_KEY_FILE is required for encrypted cloud storage');
  const realDir = fs.realpathSync(dir);
  const realKey = fs.realpathSync(keyFile);
  if (realKey === realDir || realKey.startsWith(`${realDir}${path.sep}`)) {
    throw new Error('Cloud master key must be outside the data directory');
  }
  const stat = fs.statSync(realKey);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Cloud master key must be a regular file readable only by its owner (0600)');
  const keyText = fs.readFileSync(realKey, 'utf8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(keyText)) throw new Error('Cloud master key must contain exactly 64 hex digits (32 bytes)');
  const key = Buffer.from(keyText, 'hex');
  const keyId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
  return {
    keyId,
    seal(plaintext, name) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(`${FORMAT}:1:${keyId}:${name}`));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return JSON.stringify({ format: FORMAT, version: 1, keyId, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
    },
    async sealFile(text, name, file) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(`${FORMAT}:1:${keyId}:${name}`));
      const target = await fsp.open(file, 'w', 0o600);
      try {
        await target.writeFile(`{"format":"${FORMAT}","version":1,"keyId":"${keyId}","nonce":"${nonce.toString('base64')}","ciphertext":"`);
        // Base64 chunks must end on a three-byte boundary. Encode UTF-8 with
        // encodeInto so a surrogate pair is never split between chunks.
        const encoder = new TextEncoder();
        const buffer = new Uint8Array(48 * 1024);
        let offset = 0;
        let remainder = Buffer.alloc(0);
        while (offset < text.length) {
          let endOffset = Math.min(text.length, offset + 16 * 1024);
          const last = text.charCodeAt(endOffset - 1);
          if (endOffset < text.length && last >= 0xD800 && last <= 0xDBFF) endOffset -= 1;
          const { read, written } = encoder.encodeInto(text.slice(offset, endOffset), buffer);
          offset += read;
          const encrypted = Buffer.concat([remainder, cipher.update(buffer.subarray(0, written))]);
          const end = encrypted.length - encrypted.length % 3;
          await target.writeFile(encrypted.subarray(0, end).toString('base64'));
          remainder = encrypted.subarray(end);
        }
        await target.writeFile(Buffer.concat([remainder, cipher.final()]).toString('base64'));
        await target.writeFile(`","tag":"${cipher.getAuthTag().toString('base64')}"}`);
      } finally {
        await target.close();
      }
    },
    open(raw, name) {
      let envelope;
      try { envelope = JSON.parse(raw); } catch { throw new Error(`Encrypted cloud ${name}: malformed envelope`); }
      if (envelope?.format !== FORMAT || envelope.version !== 1 || envelope.keyId !== keyId) {
        throw new Error(`Encrypted cloud ${name}: format/version/keyId mismatch (wrong key or plaintext)`);
      }
      for (const field of ['nonce', 'ciphertext', 'tag']) {
        if (typeof envelope[field] !== 'string' || envelope[field].length === 0 || (envelope[field].length % 4) !== 0) {
          throw new Error(`Encrypted cloud ${name}: invalid ${field}`);
        }
      }
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.nonce) || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.tag)) {
        throw new Error(`Encrypted cloud ${name}: invalid nonce/tag`);
      }
      const nonce = Buffer.from(envelope.nonce, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      if (nonce.length !== 12 || tag.length !== 16) throw new Error(`Encrypted cloud ${name}: invalid nonce/tag`);
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(Buffer.from(`${FORMAT}:1:${keyId}:${name}`));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
      } catch { throw new Error(`Encrypted cloud ${name}: authentication failed (wrong key or tampered data)`); }
    },
  };
}

export function readyCipher(dir, keyFile, { initialize = false, allowPlaintextLegacy = false } = {}) {
  const marker = path.join(dir, READY_FILE);
  if (!fs.existsSync(marker)) {
    if (!keyFile) {
      if (allowPlaintextLegacy) return null;
      throw new Error('TAILCHAT_CLOUD_MASTER_KEY_FILE is required for Cloud storage');
    }
    const cipher = createCloudCipher(keyFile, dir);
    if (!initialize) throw new Error(`Encrypted cloud storage requires completed offline migration: ${marker}`);
    const existing = fs.readdirSync(dir);
    if (existing.length) throw new Error(`Cloud data directory contains files but no encrypted marker: ${dir}; run offline migration to a separate empty directory`);
    fs.writeFileSync(marker, cipher.seal(Buffer.from('ready'), READY_FILE), { flag: 'wx', mode: 0o600 });
    return cipher;
  }
  const cipher = createCloudCipher(keyFile, dir);
  if (cipher.open(fs.readFileSync(marker, 'utf8'), READY_FILE).toString() !== 'ready') throw new Error('Encrypted cloud marker mismatch');
  return cipher;
}

export function readCloudSidecar(dir, name, cipher = readyCipher(dir, process.env.TAILCHAT_CLOUD_MASTER_KEY_FILE), allowPlaintextLegacy = false) {
  if (!cipher && !allowPlaintextLegacy) throw new Error('Cloud sidecar encryption key is required');
  const raw = fs.readFileSync(path.join(dir, name));
  return cipher ? cipher.open(raw.toString('utf8'), name).toString('utf8') : raw.toString('utf8');
}

export function writeCloudSidecar(dir, name, text, cipher = readyCipher(dir, process.env.TAILCHAT_CLOUD_MASTER_KEY_FILE), allowPlaintextLegacy = false) {
  if (!cipher && !allowPlaintextLegacy) throw new Error('Cloud sidecar encryption key is required');
  const fd = fs.openSync(path.join(dir, name), 'wx', 0o600);
  try {
    fs.writeFileSync(fd, cipher ? cipher.seal(Buffer.from(text), name) : text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
