// Tailchat Cloud PWA Service Worker (Network-First)
const CACHE_NAME = "tailchat-cloud-v188";
const SHELL_ASSETS = [
  "/tailchat/",
  "/tailchat/index.html",
  "/tailchat/app.css?v=1.149",
  "/tailchat/app.js?v=1.149",
  "/tailchat/boot.js?v=1.149",
  "/tailchat/manifest.webmanifest",
  "/tailchat/icons/icon.svg?v=1.149",
  "/tailchat/icons/icon-192.png?v=1.149",
  "/tailchat/icons/icon-512.png?v=1.149",
  "/tailchat/icons/icon-180.png?v=1.149",
  "/tailchat/sounds/received.mp3?v=1.48",
  "/tailchat/sounds/sent.mp3?v=1.48",
  "/tailchat/sounds/wake.mp3?v=1.48"
];

// Apple emoji PNGs (spec 2026-10-27, A2): ~1 900 files that never change under
// their name. None are in SHELL_ASSETS — installing the PWA would pull ~10 MB
// — each lands here the first time it is drawn, cache-first. The name sits
// outside the `tailchat-cloud-` prefix `activate` clears, so a release does not
// make every device download its emoji again.
const EMOJI_CACHE = "tailchat-emoji-apple-64";
const EMOJI_PATH = "/tailchat/emoji/apple/64/";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key.startsWith("tailchat-cloud-") && key !== CACHE_NAME) {
            return caches.delete(key);
          }
          return undefined;
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip WebSocket and API calls from cache
  if (url.protocol === "ws:" || url.protocol === "wss:" || url.pathname.includes("/api/")) {
    return;
  }

  // Only handle GET requests
  if (event.request.method !== "GET") {
    return;
  }

  if (url.pathname.startsWith(EMOJI_PATH)) {
    const cacheKey = url.origin + url.pathname;
    event.respondWith(
      caches.open(EMOJI_CACHE).then((cache) => cache.match(cacheKey).then((hit) => hit
        || fetch(event.request).then((networkResponse) => {
          if (networkResponse.status === 200 && networkResponse.type === "basic") {
            return cache.put(cacheKey, networkResponse.clone()).catch(() => {}).then(() => networkResponse);
          }
          return networkResponse;
        })))
    );
    return;
  }

  // Network-First: Always fetch freshest assets from network, fallback to cache when offline
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === "basic") {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          }).catch(() => {});
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const peer = event.notification.data?.peer;
  const targetUrl = "/tailchat/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes("/tailchat/") && "focus" in client) {
          if (peer) {
            client.postMessage({ type: "SELECT_PEER", peer, messageId: event.notification.data?.messageId || null });
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// A push arrives with the app fully closed just as easily as backgrounded —
// this is the one handler that has to work without any page around to run
// `showWebNotification` for it. Same tag scheme as that function
// (`tailchat-msg-<login>`) so the two never stack a duplicate for the same
// conversation on one device.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "Tailchat";
  // Android draws `badge` as a monochrome *mask* in the status bar and in the
  // shade header: a full-colour 192px app icon comes out as a white square,
  // which is what «просто белый квадрат» was. `badge-96.png` is a white
  // speech bubble on transparency — exactly what a mask wants.
  const options = {
    body: data.body || "",
    icon: "/tailchat/icons/icon-192.png?v=1.126",
    badge: "/tailchat/icons/badge-96.png",
    tag: data.tag || (data.peer ? `tailchat-msg-${data.peer}` : "tailchat-push"),
    renotify: true,
    vibrate: [150, 80, 150],
    data: { peer: data.peer || null, messageId: data.messageId || null },
  };
  // A `userVisibleOnly` subscription MUST end in a notification: skipping it
  // makes Chrome post its own «Site updated in background» notice under the
  // Chrome name, with no icon of ours — the second half of the complaint.
  // So the notification is always shown; when the person is already looking
  // at this exact conversation it is shown silently and without a buzz.
  event.waitUntil(
    shouldShowPush(data.peer).then((show) => self.registration.showNotification(title, show
      ? options
      : { ...options, silent: true, vibrate: undefined, renotify: false }))
  );
});

