import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createSecureStore, openDeviceStore } from '../src/secure-store.js';
import { EMOJIS } from '../src/emoji.js';
import { normaliseSelfName, SELF_NAME_MAX, hashPassword, verifyPassword } from '../src/config.js';
import {
  parseArgs, resolveSelfName,
  formatLine,
  relabelLogLine,
  parseLogEntries,
  logEntryMessage,
  splitLogTail,
  resolveThemed,
  resolveThemeName,
  chatCommands,
  AI_SAFE_COMMANDS,
  AI_SPEECH_COMMANDS,
  formatGreeting,
  versionNotice, updateBanner, createUpdateBannerGuard,
  parseCommand,
  looksLikePath,
  isAtLeast,
  peerCapabilities,
  cliFlags,
  usageText,
  queueSaverPlayback,
  resolveSaverAfterMinutes,
  SAVER_AFTER_DEFAULT_MINUTES,
  SAVER_AFTER_MIN_MINUTES,
  SAVER_AFTER_MAX_MINUTES,
  buildChatCommands,
  resolveReplyCommand,
  resolveReactionCommand,
  resolveReplyReminderCommand,
  sendTextOverTransport,
  createCoreEdits,
  chatKeys,
  normaliseUrl,
  systemOpener,
  resolveOpenTarget,
  droppedPaths,
  unescapeDroppedPath,
  resolvePastedPath,
  choosePeer,
  fileListLines,
  resolvePeerIdentity,
  formatDuration,
  formatRoute,
  formatPeerClient,
  formatLastPeerMessage,
  isAudioFile,
  parseDataUrl,
  createHeadlessUI,
  createRzFacade,
  backgroundUnreadNotice,
  resolveCloudHistorySender,
  renderAttachmentLines,
  ringIfEnabled,
  notifyIfEnabled,
  savedMessagesRow,
  resolveCloudPeerSync,
  cloudTargetForCurrentPeer,
  computePeerKey,
  resolveDisplayName,
  cloudAliasOf,
  setCloudAlias,
  applyNickname,
  migrateCloudNicknames,
  removeCloudContact,
  forgetContactEntry,
  cloudCacheFile,
  createCloudCacheStore,
  runInviteCommand,
  coreRowMarker,
  coreRowToHistoryMessage,
  reconcileCoreRows,
  RETRY_COMMAND,
  E2EE_COMMANDS,
} from '../src/cli.js';
import { createHistoryBuffer } from '../src/ui.js';
import { defaultLogPath } from '../src/log.js';
import { outboxFileFor } from '../src/outbox-store.js';
import { peerMemoryFile } from '../src/peer-memory.js';
import { CloudApiError, createCloudApi } from '../src/cloud/api.js';
import { describeApiError } from '../src/cloud/prompt.js';

import { logoRows, logoFrames, LOGO, MIN_LOGO_WIDTH } from '../src/logo.js';
import { VERSION } from '../src/version.js';
import { DEFAULT_AI_NAME } from '../src/ai.js';
import { createTranslator, LANGUAGES } from '../src/i18n.js';

test('saver playback waits until the submitting Enter event is finished', () => {
  const queued = [];
  const calls = [];
  const ui = { playSaverScreen: (...args) => calls.push(args) };
  const frames = [['cat']];
  const options = { interval: 200 };

  queueSaverPlayback(ui, frames, options, (cb) => queued.push(cb));
  assert.deepEqual(calls, [], 'not shown inside the Enter keypress');
  assert.equal(queued.length, 1);
  queued[0]();
  assert.deepEqual(calls, [[frames, options]]);
});

const defaults = { port: 4747, name: 'host' };

const sampleFor = (flag) => ({
  '--name': 'Me',
  '--port': '4747',
  '--log': 'c.log',
  '--bind': '100.64.0.1',
  '--files-dir': '/tmp/f',
  '--max-file': '10',
  '--lang': 'fr',
}[flag] ?? 'x');

test('parseArgs: peer positional required', () => {
  const r = parseArgs(['lit'], defaults);
  assert.equal(r.peer, 'lit');
  assert.equal(r.port, 4747);
  assert.equal(r.name, 'host');
  assert.equal(r.nameExplicit, false);
  assert.equal(r.help, false);
});
test('parseArgs: flags', () => {
  const r = parseArgs(['100.71.187.60', '--name', 'Me', '--port', '5000', '--log', 'c.log', '--bind', '100.64.0.1'], defaults);
  assert.equal(r.peer, '100.71.187.60');
  assert.equal(r.name, 'Me');
  assert.equal(r.nameExplicit, true);
  assert.equal(r.port, 5000);
  assert.equal(r.log, 'c.log');
  assert.equal(r.bind, '100.64.0.1');
});

test('saved display name wins over hostname, while --name stays explicit', () => {
  const implicit = parseArgs(['lit'], defaults);
  assert.equal(resolveSelfName(implicit, { name: 'godsheep' }), 'godsheep');
  assert.equal(resolveSelfName(implicit, { name: '   ' }), 'host');
  const explicit = parseArgs(['lit', '--name', 'Alice'], defaults);
  assert.equal(resolveSelfName(explicit, { name: 'godsheep' }), 'Alice');
});

// The name is fixed on purpose. Before it was asked for and saved, this fell
// through to os.hostname() on every run, so one person appeared under a
// different name on each machine they answered from — and as "localhost" on the
// platforms that report it that way.
test('a saved name survives a hand-edited config', () => {
  const implicit = parseArgs(['lit'], defaults);
  assert.equal(
    resolveSelfName(implicit, { name: 'Roman: the second' }), 'host',
    'a colon cannot reach the transcript format, so the name is refused',
  );
  assert.equal(resolveSelfName(implicit, { name: '@Roman' }), 'Roman');
  assert.equal(resolveSelfName(implicit, { name: 42 }), 'host', 'a non-string is not a name');
  assert.equal(resolveSelfName(implicit, {}), 'host');
});

test('a name that would break the transcript is refused at the flag', () => {
  // Quietly substituting the hostname would leave the person believing --name
  // had worked, and the stored line `[HH:MM] name: text` would stop parsing.
  assert.throws(() => parseArgs(['lit', '--name', 'a: b'], defaults), /bad --name/);
  assert.throws(() => parseArgs(['lit', '--name', '   '], defaults), /bad --name/);
  assert.equal(parseArgs(['lit', '--name', '  Roman K '], defaults).name, 'Roman K');
});

test('a name is capped so it cannot push the peer off the header', () => {
  const long = 'R'.repeat(SELF_NAME_MAX + 20);
  assert.equal(normaliseSelfName(long).length, SELF_NAME_MAX);
  assert.equal(normaliseSelfName('Roman'), 'Roman');
  assert.equal(normaliseSelfName('R\u0007oman'), 'Roman', 'control characters are dropped');
  assert.equal(normaliseSelfName(''), null);
  assert.equal(normaliseSelfName('x', { limit: 0 }), null, 'the cap is injectable');
});

test('parseArgs: display and notification flags', () => {
  const r = parseArgs(['lit', '--no-theme', '--no-notify'], defaults);
  assert.equal(r.noTheme, true);
  assert.equal(r.noNotify, true);
});

test('background unread notices expose only the sender and accumulated count', () => {
  const translations = {
    'unread.count': ({ count }) => `unread: ${count}`,
    'unread.switch': ({ peer }) => `type /peer ${peer}`,
  };
  const t = (key, params) => translations[key](params);
  const notice = backgroundUnreadNotice('roman', 3, t);

  assert.equal(notice.count, 3);
  assert.deepEqual(notice.notification, {
    name: 'Tailchat: roman',
    text: 'roman: unread: 3',
  });
  assert.match(notice.line, /roman.*unread: 3.*\/peer roman/);
  // ui.addLine escapes markup, so a tag here would be printed, not applied.
  assert.doesNotMatch(notice.line, /\{\/?[a-z0-9-]+\}/i, 'the line must carry no blessed tags');
});

test('resolveThemed honors flag and NO_COLOR presence', () => {
  assert.equal(resolveThemed({ noTheme: false }, {}), true);
  assert.equal(resolveThemed({ noTheme: true }, {}), false);
  assert.equal(resolveThemed({ noTheme: false }, { NO_COLOR: '' }), false);
});

test('resolveThemeName remembers a valid choice and falls back on a bad one', () => {
  assert.equal(resolveThemeName({}), 'green', 'nothing chosen yet is the original look');
  assert.equal(resolveThemeName({ theme: 'ocean' }), 'ocean');
  assert.equal(
    resolveThemeName({ theme: 'not-a-real-theme' }),
    'green',
    'a hand-edited or outdated config falls back rather than leaving the frame unstyled',
  );
});

test('every AI-safe command is real, and file transfer/identity/AI-control stay off it', () => {
  const names = chatCommands.map((c) => c.name);
  for (const safe of AI_SAFE_COMMANDS) {
    assert.ok(names.includes(safe), `${safe} is not a real command`);
  }
  // File access, identity and conversation target, and control over the AI
  // itself are held back deliberately — everything else the person could type
  // by hand (including /update and /restart, which end the process) is not.
  for (const risky of [
    '/send', '/open', '/peer', '/name', '/lang', '/logs',
    '/ai', '/stop', '/wake', '/typing', '/nick', '/link',
  ]) {
    assert.ok(!AI_SAFE_COMMANDS.includes(risky), `${risky} must stay off the AI's own list`);
  }
  for (const speech of AI_SPEECH_COMMANDS) {
    assert.ok(AI_SAFE_COMMANDS.includes(speech), `${speech} must also be AI-safe`);
  }
});

// /happy from Tailik has to arrive as Tailik: the four commands that speak
// into the chat call `sendText` in their ordinary form, so the AI's own
// command table swaps that one function for `emitAi` and nothing else —
// every other AI-safe command (theme, clear, logo, saver, mouse, the
// read-only info commands) keeps its real, unchanged handler either way.
test('AI-run speech commands answer through whichever "sendText" they are given, never their own', () => {
  const humanCalls = [];
  const botCalls = [];
  const ctx = {
    ui: { addLine: () => {}, setMouseCapture: () => true, isMouseCaptured: () => false },
    sendText: (text) => humanCalls.push(text),
  };
  const human = new Map(buildChatCommands(ctx).map((c) => [c.name, c]));
  const bot = new Map(
    buildChatCommands({ ...ctx, sendText: (text) => botCalls.push(text) }).map((c) => [c.name, c]),
  );
  for (const name of ['/happy', '/sad', '/neutral']) {
    human.get(name).run();
    bot.get(name).run();
  }
  assert.equal(humanCalls.length, 3);
  assert.deepEqual(botCalls, humanCalls, 'the same text goes out either way — only its attribution differs');
});

// /changelog is a read command: the AI must see the real version history it
// returns, not just know that it ran — see askAiReply's read-then-answer flow.
test('/changelog dispatches to showChangelog and hands its real text back', () => {
  const commands = buildChatCommands({
    ui: { addLine: () => {} },
    showChangelog: (arg) => `history for "${arg}"`,
  });
  const result = commands.find((c) => c.name === '/changelog').run('0.57.16');
  assert.equal(result, 'history for "0.57.16"');
});

// /net is a read command too: the AI is allowed to run it, and askAiReply
// hands whatever it returns back to the model as the tool's output.
test('/net dispatches to showNetwork and hands its real text back', async () => {
  const commands = buildChatCommands({
    ui: { addLine: () => {} },
    showNetwork: async () => 'tailscale CLI: /usr/bin/tailscale',
  });
  assert.equal(await commands.find((c) => c.name === '/net').run(), 'tailscale CLI: /usr/bin/tailscale');
  // Absent a session it must be inert rather than a crash, like every other
  // optional runner in this table.
  const bare = buildChatCommands({ ui: { addLine: () => {} } });
  assert.equal(bare.find((c) => c.name === '/net').run(), undefined);
  assert.ok(AI_SAFE_COMMANDS.includes('/net'));
});

test('/theme dispatches to switchTheme and returns status string', () => {
  const commands = buildChatCommands({
    ui: { addLine: () => {} },
    switchTheme: (arg) => `theme changed to ${arg}`,
  });
  const result = commands.find((c) => c.name === '/theme').run('ocean');
  assert.equal(result, 'theme changed to ocean');
});

test('/block dispatches to blockPeer and returns status string', async () => {
  const commands = buildChatCommands({
    ui: { addLine: () => {} },
    blockPeer: (arg) => `blocked ${arg}`,
  });
  const result = await commands.find((c) => c.name === '/block').run('roman@example.com');
  assert.equal(result, 'blocked roman@example.com');
});

test('/unblock dispatches to unblockPeer and returns status string', async () => {
  const commands = buildChatCommands({
    ui: { addLine: () => {} },
    unblockPeer: (arg) => `unblocked ${arg}`,
  });
  const result = await commands.find((c) => c.name === '/unblock').run('roman@example.com');
  assert.equal(result, 'unblocked roman@example.com');
});

test('/block and /unblock are absent without a session, like every other optional runner', () => {
  const bare = buildChatCommands({ ui: { addLine: () => {} } });
  assert.equal(bare.find((c) => c.name === '/block').run(), undefined);
  assert.equal(bare.find((c) => c.name === '/unblock').run(), undefined);
  assert.ok(!AI_SAFE_COMMANDS.includes('/block'), '/block must never run from an AI turn');
  assert.ok(!AI_SAFE_COMMANDS.includes('/unblock'), '/unblock must never run from an AI turn');
});

test('/remove is offered on a contact and never handed to the AI', () => {
  const bare = buildChatCommands({ ui: { addLine: () => {} } });
  assert.equal(bare.find((c) => c.name === '/remove').run(), undefined);
  // Deleting a conversation is not something an assistant may decide to do on
  // its own: unlike /block it cannot be undone by typing the opposite command.
  assert.ok(!AI_SAFE_COMMANDS.includes('/remove'), '/remove must never run from an AI turn');
});

// A state directory holding every local trace of one Cloud conversation: the
// transcript, the cached history, the frames still waiting for a link, and the
// remembered device and nickname. Named through the same helpers the session
// writes them with, so the test names the files the client would really leave
// behind rather than a second guess at their names.
const removalStore = createSecureStore(Buffer.alloc(32, 7));
function seedConversation(stateDir, login) {
  const key = `cloud-${login}`;
  const files = {
    transcript: defaultLogPath(stateDir, key),
    cache: cloudCacheFile(stateDir, login),
    outbox: outboxFileFor(stateDir, key),
    memory: peerMemoryFile(stateDir, key),
  };
  fs.mkdirSync(path.dirname(files.cache), { recursive: true });
  fs.writeFileSync(files.transcript, '[10:00] me: hello\n');
  fs.writeFileSync(files.cache, '[]');
  fs.writeFileSync(files.outbox, '[]');
  fs.writeFileSync(files.memory, '{}');
  removalStore.migrateLog(files.transcript);
  removalStore.migrate(files.cache);
  removalStore.migrate(files.outbox);
  return files;
}

const survivors = (files) => Object.entries(files)
  .filter(([, file]) => fs.existsSync(file))
  .map(([kind]) => kind);

