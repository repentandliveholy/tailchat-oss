#!/usr/bin/env node
import './wide-chars.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import {
  findTailscaleCli,
  createWhois,
  parseStatus,
  findUserDevices,
  deviceLabel,
  nearbyDevices,
  looksLikeIp,
  runTailscale,
  ownDeviceList,
  describeCliSearch,
  inspectPeerRoute,
  resolveRouteKind,
  isPrivateIp,
  parseTailscalePing,
  tailscalePingPeer,
  isTailnetIp,
  isNonTailscaleLan,
  probeTailscaleStatus,
} from './tailscale.js';
import {
  createReminderEngine,
  parseReminderTime,
  formatReminderRemaining,
  formatClockTime,
} from './reminders.js';
import { presetDue } from '@tailchat/reminder-core';
import { pausePm2Daemon, resumePm2Daemon } from './pm2.js';
import { createPeerMemory, peerMemoryFile } from './peer-memory.js';
import { EMOJIS, replaceEmojis, replaceColonEmojis } from './emoji.js';
import {
  createFileReceiver,
  chunkFile,
  formatBytes,
  DEFAULT_MAX_BYTES,
  defaultFilesDir,
  defaultStateDir,
  takeNextPeer,
  writeNextPeer,
} from './files.js';
import { readSecureClipboardImage, writeClipboardText } from './clipboard.js';
import {
  decodeImage, renderPreview, looksLikeImage, fileIconLines,
  encodeKittyGraphics, convertToPngBytes, pngDimensions,
  kittyViewPlan, kittyPut, KITTY_DELETE_ALL,
  terminalViewProtocol, itermViewPlan, itermInlineImage,
} from './preview.js';
import { createPersistentOutbox, outboxFileFor } from './outbox-store.js';
import { createTypingSignal } from './typing.js';
import { createPresenceSignal } from './presence.js';
import { parsePeerAddr, detectBindAddr, ownTailnetIps } from './addr.js';
import { startRendezvous } from './rendezvous.js';
import { startCloudSession } from './cloud/link.js';
import {
  coreRequested, startCoreCloudSession, loadNativeCore, coreDbPath, describeCoreError, CORE_KEY_INFO,
} from './cloud/core-link.js';
import { createE2eeCommands } from './e2ee-commands.js';
import { CLOUD_FRAME_MAX_CHARS, CLOUD_MEDIA_MAX_CHARS } from './cloud/limits.js';
import { frameAttachment, isMediaRefShape } from './cloud/media-ref.js';
import { prepareCloud, logoutCloud } from './cloud/boot.js';
import { cloudWebUrl } from './cloud/config.js';
import { peerRows, describeLastSeen, describeApiError } from './cloud/prompt.js';
import {
  createUI, mergeMessageState, MARKER_RANK, RECEIPT_MARKERS, climbs, THEMES, THEME_NAMES, DEFAULT_THEME, fileLinkLine,
} from './ui.js';
import { createLog, readLogTail, resolveLogFile, defaultLogPath } from './log.js';
import { createNotifier, notifyIfUnfocused } from './notify.js';
import { newMessageId, messageTooLarge, MAX_MESSAGE_CHARS } from './session.js';
import { VERSION, shortVersion } from './version.js';

import { createThrottle } from './throttle.js';
import {
  createTranslator, detectLanguage, normaliseLanguage, DICTIONARIES,
} from './i18n.js';
import { probeFocusSupport, isTermux } from './terminal.js';
import { installFatalHandlers, installSignalHandlers } from './fatal.js';
import {
  runUpdate, restartAfterUpdate, changesSince, headCommit, readLastRun, writeLastRun,
  isGitCheckout, installRoot, isSupervised, runCliUpdate, localUpdateBanner, updatedBanner,
  updateNotices, makeUpdateBox,
} from './update.js';

import { pickArt } from './art.js';
import {
  writeListenerPid, readListenerPid, clearListenerPid, readListenerPeer, lockVerdict,
} from './listener.js';
import {
  lookupRoster, rosterAddresses, rememberDevices, rosterSelectors,
  isSelfAnnouncement, forgetDevices,
} from './roster.js';
import {
  readBlocklist, blockLogin, unblockLogin, isBlocked,
} from './blocklist.js';
import {
  rosterChoices, renderChoices, readChoice, peerMenuRows,
} from './picker.js';
import {
  readConfig, writeConfig, resolveLanguage, readSecrets, writeSecret, secretsFile,
  removeSecret, resetState, normaliseSelfName, SELF_NAME_MAX,
  hashPassword, verifyPassword,
} from './config.js';
import { createLanDiscovery } from './lan-discovery.js';
import { loadOrCreateIdentity, saveCertificate, loadCertificate } from './identity.js';
import {
  linkPeer, unlinkPeer, readPeerLinks, resolveLinkedCloudLogin,
} from './peer-links.js';
import { runSetup, languageRows } from './setup.js';
import { runListMenu, interactive } from './menu.js';
import {
  resolveAi, aiConfigPatch, normaliseAiName, mentionRegex, shouldAutoReply, shouldRunExplicitAi,
  aiOwnsAnswers, answersHere,
  aiFrame, isReplyToAi, stripHumanMarker, createTurnBuffer, buildRequest, requestReply,
  splitCommands, AI_PROVIDERS, GOOGLE_MODELS, normaliseModelName, AI_THROTTLE_MS, AI_TURNS, AI_TOOL_ROUNDS, AI_FEEDBACK_EVERY, escapeRegex, DEFAULT_AI_NAME,
  AI_SAFE_SHELL_COMMANDS, isSafeShellCommand,
  AI_QUIET_MS, AI_QUIET_WORDS, AI_RESUME_WORDS, isBareInstruction,
} from './ai.js';
import {
  recordAudioBuffer,
  playAudio,
  decodeToPcm,
  computeWaveform,
  formatVoiceCard,
  parseWavPcm,
  fitWavForCloud,
  probeAudioRecorder,
  listAudioInputDevices,
  normaliseVoiceBackend,
  VOICE_DEFAULT_SECONDS,
  VOICE_MAX_SECONDS,
} from './voice.js';
import {
  logoRows, logoFrames, sleepFrames, saverIdleFrames, saverIntroFrames,
  minimumLogoWidth, MIN_SAVER_WIDTH, MIN_SAVER_HEIGHT,
} from './logo.js';
import { readChangelog } from './changelog.js';
import { createSharedHistory } from './shared-history.js';
import { openDeviceStore, migrateCliFiles } from './secure-store.js';
// A displaced instance restores the terminal and clears its note before it goes,
// which takes a moment. Past this we stop waiting rather than escalate to KILL.
const WAKE_THROTTLE_MS = 10_000; // a nudge is loud; do not let a held key spam it
const TAKEOVER_MS = 3000;
// The release the `ai` frame landed in. Below it a peer's client parses the
// frame as unknown and drops it, so its answer has to arrive as a message.
export const AI_FRAME_VERSION = '0.43.0';
// The release the `logo` frame landed in. Below it a peer drops the frame, so
// the logo travels as a plain message instead of an animation.
export const LOGO_FRAME_VERSION = '0.44.0';
// The shared holiday switch lands in 0.57.24. Older peers keep their own art
// and must never be told both screens changed when they ignored the frame.
export const HOLIDAY_FRAME_VERSION = '0.57.24';
export const PING_FRAME_VERSION = '0.57.31';
// Movement on someone else's screen: welcome once, tiresome on a held key.
const LOGO_THROTTLE_MS = 10_000;
// Sleep is slow on purpose: a breath every fifth of a second reads as a cat
// asleep, the same rhythm three times faster reads as a twitch.
const SLEEP_FRAME_MS = 200;

export function backgroundUnreadNotice(from, count, t) {
  const total = Number.isInteger(count) && count > 0 ? count : 1;
  const summary = t('unread.count', { count: total });
  return {
    count: total,
    notification: {
      name: `Tailchat: ${from}`,
      text: `${from}: ${summary}`,
    },
    // Plain text on purpose: `ui.addLine` escapes markup, so blessed tags baked
    // in here reached the transcript as a literal `{yellow-fg}…{/yellow-fg}`.
    line: `* 💬 [${from}]: ${summary}  (${t('unread.switch', { peer: from })})`,
  };
}

// Cloud history — and hub.js's storage behind it — keeps one record shape for
// a human line and a bot line, `kind` and `author` are what tell them apart on
// the way back out. A bot line is never "self", however the account that ran
// it is spelled: it carries its own name, and marking it self would draw it
// under the reader's own name instead, the exact bug this replaced.
export function resolveCloudHistorySender(cm, {
  selfLogin, selfName, peerName, peer,
}) {
  const bot = cm.kind === 'ai';
  const isSelf = !bot && cm.from === selfLogin;
  const senderName = bot
    ? (cm.author || DEFAULT_AI_NAME)
    : (isSelf ? (selfName || peer) : (peerName || peer));
  return { bot, isSelf, senderName };
}

// ---- The native core's rows in the transcript -------------------------------
//
// `client.conversation()` hands over the store's own rows (src/cloud/core-link.js
// documents the shape). These pure helpers are the one place they meet the
// terminal's transcript, so the receipt ladder is read from the core exactly
// once and everything downstream (`renderCloudMessages`, the UI buffers, the
// headless interface) keeps the record shape `/api/history` always had.

// Where a row stands on the ladder. A sent or pending row carries the core's own
// receipt; a row without one is what the server handed over (this account's own
// message from another device), which is committed — ✓ at the least.
export function coreRowMarker(row) {
  const receipt = typeof row?.receipt === 'string' ? row.receipt : null;
  const marker = receipt !== null && Object.hasOwn(RECEIPT_MARKERS, receipt)
    ? RECEIPT_MARKERS[receipt]
    : RECEIPT_MARKERS.sent;
  return { marker, markerRead: receipt === 'read' };
}

function coreReactionMap(list) {
  const map = {};
  for (const entry of Array.isArray(list) ? list : []) {
    if (typeof entry?.emoji !== 'string' || !Array.isArray(entry.by) || entry.by.length === 0) continue;
    map[entry.emoji] = [...entry.by];
  }
  return map;
}

// Who reacted is a set, and the order the store lists them in is its own.
const reactionKey = (map) => JSON.stringify(Object.entries(map ?? {})
  .map(([emoji, by]) => [emoji, [...by].sort()])
  .sort(([a], [b]) => (a < b ? -1 : (a > b ? 1 : 0))));

// One row as the history record `renderCloudMessages` reads. The text is what
// the live link draws: without the leading `@ ` ("the person, not the AI") and,
// for a forward, behind its «переслано от» line — a repaint must not change a
// row that was already drawn from the wire.
export function coreRowToHistoryMessage(row, {
  selfLogin = null, forwardLead = () => '', t = createTranslator('en'),
} = {}) {
  const ai = row.kind === 'ai';
  const protection = typeof row?.protection === 'string' ? row.protection : 'plain';
  let text = String(row.text ?? '');
  if (!text && protection === 'waiting') {
    text = `🔒 ${t('core.waitingKey')}`;
  } else if (!text && protection === 'undecryptable') {
    text = `🔒 ${t('core.undecryptable')}`;
  }
  const body = ai ? text : stripHumanMarker(text);
  const message = {
    id: row.id,
    from: row.from,
    text: row.forwardedFrom ? `${forwardLead(row.forwardedFrom)}\n${body}` : body,
    ts: row.ts,
    kind: ai ? 'ai' : 'human',
    reactions: coreReactionMap(row.reactions),
  };
  if (protection !== 'plain') message.protection = protection;
  if (row.author) message.author = row.author;
  if (row.replyTo) message.replyTo = row.replyTo;
  if (row.image) message.image = row.image;
  if (row.voice) message.voice = row.voice;
  if (row.editedAt) message.editedAt = row.editedAt;
  if (!ai && row.from === selfLogin) Object.assign(message, coreRowMarker(row));
  return message;
}

// Brings a transcript up to what the store says. A row the transcript already
// holds is updated where it stands — its mark, an edit, its reactions — through
// the UI's own in-place setters, which keep the reader's scroll position; the
// rows it does not hold yet are returned, in the store's order, for the caller
// to append. Nothing here lowers a mark: the UI's ladder only climbs.
export function reconcileCoreRows(rows, ui, context = {}) {
  const fresh = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    // The carrier of an edit is the store's proof the edit was applied (its
    // read watermark counts it), never a line of the transcript: the target
    // row below already shows the new text.
    if (row?.editOf) continue;
    const message = coreRowToHistoryMessage(row, context);
    const known = ui.messageById(row.id);
    if (!known) {
      fresh.push(message);
      continue;
    }
    if (message.marker) {
      if (message.markerRead) ui.markReadUpTo(row.id);
      else ui.setMessageMarker(row.id, message.marker);
    }
    if ((message.editedAt || message.protection === 'encrypted') && known.text !== message.text) {
      ui.updateMessage(row.id, message.text, { edited: Boolean(message.editedAt) });
    }
    if (reactionKey(ui.reactionsOf(row.id)) !== reactionKey(message.reactions)) {
      ui.setMessageReactions(row.id, message.reactions);
    }
  }
  return fresh;
}

// Whether a peer selector means the cloud, decided without any network call:
// true for an explicit `@login` (Saved Messages included) or `--cloud`, or
// for a login/name already on the friends list. The startup resolution and
// /peer's live switch both feed a selector through this one rule instead of
// duplicating the friend lookup, so "@self" and an ordinary cloud friend are
// told apart the same way in both places. A selector that resolves to
// neither still needs the caller's own tailscale/identity fallback — that
// half depends on a CLI call, so it stays with the caller.
export function resolveCloudPeerSync(peer, { explicitCloud = false, cloudUsers = [], selfLogin = null } = {}) {
  const needle = String(peer ?? '').trim().toLowerCase();
  if (selfLogin && (needle === String(selfLogin).toLowerCase() || needle === 'saved')) {
    return {
      isCloudPeer: true,
      cloudFriend: null,
      peer: String(selfLogin),
      peerName: 'Saved',
    };
  }
  const cloudFriend = cloudUsers.find((u) => (
    String(u?.login ?? '').toLowerCase() === needle ||
    String(u?.name ?? '').toLowerCase() === needle
  )) || null;
  if (!explicitCloud && !cloudFriend) return { isCloudPeer: false, cloudFriend: null };
  return {
    isCloudPeer: true,
    cloudFriend,
    peer: cloudFriend ? cloudFriend.login : peer,
    peerName: cloudFriend?.name || (cloudFriend ? cloudFriend.login : peer),
  };
}

export function cloudTargetForCurrentPeer({ isCloudPeer, peer, cloudUsers = [] }) {
  if (isCloudPeer || !peer) return null;
  const needle = String(peer).trim().toLowerCase();
  const byLogin = cloudUsers.find((user) => String(user?.login ?? '').toLowerCase() === needle);
  if (byLogin) return byLogin.login;
  const byName = cloudUsers.filter((user) => String(user?.name ?? '').toLowerCase() === needle);
  return byName.length === 1 ? byName[0].login : null;
}

// The one formula every peerKey computation in this file goes through
// (createPeerMemory, resolveLogFile/defaultLogPath, and the two places main()
// and switchActiveConversation derive `peerKey`): a live Cloud conversation
// always keys by the Cloud login, an explicitly `/link`ed Tailscale/LAN
// selector keys by the Cloud login it was tied to (so /p2p and /cloud land in
// the same history once linked), and everything else falls back to the
// selector's tailnet login or, lacking one, the raw selector — exactly the
// pre-unification behaviour. Pure and exported so the three-way precedence is
// provable without a running session.
export function computePeerKey({
  isCloudPeer, cloudLogin, peerLogin, selector, linkedCloudLogin = null,
}) {
  if (isCloudPeer) return `cloud-${cloudLogin}`;
  if (linkedCloudLogin) return `cloud-${linkedCloudLogin}`;
  return peerLogin ?? selector;
}

// The one precedence rule every rendering path shares (issue #28): the
// server-side nickname this account gave a contact wins, then the legacy
// on-machine nickname, then whatever the roster (or the peer's own hello)
// offered. Aliases are the only part that follows the account across
// machines, so a stale local nickname must never shadow one. Pure and
// exported so the order is provable without a running session; the session's
// resolveDisplayLabel feeds it the live values.
export function resolveDisplayName({ alias = null, nickname = null, fallback = null } = {}) {
  return alias || nickname || fallback || null;
}

// The caller's own nickname for one contact, read from a prepared cloud
// session's roster: the server puts `alias` only on the owner's copy, so it is
// exactly what `resolveDisplayName` has to try first. `null` when there is no
// such contact or no nickname set.
export function cloudAliasOf(cloud, login = null) {
  const target = String(login ?? cloud?.peer ?? '').replace(/^@/, '').toLowerCase();
  if (!target) return null;
  const entry = (cloud?.users ?? []).find(
    (user) => String(user?.login ?? '').replace(/^@/, '').toLowerCase() === target,
  );
  return entry?.alias || null;
}

// Applies a nickname the server just accepted to the roster held in memory, so
// the next resolveDisplayLabel call shows it without waiting for the
// broadcast the server sends to this account's other sessions.
export function setCloudAlias(cloud, login, alias) {
  const target = String(login ?? '').replace(/^@/, '').toLowerCase();
  const entry = (cloud?.users ?? []).find(
    (user) => String(user?.login ?? '').replace(/^@/, '').toLowerCase() === target,
  );
  if (entry) entry.alias = alias || '';
  return entry ?? null;
}

// The body of /nick, split from the running session so the cloud/local split is
// provable without a terminal. A personal nickname is what this machine calls
// the peer; for a cloud conversation the account's server now holds it, so it
// follows the person from the phone to the browser (issue #28) and this writes
// there instead of peer-memory. `clear`/empty clears the server value too.
// Whatever the user typed is sent as typed — the server normalises it, and its
// answer is what gets stored. Returns the action taken; callers print.
export async function applyNickname({ arg, isCloudPeer = false, cloud = null, memory = null } = {}) {
  const asked = String(arg ?? '').trim();
  if (asked === '') return { action: 'show' };
  if (/^(clear|reset)$/i.test(asked)) {
    if (isCloudPeer) {
      await cloud.api.setAlias(cloud.peer, '');
      setCloudAlias(cloud, cloud.peer, '');
      if (memory?.nickname()) memory.setNickname(null);
    } else {
      memory?.setNickname(null);
    }
    return { action: 'clear' };
  }
  if (isCloudPeer) {
    // A cloud nickname is free text on the server, so no local sanitiser runs
    // here: sending the typed value and displaying the server's answer keeps
    // the two from disagreeing about what was stored.
    const out = await cloud.api.setAlias(cloud.peer, asked);
    const applied = typeof out === 'string' && out ? out : asked;
    setCloudAlias(cloud, cloud.peer, applied);
    return { action: 'set', name: applied };
  }
  const next = normaliseSelfName(asked);
  if (!next) return { action: 'bad' };
  memory?.setNickname(next);
  return { action: 'set', name: next };
}

// One-time bridge for nicknames set before the cloud learned to hold them: a
// local /nick was private to this machine, and now the server value outranks it
// in resolveDisplayName, so every existing local nickname would vanish the
// moment its owner connects. Push each to the server once, then clear the local
// copy — but only after the server accepted it, and only when the roster entry
// carries no alias of its own: an alias is authoritative and a stale local
// nickname must never overwrite it. The durable flag is set only when nothing
// is left pending, so a failed or offline push is retried next connect instead
// of dropping the name inside the try.
export async function migrateCloudNicknames({
  cloud, config = {}, stateDir, persist = () => {},
  memoryFor = (login) => createPeerMemory({
    dir: stateDir, key: computePeerKey({ isCloudPeer: true, cloudLogin: login }),
  }),
} = {}) {
  if (!cloud || config.nicknameMigrationDone) return { moved: 0, pending: 0, done: true };
  const roster = Array.isArray(cloud.users) ? cloud.users : [];
  let moved = 0;
  let pending = 0;
  for (const entry of roster) {
    const login = String(entry?.login ?? '').trim();
    if (!login) continue;
    const memory = memoryFor(login);
    const local = memory?.nickname?.();
    if (!local) continue;
    if (entry.alias) {
      // The server already has a nickname for this contact. It wins, so the
      // local one is dropped without telling the server anything — but a drop
      // that failed (EPERM/EBUSY on Windows, a read-only state dir) is still
      // unresolved work: the entry is on disk, and the flag must not be set
      // while it is.
      if (memory.setNickname(null)?.ok === false) pending += 1;
      continue;
    }
    try {
      await cloud.api.setAlias(login, local);
    } catch {
      pending += 1; // keep the local copy and the flag; retry on the next connect
      continue;
    }
    // Cleared only once the server has it — and a failed clear is unresolved
    // too, or the file keeps a nickname the next connect would push again.
    if (memory.setNickname(null)?.ok === false) {
      pending += 1;
      continue;
    }
    moved += 1;
  }
  if (pending === 0) persist({ nicknameMigrationDone: true });
  return { moved, pending, done: pending === 0 };
}

// Single source of truth: parsing and every help screen read the same table, so
// a new flag cannot land undocumented — that drift already happened once.
export const cliFlags = [
  // Validated here rather than accepted and quietly mangled later: a name with
  // a colon in it would produce transcript lines nothing can parse back, and
  // silently substituting the hostname would leave the person believing the
  // flag had worked.
  {
    flag: '--name',
    value: '<name>',
    help: 'flag.name',
    apply: (o, v) => {
      const name = normaliseSelfName(v);
      if (!name) throw new Error(`bad --name: ${v}`);
      o.name = name;
      o.nameExplicit = true;
    },
  },
  { flag: '--port', value: '<n>', help: 'flag.port', apply: (o, v) => { o.port = Number(v); } },
  { flag: '--log', value: '<file>', help: 'flag.log', apply: (o, v) => { o.log = v; } },
  { flag: '--no-log', help: 'flag.noLog', apply: (o) => { o.noLog = true; } },
  { flag: '--bind', value: '<ip>', help: 'flag.bind', apply: (o, v) => { o.bind = v; } },
  { flag: '--files-dir', value: '<dir>', help: 'flag.filesDir', apply: (o, v) => { o.filesDir = v; } },
  { flag: '--state-dir', value: '<dir>', help: 'flag.stateDir', apply: (o, v) => { o.stateDir = v; } },
  { flag: '--migrate-encryption', help: 'flag.migrateEncryption', apply: (o) => { o.migrateEncryption = true; } },
  { flag: '--drop-plaintext', help: 'flag.dropPlaintext', apply: (o) => { o.dropPlaintext = true; } },
  { flag: '--max-file', value: '<MB>', help: 'flag.maxFile', apply: (o, v) => { o.maxFile = Number(v); } },
  { flag: '--lang', value: '<code>', help: 'flag.lang', apply: (o, v) => { o.lang = normaliseLanguage(v); o.langExplicit = true; } },
  { flag: '--no-theme', help: 'flag.noTheme', apply: (o) => { o.noTheme = true; } },
  { flag: '--no-notify', help: 'flag.noNotify', apply: (o) => { o.noNotify = true; } },
  { flag: '--sysmsg', help: 'flag.sysmsg', apply: (o) => { o.sysmsg = true; } },
  { flag: '--no-sysmsg', help: 'flag.noSysmsg', apply: (o) => { o.noSysmsg = true; } },
  { flag: '--mouse', help: 'flag.mouse', apply: (o) => { o.mouse = true; } },
  { flag: '--menu', help: 'flag.menu', apply: (o) => { o.menu = true; } },
  // The cloud is opt-in, one flag, and everything about it is off until it is
  // given: without it this client never contacts a server at all.
  { flag: '--cloud', help: 'flag.cloud', apply: (o) => { o.cloud = true; } },
  { flag: '--cloud-server', value: '<url>', help: 'flag.cloudServer', apply: (o, v) => { o.cloudServer = v; o.cloud = true; } },
  { flag: '--cloud-logout', help: 'flag.cloudLogout', apply: (o) => { o.cloudLogout = true; } },
  { flag: '--update', help: 'flag.update', apply: (o) => { o.update = true; } },
  { flag: '--reset', help: 'flag.reset', apply: (o) => { o.reset = true; } },
  { flag: '--headless', help: 'flag.headless', apply: (o) => { o.headless = true; } },
  { flag: '--help', help: 'flag.help', apply: (o) => { o.help = true; } },
  { flag: '--version', help: 'flag.version', apply: (o) => { o.version = true; } },
];

// so a mood never reflows a line the way a Unicode emoji can.
export const EMOTICONS = {
  '/happy': '(^_^)',
  '/sad': '(;_;)',
  '/neutral': '(._.)',
};

// `help` is a translation key, not prose: the same table drives the English
// usage screen and the in-chat help in whatever language is active.
export const chatCommands = [
  { name: '/help', alias: '/h', help: 'cmd.help' },
  { name: '/send', alias: '/s', help: 'cmd.send' },
  { name: '/paste', alias: '/p', help: 'cmd.paste' },
  { name: '/files', alias: '/f', help: 'cmd.files' },
  { name: '/open', alias: '/o', help: 'cmd.open' },
  { name: '/view', help: 'cmd.view' },
  { name: '/history', alias: '/i', help: 'cmd.history' },
  { name: '/peer', help: 'cmd.peer' },
  { name: '/p2p', help: 'cmd.p2p' },
  { name: '/cloud', help: 'cmd.cloud' },
  { name: '/roster', help: 'cmd.roster' },
  { name: '/link', help: 'cmd.link' },
  { name: '/block', help: 'cmd.block' },
  { name: '/unblock', help: 'cmd.unblock' },
  { name: '/remove', help: 'cmd.remove' },
  { name: '/add', help: 'cmd.add' },
  { name: '/invite', help: 'cmd.invite' },
  { name: '/reconnect', help: 'cmd.reconnect' },
  { name: '/ping', help: 'cmd.ping' },
  { name: '/status', help: 'cmd.status' },
  { name: '/lock', help: 'cmd.lock' },
  { name: '/pass', help: 'cmd.pass' },
  { name: '/voice', help: 'cmd.voice' },
  { name: '/del', help: 'cmd.del' },
  { name: '/route', help: 'cmd.route' },
  { name: '/edit', help: 'cmd.edit' },
  { name: '/react', help: 'cmd.react' },
  { name: '/reply', help: 'cmd.reply' },
  { name: '/unread', help: 'cmd.unread' },
  { name: '/later', help: 'cmd.later' },
  { name: '/forward', help: 'cmd.forward' },
  { name: '/wake', alias: '/w', help: 'cmd.wake' },
  { name: '/mouse', alias: '/m', help: 'cmd.mouse' },
  { name: '/sound', help: 'cmd.sound' },
  { name: '/emo', help: 'cmd.emo' },
  { name: '/happy', alias: '/a', help: 'cmd.happy' },
  { name: '/sad', alias: '/d', help: 'cmd.sad' },
  { name: '/neutral', alias: '/n', help: 'cmd.neutral' },
  { name: '/code', help: 'cmd.code' },
  { name: '/asc', help: 'cmd.asc' },
  { name: '/ai', help: 'cmd.ai' },
  { name: '/stop', help: 'cmd.stop' },
  { name: '/version', alias: '/v', help: 'cmd.version' },
  { name: '/diagnose', help: 'cmd.diagnose' },
  { name: '/net', help: 'cmd.net' },
  { name: '/changelog', help: 'cmd.changelog' },
  { name: '/remind', alias: '/r', help: 'cmd.remind' },
  { name: '/lang', alias: '/l', help: 'cmd.lang' },
  { name: '/name', help: 'cmd.name' },
  { name: '/nick', alias: '/k', help: 'cmd.nick' },
  { name: '/logs', help: 'cmd.logs' },
  { name: '/settings', help: 'cmd.settings' },
  { name: '/update', alias: '/u', help: 'cmd.update' },
  { name: '/autoupdate', help: 'cmd.autoupdate' },
  { name: '/sysmsg', help: 'cmd.sysmsg' },
  { name: '/restart', help: 'cmd.restart' },
  { name: '/logo', help: 'cmd.logo' },
  { name: '/holiday', help: 'cmd.holiday' },
  { name: '/saver', help: 'cmd.saver' },
  { name: '/typing', help: 'cmd.typing' },
  { name: '/badge', help: 'cmd.badge' },
  { name: '/theme', alias: '/t', help: 'cmd.theme' },
  { name: '/clear', alias: '/c', help: 'cmd.clear' },
  { name: '/quit', alias: '/q', help: 'cmd.quit' },
];

// Only where there is a send queue to retry from — the native core's. It is not
// in `chatCommands`, so the catalog, --help and the AI's own command list stay
// exactly what they were everywhere else; `buildChatCommands` adds it, right
// after /forward, only when it is handed a `retryFailed` handler.
export const RETRY_COMMAND = Object.freeze({ name: '/retry', help: 'cmd.retry' });

// Same rule for the native core's end-to-end encryption commands
// (src/e2ee-commands.js): not in `chatCommands`, listed after /retry (or after
// /forward) only when `buildChatCommands` is handed an `e2ee` object.
export const E2EE_COMMANDS = Object.freeze([
  Object.freeze({ name: '/verify', help: 'cmd.verify' }),
  Object.freeze({ name: '/safety', help: 'cmd.safety' }),
  Object.freeze({ name: '/trust', help: 'cmd.trust' }),
  Object.freeze({ name: '/backup', help: 'cmd.backup' }),
  Object.freeze({ name: '/keys', help: 'cmd.keys' }),
]);

// The subset of tailchat's own commands the AI may run itself, when asked — a
// line with just a command on it, exactly as a person would type it (see
// splitCommands in ai.js). Every entry is one of: purely local (theme, clear,
// logo, holiday, saver, mouse, diagnose), read-only with its real output captured and
// fed back (help, version, files, history, changelog — see askAiReply), one
// of the four that speak into the chat (happy, sad, neutral, asc — routed through
// the AI's own identity, see aiCommandTable below), or session lifecycle
// (reconnect, update, restart, quit — explicitly asked for by the person
// running this client; update and restart end the process to apply the
// change, exactly as they would for a person typing the same command).
// Nothing here sends a file, reaches another machine or touches a secret.
export const AI_SAFE_COMMANDS = [
  '/theme', '/clear', '/logo', '/holiday', '/saver', '/mouse',
  '/asc', '/happy', '/sad', '/neutral',
  '/help', '/version', '/files', '/history', '/changelog', '/diagnose', '/net',
  '/roster',
  '/remind',
  '/autoupdate',
  '/sysmsg',
  '/ping', '/status', '/lock',
  '/invite',
  '/reconnect', '/update', '/restart', '/quit',
];
// commandTable (aiCommandTable) these arrive under its own name instead.
export const AI_SPEECH_COMMANDS = ['/happy', '/sad', '/neutral', '/asc'];

export const chatKeys = [
  'key.enter',
  'key.newline',
  'key.select',
  'key.mouse',
  'key.codeBlock',
  'key.pasteToggle',
  'key.paste',
  'key.scrollLine',
  'key.scrollPage',
  'key.wheel',
  'key.scrollbar',
  'key.arrows',
  'key.rosterSwitch',
  'key.rosterMouse',
  'key.homeEnd',
  'key.killLine',
  'key.killWord',
  'key.killToEnd',
  'key.clearDraft',
  'key.delete',
  'key.quit',
];

const pad = (rows) => {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
};

// A slash command is handled inside the Enter keypress which submitted it.
// Showing the saver synchronously lets a terminal's trailing Enter byte wake it
// immediately. Queueing playback one turn later makes activation independent of
// whether that terminal emits CR, LF, or both.
export function queueSaverPlayback(
  ui,
  frames,
  options,
  defer = setImmediate,
) {
  defer(() => ui.playSaverScreen(frames, options));
}

export function usageText(t = createTranslator(detectLanguage())) {
  const flags = pad(cliFlags.map(({ flag, value, help }) => [
    value ? `${flag} ${value}` : flag,
    t(help),
  ]));
  const commands = pad(chatCommands.map(({ name, alias, help }) => [
    alias ? `${name}, ${alias}` : name,
    t(help),
  ]));
  return [
    `tailchat v${VERSION} — ${t('usage.summary')}`,
    '',
    t('usage.usage'),
    '  tailchat <peer-addr> [flags]',
    '',
    `  <peer-addr>  ${t('usage.peerArg')}`,
    '',
    t('usage.flags'),
    ...flags,
    '',
    t('usage.commands'),
    ...commands,
    '',
    t('usage.keys'),
    ...chatKeys.map((key) => `  ${t(key)}`),
    '',
    `  ${t('help.markers')}`,
  ].join('\n');
}
// Handlers live beside the documented names so the two cannot drift apart.
export function buildChatCommands(ctx) {
  const {
    shutdown, restartClient, ui, listFiles, openFile, sendFile, sendClipboardImage, sendWake,
    showHistory, sendText, selfUpdate, showVersion, showDiagnostics, showChangelog, reconnectPeer, switchPeer,
    showNetwork = () => {},
    switchPeerP2p = () => {},
    switchPeerCloud = () => {},
    switchLanguage, switchName, switchNickname, switchLink, switchLogging, switchTheme, switchTyping, switchHoliday,
    switchSound = () => {},
    switchNameBadge = () => {},
    switchRosterRows = () => {},
    showSettings, askAi, stopAi, clearScreen, showLogo, showSaver, pingPeer, showStatus,
    lockScreen, switchPassword, sendVoiceNote, runRemind, switchAutoupdate, switchSysmsg,
    runInvite = () => {},
    addFriend = () => {},
    blockPeer = () => {},
    unblockPeer = () => {},
    removePeer = () => {},
    deleteMessages = () => {},
    editLastMessage = () => {},
    reactLastMessage = () => {},
    replyToMessage = () => {},
    markConversationUnread = () => {},
    remindReplyToMessage = () => {},
    forwardMessage = () => {},
    retryFailed = null,
    e2ee = null,
    showRoute = () => {},
    viewImage = () => {},
    t = createTranslator('en'),
  } = ctx;
  const extras = [
    ...(typeof retryFailed === 'function' ? [RETRY_COMMAND] : []),
    ...(e2ee ? E2EE_COMMANDS : []),
  ];
  const catalog = extras.length > 0
    ? chatCommands.flatMap((command) => (command.name === '/forward' ? [command, ...extras] : [command]))
    : chatCommands;
  // A name and its explanation, taken apart so the two can line up in columns.
  // Every language writes these the same way, and a line without the dash simply
  // has nothing to put in the left column.
  function splitRow(text) {
    const at = String(text).indexOf(' — ');
    return at === -1 ? ['', String(text)] : [text.slice(0, at), text.slice(at + 3)];
  }

  const helpSections = () => ({
    commands: {
      title: t('help.commands'),
      // The alias gets its own column: a ragged second word is as hard to scan
      // as no column at all.
      rows: (() => {
        const wide = Math.max(...catalog.map((c) => c.name.length));
        return catalog.map((c) => [
          `${c.name.padEnd(wide)}  ${c.alias ?? ''}`.replace(/\s+$/, ''),
          t(c.help),
        ]);
      })(),
    },
    keys: { title: t('help.keys'), rows: chatKeys.map((key) => splitRow(t(key))) },
    flags: {
      title: t('help.flags'),
      rows: cliFlags.map(({ flag, value, help }) => [
        value ? `${flag} ${value}` : flag,
        t(help),
      ]),
    },
    more: {
      title: t('help.sectionMore'),
      rows: [
        splitRow(t('help.markers')),
        splitRow(t('help.markdown')),
        ['', ui.focusTracked?.() ? t('help.focusYes') : t('help.focusNo')],
      ],
    },
  });

  const wordsFor = (key) => Object.values(DICTIONARIES)
    .map((dict) => dict[key])
    .filter(Boolean);

  // Typed by a person mid-conversation, so the word has to be recognised whatever
  // language it comes in.
  function helpWanted(arg) {
    const asked = String(arg ?? '').trim().toLowerCase();
    if (asked === '') return ['commands'];
    // Every language's word, not just the one the interface happens to be in: the
    // person types what they think in, and the interface language is often not it.
    const names = {
      commands: wordsFor('help.wordCommands'),
      keys: wordsFor('help.wordKeys'),
      flags: wordsFor('help.wordFlags'),
      all: wordsFor('help.wordAll'),
    };
    for (const [section, words] of Object.entries(names)) {
      if (words.some((word) => String(word).toLowerCase() === asked)) {
        return section === 'all' ? ['commands', 'keys', 'flags', 'more'] : [section];
      }
    }
    return null;
  }

  function showHelp(arg) {
    const wanted = helpWanted(arg);
    if (!wanted) {
      return ui.addLine(`* ${t('help.unknownSection', { arg: String(arg).trim() })}`);
    }
    const sections = helpSections();
    for (const name of wanted) {
      const { title, rows } = sections[name];
      ui.addSection(title, rows);
    }
    if (wanted.length === 1 && wanted[0] === 'commands') {
      ui.addLine(`* ${t('help.more')}`);
    }
    return undefined;
  }

  const runners = {
    '/help': (arg) => showHelp(arg),
    '/send': (arg) => sendFile(arg),
    '/paste': () => sendClipboardImage(),
    '/files': () => listFiles(),
    '/open': (arg) => openFile(arg),
    '/view': (arg) => viewImage(arg),
    '/history': () => showHistory(),
    '/peer': (arg) => switchPeer(arg),
    '/friends': (arg) => switchPeer(arg),
    '/p2p': (arg) => switchPeerP2p(arg),
    '/cloud': (arg) => switchPeerCloud(arg),
    '/roster': (arg) => switchRosterRows(arg),
    '/link': (arg) => switchLink(arg),
    '/block': (arg) => blockPeer(arg),
    '/unblock': (arg) => unblockPeer(arg),
    '/remove': (arg) => removePeer(arg),
    '/add': (arg) => addFriend(arg),
    '/invite': (arg) => runInvite(arg),
    '/inv': (arg) => runInvite(arg),
    '/reconnect': () => reconnectPeer(),
    '/ping': () => pingPeer?.(),
    '/status': () => showStatus?.(),
    '/lock': () => lockScreen?.(),
    '/pass': (arg) => switchPassword?.(arg),
    '/voice': (arg) => sendVoiceNote?.(arg),
    '/wake': () => sendWake(),
    '/del': (arg) => deleteMessages(arg),
    '/edit': (arg) => editLastMessage(arg),
    '/react': (arg) => reactLastMessage(arg),
    '/reply': (arg) => replyToMessage(arg),
    '/unread': () => markConversationUnread(),
    '/later': (arg) => remindReplyToMessage(arg),
    '/forward': (arg) => forwardMessage(arg),
    '/retry': () => retryFailed?.(),
    '/verify': (arg) => e2ee?.verify(arg),
    '/safety': (arg) => e2ee?.safety(arg),
    '/trust': () => e2ee?.trust(),
    '/backup': (arg) => e2ee?.backup(arg),
    '/keys': (arg) => e2ee?.keys(arg),
    '/route': () => showRoute(),
    '/mouse': () => {
      const on = ui.setMouseCapture(!ui.isMouseCaptured());
      const msg = `* ${on ? t('mouse.on') : t('mouse.off')}`;
      ui.addLine(msg);
      return msg;
    },
    '/sound': (arg) => switchSound(arg),
    '/emo': async () => {
      const picked = await ui.pickFromList({
        label: 'emojis',
        rows: EMOJIS.map(e => ({ name: e.emoji, help: e.help })),
      });
      if (picked) sendText(picked);
    },
    '/happy': () => sendText(EMOTICONS['/happy']),
    '/sad': () => sendText(EMOTICONS['/sad']),
    '/neutral': () => sendText(EMOTICONS['/neutral']),
    '/code': (arg) => {
      const code = String(arg ?? '').trim();
      if (code === '') return ui.addLine(`* ${t('code.usage')}`);
      return sendText(`\`\`\`\n${code}\n\`\`\``);
    },
    '/asc': (arg) => {
      const result = pickArt(arg);
      if (!result.ok) return ui.addLine(`* ${t('asc.moods', { moods: result.moods.join(', ') })}`);
      return sendText(result.art);
    },
    '/ai': (arg) => askAi(arg),
    '/stop': () => stopAi(),
    '/version': () => showVersion(),
    '/diagnose': () => showDiagnostics(),
    '/net': () => showNetwork(),
    '/changelog': (arg) => showChangelog(arg),
    '/remind': (arg) => runRemind?.(arg),
    '/lang': (arg) => switchLanguage(arg),
    '/name': (arg) => switchName(arg),
    '/nick': (arg) => switchNickname(arg),
    '/logs': (arg) => switchLogging(arg),
    '/settings': () => showSettings(),
    '/update': () => selfUpdate(),
    '/autoupdate': (arg) => switchAutoupdate?.(arg),
    '/sysmsg': (arg) => switchSysmsg?.(arg),
    '/restart': () => restartClient(),
    '/logo': () => showLogo(),
    '/holiday': (arg) => switchHoliday(arg),
    '/saver': (arg) => showSaver(arg),
    '/typing': (arg) => switchTyping(arg),
    '/badge': (arg) => switchNameBadge(arg),
    '/theme': (arg) => switchTheme(arg),
    '/clear': () => clearScreen(),
    '/quit': () => shutdown(),
  };
  return catalog.map(({ name, alias, help }) => ({
    name, alias, help: t(help), run: runners[name],
  }));
}

export function resolveReactionCommand(arg, recentMessageIds) {
  const words = String(arg ?? '').trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? '';
  // A bare number picks that position in EMOJIS instead of typing the emoji
  // itself out — /react 1 is 👌, /react 2 is 👍, through /react 8 for 🙏 (see
  // src/emoji.js) — which is what a terminal, without a tappable picker, needs
  // for reacting to be as fast as the web client's popover. Anything outside
  // that range is not a shortcut; it falls through to the emoji check below
  // and reports the ordinary usage error, same as any other unrecognised token.
  const slot = /^\d+$/.test(first) ? Number(first) : null;
  const emoji = (slot !== null && slot >= 1 && slot <= EMOJIS.length) ? EMOJIS[slot - 1].emoji : first;
  const index = words[1] === undefined ? 1 : Number(words[1]);
  if (
    words.length > 2
    || !(EMOJIS.some((item) => item.emoji === emoji) || emoji.replace(/\uFE0F/gu, '') === '❤')
    || !Number.isInteger(index)
    || index < 1
  ) {
    return { error: 'react.usage' };
  }
  const id = recentMessageIds({ limit: index })[index - 1];
  return id ? { id, emoji } : { error: 'react.nothing' };
}

export function resolveReplyReminderCommand(arg, {
  recentMessageIds,
  messageById,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  now = Date.now(),
}) {
  const match = /^(\S+)\s+(15m|1h|evening|tomorrow)$/iu.exec(String(arg ?? '').trim());
  if (!match) return { error: 'later.usage' };
  const [, target, preset] = match;
  let id = target;
  if (target.toLowerCase() === 'last') {
    [id] = recentMessageIds({ limit: 1 });
  } else if (/^\d+$/u.test(target)) {
    const index = Number(target);
    if (!Number.isSafeInteger(index) || index < 1) return { error: 'later.notFound', target };
    id = recentMessageIds({ limit: index })[index - 1];
  }
  if (!id || !messageById(id)) return { error: 'later.notFound', target };
  const dueAt = presetDue(preset.toLowerCase(), { timezone, now });
  return Number.isFinite(dueAt)
    ? { id, dueAt, preset: preset.toLowerCase() }
    : { error: 'later.usage' };
}

// Resolve the terminal's compact reply target into the immutable quote that
// travels with the new message. Kept independent of transport so the same
// 1-based recency rule is testable without starting a network session.
export function resolveReplyCommand(arg, {
  recentMessageIds,
  messageById,
  selfLogin,
  peerLogin,
}) {
  const match = /^(\S+)\s+([\s\S]+)$/u.exec(String(arg ?? '').trim());
  if (!match || match[2].trim() === '') return { error: 'reply.usage' };
  const [, target, rawText] = match;
  let id = target;
  if (/^\d+$/u.test(target)) {
    const index = Number(target);
    if (!Number.isSafeInteger(index) || index < 1) {
      return { error: 'reply.notFound', target };
    }
    id = recentMessageIds({ limit: index })[index - 1];
  }
  const original = messageById(id);
  if (!original) return { error: 'reply.notFound', target };

  const replyTo = {
    id: original.id,
    from: original.self ? selfLogin : peerLogin,
    author: original.name || (original.self ? selfLogin : peerLogin),
    text: original.text.slice(0, 200),
  };
  if (replyTo.text === '' && ['image', 'voice', 'file'].includes(original.media)) {
    replyTo.media = original.media;
  }
  return { text: rawText.trim(), replyTo };
}

// A reply is the one text path whose immutable quote must share the message
// frame. Ordinary text keeps using the transport's compact send() call.
// The core's edits not yet confirmed, by the id of the message each travels in.
// An edit shows in the transcript at once; the core can still refuse it, or give
// up on it in its queue, and then the old words go back and a line says so — a
// refusal that only printed "message not sent" left the transcript claiming an
// edit the other side never got.
export function createCoreEdits(ui, say, limit = 100) {
  const pending = new Map();
  return {
    remember(carrier, id, text) {
      const before = ui.messageById(id);
      pending.delete(carrier);
      pending.set(carrier, { id, shown: text, text: before?.text ?? null, edited: Boolean(before?.edited) });
      if (pending.size > limit) pending.delete(pending.keys().next().value);
    },
    // `true` when `carrier` was one of ours (the caller then has nothing to add).
    fail(carrier) {
      const edit = carrier ? pending.get(carrier) : null;
      if (!edit) return false;
      pending.delete(carrier);
      const now = ui.messageById(edit.id);
      // Not if the row was edited again since: those are other words now.
      if (now && edit.text !== null && now.text === edit.shown) {
        ui.updateMessage(edit.id, edit.text, { edited: edit.edited, reset: true });
      }
      say();
      return true;
    },
    done(carrier) {
      return carrier ? pending.delete(carrier) : false;
    },
  };
}

export function sendTextOverTransport(rz, {
  id, ts, text, replyTo = null, forwardedFrom = null,
}) {
  if (!replyTo && !forwardedFrom) return rz.send(text, ts, id);
  // On the core the quote and the forward label are part of the sealed
  // message; a refusal is the core's to report, never a reason to send the
  // same words in the open.
  if (rz.canSealed?.()) {
    return rz.sendWith(text, { replyTo, forwardedFrom }, id) !== null;
  }
  const frame = { t: 'msg', id, ts, text };
  if (replyTo) frame.replyTo = replyTo;
  if (forwardedFrom) frame.forwardedFrom = forwardedFrom;
  return rz.sendFrame(frame);
}

// `/forward <id|N>` — the referenced message said again, in this conversation,
// with the name of whoever said it first attached. The terminal talks to one
// peer at a time (the hub allows exactly one subscription per connection), so
// «переслать» here means «переслать сюда»: switch conversation with /peer
// first, then forward what you copied.
export function resolveForwardCommand(arg, {
  recentMessageIds,
  messageById,
  selfLogin,
  selfName,
  peerLogin,
  peerName,
}) {
  const target = String(arg ?? '').trim();
  if (target === '') return { error: 'forward.usage' };
  let id = target;
  if (/^\d+$/u.test(target)) {
    const index = Number(target);
    if (!Number.isSafeInteger(index) || index < 1) return { error: 'forward.notFound', target };
    id = recentMessageIds({ limit: index })[index - 1];
  }
  const original = messageById(id);
  if (!original) return { error: 'forward.notFound', target };
  const text = typeof original.text === 'string' ? original.text.trim() : '';
  if (text === '') return { error: 'forward.empty', target };
  return {
    text,
    forwardedFrom: {
      login: original.self ? selfLogin : peerLogin,
      name: original.name || (original.self ? selfName : peerName),
    },
  };
}

// Where the cached history of one Cloud conversation lives: a JSON file per
// login, beside the transcripts. The session writes them (see cloudCacheWrites
// in main) and `/remove` deletes one, so the naming has a single home.
export function cloudCacheFile(stateDir, login) {
  const clean = String(login ?? '').replace(/^@/, '').toLowerCase();
  if (!clean) return null;
  return path.join(stateDir, 'cloud-cache', `${clean}.json`);
}

// Session-level cache and write queue for encrypted Cloud message history (issue #20).
//
// A conversation is megabytes on disk — inline pictures and voice notes ride
// in it as data URLs — and decrypting it synchronously on every switch freezes
// the UI. Decrypting each contact once in memory per session makes switching
// contacts instant (0ms).
//
// Preloading every contact at startup put a dozen writes in a row, each one a
// stutter for anyone switching conversations while it ran. One write per file
// in flight, with the newest payload replacing whatever was still waiting: the
// file has to hold the latest state, never a queue of every state it passed
// through. `done` is that chain, so a caller that has to be sure the file is
// at rest — /remove, deleting one — can wait for it instead of racing it.
//
// The in-memory cache is bounded (LRU of 50 contacts) so resident set size stays
// bounded even in accounts with hundreds of friends.
export function createCloudCacheStore({
  stateDir,
  store = openDeviceStore(),
  maxCached = 50,
  onWriteFailed = () => {},
} = {}) {
  const sessionCloudCache = new Map();
  const cloudCacheWrites = new Map();
  const historyRequests = new Map();

  function touchCache(clean, messages) {
    sessionCloudCache.delete(clean);
    sessionCloudCache.set(clean, messages);
    if (sessionCloudCache.size > maxCached) {
      const oldest = sessionCloudCache.keys().next().value;
      sessionCloudCache.delete(oldest);
    }
  }

  function queueCloudCacheWrite(file, messages) {
    const waiting = cloudCacheWrites.get(file);
    if (waiting) {
      waiting.payload = messages;
      return;
    }
    const state = { payload: messages, done: null };
    cloudCacheWrites.set(file, state);
    const step = () => {
      const payload = state.payload;
      state.payload = null;
      if (!payload) {
        cloudCacheWrites.delete(file);
        return undefined;
      }
      return Promise.resolve()
        .then(() => store.write(file, Buffer.from(JSON.stringify(payload))))
        .catch((error) => onWriteFailed(error))
        .then(step);
    };
    state.done = Promise.resolve().then(step).catch(() => {});
    void state.done;
  }

  function load(peerLogin) {
    if (!peerLogin) return [];
    const clean = String(peerLogin).replace(/^@/, '').toLowerCase();
    if (sessionCloudCache.has(clean)) {
      const cached = sessionCloudCache.get(clean);
      touchCache(clean, cached);
      return cached;
    }
    const file = cloudCacheFile(stateDir, clean);
    if (!file) return [];
    let raw;
    try { raw = store.read(file); }
    catch (error) {
      if (error.code === 'ENOENT' && !fs.existsSync(file)) {
        touchCache(clean, []);
        return [];
      }
      throw error;
    }
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!Array.isArray(parsed)) throw new Error(`Corrupted encrypted Cloud cache: ${file}`);
    touchCache(clean, parsed);
    return parsed;
  }

  function save(peerLogin, messages) {
    if (!peerLogin || !Array.isArray(messages)) return;
    const clean = String(peerLogin).replace(/^@/, '').toLowerCase();
    const file = cloudCacheFile(stateDir, clean);
    if (!file) return;
    touchCache(clean, messages);
    queueCloudCacheWrite(file, messages);
  }

  // An HTTP history snapshot can finish after the socket appended a newer
  // message. Replace the snapshot's old rows, but keep arrivals that were not
  // present when it was requested (and unsent local messages). Concurrent
  // preload/replay requests are ordered per conversation, not by response time.
  async function refresh(peerLogin, fetchMessages) {
    const clean = String(peerLogin ?? '').replace(/^@/, '').toLowerCase();
    if (!clean) return null;
    const request = {};
    historyRequests.set(clean, request);
    const before = new Set(load(clean));
    const beforeIds = new Set([...before].map((message) => message.id).filter(Boolean));
    try {
      const fresh = await fetchMessages();
      if (historyRequests.get(clean) !== request || !Array.isArray(fresh)) return null;
      const freshIds = new Set(fresh.map((message) => message.id).filter(Boolean));
      const arrivals = load(clean).filter((message) => (
        (message.marker === '⧗' || (message.id ? !beforeIds.has(message.id) : !before.has(message)))
        && (!message.id || !freshIds.has(message.id))
      ));
      const messages = arrivals.length > 0
        ? [...fresh, ...arrivals].sort((a, b) => (a.ts || 0) - (b.ts || 0))
        : fresh;
      const keptIds = new Set(messages.map((message) => message.id).filter(Boolean));
      const removedIds = [...beforeIds].filter((id) => !keptIds.has(id));
      save(clean, messages);
      return { messages, removedIds };
    } finally {
      if (historyRequests.get(clean) === request) historyRequests.delete(clean);
    }
  }

  // Drops the cached history of one contact, waiting out the write that may
  // already be in flight — otherwise a payload queued a moment ago would land
  // on disk *after* the cache was deleted.
  async function drop(peerLogin) {
    if (!peerLogin) return;
    const clean = String(peerLogin).replace(/^@/, '').toLowerCase();
    historyRequests.delete(clean);
    sessionCloudCache.delete(clean);
    const file = cloudCacheFile(stateDir, clean);
    if (!file) return;
    const waiting = cloudCacheWrites.get(file);
    if (waiting) {
      waiting.payload = null;
      await waiting.done;
    }
    cloudCacheWrites.delete(file);
    try {
      fs.rmSync(store.fileFor(file), { force: true });
    } catch { /* already gone */ }
  }

  function append(peerLogin, msg) {
    if (!peerLogin || !msg) return;
    const cached = load(peerLogin);
    if (msg.id && cached.some((m) => m.id === msg.id)) return;
    cached.push(msg);
    save(peerLogin, cached);
  }

  async function flush(peerLogin) {
    if (!peerLogin) return Promise.all([...cloudCacheWrites.values()].map((w) => w.done));
    const clean = String(peerLogin).replace(/^@/, '').toLowerCase();
    const file = cloudCacheFile(stateDir, clean);
    const waiting = cloudCacheWrites.get(file);
    if (waiting) await waiting.done;
  }

  return {
    load,
    save,
    refresh,
    drop,
    append,
    flush,
    sessionCache: sessionCloudCache,
  };
}

// Everything on this machine that holds a Cloud contact's conversation: the
// transcript, the cached history the relay's copy is replayed from, the frames
// still waiting for a link, and the remembered device and nickname. Named in
// one place so `/remove` cannot quietly leave one behind, and so a test and the
// handler mean the same files. `active` carries the paths of the conversation
// that is open right now — those are live objects (see log.js and
// outbox-store.js), while a contact that is not open is reached through the
// same derived names every other per-conversation file uses.
function contactStorageFiles({ stateDir, login, active = null }) {
  const key = `cloud-${login}`;
  return [
    active ? active.log : defaultLogPath(stateDir, key),
    active ? active.outbox : outboxFileFor(stateDir, key),
    cloudCacheFile(stateDir, login),
    active ? active.memory : peerMemoryFile(stateDir, key),
  ].filter(Boolean);
}

// `/remove`, end to end: the contact, the refusals that must come before
// anything leaves the machine, the question that has to be asked, the one call
// to the server, and then every local trace of the person. Exported because the
// three things it has to get right — the login the API is given, the local
// files that go, and the refusals and failures that leave everything exactly as
// it was — are worth proving without a running session, a server or a
// terminal.
//
// What the server does is one-sided and permanent: the contact and this
// account's side of the conversation go, on every device this account runs on,
// the other person keeps both and is never told, and the API is idempotent (see
// removeContact in src/cloud/accounts.js).
//
// A refusal comes back as `{ ok: false, key, params }` for the caller to say in
// the person's own language; on that path nothing is written, nothing is
// deleted, and for the local refusals the server is not called at all.
export async function removeCloudContact({
  stateDir,
  login,
  selfLogin = null,
  contacts = [],
  api = null,
  confirm = async () => false,
  active = null,
  closeLog = null,
  dropCache = null,
  onRemoved = null,
  t = createTranslator('en'),
} = {}) {
  const wanted = String(login ?? '').trim().replace(/^@/, '');
  if (!wanted) return { ok: false, key: 'remove.usage' };
  const needle = wanted.toLowerCase();
  if (selfLogin && String(selfLogin).toLowerCase() === needle) {
    // Saved Messages is this account's own thread; the server refuses it too
    // (400 self_remove), and there is nothing here to delete.
    return { ok: false, key: 'remove.self' };
  }
  if (typeof api?.removeContact !== 'function') return { ok: false, key: 'remove.offline' };
  // The friend list is the only authority on who is a contact, so a login that
  // is not on it — a typo, someone else's login — is refused here rather than
  // sent.
  const contact = (Array.isArray(contacts) ? contacts : [])
    .find((u) => String(u?.login ?? '').toLowerCase() === needle);
  if (!contact) return { ok: false, key: 'remove.unknown', params: { login: wanted } };
  // tailchat and tailik answer from the server itself and cannot be removed at
  // all; the API agrees with 403 official_contact, and the action is never
  // offered on them in the first place.
  if (contact.official) return { ok: false, key: 'remove.official' };
  if (!(await confirm(contact.login))) {
    return { ok: false, key: 'remove.cancelled', params: { login: contact.login } };
  }
  try {
    await api.removeContact(contact.login);
  } catch (error) {
    // A refusal or a dead server: the conversation is still on the server, so
    // nothing local is touched either. The two halves must never disagree.
    return { ok: false, key: 'remove.failed', params: { reason: describeApiError(error, t) } };
  }
  // The server has let this person go; the local half is ours. The transcript
  // is the only artifact with an open handle, and it is closed before the file
  // underneath it is unlinked: on Windows an open file cannot be removed at
  // all, and on POSIX the lines already buffered would land in an inode nothing
  // can reach.
  if (active && closeLog) await closeLog();
  if (dropCache) await dropCache(contact.login);
  for (const file of contactStorageFiles({ stateDir, login: contact.login, active })) {
    const encrypted = /(?:\.log|outbox-.*\.json|cloud-cache[/\\\\].*\.json)$/.test(file);
    try {
      fs.rmSync(encrypted ? `${file}.enc` : file, { force: true });
      // Legacy plaintext is retained until its exact path, size and recovery
      // have been separately confirmed; /remove's contact prompt is not that.
    } catch { /* a file that is already gone is not a failure */ }
  }
  if (onRemoved) onRemoved(contact.login);
  return { ok: true, login: contact.login, key: 'remove.success', params: { login: contact.login } };
}

// The contact's row, on disk: the roster's remembered devices for this person
// (and for the Tailscale/LAN selector an explicit /link filed them under), and
// every /link that named this login — a link left behind would keep filing a
// tailnet peer's history under a contact that no longer exists. The session's
// own lists (`cloud.users`, the unread badges, the recency the picker sorts by)
// are dropped by the caller, which is the half with no file to write.
export function forgetContactEntry(stateDir, login, selector = null) {
  const needle = String(login).toLowerCase();
  forgetDevices(stateDir, login);
  if (selector && selector.toLowerCase() !== needle) forgetDevices(stateDir, selector);
  for (const [linked, cloudLogin] of Object.entries(readPeerLinks(stateDir).links)) {
    if (String(cloudLogin).toLowerCase() === needle) unlinkPeer(stateDir, linked);
  }
}

// `/invite`, end to end: which of its two actions the argument names, the one
// call that reaches the server, and the one line that comes back — the code
// itself when it worked, the server's own refusal as a sentence when it did
// not. Exported because a login and a 64-hex code look alike in an argument,
// and because "did the login reach the API, and did the code reach the screen?"
// is worth proving without a session, a server or a terminal.
//
// The link belongs to the account named after `create`: whoever accepts it
// becomes that account's friend, not the caller's. Only the deployment owner
// may mint somebody else's link, and the server answers `forbidden` when they
// may not (see createInvite in src/cloud/api.js).
export async function runInviteCommand({ arg, api = null, ui, t = createTranslator('en') } = {}) {
  if (!api) return ui.addLine(`* ${t('cloud.onlyCloud')}`);
  const clean = String(arg ?? '').trim();
  const parts = clean.split(/\s+/);
  const action = parts[0]?.toLowerCase();

  if (action === 'create' || action === 'new' || clean === '') {
    // Everything after the action is the account the link is for; with nothing
    // after it this is the caller's own link, exactly as it was.
    const login = parts.slice(1).join(' ').trim();
    ui.addLine(`* ${t('cloud.creatingInvite')}`);
    try {
      const inviteCode = await api.createInvite(login);
      // A link, not the code: the code is useless on its own to anybody who has
      // not been told where to type it, and everything that accepts one accepts
      // the link built out of the same server (`parseInviteCode` here, the
      // server's own extraction in every other client).
      const inviteLink = api.server ? `${cloudWebUrl(api.server)}?invite=${inviteCode}` : inviteCode;
      ui.addLine(`* ${t('cloud.inviteCreated')}`);
      ui.addLine(`* ${inviteLink}`);
      ui.addLine(`* ${t('cloud.myInviteHelp')}`);
    } catch (err) {
      ui.addLine(`* ${describeApiError(err, t)}`);
    }
    return undefined;
  }

  // Everything else is accept, and the form people usually have in hand is the
  // whole link: `?invite=<64 hex>` is unwrapped from it before the code is
  // judged, so a link pasted after `accept` is never read as a login.
  const token = parts[1] || (parts[0]?.length === 64 ? parts[0] : null);
  const rawToAccept = token || (action === 'accept' ? parts.slice(1).join(' ') : null) || parts[0];
  let codeToAccept = rawToAccept;
  if (typeof codeToAccept === 'string') {
    const match = /[?&]invite=([a-f0-9]{64})/i.exec(codeToAccept.trim());
    if (match) codeToAccept = match[1];
  }
  if (codeToAccept && /^[a-f0-9]{64}$/i.test(codeToAccept.trim())) {
    ui.addLine(`* ${t('cloud.checkingInvite')}`);
    try {
      const friend = await api.acceptInvite(codeToAccept.trim());
      ui.addLine(`* ${t('cloud.friendAdded', { name: friend.name || friend.login })}`);
      ui.addLine(`* ${t('cloud.switchWithPeerHint', { name: friend.login })}`);
    } catch (err) {
      ui.addLine(`* ${describeApiError(err, t)}`);
    }
    return undefined;
  }

  ui.addLine('* Usage: /invite create [login]   or   /invite accept <invite-link-or-code>');
  return undefined;
}

// `/add`, end to end: a friend request to the one address a person already has
// for somebody — their @username — with no code to hand over first. The server
// delivers the request to the addressee, who accepts or declines it in their
// {tailchat} thread; this side only says which of the two things happened.
// Exported for the same reason `runInviteCommand` is: the argument a person
// types and the two answers that come back are worth proving without a
// session, a server or a terminal.
export async function runAddCommand({ arg, api = null, ui, t = createTranslator('en') } = {}) {
  if (!api) return ui.addLine(`* ${t('cloud.onlyCloud')}`);
  // People copy the address as they see it written elsewhere, with the `@`.
  // The server strips one too, but a login shown back before the request is
  // sent should already read the way the roster spells it.
  const login = String(arg ?? '').trim().replace(/^@/, '').trim();
  if (!login) return ui.addLine(`* ${t('add.usage')}`);

  ui.addLine(`* ${t('cloud.requestingFriend', { login })}`);
  try {
    const { state, friend } = await api.requestFriend(login);
    // Already friends — the contact is in the roster now, and there is nothing
    // to wait for. Same line `/invite accept` ends on, for the same event.
    if (state === 'friends') {
      ui.addLine(`* ${t('cloud.friendAdded', { name: friend?.name || friend?.login || login })}`);
      ui.addLine(`* ${t('cloud.switchWithPeerHint', { name: friend?.login || login })}`);
      return undefined;
    }
    ui.addLine(`* ${t('cloud.friendRequested')}`);
  } catch (err) {
    ui.addLine(`* ${describeApiError(err, t)}`);
  }
  return undefined;
}

// The ladder src/ui.js ranks its markers by is imported, not copied, for the
// headless interface: there is no colour to tell a delivered ✓✓ from a read one,
// so the rank is what keeps a late ✓ from walking a ✓✓ back, and `markerRead`
// records which ✓✓ is which for callers that need to know.

export function createHeadlessUI({
  selfName = 'me',
  peerLabel = 'peer',
  t = createTranslator('en'),
} = {}) {
  let theme = DEFAULT_THEME;
  let peerName = peerLabel;
  let peerDev = '';
  let isSending = null;
  let isAiTyping = null;
  let mouseCapture = false;
  let peerPres = 'unknown';
  let currentStatus = 'offline';
  let currentTransport = '';
  let currentPeerClient = '';
  let messages = [];
  const messageEntry = (id) => messages.find((message) => message.id === id);
  function stripMarkup(str) {
    return String(str ?? '').replace(/\{[^}]+\}/g, '').replace(/\x1b\[[0-9;]*m/g, '');
  }

  return {
    isHeadless: true,
    selfName,
    addLine(line) {
      const clean = stripMarkup(line);
      process.stdout.write(`${clean}\n`);
    },
    addSection(title, rows) {
      if (title) process.stdout.write(`=== ${stripMarkup(title)} ===\n`);
      for (const row of rows ?? []) {
        if (typeof row === 'string') process.stdout.write(`  ${stripMarkup(row)}\n`);
        else if (row?.left || row?.text) process.stdout.write(`  ${stripMarkup(row.left || '')}: ${stripMarkup(row.text || '')}\n`);
      }
    },
    addArt(lines, file) {
      if (file) process.stdout.write(`[file: ${file}]\n`);
    },
    addMessage(message) {
      const previous = message.id ? messageEntry(message.id) : null;
      if (previous) {
        Object.assign(previous, mergeMessageState(previous, message));
        return;
      }
      messages.push({ ...message });
      if (messages.length > 2000) messages = messages.slice(-2000);
      const line = formatLine(message.ts || Date.now(), message.name, message.text);
      process.stdout.write(`${line}\n`);
    },
    // A pipe cannot repaint earlier lines; known ids update receipt/reply state
    // without printing the same message again when history catches the socket.
    addMessages(batch) {
      for (const message of batch ?? []) this.addMessage(message);
      messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      return batch?.length ?? 0;
    },
    bell() {
      process.stdout.write('\x07');
    },
    setTheme(name) {
      if (THEMES[name]) { theme = name; return true; }
      return false;
    },
    themeName() { return theme; },
    setNameBadge() {},
    nameBadge() { return true; },
    setMessageMarker(id, marker) {
      const message = messageEntry(id);
      if (!message) return false;
      if (!climbs(message.marker, marker)) return false;
      message.marker = marker;
      // Everything reaching here is the sent or delivered rung — the read one
      // arrives through markReadUpTo — so the flag is cleared, exactly as the
      // glyph buffer does.
      message.markerRead = false;
      return true;
    },
    markReadUpTo(id) {
      const at = messages.findIndex((message) => message.id === id);
      if (at < 0) return false;
      for (let i = 0; i <= at; i += 1) {
        if (!messages[i].self || !messages[i].marker) continue;
        // Same rule as the glyph buffer's markReadUpTo: a ⧗ or ⚠ the server
        // never took is not read, except the message the receipt itself names.
        if (i !== at && MARKER_RANK[messages[i].marker] === 0) continue;
        messages[i].marker = '✓✓';
        messages[i].markerRead = true;
      }
      return true;
    },
    updateMessage(id, text) {
      const message = messageEntry(id);
      if (!message || typeof text !== 'string') return false;
      message.text = text;
      return true;
    },
    setMessageReactions(id, reactions) {
      const message = messageEntry(id);
      if (!message) return false;
      message.reactions = reactions;
      return true;
    },
    applyReaction(id, emoji, by, add) {
      const message = messageEntry(id);
      if (!message) return false;
      const reactions = message.reactions ?? (message.reactions = {});
      const logins = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
      const at = logins.indexOf(by);
      if (add && at < 0 && logins.length < 100) logins.push(by);
      if (!add && at >= 0) logins.splice(at, 1);
      if (logins.length > 0) reactions[emoji] = logins;
      else delete reactions[emoji];
      return true;
    },
    reactionsOf(id) { return messageEntry(id)?.reactions ?? null; },
    markerOf(id) { return messageEntry(id)?.marker ?? null; },
    removeMessages(ids) {
      const wanted = new Set(ids);
      const before = messages.length;
      messages = messages.filter((message) => !wanted.has(message.id));
      return before - messages.length;
    },
    recentMessageIds({ self = null, limit = 1 } = {}) {
      const found = [];
      for (let i = messages.length - 1; i >= 0 && found.length < limit; i -= 1) {
        if (!messages[i].id || (self !== null && Boolean(messages[i].self) !== self)) continue;
        found.push(messages[i].id);
      }
      return found;
    },
    messageById(id) {
      const message = messageEntry(id);
      if (!message) return null;
      return {
        id: message.id,
        self: Boolean(message.self),
        name: message.name ?? null,
        text: typeof message.text === 'string' ? message.text : '',
        media: typeof message.media === 'string' ? message.media : null,
      };
    },
    wheelStep: 3,
    scrollHistory() {},
    isFollowingTail() { return true; },
    historyScrollOffset() { return 0; },
    setLogo() { return false; },
    width() { return process.stdout.columns || 80; },
    height() { return process.stdout.rows || 24; },
    onResize() {},
    playLogo() { return false; },
    playSaverScreen() { return false; },
    stopSaverScreen() {},
    saverActive() { return false; },
    saverFits() { return false; },
    hideSaverScreen() {},
    isSaverActive() { return false; },
    setUpdateAvailable(val) {},
    setStatus(status) {
      if (status !== currentStatus) {
        currentStatus = status;
        process.stdout.write(`[status] ${status}\n`);
      }
    },
    showLockScreen() {},
    isLocked() { return false; },
    dismissLockScreen() {},
    pickFromList() { return Promise.resolve(null); },
    setCommands() {},
    setDraft() {},
    getDraft() { return ''; },
    clearDraft() {},
    clearHistory() { messages = []; },
    clear() { messages = []; },
    setUnreadBadge() {},
    setRoster() {},
    onRosterSelect() {},
    onPeerPicker() {},
    recolor() {},
    completionMenu() {},
    completionRows() { return 0; },
    acceptCompletion() { return false; },
    selectCompletion() {},
    isExactCommand() { return false; },
    completionIndex() { return 0; },
    setPeerDevice(name) { peerDev = String(name ?? ''); },
    setPeerName(name) { peerName = name; },
    setTransport(label) {
      const next = String(label ?? '');
      if (next !== currentTransport) {
        currentTransport = next;
        if (next) process.stdout.write(`[transport] ${next}\n`);
      }
    },
    setPeerClient(label) {
      const next = String(label ?? '');
      if (next !== currentPeerClient) {
        currentPeerClient = next;
        if (next) process.stdout.write(`[peer-client] ${next}\n`);
      }
    },
    isFocused() { return false; },
    focusTracked() { return true; },
    __emitFocus() {},
    onInput() {},
    onTyping() {},
    setPeerTyping() {},
    clearPeerTyping() {},
    setSelfTyping() {},
    setSending(name) { isSending = name; },
    setAiTyping(name) { isAiTyping = name; },
    sendingLabel() { return isSending; },
    shimmerRunning() { return false; },
    setPeerPresence(state) { peerPres = state; },
    headerStatus() { return `${peerName} (${peerPres})`; },
    setMouseCapture(enabled) { mouseCapture = Boolean(enabled); return mouseCapture; },
    isMouseCaptured() { return mouseCapture; },
    onQuit(cb) {},
    onFocusChange(cb) {},
    onPasteImage(cb) {},
    onMouseToggle(cb) {},
    onPasteText(cb) {},
    onCopy(cb) {},
    onActivity(cb) {},
    onSaverWake(cb) {},
    onOpenImage(cb) {},
    onOpenLink(cb) {},
    selectLines() {},
    selectionRange() { return null; },
    selectedText() { return ''; },
    clearSelection() {},
    destroy() {},
  };
}

export function createRzFacade(getActiveTransport, options = {}) {
  const rz = new EventEmitter();
  // A blocked peer gets nothing: the local blocklist is P2P's only enforcement
  // (there is no server to ask), and cloud mode wants the same behaviour the
  // moment a block is set locally, without waiting on a round trip.
  const blocked = () => options.isBlocked?.() ?? false;
  rz.send = (text, ts, id) => (blocked() ? false : (getActiveTransport()?.send(text, ts, id) ?? false));
  rz.sendFrame = (frame) => (blocked() ? false : (getActiveTransport()?.sendFrame(frame) ?? false));
  // The native core's sealed actions (reply, forward, picture, voice, edit):
  // only a core transport has them, and `null` is "not handed over". The
  // caller tests `canSealed()` first — an absent method is never a reason to
  // fall back to an open frame on a conversation the core carries.
  rz.canSealed = () => typeof getActiveTransport()?.sendWith === 'function';
  rz.canEdit = () => typeof getActiveTransport()?.editText === 'function';
  rz.sendWith = (text, options, id) => (blocked() ? null : (getActiveTransport()?.sendWith?.(text, options, id) ?? null));
  rz.editText = (target, text, id) => (blocked() ? null : (getActiveTransport()?.editText?.(target, text, id) ?? null));
  rz.sendReceipt = (kind, id) => (blocked() ? false
    : (options.receiptTransport?.() ?? getActiveTransport())?.sendReceipt(kind, id));
  rz.sendPing = (id, ts) => (blocked() ? null : (getActiveTransport()?.sendPing?.(id, ts) ?? null));
  rz.isOnline = () => getActiveTransport()?.isOnline() ?? false;
  rz.peerOnline = () => (getActiveTransport()?.peerOnline ? getActiveTransport().peerOnline() : getActiveTransport()?.isOnline()) ?? false;
  rz.isDialling = () => getActiveTransport()?.isDialling() ?? false;
  rz.target = () => getActiveTransport()?.target() ?? { host: '', port: 0 };
  rz.targets = () => getActiveTransport()?.targets?.() ?? [];
  rz.setTarget = (host, port) => getActiveTransport()?.setTarget?.(host, port);
  rz.setTargets = (candidates) => getActiveTransport()?.setTargets?.(candidates);
  rz.boundPort = () => getActiveTransport()?.boundPort() ?? null;
  rz.reconnect = () => getActiveTransport()?.reconnect() ?? false;
  rz.standDown = () => getActiveTransport()?.standDown?.();
  rz.refreshAllowed = () => getActiveTransport()?.refreshAllowed?.();
  rz.retryDelay = () => getActiveTransport()?.retryDelay?.() ?? 0;
  rz.activeSocket = () => getActiveTransport()?.activeSocket?.() ?? null;
  rz.stop = () => {
    options.stopP2p?.();
    options.stopCloud?.();
  };
  rz.writable = () => getActiveTransport()?.writable() ?? false;
  rz.writeFrame = (frame) => (blocked() ? false : (getActiveTransport()?.writeFrame(frame) ?? false));
  rz.flushed = () => getActiveTransport()?.flushed?.() ?? Promise.resolve();
  rz.switchPeer = (newP, newL) => {
    options.switchCloudPeer?.(newP, newL);
  };
  return rz;
}


export function parseArgs(argv, defaults, { requirePeer = true } = {}) {
  const out = {
    peer: null,
    name: defaults.name,
    nameExplicit: false,
    port: defaults.port,
    log: null,
    bind: null,
    noTheme: false,
    noNotify: false,
    filesDir: defaultFilesDir({ home: os.homedir(), termux: isTermux() }),
    stateDir: defaultStateDir(os.homedir()),
    maxFile: DEFAULT_MAX_BYTES / (1024 * 1024),
    mouse: false,
    menu: false,
    update: false,
    reset: false,
    migrateEncryption: false,
    dropPlaintext: false,
    noLog: false,
    headless: false,
    cloud: false,
    cloudServer: null,
    cloudLogout: false,
    lang: defaults.lang ?? detectLanguage(),
    langExplicit: false,
    help: false,
    version: false,
  };
  const byFlag = new Map(cliFlags.map((spec) => [spec.flag, spec]));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { out.help = true; continue; }
    if (a === '-v') { out.version = true; continue; }
    const spec = byFlag.get(a);
    if (spec) spec.apply(out, spec.value ? argv[++i] : undefined);
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else if (out.peer === null) out.peer = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  // Direct mode still needs an address. Cloud mode offers the account roster,
  // and logout exits before a conversation is selected.
  if (requirePeer && !out.help && !out.version && !out.cloud && !out.cloudLogout && !out.peer) {
    throw new Error('peer address required (see --help)');
  }
  if (out.log && out.noLog) {
    throw new Error('--log and --no-log together make no sense');
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) {
    throw new Error(`bad --port: ${out.port}`);
  }
  if (!Number.isFinite(out.maxFile) || out.maxFile <= 0) {
    throw new Error(`bad --max-file: ${out.maxFile}`);
  }
  return out;
}

// Whatever this person chose, the same on every machine they run from. The
// hostname is the last resort and the reason this exists: it differs per device,
// several platforms report it as "localhost", and the peer therefore saw the
// same correspondent under a different name depending on what they answered
// from. A saved answer outranks it, and --name outranks everything for one run.
export function resolveSelfName(args, config = {}) {
  if (args.nameExplicit) return args.name;
  // The type check is about the file, not the value: config.json is meant to be
  // hand-edited, and a number where a name belongs is a mangled file rather than
  // a name spelled oddly. Coercing it would put "42" on the peer's screen.
  if (typeof config.name !== 'string') return args.name;
  return normaliseSelfName(config.name) ?? args.name;
}

// Decides whether `<peer>` names a Tailscale user or a single device, and says
// whether the CLI answered at all. That last part matters where a `tailscale`
// binary exists but has no daemon to talk to — Termux beside the Android app is
// exactly that: every call fails, so treating its presence as authority means
// asking a dead oracle before every inbound connection.
export async function resolvePeerIdentity(selector, cliPath, run = null) {
  if (!cliPath) return { login: null, devices: [], cliOk: false };
  let status;
  try {
    const exec = run ?? ((args) => new Promise((resolve, reject) => {
      execFile(cliPath, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    }));
    status = parseStatus(await exec(['status', '--json']));
  } catch {
    return { login: null, devices: [], cliOk: false };
  }
  const devices = findUserDevices(status, selector);
  if (devices.length === 0) return { login: null, devices: [], cliOk: true };
  // Only treat it as a user when the devices agree on one owner; a bare host
  // name should keep behaving like an address.
  const logins = new Set(devices.map((d) => d.login).filter(Boolean));
  if (logins.size !== 1) return { login: null, devices: [], cliOk: true };
  return { login: [...logins][0], devices, cliOk: true };
}

export function isAudioFile(file) {
  const ext = path.extname(String(file ?? '')).toLowerCase();
  // .webm joins the list for the same reason the others are here: a browser's
  // MediaRecorder default is audio/webm, and a voice note that arrives that way
  // must still play with /open and get a card instead of a generic file icon.
  return ['.wav', '.mp3', '.m4a', '.opus', '.ogg', '.flac', '.aac', '.webm'].includes(ext);
}

// Parses a "data:<mediatype>[;param=value...];base64,<data>" URL. A bare
// mediatype ("data:audio/mp4;base64,...") is the common case, but a
// browser's MediaRecorder blob carries its codec on the type string too —
// Chrome and Firefox both default voice notes to "audio/webm;codecs=opus" —
// so the mediatype capture must not require ";base64," immediately after
// it, or every such web-recorded voice note fails to match at all and never
// gets saved, played, or even shown as a card.
// Which attachment a message row is labelled with: inline bytes and a
// `/api/media` reference count the same — the row is a picture either way.
export function messageMediaKind(image, voice) {
  if (frameAttachment(image)) return 'image';
  return frameAttachment(voice) ? 'voice' : null;
}

export function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+)(?:;[^;,]+)*;base64,([\s\S]*)$/.exec(String(dataUrl ?? ''));
  if (!match) return null;
  return { mediaType: match[1], base64: match[2] };
}

// The transcript preview's resolution, in cells: each one is a 2x2 pixel
// block, so these are 72x... and 144x... pixels wide respectively. The floor
// is the width that fits any terminal worth drawing in; the ceiling exists
// because past it a preview stops being a preview and starts being the
// picture (that is what `/view` is for), and every extra column is another
// 24-bit colour escape per row on the wire.
export const PREVIEW_COLUMNS_MIN = 36;
export const PREVIEW_COLUMNS_MAX = 72;

// How wide a preview may be drawn in a window of `width` columns. The
// transcript has a gutter and a border, and an art row that reaches the last
// cell wraps — so a margin is taken off before the box is capped.
export function previewColumnsFor(width) {
  const usable = Math.floor(Number(width) || 0) - 8;
  if (!Number.isFinite(usable) || usable <= PREVIEW_COLUMNS_MIN) return PREVIEW_COLUMNS_MIN;
  return Math.min(PREVIEW_COLUMNS_MAX, usable);
}

// What a payload becomes on screen: an image preview, a voice card, or a
// generic file icon — never nothing. Pure, so both showFilePreview (which
// draws the result) and a test (which just wants proof a payload was not
// silently dropped) can call it without a running session.
export async function renderAttachmentLines(payload, file, {
  themed = true, durationHint, decode = decodeImage, openWith = null,
  // The box the picture may fill, in cells. A cell carries a 2x2 block of
  // pixels, so the column count *is* the preview's horizontal resolution: 36
  // columns were 72 pixels across, which is what «увеличь dpi картинок»
  // was about. Width still must not overflow — an art row wider than the
  // transcript wraps and the quadrant halves tear into noise — so callers
  // pass the real transcript width and this grows the box up to
  // PREVIEW_COLUMNS_MAX, never past what was given. Height stays free: a
  // taller picture scrolls like any other transcript line, and previewSize
  // keeps the picture's own proportions inside the box.
  columns = PREVIEW_COLUMNS_MIN, rows = 60,
} = {}) {
  let lines = [];
  if (looksLikeImage(file) && payload) {
    const image = await decode(payload);
    if (image) lines = renderPreview(image, { themed, columns, rows });
  } else if (isAudioFile(file) && payload) {
    let parsed = parseWavPcm(payload);
    // Not a WAV: a browser recording is Opus in WebM, and without this the card
    // showed the placeholder bar pattern — a microphone with no waveform, which
    // is exactly what it looked like.
    if (!parsed) {
      const samples = await decodeToPcm(file).catch(() => null);
      if (samples && samples.length > 0) {
        parsed = {
          durationSec: Number.isFinite(durationHint) ? durationHint : samples.length / 8000,
          waveform: computeWaveform(samples, 24),
        };
      }
    }
    // A WAV — ours, or another Tailchat terminal's — gets the real waveform.
    // A browser recording is opus/webm: not PCM parseWavPcm can read, so the
    // card falls back to the duration the sender reported instead of silently
    // becoming a bare filename.
    const card = parsed
      ? formatVoiceCard(parsed.durationSec, parsed.waveform, { openWith })
      : Number.isFinite(durationHint)
        ? formatVoiceCard(durationHint, '', { openWith })
        : `🎙 [Audio] ${path.basename(file)}${openWith ? `  ▶ ${openWith}` : ''}`;
    lines = [card];
  }
  if (!lines.length) lines = fileIconLines(file, { themed });
  return lines;
}

// The one gate every bell and every desktop notification in the running
// client goes through — /sound flips `enabled`, nothing else does. Pure and
// exported so the mute/unmute contract is provable without a live session:
// `ring` also sounds the bell, `notifyIfEnabled` is the shape
// notifyIfUnfocused (notify.js) calls a notifier with.
export function ringIfEnabled(enabled, bell, notify, notification) {
  if (!enabled) return false;
  bell();
  if (notification) notify(notification);
  return true;
}

export function notifyIfEnabled(enabled, notify, notification) {
  return enabled ? notify(notification) : false;
}

export function resolveThemed(args, env = process.env) {
  return !args.noTheme && env.NO_COLOR === undefined;
}

// Which named palette to paint with — a config value the person (or /theme,
// through the AI or by hand) chose and asked to be remembered. A name that no
// longer exists, because a config file was hand-edited or came from an older
// release, falls back to the default instead of leaving the frame unstyled.
export function resolveThemeName(config = {}) {
  return THEMES[config.theme] ? config.theme : DEFAULT_THEME;
}

// Hand a file to the desktop, phone or shell that owns it. On a Mac a picture
// opens in Preview no matter which app the user reassigned jpg/png to — by
// bundle id, not the localised name, so it stays Preview in any language. A
// chat link that merely ends in an image extension is not a local file and
// keeps the default handler (the browser).
export function systemOpener(target, {
  platform = process.platform,
  exists = fs.existsSync,
  termux = isTermux(),
} = {}) {
  if (termux) return { cmd: 'termux-open', args: [target] };
  if (platform === 'darwin') {
    return looksLikeImage(target) && exists(target)
      ? { cmd: 'open', args: ['-b', 'com.apple.Preview', target] }
      : { cmd: 'open', args: [target] };
  }
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', target] };
  return { cmd: 'xdg-open', args: [target] };
}

// Preview.app decides which picture formats it will actually render, and
// .webp has sat outside that list for years: `open -b com.apple.Preview` on
// a .webp still exits 0 — the app launched — while the window it opens is
// blank or an error sheet, so systemOpen's child.on('error') never fires and
// nothing here can tell the difference from a picture that opened fine. The
// same bytes already decode without trouble through convertToPngBytes — that
// is the pipeline the inline transcript preview and /view both go through for
// this exact file — so a local, existing .webp is converted to a PNG first
// and Preview is handed that instead. Every other format, and every other
// platform's opener (none of which single out Preview the way darwin does),
// is untouched: systemOpener alone still decides what happens to them.
export async function resolveOpenTarget(target, {
  platform = process.platform,
  exists = fs.existsSync,
  termux = isTermux(),
  readFile = fs.readFileSync,
  writeFile = fs.writeFileSync,
  mkdtemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-open-')),
  convert = convertToPngBytes,
} = {}) {
  if (platform !== 'darwin' || termux) return target;
  if (!/\.webp$/i.test(String(target ?? '')) || !exists(target)) return target;
  try {
    const payload = readFile(target);
    const png = await convert(payload, { platform });
    if (!png) return target;
    const dir = mkdtemp();
    const out = path.join(dir, `${path.basename(target, path.extname(target))}.png`);
    writeFile(out, png);
    return out;
  } catch {
    // Read, convert or write failed for any reason: open the original file
    // exactly as before rather than throw out from a click handler.
    return target;
  }
}

// A bare `www.` host has no scheme the platform opener can hand off; give it one.
export function normaliseUrl(raw) {
  const value = String(raw ?? '').trim();
  if (value.startsWith('/') || value.startsWith('~') || value.startsWith('file://')) {
    if (value.startsWith('~/') || value === '~') {
      return path.join(os.homedir(), value.slice(1));
    }
    return value;
  }
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) ? value : `https://${value}`;
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function formatRoute(route, t = createTranslator('en')) {
  if (!route) return t('route.unknown');
  switch (route.kind) {
    case 'direct-lan':
      return t('route.directLan', { endpoint: route.endpoint || 'LAN' });
    case 'direct-private':
      return t('route.directPrivate', { endpoint: route.endpoint || 'private endpoint' });
    case 'direct-wan':
      return t('route.directWan', { endpoint: route.endpoint || 'WAN' });
    case 'derp-relay':
      return t('route.derpRelay', { relay: route.relay || 'relay' });
    case 'tailnet':
      return t('route.tailnet', { endpoint: route.endpoint || 'tailnet' });
    case 'cloud':
      return t('route.cloud', { endpoint: route.endpoint || 'cloud' });
    default:
      return t('route.unknown');
  }
}

export function formatPeerClient(lastPeerVersion) {
  if (isWebVersion(lastPeerVersion)) return 'tailchat web';
  if (lastPeerVersion) return `tailchat cli (v${lastPeerVersion})`;
  return 'tailchat cli';
}

export function formatLastPeerMessage(lastPeerMessage, t = createTranslator('en')) {
  if (!lastPeerMessage) return t('status.noMsgs');
  const d = new Date(lastPeerMessage.ts || Date.now());
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  let preview = typeof lastPeerMessage.text === 'string' ? lastPeerMessage.text : '';
  if (!preview && lastPeerMessage.voice) preview = '🎤 voice';
  if (!preview && lastPeerMessage.image) preview = '🖼 image';
  if (preview.length > 40) preview = `${preview.slice(0, 37)}...`;
  return `${hh}:${mm}:${ss} ("${preview}")`;
}

export function formatLine(ts, name, text) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `[${hh}:${mm}] ${name}: ${text}`;
}

// A nickname set after messages were already logged leaves the old name
// baked into those lines — the log is an honest, append-only record of what
// was actually written at the time, and stays that way on disk. /history
// still shows the current nickname when it replays them: only the sender
// field is touched, anchored at the very start of the line, so a peer's own
// words that happen to contain their old name are never rewritten. A
// continuation line of a multiline message carries no such prefix and is
// therefore left alone either way.
export function relabelLogLine(line, from, to) {
  if (!from || !to || from === to) return line;
  const escaped = escapeRegex(from);
  return line.replace(new RegExp(`^(\\[\\d{2}:\\d{2}\\] )${escaped}(: )`), `$1${to}$2`);
}

// Enough of the recent transcript to remember where a conversation left off
// the moment tailchat reconnects, without replaying the whole log the way
// /history does. Counted in messages, not physical log lines — see
// parseLogEntries: a pasted block or ASCII art is one message across several
// lines, and counting lines would cut it off mid-picture.
const CONNECT_PREVIEW_MESSAGES = 20;
// /history digs deeper than the automatic preview, but still bounded: a
// conversation running for months should not dump its whole life to the
// screen just because it was asked to remember.
const HISTORY_MESSAGES = 100;

// How long nobody has to be away before the automatic full-screen saver comes
// on: a person's setting, in minutes, not the clock's own unit. Fifteen
// minutes by default — long enough that a short pause reading or thinking
// never trips it.
export const SAVER_AFTER_DEFAULT_MINUTES = 15;
export const SAVER_AFTER_MIN_MINUTES = 1;
export const SAVER_AFTER_MAX_MINUTES = 180;

// A hand-edited config value that is not a sane number of minutes falls back
// to the default instead of arming a timer for zero, forever, or NaN ms — the
// same tolerance normaliseSelfName and resolveThemeName give a mangled file.
export function resolveSaverAfterMinutes(value) {
  // Absent, or explicitly cleared: "unset" reads as the default, not as the
  // number zero that Number(null) and Number('') would otherwise coerce to.
  if (value === null || value === undefined || value === '') {
    return SAVER_AFTER_DEFAULT_MINUTES;
  }
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes)) return SAVER_AFTER_DEFAULT_MINUTES;
  return Math.min(SAVER_AFTER_MAX_MINUTES, Math.max(SAVER_AFTER_MIN_MINUTES, minutes));
}

// Turns a raw transcript line back into the shape ui.addMessage expects, so a
// restored line gets the same per-sender colour it had live instead of one
// flat colour for the whole block. A continuation line of a multiline message
// (see relabelLogLine) carries no `[HH:MM] name:` prefix of its own and is
// folded back into the message above it rather than read as one of its own.
const LOG_LINE = /^\[(\d{2}):(\d{2})\] ([^:]+?)(?:\s+\[(✓✓|✓|→|⧗)\])?: ([\s\S]*)$/;
export function parseLogEntries(lines) {
  const entries = [];
  for (const raw of lines) {
    const match = LOG_LINE.exec(raw);
    if (match) {
      const entry = {
        hh: Number(match[1]),
        mm: Number(match[2]),
        name: match[3],
        text: match[5],
      };
      if (match[4]) entry.marker = match[4] === '→' ? '✓' : match[4];
      entries.push(entry);
    } else if (entries.length > 0) {
      entries[entries.length - 1].text += `\n${raw}`;
    } else {
      // The file starts mid-message (a truncated write): there is no sender or
      // time to show, so the line stays plain, uncoloured text.
      entries.push({ hh: null, mm: null, name: null, text: raw });
    }
  }
  return entries;
}

// A parsed entry becomes a ui.addMessage payload, or null when it has no
// header (see parseLogEntries) and belongs on screen as a plain line instead.
// The log keeps only hours and minutes, so today's date stands in — nothing
// downstream reads more than the clock off this timestamp.
//
// Only two humans and one assistant ever write to a log — self, the peer, and
// the AI — so "not self, not the AI" reads as peer, no allow-list needed. The
// one case this gets wrong: `/ai name` was changed, and an older line was
// signed with the assistant's previous name. That line colours as the peer
// rather than the bot; the same accepted gap as relabelLogLine, which only
// remembers the peer's own most recent pre-nickname label. Fixing either
// would mean logging name history nothing else needs.
export function logEntryMessage(entry, { selfName, aiName }) {
  if (entry.hh == null) return null;
  const ts = new Date();
  ts.setHours(entry.hh, entry.mm, 0, 0);
  const self = entry.name === selfName;
  const bot = !self && entry.name === aiName;
  const marker = entry.marker ?? (self ? '✓' : null);
  return {
    name: entry.name,
    text: entry.text,
    ts: ts.getTime(),
    self,
    bot,
    marker,
    // The glyph alone cannot tell a delivered ✓✓ from a read one, and a line
    // only reaches the log once it has been through this device's own reader:
    // a logged ✓✓ is the read rung.
    markerRead: marker === '✓✓',
  };
}

// Where in a restored tail the current session's own entries begin, so a long
// transcript can show "you left off here" instead of one undifferentiated
// wall of text. Works over any array sliced from a longer one — messages here,
// but the arithmetic does not care. totalLines and sessionStart are absolute
// counts in the full sequence: sessionStart is how many entries existed the
// moment this session opened the log, before it wrote anything of its own.
export function splitLogTail(lines, { totalLines, sessionStart }) {
  const offset = totalLines - lines.length;
  const boundary = Math.min(Math.max(sessionStart - offset, 0), lines.length);
  return { old: lines.slice(0, boundary), fresh: lines.slice(boundary) };
}

export function formatGreeting({
  name, peerHost, peerPort, bindAddr, t = createTranslator('en'),
}) {
  // `host:port` describes a direct route. A cloud peer has no port, and
  // gluing one on produced labels like `@aurelia:cloud`.
  const peer = peerPort ? `${peerHost}:${peerPort}` : peerHost;
  const detail = t('greeting.line', {
    name, peer, bind: bindAddr,
  });
  return `* tailchat v${VERSION} — ${detail}`;
}

// The logo itself lives in src/logo.js: the art, the width it needs and the
// frames it arrive in are all there. Here it is only placed, timed and shared.

// How long a dropped link has to stay dropped before the transcript mentions
// it. Short outages are invisible to the reader and, with a relay in the
// middle, are the common case rather than the exception.
const DISCONNECT_QUIET_MS = 8000;
// The same ceiling src/cloud/hub.js and src/session.js put on one deletion
// batch, so `/del 500` is refused here with an explanation rather than silently
// truncated on the way out.
const DEL_MAX_IDS = 200;
// How much of a command's output the model is given to read. One shared ceiling
// for both the shell path and the app-command path: the cost of exceeding it is
// the same either way — a follow-up request slow enough to hit its own timeout.
const AI_TOOL_OUTPUT_CAP = 8000;

const UPDATE_HINT = 'git pull && npm install';

export function isWebVersion(v) {
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'web' || s === 'vweb' || s.startsWith('web-') || s.startsWith('web/');
}

const versionParts = (v) => String(v ?? '')
  .split('.')
  .map((p) => Number.parseInt(p, 10) || 0);

// Feature gate: a peer that reports no version predates version reporting and
// therefore predates every feature we would gate on.
export function isAtLeast(version, minimum) {
  if (!version) return false;
  if (isWebVersion(version)) return true;
  const a = versionParts(version);
  const b = versionParts(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

// What a peer's announced version lets this side send it. `null` means unknown
// and every gate in the client reads it as "no reason to refuse"; `false` means
// an old client, which is what a version the peer *reported* as absent means on
// a direct connection. Over the relay it does not: the link synthesises a
// stand-in hello (`v: null`) whenever queued messages arrive ahead of the
// peer's real one, and a peer reading another conversation never greets us at
// all — so a missing version there said "ancient", which refused file transfers
// and downgraded every AI answer to plain text signed with the owner's own name.
export function peerCapabilities(peerVersion, { overCloud = false } = {}) {
  if (!peerVersion && overCloud) {
    return { files: null, ai: null, logo: null, holiday: null };
  }
  return {
    files: isAtLeast(peerVersion, '0.5.0'), // files landed in 0.5.0
    // The AI frame landed in 0.43.0. An older peer gets the answer as a message
    // instead, so a conversation is never one-sided because of a stale checkout.
    ai: isAtLeast(peerVersion, AI_FRAME_VERSION),
    logo: isAtLeast(peerVersion, LOGO_FRAME_VERSION),
    holiday: isAtLeast(peerVersion, HOLIDAY_FRAME_VERSION),
  };
}
const UPDATE_BORDER = '*'.repeat(20);

export function updateBanner(mine, theirs, peerName, t = createTranslator('en')) {
  return [
    UPDATE_BORDER,
    `* ${t('update.bannerTitle')}`,
    `* ${t('update.bannerVersions', { peer: peerName, theirs, mine })}`,
    `* ${t('update.bannerAction')}`,
    `* ${t('update.bannerEffect')}`,
    UPDATE_BORDER,
  ].join('\n');
}

export function createUpdateBannerGuard() {
  let lastKey = null;
  return {
    take(mine, theirs) {
      const key = `${mine}\0${theirs}`;
      if (key === lastKey) return false;
      lastKey = key;
      return true;
    },
    clear() { lastKey = null; },
  };
}

// Returns null when there is nothing worth saying. The older local client gets
// the full action banner; the newer side only learns whom to ask to update.
export function versionNotice(mine, theirs, peerName, t = createTranslator('en')) {
  if (!theirs) {
    return `* ${t('version.unknown', { peer: peerName, hint: UPDATE_HINT })}`;
  }
  if (isWebVersion(theirs) || isWebVersion(mine)) return null;
  if (mine === theirs) return null;

  const a = versionParts(mine);
  const b = versionParts(theirs);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff === 0) continue;
    if (diff < 0) return updateBanner(mine, theirs, peerName, t);
    return `* ${t('version.theirsOlder', {
      peer: peerName, theirs, mine, hint: UPDATE_HINT,
    })}`;
  }
  return null;
}

// Both directions in one list, numbered the way /open reads them: received
// first, then sent. A file this side sent is as worth opening again as one that
// arrived — the picture is in the transcript either way — and a list that only
// admitted half of them left the other half with no number to type.
export function fileListLines({
  received = [], sent = [], dir, t = createTranslator('en'),
}) {
  if (received.length === 0 && sent.length === 0) {
    return [`* ${t('files.none', { dir })}`, `* ${t('files.hint')}`];
  }
  const lines = [];
  const group = (files, key, offset) => {
    if (files.length === 0) return;
    lines.push(`* ${t(key)}`);
    files.forEach((file, index) => {
      lines.push(`*   ${offset + index + 1}: ${path.basename(file)} — ${file}`);
    });
  };
  group(received, 'files.list', 0);
  group(sent, 'files.sentList', received.length);
  return lines;
}

function stripQuotes(value) {
  const text = String(value ?? '').trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(text);
  return quoted ? quoted[2] : text;
}

// Lenient on purpose: terminals quote a dragged-in path, and "/ open 1" with a
// stray space is an easy slip that should still work.
export function parseCommand(text) {
  const match = /^\/\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*([\s\S]*)$/.exec(String(text ?? '').trim());
  if (!match) return null;
  return { name: `/${match[1].toLowerCase()}`, arg: stripQuotes(match[2]) };
}

// Terminals deliver a dragged file as a pasted path, and each one writes it
// differently: quoted on Windows, backslash-escaped on macOS, plain when the
// name has nothing worth escaping.
export function unescapeDroppedPath(value) {
  return stripQuotes(value).replace(/\\(.)/g, '$1');
}

// Rather than guess which convention a terminal used — and mangle
// `C:\Users\x\a.png` into `C:Usersxa.png` doing it — try each reading and keep
// the one that names a real file. The filesystem is the only authority here.
export function resolvePastedPath(raw, exists) {
  const literal = stripQuotes(raw);
  if (literal === '') return null;
  if (exists(literal)) return literal;
  const unescaped = unescapeDroppedPath(raw);
  return unescaped !== literal && exists(unescaped) ? unescaped : null;
}

// `~` is the shell's, not the filesystem's, so a hand-typed path needs it
// expanded before anything can be read.
export function expandHome(rawPath, home = os.homedir()) {
  const text = String(rawPath ?? '');
  return text.startsWith('~') ? path.join(home, text.slice(1)) : path.resolve(text);
}

export function droppedPaths(text, exists) {
  const raw = String(text ?? '').trim();
  if (raw === '') return [];
  const resolveAll = (candidates) => {
    const resolved = candidates.map((candidate) => resolvePastedPath(candidate, exists));
    return resolved.every(Boolean) ? resolved : [];
  };
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1) return resolveAll(lines);
  const single = resolvePastedPath(raw, exists);
  if (single) return [single];
  // Several files dropped together arrive space-separated. Only accept that
  // reading when every part is a real file, so ordinary prose never splits.
  const parts = raw.split(/(?<!\\)\s+/).filter(Boolean);
  return parts.length < 2 ? [] : resolveAll(parts);
}

// A path pasted as an ordinary message looks like a file send but transfers
// nothing, so the sender gets a hint instead of silence.
export function looksLikePath(text) {
  const candidate = stripQuotes(text);
  if (/\s/.test(candidate) && !/^["']/.test(String(text ?? '').trim())) return false;
  const hasExtension = /\.[A-Za-z0-9]{1,8}$/.test(candidate);
  if (!hasExtension) return false;
  return /^[A-Za-z]:[\\/]/.test(candidate)   // C:\... or C:/...
    || /^\\\\/.test(candidate)               // UNC share
    || candidate.startsWith('/')             // POSIX absolute
    || candidate.startsWith('~/');           // home-relative
}

// A pinned, always-reachable conversation with yourself — never a friend, so
// it never comes from cloud.users, and its identity is always the account's
// own login. The picker resolves a row's `value` over its `name`, so the
// localized "📝 Saved Messages" label and the `@login` selector travel
// separately: switchActiveConversation already reads a leading `@` as an
// explicit cloud peer (see its `explicitCloud` handling), and the server
// (hub.js) already allows subscribing to yourself.
export function savedMessagesRow(t, login) {
  return {
    name: `📝 ${t('cloud.savedMessages')}`,
    value: `@${login}`,
    help: t('cloud.savedMessagesHint'),
  };
}

// `tailchat` with nothing after it used to be a dead end. The roster already
// knows who you have talked to, so offer that list — one remembered person is
// dialled outright, several get the app's own menu, a pipe gets the numbered
// plain list. Only the choosing is new: what follows is the ordinary
// single-peer session.
export async function choosePeer({
  stateDir, cliPath, t, themed = true, force = false,
  input = process.stdin, output = process.stdout,
  self = null,
  lanDiscovery = null,
  cloud = null,
}) {
  let status = null;
  if (cliPath) {
    try {
      status = parseStatus(await new Promise((resolve, reject) => {
        execFile(
          cliPath,
          ['status', '--json'],
          { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      }));
    } catch {
      status = null; // no daemon to ask, so claim nothing about anyone
    }
  }
  const selfInfo = self ?? { login: status?.self?.login ?? null, ips: ownTailnetIps() };
  const selectors = rosterSelectors(stateDir, selfInfo);
  const choices = rosterChoices({ selectors, status });

  // One row per person, every transport it was seen on listed together — a
  // LAN neighbour who is also a Cloud friend must not show as two separate
  // rows, and a later merge must never erase an earlier one's badge (the
  // previous version overwrote `badge` outright, so a person online on both
  // LAN and Cloud only ever showed the last transport checked).
  for (const choice of choices) {
    choice.badges = new Set([choice.badge || '⚡ [tailnet]']);
    choice.badge = [...choice.badges].join(' ');
  }

  // Merge LAN discovered peers. A LAN beacon's `login` is the announcer's
  // Cloud login when it has one (see lan-discovery.js/createLanDiscovery),
  // and the same string a Cloud friend list reports it under — so a fresh
  // entry is keyed by that login when present, letting the Cloud merge below
  // find it and combine rather than duplicate. Only a peer with no Cloud
  // login at all falls back to its plain display name.
  if (lanDiscovery) {
    const lanPeers = lanDiscovery.getPeers();
    for (const lanPeer of lanPeers) {
      const lanKey = lanPeer.login || lanPeer.name;
      const existing = choices.find((c) => c.login === lanKey || c.login === lanPeer.name
        || (lanPeer.login && c.login === lanPeer.login));
      if (existing) {
        existing.badges.add('📡 [lan]');
        existing.badge = [...existing.badges].join(' ');
        existing.devices = [lanPeer.address, ...(existing.devices || [])];
        existing.state = 'online';
      } else {
        choices.unshift({
          login: lanKey,
          state: 'online',
          type: 'lan',
          badges: new Set(['📡 [lan]']),
          badge: '📡 [lan]',
          devices: [lanPeer.address],
        });
      }
    }
  }

  // Merge Cloud friends. `existing.state` only ever gains "online" here —
  // a Cloud account showing offline must not demote a person already known
  // reachable on LAN or Tailscale, since a stale Cloud websocket says
  // nothing about whether the direct transport still works.
  if (cloud && cloud.api) {
    try {
      const cloudUsers = await cloud.api.users();
      for (const cu of cloudUsers) {
        const cLogin = cu.login;
        if (!cLogin) continue;
        const existing = choices.find((c) => c.login === cLogin);
        if (existing) {
          existing.badges.add('🌐 [cloud]');
          existing.badge = [...existing.badges].join(' ');
          existing.state = existing.state === 'online' ? 'online' : (cu.online ? 'online' : existing.state);
        } else {
          choices.push({
            login: cLogin,
            state: cu.online ? 'online' : 'offline',
            type: 'cloud',
            badges: new Set(['🌐 [cloud]']),
            badge: '🌐 [cloud]',
            devices: cu.official ? [t ? t('cloud.officialAccount') : 'service account'] : (cu.online ? [t ? t('cloud.statusHere') : 'online'] : [describeLastSeen(cu.lastSeen, t)]),
          });
        }
      }
    } catch {}
  }
  // A blocked contact stays in the list — blocking never removes the
  // friendship — but is marked so a person does not pick it expecting an
  // answer.
  for (const choice of choices) {
    choice.blocked = isBlocked(stateDir, choice.login.replace(/^@/, ''));
  }

  // Saved Messages is not "a friend being online or offline" — it is your own
  // account, always reachable — so it is added after the empty/single-choice
  // shortcuts decide whether there is anything else to ask about, and it never
  // participates in either shortcut itself.
  const hasSaved = Boolean(cloud?.self?.login);
  if (choices.length === 0 && !hasSaved) {
    output.write(`${t('pick.empty')}\n${t('pick.emptyHint')}\n`);
    return null;
  }
  // One remembered person means no question to ask: the answer is obvious and
  // the menu would be a formality. --menu overrides: asking again is the point.
  if (choices.length === 1 && !force && !hasSaved) return choices[0].login;
  if (!interactive(input, output)) {
    for (const line of renderChoices(choices, t)) output.write(`${line}\n`);
    return readChoice(choices, { input, output, t });
  }
  const rows = peerMenuRows(choices, t);
  if (hasSaved) rows.unshift(savedMessagesRow(t, cloud.self.login));
  const picked = await runListMenu({
    title: t('pick.title'),
    rows,
    keysHint: t('pick.keysHint'),
    themed, termux: isTermux(), input, output,
  });
  // The login itself: rows carry no `value`, so the menu resolves their name —
  // except the pinned Saved Messages row, which carries its own `@login` value.
  return picked;
}

export async function main() {
  let args;
  try {
    args = parseArgs(
      process.argv.slice(2),
      { port: 4747, name: os.hostname() },
      { requirePeer: false },
    );
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  // Explicit beats remembered: --lang and TAILCHAT_LANG keep overriding what the
  // first-run wizard saved, and a saved answer beats the locale guess.
  const config = readConfig(args.stateDir);
  args.name = resolveSelfName(args, config);
  args.lang = resolveLanguage({
    argv: process.argv.slice(2), env: process.env, config,
    detected: args.lang, normalise: normaliseLanguage,
  });
  let t = createTranslator(args.lang);
  // The safety net goes up before anything else can fail. From here on an
  // unexpected error hands the terminal back, drops the listener note and says
  // where the stack trace was written, instead of leaving a dead console and a
  // file that will turn the next client away from its own port. `releaseSession`
  // is declared further down and hoisted to here, and every step inside it is
  // guarded on its own — so it is safe to call at any point during startup, when
  // most of what it tears down does not exist yet.
  installFatalHandlers({
    stateDir: args.stateDir,
    restore: releaseSession,
    meta: { version: VERSION, argv: process.argv.slice(2) },
    headline: (summary) => t('fatal.stopped', { error: summary }),
    describe: ({ ok, file }) => t(ok ? 'fatal.saved' : 'fatal.unsaved', { file }),
  });

  // Several things worth saying go wrong before there is a screen to say them
  // on, and none of them are worth dying for: a stuck one-shot note, a missing
  // tailscale CLI, a transcript the disk refused. Each queues here and is raised
  // the moment the interface exists.
  let uiReady = false;
  const pending = [];
  const notice = (line) => {
    if (uiReady) ui.addLine(`* ${line}`);
    else pending.push(line);
  };
  if (args.help) {
    console.log(usageText(t));
    process.exit(0);
  }
  if (args.version) {
    console.log(`tailchat v${VERSION}`);
    process.exit(0);
  }
  if (args.update) {
    process.exit(runCliUpdate({ root: installRoot(), t }));
  }
  // Never begin a session with an inaccessible key: an empty-looking encrypted
  // outbox would otherwise be overwritten and pending messages lost.
  const secureStore = openDeviceStore();
  if (args.migrateEncryption || args.dropPlaintext) {
    const outcome = migrateCliFiles(secureStore, {
      stateDir: args.stateDir, filesDir: args.filesDir, logFile: args.log, dropPlaintext: args.dropPlaintext,
    });
    console.log(`Verified ${outcome.scanned} CLI files; encrypted ${outcome.migrated}${args.dropPlaintext ? `; safely deleted ${outcome.dropped} verified plaintext originals.` : '. Original plaintext files retained for separately approved cleanup.'}`);
    return outcome;
  }
  // Opportunistic auto-migration: with the vault open, legacy files are converted
  // seamlessly so an upgrade does not stop at a migration prompt. Only the files
  // that have no ciphertext yet are touched (`onlyMissing`) — a profile keeps its
  // plaintext originals until `--drop-plaintext`, and re-proving thousands of
  // already-converted pairs byte-for-byte on every launch is pure I/O.
  //
  // The errors that are tolerated are the ones a single unreadable file produces:
  // a permission or a mount that went away. A `Migration conflict` is deliberately
  // NOT swallowed — it means the plaintext and the ciphertext already disagree, and
  // hiding that would let two divergent copies of real history coexist invisibly.
  const BENIGN_MIGRATION_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'EROFS', 'EBUSY']);
  try {
    migrateCliFiles(secureStore, {
      stateDir: args.stateDir, filesDir: args.filesDir, logFile: args.log, onlyMissing: true,
    });
  } catch (error) {
    if (!BENIGN_MIGRATION_CODES.has(error?.code)) throw error;
  }

  // `tailchat --reset`: settings and AI keys back to factory defaults. Run with
  // the client closed — a live instance would rewrite config.json from its own
  // memory on the next /ai or /logs.
  if (args.reset) {
    const removed = resetState(args.stateDir);
    console.log(removed.length > 0
      ? t('reset.done', { files: removed.join(', ') })
      : t('reset.nothing'));
    process.exit(0);
  }

  // Signing out is a one-shot action like --reset, not a session: the token goes
  // and nothing starts.
  if (args.cloudLogout) {
    await logoutCloud({ args, config, t, stateDir: args.stateDir });
    process.exit(0);
  }

  // An in-app /peer left a one-shot instruction for this relaunch: the wrapper
  // restarts us with the same arguments, so the new conversation gets its name
  if (!args.peer) {
    // A note that can be read but not cleared repeats the switch on every
    // restart, which is a person being dragged back to a conversation they
    // already left. Rare, and confusing enough to be worth naming.
    const noted = takeNextPeer(args.stateDir, {
      onError: (error) => notice(t('peer.noteStuck', { reason: error.code ?? error.message })),
    });
    if (noted) args.peer = noted;
  }
  // --menu opens the roster menu even when a peer was named or a /peer switch
  // left a note: asking again is exactly what the flag is for.
  if (args.menu) args.peer = null;
  // First run: the three questions the client cannot answer any other way — the
  // interface language, the name this person is known by, and whether the
  // transcript is kept. Asked before the picker, so the picker already speaks
  // the chosen language. A script gets the defaults instead of a hang, and flags
  // skip the questions they answer.
  const setup = args.cloud ? null : await runSetup({
    args, t, themed: resolveThemed(args), config,
  });
  const logPreference = setup ? setup.log : config.log; // false = off, absent = on
  if (setup) {
    args.lang = setup.lang;
    t = createTranslator(args.lang);
    config.lang = setup.lang;
    config.log = setup.log;
    // Saved so it is the same name on the next run and on every other machine
    // this person starts from, which is the whole point of asking.
    if (!args.nameExplicit) {
      args.name = setup.name;
      config.name = setup.name;
    }
    writeConfig(args.stateDir, config);
  }

  // Ensure Cloud Identity Registration: every client is bound to a unified identity
  // (which provides Ed25519 identity, server certificate, and unified profile for LAN, Tailscale & Cloud).
  if (!config.cloudLogin && !args.cloud && !args.headless && !args.cloudLogout) {
    try {
      const desktopNotifier = createNotifier();
      desktopNotifier.notify({ name: 'Tailchat', text: t('cloud.needRegisterNotice') });
    } catch {}
    const onboard = await prepareCloud({
      args: { ...args, cloud: true },
      config,
      t,
      themed: resolveThemed(args),
      stateDir: args.stateDir,
      requirePeer: false,
      persist: (patch) => {
        Object.assign(config, patch);
        writeConfig(args.stateDir, config);
      },
    });
    if (onboard) {
      args.name = onboard.self.name || onboard.self.login;
      config.name = args.name;
      config.cloudLogin = onboard.self.login;
      writeConfig(args.stateDir, config);
      if (onboard.recoveryKey) {
        process.stdout.write(`\n\x1b[32m* ==========================================================\x1b[0m\n`);
        process.stdout.write(`\x1b[32m* ${t('cloud.recoveryTitle')}: ${onboard.recoveryKey}\x1b[0m\n`);
        process.stdout.write(`\x1b[32m* ${t('cloud.recoverySubtitle')}\x1b[0m\n`);
        process.stdout.write(`\x1b[32m* ==========================================================\x1b[0m\n\n`);
      }
    }
  }

  // The cloud path asks its questions here, while the terminal is still plain
  // text: a password prompt and a picker cannot share the screen with the app's
  // own. Everything Tailscale-specific below is skipped in this mode — there is
  // no address to resolve, no port to listen on and nobody local to vouch for
  // the peer, because the account is what identifies them.
  // Unified Network: Cloud transport, LAN discovery, and Tailscale mesh
  // all run concurrently. If offline, cloud gracefully disables while LAN & Tailscale continue.
  let cloud = null;
  if (args.cloud || config.cloudLogin) {
    try {
      cloud = await prepareCloud({
        args: { ...args, cloud: true },
        config,
        t,
        themed: resolveThemed(args),
        stateDir: args.stateDir,
        requirePeer: Boolean(args.cloud && !args.peer),
        persist: (patch) => {
          Object.assign(config, patch);
          writeConfig(args.stateDir, config);
        },
      });
    } catch {
      cloud = null;
    }
  }
  if (args.cloud && !cloud) process.exit(2);
  if (cloud && cloud.peer && !args.peer) {
    args.peer = cloud.peer;
  }
  if (cloud) {
    notice(t('cloud.signedInAs', { login: cloud.self.login }));
    notice(t('cloud.webHint', { url: cloud.webUrl }));
  }

  // This is deliberately a replica, never a message transport: a failed OVH
  // request leaves the direct chat and its local transcript untouched.
  const sharedHistory = createSharedHistory(config, args.stateDir, { store: secureStore });

  function archiveSharedMessage({ id, name, text, ts, kind = 'human' }) {
    if (!id) return;
    sharedHistory.record({ id, name, text, ts, kind });
  }

  // Probe Tailscale CLI
  const tsCli = findTailscaleCli();
  const tsStatus = await probeTailscaleStatus({ cliPath: tsCli, interfaces: os.networkInterfaces() });
  if (!tsStatus.active && !cloud) {
    notice(t('tailscale.inactive'));
    notice(t('tailscale.offlineWarning'));
  }
  const cliSearch = tsCli ? null : describeCliSearch();
  const whois = createWhois({ cliPath: tsCli });
  const ownIps = ownTailnetIps();
  let ownLogin = null;
  let ownLoginAsked = false;
  async function selfLogin() {
    if (!tsCli || ownLoginAsked) return ownLogin;
    ownLoginAsked = true;
    try {
      ownLogin = parseStatus(await runTailscale(tsCli, ['status', '--json']))?.self?.login ?? null;
    } catch {
      ownLogin = null;
    }
    return ownLogin;
  }

  // Always enable LAN discovery for local mesh
  let lanDiscovery = null;
  try {
    const localId = loadOrCreateIdentity(args.stateDir);
    const localCert = loadCertificate(args.stateDir);
    lanDiscovery = createLanDiscovery({
      port: 4748,
      tcpPort: args.port || 4747,
      name: args.name,
      login: config.cloudLogin || args.name,
      cert: localCert,
    });
    await lanDiscovery.start().catch(() => {});
  } catch {
    lanDiscovery = null;
  }

  // Before the TUI: the menu owns the plain terminal, and the app's screen would
  // fight it for the same one.
  if (!args.peer) {
    if (cloud?.self?.login && !args.menu) {
      args.peer = `@${cloud.self.login}`;
    } else {
      args.peer = await choosePeer({
        stateDir: args.stateDir, cliPath: tsCli, t, themed: resolveThemed(args),
        force: args.menu,
        self: { login: await selfLogin(), ips: ownIps },
        lanDiscovery,
        cloud,
      });
      if (!args.peer) {
        if (lanDiscovery) lanDiscovery.close();
        console.error(t('pick.cancelled'));
        process.exit(2);
      }
    }
  }
  // Saved Messages (and any explicit `@login` selector) resolves through the
  // same leading-`@` convention /peer and /cloud already use — the picker
  // above and the in-session commands share this one rule instead of each
  // guessing at "is this cloud?" its own way.
  if (args.peer.startsWith('@')) {
    args.peer = args.peer.slice(1);
    args.cloud = true;
  }

  // Look up peer in cloud friends if cloud is active
  let isCloudPeer = Boolean(args.cloud);
  let cloudFriend = null;
  if (cloud) {
    const resolved = resolveCloudPeerSync(args.peer, {
      explicitCloud: Boolean(args.cloud), cloudUsers: cloud.users || [],
    });
    cloudFriend = resolved.cloudFriend;
    if (resolved.isCloudPeer) {
      isCloudPeer = true;
      cloud.peer = resolved.peer;
      cloud.peerName = resolved.peerName;
    }
  }

  // Nothing local can or should vouch for a cloud account: the server
  // authenticated it with a password, and there is no device list to widen.
  let identity = isCloudPeer
    ? { login: null, devices: [], cliOk: false }
    : await resolvePeerIdentity(args.peer, tsCli);

  // If Tailscale doesn't know who this peer is, but we are logged into Cloud and peer is not an IP:
  if (!isCloudPeer && cloud && !identity.login && !looksLikeIp(args.peer)) {
    isCloudPeer = true;
    cloud.peer = cloudFriend ? cloudFriend.login : args.peer;
    cloud.peerName = cloudFriend?.name || cloud.peer;
    identity = { login: null, devices: [], cliOk: false };
  }

  // A binary that cannot reach a daemon is not an authority. Termux next to the
  // Android app has exactly that: `tailscale` on PATH, no socket to talk to. Ask
  // it once, then stop pretending — otherwise every inbound connection waits on
  // a whois that can only fail, and the answer is always "turn them away".
  const tsAuthority = Boolean(tsCli) && identity.cliOk;
  const stateDir = args.stateDir;
  // config.json is rewritten whole, so every writer merges into the one object
  // this process read at startup. Otherwise /logs would forget the AI's name and
  // /ai would forget the language.
  function persist(patch) {
    Object.assign(config, patch);
    writeConfig(stateDir, config);
  }

  // Nicknames set on this machine before the cloud held them are pushed to the
  // server once, the first time a cloud session loads its roster (issue #28):
  // see migrateCloudNicknames. It runs before `memory` is built below, so the
  // open conversation is never created over a local nickname the server value
  // is about to replace forever.
  if (cloud) {
    try {
      await migrateCloudNicknames({ cloud, config, stateDir, persist });
    } catch { /* best-effort; the unmet flag makes the next connect retry */ }
  }

  let selfIdentity = { login: await selfLogin(), ips: ownIps };
  const remembered = identity.login ? null : lookupRoster(stateDir, args.peer, selfIdentity);
  let peerLogin = identity.login ?? remembered?.login ?? null;
  // A cloud account and a tailnet selector can be spelled the same and are not
  // the same conversation on their own — but an explicit `/link` (see
  // peer-links.js) says they are the same person, and from then on every
  // transport for this selector converges on the linked Cloud login's key
  // instead of silently merging by name or splitting by transport.
  let peerKey = computePeerKey({
    isCloudPeer,
    cloudLogin: cloud?.peer,
    peerLogin,
    selector: args.peer,
    linkedCloudLogin: !isCloudPeer && peerLogin ? resolveLinkedCloudLogin(stateDir, peerLogin) : null,
  });
  let memory = createPeerMemory({ dir: stateDir, key: peerKey });

  // Split in two so /history can undo exactly the part a nickname changes:
  // rawDisplayLabel is what the peer would be called with no nickname set —
  // the string that already sits, verbatim, in every log line written before
  // /nick existed.
  function rawDisplayLabel(helloName) {
    // In cloud mode the account's own display name is the best label there is:
    // it is what the other person chose and what every other client shows.
    if (isCloudPeer) return cloud.peerName || helloName || cloud.peer;
    const currentRoster = peerLogin ? lookupRoster(stateDir, peerLogin, selfIdentity) : null;
    const currentDevices = identity.login ? identity.devices : (currentRoster?.devices ?? []);
    const currentNames = currentRoster?.names ?? [];
    const isDevice = (n) => currentDevices.some((d) => d.host === n || d.dns === n || d.dns?.split('.')[0] === n);
    const friendly = currentNames.filter((n) => !isDevice(n));
    if (friendly.length > 0) return friendly[friendly.length - 1];
    if (helloName && !isDevice(helloName)) return helloName;
    return peerLogin ?? peerHost;
  }
  function resolveDisplayLabel(helloName) {
    return resolveDisplayName({
      // The server holds this account's nickname for a cloud contact; it is
      // the only label that follows the account from machine to machine, so it
      // is tried before the local one.
      alias: isCloudPeer ? cloudAliasOf(cloud) : null,
      nickname: memory.nickname(),
      fallback: rawDisplayLabel(helloName),
    });
  }

  function computePeerTargets(peerTargetName, peerTargetLogin, peerTargetMemory) {
    if (isCloudPeer) return [{ host: cloud?.peer || peerTargetName, port: 0 }];
    const targetRoster = peerTargetLogin ? lookupRoster(stateDir, peerTargetLogin, selfIdentity) : null;
    const targetDevices = identity.login ? identity.devices : (targetRoster?.devices ?? []);
    const targetAddresses = targetDevices.flatMap((device) => [
      ...device.ips,
      device.dns,
    ]).filter(Boolean);
    return (peerTargetLogin
      ? [peerTargetMemory?.lastAddress?.(), ...targetAddresses, peerTargetName]
      : [peerTargetName])
      .filter(Boolean)
      .map((address) => parsePeerAddr(address, args.port));
  }

  const peerTargets = computePeerTargets(args.peer, peerLogin, memory);
  let { host: peerHost, port: peerPort } = peerTargets[0] || { host: args.peer || '', port: args.port || 49878 };
  // No port is bound in cloud mode, so there is nothing for a background
  // process to be holding and no reason to pause it.
  const pausedPm2App = args.headless || isCloudPeer ? null : await pausePm2Daemon();
  if (pausedPm2App) {
    notice(t('pm2.paused', { name: pausedPm2App }));
  }
  if (!isCloudPeer && isNonTailscaleLan(peerHost)) {
    notice(t('tailscale.lanWarning'));
  }
  const bindAddr = isCloudPeer ? null : (args.bind || detectBindAddr());
  // The transcript is on by default; --no-log and a first-run "No" turn it off.
  // The directory must exist before the stream opens into it. `logFile` and
  // `log` are mutable: /logs swaps them while the session runs.
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const cloudCacheDir = path.join(stateDir, 'cloud-cache');
  try { fs.mkdirSync(cloudCacheDir, { recursive: true, mode: 0o700 }); } catch {}

  const sessionOutboxes = new Map();

  function getPersistentOutbox(targetKey) {
    let ob = sessionOutboxes.get(targetKey);
    if (!ob) {
      ob = createPersistentOutbox({
        file: outboxFileFor(stateDir, targetKey),
        store: secureStore,
        onPersistError: (result) => notice(t('outbox.persistFailed', {
          error: result.code ?? result.error ?? 'unknown',
        })),
      });
      sessionOutboxes.set(targetKey, ob);
    }
    return ob;
  }

  const cloudCacheSession = createCloudCacheStore({
    stateDir,
    store: secureStore,
    onWriteFailed: (error) => notice(`Cloud cache write failed: ${error.message}`),
  });
  const loadCloudCache = (peerLogin) => cloudCacheSession.load(peerLogin);
  const dropCloudCache = async (peerLogin) => {
    const clean = String(peerLogin ?? '').replace(/^@/, '').toLowerCase();
    const prefix = `cloud-${clean}`;
    for (const [key] of sessionOutboxes) {
      if (String(key).toLowerCase() === prefix) {
        sessionOutboxes.delete(key);
      }
    }
    await cloudCacheSession.drop(peerLogin);
  };
  // With the native core the store is the history, so a second plaintext copy of
  // every message in the legacy cache would only go stale beside it.
  const appendCloudCacheMessage = (peerLogin, msg) => {
    if (cloudSession?.isCore) return;
    cloudCacheSession.append(peerLogin, msg);
  };
  let logFile = resolveLogFile({
    logFlag: args.log, noLogFlag: args.noLog, configLog: logPreference,
    stateDir, peerKey,
  });
  // A full disk, a revoked permission or a Windows file lock used to arrive as
  // an unhandled stream error and cost the whole session. Now it costs a line —
  // but it does have to cost that, because someone who believes their chat is
  // being written down deserves to know the moment it stops.
  let log = createLog(logFile, {
    store: secureStore,
    onError: (error) => notice(t('log.writeFailed', { error: error.message })),
  });
  // Ask before the TUI grabs the terminal: the reply is an escape sequence and
  // would otherwise land in the composer as text.
  const focusSupported = args.headless ? false : await probeFocusSupport();
  let nameBadge = Boolean(config.nameBadge);
  const ui = args.headless
    ? createHeadlessUI({
        selfName: args.name,
        peerLabel: resolveDisplayLabel(null),
        t,
      })
    : createUI({
        focusSupported,
        termux: isTermux(),
        // In cloud mode the account is who you are; the hostname only says
        // which machine you are sitting at, which is what the header showed.
        selfName: cloud ? (cloud.self.name || cloud.self.login) : args.name,
        // Name the person, not the route their packets happen to take today.
        peerLabel: resolveDisplayLabel(null),
        selfLogin: [cloud?.self?.login, selfIdentity.login, args.name],
        themed: resolveThemed(args),
        theme: resolveThemeName(config),
        nameBadge,
        mouse: args.mouse,
        pasteLabel: (count) => t('draft.pasteLines', { count }),
        composerLabel: t('draft.composerLabel'),
        version: VERSION,
        transport: isCloudPeer ? 'cloud' : 'p2p',
        rosterRows: config.rosterRows ? Math.max(1, Math.min(3, Number(config.rosterRows) || 3)) : 3,
      });

  uiReady = true;
  // notify.js's `enabled` is fixed at construction and is not reactive, so it
  // stays on unconditionally here — /sound is the one thing that mutes a bell
  // or a desktop notification mid-session, and it needs a gate that actually
  // changes at runtime.
  let soundEnabled = config.sound !== undefined ? config.sound !== false : !args.noNotify;
  const notifications = createNotifier({
    enabled: true,
    bell: () => ui.bell(),
  });
  if (notifications.termuxNoApi) {
    ui.addLine(`* ${t('notify.termuxNoApi')}`);
  }
  // Every "the peer should hear or see this" moment — a reminder firing, an
  // unread badge, a wake, an update banner — rings through here instead of
  // calling ui.bell()/notifications.notify() directly, so /sound off silences
  // all of them from one place.
  function ring(notification) {
    return ringIfEnabled(soundEnabled, () => ui.bell(), (n) => notifications.notify(n), notification);
  }
  // notifyIfUnfocused (notify.js) calls `notifier.notify()` itself; this is the
  // same gate as `ring`, minus the bell, shaped to fit that call site instead
  // of duplicating it.
  const gatedNotifier = { notify: (n) => notifyIfEnabled(soundEnabled, (nn) => notifications.notify(nn), n) };
  const reminders = createReminderEngine({
    stateDir: args.stateDir,
    store: secureStore,
    onTrigger: (rem) => {
      const target = rem.targetUser || args.name;
      const text = rem.text;
      const msg = t('remind.triggered', { target, text });
      ui.addLine(`* ${msg}`);
      ring({ name: 'Tailchat', text: `⏰ ${text}` });
    },
  });
  if (cliSearch) {
    notice(cliSearch.override
      ? t('tailscale.cliOverrideBad', {
          var: cliSearch.overrideVar, path: cliSearch.override,
        })
      : t('tailscale.cliMissing', {
          count: cliSearch.count, var: cliSearch.overrideVar,
        }));
  }
  const unreadPeers = new Map();
  const peerRecency = new Map();

  function touchPeerRecency(login, ts = Date.now()) {
    if (!login) return;
    const clean = String(login).replace(/^@/, '').toLowerCase();
    const current = peerRecency.get(clean) || 0;
    if (ts > current) {
      peerRecency.set(clean, ts);
    }
  }

  function getPeerRecency(login) {
    if (!login) return 0;
    const clean = String(login).replace(/^@/, '').toLowerCase();
    if (peerRecency.has(clean)) {
      return peerRecency.get(clean);
    }
    let recency = 0;
    if (cloud?.users && Array.isArray(cloud.users)) {
      const u = cloud.users.find((user) => String(user?.login ?? '').toLowerCase() === clean);
      if (u) {
        recency = Math.max(recency, u.last?.ts || 0, u.lastSeen || 0);
      }
    }
    if (recency === 0 && args.stateDir) {
      try {
        const logPath = defaultLogPath(args.stateDir, isCloudPeer ? `cloud-${clean}` : clean);
        if (fs.existsSync(logPath)) {
          recency = fs.statSync(logPath).mtimeMs;
        }
      } catch {}
    }
    peerRecency.set(clean, recency);
    return recency;
  }

  function clearUnreadForPeer(peerLogin) {
    if (!peerLogin) return;
    const clean = String(peerLogin).replace(/^@/, '').toLowerCase();
    unreadPeers.delete(peerLogin);
    unreadPeers.delete(`@${peerLogin}`);
    unreadPeers.delete(clean);
    unreadPeers.delete(`@${clean}`);
    if (cloud?.users && Array.isArray(cloud.users)) {
      for (const u of cloud.users) {
        if (String(u?.login ?? '').replace(/^@/, '').toLowerCase() === clean) {
          u.pending = 0;
        }
      }
    }
  }

  const READ_DELAY_MS = 3000;
  let readTimer = null;
  let pendingReadPeer = null;
  let readActivityAt = 0;

  function canReadConversation() {
    if (ui.isLocked?.() || ui.saverActive?.() || !ui.isFollowingTail()) return false;
    return ui.focusTracked() ? ui.isFocused() : Date.now() - readActivityAt < 6000;
  }

  function cancelPendingRead() {
    if (readTimer) {
      clearTimeout(readTimer);
      readTimer = null;
    }
    pendingReadPeer = null;
  }

  function performMarkRead(targetPeer) {
    cancelPendingRead();
    if (!targetPeer || !canReadConversation()) return;
    const clean = String(targetPeer).replace(/^@/, '').toLowerCase();
    const active = String(isCloudPeer ? cloud?.peer : args.peer).replace(/^@/, '').toLowerCase();
    if (clean !== active) return;
    flushReads();
  }

  function scheduleMarkRead(peerToRead = null) {
    const target = peerToRead || (isCloudPeer ? (cloud?.peer || args.peer) : args.peer);
    if (!target) return;
    const clean = String(target).replace(/^@/, '').toLowerCase();
    if (!canReadConversation()) return;
    const hasUnread = unread.size > 0 || unreadPeers.has(clean) || unreadPeers.has(`@${clean}`);
    if (!hasUnread) return;

    cancelPendingRead();
    pendingReadPeer = clean;
    readTimer = setTimeout(() => {
      readTimer = null;
      if (pendingReadPeer !== clean) return;
      pendingReadPeer = null;
      performMarkRead(clean);
    }, READ_DELAY_MS);
  }

  const PROMOTION_DELAY_MS = 60_000;
  let activePromotionTimer = null;
  let activePromotionPeer = null;

  function cancelActivePromotion() {
    if (activePromotionTimer) {
      clearTimeout(activePromotionTimer);
      activePromotionTimer = null;
    }
    activePromotionPeer = null;
  }

  function scheduleActivePromotion(peerToPromote = null) {
    const target = peerToPromote || (isCloudPeer ? (cloud?.peer || args.peer) : args.peer);
    if (!target) return;
    const clean = String(target).replace(/^@/, '').toLowerCase();
    cancelActivePromotion();
    activePromotionPeer = clean;
    activePromotionTimer = setTimeout(() => {
      activePromotionTimer = null;
      if (activePromotionPeer !== clean) return;
      activePromotionPeer = null;
      touchPeerRecency(clean, Date.now());
      updateRosterBar();
    }, PROMOTION_DELAY_MS);
  }
  // Which conversation the session is on, as a number that only ever goes up.
  // Everything that paints the transcript from a promise — the relay's history
  // for the open thread, the shared-history replica — captures this before it
  // asks, and refuses to paint if the reader has moved on since: those
  // handlers also write to `log` and the AI memory, so a late answer for the
  // previous peer did not merely look wrong on screen, it was appended to the
  // new peer's log file and quoted back to the assistant as their words.
  //
  // `switchChain` serialises the switches themselves. One switch detaches the
  // transports, closes and reopens the log and the outbox and refetches the
  // history across several awaits; two of those interleaved — one Ctrl+→ per
  // keypress, held down — left the session's halves owned by different people.
  // Only the target asked for last survives a burst: the ones passed over are
  // conversations nobody looked at.
  let conversationEpoch = 0;
  let cloudHistoryEpoch = -1;
  const deletedHistoryIds = new Set();
  let switchChain = Promise.resolve();
  let switchQueued = null;
  // What the open conversation's log file already held when a replay first
  // landed on it; see mirrorReplayedLine.
  let logMirror = null;

  function buildRosterList() {
    const list = [];
    const seen = new Set();
    if (cloud?.self?.login) {
      const sLogin = `@${cloud.self.login}`;
      const unread = unreadPeers.get(sLogin)?.count || unreadPeers.get(cloud.self.login)?.count || 0;
      list.push({
        login: sLogin,
        name: 'Saved',
        type: 'saved',
        isSaved: true,
        unread,
      });
      seen.add(cloud.self.login);
      seen.add(sLogin);
    }
    if (cloud?.users && Array.isArray(cloud.users)) {
      for (const u of cloud.users) {
        if (!u?.login || seen.has(u.login) || seen.has(`@${u.login}`)) continue;
        const cLogin = `@${u.login}`;
        const unread = unreadPeers.get(cLogin)?.count || unreadPeers.get(u.login)?.count || (u.pending > 0 ? u.pending : 0);
        list.push({
          login: cLogin,
          // The account's own nickname for this contact outranks the name they
          // chose (issue #28); it rides on this client's roster copy only.
          name: u.alias || u.name || u.login,
          state: u.online ? 'online' : 'offline',
          type: 'cloud',
          unread,
          official: Boolean(u.official),
        });
        seen.add(u.login);
        seen.add(cLogin);
      }
    }
    try {
      const selectors = rosterSelectors(args.stateDir, { login: selfIdentity?.login ?? null, ips: ownIps });
      const choices = rosterChoices({ selectors, status: null });
      for (const choice of choices) {
        const cLogin = choice.login;
        if (!cLogin || seen.has(cLogin) || seen.has(`@${cLogin}`)) continue;
        const unread = unreadPeers.get(cLogin)?.count || 0;
        list.push({
          login: cLogin,
          name: choice.name || cLogin,
          state: choice.state || 'offline',
          type: choice.type || 'tailnet',
          unread,
        });
        seen.add(cLogin);
      }
    } catch {}
    const activeTarget = isCloudPeer ? (cloud?.peer ? `@${cloud.peer}` : `@${args.peer}`) : args.peer;
    if (activeTarget && !seen.has(activeTarget) && !seen.has(activeTarget.replace(/^@/, ''))) {
      list.push({
        login: activeTarget,
        name: cloud?.peerName || resolveDisplayLabel(null) || activeTarget,
        type: isCloudPeer ? 'cloud' : 'p2p',
        unread: 0,
      });
    }
    for (const item of list) {
      item.recency = getPeerRecency(item.login);
    }

    const sLogin = cloud?.self?.login ? `@${cloud.self.login}` : null;
    list.sort((a, b) => {
      // 1. Saved Messages always pinned at index 0 ("saved всегда pinned")
      const aSaved = a.isSaved || a.type === 'saved' || (sLogin && a.login === sLogin);
      const bSaved = b.isSaved || b.type === 'saved' || (sLogin && b.login === sLogin);
      if (aSaved !== bSaved) return aSaved ? -1 : 1;

      // 2. Unread contacts next ("в первую очередь показывать непрочитанные")
      const unreadA = Number(a.unread) || 0;
      const unreadB = Number(b.unread) || 0;
      if ((unreadA > 0) !== (unreadB > 0)) {
        return unreadA > 0 ? -1 : 1;
      }
      // 3. Both unread: newest message first
      if (unreadA > 0 && unreadB > 0) {
        const diff = (b.recency || 0) - (a.recency || 0);
        if (diff !== 0) return diff;
        return String(a.name || a.login).localeCompare(String(b.name || b.login));
      }
      // 4. Sort by recency of messages (newest message first)
      const diff = (b.recency || 0) - (a.recency || 0);
      if (diff !== 0) return diff;
      return String(a.name || a.login).localeCompare(String(b.name || b.login));
    });
    return list;
  }

  function updateRosterBar() {
    const active = isCloudPeer ? (cloud?.peer ? `@${cloud.peer}` : `@${args.peer}`) : args.peer;
    ui.setRoster(buildRosterList(), active);
  }

  function updateUnreadHeader() {
    // Top header unread badge is suppressed because the bottom roster displays contacts and unreads
    ui.setUnreadBadge('');
    updateRosterBar();
  }

  ui.onRosterSelect((peerLogin) => {
    finishSwitch(peerLogin);
  });

  if (args.peer) touchPeerRecency(args.peer, Date.now());
  if (cloud?.users) {
    const cleanActivePeer = String((isCloudPeer ? cloud?.peer : args.peer) ?? '').replace(/^@/, '').toLowerCase();
    for (const u of cloud.users) {
      const uLogin = String(u?.login ?? '').replace(/^@/, '').toLowerCase();
      if (u.last?.ts) touchPeerRecency(uLogin, u.last.ts);
      if (uLogin !== cleanActivePeer && u.pending > 0) {
        unreadPeers.set(`@${u.login}`, { count: u.pending });
        unreadPeers.set(u.login, { count: u.pending });
      }
    }
  }
  updateRosterBar();

  while (pending.length > 0) notice(pending.shift());
  let peerFocus = null; // null until the peer says, so /version can be honest
  let peerFocusReported = false; // printed the "no focus" note once per session
  let announcedFocus = false; // what we last told the peer about our own terminal
  let outbox = getPersistentOutbox(isCloudPeer ? `cloud-${cloud.peer}` : `${peerHost}:${peerPort}`);
  const unread = new Map(); // incoming id -> server timestamp
  const ownReadWatermarks = new Map(); // peer -> accepted account-wide read timestamp
  // Index → absolute path, in the order /files prints them and /open counts them.
  const received = [];
  const sent = [];
  let lastFile = null; // whichever of the two arrived most recently
  let clickHintShown = false; // the "a click opens it" line is said once, or never
  const wakeThrottle = createThrottle(WAKE_THROTTLE_MS);

  // ── the third participant ──────────────────────────────────────────────────
  // Called by name or by /ai, it answers into the same transcript both people
  // are reading. The taste — its name, the model, whether it listens at all —
  // comes from the config file; the key from the environment, or from the
  // secrets file beside the config, which is what makes a fresh shell with
  // nothing exported still have a working /ai. A real variable still wins: an
  // export is what a person reaches for to override for one session.
  const aiEnv = { ...readSecrets(stateDir), ...process.env };
  let ai = resolveAi({ config, env: aiEnv });
  let aiMention = mentionRegex(ai.name);
  const aiTurns = createTurnBuffer(AI_TURNS);
  const aiThrottle = createThrottle(AI_THROTTLE_MS);
  let aiInFlight = false;
  let aiAbort = null; // the in-flight AI request, aborted by /stop
  let aiChild = null; // the in-flight safe shell command, killed by /stop
  // The in-flight `/voice` recording, finished early by /stop. Null whenever
  // nothing is recording.
  let voiceStop = null;
  let sinceTailik = 0;
  let peerHasAi = false; // until their caps frame claims the answering
  let peerAiMuted = false; // and until it says they want no AI here at all
  // Whether their client knows the AI frame at all. null until their hello says.
  let peerSupportsAi = null;
  // And whether it knows the logo frame, which decides between an animation and
  // a plain picture on their side.
  let peerSupportsLogo = null;
  let peerSupportsHoliday = null;
  // One place builds the caps frame: six copies of it had to agree about a
  // second field, and that is the kind of agreement that lasts until someone
  // adds a seventh. What each field means lives with the rule in src/ai.js.
  const sendCaps = () => rz.sendFrame({
    t: 'caps',
    focus: announcedFocus,
    ai: aiOwnsAnswers(ai),
    aiMuted: ai.never === true,
  });

  const rememberTurn = (author, text, ts, kind = 'human') => (
    aiTurns.push({ author, text, ts, kind })
  );

  // The answer belongs to the conversation, not to one screen. `aiFrame` decides
  // whether the peer's client can read it as its own author or needs it as a
  // message; either way it leaves here, and only a dead channel keeps it home.
  function emitAi(text) {
    const ts = Date.now();
    const id = newMessageId();
    sinceTailik = 0;
    ui.addMessage({ id, name: ai.name, text, ts, self: false, bot: true });
    log.append(formatLine(ts, ai.name, text));
    archiveSharedMessage({ id, name: ai.name, text, ts, kind: 'ai' });
    rememberTurn(ai.name, text, ts, 'ai');
    const frame = aiFrame({ name: ai.name, text, ts, id, peerSupportsAi });
    if (!rz.sendFrame(frame)) ui.addLine(`* ${t('ai.offline')}`);
  }

  // One request at a time, and never faster than a free tier allows: two people
  // saying the name in the same breath must not become two calls. The question
  // is always the last turn in the buffer by the time we get here — it was said
  // in the room, not handed over privately.
  async function runAi() {
    if (!ai.key) return ui.addLine(`* ${t('ai.noKey', { env: ai.keyEnv })}`);
    if (aiInFlight) return ui.addLine(`* ${t('ai.busy')}`);
    if (!aiThrottle.tryTake()) {
      return ui.addLine(`* ${t('ai.wait', { seconds: aiThrottle.remainingSeconds() })}`);
    }
    aiInFlight = true;
    aiAbort = new AbortController();
    // A composing AI is a voice, not a delivery: the rule shows it the way it
    // would show a person typing, and the peer sees the same signal under the
    // same name. A file going out keeps the rule, and a question is not worth
    // hiding that.
    if (!ui.sendingLabel()) ui.setAiTyping(ai.name);
    rz.sendFrame({ t: 'typing', state: 'start', name: ai.name });
    try {
      const outcome = await askAiReply();
      if (outcome.ok) {
        if (outcome.text !== '') emitAi(outcome.text);
        return undefined;
      }
      if (outcome.reason === 'stopped') return ui.addLine(`* ${t('ai.stopped')}`);
      // Headers arrived and the body never did. Worth its own sentence: "the AI
      // did not answer" would suggest the question never left, when in fact the
      // provider took it, began replying and went quiet.
      if (outcome.reason === 'timeout-body') return ui.addLine(`* ${t('ai.timeoutBody')}`);
      if (outcome.reason === 'empty') return ui.addLine(`* ${t('ai.noReply')}`);
      ui.addLine(`* ${t('ai.failed', { reason: outcome.reason })}`);
      if (outcome.detail) ui.addLine(`* ${t('ai.detail', { detail: outcome.detail })}`);
      return undefined;
    } finally {
      aiInFlight = false;
      aiAbort = null;
      ui.setAiTyping(null);
      rz.sendFrame({ t: 'typing', state: 'stop', name: ai.name });
    }
  }

  function maybeFeedback() {
    sinceTailik += 1;
    if (sinceTailik < AI_FEEDBACK_EVERY) return false;
    // Only the single physical AI comments. A peer claiming AI owns its own
    // recap, and *-marked human-only lines never call this function.
    if (!ai.enabled || !ai.key || aiInFlight || !rz.isOnline() || peerHasAi === true) return false;
    sinceTailik = 0;
    runAiFeedback();
    return true;
  }

  async function runAiFeedback() {
    if (!ai.key || aiInFlight) return;
    if (!aiThrottle.tryTake()) return;
    aiInFlight = true;
    aiAbort = new AbortController();
    if (!ui.sendingLabel()) ui.setAiTyping(ai.name);
    rz.sendFrame({ t: 'typing', state: 'start', name: ai.name });
    try {
      const { system, messages } = buildRequest({
        turns: aiTurns.recent(),
        aiName: ai.name,
        selfName: args.name,
        peerName: currentPeerLabel,
        version: VERSION,
        commands: chatCommands.map((c) => (
          `${c.name}${c.alias ? ` (${c.alias})` : ''} — ${t(c.help)}`
        )),
        appCommands: AI_SAFE_COMMANDS,
        mode: 'feedback',
      });
      const result = await requestReply({
        resolved: ai, system, messages, humanNames: [args.name, currentPeerLabel], signal: aiAbort?.signal,
      });
      if (result.ok) {
        const { text } = splitCommands(result.text, {
          appCommands: AI_SAFE_COMMANDS, allowShellCommands: false,
        });
        if (text !== '') emitAi(text);
      }
    } finally {
      aiInFlight = false;
      aiAbort = null;
      ui.setAiTyping(null);
      rz.sendFrame({ t: 'typing', state: 'stop', name: ai.name });
    }
  }

  // /stop cuts the model off mid-answer; kills a safe shell command too; and
  // finishes a `/voice` recording early, which is the only way to end a long
  // take without waiting out its clock.
  function stopAi() {
    if (voiceStop) {
      const stop = voiceStop;
      voiceStop = null;
      stop();
      ui.addLine(`* ${t('voice.stopped')}`);
      return undefined;
    }
    if (!aiInFlight) return ui.addLine(`* ${t('ai.nothingToStop')}`);
    aiAbort?.abort();
    if (aiChild) { aiChild.kill('SIGKILL'); aiChild = null; }
    return undefined;
  }
  // One question, one model call, plus at most one more if the reply was
  // nothing but a read command (/changelog, /files, /version): the model
  // cannot answer "what changed in 0.57" before it has seen the changelog,
  // so that second call carries the real output, with no further commands
  // allowed — a read can never cascade into another read.
  async function requestAi({ appCommands = AI_SAFE_COMMANDS, allowShellCommands = true } = {}) {
    const { system, messages } = buildRequest({
      turns: aiTurns.recent(),
      aiName: ai.name,
      selfName: args.name,
      peerName: currentPeerLabel,
      version: VERSION,
      commands: chatCommands.map((c) => (
        `${c.name}${c.alias ? ` (${c.alias})` : ''} — ${t(c.help)}`
      )),
      appCommands,
      shellCommands: allowShellCommands ? AI_SAFE_SHELL_COMMANDS : [],
    });
    const result = await requestReply({
      resolved: ai, system, messages, humanNames: [args.name, currentPeerLabel], signal: aiAbort?.signal,
    });
    if (!result.ok) return result;
    const { text, commands } = splitCommands(result.text, { appCommands, allowShellCommands });
    const reads = [];
    for (const cmd of commands.slice(0, AI_TOOL_ROUNDS)) {
      const output = await runAiCommand(cmd);
      if (output !== undefined) reads.push({ cmd, output });
    }
    return {
      ok: true, text, hadCommands: commands.length > 0, commands, reads,
    };
  }

  async function askAiReply() {
    const first = await requestAi();
    if (!first.ok) return first;
    if (first.text !== '') return { ok: true, text: first.text };
    if (first.reads.length === 0) {
      // Speech commands (/happy, /sad, …) emit themselves and return nothing — that is fine.
      // Any other command that produced no output is a real failure worth surfacing.
      const allSpeech = first.hadCommands
        && first.commands?.every((cmd) => AI_SPEECH_COMMANDS.includes(cmd.app));
      return allSpeech ? { ok: true, text: '' } : { ok: false, reason: 'empty' };
    }
    for (const { cmd, output } of first.reads) {
      const label = cmd.app ? `${cmd.app}${cmd.arg ? ` ${cmd.arg}` : ''}` : cmd.command;
      aiTurns.push({ author: 'tool', text: `${label}:\n${output}`, kind: 'tool' });
    }
    const second = await requestAi({ appCommands: [], allowShellCommands: false });
    if (!second.ok) return second;
    return second.text !== '' ? { ok: true, text: second.text } : { ok: false, reason: 'empty' };
  }

  // A command the model asked to run itself: one of its own safe tailchat
  // commands (dispatched through aiCommandTable — see its construction for
  // why /happy speaks under the AI's own name there) or one of the fixed
  // local read-only shell commands. Whatever real text comes back (a file
  // list, a changelog entry, `git log`'s output) is handed back to the
  // caller, so the model can actually use it instead of only knowing it ran.
  // Whatever a command produced, bounded. The shell path has always capped its
  // output; the app-command path did not, so `/help` or `/changelog` went into
  // the follow-up request whole. That request carries its own full 30-second
  // budget on top of the first one and the command's own run time, and a prompt
  // padded with a screenful of help text is exactly what pushed it over — which
  // is «на некоторых командах он уходит в таймаут». Truncation is announced, so
  // the model knows it is reading part of something rather than all of it.
  function capToolOutput(text) {
    if (text.length <= AI_TOOL_OUTPUT_CAP) return text;
    return `${text.slice(0, AI_TOOL_OUTPUT_CAP)}\n… (${t('ai.outputTruncated')})`;
  }

  async function runAiCommand(cmd) {
    if (cmd.app) {
      const entry = aiCommandTable.get(cmd.app);
      if (!entry) return undefined;
      ui.addLine(`* ${t('ai.appCommandRunning', { cmd: cmd.arg ? `${cmd.app} ${cmd.arg}` : cmd.app })}`);
      // These are the same functions a person's typed command runs, so they
      // paint their output into the transcript on the way. That is right for a
      // person and wrong here: the model asked for this to read it, and the
      // reader is waiting for an answer, not for `/help` in full. The lines are
      // collected instead and handed back as the command's result — which is
      // also the only way to get output from the ones that print without
      // returning anything, like `/diagnose`.
      ui.startLineCapture();
      let output;
      let printed = [];
      try {
        output = await entry.run(cmd.arg);
      } finally {
        printed = ui.stopLineCapture();
      }
      const text = typeof output === 'string' && output !== ''
        ? output
        : printed.join('\n');
      return text !== '' ? capToolOutput(text) : undefined;
    }
    // Never another machine, and only the fixed allowlist — a blocklist of
    // "destructive" commands would still have let `cat secrets.env` through.
    if (cmd.host !== null || !isSafeShellCommand(cmd.command)) {
      return `blocked: ${cmd.command} is not an allowed command`;
    }
    ui.addLine(`* ${t('ai.appCommandRunning', { cmd: cmd.command })}`);
    return runSafeShellCommand(cmd.command);
  }

  // Runs one of the fixed, local, read-only diagnostics through the platform
  // shell, capped and killable — the same shape a hung command always needed,
  // just without the arbitrary command or the other machine it used to allow.
  function runSafeShellCommand(command) {
    return new Promise((resolve) => {
      const child = spawn(command, { shell: true });
      aiChild = child; // /stop can kill it
      const cap = AI_TOOL_OUTPUT_CAP;
      let out = '';
      const push = (chunk) => {
        if (out.length >= cap) return;
        out += String(chunk).slice(0, cap - out.length);
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      child.on('error', (err) => {
        clearTimeout(timer);
        aiChild = null;
        resolve(`could not start: ${err.message}`);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        aiChild = null;
        const status = signal ? `killed (${signal})` : `exit ${code}`;
        resolve(out.trim() === '' ? `(${status}, no output)` : `(${status})\n${out.trim()}`);
      });
    });
  }

  // Per-conversation quiet windows, keyed by the peer this session is talking
  // to: telling tailik to be quiet here must not silence it in the next
  // conversation. In memory only — a fifteen-minute window is not worth a
  // write to the config, and a restart returning the assistant to answering is
  // the safe direction to fail.
  const aiQuietUntil = new Map();

  // Name or direct continuation invites the AI. Small talk stays between the
  // people and contributes to one short recap every fifteen unanswered lines.
  // The author's capable client owns an addressed line; otherwise the peer's
  // single AI provides the fallback.
  function maybeAnswer(text, fromSelf, replyTo = null) {
    const isReplyToAiMessage = Boolean(
      replyTo && typeof replyTo === 'object' && (replyTo.author === ai.name || replyTo.author === 'tailik')
    );
    const addressed = aiMention.test(text) || isReplyToAiMessage || isReplyToAi(aiTurns.recent(2), ai.name);
    // Only the client that would have answered may go quiet or say so: a
    // terminal with no key must not announce a silence nobody asked it for,
    // and a session deferring to the peer's AI has no silence to promise.
    const mineToAnswer = ai.enabled && Boolean(ai.key) && (fromSelf || peerHasAi !== true);
    if (mineToAnswer) {
      const peerKey = currentPeerLabel || peerHost;
      const quietNow = (aiQuietUntil.get(peerKey) ?? 0) > Date.now();
      const wantsQuiet = AI_QUIET_WORDS.test(text)
        && (addressed || isBareInstruction(text, AI_QUIET_WORDS));
      const wantsVoice = AI_RESUME_WORDS.test(text)
        && (addressed || isBareInstruction(text, AI_RESUME_WORDS));
      // «говори» wins over «стоп» in the same breath: the later instruction in
      // a sentence like «стоп, нет, говори» is the one a person means.
      if (wantsVoice) {
        aiQuietUntil.delete(peerKey);
        // Acked only if it was actually quiet — otherwise the word was just a
        // word in a sentence.
        if (quietNow) {
          emitAi(t('ai.resumeAck'));
          return true;
        }
      } else if (wantsQuiet) {
        aiQuietUntil.set(peerKey, Date.now() + AI_QUIET_MS);
        // Repeating it inside an existing window stays silent: acknowledging a
        // request for silence twice is the opposite of obeying it.
        if (!quietNow) emitAi(t('ai.quietAck', { minutes: Math.round(AI_QUIET_MS / 60000) }));
        return true;
      }
      if (quietNow) return true;
    }
    if (!shouldAutoReply({
      enabled: ai.enabled, hasKey: Boolean(ai.key), fromSelf, peerHasAi, addressed,
    })) return false;
    runAi();
    return true;
  }

  // Everything a person needs to answer "why is it doing that", in the order
  // they need it. The first line is the one that mattered: who answers here.
  // Then this machine, then where its key comes from — an exported variable
  // outranking the file has now caused confusion twice — then the peer.
  function aiStatus() {
    const who = answersHere({
      enabled: ai.enabled,
      key: ai.key,
      never: ai.never,
      peerOwns: peerHasAi,
      peerMuted: peerAiMuted,
    });
    const peer = currentPeerLabel;
    ui.addLine(`* ${{
      you: () => t('ai.whoYou', { name: ai.name }),
      peer: () => t('ai.whoPeer', { peer }),
      'nobody-mine': () => t('ai.whoNobodyMine'),
      'nobody-peer': () => t('ai.whoNobodyPeer', { peer }),
      none: () => t('ai.whoNone'),
    }[who]()}`);

    const state = ai.never
      ? t('ai.stateNever')
      : ai.key
        ? t(ai.enabled ? 'ai.stateOn' : 'ai.stateOff')
        : t('ai.stateNoKey', { env: ai.keyEnv });
    ui.addLine(`* ${t('ai.statusMachine', {
      name: ai.name, provider: ai.provider, model: ai.model, state,
    })}`);

    // Which of the two sources actually supplied it, not which one could have.
    const exported = [ai.keyEnv, 'TAILCHAT_AI_KEY'].filter((name) => process.env[name]);
    if (exported.length > 0) {
      ui.addLine(`* ${t('ai.keyFromEnv', { env: exported.join(', ') })}`);
    } else if (ai.key) {
      ui.addLine(`* ${t('ai.keyFromFile', { env: ai.keyEnv, file: secretsFile(stateDir) })}`);
    } else {
      ui.addLine(`* ${t('ai.keyAbsent', { env: ai.keyEnv })}`);
    }

    // A client too old to know the flag is worth naming: it explains both why it
    // claims nothing and why it may answer anyway.
    if (peerSupportsAi === false) return ui.addLine(`* ${t('ai.peerOld', { peer })}`);
    if (peerAiMuted) return ui.addLine(`* ${t('ai.peerMutedShort', { peer })}`);
    return ui.addLine(`* ${t(peerHasAi ? 'ai.peerClaims' : 'ai.peerQuiet', { peer })}`);
  }
  async function testAi() {
    if (!ai.key) return ui.addLine(`* ${t('ai.testNoKey', { env: ai.keyEnv })}`);
    if (aiInFlight) return ui.addLine(`* ${t('ai.busy')}`);
    aiInFlight = true;
    aiAbort = new AbortController();
    ui.addLine(`* ${t('ai.testing', { provider: ai.provider, model: ai.model })}`);
    try {
      const result = await requestReply({
        resolved: ai,
        system: 'Reply with exactly OK. This request only verifies API connectivity.',
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: 32,
        retries: 0,
        signal: aiAbort.signal,
      });
      if (result.ok) return ui.addLine(`* ${t('ai.testOk', { provider: ai.provider, model: ai.model })}`);
      if (result.reason === 'stopped') return ui.addLine(`* ${t('ai.stopped')}`);
      ui.addLine(`* ${t('ai.testFailed', { reason: result.reason })}`);
      if (result.detail) ui.addLine(`* ${t('ai.detail', { detail: result.detail })}`);
      return undefined;
    } finally {
      aiInFlight = false;
      aiAbort = null;
    }
  }


  function aiHelp() {
    for (const key of ['ai.helpAsk', 'ai.helpWho', 'ai.helpKey', 'ai.helpModel', 'ai.helpMisc', 'ai.helpTest']) {
      ui.addLine(`* ${t(key)}`);
    }
  }

  async function switchAiModel(arg) {
    const raw = String(arg ?? '').trim();
    const preset = AI_PROVIDERS[ai.provider] ?? AI_PROVIDERS.gemini;
    const models = preset.models ?? GOOGLE_MODELS;
    let next = raw;
    if (raw === '') {
      const rows = models.map((m, idx) => ({
        name: `${idx + 1}. ${m}`,
        help: m === ai.model ? t('settings.active') : (m === preset.model ? t('ai.modelDefault') : undefined),
        value: m,
      }));
      const picked = await ui.pickFromList({
        label: t('settings.aiModel'),
        rows,
      });
      if (picked === null) return undefined;
      next = picked;
    }
    const target = normaliseModelName(next, ai.provider);
    if (!target) return ui.addLine(`* ${t('ai.badModel')}`);
    ai = { ...ai, model: target };
    persist({ ai: aiConfigPatch(ai) });
    sendCaps();
    return ui.addLine(`* ${t('ai.modelSet', { provider: ai.provider, model: ai.model })}`);
  }

  function askAi(arg) {
    const raw = String(arg ?? '').trim();
    // Bare /ai has always shown the setup, so it keeps doing so; `status` is the
    // name a person guesses, and `help` stops the usage line from having to be
    // both a reference and an advertisement.
    if (raw === '' || raw.toLowerCase() === 'status') return aiStatus();
    if (raw.toLowerCase() === 'help') return aiHelp();
    if (raw.toLowerCase() === 'test') return testAi();
    if (raw.toLowerCase() === 'models' || raw.toLowerCase() === 'model') return switchAiModel('');
    const word = raw.toLowerCase();
    if (word === 'on' || word === 'off' || word === 'never') {
      ai = { ...ai, enabled: word === 'on', never: word === 'never' };
      persist({ ai: aiConfigPatch(ai) });
      sendCaps();
      return ui.addLine(`* ${t(word === 'never' ? 'ai.neverSet' : (ai.enabled ? 'ai.turnedOn' : 'ai.turnedOff'))}`);
    }
    const named = /^name\s+(.+)$/i.exec(raw);
    if (named) {
      const next = normaliseAiName(named[1]);
      if (!next) return ui.addLine(`* ${t('ai.badName')}`);
      ai = { ...ai, name: next };
      aiMention = mentionRegex(ai.name);
      persist({ ai: aiConfigPatch(ai) });
      return ui.addLine(`* ${t('ai.named', { name: ai.name })}`);
    }
    // Taking the key away is the other half of putting it there, and the reason
    // it exists: a key on both machines means both clients advertise an AI and
    // both answer, so the room gets two assistants under one name. Without this
    // the only ways out were --reset, which also discards the language and the
    // transcript choice, and deleting a file by hand on a machine whose owner
    // may have no shell open.
    const dropped = /^key\s+(none|off|clear|forget)$/i.exec(raw);
    if (dropped) {
      // Every provider's variable, not just the one in force. Removing only the
      // active key leaves the others on disk, and `resolveProvider` then simply
      // picks whichever preset still has one — so the machine would go on
      // answering under a different provider, which is precisely the outcome
      // being asked for the opposite of. A live test caught exactly that.
      const names = [
        ...Object.values(AI_PROVIDERS).map((preset) => preset.keyEnv),
        'TAILCHAT_AI_KEY',
      ];
      let removed;
      try {
        ({ removed } = removeSecret(stateDir, names));
      } catch (err) {
        return ui.addLine(`* ${t('ai.keyFailed', { reason: err.message })}`);
      }
      for (const name of names) delete aiEnv[name];
      ai = resolveAi({ config, env: aiEnv });
      // Said before anything else: this is what stops the peer's client waiting
      // on an answer that is never coming.
      sendCaps();
      // An exported variable outranks the file, so deleting a line cannot unset
      // it — and claiming the key is gone while the next start finds it again
      // would be the worst of the three possible answers.
      const exported = names.filter((name) => process.env[name]);
      if (exported.length > 0) {
        return ui.addLine(`* ${t('ai.keyStillExported', { env: exported.join(', ') })}`);
      }
      return ui.addLine(`* ${t(removed.length > 0 ? 'ai.keyCleared' : 'ai.keyNone', {
        env: names.join(', '), file: secretsFile(stateDir),
      })}`);
    }
    // The one setup step that used to live outside the app, brought inside it:
    // typed once, the key is on disk with the mode a secret needs and every
    // later session finds it by itself. What was typed does not travel and is
    // not written to the transcript — this is the one command whose argument is
    // a secret. It also wins over an exported variable for the rest of this
    // session: a person who just typed a key means the new one.
    const keyed = /^key\s+(.+)$/i.exec(raw);
    if (keyed) {
      const secret = keyed[1].trim().replace(/^['"]|['"]$/g, '');
      if (secret === '') return ui.addLine(`* ${t('ai.keyEmpty')}`);
      try {
        writeSecret(stateDir, ai.keyEnv, secret);
      } catch (err) {
        return ui.addLine(`* ${t('ai.keyFailed', { reason: err.message })}`);
      }
      aiEnv[ai.keyEnv] = secret;
      ai = resolveAi({ config, env: aiEnv });
      sendCaps();
      return ui.addLine(`* ${t('ai.keySaved', {
        env: ai.keyEnv, file: secretsFile(stateDir),
      })}`);
    }
    // A key can run out — a depleted free tier answers 4xx to everything — and
    // then the only way out used to be hand-editing config.json. The switch
    // drops the old model and endpoint with it: they belonged to the preset that
    // named them, and pointing one provider at another's model answers nothing.
    const chosen = /^provider\s+(\S+)$/i.exec(raw);
    if (chosen) {
      const wanted = chosen[1].toLowerCase();
      if (!Object.hasOwn(AI_PROVIDERS, wanted)) {
        return ui.addLine(`* ${t('ai.badProvider', {
          names: Object.keys(AI_PROVIDERS).join(', '),
        })}`);
      }
      persist({ ai: { enabled: ai.enabled, name: ai.name, provider: wanted } });
      ai = resolveAi({ config, env: aiEnv });
      sendCaps();
      ui.addLine(`* ${t('ai.providerSet', { provider: ai.provider, model: ai.model })}`);
      if (!ai.key) ui.addLine(`* ${t('ai.noKey', { env: ai.keyEnv })}`);
      return undefined;
    }
    const modelChosen = /^models?\s+(.+)$/i.exec(raw);
    if (modelChosen) {
      return switchAiModel(modelChosen[1]);
    }
    // Make `/ai question` an ordinary visible address. This uses the same
    // single-owner routing as typing "tailik, question" by hand, so Roman's
    // disabled client never needs a key.
    const spoken = aiMention.test(raw) ? raw : `${ai.name}, ${raw}`;
    // Full off: the question is not even offered to the peer's AI. /ai off
    // still posts it — that is how "one AI on the Mac" routes Roman's question.
    if (ai.never) return ui.addLine(`* ${t('ai.neverQuestion')}`);
    const localAccepted = sendText(spoken);
    if (shouldRunExplicitAi({
      localAccepted, localEnabled: ai.enabled, peerHasAi,
    })) runAi();
    return undefined;
  }

  // «Удалить» in a terminal: no message to point at with a mouse, so `/del`
  // means the last thing *this side* said, and `/del 3` the last three. Only
  // one's own words can be taken off the other person's screen — deleting what
  // somebody else said is not a thing this protocol offers, and should not be.
  //
  //   /del        the last message you sent, on both screens
  //   /del 3      the last three you sent, on both screens
  //   /del me     the last one, from this account only — the peer keeps theirs
  //   /del me 3   the last three, from this account only
  function deleteMessages(arg) {
    const words = String(arg ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const mine = words[0] === 'me' || words[0] === 'self';
    const scope = mine ? 'self' : 'all';
    const countWord = mine ? words[1] : words[0];
    const count = countWord === undefined ? 1 : Number(countWord);
    if (!Number.isInteger(count) || count < 1 || count > DEL_MAX_IDS) {
      return ui.addLine(`* ${t('del.usage', { max: DEL_MAX_IDS })}`);
    }

    const ids = ui.recentMessageIds({ self: true, limit: count });
    if (ids.length === 0) return ui.addLine(`* ${t('del.nothing')}`);

    // A `self` deletion over p2p has nobody to tell: there is no server holding
    // a copy, and the peer's own transcript is deliberately none of our
    // business. Over the cloud it still travels, because the server stores the
    // conversation and this account's other devices have to catch up.
    const tell = scope === 'all' || onCloudTransport();
    if (tell && !rz.sendFrame({ t: 'del', ids, scope })) {
      // Unlike a message, a deletion is not worth queueing: by the time the
      // channel is back the reader has moved on, and a revocation that arrives
      // out of nowhere an hour later is its own confusion.
      return ui.addLine(`* ${t('del.offline', { peer: currentPeerLabel })}`);
    }

    ui.removeMessages(ids);
    if (showDeletedMessages) ui.addLine(`* ${t('del.marker')}`);
    return undefined;
  }

  const coreEdits = createCoreEdits(ui, () => ui.addLine(`* ${t('edit.coreFailed')}`));

  function editLastMessage(arg) {
    const text = replaceColonEmojis(String(arg ?? '').trim());
    if (text === '') return ui.addLine(`* ${t('edit.usage')}`);
    const [id] = ui.recentMessageIds({ self: true, limit: 1 });
    if (!id) return ui.addLine(`* ${t('edit.nothing')}`);
    // On the core the edit is the core's action: in an encrypted conversation
    // it travels inside the ciphertext, otherwise as the open `edit` frame.
    if (cloudSession?.isCore && onCloudTransport() && rz.canEdit()) {
      // On screen first, so a refusal that comes at once and one that comes
      // later are undone the same way (`createCoreEdits`).
      const carrier = newMessageId();
      coreEdits.remember(carrier, id, text);
      ui.updateMessage(id, text);
      if (rz.editText(id, text, carrier) === null) {
        coreEdits.fail(carrier);
        return ui.addLine(`* ${t('edit.offline', { peer: currentPeerLabel })}`);
      }
      return undefined;
    }
    if (!rz.sendFrame({ t: 'edit', id, text })) {
      return ui.addLine(`* ${t('edit.offline', { peer: currentPeerLabel })}`);
    }
    ui.updateMessage(id, text);
    return undefined;
  }

  function currentSelfLogin() {
    return (onCloudTransport() ? cloud?.self?.login : selfIdentity.login)
      || cloud?.self?.login
      || selfIdentity.login
      || args.name;
  }

  function currentPeerLogin() {
    return (onCloudTransport() ? cloud?.peer : peerLogin)
      || peerLogin
      || cloud?.peer
      || currentPeerLabel;
  }

  function reactLastMessage(arg) {
    const resolved = resolveReactionCommand(
      arg,
      (options) => ui.recentMessageIds(options),
    );
    if (resolved.error) return ui.addLine(`* ${t(resolved.error)}`);
    const by = currentSelfLogin();
    if (!rz.sendFrame({
      t: 'react', id: resolved.id, emoji: resolved.emoji, by, add: true,
    })) {
      return ui.addLine(`* ${t('react.offline', { peer: currentPeerLabel })}`);
    }
    ui.applyReaction(resolved.id, resolved.emoji, by, true);
    return undefined;
  }

  function markConversationUnread() {
    if (!onCloudTransport() || !cloudSession?.markUnread?.(currentPeerLogin())) {
      return ui.addLine(`* ${t('unread.offline')}`);
    }
    ui.addLine(`* ${t('unread.marked', { peer: currentPeerLabel })}`);
    return undefined;
  }

  function remindReplyToMessage(arg) {
    const resolved = resolveReplyReminderCommand(arg, {
      recentMessageIds: (options) => ui.recentMessageIds(options),
      messageById: (id) => ui.messageById(id),
    });
    if (resolved.error) {
      return ui.addLine(`* ${t(resolved.error, { target: resolved.target ?? '' })}`);
    }
    if (!onCloudTransport()
      || !cloudSession?.scheduleReplyReminder?.(currentPeerLogin(), resolved.id, resolved.dueAt)) {
      return ui.addLine(`* ${t('later.offline')}`);
    }
    ui.addLine(`* ${t('later.set', {
      peer: currentPeerLabel,
      time: formatClockTime(resolved.dueAt),
    })}`);
    return undefined;
  }

  // The one line a forwarded message gets above its body, in the transcript
  // and on the wire's receiving side alike.
  function forwardLead(forwardedFrom) {
    const who = forwardedFrom?.name || forwardedFrom?.login || '?';
    return `⤷ ${t('forward.from', { name: who })}`;
  }

  function forwardMessage(arg) {
    const resolved = resolveForwardCommand(arg, {
      recentMessageIds: (options) => ui.recentMessageIds(options),
      messageById: (id) => ui.messageById(id),
      selfLogin: currentSelfLogin(),
      selfName: args.name,
      peerLogin: currentPeerLogin(),
      peerName: currentPeerLabel,
    });
    if (resolved.error) {
      return ui.addLine(`* ${t(resolved.error, { target: resolved.target ?? '' })}`);
    }
    return sendText(resolved.text, { forwardedFrom: resolved.forwardedFrom, toHuman: true });
  }

  function replyToMessage(arg) {
    const resolved = resolveReplyCommand(arg, {
      recentMessageIds: (options) => ui.recentMessageIds(options),
      messageById: (id) => ui.messageById(id),
      selfLogin: currentSelfLogin(),
      peerLogin: currentPeerLogin(),
    });
    if (resolved.error) {
      return ui.addLine(`* ${t(resolved.error, { target: resolved.target ?? '' })}`);
    }
    return sendText(resolved.text, { replyTo: resolved.replyTo });
  }

  // How a message actually gets to the other person, spelled out. Over the
  // relay the route is this client, the server, and them; over p2p it is the
  // address arbitration settled on, which on a tailnet is a real machine worth
  // naming. Neither is guessable from the transcript, and «why is this slow»
  // is unanswerable without it.
  // The server's host as a person would name it, not the whole ws:// URL.
  function cloudHostLabel() {
    try {
      return new URL(cloud.socketUrl).host;
    } catch {
      return cloud?.socketUrl || '?';
    }
  }

  function showRoute() {
    const lines = [];
    const peer = currentPeerLabel;
    if (!peerHere) {
      lines.push(`* ${t('route.offline', { peer })}`);
    } else if (onCloudTransport()) {
      lines.push(`* ${t('route.cloud', { peer, server: cloudHostLabel() })}`);
    } else {
      const socket = rz.activeSocket();
      const endpoint = socket?.remoteAddress
        ? `${socket.remoteAddress}${socket.remotePort ? `:${socket.remotePort}` : ''}`
        : (lastRemoteAddress || '?');
      lines.push(`* ${t('route.p2p', { peer, address: endpoint })}`);
    }
    const client = isWebVersion(lastPeerVersion)
      ? t('route.clientWeb')
      : (lastPeerVersion ? t('route.clientCli', { version: lastPeerVersion }) : t('route.clientUnknown'));
    lines.push(`* ${t('route.client', { peer, client })}`);
    if (lastRttMs !== null) lines.push(`* ${t('route.latency', { ms: lastRttMs })}`);
    for (const line of lines) ui.addLine(line);
    return lines.join('\n');
  }

  function sendWake() {
    if (!rz.isOnline()) return ui.addLine(`* ${t('wake.offline')}`);
    if (!wakeThrottle.tryTake()) {
      return ui.addLine(`* ${t('wake.wait', { seconds: wakeThrottle.remainingSeconds() })}`);
    }
    rz.sendFrame({ t: 'wake' });
    return ui.addLine(`* ${t('wake.sent', { peer: currentPeerLabel })}`);
  }
  const receiver = createFileReceiver({
    dir: args.filesDir,
    maxBytes: args.maxFile * 1024 * 1024,
    store: secureStore,
  });
  let peerSupportsFiles = null; // null = unknown until the first hello
  let lastPeerName = null;
  let currentPeerLabel = resolveDisplayLabel(null);
  let lastPeerVersion = null; // what the peer announced in its hello
  let seenPeerVersion = null; // survives a reconnect, so an update can be noticed
  const updateBannerGuard = createUpdateBannerGuard();
  let autoupdateEnabled = config.autoupdate === true;
  let sysmsgEnabled = args.sysmsg ? true : (args.noSysmsg ? false : config.sysmsg === true);
  let showDeletedMessages = config.showDeletedMessages === true;

  function maybeAutoUpdate(theirs) {
    if (!autoupdateEnabled) return false;
    const root = installRoot();
    if (!isGitCheckout(root)) return false;
    if (shuttingDown) return false;
    ui.addLine(`* ${t('autoupdate.triggering', { version: theirs || 'latest' })}`);
    setTimeout(() => {
      selfUpdate();
    }, 200);
    return true;
  }

  function showUpdateBanner(theirs) {
    if (!updateBannerGuard.take(VERSION, theirs)) return false;
    ui.setUpdateAvailable(true);
    ui.addLine(updateBanner(VERSION, theirs, currentPeerLabel, t));
    maybeAutoUpdate(theirs);
    return true;
  }

  function listFiles() {
    const lines = fileListLines({ received, sent, dir: args.filesDir, t });
    for (const line of lines) ui.addLine(line);
    return lines.join('\n');
  }

  function openPath(target) {
    if (!target) return;
    if (fs.existsSync(secureStore.fileFor(target))) {
      if (isAudioFile(target)) {
        const child = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-i', 'pipe:0'], {
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        child.on('error', (error) => ui.addLine(`* ${t('open.failed', { error: error.message })}`));
        child.stdin.on('error', (error) => ui.addLine(`* ${t('open.failed', { error: error.message })}`));
        child.stdin.end(secureStore.read(target));
      } else if (looksLikeImage(target)) {
        const index = received.indexOf(target);
        const number = index >= 0 ? index + 1 : received.length + sent.indexOf(target) + 1;
        if (number > 0) void viewFile(String(number)).catch((error) => ui.addLine(`* ${t('open.failed', { error: error.message })}`));
      } else {
        ui.addLine('* Encrypted attachment cannot be handed to an external application without writing a plaintext copy.');
      }
      return;
    }
    if (isAudioFile(target)) {
      const child = playAudio(target);
      if (child) {
        ui.addLine(`* ▶ ${t('voice.playing')} (${path.basename(target)})`);
        // `playAudio` only picks a player it believes can decode the file, but
        // belief is not a decoder: a container it guessed wrong about exits
        // non-zero having produced silence. Handing the file to the desktop
        // then is the difference between a voice note that plays and one that
        // merely claims to have.
        let fellBack = false;
        const fallBack = () => {
          if (fellBack) return;
          fellBack = true;
          systemOpen(target);
        };
        child.on('error', fallBack);
        child.on('exit', (code) => {
          if (code !== 0) fallBack();
        });
        return;
      }
    }
    systemOpen(target);
  }

  // Hand the file to whatever the desktop, phone or shell considers its owner.
  // resolveOpenTarget only ever substitutes a converted PNG for a local,
  // existing .webp on darwin (see its own comment); every other target comes
  // back unchanged, so systemOpener's decision for it is exactly as before.
  async function systemOpen(target) {
    const resolved = await resolveOpenTarget(target);
    const opener = systemOpener(resolved);
    const child = spawn(opener.cmd, opener.args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => ui.addLine(`* ${t('open.failed', { error: err.message })}`));
    child.unref();
  }

  function openFile(arg) {
    const open = (target) => {
      openPath(target);
      return ui.addLine(`* ${t('open.opening', { name: path.basename(target) })}`);
    };
    const count = received.length + sent.length;
    // Bare /open means "the one I just looked at", and that is as often a
    // picture this side sent as one that arrived.
    if (arg === undefined || arg === null || String(arg).trim() === '') {
      return lastFile ? open(lastFile) : ui.addLine(`* ${t('open.usage', { count })}`);
    }

    const index = Number(arg);
    if (!Number.isInteger(index) || index < 1 || index > count) {
      return ui.addLine(`* ${t('open.usage', { count })}`);
    }
    // One numbering across both lists, received first, exactly as /files prints
    // them: the number under a file is the number that opens it.
    return open(index <= received.length
      ? received[index - 1]
      : sent[index - received.length - 1]);
  }

  // A picture looked at for real, not as the 36x12 transcript stamp: the kitty
  // graphics protocol draws the actual pixels over the terminal, so the view
  // takes the whole screen and the first key, mouse gesture or resize hands it
  // back. Same numbering as /open and /files — bare /view is the last file,
  // /view <n> the one /files numbers n.
  async function viewFile(arg) {
    const count = received.length + sent.length;
    let target = null;
    if (arg === undefined || arg === null || String(arg).trim() === '') {
      target = lastFile;
      if (!target) return ui.addLine(`* ${t('view.usage', { count })}`);
    } else {
      const index = Number(String(arg).trim());
      if (!Number.isInteger(index) || index < 1 || index > count) {
        return ui.addLine(`* ${t('view.usage', { count })}`);
      }
      target = index <= received.length
        ? received[index - 1]
        : sent[index - received.length - 1];
    }
    if (!looksLikeImage(target)) {
      return ui.addLine(`* ${t('view.notImage', { name: path.basename(target) })}`);
    }
    const protocol = terminalViewProtocol();
    if (!protocol) {
      return ui.addLine(`* ${t('view.notSupported')}`);
    }
    let payload;
    try {
      payload = secureStore.read(target);
    } catch {
      return ui.addLine(`* ${t('view.unreadable', { name: path.basename(target) })}`);
    }
    // Decoding happens first, on the normal screen: a phone photo through the
    // converter can take a moment, and keys typed meanwhile belong in the
    // draft. Only once the PNG is ready does the screen hand itself over.
    const columns = ui.width?.() ?? 80;
    const rows = ui.height?.() ?? 24;
    // OSC 1337 is one single escape — no chunking, so a full-res photo would
    // ride as one multi-megabyte message. The terminal only ever shows the
    // pixel box below anyway, so cap the source at twice the box: everything
    // past that is detail nobody can see.
    const maxEdge = protocol === 'iterm'
      ? Math.max(columns * 9, rows * 18) * 2
      : null;
    const png = await convertToPngBytes(payload, { maxEdge });
    const dims = pngDimensions(png);
    if (!png || !dims) {
      return ui.addLine(`* ${t('view.unreadable', { name: path.basename(target) })}`);
    }
    const name = path.basename(target);
    const close = () => {
      // Kitty placements are overlays: they survive a screen clear, so they
      // are deleted before blessed repaints over the blanked terminal. OSC
      // 1337 images are ordinary stream content and vanish with the clear.
      if (protocol === 'kitty') ui.writeRaw(KITTY_DELETE_ALL);
      ui.leaveRawView();
    };
    if (!ui.enterRawView?.(close)) {
      return ui.addLine(`* ${t('view.notSupported')}`);
    }
    ui.writeRaw('\x1b[2J\x1b[H');
    if (protocol === 'kitty') {
      const plan = kittyViewPlan(dims, { columns, rows });
      if (!plan) return ui.leaveRawView();
      for (const chunk of encodeKittyGraphics(png)) ui.writeRaw(chunk);
      ui.writeRaw(kittyPut(plan.cols));
    } else {
      const plan = itermViewPlan(dims, { columns, rows });
      if (!plan) return ui.leaveRawView();
      ui.writeRaw(itermInlineImage(png, { width: plan.width }));
    }
    ui.writeRaw(`\x1b[${rows};1H${t('view.close', { name, width: dims.width, height: dims.height })}`);
    return undefined;
  }

  // Best-effort: a picture shows as a block of colour, any other file as a small
  // card. Both are clickable, and both get a blank line above and below so they
  // sit apart from the text instead of crowding it. A missing converter or an
  // unreadable file simply means a card instead of a picture.
  async function showFilePreview(payload, file, {
    durationHint,
    afterMessageId = null,
    openWith = null,
  } = {}) {
    const themed = resolveThemed(args);
    // The wider the window, the more detail a preview can carry without ever
    // wrapping — see previewColumnsFor.
    const columns = previewColumnsFor(ui.width?.() ?? 80);
    const lines = await renderAttachmentLines(payload, file, {
      themed, durationHint, openWith, columns,
    });
    if (!lines.length) return;
    // The path goes under the card as a link: a picture says a file arrived and
    // nothing about where it went, and this is the one line that can be
    // Cmd+clicked in the terminal as well as opened by a click here.
    const link = fileLinkLine(file, { themed });
    ui.addArt(['', ...lines, ...(link ? [link] : []), ''], file, afterMessageId);
    // A click on the picture opens it — but only while the mouse is captured, and
    // it is released by default so the terminal keeps its own selection. Without
    // this line a reader clicks the first preview, nothing happens, and the
    // reasonable conclusion is that clicking is not a thing here. Said once.
    if (!clickHintShown && !ui.isMouseCaptured()) {
      clickHintShown = true;
      ui.addLine(`* ${t('file.clickHint')}`);
    }
  }

  // Cloud transport carries an image or a voice note inline on the message
  // frame itself — a base64 data URL, never a file-chunk transfer — because
  // that is the only shape a web-browser peer understands at all. Saving the
  // bytes to a real file under filesDir is what lets every other piece of
  // machinery built for a received p2p file — showFilePreview, /open, /files,
  // the click-to-open handler — serve this transport too, instead of a second
  // rendering path built just for it.
  // A voice note or picture already written to disk for this message. History
  // is replayed on every reconnect and on `/history`, and each replay used to
  // save a fresh copy, push it onto `received` and move `lastFile` — so a bare
  // `/open` reached for an old message's audio instead of the newest, and the
  // numbering shifted under the reader every time the link blipped.
  const savedInline = new Map();

  // A message's attachment being fetched right now, so a replay racing a live
  // frame (or two replays) downloads it once.
  const loadingInline = new Set();

  // `source` is a `data:` URL as it came inline, or `{mime, bytes}` fetched
  // for a reference (`attachmentSource`).
  function saveInlineAttachment(source, { prefix, fallbackExt }) {
    let mediaType;
    let payload;
    if (typeof source === 'string') {
      const parsed = parseDataUrl(source);
      if (!parsed) return null;
      mediaType = parsed.mediaType;
      try {
        payload = Buffer.from(parsed.base64, 'base64');
      } catch {
        return null;
      }
    } else if (source && Buffer.isBuffer(source.bytes)) {
      mediaType = String(source.mime ?? '').split(';')[0].trim();
      payload = source.bytes;
    } else {
      return null;
    }
    const subtype = (mediaType.split('/')[1] || fallbackExt).split('+')[0].replace(/[^a-z0-9]/gi, '');
    const ext = subtype || fallbackExt;
    if (!payload.length) return null;
    const filesDir = args.filesDir || defaultFilesDir(os.homedir());
    try {
      fs.mkdirSync(filesDir, { recursive: true });
    } catch {
      return null;
    }
    const filePath = path.join(filesDir, `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`);
    try {
      secureStore.write(filePath, payload);
    } catch {
      return null;
    }
    return { path: filePath, payload };
  }

  // The bytes behind an attachment: inline as they came, or fetched from
  // `/api/media` for a reference (docs/specs/2026-11-03-history-media-refs.md).
  // `null` when there is nothing to draw — a 410 (deleted, or evicted by the
  // conversation's media budget) quietly, any other failure with one line.
  async function attachmentSource(media, { peer, id, slot }) {
    if (typeof media?.dataUrl === 'string') return media.dataUrl;
    if (!isMediaRefShape(media) || !peer || !id || typeof cloud?.api?.media !== 'function') return null;
    try {
      return await cloud.api.media({ peer, id, slot });
    } catch (error) {
      if (error?.status !== 410) {
        ui.addLine(`* ${t('media.failed', { error: error?.code || error?.message || String(error) })}`);
      }
      return null;
    }
  }

  // Saved once per message: claimed before the download so a second caller
  // returns at once, released if nothing was saved so the next replay retries.
  async function saveMessageAttachment(media, { slot, prefix, fallbackExt, afterMessageId, peer }) {
    const key = afterMessageId ? `${slot}:${afterMessageId}` : null;
    if (key && (savedInline.has(key) || loadingInline.has(key))) return null;
    if (key) loadingInline.add(key);
    try {
      const source = await attachmentSource(media, { peer, id: afterMessageId, slot });
      const saved = saveInlineAttachment(source, { prefix, fallbackExt });
      if (saved && key) savedInline.set(key, saved.path);
      return saved;
    } finally {
      if (key) loadingInline.delete(key);
    }
  }

  async function showInlineImage(image, afterMessageId = null, peer = null) {
    const saved = await saveMessageAttachment(image, {
      slot: 'image', prefix: 'image', fallbackExt: 'jpg', afterMessageId, peer,
    });
    if (!saved) return;
    received.push(saved.path);
    lastFile = saved.path;
    await showFilePreview(saved.payload, saved.path, { afterMessageId });
  }

  async function showInlineVoice(voice, afterMessageId = null, peer = null) {
    const saved = await saveMessageAttachment(voice, {
      slot: 'voice', prefix: 'voice', fallbackExt: 'webm', afterMessageId, peer,
    });
    if (!saved) return;
    received.push(saved.path);
    lastFile = saved.path;
    const durationHint = Number.isFinite(voice?.duration) ? voice.duration : undefined;
    // The number this note answers to in `/files`, put on the card itself: a
    // waveform tells the reader a voice message arrived and nothing at all
    // about how to hear it, and one that cannot be played might as well not
    // have been sent. `/open` with no argument opens the last attachment, which
    // is this one until another arrives — the number is what keeps working
    // after that.
    await showFilePreview(saved.payload, saved.path, {
      durationHint, afterMessageId, openWith: `/open ${received.length}`,
    });
  }

  // Inline pictures and voice notes are the expensive half of opening a
  // conversation: each one is decoded, written into the files directory and
  // drawn as a preview. None of it has to happen before the text is on screen,
  // so a replayed history paints its messages in one pass and hands the
  // attachments here, one per turn of the event loop. The generation is what
  // makes switching away cheap — and correct: a preview drawn for the
  // conversation being left would land in the one just opened.
  let inlineMediaQueue = Promise.resolve();
  let inlineMediaGeneration = 0;

  function dropQueuedInlineMedia() {
    inlineMediaGeneration += 1;
  }

  function queueInlineMedia(tasks) {
    if (!Array.isArray(tasks) || tasks.length === 0) return;
    const generation = inlineMediaGeneration;
    for (const run of tasks) {
      inlineMediaQueue = inlineMediaQueue
        .then(() => new Promise((resolve) => {
          setTimeout(() => {
            if (generation !== inlineMediaGeneration) return resolve();
            return resolve(run());
          }, 0);
        }))
        .catch(() => {});
    }
  }

  // One transfer at a time. Interleaving two would not corrupt either — the
  // receiver keys chunks by id — but they would fight over the one indicator and
  // over the same socket, and a drop of five files has always gone out one after
  // another. The chain runs the next transfer whether the last one worked or not.
  let transfers = Promise.resolve();

  function queueTransfer(name, run) {
    transfers = transfers.then(run, run).catch((error) => ui.addLine(
      `* ${t('send.failed', { name, error: error?.code || error?.message || String(error) })}`,
    ));
    return transfers;
  }

  async function sendBuffer(name, payload, sourcePath = null) {
    if (!rz.isOnline()) {
      return ui.addLine(`* ${t('send.offline')}`);
    }
    // The cloud keeps messages for an absent account, deliberately not
    // transfers: a 25 MB file in a queue is a different product. So a transfer
    // waits for the other person to be there, and says so instead of streaming
    // chunks the server will drop.
    if (rz.peerOnline?.() === false) {
      return ui.addLine(`* ${t('cloud.fileNeedsPeer', { peer: currentPeerLabel })}`);
    }
    // A peer older than 0.5.0 silently drops file frames, so say so instead of
    // letting the transfer disappear.
    if (peerSupportsFiles === false) {
      return ui.addLine(
        `* ${t('send.noFileSupport', { peer: currentPeerLabel, hint: UPDATE_HINT })}`,
      );
    }
    const maxBytes = args.maxFile * 1024 * 1024;
    if (payload.length > maxBytes) {
      return ui.addLine(`* ${t('send.tooBig', { size: formatBytes(payload.length), limit: args.maxFile })}`);
    }
    const id = newMessageId();
    rz.sendFrame({
      t: 'file-offer',
      id,
      name,
      size: payload.length,
      sha256: crypto.createHash('sha256').update(payload).digest('hex'),
    });
    // 25 MB is 534 chunks and 33 MB of base64. Pushed in one loop they all land
    // in Node's write buffer in 23 ms: the event loop never gets a turn, so
    // nothing can animate, and `sent` was printed while the bytes were still
    // draining over the wire. Now the socket sets the pace — the loop waits when
    // it is full — and the indicator on the composer rule runs the whole time
    // because there are turns of the event loop for it to run in.
    ui.setSending(name);
    // Checked before every chunk, and not with `isOnline`. A peer that quits
    // sends FIN; Node ends this side too, so the socket is unwritable at once,
    // but it is not destroyed and 'close' has not run — `active` is still set,
    // `isOnline` still says yes. And on an unwritable socket `flushed()`
    // resolves inside its own constructor, so `await` yields a microtask and no
    // macrotask ever runs: the loop would spin through every remaining chunk
    // without letting 'close' fire, send `file-done` into the void, and report a
    // 20 MB file as sent when 6.9 MB of it arrived. Measured, not imagined.
    const lost = () => ui.addLine(`* ${t('send.lost', { name })}`);
    try {
      let seq = 0;
      for (const chunk of chunkFile(payload)) {
        if (!rz.writable()) return lost();
        if (!rz.writeFrame({ t: 'file-chunk', id, seq: seq++, data: chunk.toString('base64') })) {
          await rz.flushed();
        }
      }
      if (!rz.writable()) return lost();
      rz.sendFrame({ t: 'file-done', id });
      // The last word on a transfer is that the bytes have left, not that they
      // were handed to a buffer — and that the channel was still there to take
      // them when they did.
      await rz.flushed();
      if (!rz.writable()) return lost();
    } finally {
      ui.setSending(null);
    }
    if (sourcePath) {
      sent.push(sourcePath);
      lastFile = sourcePath;
    }
    showFilePreview(payload, sourcePath ?? name).catch(() => {});
    return ui.addLine(`* ${t('send.done', { name, size: formatBytes(payload.length) })}`);
  }

  function sendFile(rawPath) {
    if (!rawPath) return ui.addLine(`* ${t('send.usage')}`);
    // A path dragged onto `/send ` is escaped exactly like one dropped into an
    // empty composer, so both go through the same resolution.
    const fileExists = (candidate) => {
      try {
        const file = expandHome(candidate);
        return fs.statSync(fs.existsSync(file) ? file : secureStore.fileFor(file)).isFile();
      } catch {
        return false;
      }
    };
    const resolved = expandHome(resolvePastedPath(rawPath, fileExists) ?? rawPath);
    let payload;
    try {
      payload = fs.existsSync(secureStore.fileFor(resolved)) ? secureStore.read(resolved) : fs.readFileSync(resolved);
    } catch (err) {
      return ui.addLine(`* ${t('send.unreadable', { path: resolved, error: err.code || err.message })}`);
    }
    const name = path.basename(resolved);
    return queueTransfer(name, () => sendBuffer(name, payload, resolved));
  }

  // A cloud peer — including a web-browser client, which never speaks the
  // file-chunk protocol at all — receives an image the same way it receives
  // one: inline on the message frame, as the base64 data URL the web client
  // itself sends. Sending both would be a second copy of the same picture
  // landing in the SAME cloud-native peer's transcript, so this replaces the
  // file-chunk transfer for cloud instead of adding to it; p2p is untouched.
  async function sendInlineAttachment(filePath, name, buildFrame) {
    if (!rz.isOnline()) {
      return ui.addLine(`* ${t('send.offlineShort')}`);
    }
    let payload;
    try {
      payload = fs.existsSync(secureStore.fileFor(filePath)) ? secureStore.read(filePath) : fs.readFileSync(filePath);
    } catch (err) {
      return ui.addLine(`* ${t('send.unreadable', { path: filePath, error: err.code || err.message })}`);
    }
    const frame = await buildFrame(payload);
    // The cloud frame ceiling, not MAX_MESSAGE_CHARS: that one is the p2p
    // 255 KiB limit, and measuring inline media against it refused every
    // recording longer than a few seconds — the very media this cloud-only
    // path exists to send.
    if (JSON.stringify(frame).length > CLOUD_FRAME_MAX_CHARS) {
      return ui.addLine(`* ${t('send.cloudTooBig', { size: formatBytes(payload.length) })}`);
    }
    // On the core a picture or a voice note is a sealed action, never an open
    // frame: its row comes back from the store, as any message the core holds.
    const sealed = cloudSession?.isCore && onCloudTransport() && rz.canSealed();
    const handed = sealed
      ? rz.sendWith(frame.text, { image: frame.image, voice: frame.voice }, frame.id) !== null
      : rz.sendFrame(frame);
    if (!handed) {
      return ui.addLine(`* ${t('send.failed', { name, error: t('send.offline') })}`);
    }
    sent.push(filePath);
    lastFile = filePath;
    showFilePreview(payload, filePath).catch(() => {});
    return ui.addLine(`* ${t('send.done', { name, size: formatBytes(payload.length) })}`);
  }

  // A sealed picture or voice note always carries words: the core refuses an
  // empty message, and a client that predates the attachment shows only the
  // caption. The classic frame keeps its empty text exactly as it was.
  const coreCaption = (key, params) => (
    cloudSession?.isCore && onCloudTransport() && rz.canSealed() ? t(key, params) : ''
  );
  const voiceClock = (seconds) => {
    const whole = Math.max(0, Math.round(Number(seconds) || 0));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  };

  async function sendInlineImage(filePath, name) {
    return sendInlineAttachment(filePath, name, async (payload) => {
      const image = await decodeImage(payload).catch(() => null);
      const dataUrl = `data:image/png;base64,${payload.toString('base64')}`;
      return {
        t: 'msg', id: newMessageId(), ts: Date.now(), text: coreCaption('send.imageCaption'),
        image: { dataUrl, width: image?.width ?? 0, height: image?.height ?? 0 },
      };
    });
  }

  async function sendInlineVoice(filePath, name, durationSec) {
    return sendInlineAttachment(filePath, name, async (payload) => ({
      t: 'msg', id: newMessageId(), ts: Date.now(),
      text: coreCaption('send.voiceCaption', { duration: voiceClock(durationSec) }),
      voice: { dataUrl: `data:audio/wav;base64,${payload.toString('base64')}`, duration: durationSec },
    }));
  }

  async function sendClipboardImage() {
    if (!rz.isOnline()) {
      return ui.addLine(`* ${t('send.offlineShort')}`);
    }
    const shot = await readSecureClipboardImage({ dir: args.filesDir, store: secureStore });
    if (!shot) {
      return ui.addLine(`* ${t('send.noImage')}`);
    }
    // Kept, not deleted: the preview this paste draws must still open when it is
    // clicked, and that needs a real path on disk.
    const name = path.basename(shot.path);
    return isCloudPeer
      ? queueTransfer(name, () => sendInlineImage(shot.path, name))
      : queueTransfer(name, () => sendBuffer(name, secureStore.read(shot.path), shot.path));
  }

  // One seam, two transports. Everything below this point — receipts, files,
  // typing, presence, the outbox, the AI — talks to the same events and the same
  // methods, which is why the cloud costs no second copy of the client.
  let activeTransport = null;
  let cloudSession = null;
  let p2pSession = null;

  // The CLI carries one conversation per session, so "the active peer" is
  // enough to gate the whole transport: cloud uses its login, p2p whatever
  // login the roster or the selector resolved to. Used both to refuse
  // outgoing sends (the facade below) and to drop incoming frames from a
  // peer this account has blocked (see the message/sync-outgoing/ai handlers).
  const activePeerLogin = () => (isCloudPeer ? cloud?.peer : (peerLogin || args.peer));
  const isPeerBlocked = () => {
    const login = activePeerLogin();
    return login ? isBlocked(stateDir, login) : false;
  };
  const rz = createRzFacade(() => activeTransport, {
    stopP2p: () => p2pSession?.stop?.(),
    stopCloud: () => cloudSession?.stop?.(),
    switchCloudPeer: (newP, newL) => cloudSession?.switchPeer?.(newP, newL),
    isBlocked: isPeerBlocked,
    receiptTransport: () => isCloudPeer ? cloudSession : activeTransport,
  });

  function setActiveTransport(transport) {
    activeTransport = transport;
  }

  // Whether this conversation is currently being carried by the relay. Not the
  // same question as `isCloudPeer`, which only says how the peer was addressed:
  // a peer dialled by name can still end up on the cloud after a p2p fallback.
  function onCloudTransport() {
    return Boolean(cloudSession) && activeTransport === cloudSession;
  }

  function forwardEvents(transport, isCloud) {
    const forwardedEvents = [
      'bye', 'unresolved', 'port-taken', 'inbound',
      'file-offer', 'file-chunk', 'file-done', 'file-deny', 'file-refuse', 'file-progress', 'file-abort',
      'took-over', 'status', 'online', 'offline', 'typing', 'focus', 'wake', 'logo', 'holiday',
      'message', 'msg', 'ai', 'ack', 'read', 'del', 'edit', 'react', 'read-sync', 'read-accepted', 'receipt', 'error', 'unread', 'users', 'sync-outgoing', 'reaching', 'present', 'caps', 'update', 'devices', 'ping', 'pong',
      // Only the native-core transport (core-link.js) ever emits these.
      'core-stored', 'core-removed', 'core-refused', 'core-held',
      'core-device-registered', 'core-device-keys-conflict', 'core-sas-started', 'core-sas-code-ready', 'core-sas-cancelled', 'core-device-verified', 'core-safety-code', 'core-key-changed',
      'core-unverified-device', 'core-backup-created', 'core-backup-info', 'core-backup-restored', 'core-bad-frame',
      'core-cross-signing-reset', 'core-cross-signing-reset-failed',
    ];
    for (const evName of forwardedEvents) {
      transport.on(evName, (payload) => {
        if (isCloud && activeTransport !== transport) {
          if (evName === 'unread' || evName === 'read-sync' || evName === 'users') rz.emit(evName, payload);
          return;
        }
        if (activeTransport === transport) {
          rz.emit(evName, payload);
        }
      });
    }
  }

  // The cloud transport: the classic link, or — under TAILCHAT_CORE=1 — the same
  // link on the native core. Anything that stops the core from opening (module
  // not built, store locked by another tailchat, unusable key) is one line and
  // the classic transport, never a terminal that cannot start.
  function openCloudSession(targetPeer, targetLabel) {
    const options = {
      url: cloud.socketUrl,
      token: cloud.token,
      name: args.name,
      peer: targetPeer,
      peerLabel: targetLabel,
    };
    if (!coreRequested()) return startCloudSession(options);
    // The subkey exists only for the native side, which copies it: wiped here
    // whether the core opened or not.
    let key = null;
    try {
      key = secureStore.deriveKey(CORE_KEY_INFO);
      const session = startCoreCloudSession({
        ...options,
        login: cloud.self.login,
        dbPath: coreDbPath(stateDir, cloud.self.login),
        key,
        native: loadNativeCore(),
      });
      notice(t('core.active'));
      if (session.retiredStore) notice(t('core.storeRetired', { file: session.retiredStore }));
      return session;
    } catch (error) {
      notice(t('core.fallback', { reason: describeCoreError(error) }));
      return startCloudSession(options);
    } finally {
      key?.fill(0);
    }
  }

  function startOrSwitchCloudSession(targetPeer, targetLabel) {
    if (!cloudSession && cloud) {
      cloudSession = openCloudSession(targetPeer, targetLabel);
      forwardEvents(cloudSession, true);
    } else if (cloudSession && targetPeer) {
      cloudSession.switchPeer(targetPeer, targetLabel);
    }
    return cloudSession;
  }

  function startP2pSession(pHost, pPort, pTargets) {
    if (p2pSession) {
      try { p2pSession.stop?.(); } catch {}
      p2pSession.removeAllListeners?.();
      p2pSession = null;
    }
    const effTargets = (Array.isArray(pTargets) && pTargets.length > 0)
      ? pTargets
      : computePeerTargets(pHost, peerLogin, memory);
    p2pSession = startRendezvous({
      peerHost: pHost,
      peerPort: pPort,
      peerTargets: effTargets,
      bindAddr,
      port: args.port,
      name: args.name,
      resolveAllowed: identity.login
        ? async () => (await resolvePeerIdentity(args.peer, tsCli)).devices.flatMap((d) => d.ips)
        : (peerLogin
          ? async () => rosterAddresses(lookupRoster(stateDir, peerLogin, selfIdentity))
          : null),
      verifyInbound: tsAuthority
        ? async (ip) => {
            const want = peerLogin ?? (looksLikeIp(pHost) ? (await whois(pHost))?.login : null);
            return want ? (await whois(ip))?.login === want : false;
          }
        : null,
    });
    forwardEvents(p2pSession, false);
    return p2pSession;
  }

  if (cloud) {
    cloudSession = startOrSwitchCloudSession(isCloudPeer ? cloud.peer : null, isCloudPeer ? cloud.peerName : null);
  }
  if (isCloudPeer) {
    setActiveTransport(cloudSession);
    if (cloud?.peer) {
      scheduleMarkRead(cloud.peer);
    }
  } else {
    p2pSession = startP2pSession(peerHost, peerPort);
    setActiveTransport(p2pSession);
  }
  rz.on('bye', ({ reason }) => {
    if (reason !== 'replaced') return;
    ui.setStatus('offline');
    ui.setPeerPresence(null);
    ui.addLine(`* ${t('session.takenOver')}`);
    ui.addLine(`* ${t('session.stillReadable')}`);
  });
  // Once per session: the same two lines every retry round would bury the
  // transcript under a fact that does not change until the person acts on it.
  let unresolvedSaid = false;
  rz.on('unresolved', ({ peer }) => {
    if (unresolvedSaid) return;
    unresolvedSaid = true;
    ui.addLine(`* ${t('peer.unresolved', { peer })}`);
    ui.addLine(`* ${t('peer.unresolvedHint')}`);
    // The one case where the hint above is not enough: a login can only be
    // resolved by the daemon, and here there is none to ask.
    if (!looksLikeIp(peer) && !tsAuthority) ui.addLine(`* ${t('peer.needsAddress')}`);
  });
  // Who holds the port and what that means for us. Read fresh on every call: the
  // holder can change while we wait, and judging on a stale reading is how a
  // dead pid ends up in the remedy we print.
  function assessPort(taken) {
    const holderPid = readListenerPid(stateDir, taken);
    return {
      holderPid,
      verdict: lockVerdict({
        holderPid,
        holderPeer: readListenerPeer(stateDir, taken),
        myPeer: peerKey,
      }),
    };
  }
  rz.on('port-taken', ({ port: taken }) => {
    // Keyed on the conversation, not the port: a chat with a different peer has
    // nothing to fight over, and a holder of THIS conversation is simply stale.
    const { holderPid: holder, verdict } = assessPort(taken);
    if (verdict === 'coexist') {
      ui.addLine(`* ${t('port.coexist', { port: taken })}`);
      ui.addLine(`* ${t('port.coexistHint')}`);
      return; // keep dialling: one connection carries both directions
    }
    if (verdict === 'takeover') {
      ui.addLine(`* ${t('port.takingOver', { pid: holder })}`);
      // SIGTERM only, and only a pid our own note vouched for. The listener is
      // already retrying every second, so it takes the port on its own.
      try {
        process.kill(holder, 'SIGTERM');
      } catch { /* it exited between the read and the signal */ }
      const timer = setTimeout(() => {
        if (rz.boundPort()) return; // it let go and the port is ours now
        // The holder can have changed while we waited: the instance we signalled
        // may be gone and a client of ANOTHER conversation may own the port now.
        // Judging on the old reading stood us down for nothing and named a pid
        // that no longer holds anything.
        const now = assessPort(taken);
        if (now.verdict === 'coexist') {
          ui.addLine(`* ${t('port.coexist', { port: taken })}`);
          ui.addLine(`* ${t('port.coexistHint')}`);
          return; // nothing to fight over, so keep dialling
        }
        if (now.verdict === 'free') return; // not ours to explain; the retry goes on
        ui.addLine(`* ${t('port.takeoverFailed', { pid: now.holderPid })}`);
        ui.addLine(`* ${t('port.howToFree', { pid: now.holderPid })}`);
        ui.addLine(`* ${t('port.standDown')}`);
        ui.setStatus('offline');
        rz.standDown();
      }, TAKEOVER_MS);
      timer.unref?.();
      return;
    }
    if (verdict === 'stand-down') {
      // An older holder left a pid and no conversation, so it cannot be named.
      ui.addLine(`* ${t('port.heldBy', { port: taken, pid: holder })}`);
      ui.addLine(`* ${t('port.howToFree', { pid: holder })}`);
      // Keep quiet on the wire as well. A second client that cannot listen can
      // still dial, and then the peer's channel flaps between the two of us —
      // which reads as "it does not connect" on both ends.
      ui.addLine(`* ${t('port.standDown')}`);
      ui.setStatus('offline');
      rz.standDown();
      return;
    }
    ui.addLine(`* ${t('port.taken', { port: taken })}`);
    ui.addLine(`* ${t('port.takenHint')}`);
  });
  rz.on('inbound', async ({ ip }) => {
    if (!identity.login) return;
    const seen = await whois(ip);
    memory.remember({ host: seen?.node ?? ip, address: ip });
  });
  rz.on('file-offer', (frame) => {
    const result = receiver.offer(frame);
    if (!result.accepted) {
      rz.sendFrame({ t: 'file-deny', id: frame.id, reason: result.reason });
      ui.addLine(`* ${t('file.refused', { reason: result.reason })}`);
      return;
    }
    ui.addLine(`* ${t('file.incoming', { name: result.name, size: formatBytes(frame.size) })}`);
  });
  rz.on('file-chunk', (frame) => {
    const result = receiver.chunk(frame);
    if (!result.ok) ui.addLine(`* ${t('file.aborted', { reason: result.reason })}`);
  });
  rz.on('file-done', (frame) => {
    const result = receiver.done(frame);
    if (!result.ok) {
      ui.addLine(`* ${t('file.failed', { reason: result.reason })}`);
      return;
    }
    received.push(result.path);
    lastFile = result.path;
    ui.addLine(`* ${t('file.received', { index: received.length, name: path.basename(result.path), size: formatBytes(result.size) })}`);
    if (looksLikeImage(result.path) || isAudioFile(result.path)) {
      Promise.resolve().then(() => secureStore.read(result.path))
        .then((data) => showFilePreview(data, result.path))
        .catch((error) => notice(`Attachment preview failed: ${error.message}`));
    } else {
      showFilePreview(null, result.path);
    }
    if (!ui.isFocused()) {
      notifyIfUnfocused({
        focused: false,
        notifier: gatedNotifier,
        name: currentPeerLabel,
        text: `файл: ${path.basename(result.path)}`,
      });
    }
  });
  rz.on('file-deny', (frame) => {
    ui.addLine(`* ${t('file.peerRefused', { reason: frame.reason || t('file.noReason') })}`);
  });


  let shuttingDown = false;
  let listenerPort = null;
  // Every step is attempted whatever the one before it did. The order matters —
  // drop the note first so a crashing teardown cannot leave it, tear the screen
  // down last so its message survives longest — but a throw part-way through
  // used to skip `ui.destroy()` and hand back a console nobody could type into,
  // which is a worse outcome than any of the failures being reported.
  function releaseSession() {
    const steps = [
      () => { if (listenerPort) clearListenerPid(stateDir, listenerPort); },
      () => { if (lanDiscovery) lanDiscovery.close(); },
      () => rz.stop(),
      () => typing.destroy(),
      () => presence.destroy(),
      () => reminders.destroy(),
      () => { if (pausedPm2App) resumePm2Daemon(pausedPm2App); },
      () => ui.destroy(),
    ];
    for (const step of steps) {
      try {
        step();
      } catch {
        // Nothing here has anywhere left to report to; the next step matters more.
      }
    }
  }
  // A stream that never drains — a filled disk, a vanished network share — used
  // to leave the process alive after the screen had already been handed back,
  // with no key left to press. The flush is worth waiting for, but not forever.
  const FLUSH_GRACE_MS = 2000;
  function closeAndExit(code, next = () => process.exit(code)) {
    const forced = setTimeout(() => process.exit(code), FLUSH_GRACE_MS);
    try {
      log.close(() => {
        clearTimeout(forced);
        next();
      });
    } catch {
      clearTimeout(forced);
      next();
    }
  }
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    releaseSession();
    closeAndExit(0);
  }
  function restartClient() {
    if (shuttingDown) return undefined;
    shuttingDown = true;
    releaseSession();
    const supervised = isSupervised();
    process.stdout.write(`\n${t(supervised ? 'restart.supervised' : 'restart.relaunching')}\n`);
    return closeAndExit(0, () => leaveAndRestart({
      tooDeep: 'restart.tooDeep',
      relaunchFailed: 'restart.relaunchFailed',
    }));
  }


  // Read once: the list changes rarely, and a status call per reconnect would be
  // a spawn per second on a flapping link.
  let ownDevices = null;
  async function announceOwnDevices() {
    try {
      if (!ownDevices) {
        const status = parseStatus(await runTailscale(tsCli, ['status', '--json']));
        const login = status?.self?.login;
        if (!login) return;
        ownDevices = { login, devices: ownDeviceList(status) };
      }
      if (ownDevices.devices.length > 0) rz.sendFrame({ t: 'devices', ...ownDevices, name: args.name });
    } catch {
      // No CLI or no answer: the peer simply keeps using addresses.
    }
  }

  function showVersion() {
    const lines = [`* ${t('version.mine', { mine: VERSION, root: installRoot() })}`];
    if (!lastPeerVersion) {
      lines.push(`* ${t('version.peerUnknown')}`);
    } else {
      lines.push(`* ${t('version.peer', { peer: currentPeerLabel, theirs: lastPeerVersion })}`);
      // Capability, not just version: the one-off startup line scrolls away,
      // and then nothing on screen answers "does presence work right now".
      const state = (value) => (value === null ? t('state.unknown') : t(value ? 'state.yes' : 'state.no'));
      lines.push(`* ${t('version.focusMine', { state: state(ui.focusTracked()) })}`);
      lines.push(`* ${t('version.focusPeer', { peer: currentPeerLabel, state: state(peerFocus) })}`);
      // Same reasoning as the connect banner: a web peer reports `web`, not a
      // number, so it is neither ahead nor behind and there is nothing to say.
      if (!isWebVersion(lastPeerVersion)) {
        const notice = versionNotice(VERSION, lastPeerVersion, currentPeerLabel, t);
        lines.push(notice ?? `* ${t('version.same')}`);
      }
    }
    for (const line of lines) ui.addLine(line);
    return lines.join('\n');
  }
  // /changelog is self-contained. `latest` additionally asks the optional OVH
  // manifest after local output is already visible; offline is indistinguishable
  // from an older client, never an error that hides the installed history.
  function showChangelog(arg) {
    const wantsLatest = String(arg ?? '').trim().toLowerCase() === 'latest';
    const text = readChangelog(wantsLatest ? '' : arg);
    for (const line of text.split('\n')) ui.addLine(line);
    if (wantsLatest) {
      void sharedHistory.latestRelease().then((release) => {
        if (!release || release.version === VERSION) return;
        ui.addSection(`OVH latest v${release.version}`, release.notes.split('\n'));
      });
    }
    return text;
  }
  function showDiagnostics() {
    const target = rz.target();
    const state = rz.isOnline()
      ? t('diagnose.connected')
      : t(rz.isDialling() ? 'diagnose.reconnecting' : 'diagnose.standingDown');
    ui.addLine(`* ${t('diagnose.connection', {
      state, peer: currentPeerLabel, host: target.host, port: target.port,
    })}`);
    ui.addLine(`* ${t('diagnose.listener', {
      port: rz.boundPort() ?? t('diagnose.notListening'),
      queued: outbox.size(),
    })}`);
    // Half of "it will not connect" is the tailnet, and the first thing worth
    // knowing is whether this machine has the CLI to ask at all.
    ui.addLine(`* ${tsCli ? t('diagnose.tailscaleCli', { path: tsCli }) : t('diagnose.noTailscaleCli')}`);
    ui.addLine(`* ${t('diagnose.netHint')}`);
    return aiStatus();
  }

  // The tailnet side of the same question, which used to mean leaving the
  // client for a shell: who this machine is on the tailnet, how many peers it
  // can see, which route the current conversation actually takes, and the
  // addresses another machine could dial it on. Read-only throughout — the CLI
  // is asked for its status and the interfaces are read, nothing is set.
  async function showNetwork() {
    const lines = [];
    const say = (line) => {
      lines.push(`* ${line}`);
      ui.addLine(`* ${line}`);
    };
    say(tsCli ? t('net.cli', { path: tsCli }) : t('net.noCli'));
    if (tsCli) {
      let status = null;
      try {
        status = parseStatus(await runTailscale(tsCli, ['status', '--json']));
      } catch (err) {
        say(t('net.statusFailed', { error: err.code || err.message }));
      }
      if (status) {
        say(t('net.self', {
          host: status.self.dnsName || status.self.host || '?',
          login: status.self.login ?? '?',
          ips: (status.self.ips ?? []).join(', ') || '?',
        }));
        say(t('net.peers', {
          online: status.peers.filter((peer) => peer.online).length,
          total: status.peers.length,
        }));
        if (peerHere && !onCloudTransport()) {
          const socket = rz.activeSocket();
          say(t('net.route', {
            peer: currentPeerLabel,
            route: formatRoute(inspectPeerRoute(status, peerHost, socket?.remoteAddress), t),
          }));
        }
      }
    }
    // The addresses a peer could actually dial. A client bound to one interface
    // and a peer that cannot see it is most connection trouble there is.
    const local = Object.entries(os.networkInterfaces())
      .flatMap(([name, addrs]) => (addrs ?? [])
        .filter((addr) => addr.family === 'IPv4' && !addr.internal)
        .map((addr) => `${name} ${addr.address}`));
    say(t('net.interfaces', { list: local.join(', ') || t('net.noInterfaces') }));
    return lines.join('\n');
  }

  function reconnectPeer() {
    if (!rz.reconnect()) return ui.addLine(`* ${t('reconnect.unavailable')}`);
    return ui.addLine(`* ${t('reconnect.requested', { peer: currentPeerLabel })}`);
  }


  // Closes the interface first: git and npm write to the same terminal, and a
  // half-torn TUI over their output is unreadable.
  function selfUpdate() {
    const root = installRoot();
    if (!isGitCheckout(root)) {
      return ui.addLine(`* ${t('update.notCheckout', { root })}`);
    }
    ui.addLine(`* ${t('update.running', { root })}`);
    ui.addLine(localUpdateBanner({ root, version: VERSION, t }));
    if (shuttingDown) return undefined;
    shuttingDown = true;
    releaseSession();
    const result = runUpdate({ root });
    // The interface is already gone, so these go to the plain terminal — which
    // is the only place left, and the right one: a failed update is read after
    // the fact, on a shell prompt, by someone deciding what to do next.
    for (const line of updateNotices(result, t)) process.stdout.write(`${line}\n`);
    if (!result.ok) {
      process.stdout.write(`\n${t('update.failed', { reason: result.reason })}\n`);
      return closeAndExit(1);
    }
    const supervised = isSupervised();
    process.stdout.write(`\n${t(supervised ? 'update.supervisedRestart' : 'update.relaunching')}\n`);
    // Under bin/tailchat.js the wrapper is already waiting to start the new
    // version, so we spawn nothing and simply leave with the restart code.
    // Unsupervised, the new version runs as a child with the arguments this
    // session was started with, so the peer and the flags survive the upgrade.
    return closeAndExit(0, leaveAndRestart);
  }

  // /peer: change the conversation smoothly in-place without restarting the
  // window. The caller never awaits this, and the work underneath is not
  // re-entrant, so requests are queued rather than started on top of each
  // other; see `switchChain`.
  function switchActiveConversation(nextPeer, { transport = 'auto' } = {}) {
    if (!nextPeer) return switchChain;
    switchQueued = { peer: nextPeer, transport };
    switchChain = switchChain.then(() => {
      const queued = switchQueued;
      switchQueued = null;
      // Superseded while it waited: a later request already took its turn.
      if (!queued) return undefined;
      return applyConversationSwitch(queued.peer, queued.transport);
    }).catch((error) => {
      notice(`switch failed: ${error?.message ?? 'error'}`);
    });
    return switchChain;
  }

  async function applyConversationSwitch(nextPeer, transport) {
    // Claimed before the first await: every detached promise that paints the
    // transcript compares against this, so anything still in flight for the
    // conversation being left stops being allowed to draw from here on.
    conversationEpoch += 1;
    // Same reasoning for the attachments still queued for it: their previews
    // belong to the conversation being left, and drawing one into the thread
    // just opened would be a picture of the wrong conversation.
    dropQueuedInlineMedia();
    let cleanPeer = String(nextPeer).trim();
    let explicitCloud = transport === 'cloud';
    if (cleanPeer.startsWith('@')) {
      explicitCloud = true;
      cleanPeer = cleanPeer.slice(1);
    }

    // 1. Resolve whether nextPeer is a Cloud peer or Tailscale/LAN peer.
    // `/p2p` is a strict transport choice: an unresolved selector must not
    // silently turn into a cloud conversation with the same display name.
    let newIsCloudPeer = false;
    let newCloudFriend = null;
    let newCloudPeer = null;
    let newCloudPeerName = null;
    if (cloud && transport !== 'p2p') {
      const resolved = resolveCloudPeerSync(cleanPeer, {
        explicitCloud: explicitCloud || Boolean(args.cloud),
        cloudUsers: cloud.users || [],
        selfLogin: cloud.self?.login || null,
      });
      newCloudFriend = resolved.cloudFriend;
      if (resolved.isCloudPeer) {
        newIsCloudPeer = true;
        newCloudPeer = resolved.peer;
        newCloudPeerName = resolved.peerName;
      }
    }

    let newIdentity = (newIsCloudPeer || args.cloud || (cloud && transport !== 'p2p' && !looksLikeIp(cleanPeer)))
      ? { login: null, devices: [], cliOk: false }
      : (tsCli ? await resolvePeerIdentity(cleanPeer, tsCli) : { login: null, devices: [], cliOk: false });

    if (!newIsCloudPeer && transport !== 'p2p' && cloud && !newIdentity.login && !looksLikeIp(cleanPeer)) {
      newIsCloudPeer = true;
      newCloudPeer = newCloudFriend ? newCloudFriend.login : cleanPeer;
      newCloudPeerName = newCloudFriend?.name || newCloudPeer;
      newIdentity = { login: null, devices: [], cliOk: false };
    }

    // 2. Detach the old active path before conversation-global state changes.
    // Cloud sessions retain only their unread path while inactive; every
    // message handler is gated by activeTransport.
    setActiveTransport(null);
    if (p2pSession) {
      try { p2pSession.stop?.(); } catch {}
      p2pSession.removeAllListeners?.();
      p2pSession = null;
    }
    // The relay counts this connection as an active viewer of the conversation
    // being left until it is told otherwise, so everything that peer says
    // during the switch is routed here as live traffic — and dropped, because
    // the transport carrying it is no longer the active one. Unsubscribing
    // first makes the hub queue those messages instead and push their unread
    // count; step 8 subscribes to whatever the new conversation turns out to
    // be. Without it, switching away from a cloud peer to a direct one lost
    // every message they sent afterwards outright: never shown, never queued,
    // no badge.
    log.close(() => {});

    if (newIsCloudPeer && cloud) {
      cloud.peer = newCloudPeer;
      cloud.peerName = newCloudPeerName;
    }

    // 3. Cancel any pending read timer and active promotion timer for the previous conversation.
    cancelPendingRead();
    cancelActivePromotion();

    // 4. Update conversation state BEFORE updating the roster bar, so updateRosterBar
    // evaluates the new peer as active, not the previous one.
    args.peer = cleanPeer;
    isCloudPeer = newIsCloudPeer;
    identity = newIdentity;
    updateUnreadHeader();
    scheduleMarkRead(newCloudPeer || cleanPeer);
    scheduleActivePromotion(newCloudPeer || cleanPeer);

    const newSelfIdentity = { login: await selfLogin(), ips: ownIps };
    const newRemembered = identity.login ? null : lookupRoster(stateDir, args.peer, newSelfIdentity);
    const newPeerLogin = identity.login ?? newRemembered?.login ?? null;
    selfIdentity = newSelfIdentity;
    peerLogin = newPeerLogin;
    peerKey = computePeerKey({
      isCloudPeer,
      cloudLogin: cloud?.peer,
      peerLogin: newPeerLogin,
      selector: args.peer,
      linkedCloudLogin: !isCloudPeer && newPeerLogin ? resolveLinkedCloudLogin(stateDir, newPeerLogin) : null,
    });
    memory = createPeerMemory({ dir: stateDir, key: peerKey });

    for (const [, { timer }] of pendingPings) clearTimeout(timer);
    pendingPings.clear();
    peerFocus = null;
    peerFocusReported = false;
    lastPeerVersion = null;
    seenPeerVersion = null;
    lastPeerName = '';
    lastDevice = '';
    hiddenDeviceReported = false;
    everConnected = false;
    peerHasAi = false;
    peerAiMuted = false;
    peerSupportsAi = null;
    // Files too: what the previous conversation's peer announced says nothing
    // about this one, and a stale false refused every transfer with "they need
    // 0.5.0" — the exact gate the flag exists for, aimed at the wrong person.
    peerSupportsFiles = null;
    peerSupportsLogo = null;
    peerSupportsHoliday = null;
    peerHere = false;
    unresolvedSaid = false;
    sessionOnlineTs = null;
    sentMessageCount = 0;
    receivedMessageCount = 0;
    lastPeerMessage = null;
    unread.clear();
    receiver.abortAll();

    // 5. Update UI labels and status.
    currentPeerLabel = resolveDisplayLabel(null);
    ui.clear();
    ui.setPeerName(currentPeerLabel);
    ui.setTransport(isCloudPeer ? 'cloud' : 'p2p');
    ui.setStatus('connecting…');
    ui.clearPeerTyping();
    ui.setPeerPresence(null);

    // 6. Resolve the next direct target without starting its transport.
    let nextPeerTargets = null;
    if (!isCloudPeer) {
      nextPeerTargets = computePeerTargets(cleanPeer, newPeerLogin, memory);
      const target = nextPeerTargets[0] || { host: cleanPeer, port: args.port || 49878 };
      peerHost = target.host;
      peerPort = target.port;
    }

    // 7. Open the new conversation's persistence before it can receive frames.
    logFile = resolveLogFile({
      logFlag: args.log, noLogFlag: args.noLog, configLog: logPreference,
      stateDir, peerKey,
    });
    log = createLog(logFile, {
      store: secureStore,
      onError: (error) => notice(t('log.writeFailed', { error: error.message })),
    });
    // Another conversation, another file: what the previous one already held
    // says nothing about this one.
    logMirror = null;

    outbox = getPersistentOutbox(isCloudPeer ? `cloud-${cloud.peer}` : `${peerHost}:${peerPort}`);

    // 8. Start only after the correct log and outbox are ready.
    if (isCloudPeer) {
      const cs = startOrSwitchCloudSession(cloud.peer, cloud.peerName);
      setActiveTransport(cs);
      ui.setStatus(cs?.peerOnline() ? 'online' : 'connecting…');
    } else {
      const ps = startP2pSession(peerHost, peerPort, nextPeerTargets);
      setActiveTransport(ps);
      ui.setStatus('connecting…');
    }

    // 9. Print header banner & recent history from disk
    // In cloud mode the account is the identity; the hostname is just the
    // machine it runs on, and `cloud.signedInAs` is already on screen from
    // the pre-UI notice, so it is not repeated here.
    const displayName = isCloudPeer ? (cloud.self.name || cloud.self.login) : args.name;
    const displayPeerHost = isCloudPeer ? `@${cloud.peer}` : peerHost;
    const displayPeerPort = isCloudPeer ? null : peerPort;
    ui.addLine(formatGreeting({
      name: displayName, peerHost: displayPeerHost, peerPort: displayPeerPort, bindAddr: bindAddr || 'cloud', t,
    }));
    ui.addLine(`* ${t('help.hint')}`);

    // The dim, flat-colour preview only ever ran here; a Cloud peer gets a
    // properly coloured replay straight from the server just below, so this
    // local pass is skipped for it — otherwise the same messages would print
    // twice, once dim then once coloured.
    if (!isCloudPeer) previewSwitchHistory();

    replayCloudHistory();

    paintBand();
  }

  // The relay's copy of the open conversation, painted into the transcript.
  // Both callers — startup and every /peer switch — leave it running as a
  // detached promise, so it can land after the reader has already moved to
  // another thread. The epoch it captures is what stops the previous
  // conversation's history from being printed into the current one, appended
  // to that peer's log file and quoted back to the assistant as their words.
  function renderCloudMessages(cloudMessages, forPeer) {
    if (!Array.isArray(cloudMessages) || cloudMessages.length === 0) return 0;
    const batch = [];
    const attachments = [];
    for (const cm of cloudMessages) {
      if (cm.sealedEdit === true) continue; // an edit's carrier, not a message
      if (cm.deletedAt) {
        ui.removeMessages([cm.id]);
        unread.delete(cm.id);
        if (showDeletedMessages && !deletedHistoryIds.has(cm.id)) ui.addLine(`* ${t('del.marker')}`);
        deletedHistoryIds.add(cm.id);
        continue;
      }
      const peerEntry = (cloud?.users ?? []).find(
        (u) => String(u?.login ?? '').toLowerCase() === String(forPeer ?? '').toLowerCase(),
      );
      const { bot, isSelf, senderName } = resolveCloudHistorySender(cm, {
        selfLogin: cloud.self?.login,
        selfName: args.name || cloud.self?.name || cloud.self?.login,
        // The account's own nickname for the thread being drawn wins over the
        // name the peer chose, exactly as the live header does (issue #28).
        peerName: peerEntry?.alias || peerEntry?.name || cloud.peerName,
        peer: forPeer,
      });
      batch.push({
        id: cm.id,
        name: senderName,
        text: cm.text,
        ts: cm.ts,
        self: isSelf,
        bot,
        marker: isSelf ? (cm.marker || '✓') : null,
        markerRead: Boolean(cm.markerRead),
        reactions: cm.reactions,
        replyTo: cm.replyTo,
        media: messageMediaKind(cm.image, cm.voice),
        edited: Boolean(cm.editedAt),
      });
      if (!isSelf && !bot && cm.id && cm.ts > (ownReadWatermarks.get(forPeer) || 0)) {
        unread.set(cm.id, cm.ts);
      }
      if (!cm.id || !ui.messageById(cm.id)) {
        mirrorReplayedLine(formatLine(cm.ts, senderName, cm.text));
        rememberTurn(senderName, cm.text, cm.ts, bot ? 'ai' : 'human');
        if (frameAttachment(cm.image)) attachments.push(() => showInlineImage(cm.image, cm.id, forPeer));
        if (frameAttachment(cm.voice)) attachments.push(() => showInlineVoice(cm.voice, cm.id, forPeer));
      }
    }
    // One paint for the whole replay, then the pictures behind it — see
    // ui.addMessages and queueInlineMedia.
    ui.addMessages(batch);
    scheduleMarkRead(forPeer);
    queueInlineMedia(attachments);
    return batch.length;
  }

  // The open conversation, painted from the native core's store. What the
  // transcript does not hold yet is appended through `renderCloudMessages` — the
  // one place sender names, unread ids, media and the log are handled; what it
  // does hold is updated where it stands (a receipt, an edit, a reaction), so
  // the reader's scroll position is never taken for a mark changing colour.
  const CORE_HISTORY_ROWS = 200;
  // A burst of notices (a page of backfilled history, a run of receipts) is one
  // repaint, and the live link — which shows an arrival the moment it lands —
  // gets there first, so the repaint finds the row already drawn.
  const CORE_PAINT_DEBOUNCE_MS = 150;
  let corePaintTimer = null;

  function paintCoreConversation() {
    const session = cloudSession;
    if (!(isCloudPeer && cloud?.peer && session?.isCore)) return;
    const forPeer = cloud.peer;
    let rows;
    try {
      rows = session.conversation(forPeer, CORE_HISTORY_ROWS);
    } catch (error) {
      ui.addLine(`* ${t('core.storageFailed', { reason: error?.message ?? 'error' })}`);
      return;
    }
    const fresh = reconcileCoreRows(rows, ui, { selfLogin: cloud.self?.login, forwardLead, t });
    if (fresh.length > 0) renderCloudMessages(fresh, forPeer);
    const last = rows[rows.length - 1];
    if (last?.ts) touchPeerRecency(forPeer, last.ts);
  }

  function scheduleCorePaint() {
    if (corePaintTimer !== null || shuttingDown) return;
    corePaintTimer = setTimeout(() => {
      corePaintTimer = null;
      paintCoreConversation();
    }, CORE_PAINT_DEBOUNCE_MS);
    corePaintTimer.unref?.();
  }

  function replayCloudHistory() {
    if (!(isCloudPeer && cloud && cloud.peer)) return;
    if (cloudSession?.isCore) {
      // The store is the history: no cache to paint first and no HTTP snapshot
      // to merge — the core fetches and persists what is missing, and tells us
      // (`core-stored`) when a row appears.
      if (cloudHistoryEpoch !== conversationEpoch) {
        cloudHistoryEpoch = conversationEpoch;
        deletedHistoryIds.clear();
      }
      paintCoreConversation();
      return;
    }
    const epoch = conversationEpoch;
    const forPeer = cloud.peer;

    // Cache is an initial paint, never another append of the open transcript.
    // Both the eventual snapshot and live delivery merge by message id.
    const cached = loadCloudCache(forPeer);
    const cachedRendered = cached.length > 0;
    if (cloudHistoryEpoch !== epoch) {
      cloudHistoryEpoch = epoch;
      deletedHistoryIds.clear();
      const lastMsg = cached[cached.length - 1];
      if (lastMsg?.ts) touchPeerRecency(forPeer, lastMsg.ts);
      renderCloudMessages(cached, forPeer);
    }

    // 2. Fetch fresh history from cloud server if available
    if (cloud.api?.history) {
      void cloudCacheSession.refresh(forPeer, () => (
        cloud.api.history(forPeer, 200, { includeDeleted: showDeletedMessages, media: 'ref' })
      )).then((result) => {
        if (epoch !== conversationEpoch || !result) return;
        const { messages, removedIds } = result;
        ui.removeMessages(removedIds);
        for (const id of removedIds) unread.delete(id);
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.ts) touchPeerRecency(forPeer, lastMsg.ts);
        // Do not clear: that discarded live arrivals and receipt state, and a
        // headless transcript cannot erase lines that have already been printed.
        renderCloudMessages(messages, forPeer);
      }).catch(() => {
        if (epoch !== conversationEpoch) return;
        if (!cachedRendered) {
          ui.addLine(`* ${t('status.offline')}`);
        }
      });
    } else if (!cachedRendered) {
      ui.addLine(`* ${t('status.offline')}`);
    }
  }

  let preloadingInProgress = false;
  async function preloadCloudHistories() {
    if (preloadingInProgress || !cloud?.api?.history || cloudSession?.isCore) return;
    preloadingInProgress = true;
    try {
      const targets = [];
      if (cloud.self?.login) targets.push(cloud.self.login);
      if (Array.isArray(cloud.users)) {
        for (const u of cloud.users) {
          if (u?.login && !targets.includes(u.login)) {
            targets.push(u.login);
          }
        }
      }
      for (const target of targets) {
        if (shuttingDown) break;
        // The open conversation owns its request and its epoch-guarded paint.
        if (isCloudPeer && target === cloud?.peer) continue;
        try {
          const result = await cloudCacheSession.refresh(target, () => cloud.api.history(target, 100, { media: 'ref' }));
          if (result) {
            const lastMsg = result.messages[result.messages.length - 1];
            if (lastMsg?.ts) touchPeerRecency(target, lastMsg.ts);
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 60));
      }
      updateRosterBar();
    } finally {
      preloadingInProgress = false;
    }
  }

  function finishSwitch(peer, transport = 'auto') {
    if (shuttingDown) return undefined;
    if (!peer) {
      shuttingDown = true;
      releaseSession();
      return closeAndExit(0, leaveAndRestart);
    }
    switchActiveConversation(peer, { transport });
    return undefined;
  }

  // /lang: the interface language lives in the config the next process reads,
  // so the change is a clean relaunch — the same machinery /peer and /update
  // use. Bare /lang offers the menu, current language first.
  async function switchLanguage(arg) {
    const asked = String(arg ?? '').trim().toLowerCase();
    let next = asked;
    if (asked === '') {
      const picked = await ui.pickFromList({
        label: 'language', rows: languageRows(args.lang),
      });
      if (picked === null) return undefined; // dismissed: keep talking
      next = picked;
    }
    try {
      next = normaliseLanguage(next);
    } catch {
      return ui.addLine(`* ${t('lang.unknown', { asked: asked || '?' })}`);
    }
    if (next === args.lang) return ui.addLine(`* ${t('lang.same', { lang: next })}`);
    ui.addLine(`* ${t('lang.switching', { lang: next })}`);
    persist({ lang: next, log: logPreference === false ? false : true });
    return finishSwitch(null);
  }

  // /name: the name the peer sees. Saved, so it is the same on the next run and
  // on every other machine this person starts from — that consistency is the
  // point, since the old default was the hostname and no two machines share one.
  //
  // A relaunch rather than a live swap: the name travels in the hello frame,
  // which is sent once when a channel opens, so a peer already connected would
  // otherwise keep showing the old one until it reconnected anyway. This is the
  // same machinery /lang and /peer use, and it works against every peer version.
  function switchName(arg) {
    const asked = String(arg ?? '').trim();
    if (asked === '') {
      ui.addLine(`* ${t('name.current', { name: args.name })}`);
      return ui.addLine(`* ${t('name.usage', { limit: SELF_NAME_MAX })}`);
    }
    const next = normaliseSelfName(asked);
    if (!next) return ui.addLine(`* ${t('name.bad', { limit: SELF_NAME_MAX })}`);
    if (next === args.name) return ui.addLine(`* ${t('name.same', { name: next })}`);
    // The flag wins on the next start too, because the relaunch reuses this
    // session's arguments — so saying "changed" would be a lie.
    if (args.nameExplicit) {
      persist({ name: next });
      return ui.addLine(`* ${t('name.savedButFlagged', { name: next })}`);
    }
    ui.addLine(`* ${t('name.switching', { name: next })}`);
    persist({ name: next });
    return finishSwitch(null);
  }

  // /nick: what this screen calls the peer. A Cloud conversation carries the
  // nickname on the account (issue #28), so it follows the person from machine
  // to machine; on a direct Tailscale/LAN link there is no server to hold it,
  // and it stays in this machine's peer-memory exactly as before — never sent,
  // never read by them, which is still the point for a shared node with no
  // resolvable login. resolveDisplayLabel tries the server alias first, then
  // this local nickname, then the roster/hello name, so a stale local one can
  // never shadow the account's own.
  async function switchNickname(arg) {
    const asked = String(arg ?? '').trim();
    if (asked === '') {
      const alias = isCloudPeer ? cloudAliasOf(cloud) : null;
      const local = memory.nickname();
      if (alias) return ui.addLine(`* ${t('nick.currentCloud', { nick: alias })}`);
      if (local) return ui.addLine(`* ${t('nick.current', { nick: local })}`);
      return ui.addLine(`* ${t('nick.none', { peer: currentPeerLabel })}`);
    }
    if (/^(clear|reset)$/i.test(asked)) {
      const current = (isCloudPeer ? cloudAliasOf(cloud) : null) || memory.nickname();
      if (!current) return ui.addLine(`* ${t('nick.alreadyNone')}`);
    }
    let result;
    try {
      result = await applyNickname({ arg: asked, isCloudPeer, cloud, memory });
    } catch (error) {
      // The local nickname is left untouched: a refused or unreachable server
      // must not be the reason a name disappears.
      return ui.addLine(`* ${t('nick.cloudFailed', { code: error?.code ?? 'server_error' })}`);
    }
    if (result.action === 'bad') return ui.addLine(`* ${t('nick.bad', { limit: SELF_NAME_MAX })}`);
    currentPeerLabel = resolveDisplayLabel(lastPeerName);
    ui.setPeerName(currentPeerLabel);
    if (result.action === 'clear') {
      return ui.addLine(`* ${t(isCloudPeer ? 'nick.clearedCloud' : 'nick.cleared', { peer: currentPeerLabel })}`);
    }
    return ui.addLine(`* ${t(isCloudPeer ? 'nick.setCloud' : 'nick.set', { nick: result.name })}`);
  }

  // /link: an explicit, one-time confirmation that this Tailscale/LAN peer
  // and a named Cloud friend are the same human being (see peer-links.js) —
  // never inferred from a name or hostname match, only ever set by a person
  // typing the command. Once set, computePeerKey routes every transport for
  // this selector onto the linked Cloud login's history/memory/outbox, so
  // /p2p and /cloud stop looking like two different correspondents. History
  // written before the link is left exactly where it was; only where new
  // lines land changes.
  //
  // Deliberately NOT switchActiveConversation: nothing about the transport
  // changed (same socket, same peer, same isCloudPeer), so there is nothing
  // to reconnect and no reason to clear the screen — only the log/memory
  // this session writes into. An earlier version reused
  // switchActiveConversation for this and its unconditional `ui.clear()`
  // erased the confirmation line the instant it was printed, from the same
  // synchronous call that added it — a person typing /link saw nothing.
  async function relinkPeerKey(nextPeerKey) {
    peerKey = nextPeerKey;
    memory = createPeerMemory({ dir: stateDir, key: peerKey });
    currentPeerLabel = resolveDisplayLabel(lastPeerName);
    ui.setPeerName(currentPeerLabel);
    await new Promise((resolve) => log.close(resolve));
    logFile = resolveLogFile({
      logFlag: args.log, noLogFlag: args.noLog, configLog: logPreference,
      stateDir, peerKey,
    });
    log = createLog(logFile, {
      store: secureStore,
      onError: (error) => notice(t('log.writeFailed', { error: error.message })),
    });
    previewSwitchHistory();
  }

  async function switchLink(arg) {
    const asked = String(arg ?? '').trim();
    if (isCloudPeer) return ui.addLine(`* ${t('link.notNeeded')}`);
    if (!peerLogin) return ui.addLine(`* ${t('link.noLogin')}`);
    if (asked === '') {
      const current = resolveLinkedCloudLogin(stateDir, peerLogin);
      return current
        ? ui.addLine(`* ${t('link.current', { login: current })}`)
        : ui.addLine(`* ${t('link.none')}`);
    }
    if (/^(clear|unlink|none)$/i.test(asked)) {
      if (!resolveLinkedCloudLogin(stateDir, peerLogin)) {
        return ui.addLine(`* ${t('link.alreadyNone')}`);
      }
      unlinkPeer(stateDir, peerLogin);
      await relinkPeerKey(computePeerKey({ isCloudPeer, peerLogin, selector: args.peer }));
      return ui.addLine(`* ${t('link.cleared')}`);
    }
    const wanted = asked.replace(/^@/, '').trim();
    if (!wanted) return ui.addLine(`* ${t('link.noLogin')}`);
    // Verified against the live friend list when one is available, so a typo
    // does not quietly link to a login nobody actually owns; without a Cloud
    // session to check against, the given login is trusted as typed.
    let cloudLogin = wanted;
    if (cloud && Array.isArray(cloud.users)) {
      const needle = wanted.toLowerCase();
      const friend = cloud.users.find((u) => String(u?.login ?? '').toLowerCase() === needle
        || String(u?.name ?? '').toLowerCase() === needle);
      const isSelf = cloud.self && String(cloud.self.login ?? '').toLowerCase() === needle;
      if (!friend && !isSelf) return ui.addLine(`* ${t('link.unknownCloud', { login: wanted })}`);
      cloudLogin = friend ? friend.login : cloud.self.login;
    }
    linkPeer(stateDir, peerLogin, cloudLogin);
    await relinkPeerKey(computePeerKey({ isCloudPeer, peerLogin, selector: args.peer, linkedCloudLogin: cloudLogin }));
    return ui.addLine(`* ${t('link.set', { login: cloudLogin })}`);
  }

  // /block, /unblock: the local blocklist is the CLI's own enforcement (see
  // createRzFacade and the message/sync-outgoing/ai handlers below) and holds
  // in P2P even though there is no server to ask. In cloud mode the server is
  // told too, so the block holds on every other device and the other side
  // loses the ability to reach this account, not just the other way round.
  function resolveBlockTarget(arg) {
    const asked = String(arg ?? '').trim().replace(/^@/, '');
    return asked || activePeerLogin();
  }

  async function blockPeer(arg) {
    const login = resolveBlockTarget(arg);
    if (!login) return ui.addLine(`* ${t('block.usage')}`);
    const already = isBlocked(stateDir, login);
    if (!blockLogin(stateDir, login)) return ui.addLine(`* ${t('block.failed', { login })}`);
    if (isCloudPeer && cloud && cloud.api) {
      try {
        await cloud.api.block(login);
      } catch (err) {
        ui.addLine(`* ${describeApiError(err, t)}`);
      }
    }
    return ui.addLine(`* ${t(already ? 'block.already' : 'block.set', { login })}`);
  }

  async function unblockPeer(arg) {
    const login = resolveBlockTarget(arg);
    if (!login) return ui.addLine(`* ${t('block.usage')}`);
    const was = isBlocked(stateDir, login);
    unblockLogin(stateDir, login);
    if (isCloudPeer && cloud && cloud.api) {
      try {
        await cloud.api.unblock(login);
      } catch (err) {
        ui.addLine(`* ${describeApiError(err, t)}`);
      }
    }
    return ui.addLine(`* ${t(was ? 'block.unset' : 'block.alreadyNone', { login })}`);
  }

  // /remove: the contact and this account's whole side of the conversation,
  // gone for good. Deliberately not /block's twin — blocking keeps the thread
  // and is reversible, this deletes it — and deliberately not offered in P2P,
  // which has no contact list of its own: a Tailscale/LAN peer is a device the
  // roster remembers, and only an explicit `/link` ties one to a Cloud login.
  // Without that link there is nobody to remove, and saying so is better than
  // inventing a local friendship to delete.
  //
  // The whole call is one transaction against a frozen server API (see
  // removeCloudContact): the API is told exactly one login, and only after it
  // answers 200 does anything on this machine go.
  function openCloudLogin() {
    if (isCloudPeer) return cloud?.peer ?? null;
    const aimed = activePeerLogin();
    return aimed ? resolveLinkedCloudLogin(stateDir, aimed) : null;
  }

  function removeTarget(arg) {
    const asked = String(arg ?? '').trim().replace(/^@/, '');
    if (asked) return { login: asked };
    const open = openCloudLogin();
    if (open) return { login: open };
    return { login: null, peer: activePeerLogin() ?? null };
  }

  // A whole conversation must never disappear on a single Enter, so the command
  // only asks: the price is said in full above the menu, and the row that goes
  // through says it in two words. A client with no menu (headless, a pipe)
  // answers null and deletes nothing.
  async function confirmRemove(login) {
    ui.addLine(`* ${t('remove.confirm')}`);
    const picked = await ui.pickFromList({
      label: t('remove.action'),
      rows: [
        { name: t('remove.confirmRow'), help: login, value: 'remove' },
        { name: t('remove.cancel'), value: 'cancel' },
      ],
    });
    return picked === 'remove';
  }

  // The row and everything that ranks it: the roster entry and the links (see
  // forgetContactEntry), then the Cloud friend list this session draws both the
  // picker and the roster bar from, the unread badge, and the recency the
  // picker sorts by.
  function forgetRemovedContact(login, selector = null) {
    const needle = String(login).toLowerCase();
    forgetContactEntry(stateDir, login, selector);
    if (Array.isArray(cloud?.users)) {
      cloud.users = cloud.users.filter((u) => String(u?.login ?? '').toLowerCase() !== needle);
    }
    unreadPeers.delete(login);
    unreadPeers.delete(`@${login}`);
    unreadPeers.delete(needle);
    peerRecency.delete(needle);
    updateRosterBar();
  }

  // The server refuses new frames between the two of us from now on
  // (peer_not_found), and the cached history would be rebuilt from its copy of
  // a thread this account no longer has, so the conversation is closed at once.
  // This client always sits in some conversation, so «closed» means Saved
  // Messages — the one that is always there, and never a friend. The switch is
  // returned rather than fired and forgotten: it repaints the whole screen, so
  // a caller with something to say has to wait for the new transcript to exist
  // before saying it.
  function closeRemovedConversation() {
    if (shuttingDown) return null;
    const self = cloud?.self?.login;
    if (!self) return null;
    return switchActiveConversation(`@${self}`);
  }

  async function removePeer(arg) {
    const target = removeTarget(arg);
    if (!target.login) {
      return ui.addLine(`* ${target.peer
        ? t('remove.notContact', { peer: target.peer })
        : t('remove.usage')}`);
    }
    if (!cloud || !cloud.api) return ui.addLine(`* ${t('remove.signedOut')}`);

    // Both halves of the open conversation, read before the request: the
    // roster broadcast that follows a removal can switch this session to
    // another peer while the call is in flight, and what has to go is the
    // conversation that was open, not whatever replaced it.
    const openLogin = openCloudLogin();
    const isOpen = Boolean(openLogin)
      && String(openLogin).toLowerCase() === target.login.toLowerCase();
    const openSelector = isOpen ? activePeerLogin() : null;
    const closingLog = log;
    const openFiles = isOpen
      ? { log: logFile, outbox: outbox.file, memory: memory.file }
      : null;

    const result = await removeCloudContact({
      stateDir,
      login: target.login,
      selfLogin: cloud.self?.login ?? null,
      contacts: cloud.users ?? [],
      api: cloud.api,
      confirm: confirmRemove,
      active: openFiles,
      closeLog: () => new Promise((resolve) => closingLog.close(resolve)),
      dropCache: dropCloudCache,
      onRemoved: (login) => forgetRemovedContact(login, openSelector),
      t,
    });
    // The switch that closes the removed conversation repaints the transcript,
    // so the line about it is said afterwards — otherwise the person would be
    // told a conversation is gone into a screen that is already gone.
    if (result.ok && isOpen) await closeRemovedConversation();
    ui.addLine(`* ${t(result.key, result.params)}`);
    return undefined;
  }

  // /theme: a live, local swap — unlike /lang and /name nothing here has to
  // reach the peer or survive a reconnect, so there is no relaunch. Bare
  // /theme reports the current choice and the ones on offer; anything else is
  // an outright rejection rather than a guess, so a typo cannot silently land
  // on the wrong palette.
  function switchTheme(arg) {
    const asked = String(arg ?? '').trim().toLowerCase();
    if (asked === '') {
      const msg = `* ${t('theme.current', {
        name: ui.themeName(), names: THEME_NAMES.join(', '),
      })}`;
      ui.addLine(msg);
      return msg;
    }
    if (!ui.setTheme(asked)) {
      const msg = `* ${t('theme.unknown', { name: asked, names: THEME_NAMES.join(', ') })}`;
      ui.addLine(msg);
      return msg;
    }
    persist({ theme: asked });
    const msg = `* ${t('theme.set', { name: asked })}`;
    ui.addLine(msg);
    return msg;
  }

  // A single keyboard menu for the settings people regularly change. Every row
  // shows its current value; selections either open a focused chooser or flip
  // the boolean they name. Free-form names and secrets stay explicit commands.
  async function showSettings() {
    const picked = await ui.pickFromList({
      label: t('settings.title'),
      rows: [
        { name: t('settings.language'), help: args.lang, value: 'language' },
        { name: t('settings.theme'), help: ui.themeName(), value: 'theme' },
        { name: t('settings.nameBadge'), help: t(nameBadge ? 'settings.on' : 'settings.off'), value: 'nameBadge' },
        { name: t('settings.logs'), help: t(logFile ? 'settings.on' : 'settings.off'), value: 'logs' },
        { name: t('settings.typing'), help: t(typingEnabled ? 'settings.on' : 'settings.off'), value: 'typing' },
        { name: t('settings.sysmsg'), help: t(sysmsgEnabled ? 'settings.on' : 'settings.off'), value: 'sysmsg' },
        { name: t('settings.deletedMessages'), help: t(showDeletedMessages ? 'settings.on' : 'settings.off'), value: 'deletedMessages' },
        { name: t('settings.emoji'), help: t(autoEmoji ? 'settings.on' : 'settings.off'), value: 'emoji' },
        { name: t('settings.saver'), help: t(saverOn ? 'settings.on' : 'settings.off'), value: 'saver' },
        { name: t('settings.autoupdate'), help: t(autoupdateEnabled ? 'settings.on' : 'settings.off'), value: 'autoupdate' },
        { name: t('settings.ai'), help: t(ai.enabled && ai.key ? 'settings.on' : 'settings.off'), value: 'ai' },
      ],
    });
    if (picked === null) return undefined;
    if (picked === 'language') return switchLanguage('');
    if (picked === 'logs') return switchLogging('');
    if (picked === 'nameBadge') return switchNameBadge(nameBadge ? 'off' : 'on');
    if (picked === 'typing') return switchTyping(typingEnabled ? 'off' : 'on');
    if (picked === 'sysmsg') return switchSysmsg(sysmsgEnabled ? 'off' : 'on');
    if (picked === 'deletedMessages') {
      showDeletedMessages = !showDeletedMessages;
      persist({ showDeletedMessages });
      return undefined;
    }
    if (picked === 'emoji') return switchEmoji(autoEmoji ? 'off' : 'on');
    if (picked === 'saver') return showSaver(saverOn ? 'off' : 'on');
    if (picked === 'autoupdate') return switchAutoupdate(autoupdateEnabled ? 'off' : 'on');
    if (picked === 'theme') {
      const current = ui.themeName();
      const next = await ui.pickFromList({
        label: t('settings.theme'),
        rows: [current, ...THEME_NAMES.filter((name) => name !== current)]
          .map((name) => ({ name, value: name })),
      });
      return next === null ? undefined : switchTheme(next);
    }
    const action = await ui.pickFromList({
      label: t('settings.ai'),
      rows: [
        { name: t('settings.aiStatus'), value: 'status' },
        { name: t('settings.aiModel'), help: ai.model, value: 'model' },
        { name: t(ai.enabled ? 'settings.aiUsePeer' : 'settings.aiUseHere'), value: 'toggle' },
      ],
    });
    if (action === 'toggle') return askAi(ai.enabled ? 'off' : 'on');
    if (action === 'status') return askAi('status');
    if (action === 'model') return switchAiModel('');
    return undefined;
  }

  function switchNameBadge(arg) {
    const asked = String(arg ?? '').trim().toLowerCase();
    if (asked === '') {
      return ui.addLine(`* ${t('badge.current', {
        state: t(nameBadge ? 'settings.on' : 'settings.off'),
      })}`);
    }
    if (asked !== 'on' && asked !== 'off') {
      return ui.addLine(`* ${t('badge.usage')}`);
    }
    const next = asked === 'on';
    if (next === nameBadge) {
      return ui.addLine(`* ${t(next ? 'badge.alreadyOn' : 'badge.alreadyOff')}`);
    }
    nameBadge = next;
    ui.setNameBadge(nameBadge);
    persist({ nameBadge });
    return ui.addLine(`* ${t(nameBadge ? 'badge.on' : 'badge.off')}`);
  }

  function switchRosterRows(arg) {
    const raw = String(arg ?? '').trim();
    if (raw === '') {
      return ui.addLine(`* ${t('roster.current', { count: ui.rosterRows() })}  (${t('roster.usage')})`);
    }
    const num = parseInt(raw, 10);
    if (![1, 2, 3].includes(num)) {
      return ui.addLine(`* ${t('roster.usage')}`);
    }
    ui.setRosterRows(num);
    persist({ rosterRows: num });
    return ui.addLine(`* ${t('roster.set', { count: num })}`);
  }

  function switchEmoji(arg) {
    const next = arg === 'on';
    if (next === autoEmoji) return undefined;
    autoEmoji = next;
    persist({ autoEmoji });
    return undefined;
  }

  function switchAutoupdate(arg) {
    const asked = String(arg ?? '').trim().toLowerCase();
    if (asked === '') {
      return ui.addLine(`* ${t('autoupdate.current', {
        state: t(autoupdateEnabled ? 'settings.on' : 'settings.off'),
      })}`);
    }
    if (asked !== 'on' && asked !== 'off') {
      return ui.addLine(`* ${t('autoupdate.usage')}`);
    }
    const next = asked === 'on';
    if (next === autoupdateEnabled) {
      return ui.addLine(`* ${t(next ? 'autoupdate.alreadyOn' : 'autoupdate.alreadyOff')}`);
    }
    autoupdateEnabled = next;
    persist({ autoupdate: autoupdateEnabled });
    return ui.addLine(`* ${t(autoupdateEnabled ? 'autoupdate.on' : 'autoupdate.off')}`);
  }

  function switchSysmsg(arg) {
    const asked = String(arg ?? '').trim().toLowerCase();
    if (asked === '') {
      return ui.addLine(`* ${t('sysmsg.current', {
        state: t(sysmsgEnabled ? 'settings.on' : 'settings.off'),
      })}`);
    }
    if (asked !== 'on' && asked !== 'off') {
      return ui.addLine(`* ${t('sysmsg.usage')}`);
    }
    const next = asked === 'on';
    if (next === sysmsgEnabled) {
      return ui.addLine(`* ${t(next ? 'sysmsg.alreadyOn' : 'sysmsg.alreadyOff')}`);
    }
    sysmsgEnabled = next;
    persist({ sysmsg: sysmsgEnabled });
    return ui.addLine(`* ${t(sysmsgEnabled ? 'sysmsg.on' : 'sysmsg.off')}`);
  }

  // /logs: turns the transcript on or off for this session and remembers the
  // choice, so the next launch starts the same way. Bare /logs offers a menu
  // with the current state first.
  async function switchLogging(arg) {
    const asked = String(arg ?? '').trim().toLowerCase();
    let next = null;
    if (asked === '') {
      const rows = logFile
        ? [{ name: t('logs.off'), value: false }, { name: t('logs.on'), value: true }]
        : [{ name: t('logs.on'), value: true }, { name: t('logs.off'), value: false }];
      const picked = await ui.pickFromList({ label: 'logs', rows });
      if (picked === null) return undefined;
      next = picked;
    } else if (asked === 'on' || asked === 'off') {
      next = asked === 'on';
    } else {
      return ui.addLine(`* ${t('logs.usage')}`);
    }
    if (next === Boolean(logFile)) {
      return ui.addLine(`* ${t(next ? 'logs.alreadyOn' : 'logs.alreadyOff', { file: logFile ?? '' })}`);
    }
    log.close(() => {});
    logFile = next ? (args.log || defaultLogPath(stateDir, peerKey)) : null;
    log = createLog(logFile, {
      store: secureStore,
      onError: (error) => notice(t('log.writeFailed', { error: error.message })),
    });
    persist({ lang: args.lang, log: next });
    return ui.addLine(`* ${t(next ? 'logs.turnedOn' : 'logs.turnedOff', { file: logFile ?? '' })}`);
  }

  function runRemindCommand(arg) {
    const input = String(arg ?? '').trim();
    if (input === '') {
      ui.addLine(`* ${t('remind.usage')}`);
      return t('remind.usage');
    }
    const lower = input.toLowerCase();
    if (lower === 'list') {
      const list = reminders.list();
      if (list.length === 0) {
        ui.addLine(`* ${t('remind.empty')}`);
        return t('remind.empty');
      }
      ui.addLine(`* ${t('remind.list', { count: list.length })}`);
      for (const r of list) {
        ui.addLine(`  • [${r.id}] ${r.dueClock} (${r.remainingLabel}): ${r.text}`);
      }
      return `${t('remind.list', { count: list.length })}\n` +
        list.map((r) => `• [${r.id}] ${r.dueClock} (${r.remainingLabel}): ${r.text}`).join('\n');
    }
    if (lower === 'clear') {
      const count = reminders.clear();
      ui.addLine(`* ${t('remind.cleared', { count })}`);
      return t('remind.cleared', { count });
    }
    if (lower.startsWith('cancel ') || lower.startsWith('delete ') || lower.startsWith('rm ')) {
      const id = input.split(/\s+/)[1];
      const ok = reminders.cancel(id);
      ui.addLine(`* ${t(ok ? 'remind.cancelled' : 'remind.notFound', { id: id || '?' })}`);
      return t(ok ? 'remind.cancelled' : 'remind.notFound', { id: id || '?' });
    }
    const parsed = parseReminderTime(input);
    if (!parsed) {
      ui.addLine(`* ${t('remind.badTime', { input })}`);
      return t('remind.badTime', { input });
    }
    const rem = reminders.add({
      text: parsed.text,
      dueTs: parsed.dueTs,
      targetUser: args.name,
    });
    const timeStr = formatClockTime(rem.dueTs);
    const remainingStr = formatReminderRemaining(parsed.delayMs);
    ui.addLine(`* ${t('remind.set', {
      time: timeStr,
      remaining: remainingStr,
      text: rem.text,
      id: rem.id,
    })}`);
    return t('remind.set', {
      time: timeStr,
      remaining: remainingStr,
      text: rem.text,
      id: rem.id,
    });
  }

  async function runInvite(arg) {
    // `cloud` being absent is the one thing this session knows and the command
    // does not: it decides between "no Cloud here" and a real request.
    return runInviteCommand({ arg, api: cloud?.api ?? null, ui, t });
  }

  async function addFriend(arg) {
    return runAddCommand({ arg, api: cloud?.api ?? null, ui, t });
  }

  async function switchPeer(arg) {
    const selector = String(arg ?? '').trim();
    if (selector === '') {
      let status = null;
      if (tsCli) {
        try {
          status = parseStatus(await runTailscale(tsCli, ['status', '--json']));
        } catch {
          status = null; // no daemon to ask, so claim nothing about anyone
        }
      }
      const selectors = rosterSelectors(stateDir, { login: status?.self?.login ?? null, ips: ownIps });
      const choices = rosterChoices({ selectors, status });
      for (const choice of choices) {
        if (!choice.badge) choice.badge = '⚡ [tailnet]';
        if (unreadPeers.has(choice.login)) {
          const unreadInfo = unreadPeers.get(choice.login);
          choice.badge = `🔔 [${unreadInfo.count} unread] ` + choice.badge;
        }
      }
      if (lanDiscovery) {
        const lanPeers = lanDiscovery.getPeers();
        for (const lanPeer of lanPeers) {
          const existing = choices.find((c) => c.login === lanPeer.name || (lanPeer.login && c.login === lanPeer.login));
          if (existing) {
            existing.badge = '📡 [lan]';
            existing.devices = [lanPeer.address, ...(existing.devices || [])];
            existing.state = 'online';
          } else {
            choices.unshift({
              login: lanPeer.name,
              state: 'online',
              type: 'lan',
              badge: '📡 [lan]',
              devices: [lanPeer.address],
            });
          }
        }
      }
      if (cloud && cloud.api) {
        try {
          const cloudUsers = await cloud.api.users();
          for (const cu of cloudUsers) {
            const cLogin = cu.login;
            if (!cLogin) continue;
            const existing = choices.find((c) => c.login === cLogin);
            const unreadInfo = unreadPeers.get(cLogin);
            const unreadBadge = unreadInfo ? `🔔 [${unreadInfo.count} unread] ` : '';
            if (existing) {
              existing.badge = `${unreadBadge}🌐 [cloud]`;
              existing.state = cu.online ? 'online' : 'offline';
            } else {
              choices.push({
                login: cLogin,
                state: cu.online ? 'online' : 'offline',
                type: 'cloud',
                badge: `${unreadBadge}🌐 [cloud]`,
                devices: cu.official ? [t('cloud.officialAccount')] : (cu.online ? [t('cloud.statusHere')] : [describeLastSeen(cu.lastSeen, t)]),
              });
            }
          }
        } catch {}
      }
      for (const choice of choices) {
        choice.blocked = isBlocked(stateDir, choice.login.replace(/^@/, ''));
      }
      // Saved Messages is your own account, not a friend being reachable or
      // not, so it sits outside the empty/single-choice shortcuts the same way
      // it does in choosePeer.
      const hasSaved = Boolean(cloud?.self?.login);
      if (choices.length === 0 && !hasSaved) {
        ui.addLine(`* ${t('pick.empty')}`);
        return ui.addLine(`* ${t('pick.emptyHint')}`);
      }
      choices.sort((a, b) => {
        const unreadA = (unreadPeers.get(a.login)?.count || unreadPeers.get(a.login.replace(/^@/, ''))?.count || 0) > 0;
        const unreadB = (unreadPeers.get(b.login)?.count || unreadPeers.get(b.login.replace(/^@/, ''))?.count || 0) > 0;
        if (unreadA !== unreadB) return unreadA ? -1 : 1;
        const recA = getPeerRecency(a.login);
        const recB = getPeerRecency(b.login);
        if (recA !== recB) return recB - recA;
        return String(a.name || a.login).localeCompare(String(b.name || b.login));
      });
      // One remembered person: the switch is obvious enough to just do.
      if (choices.length === 1 && !hasSaved) return finishSwitch(choices[0].login);
      const rows = peerMenuRows(choices, t);
      if (hasSaved) rows.unshift(savedMessagesRow(t, cloud.self.login));
      const picked = await ui.pickFromList({ label: 'peers', rows });
      return picked === null ? undefined : finishSwitch(picked);
    }
    return finishSwitch(selector);
  }

  async function switchPeerP2p(arg) {
    const selector = String(arg ?? '').trim();
    if (selector === '' && isCloudPeer && args.peer) return finishSwitch(args.peer, 'p2p');
    if (selector === '') {
      let status = null;
      if (tsCli) {
        try {
          status = parseStatus(await runTailscale(tsCli, ['status', '--json']));
        } catch {
          status = null;
        }
      }
      const selectors = rosterSelectors(stateDir, { login: status?.self?.login ?? null, ips: ownIps });
      const choices = rosterChoices({ selectors, status });
      for (const choice of choices) {
        if (!choice.badge) choice.badge = '⚡ [tailnet]';
        if (unreadPeers.has(choice.login)) {
          const unreadInfo = unreadPeers.get(choice.login);
          choice.badge = `🔔 [${unreadInfo.count} unread] ` + choice.badge;
        }
      }
      if (lanDiscovery) {
        const lanPeers = lanDiscovery.getPeers();
        for (const lanPeer of lanPeers) {
          const existing = choices.find((c) => c.login === lanPeer.name || (lanPeer.login && c.login === lanPeer.login));
          if (existing) {
            existing.badge = '📡 [lan]';
            existing.devices = [lanPeer.address, ...(existing.devices || [])];
            existing.state = 'online';
          } else {
            choices.unshift({
              login: lanPeer.name,
              state: 'online',
              type: 'lan',
              badge: '📡 [lan]',
              devices: [lanPeer.address],
            });
          }
        }
      }
      for (const choice of choices) {
        choice.blocked = isBlocked(stateDir, choice.login.replace(/^@/, ''));
      }
      if (choices.length === 0) {
        ui.addLine(`* ${t('pick.empty')}`);
        return ui.addLine(`* ${t('pick.emptyHint')}`);
      }
      choices.sort((a, b) => {
        const unreadA = (unreadPeers.get(a.login)?.count || unreadPeers.get(a.login.replace(/^@/, ''))?.count || 0) > 0;
        const unreadB = (unreadPeers.get(b.login)?.count || unreadPeers.get(b.login.replace(/^@/, ''))?.count || 0) > 0;
        if (unreadA !== unreadB) return unreadA ? -1 : 1;
        const recA = getPeerRecency(a.login);
        const recB = getPeerRecency(b.login);
        if (recA !== recB) return recB - recA;
        return String(a.name || a.login).localeCompare(String(b.name || b.login));
      });
      if (choices.length === 1) return finishSwitch(choices[0].login, 'p2p');
      const picked = await ui.pickFromList({
        label: 'peers', rows: peerMenuRows(choices, t),
      });
      return picked === null ? undefined : finishSwitch(picked, 'p2p');
    }
    return finishSwitch(selector, 'p2p');
  }

  async function switchPeerCloud(arg) {
    const selector = String(arg ?? '').trim();
    if (!cloud || !cloud.api) {
      ui.addLine(`* Cloud mode is not configured. Use /invite or --cloud`);
      return undefined;
    }
    const currentCloudTarget = cloudTargetForCurrentPeer({
      isCloudPeer, peer: args.peer, cloudUsers: cloud.users || [],
    });
    if (selector === '' && currentCloudTarget) return finishSwitch(currentCloudTarget, 'cloud');
    if (selector === '') {
      try {
        const cloudUsers = await cloud.api.users();
        const choices = [];
        for (const cu of cloudUsers) {
          const cLogin = cu.login;
          if (!cLogin) continue;
          const unreadInfo = unreadPeers.get(cLogin);
          const unreadBadge = unreadInfo ? `🔔 [${unreadInfo.count} unread] ` : '';
          choices.push({
            login: `@${cLogin}`,
            state: cu.online ? 'online' : 'offline',
            type: 'cloud',
            badge: `${unreadBadge}🌐 [cloud]`,
            devices: cu.official ? [t('cloud.officialAccount')] : (cu.online ? [t('cloud.statusHere')] : [describeLastSeen(cu.lastSeen, t)]),
          });
        }
        for (const choice of choices) {
          choice.blocked = isBlocked(stateDir, choice.login.replace(/^@/, ''));
        }
        // Saved Messages is pinned ahead of the empty/single-friend shortcuts:
        // it is always there even with zero cloud friends yet.
        if (choices.length === 0 && !cloud.self?.login) {
          ui.addLine(`* No cloud contacts yet. Use /invite create or /invite <code-from-friend>`);
          return undefined;
        }
        choices.sort((a, b) => {
          const unreadA = (unreadPeers.get(a.login)?.count || unreadPeers.get(a.login.replace(/^@/, ''))?.count || 0) > 0;
          const unreadB = (unreadPeers.get(b.login)?.count || unreadPeers.get(b.login.replace(/^@/, ''))?.count || 0) > 0;
          if (unreadA !== unreadB) return unreadA ? -1 : 1;
          const recA = getPeerRecency(a.login);
          const recB = getPeerRecency(b.login);
          if (recA !== recB) return recB - recA;
          return String(a.name || a.login).localeCompare(String(b.name || b.login));
        });
        if (choices.length === 1 && !cloud.self?.login) return finishSwitch(choices[0].login, 'cloud');
        const rows = peerMenuRows(choices, t);
        if (cloud.self?.login) rows.unshift(savedMessagesRow(t, cloud.self.login));
        const picked = await ui.pickFromList({ label: 'peers', rows });
        return picked === null ? undefined : finishSwitch(picked, 'cloud');
      } catch (err) {
        ui.addLine(`* Cloud query failed: ${err.message}`);
        return undefined;
      }
    }
    const clean = selector.startsWith('@') ? selector : `@${selector}`;
    return finishSwitch(clean, 'cloud');
  }

  // Supervised, the wrapper restarts us with the same arguments; unsupervised,
  // the new session is a child of this one. Either way the next-peer note above
  // is what names the conversation — the arguments stay as the shell wrote them.
  function leaveAndRestart({
    tooDeep = 'update.tooDeep',
    relaunchFailed = 'update.relaunchFailed',
  } = {}) {
    const restarted = restartAfterUpdate();
    if (restarted.supervised) process.exit(restarted.exitCode);
    if (!restarted.ok) {
      process.stdout.write(restarted.reason === 'too-deep'
        ? `${t(tooDeep)}\n`
        : `${t(relaunchFailed, { reason: restarted.reason })}\n`);
      process.exit(restarted.reason === 'too-deep' ? 0 : 1);
    }
    process.exit(restarted.status);
  }

  // A band above the transcript rather than a line in it: there it cannot scroll
  // away, and /clear cannot take it. The width comes from blessed, not from
  // `process.stdout.columns`: under tmux the two disagree at startup, and the
  // one that draws the frame is the one that decides whether the logo fits.
  let holidayOn = config.holiday === true;
  const bandRows = () => logoRows(ui.width(), { holiday: holidayOn });
  const logoThrottle = createThrottle(LOGO_THROTTLE_MS);
  let saverOn = config.saver !== false;
  let saverAfterMinutes = resolveSaverAfterMinutes(config.saverAfter);
  let typingEnabled = config.typing === true;
  let autoEmoji = config.autoEmoji === true;
  let peerHere = false; // no channel yet, and that is what the cat sleeps on
  let selfState = 'active';
  let autoSaverOn = false; // the full-screen saver showing because the person left
  let bandMode = null; // what the band is doing now, so a repaint cannot restart it
  let bandArt = []; // the rows it was built on, so a resize can tell if they changed

  // One decision, in one place. The cat sleeps whenever nothing is happening —
  // no channel, or a channel and nobody typing — and stands up as the plain logo
  // the moment someone is at the keyboard. Two different idle animations were
  // one too many: "quiet" is quiet.
  function wantedBand() {
    if (bandRows().length === 0) return 'none';
    if (!saverOn) return 'logo';
    if (!peerHere || selfState !== 'active') return 'sleep';
    return 'logo';
  }

  function paintBand({ force = false } = {}) {
    // A sweep is a one-shot and is never cut short: whatever changed while it
    // ran is applied by its own `onDone`. Without this a focus report or a
    // resize arriving in the first second — tmux sends one the moment the pane
    // settles — replaced the animation with its own result, and the logo looked
    // as though it had never been drawn.
    if (bandMode === 'sweep') return;
    const want = wantedBand();
    if (!force && want === bandMode) return;
    bandMode = want;
    const rows = bandRows();
    bandArt = rows;
    if (want === 'none') ui.setLogo(null);
    else if (want === 'logo') ui.setLogo(rows);
    else ui.playLogo(sleepFrames(rows), { interval: SLEEP_FRAME_MS, loop: true });
  }

  // Every sweep goes through here, so the two rules hold everywhere: nothing
  // interrupts it, and when it ends the band goes back to saying what is true —
  // asleep with nobody on the other end, standing still with someone typing.
  function sweepBand(rows) {
    bandMode = 'sweep';
    bandArt = rows;
    ui.playLogo(logoFrames(rows), {
      onDone: () => {
        bandMode = null;
        paintBand({ force: true });
      },
    });
  }

  // The logo is on screen from the first paint — a band that starts blank and
  // waits for a timer is how it went missing at startup. The sweep runs over it
  // afterwards, once the blocking half of startup (`tailscale status`, `whois`,
  // a `git log` for the changelog) is out of the way and the loop can actually
  // paint one column at a time. When it finishes, the band takes over.
  const startupLogo = bandRows();
  if (startupLogo.length > 0) {
    ui.setLogo(startupLogo);
    bandMode = 'logo';
    bandArt = startupLogo;
  }

  // A resize matters to the band only when it changes which art fits. Every
  // other resize — and a terminal sends several while a pane settles — must
  // leave whatever is running alone.
  //
  // The window a terminal reports first is not always the window it settles on:
  // start narrow enough and the real size arrives after the sweep has begun, on
  // the other side of the 47-column line. Then the art genuinely is stale — and
  // the answer is to draw the new one, not to abandon the drawing. Killing it
  // here is why a small window showed no animation while a large one did.
  ui.onResize(() => {
    resyncSaver();
    const rows = bandRows();
    const same = rows.length === bandArt.length && rows.every((row, i) => row === bandArt[i]);
    if (same) return;
    bandArt = rows;
    if (bandMode === 'sweep' && rows.length > 0) return sweepBand(rows);
    bandMode = null; // the art changed, so whatever is on the band is stale
    return paintBand({ force: true });
  });

  // /logo replays the sweep, and the peer sees the same thing: a logo one person
  // watches alone is a screensaver, not a greeting. It is also movement on
  // someone else's terminal, so it is rate-limited the way a nudge is.


  function showLogo() {
    const rows = bandRows();
    if (rows.length === 0) {
      return ui.addLine(`* ${t('logo.tooNarrow', {
        width: minimumLogoWidth({ holiday: holidayOn }),
      })}`);
    }
    if (!logoThrottle.tryTake()) {
      return ui.addLine(`* ${t('logo.wait', { seconds: logoThrottle.remainingSeconds() })}`);
    }
    // The sweep is a one-shot, so the band has to be told to resume afterwards —
    // otherwise a session with nobody on the other end would stop sleeping.
    sweepBand(rows);
    if (!rz.isOnline()) return ui.addLine(`* ${t('logo.alone')}`);
    // A peer that predates the frame drops it and sees nothing, so it gets the
    // logo as an ordinary message: still the same picture, just without the
    // sweep. The animation is a nicety; being left out of it is not.
    const sent = peerSupportsLogo === false
      ? rz.sendFrame({ t: 'msg', text: rows.join('\n') })
      : rz.sendFrame({ t: 'logo' });
    return ui.addLine(`* ${t(sent ? 'logo.sent' : 'logo.alone', { peer: currentPeerLabel })}`);
  }

  // One command changes the current pair, not just this terminal. The local
  // choice is applied first and persisted; a current peer receives the same
  // boolean once, while an older or absent peer leaves an honest local-only
  // message instead of a false claim that both screens changed.
  function applyHoliday(next) {
    holidayOn = Boolean(next);
    persist({ holiday: holidayOn });
    paintBand({ force: true });
  }

  function switchHoliday(arg) {
    const asked = String(arg ?? '').trim().toLowerCase();
    if (asked !== '' && asked !== 'on' && asked !== 'off') {
      const msg = `* ${t('holiday.usage')}`;
      ui.addLine(msg);
      return msg;
    }
    const next = asked === '' ? !holidayOn : asked === 'on';
    applyHoliday(next);
    const shared = peerSupportsHoliday === true
      && rz.isOnline()
      && rz.sendFrame({ t: 'holiday', on: next });
    const key = shared
      ? (next ? 'holiday.on' : 'holiday.off')
      : (next ? 'holiday.localOn' : 'holiday.localOff');
    const msg = `* ${t(key, { peer: currentPeerLabel })}`;
    ui.addLine(msg);
    return msg;
  }
  // Shared full-screen playback, for the manual command and the automatic
  // appearance on AWAY. Both go through the deferred queue so the entry point
  // never matters for the Enter-tail race.
  const fullscreenFits = () =>
    ui.width() >= MIN_SAVER_WIDTH && ui.height() >= MIN_SAVER_HEIGHT;

  // Which composition fits is decided when the saver is shown, not at import:
  // the window may have been resized since the last time. The scanline is built
  // from the frame that was chosen, so it writes exactly what follows it.
  //
  // `auto` is the whole difference between the two kinds of saver. One that came
  // up on its own means nobody is at the machine, so a moved mouse is proof
  // somebody is and ends it. One asked for with `/saver` is something to look
  // at, and the pointer crossing the window must not take it away.
  function showFullscreenSaver(auto = false) {
    const frames = saverIdleFrames(ui.width(), ui.height());
    queueSaverPlayback(ui, frames, {
      intro: saverIntroFrames(frames[0]),
      interval: SLEEP_FRAME_MS,
      introInterval: 55,
      wakeOnMouse: auto,
    });
  }

  // The window changed size while the saver was up. The frames in flight were
  // built for the old one, and a frame wider than the window gets wrapped by
  // blessed into twice the rows — the picture shredded — so re-pick for the new
  // size, or give the screen back if nothing fits any more. A window that grew
  // back goes through the ordinary presence rule, which is what decides whether
  // an automatic saver belongs on screen at all.
  function resyncSaver() {
    if (ui.saverActive() && !ui.saverFits()) {
      if (fullscreenFits()) return showFullscreenSaver(autoSaverOn);
      autoSaverOn = false;
      return ui.hideSaverScreen();
    }
    return syncAutoSaver();
  }

  // Automatic screensaver: engages only on AWAY — /saver after minutes of no
  // focus and no key, the honest "nobody is here" signal. Idle (thirty quiet
  // seconds) is still someone reading, so the transcript stays visible.
  // Termux never reports focus and never drifts to AWAY, so it keeps its
  // always-on screen.
  function syncAutoSaver() {
    const shouldShow = saverOn && fullscreenFits() && selfState === 'away';
    if (shouldShow && !ui.saverActive()) {
      autoSaverOn = true;
      showFullscreenSaver(true);
    } else if (!shouldShow && autoSaverOn) {
      autoSaverOn = false;
      ui.hideSaverScreen();
    }
  }

  // Both `/saver` and `/saver on` now show the full-screen animation. `on`
  // additionally enables the quiet three-row sleep for future idle periods;
  // `off` only disables that automatic behavior. Activation is deferred until
  // the Enter key which submitted the command has fully left the terminal
  // input pipeline — Warp may emit its tail as another keypress, which used to
  // wake a newly shown saver immediately and make the command look inert.
  function showSaver(arg) {
    const trimmed = String(arg ?? '').trim();
    // /saver after [minutes]: bare reports the current delay, a number sets
    // it and retunes the presence signal live — see presence.setAwayMs. This
    // is the same AWAY that the header reports to the peer, on purpose: one
    // signal for "nobody is here", not a second clock invented for the saver
    // alone (see the comment on the presence construction below).
    const after = /^after\b\s*(.*)$/i.exec(trimmed);
    if (after) {
      const value = after[1].trim();
      if (value === '') {
        const msg = `* ${t('saver.afterCurrent', {
          minutes: saverAfterMinutes, peer: currentPeerLabel,
        })}`;
        ui.addLine(msg);
        return msg;
      }
      const minutes = Number(value);
      const valid = Number.isInteger(minutes)
        && minutes >= SAVER_AFTER_MIN_MINUTES && minutes <= SAVER_AFTER_MAX_MINUTES;
      if (!valid) {
        const msg = `* ${t('saver.afterUsage', {
          min: SAVER_AFTER_MIN_MINUTES, max: SAVER_AFTER_MAX_MINUTES,
        })}`;
        ui.addLine(msg);
        return msg;
      }
      saverAfterMinutes = minutes;
      persist({ saverAfter: minutes });
      presence.setAwayMs(minutes * 60000);
      const msg = `* ${t('saver.afterSet', { minutes, peer: currentPeerLabel })}`;
      ui.addLine(msg);
      return msg;
    }
    const raw = trimmed.toLowerCase();
    const launch = () => {
      if (!fullscreenFits()) {
        const msg = `* ${t('saver.tooSmall', {
          width: MIN_SAVER_WIDTH, height: MIN_SAVER_HEIGHT,
        })}`;
        ui.addLine(msg);
        return msg;
      }
      showFullscreenSaver();
      return true;
    };

    if (raw === 'off') {
      saverOn = false;
      persist({ saver: false });
      paintBand({ force: true });
      syncAutoSaver(); // a still-showing automatic saver goes away too
      const msg = `* ${t('saver.off')}`;
      ui.addLine(msg);
      return msg;
    }
    if (raw === 'on') {
      saverOn = true;
      persist({ saver: true });
      paintBand({ force: true });
      syncAutoSaver();
      const msg = `* ${t('saver.on')}`;
      ui.addLine(msg);
      launch();
      return msg;
    }
    if (raw !== '') {
      const msg = `* ${t('saver.usage')}`;
      ui.addLine(msg);
      return msg;
    }
    const started = launch();
    return started === true ? '* screensaver started' : started;
  }

  // /typing: whether this machine's own name appears on its own composer rule
  // while typing — never whether the peer is told. The peer always is; that
  // part travels the same way the AI's own typing frames do, unconditionally.
  // A toggle mid-word syncs the local indicator immediately rather than
  // waiting for the next keystroke or the idle timeout to notice.
  function switchTyping(arg) {
    const asked = String(arg ?? '').trim().toLowerCase();
    if (asked === '') {
      return ui.addLine(`* ${t(typingEnabled ? 'typing.currentOn' : 'typing.currentOff', {
        peer: currentPeerLabel,
      })}`);
    }
    if (asked !== 'on' && asked !== 'off') return ui.addLine(`* ${t('typing.usage')}`);
    const next = asked === 'on';
    if (next === typingEnabled) {
      return ui.addLine(`* ${t(next ? 'typing.alreadyOn' : 'typing.alreadyOff')}`);
    }
    typingEnabled = next;
    ui.setSelfTyping(next && typing.isActive());
    persist({ typing: typingEnabled });
    return ui.addLine(`* ${t(typingEnabled ? 'typing.on' : 'typing.off', { peer: currentPeerLabel })}`);
  }
  // /sound: mutes or unmutes the bell and every desktop notification, in both
  // p2p and cloud sessions — the one runtime toggle for what used to be only
  // the startup --no-notify flag.
  function switchSound(arg) {
    const asked = String(arg ?? '').trim().toLowerCase();
    if (asked === '') {
      return ui.addLine(`* ${t(soundEnabled ? 'sound.currentOn' : 'sound.currentOff')}`);
    }
    if (asked !== 'on' && asked !== 'off') return ui.addLine(`* ${t('sound.usage')}`);
    const next = asked === 'on';
    if (next === soundEnabled) {
      return ui.addLine(`* ${t(next ? 'sound.alreadyOn' : 'sound.alreadyOff')}`);
    }
    soundEnabled = next;
    persist({ sound: soundEnabled });
    return ui.addLine(`* ${t(soundEnabled ? 'sound.on' : 'sound.off')}`);
  }
  const greetName = isCloudPeer ? (cloud.self.name || cloud.self.login) : args.name;
  const displayPeerHost = isCloudPeer ? `@${cloud.peer}` : peerHost;
  const displayPeerPort = isCloudPeer ? null : peerPort;
  ui.addLine(formatGreeting({
    name: greetName, peerHost: displayPeerHost, peerPort: displayPeerPort, bindAddr: bindAddr || 'cloud', t,
  }));
  ui.addLine(`* ${t('help.hint')}`);
  if (isCloudPeer) {
    // `cloud.signedInAs` already came through the pre-UI notice.
  } else if (!identity.login && remembered) {
    ui.addLine(`* ${t('peer.fromRoster', {
      selector: args.peer, login: remembered.login, count: remembered.devices.length,
    })}`);
  } else if (!identity.login && !remembered && !looksLikeIp(args.peer)) {
    ui.addLine(`* ${t('peer.noRoster', { selector: args.peer })}`);
    for (const known of rosterSelectors(stateDir, { login: await selfLogin(), ips: ownIps })) {
      const options = [known.login, ...known.names, ...known.devices].join(', ');
      ui.addLine(`*   ${options}`);
    }
    ui.addLine(`* ${t('peer.rosterHint')}`);
  }
  if (identity.login) {
    const names = identity.devices.map((d) => `${d.host}${d.online ? '' : ' (offline)'}`);
    ui.addLine(`* ${t('peer.user', { login: identity.login, count: identity.devices.length, names: names.join(', ') })}`);
    ui.addLine(`* ${t('peer.anyDevice')}`);
    if (memory.lastHost()) ui.addLine(`* ${t('peer.lastTalked', { host: memory.lastHost(), address: memory.lastAddress() })}`);
  }
  if (bindAddr === '0.0.0.0') ui.addLine(`* ${t('warn.noTailnetIp')}`);

  // A mistyped tailnet address is indistinguishable from a peer that is simply
  // switched off: both sit at "connecting" forever. The local daemon knows the
  // difference, so ask it once at startup instead of leaving people waiting.
  // Only where the daemon can actually answer: without the CLI every address
  // looks unknown, and accusing a working peer of not existing is worse than
  // saying nothing.
  if (tsCli && looksLikeIp(peerHost)) {
    (async () => {
      if (await whois(peerHost)) return;
      ui.addLine(`* ${t('peer.unknownAddress', { address: peerHost })}`);
      try {
        const status = parseStatus(await runTailscale(tsCli, ['status', '--json']));
        const near = nearbyDevices(status, peerHost);
        if (near.length > 0) {
          const suggestions = near
            .map((d) => `${d.ip} (${d.host}${d.online ? '' : ', offline'})`)
            .join(', ');
          ui.addLine(`* ${t('peer.didYouMean', { suggestions })}`);
        }
      } catch {
        // No CLI, no suggestions — the warning above already stands on its own.
      }
      ui.addLine(`* ${t('peer.checkAddress')}`);
    })();
  }

  // The transcript is kept but not fully replayed: a screen full of yesterday
  // buries the conversation you actually opened the app for. A short, coloured
  // preview below covers the last few messages; /history asks for more.
  let historyShown = false;
  // How many messages already sat in the log the moment this session opened
  // it — the one at this index is the first this session wrote itself, so a
  // later /history can tell restored messages from ones just exchanged.
  let sessionBoundaryMessageCount = 0;
  // /clear now takes the restored lines with everything else, so the transcript
  // on disk becomes askable again — otherwise the help text's promise that the
  // history is kept would be true of the file and false of the client.
  function clearScreen() {
    historyShown = false;
    ui.clearHistory();
  }
  // The whole file, parsed into messages before anything is sliced off it —
  // never a pre-truncated tail. Grouping a multiline paste or ASCII art back
  // into one entry (parseLogEntries) only works if every one of its lines is
  // still there to group; slicing physical lines first, then parsing, could
  // cut such a message in half right at the edge of the requested count and
  // strand its back half without the header that names its sender.
  function loadLogEntries() {
    if (!logFile) return [];
    const nickname = memory.nickname();
    const raw = nickname ? rawDisplayLabel(lastPeerName) : null;
    // Only the most recent pre-nickname label is known here, so a peer whose
    // announced name changed more than once before /nick was set may still
    // show an older name further back in the file — see relabelLogLine.
    const lines = readLogTail(logFile, Infinity, secureStore);
    const relabeled = raw ? lines.map((line) => relabelLogLine(line, raw, nickname)) : lines;
    return parseLogEntries(relabeled);
  }
  // Shared by the connect-time preview and /history: each restored message
  // gets the same per-sender colour a live one would, instead of the flat
  // colour a plain log line gets — see logEntryMessage.
  function renderLogEntries(entries) {
    for (const entry of entries) {
      const message = logEntryMessage(entry, { selfName: args.name, aiName: ai.name });
      if (message) ui.addMessage(message);
      else ui.addLine(entry.text);
    }
  }
  // A P2P/LAN switch or /link re-key has no server to ask for history, only
  // this local log — so it is the only place that can show "what was already
  // here" for those transports. Reused for the same reason renderLogEntries
  // is: without it, a switch showed the tail with addLine's one flat system
  // colour instead of each sender's own, which is what made a fresh /p2p
  // conversation look washed out next to /cloud's server-replayed, coloured
  // history right after switching to it.
  function previewSwitchHistory() {
    const allEntries = loadLogEntries();
    if (allEntries.length === 0) return;
    ui.addLine(`* ── recent history ──`);
    renderLogEntries(allEntries.slice(-CONNECT_PREVIEW_MESSAGES));
  }
  // The relay — and the shared-history replica — hand back the whole
  // conversation on every open, while the local log already holds whatever
  // this machine saw live. Appending a replay wholesale grew that file by the
  // entire history each time the conversation was opened: two messages became
  // four, then six. The startup preview reads the same file, so every old
  // message was then shown once per time the conversation had ever been
  // opened — the transcript "duplicating" and "mixing up" messages. So a
  // replayed line is mirrored only when the file does not already carry it.
  // The cache is the file as it stood when the first replay landed; a switch
  // opens another log and drops it (see applyConversationSwitch).
  function mirrorReplayedLine(line) {
    if (!logFile) return;
    if (logMirror === null) logMirror = readLogTail(logFile, Infinity, secureStore).join('\n');
    if (logMirror.includes(line)) return;
    logMirror = logMirror === '' ? line : `${logMirror}\n${line}`;
    log.append(line);
  }
  function showHistory() {
    if (historyShown) return ui.addLine(`* ${t('log.alreadyShown')}`);
    if (!logFile) return ui.addLine(`* ${t('log.disabled')}`);
    const allEntries = loadLogEntries();
    if (allEntries.length === 0) return ui.addLine(`* ${t('log.empty', { file: logFile })}`);
    const restored = allEntries.slice(-HISTORY_MESSAGES);
    historyShown = true;
    ui.addLine(`* ${t('log.restored', { count: restored.length, file: logFile })}`);
    const { old, fresh } = splitLogTail(restored, {
      totalLines: allEntries.length, sessionStart: sessionBoundaryMessageCount,
    });
    renderLogEntries(old);
    if (fresh.length > 0) {
      ui.addSection(t('log.newSinceHeader'), []);
      renderLogEntries(fresh);
    }
    return ui.addLine(`* ${t('log.endOfHistory')}`);
  }
  // Captured before this session writes anything of its own — see
  // sessionBoundaryMessageCount above.
  {
    const allEntries = loadLogEntries();
    sessionBoundaryMessageCount = allEntries.length;
    // A cloud conversation gets its coloured, authoritative replay from the
    // relay a moment later (`replayCloudHistory`); printing the local mirror
    // as well showed every message twice, which is exactly why the /peer
    // switch path has skipped this preview for a cloud peer all along.
    if (allEntries.length > 0 && !isCloudPeer) {
      const preview = allEntries.slice(-CONNECT_PREVIEW_MESSAGES);
      ui.addSection(t('log.recentHeader'), []);
      renderLogEntries(preview);
      if (allEntries.length > preview.length) {
        ui.addLine(`* ${t('log.available', { count: allEntries.length })}`);
      }
    }
  }
  // Fetching the replica happens after the terminal is usable. It is bounded
  // and best-effort, so an unreachable OVH host never delays P2P startup.
  // Epoch-guarded like the relay's own history: /peer can be typed (or a
  // roster pill picked) while this request is still out, and the replica's
  // messages belong to the conversation that asked for them.
  const historyEpoch = conversationEpoch;
  void sharedHistory.restore().then((messages) => {
    if (historyEpoch !== conversationEpoch) return;
    if (messages.length === 0) return;
    ui.addSection('shared history', []);
    for (const message of messages) {
      if (message.id && ui.messageById(message.id)) continue;
      const bot = message.kind === 'ai';
      const self = !bot && message.name === args.name;
      ui.addMessage({
        id: message.id,
        name: message.name,
        text: message.text,
        ts: message.ts,
        self,
        bot,
        marker: self ? '✓' : null,
      });
      mirrorReplayedLine(formatLine(message.ts, message.name, message.text));
      rememberTurn(message.name, message.text, message.ts, bot ? 'ai' : 'human');
    }
  });
  replayCloudHistory();
  scheduleActivePromotion(isCloudPeer ? (cloud?.peer || args.peer) : args.peer);
  if (isCloudPeer) {
    setTimeout(() => preloadCloudHistories().catch(() => {}), 300);
  }
  // Compare against the version that last ran from this checkout, so a manual
  // `git pull` is reported exactly like an upgrade started with /update.
  const lastRun = readLastRun(stateDir);
  if (lastRun && lastRun.version !== VERSION) {
    const sv = shortVersion(VERSION);
    const allLines = [
      t('update.doneTitle'),
      t('update.doneVersion', { version: sv }),
    ];
    const changes = changesSince(lastRun.commit, { limit: 20 });
    if (changes.length === 0) {
      allLines.push(t('update.noChanges', { version: sv }));
    } else {
      const header = lastRun.version
        ? t('update.changesSince', { from: shortVersion(lastRun.version), version: sv })
        : t('update.changes', { version: sv });
      allLines.push(header);
      for (const change of changes) allLines.push(`  - ${change}`);
    }
    const box = makeUpdateBox(allLines);
    ui.addLine(box);
    for (const bLine of box.split('\n')) log.append(bLine);
  }


  writeLastRun(stateDir, { version: VERSION, commit: headCommit() });
  // Everything that blocks is behind us: the greeting is on screen, the last-run
  // file is written, the git call is done. Now the sweep gets a loop that can
  // paint one frame at a time, which is the only way it is an animation rather
  // than a finished picture — and when it ends the band decides what comes next.
  if (startupLogo.length > 0) {
    setImmediate(() => sweepBand(startupLogo));
  }

  rz.on('took-over', () => {
    if (sysmsgEnabled) ui.addLine(`* ${t('port.tookOver')}`);
    ui.setStatus('connecting…');
  });
  rz.on('status', ({ key, params }) => {
    // Leave the note only once the port is actually ours.
    if (key === 'rz.listening') {
      const bound = rz.boundPort();
      if (bound) {
        listenerPort = bound;
        writeListenerPid(stateDir, bound, process.pid, peerKey);
      }
    }
    if (sysmsgEnabled || key === 'rz.listenError' || key === 'core.storageFailed') {
      ui.addLine(`* ${t(key, params)}`);
    }
  });
  if (outbox.size() > 0) {
    ui.addLine(`* ${t('outbox.pending', { count: outbox.size() })}`);
  }
  const typing = createTypingSignal({
    send: (state) => {
      // The frame to the peer is never withheld — they always know when this
      // side is typing, the same way they always know when the AI is. What
      // /typing off actually withholds is purely local: this machine's own
      // "Alice typing" on its own composer rule, for the person who finds
      // their own name there redundant rather than useful.
      if (typingEnabled) ui.setSelfTyping(state === 'start');
      rz.sendFrame({ t: 'typing', state });
    },
  });
  // The band is also the screensaver, and presence already knows when nobody is
  // at the keyboard — that is what it tells the peer — so it hangs off the same
  // signal instead of inventing a second idle clock.
  const presence = createPresenceSignal({
    send: (state) => {
      rz.sendFrame({ t: 'focus', state });
      // Back from away — at least as long as /saver after is set to, so the
      // screen has not been looked at in a while: the logo draws itself again
      // instead of merely reappearing. Coming back from idle is thirty
      // seconds and gets no ceremony, or the sweep would run every time a
      // sentence is paused.
      const returned = selfState === 'away' && state === 'active';
      selfState = state;
      syncAutoSaver();
      // Nobody is at the keyboard, which makes this the cheapest moment to let
      // go of transfers the peer offered and never finished: their bytes are
      // held in memory until something asks, and until now only a fresh offer
      // ever did.
      if (state === 'away') receiver.sweep();
      const rows = returned ? bandRows() : [];
      if (rows.length > 0) return sweepBand(rows);
      return paintBand();
    },
    // Without focus reporting there is no "left the room" signal, only "has not
    // typed for a while": on Termux the user reading a chat would read AWAY.
    noAway: !focusSupported,
    awayMs: saverAfterMinutes * 60000,
  });
  rz.on('caps', ({ focus, ai: peerAi, muted }) => {
    // Whether answers in this conversation are theirs. An older peer sends no
    // such flag and is taken to own nothing, so ours still answers.
    peerHasAi = peerAi === true;
    const who = currentPeerLabel;
    // Silence with no explanation is the worst of the possible outcomes: a
    // question is asked, nothing comes back, and nothing on screen says whether
    // the AI is thinking, broken or switched off. Said on the change, once.
    if (muted !== peerAiMuted) {
      peerAiMuted = muted;
      ui.addLine(`* ${t(muted ? 'ai.peerMuted' : 'ai.peerUnmuted', { peer: who })}`);
    }
    // A claim left on screen from an earlier session outlives the truth: the
    // peer may have updated since. Say when it changes instead of letting the
    // transcript contradict the header.
    if (focus) {
      if (peerFocusReported) {
        peerFocusReported = false;
        ui.addLine(`* ${t('caps.focusGained', { peer: who })}`);
      }
      peerFocus = true;
      return;
    }
    peerFocus = false;
    if (peerFocusReported) return;
    peerFocusReported = true;
    ui.addLine(`* ${t('caps.noFocus', { peer: who })}`);
    ui.addLine(`* ${t('caps.noFocusEffect')}`);
  });
  rz.on('unread', ({ from, text, ts, count: serverCount }) => {
    const activeTarget = isCloudPeer ? (cloud?.peer || args.peer) : args.peer;
    const cleanFrom = String(from ?? '').replace(/^@/, '').toLowerCase();
    const cleanActive = String(activeTarget ?? '').replace(/^@/, '').toLowerCase();
    if (!cleanFrom || cleanFrom === cleanActive || !text) return;
    touchPeerRecency(from, ts);
    const count = Number.isFinite(serverCount) && serverCount > 0
      ? serverCount
      : (unreadPeers.get(from)?.count ?? unreadPeers.get(`@${from}`)?.count ?? unreadPeers.get(cleanFrom)?.count ?? 0) + 1;
    const notice = backgroundUnreadNotice(from, count, t);
    const unreadTs = ts || Date.now();
    unreadPeers.set(from, { count: notice.count, ts: unreadTs });
    unreadPeers.set(`@${from}`, { count: notice.count, ts: unreadTs });
    unreadPeers.set(cleanFrom, { count: notice.count, ts: unreadTs });
    updateUnreadHeader();
    ring(notice.notification);
    ui.addLine(notice.line);
  });
  function applyCloudReadWatermark(peer, readTs) {
    if (!peer || !Number.isFinite(readTs) || readTs <= 0) return;
    const upTo = Math.max(ownReadWatermarks.get(peer) || 0, readTs);
    ownReadWatermarks.set(peer, upTo);
    const info = unreadPeers.get(peer) || unreadPeers.get(`@${peer}`);
    const newestPending = peer === String(isCloudPeer ? cloud?.peer : args.peer).replace(/^@/, '')
      && [...unread.values()].some((ts) => ts > upTo);
    if (!newestPending && (!info || (info.ts || 0) <= upTo)) clearUnreadForPeer(peer);
    const active = isCloudPeer ? cloud?.peer : args.peer;
    if (peer === String(active).replace(/^@/, '')) {
      for (const [id, ts] of unread) if (ts <= upTo) unread.delete(id);
    }
    updateUnreadHeader();
  }
  rz.on('read-sync', ({ peer, readTs }) => applyCloudReadWatermark(peer, readTs));
  rz.on('read-accepted', ({ peer, readTs }) => applyCloudReadWatermark(peer, readTs));

  // ---- Подтверждение сервера (durable-ack) --------------------------------
  //
  // Over the cloud a write reaching the socket proves nothing: the hub can drop
  // the frame over its own budget, or the socket can die between the write and
  // the server's answer. The terminal used to take the write as delivery, mark
  // the message ✓ and drop it from the outbox — so a message that never reached
  // the server looked exactly like one that had, and the only copy of it was in
  // a log file. `message-accepted` is the server's actual promise (the message
  // is committed to its journal), and the entry now stays in the durable outbox
  // until that promise arrives, or until the peer's own ack proves the server
  // had it just as well.
  const CLOUD_ACK_RETRY_MS = 3_000;
  const CLOUD_ACK_TIMEOUT_MS = 20_000;
  const cloudAwaiting = new Map(); // id -> { text, ts, deadline }
  let cloudAckTimer = null;

  const cloudDurableAck = () => Boolean(isCloudPeer && rz.caps?.has?.('durable-ack'));

  function armCloudAckTimer() {
    if (cloudAckTimer !== null) return;
    cloudAckTimer = setInterval(retryCloudAwaiting, CLOUD_ACK_RETRY_MS);
    cloudAckTimer.unref?.();
  }

  function awaitCloudAcceptance(id, text, ts) {
    if (!id) return;
    cloudAwaiting.set(id, { text, ts, deadline: Date.now() + CLOUD_ACK_TIMEOUT_MS });
    armCloudAckTimer();
  }

  // The server has the message: the queue entry is over, whatever its state, and
  // the row stops claiming to be on its way. Idempotent — `message-accepted`,
  // the peer's `ack` and its `read` can each arrive first for the same id.
  function settleCloudAcceptance(id) {
    if (!id) return false;
    const known = cloudAwaiting.delete(id);
    const queued = outbox.remove(id);
    if (!known && !queued) return false;
    ui.setMessageMarker(id, '✓');
    if (cloudAwaiting.size === 0 && cloudAckTimer !== null) {
      clearInterval(cloudAckTimer);
      cloudAckTimer = null;
    }
    return true;
  }

  function retryCloudAwaiting() {
    const now = Date.now();
    for (const [id, entry] of [...cloudAwaiting]) {
      if (entry.deadline > now) continue;
      // Re-sending under the same id is what makes this safe: the server answers
      // a repeat of a message it already has with the same `message-accepted`
      // (`relay` in src/cloud/hub.js), so a lost receipt costs a round trip and
      // never a duplicate.
      if (!rz.send(entry.text, entry.ts, id)) continue;
      entry.deadline = now + CLOUD_ACK_TIMEOUT_MS;
    }
  }

  rz.on('accepted', ({ id }) => { settleCloudAcceptance(id); });

  // ---- Лента аккаунта (sync-v1) -------------------------------------------
  //
  // The terminal's own view of a conversation is a cache file, and it was only
  // ever written by frames that arrived while the socket was up: a message read
  // on the phone, an edit made in the browser, the messages of a conversation
  // nobody had open — none of them reached this side until the conversation was
  // switched to (or the process restarted, which replayed the cache and then
  // fetched history). The feed is the durable account log, so the terminal pages
  // through it from a cursor and re-reads exactly the conversations it names.
  const SYNC_PAGE_LIMIT = 200;
  const SYNC_REFRESH_DEBOUNCE_MS = 500;
  let cloudSyncCursor = 0;
  let cloudSyncLoaded = false;
  let cloudSyncInFlight = false;
  const cloudSyncPeers = new Set();
  let cloudSyncRefreshTimer = null;

  function cloudSyncFile() {
    const login = String(cloud?.self?.login ?? '').replace(/^@/, '').toLowerCase();
    if (!login) return null;
    return path.join(stateDir, 'cloud-sync', `${login}.json`);
  }

  function loadCloudSyncCursor() {
    if (cloudSyncLoaded) return;
    cloudSyncLoaded = true;
    const file = cloudSyncFile();
    if (!file) return;
    try {
      const parsed = JSON.parse(secureStore.read(file).toString('utf8'));
      if (Number.isFinite(parsed?.cursor) && parsed.cursor > 0) cloudSyncCursor = parsed.cursor;
    } catch (error) {
      if (error.code !== 'ENOENT' || fs.existsSync(file)) throw error;
      // First run has no cursor; begin from the start of the server log.
    }
  }

  function saveCloudSyncCursor(cursor) {
    const file = cloudSyncFile();
    if (!file) return;
    void fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      .then(() => secureStore.write(file, Buffer.from(JSON.stringify({ cursor }))))
      .catch((error) => notice(`Cloud sync cursor write failed: ${error.message}`));
  }

  function startCloudSync() {
    if (!isCloudPeer || !cloud?.api) return;
    if (!rz.caps?.has?.('sync-v1')) return;
    loadCloudSyncCursor();
    if (cloudSyncInFlight) return;
    cloudSyncInFlight = true;
    rz.sendSync(cloudSyncCursor, SYNC_PAGE_LIMIT);
  }

  rz.on('sync-nudge', () => startCloudSync());

  rz.on('sync-page', (page) => {
    if (!isCloudPeer) return;
    if (page.reset) {
      cloudSyncCursor = 0;
      saveCloudSyncCursor(0);
    }
    for (const event of page.events) applyCloudSyncEvent(event);
    if (Number.isFinite(page.cursor) && page.cursor > 0) {
      cloudSyncCursor = page.cursor;
      saveCloudSyncCursor(cloudSyncCursor);
    }
    if (page.more) {
      rz.sendSync(cloudSyncCursor, SYNC_PAGE_LIMIT);
      return;
    }
    cloudSyncInFlight = false;
    scheduleCloudSyncRefresh();
  });

  function applyCloudSyncEvent(event) {
    if (!event || typeof event.peer !== 'string' || event.peer === '') return;
    const peer = event.peer;
    if (event.kind === 'read') {
      if (event.self) {
        applyCloudReadWatermark(peer, event.readTs);
        return;
      }
      // The peer read this account's own messages up to `readTs`. The terminal's
      // marks are keyed by message id, so the watermark is turned into the newest
      // own message it covers — `markReadUpTo` then raises everything above it,
      // which is the same rule the live `read` frame follows.
      const readTs = Number.isFinite(event.readTs) ? event.readTs
        : (Number.isFinite(event.ts) ? event.ts : 0);
      const own = loadCloudCache(peer).filter((msg) => msg.self && Number.isFinite(msg.ts) && msg.ts <= readTs);
      const newest = own[own.length - 1];
      if (newest?.id) ui.markReadUpTo(newest.id);
      return;
    }
    // Anything with content — a message, an edit, a delete, a reaction — makes
    // the cached copy of that conversation stale rather than wrong, and the
    // terminal already owns two ways to re-read one: the open conversation is
    // replayed from `/api/history` (`replayCloudHistory`), and a cached one is
    // refreshed the way the startup preload does it. Both are coalesced into one
    // pass, because a burst of events names the same conversation.
    cloudSyncPeers.add(peer);
    scheduleCloudSyncRefresh();
  }

  function scheduleCloudSyncRefresh() {
    if (cloudSyncPeers.size === 0 || cloudSyncRefreshTimer !== null) return;
    cloudSyncRefreshTimer = setTimeout(() => {
      cloudSyncRefreshTimer = null;
      void refreshSyncedConversations();
    }, SYNC_REFRESH_DEBOUNCE_MS);
    cloudSyncRefreshTimer.unref?.();
  }

  async function refreshSyncedConversations() {
    const peers = [...cloudSyncPeers];
    cloudSyncPeers.clear();
    const active = isCloudPeer ? (cloud?.peer || args.peer) : args.peer;
    for (const peer of peers) {
      if (shuttingDown) return;
      if (peer === active) {
        // The open conversation has its own replay, which re-renders from the
        // server's answer; nothing else may write to that transcript.
        replayCloudHistory();
        continue;
      }
      if (!cloud?.api?.history) return;
      try {
        const result = await cloudCacheSession.refresh(peer, () => cloud.api.history(peer, 100, { media: 'ref' }));
        if (result) {
          const last = result.messages[result.messages.length - 1];
          if (last?.ts) touchPeerRecency(peer, last.ts);
        }
      } catch {
        // Unreachable server: the cursor is already stored, so the next nudge
        // (or the next session) offers the same conversations again.
      }
    }
    updateRosterBar();
  }
  rz.on('reply-reminder', ({ peer: reminderPeer }) => {
    const label = (() => {
      const user = cloud?.users?.find((u) => u.login === reminderPeer);
      return user ? (user.alias || user.name || reminderPeer) : reminderPeer;
    })();
    ui.addLine(`* ${t('later.due', { peer: label })}`);
    ring(t('later.due', { peer: label }));
  });
  rz.on('users', ({ users: nextUsers }) => {
    if (cloud && Array.isArray(nextUsers)) {
      cloud.users = nextUsers;
      // An alias rides only on this account's own roster copy, so a nickname
      // changed on another of this account's devices — or cleared here — shows
      // up in this very frame. Repaint the open conversation from it instead of
      // waiting for a reconnect to notice the new label.
      if (isCloudPeer) {
        const reprised = resolveDisplayLabel(lastPeerName);
        if (reprised !== currentPeerLabel) {
          currentPeerLabel = reprised;
          ui.setPeerName(reprised);
        }
      }
      const currentTarget = isCloudPeer ? (cloud?.peer || args.peer) : args.peer;
      const cleanActive = String(currentTarget ?? '').replace(/^@/, '').toLowerCase();
      for (const u of nextUsers) {
        if (!u?.login) continue;
        const cleanLogin = String(u.login).replace(/^@/, '').toLowerCase();
        if (u.last?.ts) touchPeerRecency(cleanLogin, u.last.ts);
        if (u.pending === 0 || (cleanActive !== '' && cleanLogin === cleanActive)) {
          u.pending = 0;
          unreadPeers.delete(u.login);
          unreadPeers.delete(`@${u.login}`);
          unreadPeers.delete(cleanLogin);
        }
      }
      // A roster that no longer names the open contact is how this account's
      // *other* devices learn about a deletion (see the /remove contract): the
      // conversation is a thread the server refuses to move frames through now,
      // so it is closed here too. Saved Messages is never in this list and is
      // nobody's contact, so it is excluded by name.
      const openPeer = isCloudPeer ? (cloud.peer ?? null) : null;
      const ownLogin = cloud.self?.login ? String(cloud.self.login).toLowerCase() : null;
      const droppedOpenPeer = Boolean(openPeer)
        && String(openPeer).toLowerCase() !== ownLogin
        && !nextUsers.some((u) => String(u?.login ?? '').toLowerCase() === String(openPeer).toLowerCase());
      updateRosterBar();
      if (droppedOpenPeer) {
        // Deleting a contact on another device is silent by design — the other
        // person is never told — but this person deserves to know why the
        // conversation in front of them just closed.
        const closing = closeRemovedConversation();
        if (closing) void closing.then(() => ui.addLine(`* ${t('remove.peerGone', { peer: openPeer })}`));
      }
      preloadCloudHistories().catch(() => {});
    }
  });
  rz.on('typing', ({ state, name }) => ui.setPeerTyping(state === 'start', name));
  rz.on('focus', ({ state }) => ui.setPeerPresence(state));
  rz.on('wake', () => {
    const who = currentPeerLabel;
    ui.addLine(`* ${t('wake.incoming', { peer: who })}`);
    // A nudge is explicit and rate-limited, so make it audible even when the
    // window is in front; the bell stays local and honours no OS permissions.
    ring({ name: who, text: t('wake.notify') });
  });
  // The peer replayed the logo, so it runs here too — that is the whole point of
  // sending it. Their throttle is what keeps this from being a nuisance; ours
  // does not apply to a thing we did not ask for.
  rz.on('logo', () => {
    const rows = bandRows();
    if (rows.length > 0) {
      sweepBand(rows);
    }
    ui.addLine(`* ${t('logo.incoming', { peer: currentPeerLabel })}`);
  });
  let sessionOnlineTs = null;
  // A relay link drops and comes back for reasons that are none of the
  // reader's business — a phone locking, a tab sleeping, a proxy recycling a
  // tunnel. Narrating each cycle filled the transcript with «connected to
  // roman (web)» and buried the conversation. So a disconnection is announced
  // only once it has lasted long enough to be worth knowing about, and a
  // reconnection only when it brings news: a first connection, a different
  // peer, a different client version, or a return from an outage that was
  // announced. `lastConnectKey` is what «the same peer as before» means.
  // The address arbitration settled on, and the last measured round trip.
  // Both exist only so `/route` can answer «how does this actually get there»
  // without re-deriving it from the transport.
  let lastRemoteAddress = null;
  let lastRttMs = null;
  let lastConnectKey = null;
  let disconnectNotice = null;
  let disconnectAnnounced = false;
  let sentMessageCount = 0;
  let receivedMessageCount = 0;
  let lastPeerMessage = null;
  const pendingPings = new Map();

  rz.on('offline', () => {
    sessionOnlineTs = null;
    for (const [, { timer }] of pendingPings) clearTimeout(timer);
    pendingPings.clear();
    peerFocus = null; // unknown again until the next hello
    peerFocusReported = false; // a fresh session may report its focus anew
    lastPeerVersion = null; // unknown again until the next hello
    lastRemoteAddress = null;
    lastRttMs = null;
    ui.setPeerClient(''); // unknown again until the next hello, same as the version it comes from
    peerHasAi = false; // their client's AI is unclaimed again until the next caps
    // Reset alongside it, so a reconnect that arrives muted says so once more
    // rather than staying silent because the last session already mentioned it.
    peerAiMuted = false;
    peerSupportsAi = null; // and whether it knows the frame is unknown again
    peerSupportsFiles = null; // as is whether it can be sent a file at all
    peerSupportsLogo = null;
    peerSupportsHoliday = null;
    // Nobody on the other end again: the cat goes back to sleep.
    peerHere = false;
    paintBand();
    ui.clearPeerTyping();
    ui.setPeerPresence(null); // presence is unknown again until the peer returns
    // Whatever was half-received is now unfinishable: the chunks that would
    // have completed it went down with the channel, and a reconnect starts the
    // offer again from the beginning. Holding the buffers would only cost memory
    // for the rest of the session and refuse the retry for being one too many.
    receiver.abortAll();
  });
  rz.on('holiday', ({ on }) => {
    applyHoliday(on);
    ui.addLine(`* ${t(on ? 'holiday.incomingOn' : 'holiday.incomingOff', {
      peer: currentPeerLabel,
    })}`);
  });
  rz.on('online', async ({ peerName, peerVersion, remoteAddress }) => {
    sessionOnlineTs = Date.now();
    lastPeerName = peerName;
    currentPeerLabel = resolveDisplayLabel(peerName);
    // A reconnect on a new version is the peer finishing an update. Saying so
    // closes the loop we opened by asking them to: otherwise the only evidence
    // is a version number in a line about connecting.
    if (seenPeerVersion && peerVersion && peerVersion !== seenPeerVersion) {
      ui.addLine(`* ${t('peer.updated', {
        peer: peerName, from: seenPeerVersion, to: peerVersion,
      })}`);
      if (peerVersion === VERSION) {
        ui.addLine(`* ${t('peer.updatedMatch', { version: VERSION })}`);
      }
    }
    if (peerVersion) seenPeerVersion = peerVersion;
    lastPeerVersion = peerVersion ?? null;
    // Over the relay a missing version is not evidence of an old client — see
    // peerCapabilities. On a direct connection it is: no version reported means
    // a client older than version reporting itself.
    const versionUnknownOverCloud = !peerVersion && onCloudTransport();
    const caps = peerCapabilities(peerVersion, { overCloud: versionUnknownOverCloud });
    peerSupportsFiles = caps.files;
    peerSupportsAi = caps.ai;
    peerSupportsLogo = caps.logo;
    peerSupportsHoliday = caps.holiday;
    peerHere = true;
    paintBand();
    // Only the channel that actually won arbitration is worth calling back.
    // Termux has no Tailscale CLI, so a roster-resolved login must remember the
    // live address too; otherwise the peer's next device announcement can put a
    // stale shared-node address first and every later launch dials that dead route.
    lastRemoteAddress = remoteAddress ?? null;
    if (peerLogin && remoteAddress) {
      rz.setTarget(remoteAddress, args.port);
      memory.remember({ host: peerName, address: remoteAddress });
    }
    ui.setPeerName(currentPeerLabel);
    ui.setStatus('online');
    const displayVersion = isWebVersion(peerVersion) ? ' (web)' : (peerVersion ? ` (v${peerVersion})` : '');
    ui.setPeerClient(isWebVersion(peerVersion) ? 'web' : (peerVersion ? 'cli' : ''));
    const connectKey = `${currentPeerLabel}\u0000${peerVersion ?? ''}`;
    if (disconnectNotice) {
      // Back before the outage was even worth mentioning.
      clearTimeout(disconnectNotice);
      disconnectNotice = null;
    }
    const worthSaying = lastConnectKey !== connectKey || disconnectAnnounced;
    lastConnectKey = connectKey;
    disconnectAnnounced = false;
    if (worthSaying) {
      ui.addLine(`* ${t('peer.connected', { peer: currentPeerLabel })}${displayVersion}`);
    }
    if (peerVersion === VERSION) updateBannerGuard.clear();
    // `versionUnknownOverCloud` above, for the same reason: a browser peer that
    // is looking at another conversation never sends a hello at all, so the
    // "ask them to update" line fired at people running the newest web build
    // there is.
    if (!isWebVersion(peerVersion) && !versionUnknownOverCloud) {
      if (peerVersion && isAtLeast(peerVersion, VERSION) && peerVersion !== VERSION) {
        showUpdateBanner(peerVersion);
      } else {
        const notice = versionNotice(VERSION, peerVersion, currentPeerLabel, t);
        if (notice) ui.addLine(notice);
      }
      // A peer behind us cannot see our version in their own transcript, so tell
      // them outright instead of hoping they read a mismatch warning.
      if (peerVersion && isAtLeast(VERSION, peerVersion) && VERSION !== peerVersion) {
        rz.sendFrame({ t: 'update', version: VERSION });
        ui.addLine(`* ${t('update.pushed', { peer: peerName })}`);
      }
    }
    // Tell the peer what this terminal can do, so a missing ✓✓ is explained
    // rather than mysterious. Presence is only claimed once it can be observed.
    announcedFocus = ui.focusTracked();
    sendCaps();
    // Tell the peer which machines are ours, so a client without the CLI can
    // dial us by name instead of memorising addresses.
    if (tsCli) announceOwnDevices();
    if (ui.focusTracked()) rz.sendFrame({ t: 'focus', state: presence.current() });
    flushOutbox();
    scheduleMarkRead();
    // The link is up and subscribed: this is where the account feed is asked for
    // everything that happened while the terminal was away, and where a nudge
    // that arrives later is answered from.
    startCloudSync();
  });

  // Entries a classic run left in the outbox, handed to the native core's own
  // durable queue: id -> the outbox that holds it, so the entry is removed from
  // the right file even if the conversation was switched in between.
  const coreHandover = new Map();

  // Drafts written while the link was down leave the moment the relay says the
  // account on the other end is online. The server queues messages for a peer
  // who is reading another conversation, so waiting for the peer's own hello
  // (see `present` below) held them on this disk for a greeting that only ever
  // arrives when they open this very conversation.
  function flushOutbox() {
    const waiting = outbox.size();
    if (waiting === 0) return;
    // Under the native core an entry left over from a classic run goes into the
    // core's durable queue under its own id, and leaves this file only when the
    // core says it holds the message (the `receipt` handler below) — never on
    // the strength of a write, and never marked ✓ for what is merely queued.
    if (cloudSession?.isCore && onCloudTransport()) {
      for (const item of outbox.pending()) {
        if (!item.id || coreHandover.has(item.id)) continue;
        if (!rz.send(item.text, item.ts, item.id)) break;
        coreHandover.set(item.id, outbox);
      }
      return;
    }
    // Over a durable-ack cloud the queue cannot be drained by a successful
    // write, because a successful write is not an acceptance: each entry goes
    // out under its own id (`flushCloudOutbox` below) and leaves only when the
    // server confirms it.
    if (cloudDurableAck()) {
      flushCloudOutbox();
      return;
    }
    const delivered = outbox.flush((text, ts, id) => {
      if (!rz.send(text, ts, id)) return false;
      ui.setMessageMarker(id, '✓');
      log.append(formatLine(ts, args.name, text));
      archiveSharedMessage({ id, name: args.name, text, ts });
      return true;
    });
    ui.addLine(delivered === waiting
      ? `* ${t('outbox.delivered', { count: delivered })}`
      : `* ${t('outbox.partial', { delivered, waiting })}`);
  }

  /**
   * The cloud counterpart of `flushOutbox`, for a server that confirms
   * acceptance.
   *
   * Nothing is removed here: an entry that has been written goes back to waiting
   * for its receipt, and one whose receipt is already overdue is offered again —
   * under the same id, which is exactly what the server's idempotency needs to
   * answer a repeat with the receipt the first attempt lost. The message is the
   * queue's until the server says otherwise, which is why a process that dies
   * mid-send replays it instead of losing it.
   */
  function flushCloudOutbox() {
    const waiting = outbox.pending();
    if (waiting.length === 0) return;
    let written = 0;
    for (const item of waiting) {
      const overdue = cloudAwaiting.get(item.id);
      if (overdue && overdue.deadline > Date.now()) continue;
      if (!rz.send(item.text, item.ts, item.id)) break;
      written += 1;
      ui.setMessageMarker(item.id, '⧗');
      awaitCloudAcceptance(item.id, item.text, item.ts);
    }
    if (written > 0) {
      ui.addLine(`* ${t('outbox.delivered', { count: written })}`);
    }
  }

  // The relay's answer to «is that account online?» — the same fact the roster's
  // green dot is drawn from, and the only honest source for the header over the
  // cloud. The peer's hello, which carries their name and version, is not: a
  // client sitting in another conversation never sends one, and the CLI used to
  // wait for exactly that before saying anything but «connecting…», so a contact
  // the roster showed as online looked unreachable here for the whole session.
  rz.on('present', ({ present = false, peerName = null } = {}) => {
    if (present) {
      peerHere = true;
      sessionOnlineTs = Date.now();
      // The roster's name for them, which is all that is known before a hello.
      if (peerName) {
        currentPeerLabel = resolveDisplayLabel(peerName);
        ui.setPeerName(currentPeerLabel);
      }
      paintBand();
      ui.setStatus('online');
      flushOutbox();
      startCloudSync();
      return;
    }
    // Away, and said plainly: messages wait on the server, which is a different
    // situation from a direct connection that is being dialled. `offline` is
    // the word for it here — see the same choice in the `offline` handler.
    peerHere = false;
    sessionOnlineTs = null;
    paintBand();
    ui.setStatus('offline');
  });

  // Named after the machine, not the route: the same person can answer from a
  // laptop now and a phone in ten minutes, and that is worth seeing.
  let lastDevice = '';
  // Distinguishes a first approach from a return: only a lost channel is worth
  // calling reconnecting.
  let everConnected = false;
  let hiddenDeviceReported = false;
  rz.on('online', async ({ peerName, remoteAddress }) => {
    if (!remoteAddress) return;
    const seen = await whois(remoteAddress);
    const device = seen?.device ?? '';
    if (!device) {
      // Silence here reads as a bug. Say why the name is missing instead.
      if (!seen?.shared || hiddenDeviceReported) return;
      hiddenDeviceReported = true;
      ui.setPeerDevice('');
      if (sysmsgEnabled) ui.addLine(`* ${t('peer.deviceHidden', { peer: peerName, address: remoteAddress })}`);
      return;
    }
    ui.setPeerDevice(device);
    const key = lastDevice && lastDevice !== device ? 'peer.deviceChanged' : 'peer.device';
    lastDevice = device;
    if (sysmsgEnabled) ui.addLine(`* ${t(key, { peer: peerName, device, address: remoteAddress })}`);
  });
  // CONNECTING only while a call is actually open; the rest of the wait is spent
  // listening, which is what WAITING says.
  rz.on('reaching', ({ active }) => {
    if (rz.isOnline()) return;
    if (active) return ui.setStatus('connecting…');
    return ui.setStatus(isCloudPeer ? 'offline' : (everConnected ? 'reconnecting…' : 'waiting'));
  });
  rz.on('offline', () => {
    everConnected = true;
    ui.setStatus(isCloudPeer ? 'offline' : 'reconnecting…');
    // The status line already says «reconnecting…» the instant this happens,
    // so the transcript can afford to wait and see whether it matters.
    if (!sysmsgEnabled || disconnectNotice) return;
    disconnectNotice = setTimeout(() => {
      disconnectNotice = null;
      disconnectAnnounced = true;
      ui.addLine(`* ${t('peer.disconnected')}`);
    }, DISCONNECT_QUIET_MS);
    disconnectNotice.unref?.();
  });
  rz.on('devices', async ({ login, name, devices }) => {
    // A peer names its own login. When the CLI is here that claim is checkable
    // against the daemon, and a mismatch is dropped rather than believed.
    if (tsCli) {
      const address = rz.target().host;
      const seen = await whois(address);
      if (seen?.login && String(login ?? '').toLowerCase() !== seen.login.toLowerCase()) return;
    }
    const self = { login: await selfLogin(), ips: ownIps };
    if (isSelfAnnouncement({ login, devices }, self)) {
      // The peer announced our own login — the devices share it with us — so
      // this list is us, not someone to talk to. Prune whatever an older run
      // wrongly believed instead of remembering it again.
      forgetDevices(stateDir, login);
      return;
    }
    if (!rememberDevices(stateDir, login, devices, [name, lastPeerName].filter(Boolean))) return;
    const refreshed = lookupRoster(stateDir, login, self);
    rz.setTargets((refreshed?.devices ?? []).flatMap((device) => [
      ...device.ips.map((host) => ({ host, port: args.port })),
      ...(device.dns ? [{ host: device.dns, port: args.port }] : []),
    ]));
  });
  rz.on('update', ({ version }) => {
    // The hello comparison may already have shown this exact update. The
    // explicit frame is still useful for old clients, but never duplicates the
    // framed banner on a current one.
    if (showUpdateBanner(version ?? '?')) ring();
  });
  // The peer's own receipt proves the server had the message just as well as
  // `message-accepted` does — a device cannot acknowledge what the server never
  // committed — so both end the queue entry (see `settleCloudAcceptance`). But
  // the ack means more than the server's receipt: it is the peer's *device*
  // saying it holds the message, which is the delivered rung (✓✓), not the sent
  // one. The `read` below then raises it to read; a client that never acks just
  // leaves this rung unclaimed.
  rz.on('ack', ({ id }) => { settleCloudAcceptance(id); ui.setMessageMarker(id, '✓✓'); });
  rz.on('read', ({ id }) => { settleCloudAcceptance(id); ui.markReadUpTo(id); });
  // ---- Квитанции и история от нативного ядра --------------------------------
  //
  // Under the native core the marks are the core's: it keeps the send queue and
  // the receipt ladder (⧗ queued · ✓ sent · ✓✓ delivered · ✓✓ read · ⚠ failed),
  // and core-link.js withholds the peer's ack/read and the server's
  // message-accepted from the classic handlers above so nothing marks a row
  // twice. What the core stores is announced here and repainted from the store.
  const isOpenCorePeer = (peer) => Boolean(isCloudPeer && cloud?.peer && peer
    && String(peer).toLowerCase() === String(cloud.peer).toLowerCase());
  const failedHinted = new Set();
  rz.on('receipt', ({ peer, id, receipt }) => {
    // The core has the message: the classic outbox entry it was handed from is over.
    const owner = coreHandover.get(id);
    if (owner) {
      coreHandover.delete(id);
      owner.remove(id);
    }
    // An edit's carrier has no row; its fate is the edit's.
    if (receipt === 'failed' && coreEdits.fail(id)) return;
    if (receipt !== 'queued') coreEdits.done(id);
    if (!isOpenCorePeer(peer)) return;
    // Read is a watermark (everything above it was read too), the other rungs
    // belong to the one message — the same rule the classic ack/read follow.
    if (receipt === 'read') ui.markReadUpTo(id);
    else if (Object.hasOwn(RECEIPT_MARKERS, receipt)) ui.setMessageMarker(id, RECEIPT_MARKERS[receipt]);
    if (!ui.messageById(id)) scheduleCorePaint(); // a row this transcript never drew
    if (receipt === 'failed' && !failedHinted.has(id)) {
      failedHinted.add(id);
      ui.addLine(`* ${t('retry.hint')}`);
    }
  });
  rz.on('core-stored', ({ peer }) => {
    if (isOpenCorePeer(peer)) scheduleCorePaint();
  });
  rz.on('core-removed', ({ peer, ids }) => {
    if (!isOpenCorePeer(peer)) return;
    for (const id of ids) unread.delete(id);
    const gone = ui.removeMessages(ids);
    if (gone > 0 && showDeletedMessages) ui.addLine(`* ${t('del.marker')}`);
  });
  // A send that never made it into the core's queue: its row never was a
  // message, so it is taken back and the person is told why.
  rz.on('core-refused', ({ id, reason }) => {
    if (coreEdits.fail(id)) return; // an edit: its words go back, one line says so
    if (id) ui.removeMessages([id]);
    ui.addLine(`* ${t('core.refused', { reason })}`);
  });
  // A handed-over outbox entry the core already held (it took it on an earlier
  // run that ended before saying so): the message exists and is the core's, so
  // the outbox entry is over and the row is the store's to draw.
  rz.on('core-held', ({ peer, id }) => {
    const owner = coreHandover.get(id);
    if (owner) {
      coreHandover.delete(id);
      owner.remove(id);
    }
    if (isOpenCorePeer(peer)) scheduleCorePaint();
  });
  rz.on('message', ({
    name, text, ts, id, image, voice, replyTo, reactions, forwardedFrom, from,
  }) => {
    // The active peer is blocked: a frame that reached us anyway (a queued
    // relay delivery, a stale P2P socket) renders nothing and leaves no trace.
    if (isPeerBlocked()) return;
    const display = resolveDisplayLabel(name);
    const msgPeer = from || (isCloudPeer ? (cloud?.peer || args.peer) : args.peer);
    // A leading `@ ` is the other side saying "the person, not the AI": show
    const body = stripHumanMarker(text);
    lastPeerMessage = {
      text: body, ts: ts || Date.now(), voice: Boolean(voice), image: Boolean(image),
    };
    // and remember the line without the marker, and answer nothing — not even
    // a mention inside it.
    // Optional shared-history archival is not the transcript's identity store:
    // it is disabled by default and knows nothing about Cloud history replay.
    const duplicate = id && ui.messageById(id);
    if (!duplicate) {
      receivedMessageCount++;
      const line = formatLine(ts, display, body);
      ui.addMessage({
        id,
        name: display,
        text: forwardedFrom ? `${forwardLead(forwardedFrom)}\n${body}` : body,
        ts,
        self: false,
        replyTo,
        reactions,
        media: messageMediaKind(image, voice),
      });
      log.append(line);
      archiveSharedMessage({ id, name: display, text: body, ts });
      rememberTurn(display, body, ts);
      if (image) showInlineImage(image, id, msgPeer).catch(() => {});
      if (voice) showInlineVoice(voice, id, msgPeer).catch(() => {});
      if (body === text) {
        const taken = maybeAnswer(text, false, replyTo);
        if (!taken && !aiInFlight) maybeFeedback();
      }
      if (isCloudPeer) {
        appendCloudCacheMessage(msgPeer, {
          id, text: body, ts: ts || Date.now(), name: display,
          replyTo, reactions, image, voice, forwardedFrom,
        });
      }
    }
    touchPeerRecency(msgPeer, ts || Date.now());
    if (id) {
      rz.sendReceipt('ack', id);
      if ((ownReadWatermarks.get(msgPeer) || 0) < (ts || Date.now())) {
        unread.set(id, ts || Date.now());
      }
      // "Read" must mean a human has been looking at it for at least 3 seconds.
      if (ui.focusTracked() ? ui.isFocused() : false) {
        scheduleMarkRead(msgPeer);
      }
    }
    if (!duplicate) {
      notifyIfUnfocused({
        focused: ui.isFocused(),
        tracked: ui.focusTracked(),
        notifier: gatedNotifier,
        name: display,
        text: body,
      });
    }
  });
  rz.on('sync-outgoing', ({
    id, text, ts, image, voice, replyTo, reactions,
  }) => {
    if (isPeerBlocked()) return;
    if (!text && !messageMediaKind(image, voice)) return;
    if (id && ui.messageById(id)) return;
    const messageId = id || newMessageId();
    const body = stripHumanMarker(text);
    const outTs = ts || Date.now();
    touchPeerRecency(isCloudPeer ? cloud?.peer : args.peer, outTs);
    const line = formatLine(outTs, args.name, body);
    ui.addMessage({
      id: messageId,
      name: args.name,
      text: body,
      ts: outTs,
      self: true,
      marker: '✓',
      replyTo,
      reactions,
      media: messageMediaKind(image, voice),
    });
    log.append(line);
    archiveSharedMessage({ id: messageId, name: args.name, text: body, ts: outTs });
    rememberTurn(args.name, body, outTs, 'human');
    // Same as an incoming message: the attachment is saved and drawn, so this
    // account's own voice note is a card it can play rather than a caption.
    const ownPeer = isCloudPeer ? cloud?.peer : args.peer;
    if (image) showInlineImage(image, messageId, ownPeer).catch(() => {});
    if (voice) showInlineVoice(voice, messageId, ownPeer).catch(() => {});
    if (body === text && !aiInFlight) {
      maybeAnswer(body, true, replyTo);
    }
    if (isCloudPeer && cloud?.peer) {
      appendCloudCacheMessage(cloud.peer, {
        id: messageId, name: args.name, text: body, ts: outTs,
        self: true, replyTo, reactions, image, voice,
      });
    }
  });
  // The peer's client produced this, and their quota paid for it: show it,
  // remember it, answer nothing. A bot under a different name is simply another
  // voice in the room rather than our own past turn.
  rz.on('edit', ({ id, text }) => {
    ui.updateMessage(id, text);
  });
  rz.on('react', ({
    id, emoji, by, add,
  }) => {
    if (!ui.applyReaction(id, emoji, by, add) && add) {
      ui.addLine(`* ${t('react.received', { peer: by || currentPeerLabel, emoji })}`);
    }
  });
  rz.on('ai', ({
    name, text, ts, id, image, voice,
  }) => {
    if (isPeerBlocked()) return;
    if (id && ui.messageById(id)) return;
    touchPeerRecency(isCloudPeer ? (cloud?.peer || args.peer) : args.peer, ts || Date.now());
    ui.addMessage({ id, name, text, ts, self: false, bot: true });
    log.append(formatLine(ts, name, text));
    archiveSharedMessage({ id, name, text, ts, kind: 'ai' });
    rememberTurn(name, text, ts, name === ai.name ? 'ai' : 'human');
    const aiPeer = isCloudPeer ? (cloud?.peer || args.peer) : args.peer;
    if (image) showInlineImage(image, id, aiPeer).catch(() => {});
    if (isCloudPeer && cloud?.peer) {
      appendCloudCacheMessage(cloud.peer, {
        id, name, text, ts, kind: 'ai', bot: true, image, voice,
      });
    }
    if (voice) showInlineVoice(voice, id, aiPeer).catch(() => {});
    notifyIfUnfocused({
      focused: ui.isFocused(),
      tracked: ui.focusTracked(),
      notifier: gatedNotifier,
      name,
      text,
    });
  });
  // The peer revoked something they said. Their client has already taken it off
  // their own screen; this takes it off ours. Nothing is announced when nothing
  // matched — an id for a message this session never saw, or one already trimmed
  // off the head of the buffer, is not news.
  rz.on('del', ({ ids }) => {
    const gone = ui.removeMessages(ids);
    if (gone > 0 && showDeletedMessages) ui.addLine(`* ${t('del.marker')}`);
  });
  rz.on('pong', ({ id, rtt }) => {
    if (Number.isFinite(rtt)) lastRttMs = Math.round(rtt);
    if (id && pendingPings.has(id)) {
      const { resolve, timer } = pendingPings.get(id);
      clearTimeout(timer);
      pendingPings.delete(id);
      resolve({ rtt });
    }
  });

  async function pingPeer() {
    if (!rz.isOnline()) {
      ui.addLine(t('ping.offline', { peer: currentPeerLabel || peerHost }));
      return;
    }
    const isOlderPeer = lastPeerVersion && !isAtLeast(lastPeerVersion, PING_FRAME_VERSION);
    const appTimeoutMs = isOlderPeer ? 800 : 2500;
    const pingId = newMessageId();
    const sentTs = Date.now();
    const result = rz.sendPing(pingId, sentTs);
    if (!result) {
      ui.addLine(t('ping.offline', { peer: currentPeerLabel || peerHost }));
      return;
    }
    const timeoutPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingPings.delete(pingId);
        resolve({ timedOut: true });
      }, appTimeoutMs);
      pendingPings.set(pingId, { resolve, timer });
    });
    const pongResult = await timeoutPromise;
    if (!pongResult.timedOut) {
      let route = null;
      try {
        if (tsCli) {
          const status = parseStatus(await runTailscale(tsCli, ['status', '--json']));
          const socket = rz.activeSocket();
          route = inspectPeerRoute(status, peerHost, socket?.remoteAddress);
        }
      } catch {}
      if (!route) {
        const socket = rz.activeSocket();
        route = resolveRouteKind({ remoteIp: socket?.remoteAddress });
      }
      ui.addLine(t('ping.result', {
        peer: currentPeerLabel || peerHost,
        rtt: pongResult.rtt,
        route: formatRoute(route, t),
      }));
      return;
    }
    // Fallback: Tailscale layer ping (handles older peer versions or ping frame drops)
    const socket = rz.activeSocket();
    const targetIp = socket?.remoteAddress || peerHost;
    if (tsCli && targetIp) {
      const tsResult = await tailscalePingPeer(tsCli, targetIp);
      if (tsResult) {
        ui.addLine(t('ping.result', {
          peer: currentPeerLabel || peerHost,
          rtt: tsResult.rtt,
          route: formatRoute(tsResult.route, t),
        }));
        return;
      }
    }
    ui.addLine(t('ping.timeout', { peer: currentPeerLabel || peerHost }));
  }

  async function showStatus() {
    if (!rz.isOnline()) {
      ui.addLine(t('status.offline'));
      return;
    }
    const socket = rz.activeSocket();
    const uptimeMs = sessionOnlineTs ? Date.now() - sessionOnlineTs : 0;
    let route = null;
    if (isCloudPeer) {
      route = { kind: 'cloud', endpoint: cloud?.server || 'cloud' };
    } else {
      try {
        if (tsCli) {
          const status = parseStatus(await runTailscale(tsCli, ['status', '--json']));
          route = inspectPeerRoute(status, peerHost, socket?.remoteAddress);
        }
      } catch {}
      if (!route) {
        route = resolveRouteKind({ remoteIp: socket?.remoteAddress });
      }
    }
    const localEndpoint = isCloudPeer ? 'WebSocket (WSS)' : (socket ? `${socket.localAddress}:${socket.localPort}` : '—');
    const remoteEndpoint = isCloudPeer ? `@${cloud.peer} (${cloud?.server || 'cloud'})` : (socket ? `${socket.remoteAddress}:${socket.remotePort}` : peerHost);
    const txBytes = socket ? formatBytes(socket.bytesWritten) : '0 B';
    const rxBytes = socket ? formatBytes(socket.bytesRead) : '0 B';
    const outboxCount = outbox ? outbox.size() : 0;

    const peerClient = formatPeerClient(lastPeerVersion);
    const lastMsgFormatted = formatLastPeerMessage(lastPeerMessage, t);

    const lines = [
      t('status.header'),
      t('status.uptime', { uptime: formatDuration(uptimeMs) }),
      t('status.peer', { peer: currentPeerLabel || peerHost, endpoint: remoteEndpoint }),
      t('status.client', { client: peerClient }),
      t('status.local', { endpoint: localEndpoint }),
      t('status.route', { route: formatRoute(route, t) }),
      t('status.traffic', { tx: txBytes, txMsg: sentMessageCount, rx: rxBytes, rxMsg: receivedMessageCount }),
      t('status.lastMsg', { message: lastMsgFormatted }),
      t('status.outbox', { count: outboxCount }),
    ];
    ui.addLine(`* ${lines[0]}`);
    for (const line of lines.slice(1)) ui.addLine(`  ${line}`);
    return lines.join('\n');
  }

  function lockScreen() {
    const hasPass = Boolean(config.lockPassword);
    ui.showLockScreen({
      hasPass,
      t,
      verifyPassword: (entered) => {
        if (!config.lockPassword) return true;
        return verifyPassword(entered, config.lockPassword);
      },
      onUnlock: () => {
        if (ui.focusTracked() && ui.isFocused()) flushReads();
      },
    });
  }

  function switchPassword(arg) {
    const val = String(arg ?? '').trim();
    if (val.toLowerCase() === 'clear' || val.toLowerCase() === 'none') {
      config.lockPassword = null;
      writeConfig(stateDir, config);
      ui.addLine(`* ${t('pass.cleared')}`);
      return;
    }
    if (val !== '') {
      config.lockPassword = hashPassword(val);
      writeConfig(stateDir, config);
      ui.addLine(`* ${t('pass.set')}`);
      return;
    }
    if (config.lockPassword) {
      ui.addLine(`* ${t('pass.active')}`);
    } else {
      ui.addLine(`* ${t('pass.none')}`);
    }
  }
  async function sendVoiceNote(arg) {
    const raw = String(arg ?? '').trim();
    const backendChoice = /^backend(?:\s+(.+))?$/i.exec(raw);
    if (backendChoice) {
      const asked = backendChoice[1]?.trim();
      if (!asked) {
        ui.addLine(`* ${t('voice.backendCurrent', { backend: config.voiceBackend || 'auto' })}`);
        ui.addLine(`* ${t('voice.backendHint')}`);
        return undefined;
      }
      const backend = normaliseVoiceBackend(asked);
      if (!backend) {
        ui.addLine(`* ${t('voice.backendUnknown', { backend: asked })}`);
        return undefined;
      }
      config.voiceBackend = backend === 'auto' ? null : backend;
      writeConfig(stateDir, config);
      ui.addLine(`* ${t('voice.backendSet', { backend })}`);
      return undefined;
    }
    if (raw.toLowerCase() === 'devices' || raw.toLowerCase() === 'list') {
      const devs = await listAudioInputDevices();
      if (!devs.length) {
        ui.addLine(`* ${t('voice.noDevices')}`);
        return undefined;
      }
      ui.addLine(`* ${t('voice.devicesHeader')}`);
      const activeDev = config.micDevice || 'auto';
      for (const d of devs) {
        const isCurrent = d.index === activeDev || (activeDev === 'auto' && /microphone|mic|macbook|built-in/i.test(d.name));
        ui.addLine(`*   [${d.index}] ${d.name}${isCurrent ? ` ${t('voice.activeDevice')}` : ''}`);
      }
      ui.addLine(`* ${t('voice.devicesHint')}`);
      return undefined;
    }
    const devChoice = /^devices?\s+(.+)$/i.exec(raw);
    if (devChoice) {
      const chosen = devChoice[1].trim();
      if (chosen.toLowerCase() === 'auto' || chosen.toLowerCase() === 'default') {
        config.micDevice = null;
        writeConfig(stateDir, config);
        ui.addLine(`* ${t('voice.deviceAuto')}`);
        return undefined;
      }
      config.micDevice = chosen;
      writeConfig(stateDir, config);
      ui.addLine(`* ${t('voice.deviceSet', { device: chosen })}`);
      return undefined;
    }

    if (!rz.isOnline()) {
      ui.addLine(`* ${t('ping.offline', { peer: currentPeerLabel || peerHost })}`);
      return undefined;
    }
    const dur = Math.max(1, Math.min(VOICE_MAX_SECONDS, parseInt(raw, 10) || VOICE_DEFAULT_SECONDS));
    ui.addLine(`* ${t('voice.recording', { seconds: dur })}`);
    ui.addLine(`* ${t('voice.stopHint')}`);
    let voicePanelTimer = null;
    const voiceStartedAt = Date.now();
    const drawVoicePanel = () => {
      const elapsed = Math.min(dur, Math.floor((Date.now() - voiceStartedAt) / 1000));
      const clock = (value) => `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
      const levels = '░▒▓█';
      const waveform = Array.from({ length: 18 }, (_, index) =>
        levels[(elapsed * 3 + index * 7) % levels.length]).join('');
      ui.replaceLastLine(`* ● ${clock(elapsed)} [${waveform}] / ${clock(dur)} · /stop`);
    };
    const filesDir = args.filesDir || defaultFilesDir(os.homedir());
    fs.mkdirSync(filesDir, { recursive: true });
    const voiceFile = path.join(filesDir, `voice-${Date.now()}.wav`);
    try {
      const recordRes = await recordAudioBuffer({
        durationSec: dur,
        device: config.micDevice,
        backend: config.voiceBackend || 'auto',
        stateDir,
        // `/stop` (and only `/stop`) finishes the take early; the hook is
        // cleared in the `finally` below so a later `/stop` cannot try to
        // interrupt a recorder that has already exited.
        onStart: ({ stop }) => {
          voiceStop = stop;
          drawVoicePanel();
          voicePanelTimer = setInterval(drawVoicePanel, 250);
          voicePanelTimer.unref?.();
        },
      });
      const buffer = recordRes.payload;
      const parsed = parseWavPcm(buffer);
      const themed = resolveThemed(args);
      const waveCard = parsed ? formatVoiceCard(parsed.durationSec, parsed.waveform, { themed }) : '🎙 [Voice]';
      ui.addLine(`* ${waveCard}`);
      if (parsed?.isSilent) {
        ui.addLine(`* ${t('voice.micSilent', { device: recordRes.device || 'default' })}`);
        ui.addLine(`* ${t('voice.macPermHint')}`);
        // Silence was never persisted.
        return undefined;
      }
      secureStore.write(voiceFile, buffer);
      if (isCloudPeer) {
        // The cloud carries a voice note as base64 on the message frame, and
        // the hub refuses one over CLOUD_MEDIA_MAX_CHARS: at 16 kHz mono the
        // five minutes /voice offers is 12.8 MB encoded, so the longest notes
        // were recorded in full and then thrown away by the send-side check.
        // Halved to telephone rate they fit, which is the difference between a
        // long message and no message. The file on disk is rewritten too, so
        // /open and the peer hear the same thing.
        const fitted = fitWavForCloud(buffer, CLOUD_MEDIA_MAX_CHARS);
        if (fitted !== buffer) {
          secureStore.write(voiceFile, fitted);
          const rate = parseWavPcm(fitted)?.sampleRate ?? 0;
          ui.addLine(`* ${t('voice.fittedForCloud', { khz: Math.round(rate / 100) / 10 })}`);
        }
        await queueTransfer(
          path.basename(voiceFile),
          () => sendInlineVoice(voiceFile, path.basename(voiceFile), parsed?.durationSec ?? dur),
        );
      } else {
        await sendFile(voiceFile);
      }
    } catch (err) {
      ui.addLine(`* ${t('voice.error', { error: err.message || 'record failed' })}`);
      const detail = `${err.message ?? ''}\n${err.stderr ?? ''}`;
      if (/microphone permission denied/i.test(detail)) {
        ui.addLine(`* ${t('voice.macPermHint')}`);
        ui.addLine(`* ${t('voice.nativePermHint')}`);
      }
    } finally {
      if (voicePanelTimer) clearInterval(voicePanelTimer);
      voiceStop = null;
    }
    return undefined;
  }


  function flushReads() {
    if (unread.size === 0 || !canReadConversation()) return;
    let newest = null;
    let newestTs = -1;
    for (const [id, ts] of unread) {
      if (ts >= newestTs) {
        newest = id;
        newestTs = ts;
      }
    }
    if (!newest || !rz.sendReceipt('read', newest)) return;
    if (isCloudPeer && cloudSession?.caps?.has('read-ack-v1')) {
      // Keep the incoming ids until the server accepts, retrying while this
      // conversation remains viewed. Reconnect also schedules this same path.
      scheduleMarkRead();
    } else {
      unread.clear();
      const peer = isCloudPeer ? cloud?.peer : args.peer;
      clearUnreadForPeer(peer);
      updateUnreadHeader();
    }
  }

  ui.onFocusChange((isFocused) => {
    // The probe can miss — a terminal may answer too late or not at all — and a
    // real focus event proves the capability outright. Announcing it only at
    // connect time would leave the peer believing the first, wrong answer for
    // the rest of the session.
    if (!announcedFocus && ui.focusTracked()) {
      announcedFocus = true;
      sendCaps();
    }
    if (isFocused) {
      presence.focus();
      scheduleMarkRead();
    } else {
      presence.blur();
      cancelPendingRead();
    }
  });

  // Any key or mouse gesture means the person is at the keyboard this minute,
  // whatever the focus probe says.
  ui.onActivity(() => {
    readActivityAt = Date.now();
    presence.activity();
    if (unread.size > 0) scheduleMarkRead();
  });
  ui.onSaverWake(() => lockScreen());
  ui.onTyping(() => {
    readActivityAt = Date.now();
    typing.keystroke();
    if (unread.size > 0) scheduleMarkRead();
  });
  ui.onPeerPicker(() => switchPeer(''));
  // /retry: the newest message of the open conversation that ended on ⚠ goes
  // into the native core's queue again under the same id (the server is
  // idempotent), and its row turns ⧗ when the core confirms — the `receipt`
  // handler. The store, not the transcript, says which rows failed.
  function retryFailedMessage() {
    const session = cloudSession;
    if (!(isCloudPeer && cloud?.peer && session?.isCore)) return ui.addLine(`* ${t('retry.none')}`);
    let rows;
    try {
      rows = session.conversation(cloud.peer, CORE_HISTORY_ROWS);
    } catch (error) {
      return ui.addLine(`* ${t('core.storageFailed', { reason: error?.message ?? 'error' })}`);
    }
    const failed = rows.filter((row) => row.source === 'pending' && row.receipt === 'failed');
    const newest = failed[failed.length - 1];
    if (!newest) return ui.addLine(`* ${t('retry.none')}`);
    try {
      session.retry(cloud.peer, newest.id);
    } catch (error) {
      return ui.addLine(`* ${t('core.refused', { reason: error?.message ?? 'error' })}`);
    }
    return ui.addLine(`* ${t('retry.sent')}`);
  }
  // /verify, /trust, /backup — only under the native core, which is the only
  // transport that has end-to-end encryption to manage (src/e2ee-commands.js).
  const e2eeCommands = cloudSession?.isCore
    ? createE2eeCommands({
      getSession: () => cloudSession,
      getApi: () => cloud?.api ?? null,
      getPeer: () => (isCloudPeer && cloud?.peer) || null,
      getSelf: () => cloud?.self?.login ?? null,
      // The masked prompt /backup restore reads the recovery key from. The
      // headless stand-in has none, and the command then says so.
      promptSecret: typeof ui.promptSecret === 'function' ? (options) => ui.promptSecret(options) : null,
      // Indented lines (the emojis, the recovery key) are data, not notices.
      say: (line) => ui.addLine(line.startsWith(' ') ? line : `* ${line}`),
      t,
    })
    : null;
  if (e2eeCommands) {
    for (const [name, handler] of Object.entries(e2eeCommands.events)) rz.on(name, handler);
  }
  const chatCommandCtx = {
    shutdown, restartClient, ui, listFiles, openFile, sendFile, sendClipboardImage, sendWake,
    showHistory, sendText, selfUpdate, showVersion, showDiagnostics, showChangelog, reconnectPeer, switchPeer,
    showNetwork,
    switchPeerP2p, switchPeerCloud,
    switchLanguage, switchName, switchNickname, switchLink, switchLogging, switchTheme, switchTyping, switchHoliday,
    switchSound,
    switchNameBadge,
    switchRosterRows,
    showSettings, askAi, stopAi, clearScreen, showLogo, showSaver, pingPeer, showStatus,
    lockScreen, switchPassword, sendVoiceNote, runRemind: runRemindCommand, switchAutoupdate, switchSysmsg,
    runInvite, addFriend, blockPeer, unblockPeer, removePeer, deleteMessages, editLastMessage, reactLastMessage, replyToMessage, forwardMessage,
    markConversationUnread, remindReplyToMessage,
    showRoute, viewImage: viewFile, t,
    retryFailed: cloudSession?.isCore ? retryFailedMessage : null,
    e2ee: e2eeCommands,
  };
  const commandTable = new Map();
  for (const command of buildChatCommands(chatCommandCtx)) {
    commandTable.set(command.name, command);
    if (command.alias) commandTable.set(command.alias, command);
  }
  // except that AI_SPEECH_COMMANDS' sendText goes to emitAi instead — so
  // /happy run by the AI answers under its own name, never the person's.
  const aiCommandTable = new Map();
  for (const command of buildChatCommands({ ...chatCommandCtx, sendText: (text) => emitAi(text) })) {
    if (AI_SAFE_COMMANDS.includes(command.name)) aiCommandTable.set(command.name, command);
  }

  function sendText(text, { toHuman = false, replyTo = null, forwardedFrom = null } = {}) {
    // A pasted logfile is the realistic way to reach this ceiling. Such a
    // message cannot go on the wire — a peer running the same frame limit drops
    // the channel the moment it arrives — and it must not go to the outbox
    // either, which would retry it on every reconnect for the rest of the
    // session without ever delivering it. So it is refused here, where there is
    // someone to tell, and pointed at /send, which carries exactly this.
    if (messageTooLarge(text)) {
      ui.addLine(`* ${t('send.tooLarge', {
        size: formatBytes(text.length), limit: formatBytes(MAX_MESSAGE_CHARS),
      })}`);
      return false; // nothing was said, so the AI has nothing to answer
    }
    typing.stop(); // the draft just left the composer
    sentMessageCount++;
    // A leading `@ ` marks the line as the person's, not the AI's. The marker
    // still travels on the wire so the other client honours it, but nothing
    // the reader sees, remembers or logs carries it.
    text = replaceColonEmojis(text);
    if (autoEmoji) {
      text = replaceEmojis(text);
    }
    const body = toHuman ? stripHumanMarker(text) : text;
    const ts = Date.now();
    const id = newMessageId();
    touchPeerRecency(isCloudPeer ? cloud?.peer : args.peer, ts);
    const line = formatLine(ts, args.name, body);
    // Plain text on a conversation the native core carries goes into the core's
    // own durable queue: the row starts as ⧗ and its marks follow the core's
    // receipts, so none of the acceptance/outbox machinery below applies to it.
    // A reply, a forward or media still goes out as a raw frame the core does
    // not track, and keeps the classic marks.
    const viaCore = Boolean(cloudSession?.isCore) && onCloudTransport()
      && ((!replyTo && !forwardedFrom) || rz.canSealed());
    const sent = sendTextOverTransport(rz, {
      id, ts, text, replyTo, forwardedFrom,
    });
    if (sent) {
      // Over a durable-ack server the write is not the send: the message is on
      // the wire and its receipt has not come back, so the row shows the clock
      // and the entry stays in the durable outbox until `message-accepted` (or
      // the peer's own ack) proves the server committed it. A terminal that
      // cannot tell those apart marks lost messages ✓.
      const durable = !viaCore && cloudDurableAck();
      const startMarker = viaCore || durable ? '⧗' : '✓';
      ui.addMessage({
        id,
        name: args.name,
        text: forwardedFrom ? `${forwardLead(forwardedFrom)}\n${body}` : body,
        ts,
        self: true,
        marker: startMarker,
        replyTo,
      });
      log.append(line);
      archiveSharedMessage({ id, name: args.name, text: body, ts });
      if (isCloudPeer && cloud?.peer) {
        appendCloudCacheMessage(cloud.peer, {
          id, name: args.name, text: forwardedFrom ? `${forwardLead(forwardedFrom)}\n${body}` : body,
          ts, self: true, replyTo, forwardedFrom, marker: startMarker,
        });
      }
      if (durable) {
        // The queue is the sender's only copy of an unconfirmed message, so it
        // is written before the receipt is waited for: a process killed in
        // between replays the same id on the next connect.
        outbox.add(text, ts, id);
        awaitCloudAcceptance(id, text, ts);
      }
    } else if (replyTo || forwardedFrom) {
      ui.addLine(`* ${t('reply.offline', { peer: currentPeerLabel })}`);
      return false;
    } else {
      // Keep it and send on reconnect instead of losing what was typed.
      const queued = outbox.add(text, ts, id);
      ui.addMessage({ id, name: args.name, text: body, ts, self: true, marker: '⧗' });
      ui.addLine(`* ${t('outbox.queued', { count: queued })}`);
    }
    // Said out loud in the room, so the AI hears it whether it was addressed or
    // not — the context is what lets it tell the two of them apart.
    rememberTurn(args.name, body, ts);
    // Explicit /ai reads this result so it never starts a second request.
    const taken = toHuman ? false : maybeAnswer(text, true, replyTo);
    if (!toHuman && !taken && !aiInFlight) maybeFeedback();
    return taken;
  }

  ui.setCommands([...commandTable.values()]
    .filter((command, index, all) => all.indexOf(command) === index));

  ui.onInput((text) => {
    const command = parseCommand(text);
    if (command) {
      const entry = commandTable.get(command.name);
      if (!entry) {
        ui.addLine(`* ${t('cmd.unknown', { name: command.name })}`);
        return undefined;
      }
      entry.run(command.arg);
      return undefined;
    }
    // A leading `@ ` is the way to write to the person when the AI spoke last:
    // the marker travels with the line so the other client honours it, but
    // the message itself is the text behind it.
    const body = stripHumanMarker(text);
    if (body === '') return undefined; // a bare @ is a marker with nothing after it
    sendText(text, { toHuman: body !== text });
    if (looksLikePath(body)) {
      ui.addLine(`* ${t('send.wasText')}`);
    }
    return undefined;
  });
  // A dragged file should transfer, not paste its name into the draft.
  ui.onPasteText((text) => {
    const paths = droppedPaths(text, (candidate) => {
      try {
        const file = expandHome(candidate);
        return fs.statSync(fs.existsSync(file) ? file : secureStore.fileFor(file)).isFile();
      } catch {
        return false;
      }
    });
    if (paths.length === 0) return false;
    if (paths.length > 1) ui.addLine(`* ${t('send.dropped', { count: paths.length })}`);
    for (const candidate of paths) sendFile(candidate);
    return true;
  });
  // Selecting inside the app is the only way to copy more than one screen: the
  // terminal cannot see past the page the alternate screen shows it.
  ui.onOpenImage((file) => openPath(file));
  ui.onOpenLink((url) => openPath(normaliseUrl(url)));
  ui.onCopy(async (text, count) => {
    const copied = await writeClipboardText(text);
    ui.addLine(`* ${copied ? t('copy.done', { count }) : t('copy.failed')}`);
  });
  ui.onPasteImage(() => { sendClipboardImage(); });
  // Same toggle as /mouse, but reachable from the keyboard (Ctrl+T).
  ui.onMouseToggle(() => {
    const on = ui.setMouseCapture(!ui.isMouseCaptured());
    ui.addLine(`* ${on ? t('mouse.on') : t('mouse.off')}`);
  });
  ui.onQuit(shutdown);
  // Every way a terminal can ask us to stop. Without the full set a displaced or
  // closed-window instance dies dirty: the screen is not restored and its note
  // is left behind to misname the conversation for the next client. Windows in
  // particular sends no terminal SIGTERM at all — Ctrl+Break arrives as
  // SIGBREAK and closing the console window arrives as SIGHUP.
  installSignalHandlers(shutdown);
}

// Run only when invoked directly (not when imported by tests).
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// A path that cannot be resolved is not a reason to refuse to start: a symlink
// deleted underneath us or a launcher passing something odd used to end the
// process here, before any of the reporting below existed.
let entry = '';
try {
  entry = process.argv[1] ? realpathSync(process.argv[1]) : '';
} catch {
  entry = process.argv[1] ?? '';
}
if (entry === fileURLToPath(import.meta.url)) {
  // main() installs its own safety net once it knows where the state directory
  // is; this catches the sliver before that, where a plain message on a terminal
  // nothing has taken over yet is the whole of what is useful.
  main().catch((error) => {
    console.error(`tailchat could not start: ${error?.stack ?? error}`);
    process.exit(1);
  });
}
