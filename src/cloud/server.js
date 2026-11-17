import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { createAccountStore, normalizeLogin } from './accounts.js';
import { createAiBridge } from './ai-bridge.js';
import { E2EE_CAP, frameForCaps } from './e2ee.js';
import { createCloudHub } from './hub.js';
import { CLOUD_WS_MAX_PAYLOAD, MEDIA_INFLIGHT_PER_ACCOUNT, MEDIA_INFLIGHT_TOTAL } from './limits.js';
import {
  MEDIA_SLOTS, addressableId, mediaBytes, mediaFacts, parseRange, withMediaRefs,
} from './media-ref.js';
import { createPushSender, loadOrCreateVapidKeys } from './push.js';
import { createFcmSender, loadFcmServiceAccount, createCombinedPushSender } from './fcm.js';
import { createGithubIssues } from './github-issues.js';
import { createServiceBot } from './service-bot.js';
import { fetchLinkPreview } from './link-preview.js';
import {
  announceRelease, announceReleaseTo, ensureServiceAccount, linkServiceAccount,
  linkServiceAccountToEveryone, RELEASE_ANNOUNCEMENTS, SERVICE_LOGIN,
} from './service-account.js';
import { readCloudSidecar } from './storage-crypto.js';
import { ensureAiAccount, linkAiAccount, linkAiAccountToEveryone, AI_LOGIN } from './ai-account.js';
import { VERSION } from '../version.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_ROOT = path.resolve(MODULE_DIR, '../../web/cloud');
const WEB_PREFIX = '/tailchat';

// The API speaks small JSON objects only, so anything larger is either a bug or
// someone probing for a memory limit; refusing early keeps both cheap.
const MAX_BODY_BYTES = 8 * 1024;
// End-to-end encryption key uploads carry up to fifty signed one-time keys,
// which is more than everything else here; only those routes read this much.
const E2EE_BODY_BYTES = 64 * 1024;

// Cloud media is a retained inline data URL. `ws` rejects only envelopes above
// the shared ceiling, before JSON parsing can allocate an unbounded payload.
const MAX_WS_PAYLOAD = CLOUD_WS_MAX_PAYLOAD;

const HISTORY_DEFAULT_LIMIT = 200;
const HISTORY_MAX_LIMIT = 5000;
const SAVED_HISTORY_MAX_LIMIT = 5000;

const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const FAILURE_LIMIT = 10;
// Failed sign-ins against one login from every address together. Higher than
// the per-address limit on purpose: it exists to slow a guesser spread over
// many addresses, and set as low as the per-address one it would let anybody
// lock a person out of their own account with ten wrong passwords.
const LOGIN_FAILURE_LIMIT = 50;
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
const REGISTRATION_LIMIT = 5;

// Bounded so that dialling many addresses cannot grow the limiter itself into
// the problem it exists to prevent.
const LIMITER_MAX_ADDRESSES = 4096;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.gz': 'application/gzip',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.apk': 'application/vnd.android.package-archive',
  '.wasm': 'application/wasm',
};

// The only static files ever served, keyed by the request paths that
// may reach them. Nothing from the request is ever joined onto `webRoot`, so no
// amount of `..`, encoding tricks or symlink games can widen this set.
const STATIC_ASSETS = new Map([
  [`${WEB_PREFIX}`, 'index.html'],
  [`${WEB_PREFIX}/`, 'index.html'],
  [`${WEB_PREFIX}/index.html`, 'index.html'],
  [`${WEB_PREFIX}/app.js`, 'app.js'],
  [`${WEB_PREFIX}/app.css`, 'app.css'],
  // The Apple emoji picker's table (spec 2026-10-27, A3): loaded on the first
  // picker open, cache-busted with the app version like app.js.
  [`${WEB_PREFIX}/emoji-data.js`, 'emoji-data.js'],
  // The core in the browser (stage 7, `npm run build:web-core`): the driver's
  // page half, the IndexedDB store, and the WebAssembly with its glue. Built,
  // not committed; absent until a release ships them, then a plain 404.
  [`${WEB_PREFIX}/core/core-client.js`, 'core/core-client.js'],
  [`${WEB_PREFIX}/core/idb-storage.js`, 'core/idb-storage.js'],
  [`${WEB_PREFIX}/core/routing.js`, 'core/routing.js'],
  [`${WEB_PREFIX}/core/web-session.js`, 'core/web-session.js'],
  [`${WEB_PREFIX}/core/e2ee-commands.js`, 'core/e2ee-commands.js'],
  [`${WEB_PREFIX}/core/e2ee-strings.js`, 'core/e2ee-strings.js'],
  [`${WEB_PREFIX}/core/pkg/tailchat_web.js`, 'core/pkg/tailchat_web.js'],
  [`${WEB_PREFIX}/core/pkg/tailchat_web_bg.wasm`, 'core/pkg/tailchat_web_bg.wasm'],
  [`${WEB_PREFIX}/sw.js`, 'sw.js'],
  [`${WEB_PREFIX}/boot.js`, 'boot.js'],
  [`${WEB_PREFIX}/manifest.json`, 'manifest.json'],
  [`${WEB_PREFIX}/manifest.webmanifest`, 'manifest.webmanifest'],
  [`${WEB_PREFIX}/icons/icon.svg`, 'icons/icon.svg'],
  [`${WEB_PREFIX}/icons/icon-180.png`, 'icons/icon-180.png'],
  [`${WEB_PREFIX}/icons/icon-192.png`, 'icons/icon-192.png'],
  [`${WEB_PREFIX}/icons/icon-512.png`, 'icons/icon-512.png'],
  [`${WEB_PREFIX}/icons/maskable-512.png`, 'icons/maskable-512.png'],
  [`${WEB_PREFIX}/icons/badge-96.png`, 'icons/badge-96.png'],
  // Message cues as real samples, not synthesised beeps (see `SOUND_FILES` in
  // web/cloud/app.js): three short mp3s, cache-busted with the app version
  // and precached by the Service Worker.
  [`${WEB_PREFIX}/sounds/received.mp3`, 'sounds/received.mp3'],
  [`${WEB_PREFIX}/sounds/sent.mp3`, 'sounds/sent.mp3'],
  [`${WEB_PREFIX}/sounds/wake.mp3`, 'sounds/wake.mp3'],
  [`${WEB_PREFIX}/install.sh`, 'install.sh'],
  [`${WEB_PREFIX}/tailchat.tar.gz`, 'tailchat.tar.gz'],
  [`${WEB_PREFIX}/tailchat.apk`, 'tailchat.apk'],
  // Side-channel test build: a call-feature APK handed out by URL for manual
  // §7 testing, deliberately *not* referenced by `android-version.json`, so
  // installing it is always a decision someone made rather than a
  // self-update every device takes. Absent file = plain 404, like any other
  // asset in this table.
  [`${WEB_PREFIX}/tc-call.apk`, 'tc-call.apk'],
  // Android self-update: what `bin/release-android.js` writes next to the
  // APK it just published, so a running app can tell a newer build exists
  // without the server tracking Android versions itself.
  [`${WEB_PREFIX}/android-version.json`, 'android-version.json'],
  ['/install.sh', 'install.sh'],
  ['/.well-known/assetlinks.json', 'well-known/assetlinks.json'],
]);

// Apple emoji PNGs (spec 2026-10-27, A2): ~1 900 files named by their code
// points, too many to list above, so this one pattern stands in for them. Only
// lower-case hex runs joined by `-` ever match, and the filename is rebuilt
// from that match alone — no `.`, `/` or `%` from the request can reach the
// filesystem. The images never change under a name, so unlike the shell
// assets they may sit in the browser cache: a new emoji-data release would
// ship as a new directory, not new bytes under these URLs.
const EMOJI_PATH_RE = new RegExp(`^${WEB_PREFIX}/emoji/apple/64/([0-9a-f]{4,5}(?:-[0-9a-f]{4,5}){0,9})\\.png$`);
const EMOJI_CACHE_CONTROL = 'public, max-age=31536000, immutable';