test('/remove asks first, deletes the named login, and then forgets the whole conversation', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-remove-'));
  try {
    const files = seedConversation(stateDir, 'roman@example.com');
    const calls = [];
    const result = await removeCloudContact({
      stateDir,
      login: '@roman@example.com',
      selfLogin: 'alice@example.com',
      contacts: [{ login: 'roman@example.com', name: 'Roman' }],
      api: {
        removeContact: async (login) => {
          calls.push(`api:${login}`);
          return true;
        },
      },
      confirm: async (login) => {
        calls.push(`confirm:${login}`);
        return true;
      },
      t: createTranslator('en'),
    });
    // The question comes first, and the contact's own login — not the `@` form
    // the person typed — is what the server is given.
    assert.deepEqual(calls, ['confirm:roman@example.com', 'api:roman@example.com']);
    assert.equal(result.ok, true);
    assert.equal(result.key, 'remove.success');
    assert.deepEqual(survivors(files), ['transcript', 'cache', 'outbox'],
      'legacy plaintext requires separate exact-path cleanup confirmation');
    for (const kind of ['transcript', 'cache', 'outbox']) {
      assert.equal(fs.existsSync(removalStore.fileFor(files[kind])), false);
    }
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('/remove closes the open transcript before unlinking it', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-remove-open-'));
  try {
    const files = seedConversation(stateDir, 'roman@example.com');
    const order = [];
    const dropped = [];
    const result = await removeCloudContact({
      stateDir,
      login: 'roman@example.com',
      selfLogin: 'alice@example.com',
      contacts: [{ login: 'roman@example.com' }],
      api: { removeContact: async () => true },
      confirm: async () => true,
      // The open conversation hands in the live objects, as main() does.
      active: { log: files.transcript, outbox: files.outbox, memory: files.memory },
      closeLog: async () => {
        // On Windows an open file cannot be removed at all, and on POSIX the
        // buffered lines land in an inode nothing can reach — either way the
        // stream has to be shut before the file goes.
        order.push(fs.existsSync(files.transcript) ? 'closed-while-open' : 'closed-too-late');
      },
      dropCache: async () => { dropped.push('cache'); },
      t: createTranslator('en'),
    });
    assert.deepEqual(order, ['closed-while-open']);
    assert.deepEqual(dropped, ['cache'], 'a queued cache write must be dropped, not left to land after the delete');
    assert.equal(result.ok, true);
    assert.deepEqual(survivors(files), ['transcript', 'cache', 'outbox']);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a refused or failed /remove leaves every local trace exactly as it was', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-remove-no-'));
  try {
    const files = seedConversation(stateDir, 'roman@example.com');
    const t = createTranslator('en');
    const refusals = [
      // Declined at the question: a whole conversation must never go on a
      // single Enter, so "no" is a first-class answer.
      {
        name: 'cancelled', answer: false, asked: true, sent: false, key: 'remove.cancelled',
      },
      // The server refuses. An official contact and a stale friend list both
      // arrive here, since the local checks above can only be as fresh as the
      // roster this session holds.
      {
        name: 'server refusal',
        answer: true,
        asked: true,
        sent: true,
        key: 'remove.failed',
        fail: 'official_contact',
      },
      {
        name: 'no server', asked: false, sent: false, key: 'remove.offline', api: null,
      },
      // Refused here, before anything is asked and before anything is sent.
      {
        name: 'self', login: 'alice@example.com', asked: false, sent: false, key: 'remove.self',
      },
      {
        name: 'unknown', login: 'stranger@example.com', asked: false, sent: false, key: 'remove.unknown',
      },
      {
        name: 'official',
        login: 'tailchat',
        contacts: [{ login: 'tailchat', official: true }],
        asked: false,
        sent: false,
        key: 'remove.official',
      },
    ];
    for (const scenario of refusals) {
      const calls = [];
      const api = scenario.api === null ? null : {
        removeContact: async (login) => {
          calls.push(login);
          if (scenario.fail) throw new CloudApiError(scenario.fail, { status: 403 });
          return true;
        },
      };
      const result = await removeCloudContact({
        stateDir,
        login: scenario.login ?? 'roman@example.com',
        selfLogin: 'alice@example.com',
        contacts: scenario.contacts ?? [{ login: 'roman@example.com' }],
        api,
        confirm: async () => { calls.push('confirm'); return scenario.answer ?? true; },
        t,
      });
      assert.equal(result.ok, false, `${scenario.name} was not refused`);
      assert.equal(result.key, scenario.key, `${scenario.name} answered with the wrong line`);
      assert.equal(calls.includes('confirm'), scenario.asked, `${scenario.name} asked at the wrong moment`);
      assert.equal(calls.filter((call) => call !== 'confirm').length > 0, scenario.sent,
        `${scenario.name} reached the server when it should not have`);
      if (scenario.fail) {
        // The server's code becomes a sentence: a person must never be shown
        // `official_contact`, and must be told nothing was deleted.
        const line = t(result.key, result.params);
        assert.ok(line.includes(t('remove.official')), `${scenario.name} did not explain itself: ${line}`);
        assert.ok(!line.includes(scenario.fail), `${scenario.name} printed the raw code: ${line}`);
      }
      assert.deepEqual(survivors(files), ['transcript', 'cache', 'outbox', 'memory'],
        `${scenario.name} deleted something locally`);
    }
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('every refusal /remove can receive is a sentence, not a code', () => {
  // The three red lines the command's own answers can carry, plus the three the
  // server sends for a contact this session could not judge locally.
  const lines = {
    official_contact: 'remove.official',
    self_remove: 'remove.self',
    not_friends: 'cloud.notFriends',
    unknown_user: 'cloud.unknownUser',
    peer_not_found: 'cloud.peerUnknown',
    unreachable: 'cloud.unreachable',
  };
  for (const lang of LANGUAGES) {
    const t = createTranslator(lang);
    for (const [code, key] of Object.entries(lines)) {
      const line = describeApiError(new CloudApiError(code, { status: 403 }), t);
      assert.equal(line, t(key), `${lang}: ${code} must be answered with its own line`);
      assert.ok(!line.includes(code), `${lang}: ${code} reached the reader as a raw code`);
    }
  }
});

// The invite command is the one place a login and a 64-hex code share the same
// slot of the same argument, so what is proven here is that the two never swap
// places: a named account travels as the request body the server reads as
// "mint *their* link", a pasted link is still unwrapped into the code, and a
// refusal reaches the screen as a sentence in the reader's own language.
test('/invite create asks the server for the named account, with a body the older server still understands', async () => {
  const seen = [];
  const api = createCloudApi({
    server: 'https://cloud.example',
    token: 'token',
    fetchImpl: async (url, options) => {
      seen.push({ url, method: options.method, body: options.body });
      return new Response(JSON.stringify({ invite: 'a'.repeat(64) }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(await api.createInvite('remindka_bot'), 'a'.repeat(64));
  assert.equal(seen[0].method, 'POST');
  assert.match(seen[0].url, /\/tailchat\/api\/invite$/);
  assert.equal(seen[0].body, JSON.stringify({ login: 'remindka_bot' }));

  // Without a login the request carries no body at all — not an empty object —
  // because that is the request a server older than this feature reads as "my
  // own link", and the two have to keep agreeing on it.
  await api.createInvite();
  await api.createInvite('');
  assert.equal(seen[1].body, undefined);
  assert.equal(seen[2].body, undefined);
});

test('/invite create [login] shows a link, and a bare create is still your own link', async () => {
  const t = createTranslator('ru');
  const calls = [];
  const shown = [];
  const ui = { addLine: (line) => shown.push(String(line)) };
  const code = 'c'.repeat(64);
  const api = {
    server: 'https://cloud.example',
    createInvite: async (login) => { calls.push(login); return code; },
    acceptInvite: async () => { throw new Error('creating a link must never accept one'); },
  };

  // What reaches the screen has to be the link, not the bare code: a 64-hex
  // string is unopenable and unguessable to whoever receives it, and every
  // client accepts the link built out of the same server.
  const link = `https://cloud.example/tailchat/?invite=${code}`;
  await runInviteCommand({ arg: 'create remindka_bot', api, ui, t });
  assert.deepEqual(calls, ['remindka_bot'], 'the named account never reached the API');
  assert.ok(shown.includes(`* ${link}`), `the minted link was not shown: ${shown.join(' | ')}`);
  assert.ok(shown.includes(`* ${t('cloud.inviteCreated')}`));

  // `/invite create`, `/invite new` and a bare `/invite` all mean the caller's
  // own link, exactly as they did before a login existed.
  for (const arg of ['create', 'new', '', '   ']) {
    calls.length = 0;
    shown.length = 0;
    await runInviteCommand({ arg, api, ui, t });
    assert.deepEqual(calls, [''], `\`/invite ${arg}\` asked for somebody else's link`);
    assert.ok(shown.includes(`* ${link}`), `\`/invite ${arg}\` showed no link`);
  }
});

test('/invite still accepts a pasted link, and a refusal is a sentence rather than a code', async () => {
  const t = createTranslator('ru');
  const calls = [];
  const shown = [];
  const ui = { addLine: (line) => shown.push(String(line)) };
  const code = 'd'.repeat(64);
  const api = {
    createInvite: async (login) => { calls.push(['create', login]); return code; },
    acceptInvite: async (invite) => { calls.push(['accept', invite]); return { login: 'roman', name: 'Roman' }; },
  };

  await runInviteCommand({ arg: `accept https://cloud.example/tailchat/?invite=${code}`, api, ui, t });
  assert.deepEqual(calls, [['accept', code]], 'a pasted link was not unwrapped into its code');
  assert.ok(shown.includes(`* ${t('cloud.friendAdded', { name: 'Roman' })}`));

  // Handing the link over without the word `accept` is the common case, and a
  // 64-hex link must never be read as a login.
  calls.length = 0;
  await runInviteCommand({ arg: `https://cloud.example/tailchat/?invite=${code}`, api, ui, t });
  assert.deepEqual(calls, [['accept', code]]);

  // The two refusals only `/invite create <login>` can receive, in every
  // language the interface ships: the code stays inside the client.
  const refusals = {
    forbidden: 'cloud.inviteForbidden',
    official_invite: 'cloud.inviteOfficial',
  };
  for (const lang of LANGUAGES) {
    const translator = createTranslator(lang);
    for (const [failureCode, key] of Object.entries(refusals)) {
      const lines = [];
      const refusing = {
        ...api,
        createInvite: async () => { throw new CloudApiError(failureCode, { status: 403 }); },
      };
      await runInviteCommand({
        arg: 'create remindka_bot',
        api: refusing,
        ui: { addLine: (line) => lines.push(String(line)) },
        t: translator,
      });
      const printed = lines.join('\n');
      assert.ok(printed.includes(translator(key)), `${lang}: ${failureCode} was not explained: ${printed}`);
      assert.ok(!printed.includes(failureCode), `${lang}: ${failureCode} reached the reader as a code`);
    }
  }
});

test('the deleted contact disappears from the roster and from every /link that named them', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-remove-row-'));
  try {
    // A contact remembered from two machines, a tailnet peer explicitly linked
    // to them, and a second link to somebody else that must survive.
    fs.writeFileSync(path.join(stateDir, 'roster.json'), JSON.stringify({
      logins: {
        'roman@example.com': {
          devices: [{ host: 'lit', dns: 'lit.tailnet', ips: ['100.64.0.7'] }],
          names: ['Roman'],
          seen: '2026-09-01T00:00:00.000Z',
        },
        'other@example.com': {
          devices: [{ host: 'mac', ips: ['100.64.0.9'] }],
          seen: '2026-09-01T00:00:00.000Z',
        },
      },
    }));
    fs.writeFileSync(path.join(stateDir, 'peer-links.json'), JSON.stringify({
      links: { 'lit@example.com': 'roman@example.com', 'mac@example.com': 'other@example.com' },
    }));
    forgetContactEntry(stateDir, 'roman@example.com', 'lit@example.com');
    const roster = JSON.parse(fs.readFileSync(path.join(stateDir, 'roster.json'), 'utf8'));
    assert.deepEqual(Object.keys(roster.logins), ['other@example.com']);
    const links = JSON.parse(fs.readFileSync(path.join(stateDir, 'peer-links.json'), 'utf8'));
    assert.deepEqual(links.links, { 'mac@example.com': 'other@example.com' },
      'a link to a deleted contact must not survive, and nobody else\'s may be touched');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('the /remove wording is the copy the contract fixes, in every language', () => {
  const copy = {
    ru: {
      action: 'Удалить контакт',
      confirm: 'Удалить контакт вместе с перепиской? У вас переписка удалится безвозвратно, у собеседника останется своя копия. Отменить это нельзя.',
      success: 'Контакт и переписка удалены.',
      official: 'Официальный контакт удалить нельзя.',
    },
    en: {
      action: 'Delete contact',
      confirm: 'Delete the contact together with the conversation? Your copy is gone for good; the other person keeps theirs. This cannot be undone.',
      success: 'Contact and conversation deleted.',
      official: 'The official contact cannot be deleted.',
    },
    fr: {
      action: 'Supprimer le contact',
      confirm: 'Supprimer le contact et la conversation ? Votre copie disparaît définitivement, l\'autre personne garde la sienne. Action irréversible.',
      success: 'Contact et conversation supprimés.',
      official: 'Le contact officiel ne peut pas être supprimé.',
    },
  };
  for (const [lang, words] of Object.entries(copy)) {
    const t = createTranslator(lang);
    assert.equal(t('remove.action'), words.action, `${lang} action`);
    assert.equal(t('remove.confirm'), words.confirm, `${lang} confirmation`);
    assert.equal(t('remove.success'), words.success, `${lang} success`);
    assert.equal(t('remove.official'), words.official, `${lang} refusal`);
  }
});

test('VERSION matches the published package version', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
  assert.match(VERSION, /^\d+\.\d+/);
});

test('greeting announces the running version', () => {
  const greeting = formatGreeting({
    name: 'Alice', peerHost: 'lit', peerPort: 4747, bindAddr: '100.64.0.1',
  });
  assert.ok(greeting.includes(`v${VERSION}`), `greeting must carry version: ${greeting}`);
  assert.ok(greeting.includes('Alice'));
  assert.ok(greeting.includes('lit:4747'));
  assert.ok(greeting.includes('100.64.0.1'));
});

test('chatCommands documents every in-chat command', () => {
  assert.deepEqual(chatCommands.map((c) => c.name), [
    '/help', '/send', '/paste', '/files', '/open', '/view', '/history', '/peer', '/p2p', '/cloud', '/roster', '/link', '/block', '/unblock', '/remove', '/add', '/invite', '/reconnect',
    '/ping', '/status', '/lock', '/pass', '/voice', '/del', '/route', '/edit', '/react', '/reply', '/unread', '/later', '/forward', '/wake', '/mouse', '/sound',
    '/emo', '/happy', '/sad', '/neutral', '/code', '/asc', '/ai', '/stop', '/version', '/diagnose', '/net', '/changelog',
    '/remind',
    '/lang', '/name', '/nick', '/logs', '/settings', '/update', '/autoupdate', '/sysmsg', '/restart',
    '/logo', '/holiday', '/saver', '/typing', '/badge', '/theme', '/clear', '/quit',
  ]);
  for (const command of chatCommands) {
    assert.match(command.name, /^\/[a-z0-9]+$/);
    assert.ok(command.help.length > 0, `${command.name} needs help text`);
  }
});

test('/reply resolves a 1-based recency target into a reply snapshot', () => {
  const messages = new Map([
    ['newest', {
      id: 'newest', self: true, name: 'Alice', text: 'latest',
    }],
    ['second', {
      id: 'second', self: false, name: 'Roman', text: 'the original',
    }],
  ]);
  const ui = {
    recentMessageIds: ({ limit }) => ['newest', 'second'].slice(0, limit),
    messageById: (id) => messages.get(id) ?? null,
  };

  const resolved = resolveReplyCommand('2 hi', {
    recentMessageIds: ui.recentMessageIds,
    messageById: ui.messageById,
    selfLogin: 'alice@example.com',
    peerLogin: 'roman@example.com',
  });

  assert.deepEqual(resolved, {
    text: 'hi',
    replyTo: {
      id: 'second',
      from: 'roman@example.com',
      author: 'Roman',
      text: 'the original',
    },
  });

  const frames = [];
  assert.equal(sendTextOverTransport({
    sendFrame: (frame) => { frames.push(frame); return true; },
  }, {
    id: 'new-message',
    ts: 123,
    text: resolved.text,
    replyTo: resolved.replyTo,
  }), true);
  assert.deepEqual(frames, [{
    t: 'msg',
    id: 'new-message',
    ts: 123,
    text: 'hi',
    replyTo: resolved.replyTo,
  }]);
});

test('/reply rejects an unknown target before anything can be sent', () => {
  let lookedUp = 0;
  const resolved = resolveReplyCommand('missing hi', {
    recentMessageIds: () => [],
    messageById: () => {
      lookedUp += 1;
      return null;
    },
    selfLogin: 'alice@example.com',
    peerLogin: 'roman@example.com',
  });

  assert.deepEqual(resolved, { error: 'reply.notFound', target: 'missing' });
  assert.equal(lookedUp, 1);
});

test('/reply dispatches the target and text to the session handler unchanged', () => {
  const calls = [];
  const command = buildChatCommands({
    ui: { addLine: () => {} },
    replyToMessage: (arg) => calls.push(arg),
  }).find((entry) => entry.name === '/reply');

  command.run('2 hi');
  assert.deepEqual(calls, ['2 hi']);
});

test('/later resolves a recent message and shared reminder preset', () => {
  const messages = new Map([['newest', { id: 'newest' }], ['second', { id: 'second' }]]);
  const resolved = resolveReplyReminderCommand('2 1h', {
    recentMessageIds: ({ limit }) => ['newest', 'second'].slice(0, limit),
    messageById: (id) => messages.get(id),
    timezone: 'UTC',
    now: Date.parse('2026-09-21T12:00:00Z'),
  });
  assert.deepEqual(resolved, {
    id: 'second',
    dueAt: Date.parse('2026-09-21T13:00:00Z'),
    preset: '1h',
  });
  assert.deepEqual(resolveReplyReminderCommand('missing tomorrow', {
    recentMessageIds: () => [],
    messageById: () => undefined,
    timezone: 'UTC',
    now: Date.parse('2026-09-21T12:00:00Z'),
  }), { error: 'later.notFound', target: 'missing' });
});

test('/unread and /later dispatch to their cloud conversation handlers', () => {
  const calls = [];
  const commands = new Map(buildChatCommands({
    ui: { addLine: () => {} },
    markConversationUnread: () => calls.push(['unread']),
    remindReplyToMessage: (arg) => calls.push(['later', arg]),
  }).map((entry) => [entry.name, entry]));
  commands.get('/unread').run();
  commands.get('/later').run('last evening');
  assert.deepEqual(calls, [['unread'], ['later', 'last evening']]);
});

test('/react accepts a 1-based recency index and rejects bad indices', () => {
  const recent = ({ limit }) => ['newest', 'second', 'third'].slice(0, limit);
  assert.deepEqual(resolveReactionCommand('❤️ 3', recent), {
    id: 'third',
    emoji: '❤️',
  });
  assert.deepEqual(resolveReactionCommand('👍 0', recent), { error: 'react.usage' });
  assert.deepEqual(resolveReactionCommand('👍 4', recent), { error: 'react.nothing' });
});

test('/react 1-8 picks that position from EMOJIS in place of typing the glyph', () => {
  const recent = ({ limit }) => ['newest', 'second', 'third'].slice(0, limit);
  assert.deepEqual(resolveReactionCommand('1', recent), { id: 'newest', emoji: EMOJIS[0].emoji });
  assert.deepEqual(resolveReactionCommand(`${EMOJIS.length} 2`, recent), {
    id: 'second',
    emoji: EMOJIS[EMOJIS.length - 1].emoji,
  });
  // Out of EMOJIS' range is not a shortcut — it falls through to the
  // ordinary "not a known emoji" rejection, same as any other bad token.
  assert.deepEqual(resolveReactionCommand('0', recent), { error: 'react.usage' });
  assert.deepEqual(resolveReactionCommand(`${EMOJIS.length + 1}`, recent), { error: 'react.usage' });
});

test('versionNotice stays silent when both sides match', () => {
  assert.equal(versionNotice('0.6.0', '0.6.0', 'Roman'), null);
});

test('versionNotice gives the older local side a full framed update banner', () => {
  const peerBehind = versionNotice('0.6.0', '0.4.0', 'Roman');
  assert.match(peerBehind, /Roman/);
  assert.match(peerBehind, /0\.4\.0/);
  assert.match(peerBehind, /0\.6\.0/);
  assert.match(peerBehind, /git pull/);

  const weAreBehind = versionNotice('0.4.0', '0.6.0', 'Roman');
  const lines = weAreBehind.split('\n');
  assert.match(lines[0], /^\*{16,}$/);
  assert.equal(lines.at(-1), lines[0]);
  assert.match(weAreBehind, /\/update/);
  assert.match(weAreBehind, /Roman/);
  assert.notEqual(weAreBehind, peerBehind, 'only the side with work to do gets the banner');
});

test('the update banner is complete and framed in every language', () => {
  for (const lang of LANGUAGES) {
    const banner = updateBanner('0.50.1', '0.50.2', 'Roman', createTranslator(lang));
    const lines = banner.split('\n');
    assert.equal(lines.length, 6, `${lang} banner has every row`);
    assert.match(lines[0], /^\*{16,}$/);
    assert.equal(lines.at(-1), lines[0]);
    assert.match(banner, new RegExp(createTranslator(lang)('update.bannerTitle')));
    assert.match(banner, /0\.50\.1/);
    assert.match(banner, /0\.50\.2/);
    assert.match(banner, /Roman/);
    assert.match(banner, /\/update/);
  }
});

test('the same update banner is shown once until versions change or match', () => {
  const guard = createUpdateBannerGuard();
  assert.equal(guard.take('0.50.1', '0.50.2'), true);
  assert.equal(guard.take('0.50.1', '0.50.2'), false, 'hello and update frame deduplicate');
  assert.equal(guard.take('0.50.1', '0.50.3'), true, 'a newer release deserves a new banner');
  guard.clear();
  assert.equal(guard.take('0.50.1', '0.50.3'), true, 'a later mismatch after matching is visible');
});

test('versionNotice handles a peer that predates version reporting', () => {
  const notice = versionNotice('0.6.0', null, 'Roman');
  assert.match(notice, /Roman/);
  assert.match(notice, /git pull/);
});

test('versionNotice compares numerically, not as text', () => {
  // '0.10.0' > '0.9.0' numerically but sorts lower as a string.
  assert.match(versionNotice('0.10.0', '0.9.0', 'Roman'), /Roman .*0\.9\.0/);
  assert.equal(versionNotice('0.10.0', '0.10.0', 'Roman'), null);
});

test('/files lists both directions under one numbering', () => {
  // A picture this side sent sits in the same transcript as one that arrived, so
  // it needs a number too — /files used to show only what came in, which left
  // half the previews with nothing to type at /open.
  const lines = fileListLines({
    received: ['/in/photo.png', '/in/notes.pdf'],
    sent: ['/out/shot.png'],
    dir: '/in',
  });
  assert.match(lines[0], /files received:/);
  assert.match(lines[1], /^\*\s+1: photo\.png — \/in\/photo\.png$/);
  assert.match(lines[2], /^\*\s+2: notes\.pdf — \/in\/notes\.pdf$/);
  assert.match(lines[3], /files sent:/);
  assert.match(lines[4], /^\*\s+3: shot\.png — \/out\/shot\.png$/, 'sent files keep counting');
  assert.equal(lines.length, 5);
});

test('/files with one direction empty says nothing about the other', () => {
  const sentOnly = fileListLines({ sent: ['/out/shot.png'], dir: '/in' });
  assert.equal(sentOnly.length, 2, 'a heading and the one file');
  assert.match(sentOnly[0], /files sent:/);
  assert.match(sentOnly[1], /^\*\s+1: shot\.png/, 'it is the first thing /open can reach');

  const nothing = fileListLines({ dir: '/in/files' });
  assert.match(nothing[0], /\/in\/files/, 'the empty list still says where files land');
  assert.match(nothing[1], /\/send/);
});

test('parseCommand tolerates spacing and quotes around the argument', () => {
  assert.deepEqual(parseCommand('/files'), { name: '/files', arg: '' });
  assert.deepEqual(parseCommand('  /files  '), { name: '/files', arg: '' });
  // Roman typed "/ open X" — a space after the slash must still work.
  assert.deepEqual(parseCommand('/ open 1'), { name: '/open', arg: '1' });
  assert.deepEqual(parseCommand('/OPEN 2'), { name: '/open', arg: '2' });
  assert.deepEqual(parseCommand('/send   ~/a.png'), { name: '/send', arg: '~/a.png' });
  assert.deepEqual(parseCommand('/p2p'), { name: '/p2p', arg: '' });
  assert.deepEqual(parseCommand('/p2p roman'), { name: '/p2p', arg: 'roman' });
});

test('parseCommand strips the quotes a terminal adds when a file is dragged in', () => {
  assert.deepEqual(
    parseCommand('/send "C:\\Users\\stcui\\Pictures\\My Shot.png"'),
    { name: '/send', arg: 'C:\\Users\\stcui\\Pictures\\My Shot.png' },
  );
  assert.deepEqual(parseCommand("/send '/tmp/a b.png'"), { name: '/send', arg: '/tmp/a b.png' });
});

test('parseCommand ignores ordinary text', () => {
  assert.equal(parseCommand('hello'), null);
  assert.equal(parseCommand('2/3 done'), null);
  assert.equal(parseCommand(''), null);
});

test('looksLikePath spots a dragged-in path sent as a plain message', () => {
  assert.equal(looksLikePath('"C:\\Users\\stcui\\Pictures\\Screenshots\\a.png"'), true);
  assert.equal(looksLikePath('C:\\Users\\stcui\\a.png'), true);
  assert.equal(looksLikePath('/Users/alice/Downloads/photo.jpg'), true);
  assert.equal(looksLikePath('~/Downloads/photo.jpg'), true);

  assert.equal(looksLikePath('привет'), false);
  assert.equal(looksLikePath('смотри /help'), false);
  assert.equal(looksLikePath('/tmp'), false, 'no extension is too weak a signal');
});

test('isAtLeast gates features on the peer version', () => {
  assert.equal(isAtLeast('0.5.0', '0.5.0'), true);
  assert.equal(isAtLeast('0.8.0', '0.5.0'), true);
  assert.equal(isAtLeast('0.10.0', '0.9.0'), true, 'numeric, not lexicographic');
  assert.equal(isAtLeast('0.4.0', '0.5.0'), false);
  assert.equal(isAtLeast(null, '0.5.0'), false, 'a silent peer is treated as too old');
  assert.equal(isAtLeast('1.0.0', '0.5.0'), true);
});

// Over the relay a missing version means "not heard from yet", not "ancient":
// the link fabricates a stand-in hello for queued messages, and a peer reading
// another conversation never sends one at all. Reading it as an old client
// refused file transfers to a current peer and downgraded every AI answer to
// plain text signed with the owner's own name.
test('a version nobody reported is unknown over the relay, not ancient', () => {
  const cloud = peerCapabilities(null, { overCloud: true });
  assert.deepEqual(cloud, { files: null, ai: null, logo: null, holiday: null });
  assert.equal(cloud.files, null, 'null is what lets a file be sent');
  assert.equal(cloud.ai, null, 'and what keeps an AI answer an AI frame');

  // A direct connection reports no version only when the client predates
  // version reporting, where "too old" is the honest answer.
  assert.deepEqual(peerCapabilities(null, { overCloud: false }), {
    files: false, ai: false, logo: false, holiday: false,
  });

  // A version that *is* reported gates as before, on either transport.
  assert.deepEqual(peerCapabilities('1.64', { overCloud: true }), {
    files: true, ai: true, logo: true, holiday: true,
  });
  assert.equal(peerCapabilities('0.4.0', { overCloud: true }).ai, false);
  assert.equal(peerCapabilities('0.4.0', { overCloud: true }).files, false);
  assert.equal(peerCapabilities('web', { overCloud: true }).files, true, 'the browser client is current');
});
test('every flag the parser accepts is documented in --help', () => {
  for (const { flag } of cliFlags) {
    assert.ok(usageText().includes(flag), `${flag} is missing from --help`);
  }
});

test('every documented flag is actually accepted by the parser', () => {
  for (const { flag, value } of cliFlags) {
    if (flag === '--help') continue;
    const argv = value ? ['lit', flag, sampleFor(flag)] : ['lit', flag];
    assert.doesNotThrow(() => parseArgs(argv, defaults), `${flag} is not parsed`);
  }
});

test('a tailscale binary that cannot reach its daemon is not treated as one', async () => {
  // Termux beside the Android app: `tailscale` exists, every call fails. Saying
  // "no CLI" is the truthful reading — pretending otherwise means every inbound
  // connection waits on a whois that can only fail and then be refused.
  const dead = await resolvePeerIdentity('roman@example.com', '/usr/bin/tailscale', async () => {
    throw new Error('failed to connect to local tailscaled');
  });
  assert.deepEqual(dead, { login: null, devices: [], cliOk: false });

  // No binary at all reads the same way, and an answering daemon that simply
  // does not know the peer still counts as an authority.
  assert.equal((await resolvePeerIdentity('x', null)).cliOk, false);
  const alive = await resolvePeerIdentity('nobody@example.com', '/usr/bin/tailscale',
    async () => JSON.stringify({ Self: {}, User: {}, Peer: {} }));
  assert.equal(alive.cliOk, true);
  assert.equal(alive.login, null);
});

test('every in-chat command carries help text and a handler', () => {
  const calls = [];
  const commands = buildChatCommands({
    shutdown: () => calls.push('shutdown'),
    restartClient: () => calls.push('restart'),
    ui: { addLine: () => {}, clearHistory: () => calls.push('clear'), setMouseCapture: () => true, isMouseCaptured: () => false },
    showDiagnostics: () => calls.push('diagnose'),
    reconnectPeer: () => calls.push('reconnect'),
    clearScreen: () => calls.push('clear'),
    showLogo: () => calls.push('logo'),
    switchHoliday: (arg) => calls.push(`holiday:${arg}`),
    showSaver: () => calls.push('saver'),
    listFiles: () => calls.push('files'),
    openFile: () => calls.push('open'),
    sendFile: () => calls.push('send'),
    sendClipboardImage: () => calls.push('paste'),
    sendWake: () => calls.push('wake'),
    showHistory: () => calls.push('history'),
    switchTheme: (arg) => calls.push(`theme:${arg}`),
    switchTyping: (arg) => calls.push(`typing:${arg}`),
    switchSound: (arg) => calls.push(`sound:${arg}`),
    switchNickname: (arg) => calls.push(`nick:${arg}`),
    showSettings: () => calls.push('settings'),
    pingPeer: () => calls.push('ping'),
    showStatus: () => calls.push('status'),
    lockScreen: () => calls.push('lock'),
    switchPassword: (arg) => calls.push(`pass:${arg}`),
    sendVoiceNote: (arg) => calls.push(`voice:${arg}`),
    runRemind: (arg) => calls.push(`remind:${arg}`),
    switchAutoupdate: (arg) => calls.push(`autoupdate:${arg}`),
    switchSysmsg: (arg) => calls.push(`sysmsg:${arg}`),
    blockPeer: (arg) => calls.push(`block:${arg}`),
    unblockPeer: (arg) => calls.push(`unblock:${arg}`),
    removePeer: (arg) => calls.push(`remove:${arg}`),
  });
  assert.deepEqual(commands.map((c) => c.name), chatCommands.map((c) => c.name));
  for (const command of commands) {
    assert.ok(command.help.length > 0, `${command.name} needs help text`);
    assert.equal(typeof command.run, 'function', `${command.name} needs a handler`);
  }

  // A short form only helps if it is unique and mnemonic. It is not always the
  // first letter: /help owns /h, so /history takes /i. A command may have none
  // at all — every letter of /asc is already spoken for, and a made-up letter
  // would be harder to remember than the full word.
  const aliases = commands.map((c) => c.alias).filter(Boolean);
  assert.equal(new Set(aliases).size, aliases.length, 'aliases must not collide');
  for (const { name, alias } of commands) {
    if (!alias) continue;
    assert.ok(/^\/[a-z]$/.test(alias), `${name} needs a single-letter alias, got ${alias}`);
    assert.ok(name.includes(alias.slice(1)), `${alias} is not a letter of ${name}`);
  }

  commands.find((c) => c.name === '/theme').run('ocean');
  assert.ok(calls.includes('theme:ocean'), '/theme must dispatch to switchTheme');
  commands.find((c) => c.name === '/typing').run('off');
  assert.ok(calls.includes('typing:off'), '/typing must dispatch to switchTyping');
  commands.find((c) => c.name === '/holiday').run('off');
  assert.ok(calls.includes('holiday:off'), '/holiday must dispatch to switchHoliday');
  commands.find((c) => c.name === '/settings').run();
  assert.ok(calls.includes('settings'), '/settings must dispatch to showSettings');
  commands.find((c) => c.name === '/nick').run('Ромыч');
  assert.ok(calls.includes('nick:Ромыч'), '/nick must dispatch to switchNickname');
  commands.find((c) => c.name === '/restart').run();
  assert.ok(calls.includes('restart'), '/restart must dispatch to restartClient');
  commands.find((c) => c.name === '/diagnose').run();
  assert.ok(calls.includes('diagnose'), '/diagnose must dispatch to showDiagnostics');
  commands.find((c) => c.name === '/reconnect').run();
  assert.ok(calls.includes('reconnect'), '/reconnect must dispatch to reconnectPeer');
  commands.find((c) => c.name === '/sysmsg').run('off');
  assert.ok(calls.includes('sysmsg:off'), '/sysmsg must dispatch to switchSysmsg');
  commands.find((c) => c.name === '/sound').run('on');
  assert.ok(calls.includes('sound:on'), '/sound must dispatch to switchSound');
  commands.find((c) => c.name === '/block').run('roman@example.com');
  assert.ok(calls.includes('block:roman@example.com'), '/block must dispatch to blockPeer');
  commands.find((c) => c.name === '/unblock').run('roman@example.com');
  assert.ok(calls.includes('unblock:roman@example.com'), '/unblock must dispatch to unblockPeer');
  commands.find((c) => c.name === '/remove').run('roman@example.com');
  assert.ok(calls.includes('remove:roman@example.com'), '/remove must dispatch to removePeer');
});

test('documented key bindings are listed for in-chat help', () => {
  // The table holds translation keys now, so the check has to render them. The
  // shortcut modifier reads ⌘ on a Mac and Ctrl elsewhere.
  const t = createTranslator('en');
  const mod = process.platform === 'darwin' ? '⌘' : 'Ctrl+';
  const text = chatKeys.map((key) => t(key)).join('\n');
  for (const key of ['Shift+Up', 'PgUp', `${mod}U`, `${mod}W`, `${mod}V`, `${mod}G`, 'Enter']) {
    assert.ok(text.includes(key), `${key} is not documented`);
  }
});

test('every language documents the same key bindings', () => {
  for (const lang of LANGUAGES) {
    const t = createTranslator(lang);
    for (const key of chatKeys) {
      assert.ok(t(key).length > 0, `${lang} is missing ${key}`);
    }
  }
});
test('parseArgs: --help sets help true without requiring peer', () => {
  const r = parseArgs(['--help'], defaults);
  assert.equal(r.help, true);
});
test('parseArgs: missing peer throws', () => {
  assert.throws(() => parseArgs([], defaults));
});
test('parseArgs: cloud actions do not require a positional peer', () => {
  const cloud = parseArgs(['--cloud'], defaults);
  assert.equal(cloud.cloud, true);
  assert.equal(cloud.peer, null);

  const server = parseArgs(['--cloud-server', 'https://cloud.example'], defaults);
  assert.equal(server.cloud, true);
  assert.equal(server.cloudServer, 'https://cloud.example');
  assert.equal(server.peer, null);

  const logout = parseArgs(['--cloud-logout'], defaults);
  assert.equal(logout.cloudLogout, true);
  assert.equal(logout.peer, null);
});
test('parseArgs: the mouse is off unless --mouse asks for it', () => {
  const off = parseArgs(['lit'], defaults);
  assert.equal(off.mouse, false);
  const on = parseArgs(['lit', '--mouse'], defaults);
  assert.equal(on.mouse, true);
});
test('parseArgs: --no-log and the explicit --lang marker', () => {
  const r = parseArgs(['lit', '--no-log', '--lang', 'fr'], defaults);
  assert.equal(r.noLog, true);
  assert.equal(r.lang, 'fr');
  assert.equal(r.langExplicit, true);
});

test('parseArgs: a language from the environment is not explicit', () => {
  const r = parseArgs(['lit'], defaults);
  assert.equal(r.langExplicit, false);
});

test('parseArgs: --menu asks for a peer even when one is named', () => {
  const r = parseArgs(['lit', '--menu'], defaults);
  assert.equal(r.menu, true);
  assert.equal(r.peer, 'lit');
});

test('parseArgs: --log and --no-log together are refused, not silently resolved', () => {
  assert.throws(() => parseArgs(['lit', '--log', 'x.log', '--no-log'], defaults));
});

test('choosePeer: nobody remembered ends in the hint, not a hang', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-pick-'));
  const output = new PassThrough();
  const written = [];
  output.on('data', (chunk) => written.push(String(chunk)));
  assert.equal(await choosePeer({ stateDir: dir, cliPath: null, t: (k) => k, output }), null);
  assert.match(written.join(''), /pick\.empty/);
});

test('choosePeer: one remembered person is dialled without asking', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-pick-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'roster.json'), JSON.stringify({
    logins: {
      'roman@example.com': {
        devices: [{ host: 'lit', dns: 'lit.example.ts.net', ips: ['100.64.0.5'] }],
        names: ['roman'],
      },
    },
  }));
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  // No cliPath and a pipe: the single choice must need no terminal at all.
  assert.equal(await choosePeer({
    stateDir: dir, cliPath: null, t: (k) => k, input, output,
  }), 'roman@example.com');
  input.end();
});

test('choosePeer: several remembered people and a pipe keep the numbered list', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-pick-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'roster.json'), JSON.stringify({
    logins: {
      'roman@example.com': {
        devices: [{ host: 'lit', dns: 'lit.example.ts.net', ips: ['100.64.0.5'] }],
        names: [],
      },
      'ella@example.com': {
        devices: [{ host: 'ella', dns: 'ella.example.ts.net', ips: ['100.64.0.9'] }],
        names: [],
      },
    },
  }));
  const input = new PassThrough();
  input.write('2\n');
  const output = new PassThrough();
  const written = [];
  output.on('data', (chunk) => written.push(String(chunk)));
  assert.equal(await choosePeer({
    stateDir: dir, cliPath: null, t: (k) => k, input, output,
  }), 'roman@example.com');
  input.end();
  assert.match(written.join(''), /pick\.title/);
});
test('formatLine: HH:MM name: text', () => {
  const ts = new Date('2026-08-11T14:02:00').getTime();
  assert.equal(formatLine(ts, 'lit', 'hi'), '[14:02] lit: hi');
});

test('relabelLogLine renames only the anchored sender field, not the message body', () => {
  assert.equal(
    relabelLogLine('[14:02] desktop-ag8b8u4: hi', 'desktop-ag8b8u4', 'Роман'),
    '[14:02] Роман: hi',
  );
  // A message that happens to quote the old name in its own text is untouched
  // — only the timestamped sender prefix at the very start counts.
  assert.equal(
    relabelLogLine('[14:02] alice: desktop-ag8b8u4 is my machine', 'desktop-ag8b8u4', 'Роман'),
    '[14:02] alice: desktop-ag8b8u4 is my machine',
  );
  // A continuation line of a multiline message carries no `[HH:MM] name:`
  // prefix at all, so it passes through unchanged either way.
  assert.equal(
    relabelLogLine('second line, no prefix', 'desktop-ag8b8u4', 'Роман'),
    'second line, no prefix',
  );
  // Nothing to rename: the line, the missing `from`, and `from === to` are
  // all left exactly as given.
  assert.equal(relabelLogLine('[14:02] Roman: hi', null, 'Роман'), '[14:02] Roman: hi');
  assert.equal(relabelLogLine('[14:02] Roman: hi', 'Roman', 'Roman'), '[14:02] Roman: hi');
});

test('parseLogEntries reads headered lines and folds continuations into them', () => {
  assert.deepEqual(parseLogEntries(['[14:02] lit: hi', '[14:05] Roman: hello there']), [
    { hh: 14, mm: 2, name: 'lit', text: 'hi' },
    { hh: 14, mm: 5, name: 'Roman', text: 'hello there' },
  ]);
  // A continuation line carries no prefix and belongs to the message above it.
  assert.deepEqual(
    parseLogEntries(['[09:00] lit: line one', 'line two', 'line three']),
    [{ hh: 9, mm: 0, name: 'lit', text: 'line one\nline two\nline three' }],
  );
  // A file that starts mid-message (a truncated write) has no header at all —
  // it comes back as plain, uncoloured text instead of losing the line.
  assert.deepEqual(parseLogEntries(['stray continuation']), [
    { hh: null, mm: null, name: null, text: 'stray continuation' },
  ]);
  assert.deepEqual(parseLogEntries([]), []);
});

test('slicing the last N messages after parsing keeps a multiline one whole at the edge', () => {
  // A pasted block near the boundary of "last 2 messages": if the file's raw
  // lines were sliced to a window first and only then parsed, a 2-line window
  // could land inside the paste and strand its tail without the header that
  // names its sender (see loadLogEntries in cli.js, which parses the whole
  // file before slicing for exactly this reason).
  const lines = [
    '[09:00] lit: morning',
    '[09:01] Roman: check this out',
    'line two of the paste',
    'line three of the paste',
    '[09:02] lit: nice',
  ];
  const lastTwo = parseLogEntries(lines).slice(-2);
  assert.deepEqual(lastTwo, [
    {
      hh: 9, mm: 1, name: 'Roman', text: 'check this out\nline two of the paste\nline three of the paste',
    },
    { hh: 9, mm: 2, name: 'lit', text: 'nice' },
  ]);
  // The naive order — slice the last 2 physical lines, then parse — is what
  // this guards against: it would cut the paste's own two tail lines loose
  // with no header at all, each an anonymous, uncoloured fragment.
  const naive = parseLogEntries(lines.slice(-2));
  assert.deepEqual(naive, [
    { hh: null, mm: null, name: null, text: 'line three of the paste' },
    { hh: 9, mm: 2, name: 'lit', text: 'nice' },
  ]);
});

test('logEntryMessage builds a ui.addMessage payload, or null without a header', () => {
  const message = logEntryMessage(
    { hh: 14, mm: 2, name: 'lit', text: 'hi' },
    { selfName: 'lit', aiName: 'assistant' },
  );
  assert.equal(message.name, 'lit');
  assert.equal(message.text, 'hi');
  assert.equal(message.self, true);
  assert.equal(message.bot, false);
  assert.equal(message.marker, '✓');
  assert.equal(message.markerRead, false, 'a plain sent line is not read');
  const date = new Date(message.ts);
  assert.equal(date.getHours(), 14);
  assert.equal(date.getMinutes(), 2);

  const messageWithMarker = logEntryMessage(
    { hh: 14, mm: 2, name: 'lit', text: 'hi', marker: '✓✓' },
    { selfName: 'lit', aiName: 'assistant' },
  );
  assert.equal(messageWithMarker.marker, '✓✓');
  assert.equal(messageWithMarker.markerRead, true, 'a logged ✓✓ is the read rung');

  const peer = logEntryMessage(
    { hh: 9, mm: 30, name: 'Roman', text: 'hey' },
    { selfName: 'lit', aiName: 'assistant' },
  );
  assert.equal(peer.self, false);
  assert.equal(peer.bot, false);
  assert.equal(peer.marker, null);

  const bot = logEntryMessage(
    { hh: 9, mm: 30, name: 'assistant', text: 'hey' },
    { selfName: 'lit', aiName: 'assistant' },
  );
  assert.equal(bot.self, false);
  assert.equal(bot.bot, true);
  assert.equal(bot.marker, null);

  assert.equal(
    logEntryMessage({ hh: null, mm: null, name: null, text: 'x' }, { selfName: 'lit', aiName: 'a' }),
    null,
  );
});

test('parseLogEntries parses explicit delivery markers when present', () => {
  assert.deepEqual(parseLogEntries(['[14:02] lit [✓✓]: hi', '[14:05] Roman: hello']), [
    { hh: 14, mm: 2, name: 'lit', marker: '✓✓', text: 'hi' },
    { hh: 14, mm: 5, name: 'Roman', text: 'hello' },
  ]);
});

test('splitLogTail separates lines from before this session from ones written during it', () => {
  // 10 lines total on disk; the session opened the log after the first 7, so
  // a tail of the last 5 (lines 6-10) has two old (6-7) and three fresh (8-10).
  const tail = ['f', 'g', 'h', 'i', 'j'];
  assert.deepEqual(
    splitLogTail(tail, { totalLines: 10, sessionStart: 7 }),
    { old: ['f', 'g'], fresh: ['h', 'i', 'j'] },
  );
  // Nothing written yet this session: the whole tail is old.
  assert.deepEqual(
    splitLogTail(tail, { totalLines: 10, sessionStart: 10 }),
    { old: tail, fresh: [] },
  );
  // The session started before the file had any of these lines (a fresh log,
  // or the boundary predates the window entirely): the whole tail is fresh.
  assert.deepEqual(
    splitLogTail(tail, { totalLines: 10, sessionStart: 3 }),
    { old: [], fresh: tail },
  );
});

test('resolveSaverAfterMinutes clamps and defaults a hand-edited config value', () => {
  // Nothing saved yet, or the file was hand-edited into nonsense: 15 minutes,
  // the same tolerance normaliseSelfName and resolveThemeName give a mangled
  // config.
  assert.equal(resolveSaverAfterMinutes(undefined), SAVER_AFTER_DEFAULT_MINUTES);
  assert.equal(resolveSaverAfterMinutes(null), SAVER_AFTER_DEFAULT_MINUTES);
  assert.equal(resolveSaverAfterMinutes('not a number'), SAVER_AFTER_DEFAULT_MINUTES);
  assert.equal(resolveSaverAfterMinutes(NaN), SAVER_AFTER_DEFAULT_MINUTES);
  assert.equal(resolveSaverAfterMinutes(''), SAVER_AFTER_DEFAULT_MINUTES);
  // A real value in range survives, string or number alike.
  assert.equal(resolveSaverAfterMinutes(10), 10);
  assert.equal(resolveSaverAfterMinutes('10'), 10);
  // A fraction rounds rather than truncating or being refused outright.
  assert.equal(resolveSaverAfterMinutes(10.6), 11);
  // Out of range is clamped, not defaulted — a person's own too-high or
  // too-low number is honoured as closely as it can be.
  assert.equal(resolveSaverAfterMinutes(0), SAVER_AFTER_MIN_MINUTES);
  assert.equal(resolveSaverAfterMinutes(-5), SAVER_AFTER_MIN_MINUTES);
  assert.equal(resolveSaverAfterMinutes(99999), SAVER_AFTER_MAX_MINUTES);
});

const DROPPED = new Set(['/tmp/a b.png', '/tmp/c.jpg', '/Users/x/photo.jpg']);
const dropExists = (candidate) => DROPPED.has(candidate);

test('a dragged path is unescaped the way each terminal writes it', () => {
  assert.equal(unescapeDroppedPath('/Users/x/photo.jpg'), '/Users/x/photo.jpg');
  // macOS escapes the spaces; Windows quotes the whole thing, and inside quotes
  // a backslash is a literal separator.
  assert.equal(unescapeDroppedPath('/tmp/a\\ b.png'), '/tmp/a b.png');
  // This helper only ever produces the *unescaped reading*. On a Windows path
  // that reading is wrong, which is precisely why resolvePastedPath checks the
  // literal one against the filesystem first and only falls back to this.
  assert.equal(unescapeDroppedPath('C:\\Users\\x\\a.png'), 'C:Usersxa.png');
  assert.equal(unescapeDroppedPath('"C:\\Users\\x\\a.png"'), 'C:Usersxa.png');
});

test('dropping a file yields its path, and prose yields nothing', () => {
  assert.deepEqual(droppedPaths('/Users/x/photo.jpg', dropExists), ['/Users/x/photo.jpg']);
  assert.deepEqual(droppedPaths('/tmp/a\\ b.png', dropExists), ['/tmp/a b.png']);
  // A message that merely looks path-like must still be sent as text.
  assert.deepEqual(droppedPaths('/tmp/nope.png', dropExists), []);
  assert.deepEqual(droppedPaths('just talking', dropExists), []);
  assert.deepEqual(droppedPaths('', dropExists), []);
});

test('several files dropped at once are all sent', () => {
  assert.deepEqual(
    droppedPaths('/tmp/a b.png\n/tmp/c.jpg', dropExists),
    ['/tmp/a b.png', '/tmp/c.jpg'],
  );
  assert.deepEqual(
    droppedPaths('/tmp/a\\ b.png /tmp/c.jpg', dropExists),
    ['/tmp/a b.png', '/tmp/c.jpg'],
  );
});

test('a space-separated split is refused unless every part is a real file', () => {
  // Otherwise an ordinary sentence containing a filename would vanish into a
  // transfer the person never asked for.
  assert.deepEqual(droppedPaths('/tmp/c.jpg and some words', dropExists), []);
});

test('a pasted path is read the way the filesystem confirms, not by guesswork', () => {
  const real = new Set(['/Users/g/Telegram Desktop/a.mp3', 'C:\\Users\\x\\a.png']);
  const exists = (candidate) => real.has(candidate);

  // macOS escapes the space; the escaped reading is the real file.
  assert.equal(
    resolvePastedPath('/Users/g/Telegram\\ Desktop/a.mp3', exists),
    '/Users/g/Telegram Desktop/a.mp3',
  );
  // An unquoted Windows path must survive: unescaping it blindly would turn
  // C:\Users\x\a.png into C:Usersxa.png, which is how /send used to fail.
  assert.equal(resolvePastedPath('C:\\Users\\x\\a.png', exists), 'C:\\Users\\x\\a.png');
  assert.equal(resolvePastedPath('"C:\\Users\\x\\a.png"', exists), 'C:\\Users\\x\\a.png');

  assert.equal(resolvePastedPath('/nope.txt', exists), null);
  assert.equal(resolvePastedPath('', exists), null);
});

test('an unquoted Windows path can still be dropped', () => {
  const exists = (candidate) => candidate === 'C:\\Users\\x\\a.png';
  assert.deepEqual(droppedPaths('C:\\Users\\x\\a.png', exists), ['C:\\Users\\x\\a.png']);
});

test('opening a URL normalises a bare www host', () => {
  assert.equal(normaliseUrl('https://x.dev'), 'https://x.dev');
  assert.equal(normaliseUrl('www.x.dev'), 'https://www.x.dev');
});

test('a local path is opened as a path, never as a host', () => {
  // A clickable path in the transcript goes through the same opener as a link,
  // and `https:///Users/…` is a 404 in a browser rather than a picture on
  // screen.
  assert.equal(normaliseUrl('/Users/me/.tailchat/files/image-1.webp'), '/Users/me/.tailchat/files/image-1.webp');
  assert.equal(normaliseUrl('  /tmp/shot.png  '), '/tmp/shot.png', 'padded by a selection');
  assert.equal(normaliseUrl('file:///tmp/shot.png'), 'file:///tmp/shot.png');
  assert.equal(normaliseUrl('~/shot.png'), path.join(os.homedir(), 'shot.png'));
  assert.equal(normaliseUrl('~'), os.homedir());
});

test('a Mac opens an existing picture in Preview by bundle id, other files in the default app', () => {
  const exists = (candidate) => candidate === '/in/shot.png';
  const terms = { platform: 'darwin', exists, termux: false };
  assert.deepEqual(systemOpener('/in/shot.png', terms),
    { cmd: 'open', args: ['-b', 'com.apple.Preview', '/in/shot.png'] });
  // A picture that is no longer on disk, and any non-picture, keep plain open —
  // so a reassigned default still wins for non-images and a missing file fails
  // with the same "cannot open" as before instead of a second, confusing error.
  assert.deepEqual(systemOpener('/in/gone.png', terms), { cmd: 'open', args: ['/in/gone.png'] });
  assert.deepEqual(systemOpener('/in/notes.txt', terms), { cmd: 'open', args: ['/in/notes.txt'] });
  // A chat link that merely ends in an image extension is not a local file.
  assert.deepEqual(systemOpener('https://x.dev/a.png', terms), { cmd: 'open', args: ['https://x.dev/a.png'] });
});

test('every other platform hands the file to its own opener', () => {
  const noTermux = { platform: 'linux', exists: () => true, termux: false };
  assert.deepEqual(systemOpener('/in/f.png', noTermux), { cmd: 'xdg-open', args: ['/in/f.png'] });
  const windows = { platform: 'win32', exists: () => true, termux: false };
  assert.deepEqual(systemOpener('/in/f.png', windows), { cmd: 'cmd', args: ['/c', 'start', '', '/in/f.png'] });
  const termux = { platform: 'linux', exists: () => true, termux: true };
  assert.deepEqual(systemOpener('/in/f.png', termux), { cmd: 'termux-open', args: ['/in/f.png'] });
  // A Windows path carries backslashes; the extension check reads it the same.
  const winImage = { platform: 'win32', exists: () => true, termux: false };
  assert.deepEqual(systemOpener('C:\\Users\\x\\a.png', winImage), { cmd: 'cmd', args: ['/c', 'start', '', 'C:\\Users\\x\\a.png'] });
});

test('a received .webp is converted to a temp PNG before Preview ever sees it', async () => {
  // Preview launches successfully on a .webp and still fails to show it (see
  // resolveOpenTarget's own comment) — the fix routes the file through the
  // same converter /view already trusts, and only for exactly this shape.
  const written = {};
  const webpBytes = Buffer.from('fake-webp');
  const pngBytes = Buffer.from('fake-png');
  const deps = {
    platform: 'darwin',
    exists: (p) => p === '/in/shot.webp',
    termux: false,
    readFile: (p) => (p === '/in/shot.webp' ? webpBytes : assert.fail('unexpected read')),
    writeFile: (p, data) => { written[p] = data; },
    mkdtemp: () => '/tmp/tailchat-open-abc',
    convert: async (payload) => (payload === webpBytes ? pngBytes : null),
  };
  const resolved = await resolveOpenTarget('/in/shot.webp', deps);
  assert.equal(resolved, '/tmp/tailchat-open-abc/shot.png');
  assert.deepEqual(written[resolved], pngBytes);
  // Feeding the resolved path back through systemOpener is what openPath
  // actually does: Preview now opens the PNG, not the .webp it could not show.
  assert.deepEqual(
    systemOpener(resolved, { platform: 'darwin', exists: () => true, termux: false }),
    { cmd: 'open', args: ['-b', 'com.apple.Preview', resolved] },
  );
});

test('resolveOpenTarget leaves everything but an existing local darwin .webp alone', async () => {
  const untouchedDeps = (overrides) => ({
    exists: () => true,
    termux: false,
    readFile: () => assert.fail('should not read'),
    writeFile: () => assert.fail('should not write'),
    convert: async () => assert.fail('should not convert'),
    ...overrides,
  });
  // Any other platform: xdg-open/cmd/termux-open never single out Preview,
  // so there is nothing here for the conversion to fix.
  assert.equal(
    await resolveOpenTarget('/in/shot.webp', untouchedDeps({ platform: 'linux' })),
    '/in/shot.webp',
  );
  assert.equal(
    await resolveOpenTarget('/in/shot.webp', untouchedDeps({ platform: 'win32' })),
    '/in/shot.webp',
  );
  // Termux has its own opener regardless of the reported platform.
  assert.equal(
    await resolveOpenTarget('/in/shot.webp', untouchedDeps({ platform: 'darwin', termux: true })),
    '/in/shot.webp',
  );
  // A .webp that is not actually on disk: systemOpener already falls back to
  // plain `open` for it, same as any missing file.
  assert.equal(
    await resolveOpenTarget('/in/gone.webp', untouchedDeps({ platform: 'darwin', exists: () => false })),
    '/in/gone.webp',
  );
  // Every non-webp format keeps going through Preview exactly as before.
  assert.equal(
    await resolveOpenTarget('/in/shot.png', untouchedDeps({ platform: 'darwin' })),
    '/in/shot.png',
  );
});

test('resolveOpenTarget falls back to the original .webp when conversion fails', async () => {
  // A decode/convert failure must never be worse than doing nothing: no
  // thrown error out of a click handler, and the file `open` already knew
  // how to attempt is still what gets handed to it.
  const baseDeps = {
    platform: 'darwin',
    exists: () => true,
    termux: false,
    readFile: () => Buffer.from('fake-webp'),
  };
  assert.equal(
    await resolveOpenTarget('/in/shot.webp', {
      ...baseDeps,
      writeFile: () => assert.fail('should not write'),
      mkdtemp: () => assert.fail('should not mkdtemp'),
      convert: async () => null,
    }),
    '/in/shot.webp',
  );
  assert.equal(
    await resolveOpenTarget('/in/shot.webp', {
      ...baseDeps,
      mkdtemp: () => { throw new Error('disk full'); },
      writeFile: () => assert.fail('should not write'),
      convert: async () => Buffer.from('fake-png'),
    }),
    '/in/shot.webp',
  );
});

test('choosePeer: the local user is never offered, even from a poisoned roster', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-pick-'));
  const output = new PassThrough();
  const written = [];
  output.on('data', (chunk) => written.push(String(chunk)));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'roster.json'), JSON.stringify({
    logins: {
      'me@example.com': {
        devices: [{ host: 'macbook-pro', dns: 'macbook-pro.tail6ab02b.ts.net', ips: ['100.122.98.16'] }],
        names: ['macbook-pro'],
      },
      'roman@example.com': {
        devices: [{ host: 'desktop-iru', dns: 'desktop-iru.tailc80816.ts.net', ips: ['100.105.157.69'] }],
        names: ['roman'],
      },
    },
  }));
  const input = new PassThrough();
  const picked = choosePeer({
    stateDir: dir, cliPath: null, t: (k) => k, input, output,
    self: { login: null, ips: ['100.122.98.16'] },
  });
  input.end();
  assert.equal(await picked, 'roman@example.com');
  assert.ok(!written.join('').includes('me@example.com'));
});

