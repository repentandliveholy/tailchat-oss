// The third participant. A person invites it with /ai, or simply says its name
// mid-conversation the way they would address anyone else, and it answers into
// the same transcript both sides are reading.
//
// One request shape covers every provider worth using here: Google's free key,
// OpenRouter's free models and anything self-hosted all speak the OpenAI
// chat/completions dialect, so there is a single code path instead of one per
// vendor. Nothing in this file touches the network unless asked, nothing throws,
// and nothing knows about the TUI — the caller decides what to show.

// Where the key comes from is part of the preset: a person who has a Google key
// in their environment should get a working /ai without editing any file.
export const GOOGLE_MODELS = [
  'gemini-3.7-flash-tiered',
  'gemini-3.5-flash-lite',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-pro',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-cyber',
];

export const AI_PROVIDERS = {
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    keyEnv: 'GEMINI_API_KEY',
    model: 'gemini-3.5-flash-lite',
    models: GOOGLE_MODELS,
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    keyEnv: 'OPENROUTER_API_KEY',
    model: 'nvidia/nemotron-3-nano-30b-a3b:free',
    models: ['nvidia/nemotron-3-nano-30b-a3b:free'],
  },
  deepseek: {
    url: 'https://api.deepseek.com/chat/completions',
    keyEnv: 'DEEPSEEK_API_KEY',
    model: 'deepseek-v4-flash',
    models: ['deepseek-v4-flash'],
  },
};

