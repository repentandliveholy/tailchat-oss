import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTailFeistel } from '../experiments/tail-feistel.js';

// Computed independently with Python hmac.digest and a tuple-based Feistel
// implementation, not by the JavaScript under test. These check the specified
// permutation, not cryptographic strength or message authentication.
const vectors = [
  {
    name: 'zero',
    key: '0000000000000000000000000000000000000000000000000000000000000000',
    plaintext: '0000000000000000000000000000000000000000000000000000000000000000',
    ciphertext: '563b591af22cc0429b9f9868657d8f9c278b34b6cbfcc6f08c93684534535cee',
  },
  {
    name: 'ascending',
    key: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    plaintext: '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f',
    ciphertext: 'aa3739977f44ba451416e9d569e1e63e9d64c1fb589721c82ce27d6dbb1d0cf9',
  },
];

for (const vector of vectors) {
  test(`TailFeistel matches independent ${vector.name} encryption and decryption vectors`, (t) => {
    const cipher = createTailFeistel(Buffer.from(vector.key, 'hex'));
    t.after(() => cipher.destroy());
    assert.equal(cipher.encryptBlock(Buffer.from(vector.plaintext, 'hex')).toString('hex'), vector.ciphertext);
    assert.equal(cipher.decryptBlock(Buffer.from(vector.ciphertext, 'hex')).toString('hex'), vector.plaintext);
  });
}

test('TailFeistel rejects ambiguous input types and non-block sizes', (t) => {
  assert.throws(() => createTailFeistel('0'.repeat(32)), TypeError);
  for (const size of [0, 31, 33]) {
    assert.throws(() => createTailFeistel(new Uint8Array(size)), RangeError);
  }
  const cipher = createTailFeistel(new Uint8Array(32));
  t.after(() => cipher.destroy());
  for (const operation of [cipher.encryptBlock, cipher.decryptBlock]) {
    assert.throws(() => operation('0'.repeat(32)), TypeError);
    for (const size of [0, 31, 33]) {
      assert.throws(() => operation(new Uint8Array(size)), RangeError);
    }
  }
});

test('TailFeistel respects byte offsets of key and block views', (t) => {
  const vector = vectors[1];
  const keyStorage = new Uint8Array(42).fill(0xff);
  const blockStorage = new Uint8Array(48).fill(0xff);
  keyStorage.set(Buffer.from(vector.key, 'hex'), 5);
  blockStorage.set(Buffer.from(vector.plaintext, 'hex'), 7);
  const cipher = createTailFeistel(keyStorage.subarray(5, 37));
  t.after(() => cipher.destroy());
  assert.equal(cipher.encryptBlock(blockStorage.subarray(7, 39)).toString('hex'), vector.ciphertext);
  blockStorage.set(Buffer.from(vector.ciphertext, 'hex'), 7);
  assert.equal(cipher.decryptBlock(blockStorage.subarray(7, 39)).toString('hex'), vector.plaintext);
});

test('a destroyed TailFeistel instance cannot keep encrypting or decrypting', () => {
  const cipher = createTailFeistel(new Uint8Array(32));
  cipher.destroy();
  cipher.destroy();
  assert.throws(() => cipher.encryptBlock(new Uint8Array(32)), Error);
  assert.throws(() => cipher.decryptBlock(new Uint8Array(32)), Error);
});