test('formatDuration formats seconds, minutes, and hours', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(5000), '5s');
  assert.equal(formatDuration(65000), '1m 5s');
  assert.equal(formatDuration(3665000), '1h 1m 5s');
});

test('formatRoute formats direct, private, relayed, and tailnet routes', () => {
  const t = (k, params) => `${k}:${JSON.stringify(params || {})}`;
  assert.equal(
    formatRoute({ kind: 'direct-lan', endpoint: '[fe80::1]:41641' }, t),
    'route.directLan:{"endpoint":"[fe80::1]:41641"}',
  );
  assert.equal(
    formatRoute({ kind: 'direct-private', endpoint: '10.66.66.254:41641' }, t),
    'route.directPrivate:{"endpoint":"10.66.66.254:41641"}',
  );
  assert.equal(
    formatRoute({ kind: 'direct-wan', endpoint: '95.24.12.33:41641' }, t),
    'route.directWan:{"endpoint":"95.24.12.33:41641"}',
  );
  assert.equal(
    formatRoute({ kind: 'derp-relay', relay: 'fra' }, t),
    'route.derpRelay:{"relay":"fra"}',
  );
  assert.equal(
    formatRoute({ kind: 'tailnet', endpoint: '100.78.12.77' }, t),
    'route.tailnet:{"endpoint":"100.78.12.77"}',
  );
});