export const DEFAULT_AI_NAME = 'tailik';
export const AI_TURNS = 24; // how much of the conversation the model is shown
export const AI_TOOL_ROUNDS = 3; // tailchat commands per question, so a reply cannot run a queue of them
// Local, read-only diagnostics the AI may run directly — exact prefixes only.
// Never a write, a delete, a send, a network call or another machine: the
// destructive-class blocklist this used to lean on could never enumerate
// every risk (it missed plain information disclosure entirely — reading
// secrets.env is not "destructive"), so this is a closed allowlist instead.
// The tailnet half is subcommand-level on purpose. A bare `tailscale` prefix
// would grant `logout`, `down`, `set`, `file cp` and `cert` along with the
// rest — the prefix rule ends at the space, so `tailscale` means the whole
// command space and `tailscale status` means only what `status` can do. Every
// entry here is read-only, takes no path or glob, and cannot change the
// machine's state: `netcheck` measures, `ping` probes and stops on its own,
// `whois` and `dns status` read. Nothing writes, nothing logs out.
const AI_SAFE_TAILNET_COMMANDS = [
  'tailscale status', 'tailscale ip', 'tailscale netcheck', 'tailscale ping',
  'tailscale version', 'tailscale whois', 'tailscale dns status',
];
// Platform-dependent, which the rest of this list is not: `ping` counts its
// packets with -c everywhere except Windows, where the flag is -n, and an
// unbounded ping is a process that never ends. `ip` exists on Linux only and
// `ifconfig`/`ipconfig` are read-only only for some of their arguments —
// `ifconfig en0 down` and `ipconfig /release` are both writes the prefix rule
// cannot forbid, so neither is here in a form that admits an interface.
const AI_SAFE_NET_COMMANDS = {
  darwin: ['ping -c 3', 'netstat -rn', 'ipconfig getifaddr'],
  win32: ['ping -n 3', 'route print', 'netstat -rn'],
  linux: ['ping -c 3', 'ip addr show', 'ip route show', 'netstat -rn'],
};
export function safeShellCommands(platform = process.platform) {
  return [
    'git log', 'git status', 'git describe', 'git diff --stat', 'git show --stat',
    'pwd', 'whoami', 'date', 'uptime', 'uname',
    ...AI_SAFE_TAILNET_COMMANDS,
    ...(AI_SAFE_NET_COMMANDS[platform] ?? AI_SAFE_NET_COMMANDS.linux),
  ];
}
// What this machine allows, resolved once: the list is handed to the model as
// part of its prompt, and offering a Mac `ping -c 3` on Windows would be
// offering a command that cannot run.
export const AI_SAFE_SHELL_COMMANDS = safeShellCommands();
// No metacharacter survives, so an allowed prefix can never be chained into
// something else — `git log; cat secrets.env` is refused whole, not trimmed
// down to the part that looked safe.
const SHELL_METACHARACTERS = /[;&|`$(){}<>]/;
export function isSafeShellCommand(command, allowed = AI_SAFE_SHELL_COMMANDS) {
  const c = String(command ?? '').trim();
  if (c === '' || SHELL_METACHARACTERS.test(c)) return false;
  return allowed.some((prefix) => c === prefix || c.startsWith(`${prefix} `));
}
export const AI_FEEDBACK_EVERY = 15; // unanswered human messages before one recap
export const AI_THROTTLE_MS = 4000; // ~15 requests a minute: what a free tier gives
export const AI_TIMEOUT_MS = 30_000;
export const AI_REPLY_CHARS = 1200; // a terminal window, not an essay
// Generous on purpose. On a thinking model — and every current default is one —
// the reasoning is spent out of this same budget, so a cap tight enough for the
// visible answer gets eaten before a word of it is written and the reply comes
// back empty. The answer is trimmed to AI_REPLY_CHARS anyway, so headroom here
// costs nothing and buys the difference between an answer and a blank. 2048 was
// reachable on a hard question and 4096 sometimes too, so the ceiling moved to
// 8192 — the 30-second request timeout still bounds what a single question can
// spend.
export const AI_MAX_TOKENS = 8192;

// A single blip must not cost the person the answer they asked for, and a
// provider that answers 429 or 503 is asking to be asked again rather than
// refusing. Two extra attempts, each waited out a little longer than the last,
// is the whole policy: enough to ride out one bad moment, not enough to turn a
// dead endpoint into a minute of silence. The waits are jittered because both
// clients of a pair can be throttled by the same provider in the same second,
// and two identical backoffs would collide again on every attempt.
export const AI_RETRIES = 2;
export const AI_RETRY_BASE_MS = 400;
export const AI_RETRY_MAX_MS = 4000;

// A name has to survive being typed into a sentence and recognised again, so a
// blank one, a spaced one or markup is refused rather than half-honoured.
export function normaliseAiName(value) {
  const raw = String(value ?? '').trim().replace(/^@+/, '');
  if (raw === '' || /[\s:]/.test(raw)) return null;
  return raw;
}

// A model choice: a preset number, 'default'/'reset', or an explicit model name.
export function normaliseModelName(value, provider = 'gemini') {
  const raw = String(value ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (raw === '') return null;
  const lower = raw.toLowerCase();
  const preset = AI_PROVIDERS[provider] ?? AI_PROVIDERS.gemini;
  if (lower === 'default' || lower === 'reset') return preset.model;
  const num = parseInt(raw, 10);
  if (!Number.isNaN(num) && String(num) === raw) {
    const list = preset.models ?? GOOGLE_MODELS;
    if (num >= 1 && num <= list.length) return list[num - 1];
    return null;
  }
  if (/[\s:]/.test(raw)) return null;
  return raw;
}

// Explicit beats available beats preset: the environment holds the secret, the
// config file holds the taste. The key never goes into the config — that file is
// meant to be hand-edited and shown to people.
export function resolveAi({ config = {}, env = {} } = {}) {
  const saved = config.ai && typeof config.ai === 'object' ? config.ai : {};
  const provider = resolveProvider(saved, env);
  const preset = AI_PROVIDERS[provider];
  const url = typeof saved.url === 'string' && saved.url !== '' ? saved.url : preset.url;
  const model = typeof saved.model === 'string' && saved.model !== '' ? saved.model : preset.model;
  // TAILCHAT_AI_KEY is for a custom `url`, which has no preset variable to read.
  const key = env.TAILCHAT_AI_KEY || env[preset.keyEnv] || null;
  return {
    name: normaliseAiName(saved.name) ?? DEFAULT_AI_NAME,
    provider,
    url,
    model,
    key,
    keyEnv: preset.keyEnv,
    // On by default: a key in the environment is consent enough, and a person
    // who does not want to be listened to says /ai off once.
    enabled: saved.enabled !== false && saved.never !== true,
    // Full off: /ai never — no model runs here and no question is offered to
    // the peer's AI either. undefined, not false, so a config patch never pins
    // the default into the file.
    never: saved.never === true ? true : undefined,
  };
}

// A named provider is obeyed even with no key, because being told the right
// variable is missing beats being silently redirected elsewhere. With nothing
// named, whichever preset the environment already has a key for wins — so one
// variable is the whole setup, whichever of the two the person happens to own.
function resolveProvider(saved, env) {
  if (Object.hasOwn(AI_PROVIDERS, saved.provider)) return saved.provider;
  const keyed = Object.keys(AI_PROVIDERS).find((name) => env[AI_PROVIDERS[name].keyEnv]);
  return keyed ?? 'gemini';
}

// What gets written back to config.json — never the key, and only what the
// person actually chose. Pinning a preset's own model into the file would mean a
// better default never reaches anyone who once typed /ai on.
export function aiConfigPatch({ name, provider, model, url, enabled, never }) {
  const preset = AI_PROVIDERS[provider] ?? AI_PROVIDERS.gemini;
  const patch = { enabled, name };
  if (provider && provider !== 'gemini') patch.provider = provider;
  if (model && model !== preset.model) patch.model = model;
  if (url && url !== preset.url) patch.url = url;
  if (typeof never === 'boolean') patch.never = never;
  return patch;
}

// Shared with anything that builds a regex out of peer-controlled text —
// a mention name, a display name — none of which may be trusted to contain
// no regex metacharacters.
export const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Name mention remains the explicit invitation. Unicode boundaries keep a
// nickname inside another word from triggering the model.
export function mentionRegex(name) {
  const base = normaliseAiName(name) ?? DEFAULT_AI_NAME;
  const names = base === DEFAULT_AI_NAME ? [base, 'тайлик', 'тэйлик'] : [base];
  const pattern = names.map(escapeRegex).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`, 'iu');
}