// The server now pushes on every message a login doesn't have delivered live
// to *this exact connection*, regardless of whether some other device of
// the same account has it open — otherwise one open laptop tab would
// silence push for every other device on the account, forever. That moves
// the "is this actually still worth a popup" decision here: a window that
// is both focused and already looking at this exact peer already rendered
// the message inline, so showing the OS notification too would just be
// noise for the one device that doesn't need it.
async function shouldShowPush(peer) {
  if (!peer) return true;
  const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clientList) {
    if (!client.focused) continue;
    const activePeer = await queryActivePeer(client);
    if (activePeer === peer) return false;
  }
  return true;
}

function queryActivePeer(client) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const settle = (activePeer) => {
      clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close?.();
      resolve(activePeer);
    };
    const timer = setTimeout(() => settle(null), 500);
    channel.port1.onmessage = (event) => {
      settle(event.data && event.data.activePeer ? event.data.activePeer : null);
    };
    try {
      client.postMessage({ type: "QUERY_ACTIVE_PEER" }, [channel.port2]);
    } catch {
      settle(null);
    }
  });
}

// The browser rotates a push subscription's endpoint on its own schedule; a
// device that never resubscribes keeps sending to an endpoint that silently
// stops delivering — and the moment it happens there is usually no page open at
// all. So the worker repairs it itself: `/api/push/subscribe` handed this device
// a repair key (login, device id, key — the page keeps them in IndexedDB, the
// one storage a worker can read), and that key can do exactly one thing, replace
// this device's own subscription. That is why it, and not the session token,
// is the credential a worker holds. When there is nothing to repair with —
// subscribed before this existed, or the key was cleared on logout — every open
// client is still told, exactly as before.
const PUSH_REPAIR_DB = "tailchat-push-repair";
const PUSH_REPAIR_STORE = "repair";
const PUSH_REPAIR_ID = "current";

function pushRepairStore(mode, run) {
  return new Promise((resolve) => {
    let open;
    try {
      open = indexedDB.open(PUSH_REPAIR_DB, 1);
    } catch {
      resolve(null);
      return;
    }
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(PUSH_REPAIR_STORE)) db.createObjectStore(PUSH_REPAIR_STORE);
    };
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const db = open.result;
      try {
        run(db.transaction(PUSH_REPAIR_STORE, mode).objectStore(PUSH_REPAIR_STORE), (value) => {
          db.close();
          resolve(value === undefined ? null : value);
        });
      } catch {
        db.close();
        resolve(null);
      }
    };
  });
}

const readPushRepair = () => pushRepairStore("readonly", (store, done) => {
  const request = store.get(PUSH_REPAIR_ID);
  request.onsuccess = () => done(request.result ?? null);
  request.onerror = () => done(null);
});

const writePushRepair = (record) => pushRepairStore("readwrite", (store, done) => {
  const request = store.put(record, PUSH_REPAIR_ID);
  request.onsuccess = () => done(record);
  request.onerror = () => done(null);
});

// One attempt, no retry: a repair that fails is repeated the next time the
// browser rotates the subscription, or the next time the app opens (which
// re-subscribes on its own and mints a fresh key).
async function repairSubscriptionOnServer(subscription) {
  const record = await readPushRepair();
  if (!record?.repairKey || !record.login || !record.deviceId) return false;
  const response = await fetch("/tailchat/api/push/resubscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      login: record.login,
      deviceId: record.deviceId,
      repairKey: record.repairKey,
      subscription: subscription.toJSON(),
    }),
  });
  if (!response.ok) return false;
  const answer = await response.json().catch(() => null);
  // The server rotates the key on every use: the one that just worked is spent.
  if (answer?.repairKey) await writePushRepair({ ...record, repairKey: answer.repairKey });
  return true;
}

self.addEventListener("pushsubscriptionchange", (event) => {
  const applicationServerKey = event.oldSubscription?.options?.applicationServerKey;
  event.waitUntil(
    self.registration.pushManager.subscribe(
      applicationServerKey ? { userVisibleOnly: true, applicationServerKey } : { userVisibleOnly: true },
    )
      .then(async (subscription) => {
        if (await repairSubscriptionOnServer(subscription).catch(() => false)) return;
        const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const client of clientList) {
          client.postMessage({ type: "PUSH_RESUBSCRIBE_NEEDED" });
        }
      })
      .catch(() => {})
  );
});