test('formatPeerClient formats web and CLI clients with or without version', () => {
  assert.equal(formatPeerClient('web'), 'tailchat web');
  assert.equal(formatPeerClient('vweb'), 'tailchat web');
  assert.equal(formatPeerClient('web-1.0'), 'tailchat web');
  assert.equal(formatPeerClient('0.81.0'), 'tailchat cli (v0.81.0)');
  assert.equal(formatPeerClient('0.57.32'), 'tailchat cli (v0.57.32)');
  assert.equal(formatPeerClient(null), 'tailchat cli');
  assert.equal(formatPeerClient(''), 'tailchat cli');
});

test('formatLastPeerMessage formats timestamps, previews, voice, images, or empty state', () => {
  const t = createTranslator('en');
  assert.equal(formatLastPeerMessage(null, t), 'none');

  const ts = new Date(2026, 8, 1, 13, 14, 5).getTime();
  const res = formatLastPeerMessage({ text: 'Hello there!', ts }, t);
  assert.match(res, /^\d{2}:\d{2}:\d{2} \("Hello there!"\)$/);

  const longText = 'A'.repeat(50);
  const longRes = formatLastPeerMessage({ text: longText, ts }, t);
  assert.match(longRes, /^\d{2}:\d{2}:\d{2} \("A{37}\.\.\."\)$/);

  const voiceRes = formatLastPeerMessage({ text: '', voice: true, ts }, t);
  assert.match(voiceRes, /^\d{2}:\d{2}:\d{2} \("🎤 voice"\)$/);

  const imgRes = formatLastPeerMessage({ text: '', image: true, ts }, t);
  assert.match(imgRes, /^\d{2}:\d{2}:\d{2} \("🖼 image"\)$/);
});