// One method per path. A path that is absent is a 404; a path that is present
// with the wrong method is a 405, which tells a client with a typo'd verb
// something useful instead of pretending the endpoint does not exist.
const ROUTE_METHODS = new Map([
  ['/health', 'GET'],
  ['/install.sh', 'GET'],
  ['/.well-known/assetlinks.json', 'GET'],
  [WEB_PREFIX, 'GET'],
  [`${WEB_PREFIX}/`, 'GET'],
  [`${WEB_PREFIX}/index.html`, 'GET'],
  [`${WEB_PREFIX}/app.js`, 'GET'],
  [`${WEB_PREFIX}/app.css`, 'GET'],
  [`${WEB_PREFIX}/emoji-data.js`, 'GET'],
  [`${WEB_PREFIX}/core/core-client.js`, 'GET'],
  [`${WEB_PREFIX}/core/idb-storage.js`, 'GET'],
  [`${WEB_PREFIX}/core/routing.js`, 'GET'],
  [`${WEB_PREFIX}/core/web-session.js`, 'GET'],
  [`${WEB_PREFIX}/core/e2ee-commands.js`, 'GET'],
  [`${WEB_PREFIX}/core/e2ee-strings.js`, 'GET'],
  [`${WEB_PREFIX}/core/pkg/tailchat_web.js`, 'GET'],
  [`${WEB_PREFIX}/core/pkg/tailchat_web_bg.wasm`, 'GET'],
  [`${WEB_PREFIX}/sw.js`, 'GET'],
  [`${WEB_PREFIX}/boot.js`, 'GET'],
  [`${WEB_PREFIX}/manifest.json`, 'GET'],
  [`${WEB_PREFIX}/manifest.webmanifest`, 'GET'],
  [`${WEB_PREFIX}/icons/icon.svg`, 'GET'],
  [`${WEB_PREFIX}/icons/icon-180.png`, 'GET'],
  [`${WEB_PREFIX}/icons/icon-192.png`, 'GET'],
  [`${WEB_PREFIX}/icons/icon-512.png`, 'GET'],
  [`${WEB_PREFIX}/icons/maskable-512.png`, 'GET'],
  [`${WEB_PREFIX}/icons/badge-96.png`, 'GET'],
  [`${WEB_PREFIX}/sounds/received.mp3`, 'GET'],
  [`${WEB_PREFIX}/sounds/sent.mp3`, 'GET'],
  [`${WEB_PREFIX}/sounds/wake.mp3`, 'GET'],
  [`${WEB_PREFIX}/install.sh`, 'GET'],
  [`${WEB_PREFIX}/tailchat.tar.gz`, 'GET'],
  [`${WEB_PREFIX}/api/register`, 'POST'],
  [`${WEB_PREFIX}/tailchat.apk`, 'GET'],
  [`${WEB_PREFIX}/tc-call.apk`, 'GET'],
  [`${WEB_PREFIX}/android-version.json`, 'GET'],
  [`${WEB_PREFIX}/api/login`, 'POST'],
  [`${WEB_PREFIX}/api/recover`, 'POST'],
  [`${WEB_PREFIX}/api/logout`, 'POST'],
  [`${WEB_PREFIX}/api/invite`, 'POST'],
  [`${WEB_PREFIX}/api/invite/accept`, 'POST'],
  [`${WEB_PREFIX}/api/friend/request`, 'POST'],
  [`${WEB_PREFIX}/api/block`, 'POST'],
  [`${WEB_PREFIX}/api/unblock`, 'POST'],
  [`${WEB_PREFIX}/api/contact/remove`, 'POST'],
  [`${WEB_PREFIX}/api/alias`, 'POST'],
  [`${WEB_PREFIX}/api/users`, 'GET'],
  [`${WEB_PREFIX}/api/history`, 'GET'],
  [`${WEB_PREFIX}/api/media`, 'GET'],
  [`${WEB_PREFIX}/api/me`, 'GET'],
  [`${WEB_PREFIX}/api/profile`, 'PATCH'],
  [`${WEB_PREFIX}/api/push/key`, 'GET'],
  [`${WEB_PREFIX}/api/push/subscribe`, 'POST'],
  [`${WEB_PREFIX}/api/push/unsubscribe`, 'POST'],
  [`${WEB_PREFIX}/api/push/resubscribe`, 'POST'],
  [`${WEB_PREFIX}/api/fcm/register`, 'POST'],
  [`${WEB_PREFIX}/api/fcm/unregister`, 'POST'],
  [`${WEB_PREFIX}/api/link-preview`, 'GET'],
  [`${WEB_PREFIX}/api/turn`, 'GET'],
  [`${WEB_PREFIX}/api/e2ee/keys/upload`, 'POST'],
  [`${WEB_PREFIX}/api/e2ee/keys/query`, 'POST'],
  [`${WEB_PREFIX}/api/e2ee/keys/claim`, 'POST'],
  [`${WEB_PREFIX}/api/e2ee/backup`, 'POST'],
  [`${WEB_PREFIX}/api/e2ee/trust`, 'POST'],
]);

const MESSAGES = {
  invalid_json: 'Некорректный JSON в запросе.',
  body_too_large: 'Тело запроса слишком большое.',
  unknown_token: 'Нужен вход в аккаунт.',
  too_many_attempts: 'Слишком много попыток. Подождите и попробуйте снова.',
  invalid_login: 'Логин: от 3 до 32 знаков, латинские буквы, цифры, точка, дефис или подчёркивание.',
  invalid_password: 'Пароль: от 1 до 200 знаков.',
  invalid_name: 'Такое имя не подходит.',
  login_taken: 'Этот логин уже занят.',
  bad_credentials: 'Неверный логин или пароль.',
  bad_recovery_key: 'Неверный ключ восстановления или логин.',
  invalid_invite: 'Некорректный код приглашения.',
  invite_not_found: 'Приглашение не найдено или уже использовано.',
  self_invite: 'Нельзя активировать своё собственное приглашение.',
  forbidden: 'Приглашение для другого аккаунта может выдать только владелец деплоя.',
  official_invite: 'Для официального контакта приглашение не выдаётся.',
  not_friends: 'Собеседник не найден в списке друзей.',
  self_block: 'Нельзя заблокировать самого себя.',
  self_remove: 'Нельзя удалить самого себя из списка контактов.',
  official_contact: 'Официальный контакт удалить нельзя.',
  unknown_user: 'Пользователь не найден.',
  blocked: 'Собеседник заблокирован.',
  self_request: 'Это ваш собственный аккаунт.',
  official_request: 'Служебный аккаунт и так есть у всех в списке.',
  request_limit: 'Слишком много заявок. Попробуйте позже.',
  request_not_found: 'Эта заявка уже отвечена.',
  method_not_allowed: 'Метод не поддерживается.',
  not_found: 'Страница не найдена.',
  bad_request: 'Некорректный запрос.',
  media_deleted: 'Сообщение с этим вложением удалено.',
  media_evicted: 'Вложение больше не хранится на сервере.',
  too_many_requests: 'Слишком много одновременных загрузок. Попробуйте чуть позже.',
  invalid_device_keys: 'Некорректные ключи устройства.',
  device_keys_changed: 'Ключи этого устройства уже опубликованы и не могут измениться.',
  device_limit: 'Слишком много устройств у аккаунта.',
  device_required: 'Сначала опубликуйте ключи устройства.',
  invalid_one_time_keys: 'Некорректные одноразовые ключи.',
  one_time_key_conflict: 'Одноразовый ключ с этим id уже опубликован другим.',
  one_time_key_limit: 'Слишком много одноразовых ключей.',
  invalid_fallback_key: 'Некорректный резервный ключ.',
  invalid_cross_signing: 'Некорректные ключи подписи аккаунта.',
  invalid_backup: 'Некорректные данные резервной копии ключей.',
  backup_version_mismatch: 'Версия резервной копии ключей изменилась.',
  backup_session_limit: 'Превышен лимит сессий в резервной копии ключей.',
  invalid_trust: 'Некорректные подтверждения сверки.',
  trust_limit: 'Слишком много подтверждённых собеседников.',
  server_error: 'Внутренняя ошибка сервера.',
  invalid_subscription: 'Некорректная push-подписка.',
  invalid_token: 'Некорректный push-токен.',
  invalid_alias: 'Такое имя для собеседника не подходит.',
  self_alias: 'Нельзя переименовать самого себя.',
  extra_password_required: 'Нужен дополнительный пароль.',
};

// Shared with `bin/cloud-server.js`, which prints the directory in its ready
// line: the fallback must be stated once or the two will drift apart.
export function defaultCloudDataDir() {
  return process.env.TAILCHAT_CLOUD_DATA || path.join(os.homedir(), '.tailchat-cloud');
}

// No env var, no bridge: an unconfigured deployment gets exactly today's
// behaviour. `createAiBridge` itself reads `TAILCHAT_CLOUD_AI_GATEWAY_URL`
// (the tailik gateway's own Tailscale-bound address) and stays disabled
// without it, same as it stays disabled without an owner here.
function defaultAiBridge(store) {
  const ownerLogin = process.env.TAILCHAT_CLOUD_AI_OWNER;
  if (!ownerLogin) return null;
  return createAiBridge({ ownerLogin, store });
}

// The service account answers by itself only where there is something to
// answer with: `createGithubIssues` is `null` without a token, and the bot
// says so rather than pretending a bug report went somewhere. Everything else
// it does (menu, help, friend requests) needs no credential at all.
function defaultServiceBot(store, ownerLogin, dataDir) {
  return createServiceBot({
    store,
    issues: createGithubIssues({ dataDir, cipher: store.storageCipher }),
    // The deployment's owner as this service already resolved it — not the
    // environment variable again. A test that says «this deployment has no
    // owner» must not become an owner-configured one because the machine it
    // runs on happens to export the variable.
    ownerLogin,
  });
}

// Always on: the VAPID keypair is generated once and kept in `dataDir` (see
// `push.js`), so unlike the AI bridge there is no missing credential that
// would leave this deployment without one. A subscription with no keypair to
// send against would just never receive anything, quietly.
function defaultPushSender(store, dataDir) {
  const { publicKey, privateKey } = loadOrCreateVapidKeys(dataDir, store.storageCipher);
  const subject = process.env.TAILCHAT_CLOUD_VAPID_SUBJECT || 'mailto:admin@repentandliveholy.org';
  return createPushSender({ publicKey, privateKey, subject, store });
}

// Same absent-credential contract as `defaultAiBridge`, not `defaultPushSender`:
// there is no keypair this server can generate for itself the way VAPID
// works, only a service-account key a human has to hand it (see
// `loadFcmServiceAccount`). A deployment without one just never reaches
// Android devices over FCM and behaves exactly as it did before this
// existed — web push keeps working on its own.
function defaultFcmSender(store, dataDir) {
  const serviceAccount = loadFcmServiceAccount(dataDir, store.storageCipher);
  return createFcmSender({ serviceAccount, store });
}

