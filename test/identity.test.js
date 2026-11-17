import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  generateEd25519KeyPair,
  generateIdentity,
  loadOrCreateIdentity,
  createChallenge,
  signData,
  verifyData,
  signCertificate,
  verifyCertificate,
  saveCertificate,
  loadCertificate,
  createKnownPeersStore,
  canonicalJson,
} from '../src/identity.js';

test('canonicalJson produces deterministic sorted key JSON', () => {
  const a = { b: 2, a: 1, c: { y: 20, x: 10 } };
  const b = { c: { x: 10, y: 20 }, a: 1, b: 2 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":1,"b":2,"c":{"x":10,"y":20}}');
});

test('generateIdentity creates valid Ed25519 identity', () => {
  const id = generateIdentity({ login: 'Alice', name: 'Alice Smith' });
  assert.equal(id.login, 'alice');
  assert.equal(id.name, 'Alice Smith');
  assert.ok(typeof id.pubKey === 'string' && id.pubKey.length > 32);
  assert.ok(typeof id.privKey === 'string' && id.privKey.includes('BEGIN PRIVATE KEY'));
});

test('signData and verifyData with Ed25519 keypair', () => {
  const { pubKey, privKey } = generateEd25519KeyPair();
  const data = { message: 'hello world', count: 42 };
  const sig = signData(privKey, data);
  assert.ok(typeof sig === 'string' && sig.length > 0);

  assert.equal(verifyData(pubKey, data, sig), true);
  assert.equal(verifyData(pubKey, { ...data, count: 43 }, sig), false);
  assert.equal(verifyData('badkey', data, sig), false);
});

test('loadOrCreateIdentity loads existing identity and creates new if missing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ident-test-'));
  try {
    const id1 = loadOrCreateIdentity(tmpDir, { login: 'bob', name: 'Bob' });
    assert.equal(id1.login, 'bob');
    assert.ok(id1.pubKey);

    const id2 = loadOrCreateIdentity(tmpDir, { login: 'bob' });
    assert.equal(id2.pubKey, id1.pubKey);
    assert.equal(id2.privKey, id1.privKey);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('signCertificate and verifyCertificate with server key', () => {
  const serverKeys = generateEd25519KeyPair();
  const userKeys = generateEd25519KeyPair();

  const certBundle = signCertificate(serverKeys.privKey, {
    login: 'carol',
    name: 'Carol Danvers',
    pubKey: userKeys.pubKey,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 100_000,
  });

  assert.equal(verifyCertificate(certBundle, serverKeys.pubKey), true);

  // Expired certificate
  const expiredBundle = signCertificate(serverKeys.privKey, {
    login: 'carol',
    name: 'Carol Danvers',
    pubKey: userKeys.pubKey,
    issuedAt: Date.now() - 200_000,
    expiresAt: Date.now() - 100_000,
  });
  assert.equal(verifyCertificate(expiredBundle, serverKeys.pubKey), false);

  // Tampered certificate
  const tamperedBundle = {
    cert: { ...certBundle.cert, login: 'eve' },
    signature: certBundle.signature,
  };
  assert.equal(verifyCertificate(tamperedBundle, serverKeys.pubKey), false);
});

test('saveCertificate and loadCertificate cache to disk', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cert-test-'));
  try {
    const serverKeys = generateEd25519KeyPair();
    const certBundle = signCertificate(serverKeys.privKey, {
      login: 'david',
      name: 'David',
      pubKey: '0123456789abcdef',
    });

    assert.equal(saveCertificate(tmpDir, certBundle), true);
    const loaded = loadCertificate(tmpDir);
    assert.ok(loaded);
    assert.equal(loaded.cert.login, 'david');
    assert.equal(loaded.signature, certBundle.signature);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createKnownPeersStore handles TOFU and detects key mismatches', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tofu-test-'));
  try {
    const store = createKnownPeersStore({ stateDir: tmpDir });

    // 1. First time seeing alice -> TOFU new
    const r1 = store.evaluatePeer({ login: 'alice', pubKey: 'key-alice-v1', name: 'Alice' });
    assert.equal(r1.status, 'new');
    assert.equal(r1.trusted, true);
    assert.equal(r1.kind, 'tofu_new');

    // 2. Second time seeing alice with same key -> TOFU known
    const r2 = store.evaluatePeer({ login: 'alice', pubKey: 'key-alice-v1' });
    assert.equal(r2.status, 'trusted');
    assert.equal(r2.trusted, true);
    assert.equal(r2.kind, 'tofu_known');

    // 3. Third time seeing alice with DIFFERENT key without cloud cert -> mismatch!
    const r3 = store.evaluatePeer({ login: 'alice', pubKey: 'key-alice-fake' });
    assert.equal(r3.status, 'mismatch');
    assert.equal(r3.trusted, false);

    // 4. Seeing alice with DIFFERENT key with Cloud verified cert -> renewed!
    const r4 = store.evaluatePeer({ login: 'alice', pubKey: 'key-alice-v2', verifiedByCloud: true });
    assert.equal(r4.status, 'trusted');
    assert.equal(r4.trusted, true);
    assert.equal(r4.kind, 'cloud_renewed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
