import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MAGIC = Buffer.from('TAILCHAT-LOCAL-AEAD-1\0');
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SERVICE = 'tailchat-local-history-v1';
const ACCOUNT = 'device-key';

function run(command, args, input, spawn = spawnSync) {
  const result = spawn(command, args, { input, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Secure storage unavailable (${command}): ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  return result.stdout.trim();
}

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class TailchatCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredWrite(ref CREDENTIAL credential, int flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr credential);
}
'@
$target = '${SERVICE}'
if ($args[0] -eq 'get') {
  $pointer = [IntPtr]::Zero
  if (-not [TailchatCredential]::CredRead($target, 1, 0, [ref]$pointer)) {
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 3 }
    throw 'Credential Manager read failed'
  }
  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][TailchatCredential+CREDENTIAL])
    $bytes = New-Object byte[] $credential.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
  } finally { [TailchatCredential]::CredFree($pointer) }
} else {
  $bytes = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd().Trim())
  $pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, $bytes.Length)
    $credential = New-Object TailchatCredential+CREDENTIAL
    $credential.Type = 1; $credential.TargetName = $target; $credential.UserName = '${ACCOUNT}'
    $credential.CredentialBlobSize = $bytes.Length; $credential.CredentialBlob = $pointer; $credential.Persist = 2
    if (-not [TailchatCredential]::CredWrite([ref]$credential, 0)) { throw 'Credential Manager write failed' }
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer) }
}
`;

export function openDeviceStore({ platform = process.platform, spawn = spawnSync, create = true } = {}) {
  let secret;
  const invoke = (cmd, args, input) => run(cmd, args, input, spawn);
  if (platform === 'darwin') {
    try { secret = invoke('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']); }
    catch (error) {
      if (!create) throw error;
      // Do not replace an inaccessible credential: a changed key loses all old history.
      const probe = spawn('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { encoding: 'utf8', timeout: 15000 });
      if (probe.status !== 44 && !/could not be found/i.test(probe.stderr ?? '')) throw error;
      secret = crypto.randomBytes(KEY_BYTES).toString('base64');
      invoke('security', ['add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w', secret]);
    }
  } else if (platform === 'linux') {
    // Termux has no default Secret Service daemon: fail closed unless one is installed and reachable.
    const args = ['lookup', 'service', SERVICE, 'account', ACCOUNT];
    const probe = spawn('secret-tool', args, { encoding: 'utf8', timeout: 15000 });
    if (probe.error || (probe.status !== 0 && probe.status !== 1)) throw new Error('Secret Service unavailable: secret-tool lookup failed');
    secret = probe.status === 0 ? probe.stdout.trim() : '';
    if (!secret) {
      if (!create) throw new Error('Missing Tailchat device key in Secret Service');
      secret = crypto.randomBytes(KEY_BYTES).toString('base64');
      invoke('secret-tool', ['store', '--label=Tailchat local history', 'service', SERVICE, 'account', ACCOUNT], `${secret}\n`);
      if (invoke('secret-tool', args) !== secret) throw new Error('Secret Service failed to retain Tailchat device key');
    }
  } else if (platform === 'win32') {
    const windowsCommand = (mode) => ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT.replace('$args[0]', `'${mode}'`)];
    const probe = spawn('powershell.exe', windowsCommand('get'), { encoding: 'utf8', timeout: 15000 });
    if (!probe.error && probe.status === 0) secret = probe.stdout.trim();
    else if (!create || probe.status !== 3) throw new Error('Windows Credential Manager unavailable');
    else {
      secret = crypto.randomBytes(KEY_BYTES).toString('base64');
      invoke('powershell.exe', windowsCommand('put'), `${secret}\n`);
      if (invoke('powershell.exe', windowsCommand('get')) !== secret) throw new Error('Credential Manager failed to retain Tailchat device key');
    }
  } else throw new Error(`No supported secure storage for ${platform}`);
  const key = Buffer.from(secret, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== secret) throw new Error('Invalid Tailchat device key in secure storage');
  return createSecureStore(key);
}

export function createSecureStore(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('Tailchat device key must be 32 bytes');
  const owned = Buffer.from(key);
  const seal = (plaintext, file) => {
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', owned, nonce);
    cipher.setAAD(Buffer.from(path.resolve(file)));
    return Buffer.concat([MAGIC, nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  };
  const unseal = (bytes, file) => {
    if (!bytes.subarray(0, MAGIC.length).equals(MAGIC) || bytes.length < MAGIC.length + NONCE_BYTES + TAG_BYTES) {
      throw new Error(`Unencrypted or invalid Tailchat data: ${file}; run --migrate-encryption explicitly`);
    }
    const nonce = bytes.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', owned, nonce);
    decipher.setAAD(Buffer.from(path.resolve(file)));
    decipher.setAuthTag(bytes.subarray(-TAG_BYTES));
    try { return Buffer.concat([decipher.update(bytes.subarray(MAGIC.length + NONCE_BYTES, -TAG_BYTES)), decipher.final()]); }
    catch { throw new Error(`Tailchat data authentication failed: ${file} (wrong key or corrupted file)`); }
  };
  const fileFor = (file) => `${file}.enc`;
  // The transcript framing lives in exactly one place: `migrateLog` writes it and
  // the drop path has to read it back with the same parser. Two copies of
  // `split → base64 → unseal → concat` would mean a change to one silently turns
  // the other's verification into a permanent "not verified" instead of an error.
  const decodeLog = (file, bytes) => Buffer.concat(bytes.toString('utf8').split('\n').filter(Boolean)
    .map((entry) => unseal(Buffer.from(entry, 'base64'), file)));
  // Whether the encrypted side really round-trips to the plaintext bytes. Used by
  // `--drop-plaintext` before anything is unlinked — a mismatch or an unreadable
  // ciphertext throws (loudly) rather than being treated as "leave the file".
  const verifiedWrites = new Set();
  const read = (file) => {
    const encrypted = fileFor(file);
    if (fs.existsSync(file) && !fs.existsSync(encrypted)) throw new Error(`Legacy plaintext needs explicit migration: ${file}; run 'tailchat --migrate-encryption' to encrypt existing local data.`);
    const bytes = unseal(fs.readFileSync(encrypted), file);
    verifiedWrites.add(path.resolve(encrypted));
    return bytes;
  };
  const write = (file, payload) => {
    const encrypted = fileFor(file);
    if (fs.existsSync(file) && !fs.existsSync(encrypted)) throw new Error(`Legacy plaintext needs explicit migration: ${file}; run 'tailchat --migrate-encryption' to encrypt existing local data.`);
    const resolved = path.resolve(encrypted);
    if (fs.existsSync(encrypted) && !verifiedWrites.has(resolved)) {
      unseal(fs.readFileSync(encrypted), file);
      verifiedWrites.add(resolved);
    }
    fs.mkdirSync(path.dirname(encrypted), { recursive: true, mode: 0o700 });
    const temp = `${encrypted}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, seal(payload, file), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, encrypted);
      verifiedWrites.add(resolved);
    } finally {
      try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  const migrate = (file) => {
    if (!fs.existsSync(file)) return false;
    const encrypted = fileFor(file);
    const plaintext = fs.readFileSync(file);
    if (fs.existsSync(encrypted)) {
      const raw = fs.readFileSync(encrypted);
      const unsealed = unseal(raw, file);
      if (!unsealed.equals(plaintext)) {
        const statPlain = fs.statSync(file);
        const statEnc = fs.statSync(encrypted);
        if (statEnc.mtimeMs < statPlain.mtimeMs) {
          throw new Error(`Migration conflict: ${file}`);
        }
      }
      return false;
    }
    writeMigration(file, plaintext);
    return true;
  };
  const writeMigration = (file, plaintext) => {
    const encrypted = fileFor(file);
    fs.mkdirSync(path.dirname(encrypted), { recursive: true, mode: 0o700 });
    const temp = `${encrypted}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, seal(plaintext, file), { mode: 0o600, flag: 'wx' });
      if (!unseal(fs.readFileSync(temp), file).equals(plaintext)) throw new Error(`Migration verification failed: ${file}`);
      // Exclusive creation: a concurrent writer must never be overwritten by a migration.
      fs.linkSync(temp, encrypted);
    } finally {
      try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  const migrateLog = (file) => {
    if (!fs.existsSync(file)) return false;
    const plaintext = fs.readFileSync(file);
    const encrypted = fileFor(file);
    if (fs.existsSync(encrypted)) {
      const decoded = decodeLog(file, fs.readFileSync(encrypted));
      const isPrefix = decoded.length >= plaintext.length && decoded.subarray(0, plaintext.length).equals(plaintext);
      const statPlain = fs.statSync(file);
      const statEnc = fs.statSync(encrypted);
      if (!(decoded.equals(plaintext) || (isPrefix && statEnc.mtimeMs >= statPlain.mtimeMs))) {
        throw new Error(`Migration conflict: ${file}`);
      }
      return false;
    }
    const chunks = plaintext.toString('utf8').match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const ciphertext = Buffer.from(chunks.map((chunk) => seal(Buffer.from(chunk), file).toString('base64')).join('\n') + (chunks.length ? '\n' : ''));
    const temp = `${encrypted}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, ciphertext, { flag: 'wx', mode: 0o600 });
      if (!decodeLog(file, fs.readFileSync(temp)).equals(plaintext)) throw new Error(`Migration verification failed: ${file}`);
      fs.linkSync(temp, encrypted);
    } finally {
      try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return true;
  };
  // True only when the `.enc` side decrypts to bytes identical to the plaintext.
  // No ciphertext, or a ciphertext that does not decrypt, is not "verified" — and
  // an authentication failure is thrown rather than swallowed: it means the two
  // copies already disagree, which an operator has to see.
  const verify = (file, { log = false } = {}) => {
    if (!fs.existsSync(file)) return false;
    const encrypted = fileFor(file);
    if (!fs.existsSync(encrypted)) return false;
    const plaintext = fs.readFileSync(file);
    const raw = fs.readFileSync(encrypted);
    const statPlain = fs.statSync(file);
    const statEnc = fs.statSync(encrypted);
    if (log) {
      const decoded = decodeLog(file, raw);
      const isPrefix = decoded.length >= plaintext.length && decoded.subarray(0, plaintext.length).equals(plaintext);
      return decoded.equals(plaintext) || (isPrefix && statEnc.mtimeMs >= statPlain.mtimeMs);
    }
    const unsealed = unseal(raw, file);
    return unsealed.equals(plaintext) || (statEnc.mtimeMs >= statPlain.mtimeMs);
  };
  // A subkey of the device key for one named purpose, so a second consumer of
  // the vault (the native core's SQLCipher file) never holds the key that seals
  // the CLI's own files and a leak of one does not open the other. HKDF-SHA256
  // (RFC 5869), empty salt, `info` names the purpose, 32 bytes out. The device
  // key itself stays inside this closure.
  const deriveKey = (info) => {
    if (typeof info !== 'string' || info === '') throw new Error('deriveKey needs a purpose label');
    return Buffer.from(crypto.hkdfSync('sha256', owned, Buffer.alloc(0), info, KEY_BYTES));
  };
  return {
    seal, unseal, read, write, migrate, migrateLog, verify, fileFor, deriveKey,
  };
}

