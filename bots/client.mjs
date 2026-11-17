// A Tailchat cloud client for a long-running bot process.
//
// One socket per conversation, and that is a property of the server, not a
// choice made here: a frame is handed to a connection only while that
// connection is subscribed to the sender (`target.peer !== fromLogin` skips it,
// src/cloud/hub.js:768), and `subscribe` replaces the single peer a connection
// is watching. A client that wants to see several conversations at once — which
// is what a service is — therefore holds one socket per peer. A person's client
// never notices: it watches one thread at a time and gets unread badges for the
// rest.
//
// No dependencies: Node 22+ has global WebSocket and fetch.

import crypto from 'node:crypto';

const PREFIX = '/tailchat';
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;
// The server pings every socket on a 12s cycle and drops one that does not
// answer, so a socket object that still claims to be open proves nothing. Each
// link sends its own `who` on a 20s cycle — which guarantees inbound traffic
// while the path works — and treats a minute of silence as a dead path.
const PING_MS = 20_000;
const STALE_MS = 60_000;
// How often a bot that has no friends yet asks who its friends are.
const IDLE_ROSTER_MS = 10_000;

// What this client implements. `addressed-send` is the one that matters for a
// bot: it may write to a peer from a socket that is not currently watching that
// peer, which is what a reminder fired at 07:00 needs.
const CLIENT_CAPS = ['addressed-send', 'durable-ack'];

export function normalizeServer(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return `${url.protocol}//${url.host}`;
}

export function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

export class CloudApiError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.name = 'CloudApiError';
    this.code = code;
    this.status = status;
  }
}