// An addressed line belongs to the author's capable client. If that side has
// no AI, the receiving client provides the one fallback. Unaddressed small
// talk stays between the people until the fifteen-message recap.
export function shouldAutoReply({ enabled, hasKey, fromSelf, peerHasAi, addressed }) {
  if (!enabled || !hasKey || addressed !== true) return false;
  if (fromSelf) return true;
  return peerHasAi !== true;
}

// «помолчи» must work as a plain instruction, so it is matched *before* the
// mention gate: a person telling the assistant to stop rarely repeats its
// name. To keep an ordinary human conversation from silencing it by accident
// («стоп» is a normal word between two people), the word only counts when it
// either carries the assistant's name or is the entire message. The words and
// the window live here because two clients obey them — the terminal's own
// tailik (cli.js maybeAnswer) and the cloud bridge — and an assistant that
// went quiet in the browser and kept talking in the terminal would be a bug
// nobody could explain.
export const AI_QUIET_MS = 15 * 60 * 1000;
export const AI_QUIET_WORDS = /(помолч|замолч|молчи|стоп|тише|заткн|be\s+quiet|shut\s+up|silence|\bstop\b)/iu;
export const AI_RESUME_WORDS = /(говори|отвечай|продолжай|speak|talk|resume|unmute)/iu;

