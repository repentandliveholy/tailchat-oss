// Bug reports from inside the app, filed as GitHub issues.
//
// Deliberately the whole integration: one POST, no client library, no cached
// installation token, no webhooks. The deployment holds a single personal
// access token with `issues:write` on one repository, and the only thing that
// ever reaches GitHub is what a person typed into the `{tailchat}` thread plus
// the login that typed it.
//
// The token is read from the environment (`TAILCHAT_GITHUB_TOKEN`) or, better
// on the live box, from `github_token` in the deployment's data directory —
// next to `vapid_key.json`, for the same reason `push.js` keeps its keypair
// there: `ecosystem.config.cjs` is a tracked file, and a personal access
// token does not belong in git or in the process list. A deployment with
// neither simply has no reporter — `createGithubIssues` returns `null` and
// the service account says so instead of pretending the report went
// somewhere.
import { readCloudSidecar } from './storage-crypto.js';

const API_ROOT = 'https://api.github.com';
// No built-in target: the repository a deployment files reports into is the
// operator's choice, and a default would quietly publish people's reports
// into whatever repository the code happened to be cloned from — public, for
// anybody running this from a public checkout. Reports usually quote
// conversations, so the target should be a private repository.
// GitHub's own limit is 256 characters; a title is a summary line, not the
// report, and the body carries the whole text regardless.
const TITLE_MAX = 80;
const BODY_MAX = 8000;
const TIMEOUT_MS = 10_000;

export const GITHUB_TOKEN_ENV = 'TAILCHAT_GITHUB_TOKEN';
export const GITHUB_REPO_ENV = 'TAILCHAT_GITHUB_REPO';
export const GITHUB_TOKEN_FILE = 'github_token';

/** Optional GitHub credential: missing disables reporting; corrupt credentials stop boot. */
function tokenFromDir(dir, cipher) {
  if (!dir) return '';
  try {
    return readCloudSidecar(dir, GITHUB_TOKEN_FILE, cipher).split('\n')[0].trim();
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

/** First line, trimmed to something that reads as a title. */
export function issueTitle(text) {
  const first = String(text ?? '').split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
  const flat = first.replace(/\s+/gu, ' ');
  if (flat === '') return 'Сообщение об ошибке из Tailchat';
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}

/**
 * The report as it will be read months later by somebody who was not there:
 * the text as typed, then who reported it and when. The login is included on
 * purpose — a bug report nobody can ask a follow-up question about is half a
 * report — and nothing else about the account is.
 */
export function issueBody({ text, login, at = Date.now() }) {
  const body = String(text ?? '').slice(0, BODY_MAX).trim();
  const stamp = new Date(at).toISOString();
  return `${body}\n\n---\nОтправлено из Tailchat аккаунтом @${login} · ${stamp}`;
}

export function createGithubIssues({
  dataDir = null,
  cipher,
  token = process.env[GITHUB_TOKEN_ENV] || tokenFromDir(dataDir, cipher),
  repo = process.env[GITHUB_REPO_ENV] || '',
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const trimmed = String(token).trim();
  // No token is not a failure to report: it is a deployment that never opted
  // in. The caller checks for `null` and tells the person the truth.
  const target = String(repo).trim();
  if (trimmed === '' || target === '' || typeof fetchImpl !== 'function') return null;

  return {
    repo: target,
    /** Resolves to `{ url, number }`; throws with a short reason otherwise. */
    async report({ text, login }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetchImpl(`${API_ROOT}/repos/${target}/issues`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${trimmed}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'tailchat-cloud',
          },
          body: JSON.stringify({
            title: issueTitle(text),
            body: issueBody({ text, login, at: now() }),
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`github_${response.status}`);
        const payload = await response.json();
        return { url: String(payload?.html_url ?? ''), number: Number(payload?.number) || 0 };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