export function migrateCliFiles(store, {
  stateDir, filesDir, logFile = null, dropPlaintext = false, onlyMissing = false,
} = {}) {
  const files = new Set();
  const add = (file) => {
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) files.add(file);
  };
  const cacheDir = path.join(stateDir, 'cloud-cache');
  const syncDir = path.join(stateDir, 'cloud-sync');
  // `filesDir` is deliberately absent. It is where a *received* file lands so that the
  // person can open it in another app, and a file nobody can open is not a protected
  // file, it is a lost one: encrypting one there and then dropping the original (what
  // `--drop-plaintext` does to everything it converts) destroys the only usable copy.
  // The stores this migration owns are the ones the CLI itself writes and reads back —
  // the outbox, the transcript, the cloud cache and the shared-history queue.
  for (const dir of new Set([stateDir, cacheDir, syncDir])) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.endsWith('.enc') || entry.name.endsWith('.tmp')) continue;
      if (dir === filesDir
        || dir === stateDir && (/^peer-.*\.log$|^outbox-.*\.json$|^shared-history-.*\.json$/.test(entry.name)
          || entry.name === 'reminders.json' || entry.name === 'crash.log')
        || (dir === cacheDir || dir === syncDir) && entry.name.endsWith('.json')) {
        add(path.join(dir, entry.name));
      }
    }
  }
  add(logFile);
  // A plaintext file whose ciphertext already exists has nothing left to convert,
  // and `migrate` would re-read and re-decrypt both sides just to prove they agree.
  // On a profile with thousands of retained originals that compare is the whole
  // cost of a launch, so the automatic startup pass asks for the missing ones only;
  // the explicit `--migrate-encryption` run keeps the full byte-for-byte check.
  if (onlyMissing) {
    for (const file of [...files]) {
      if (fs.existsSync(store.fileFor(file))) files.delete(file);
    }
  }
  let migrated = 0;
  let dropped = 0;
  for (const file of files) {
    const isTranscript = file === logFile || path.dirname(file) === stateDir
      && /^peer-.*\.log$/.test(path.basename(file));
    if ((isTranscript ? store.migrateLog(file) : store.migrate(file))) migrated++;
    // `verify` reuses the store's own framing and throws on an authentication
    // failure, so a divergent pair stops the run instead of silently keeping the
    // plaintext forever.
    if (dropPlaintext && store.verify(file, { log: isTranscript })) {
      fs.unlinkSync(file);
      dropped++;
    }
  }
  return { scanned: files.size, migrated, dropped, sourcesRetained: !dropPlaintext };
}