test('chatCommands and AI_SAFE_COMMANDS include /ping, /status, /remind, /autoupdate, and /sysmsg', () => {
  const cmdNames = chatCommands.map((c) => c.name);
  assert.ok(cmdNames.includes('/ping'));
  assert.ok(cmdNames.includes('/status'));
  assert.ok(cmdNames.includes('/remind'));
  assert.ok(cmdNames.includes('/autoupdate'));
  assert.ok(cmdNames.includes('/sysmsg'));
  assert.ok(AI_SAFE_COMMANDS.includes('/ping'));
  assert.ok(AI_SAFE_COMMANDS.includes('/status'));
  assert.ok(AI_SAFE_COMMANDS.includes('/remind'));
  assert.ok(AI_SAFE_COMMANDS.includes('/autoupdate'));
  assert.ok(AI_SAFE_COMMANDS.includes('/sysmsg'));
});

test('hashPassword and verifyPassword securely hash and verify passwords', () => {
  const hash = hashPassword('my-secret-pass');
  assert.ok(hash);
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 64);
  assert.equal(verifyPassword('my-secret-pass', hash), true);
  assert.equal(verifyPassword('wrong-pass', hash), false);
  assert.equal(verifyPassword('', hash), false);
  assert.equal(verifyPassword(null, hash), false);
  assert.equal(verifyPassword('any', null), true); // no password set
});

test('isAudioFile identifies common audio formats', () => {
  assert.equal(isAudioFile('voice.wav'), true);
  assert.equal(isAudioFile('/path/to/note.mp3'), true);
  assert.equal(isAudioFile('song.M4A'), true);
  assert.equal(isAudioFile('track.opus'), true);
  assert.equal(isAudioFile('photo.png'), false);
  assert.equal(isAudioFile('document.pdf'), false);
  assert.equal(isAudioFile(''), false);
  assert.equal(isAudioFile(null), false);
});

// Chrome and Firefox both default MediaRecorder voice notes to
// "audio/webm;codecs=opus" — a mediatype with a parameter, not the bare
// "audio/mp4" the Android and CLI recorders send. A parser that required
// ";base64," right after the mediatype silently dropped every such note:
// no file saved, no card shown, nothing to play at all.
test('parseDataUrl tolerates a codecs parameter between the mediatype and the base64 marker', () => {
  assert.deepEqual(
    parseDataUrl('data:audio/webm;codecs=opus;base64,QUJD'),
    { mediaType: 'audio/webm', base64: 'QUJD' },
  );
  assert.deepEqual(
    parseDataUrl('data:audio/ogg;codecs=opus;base64,QUJD'),
    { mediaType: 'audio/ogg', base64: 'QUJD' },
  );
  assert.deepEqual(
    parseDataUrl('data:audio/mp4;base64,QUJD'),
    { mediaType: 'audio/mp4', base64: 'QUJD' },
  );
  assert.equal(parseDataUrl('not a data url'), null);
  assert.equal(parseDataUrl(''), null);
  assert.equal(parseDataUrl(null), null);
});

test('createHeadlessUI implements complete UI interface without crashes', () => {
  const ui = createHeadlessUI({ selfName: 'alice', peerLabel: 'bob' });
  assert.equal(ui.isHeadless, true);
  assert.equal(ui.isFocused(), false);
  assert.equal(ui.focusTracked(), true);
  assert.equal(ui.saverActive(), false);
  assert.equal(ui.saverFits(), false);
  assert.equal(ui.isSaverActive(), false);
  assert.equal(ui.isLocked(), false);
  assert.equal(ui.isMouseCaptured(), false);

  assert.doesNotThrow(() => {
    ui.addLine('Test status line');
    ui.addMessage({ name: 'bob', text: 'Hello', ts: Date.now() });
    ui.addSection('Test section', ['row 1', { left: 'key', text: 'val' }]);
    ui.addArt(['art line'], 'photo.png');
    ui.bell();
    ui.setTheme('ocean');
    ui.setStatus('online');
    ui.setStatus('reconnecting…');
    ui.setUpdateAvailable(true);
    ui.hideSaverScreen();
    ui.setPeerPresence('active');
    ui.setPeerName('robert');
    ui.setPeerDevice('laptop');
    ui.setSending('file.txt');
    ui.setAiTyping('tailik');
    ui.setMessageMarker('id1', '✓');
    ui.destroy();
  });
});

test('createHeadlessUI holds the delivered and read rungs of the marker ladder', () => {
  const ui = createHeadlessUI({ selfName: 'alice', peerLabel: 'bob' });
  ui.addMessage({ id: 'm1', name: 'alice', text: 'hi', ts: 0, self: true, marker: '⧗' });

  // The ack says the peer's device holds it; the glyph cannot say more than
  // that, but it is a higher rung than sent and must not be walked back.
  assert.equal(ui.setMessageMarker('m1', '✓✓'), true);
  assert.equal(ui.markerOf('m1'), '✓✓');
  assert.equal(ui.setMessageMarker('m1', '✓'), false, 'a late ack cannot undo a ✓✓');

  // A read receipt lands on the same glyph and leaves it there.
  assert.equal(ui.markReadUpTo('m1'), true);
  assert.equal(ui.markerOf('m1'), '✓✓');
  ui.destroy();
});

test('createHeadlessUI draws ⚠ on the same ladder: ⧗ and ⚠ swap, nothing confirmed goes back', () => {
  const ui = createHeadlessUI({ selfName: 'alice', peerLabel: 'bob' });
  ui.addMessage({ id: 'm1', name: 'alice', text: 'hi', ts: 0, self: true, marker: '⧗' });
  assert.equal(ui.setMessageMarker('m1', '⚠'), true);
  assert.equal(ui.markerOf('m1'), '⚠');
  assert.equal(ui.setMessageMarker('m1', '⧗'), true, 'retried');
  assert.equal(ui.setMessageMarker('m1', '✓'), true);
  assert.equal(ui.setMessageMarker('m1', '⚠'), false, 'a failure never overwrites a confirmed mark');
  assert.equal(ui.markerOf('m1'), '✓');

  // A read receipt skips the row that never left, unless it is the row it names.
  ui.addMessage({ id: 'failed', name: 'alice', text: 'x', ts: 1, self: true, marker: '⚠' });
  ui.addMessage({ id: 'later', name: 'alice', text: 'y', ts: 2, self: true, marker: '✓' });
  assert.equal(ui.markReadUpTo('later'), true);
  assert.equal(ui.markerOf('failed'), '⚠');
  assert.equal(ui.markerOf('m1'), '✓✓');
  assert.equal(ui.markReadUpTo('failed'), true, 'the named message was read after all');
  assert.equal(ui.markerOf('failed'), '✓✓');
  ui.destroy();
});

// ---- Under TAILCHAT_CORE=1: the store's rows in the transcript ----------------

const ROW_BASE = {
  peer: 'bob', from: 'alice', ts: 100, text: 'hello', reactions: [],
};
const coreRow = (over) => ({ source: 'sent', id: 'm1', ...ROW_BASE, ...over });

test('a row\'s mark is the core\'s receipt on the one ladder; a row without one is committed', () => {
  assert.deepEqual(coreRowMarker(coreRow({ receipt: 'queued' })), { marker: '⧗', markerRead: false });
  assert.deepEqual(coreRowMarker(coreRow({ receipt: 'sent' })), { marker: '✓', markerRead: false });
  assert.deepEqual(coreRowMarker(coreRow({ receipt: 'delivered' })), { marker: '✓✓', markerRead: false });
  assert.deepEqual(coreRowMarker(coreRow({ receipt: 'read' })), { marker: '✓✓', markerRead: true });
  assert.deepEqual(coreRowMarker(coreRow({ receipt: 'failed' })), { marker: '⚠', markerRead: false });
  // this account's own message from another device: the server holds it
  assert.deepEqual(coreRowMarker(coreRow({ source: 'message', receipt: undefined })), { marker: '✓', markerRead: false });
  // a receipt this client has never heard of is not a reason to draw nothing, or something inherited
  assert.deepEqual(coreRowMarker(coreRow({ receipt: 'constructor' })), { marker: '✓', markerRead: false });
  assert.deepEqual(coreRowMarker(coreRow({ receipt: null })), { marker: '✓', markerRead: false });
});

test('a core row becomes the history record the transcript already reads', () => {
  const own = coreRowToHistoryMessage(coreRow({ receipt: 'delivered', editedAt: 150 }), { selfLogin: 'alice' });
  assert.deepEqual(own, {
    id: 'm1',
    from: 'alice',
    text: 'hello',
    ts: 100,
    kind: 'human',
    reactions: {},
    editedAt: 150,
    marker: '✓✓',
    markerRead: false,
  });

  const theirs = coreRowToHistoryMessage(coreRow({
    source: 'message', from: 'bob', id: 'in1', receipt: undefined, text: 'hi',
    reactions: [{ emoji: '👍', by: ['alice', 'bob'] }, { emoji: '🔥', by: [] }],
    replyTo: { id: 'm1', from: 'alice', text: 'hello', media: null },
    image: { dataUrl: 'data:image/png;base64,AA==', width: 1, height: 1 },
    voice: null,
    author: null,
    editedAt: null,
  }), { selfLogin: 'alice' });
  assert.equal(theirs.marker, undefined, 'a peer\'s message carries no mark');
  assert.equal(theirs.markerRead, undefined);
  assert.deepEqual(theirs.reactions, { '👍': ['alice', 'bob'] }, 'an emoji nobody holds is not drawn');
  assert.deepEqual(theirs.replyTo, { id: 'm1', from: 'alice', text: 'hello', media: null });
  assert.equal(theirs.image.dataUrl, 'data:image/png;base64,AA==');
  for (const absent of ['voice', 'author', 'editedAt']) assert.equal(Object.hasOwn(theirs, absent), false, absent);

  const bot = coreRowToHistoryMessage(coreRow({
    source: 'message', from: 'alice', kind: 'ai', author: 'Tailik', text: 'the answer',
  }), { selfLogin: 'alice' });
  assert.equal(bot.kind, 'ai');
  assert.equal(bot.author, 'Tailik');
  assert.equal(bot.marker, undefined, 'an AI line is never the reader\'s own, whatever account ran it');

  const waiting = coreRowToHistoryMessage(coreRow({
    source: 'message', from: 'bob', id: 'w1', text: '', protection: 'waiting',
  }), { selfLogin: 'alice' });
  // In the reader's language: the live run showed Russian in an English terminal.
  assert.equal(waiting.text, '🔒 Waiting for the encryption key…');
  assert.equal(waiting.protection, 'waiting');
  const ru = { selfLogin: 'alice', t: createTranslator('ru') };
  assert.equal(coreRowToHistoryMessage(coreRow({ source: 'message', from: 'bob', id: 'w2', text: '', protection: 'waiting' }), ru).text,
    '🔒 Ждём ключ шифрования…');
  assert.equal(coreRowToHistoryMessage(coreRow({ source: 'message', from: 'bob', id: 'w3', text: '', protection: 'undecryptable' }), ru).text,
    '🔒 Не удалось расшифровать сообщение');
  assert.equal(coreRowToHistoryMessage(coreRow({ source: 'message', from: 'bob', id: 'w4', text: '', protection: 'undecryptable' }), { selfLogin: 'alice' }).text,
    '🔒 This message could not be decrypted');

  const buffer = createHistoryBuffer();
  buffer.appendMessage({ id: 'w1', name: 'Bob', text: waiting.text, ts: 100, self: false });
  const unsealed = reconcileCoreRows([
    coreRow({ source: 'message', id: 'w1', from: 'bob', ts: 100, text: 'secret opened', protection: 'encrypted' }),
  ], bufferUi(buffer), { selfLogin: 'alice' });
  assert.deepEqual(unsealed, []);
  assert.equal(buffer.messageById('w1').text, 'secret opened');
  assert.equal(buffer.content().includes('(edited)'), false, 'unsealing a waiting row is not an edit');
});

test('a core row reads as the live link draws it: no "@ " marker, a forward behind its lead', () => {
  const marked = coreRowToHistoryMessage(coreRow({ receipt: 'sent', text: '@ for the person' }), { selfLogin: 'alice' });
  assert.equal(marked.text, 'for the person');
  const ai = coreRowToHistoryMessage(coreRow({ kind: 'ai', from: 'alice', text: '@ quoted by the model' }), { selfLogin: 'alice' });
  assert.equal(ai.text, '@ quoted by the model', 'what an AI said is not rewritten');
  const forwarded = coreRowToHistoryMessage(coreRow({
    receipt: 'sent', text: 'said first elsewhere', forwardedFrom: { login: 'carol', name: 'Carol' },
  }), { selfLogin: 'alice', forwardLead: (from) => `⤷ from ${from.name}` });
  assert.equal(forwarded.text, '⤷ from Carol\nsaid first elsewhere');
});

