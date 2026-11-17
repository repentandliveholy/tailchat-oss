// Terminal commands for the native core's end-to-end encryption: /verify (a
// contact: their safety code, emojis that stay the same, to compare whenever;
// your own account: SAS, the live emoji comparison that signs a new device),
// /safety (the safety code by its own name), /trust (accept a peer's changed keys), /backup
// (create a key backup, read its status, restore it on a new device) and /keys
// reset (new account keys, with the password, when nothing else is left). The core
// does the cryptography; this module only asks it to, shows what it answers,
// and keeps the state a person's answer needs — which verification is waiting
// for a "yes", which restore is waiting for the core.
//
// A secret — the recovery key, a backup passphrase — is never a command
// argument: that would sit on screen and in the input history. /backup restore
// asks for it through the masked prompt (`promptSecret`, ui.promptSecret), and
// without one (headless mode) it says so instead of reading the composer.
// Creating a backup *with* a passphrase is still not offered (spec E2EE §8.7).

// The 64 pairs of `SAS_EMOJIS` in crates/tailchat-crypto/src/sas.rs, in the same
// order: the core sends 6-bit indices into that table, so a different order here
// would show the other side's screen different animals. test/e2ee-commands.test.js
// reads the Rust source and fails if the two drift apart.
export const SAS_EMOJIS = Object.freeze([
  ['🐶', 'dog'], ['🐱', 'cat'], ['🦁', 'lion'], ['🐎', 'horse'],
  ['🦄', 'unicorn'], ['🐷', 'pig'], ['🐘', 'elephant'], ['🐰', 'rabbit'],
  ['🐼', 'panda'], ['🐓', 'rooster'], ['🐧', 'penguin'], ['🐢', 'turtle'],
  ['🐟', 'fish'], ['🐙', 'octopus'], ['🦋', 'butterfly'], ['🌷', 'flower'],
  ['🌳', 'tree'], ['🌵', 'cactus'], ['🍄', 'mushroom'], ['🌏', 'globe'],
  ['🌙', 'moon'], ['☁️', 'cloud'], ['🔥', 'fire'], ['🍌', 'banana'],
  ['🍎', 'apple'], ['🍓', 'strawberry'], ['🌽', 'corn'], ['🍕', 'pizza'],
  ['🎂', 'cake'], ['🍬', 'candy'], ['🍺', 'beer'], ['☕', 'coffee'],
  ['⚽', 'ball'], ['🏆', 'trophy'], ['🎸', 'guitar'], ['🎺', 'trumpet'],
  ['🔔', 'bell'], ['⚓', 'anchor'], ['🎧', 'headphones'], ['📁', 'folder'],
  ['📌', 'pin'], ['🔑', 'key'], ['🔒', 'lock'], ['💡', 'bulb'],
  ['🔨', 'hammer'], ['☎️', 'telephone'], ['🚩', 'flag'], ['🚂', 'train'],
  ['🚲', 'bicycle'], ['✈️', 'aeroplane'], ['🚀', 'rocket'], ['👑', 'crown'],
  ['✂️', 'scissors'], ['📘', 'book'], ['✏️', 'pencil'], ['📎', 'paperclip'],
  ['❤️', 'heart'], ['💎', 'diamond'], ['👍', 'thumbs_up'], ['☂️', 'umbrella'],
  ['⏳', 'hourglass'], ['⏰', 'clock'], ['🎁', 'gift'], ['🕶️', 'glasses'],
].map((pair) => Object.freeze(pair)));

