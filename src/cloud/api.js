import { cloudApiUrl } from './config.js';

// Every call has a deadline. A cloud server behind a stalled proxy answers
// nothing and never closes the socket, and without a deadline the client would
// hang before the screen it is supposed to show even exists.
const TIMEOUT_MS = 8000;
// An attachment download is judged by progress instead (see `media`).
const MEDIA_STALL_MS = 30_000;

// A failure carries the server's own code (`bad_credentials`, `login_taken`, …)
// so the caller can print one sentence instead of parsing prose. A network
// failure gets `unreachable`, which is the difference between "your password is
// wrong" and "the server is not there" — the two answers a person confuses.
export class CloudApiError extends Error {
  constructor(code, { status = 0, message = code } = {}) {
    super(message);
    this.name = 'CloudApiError';
    this.code = code;
    this.status = status;
  }
}

export function createCloudApi({
  server,
  token = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  if (!server) throw new Error('cloud api needs a server');
  let bearer = token;

  async function call(method, path, { body = null, auth = true } = {}) {
    const headers = {};
    if (body !== null) headers['content-type'] = 'application/json';
    if (auth && bearer) headers.authorization = `Bearer ${bearer}`;
    let response;
    try {
      response = await fetchImpl(cloudApiUrl(server, path), {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new CloudApiError('unreachable', { message: error?.message ?? 'network failure' });
    }
    if (response.status === 204) return null;
    // A proxy in front of the server answers with HTML on its own errors, so a
    // parse failure is reported as the transport fault it is rather than as a
    // mysterious `undefined` two frames later.
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new CloudApiError(payload?.error ?? 'server_error', {
        status: response.status,
        message: payload?.message ?? `HTTP ${response.status}`,
      });
    }
    return payload;
  }

  return {
    // Where this api points. Exposed because a link a person is meant to paste
    // somewhere is built from the server it is valid on (`/invite create`), and
    // a client that re-derives the address from its own config can disagree
    // with the connection that actually minted the code.
    server,
    token: () => bearer,
    setToken(value) { bearer = value ?? null; },
    async register({ login, password, name, pubKey }) {
      const out = await call('POST', '/register', { body: { login, password, name, pubKey }, auth: false });
      bearer = out.token;
      return out;
    },
    async login({ login, password, pubKey, extraPassword }) {
      const out = await call('POST', '/login', { body: { login, password, pubKey, extraPassword }, auth: false });
      bearer = out.token;
      return out;
    },
    async recover({ login, recoveryKey, newPassword }) {
      const out = await call('POST', '/recover', { body: { login, recoveryKey, newPassword }, auth: false });
      bearer = out.token;
      return out;
    },
    async logout() {
      await call('POST', '/logout');
      bearer = null;
    },
    async me() {
      const out = await call('GET', '/me');
      return out.user;
    },
    async users() {
      const out = await call('GET', '/users');
      return Array.isArray(out.users) ? out.users : [];
    },
    // The nickname this account shows for one of its contacts (issue #28).
    // Private and asymmetric: the peer is never told. `name` is free text —
    // the server normalises it, so whatever the person typed goes as typed and
    // an empty string clears the nickname. Returns the stored alias, which may
    // differ from `name` after the server's own cleaning.
    async setAlias(peer, name) {
      const out = await call('POST', '/alias', { body: { login: peer, name } });
      return typeof out?.alias === 'string' ? out.alias : '';
    },
    // `media: 'ref'` asks for pictures and voice notes as `{mime, size, …}`
    // references instead of inline bytes; `media()` below fetches them. A
    // server older than that ignores the parameter and answers inline, which
    // every caller still reads.
    async history(peer, limit = 200, { includeDeleted = false, media = null } = {}) {
      const deleted = includeDeleted ? '&deleted=1' : '';
      const refs = media === 'ref' ? '&media=ref' : '';
      const out = await call('GET', `/history?peer=${encodeURIComponent(peer)}&limit=${limit}${deleted}${refs}`);
      // A 204 or an unparsable body is `null`: an empty page, not a TypeError.
      // An edit carrier (`sealedEdit`) is the server's envelope for an edit this
      // client cannot read: it is never a message, so no caller gets it as one.
      return Array.isArray(out?.messages) ? out.messages.filter((m) => m?.sealedEdit !== true) : [];
    },
    // The bytes of one attachment, `{mime, bytes}`. Not under the 8-second
    // deadline of every other call: a 7 MiB voice note over a phone link may
    // take a minute, and that is fine while bytes keep coming. What fails it
    // is `stallMs` with no progress at all.
    async media({ peer, id, slot }, { stallMs = MEDIA_STALL_MS } = {}) {
      const query = new URLSearchParams({ peer, id, slot });
      const controller = new AbortController();
      let timer = null;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), stallMs);
        timer.unref?.();
      };
      arm();
      try {
        let response;
        try {
          response = await fetchImpl(cloudApiUrl(server, `/media?${query.toString()}`), {
            method: 'GET',
            headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
            signal: controller.signal,
          });
        } catch (error) {
          throw new CloudApiError('unreachable', { message: error?.message ?? 'network failure' });
        }
        if (!response.ok) {
          let payload = null;
          try { payload = await response.json(); } catch { payload = null; }
          throw new CloudApiError(payload?.error ?? 'server_error', {
            status: response.status,
            message: payload?.message ?? `HTTP ${response.status}`,
          });
        }
        const mime = response.headers?.get?.('content-type') || 'application/octet-stream';
        const chunks = [];
        try {
          if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
            for await (const chunk of response.body) {
              chunks.push(Buffer.from(chunk));
              arm();
            }
          } else {
            chunks.push(Buffer.from(await response.arrayBuffer()));
          }
        } catch (error) {
          throw new CloudApiError('unreachable', { message: error?.message ?? 'download interrupted' });
        }
        return { mime, bytes: Buffer.concat(chunks) };
      } finally {
        clearTimeout(timer);
      }
    },
    // The devices (and their public keys) the server lists for these accounts:
    // yourself and your friends only, the rest are left out of the answer. The
    // native terminal needs it for /verify, which names a device to start with.
    async e2eeKeysQuery(logins) {
      const out = await call('POST', '/e2ee/keys/query', { body: { logins } });
      return out?.users && typeof out.users === 'object' ? out.users : {};
    },
    // The link belongs to the account named in `login` — whoever accepts it
    // becomes that account's friend, not the caller's. Only the deployment
    // owner is allowed to name somebody else; the server answers `forbidden`
    // (403) for everyone else and refuses the two official contacts with
    // `official_invite`.
    //
    // Without a login the request carries no body at all, not `{}`: a server
    // older than this feature reads exactly that as "my own link", and the two
    // clients have to keep agreeing on that one request.
    async createInvite(login = null) {
      const wanted = String(login ?? '').trim();
      const out = await call('POST', '/invite', wanted ? { body: { login: wanted } } : {});
      return out.invite;
    },
    async acceptInvite(invite) {
      const out = await call('POST', '/invite/accept', { body: { invite } });
      return out.friend;
    },
    // A request by @username: the address a person already has for somebody,
    // with no code to pass around first. The answer says which of the two
    // things happened — the request is waiting for the addressee to answer it
    // (`requested`), or the contact is in the roster already and there was
    // nothing to wait for (`friends`, with the contact itself).
    async requestFriend(login) {
      const out = await call('POST', '/friend/request', { body: { login } });
      return { state: out?.state ?? 'requested', friend: out?.friend ?? null };
    },
    async block(login) {
      const out = await call('POST', '/block', { body: { login } });
      return out.blocked;
    },
    // One-sided and permanent: the contact and this account's whole side of the
    // conversation go, on every device this account runs on — the other person
    // keeps both, and is never told (see `removeContact` in
    // src/cloud/accounts.js).
    async removeContact(login) {
      const out = await call('POST', '/contact/remove', { body: { login } });
      return out.ok;
    },
    async unblock(login) {
      const out = await call('POST', '/unblock', { body: { login } });
      return out.blocked;
    },
  };
}
