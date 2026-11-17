import { randomUUID } from 'node:crypto';

import { readPresenceState } from '../presence.js';
import { normalizeLogin } from './accounts.js';
import { SERVICE_LOGIN, announceAppBuild } from './service-account.js';
import { AI_LOGIN } from './ai-account.js';
import { CLOUD_E2EE_FRAME_MAX_CHARS, CLOUD_FRAME_MAX_CHARS } from './limits.js';
import { MEDIA_REF_CAP, withMediaRefs } from './media-ref.js';
import {
  E2EE_CAP, E2EE_STUB_TEXT, carriesPlainContent, frameForCaps, isSealedEdit, normalizeEnvelope, sameEnvelope,
} from './e2ee.js';

// The only frame types worth keeping for someone who is not connected. A
// «печатает…», a ping or a file chunk describes a moment that is already over by
// the time the recipient comes back, and `hello` is re-sent by every new channel
// anyway, so holding those would replay a conversation that never happened.
// `del` belongs here: a deletion the peer never hears about would leave the
// message on their screen forever, and it is precisely the offline peer whose
// copy has to be revoked on the way back in.
const QUEUEABLE = new Set(['msg', 'ai', 'ack', 'read', 'del', 'edit', 'react']);
const USER_MESSAGE_TYPES = new Set(['msg', 'ai']);
// Only actual chat messages self-sync: control frames are never broadcast
// across sessions of the same account.
const SELF_SYNC = new Set(['msg', 'ai']);
// Voice-call signalling. A call arrives precisely when the callee has some
// other conversation open (or none), so these go to every connection of the
// recipient regardless of subscription. Never queued — an offer from five
// minutes ago is not a call — never stored, never self-synced (`call-taken`
// reaches the account's other devices by being addressed to itself).
const CALL_SIGNAL = new Set(['call-offer', 'call-ring', 'call-answer', 'call-ice', 'call-end', 'call-taken']);
const CALL_CAP = 'call-v1';
// A socket that exists only because something woke this device: the phone that
// FCM started to fetch one message and post one notification, while the person
// is not looking at it. It receives everything a session can — that is what it
// was woken for — but it must not make its owner *present*: nobody is there,
// and announcing them for the couple of seconds the wake socket lives (plus the
// departure hold that follows) is exactly «при отправке сообщения собеседнику,
// который offline — он автоматически на 2+- секунды показывается как online».
// Declared by the client, because only the client knows why it dialled; a
// client that does not send it is present, as every client has been until now.
const LURK_CAP = 'lurk-v1';
// Offers per caller→callee pair per window before `too_many_calls`.
const CALL_OFFER_LIMIT = 5;
const CALL_OFFER_WINDOW_MS = 60_000;
// How long an undelivered `call-offer` is held for the woken device to come
// and collect. The Android caller stops ringing at 45 s
// (`CallController.RING_TOTAL_TIMEOUT_MS`); replaying an offer after that
// would ring a phone for a call nobody is waiting on any more.
const CALL_OFFER_HOLD_MS = 45_000;
// How long a `call-offer` that *was* written to a live, call-capable socket
// waits for that device's own `call-ring` before it is treated as
// undelivered after all. A successful write proves nothing about the phone:
// frozen in Doze, or holding a TCP connection that died without a FIN, it
// accepts the bytes and rings nobody. `delivered > 0` then skipped both the
// hold and the push, the heartbeat noticed that socket only after two 12 s
// rounds, and the one wake-up signal that could still have reached the phone
// inside the caller's 45 s ring was never sent — «при закрытом приложении
// звонок не всегда проходит». `call-ring` is the frame that proves a phone
// is actually ringing, so its absence is what arms the fallback push.
const CALL_RING_ACK_MS = 6_000;
// How long a caller's ring outlives the loss of its last call-capable socket
// before it is cancelled on the caller's behalf. A phone changes network,
// Doze freezes the socket, the tunnel recycles: any of those closes the
// connection the server sees, and cancelling on the teardown itself meant
// «звонок сбрасывался» for calls whose caller was reconnecting at that very
// moment — the ring was withdrawn from a phone the caller was still trying to
// reach. The grace is comfortably longer than a reconnect and far shorter
// than the ring window it applies within.
const CALL_CANCEL_GRACE_MS = 5_000;
// One tap on «выделить всё» in a 500-message thread must not become one frame
// carrying 500 ids of unbounded length.
const DEL_MAX_IDS = 200;
const RATE_WINDOW_MS = 1000;
// Windows in a row that may exceed the budget before the connection is closed
// rather than merely warned. Three seconds of continuous overage is a client
// that is not pacing itself; one window over is a burst.
const RATE_STRIKE_LIMIT = 3;

// How long `broadcastUsers` folds repeated calls into one roster pass. Long
// enough to swallow a read-receipt storm, short enough that a person's roster
// is never visibly behind the event that changed it.
const USERS_COALESCE_MS = 250;

// How long «away» is held before it is told to anybody.
//
// A phone's socket dies every time it locks, hops Wi-Fi→LTE, is backgrounded or
// is woken: the APK redials after one second (`SyncEngine.RETRY_MS`, only
// reset by a *successful* connect), the browser after 250 ms
// (`RECONNECT_MIN_MS`). Reporting that second as an absence causes the presence
// dot, header state, and typing indicators to flicker on momentary transport drops.
//
// The verdict is held here, at the one place that decides it, rather than
// once per client. It costs a bounded staleness: a person who really left is
// still shown as present for this long on top of the ~25 s a silent socket
// already survives, and the moment they left (`store.touch`) is recorded
// unchanged. A reconnect inside the window cancels the hold, and nothing was
// ever announced, so there is nothing to take back.
const PRESENCE_GRACE_MS = 5000;

// How long a disconnected client keeps its claim on answering. Comfortably
// longer than a reconnect — the web client backs off to at most ten seconds,
// and a terminal's cloud link to thirty — and far shorter than "the terminal is
// switched off", which is the case the bridge exists for.
const AI_CLAIM_GRACE_MS = 90_000;
const AUTH_FAILED_CODE = 4401;
const RATE_LIMITED_CODE = 4429;
// How far a client's own clock may be from the server's before its timestamp
// stops being believed. Every client sorts a conversation by `ts`, so one
// phone running a few minutes fast used to plant its messages permanently
// below (or above) everything the other side said — «сообщения идут не по
// порядку». Inside the window the sender's own time is kept, which keeps a
// message sent a second ago from being restamped by a server whose clock
// differs by milliseconds; outside it, the server's clock decides, because
// it is the only one both sides share.
const CLOCK_SKEW_TOLERANCE_MS = 120_000;
// What this server implements, sent on `ready`. A client that sees no `caps`
// key is talking to an older deployment and keeps its own queue instead of
// trusting any of this.
const SERVER_CAPS = [
  'durable-ack', 'sync-v1', 'addressed-send', 'read-ack-v1', 'op-ack-v1',
  'marked-unread-v1', 'reply-reminder-v1', 'sync-nudge-v1', 'reaction-read-v1', CALL_CAP, LURK_CAP,
  E2EE_CAP, MEDIA_REF_CAP,
];
// A durable mutation changes what every session of the accounts involved owes
// its own cursor — not only the session subscribed to that conversation and not
// only the ones that happened to be connected when it was written. `sync-v1`
// alone left the catch-up to the client's own reconnect, so a socket that stayed
// up in another conversation (the phone in the background, a second tab on the
// roster) learned nothing until something forced a new `sync` — the message was
// never lost server-side, but the device was silently behind. A capability-
// gated, coalesced nudge is the smallest honest fix: the server says only
// "your feed moved", never what it says, and the client answers with the
// ordinary `sync` request it already implements. Not rate-limited, like `who`
// (`receive`), and never echoed back — a nudge is a server-to-client signal, so
// there is no path by which it could become the ping-pong AGENTS.md warns about.
const SYNC_NUDGE_CAP = 'sync-nudge-v1';
// How long nudges for one account are folded together. A `read`-receipt storm
// from a reconnecting client is hundreds of durable mutations in a burst; each
// one owes the peer's devices a feed pass, and one pass covers all of them.
const SYNC_NUDGE_COALESCE_MS = 250;
// How often the assistant's «печатает…» is renewed while the bridge works. A
// client forgets the indicator after a few seconds of silence — that is what
// made a long answer look like nothing happening — so the lease is re-armed
// well inside that window and released the moment the answer settles.
const AI_TYPING_RENEW_MS = 3000;

const MESSAGES = {
  auth_required: 'Сначала пройдите авторизацию.',
  auth_timeout: 'Токен не получен вовремя.',
  auth_failed: 'Токен не принят.',
  unknown_action: 'Неизвестная команда.',
  peer_not_found: 'Собеседник не найден.',
  not_subscribed: 'Сначала выберите собеседника.',
  blocked: 'Собеседник заблокирован.',
  frame_too_large: 'Кадр слишком большой.',
  rate_limited: 'Слишком много кадров.',
  message_id_conflict: 'Идентификатор сообщения уже использован.',
  store_failed: 'Сообщение не сохранено, попробуйте ещё раз.',
  too_many_calls: 'Слишком много звонков, подождите минуту.',
  bad_envelope: 'Зашифрованное сообщение отклонено.',
  device_required: 'Сначала зарегистрируйте ключи устройства.',
  device_not_found: 'Устройство не найдено.',
  invalid_to_device: 'Некорректное сообщение устройству.',
  to_device_full: 'Очередь устройства переполнена.',
};

// What a device that never gets the live frame sees instead: text if there is
// any, otherwise a label for the one attachment kind a push payload is small
// enough to describe without embedding it.
function pushPreview(d) {
  if (typeof d.text === 'string' && d.text !== '') {
    return d.text.length > 160 ? `${d.text.slice(0, 157)}…` : d.text;
  }
  if (d.image && typeof d.image === 'object') return '📷 Photo';
  if (d.voice && typeof d.voice === 'object') return '🎙 Voice message';
  return 'New message';
}

// Whether a frame arriving under an id the store already holds is the same
// message again — a retry whose receipt was lost — or a different one wearing
// a used id. Text and the attachment's payload are what a reader would call
// the message; everything else about a frame is routing.
function sameMessage(record, d) {
  // Already deleted for everyone: the message did land, and resurrecting the
  // comparison against a tombstone would turn every late retry into a
  // conflict the sender can never resolve.
  if (record.deletedAt) return true;
  // An encrypted message is its envelope: a retry sends the very same bytes
  // (E2EE spec §4.3), so anything else under its id is a different message.
  // One the media budget evicted has nothing left to compare, like a dropped
  // picture below.
  if (d.e2ee && record.mediaDropped && !record.e2ee) return true;
  if (record.e2ee || d.e2ee) return sameEnvelope(record.e2ee, normalizeEnvelope(d.e2ee));
  const text = typeof d.text === 'string' ? d.text : '';
  if ((typeof record.text === 'string' ? record.text : '') !== text) return false;
  // The attachment may have been evicted by the conversation's media budget;
  // what was stored is then no longer comparable, and the text has decided.
  if (record.mediaDropped) return true;
  const payload = (media) => (media && typeof media === 'object' && typeof media.dataUrl === 'string' ? media.dataUrl : '');
  return payload(record.image) === payload(d.image) && payload(record.voice) === payload(d.voice);
}

