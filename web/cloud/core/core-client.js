// The page's half of the core driver (stage 7): the WebSocket, `fetch`, the
// timers and the ordered commits that `crates/tailchat-web/src/host.rs`
// expects of its host, and `openCore`, which builds a `WebClient` from what
// the storage holds. Plain ES module: the browser and the Node tests load the
// same file; nothing here touches the DOM.
//
// The notices are `tailchat_net::json`'s, exactly as the terminal's
// `src/cloud/core-link.js` receives them from the native driver.

const OPEN = 1;

/**
 * The host object a `WebClient` drives.
 *
 * @param {object} options
 * @param {{commit(entries: {key: string, value: string|null}[]): Promise<void>}} options.storage
 * @param {(notice: object) => void} options.onNotice
 * @param {typeof WebSocket} [options.WebSocketImpl]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.fetchTimeoutMs] the whole exchange, as the native driver's
 */
export function createHost({
  storage,
  onNotice,
  WebSocketImpl = globalThis.WebSocket,
  fetchImpl = globalThis.fetch,
  fetchTimeoutMs = 30_000,
}) {
  let client = null;
  let socket = null;
  // Commits run one after another, in call order; after one fails every
  // later one refuses, so the disk never holds a later batch without an
  // earlier one (the driver restarts from the disk then).
  let chain = Promise.resolve();
  let failed = false;

  // Forgets the current socket without reporting it.
  function detach() {
    const old = socket;
    socket = null;
    if (!old) return;
    old.onopen = null;
    old.onmessage = null;
    old.onclose = null;
    old.onerror = null;
    try {
      old.close();
    } catch {
      // Already gone; nothing to close.
    }
  }

  const host = {
    connect(url) {
      detach();
      let ws;
      try {
        ws = new WebSocketImpl(url);
      } catch {
        queueMicrotask(() => client?.socketClosed());
        return;
      }
      socket = ws;
      ws.onopen = () => {
        if (socket === ws) client?.socketOpen();
      };
      ws.onmessage = (event) => {
        if (socket === ws && typeof event.data === 'string') client?.socketText(event.data);
      };
      ws.onclose = () => {
        if (socket !== ws) return;
        socket = null;
        client?.socketClosed();
      };
      // `close` always follows `error`; that is where it is reported.
      ws.onerror = () => {};
    },
    send(text) {
      if (!socket || socket.readyState !== OPEN) return false;
      try {
        socket.send(text);
        return true;
      } catch {
        return false;
      }
    },
    close() {
      detach();
    },
    async fetch(method, url, token, body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
      try {
        const headers = { Authorization: `Bearer ${token}` };
        if (body != null) headers['Content-Type'] = 'application/json';
        const response = await fetchImpl(url, {
          method,
          headers,
          body: body ?? undefined,
          signal: controller.signal,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
        });
        return { status: response.status, body: await response.text() };
      } finally {
        clearTimeout(timer);
      }
    },
    commit(entries) {
      const next = chain.then(() => {
        if (failed) throw new Error('an earlier commit failed');
        return storage.commit(entries);
      });
      chain = next.catch(() => {
        failed = true;
      });
      return next;
    },
    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
    notice(value) {
      onNotice(value);
    },
  };

  return {
    host,
    bind(value) {
      client = value;
    },
  };
}

/**
 * Starts the core for one account.
 *
 * @param {object} options
 * @param {object} options.wasm the initialised `pkg/tailchat_web.js` module
 * @param {{login: string, token: string, socketUrl: string, httpBase: string, e2ee?: boolean, extraCaps?: string[]}} options.account
 * @param {{load(): Promise<string[]>, commit(entries): Promise<void>}} options.storage
 * @param {(notice: object) => void} options.onNotice
 * @returns {Promise<object>} the running `WebClient`; `stop()` ends it
 */
export async function openCore({ wasm, account, storage, onNotice, ...hostOptions }) {
  const records = await storage.load();
  const { host, bind } = createHost({ storage, onNotice, ...hostOptions });
  const client = new wasm.WebClient(account, records, host);
  // The driver's first poll (and its first `connect`) runs on a later
  // microtask, so the client is bound before any socket can report.
  bind(client);
  return client;
}

/** A storage that keeps the records in memory: for tests, and nothing else. */
export function memoryStorage(initial = new Map()) {
  const records = new Map(initial);
  return {
    records,
    async load() {
      return [...records.values()];
    },
    async commit(entries) {
      for (const { key, value } of entries) {
        if (value === null) records.delete(key);
        else records.set(key, value);
      }
    },
  };
}
