import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { readCloudSidecar, writeCloudSidecar } from './storage-crypto.js';

// A push subscription is only as good as the VAPID key that signed it: a
// fresh keypair on every boot would invalidate every subscription a device
// has ever made, silencing it until it happens to reopen the app and
// re-subscribe. So this is generated once, next to `server_key.json` in the
// same data directory, and read back on every subsequent start.
export function loadOrCreateVapidKeys(dir, cipher) {
  try {
    const parsed = JSON.parse(readCloudSidecar(dir, 'vapid_key.json', cipher));
    if (parsed && typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
      return parsed;
    }
    throw new Error('Invalid VAPID keypair');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (cipher && (fs.existsSync(path.join(dir, 'accounts.json')) || fs.existsSync(path.join(dir, 'accounts.journal')))) {
    throw new Error('VAPID identity missing from existing encrypted cloud data; refusing to replace push credentials');
  }

  const keys = webpush.generateVAPIDKeys();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeCloudSidecar(dir, 'vapid_key.json', JSON.stringify(keys, null, 2), cipher);
  return keys;
}

// A message that never reaches a live socket is exactly the case a phone with
// the app fully closed is in — that is what `hub.js` calls this for. Web Push
// delivers it through the OS's own push service (FCM on Android, APNs-backed
// on iOS Safari, Mozilla's on desktop Firefox), which is why this needs no
// polling, no held-open connection and no native SDK of its own.
//
// `publicKey`/`privateKey` are a VAPID keypair. Without both, sending is a
// silent no-op: an unconfigured deployment behaves exactly as it did before
// push existed, the same contract `ai-bridge.js` uses for its own optional
// dependency.
export const PUSH_FAILURE_LIMIT = 10;

export function createPushSender({
  publicKey,
  privateKey,
  subject = 'mailto:admin@repentandliveholy.org',
  store,
  send = webpush.sendNotification,
  setVapidDetails = webpush.setVapidDetails,
} = {}) {
  if (!store) throw new TypeError('createPushSender requires store');
  const enabled = typeof publicKey === 'string' && publicKey !== ''
    && typeof privateKey === 'string' && privateKey !== '';
  if (enabled) setVapidDetails(subject, publicKey, privateKey);

  // How many *consecutive* transient failures an endpoint is allowed before it
  // is dropped. A rate limit or a hiccup is transient by definition, so the
  // first one must not silence a device (`web-push`'s own contract); but never
  // dropping one means a dead endpoint is retried on every single message
  // forever — one Windows device had answered Microsoft's 429 for 370 sends in
  // a row, and nothing anywhere pruned it. The counter lives in this process
  // rather than in the store: the store is a large encrypted snapshot, not a
  // place for a counter, and a run that starts over after a restart is the
  // right granularity anyway. Only a *run* counts: one success clears it.
  const failures = new Map();

  // Fired after the frame is already queued — a slow or failing push
  // provider must never delay or block message delivery itself, so nothing
  // here is awaited by the caller and nothing here can throw back into it.
  async function notify(login, payload) {
    if (!enabled) return;
    // Calls are Android-only: a browser has nothing that could answer one.
    if (payload?.kind === 'call') return;
    const subs = store.pushSubscriptions(login);
    if (subs.length === 0) return;

    const body = JSON.stringify(payload);
    // Nothing here may throw back into the caller, and nothing is awaited by it:
    // a slow or failing push provider must never delay message delivery. The
    // host and the status are safe to log; the payload (message text) is not.
    const attempts = await Promise.all(subs.map(async (sub) => {
      let host = sub.endpoint;
      try { host = new URL(sub.endpoint).host; } catch {}
      try {
        await send({ endpoint: sub.endpoint, keys: sub.keys }, body);
        return { sub, host, ok: true };
      } catch (error) {
        return { sub, host, ok: false, status: error?.statusCode, failure: error?.code ?? error?.message };
      }
    }));

    // Every endpoint of this recipient failed *without answering at all* — no
    // HTTP status, only a transport error. That is this box's connectivity or
    // its signing, not a verdict on those endpoints, and counting it would walk
    // every device of that person toward the prune threshold at once over our
    // own outage. Judging the whole batch is why the bookkeeping happens after
    // the sends instead of inside the catch.
    const ourOutage = attempts.length > 0
      && attempts.every((attempt) => !attempt.ok && attempt.status === undefined);

    for (const attempt of attempts) {
      const host = attempt.host;
      const endpoint = attempt.sub.endpoint;
      if (attempt.ok) {
        failures.delete(endpoint);
        continue;
      }
      // 404/410: the push service has permanently discarded this endpoint
      // (uninstalled app, cleared site data, expired token).
      if (attempt.status === 404 || attempt.status === 410) {
        failures.delete(endpoint);
        store.removePushSubscription(login, endpoint);
        continue;
      }
      // 400/401/403 are this deployment's fault, not the endpoint's: a wrong or
      // rotated VAPID keypair answers every subscription that way, and counting
      // those would let one configuration mistake prune every device there is —
      // the loudest possible symptom, made silent.
      if (attempt.status === 400 || attempt.status === 401 || attempt.status === 403) {
        console.warn(`[push] send to ${host} rejected: ${attempt.status} (VAPID credentials or request, not the endpoint)`);
        continue;
      }
      if (ourOutage) {
        console.warn(`[push] send to ${host} failed: ${attempt.failure ?? 'unknown'} (every endpoint of this account failed without a response — not counted)`);
        continue;
      }
      const run = (failures.get(endpoint) ?? 0) + 1;
      failures.set(endpoint, run);
      console.warn(`[push] send to ${host} failed: ${attempt.status ?? attempt.failure ?? 'unknown'} (${run}/${PUSH_FAILURE_LIMIT})`);
      if (run >= PUSH_FAILURE_LIMIT) {
        // A run this long is not a hiccup: the endpoint is gone or has decided
        // not to talk to this server at all, and keeping it means paying for the
        // attempt on every message. Dropping it makes the device silent until it
        // next opens the app — which is what a device that never opens the app
        // already is.
        failures.delete(endpoint);
        store.removePushSubscription(login, endpoint);
        console.warn(`[push] dropped ${host} after ${PUSH_FAILURE_LIMIT} consecutive failures`);
      }
    }
  }

  return {
    enabled,
    notify,
    publicKey: () => (enabled ? publicKey : null),
  };
}
