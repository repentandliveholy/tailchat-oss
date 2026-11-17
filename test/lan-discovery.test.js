import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateBroadcastAddress,
  getLocalBroadcastAddresses,
  createLanDiscovery,
} from '../src/lan-discovery.js';
import { generateEd25519KeyPair, signCertificate } from '../src/identity.js';

test('calculateBroadcastAddress computes correct subnet broadcast', () => {
  assert.equal(calculateBroadcastAddress('192.168.1.105', '255.255.255.0'), '192.168.1.255');
  assert.equal(calculateBroadcastAddress('10.0.0.50', '255.0.0.0'), '10.255.255.255');
  assert.equal(calculateBroadcastAddress('172.16.4.12', '255.255.0.0'), '172.16.255.255');
  assert.equal(calculateBroadcastAddress('invalid', 'mask'), null);
});

test('getLocalBroadcastAddresses returns at least 255.255.255.255', () => {
  const addrs = getLocalBroadcastAddresses();
  assert.ok(Array.isArray(addrs));
  assert.ok(addrs.includes('255.255.255.255'));
});

test('createLanDiscovery announces and discovers peer', async () => {
  const TEST_PORT = 49152 + Math.floor(Math.random() * 1000);

  const serverKeys = generateEd25519KeyPair();
  const aliceIdentity = generateEd25519KeyPair();
  const aliceCert = signCertificate(serverKeys.privKey, {
    login: 'alice',
    name: 'Alice Wonder',
    pubKey: aliceIdentity.pubKey,
  });

  const nodeAlice = createLanDiscovery({
    port: TEST_PORT,
    tcpPort: 4747,
    name: 'Alice-Laptop',
    login: 'alice',
    identity: aliceIdentity,
    cert: aliceCert,
    serverVerifyKey: serverKeys.pubKey,
    beaconIntervalMs: 50,
    peerTtlMs: 200,
  });

  const bobIdentity = generateEd25519KeyPair();
  const nodeBob = createLanDiscovery({
    port: TEST_PORT,
    tcpPort: 4747,
    name: 'Bob-MacBook',
    login: 'bob',
    identity: bobIdentity,
    serverVerifyKey: serverKeys.pubKey,
    beaconIntervalMs: 50,
    peerTtlMs: 200,
  });

  try {
    await nodeAlice.start();
    await nodeBob.start();

    // Wait for discovery
    const discoveredPeer = await new Promise((resolve) => {
      nodeBob.once('peer', (p) => resolve(p));
      nodeAlice.announceNow();
      setTimeout(() => resolve(null), 1000);
    });

    assert.ok(discoveredPeer, 'Bob should discover Alice');
    assert.equal(discoveredPeer.login, 'alice');
    assert.equal(discoveredPeer.name, 'Alice-Laptop');
    assert.equal(discoveredPeer.verified, true);

    const peers = nodeBob.getPeers();
    assert.ok(peers.length >= 1);
    assert.equal(nodeBob.findPeerByLogin('alice')?.login, 'alice');
  } finally {
    await nodeAlice.stop();
    await nodeBob.stop();
  }
});
