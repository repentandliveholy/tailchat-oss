import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// The user's own choices, asked once at first run and remembered: the interface
// language and whether the transcript is kept. A small plain file the person can
// also edit by hand — a hand-mangled value simply falls back to defaults.
const FILE = 'config.json';

export function configFile(stateDir) {
  return path.join(stateDir, FILE);
}

export function readConfig(stateDir, { readFile = fs.readFileSync } = {}) {
  try {
    const parsed = JSON.parse(readFile(configFile(stateDir), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // absent or hand-mangled: defaults rather than fail
  }
}

export function writeConfig(stateDir, config, {
  mkdir = fs.mkdirSync, writeFile = fs.writeFileSync,
} = {}) {
  mkdir(stateDir, { recursive: true, mode: 0o700 });
  writeFile(configFile(stateDir), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function hashPassword(password) {
  if (!password || typeof password !== 'string') return null;
  const trimmed = password.trim();
  if (!trimmed) return null;
  return crypto.createHash('sha256').update(trimmed).digest('hex');
}

export function verifyPassword(password, hash) {
  if (!hash) return true; // no password required
  if (!password || typeof password !== 'string') return false;
  return hashPassword(password) === hash;
}

// A key is not a preference: config.json is meant to be hand-edited, pasted
// into a bug report and read out loud, and a secret in it leaks the first time
// someone does any of that. So it lives next to it in its own file, one
// NAME=value per line, readable by its owner alone — which is also what makes
// `/ai` work in a fresh shell with nothing exported.
const SECRETS = 'secrets.env';

export function secretsFile(stateDir) {
  return path.join(stateDir, SECRETS);
}

// Deliberately forgiving about shape: what a person actually has to hand is a
// line copied out of a shell profile, so `export NAME="value"`, stray spaces
// and comments all read as the same thing. A line without a name is skipped
// rather than fatal — a mangled secrets file must not cost anyone the chat.
export function parseSecrets(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).replace(/^export\s+/, '').trim();
    if (name === '') continue;
    const raw = trimmed.slice(eq + 1).trim();
    const quoted = raw.length >= 2
      && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
    out[name] = quoted ? raw.slice(1, -1) : raw;
  }
  return out;
}

export function readSecrets(stateDir, { readFile = fs.readFileSync } = {}) {
  try {
    return parseSecrets(readFile(secretsFile(stateDir), 'utf8'));
  } catch {
    return {}; // absent is the normal case, unreadable is not worth a crash
  }
}

// Rewritten whole, from what is on disk plus the one name that changed, so a
// second key set later does not drop the first. 0600 on the file and 0700 on
// the directory: a world-readable key is the same as no key at all.
export function writeSecret(stateDir, name, value, {
  mkdir = fs.mkdirSync, writeFile = fs.writeFileSync, readFile = fs.readFileSync,
} = {}) {
  const next = { ...readSecrets(stateDir, { readFile }), [name]: value };
  const body = Object.entries(next).map(([key, val]) => `${key}=${val}`).join('\n');
  mkdir(stateDir, { recursive: true, mode: 0o700 });
  writeFile(secretsFile(stateDir), `${body}\n`, { mode: 0o600 });
  return next;
}

// The counterpart, and the reason it exists: with a key on both machines both
// clients advertise an AI and both answer, so a conversation ends up with two
// assistants talking under the same name. Taking a key away used to mean
// `--reset` — which also throws out the language and the transcript choice — or
// deleting the file by hand, and on a Windows box with no shell access neither
// is something a person will do. Names, plural: a custom endpoint's key lives
// under a different variable than a preset's, and both have to go.
export function removeSecret(stateDir, names, {
  mkdir = fs.mkdirSync, writeFile = fs.writeFileSync, readFile = fs.readFileSync,
} = {}) {
  const wanted = new Set([names].flat());
  const current = readSecrets(stateDir, { readFile });
  const removed = Object.keys(current).filter((key) => wanted.has(key));
  if (removed.length === 0) return { removed, kept: current };
  const kept = Object.fromEntries(
    Object.entries(current).filter(([key]) => !wanted.has(key)),
  );
  const body = Object.entries(kept).map(([key, val]) => `${key}=${val}`).join('\n');
  mkdir(stateDir, { recursive: true, mode: 0o700 });
  // Written even when nothing is left, rather than unlinked: an empty file with
  // the right mode is what the next `writeSecret` expects to find.
  writeFile(secretsFile(stateDir), body === '' ? '' : `${body}\n`, { mode: 0o600 });
  return { removed, kept };
}

// `tailchat --reset`: preferences and keys back to factory defaults. The rest
// of the state — the roster, transcripts, received files — is the user's own
// data, not a preference, and survives. Missing files are not an error: a
// fresh install has nothing to reset, and the client re-creates everything on
// its next run.
export function resetState(stateDir, { exists = fs.existsSync, unlink = fs.unlinkSync } = {}) {
  const removed = [];
  for (const file of [configFile(stateDir), secretsFile(stateDir)]) {
    try {
      if (exists(file)) {
        unlink(file);
        removed.push(file);
      }
    } catch {
      // one unremovable file is not worth failing the whole reset
    }
  }
  return removed;
}

// Where an explicit language choice lives, if one was made this run: the flag or
// the TAILCHAT_LANG variable. Anything remembered is weaker than either.
export function languageOverride({ argv = [], env = {} } = {}) {
  if (argv.includes('--lang')) return 'flag';
  if (env.TAILCHAT_LANG) return 'env';
  return null;
}

// How wide a name may be. The header draws it beside the peer's, so a name that
// outruns this would push theirs off the screen.
export const SELF_NAME_MAX = 32;

// The name a person is known by. Its rules come from the two places it ends up
// rather than from taste: the stored transcript is `[HH:MM] name: text` and
// src/paste.js parses that shape back, so a colon inside a name makes a line
// ambiguous, and a control character would corrupt the header it is drawn into.
// Everything else is allowed, spaces included — "Roman K" is a name, and unlike
// the AI's name this one is only ever read, never typed as a mention.
export function normaliseSelfName(value, { limit = SELF_NAME_MAX } = {}) {
  const raw = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^@+/, '')
    .trim();
  if (raw === '' || raw.includes(':')) return null;
  return raw.slice(0, limit).trim() || null;
}

// The flag and the variable already won inside parseArgs (`detected` carries
// their value); a saved wizard answer beats the locale guess, and a locale guess
// is the last word. A hand-edited saved value falls back rather than crash.
export function resolveLanguage({
  argv = [], env = {}, config = {}, detected = 'en', normalise = (v) => v,
} = {}) {
  if (languageOverride({ argv, env })) return detected;
  const saved = config.lang;
  if (saved) {
    try {
      return normalise(saved);
    } catch {
      // keep the fall-through: the environment's word stands
    }
  }
  return detected;
}
