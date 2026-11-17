import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// EXPERIMENT ONLY. Not reviewed cryptography; never use for real secrets.
// This is a deterministic block permutation, NOT authenticated encryption.
// There is no message mode, nonce, padding or wrong-key/tamper detection.
// Do not encrypt a message by processing its blocks independently (ECB).
// "256" names the block size, not a demonstrated security level.
export const BLOCK_BYTES = 32;
export const KEY_BYTES = 32;
export const ROUNDS = 8;
const HALF_BYTES = BLOCK_BYTES / 2;
const KEY_DOMAIN = Buffer.from('TailFeistel-256/experimental-v1/key\0', 'ascii');
const ROUND_DOMAIN = Buffer.from('TailFeistel-256/experimental-v1/round\0', 'ascii');

function requireBytes(value, size, name) {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${name} must be a Uint8Array or Buffer`);
  if (value.byteLength !== size) throw new RangeError(`${name} must contain exactly ${size} bytes`);
}

// K_i = HMAC-SHA-256(key, KEY_DOMAIN || uint8(i)), i = 0..7.
// F_i(R) = first 16 bytes of HMAC-SHA-256(K_i, ROUND_DOMAIN || R).
// Encrypt: (L, R) -> (R, L XOR F_i(R)). Decrypt reverses the rounds.
export function createTailFeistel(key) {
  requireBytes(key, KEY_BYTES, 'key');
  const ownedKey = Buffer.from(key);
  const roundKeys = [];
  try {
    for (let round = 0; round < ROUNDS; round += 1) {
      roundKeys.push(createHmac('sha256', ownedKey)
        .update(KEY_DOMAIN).update(Buffer.from([round])).digest());
    }
  } finally {
    ownedKey.fill(0);
  }
  let destroyed = false;

  function transform(block, decrypt) {
    if (destroyed) throw new Error('Cipher has been destroyed');
    requireBytes(block, BLOCK_BYTES, 'block');
    const state = Buffer.from(block);
    const scratch = Buffer.allocUnsafe(HALF_BYTES);
    let left = state.subarray(0, HALF_BYTES);
    let right = state.subarray(HALF_BYTES);
    let spare = scratch;
    try {
      for (let step = 0; step < ROUNDS; step += 1) {
        const round = decrypt ? ROUNDS - 1 - step : step;
        const mask = createHmac('sha256', roundKeys[round])
          .update(ROUND_DOMAIN).update(decrypt ? left : right).digest();
        const source = decrypt ? right : left;
        for (let byte = 0; byte < HALF_BYTES; byte += 1) {
          spare[byte] = source[byte] ^ mask[byte];
        }
        mask.fill(0);
        const next = spare;
        if (decrypt) {
          spare = right;
          right = left;
          left = next;
        } else {
          spare = left;
          left = right;
          right = next;
        }
      }
      const result = Buffer.allocUnsafe(BLOCK_BYTES);
      left.copy(result, 0);
      right.copy(result, HALF_BYTES);
      return result;
    } finally {
      state.fill(0);
      scratch.fill(0);
    }
  }

  return Object.freeze({
    encryptBlock: (block) => transform(block, false),
    decryptBlock: (block) => transform(block, true),
    // Best-effort buffer wiping, not a guarantee about GC/OpenSSL copies.
    destroy() {
      for (const key of roundKeys) key.fill(0);
      destroyed = true;
    },
  });
}

// Standalone demonstration; importing the module has no I/O side effects.
// These are PUBLIC TEST VALUES, not a key or plaintext to use in an app.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
  const plaintext = Buffer.from('202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f', 'hex');
  const cipher = createTailFeistel(key);
  try {
    const ciphertext = cipher.encryptBlock(plaintext);
    const recovered = cipher.decryptBlock(ciphertext);
    if (!recovered.equals(plaintext)) throw new Error('Demo round-trip failed');
    console.error('EXPERIMENTAL: unreviewed block cipher; no authentication; public demo key.');
    console.log(JSON.stringify({
      algorithm: 'TailFeistel-256/experimental-v1',
      key: key.toString('hex'),
      plaintext: plaintext.toString('hex'),
      ciphertext: ciphertext.toString('hex'),
      recovered: recovered.toString('hex'),
    }, null, 2));
  } finally {
    cipher.destroy();
    key.fill(0);
  }
}