export function createBotClient({
  server,
  login,
  password = null,
  token = null,
  presence = 'active',
  displayName = null,
  log = () => {},
  onMessage = () => {},
  onHello = () => {},
  onPeers = () => {},
  onReady = () => {},
} = {}) {
  const base = normalizeServer(server);
  if (base === null) throw new Error(`not a usable server address: ${server}`);
  const self = String(login ?? '').toLowerCase();

  let bearer = token;
  let stopped = false;
  const links = new Map();

  // A laptop's network is not a server's: it changes Wi-Fi, wakes from sleep,
  // and has a VPN that comes and goes. `fetch` reports every one of those as a
  // bare `TypeError: fetch failed` with the real reason one level down in
  // `cause` — which is the difference between "the host is down" and "this
  // machine has no route to it right now", so the cause is what gets reported.
  // A network failure is retried; an HTTP answer is not, because a wrong
  // password must not be retried into an account lockout.
  const API_ATTEMPTS = 4;

  async function api(path, { method = 'POST', body = null } = {}) {
    const headers = {};
    if (body !== null) headers['content-type'] = 'application/json';
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        response = await fetch(`${base}${PREFIX}/api${path}`, {
          method,
          headers,
          body: body === null ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        const cause = error?.cause;
        const detail = [cause?.code, cause?.message ?? error?.message].filter(Boolean).join(' ') || 'network failure';
        if (attempt >= API_ATTEMPTS) throw new CloudApiError(`unreachable: ${detail}`);
        const wait = 1000 * 2 ** (attempt - 1);
        log(`${base} did not answer (${detail}) — retry ${attempt}/${API_ATTEMPTS - 1} in ${wait / 1000}s`);
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      const text = await response.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch {}
      if (!response.ok) throw new CloudApiError(payload?.error ?? 'server_error', response.status);
      return payload;
    }
  }

  async function signIn() {
    if (bearer) return;
    if (!password) throw new CloudApiError('no_token');
    const out = await api('/login', { body: { login: self, password } });
    bearer = out.token;
  }

  function write(socket, obj) {
    if (!socket || socket.readyState !== 1) return false;
    socket.send(`${JSON.stringify(obj)}\n`);
    return true;
  }

  // Any authenticated socket can address any friend, which is what
  // `addressed-send` buys: a reply does not have to go out on the very socket
  // that happens to be watching the person being answered.
  function anyOpenSocket() {
    for (const link of links.values()) {
      if (link.socket && link.socket.readyState === 1) return link.socket;
    }
    return null;
  }

  function send(to, d) {
    return write(anyOpenSocket(), { k: 'frame', to, d });
  }
  const peerLatestTs = new Map();


  function sendText(to, text, extra = {}) {
    const base = peerLatestTs.get(to) || 0;
    const now = Date.now();
    const ts = Math.max(now, base + 1);
    peerLatestTs.set(to, ts);
    return send(to, { t: 'msg', id: `bot-${randomId()}`, text, ts, ...extra });
  }

  function sendActions(to, actions) {
    return send(to, { t: 'actions', actions });
  }

  function typing(to, start) {
    return send(to, { t: 'typing', state: start ? 'start' : 'stop', name: displayName ?? self });
  }

  function handleUsers(list) {
    const next = new Set();
    for (const user of list) {
      if (typeof user?.login !== 'string') continue;
      // The official account and the assistant are friends of everyone and
      // never write to a bot; a socket each buys nothing.
      if (user.official === true) continue;
      if (user.login === self) continue;
      next.add(user.login);
    }
    for (const peer of next) {
      if (!links.has(peer)) {
        log(`watching ${peer}`);
        openLink(peer);
      }
    }
    for (const peer of links.keys()) {
      if (next.has(peer)) continue;
      log(`no longer friends with ${peer} — closing its socket`);
      closeLink(links.get(peer));
    }
    onPeers([...next]);
  }

  function handle(link, frame) {
    link.lastInboundAt = Date.now();
    if (frame.k === 'ready') {
      if (!displayName && typeof frame.self?.name === 'string') displayName = frame.self.name;
      write(link.socket, { k: 'state', state: presence });
      write(link.socket, { k: 'subscribe', peer: link.peer });
      return;
    }
    if (frame.k === 'subscribed') {
      // A terminal session drops everything it has not greeted, so a
      // well-behaved client says hello as soon as it is watching a thread —
      // the web client does the same on subscribe.
      link.subscribed = true;
      write(link.socket, {
        k: 'frame',
        to: link.peer,
        d: { t: 'hello', name: displayName ?? self, connId: randomId(8), v: 'bot' },
      });
      onReady(link.peer);
      return;
    }
    if (frame.k === 'frame') {
      const from = typeof frame.from === 'string' ? frame.from : '';
      const d = frame.d;
      if (from === '' || !d || typeof d.t !== 'string') return;
      // `self: true` is the account's own message coming back down another of
      // its sockets (`selfSync`, src/cloud/hub.js): the envelope names the
      // *conversation*, so `from` is the peer and the frame is otherwise
      // indistinguishable from one that peer really sent. A bot has no second
      // device, so every such frame is its own reply echoing back — and a bot
      // that answers it answers itself. «помощь» came back as the help text,
      // which came back as a reminder about the help text, which came back…
      // until the server's frame budget closed the socket (`rate_limited`,
      // close 4429) and left hundreds of junk reminders behind. Only a peer
      // that is not the one `anyOpenSocket` picks was ever hit, which is why
      // the first friend never saw it.
      if (frame.self === true) return;
      if (d.t === 'hello') {
        onHello(from, d);
        return;
      }
      if (d.t === 'msg' || d.t === 'ai') {
        if (Number.isFinite(d.ts)) {
          peerLatestTs.set(from, Math.max(peerLatestTs.get(from) || 0, d.ts));
        }
        if (typeof d.id === 'string' && d.id !== '') {
          send(from, { t: 'read', id: d.id });
        }
        onMessage(from, d);
      }
      return;
    }
    if (frame.k === 'users') {
      handleUsers(Array.isArray(frame.users) ? frame.users : []);
      return;
    }
    if (frame.k === 'error') {
      log(`server error: ${frame.code ?? 'unknown'}${frame.message ? ` — ${frame.message}` : ''}`);
    }
  }

  function scheduleReconnect(link, reason) {
    if (stopped || link.timer) return;
    const wait = link.retryMs;
    log(`reconnecting ${link.peer} in ${Math.round(wait / 1000)}s (${reason})`);
    link.timer = setTimeout(() => {
      link.timer = null;
      openLink(link.peer);
    }, wait);
    link.retryMs = Math.min(link.retryMs * 2, RETRY_MAX_MS);
  }

  function openLink(peer) {
    if (stopped) return;
    let link = links.get(peer);
    if (!link || link.closing) {
      link = { peer, socket: null, subscribed: false, retryMs: RETRY_MIN_MS, timer: null, lastInboundAt: 0 };
      links.set(peer, link);
    }
    void (async () => {
      try {
        await signIn();
      } catch (error) {
        log(`sign-in failed: ${error.message}`);
        scheduleReconnect(link, 'sign-in');
        return;
      }
      if (stopped) return;
      const socket = new WebSocket(`${base.replace(/^http/, 'ws')}${PREFIX}/ws`);
      link.socket = socket;
      socket.addEventListener('open', () => {
        link.retryMs = RETRY_MIN_MS;
        link.lastInboundAt = Date.now();
        write(socket, { k: 'auth', token: bearer, caps: CLIENT_CAPS });
      });
      socket.addEventListener('message', (event) => {
        for (const line of String(event.data).split('\n')) {
          if (line === '') continue;
          let frame;
          try { frame = JSON.parse(line); } catch { continue; }
          try { handle(link, frame); } catch (error) { log(`frame handling failed: ${error.message}`); }
        }
      });
      socket.addEventListener('close', (event) => {
        if (link.socket === socket) link.socket = null;
        link.subscribed = false;
        if (stopped) return;
        // 4401 is the server refusing the token; a fresh one is the only cure.
        if (event.code === 4401) bearer = null;
        scheduleReconnect(link, `closed (${event.code})`);
      });
    })();
  }

  function closeLink(link) {
    link.closing = true;
    clearTimeout(link.timer);
    try { link.socket?.close(); } catch {}
    links.delete(link.peer);
  }

  // Keeps every link honest: a socket nobody hears anything on for a minute is
  // rebuilt, because a half-dead path (a NAT hop that dropped one direction)
  // never reports itself closed.
  //
  // The loop beats faster than it pings, for one reason: a bot with no friends
  // yet has no link to carry a `who`, so the roster has to be asked for
  // directly — otherwise the person who accepts the invitation waits for a
  // restart that never comes.
  const HEARTBEAT_MS = 5000;
  let lastPingAt = 0;
  let lastRosterAt = 0;
  const heartbeat = setInterval(() => {
    if (stopped) return;
    const now = Date.now();

    if (links.size === 0) {
      if (rosterTimer === null && now - lastRosterAt >= IDLE_ROSTER_MS) {
        lastRosterAt = now;
        void refreshRoster();
      }
      return;
    }

    for (const link of links.values()) {
      const socket = link.socket;
      if (!socket || socket.readyState !== 1) continue;
      if (now - link.lastInboundAt > STALE_MS) {
        log(`${link.peer}: no traffic for a minute — rebuilding the socket`);
        try { socket.close(); } catch {}
      }
    }

    if (now - lastPingAt < PING_MS) return;
    lastPingAt = now;
    for (const link of links.values()) {
      const socket = link.socket;
      if (socket && socket.readyState === 1) write(socket, { k: 'who' });
    }
  }, HEARTBEAT_MS);
  // Deliberately not unref'd: a bot is a daemon, and this interval is what
  // keeps it one even if the socket library lets go of the loop.

  // The roster is how the bot learns who to watch at all, so a failed first
  // fetch has to keep trying — with no links open yet, nothing else will ever
  // bring an answer back.
  let rosterTimer = null;
  async function refreshRoster() {
    if (stopped) return;
    try {
      await signIn();
      const out = await api('/users', { method: 'GET' });
      handleUsers(Array.isArray(out?.users) ? out.users : []);
    } catch (error) {
      // `bad_credentials` on a first run means the account does not exist yet,
      // which is the one failure the hint below can actually fix.
      if (error.code === 'bad_credentials') {
        log(`sign-in refused for ${self} — if the account does not exist yet, run: node reminder-bot.mjs --register`);
      } else {
        log(`could not list friends: ${error.message}`);
      }
      rosterTimer = setTimeout(() => {
        rosterTimer = null;
        void refreshRoster();
      }, RETRY_MAX_MS);
      rosterTimer.unref?.();
    }
  }

  return {
    server: base,
    login: self,
    peers: () => [...links.keys()],
    start() {
      void refreshRoster();
    },
    // The first run of a new bot: create the account, then let it accept an
    // invitation from whoever is meant to use it. Both are one-shot — after
    // that the account exists and the friendship is symmetrical — but keeping
    // them here means the whole setup is the same command as the run.
    async register(name = displayName ?? self) {
      const out = await api('/register', { body: { login: self, password, name } });
      bearer = out.token;
      return out;
    },
    async acceptInvite(invite) {
      await signIn();
      const out = await api('/invite/accept', { body: { invite } });
      return out?.friend ?? null;
    },
    // The other direction, and the one that makes a first run one command: the
    // bot mints the code and prints it, the person pastes it into the app they
    // already have open. Creating a new one revokes this login's previous code.
    async createInvite() {
      await signIn();
      const out = await api('/invite', { body: {} });
      return out?.invite ?? null;
    },
    inviteUrl(code) {
      return `${base}${PREFIX}/?invite=${code}`;
    },
    async friends() {
      await signIn();
      const out = await api('/users', { method: 'GET' });
      return Array.isArray(out?.users) ? out.users : [];
    },
    // The Tailchat stand-in for Telegram's `file_id`: a reminder keeps the id
    // of the message it was made from, and the attachment is fetched back out
    // of the conversation at the moment it is needed. Nothing is copied into
    // the bot's own state, and the server's own retention rules decide how long
    // that stays possible — a record whose attachment was evicted comes back
    // with `mediaDropped`, which is a fact the reminder can tell the person
    // rather than a picture that silently never arrives.
    async history(peer, limit = 200) {
      await signIn();
      const out = await api(`/history?peer=${encodeURIComponent(peer)}&limit=${limit}`, { method: 'GET' });
      return Array.isArray(out?.messages) ? out.messages : [];
    },
    send,
    sendText,
    sendActions,
    typing,
    connected: () => anyOpenSocket() !== null,
    stop() {
      stopped = true;
      clearInterval(heartbeat);
      clearTimeout(rosterTimer);
      for (const link of links.values()) closeLink(link);
    },
  };
}