// The UI the repaint talks to is the real history buffer behind the same
// setters createUI exposes, so what is tested is what the screen would do.
function bufferUi(buffer) {
  return {
    messageById: (id) => buffer.messageById(id),
    markReadUpTo: (id) => buffer.markReadUpTo(id),
    setMessageMarker: (id, marker) => buffer.setMarker(id, marker),
    updateMessage: (id, text, options) => buffer.updateMessage(id, text, options),
    reactionsOf: (id) => buffer.reactionsOf(id),
    setMessageReactions: (id, reactions) => buffer.setReactions(id, reactions),
  };
}

test('a repaint appends what is new and updates what the transcript already holds, in place', () => {
  const buffer = createHistoryBuffer();
  buffer.appendMessage({ id: 'own1', name: 'me', text: 'first', ts: 100, self: true, marker: '⧗' });
  buffer.appendMessage({ id: 'own2', name: 'me', text: 'second', ts: 200, self: true, marker: '⧗' });
  buffer.appendMessage({ id: 'in1', name: 'Bob', text: 'hi', ts: 150, self: false });
  const ui = bufferUi(buffer);

  const fresh = reconcileCoreRows([
    coreRow({ id: 'own1', ts: 100, receipt: 'read' }),
    coreRow({ id: 'own2', ts: 200, receipt: 'sent', text: 'second (edited)', editedAt: 250 }),
    coreRow({
      source: 'message', id: 'in1', from: 'bob', ts: 150, text: 'hi', receipt: undefined, reactions: [{ emoji: '👍', by: ['alice'] }],
    }),
    coreRow({ source: 'pending', id: 'new1', ts: 300, receipt: 'queued', text: 'brand new' }),
    coreRow({ source: 'message', id: 'new2', from: 'bob', ts: 310, receipt: undefined, text: 'and theirs' }),
  ], ui, { selfLogin: 'alice' });

  assert.deepEqual(fresh.map((message) => [message.id, message.marker]), [['new1', '⧗'], ['new2', undefined]]);
  assert.equal(buffer.markerOf('own1'), '✓✓');
  assert.match(buffer.content(), /\{green-fg\}✓✓/, 'read is the accent colour');
  assert.equal(buffer.markerOf('own2'), '✓', 'the store says sent: the clock climbs');
  assert.equal(buffer.messageById('own2').text, 'second (edited)');
  assert.deepEqual(buffer.reactionsOf('in1'), { '👍': ['alice'] });
});

test('a repaint changes nothing it was not told about, and never lowers a mark', () => {
  const buffer = createHistoryBuffer();
  buffer.appendMessage({ id: 'own1', name: 'me', text: 'x', ts: 100, self: true, marker: '✓✓', markerRead: true });
  buffer.appendMessage({ id: 'own2', name: 'me', text: 'y', ts: 200, self: true, marker: '⚠' });
  buffer.appendMessage({ id: 'in1', name: 'Bob', text: 'drawn with its own text', ts: 150, self: false });
  const before = buffer.content();
  const ui = bufferUi(buffer);

  // a stale snapshot: older receipts, and a text that differs without an edit marker
  const fresh = reconcileCoreRows([
    coreRow({ id: 'own1', ts: 100, receipt: 'sent' }),
    coreRow({ id: 'own2', ts: 200, receipt: 'failed', source: 'pending' }),
    coreRow({ source: 'message', id: 'in1', from: 'bob', ts: 150, receipt: undefined, text: 'normalised differently' }),
  ], ui, { selfLogin: 'alice' });

  assert.deepEqual(fresh, []);
  assert.equal(buffer.content(), before, 'the transcript was not touched');
  assert.equal(buffer.markerOf('own1'), '✓✓');
  assert.equal(buffer.markerOf('own2'), '⚠');
});

test('a repaint carries a retried message from ⚠ back to ⧗ and on to the confirmed rung', () => {
  const buffer = createHistoryBuffer();
  buffer.appendMessage({ id: 'own1', name: 'me', text: 'x', ts: 100, self: true, marker: '⚠' });
  const ui = bufferUi(buffer);
  reconcileCoreRows([coreRow({ source: 'pending', id: 'own1', receipt: 'queued' })], ui, { selfLogin: 'alice' });
  assert.equal(buffer.markerOf('own1'), '⧗');
  reconcileCoreRows([coreRow({ id: 'own1', receipt: 'sent' })], ui, { selfLogin: 'alice' });
  assert.equal(buffer.markerOf('own1'), '✓');
});

test('a repaint reads a read row as a watermark: older committed rows rise with it', () => {
  const buffer = createHistoryBuffer();
  buffer.appendMessage({ id: 'a', name: 'me', text: 'a', ts: 100, self: true, marker: '✓' });
  buffer.appendMessage({ id: 'b', name: 'me', text: 'b', ts: 200, self: true, marker: '✓✓' });
  buffer.appendMessage({ id: 'q', name: 'me', text: 'q', ts: 250, self: true, marker: '⧗' });
  buffer.appendMessage({ id: 'c', name: 'me', text: 'c', ts: 300, self: true, marker: '✓' });
  reconcileCoreRows([coreRow({ id: 'c', ts: 300, receipt: 'read' })], bufferUi(buffer), { selfLogin: 'alice' });
  assert.deepEqual(['a', 'b', 'q', 'c'].map((id) => buffer.markerOf(id)), ['✓✓', '✓✓', '⧗', '✓✓']);
  const content = buffer.content();
  assert.equal((content.match(/\{green-fg\}✓✓/g) ?? []).length, 3, 'a, b and c are read; the queued one is not');
});

test('a repaint never draws the carrier of an edit, and the edit still reaches its target', () => {
  const buffer = createHistoryBuffer();
  buffer.appendMessage({ id: 'own1', name: 'me', text: 'old words', ts: 100, self: true, marker: '✓' });
  const ui = bufferUi(buffer);
  const fresh = reconcileCoreRows([
    coreRow({ id: 'own1', ts: 100, receipt: 'sent', text: 'new words', editedAt: 250 }),
    coreRow({ id: 'carrier1', ts: 250, receipt: 'sent', text: 'new words', editOf: 'own1' }),
    coreRow({ source: 'message', id: 'carrier2', from: 'bob', ts: 260, receipt: undefined, text: 'their edit', editOf: 'in9' }),
  ], ui, { selfLogin: 'alice' });
  assert.deepEqual(fresh, [], 'neither carrier is a new line of the transcript');
  assert.equal(buffer.messageById('carrier1'), null);
  assert.equal(buffer.messageById('carrier2'), null);
  assert.equal(buffer.messageById('own1').text, 'new words');
  assert.match(buffer.content(), /new words.*✎/, 'the target carries the edited mark');
});

test('a reply or a forward on the core is a sealed action, never an open frame; a refusal is the end of it', () => {
  const calls = [];
  const sealed = {
    canSealed: () => true,
    sendWith: (...args) => { calls.push(['sendWith', ...args]); return 'id'; },
    sendFrame: (frame) => { calls.push(['sendFrame', frame]); return true; },
    send: (...args) => { calls.push(['send', ...args]); return true; },
  };
  const replyTo = { id: 'a', from: 'bob', author: 'Bob', text: 'q' };
  const forwardedFrom = { login: 'carol', name: 'Carol' };
  assert.equal(sendTextOverTransport(sealed, { id: 'r1', ts: 1, text: 'hi', replyTo }), true);
  assert.equal(sendTextOverTransport(sealed, { id: 'f1', ts: 1, text: 'hi', forwardedFrom }), true);
  assert.deepEqual(calls, [
    ['sendWith', 'hi', { replyTo, forwardedFrom: null }, 'r1'],
    ['sendWith', 'hi', { replyTo: null, forwardedFrom }, 'f1'],
  ]);
  const refusing = { ...sealed, sendWith: () => null };
  assert.equal(sendTextOverTransport(refusing, { id: 'r2', ts: 1, text: 'hi', replyTo }), false);
  assert.equal(calls.some((call) => call[0] === 'sendFrame'), false, 'a refusal never becomes the open frame');
  // Plain text is the text path as before, and a transport without the calls
  // (the classic link, an old module) keeps the frame it always sent.
  assert.equal(sendTextOverTransport(sealed, { id: 't1', ts: 5, text: 'plain' }), true);
  assert.deepEqual(calls.at(-1), ['send', 'plain', 5, 't1']);
  const classic = { sendFrame: (frame) => { calls.push(['sendFrame', frame]); return true; } };
  assert.equal(sendTextOverTransport(classic, { id: 'r3', ts: 1, text: 'hi', replyTo }), true);
  assert.deepEqual(calls.at(-1), ['sendFrame', { t: 'msg', id: 'r3', ts: 1, text: 'hi', replyTo }]);
});

test('createRzFacade carries the sealed calls to a core transport only, and a block stops them', () => {
  const calls = [];
  let blocked = false;
  let transport = {
    sendWith: (...args) => { calls.push(['sendWith', ...args]); return 'x'; },
    editText: (...args) => { calls.push(['editText', ...args]); return 'y'; },
  };
  const rz = createRzFacade(() => transport, { isBlocked: () => blocked });
  assert.equal(rz.canSealed(), true);
  assert.equal(rz.canEdit(), true);
  assert.equal(rz.sendWith('t', { image: null }, 'i1'), 'x');
  assert.equal(rz.editText('i1', 'new', 'e1'), 'y');
  assert.deepEqual(calls, [['sendWith', 't', { image: null }, 'i1'], ['editText', 'i1', 'new', 'e1']]);
  blocked = true;
  assert.equal(rz.sendWith('t', {}, 'i2'), null);
  assert.equal(rz.editText('i1', 'new', 'e2'), null);
  blocked = false;
  transport = { sendFrame: () => true };
  assert.equal(rz.canSealed(), false, 'a classic or p2p transport has no sealed calls');
  assert.equal(rz.canEdit(), false);
  assert.equal(rz.sendWith('t', {}, 'i3'), null);
  assert.equal(calls.length, 2);
  transport = null;
  assert.equal(rz.canSealed(), false);
});

test('/retry exists only where there is a queue to retry from, and never changes the catalog elsewhere', () => {
  assert.equal(chatCommands.some((command) => command.name === '/retry'), false);
  assert.deepEqual(RETRY_COMMAND, { name: '/retry', help: 'cmd.retry' });

  const bare = buildChatCommands({ ui: { addLine: () => {} } });
  assert.deepEqual(bare.map((command) => command.name), chatCommands.map((command) => command.name));

  const calls = [];
  const withRetry = buildChatCommands({ ui: { addLine: () => {} }, retryFailed: () => calls.push('retry') });
  const names = withRetry.map((command) => command.name);
  assert.equal(names.length, chatCommands.length + 1);
  assert.equal(names[names.indexOf('/forward') + 1], '/retry', 'listed right after /forward');
  assert.deepEqual(names.filter((name) => name !== '/retry'), chatCommands.map((command) => command.name));
  const retry = withRetry.find((command) => command.name === '/retry');
  assert.equal(typeof retry.help, 'string');
  assert.ok(retry.help.length > 0);
  retry.run();
  assert.deepEqual(calls, ['retry']);
  assert.equal(AI_SAFE_COMMANDS.includes('/retry'), false, 'the AI may not re-send what a person left failed');
  assert.equal(usageText().includes('/retry'), false, '--help is the classic terminal\'s');
});

test('/verify, /safety, /trust, /backup and /keys exist only where the core runs, and leave every other catalog untouched', () => {
  for (const name of ['/verify', '/safety', '/trust', '/backup', '/keys']) {
    assert.equal(chatCommands.some((command) => command.name === name), false);
    assert.equal(AI_SAFE_COMMANDS.includes(name), false, `the AI may not run ${name}`);
    assert.equal(usageText().includes(name), false, '--help is the classic terminal\'s');
  }
  assert.deepEqual(E2EE_COMMANDS.map((command) => command.name), ['/verify', '/safety', '/trust', '/backup', '/keys']);

  const bare = buildChatCommands({ ui: { addLine: () => {} } });
  assert.deepEqual(bare.map((command) => command.name), chatCommands.map((command) => command.name));

  const calls = [];
  const e2ee = {
    verify: (arg) => calls.push(['verify', arg]),
    safety: (arg) => calls.push(['safety', arg]),
    trust: () => calls.push(['trust']),
    backup: (arg) => calls.push(['backup', arg]),
    keys: (arg) => calls.push(['keys', arg]),
  };
  const withE2ee = buildChatCommands({ ui: { addLine: () => {} }, e2ee });
  const names = withE2ee.map((command) => command.name);
  assert.deepEqual(names.slice(names.indexOf('/forward') + 1, names.indexOf('/forward') + 6), ['/verify', '/safety', '/trust', '/backup', '/keys']);
  assert.deepEqual(names.filter((name) => !['/verify', '/safety', '/trust', '/backup', '/keys'].includes(name)), chatCommands.map((command) => command.name));

  // With the send queue too: /retry first, then the five, still right after /forward.
  const both = buildChatCommands({ ui: { addLine: () => {} }, e2ee, retryFailed: () => {} }).map((command) => command.name);
  assert.deepEqual(both.slice(both.indexOf('/forward') + 1, both.indexOf('/forward') + 7), ['/retry', '/verify', '/safety', '/trust', '/backup', '/keys']);

  withE2ee.find((command) => command.name === '/verify').run('yes');
  withE2ee.find((command) => command.name === '/safety').run('bob');
  withE2ee.find((command) => command.name === '/trust').run();
  withE2ee.find((command) => command.name === '/backup').run('create');
  withE2ee.find((command) => command.name === '/keys').run('reset');
  assert.deepEqual(calls, [['verify', 'yes'], ['safety', 'bob'], ['trust'], ['backup', 'create'], ['keys', 'reset']]);
});

test('/help lists /retry and the ⚠ rung of the legend only for the core', () => {
  const lines = [];
  const ui = {
    addLine: (line) => lines.push(line),
    addSection: (title, rows) => lines.push(`${title}: ${rows.map((row) => (Array.isArray(row) ? row.join(' ') : row)).join(' | ')}`),
    focusTracked: () => false,
  };
  const t = createTranslator('en');
  buildChatCommands({ ui, t }).find((command) => command.name === '/help').run('commands');
  assert.equal(lines.join('\n').includes('/retry'), false);
  lines.length = 0;
  buildChatCommands({ ui, t, retryFailed: () => {} }).find((command) => command.name === '/help').run('commands');
  assert.match(lines.join('\n'), /\/retry .*send the newest ⚠ message again/);
  assert.match(t('help.markers'), /⚠ failed/, 'the legend names every rung of the ladder');
});

test('parseArgs accepts --headless flag', () => {
  const defaults = { name: 'alice', port: 4747 };
  const parsed = parseArgs(['bob', '--headless'], defaults);
  assert.equal(parsed.headless, true);
  assert.equal(parsed.peer, 'bob');
});

