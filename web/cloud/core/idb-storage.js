// The core's store on disk in the browser (stage 7): one IndexedDB database
// per account, every record encrypted with a device key that cannot leave the
// browser.
//
// - The device key is a WebCrypto AES-GCM-256 key created with
//   `extractable: false` and kept in the database itself (structured clone
//   keeps the CryptoKey, never its bytes). Page script can use it but no API
//   hands its bytes out: a copy of the profile's files, a backup or a sync
//   carries ciphertext the copy cannot open without the browser's own key
//   store — the same bargain as SQLCipher with its key in the Keychain.
// - Record keys are HMAC-SHA-256 of the core's key (a second non-extractable
//   key), so not even who you talk to or a message id is readable at rest.
//   The record's own key is inside the ciphertext and is the AES-GCM
//   additional data, so a record moved under another key does not open.
// - A commit is one `readwrite` transaction with `durability: 'strict'`, and
//   resolves on `complete`. All the crypto is done before the transaction
//   opens: a transaction that waits on anything but its own requests commits
//   itself early.

const VERSION = 1;
const RECORDS = 'records';
const KEYS = 'keys';
const DEVICE = 'device';

/** The database name for one account. */
export function databaseName(login) {
  return `tailchat-core:${login}`;
}

function promised(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted'));
  });
}

function open(indexedDB, name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS);
      if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('the store is held open by another version of the page'));
  });
}

async function deviceKeys(db, subtle) {
  const read = db.transaction(KEYS, 'readonly');
  const existing = await promised(read.objectStore(KEYS).get(DEVICE));
  if (existing?.aes && existing?.hmac) return existing;
  const keys = {
    aes: await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    hmac: await subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
  };
  const write = db.transaction(KEYS, 'readwrite', { durability: 'strict' });
  // `add`, not `put`: a second tab creating keys at the same moment loses,
  // and reads the winner's instead of overwriting them.
  write.objectStore(KEYS).add(keys, DEVICE);
  try {
    await finished(write);
    return keys;
  } catch {
    const again = await promised(db.transaction(KEYS, 'readonly').objectStore(KEYS).get(DEVICE));
    if (again?.aes && again?.hmac) return again;
    throw new Error('could not create the device key');
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Opens (or creates) the store of `login`.
 *
 * @returns {Promise<{load(): Promise<string[]>, commit(entries): Promise<void>, close(): void}>}
 */
export async function openIdbStorage(login, {
  indexedDB = globalThis.indexedDB,
  crypto = globalThis.crypto,
} = {}) {
  if (!indexedDB || !crypto?.subtle) throw new Error('this browser has no IndexedDB or WebCrypto');
  const { subtle } = crypto;
  const db = await open(indexedDB, databaseName(login));
  const keys = await deviceKeys(db, subtle);

  async function idbKey(key) {
    return hex(await subtle.sign('HMAC', keys.hmac, encoder.encode(key)));
  }

  async function seal(key, value) {
    const id = await idbKey(key);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = encoder.encode(JSON.stringify({ k: key, v: value }));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(id) }, keys.aes, plain);
    return { id, record: { iv, ct } };
  }

  async function unseal(id, record) {
    const plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(id) },
      keys.aes,
      record.ct,
    );
    return JSON.parse(decoder.decode(plain));
  }

  return {
    async load() {
      const read = db.transaction(RECORDS, 'readonly');
      const store = read.objectStore(RECORDS);
      const [ids, records] = await Promise.all([promised(store.getAllKeys()), promised(store.getAll())]);
      const values = [];
      for (let i = 0; i < ids.length; i += 1) {
        const { v } = await unseal(ids[i], records[i]);
        values.push(v);
      }
      return values;
    },
    async commit(entries) {
      const writes = await Promise.all(entries.map(async ({ key, value }) => (
        value === null ? { id: await idbKey(key), record: null } : seal(key, value)
      )));
      const transaction = db.transaction(RECORDS, 'readwrite', { durability: 'strict' });
      const store = transaction.objectStore(RECORDS);
      for (const { id, record } of writes) {
        if (record === null) store.delete(id);
        else store.put(record, id);
      }
      await finished(transaction);
    },
    close() {
      db.close();
    },
  };
}

/** Deletes the store of `login` (sign-out on this device). */
export function deleteIdbStorage(login, { indexedDB = globalThis.indexedDB } = {}) {
  return promised(indexedDB.deleteDatabase(databaseName(login)));
}