// ICE servers for voice calls. With `TAILCHAT_CLOUD_TURN_HOST` set (the
// operator's own coturn) STUN points there, and TURN is added when a shared
// secret sits next to the other keys (`turn_secret`, the same value as coturn's
// `static-auth-secret`). Without a host the server offers the same public STUN
// pair the web client uses and no relay: a call still works wherever NAT
// allows — the cloud stays optional, and so does the relay.
const TURN_CREDENTIAL_TTL_S = 600;
const PUBLIC_STUN_URLS = Object.freeze(['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']);

export function loadTurnConfig(dataDir, cipher) {
  const host = (process.env.TAILCHAT_CLOUD_TURN_HOST || '').trim() || null;
  const port = numberFromEnv('TAILCHAT_CLOUD_TURN_PORT', 3478);
  let secret = null;
  try {
    const raw = readCloudSidecar(dataDir, 'turn_secret', cipher).trim();
    if (raw !== '') secret = raw;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { host, port, secret };
}

export function turnResponse(config, login, nowMs = Date.now()) {
  if (!config.host) return { ttl: TURN_CREDENTIAL_TTL_S, iceServers: [{ urls: [...PUBLIC_STUN_URLS] }] };
  const iceServers = [{ urls: [`stun:${config.host}:${config.port}`] }];
  if (config.secret) {
    // coturn `use-auth-secret`: username is `<expiry>:<anything>`, credential
    // is base64(HMAC-SHA1(secret, username)).
    const username = `${Math.floor(nowMs / 1000) + TURN_CREDENTIAL_TTL_S}:${login}`;
    const credential = createHmac('sha1', config.secret).update(username).digest('base64');
    iceServers.push({
      urls: [
        `turn:${config.host}:${config.port}?transport=udp`,
        `turn:${config.host}:${config.port}?transport=tcp`,
      ],
      username,
      credential,
    });
  }
  return { ttl: TURN_CREDENTIAL_TTL_S, iceServers };
}

// A dozen people in the same conversation sharing one link is the common
// case, and each would otherwise cost its own outbound fetch. Capped so a
// server fetching many distinct links over its uptime cannot grow this
// unbounded; TTL'd so a page that changes its title eventually catches up.
const LINK_PREVIEW_CACHE_LIMIT = 500;
const LINK_PREVIEW_CACHE_TTL_MS = 60 * 60 * 1000;

function withPreviewCache(fetchPreview) {
  const cache = new Map();
  return async function cachedFetchPreview(url) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < LINK_PREVIEW_CACHE_TTL_MS) return hit.preview;
    const preview = await fetchPreview(url);
    cache.delete(url);
    cache.set(url, { at: Date.now(), preview });
    if (cache.size > LINK_PREVIEW_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return preview;
  };
}

export function createCloudService({
  host = process.env.TAILCHAT_CLOUD_HOST || '127.0.0.1',
  port = numberFromEnv('TAILCHAT_CLOUD_PORT', 7683),
  dataDir = defaultCloudDataDir(),
  webRoot = DEFAULT_WEB_ROOT,
  keyFile = process.env.TAILCHAT_CLOUD_MASTER_KEY_FILE,
  initializeStore = false,
  allowPlaintextLegacy = false,
  store = createAccountStore({ dir: dataDir, keyFile, initialize: initializeStore, allowPlaintextLegacy }),
  aiBridge = defaultAiBridge(store),
  pushSender = defaultPushSender(store, dataDir),
  fcmSender = defaultFcmSender(store, dataDir),
  fetchPreview = fetchLinkPreview,
  turnConfig = loadTurnConfig(dataDir, store.storageCipher),
  // The deployment's owner, and the account allowed to mint an invite *for
  // somebody else* (`/api/invite` with a `login`). Read from the variable the
  // AI bridge already calls its owner — the box has exactly one owner, and a
  // second variable meaning the same thing is how half a deployment ends up
  // believing one account and half another. Not configured (or the account does
  // not exist) simply means nobody can hand out anybody else's link.
  ownerLogin = process.env.TAILCHAT_CLOUD_AI_OWNER ?? null,
  // Where the one line per `GET /api/media` goes (docs/cloud-logs.md). Never
  // the message id, never the bytes — only who, which conversation, how it
  // ended and how much.
  mediaLog = (line) => process.stderr.write(`${line}\n`),
  serviceBot = defaultServiceBot(store, ownerLogin, dataDir),
  hub = createCloudHub({
    store,
    aiBridge,
    serviceBot,
    pushSender: createCombinedPushSender(pushSender, fcmSender),
  }),
  // Whether `X-Forwarded-For` may be believed, and therefore whether the
  // attempt limiter can tell two people apart. `null` — the default — means
  // "read TAILCHAT_CLOUD_TRUST_PROXY, and refuse to start on a loopback bind if
  // it is not set"; an explicit boolean is an operator (or a test) saying they
  // know what their deployment looks like.
  trustProxy = null,
  // How often the liveness heartbeat runs, and therefore how long a socket may
  // go quiet before it is dropped (two ticks: see the loop below). An option
  // because the deployment's worst case and a test's wish to observe it are the
  // same rule at different scales.
  heartbeatMs = 12_000,
} = {}) {
  const readAsset = createAssetReader(webRoot);
  const limiter = createAttemptLimiter();
  const previewFetcher = withPreviewCache(fetchPreview);
  const owner = String(ownerLogin ?? '').trim().toLowerCase() || null;

  // Caddy is the only front door on the deployment box, so the hop it appends
  // is the real client. Trusting the header unconditionally would be worse than
  // having no limiter at all: anyone could send a fresh `X-Forwarded-For` with
  // every request and get a private, always-empty bucket of attempts.
  const trustProxyHeader = trustProxy === null
    ? process.env.TAILCHAT_CLOUD_TRUST_PROXY === '1'
    : trustProxy === true;

  // Refusing to start is the point. Behind a proxy with the flag unset, every
  // request appears to come from 127.0.0.1, so the limiter has exactly one
  // bucket for the entire deployment: ten failed logins from anybody — a
  // stranger guessing, or somebody's phone retrying a stale password — block
  // `/api/login`, `/api/register` and `/api/recover` for everybody for fifteen
  // minutes, and nothing in the logs says why. The deployment this was written
  // for did have the flag set (`ecosystem.config.cjs`), but `pm2 resurrect`
  // after a reboot and a hand-run `pm2 restart` without `--update-env` both
  // drop it silently, and the resulting "too many attempts" is indistinguishable
  // from the WebSocket rate limit the clients also map to that one string.
  //
  // A local run — the server on your own machine, `curl localhost:7683` — hits
  // this too: set TAILCHAT_CLOUD_TRUST_PROXY=1, or pass `trustProxy: false` to
  // say "yes, one bucket, I know".
  if (trustProxy === null && !trustProxyHeader && isLoopbackHost(host)) {
    throw new Error(
      'Tailchat cloud: refusing to listen on the loopback address ' + `${host} without TAILCHAT_CLOUD_TRUST_PROXY=1. ` +
      'Behind a proxy that flag is what lets the attempt limiter tell clients apart; without it one ' +
      'person\'s failed logins rate-limit the whole deployment. Set TAILCHAT_CLOUD_TRUST_PROXY=1, ' +
      'bind TAILCHAT_CLOUD_HOST to a real address, or pass trustProxy: false to accept one shared bucket.',
    );
  }

  // Media answers still being written, for the 429 in `handleMedia`.
  const mediaInflight = { total: 0, byLogin: new Map() };
  const httpServer = http.createServer((request, response) => {
    handleRequest(request, response, {
      store, hub, serviceBot, readAsset, limiter, trustProxy: trustProxyHeader, aiBridge, pushSender, fetchPreview: previewFetcher, turnConfig, ownerLogin: owner,
      mediaInflight, mediaLog,
    })
      .catch(() => {
        if (!response.headersSent) writeError(response, 500, 'server_error');
        else response.end();
      });
  });

  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD,
    perMessageDeflate: false,
  });

  // Per-socket inbound byte counter, sampled by the heartbeat below. The raw
  // TCP socket is the only place a frame that is *still arriving* is visible:
  // `ws` emits nothing until a message is complete, and a client cannot answer
  // a ping while it is writing one.
  const inbound = new WeakMap();

  webSockets.on('connection', (socket, request) => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    const raw = request?.socket;
    if (raw) inbound.set(socket, { raw, seen: raw.bytesRead });

    const connection = hub.connect(
      (payload) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
      },
      {
        close: (code) => {
          if (socket.readyState === WebSocket.OPEN) socket.close(code);
          else socket.terminate();
        },
      },
    );

    socket.on('message', (data, isBinary) => {
      // Binary frames are never part of this protocol; accepting them would mean
      // a second decoding path with no callers and every risk of the first.
      if (isBinary) {
        socket.close(1003, 'Text messages only');
        return;
      }
      let payload;
      try {
        payload = JSON.parse(data.toString('utf8'));
      } catch {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ k: 'error', code: 'invalid_json', message: MESSAGES.invalid_json }));
        }
        return;
      }
      // `receive` is async: an exception in any frame handler becomes a
      // rejected promise, and an unhandled rejection ends the process — every
      // connection on the box, for one frame. The failure belongs to this
      // socket alone, so it is logged and only this socket is closed.
      Promise.resolve()
        .then(() => connection.receive(payload))
        .catch((error) => {
          process.stderr.write(`Tailchat cloud: frame failed: ${error?.stack || error}\n`);
          if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'Internal error');
        });
    });

    const gone = () => { inbound.delete(socket); connection.close(); };
    socket.once('close', gone);
    socket.once('error', gone);
  });

  httpServer.on('upgrade', (request, socket, head) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url, 'http://localhost');
    } catch {
      rejectUpgrade(socket, 400);
      return;
    }

    if (requestUrl.pathname !== `${WEB_PREFIX}/ws` || !sameOrigin(request, trustProxy)) {
      rejectUpgrade(socket, 403);
      return;
    }

    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit('connection', webSocket, request);
    });
  });

  // A phone that loses signal never closes its socket: the server only finds
  // out when a ping goes unanswered, and until then the roster shows that
  // person as online. At 30s that was up to a minute of a stale green dot;
  // 12s costs two more tiny frames a minute per client and bounds it at ~25s.
  //
  // A missed pong is not the same thing as a silent peer, and the difference is
  // one large frame: a voice note or a photo goes out as a *single* WebSocket
  // frame, framing forbids a control frame inside a data frame, and the
  // client's pong therefore waits behind the whole upload — tens of seconds on
  // a mobile uplink, which is exactly the phone whose connection used to be
  // terminated mid-send (the frame is lost, the message never lands, the
  // client shows «Cloud отключён» and re-uploads). Bytes still arriving are
  // proof the peer is alive whatever its pong queue is doing, so the verdict
  // here is "this socket has gone quiet", not "this socket missed a pong".
  const heartbeat = setInterval(() => {
    for (const socket of webSockets.clients) {
      const link = inbound.get(socket);
      let arrived = false;
      if (link) {
        arrived = link.raw.bytesRead !== link.seen;
        link.seen = link.raw.bytesRead;
      }
      if (socket.isAlive || arrived) {
        socket.isAlive = false;
        socket.ping();
        continue;
      }
      socket.terminate();
    }
  }, heartbeatMs);
  heartbeat.unref();

  // The service accounts are contacts nobody has to add, so they have to exist
  // and be in everybody's roster before anything can be written to them — and
  // a contact that could not be created is one missing name, while a server
  // that did not start is an outage.
  //
  // Release notes used to be written here as well. They are off by owner
  // policy (`RELEASE_ANNOUNCEMENTS` in `./service-account.js`); what is left is
  // the pair of contacts, each of which has to be in every roster of an
  // account that was created before it existed.
  async function ensureServiceContacts() {
    try {
      await ensureServiceAccount(store);
      // The assistant is a contact like any other: it has to exist and be in
      // everybody's roster before the first message can be written to it.
      await ensureAiAccount(store);
      linkServiceAccountToEveryone(store);
      linkAiAccountToEveryone(store);
      if (RELEASE_ANNOUNCEMENTS) announceRelease({ store, hub, version: VERSION });
    } catch (error) {
      process.stderr.write(`Tailchat cloud: service account setup failed: ${error?.message ?? error}\n`);
    }
  }

  return {
    httpServer,
    store,
    hub,
    aiBridge,
    async listen() {
      try {
        await listen(httpServer, port, host);
      } catch (error) {
        clearInterval(heartbeat);
        webSockets.close();
        throw error;
      }
      await ensureServiceContacts();
      return httpServer.address();
    },
    async close() {
      clearInterval(heartbeat);
      for (const socket of webSockets.clients) socket.terminate();
      await closeServer(httpServer);
      webSockets.close();
      // Every `teardown` those terminations caused has run by now, and each one
      // scheduled a `PRESENCE_GRACE_MS` hold. This process is going down: a hold
      // that fired now would only rebuild rosters nobody is connected to read,
      // against a store this function is about to flush and close.
      hub.close?.();
      // The store batches writes, so shutting down without draining the batch
      // would silently lose the last few hundred milliseconds of accounts.
      await store.flush();
      await store.close();
    },
  };
}

