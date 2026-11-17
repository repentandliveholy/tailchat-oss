import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSecrets } from './config.js';

// Deploy status goes to a Telegram channel because the deploy itself runs over
// SSH from a laptop that is closed a minute later: whoever pushed is not the
// person watching the box, and a failed `npm ci` that rolled itself back is
// exactly the event nobody sees in time. Bot token and chat id come from the
// environment — they are credentials and have no business in git.
export const TOKEN_ENV = 'TAILCHAT_DEPLOY_TG_TOKEN';
export const CHAT_ENV = 'TAILCHAT_DEPLOY_TG_CHAT';

/** The checkout's own credentials file: gitignored, `NAME=value` per line. */
export const ENV_FILE = '.env';

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Folds the checkout's `.env` into the environment, because the one place both
 * a laptop and the server always have is the checkout: the deploy is invoked
 * as `ssh ovh 'cd /opt/tailchat && node bin/production-deploy.js'`, which
 * inherits nothing from anybody's shell profile, so a token exported in one is
 * a token the deploy never sees.
 *
 * Deliberately narrow in two ways. It reads only the two names below, so the
 * file cannot quietly become a way to inject `PATH` or `NODE_OPTIONS` into a
 * deploy; and it never overrides a value already exported, so a one-off
 * `TAILCHAT_DEPLOY_TG_CHAT=… node bin/production-deploy.js` still wins.
 * The parser is `parseSecrets` (`src/config.js`) — the same forgiving one the
 * `/ai` key uses, so `export NAME="value"` pasted out of a shell profile reads
 * the same as a bare line.
 */
export function loadDeployEnv({
  root = repoRoot(),
  env = process.env,
  readFile = fs.readFileSync,
} = {}) {
  let text;
  try {
    text = readFile(path.join(root, ENV_FILE), 'utf8');
  } catch {
    return { loaded: [] }; // absent is the normal case on a machine that never deploys
  }
  const parsed = parseSecrets(text);
  const loaded = [];
  for (const name of [TOKEN_ENV, CHAT_ENV]) {
    const value = parsed[name];
    if (typeof value !== 'string' || value === '' || env[name]) continue;
    env[name] = value;
    loaded.push(name);
  }
  return { loaded };
}

const NOTIFY_TIMEOUT_MS = 5000;

function shortCommit(commit) {
  return typeof commit === 'string' && commit !== '' ? commit.slice(0, 12) : 'unknown';
}

// Telegram's HTML parse mode would choke on a rollback reason containing an
// angle bracket, and a deploy report is not the place to lose the reason. Plain
// text costs nothing and cannot be mis-parsed.
export function deployStatusMessage({
  ok,
  version = '?',
  commit = '',
  apps = [],
  reason = '',
  rollback = null,
  host = os.hostname(),
} = {}) {
  const lines = [
    ok ? `✅ Tailchat deploy ok — v${version}` : `❌ Tailchat deploy FAILED — v${version}`,
    `host: ${host}`,
    `commit: ${shortCommit(commit)}`,
  ];
  if (ok) lines.push(`restarted: ${apps.length > 0 ? apps.join(', ') : 'none'}`);
  else {
    lines.push(`reason: ${reason || 'unknown'}`);
    if (rollback) {
      lines.push(rollback.ok
        ? `rolled back to ${shortCommit(rollback.commit)}`
        : `ROLLBACK FAILED at ${shortCommit(rollback.commit)}: ${rollback.reason || 'unknown'}`);
    }
  }
  return lines.join('\n');
}

// Never throws and never blocks a deploy: a missing token, a dead network or a
// Telegram outage must not turn a successful deploy into a failed one, and must
// not hold the SSH session open either.
export async function notifyDeploy(status, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = NOTIFY_TIMEOUT_MS,
} = {}) {
  const token = env[TOKEN_ENV];
  const chat = env[CHAT_ENV];
  if (!token || !chat) return { sent: false, reason: 'not configured' };
  if (typeof fetchImpl !== 'function') return { sent: false, reason: 'no fetch available' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text: deployStatusMessage(status),
        disable_notification: Boolean(status?.ok),
      }),
      signal: controller.signal,
    });
    if (!response?.ok) return { sent: false, reason: `telegram http ${response?.status ?? '?'}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err?.name === 'AbortError' ? 'timeout' : (err?.message || 'failed') };
  } finally {
    clearTimeout(timer);
  }
}