export function createCloudHub({
  store,
  now = Date.now,
  authTimeoutMs = 5000,
  frameRateLimit = 60,
  // How long a departure is held before it is announced — see
  // `PRESENCE_GRACE_MS`. An option for the same reason `heartbeatMs` is one on
  // the service: a test can watch the rule at its own scale.
  presenceGraceMs = PRESENCE_GRACE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  idFactory = randomUUID,
  // Where an operator-facing line goes. Injected so a test can read the
  // diagnostics rather than only the protocol — the frame-budget report is the
  // one record of *why* a client was told to slow down, and a test that asserts
  // the socket's behaviour without it would let the line rot silently.
  note = (line) => process.stderr.write(line),
  // Optional: `{ maybeRespond({ from, to, text }) }`, resolving to
  // `{ from, to, text }` or `null`. Absent by default — no cloud deployment
  // gets an AI bridge unless it is explicitly configured with an owner and a
  // key (see `src/cloud/ai-bridge.js`).
  aiBridge = null,
  // Optional: `{ handle({ from, text }) }`, resolving to a list of
  // `{ to, text, buttons }` the service account should say. Absent by default:
  // a deployment that does not build one keeps today's behaviour, where
  // messages to `{tailchat}` are recorded and nobody answers them.
  serviceBot = null,
  // Optional: `{ notify(login, payload) }`. Absent by default — a deployment
  // without a VAPID keypair gets exactly today's behaviour (see
  // `src/cloud/push.js`).
  pushSender = null,
} = {}) {
  if (!store) throw new TypeError('createCloudHub requires store');

  // One account, several connections: a phone and a laptop are the same person,
  // and both have to receive the conversation.
  const presence = new Map();
  // Accounts whose last device just left, inside `PRESENCE_GRACE_MS`: the login
  // still answers "present" (see `isOnline`) and keeps the activity state it
  // had, while the timer waits to announce the departure. Read by the two
  // accessors only — delivery itself still goes to real connections.
  const awayHeld = new Map();
  const authorised = new Set();
  // Latest `caps.ai` claim seen from each login, across whichever of its
  // connections most recently sent one — a terminal announces this on
  // connect and on every AI setting change (`sendCaps()` in `src/cli.js`).
  // The AI bridge reads it to avoid answering a message a connected
  // terminal (the owner's own, or the other party's) already owns: without
  // this, a message sent from cloud-web self-syncs to the owner's other
  // devices as `sync-outgoing`, which any AI-enabled terminal treats as its
  // own outgoing question and answers unconditionally — racing the bridge.
  const aiCapable = new Map();
  // When each login's last connection went away. A terminal that owns the
  // answering does not stop owning it because its socket blipped — and blips
  // happen, on a phone, a laptop lid, a relay recycling a tunnel. Forgetting
  // the claim the instant the socket closed left a window in which the bridge
  // believed nobody was answering: it replied, the terminal reconnected,
  // drained the same message from the queue and replied too. Two answers to
  // one question. The claim is kept for a grace period instead, long enough to
  // cover a reconnect and short enough that a terminal which is genuinely gone
  // hands the conversation back to the bridge.
  const aiCapableLostAt = new Map();
  // Recent `call-offer` times per `caller|callee`, for CALL_OFFER_LIMIT.
  const callOffers = new Map();
  // A `call-offer` that reached no live socket, held for the caller's own
  // ring window and handed over the instant one of the callee's devices
  // authenticates. Without it the push that woke that phone arrived to
  // nothing: call frames are deliberately excluded from the durable
  // `QUEUEABLE` queue (a call from an hour ago is not a call), the offer was
  // dropped on the floor, and the woken device sat silent while the caller
  // listened to a ring that could never be answered. One slot per callee,
  // newest wins — a second caller's offer is the one that matters.
  const pendingCallOffers = new Map();

  // The call this login is currently ringing out, if any: `{ to, callId, at,
  // cancelTimer }`, set when its `call-offer` is relayed and dropped by the
  // `call-answer` / `call-end` / `call-taken` that finishes it. One slot per
  // login — this server allows one call per account at a time anyway.
  //
  // It exists for the case the caller cannot report itself: the app is
  // swiped away, the phone loses signal, the process is killed. Nothing
  // sends `call-end`, and the callee — which cannot tell "still ringing me"
  // apart from "gave up" — kept ringing for the whole window, «как будто я
  // продолжаю звонить». `teardown` turns the caller's disappearance into the
  // cancel it never got to send.
  //
  // While the call is still only ringing, that is. An answered call is a
  // peer-to-peer media path that needs no signalling socket at all, and
  // treating its leg as "a ring left behind" was the second half of «разговор
  // сбрасывается»: a one-second blip on the caller's connection sent the
  // callee a `call-end{hangup}` for a conversation both sides were in the
  // middle of. The leg is therefore dropped the moment the call is answered —
  // see `dropOutgoingCallLeg`.
  const outgoingCallLegs = new Map();

  // The calls this server has seen *answered*, keyed by the caller's login:
  // `{ to, callId }`, written by the callee's own `call-answer` and dropped by
  // the `call-end`/`call-taken` that finishes that call. One entry per login,
  // like the legs above.
  //
  // It is what makes a `call-offer{restart}` trustworthy. A running call has
  // to re-negotiate its media path when ICE fails (`CallController.onIceFailed`),
  // and that re-offer must not go through the new-call path — it would create
  // a ring leg, hold an offer and push a phone that is already talking into
  // this very call. But "this frame says restart" is a claim by the sender,
  // not a fact: relay-only restarts are therefore granted only for the pair
  // and call this server watched get answered. Everything else is an offer
  // like any other, with the rate limit and the hold that go with one.
  const liveCallLegs = new Map();

  // Whether this connection says it is not a person: a wake socket, dialled by
  // a device that a push brought up (see `LURK_CAP`). It is delivered to like
  // any other connection — `presence` still holds it, which is what lets a held
  // `call-offer` or a nudge reach it — and it counts for nothing else.
  function isLurker(conn) {
    return conn.caps.includes(LURK_CAP);
  }

  // The connections of this login that are actually somebody being here: the
  // account's set minus the wake sockets, which is the answer every presence
  // question below must give — the phone is fetching, the person is not in the
  // room. `closed` is deliberately not consulted: `teardown` marks a connection
  // closed before it removes it from the set, and this is asked about the state
  // *before* that removal ("was anybody present a moment ago?").
  function presentConns(login) {
    const conns = presence.get(normalizeLogin(login));
    if (!conns) return [];
    const present = [];
    for (const conn of conns) if (!isLurker(conn)) present.push(conn);
    return present;
  }

  // Whether anyone ringing this login would reach a device that can answer:
  // a live connection that declared `call-v1`. Derived from `presence` rather
  // than kept in a second map, so it cannot outlive the connection. A wake
  // socket is not callable either: the app was not asked for a call, and it is
  // gone again before a ring could be answered.
  function isCallable(login) {
    for (const conn of presence.get(normalizeLogin(login)) ?? []) {
      if (!conn.closed && !isLurker(conn) && conn.caps.includes(CALL_CAP)) return true;
    }
    return false;
  }

  // Forget a held offer together with whatever timer is waiting on it.
  function dropPendingCallOffer(login) {
    const held = pendingCallOffers.get(login);
    if (!held) return;
    if (held.ackTimer) clearTimer(held.ackTimer);
    pendingCallOffers.delete(login);
  }

  /** The `callId` of a signalling frame, in the one shape every leg is keyed
   *  and matched by: a client that sends a non-string id gets the same `''`
   *  the leg was stored with, so `dropOutgoingCallLeg`'s comparison is
   *  against what the caller actually sent rather than against `undefined`. */
  function callIdOf(d) {
    return typeof d.callId === 'string' ? d.callId : '';
  }

  /** Whether this `call-offer` is a running call re-negotiating its media
   *  path (`restart`) rather than a new one being placed. Only a call this
   *  server has watched get answered may renegotiate — see [liveCallLegs] —
   *  so the marker on a first offer buys nothing. */
  function isCallRestartOffer(fromLogin, toLogin, d) {
    if (d.restart !== true) return false;
    const live = liveCallLegs.get(fromLogin);
    return Boolean(live && live.to === toLogin && live.callId === callIdOf(d));
  }

  /** Forget an answered call — matched against the call the frame is about,
   *  so a late `call-end` for an earlier call cannot take away the privilege
   *  the call in progress has to re-negotiate. */
  function dropLiveCallLeg(login, expect) {
    const live = liveCallLegs.get(login);
    if (!live || live.to !== expect.to || live.callId !== expect.callId) return;
    liveCallLegs.delete(login);
  }

  // Wake the callee's devices, at most once per offer: the ring-ack fallback
  // must never re-push an offer that already pushed.
  function pushCallOffer(toLogin, held) {
    if (held.pushed || !pushSender) return;
    held.pushed = true;
    void pushSender.notify(toLogin, {
      kind: 'call',
      callId: typeof held.d.callId === 'string' ? held.d.callId : '',
      peer: held.from,
      // What the person being rung sees on their lock screen, in the name their
      // account calls that contact (issue #28) — the same name the app shows
      // once it is open.
      title: store.aliasOf?.(toLogin, held.from) || store.nameOf(held.from),
    })?.catch?.(() => {});
  }

  // Whether a client of this account has claimed the answering *for this
  // conversation* — now, or recently enough that it is probably just
  // reconnecting.
  //
  // The claim itself is account-global ("this terminal has AI configured"),
  // but a cloud terminal is subscribed to exactly one conversation at a time
  // and only ever sees frames from that peer. Treating the claim as global
  // therefore silenced the assistant for every *other* contact: the bridge
  // deferred to a terminal that was never going to be shown the message. So
  // while the account is online the claim only covers the conversations its
  // connections are actually watching; once it is fully offline the old
  // account-wide grace applies, because a reconnecting terminal drains the
  // queue and answers from it.
  function ownsAnswering(loginReference, otherReference = null) {
    const login = normalizeLogin(loginReference);
    if (aiCapable.get(login) !== true) return false;
    const conns = presence.get(login);
    if (conns && conns.size > 0) {
      if (otherReference === null) return true;
      const other = normalizeLogin(otherReference);
      for (const conn of conns) {
        if (!conn.closed && conn.peer === other) return true;
      }
      return false;
    }
    const lostAt = aiCapableLostAt.get(login);
    if (lostAt === undefined) return true;
    if (now() - lostAt < AI_CLAIM_GRACE_MS) return true;
    // Genuinely gone: forget the claim so this is decided once rather than on
    // every message for the rest of the process's life.
    aiCapable.delete(login);
    aiCapableLostAt.delete(login);
    return false;
  }

  function isOnline(login) {
    const key = normalizeLogin(login);
    // A held departure keeps answering "present" for the same reason it exists:
    // the blip is not something anybody should see. A wake socket does not.
    return presentConns(key).length > 0 || awayHeld.has(key);
  }

  function onlineLogins() {
    const logins = new Set(awayHeld.keys());
    for (const login of presence.keys()) {
      if (presentConns(login).length > 0) logins.add(login);
    }
    return logins;
  }

  // A connection that announced `media-ref-v1` is handed a message's picture or
  // voice note as a description, and fetches the bytes over HTTP
  // (docs/specs/2026-11-03-history-media-refs.md §5.3): a 10 MiB frame would
  // queue this socket's pings and receipts behind it and can outlast the
  // heartbeat on a slow link. Decided per connection, not per account — one
  // person can hold an old phone and a new browser at once — and only on the
  // way out: the stored record, the offline queue and the duplicate check all
  // keep the inline bytes.
  function forConnection(conn, payload) {
    if (payload?.k !== 'frame' || !payload.d || !conn.caps?.includes(MEDIA_REF_CAP)) return payload;
    const d = withMediaRefs(payload.d);
    return d === payload.d ? payload : { ...payload, d };
  }

  function send(conn, payload) {
    if (conn.closed) return;
    try {
      conn.send(forConnection(conn, payload));
    } catch {
      // A transport that cannot take a write is already gone; the alternative is
      // an exception thrown back into whoever's frame happened to be routed.
      teardown(conn);
    }
  }

  function fail(conn, code, message) {
    send(conn, { k: 'error', code, message });
  }

  // What the peer is shown next to the name: the most present of an account's
  // connections wins, because one attentive device is enough for the person to
  // be there. A connection that has never reported (an old client, a browser
  // tab that just opened) counts as active — the same assumption
  // `createPresenceSignal` starts from. An account inside `PRESENCE_GRACE_MS`
  // keeps the state it left with, for the same reason it keeps answering
  // `isOnline`: the blip is not something anybody should see.
  function stateFor(login) {
    const key = normalizeLogin(login);
    const conns = presentConns(key);
    if (conns.length === 0) return awayHeld.get(key)?.state ?? 'away';
    let idle = false;
    for (const conn of conns) {
      if (conn.state === 'active') return 'active';
      if (conn.state === 'idle') idle = true;
    }
    return idle ? 'idle' : 'away';
  }

  function usersFor(conn) {
    // Every UI-facing badge (this roster list, HTTP /api/users, `subscribed`)
    // counts only actual human/AI messages, deduped by message id — never the
    // ack/read/edit/delete/react control frames queued alongside them. Native
    // (non-webFeatures) clients used to get the raw `pending(login, false)`
    // queue depth here, which is how a burst of receipts for other peers
    // inflated one peer's badge to the whole queue depth.
    const counts = store.unreadCounts(conn.login);
    const list = [];
    for (const account of store.friends(conn.login)) {
      if (account.login === conn.login) continue;
      // Deleted by this account: off its roster, while the other side keeps
      // both the contact and the thread (see `removeContact`).
      if (store.isRemoved(conn.login, account.login)) continue;
      // The official account answers from the server itself, so it has no
      // socket to be present on: shown as away it read as «сервис лежит»
      // every time anyone looked at the roster. It is up exactly as long as
      // the deployment serving this roster is.
      const official = account.login === SERVICE_LOGIN || account.login === AI_LOGIN;
      const entry = {
        login: account.login,
        name: account.name,
        online: official || isOnline(account.login),
        state: official ? 'active' : stateFor(account.login),
        lastSeen: account.lastSeen,
        pending: counts[account.login] ?? 0,
        callable: !official && isCallable(account.login),
      };
      if (official) entry.official = true;
      // A program rather than a person — `bots/client.mjs` and anything else
      // whose own socket announces `v: 'bot'` (see `markBot`). Sent so a
      // client that counts people online does not count a daemon, and so a
      // roster row can say what it is. Absent, not `false`, for everybody
      // else, like every other optional flag here.
      if (store.isBot?.(account.login)) entry.bot = true;
      // The nickname *this* account gave the contact (issue #28). Private: it
      // is read from the owner's own alias table and never leaves this roster,
      // so the peer keeps the name it chose. Absent when there is none, since
      // clients render `alias || name || login`.
      const alias = store.aliasOf?.(conn.login, account.login);
      if (alias) entry.alias = alias;
      // Whether *this* account has blocked the contact — the only direction
      // a client needs to know its own composer/menu state; whether the
      // contact has blocked back is never revealed to either side.
      if (store.hasBlocked(conn.login, account.login)) entry.blocked = true;
      // What the roster shows under the name. Sent from here rather than
      // assembled by the client, because a client knows only the conversations
      // it has actually opened — on a fresh load that is none of them, and a
      // roster of blank second lines is worse than no second line at all.
      const last = store.lastMessage?.(conn.login, account.login);
      if (last) entry.last = last;
      if (conn.webFeatures || conn.caps.includes('reaction-read-v1')) entry.reactionEvents = store.reactionEvents?.(conn.login, account.login) || [];
      list.push(entry);
    }
    return list;
  }

  // Each recipient sees its own unread counters, so the list is rebuilt per
  // connection rather than broadcast as one shared payload: O(connections)
  // full rosters per call. That was fine while the callers were "somebody came
  // online" and "somebody sent a message"; it stopped being fine when a read
  // receipt started calling it (`relay`'s `read` branch), because a client
  // catching up on its transcript sends those in the hundreds. One phone
  // reconnecting made the whole deployment rebuild every roster once per
  // receipt, and each rebuild is a `usersFor` walk over every friend of every
  // connected account.
  //
  // Leading edge first, so a roster change is still visible at once — the
  // contract `broadcastPresence` and the first-connection announcement rely on
  // — then everything inside [USERS_COALESCE_MS] is folded into one pass.
  let usersTimer = null;
  let replyReminderTimer = null;
  let usersFlushedAt = -Infinity;

  function broadcastUsers(except = null) {
    const at = now();
    if (usersTimer === null && at - usersFlushedAt >= USERS_COALESCE_MS) {
      flushUsers(except);
      return;
    }
    if (usersTimer !== null) return;
    usersTimer = setTimer(() => {
      usersTimer = null;
      // No exclusion on a deferred pass. It arrives because *somebody else*
      // changed inside the window, and that change concerns every connection —
      // including one that joined while the window was open, whose own `ready`
      // answered it directly and which would otherwise miss everything that
      // happened in the same window.
      flushUsers();
    }, Math.max(0, USERS_COALESCE_MS - (at - usersFlushedAt)));
  }

  function flushUsers(except = null) {
    usersFlushedAt = now();
    for (const conn of authorised) {
      if (conn === except || conn.closed) continue;
      send(conn, { k: 'users', users: usersFor(conn) });
    }
  }

  function deliverReplyReminder(owner, reminder) {
    const payload = { k: 'reply-reminder-fired', reminder };
    for (const conn of presence.get(owner) ?? []) send(conn, payload);
    if (pushSender) {
      void pushSender.notify(owner, {
        kind: 'reply-reminder',
        title: 'Напомнить ответить',
        body: store.aliasOf?.(owner, reminder.peer) || store.nameOf(reminder.peer),
        peer: reminder.peer,
        messageId: reminder.messageId,
        reminderId: reminder.id,
        tag: `tailchat-reply-reminder-${reminder.id}`,
      }).catch(() => {});
    }
  }

  function runReplyReminders() {
    replyReminderTimer = null;
    for (const { owner, ...reminder } of store.dueReplyReminders?.(now()) ?? []) {
      deliverReplyReminder(owner, reminder);
    }
    armReplyReminders();
  }

  function armReplyReminders() {
    if (replyReminderTimer !== null) {
      clearTimer(replyReminderTimer);
      replyReminderTimer = null;
    }
    const next = store.nextReplyReminderAt?.();
    if (!Number.isFinite(next)) return;
    replyReminderTimer = setTimer(runReplyReminders, Math.max(0, next - now()));
    replyReminderTimer?.unref?.();
  }

  function broadcastPresence(login, online, state = stateFor(login)) {
    for (const conn of authorised) {
      if (conn.closed || conn.peer !== login) continue;
      send(conn, { k: 'presence', peer: login, online, state });
    }
  }

  // A keystroke must not rebuild every roster in the deployment, so nothing is
  // announced unless the account's aggregate actually moved: with two devices
  // open, one of them going idle changes nothing anybody can see.
  function setConnState(conn, raw) {
    const next = readPresenceState(raw);
    if (!next || conn.state === next) return;
    if (!conn.login) {
      conn.state = next;
      return;
    }
    const before = stateFor(conn.login);
    conn.state = next;
    const after = stateFor(conn.login);
    if (after === before) return;
    broadcastPresence(conn.login, true, after);
    // The rosters that matter are not only the ones with this conversation
    // open: a `users` list shows every friend's state at once.
    broadcastUsers();
  }

  /**
   * The ring [login] left behind. Called after its connection is out of
   * `presence`: if the account no longer has any socket that could carry a
   * call, whatever it was ringing is over, and the callee is told so — the
   * `call-end{hangup}` the caller's app never got to send because it was
   * swiped away, killed, or lost signal. Bounded by the same hold window as
   * a pending offer: past it the callee's own ring timeout has fired anyway.
   *
   * The verdict is held for [CALL_CANCEL_GRACE_MS] rather than delivered on
   * the spot, and re-checked when it lands. A caller that is merely
   * reconnecting is not a caller who gave up, and the teardown of its old
   * socket is not evidence about the new one: with the check inline, a
   * reconnect — or the Doze window, or the cellular handover, that caused it
   * — cancelled the ring the caller was still waiting on.
   */
  function cancelOrphanedCall(login) {
    const leg = outgoingCallLegs.get(login);
    if (!leg) return;
    if (isCallable(login)) return;
    // Already counting down: the timer below owns the verdict, and re-arming
    // it on every further teardown would push the deadline out forever.
    if (leg.cancelTimer) return;
    leg.cancelTimer = setTimer(() => {
      leg.cancelTimer = null;
      // Still the same leg — `dropOutgoingCallLeg` clears this timer, but a
      // genuinely stale one must not cancel a call that has replaced it
      // (a second offer from the same login, or an answer that arrived while
      // the grace was running).
      if (outgoingCallLegs.get(login) !== leg) return;
      if (isCallable(login)) return;
      outgoingCallLegs.delete(login);
      const held = pendingCallOffers.get(leg.to);
      if (held && held.from === login) dropPendingCallOffer(leg.to);
      if (now() - leg.at >= CALL_OFFER_HOLD_MS) return;
      deliverFrame(login, leg.to, { t: 'call-end', callId: leg.callId, reason: 'hangup' });
    }, CALL_CANCEL_GRACE_MS);
  }

  /** Forget [login]'s ring — answered, ended, refused, or replaced by a newer
   *  offer — together with the cancel that was waiting to judge it.
   *
   *  `expect`, when given, is the call the signal is actually about: nothing
   *  happens unless the leg is that call to that peer. A `call-end` or
   *  `call-answer` for an earlier call that arrives late — a retry, a
   *  reordered frame, the peer's own hang-up of the call before this one —
   *  must not clear, or cancel, the ring the two sides are in now.
   *  Returns whether a leg was dropped. */
  function dropOutgoingCallLeg(login, expect = null) {
    const leg = outgoingCallLegs.get(login);
    if (!leg) return false;
    if (expect && (leg.to !== expect.to || leg.callId !== expect.callId)) return false;
    if (leg.cancelTimer) {
      clearTimer(leg.cancelTimer);
      leg.cancelTimer = null;
    }
    outgoingCallLegs.delete(login);
    return true;
  }

  function teardown(conn) {
    if (conn.gone) return;
    conn.gone = true;
    conn.closed = true;
    if (conn.authTimer !== null) {
      clearTimer(conn.authTimer);
      conn.authTimer = null;
    }
    authorised.delete(conn);
    if (!conn.login) return;

    const peers = presence.get(conn.login);
    const wasPresent = presentConns(conn.login).length > 0;
    const wasCallable = isCallable(conn.login);
    const lastState = stateFor(conn.login);
    peers?.delete(conn);
    if (peers && peers.size > 0 && wasCallable && !isCallable(conn.login)) broadcastUsers();
    cancelOrphanedCall(conn.login);
    if (peers && peers.size === 0) {
      presence.delete(conn.login);
      // Not deleted: see `aiCapableLostAt`. A caps frame saying `ai: false` is
      // the only thing that revokes the claim outright.
      if (aiCapable.has(conn.login)) aiCapableLostAt.set(conn.login, now());
    }
    // A departure is announced when the last *present* device goes, which is
    // not the same as the last connection: a wake socket may outlive the screen
    // that was here. An account whose only connection was ever a wake one never
    // said "here", so there is nothing to take back and no hold to arm — which
    // is the whole point of `LURK_CAP`.
    if (wasPresent && presentConns(conn.login).length === 0) {
      // The last screen that could show «печатает…» just went away — a wake
      // socket cannot show anything, so the lease must not outlive the screen
      // that owns it (its renewal timer would otherwise keep announcing to
      // nobody for as long as the answer takes).
      stopAiTypingFor(conn.login);
      // The moment «был(а) …» belongs to is the moment the person left, not the
      // moment a wake socket of theirs stopped fetching — and a wake socket
      // never moved `lastSeen` on the way in, so it must not move it here.
      store.touch(conn.login, now());
      holdAway(conn.login, lastState);
    }
  }

  // A departure nobody is told about yet. The login stops answering for
  // delivery at once (`presence` is gone), but the two presence accessors keep
  // saying "here" until this fires, and a reconnect inside the window cancels
  // it outright — see `PRESENCE_GRACE_MS`, and `authenticate`.
  function holdAway(login, state) {
    const previous = awayHeld.get(login);
    if (previous) clearTimer(previous.timer);
    const timer = setTimer(() => {
      awayHeld.delete(login);
      // The timer is cancelled by a reconnect, so this is belt and braces: a
      // hold that somehow outlived its own entry must not report a present
      // person as gone.
      if (presentConns(login).length > 0) return;
      broadcastPresence(login, false, 'away');
      broadcastUsers();
    }, presenceGraceMs);
    awayHeld.set(login, { timer, state });
  }

  // Held verdicts are timers, and a shutdown must not leave them to fire
  // against a store that is closing (`service.close`). See it called there,
  // after the sockets are down and every teardown that had to run has run.
  function close() {
    for (const held of awayHeld.values()) clearTimer(held.timer);
    awayHeld.clear();
    // A held cancel is a timer like any other: left to fire against a store
    // that is closing (`service.close`), it would send a `call-end` through a
    // hub whose sockets are already down.
    for (const leg of outgoingCallLegs.values()) {
      if (leg.cancelTimer) clearTimer(leg.cancelTimer);
      leg.cancelTimer = null;
    }
    outgoingCallLegs.clear();
    liveCallLegs.clear();
    if (replyReminderTimer !== null) clearTimer(replyReminderTimer);
    replyReminderTimer = null;
  }

  function disconnect(conn, code) {
    teardown(conn);
    try {
      conn.requestClose?.(code);
    } catch {
      // The transport is being asked to hang up; if it throws, it has already
      // hung up.
    }
  }

  // One canonical shape for "who this account is", shared by `ready` and
  // `profile` so the two cannot drift into two different public selves. It is
  // the same three fields `accounts.js`'s `publicUser` returns for HTTP
  // (`/login`, `/profile`), which is the point: a client that replaces its
  // `self` wholesale from any of those envelopes must not lose a field because
  // one of them happened to be assembled somewhere else.
  //
  // `extraPasswordEnabled` is what the profile dialog reads to decide whether
  // the additional-password switch starts on or off. It used to ride only on
  // the HTTP login response, so a client that reconnected over the socket lost
  // it and offered to *set* a password that was already set — see
  // `web/cloud/app.js`'s `openProfileDialog`.
  function publicSelf(login, user) {
    const id = normalizeLogin(login);
    return {
      login: id,
      name: typeof user?.name === 'string' ? user.name : id,
      extraPasswordEnabled: user?.extraPasswordEnabled === true,
    };
  }

  async function authenticate(conn, token) {
    if (conn.authPending) return;
    conn.authPending = true;
    let user = null;
    try {
      // The store may answer straight from memory or from a promise; `auth` is
      // the one step this core is allowed to wait on, so both are accepted.
      user = await Promise.resolve(store.resolveToken(token));
    } catch {
      user = null;
    }
    conn.authPending = false;
    if (conn.gone) return;

    if (!user || typeof user.login !== 'string') {
      fail(conn, 'auth_failed', MESSAGES.auth_failed);
      disconnect(conn, AUTH_FAILED_CODE);
      return;
    }

    clearTimer(conn.authTimer);
    conn.authTimer = null;
    conn.login = normalizeLogin(user.login);
    // The digest of the session's token, never the token: what finds this
    // session's end-to-end encryption device, including one it registers
    // over HTTP after this socket is already up.
    conn.tokenKey = store.e2eeTokenKey?.(token) ?? null;
    // A wake socket is not the person arriving, so it must not move «был(а) …»
    // either: `usersFor` ships `lastSeen` to every roster, and a message pushed
    // to an offline phone may not turn «час назад» into «только что» any more
    // than it may turn the dot green. A real session still records the moment.
    const lurker = isLurker(conn);
    if (!lurker) store.touch(conn.login, now());
    authorised.add(conn);

    const peers = presence.get(conn.login);
    const wasPresent = presentConns(conn.login).length > 0;
    const wasCallable = isCallable(conn.login);
    if (peers) peers.add(conn);
    else presence.set(conn.login, new Set([conn]));

    // Back inside `PRESENCE_GRACE_MS` of its own departure: nobody was told
    // anything, so the hold is simply dropped — no `presence` frame and no
    // roster pass are owed, and `usersFor` below answers with the truth.
    // A wake socket does not cancel the hold, for the same reason it does not
    // announce an arrival: it is a fetch, not the person coming back.
    const departure = awayHeld.get(conn.login);
    if (departure && !lurker) {
      clearTimer(departure.timer);
      awayHeld.delete(conn.login);
    }

    // The build this client is running, when it said so on `auth`: one message
    // about exactly that build, once, in this person's thread with the service
    // account — the notes are curated per build in `docs/android-notes.md`, and
    // a build without a section gets nothing. Delivered before `ready` so that
    // `usersFor(conn)` includes the new message in `pending`, keeping the
    // service account's message strictly UNREAD on the client's roster.
    if (conn.appBuild) {
      try {
        announceAppBuild({ store, hub: { sendServiceMessage }, login: conn.login, build: conn.appBuild });
      } catch {
        // Ignored on purpose — see above.
      }
    }

    send(conn, {
      k: 'ready',
      self: publicSelf(conn.login, user),
      users: usersFor(conn),
      caps: SERVER_CAPS,
    });
    // Key messages held for this device while it was away, oldest first. They
    // stay held until the device acknowledges them (`to-device-ack`), so a
    // socket that drops halfway gets them again on the next `auth`.
    if (conn.caps.includes(E2EE_CAP)) {
      const device = store.e2eeDeviceForTokenKey?.(conn.tokenKey) ?? null;
      for (const item of device ? store.e2eeInbox(conn.login, device) : []) {
        send(conn, { k: 'to-device', ...item });
      }
    }
    for (const reminder of store.firedReplyReminders?.(conn.login) ?? []) {
      send(conn, { k: 'reply-reminder-fired', reminder });
    }
    // ...and the ones that have not come due yet, in the same shape the
    // scheduling connection got: the mark a client draws on such a message is
    // state of the message, so it survives a reload, a second device and a
    // phone that was closed when the reminder was set. Sent after the fired
    // ones — a message carries one reminder or the other, never both.
    for (const reminder of store.pendingReplyReminders?.(conn.login) ?? []) {
      send(conn, { k: 'reply-reminder-set', reminder });
    }

    // A second device of an account that is already online changes nothing
    // anyone else can see, so only the first *present* arrival is announced —
    // and a wake socket's arrival is not one (`LURK_CAP`).
    if (!wasPresent && !lurker) {
      broadcastPresence(conn.login, true);
      broadcastUsers(conn);
    } else if (!wasCallable && isCallable(conn.login)) {
      // The account was already online, but only now reachable by a call.
      broadcastUsers(conn);
    }

    // The call this device was woken up for. Delivered only to a connection
    // that can actually take it, and only while the caller is still ringing.
    const held = pendingCallOffers.get(conn.login);
    if (held) {
      const stale = now() - held.at >= CALL_OFFER_HOLD_MS;
      if (stale) dropPendingCallOffer(conn.login);
      else if (conn.caps.includes(CALL_CAP)) {
        dropPendingCallOffer(conn.login);
        send(conn, { k: 'frame', from: held.from, d: held.d });
      }
    }
  }

  function subscribe(conn, peerReference) {
    const peer = normalizeLogin(peerReference);
    // A login subscribing to itself is the Saved Messages conversation: a
    // private note-to-self thread every account gets for free, the way
    // Telegram's Saved Messages works. It needs no friendship check because
    // nobody but the account itself can ever be `conn.login` here.
    const isSelf = peer === conn.login;
    // A deleted contact fails this the same way a stranger does, and for the
    // same reason: there is no conversation on this account's side to subscribe
    // to. The other side's subscription to *this* account is unaffected — what
    // stops its frames is the gate in `relay`.
    if (!isSelf && (!store.areFriends(conn.login, peer) || store.isRemoved(conn.login, peer))) {
      fail(conn, 'peer_not_found', MESSAGES.peer_not_found);
      return;
    }

    conn.peer = peer;
    // Everything said while this account had nobody subscribed to that peer is
    // handed over as ordinary frames: the client cannot tell a stored message
    // from a live one, which is exactly the point.
    const queued = store.drain(conn.login, peer);
    for (const item of queued) {
      send(conn, peer === conn.login
        ? { k: 'frame', from: peer, d: frameForCaps(conn.caps, item.d), self: true }
        : { k: 'frame', from: peer, d: frameForCaps(conn.caps, item.d) });
    }
    send(conn, {
      k: 'subscribed',
      peer,
      online: peer === SERVICE_LOGIN || peer === AI_LOGIN || isOnline(peer),
      state: (peer === SERVICE_LOGIN || peer === AI_LOGIN) ? 'active' : stateFor(peer),
      // Only actual human/AI messages, not the control frames (ack/read/
      // edit/delete/react) drained alongside them into `queued` above.
      pending: store.countMessageItems(queued),
      callable: peer !== SERVICE_LOGIN && peer !== AI_LOGIN && peer !== conn.login && isCallable(peer),
    });
    // A hello that crossed this connection while it was not yet subscribed to
    // the sender was held on it (see deliverFrame); now that the subscription
    // makes it deliverable, pass it on — but only while the sender is
    // genuinely here, and only after `subscribed` has told the client which
    // channel to expect it on. Sent the other way round it would land on the
    // channel the client replaces the moment it reads `subscribed`.
    if (conn.greeting && conn.greeting.from === peer && presentConns(peer).length > 0) {
      const { d } = conn.greeting;
      conn.greeting = null;
      send(conn, { k: 'frame', from: peer, d });
    }
  }

  // Closing a conversation client-side must stop the hub from treating this
  // connection as an active viewer of that peer — without it, `deliverFrame`
  // kept routing every later message from that peer as "delivered live"
  // (`target.peer === fromLogin`) forever after the UI moved back to the
  // roster, which skips `store.enqueue`/the unread-count push entirely: the
  // message silently landed as if already read. No reply is sent — nothing
  // client-side is waiting on one, unlike `subscribe`'s `subscribed` ack.
  function unsubscribe(conn) {
    conn.peer = null;
  }

  /**
   * Charges one frame against the connection's budget and answers whether it
   * may be acted on.
   *
   * Exceeding the budget used to close the socket on the spot. That threw away
   * every frame already handed to the connection's own send queue and anything
   * in flight, which for this client is a durable, unacknowledged message: the
   * hub closed a socket because *bytes* arrived in a burst, and the client paid
   * for it in work it can only recover by resending. A burst is not the same
   * thing as a client that will not stop, and the difference is a window: so
   * the first windows over budget drop the frame and tell the sender, and only
   * [RATE_STRIKE_LIMIT] windows *running* over budget — with none of them inside
   * the limit, which is what would prove the client is pacing itself — earn the
   * close.
   *
   * The soft answer is deliberately **not** `error: rate_limited`. Both clients
   * treat any `error` envelope as "this connection is broken": the phone drops
   * the link, shows «Too many attempts. Try again later.» and reconnects, the
   * web client paints the same complaint — for a body of frames it is not
   * actually refused or disconnected over, and whose arrival in one window may
   * have as much to do with the server's own event loop stalling as with how
   * fast anything was sent. That one string for two very different verdicts is
   * exactly why "it says too many attempts when I send a message or two" never
   * had an answer. `k:"throttle"` carries the same news without pretending the
   * connection is gone; a client that does not know the envelope ignores it,
   * which is what both of ours do.
   *
   * Charged by [relay] only after it has decided the frame is one the hub will
   * act on: a frame refused for pointing at the wrong peer, for having no
   * payload or for exceeding the size cap was never going to be routed, and
   * spending the sender's budget on it only made the refusal worse.
   */
  function chargeFrame(conn) {
    const at = now();
    if (at - conn.windowStart >= RATE_WINDOW_MS) {
      // A window that ended inside the budget is evidence the client is not
      // stuck in a loop, so the strikes start over.
      if (!conn.windowOver) conn.rateStrikes = 0;
      conn.windowStart = at;
      conn.frames = 0;
      conn.windowOver = false;
      conn.windowOverNoted = false;
    }
    conn.frames += 1;
    if (conn.frames <= frameRateLimit) return true;
    conn.windowOver = true;
    // One strike per window, not per frame: a hundred frames over budget in one
    // window is one window over budget, and that is the thing worth counting.
    if (conn.strikeWindow !== conn.windowStart) {
      conn.strikeWindow = conn.windowStart;
      conn.rateStrikes += 1;
    }
    // One report per window per connection — not per dropped frame, and not per
    // repeat of a flood that is already being logged: a client that really is
    // flooding must not be able to make this deployment spend bandwidth on
    // telling it so, nor write its log.
    if (!conn.windowOverNoted) {
      conn.windowOverNoted = true;
      if (conn.rateStrikes >= RATE_STRIKE_LIMIT) {
        noteRateLimit(conn, 'closing');
        fail(conn, 'rate_limited', MESSAGES.rate_limited);
        disconnect(conn, RATE_LIMITED_CODE);
        return false;
      }
      noteRateLimit(conn, 'over budget');
      send(conn, { k: 'throttle', windowMs: RATE_WINDOW_MS, frames: conn.frames, limit: frameRateLimit });
      return false;
    }
    // Already reported inside this window: the frame is still dropped, and
    // whatever the client owes for it is its own durable queue's business.
    return false;
  }

  /**
   * The record the deployment was missing.
   *
   * «Too many attempts» is one string on the client for two unrelated server
   * verdicts — this frame budget, and the HTTP login limiter — and until this
   * line existed neither was written down anywhere. A report of "it happens
   * when I send one or two messages" therefore could not be told apart from a
   * client that really was flooding, nor from a burst that only *looked* like
   * one because the event loop had stalled and every queued frame arrived in
   * the same millisecond. The login, the peer and the frame type are what make
   * that distinction possible after the fact.
   */
  function noteRateLimit(conn, what) {
    note(
      `Tailchat cloud: frame budget ${what} login=${conn.login ?? '-'} peer=${conn.peer ?? '-'} ` +
      `type=${conn.lastFrameType ?? '-'} frames=${conn.frames}/${frameRateLimit} ` +
      `strikes=${conn.rateStrikes}/${RATE_STRIKE_LIMIT} window=${RATE_WINDOW_MS}ms\n`,
    );
  }

  /**
   * Which client a connection is, in the one word an operator needs after a
   * read watermark moves and nobody admits to reading anything.
   *
   * Nothing in the protocol asks a client to name itself, and nothing here
   * adds such a field: this is read off what a connection already declared for
   * other reasons. The browser is the client that sends `webFeatures`, the
   * phone is the one that reports its own build, and a terminal (the CLI, a
   * bot) is neither. `cli` is therefore "no browser, no build" rather than a
   * positive claim — see [noteReadAdvance] for what it is used for.
   */
  function clientKind(conn) {
    if (conn.webFeatures) return 'web';
    if (conn.appBuild > 0) return `android/${conn.appBuild}`;
    return 'cli';
  }

  /**
   * The record behind «сообщение уже прочитано, а я его не видел».
   *
   * Readness is account-wide, not per-device: `syncRead` clears the roster
   * badge on every other session of the reader, so one device looking at a
   * conversation leaves *all* of them looking read. Which device it was is
   * recorded beside the watermark (`state.readVias`, `accounts.js`) and travels
   * on the receipts themselves; this line is the operator's copy of the same
   * fact, written at the moment it happens and for every advance, because a
   * badge that silently cleared is exactly the report that cannot be
   * reconstructed afterwards. Both writers of the watermark — a `read` frame
   * and «отметить прочитанным» — report through it, and only when the watermark
   * actually moved: a repeated receipt for a message already read is not an
   * event, and logging it would bury the one line that matters.
   */
  function noteReadAdvance(conn, peer, readTs) {
    note(
      `Tailchat cloud: read login=${conn.login ?? '-'} peer=${peer ?? '-'} ` +
      `via=${clientKind(conn)} readTs=${readTs} at=${now()}\n`,
    );
  }

  // A self-sync frame belongs to the conversation with `toLogin`, not to a
  // thread named after the sender. This keeps a web session on the same
  // account in the live thread that `/history?peer=...` will later return.
  function selfSync(fromLogin, toLogin, d, excludeConn = null) {
    for (const target of presence.get(fromLogin) ?? []) {
      if (target === excludeConn || target.closed || target.peer !== toLogin) continue;
      send(target, { k: 'frame', from: toLogin, d: frameForCaps(target.caps, d), self: true });
    }
  }

  // A receipt has two audiences with different meanings. The peer receives
  // the ordinary frame and turns its sent checkmark into read; the reader's
  // other sessions receive this account-local envelope and clear their roster
  // badge. Keeping it out of SELF_SYNC preserves the rule that control frames
  // are never rebroadcast as peer traffic.
  function syncRead(login, peer, id, readTs, readAt, excludeConn, via = '') {
    for (const target of presence.get(login) ?? []) {
      if (target === excludeConn || target.closed) continue;
      const payload = { k: 'read-sync', peer, id, readTs };
      if (readAt > 0) payload.readAt = readAt;
      if (via !== '') payload.via = via;
      send(target, payload);
    }
  }

  // A reaction is committed once, against the sender's conversation with
  // `toLogin`, but every one of the sender's own devices needs the tally to
  // change — not just the one that tapped the emoji. `broadcastWebEvent`
  // below already does this for browser sessions (any `webFeatures`
  // connection of either party). A native session — the CLI — never
  // declares `webFeatures` and was invisible to it, which is why a reaction
  // added from the browser never reached a CLI window open on that very
  // conversation. Mirrors `syncRead`: an account-local envelope to every one
  // of this login's own connections, kept off the `k:'frame'` channel
  // `selfSync` uses for msg/ai replay so it cannot be mistaken for one of
  // those, and off `SELF_SYNC` for the same reason AGENTS.md already states
  // for other control frames — a reaction is not a chat message, it must
  // never ride the channel that builds the transcript.
  function syncReact(login, peer, frame, excludeConn) {
    for (const target of presence.get(login) ?? []) {
      if (target === excludeConn || target.closed) continue;
      send(target, {
        k: 'react-sync', peer, id: frame.id, emoji: frame.emoji, by: frame.by, add: frame.add,
      });
    }
  }

  // Who is owed a feed pass, folded into one message per account per window.
  // The set holds logins rather than connections because the question "has
  // anything changed for this account" is per account; which of its sessions
  // asked for the nudge is decided when the timer fires, so a session that
  // authenticated inside the window is told too instead of waiting for its own
  // `ready`-time sync to be the last thing it ever did.
  const syncNudgePending = new Set();
  let syncNudgeTimer = null;

  function hasSyncNudgeSession(login) {
    for (const conn of presence.get(login) ?? []) {
      if (!conn.closed && conn.caps.includes(SYNC_NUDGE_CAP)) return true;
    }
    return false;
  }

  function flushSyncNudges() {
    syncNudgeTimer = null;
    const logins = [...syncNudgePending];
    syncNudgePending.clear();
    for (const login of logins) {
      // A session that went away between arming and firing is simply gone;
      // the account's remaining sessions still owe the pass.
      for (const conn of presence.get(login) ?? []) {
        if (conn.closed || !conn.caps.includes(SYNC_NUDGE_CAP)) continue;
        send(conn, { k: 'sync-nudge' });
      }
    }
  }

  /**
   * «Your account feed moved.» Sent after a durable mutation to each of the
   * accounts whose log gained an event — both sides of it, not just the session
   * that performed it and not just the peer's subscribed one.
   *
   * Deliberately empty of payload: `sync` already answers with everything since
   * a cursor, and a nudge that tried to name the mutation would be a second,
   * weaker copy of the feed. Nothing is armed for an account that has no
   * capable session, so a deployment whose clients all lack the capability pays
   * one `caps.includes` per mutation and no timer at all.
   */
  function nudgeSync(...logins) {
    let armed = false;
    for (const raw of logins) {
      const login = normalizeLogin(raw);
      if (!login || syncNudgePending.has(login)) continue;
      if (!hasSyncNudgeSession(login)) continue;
      syncNudgePending.add(login);
      armed = true;
    }
    if (armed && syncNudgeTimer === null) {
      syncNudgeTimer = setTimer(flushSyncNudges, SYNC_NUDGE_COALESCE_MS);
      // A pending nudge must never be the reason the process stays alive.
      syncNudgeTimer?.unref?.();
    }
  }

  function broadcastWebEvent(from, to, d, excludeConn) {
    for (const target of authorised) {
      if (!target.webFeatures || target.closed || target === excludeConn) continue;
      if (target.login !== from && target.login !== to) continue;
      send(target, { k: 'message-event', from: target.login === from ? to : from,
        self: target.login === from, d: frameForCaps(target.caps, d) });
    }
  }
  function normalizeButtons(value) {
    if (!Array.isArray(value)) return undefined;
    const buttons = [];
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const label = typeof item.label === 'string' ? item.label.trim() : '';
      const val = typeof item.value === 'string' ? item.value.trim() : '';
      if (id === '' || id.length > 40 || label === '' || label.length > 40 || val === '' || val.length > 200) continue;
      buttons.push({ id, label, value: val });
      if (buttons.length >= 8) break;
    }
    return buttons.length > 0 ? buttons : undefined;
  }


  // What a user message looks like in the store. Built before anything is
  // delivered, because on the relay path it is what the commit writes and the
  // receipt is read back from.
  function historyRecord(fromLogin, d) {
    const record = {
      id: typeof d.id === 'string' ? d.id : '',
      from: fromLogin,
      text: typeof d.text === 'string' ? d.text : '',
      ts: Number.isFinite(d.ts) ? d.ts : now(),
      kind: d.t === 'ai' ? 'ai' : 'human',
    };
    if (typeof d.name === 'string' && d.name !== '') record.author = d.name;
    else if (d.t === 'ai') record.author = 'tailik';
    if (d.image && typeof d.image === 'object') record.image = d.image;
    if (d.voice && typeof d.voice === 'object') record.voice = d.voice;
    if (d.reactions && typeof d.reactions === 'object') record.reactions = d.reactions;
    if (d.replyTo && typeof d.replyTo === 'object') record.replyTo = d.replyTo;
    if (d.forwardedFrom && typeof d.forwardedFrom === 'object') record.forwardedFrom = d.forwardedFrom;
    if (d.e2ee) record.e2ee = d.e2ee;
    if (isSealedEdit(d)) record.sealedEdit = true;
    const buttons = normalizeButtons(d.buttons);
    if (buttons) record.buttons = buttons;
    return record;
  }

  // The USER_MESSAGE_TYPES bookkeeping (history + live delivery + offline
  // queue) that both a person's own frame and a server-generated AI reply
  // need equally — the reply differs from a normal message only in *who*
  // it is from, never in how it reaches the other side.
  //
  // `committed` is the record a durable commit already wrote: a relayed
  // message is in the store before it is delivered, and writing it a second
  // time here would duplicate it.
  function deliverFrame(fromLogin, toLogin, d, excludeConn = null, committed = null) {
    if (USER_MESSAGE_TYPES.has(d.t) && !committed) {
      // Written on the way through, delivered or not: the browser client builds
      // its transcript from this and would otherwise show only what happened
      // while both sides were connected.
      store.recordHistory(fromLogin, toLogin, historyRecord(fromLogin, d));
    }

    let delivered = 0;
    const recipientConns = presence.get(toLogin) ?? [];
    const isSavedMessage = toLogin === fromLogin && USER_MESSAGE_TYPES.has(d.t);
    for (const target of recipientConns) {
      // Saved Messages: presence.get(toLogin) includes this very connection
      // when toLogin === fromLogin, and it already has its own optimistic
      // local echo — sending the frame back down the same socket would
      // duplicate it.
      if (CALL_SIGNAL.has(d.t)) {
        if (target === excludeConn || target.closed) continue;
        send(target, { k: 'frame', from: fromLogin, d });
        // Only a connection that announced `call-v1` counts as having
        // *taken* the offer. A browser tab (or any client without the
        // capability) is a live socket that can do nothing with a call, and
        // counting it made `delivered > 0`, which skipped both the hold and
        // the push — so a phone whose app was closed while the same account
        // had a tab open never rang at all, and the caller sat through the
        // full 45 seconds.
        if (target.caps.includes(CALL_CAP)) delivered += 1;
        continue;
      }
      if (target === excludeConn || target.closed || (!isSavedMessage && target.peer !== fromLogin)) {
        // A hello is the one frame the server never keeps for later
        // (QUEUEABLE excludes it on purpose: a greeting from an hour ago says
        // nothing true about now). But this is not "later" — it is now: the
        // peer is connected, just not yet subscribed to the sender, which is
        // the ordinary order when two clients start at the same moment or one
        // switches conversations. Their subscription is the only thing that
        // can make this hello useful, so hold one per connection (single
        // slot, newest wins) and hand it over the instant that subscription
        // happens (see `subscribe`). Without it the newer side sat with no
        // peer hello at all: never `online`, and the first words from the
        // other side held for the stand-in's grace period. Only the *sender*
        // is the same account as the excluded connection here (toLogin ===
        // fromLogin, Saved Messages), and a self-hello is never stashed.
        if (target !== excludeConn && !target.closed && d.t === 'hello' && toLogin !== fromLogin) {
          target.greeting = { from: fromLogin, d };
        }
        continue;
      }
      // Saved Messages arrives at another connection of the same account as a
      // self-sync. Web and CLI have no `from === self` fallback, so they need
      // the explicit flag Android already recognizes.
      send(target, toLogin === fromLogin
        ? { k: 'frame', from: fromLogin, d: frameForCaps(target.caps, d), self: true }
        : { k: 'frame', from: fromLogin, d: frameForCaps(target.caps, d) });
      delivered += 1;
    }

    if (CALL_SIGNAL.has(d.t)) {
      // A `restart` offer is a running call re-negotiating its media path
      // after an ICE failure (`CallController.onIceFailed`), not a new call
      // being placed. The peer's live engine takes it; nothing about a new
      // call may happen for it — no leg (there is no ring to abandon), no
      // held offer, no push. Ringing a phone that is already talking into
      // this very call is what the marker exists to prevent — and
      // `isCallRestartOffer` is what keeps that privilege to the calls this
      // server actually saw answered.
      const restartOffer = d.t === 'call-offer' && isCallRestartOffer(fromLogin, toLogin, d);
      if (d.t === 'call-offer' && !restartOffer && toLogin !== fromLogin) {
        // The previous leg, if any, is replaced rather than left to run out:
        // a second offer from the same login is a new ring, and the cancel
        // timer of the old one would judge it by the old one's state.
        dropOutgoingCallLeg(fromLogin);
        outgoingCallLegs.set(fromLogin, {
          to: toLogin,
          callId: callIdOf(d),
          at: now(),
          cancelTimer: null,
        });
        // Held whether or not anything received it, and whether or not a push
        // channel is configured: a device that reconnects on its own inside
        // the ring window needs the offer just as much as a woken one, and a
        // socket that took the write may still be a phone that never rang.
        dropPendingCallOffer(toLogin);
        const offer = { from: fromLogin, d, at: now(), pushed: false, ackTimer: null };
        pendingCallOffers.set(toLogin, offer);
        if (delivered === 0) {
          pushCallOffer(toLogin, offer);
        } else {
          // Something live took it; a push on top would ring a second time.
          // Unless no `call-ring` comes back, in which case that socket rang
          // nobody and the push is the only thing left that can.
          offer.ackTimer = setTimer(() => {
            offer.ackTimer = null;
            if (pendingCallOffers.get(toLogin) !== offer) return;
            if (now() - offer.at >= CALL_OFFER_HOLD_MS) return;
            pushCallOffer(toLogin, offer);
          }, CALL_RING_ACK_MS);
        }
      }
      // The callee's device is really ringing. The hold has done its job, and
      // keeping it would replay the same offer to that device on its next
      // reconnect — which its CallController answers with `busy`, killing the
      // ring that was already up.
      if (d.t === 'call-ring' || d.t === 'call-answer') {
        const mine = pendingCallOffers.get(fromLogin);
        if (mine && mine.from === toLogin) dropPendingCallOffer(fromLogin);
      }
      // The call is up. `call-answer` is the callee's own statement that the
      // phone was picked up, which is what makes the caller's leg stop being
      // "a ring left behind": from here the call's media path is
      // peer-to-peer, and the loss of the signalling socket is a transport
      // event, not the end of the conversation. Without this the first blip
      // on the caller's connection sent `call-end{hangup}` into the middle of
      // a live call.
      if (d.t === 'call-answer') {
        // The one record that lets this call re-negotiate later, and only for
        // a call this server actually has a ring leg for: an unsolicited
        // `call-answer` for a call nobody offered is a claim, not a call, and
        // must not buy the relay-only path a restart offer takes.
        if (dropOutgoingCallLeg(toLogin, { to: fromLogin, callId: callIdOf(d) })) {
          liveCallLegs.set(toLogin, { to: fromLogin, callId: callIdOf(d) });
        }
      }
      // The caller gave up (timeout, cancel) or the call was refused: a held
      // offer for that same call must not ring a phone that connects later,
      // and there is no longer a ring to cancel on anyone's behalf.
      if (d.t === 'call-end' || d.t === 'call-taken') {
        const held = pendingCallOffers.get(toLogin);
        if (held && held.from === fromLogin) dropPendingCallOffer(toLogin);
        const mine = pendingCallOffers.get(fromLogin);
        if (mine && mine.from === toLogin) dropPendingCallOffer(fromLogin);
        dropOutgoingCallLeg(fromLogin, { to: toLogin, callId: callIdOf(d) });
        dropOutgoingCallLeg(toLogin, { to: fromLogin, callId: callIdOf(d) });
        dropLiveCallLeg(fromLogin, { to: toLogin, callId: callIdOf(d) });
        dropLiveCallLeg(toLogin, { to: fromLogin, callId: callIdOf(d) });
      }
      return;
    }

    // An edit's carrier is not something that arrived: a web tab that counted
    // it would bump the badge and ring for a conversation whose last message
    // did not change (`lastMessage` skips it for the same reason).
    if (USER_MESSAGE_TYPES.has(d.t) && !isSealedEdit(d)) {
      for (const target of authorised) {
        if (!target.webFeatures || target.closed || target === excludeConn) continue;
        if (target.login !== fromLogin && target.login !== toLogin) continue;
        const peer = target.login === fromLogin ? toLogin : fromLogin;
        if (target.peer === peer) continue;
        send(target, { k: 'conversation-update', from: peer, self: target.login === fromLogin,
          last: store.lastMessage?.(target.login, peer) });
      }
    }
    if (SELF_SYNC.has(d.t) && toLogin !== fromLogin) selfSync(fromLogin, toLogin, d, excludeConn);

    // Offline queueing and the unread badge are genuinely about *this*
    // login having nothing live subscribed to the sender right now — a
    // second device that already saw the frame doesn't need it replayed on
    // reconnect. A push is a different question: another device having the
    // conversation open live says nothing about whether *this* device (the
    // one Web Push exists for) is closed. Gating push on `delivered === 0`
    // meant one open laptop tab silenced every other device's phone
    // permanently for that account — the queue is per-login, but a phone
    // being closed is per-device. Pushed unconditionally instead; the
    // service worker's own `push` handler is what decides whether to
    // actually show it, by asking any focused window if it's already
    // looking at this exact peer.
    if (delivered === 0 && QUEUEABLE.has(d.t)) {
      store.enqueue(toLogin, { from: fromLogin, d, at: now() });
      if (USER_MESSAGE_TYPES.has(d.t) && !isSealedEdit(d) && ((typeof d.text === 'string' && d.text !== '') || d.e2ee)) {
        // Absolute, not "+1": a client that was already showing N unread
        // from this sender must land on the real total after a queue replay
        // or reconnect, not accumulate its own increments on top of a
        // snapshot it never had. Computed once per delivery from the queue
        // this frame was just appended to, so every recipient connection
        // (there is normally exactly one) gets the same true count.
        const count = store.unreadCounts(toLogin)[fromLogin] ?? 0;
        for (const target of recipientConns) {
          if (target.closed || target.peer === fromLogin || target.webFeatures) continue;
          send(target, {
            k: 'unread',
            from: fromLogin,
            text: d.e2ee ? E2EE_STUB_TEXT : d.text,
            ts: Number.isFinite(d.ts) ? d.ts : now(),
            count,
          });
        }
      }
    }
    if (pushSender && USER_MESSAGE_TYPES.has(d.t) && !isSealedEdit(d)) {
      void pushSender.notify(toLogin, {
        // The recipient's own nickname for the sender (issue #28): the name on
        // the notification has to be the name in the app, or the same person
        // arrives under two different names in one glance.
        title: store.aliasOf?.(toLogin, fromLogin) || store.nameOf(fromLogin),
        body: pushPreview(d),
        peer: fromLogin,
        messageId: d.id,
        tag: `tailchat-msg-${fromLogin}`,
      }).catch(() => {});
    }
  }

  // The one path by which the server itself, rather than one of its clients,
  // puts a message into somebody's conversation: the release announcement
  // from the official account (see `service-account.js`). Routed through
  // `deliverFrame` so it is recorded, handed live to a session watching that
  // thread and queued for one that is not — exactly like a message from a
  // person, because that is what it is to whoever receives it.
  function sendServiceMessage(toLogin, { text, id, ts, buttons } = {}) {
    const to = normalizeLogin(toLogin);
    const body = typeof text === 'string' ? text : '';
    // Nothing to say, nobody to say it to, or the account talking to itself:
    // Saved Messages belongs to the person who owns it.
    if (to === '' || to === SERVICE_LOGIN || body === '') return false;
    const frame = {
      t: 'msg',
      id: typeof id === 'string' && id !== '' ? id : idFactory(),
      text: body,
      ts: Number.isFinite(ts) ? ts : now(),
    };
    // The same inline buttons a bot's message carries (`normalizeButtons`),
    // which is what makes the service account answerable instead of merely
    // readable: both clients already render them on the message itself.
    const normalized = normalizeButtons(buttons);
    if (normalized) frame.buttons = normalized;
    deliverFrame(SERVICE_LOGIN, to, frame);
    // A message from the deployment's own account is a durable mutation like
    // any other: the recipient's sessions that are not watching this thread
    // still owe the copy.
    nudgeSync(to);
    return true;
  }

  // A reply is fired after the human message it answers is already on its
  // way: a slow or failed provider call must never delay that delivery, and
  // `maybeRespond` never throws (see ai-bridge.js), so nothing here can crash
  // the hub — the `.catch` is a second line of defence, not the only one.
  // Tells whoever is waiting that the assistant is composing. A terminal
  // announces this itself while it thinks; the bridge answers with nobody's
  // terminal involved, so without this the web client sat in silence for the
  // whole round trip — and a command-backed answer takes long enough that
  // silence reads as nothing happening.
  function announceAiTyping(fromLogin, toLogin, state) {
    const name = aiBridge?.name || 'tailik';
    const frame = { t: 'typing', state, name };
    // The assistant's own thread: there is no session behind AI_LOGIN, so the
    // indicator belongs on the asker's own screen, signed by the assistant.
    if (toLogin === AI_LOGIN) {
      for (const target of presence.get(fromLogin) ?? []) {
        if (target.closed || target.peer !== AI_LOGIN) continue;
        send(target, { k: 'frame', from: AI_LOGIN, d: frame });
      }
      return;
    }
    for (const target of presence.get(toLogin) ?? []) {
      if (target.closed || target.peer !== fromLogin) continue;
      send(target, { k: 'frame', from: fromLogin, d: frame });
    }
    // And the asker's own other devices, which are watching the same
    // conversation from the other side of it.
    selfSync(fromLogin, toLogin, frame);
  }

  // Live «печатает…» leases, keyed by the conversation the assistant is
  // composing in. A client drops the indicator after a few seconds of
  // silence, so a long answer has to keep saying so; the lease is what
  // guarantees the saying stops — exactly once — when the answer arrives,
  // fails, or the account it was for goes away.
  const aiTyping = new Map();

  function armAiTyping(key, fromLogin, toLogin) {
    const handle = setTimer(() => {
      if (aiTyping.get(key) === undefined) return;
      announceAiTyping(fromLogin, toLogin, 'start');
      armAiTyping(key, fromLogin, toLogin);
    }, AI_TYPING_RENEW_MS);
    aiTyping.set(key, handle);
  }

  function startAiTyping(fromLogin, toLogin) {
    const key = `${fromLogin}|${toLogin}`;
    if (aiTyping.has(key)) return;
    announceAiTyping(fromLogin, toLogin, 'start');
    armAiTyping(key, fromLogin, toLogin);
  }

  function stopAiTyping(fromLogin, toLogin) {
    const key = `${fromLogin}|${toLogin}`;
    if (!aiTyping.has(key)) return;
    clearTimer(aiTyping.get(key));
    aiTyping.delete(key);
    announceAiTyping(fromLogin, toLogin, 'stop');
  }

  // Nobody left to tell. The renewal must not survive the conversation it
  // belongs to: a timer re-arming itself for a departed account would keep
  // the process awake and announce to no one for as long as the answer takes.
  function stopAiTypingFor(login) {
    for (const key of [...aiTyping.keys()]) {
      const [fromLogin, toLogin] = key.split('|');
      if (fromLogin === login || toLogin === login) stopAiTyping(fromLogin, toLogin);
    }
  }

  function maybeAnswer(fromLogin, toLogin, d) {
    if (!aiBridge || d.t !== 'msg') return;
    void aiBridge.maybeRespond({
      from: fromLogin,
      to: toLogin,
      text: typeof d.text === 'string' ? d.text : '',
      replyTo: d.replyTo && typeof d.replyTo === 'object' ? d.replyTo : null,
      // The claim only counts for the conversation this message belongs to,
      // so each side is checked against its counterpart in *this* thread.
      isAiCapable: (login) => ownsAnswering(
        login,
        normalizeLogin(login) === normalizeLogin(fromLogin) ? toLogin : fromLogin,
      ),
      // Called by the bridge once it has decided it *is* going to answer, so a
      // message it declines never produces a phantom «печатает…».
      onAccepted: () => startAiTyping(fromLogin, toLogin),
    }).then((reply) => {
      stopAiTyping(fromLogin, toLogin);
      if (!reply) return;
      const frame = {
        t: 'ai', id: idFactory(), text: reply.text, ts: now(),
      };
      // Carried through so `record.author` below, and every client that reads
      // the frame, names the model rather than the account it was sent under.
      if (typeof reply.name === 'string' && reply.name !== '') frame.name = reply.name;
      deliverFrame(reply.from, reply.to, frame);
    }).catch(() => {
      stopAiTyping(fromLogin, toLogin);
    });
  }

  /**
   * The service account's own inbound path, symmetric with [maybeAnswer]: the
   * person's message is already committed and delivered by the time this
   * runs, so a slow — or broken — handler can only ever delay the answer, not
   * the message it answers.
   *
   * Everything the bot decides comes back as plain messages, which is why it
   * knows nothing about connections, queues or the hub: `sendServiceMessage`
   * is the one door the server itself speaks through, and the bot is a pure
   * function of «кто написал и что» on the other side of it.
   */
  function maybeServe(fromLogin, toLogin, d) {
    if (!serviceBot || d.t !== 'msg') return;
    if (normalizeLogin(toLogin) !== SERVICE_LOGIN) return;
    void Promise.resolve(serviceBot.handle({
      from: normalizeLogin(fromLogin),
      text: typeof d.text === 'string' ? d.text : '',
    })).then((replies) => {
      let roster = false;
      for (const reply of replies ?? []) {
        if (!reply) continue;
        sendServiceMessage(reply.to ?? fromLogin, reply);
        roster = roster || reply.roster === true;
      }
      // A button that accepted a friend request changed both rosters, and no
      // HTTP handler ran to say so — without this the new contact showed up
      // only after a reconnect.
      if (roster) broadcastUsers();
    }).catch(() => {});
  }

  /**
   * Confirms that a non-message mutation reached the synchronous store
   * boundary. `opId` belongs to the client operation, while `id` is the
   * affected message; keeping both avoids conflating two queued reactions on
   * the same message. Legacy clients never declare the capability and see no
   * new frame.
   */
  function acceptOperation(conn, peer, opKind, id, opId) {
    if (!conn.caps.includes('op-ack-v1')) return;
    const accepted = { k: 'op-accepted', peer, opKind, id };
    if (typeof opId === 'string' && opId !== '') accepted.opId = opId;
    send(conn, accepted);
  }

  async function relay(conn, payload) {
    // The subscription is the conversation: it was checked against the store
    // when it was made, so routing a frame aimed at it needs no lookup. A
    // client that says it can address a frame itself is taken at its word for
    // any thread it is actually entitled to — that is what lets one socket
    // drain a queue spanning several conversations instead of resubscribing
    // between every message. Without the capability nothing changes: a frame
    // aimed anywhere but the subscription is still a client bug.
    const to = normalizeLogin(payload.to);
    if (to !== conn.peer && !(conn.caps.includes('addressed-send') && (to === conn.login || store.areFriends(conn.login, to)))) {
      fail(conn, 'not_subscribed', MESSAGES.not_subscribed);
      return;
    }
    // Either side having blocked the other stops every live frame between
    // them — msg/ai, typing/focus, read/react/edit/del alike — while leaving
    // `subscribe` and `/api/history` alone, so the existing conversation
    // stays readable and only *new* traffic is cut off.
    if (store.hasBlocked(conn.login, to) || store.hasBlocked(to, conn.login)) {
      fail(conn, 'blocked', MESSAGES.blocked);
      return;
    }
    // A contact either side deleted is cut both ways, like a block — and, also
    // like a block, only for new live traffic: the shared history and the other
    // side's roster are untouched. Answered as a missing contact, which is all
    // the sender can be told: the peer must not learn that they were deleted
    // rather than merely unreachable.
    if (store.isRemoved(to, conn.login) || store.isRemoved(conn.login, to)) {
      fail(conn, 'peer_not_found', MESSAGES.peer_not_found);
      return;
    }

    const d = payload.d;
    if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.t !== 'string') return;
    let frameChars;
    try {
      frameChars = JSON.stringify(d).length;
    } catch {
      return;
    }
    if (frameChars > (d.e2ee ? CLOUD_E2EE_FRAME_MAX_CHARS : CLOUD_FRAME_MAX_CHARS)) {
      fail(conn, 'frame_too_large', MESSAGES.frame_too_large);
      return;
    }

    // Only now, for a frame the hub will actually act on, is the budget
    // charged — see [chargeFrame] for what happens when it is spent. The type
    // is recorded first so the log line can name what the sender was doing.
    conn.lastFrameType = d.t;
    if (!chargeFrame(conn)) return;

    // One shared clock decides the order of a conversation (see
    // CLOCK_SKEW_TOLERANCE_MS). Applied before anything reads `d.ts`, so the
    // stored record, the live frame, the self-sync copy and the push preview
    // all carry the same corrected time.
    if (USER_MESSAGE_TYPES.has(d.t)) {
      const at = now();
      const claimed = Number.isFinite(d.ts) ? d.ts : at;
      d.ts = Math.abs(claimed - at) > CLOCK_SKEW_TOLERANCE_MS ? at : claimed;
    }

    // `caps.ai` says "this client currently has AI configured" — a property of
    // the client, not of the peer the frame happens to be en route to, so it
    // is recorded regardless of `d.t`. Which *conversations* the claim covers
    // is decided by `ownsAnswering` from live subscriptions instead.
    if (d.t === 'caps' && typeof d.ai === 'boolean') {
      aiCapable.set(conn.login, d.ai);
      aiCapableLostAt.delete(conn.login);
    }

    // A bot says what it is: the `hello` a bot's own socket sends carries
    // `v: 'bot'` (`bots/client.mjs:205`), and this is the one place that sees
    // every frame on its way to a peer. Recorded against the *sender* — the
    // side receiving the greeting learns nothing — because it is a fact about
    // the account, and the roster marks it from then on.
    if (d.t === 'hello' && d.v === 'bot' && store.markBot?.(conn.login)) broadcastUsers();

    // The terminal already announces its focus as an inner frame the peer
    // renders itself; reading it here is what makes a CLI session part of the
    // same presence aggregate without a second protocol. The frame is still
    // relayed below — the peer's own «читает/отошёл» line depends on it.
    if (d.t === 'focus' && typeof d.state === 'string') setConnState(conn, d.state);

    // An ack is what the ✓✓ rung is made of: the reader's *device* has taken
    // custody of a message, one rung above the ✓ that only says the server
    // committed it. The server is the only bookkeeper of that — an ack sent
    // over a peer-to-peer channel reaches nobody else — so it is recorded here
    // for the author's rebuilt transcript, and the frame still falls through to
    // the relay below so every subscribed session of the author receives it
    // with the watermark attached.
    if (d.t === 'ack' && typeof d.id === 'string') {
      try {
        await store.markDelivered?.(conn.login, to, d.id);
      } catch {
        return;
      }
      const deliveredTs = store.deliveredTs?.(conn.login, to) ?? 0;
      if (deliveredTs > 0) d.deliveredTs = deliveredTs;
    }

    // A read receipt is remembered, not just relayed: the author's own client
    // rebuilds its transcript from `/api/history` on every reload, and with
    // nothing stored every already-read message came back showing one ✓.
    // Other sessions of the reader need a separate account-local signal:
    // otherwise their roster keeps a stale unread badge until a reload.
    if (d.t === 'read' && typeof d.id === 'string') {
      const kind = clientKind(conn);
      const before = store.readTs?.(conn.login, to) ?? 0;
      let readTs;
      try {
        readTs = await store.markRead(conn.login, to, d.id, kind);
      } catch {
        return;
      }
      if (readTs > before) noteReadAdvance(conn, to, readTs);
      const readAt = store.readAt?.(conn.login, to) || 0;
      if (readAt > 0) d.readAt = readAt;
      // Which client read it, on the same watermark the two claims above
      // describe: the author's transcript is rebuilt from `/api/history` and the
      // durable feed on reload, and «прочитано с телефона» is a fact about *this*
      // advance, so it travels with the frame that carries it (the same value
      // the store keeps for the reload path).
      const readVia = store.readVia?.(conn.login, to) || '';
      if (readVia !== '') d.via = readVia;
      // A receipt is a watermark, not a statement about one bubble: nobody can
      // read the newest message without having read everything above it. `id`
      // alone left a client that missed an earlier receipt (a socket swap, the
      // paced queue) with one ✓✓ on the read message and a run of older ones
      // still on ✓, which is why the author's transcript had to be reloaded
      // before it agreed with the reader's. `readTs` is the same number the
      // durable feed carries, so live, `read-sync` and HTTP history can be
      // applied by one rule instead of three.
      if (readTs > 0) d.readTs = readTs;
      syncRead(conn.login, to, d.id, readTs, readAt, conn, readVia);
      // The reader's own devices already heard through `syncRead`; the author's
      // other devices — the phone that was not subscribed to this conversation,
      // the second tab — learn through the feed that their outgoing messages
      // have been read.
      nudgeSync(to);
      // The sender's own receipt was never confirmed before this capability:
      // `syncRead` deliberately excludes `conn` because it is the *other*
      // sessions of this account that need the roster badge cleared. A client
      // that declared `read-ack-v1` gets this instead, so it can stop trusting
      // "the socket accepted the frame" as proof the server actually applied it.
      if (conn.caps.includes('read-ack-v1')) {
        const accepted = { k: 'read-accepted', peer: to, id: d.id, readTs };
        if (readAt > 0) accepted.readAt = readAt;
        if (readVia !== '') accepted.via = readVia;
        send(conn, accepted);
      }
      broadcastUsers();
    }

    if (d.t === 'call-offer' && !isCallRestartOffer(conn.login, to, d)) {
      const key = `${conn.login}|${to}`;
      const at = now();
      const recent = (callOffers.get(key) ?? []).filter((ts) => at - ts < CALL_OFFER_WINDOW_MS);
      if (recent.length >= CALL_OFFER_LIMIT) {
        callOffers.set(key, recent);
        fail(conn, 'too_many_calls', MESSAGES.too_many_calls);
        return;
      }
      recent.push(at);
      callOffers.set(key, recent);
    }

    if (d.t === 'del') {
      const ids = Array.isArray(d.ids)
        ? d.ids.filter((id) => typeof id === 'string' && id !== '').slice(0, DEL_MAX_IDS)
        : [];
      if (ids.length === 0) return;
      // Rebuilt rather than forwarded: the peer and the sender's own other
      // sessions must apply exactly the ids the store was told to forget.
      const scope = d.scope === 'self' ? 'self' : 'all';
      const frame = { t: 'del', ids, scope };
      if (scope === 'self') {
        // «Удалить у себя»: the peer keeps its copy and is told nothing, so
        // only this account's other devices need to catch up.
        void commitHide(conn, to, ids, frame, d.opId);
        return;
      }
      frame.tombstone = true;
      void commitDelete(conn, to, ids, frame, d.opId);
      return;
    }

    if (d.t === 'edit') {
      const id = typeof d.id === 'string' ? d.id : '';
      const text = typeof d.text === 'string' ? d.text : '';
      void commitEdit(conn, to, id, text, d.opId);
      return;
    }

    if (d.t === 'react') {
      const id = typeof d.id === 'string' ? d.id : '';
      const emoji = typeof d.emoji === 'string' ? d.emoji : '';
      const add = d.add !== false;
      void commitReact(conn, to, id, emoji, add, d.opId);
      return;
    }

    if (USER_MESSAGE_TYPES.has(d.t)) {
      // An encrypted message: a well-formed envelope, nothing it encrypts in
      // the clear beside it, from a session that registered the device the
      // envelope names. The server cannot check more than that — and must
      // not let a client bug leak what it meant to encrypt.
      if (d.e2ee !== undefined) {
        const envelope = normalizeEnvelope(d.e2ee);
        const device = store.e2eeDeviceForTokenKey?.(conn.tokenKey) ?? null;
        if (!envelope || carriesPlainContent(d) || !conn.caps.includes(E2EE_CAP) || envelope.dev !== device) {
          send(conn, { k: 'error', code: 'bad_envelope', peer: to, id: typeof d.id === 'string' ? d.id : '', message: MESSAGES.bad_envelope });
          return;
        }
        d.e2ee = envelope;
        delete d.text;
      }
      // Only `true` beside an envelope is the flag; anything else is dropped
      // rather than carried into the store and every recipient's queue.
      if (d.sealedEdit !== undefined && !isSealedEdit(d)) delete d.sealedEdit;
      const stored = typeof d.id === 'string' && d.id !== ''
        ? store.findHistoryMessage?.(conn.login, to, d.id, conn.login) ?? null
        : null;
      if (stored) {
        // A retry of a message whose receipt never made it back. The receipt
        // is rebuilt from what was stored, not from the frame in hand: the
        // sender must end up with the timestamp everybody else already has.
        if (sameMessage(stored, d)) {
          send(conn, { k: 'message-accepted', peer: to, id: stored.id, ts: stored.ts, seq: stored.seq });
        } else {
          // The same id for different words is not a retry; answering it would
          // silently drop one of the two messages.
          send(conn, { k: 'error', code: 'message_id_conflict', peer: to, id: d.id, message: MESSAGES.message_id_conflict });
        }
        return;
      }
      void commitAndDeliver(conn, to, d);
      return;
    }

    deliverFrame(conn.login, to, d, conn);
  }

  // Nothing happens on the strength of a message the store has not taken:
  // no delivery, no queueing, no receipt, no AI. A rejected commit leaves the
  // message the sender's, under the same id, to send again.
  async function commitAndDeliver(conn, to, d) {
    const record = historyRecord(conn.login, d);
    let committed = null;
    try {
      committed = (await store.commitHistory(conn.login, to, record)) ?? record;
    } catch {
      send(conn, {
        k: 'error',
        code: 'store_failed',
        peer: to,
        id: record.id,
        message: MESSAGES.store_failed,
      });
      return;
    }

    d.ts = committed.ts;
    deliverFrame(conn.login, to, d, conn, committed);
    if (committed.id !== '') {
      send(conn, { k: 'message-accepted', peer: to, id: committed.id, ts: committed.ts, seq: committed.seq });
    }
    // Both accounts' feeds gained an event: the sender's own other devices owe
    // the copy of their own message just as much as the recipient owes the
    // message itself.
    nudgeSync(conn.login, to);
    maybeAnswer(conn.login, to, d);
    maybeServe(conn.login, to, d);
  }

  // A store failure here (disk full, journal closed mid-shutdown) leaves the
  // mutation unacknowledged and undelivered rather than pretending it landed:
  // the client's own pending-operation lease times out and retries, exactly
  // as it already does for a lost `op-accepted` frame.
  async function commitHide(conn, to, ids, frame, opId) {
    try {
      await store.hideHistory(conn.login, to, ids);
    } catch {
      return;
    }
    acceptOperation(conn, to, 'delete', ids[0], opId);
    selfSync(conn.login, to, frame, conn);
    // «Удалить у себя» is this account's own business — the peer is told
    // nothing — but this account's other devices still owe the hide.
    nudgeSync(conn.login);
  }

  async function commitDelete(conn, to, ids, frame, opId) {
    let accepted;
    try {
      accepted = await store.deleteHistory(conn.login, to, ids);
    } catch {
      return;
    }
    if (!Array.isArray(accepted) || accepted.length === 0) return;
    frame.ids = accepted;
    acceptOperation(conn, to, 'delete', accepted[0], opId);
    deliverFrame(conn.login, to, frame, conn);
    broadcastWebEvent(conn.login, to, frame, conn);
    selfSync(conn.login, to, frame, conn);
    nudgeSync(conn.login, to);
    broadcastUsers();
  }

  async function commitEdit(conn, to, id, text, opId) {
    let record = null;
    try {
      record = await store.editHistory?.(conn.login, to, id, conn.login, text);
    } catch {
      return;
    }
    if (!record) return;
    const frame = { t: 'edit', id: record.id, text: record.text, editedAt: record.editedAt };
    acceptOperation(conn, to, 'edit', record.id, opId);
    deliverFrame(conn.login, to, frame, conn);
    broadcastWebEvent(conn.login, to, frame, conn);
    selfSync(conn.login, to, frame, conn);
    nudgeSync(conn.login, to);
    broadcastUsers();
  }

  async function commitReact(conn, to, id, emoji, add, opId) {
    let record = null;
    try {
      record = await store.reactHistory?.(conn.login, to, id, conn.login, emoji, add);
    } catch {
      return;
    }
    if (!record) return;
    const frame = { t: 'react', id: record.id, emoji, by: conn.login, add };
    acceptOperation(conn, to, 'react', record.id, opId);
    deliverFrame(conn.login, to, frame, conn);
    broadcastWebEvent(conn.login, to, frame, conn);
    syncReact(conn.login, to, frame, conn);
    nudgeSync(conn.login, to);
    broadcastUsers();
  }

  async function receive(conn, payload) {
    if (conn.closed) return;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;

    if (!conn.login) {
      if (payload.k === 'auth') {
        conn.webFeatures = payload.webFeatures === true;
        // What the *client* implements. An old client sends none, and every
        // capability-gated behaviour below stays off for it.
        conn.caps = Array.isArray(payload.caps)
          ? payload.caps.filter((cap) => typeof cap === 'string')
          : [];
        // The build the app is running, when it reports one: the Android
        // client sends its `versionCode` here. Read as a positive integer and
        // kept on the connection, because it is used once, in `authenticate`,
        // to answer a build that has user-facing notes with a single message
        // about itself — see `announceAppBuild`.
        const appVersion = Math.floor(Number(payload.appVersion));
        conn.appBuild = Number.isFinite(appVersion) && appVersion > 0 ? appVersion : 0;
        authenticate(conn, payload.token);
      } else fail(conn, 'auth_required', MESSAGES.auth_required);
      return;
    }

    if (payload.k === 'reaction-read' && (conn.webFeatures || conn.caps.includes('reaction-read-v1'))) {
      const peer = normalizeLogin(payload.peer);
      if (!store.areFriends(conn.login, peer)) return;
      store.readReactionEvents?.(conn.login, peer, payload.ids);
      broadcastUsers();
      return;
    }
    // «Отметить прочитанным»: the explicit way out of an unread badge that
    // nothing on screen can clear — a reaction on a message that has scrolled
    // out of the loaded page, or a queued frame whose conversation the reader
    // does not intend to open.
    if (payload.k === 'mark-read') {
      const peer = normalizeLogin(payload.peer);
      if (peer !== conn.login && !store.areFriends(conn.login, peer)) return;
      const kind = clientKind(conn);
      const before = store.readTs?.(conn.login, peer) ?? 0;
      let readTs;
      try {
        readTs = await store.markConversationRead?.(conn.login, peer, kind) ?? 0;
      } catch {
        return;
      }
      if (readTs > before) noteReadAdvance(conn, peer, readTs);
      const readAt = store.readAt?.(conn.login, peer) || 0;
      const readVia = store.readVia?.(conn.login, peer) || '';
      // This account's other sessions drop the badge; the peer's own sent
      // checkmarks are turned around by the ordinary receipt frame, which is
      // only worth sending when the newest message in the thread is theirs.
      syncRead(conn.login, peer, '', readTs, readAt, conn, readVia);
      const last = store.lastMessage?.(conn.login, peer);
      if (last && last.from === peer && peer !== conn.login) {
        const receipt = { t: 'read', id: last.id };
        if (readAt > 0) receipt.readAt = readAt;
        if (readVia !== '') receipt.via = readVia;
        // Same watermark rule as a per-message receipt: the peer's transcript
        // advances everything up to `readTs`, not only this one bubble.
        if (readTs > 0) receipt.readTs = readTs;
        for (const target of presence.get(peer) ?? []) {
          if (target.closed || target.peer !== conn.login) continue;
          send(target, { k: 'frame', from: conn.login, d: receipt });
        }
        // Only the peer's subscribed sessions got the frame above; the rest of
        // that account's devices learn from their feed.
        nudgeSync(peer);
      }
      if (conn.caps.includes('read-ack-v1')) {
        const accepted = { k: 'read-accepted', peer, id: null, readTs };
        if (readAt > 0) accepted.readAt = readAt;
        if (readVia !== '') accepted.via = readVia;
        send(conn, accepted);
      }
      broadcastUsers();
      return;
    }
    if (payload.k === 'mark-unread') {
      const peer = normalizeLogin(payload.peer);
      if (peer === conn.login || !store.areFriends(conn.login, peer)) return;
      if (!store.markConversationUnread?.(conn.login, peer)) return;
      send(conn, { k: 'mark-unread-accepted', peer });
      broadcastUsers();
      return;
    }
    if (payload.k === 'reply-reminder') {
      const peer = normalizeLogin(payload.peer);
      if (peer === conn.login || !store.areFriends(conn.login, peer)) return;
      const reminder = store.scheduleReplyReminder?.(conn.login, peer, payload.messageId, payload.dueAt);
      if (!reminder) {
        fail(conn, 'invalid_reminder', 'Не удалось создать напоминание.');
        return;
      }
      send(conn, { k: 'reply-reminder-set', reminder });
      // Every other connection of the owner too: the person's tablet and
      // browser tab show the same transcript, and the mark belongs to the
      // message rather than to the device that chose the time. Reconnects get
      // the pending set anyway (`authenticate`), so a client that misses this
      // frame is only late, never wrong.
      for (const target of presence.get(conn.login) ?? []) {
        if (target !== conn) send(target, { k: 'reply-reminder-set', reminder });
      }
      armReplyReminders();
      return;
    }
    if (payload.k === 'reply-reminder-ack') {
      if (store.ackReplyReminder?.(conn.login, payload.id)) {
        send(conn, { k: 'reply-reminder-acked', id: payload.id });
      }
      return;
    }
    // Resumable sync: what this account missed while it was away. Not rate
    // limited, like `who` — a client reconnecting after a long absence pages
    // through its log as fast as it can read it, and throttling that would
    // leave it half caught up.
    if (payload.k === 'sync') {
      const page = store.eventsSince?.(conn.login, payload.since, payload.limit)
        ?? { events: [], cursor: 0, more: false, reset: false };
      send(conn, {
        k: 'sync-page',
        events: page.events,
        cursor: page.cursor,
        more: page.more,
        reset: page.reset,
      });
      return;
    }
    // End-to-end encryption key traffic (E2EE spec §4.4): held per device, on
    // disk, until that device says it has it. Charged against the frame
    // budget like a message — it is written to disk the same way.
    if (payload.k === 'to-device') {
      conn.lastFrameType = 'to-device';
      if (!chargeFrame(conn)) return;
      await sendToDevice(conn, payload);
      return;
    }
    if (payload.k === 'to-device-ack') {
      await ackToDevice(conn, payload);
      return;
    }
    if (payload.k === 'subscribe') {
      const peer = typeof payload.peer === 'string' ? payload.peer.trim() : '';
      if (peer === '') unsubscribe(conn);
      else subscribe(conn, peer);
    }
    else if (payload.k === 'frame') await relay(conn, payload);
    else if (payload.k === 'who') send(conn, { k: 'users', users: usersFor(conn) });
    // Not rate-limited, like `who`: a browser tab reports this on every focus
    // change and idle timeout, and losing those to the frame budget would
    // freeze the account's state at whatever it was when the burst started.
    else if (payload.k === 'state') setConnState(conn, payload.state);
    else fail(conn, 'unknown_action', MESSAGES.unknown_action);
  }
  function broadcastProfile(user) {
    const login = normalizeLogin(user?.login);
    if (!login || typeof user?.name !== 'string') return;
    const self = publicSelf(login, user);
    for (const conn of presence.get(login) ?? []) {
      send(conn, { k: 'profile', user: self });
    }
    broadcastUsers();
  }

  // A nickname this account just gave a contact (issue #28). Private, unlike
  // `broadcastProfile`: only the owner's own sessions are owed the roster the
  // name appears in, and the peer is never told — that is what makes it a
  // nickname rather than a rename. Sent straight rather than through
  // `broadcastUsers`' coalescing, because this is a deliberate tap: the row has
  // to change under the finger that made it, and there is exactly one account
  // to rebuild for.
  function broadcastAliases(loginReference) {
    const login = normalizeLogin(loginReference);
    for (const conn of presence.get(login) ?? []) {
      if (conn.closed) continue;
      send(conn, { k: 'users', users: usersFor(conn) });
    }
  }

  async function sendToDevice(conn, payload) {
    const id = typeof payload.id === 'string' && payload.id !== '' && payload.id.length <= 128 ? payload.id : null;
    const refuse = (code) => send(conn, {
      k: 'error', code, ...(id ? { id } : {}), message: MESSAGES[code] ?? MESSAGES.unknown_action,
    });
    // An older client never sends this; one that does without the capability
    // is answered exactly as before the capability existed.
    if (!conn.caps.includes(E2EE_CAP)) {
      refuse('unknown_action');
      return;
    }
    const fromDevice = store.e2eeDeviceForTokenKey?.(conn.tokenKey) ?? null;
    if (!fromDevice) {
      refuse('device_required');
      return;
    }
    const to = normalizeLogin(payload.to);
    if (to !== conn.login && (store.hasBlocked(conn.login, to) || store.hasBlocked(to, conn.login))) {
      refuse('blocked');
      return;
    }
    if (to !== conn.login && (store.isRemoved(to, conn.login) || store.isRemoved(conn.login, to))) {
      refuse('peer_not_found');
      return;
    }
    let result;
    try {
      result = await store.e2eeSend(conn.login, fromDevice, to, payload.device, payload.body);
    } catch {
      refuse('store_failed');
      return;
    }
    if (!result.ok) {
      refuse(result.code);
      return;
    }
    if (id) send(conn, { k: 'to-device-accepted', id, seq: result.item.seq });
    for (const target of presence.get(to) ?? []) {
      if (target.closed || !target.caps.includes(E2EE_CAP)) continue;
      if (store.e2eeDeviceForTokenKey?.(target.tokenKey) !== payload.device) continue;
      send(target, { k: 'to-device', ...result.item });
    }
  }

  async function ackToDevice(conn, payload) {
    if (!conn.caps.includes(E2EE_CAP) || !Number.isFinite(payload.seq)) return;
    const device = store.e2eeDeviceForTokenKey?.(conn.tokenKey) ?? null;
    if (!device) return;
    try {
      await store.e2eeAck(conn.login, device, payload.seq);
    } catch {
      // Nothing is lost: the items stay held and come again on the next auth.
    }
  }

  // Somebody's set of devices — or of sessions that cannot read — changed:
  // their own sessions and their friends' have to re-query before they next
  // encrypt to them (E2EE spec §4.3). Only sessions that can do anything with
  // it are told.
  function deviceListChanged(loginReference) {
    const login = normalizeLogin(loginReference);
    if (!login) return;
    const audience = [login, ...(store.friends?.(login) ?? []).map((friend) => friend.login)];
    for (const owner of audience) {
      for (const conn of presence.get(owner) ?? []) {
        if (conn.closed || !conn.caps.includes(E2EE_CAP)) continue;
        send(conn, { k: 'device-list-changed', login });
      }
    }
  }


  // Whom an account vouches for changed (`/api/e2ee/trust`): its own sessions
  // re-read their keys and adopt it. Nobody else reads it, so nobody else is
  // told — not even the account's friends.
  function trustChanged(loginReference) {
    const login = normalizeLogin(loginReference);
    if (!login) return;
    for (const conn of presence.get(login) ?? []) {
      if (conn.closed || !conn.caps.includes(E2EE_CAP)) continue;
      send(conn, { k: 'device-list-changed', login });
    }
  }

  function connect(sendPayload, { close } = {}) {
    const conn = {
      id: idFactory(),
      login: null,
      peer: null,
      // A client that never reports is taken at its best: a terminal from an
      // older release is present, not absent.
      state: 'active',
      send: sendPayload,
      requestClose: close,
      closed: false,
      gone: false,
      authPending: false,
      authTimer: null,
      windowStart: 0,
      frames: 0,
      // Rate-limit state — see chargeFrame: whether the window in progress has
      // overflowed, the window the last strike was counted in, and how many
      // consecutive windows have overflowed.
      windowOver: false,
      strikeWindow: 0,
      rateStrikes: 0,
      // Whether this window's overage has already written its one log line, and
      // what the sender was doing when it happened — see `noteRateLimit`.
      windowOverNoted: false,
      lastFrameType: null,
      // Filled in by `auth`; until then the connection claims nothing.
      caps: [],
      // The digest of this session's token, set by `auth` (see `authenticate`).
      tokenKey: null,
    };

    conn.authTimer = setTimer(() => {
      conn.authTimer = null;
      if (conn.login || conn.gone) return;
      fail(conn, 'auth_failed', MESSAGES.auth_timeout);
      disconnect(conn, AUTH_FAILED_CODE);
    }, authTimeoutMs);

    return {
      id: conn.id,
      login: () => conn.login,
      receive: (payload) => receive(conn, payload),
      close: () => teardown(conn),
    };
  }

  armReplyReminders();

  return {
    connect, onlineLogins, isOnline, stateOf: stateFor, broadcastUsers, broadcastProfile,
    broadcastAliases, sendServiceMessage, deviceListChanged, trustChanged, close,
  };
}