// The gateway freezes its three files at startup, which means every edit to the
// web client needs a service restart before anyone can see it. Here they are
// read on request and kept only while their mtime and size are unchanged, so a
// deploy that only touches `web/cloud/` needs nothing but a page reload.
function createAssetReader(webRoot) {
  const cache = new Map();
  return (filename) => {
    let full = path.join(webRoot, filename);
    if (filename === 'install.sh') {
      const rootSh = path.resolve(webRoot, '../../install.sh');
      if (fs.existsSync(rootSh)) full = rootSh;
    }
    let stats;
    try {
      stats = fs.statSync(full);
    } catch {
      return null;
    }
    const cached = cache.get(filename);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.asset;
    }
    let body;
    try {
      body = fs.readFileSync(full);
    } catch {
      return null;
    }
    const asset = {
      body,
      contentType: CONTENT_TYPES[path.extname(filename)] || 'application/octet-stream',
    };
    cache.set(filename, { mtimeMs: stats.mtimeMs, size: stats.size, asset });
    return asset;
  };
}

async function handleRequest(request, response, ctx) {
  let url;
  try {
    url = new URL(request.url, 'http://localhost');
  } catch {
    writeError(response, 400, 'bad_request');
    return;
  }

  if (url.pathname === '/cloud' || url.pathname.startsWith('/cloud/')) {
    const nextPath = url.pathname.replace(/^\/cloud/, WEB_PREFIX) + (url.search || '');
    response.writeHead(308, { Location: nextPath });
    response.end();
    return;
  }

  const emoji = EMOJI_PATH_RE.exec(url.pathname);
  if (emoji) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      writeError(response, 405, 'method_not_allowed');
      return;
    }
    const asset = ctx.readAsset(`emoji/apple/64/${emoji[1]}.png`);
    if (!asset) {
      writeError(response, 404, 'not_found');
      return;
    }
    writeResponse(response, 200, asset.contentType, asset.body, request.method, EMOJI_CACHE_CONTROL);
    return;
  }

  const method = ROUTE_METHODS.get(url.pathname);
  if (!method) {
    writeError(response, 404, 'not_found');
    return;
  }
  if (request.method !== method && !(method === 'GET' && request.method === 'HEAD')) {
    writeError(response, 405, 'method_not_allowed');
    return;
  }

  if (url.pathname === '/health') {
    const aiBridgeEnabled = Boolean(ctx.aiBridge?.enabled?.());
    writeResponse(
      response, 200, 'application/json; charset=utf-8',
      Buffer.from(`${JSON.stringify({ ok: true, aiBridge: aiBridgeEnabled })}\n`),
      request.method,
    );
    return;
  }
  if (url.pathname === WEB_PREFIX) {
    // Permanent, method-preserving: a relative asset reference on the bare path
    // would otherwise resolve against `/`, outside the service.
    response.writeHead(308, { Location: `${WEB_PREFIX}/` });
    response.end();
    return;
  }

  const filename = STATIC_ASSETS.get(url.pathname);
  if (filename) {
    const asset = ctx.readAsset(filename);
    if (!asset) {
      writeError(response, 404, 'not_found');
      return;
    }
    writeResponse(response, 200, asset.contentType, asset.body, request.method);
    return;
  }

  if (url.pathname === `${WEB_PREFIX}/api/register`) {
    await handleRegister(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/login`) {
    await handleLogin(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/recover`) {
    await handleRecover(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/logout`) {
    await handleLogout(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/invite`) {
    await handleCreateInvite(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/invite/accept`) {
    await handleAcceptInvite(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/friend/request`) {
    await handleFriendRequest(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/block`) {
    await handleBlock(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/unblock`) {
    await handleUnblock(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/contact/remove`) {
    await handleRemoveContact(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/alias`) {
    await handleAlias(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/users`) {
    handleUsers(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/history`) {
    handleHistory(request, response, url, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/media`) {
    handleMedia(request, response, url, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/profile`) {
    await handleProfile(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/push/key`) {
    handlePushKey(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/push/subscribe`) {
    await handlePushSubscribe(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/push/unsubscribe`) {
    await handlePushUnsubscribe(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/push/resubscribe`) {
    await handlePushResubscribe(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/fcm/register`) {
    await handleFcmRegister(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/fcm/unregister`) {
    await handleFcmUnregister(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/link-preview`) {
    await handleLinkPreview(request, response, url, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/turn`) {
    handleTurn(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/e2ee/keys/upload`) {
    await handleE2eeUpload(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/e2ee/keys/query`) {
    await handleE2eeQuery(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/e2ee/keys/claim`) {
    await handleE2eeClaim(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/e2ee/backup`) {
    await handleE2eeBackup(request, response, ctx);
  } else if (url.pathname === `${WEB_PREFIX}/api/e2ee/trust`) {
    await handleE2eeTrust(request, response, ctx);
  } else {
    handleMe(request, response, ctx);
  }
}

async function handleRegister(request, response, ctx) {
  const address = clientAddress(request, ctx.trustProxy);
  if (ctx.limiter.blocked(address, true)) {
    writeError(response, 429, 'too_many_attempts');
    return;
  }
  const body = await readJsonBody(request, response);
  if (!body) return;

  const result = await ctx.store.register({
    login: body.login,
    password: body.password,
    name: body.name,
    pubKey: body.pubKey,
    lang: body.lang,
  });
  if (!result.ok) {
    // A taken login is not a failed authentication. Charging it to the same
    // bucket as a wrong password means ten people picking ten names can close
    // `/api/login`, `/api/register` and `/api/recover` for the whole
    // deployment — and on a loopback bind without a trusted proxy, that bucket
    // is shared by everybody anyway (see the check in `createCloudService`).
    if (result.code !== 'login_taken') ctx.limiter.recordFailure(address);
    writeError(response, result.code === 'login_taken' ? 409 : 400, result.code);
    return;
  }
  ctx.limiter.recordRegistration(address);
  // A brand-new account gets the assistant in its list, because that thread is
  // how you talk to it without mentioning it in somebody else's conversation.
  // The release note that used to be put there as well is off by owner policy
  // (`RELEASE_ANNOUNCEMENTS` in `./service-account.js`), and like at boot this
  // is never at the cost of the request itself.
  try {
    if (RELEASE_ANNOUNCEMENTS) {
      announceReleaseTo({ store: ctx.store, hub: ctx.hub, version: VERSION, login: result.user.login });
    }
    // Both are contacts, and a contact is not a message: they arrive in the
    // new account's list whether or not anything is ever written to them.
    linkServiceAccount(ctx.store, result.user.login);
    linkAiAccount(ctx.store, result.user.login);
    // The one thing the official account says unasked: the menu, so a brand-new
    // account does not open `{tailchat}` to a blank screen with nothing to
    // press. Not a release note — `RELEASE_ANNOUNCEMENTS` above stays off, and
    // `welcome`'s own text knows nothing of the version. One login, once: the
    // thread itself is the check, so a retried registration cannot repeat it.
    if (ctx.store.history(SERVICE_LOGIN, result.user.login).length === 0) {
      deliverServiceMessages(ctx, ctx.serviceBot?.welcome(result.user.login));
    }
  } catch (error) {
    process.stderr.write(`Tailchat cloud: registration contact setup failed: ${error?.message ?? error}\n`);
  }
  // A new session is one more that cannot read anything encrypted until it
  // registers a device: whoever encrypts to this account has to know.
  ctx.hub.deviceListChanged?.(result.user.login);
  writeJson(response, 201, {
    token: result.token,
    user: publicUser(result.user),
    recoveryKey: result.recoveryKey || null,
    cert: result.cert || null,
  });
}

async function handleLogin(request, response, ctx) {
  const address = clientAddress(request, ctx.trustProxy);
  if (ctx.limiter.blocked(address, false)) {
    writeError(response, 429, 'too_many_attempts');
    return;
  }
  const body = await readJsonBody(request, response);
  if (!body) return;
  const loginKey = typeof body.login === 'string' ? `login:${body.login.trim().toLowerCase()}` : null;
  if (loginKey && ctx.limiter.blocked(loginKey, false)) {
    writeError(response, 429, 'too_many_attempts');
    return;
  }

  const result = await ctx.store.login({
    login: body.login,
    password: body.password,
    pubKey: body.pubKey,
    extraPassword: body.extraPassword,
  });
  if (!result.ok) {
    if (result.code === 'extra_password_required') {
      // Reachable only once the primary password above was already proven
      // correct, so naming this — unlike every other rejection here — does
      // not turn the endpoint into an account-existence oracle. Not counted
      // as a failed attempt: it is the normal first step of signing in to an
      // account that has one, not a wrong guess.
      writeError(response, 401, 'extra_password_required');
      return;
    }
    ctx.limiter.recordFailure(address);
    if (loginKey) ctx.limiter.recordFailure(loginKey);
    // Every rejection reads the same to the client on purpose: a distinct
    // "no such login" would turn this endpoint into a list of who has an account.
    writeError(response, 401, 'bad_credentials');
    return;
  }
  ctx.hub.deviceListChanged?.(result.user.login);
  writeJson(response, 200, {
    token: result.token,
    user: publicUser(result.user),
    cert: result.cert || null,
  });
}

async function handleRecover(request, response, ctx) {
  const address = clientAddress(request, ctx.trustProxy);
  if (ctx.limiter.blocked(address, false)) {
    writeError(response, 429, 'too_many_attempts');
    return;
  }
  const body = await readJsonBody(request, response);
  if (!body) return;

  const result = await ctx.store.recover({
    login: body.login,
    recoveryKey: body.recoveryKey,
    newPassword: body.newPassword || body.password,
  });
  if (!result.ok) {
    ctx.limiter.recordFailure(address);
    const status = result.code === 'bad_recovery_key' ? 401 : 400;
    writeError(response, status, result.code);
    return;
  }
  ctx.hub.deviceListChanged?.(result.user.login);
  writeJson(response, 200, {
    token: result.token,
    user: publicUser(result.user),
    newRecoveryKey: result.newRecoveryKey,
  });
}

async function handleLogout(request, response, ctx) {
  const token = bearerToken(request);
  const self = token ? ctx.store.resolveToken(token) : null;
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  // Signing out ends this session's encryption device, before the token that
  // names it goes (E2EE spec §4.1).
  await ctx.store.e2eeRemoveTokenDevice?.(token);
  ctx.store.revokeToken(token);
  ctx.hub.deviceListChanged?.(self.login);
  writeResponse(response, 204, 'application/json; charset=utf-8', Buffer.alloc(0));
}

// End-to-end encryption: the device registry (docs/specs/2026-11-04-e2ee.md
// §4–5). The server stores what the devices sign and checks only its shape;
// every signature is verified by the clients that read it.
async function handleE2eeUpload(request, response, ctx) {
  const token = bearerToken(request);
  const self = token ? ctx.store.resolveToken(token) : null;
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const body = await readJsonBody(request, response, { maxBytes: E2EE_BODY_BYTES });
  if (!body) return;
  // Replacing the account's keys proves the password, so it shares sign-in's
  // brake on guessing: same limiter, same address, same 429.
  const replacing = body.replaceCrossSigning === true;
  const address = replacing ? clientAddress(request, ctx.trustProxy) : null;
  if (replacing && ctx.limiter.blocked(address, false)) {
    writeError(response, 429, 'too_many_attempts');
    return;
  }
  const result = await ctx.store.e2eeUpload(token, body);
  if (!result.ok && result.code === 'bad_credentials') {
    // 403, not 401: on this route 401 means "this token is no good", which a
    // client answers by signing out. A wrong password is not that.
    ctx.limiter.recordFailure(address);
    writeError(response, 403, 'bad_credentials');
    return;
  }
  if (!result.ok) {
    const conflict = ['device_keys_changed', 'device_limit', 'one_time_key_conflict', 'one_time_key_limit'];
    writeJson(response, conflict.includes(result.code) ? 409 : 400, {
      error: result.code,
      message: MESSAGES[result.code] || MESSAGES.bad_request,
      // The id the keys have to name, so a first upload can be answered with
      // what the second one needs.
      ...(result.deviceId ? { deviceId: result.deviceId } : {}),
    });
    return;
  }
  if (result.changed) ctx.hub.deviceListChanged?.(self.login);
  writeJson(response, 200, {
    deviceId: result.deviceId,
    registered: result.registered,
    oneTimeKeyCount: result.oneTimeKeyCount,
    fallbackKey: result.fallbackKey,
  });
}

async function handleE2eeQuery(request, response, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const body = await readJsonBody(request, response);
  if (!body) return;
  writeJson(response, 200, { users: ctx.store.e2eeQuery(self.login, body.logins) });
}

async function handleE2eeClaim(request, response, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const body = await readJsonBody(request, response);
  if (!body) return;
  writeJson(response, 200, await ctx.store.e2eeClaim(self.login, body.claims));
}

// An account's signed word on whom it verified, kept so that every one of its
// devices knows (`CrossSigning::attest_peer`). Only the account's own sessions
// are told it changed: nobody else ever reads it.
async function handleE2eeTrust(request, response, ctx) {
  const token = bearerToken(request);
  const self = token ? ctx.store.resolveToken(token) : null;
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const body = await readJsonBody(request, response, { maxBytes: E2EE_BODY_BYTES });
  if (!body) return;
  const result = await ctx.store.e2eeTrust(token, body);
  if (!result.ok) {
    const status = { unknown_token: 401, trust_limit: 409 }[result.code] ?? 400;
    writeError(response, status, result.code);
    return;
  }
  if (result.changed) ctx.hub.trustChanged?.(self.login);
  writeJson(response, 200, { ok: true });
}

async function handleE2eeBackup(request, response, ctx) {
  const token = bearerToken(request);
  const self = token ? ctx.store.resolveToken(token) : null;
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const body = await readJsonBody(request, response, { maxBytes: E2EE_BODY_BYTES });
  if (!body) return;
  const result = await ctx.store.e2eeBackup(token, body);
  if (!result.ok) {
    const conflict = ['backup_version_mismatch', 'backup_session_limit'];
    writeError(response, conflict.includes(result.code) ? 409 : 400, result.code);
    return;
  }
  const { ok: _ok, ...payload } = result;
  writeJson(response, 200, payload);
}

function handleTurn(request, response, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  writeJson(response, 200, turnResponse(ctx.turnConfig, self.login));
}

// `/invite` is the one POST whose body is optional: clients have sent nothing
// or `{}` for as long as the route has existed, and `{ login }` is what turns
// it into «выдай ссылку вот для этого аккаунта». An empty body therefore means
// "for me", not "invalid JSON".
async function handleCreateInvite(request, response, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const body = await readJsonBody(request, response, { allowEmpty: true });
  if (!body) return;

  const requested = typeof body.login === 'string' ? body.login.trim().toLowerCase() : '';
  const target = requested === '' || requested === self.login ? self.login : requested;

  // Somebody else's link is the deployment owner's to hand out, and nobody
  // else's: the alternative — anyone who can log in, or anyone the account
  // happens to be friends with — would let a stranger mint a link *from
  // somebody else's name* and add people to their roster. `ownerLogin` is the
  // same variable the AI bridge already takes its owner from
  // (`TAILCHAT_CLOUD_AI_OWNER`, set in `ecosystem.config.cjs`); unset, the
  // capability is simply off, which is the safe direction for a door like this.
  if (target !== self.login) {
    if (!ctx.ownerLogin || self.login !== ctx.ownerLogin) {
      writeError(response, 403, 'forbidden');
      return;
    }
    // The official contacts are in every roster already (AGENTS.md §9), so a
    // link to one is meaningless — and it would be a way to put strangers into
    // the official account's roster, which is the one thing its threads are
    // supposed not to grow.
    if (target === SERVICE_LOGIN || target === AI_LOGIN) {
      writeError(response, 403, 'official_invite');
      return;
    }
  }

  const invite = ctx.store.createInvite(target);
  if (!invite) {
    // Only reachable for somebody else's login: the caller's own account
    // exists by definition. Answered as a missing user rather than as a
    // refusal, because «такого аккаунта нет» is what the operator needs to know
    // to fix a typo, and the only person who can get this answer is the owner.
    writeError(response, 404, 'unknown_user');
    return;
  }
  writeJson(response, 201, { invite });
}

async function handleAcceptInvite(request, response, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const body = await readJsonBody(request, response);
  if (!body) return;

  let rawInvite = body.invite || body.token;
  if (typeof rawInvite === 'string') {
    const match = /[?&]invite=([a-f0-9]{64})/i.exec(rawInvite.trim());
    if (match) rawInvite = match[1];
  }
  const result = ctx.store.acceptInvite(self.login, rawInvite);
  if (!result.ok) {
    const status = result.code === 'invite_not_found' ? 404 : 400;
    writeError(response, status, result.code);
    return;
  }
  ctx.hub.broadcastUsers?.();
  writeJson(response, 200, { friend: result.friend });
}

/**
 * «Добавить @login» — the path that needs no code passed out of band.
 *
 * The request itself creates no friendship (see `store.requestFriend`): what
 * it creates is a question in the recipient's `{tailchat}` thread, with the
 * two buttons that answer it. That is the whole reason the service account
 * exists as something other than an announcement pipe.
 */
async function handleFriendRequest(request, response, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const body = await readJsonBody(request, response);
  if (!body) return;

  // A person types the handle they see, which is `@login` everywhere in the
  // UI; the store only ever knows the bare login.
  const target = normalizeLogin(String(body.login ?? '').replace(/^@+/, ''));
  // Both server-side accounts are already in everybody's roster
  // (`linkServiceAccountToEveryone`/`linkAiAccountToEveryone`), so there is
  // nothing to ask them and nobody on the other end to answer.
  if (target === SERVICE_LOGIN || target === AI_LOGIN) {
    writeError(response, 403, 'official_request');
    return;
  }

  const result = ctx.store.requestFriend(self.login, target);
  if (!result.ok) {
    const status = result.code === 'unknown_user' ? 404
      : result.code === 'request_limit' ? 429
        : result.code === 'blocked' ? 403
          : 400;
    writeError(response, status, result.code);
    return;
  }

  // A friendship that came into being here (a mutual request, or a contact
  // restored to the asker's own list) has to reach both rosters, exactly as
  // an accepted invite does.
  if (result.state === 'friends') ctx.hub.broadcastUsers?.();
  if (result.delivered) {
    deliverServiceMessages(ctx, ctx.serviceBot?.friendRequested({ from: self.login, to: target }));
  }

  writeJson(response, 200, result.friend
    ? { ok: true, state: result.state, friend: result.friend }
    : { ok: true, state: result.state });
}

/** Everything the service account decides to say goes out this one way. */
function deliverServiceMessages(ctx, messages) {
  for (const message of messages ?? []) {
    if (message) ctx.hub.sendServiceMessage?.(message.to, message);
  }
}

// login is required and must already be a friend — blocking is a roster
// action, not a way to pre-emptively silence a stranger.
async function handleBlock(request, response, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const body = await readJsonBody(request, response);
  if (!body) return;

  const target = peerLogin(body.login);
  if (!target) {
    writeError(response, 400, 'invalid_login');
    return;
  }
  const result = ctx.store.blockUser(self.login, target);
  if (!result.ok) {
    const status = result.code === 'not_friends' ? 403
      : result.code === 'unknown_user' ? 404
      : 400;
    writeError(response, status, result.code);
    return;
  }
  ctx.hub.broadcastUsers?.();
  writeJson(response, 200, { blocked: true });
}

// Idempotent, same as `blockUser`: unblocking someone never blocked is a
// no-op success, not an error a client has to special-case.
async function handleUnblock(request, response, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const body = await readJsonBody(request, response);
  if (!body) return;

  const target = peerLogin(body.login);
  if (!target) {
    writeError(response, 400, 'invalid_login');
    return;
  }
  ctx.store.unblockUser(self.login, target);
  ctx.hub.broadcastUsers?.();
  writeJson(response, 200, { blocked: false });
}

// «Удалить контакт вместе с перепиской»: per-owner and durable. Only the
// account asking loses the contact and its side of the thread; the peer keeps
// both its roster entry and every message (see `removeContact` in accounts.js).
// The official contacts are refused rather than removed-then-restored: §9 of
// AGENTS.md keeps `tailchat`/`tailik` in every roster, and the boot-time
// `linkServiceAccountToEveryone`/`linkAiAccountToEveryone` would re-link them
// anyway.
async function handleRemoveContact(request, response, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const body = await readJsonBody(request, response);
  if (!body) return;

  const target = peerLogin(body.login);
  if (!target) {
    writeError(response, 400, 'invalid_login');
    return;
  }
  if (target === SERVICE_LOGIN || target === AI_LOGIN) {
    writeError(response, 403, 'official_contact');
    return;
  }
  const result = await ctx.store.removeContact(self.login, target);
  if (!result.ok) {
    const status = result.code === 'not_friends' ? 403
      : result.code === 'unknown_user' ? 404
      : 400;
    writeError(response, status, result.code);
    return;
  }
  // Every connection of this account rebuilds its roster without the contact;
  // a client sitting in that conversation closes it.
  ctx.hub.broadcastUsers?.();
  writeJson(response, 200, { ok: true });
}

// «Изменение ника собеседника» (issue #28): the name this account shows for one
// of its contacts, kept on the deployment instead of in each client — which is
// what makes the rename follow the owner from the phone to the browser to the
// terminal instead of living in three local nicknames. Private and asymmetric,
// exactly like the block list: the peer is never told, and never sees it. An
// empty (or absent) `name` clears the nickname and restores the real one.
async function handleAlias(request, response, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const body = await readJsonBody(request, response);
  if (!body) return;
  if (body.name !== undefined && body.name !== null && typeof body.name !== 'string') {
    writeError(response, 400, 'invalid_alias');
    return;
  }

  const target = peerLogin(body.login);
  if (!target) {
    writeError(response, 400, 'invalid_login');
    return;
  }
  const result = ctx.store.setAlias(self.login, target, body.name);
  if (!result.ok) {
    const status = result.code === 'not_friends' ? 403
      : result.code === 'unknown_user' ? 404
      : 400;
    writeError(response, status, result.code);
    return;
  }
  // Only this account's own sessions owe the new roster: the nickname shows up
  // nowhere else, and no frame may carry it to the peer's side.
  ctx.hub.broadcastAliases?.(self.login);
  writeJson(response, 200, { login: target, alias: result.alias });
}

function handleUsers(request, response, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  writeJson(response, 200, { users: listUsers(self.login, ctx) });
}

function handleHistory(request, response, url, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const peer = peerLogin(url.searchParams.get('peer'));
  if (!peer) {
    writeError(response, 400, 'invalid_login');
    return;
  }
  if (peer !== self.login && !ctx.store.areFriends(self.login, peer)) {
    writeError(response, 403, 'not_friends');
    return;
  }
  // Saved Messages may be asked for whole; every other conversation is capped
  // at a page, because that is all any of them keeps.
  const limit = historyLimit(
    url.searchParams.get('limit'),
    peer === self.login ? SAVED_HISTORY_MAX_LIMIT : HISTORY_MAX_LIMIT,
  );
  // `peerReadTs` is how far the *other* side has read this conversation, so
  // the client can restore ✓✓ on its own messages after a reload instead of
  // dropping every one of them back to a single ✓. `peerDeliveredTs` is the
  // rung below it: how far that side's *device* is known to hold them, which is
  // what draws ✓✓ for a message that has arrived but not yet been read.
  const rawBefore = Number(url.searchParams.get('before'));
  const rawSince = Number(url.searchParams.get('since'));
  const before = Number.isFinite(rawBefore) && rawBefore > 0 ? rawBefore : null;
  const since = Number.isFinite(rawSince) && rawSince > 0 ? rawSince : null;
  const beforeId = url.searchParams.get('beforeId') || null;
  // HTTP knows nothing of a socket's capabilities, so a client that can open
  // an envelope says so here; any other gets the stub text instead (E2EE
  // spec §5) — an installed APK must never be handed a bubble with nothing in it.
  const caps = url.searchParams.get('e2ee') === '1' ? [E2EE_CAP] : [];
  // Attachments inline (no parameter, or `media=inline`) — byte for byte the
  // answer every installed client already reads — or described, with the
  // bytes behind `/api/media` (`media=ref`). Anything else is a typo, and a
  // typo must not silently pick the mode (docs/specs/2026-11-03-history-media-refs.md §5.2).
  const mediaParam = url.searchParams.get('media');
  if (mediaParam !== null && mediaParam !== 'inline' && mediaParam !== 'ref') {
    writeError(response, 400, 'bad_request');
    return;
  }
  const refs = mediaParam === 'ref';
  const messages = ctx.store.history(self.login, peer, limit, {
    includeDeleted: url.searchParams.get('deleted') === '1',
    before,
    beforeId,
    since,
  }).map((message) => frameForCaps(caps, message));
  writeJson(response, 200, {
    messages: refs ? messages.map(withMediaRefs) : messages,
    peerReadTs: ctx.store.readTs(peer, self.login),
    peerDeliveredTs: ctx.store.deliveredTs(peer, self.login),
    peerReadAt: ctx.store.readAt?.(peer, self.login) || 0,
    peerReadVia: ctx.store.readVia?.(peer, self.login) || '',
    // Says the mode was understood; an older server ignores the parameter and
    // sends no such key, which is how a client knows to expect inline bytes.
    ...(refs ? { media: 'ref' } : {}),
  });
}

// The bytes of one attachment, addressed the way every client already names a
// message: the conversation, the message id, the slot
// (docs/specs/2026-11-03-history-media-refs.md §6). Visibility is the
// history's own (`store.visibleRecord`), so nothing reachable here is
// unreachable through `/api/history?media=inline`.
function handleMedia(request, response, url, ctx) {
  const started = Date.now();
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const peer = peerLogin(url.searchParams.get('peer'));
  const id = url.searchParams.get('id');
  const slot = url.searchParams.get('slot');
  const log = (status, bytes = 0) => ctx.mediaLog?.(
    `Tailchat cloud: media login=${self.login} peer=${peer ?? '-'} status=${status} bytes=${bytes} ms=${Date.now() - started}`,
  );
  const refuse = (status, code) => {
    writeError(response, status, code);
    log(status);
  };
  if (!peer || !addressableId(id) || !MEDIA_SLOTS.includes(slot)) {
    refuse(400, 'bad_request');
    return;
  }
  if (peer !== self.login && !ctx.store.areFriends(self.login, peer)) {
    refuse(403, 'not_friends');
    return;
  }
  const found = ctx.store.visibleRecord(self.login, peer, id);
  if (found.status === 'deleted') {
    refuse(410, 'media_deleted');
    return;
  }
  if (found.status !== 'ok') {
    refuse(404, 'not_found');
    return;
  }
  const media = found.record[slot];
  const facts = mediaFacts(media);
  if (!facts) {
    if (found.record.mediaDropped) refuse(410, 'media_evicted');
    else refuse(404, 'not_found');
    return;
  }

  const headers = {
    'Content-Type': facts.mime,
    'Cache-Control': 'private, no-store',
    ETag: facts.etag,
    'Accept-Ranges': 'bytes',
    ...SECURITY_HEADERS,
  };
  const ifNoneMatch = request.headers['if-none-match'];
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').map((tag) => tag.trim()).includes(facts.etag)) {
    response.writeHead(304, headers);
    response.end();
    log(304);
    return;
  }

  // A `Range` is honoured unless `If-Range` names another version of the bytes
  // (RFC 9110 §13.1.5): then the whole, current answer is the only safe one.
  const ifRange = request.headers['if-range'];
  const range = typeof ifRange === 'string' && ifRange.trim() !== facts.etag
    ? null
    : parseRange(request.headers.range, facts.size);
  if (range === 'unsatisfiable') {
    response.writeHead(416, { ...headers, 'Content-Range': `bytes */${facts.size}`, 'Content-Length': 0 });
    response.end();
    log(416);
    return;
  }

  // Counted only once there is something to send: each answer holds a decoded
  // copy until the socket drains it.
  const inflight = ctx.mediaInflight;
  const mine = inflight?.byLogin.get(self.login) ?? 0;
  if (inflight && (mine >= MEDIA_INFLIGHT_PER_ACCOUNT || inflight.total >= MEDIA_INFLIGHT_TOTAL)) {
    refuse(429, 'too_many_requests');
    return;
  }
  if (inflight) {
    inflight.total += 1;
    inflight.byLogin.set(self.login, mine + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inflight.total -= 1;
      const left = (inflight.byLogin.get(self.login) ?? 1) - 1;
      if (left > 0) inflight.byLogin.set(self.login, left);
      else inflight.byLogin.delete(self.login);
    };
    response.once('finish', release);
    response.once('close', release);
  }

  const whole = mediaBytes(media)?.bytes;
  if (!whole) {
    refuse(404, 'not_found');
    return;
  }
  const body = range ? whole.subarray(range.start, range.end + 1) : whole;
  response.writeHead(range ? 206 : 200, {
    ...headers,
    'Content-Length': body.length,
    ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${facts.size}` } : {}),
  });
  if (request.method === 'HEAD') response.end();
  else response.end(body);
  log(range ? 206 : 200, request.method === 'HEAD' ? 0 : body.length);
}

// Any authenticated account may ask for a preview of any URL — this is not
// scoped to a friend or a conversation, the same way `/api/history` is,
// because the link itself carries no relationship to check: two friends
// sharing a URL and one person previewing it before pasting it are the same
// request. What keeps this safe is `fetchLinkPreview` refusing to reach
// anything but the public web, not who is asking.
async function handleLinkPreview(request, response, url, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const target = url.searchParams.get('url');
  if (!target || target.length > 2048) {
    writeError(response, 400, 'bad_request');
    return;
  }
  let preview;
  try {
    preview = await ctx.fetchPreview(target);
  } catch {
    preview = null;
  }
  writeJson(response, 200, { preview: preview || null });
}

function handleMe(request, response, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  writeJson(response, 200, { user: publicUser(self) });
}
async function handleProfile(request, response, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const body = await readJsonBody(request, response);
  if (!body) return;

  const result = await ctx.store.updateProfile({
    login: self.login,
    name: body.name,
    currentPassword: body.currentPassword,
    newPassword: body.newPassword,
    extraPassword: body.extraPassword,
    lang: body.lang,
  });
  if (!result.ok) {
    const status = result.code === 'bad_credentials' ? 401 : 400;
    writeError(response, status, result.code);
    return;
  }

  ctx.hub.broadcastProfile?.(result.user);
  writeJson(response, 200, { user: publicUser(result.user) });
}

function handlePushKey(request, response, ctx) {
  writeJson(response, 200, { key: ctx.pushSender?.publicKey?.() ?? null });
}

async function handlePushSubscribe(request, response, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const body = await readJsonBody(request, response);
  if (!body) return;

  if (!ctx.store.addPushSubscription(self.login, body.subscription, body.deviceId)) {
    writeError(response, 400, 'invalid_subscription');
    return;
  }
  // The key this device keeps for its own service worker, so an endpoint the
  // push service rotates can be re-registered while the app is closed
  // (`/api/push/resubscribe`). Minted here rather than only stored: it is the
  // server's to hand out, rotate and forget.
  writeJson(response, 200, { ok: true, repairKey: ctx.store.mintPushRepairKey(self.login, body.deviceId) });
}

// Called by a service worker rather than by a page: when the push service
// rotates an endpoint there may be no tab open at all, and the endpoint the
// server holds stops working for good. The credential is the repair key
// `/api/push/subscribe` handed that device — the one credential a worker is
// trusted with, because it can do nothing but replace this device's own
// subscription. The body still names the login and device it belongs to, which
// is why neither has to be a secret.
async function handlePushResubscribe(request, response, ctx) {
  const address = clientAddress(request, ctx.trustProxy);
  if (ctx.limiter.blocked(address, false)) {
    writeError(response, 429, 'too_many_attempts');
    return;
  }
  const body = await readJsonBody(request, response);
  if (!body) return;

  const result = ctx.store.repairPushSubscription(body.login, body.deviceId, body.repairKey, body.subscription);
  if (!result.ok) {
    // One answer for a wrong key, an unknown login and an unknown device alike:
    // the route is unauthenticated, and telling those apart would make it a way
    // to ask which logins have a push device at all. A body that is not a
    // subscription is the one different answer, and it says nothing about
    // accounts. Only the failures that name somebody are charged to the limiter.
    const invalid = result.code === 'invalid_subscription';
    if (!invalid) ctx.limiter.recordFailure(address);
    writeError(response, invalid ? 400 : 403, invalid ? 'invalid_subscription' : 'bad_repair_key');
    return;
  }
  writeJson(response, 200, { ok: true, repairKey: result.repairKey });
}

async function handlePushUnsubscribe(request, response, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const body = await readJsonBody(request, response);
  if (!body) return;

  ctx.store.removePushSubscription(self.login, body.endpoint);
  writeJson(response, 200, { ok: true });
}

async function handleFcmRegister(request, response, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const body = await readJsonBody(request, response);
  if (!body) return;

  if (!ctx.store.addFcmToken(self.login, body.token, body.scope)) {
    writeError(response, 400, 'invalid_token');
    return;
  }
  writeJson(response, 200, { ok: true });
}

async function handleFcmUnregister(request, response, ctx) {
  const self = authorize(request, ctx.store);
  if (!self) {
    writeError(response, 401, 'unknown_token');
    return;
  }
  const body = await readJsonBody(request, response);
  if (!body) return;

  ctx.store.removeFcmToken(self.login, body.token);
  writeJson(response, 200, { ok: true });
}


function listUsers(selfLogin, ctx) {
  const pending = ctx.store.unreadCounts(selfLogin);
  const users = [];
  for (const user of ctx.store.friends(selfLogin)) {
    if (user.login === selfLogin) continue;
    // Same rule as the socket roster (`usersFor` in hub.js): a contact this
    // account deleted is not part of its list any more.
    if (ctx.store.isRemoved(selfLogin, user.login)) continue;
    // Same rule as the socket roster (`usersFor` in hub.js): the official
    // account is the deployment itself, so it is present whenever this
    // response can be served at all.
    const official = user.login === SERVICE_LOGIN || user.login === AI_LOGIN;
    // The nickname this account gave the contact (issue #28), the same field
    // the socket roster carries — a client that loads its list over HTTP must
    // see the name it set, not the peer's own one.
    const alias = ctx.store.aliasOf?.(selfLogin, user.login);
    users.push({
      login: user.login,
      name: user.name,
      ...(alias ? { alias } : {}),
      online: official || ctx.hub.isOnline(user.login),
      state: official ? 'active' : ctx.hub.stateOf(user.login),
      lastSeen: user.lastSeen,
      pending: pending[user.login] || 0,
      ...(official ? { official: true } : {}),
      ...(ctx.store.hasBlocked(selfLogin, user.login) ? { blocked: true } : {}),
      // A program rather than a person, learned from the bot's own `hello`
      // (`markBot` in accounts.js) — the same field the socket roster carries
      // (`usersFor` in hub.js), because this endpoint is the same list by
      // another door: the web client and the terminal load their roster here.
      ...(ctx.store.isBot?.(user.login) ? { bot: true } : {}),
    });
  }
  return users;
}

function publicUser(user) {
  return { login: user.login, name: user.name, extraPasswordEnabled: Boolean(user.extraPasswordEnabled) };
}

function historyLimit(raw, max = HISTORY_MAX_LIMIT) {
  const value = Number.parseInt(raw || '', 10);
  if (!Number.isInteger(value) || value <= 0) return HISTORY_DEFAULT_LIMIT;
  return Math.min(value, max);
}

// Normalisation is the store's rule, imported so the two cannot drift; the shape
// check lives here only so a malformed query never becomes a storage key.
function peerLogin(value) {
  const login = normalizeLogin(value);
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(login) ? login : null;
}

function bearerToken(request) {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function authorize(request, store) {
  const token = bearerToken(request);
  return token ? store.resolveToken(token) : null;
}

// Resolves to the parsed object, or writes the error response and resolves to
// null so every caller is a single `if (!body) return;`. `allowEmpty` is for
// the one route whose body is genuinely optional (`/api/invite`), where "no
// body" has always meant the same thing as `{}` — an empty body is not a
// malformed one.
async function readJsonBody(request, response, { allowEmpty = false, maxBytes = MAX_BODY_BYTES } = {}) {
  let raw;
  try {
    raw = await readBody(request, maxBytes);
  } catch (error) {
    if (error.code === 'body_too_large') {
      // The rest of the body is never read, so this connection cannot carry
      // another request; saying so stops a keep-alive client from trying.
      response.setHeader('Connection', 'close');
      writeError(response, 413, 'body_too_large');
    }
    else writeError(response, 400, 'bad_request');
    return null;
  }
  if (allowEmpty && raw.toString('utf8').trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    writeError(response, 400, 'invalid_json');
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    writeError(response, 400, 'invalid_json');
    return null;
  }
  return parsed;
}

function readBody(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        // Paused rather than destroyed: the 413 still has to reach the client,
        // and an unread request makes Node close the connection after it.
        request.pause();
        reject(Object.assign(new Error('body too large'), { code: 'body_too_large' }));
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    request.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

// Sliding windows kept in memory: the counts only have to survive long enough to
// slow a live attacker down, and losing them on restart is cheaper than a second
// storage format with its own failure modes.
function createAttemptLimiter({ now = Date.now } = {}) {
  const buckets = new Map();

  const bucketFor = (address) => {
    let bucket = buckets.get(address);
    if (!bucket) {
      bucket = { failures: [], registrations: [] };
      buckets.set(address, bucket);
    }
    return bucket;
  };

  const prune = (bucket, at) => {
    bucket.failures = bucket.failures.filter((stamp) => at - stamp < FAILURE_WINDOW_MS);
    bucket.registrations = bucket.registrations.filter((stamp) => at - stamp < REGISTRATION_WINDOW_MS);
  };

  const sweep = (at) => {
    for (const [address, bucket] of buckets) {
      prune(bucket, at);
      if (!bucket.failures.length && !bucket.registrations.length) buckets.delete(address);
    }
  };

  return {
    blocked(address, isRegistration) {
      const at = now();
      // Looked up, not created: a successful sign-in must not leave an entry
      // behind, or the map grows with every address that ever logged in.
      const bucket = buckets.get(address);
      if (!bucket) return false;
      prune(bucket, at);
      const failureLimit = String(address).startsWith('login:') ? LOGIN_FAILURE_LIMIT : FAILURE_LIMIT;
      const blocked = bucket.failures.length >= failureLimit
        || (isRegistration && bucket.registrations.length >= REGISTRATION_LIMIT);
      if (!blocked) return false;
      // Written once per window per address, not once per refused request: a
      // client that retries in a loop would otherwise let the refused caller
      // write this deployment's log itself.
      //
      // This is the other half of the "too many attempts" report. That string is
      // one client-side message for two unrelated verdicts, and this one is the
      // HTTP limiter: when the address is not the person's own — a proxy whose
      // `X-Forwarded-For` is not trusted, a carrier CGNAT, a shared office
      // connection — ten failed logins by *somebody* close `/api/login`,
      // `/api/register` and `/api/recover` for everybody behind that address, and
      // nothing said so anywhere. The counts are the evidence.
      if (!bucket.blockedReportedAt || at - bucket.blockedReportedAt >= FAILURE_WINDOW_MS) {
        bucket.blockedReportedAt = at;
        process.stderr.write(
          `Tailchat cloud: auth attempt limit reached for ${address} — ` +
          `${bucket.failures.length} failed logins and ${bucket.registrations.length} registrations in the last ` +
          `${Math.round(FAILURE_WINDOW_MS / 60000)} min; login/register/recover are refused for every client ` +
          `appearing as that address\n`,
        );
      }
      return true;
    },
    recordFailure(address) {
      const at = now();
      bucketFor(address).failures.push(at);
      if (buckets.size > LIMITER_MAX_ADDRESSES) sweep(at);
    },
    recordRegistration(address) {
      const at = now();
      bucketFor(address).registrations.push(at);
      if (buckets.size > LIMITER_MAX_ADDRESSES) sweep(at);
    },
  };
}

/**
 * Whether this bind address is only reachable from the machine itself.
 *
 * What matters about it is that a loopback listener is *always* behind
 * something — a proxy, a tunnel, a port-forward — so `request.socket.remoteAddress`
 * identifies that something, not the person. See the check in `createCloudService`.
 */
function isLoopbackHost(host) {
  const value = String(host ?? '').trim().toLowerCase();
  return value === '::1' || value === 'localhost' || value.startsWith('127.');
}

function clientAddress(request, trustProxy) {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    if (forwarded) {
      // The proxy appends the peer it actually saw, so the last hop is the only
      // one it vouches for; earlier entries are whatever the client typed.
      const hops = String(forwarded).split(',');
      const last = hops[hops.length - 1].trim();
      if (last) return limiterAddress(last);
    }
  }
  return limiterAddress(request.socket.remoteAddress || 'unknown');
}

// One subscriber gets a whole IPv6 /64, so counting full addresses would hand
// a single host billions of fresh limiter buckets. IPv6 is counted per /64;
// an IPv4-mapped address is counted as the IPv4 it is.
export function limiterAddress(address) {
  const raw = String(address || '').trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw);
  if (mapped) return mapped[1];
  if (!net.isIPv6(raw)) return raw;
  const [head, tail = ''] = raw.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = raw.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
}

function writeJson(response, status, payload) {
  writeResponse(response, status, 'application/json; charset=utf-8', Buffer.from(`${JSON.stringify(payload)}\n`));
}

function writeError(response, status, code) {
  writeJson(response, status, { error: code, message: MESSAGES[code] || MESSAGES.bad_request });
}

// Every answer carries these, the media route included: an attachment must
// never execute as a document.
const SECURITY_HEADERS = Object.freeze({
  // media-src нужен явно: голосовые приходят как data:-URL, а без него
  // default-src 'self' блокирует воспроизведение (MediaError code 4).
  // img-src получил https: ради превью ссылок (`og:image` — произвольный
  // внешний адрес, картинку тянет сам браузер, не сервер; сам фетч HTML
  // для метаданных делает сервер и там же ограничен `link-preview.js`).
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; img-src 'self' data: blob: https:; media-src 'self' data: blob:; worker-src 'self'; manifest-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

function writeResponse(response, status, contentType, body, method = 'GET', cacheControl = 'no-store') {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': cacheControl,
    ...SECURITY_HEADERS,
  });
  if (method === 'HEAD') {
    response.end();
  } else {
    response.end(body);
  }
}

// A browser always states its origin, so a missing header means a client that no
// site can drive from a page — the terminal transport sends none. A *wrong*
// origin is the case this guard exists for: a page on another host trying to
// borrow the visitor's session.
// `[::1]:7683` → `[::1]`, `example.org:443` → `example.org`; '' when unparsable.
function hostnameOf(host) {
  if (!host) return '';
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return '';
  }
}

function sameOrigin(request, trustProxy = false) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const originHostname = hostnameOf(originHost);
    const hostHeader = request.headers.host || '';
    const hostHostname = hostnameOf(hostHeader);
    // A forwarded host is a claim made by whoever sent the request; it only
    // means something when the deployment says a proxy it trusts set it.
    const forwardedHost = trustProxy ? String(request.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
    const forwardedHostname = hostnameOf(forwardedHost);
    if (!originHostname) return false;

    if (originHost === hostHeader || (forwardedHost && originHost === forwardedHost)) return true;
    if (originHostname === hostHostname || (forwardedHost && originHostname === forwardedHostname)) return true;
    if (trustProxy && (hostHeader.startsWith('127.0.0.1') || hostHeader.startsWith('localhost'))) return true;
    return false;
  } catch {
    return false;
  }
}

function rejectUpgrade(socket, status) {
  socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function numberFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : fallback;
}