export function isBareInstruction(text, pattern) {
  const bare = String(text ?? '').trim().replace(/[!.,…?)(»«"'-]/gu, ' ').trim();
  return bare !== '' && bare.split(/\s+/u).length <= 2 && pattern.test(bare);
}

// What the caps frame claims, and the reason the field is named the way it is:
// `ai` on the wire does not mean "I hold an API key", it means "answers in this
// conversation are mine". That is exactly what the receiver does with it —
// `shouldAutoReply` and `shouldRunExplicitAi` above both defer while it is true.
//
// So a side that wants no AI at all claims it too. The claim is a decision
// rather than a capability, and it is the only way that decision reaches a
// client which would otherwise step in on our behalf: switching the AI off here
// used to hand the answering over instead of ending it, and the assistant went
// on replying under the same name — a switch that read as doing nothing. And
// because the flag has existed since 0.52.0, this works against a peer that has
// never heard of muting.
export function aiOwnsAnswers({ enabled, key, never } = {}) {
  return never === true || (enabled === true && Boolean(key));
}

// Who, if anyone, answers in this conversation. This is the question three
// rounds of confusion were actually about: a switch was flipped, an assistant
// kept replying, and nothing on screen said whose it was. The answer needs both
// sides, because either one can decide there is to be no AI here.
//
// Order matters. A decision to have none outranks a capability to provide one,
// and it does so from whichever side made it — otherwise "nobody answers" would
// be reported as "they answer" whenever they still held a key.
export function answersHere({
  enabled, key, never, peerOwns, peerMuted,
} = {}) {
  if (never === true) return 'nobody-mine';
  if (peerMuted === true) return 'nobody-peer';
  if (enabled === true && Boolean(key)) return 'you';
  if (peerOwns === true) return 'peer';
  return 'none';
}

// Once the assistant has answered, the immediate next human line is a direct
// continuation unless another person already replied in between.
export function isReplyToAi(turns, aiName) {
  const last = turns[turns.length - 1];
  if (!last || last.kind === 'ai') return false;
  const before = turns[turns.length - 2];
  return Boolean(before) && before.kind === 'ai' && before.author === aiName;
}


// `/ai question` first posts the question to the shared room. A client that is
// explicitly off never runs the model, even with a stale key; an advertised
// peer owns the answer. This makes "one AI on the Mac" a physical guarantee,
// including while the Mac is temporarily offline.
export function shouldRunExplicitAi({ localAccepted, localEnabled, peerHasAi }) {
  return !localAccepted && localEnabled === true && peerHasAi !== true;
}
// A leading `@ ` means "the person, not the AI". The space keeps an address
// such as `@tailik` available to invoke the AI. The marker travels with the
// message so the other client honours it, but it is address information, not
// part of what was said — the screen and turn buffer see the line without it.
export function stripHumanMarker(text) {
  return String(text ?? '').replace(/^@(?:\s+|$)/, '');
}

// How the answer reaches the other screen. Its own author is the honest shape —
// the peer never sees our name over words we did not write — but a client that
// predates the frame parses it as unknown and drops it, and then one person is
// reading a conversation with every answer missing from it. So for those peers
// the answer travels as an ordinary message with the name it was written under
// carried in the text: attribution in the line is worse than an author field,
// and far better than silence. `null` means the peer has not said yet, and the
// real frame is the right guess — an unknown peer is a current one.
export function aiFrame({
  name = DEFAULT_AI_NAME, text, ts = Date.now(), id = null, peerSupportsAi = null,
} = {}) {
  const frameId = typeof id === 'string' && id !== '' ? { id } : {};
  if (peerSupportsAi === false) return { t: 'msg', text: `${name}: ${text}`, ts, ...frameId };
  return { t: 'ai', name, text, ts, ...frameId };
}

// The conversation as the model will see it: who said what, in order, capped so a
// long session cannot grow the request without bound. Kept here rather than read
// back from the log file because the transcript can be switched off.
export function createTurnBuffer(limit = AI_TURNS) {
  const turns = [];
  return {
    push(turn) {
      const text = String(turn?.text ?? '').trim();
      if (text === '') return;
      turns.push({
        author: String(turn.author ?? '?'),
        text,
        ts: Number.isFinite(turn.ts) ? turn.ts : Date.now(),
        kind: turn.kind === 'ai' ? 'ai' : turn.kind === 'tool' ? 'tool' : 'human',
      });
      if (turns.length > limit) turns.splice(0, turns.length - limit);
    },
    recent(count = limit) {
      return turns.slice(Math.max(0, turns.length - count));
    },
  };
}

// Attribution is the whole point: the model is a third voice in someone else's
// conversation and has to be able to tell the two of them apart. Each turn keeps
// its author in the text, because the role field only has room for "someone
// else" and "me".
export function buildRequest({
  turns = [], aiName = DEFAULT_AI_NAME, selfName = 'me', peerName = 'peer',
  commands = [], appCommands = [], shellCommands = [], mode = 'answer', version = null,
} = {}) {
  const system = [
    `You are ${aiName}, the assistant that lives inside tailchat — a private two-person`,
    `terminal chat over a Tailscale tailnet. The other two are ${selfName} and ${peerName};`,
    'they talk to each other, not only to you, and you answer into the same transcript.',
    'You know tailchat from the inside — what it is, how it is run, its commands and its',
    'settings — and you answer questions about it whenever they ask.',
    'Your own setup is part of that: /ai shows it, and /ai name, /ai key and /ai provider',
    'change it; the state directory (~/.tailchat by default) keeps config.json and secrets.env.',
    ...(version ? [
      `The currently running Tailchat version is v${version}. For current-version questions, use this value;`,
      'never infer the version from git tags or git describe output.',
    ] : []),
    ...(shellCommands.length > 0 ? [
      'You can also check this machine yourself with one of these exact commands, on its own',
      `line starting with !: ${shellCommands.join(', ')}. Nothing else runs under !: no other`,
      'command, no argument beyond what is shown, no pipes, redirects, chaining or another',
      'machine (no !@host). Its result arrives to you the same way as a tailchat command\'s —',
      'send only that line and nothing else, and you will be asked again right after with the',
      'real output labelled [command output].',
    ] : [
      'You cannot run terminal, remote, or web commands, and you cannot read or write any file',
      'directly — no !command, no !@host. Never emit a line starting with ! as an instruction;',
      'explain how a person can run it instead.',
    ]),
    ...(appCommands.length > 0 ? [
      "You can run one of tailchat's own commands yourself, the same way a person",
      'would type it, on its own line by itself — for example /theme ocean or /happy.',
      `Only these are allowed: ${appCommands.join(', ')}. Anything else starting with /`,
      'is just chat text, not a command, and will not run. A command such as /happy or /asc',
      'sends its own message, so do not also write that emoji or picture yourself. Some of',
      'them — /changelog, /files, /version, /remind, /theme, /status, /ping — answer with real information,',
      'switch settings or schedule reminders (e.g. /remind 10m check oven or /theme ocean):',
      'use /status to look up the current session route, peer address, uptime and traffic,',
      'and /ping to measure round-trip time to the peer.',
      'Only run a command when you genuinely need its output to answer — for general,',
      'conversational or knowledge questions just reply in plain text, no command needed.',
      'When you do need a command, send only that command line and nothing',
      'else; you will be asked again right after with its real output labelled',
      '[command output], and only then should you write the actual answer. /update and',
      '/restart end this session to apply an upgrade or start clean — say what is about to',
      'happen before you send either one, so it is never a surprise.',
    ] : []),
    'Every message you are shown is prefixed with its author\'s name and a colon.',
    'That prefix is addressing information, not part of what they said.',
    'Speak only as yourself. Do not write your own name and a colon before your reply,',
    'and never write a line as if one of them had said it. Never claim you are either',
    'person, that you sent their messages, or that you talked or acted for them.',
    'Answer in the language they are using.',
    'Keep it short — a few lines at most, this is a terminal window, and say so plainly when you do not know.',
  ].join(' ');
  const feedback = mode === 'feedback'
    ? ' You are asked to recap the conversation so far in one or two short'
      + ' sentences. Do not run commands and do not answer an unasked question.'
    : '';
  // The real command table, localised, so the assistant answers about the
  // commands that actually exist instead of a remembered list.
  const reference = commands.length > 0
    ? `\n\nTailchat commands you may be asked about (type them in the chat):\n${commands.join('\n')}`
    : '';

  const messages = turns.map((turn) => {
    if (turn.kind === 'ai') return { role: 'assistant', content: turn.text };
    if (turn.kind === 'tool') return { role: 'user', content: `[command output]\n${turn.text}` };
    return { role: 'user', content: `${turn.author}: ${turn.text}` };
  });
  return { system: system + reference + feedback, messages };
}

// Models like to introduce themselves on every line, and a wall of text in a
// terminal is unreadable, so the reply is trimmed to what a chat window can hold.
export function sanitiseReply(text, {
  aiName = DEFAULT_AI_NAME, humanNames = [], maxChars = AI_REPLY_CHARS,
} = {}) {
  let out = String(text ?? '').trim();
  if (out === '') return '';
  const names = [...new Set([aiName, ...humanNames].map((name) => String(name ?? '').trim()).filter(Boolean))];
  const echo = new RegExp(`^(?:${names.map(escapeRegex).join('|')})\\s*:\\s*`, 'iu');
  const visible = [];
  let toolEcho = false;
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '[command output]') {
      toolEcho = true;
      continue;
    }
    if (toolEcho) {
      if (trimmed === '') toolEcho = false;
      continue;
    }
    // A parenthesised command is neither prose nor an executable directive.
    if (/^\(!.+\)$/.test(trimmed)) continue;
    // The model is displayed as the bot. Remove any participant label it tries
    // to add, including on later lines, rather than letting it speak as a person.
    visible.push(line.replace(echo, ''));
  }
  out = visible.join('\n').trim();
  out = out.replace(/\n{3,}/g, '\n\n');
  if (out.length <= maxChars) return out;
  const cut = out.slice(0, maxChars);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return `${(at > maxChars * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}
// A reply parses two shapes of directive out of the prose, so the caller can
// decide what to do with them: a bare `!` line, optionally `!@host` for
// another machine of the tailnet, and a bare tailchat command such as
// `/theme ocean`. Neither is executed by this module — tailchat's own client
// disables both (`allowShellCommands: false`, an empty `appCommands` list),
// so nothing the AI writes runs as a person. A tailchat-command line is
// recognised only under two guards. First, the word after the slash has to be
// one of the names the caller actually allows: without that, asked "какие
// команды ты умеешь?" the model answers by listing them — `/theme — сменить
// тему`, one per line — and every line of its own answer would vanish into
// the queue as if it meant to run each one. Second, an argument opening with
// a dash or colon reads as the description half of exactly that kind of
// line, not a real argument — nobody types `/theme — сменить тему` meaning
// "run /theme with the argument '— сменить тему'". Either guard failing
// leaves the line as prose. Passing nothing for `appCommands` recognises
// every well-formed name, which is what most tests below rely on.
const DESCRIPTIVE_ARG = /^[-–—:]/;
// A single request can take several parsed directives. Keep this identity
// shared so an identical one is never counted, or executed, twice.
export function commandIdentity(cmd = {}) {
  if (cmd.app) return `app:${String(cmd.app)}\0${String(cmd.arg ?? '')}`;
  return `shell:${String(cmd.host ?? '')}\0${String(cmd.command ?? '')}`;
}

export function splitCommands(text, { appCommands = null, allowShellCommands = true } = {}) {
  const allowed = appCommands ? new Set(appCommands.map((c) => String(c).toLowerCase())) : null;
  const commands = [];
  const kept = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    const bang = /^!\s*(.+)$/.exec(trimmed);
    if (bang && allowShellCommands) {
      const rest = bang[1].trim();
      const remote = /^@([^\s]+)\s+(.+)$/.exec(rest);
      commands.push(remote
        ? { host: remote[1], command: remote[2].trim() }
        : { host: null, command: rest });
      continue;
    }
    const app = /^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+(.*))?$/.exec(trimmed);
    if (app) {
      const name = `/${app[1].toLowerCase()}`;
      const arg = (app[2] ?? '').trim();
      const known = allowed === null || allowed.has(name);
      if (known && !DESCRIPTIVE_ARG.test(arg)) {
        commands.push({ app: name, arg });
        continue;
      }
    }
    kept.push(line);
  }
  const seen = new Set();
  return {
    text: kept.join('\n').trim(),
    commands: commands.filter((command) => {
      const key = commandIdentity(command);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

// The compatibility layers do not agree on how a message carries its text: a
// plain string from most, an array of parts from Google's, and null from a model
// that spent its whole budget thinking. Read all three rather than stringify an
// object into the transcript.
function readContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .join('');
  }
  return '';
}

// Only two kinds of failure are worth asking about twice: the provider saying it
// is over its limit, and its own side breaking. Every other 4xx is a statement
// about the request — a bad key, an unknown model, a body it refuses — and
// repeating it only spends the deadline arriving at the same answer.
export function isRetryableStatus(status) {
  const code = Number(status);
  if (code === 429) return true;
  return code >= 500 && code <= 599;
}

// Retry-After arrives as either a count of seconds or an HTTP date, and both
// spellings are in use among the providers this speaks to. A value we cannot
// read is not worth reporting: it just means our own backoff decides, rather
// than us believing a number we guessed at.
export function parseRetryAfter(value, { now = Date.now } = {}) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - now());
}

