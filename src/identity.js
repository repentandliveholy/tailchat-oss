import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const IDENTITY_FILE = 'identity.json';
const CERT_FILE = 'cert.json';
const KNOWN_PEERS_FILE = 'known_peers.json';

// Default OVH server public key for offline certificate verification (SPKI DER Hex)
// Will be dynamically populated/updated upon connecting to server or reading certs.
export let DEFAULT_SERVER_VERIFY_KEY = null;

export function setServerVerifyKey(pubKeyDerHex) {
  if (typeof pubKeyDerHex === 'string' && pubKeyDerHex.length > 0) {
    DEFAULT_SERVER_VERIFY_KEY = pubKeyDerHex;
  }
}

export function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  return `{${pairs.join(',')}}`;
}

export function generateEd25519KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    pubKey: publicKey.toString('hex'),
    privKey: privateKey,
  };
}

export function generateIdentity({ login = '', name = '' } = {}) {
  const { pubKey, privKey } = generateEd25519KeyPair();
  return {
    login: String(login ?? '').trim().toLowerCase(),
    name: String(name ?? '').trim(),
    pubKey,
    privKey,
    createdAt: Date.now(),
  };
}

export function loadOrCreateIdentity(stateDir, { login = '', name = '' } = {}) {
  if (!stateDir || typeof stateDir !== 'string') {
    throw new TypeError('loadOrCreateIdentity requires stateDir');
  }
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  } catch {}

  const file = path.join(stateDir, IDENTITY_FILE);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.pubKey === 'string' && typeof parsed.privKey === 'string') {
      if (login && (!parsed.login || parsed.login !== login)) {
        parsed.login = String(login).trim().toLowerCase();
        try {
          fs.writeFileSync(file, JSON.stringify(parsed, null, 2), { mode: 0o600 });
        } catch {}
      }
      return parsed;
    }
  } catch {
    // missing or corrupted, generate fresh identity
  }

  const identity = generateIdentity({ login, name });
  try {
    fs.writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 });
  } catch {}
  return identity;
}

export function createChallenge() {
  return crypto.randomBytes(32).toString('hex');
}

export function signData(privKeyPem, data) {
  const payload = Buffer.from(typeof data === 'string' ? data : canonicalJson(data), 'utf8');
  const signature = crypto.sign(null, payload, privKeyPem);
  return signature.toString('hex');
}

export function verifyData(pubKeyDerHex, data, signatureHex) {
  try {
    if (!pubKeyDerHex || !data || !signatureHex) return false;
    const pubKey = crypto.createPublicKey({
      key: Buffer.from(pubKeyDerHex, 'hex'),
      format: 'der',
      type: 'spki',
    });
    const payload = Buffer.from(typeof data === 'string' ? data : canonicalJson(data), 'utf8');
    return crypto.verify(null, payload, pubKey, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

export function signCertificate(serverPrivKeyPem, certData) {
  const cert = {
    login: String(certData.login ?? '').trim().toLowerCase(),
    name: String(certData.name ?? '').trim(),
    pubKey: String(certData.pubKey ?? '').trim(),
    issuedAt: Number(certData.issuedAt ?? Date.now()),
    expiresAt: Number(certData.expiresAt ?? (Date.now() + 365 * 24 * 60 * 60 * 1000)),
  };
  const signature = signData(serverPrivKeyPem, cert);
  return {
    cert,
    signature,
  };
}

export function verifyCertificate(certBundle, serverPubKeyDerHex = DEFAULT_SERVER_VERIFY_KEY, now = Date.now()) {
  if (!certBundle || typeof certBundle !== 'object') return false;
  const { cert, signature } = certBundle;
  if (!cert || !signature || typeof signature !== 'string') return false;
  if (!serverPubKeyDerHex) return false;

  // Check expiration if set
  if (cert.expiresAt && Number.isFinite(cert.expiresAt) && cert.expiresAt < now) {
    return false;
  }
  return verifyData(serverPubKeyDerHex, cert, signature);
}

export function saveCertificate(stateDir, certBundle) {
  if (!stateDir || !certBundle) return false;
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const file = path.join(stateDir, CERT_FILE);
    fs.writeFileSync(file, JSON.stringify(certBundle, null, 2), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function loadCertificate(stateDir) {
  if (!stateDir) return null;
  const file = path.join(stateDir, CERT_FILE);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.cert && parsed?.signature) return parsed;
  } catch {}
  return null;
}

export function createKnownPeersStore({ stateDir, now = Date.now } = {}) {
  if (!stateDir || typeof stateDir !== 'string') {
    throw new TypeError('createKnownPeersStore requires stateDir');
  }
  const file = path.join(stateDir, KNOWN_PEERS_FILE);

  let state = Object.create(null);

  function load() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        state = Object.assign(Object.create(null), parsed);
      }
    } catch {
      state = Object.create(null);
    }
  }

  function save() {
    try {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch {}
  }

  load();

  return {
    get(peerId) {
      const key = String(peerId ?? '').trim().toLowerCase();
      return state[key] ?? null;
    },
    list() {
      return Object.values(state);
    },
    evaluatePeer({ login, pubKey, name = '', verifiedByCloud = false }) {
      const key = String(login ?? '').trim().toLowerCase();
      if (!key || !pubKey) {
        return { status: 'invalid', trusted: false, error: 'missing_fields' };
      }

      const existing = state[key];
      const at = now();

      if (!existing) {
        state[key] = {
          login: key,
          name: name || key,
          pubKey,
          firstSeen: at,
          lastSeen: at,
          verifiedByCloud: Boolean(verifiedByCloud),
        };
        save();
        return {
          status: 'new',
          trusted: true,
          kind: verifiedByCloud ? 'cloud_verified' : 'tofu_new',
        };
      }

      if (existing.pubKey === pubKey) {
        existing.lastSeen = at;
        if (name && (!existing.name || existing.name === key)) existing.name = name;
        if (verifiedByCloud && !existing.verifiedByCloud) existing.verifiedByCloud = true;
        save();
        return {
          status: 'trusted',
          trusted: true,
          kind: existing.verifiedByCloud ? 'cloud_verified' : 'tofu_known',
        };
      }

      // Key mismatch
      if (verifiedByCloud) {
        // A valid cloud certificate can renew a key with server proof
        existing.pubKey = pubKey;
        existing.lastSeen = at;
        existing.verifiedByCloud = true;
        if (name) existing.name = name;
        save();
        return {
          status: 'trusted',
          trusted: true,
          kind: 'cloud_renewed',
        };
      }

      return {
        status: 'mismatch',
        trusted: false,
        kind: 'mismatch',
        error: 'Key mismatch: peer public key changed without cloud certificate proof',
      };
    },
  };
}