// What sas.rs shows for an index outside the table (`SasCode::emojis`).
const UNKNOWN_EMOJI = Object.freeze(['🔒', 'lock']);
// Reasons a handshake ends because something did not check out, as opposed
// to somebody choosing to stop: the core's own codes plus the one a Matrix-
// style client sends for "the emojis differ".
const SAS_FAILURES = new Set(['commitment_mismatch', 'key_mismatch', 'mac_mismatch', 'mismatched_sas']);
const YES = new Set(['yes', 'y', 'да']);
// The core's cancel reason for a request another device of this account took.
const ACCEPTED_ELSEWHERE = 'accepted_elsewhere';
const NO = new Set(['no', 'n', 'нет']);
// What every recovery key starts with (`RECOVERY_PREFIX` in
// crates/tailchat-crypto/src/backup.rs). Anything else typed into the restore
// prompt is a passphrase — tried only when the backup has a passphrase slot.
export const RECOVERY_KEY_PREFIX = 'tailchat-backup:';
// How long a restore may stay unanswered. The core answers nothing at all when
// the device is not registered (it never left "sign in again"), and a prompt
// that ends in silence reads as success.
export const RESTORE_TIMEOUT_MS = 30_000;
/**
 * How long a verification this side started may wait for the other device's
 * answer. A device that is online answers in a second or two — the emojis need
 * no tap from anybody — so silence this long means a device that is off, and
 * the request is cancelled rather than left to pop up on it hours later from
 * its inbox (the first live test on 2026-11-11 waited on a switched-off
 * terminal with no word at all).
 */
export const SAS_ANSWER_TIMEOUT_MS = 45_000;
// The words for each reason a reset did not happen
// (`Event::CrossSigningResetFailed` in crates/tailchat-core/src/api.rs).
export const RESET_FAILURES = Object.freeze({
  bad_password: 'e2ee.resetBadPassword',
  too_many_attempts: 'e2ee.resetTooMany',
  not_ready: 'e2ee.resetNotReady',
  busy: 'e2ee.resetDeviceBusy',
  signed_out: 'e2ee.resetSignedOut',
  connection_lost: 'e2ee.resetConnectionLost',
  refused: 'e2ee.resetRefused',
});

/**
 * The person-facing translation key for a restore the core refused, from the
 * `bad-frame` reason it gave (engine/keys.rs `try_complete_restore`), or null
 * when the reason is not about a backup at all.
 */
export function restoreFailureKey(reason) {
  const text = String(reason ?? '');
  if (text === 'invalid backup recovery key') return 'e2ee.restoreNotAKey';
  if (text === 'backup: no backup on server') return 'e2ee.backupNone';
  if (text === 'backup: version mismatch') return 'e2ee.restoreOldKey';
  // A wrong key and a wrong passphrase look the same from here: the blob does
  // not open. So does a key from before a reset, whose account keys the server
  // no longer publishes.
  if (text === 'backup: cannot decrypt crossSigning' || text.startsWith('backup passphrase:')) {
    return 'e2ee.restoreWrongKey';
  }
  if (text.startsWith('backup')) return 'e2ee.restoreFailed';
  return null;
}

/**
 * The safety code as two people read it: one entry per account, in the
 * core's order (the alphabetically first login first — the other side's order
 * too), each with its ten emojis and their names.
 */
export function safetyCodeText(halves = []) {
  return (Array.isArray(halves) ? halves : []).map(({ login = '', emojiIndices = [] } = {}) => {
    const pairs = (Array.isArray(emojiIndices) ? emojiIndices : [])
      .map((index) => SAS_EMOJIS[index] ?? UNKNOWN_EMOJI);
    return {
      login: String(login),
      emojis: pairs.map(([emoji]) => emoji),
      labels: pairs.map(([, label]) => label),
    };
  });
}

/** What the two people read aloud to each other: seven animals/objects, three numbers. */
export function sasCodeText({ emojiIndices = [], decimals = [] } = {}) {
  const emojis = emojiIndices
    .map((index) => SAS_EMOJIS[index] ?? UNKNOWN_EMOJI)
    .map(([emoji, label]) => `${emoji} ${label}`)
    .join('   ');
  return { emojis, numbers: decimals.join('  ') };
}

/**
 * Wires the commands to a session. Everything it needs from the outside is
 * passed in, so it runs without a terminal: `getSession()` (the core link, or
 * null), `getApi()` (the cloud REST client), `getPeer()` (the open
 * conversation's login), `getSelf()` (this account's login), `say(line, about)` and
 * the translator `t`. `about` is `{ peer }` when a line concerns one account —
 * a client may use it to put a line about your own devices somewhere other
 * than the open conversation; one that ignores it loses nothing.
 *
 * Returns the three command handlers and `events`, a map from `core-*` event
 * names to the handlers that belong on the session's event bus.
 */