test('headless mode starts as a background daemon and emits status events', async () => {
  const { spawn } = await import('node:child_process');
  const binPath = path.resolve('bin/tailchat.js');
  const nodeBin = /node(\.exe)?$/i.test(process.execPath) ? process.execPath : 'node';
  const randPort = 49000 + Math.floor(Math.random() * 1000);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-headless-smoke-'));

  try {
    const child = spawn(nodeBin, [
      binPath,
      '127.0.0.1',
      '--port', String(randPort),
      '--state-dir', tmpDir,
      '--no-log',
      '--no-notify',
      '--headless',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    const waitForOutput = new Promise((resolve, reject) => {
      const status = /LAN|Tailscale|status|dialling|connecting|waiting|port/i;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`headless startup timed out: ${output}`));
      }, 15_000);
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        child.off('exit', onExit);
        child.off('error', onError);
      };
      const onData = (d) => {
        output += d.toString('utf8');
        if (status.test(output)) {
          cleanup();
          resolve();
        }
      };
      const onExit = (code, signal) => {
        cleanup();
        reject(new Error(`headless exited before startup (${code}/${signal}): ${output}`));
      };
      const onError = (error) => { cleanup(); reject(error); };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', onExit);
      child.once('error', onError);
    });
    try {
      await waitForOutput;
    } finally {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await exited;
      }
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
    }
    assert.match(output, /LAN|Tailscale|status|dialling|connecting|waiting|port/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('headless mode triggers pre-expired reminders on startup without crash', async () => {
  const { spawn } = await import('node:child_process');
  const binPath = path.resolve('bin/tailchat.js');
  const nodeBin = /node(\.exe)?$/i.test(process.execPath) ? process.execPath : 'node';
  const randPort = 49000 + Math.floor(Math.random() * 1000);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-headless-rem-'));

  try {
    const preExpired = [{
      id: 'rem_past_1',
      text: 'Backup database now',
      targetUser: 'alice',
      dueTs: Date.now() - 10000,
      createdTs: Date.now() - 20000,
    }];
    openDeviceStore().write(path.join(tmpDir, 'reminders.json'), Buffer.from(JSON.stringify(preExpired)));

    const child = spawn(nodeBin, [
      binPath,
      '127.0.0.1',
      '--port', String(randPort),
      '--state-dir', tmpDir,
      '--no-log',
      '--no-notify',
      '--headless',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    const waitForReminder = new Promise((resolve) => {
      const onData = (d) => {
        output += d.toString('utf8');
        if (/Backup database now/.test(output)) resolve();
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      setTimeout(resolve, 1500);
    });
    await waitForReminder;
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
    assert.match(output, /Backup database now/);
  } finally {
    // The killed client's last writes can still be landing: Node 20's rmSync
    // met a file that appeared after its scan (ENOTEMPTY) on Linux CI.
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('/autoupdate toggles autoupdate setting between on and off', () => {
  const calls = [];
  const commands = buildChatCommands({
    switchAutoupdate: (arg) => calls.push(arg),
  });
  const autoupdateCmd = commands.find((c) => c.name === '/autoupdate');
  assert.ok(autoupdateCmd);
  autoupdateCmd.run('on');
  assert.deepEqual(calls, ['on']);
  autoupdateCmd.run('off');
  assert.deepEqual(calls, ['on', 'off']);
});

test('/sysmsg toggles sysmsg setting between on and off', () => {
  const calls = [];
  const commands = buildChatCommands({
    switchSysmsg: (arg) => calls.push(arg),
  });
  const sysmsgCmd = commands.find((c) => c.name === '/sysmsg');
  assert.ok(sysmsgCmd);
  sysmsgCmd.run('off');
  assert.deepEqual(calls, ['off']);
  sysmsgCmd.run('on');
  assert.deepEqual(calls, ['off', 'on']);
});

test('parseArgs accepts --no-sysmsg flag', () => {
  const defaults = { name: 'alice', port: 4747 };
  const parsed = parseArgs(['bob', '--no-sysmsg'], defaults);
  assert.equal(parsed.noSysmsg, true);
  assert.equal(parsed.peer, 'bob');
});

test('parseArgs accepts --sysmsg flag', () => {
  const defaults = { name: 'alice', port: 4747 };
  const parsed = parseArgs(['bob', '--sysmsg'], defaults);
  assert.equal(parsed.sysmsg, true);
  assert.equal(parsed.peer, 'bob');
});

test('createRzFacade provides complete interface and safely handles null activeTransport', () => {
  let transport = null;
  const stops = [];
  const switches = [];
  const rz = createRzFacade(() => transport, {
    stopP2p: () => stops.push('p2p'),
    stopCloud: () => stops.push('cloud'),
    switchCloudPeer: (p, l) => switches.push({ p, l }),
  });

  const expectedMethods = [
    'send', 'sendFrame', 'sendReceipt', 'sendPing', 'writable', 'writeFrame', 'flushed',
    'isOnline', 'peerOnline', 'isDialling', 'boundPort', 'target', 'targets', 'setTarget', 'setTargets',
    'refreshAllowed', 'retryDelay', 'activeSocket', 'reconnect', 'standDown', 'stop', 'switchPeer',
  ];

  for (const m of expectedMethods) {
    assert.equal(typeof rz[m], 'function', `rz.${m} must be a function`);
  }

  // Null transport safety checks
  assert.equal(rz.send('hello'), false);
  assert.equal(rz.sendFrame({ t: 'ping' }), false);
  assert.equal(rz.sendReceipt('ack', '123'), undefined);
  assert.equal(rz.sendPing('p1', Date.now()), null);
  assert.equal(rz.writable(), false);
  assert.equal(rz.writeFrame({ t: 'file-chunk' }), false);
  assert.equal(rz.isOnline(), false);
  assert.equal(rz.peerOnline(), false);
  assert.equal(rz.isDialling(), false);
  assert.equal(rz.boundPort(), null);
  assert.deepEqual(rz.target(), { host: '', port: 0 });
  assert.deepEqual(rz.targets(), []);
  assert.equal(rz.setTarget('100.64.0.1', 4747), undefined);
  assert.equal(rz.setTargets([{ host: '100.64.0.1', port: 4747 }]), undefined);
  assert.equal(rz.refreshAllowed(), undefined);
  assert.equal(rz.retryDelay(), 0);
  assert.equal(rz.activeSocket(), null);
  assert.equal(rz.reconnect(), false);
  assert.equal(rz.standDown(), undefined);

  rz.stop();
  assert.deepEqual(stops, ['p2p', 'cloud']);

  rz.switchPeer('roman', 'Роман');
  assert.deepEqual(switches, [{ p: 'roman', l: 'Роман' }]);
});

test('createRzFacade forwards calls to activeTransport', () => {
  const calls = [];
  const fakeTransport = {
    send: (...a) => { calls.push(['send', ...a]); return true; },
    sendFrame: (...a) => { calls.push(['sendFrame', ...a]); return true; },
    sendReceipt: (...a) => { calls.push(['sendReceipt', ...a]); return true; },
    sendPing: (...a) => { calls.push(['sendPing', ...a]); return 'ping-res'; },
    isOnline: () => true,
    peerOnline: () => true,
    isDialling: () => false,
    target: () => ({ host: '100.64.0.2', port: 4747 }),
    targets: () => [{ host: '100.64.0.2', port: 4747 }],
    setTarget: (...a) => { calls.push(['setTarget', ...a]); return { host: a[0], port: a[1] }; },
    setTargets: (...a) => { calls.push(['setTargets', ...a]); return a[0]; },
    boundPort: () => 4747,
    reconnect: () => true,
    standDown: () => calls.push(['standDown']),
    refreshAllowed: () => calls.push(['refreshAllowed']),
    retryDelay: () => 1500,
    activeSocket: () => ({ remoteAddress: '100.64.0.2' }),
    writable: () => true,
    writeFrame: (...a) => { calls.push(['writeFrame', ...a]); return true; },
    flushed: () => Promise.resolve(),
  };

  const rz = createRzFacade(() => fakeTransport);

  assert.equal(rz.send('hi', 1000, 'id1'), true);
  assert.equal(rz.sendFrame({ t: 'wake' }), true);
  assert.equal(rz.sendReceipt('ack', 'id1'), true);
  assert.equal(rz.sendPing('p1', 2000), 'ping-res');
  assert.equal(rz.isOnline(), true);
  assert.equal(rz.peerOnline(), true);
  assert.equal(rz.isDialling(), false);
  assert.deepEqual(rz.target(), { host: '100.64.0.2', port: 4747 });
  assert.deepEqual(rz.targets(), [{ host: '100.64.0.2', port: 4747 }]);
  assert.deepEqual(rz.setTarget('100.64.0.3', 5000), { host: '100.64.0.3', port: 5000 });
  assert.deepEqual(rz.setTargets([{ host: '100.64.0.4', port: 5000 }]), [{ host: '100.64.0.4', port: 5000 }]);
  assert.equal(rz.boundPort(), 4747);
  assert.equal(rz.reconnect(), true);
  rz.standDown();
  rz.refreshAllowed();
  assert.equal(rz.retryDelay(), 1500);
  assert.deepEqual(rz.activeSocket(), { remoteAddress: '100.64.0.2' });
  assert.equal(rz.writable(), true);
  assert.equal(rz.writeFrame({ t: 'file-done' }), true);

  assert.deepEqual(calls, [
    ['send', 'hi', 1000, 'id1'],
    ['sendFrame', { t: 'wake' }],
    ['sendReceipt', 'ack', 'id1'],
    ['sendPing', 'p1', 2000],
    ['setTarget', '100.64.0.3', 5000],
    ['setTargets', [{ host: '100.64.0.4', port: 5000 }]],
    ['standDown'],
    ['refreshAllowed'],
    ['writeFrame', { t: 'file-done' }],
  ]);
});

test('/p2p and /cloud commands dispatch to their respective handlers', () => {
  const p2pCalls = [];
  const cloudCalls = [];
  const commands = buildChatCommands({
    switchPeerP2p: (arg) => p2pCalls.push(arg),
    switchPeerCloud: (arg) => cloudCalls.push(arg),
  });

  const p2pCmd = commands.find((c) => c.name === '/p2p');
  const cloudCmd = commands.find((c) => c.name === '/cloud');

  assert.ok(p2pCmd);
  assert.ok(cloudCmd);

  p2pCmd.run('alice');
  assert.deepEqual(p2pCalls, ['alice']);

  cloudCmd.run('bob');
  assert.deepEqual(cloudCalls, ['bob']);
});

test('/badge command dispatches to switchNameBadge handler', () => {
  const badgeCalls = [];
  const commands = buildChatCommands({
    switchNameBadge: (arg) => badgeCalls.push(arg),
  });

  const badgeCmd = commands.find((c) => c.name === '/badge');
  assert.ok(badgeCmd);

  badgeCmd.run('off');
  assert.deepEqual(badgeCalls, ['off']);
});

test('/roster command displays usage and updates row setting', () => {
  const lines = [];
  let currentRows = 3;
  const ui = {
    addLine: (msg) => lines.push(msg),
    setRosterRows: (n) => { currentRows = n; },
    rosterRows: () => currentRows,
  };
  const commands = buildChatCommands({
    ui,
    switchRosterRows: (arg) => {
      const raw = String(arg ?? '').trim();
      if (raw === '') return ui.addLine(`roster is showing ${ui.rosterRows()}`);
      const num = parseInt(raw, 10);
      if (![1, 2, 3].includes(num)) return ui.addLine('usage: /roster 1 | 2 | 3');
      ui.setRosterRows(num);
      return ui.addLine(`roster set to ${num}`);
    },
  });
  const rosterCmd = commands.find((c) => c.name === '/roster');
  assert.ok(rosterCmd, '/roster command exists');

  rosterCmd.run('');
  assert.match(lines[lines.length - 1], /roster is showing 3/);

  rosterCmd.run('2');
  assert.equal(currentRows, 2);
  assert.match(lines[lines.length - 1], /roster set to 2/);

  rosterCmd.run('bad');
  assert.match(lines[lines.length - 1], /usage: \/roster/);
});

// Regression: a cloud-history record for the bot must render under its own
// author name and never as "self", even when the account reading history back
// is the very one that ran the bot — `from` on a bot record is the account
// that ran it, not a claim about who is speaking.
test('cloud-history AI records render under their author, never as self', () => {
  const { bot, isSelf, senderName } = resolveCloudHistorySender({
    kind: 'ai', from: 'roman@example.com', author: 'tailik', text: 'hi',
  }, {
    selfLogin: 'roman@example.com', selfName: 'Roman', peerName: 'Ella', peer: 'ella@example.com',
  });
  assert.equal(bot, true);
  assert.equal(isSelf, false, 'a bot line is never self, whoever ran it');
  assert.equal(senderName, 'tailik', 'the author field wins, not the reader\'s own name');

  // An older record with no `author` falls back to the default AI name
  // instead of losing its identity.
  const legacy = resolveCloudHistorySender({ kind: 'ai', from: 'roman@example.com', text: 'hi' }, {
    selfLogin: 'roman@example.com', selfName: 'Roman', peerName: 'Ella', peer: 'ella@example.com',
  });
  assert.equal(legacy.senderName, DEFAULT_AI_NAME);
  assert.equal(legacy.isSelf, false);

  // A genuinely human, self-sent record is the one case self is true.
  const human = resolveCloudHistorySender({ kind: 'human', from: 'roman@example.com', text: 'hi' }, {
    selfLogin: 'roman@example.com', selfName: 'Roman', peerName: 'Ella', peer: 'ella@example.com',
  });
  assert.equal(human.bot, false);
  assert.equal(human.isSelf, true);
  assert.equal(human.senderName, 'Roman');
});

// A tiny valid 3x2 PNG, reused from test/preview.test.js's own fixture.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAFElEQVR4nGP4z8DwHwwZ/v9HRv8Bqm8O8smQ8ZMAAAAASUVORK5CYII=',
  'base64',
);

test('an inline image attachment renders a real preview instead of being dropped', async () => {
  const dataUrl = `data:image/png;base64,${TINY_PNG.toString('base64')}`;
  const payload = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const lines = await renderAttachmentLines(payload, 'image.png', { themed: false });
  assert.ok(lines.length > 0, 'a decodable image must produce at least one preview line');
  assert.ok(lines.some((line) => line.trim().length > 0), 'the preview is not blank');
});

test('a voice attachment that is not WAV still gets a card, with the sender\'s reported duration', async () => {
  const notWav = Buffer.from('not actually wav bytes, but audio-shaped by extension');
  const lines = await renderAttachmentLines(notWav, 'voice.webm', { themed: false, durationHint: 7 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /🎙/, 'still a voice card, not a generic file icon');
});

// /sound's whole contract: every bell and every desktop notification in the
// running client goes through ringIfEnabled/notifyIfEnabled, gated on the one
// boolean /sound flips. Proven directly on the gate, since that gate — not a
// re-implementation of it — is what /sound actually toggles.
test('/sound off suppresses the bell and the notifier; /sound on restores both', () => {
  const bells = [];
  const notifies = [];
  const bell = () => bells.push(true);
  const notify = (n) => { notifies.push(n); };
  const notification = { name: 'Tailchat', text: 'ping' };

  assert.equal(ringIfEnabled(false, bell, notify, notification), false, '/sound off: ring is a no-op');
  assert.deepEqual(bells, []);
  assert.deepEqual(notifies, []);
  assert.equal(notifyIfEnabled(false, notify, notification), false, '/sound off: the notifier is muted too');
  assert.deepEqual(notifies, []);

  assert.equal(ringIfEnabled(true, bell, notify, notification), true, '/sound on: ring restores the bell');
  assert.deepEqual(bells, [true]);
  assert.deepEqual(notifies, [notification]);
  notifyIfEnabled(true, notify, notification);
  assert.deepEqual(notifies, [notification, notification]);
});

// Saved Messages: a pinned row whose value is always `@<your own login>` —
// the same leading-`@` convention /peer and /cloud already use for an
// explicit cloud selector — and resolveCloudPeerSync (shared by startup and
// /peer's live switch) must read that value as cloud, with peer/peerName set
// to the account itself, even though it is never a friend on cloud.users.
test('selecting Saved Messages resolves to isCloudPeer with cloud.peer set to your own login', () => {
  const t = (key) => ({
    'cloud.savedMessages': 'Saved Messages',
    'cloud.savedMessagesHint': 'always available',
  })[key];
  const row = savedMessagesRow(t, 'roman@example.com');
  assert.equal(row.value, '@roman@example.com');
  assert.match(row.name, /Saved Messages/);

  // The picker returns `row.value`; the startup/@peer convention strips the
  // leading `@` and forces explicit cloud, exactly as main() does right after
  // choosePeer resolves.
  const selector = row.value;
  assert.ok(selector.startsWith('@'));
  const bareLogin = selector.slice(1);

  const resolved = resolveCloudPeerSync(bareLogin, {
    explicitCloud: true, // Saved Messages is never in cloudUsers, so this is what carries it
    cloudUsers: [{ login: 'ella@example.com', name: 'Ella' }],
  });
  assert.equal(resolved.isCloudPeer, true);
  assert.equal(resolved.cloudFriend, null, 'Saved Messages is never looked up as a friend');
  assert.equal(resolved.peer, 'roman@example.com');
  assert.equal(resolved.peerName, 'roman@example.com');

  // An ordinary cloud friend, reached without any `@`, still resolves purely
  // from the friends list — the explicit-cloud path is Saved Messages' own,
  // not the only way in.
  const friend = resolveCloudPeerSync('ella@example.com', {
    explicitCloud: false,
    cloudUsers: [{ login: 'ella@example.com', name: 'Ella' }],
  });
  assert.equal(friend.isCloudPeer, true);
  assert.equal(friend.peerName, 'Ella');

  // Nothing that looks cloud: unresolved, and the caller's own tailscale
  // fallback decides from there.
  const neither = resolveCloudPeerSync('100.64.0.5', { explicitCloud: false, cloudUsers: [] });
  assert.equal(neither.isCloudPeer, false);
});

test('bare /cloud selects only a verified cloud friend', () => {
  const cloudUsers = [
    { login: 'roman-cloud', name: 'Roman' },
    { login: 'ella-cloud', name: 'Ella' },
  ];

  assert.equal(cloudTargetForCurrentPeer({
    isCloudPeer: false,
    peer: 'roman-cloud',
    cloudUsers,
  }), 'roman-cloud');
  assert.equal(cloudTargetForCurrentPeer({
    isCloudPeer: false,
    peer: 'Roman',
    cloudUsers,
  }), 'roman-cloud');
  assert.equal(cloudTargetForCurrentPeer({
    isCloudPeer: false,
    peer: 'roman@example.com',
    cloudUsers,
  }), null, 'a Tailscale identity is not a cloud login');
  assert.equal(cloudTargetForCurrentPeer({
    isCloudPeer: false,
    peer: '100.78.12.77',
    cloudUsers,
  }), null);
  assert.equal(cloudTargetForCurrentPeer({
    isCloudPeer: true,
    peer: 'roman-cloud',
    cloudUsers,
  }), null);
});

test('bare /cloud leaves an ambiguous cloud display name for the picker', () => {
  assert.equal(cloudTargetForCurrentPeer({
    isCloudPeer: false,
    peer: 'Roman',
    cloudUsers: [
      { login: 'roman-one', name: 'Roman' },
      { login: 'roman-two', name: 'Roman' },
    ],
  }), null);
});

// The bug computePeerKey exists to fix: /p2p and /cloud used to key the
// transcript, memory and outbox by `isCloudPeer ? cloud-<login> : <peer>`
// inline in two different places in cli.js, so a linked identity had nowhere
// to hook in without duplicating the formula a third time.
test('computePeerKey: a live Cloud session always keys by the Cloud login', () => {
  assert.equal(computePeerKey({
    isCloudPeer: true, cloudLogin: 'roman-cloud', peerLogin: 'roman@example.com', selector: 'roman',
  }), 'cloud-roman-cloud');
});

test('computePeerKey: an explicit /link makes a Tailscale/LAN peer key by the linked Cloud login', () => {
  assert.equal(computePeerKey({
    isCloudPeer: false, peerLogin: 'roman@example.com', selector: 'roman', linkedCloudLogin: 'roman-cloud',
  }), 'cloud-roman-cloud', 'a linked peer must land in the same history as the Cloud conversation');
});

test('computePeerKey: an unlinked Tailscale peer keeps the pre-unification key', () => {
  assert.equal(computePeerKey({
    isCloudPeer: false, peerLogin: 'roman@example.com', selector: 'roman',
  }), 'roman@example.com');
  assert.equal(computePeerKey({
    isCloudPeer: false, peerLogin: null, selector: '100.64.0.5',
  }), '100.64.0.5', 'no resolvable login falls back to the raw selector, exactly as before');
});

// Regression: the previous merge overwrote `badge` on every match, so a
// person seen on both LAN and Cloud only ever showed whichever source was
// merged last — losing the other transport instead of combining with it.
test('choosePeer: a peer seen on LAN and Cloud shows one row with both badges', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-pick-'));
  try {
    const lanDiscovery = { getPeers: () => [
      { name: 'romans-macbook', login: 'roman-cloud', address: '192.168.1.42' },
    ] };
    const cloud = { api: { users: async () => [
      { login: 'roman-cloud', name: 'Roman', online: true },
    ] } };
    const input = new PassThrough();
    input.write('1\n');
    const output = new PassThrough();
    const written = [];
    output.on('data', (chunk) => written.push(String(chunk)));
    await choosePeer({
      stateDir: dir, cliPath: null, t: (k) => k, input, output,
      force: true, lanDiscovery, cloud,
    });
    input.end();
    const text = written.join('');
    assert.match(text, /roman-cloud/);
    assert.match(text, /📡 \[lan\]/);
    assert.match(text, /🌐 \[cloud\]/);
    assert.equal((text.match(/roman-cloud/g) || []).length, 1, 'must be one row, not two');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/link command dispatches to the switchLink handler with its argument', () => {
  const calls = [];
  const commands = buildChatCommands({
    switchLink: (arg) => calls.push(arg),
  });
  const linkCmd = commands.find((c) => c.name === '/link');
  assert.ok(linkCmd);
  linkCmd.run('@roman-cloud');
  assert.deepEqual(calls, ['@roman-cloud']);
});

test('cli: message frame handling must not reference undeclared from identifier', () => {
  const code = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /rz\.on\('message',\s*\(\{\s*name,\s*text,\s*ts,\s*id,\s*image,\s*voice,\s*replyTo,\s*reactions,\s*forwardedFrom,\s*\}\)/,
    'rz.on message parameters must destructure from to prevent ReferenceError');
});

test('cli: cloud message cache writes and loads JSON messages for offline viewing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-cache-'));
  try {
    const cacheDir = path.join(dir, 'cloud-cache');
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const messages = [
      { id: 'm1', name: 'Alice', text: 'hello offline', ts: 1000 },
      { id: 'm2', name: 'Bob', text: 'hi back', ts: 2000 },
    ];
    fs.writeFileSync(path.join(cacheDir, 'alice.json'), JSON.stringify(messages), 'utf8');
    const read = JSON.parse(fs.readFileSync(path.join(cacheDir, 'alice.json'), 'utf8'));
    assert.deepEqual(read, messages);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: msgPeer is initialized before appendCloudCacheMessage in rz.on message', () => {
  const code = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  const declIdx = code.indexOf('const msgPeer = from ||');
  const useIdx = code.indexOf('appendCloudCacheMessage(msgPeer,');
  assert.ok(declIdx !== -1, 'msgPeer declaration exists');
  assert.ok(useIdx !== -1, 'appendCloudCacheMessage usage exists');
  assert.ok(declIdx < useIdx, 'msgPeer must be declared before being passed to appendCloudCacheMessage');
});

test('cli: cloud message cache session decrypts once and caches in memory across switches (issue #20)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-cache-session-'));
  const store = createSecureStore(crypto.randomBytes(32));
  let readCount = 0;
  const originalRead = store.read;
  store.read = (file) => {
    readCount += 1;
    return originalRead(file);
  };

  try {
    const cacheDir = path.join(dir, 'cloud-cache');
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const aliceMessages = [
      { id: 'm1', name: 'Alice', text: 'first msg', ts: 1000 },
      { id: 'm2', name: 'Me', text: 'hi Alice', ts: 2000, self: true },
    ];
    const aliceFile = path.join(cacheDir, 'alice.json');
    store.write(aliceFile, Buffer.from(JSON.stringify(aliceMessages)));

    const cache = createCloudCacheStore({ stateDir: dir, store });

    // First load: reads and decrypts from disk
    readCount = 0;
    const loaded1 = cache.load('alice');
    assert.deepEqual(loaded1, aliceMessages);
    assert.equal(readCount, 1);

    // Second load (e.g. switching back to Alice): 0 disk reads, returns cached in-memory array!
    readCount = 0;
    const loaded2 = cache.load('@Alice');
    assert.equal(loaded2, loaded1);
    assert.equal(readCount, 0);

    // Appending a message updates in-memory cache and schedules write
    cache.append('alice', { id: 'm3', name: 'Alice', text: 'third msg', ts: 3000 });
    const loaded3 = cache.load('alice');
    assert.equal(loaded3.length, 3);
    assert.equal(loaded3[2].text, 'third msg');
    assert.equal(readCount, 0);
    // Flushed write reaches disk with ciphertext verified
    await cache.flush('alice');
    const onDisk = JSON.parse(store.read(aliceFile).toString('utf8'));
    assert.equal(onDisk.length, 3);
    assert.equal(onDisk[2].text, 'third msg');

    // Drop removes from in-memory cache and disk
    await cache.drop('alice');
    assert.equal(cache.sessionCache.has('alice'), false);
    assert.equal(fs.existsSync(store.fileFor(aliceFile)), false);
    assert.deepEqual(cache.load('alice'), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


// The nickname precedence is one rule, shared by every rendering path: the
// account's own server-side alias first (the only part that follows the account
// between machines), then the legacy on-machine nickname, then the roster or
// the peer's own hello. A local nickname must never shadow the server's.
test('display precedence: server alias, then local nickname, then roster name', () => {
  assert.equal(resolveDisplayName({ alias: 'Сервер', nickname: 'Локальное', fallback: 'Roster' }), 'Сервер');
  assert.equal(resolveDisplayName({ alias: null, nickname: 'Локальное', fallback: 'Roster' }), 'Локальное');
  assert.equal(resolveDisplayName({ alias: '', nickname: '', fallback: 'Roster' }), 'Roster');
  assert.equal(resolveDisplayName({ fallback: 'Roster' }), 'Roster');
  assert.equal(resolveDisplayName({}), null);
});

test('the roster alias is read case-insensitively and can be applied locally', () => {
  const cloud = { peer: 'roman@example.com', users: [{ login: 'Roman@Example.com', name: 'Roman', alias: 'Ромыч' }] };
  assert.equal(cloudAliasOf(cloud), 'Ромыч');
  assert.equal(cloudAliasOf(cloud, '@roman@example.com'), 'Ромыч');
  assert.equal(cloudAliasOf({ users: [] }), null);

  setCloudAlias(cloud, 'roman@example.com', 'Новое');
  assert.equal(cloudAliasOf(cloud), 'Новое');
  setCloudAlias(cloud, 'roman@example.com', '');
  assert.equal(cloudAliasOf(cloud), null, 'an empty alias reads as no alias');
});

// A Cloud conversation's nickname lives on the account, so /nick has to reach
// the server; the local nickname store is for peers without a server and must
// stay untouched here.
test('/nick on a cloud conversation posts the typed name and repaints from the answer', async () => {
  const calls = [];
  const cloud = {
    peer: 'roman@example.com',
    users: [{ login: 'roman@example.com', name: 'Roman' }],
    api: {
      setAlias: async (peer, name) => {
        calls.push([peer, name]);
        return '🔥 Ромыч 🔥';
      },
    },
  };
  const memory = {
    nickname: () => 'старое локальное',
    setNickname: () => { throw new Error('a cloud /nick must not write peer-memory'); },
  };

  const result = await applyNickname({ arg: '  🔥 Ромыч 🔥  ', isCloudPeer: true, cloud, memory });

  // What the user typed goes as typed (bar surrounding whitespace); the server
  // does the cleaning, and its answer is what the screen shows.
  assert.deepEqual(calls, [['roman@example.com', '🔥 Ромыч 🔥']]);
  assert.deepEqual(result, { action: 'set', name: '🔥 Ромыч 🔥' });
  assert.equal(cloudAliasOf(cloud), '🔥 Ромыч 🔥');
  assert.equal(
    resolveDisplayName({ alias: cloudAliasOf(cloud), nickname: memory.nickname(), fallback: 'Roman' }),
    '🔥 Ромыч 🔥',
  );
});

test('/nick on a direct peer stays on this machine', async () => {
  const writes = [];
  const memory = { nickname: () => null, setNickname: (value) => writes.push(value) };

  const result = await applyNickname({ arg: 'Ромыч', isCloudPeer: false, cloud: null, memory });

  assert.deepEqual(writes, ['Ромыч']);
  assert.deepEqual(result, { action: 'set', name: 'Ромыч' });
});

test('an empty name on a cloud conversation clears the server nickname too', async () => {
  const calls = [];
  const cleared = [];
  const cloud = {
    peer: 'roman@example.com',
    users: [{ login: 'roman@example.com', name: 'Roman', alias: 'Ромыч' }],
    api: {
      setAlias: async (peer, name) => {
        calls.push([peer, name]);
        return '';
      },
    },
  };
  const memory = { nickname: () => 'локальное', setNickname: (value) => cleared.push(value) };

  const result = await applyNickname({ arg: 'clear', isCloudPeer: true, cloud, memory });

  assert.deepEqual(calls, [['roman@example.com', '']]);
  assert.deepEqual(cleared, [null]);
  assert.deepEqual(result, { action: 'clear' });
  assert.equal(cloudAliasOf(cloud), null);
});

// A refusal from the server is surfaced, not swallowed into a phantom success,
// and the nickname already in place is left exactly as it was.
test('a refused cloud nickname surfaces its code and changes nothing', async () => {
  const cloud = {
    peer: 'roman@example.com',
    users: [{ login: 'roman@example.com', name: 'Roman', alias: 'Ромыч' }],
    api: { setAlias: async () => { throw new CloudApiError('invalid_alias', { status: 400 }); } },
  };
  let touched = false;
  const memory = { nickname: () => null, setNickname: () => { touched = true; } };

  await assert.rejects(
    () => applyNickname({ arg: 'Ромыч', isCloudPeer: true, cloud, memory }),
    (error) => error.code === 'invalid_alias',
  );
  assert.equal(touched, false);
  assert.equal(cloudAliasOf(cloud), 'Ромыч', 'the standing alias survives a refused change');
});

const fakeMemoryFor = (locals, cleared) => (login) => ({
  nickname: () => locals[login] ?? null,
  setNickname: (value) => {
    cleared.push([login, value]);
    delete locals[login];
  },
});

// The one-time bridge: local nicknames predate the server holding them, and the
// server value now outranks them, so they have to be moved before they vanish.
test('the migration pushes a local nickname once and clears it only after the server accepts', async () => {
  const calls = [];
  const cleared = [];
  const persisted = [];
  const cloud = {
    users: [{ login: 'a@example.com', name: 'A' }],
    api: { setAlias: async (peer, name) => { calls.push([peer, name]); return name; } },
  };
  const locals = { 'a@example.com': 'Локальное' };

  const result = await migrateCloudNicknames({
    cloud,
    config: {},
    stateDir: '/tmp/nowhere',
    persist: (patch) => persisted.push(patch),
    memoryFor: fakeMemoryFor(locals, cleared),
  });

  assert.deepEqual(calls, [['a@example.com', 'Локальное']], 'the nickname travels byte-identical');
  assert.deepEqual(cleared, [['a@example.com', null]]);
  assert.deepEqual(result, { moved: 1, pending: 0, done: true });
  assert.deepEqual(persisted, [{ nicknameMigrationDone: true }]);
});

test('an alias already on the roster wins: the local copy is dropped without a request', async () => {
  const calls = [];
  const cleared = [];
  const persisted = [];
  const cloud = {
    users: [{ login: 'a@example.com', name: 'A', alias: 'Уже на сервере' }],
    api: { setAlias: async (peer, name) => { calls.push([peer, name]); return name; } },
  };
  const locals = { 'a@example.com': 'Старое локальное' };

  const result = await migrateCloudNicknames({
    cloud,
    config: {},
    stateDir: '/tmp/nowhere',
    persist: (patch) => persisted.push(patch),
    memoryFor: fakeMemoryFor(locals, cleared),
  });

  assert.deepEqual(calls, [], 'a local nickname never overwrites a server alias');
  assert.deepEqual(cleared, [['a@example.com', null]]);
  assert.equal(result.done, true);
  assert.deepEqual(persisted, [{ nicknameMigrationDone: true }]);
});

test('a failed push keeps the local nickname and leaves the flag unset for a retry', async () => {
  const cleared = [];
  const persisted = [];
  const cloud = {
    users: [{ login: 'a@example.com', name: 'A' }],
    api: { setAlias: async () => { throw new CloudApiError('unreachable'); } },
  };
  const locals = { 'a@example.com': 'Локальное' };

  const result = await migrateCloudNicknames({
    cloud,
    config: {},
    stateDir: '/tmp/nowhere',
    persist: (patch) => persisted.push(patch),
    memoryFor: fakeMemoryFor(locals, cleared),
  });

  assert.deepEqual(cleared, [], 'nothing is cleared until the server took it');
  assert.equal(locals['a@example.com'], 'Локальное');
  assert.deepEqual(result, { moved: 0, pending: 1, done: false });
  assert.deepEqual(persisted, [], 'no durable flag while an entry is still pending');
});

test('a local nickname the file refuses to drop stays pending, so the migration retries', async () => {
  const calls = [];
  const persisted = [];
  const cloud = {
    users: [{ login: 'a@example.com', name: 'A' }],
    api: { setAlias: async (peer, name) => { calls.push([peer, name]); return name; } },
  };
  const locals = { 'a@example.com': 'Локальное' };

  const result = await migrateCloudNicknames({
    cloud,
    config: {},
    stateDir: '/tmp/nowhere',
    persist: (patch) => persisted.push(patch),
    // Windows: antivirus or Search holds the file for the moment it takes to
    // replace it, so the POST lands and the local clear does not.
    memoryFor: () => ({
      nickname: () => locals['a@example.com'],
      setNickname: () => ({ ok: false, code: 'EPERM' }),
    }),
  });

  assert.deepEqual(calls, [['a@example.com', 'Локальное']], 'the nickname still reaches the server');
  assert.deepEqual(result, { moved: 0, pending: 1, done: false });
  assert.deepEqual(persisted, [], 'the flag waits until the local copy is really gone');
});

test('a stale local nickname the file refuses to drop keeps the pass unresolved too', async () => {
  const calls = [];
  const persisted = [];
  const cloud = {
    users: [{ login: 'a@example.com', name: 'A', alias: 'Уже на сервере' }],
    api: { setAlias: async (peer, name) => { calls.push([peer, name]); return name; } },
  };

  const result = await migrateCloudNicknames({
    cloud,
    config: {},
    stateDir: '/tmp/nowhere',
    persist: (patch) => persisted.push(patch),
    memoryFor: () => ({
      nickname: () => 'Старое локальное',
      setNickname: () => ({ ok: false, code: 'EPERM' }),
    }),
  });

  assert.deepEqual(calls, [], 'the server value is never overwritten');
  assert.deepEqual(result, { moved: 0, pending: 1, done: false });
  assert.deepEqual(persisted, []);
});

test('the migration does not run again once its durable flag is set', async () => {
  let called = false;
  const cloud = {
    users: [{ login: 'a@example.com' }],
    api: { setAlias: async () => { called = true; return ''; } },
  };
  const result = await migrateCloudNicknames({
    cloud,
    config: { nicknameMigrationDone: true },
    stateDir: '/tmp/nowhere',
    memoryFor: () => { throw new Error('must not be consulted'); },
  });

  assert.deepEqual(result, { moved: 0, pending: 0, done: true });
  assert.equal(called, false);
});

// An edit on the core shows at once and can still be refused. Taking it back
// puts the old words and the old "edited" state in the transcript and says so;
// an edit made again since is left alone.
function editLedger({ text = 'first', edited = false } = {}) {
  const rows = new Map([['m-1', { text, edited }]]);
  const lines = [];
  const ui = {
    messageById: (id) => (rows.has(id) ? { id, ...rows.get(id) } : null),
    updateMessage: (id, words, { edited: mark = true, reset = false } = {}) => {
      const row = rows.get(id);
      rows.set(id, { text: words, edited: reset ? mark : Boolean(mark || row.edited) });
      return true;
    },
  };
  return { rows, lines, ledger: createCoreEdits(ui, () => lines.push('said')), ui };
}

test('core edits: a refusal puts the old words back and the transcript says so', () => {
  const { rows, lines, ledger, ui } = editLedger();
  ledger.remember('m-c1', 'm-1', 'second');
  ui.updateMessage('m-1', 'second');
  assert.deepEqual(rows.get('m-1'), { text: 'second', edited: true });
  assert.equal(ledger.fail('m-c1'), true);
  assert.deepEqual(rows.get('m-1'), { text: 'first', edited: false }, 'the mark the edit drew is gone too');
  assert.deepEqual(lines, ['said']);
  assert.equal(ledger.fail('m-c1'), false, 'settled once');
  assert.equal(ledger.fail('m-other'), false, 'an ordinary refused send is not an edit');
});

test('core edits: a row edited before stays edited; a confirmed edit is never undone', () => {
  const was = editLedger({ edited: true });
  was.ledger.remember('m-c1', 'm-1', 'second');
  was.ui.updateMessage('m-1', 'second');
  was.ledger.fail('m-c1');
  assert.deepEqual(was.rows.get('m-1'), { text: 'first', edited: true });

  const ok = editLedger();
  ok.ledger.remember('m-c2', 'm-1', 'second');
  ok.ui.updateMessage('m-1', 'second');
  assert.equal(ok.ledger.done('m-c2'), true);
  assert.equal(ok.ledger.fail('m-c2'), false);
  assert.deepEqual(ok.rows.get('m-1'), { text: 'second', edited: true });

  const again = editLedger();
  again.ledger.remember('m-c3', 'm-1', 'second');
  again.ui.updateMessage('m-1', 'third');
  again.ledger.fail('m-c3');
  assert.equal(again.rows.get('m-1').text, 'third', 'other words than the refused edit\'s are not touched');
  assert.deepEqual(again.lines, ['said'], 'but the person still hears that edit did not leave');
});
