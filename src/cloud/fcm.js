import { readCloudSidecar } from './storage-crypto.js';
import { initializeApp, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

// The Firebase Admin service-account key: generated once through the
// Firebase console (Project settings -> Service accounts -> Generate new
// private key), dropped next to `vapid_key.json` in the same data
// directory. Unlike `loadOrCreateVapidKeys`, this cannot be minted by the
// server itself — it identifies this deployment to Google's own project,
// not a keypair this process owns. Its absence disables FCM sending
// entirely; nothing here creates or writes this file.
export function loadFcmServiceAccount(dir, cipher) {
  try {
    const parsed = JSON.parse(readCloudSidecar(dir, 'fcm_service_account.json', cipher));
    if (parsed && typeof parsed.project_id === 'string' && typeof parsed.private_key === 'string') return parsed;
    throw new Error('Invalid FCM service account');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

// How long FCM may keep trying to deliver a call wake-up, in milliseconds
// (`AndroidConfig.ttl`). Kept equal to the hub's `CALL_OFFER_HOLD_MS`: past
// it there is no held offer left to collect.
const CALL_PUSH_TTL_MS = 45_000;

// Mirrors `createPushSender` in `push.js`: same disabled-without-credentials
// contract, same "queued after delivery, never awaited by the caller"
// calling convention from `hub.js`, same per-recipient fan-out with pruning
// of dead registrations. FCM (Android) sits alongside Web Push (browser) as
// a second delivery channel for the same `notify(login, payload)` call —
// see `createCombinedPushSender` in `server.js` for how the two are merged
// into one object so `hub.js` needs no channel-specific branching.
export function createFcmSender({
  serviceAccount,
  store,
  send,
} = {}) {
  if (!store) throw new TypeError('createFcmSender requires store');
  const enabled = Boolean(serviceAccount);
  let deliver = send;
  if (enabled && !deliver) {
    const app = initializeApp(
      { credential: cert(serviceAccount) },
      `tailchat-fcm-${serviceAccount.project_id}`,
    );
    const messaging = getMessaging(app);
    deliver = (message) => messaging.send(message);
  }

  // Fired after the frame is already queued, same as push.js's own notify:
  // a slow or failing provider must never delay or block message delivery
  // itself, so nothing here is awaited by the caller and nothing here can
  // throw back into it.
  async function notify(login, payload) {
    if (!enabled) return;
    const tokens = store.fcmTokens(login);
    if (tokens.length === 0) return;

    await Promise.all(tokens.map(async ({ token, scope }) => {
      try {
        await deliver({
          token,
          // Deliberately data-only: an FCM `notification` block is rendered
          // by the OS itself the moment the app is not in the foreground,
          // which is a *second* notification beside the one ChatService
          // posts through its single, already-tested path — one message,
          // two tray entries with the same app name and different icons,
          // which is what «несколько уведомлений на одно сообщение» was.
          // The payload contains routing identity only, never conversation
          // content. Android validates the account scope before waking its
          // sole SyncEngine and fetches the message through Tailchat itself.
          data: payload.kind === 'call'
            ? {
              kind: 'call',
              callId: String(payload.callId ?? ''),
              peer: String(payload.peer ?? ''),
              login: String(login),
              scope: String(scope ?? ''),
            }
            : payload.kind === 'reply-reminder'
              ? {
                kind: 'reply-reminder',
                peer: String(payload.peer ?? ''),
                messageId: String(payload.messageId ?? ''),
                reminderId: String(payload.reminderId ?? ''),
                login: String(login),
                scope: String(scope ?? ''),
              }
              : {
                peer: String(payload.peer ?? ''),
                messageId: String(payload.messageId ?? ''),
                login: String(login),
                scope: String(scope ?? ''),
                tag: String(payload.tag ?? ''),
              },
          // A call delivered late is not a call, but "late" is the caller's
          // ring, not this instant: `ttl: 0` discards the message outright
          // when the device is unreachable at that exact moment — a radio
          // handoff, a tunnel blip, a phone a second away from reattaching —
          // and that silent drop is one half of «при закрытом приложении
          // звонок не всегда проходит». 45 s is the hub's own
          // `CALL_OFFER_HOLD_MS`: a push that lands later finds no held
          // offer and merely reconnects the socket.
          android: payload.kind === 'call'
            ? { priority: 'high', ttl: CALL_PUSH_TTL_MS }
            : { priority: 'high' },
        });
      } catch (error) {
        // An uninstalled app, a cleared token or a stale reinstall all
        // surface as one of these two codes — anything else (quota,
        // transient 5xx, a malformed credential) is left alone rather than
        // removed, for the same reason push.js keeps a 429/500 subscription:
        // dropping a registration over a hiccup silences a device for a
        // problem that was never its own.
        const code = error?.errorInfo?.code || error?.code;
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
          store.removeFcmToken(login, token);
        } else {
          console.warn(`[fcm] send failed: ${code ?? error?.message ?? 'unknown'}`);
        }
      }
    }));
  }

  return { enabled, notify };
}

// One `notify(login, payload)` for `hub.js` to call, regardless of how many
// channels are actually configured — web push, FCM, both or neither. Each
// channel's own failure is already contained inside its own `notify`; this
// only has to make sure one channel throwing does not stop the other from
// being tried.
export function createCombinedPushSender(...senders) {
  const enabled = senders.some((sender) => sender?.enabled);
  async function notify(login, payload) {
    await Promise.all(senders.map((sender) => sender?.notify?.(login, payload)?.catch(() => {})));
  }
  return { enabled, notify, publicKey: () => senders.find((s) => s?.publicKey)?.publicKey() ?? null };
}