// What this device calls itself in `keys/upload` (item 6 of the live test:
// every verification line named a device by its random id). Browser and
// system only — never a host name, which says more about a person than
// "Chrome · macOS" does, and friends can read it (`keys/query`). The words
// stay in English: the server keeps one name, and every reader sees it.
const BROWSERS = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\bYaBrowser\//, 'Yandex Browser'],
  [/\b(OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(Firefox|FxiOS)\//, 'Firefox'],
  // No \b: `HeadlessChrome/` and `Chromium/` are Chrome too.
  [/(Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];
const SYSTEMS = [
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/CrOS/, 'ChromeOS'],
  [/Macintosh|Mac OS X/, 'macOS'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
];
const NODE_PLATFORMS = { darwin: 'macOS', linux: 'Linux', win32: 'Windows', freebsd: 'FreeBSD', openbsd: 'OpenBSD' };

export function browserDeviceName(userAgent = '') {
  const ua = String(userAgent ?? '');
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? 'Browser';
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  return system ? `${browser} · ${system}` : browser;
}

export function terminalDeviceName(platform = '') {
  const system = NODE_PLATFORMS[platform];
  return system ? `Terminal · ${system}` : 'Terminal';
}

export function createE2eeCommands({
  getSession, getApi, getPeer, getSelf = () => null, say, t,
  promptSecret = null, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  // The restore in progress: `info` while the backup's metadata is on its way
  // (it says whether a passphrase can open it), `prompt` while the person
  // types, `sent` once the secret went to the core. Null otherwise.
  let restoring = null;
  // A key reset sent to the core and not answered yet: its no-answer timer.
  let resetting = null;
  // The verification waiting for a person's answer. A second code replaces it;
  // the core reports no cancellation, so a stalled one stays until then.
  let waiting = null;
  // A verification this side asked for whose emojis have not arrived:
  // `{ peer, device, name, id, timer }`. `id` comes with `core-sas-started`.
  let asking = null;
  let ownDeviceId = null;
  // `${login}\n${deviceId}` of every device the core said its account's keys
  // have not signed: such a device gets no message keys, whatever SAS says.
  const unsignedDevices = new Set();
  // Peers whose master key the core reported as changed and nobody has
  // accepted or verified since. /trust acts only on these: the core's
  // AcceptPeerKey rewrites the stored identity as unverified, so running it
  // on a peer whose keys did not change would undo a verification.
  const changedKeys = new Set();
  // The safety code /safety last showed and nobody confirmed: `/safety yes`
  // confirms exactly that key, never one that arrived after it was read.
  let safetyShown = null;
  // Peers whose code /safety asked for and the core has not answered. A
  // client's own quiet requests (a details panel) are not said here.
  const safetyAsked = new Set();
  // The peer whose code was just confirmed: its answer says whether it took.
  let safetyConfirming = null;

  const reasonOf = (error) => error?.message ?? String(error ?? 'error');
  const self = () => String(getSelf() ?? '').toLowerCase();

  function stopAsking() {
    if (asking?.timer) clearTimer(asking.timer);
    asking = null;
  }

  // A handshake this side no longer wants: told to the core, which tells the
  // other device, so a dialog left open there closes instead of being
  // confirmed into nothing (the live test's "I confirmed, you saw nothing").
  function cancelQuietly(id) {
    if (!id) return;
    try {
      getSession()?.cancelSas?.(id);
    } catch {
      // Already over in the core — nothing left to cancel.
    }
  }

  // One verification at a time, from this side: a new /verify ends the one
  // still asking and the one still waiting for an answer.
  function supersede() {
    if (asking) cancelQuietly(asking.id);
    stopAsking();
    if (waiting) cancelQuietly(waiting.id);
    waiting = null;
  }

  async function startVerification(login) {
    const session = getSession();
    const api = getApi();
    if (!session?.isCore || !api || !login) return;
    let users;
    try {
      users = await api.e2eeKeysQuery([login]);
    } catch (error) {
      say(t('e2ee.failed', { reason: reasonOf(error) }));
      return;
    }
    const devices = Object.entries(users?.[login]?.devices ?? {})
      .filter(([id]) => id !== ownDeviceId)
      .sort((a, b) => (b[1]?.createdAt ?? 0) - (a[1]?.createdAt ?? 0));
    if (devices.length === 0) {
      say(t('e2ee.noDevices', { peer: login }), { peer: login });
      return;
    }
    // Only your own account comes here: somebody else is verified by the
    // safety code (`verify` below). Whom to ask: from a signed device, the
    // unsigned ones first, since signing them is what this is for; from an
    // unsigned device, only signed ones — two unsigned devices verifying each
    // other hand neither a key. Two signals, because the core's own verdict
    // (`core-unverified-device`) arrives only once it has looked this account
    // up, often after the first /verify: a signature by the published
    // self-signing key has to be on the device at all. Presence only —
    // choosing whom to ask needs no more; the core checks the signature itself
    // before any key goes anywhere.
    const published = users?.[login]?.crossSigning?.selfSigning?.key;
    const signedHere = (device) => !published
      || Boolean(device?.deviceKeys?.signatures?.[login]?.[`ed25519:${published}`]);
    const signed = ([id, device]) => !unsignedDevices.has(`${login}\n${id}`) && signedHere(device);
    const own = users?.[login]?.devices?.[ownDeviceId];
    const ownUnsigned = !ownDeviceId || unsignedDevices.has(`${login}\n${ownDeviceId}`) || !signedHere(own);
    const unsigned = devices.filter((entry) => !signed(entry));
    const candidates = ownUnsigned ? devices.filter(signed) : (unsigned.length > 0 ? unsigned : devices);
    if (candidates.length === 0) {
      say(t('e2ee.onlyUnsigned', { peer: login }), { peer: login });
      return;
    }
    // One handshake, every candidate asked: the device the person has open
    // answers, the others are told it was taken elsewhere (core
    // `StartSasAny`). SAS compares the master key, so whichever answers, the
    // account is what gets trusted. A native module older than that asks
    // the first candidate alone.
    const [deviceId, device] = candidates[0];
    const ids = candidates.map(([id]) => id);
    const many = typeof session.startSasAny === 'function' && ids.length > 1;
    const name = device?.name || deviceId;
    supersede();
    try {
      if (many) session.startSasAny(login, ids);
      else session.startSas(login, deviceId);
    } catch (error) {
      say(t('e2ee.failed', { reason: reasonOf(error) }), { peer: login });
      return;
    }
    const mine = { peer: login, device: deviceId, name, id: null, timer: null };
    mine.timer = setTimer(() => {
      if (asking !== mine) return;
      asking = null;
      cancelQuietly(mine.id);
      say(many
        ? t('e2ee.sasNoAnswerAny', { peer: login })
        : t('e2ee.sasNoAnswer', { peer: login, device: name }), { peer: login });
    }, SAS_ANSWER_TIMEOUT_MS);
    mine.timer?.unref?.();
    asking = mine;
    say(many
      ? t('e2ee.startingAny', { peer: login, count: ids.length })
      : t('e2ee.starting', { peer: login, device: name }), { peer: login });
  }

  function answerVerification(confirm) {
    const session = getSession();
    if (!session?.isCore) return;
    if (!waiting) {
      say(t('e2ee.nothingWaiting'));
      return;
    }
    const { id, peer } = waiting;
    waiting = null;
    try {
      if (confirm) {
        session.confirmSas(id);
        say(t('e2ee.confirmed', { peer }), { peer });
      } else {
        session.cancelSas(id);
        say(t('e2ee.cancelled'), { peer });
      }
    } catch (error) {
      say(t('e2ee.failed', { reason: reasonOf(error) }), { peer });
    }
  }

  // One way to verify a contact (owner's decision, 2026-11-12, E2EE spec
  // §8.9): /verify on a contact shows the safety code, which nobody has to be
  // online for; /verify on your own account is the live comparison, the one
  // thing that hands a new device of yours the signing key. A contact may
  // still start a live comparison from an older client, and the answer to it
  // is the same /verify yes · /verify no.
  async function verify(arg = '') {
    const word = String(arg).trim();
    const lower = word.toLowerCase();
    // "yes"/"no" are answers only while something is waiting for one: both are
    // also valid logins (three letters), and a contact may be called that.
    if (waiting && YES.has(lower)) return answerVerification(true);
    if (waiting && NO.has(lower)) return answerVerification(false);
    if (safetyShown && YES.has(lower)) return safety(lower);
    if (safetyShown && NO.has(lower)) {
      const { peer } = safetyShown;
      safetyShown = null;
      say(t('e2ee.safetyDiffer', { peer }), { peer });
      return;
    }
    if (YES.has(lower) || NO.has(lower)) {
      say(t('e2ee.nothingWaiting'));
      return;
    }
    const target = (word || getPeer() || '').toLowerCase();
    if (!target) {
      say(t('e2ee.noPeer'));
      return;
    }
    if (target !== self()) return showSafetyCode(target);
    await startVerification(target);
  }

  // Asks the core for `peer`'s safety code without saying anything: for a
  // client that draws it itself. False when the core cannot (not running, or
  // a native module built before safety codes existed).
  function requestSafetyCode(peer) {
    const session = getSession();
    const login = String(peer ?? '').toLowerCase();
    if (!session?.isCore || typeof session.safetyCode !== 'function' || !login) return false;
    try {
      session.safetyCode(login);
      return true;
    } catch {
      return false;
    }
  }

  // The person compared `peer`'s code and it matched: trust `masterKey`, the
  // key that code was made from. The core's answer says whether it took.
  function confirmSafetyCode(peer, masterKey) {
    const session = getSession();
    const login = String(peer ?? '').toLowerCase();
    if (!session?.isCore || typeof session.confirmSafetyCode !== 'function' || !login || !masterKey) return;
    safetyShown = null;
    safetyConfirming = login;
    try {
      session.confirmSafetyCode(login, masterKey);
    } catch (error) {
      safetyConfirming = null;
      say(t('e2ee.failed', { reason: reasonOf(error) }), { peer: login });
    }
  }

  function safety(arg = '') {
    const session = getSession();
    if (!session?.isCore) return;
    const word = String(arg).trim();
    const lower = word.toLowerCase();
    // "yes" is an answer only while a code waits for one, as with /verify.
    if (safetyShown && YES.has(lower)) {
      confirmSafetyCode(safetyShown.peer, safetyShown.masterKey);
      return;
    }
    if (YES.has(lower)) {
      say(t('e2ee.safetyNothing'));
      return;
    }
    const target = lower || String(getPeer() ?? '').toLowerCase();
    if (!target) {
      say(t('e2ee.safetyNoPeer'));
      return;
    }
    showSafetyCode(target);
  }

  // Asks the core for `target`'s code and says it when it comes (`core-safety-code`).
  function showSafetyCode(target) {
    const session = getSession();
    if (!session?.isCore) return;
    if (target === self()) {
      say(t('e2ee.safetySelf', { self: target }));
      return;
    }
    if (typeof session.safetyCode !== 'function') {
      say(t('e2ee.safetyUnavailable'));
      return;
    }
    safetyAsked.add(target);
    if (!requestSafetyCode(target)) {
      safetyAsked.delete(target);
      say(t('e2ee.safetyUnavailable'));
    }
  }

  function trust() {
    const session = getSession();
    const peer = String(getPeer() ?? '').toLowerCase();
    if (!session?.isCore) return;
    if (!peer) {
      say(t('e2ee.noPeer'));
      return;
    }
    if (!changedKeys.has(peer)) {
      say(t('e2ee.nothingToTrust', { peer }));
      return;
    }
    try {
      session.acceptPeerKey(peer);
      changedKeys.delete(peer);
      say(t('e2ee.trusted', { peer }));
    } catch (error) {
      say(t('e2ee.failed', { reason: reasonOf(error) }));
    }
  }

  function endRestore() {
    if (restoring?.timer) clearTimer(restoring.timer);
    restoring = null;
  }

  // Step 1 of a restore: ask for the backup's metadata. Step 2 runs when it
  // arrives (`core-backup-info`), because the prompt has to know whether a
  // passphrase is an accepted answer — and whether there is a backup at all.
  function startRestore(session) {
    if (!promptSecret) {
      say(t('e2ee.restoreNeedsTerminal'));
      return;
    }
    if (restoring) {
      say(t('e2ee.restoreBusy'));
      return;
    }
    restoring = { stage: 'info', timer: null };
    session.fetchBackup();
  }

  async function askForSecret(version, passphraseSalt) {
    restoring.stage = 'prompt';
    const entered = await promptSecret({
      title: t('e2ee.restoreTitle'),
      subtitle: t('e2ee.restoreSubtitle', { version }),
      prompt: passphraseSalt ? t('e2ee.restorePromptEither') : t('e2ee.restorePromptKey'),
      hint: t('e2ee.restoreHint'),
    });
    const secret = String(entered ?? '').trim();
    if (!secret) {
      endRestore();
      say(t('e2ee.restoreCancelled'));
      return;
    }
    const session = getSession();
    if (!session?.isCore) {
      endRestore();
      return;
    }
    const isKey = secret.startsWith(RECOVERY_KEY_PREFIX);
    if (!isKey && !passphraseSalt) {
      endRestore();
      say(t('e2ee.restoreNotAKey'));
      return;
    }
    try {
      if (isKey) session.restoreBackupWithRecoveryKey(secret);
      else session.restoreBackupWithPassphrase(secret, passphraseSalt);
    } catch (error) {
      endRestore();
      say(t('e2ee.failed', { reason: reasonOf(error) }));
      return;
    }
    restoring.stage = 'sent';
    restoring.timer = setTimer(() => {
      if (restoring?.stage !== 'sent') return;
      restoring = null;
      say(t('e2ee.restoreNoAnswer'));
    }, RESTORE_TIMEOUT_MS);
    restoring.timer?.unref?.();
    say(t('e2ee.restoring'));
  }

  // /keys reset: the way out for an account with no device left that holds its
  // keys and no backup. The masked password card is the confirmation step —
  // it says what changes for everybody, and Esc there changes nothing.
  async function startReset(session) {
    if (!promptSecret) {
      say(t('e2ee.resetNeedsTerminal'));
      return;
    }
    if (resetting) {
      say(t('e2ee.resetBusy'));
      return;
    }
    say(t('e2ee.resetWarning'));
    resetting = { timer: null };
    const entered = await promptSecret({
      title: t('e2ee.resetTitle'),
      subtitle: t('e2ee.resetSubtitle'),
      prompt: t('e2ee.resetPrompt'),
      hint: t('e2ee.resetHint'),
    });
    const password = String(entered ?? '');
    if (!password) {
      resetting = null;
      say(t('e2ee.resetCancelled'));
      return;
    }
    try {
      session.resetCrossSigning(password);
    } catch (error) {
      resetting = null;
      say(t('e2ee.failed', { reason: reasonOf(error) }));
      return;
    }
    resetting.timer = setTimer(() => {
      if (!resetting) return;
      resetting = null;
      say(t('e2ee.resetNoAnswer'));
    }, RESTORE_TIMEOUT_MS);
    resetting.timer?.unref?.();
    say(t('e2ee.resetting'));
  }

  function endReset() {
    if (resetting?.timer) clearTimer(resetting.timer);
    resetting = null;
  }

  function keys(arg = '') {
    const session = getSession();
    if (!session?.isCore) return;
    const action = String(arg).trim().toLowerCase();
    if (action !== 'reset') {
      say(t('e2ee.keysUsage'));
      return;
    }
    startReset(session).catch((error) => {
      endReset();
      say(t('e2ee.failed', { reason: reasonOf(error) }));
    });
  }

  function backup(arg = '') {
    const session = getSession();
    if (!session?.isCore) return;
    const action = String(arg).trim().toLowerCase();
    try {
      if (action === 'create') session.createBackup(null);
      else if (action === 'status') session.fetchBackup();
      else if (action === 'restore') startRestore(session);
      else say(t('e2ee.backupUsage'));
    } catch (error) {
      endRestore();
      say(t('e2ee.failed', { reason: reasonOf(error) }));
    }
  }

  const events = {
    'core-device-registered': ({ deviceId }) => {
      ownDeviceId = deviceId ?? null;
    },
    // The handshake id of the request this side just sent — what the
    // no-answer timer cancels. The same event announces a handshake the other
    // side started; that one is not ours to time.
    'core-sas-started': ({ transactionId, peer, device }) => {
      if (asking && !asking.id && asking.peer === String(peer ?? '').toLowerCase() && asking.device === device) {
        asking.id = transactionId ?? null;
      }
    },
    'core-sas-code-ready': ({ transactionId, peer, emojiIndices, decimals }) => {
      if (asking && (asking.id === transactionId
        || (!asking.id && asking.peer === String(peer ?? '').toLowerCase()))) stopAsking();
      // A second code replaces the first: the first is cancelled, so its
      // other side is told instead of being left with emojis nobody answers.
      if (waiting && waiting.id !== transactionId) cancelQuietly(waiting.id);
      waiting = { id: transactionId, peer };
      const { emojis, numbers } = sasCodeText({ emojiIndices, decimals });
      say(t('e2ee.compare', { peer }));
      say(`  ${emojis}`);
      say(`  ${numbers}`);
      say(t('e2ee.answer'));
    },
    // The server already holds other keys under this session's device id:
    // this local store is not the one that registered it. Retrying cannot help
    // and the core has stopped trying; what helps is a new sign-in, which is
    // the one thing "keys/upload refused (409)" never said.
    'core-device-keys-conflict': () => {
      say(t('e2ee.signInAgain', { self: self() || '<login>' }));
    },
    // The handshake ended without verifying. Without this the terminal kept
    // "waiting for {peer} to confirm" forever after the other side said no, or
    // after a step failed to check out (spec E2EE §8.7).
    'core-sas-cancelled': ({ transactionId, peer, device: id, name, reason }) => {
      const device = name || id;
      if (waiting?.id === transactionId) waiting = null;
      if (asking && asking.id === transactionId) stopAsking();
      // Another device of this account answered a request sent to all of
      // them: nothing was refused, and nothing here needs saying.
      if (reason === ACCEPTED_ELSEWHERE) return;
      if (SAS_FAILURES.has(reason)) say(t('e2ee.sasMismatch', { peer, device }));
      else if (reason === 'unknown_identity') say(t('e2ee.sasNoIdentity', { peer }));
      else say(t('e2ee.sasCancelledThere', { peer, device }));
    },
    'core-device-verified': ({ peer, device: id, name }) => {
      const device = name || id;
      waiting = null;
      stopAsking();
      // The core clears its own key-changed state on a completed verification.
      changedKeys.delete(String(peer ?? '').toLowerCase());
      say(t('e2ee.verified', { peer, device }));
      // The other side may start a SAS from a device its own account never
      // signed, and the core completes it: say plainly that this changes
      // nothing for messages. Your own device is different — verifying it is
      // what hands it the signing key.
      if (peer && peer !== self() && unsignedDevices.has(`${peer}\n${id}`)) {
        say(t('e2ee.verifiedUnsigned', { peer, device }));
      }
    },
    'core-safety-code': ({ peer, status, halves = [], masterKey = '', verified = false }) => {
      const login = String(peer ?? '').toLowerCase();
      if (safetyConfirming === login) {
        safetyConfirming = null;
        if (verified) {
          changedKeys.delete(login);
          say(t('e2ee.safetyVerified', { peer: login }), { peer: login });
        } else {
          say(t('e2ee.safetyStale', { peer: login }), { peer: login });
        }
        return;
      }
      if (!safetyAsked.delete(login)) return;
      if (status !== 'ready') {
        say(t(status === 'no_keys' ? 'e2ee.safetyNoKeys' : 'e2ee.safetyUnavailable', { peer: login }), { peer: login });
        return;
      }
      say(t('e2ee.safetyHeader', { peer: login }), { peer: login });
      const width = Math.max(...safetyCodeText(halves).map((h) => h.login.length), 0);
      for (const half of safetyCodeText(halves)) {
        say(`  ${half.login.padEnd(width)}  ${half.emojis.join(' ')}`, { peer: login });
        say(`  ${' '.repeat(width)}  ${half.labels.join(' · ')}`, { peer: login });
      }
      if (verified) {
        safetyShown = null;
        say(t('e2ee.safetyIsVerified', { peer: login }), { peer: login });
      } else {
        safetyShown = { peer: login, masterKey };
        say(t('e2ee.safetyAnswer', { peer: login }), { peer: login });
      }
    },
    'core-key-changed': ({ peer }) => {
      const login = String(peer ?? '').toLowerCase();
      // A code read before the change says nothing about the new keys.
      if (safetyShown?.peer === login) safetyShown = null;
      // What was unsigned under the old keys says nothing about the new ones:
      // a reset signs the device it ran on. Kept, this made /verify answer
      // "none of roman's devices is signed" right after roman's reset had
      // signed the one he was on. The core repeats `unverified-device` for
      // any device that is still unsigned.
      for (const key of [...unsignedDevices]) {
        if (key.startsWith(`${login}\n`)) unsignedDevices.delete(key);
      }
      changedKeys.add(login);
      say(t('e2ee.keyChanged', { peer }));
    },
    'core-unverified-device': ({ peer, device: id, name }) => {
      const device = name || id;
      const key = `${peer}\n${id}`;
      if (unsignedDevices.has(key)) return;
      unsignedDevices.add(key);
      // About yourself the advice is different: you cannot /verify your own
      // device from itself, only from another one of yours.
      if (peer && peer === self()) {
        say(id === ownDeviceId
          ? t('e2ee.unsignedThisDevice', { device, peer })
          : t('e2ee.unsignedOwnDevice', { device, peer }));
        return;
      }
      say(t('e2ee.unverifiedDevice', { peer, device }));
    },
    'core-backup-created': ({ version, recoveryKey }) => {
      say(t('e2ee.backupCreated', { version }));
      say(`  ${recoveryKey}`);
    },
    'core-backup-info': ({ version, sessionCount, passphraseSalt = null }) => {
      if (restoring?.stage === 'info') {
        if (!(version > 0)) {
          endRestore();
          say(t('e2ee.backupNone'));
          return;
        }
        askForSecret(version, passphraseSalt).catch((error) => {
          endRestore();
          say(t('e2ee.failed', { reason: reasonOf(error) }));
        });
        return;
      }
      say(version > 0
        ? t('e2ee.backupInfo', { version, count: sessionCount })
        : t('e2ee.backupNone'));
    },
    // Also arrives unasked: the core restores on its own when another device
    // of this account shares the backup key while messages wait to be opened.
    'core-backup-restored': ({ version, sessions }) => {
      endRestore();
      say(t('e2ee.backupRestored', { version, count: sessions }));
    },
    // The core reports a refused restore as a bad frame. Only while a restore
    // is waiting, and only about a backup: the same event carries any frame the
    // core could not read, which is not this command's to show.
    // Always said, not only while /keys waits: a reset whose answer was lost
    // is settled later, from the account's published keys, maybe after the
    // no-answer line already went out.
    'core-cross-signing-reset': () => {
      endReset();
      // This device's own entries are stale now: it was unsigned under the old
      // keys, and every other device of the account is unsigned under the new.
      const me = self();
      for (const key of [...unsignedDevices]) {
        if (key.startsWith(`${me}\n`)) unsignedDevices.delete(key);
      }
      say(t('e2ee.resetDone', { self: me || '<login>' }));
    },
    'core-cross-signing-reset-failed': ({ reason }) => {
      endReset();
      say(t(RESET_FAILURES[reason] ?? 'e2ee.resetRefused', { reason }));
    },
    'core-bad-frame': ({ reason }) => {
      if (restoring?.stage !== 'sent') return;
      const key = restoreFailureKey(reason);
      if (!key) return;
      endRestore();
      say(t(key, { reason }));
    },
  };

  // Whether `peer`'s keys changed and nobody accepted or verified them since:
  // what a client with a menu asks before it offers "trust the new keys".
  const hasChangedKeys = (peer) => changedKeys.has(String(peer ?? '').toLowerCase());

  return {
    verify, safety, trust, backup, keys, events, hasChangedKeys, requestSafetyCode, confirmSafetyCode,
  };
}