// Whether to try again, and how long to wait first. The deadline is the hard
// bound: every attempt shares the one budget the caller gave, so a wait that
// would outlast it is not a retry at all but a slower way to report the failure
// already in hand — and the caller's typing indicator stays up for the whole of
// it. A provider's own Retry-After beats our guess when it sends one.
export function retryPlan({
  attempt = 1, attempts = AI_RETRIES + 1, remainingMs = 0, retryAfterMs = null,
  base = AI_RETRY_BASE_MS, max = AI_RETRY_MAX_MS, random = Math.random,
} = {}) {
  if (attempt >= attempts) return { retry: false, delayMs: 0 };
  const backoff = Math.min(max, base * (2 ** (attempt - 1)));
  const delayMs = retryAfterMs === null || retryAfterMs === undefined
    ? Math.round(backoff * (0.5 + random() * 0.5))
    : Math.round(retryAfterMs);
  if (!(remainingMs > delayMs)) return { retry: false, delayMs: 0 };
  return { retry: true, delayMs };
}

// A wait between attempts has to be as interruptible as the request it follows.
// /stop and the clock both land on the same signal, and a person who asked the
// AI to stop should not have to watch a backoff finish first.
export function abortableDelay(ms, { signal = null, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimer(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() { clearTimer(timer); resolve(); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const ABORTED = Symbol('aborted');

const isAbortError = (err) => err?.name === 'AbortError' || err?.name === 'TimeoutError';

// Resolves when the call is cut off, so a body that neither resolves nor rejects
// can still be raced against the deadline. The listener is removed by hand
// afterwards: the same controller lives across every attempt of one call, and a
// listener per attempt would outlive the attempt that wanted it.
function whenAborted(signal) {
  let off = () => {};
  const promise = new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    off = () => signal.removeEventListener('abort', onAbort);
  });
  return { promise, off };
}

// Real responses carry a Headers object; the doubles a test writes and the odd
// shim hand back a plain object. Both are read here rather than assuming the
// first and throwing on the second.
function readHeader(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found ? found[1] : null;
}

// Never rejects: a network that is down, a depleted key or a provider having a
// bad minute must all come back as a line in the transcript, not as an exception
// through the middle of the TUI.
export async function requestReply({
  resolved, system, messages, humanNames = [],
  fetchImpl = globalThis.fetch, timeoutMs = AI_TIMEOUT_MS, maxTokens = AI_MAX_TOKENS, signal = null,
  retries = AI_RETRIES, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  random = Math.random, delayImpl = abortableDelay,
} = {}) {
  if (!resolved?.key) return { ok: false, reason: 'no-key' };
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no-fetch' };
  const body = {
    model: resolved.model,
    messages: [{ role: 'system', content: system }, ...messages],
    max_tokens: maxTokens,
    temperature: 0.7,
  };
  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${resolved.key}`,
    },
    body: JSON.stringify(body),
  };
  // A call is stopped by /stop or by the clock: one controller combines the
  // two, and the external abort is remembered so the two get distinct reasons.
  const controller = new AbortController();
  let stopped = false;
  const onAbort = () => { stopped = true; controller.abort(); };
  if (signal) {
    if (signal.aborted) { stopped = true; controller.abort(); }
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  // The one deadline covers headers, body and every retry in between, and it
  // stays armed until the answer is in hand. Clearing it the moment fetch
  // resolved was the bug this shape exists to prevent: a provider that sends
  // headers and then trickles or stalls the body used to hold the caller's
  // in-flight flag for the rest of the session, with /stop the only way out and
  // nothing to stop if the person had already given up on it.
  const deadline = now() + timeoutMs;
  const timer = setTimer(() => controller.abort(), timeoutMs);
  const attempts = Math.max(1, Number(retries) + 1);
  try {
    // What gets reported if no attempt ever succeeds. A retryable failure is
    // kept rather than returned, so the last attempt's own words are the ones
    // the person reads.
    let failure = { ok: false, reason: 'network' };
    for (let attempt = 1; ; attempt += 1) {
      let retryAfterMs = null;
      let response = null;
      try {
        response = await fetchImpl(resolved.url, { ...init, signal: controller.signal });
      } catch (err) {
        if (stopped) return { ok: false, reason: 'stopped' };
        // A fetch implementation that throws something other than AbortError
        // after we cut it off is still us cutting it off, not a dead network.
        if (isAbortError(err) || controller.signal.aborted) return { ok: false, reason: 'timeout' };
        failure = { ok: false, reason: 'network' };
      }
      if (response) {
        const watch = whenAborted(controller.signal);
        let parsed;
        try {
          // Google's compatibility layer wraps its body in a one-element array,
          // and the message inside it is the only thing that says "credits
          // depleted" rather than "429". Unwrap before reading anything.
          parsed = await Promise.race([
            response.json().then(
              (value) => ({ value }),
              (err) => (isAbortError(err) || controller.signal.aborted ? ABORTED : { value: null }),
            ),
            watch.promise.then(() => ABORTED),
          ]);
        } catch {
          parsed = { value: null };
        } finally {
          watch.off();
        }
        if (parsed === ABORTED) {
          // The headers arrived and the body did not. Worth its own reason: the
          // provider was reachable and answered, so there is nothing to fix at
          // this end, and retrying inside a deadline that has already run out
          // would only make the wait longer.
          return { ok: false, reason: stopped ? 'stopped' : 'timeout-body' };
        }
        const payload = Array.isArray(parsed.value) ? parsed.value[0] : parsed.value;
        if (response.ok) {
          const choice = payload?.choices?.[0];
          const text = sanitiseReply(readContent(choice?.message?.content), {
            aiName: resolved.name,
            humanNames,
          });
          if (text !== '') return { ok: true, text };
          // Nothing to show, and the two reasons want different fixes: a budget
          // spent before the answer began is a setting, an empty answer is the
          // model. A body we could not parse lands here too, and is the same
          // nothing from the person's side — but it is not a timeout, and saying
          // "timed out" about a provider that answered promptly would send them
          // looking at their network.
          return choice?.finish_reason === 'length'
            ? { ok: false, reason: 'cut-off', detail: `the model used all ${maxTokens} tokens thinking` }
            : { ok: false, reason: 'empty' };
        }
        // The provider's own words are worth more than a status code: "credits
        // depleted" and "no such model" are both 4xx and want different actions.
        const said = payload?.error?.message ?? payload?.error?.status ?? '';
        failure = { ok: false, reason: `http ${response.status}`, detail: String(said).trim().slice(0, 200) };
        if (!isRetryableStatus(response.status)) return failure;
        retryAfterMs = parseRetryAfter(readHeader(response, 'retry-after'), { now });
      }
      const plan = retryPlan({ attempt, attempts, remainingMs: deadline - now(), retryAfterMs, random });
      if (!plan.retry) return failure;
      await delayImpl(plan.delayMs, { signal: controller.signal, setTimer, clearTimer });
      if (stopped) return { ok: false, reason: 'stopped' };
      if (controller.signal.aborted) return { ok: false, reason: 'timeout' };
    }
  } finally {
    clearTimer(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
