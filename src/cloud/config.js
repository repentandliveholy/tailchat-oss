import { readSecrets, writeSecret, removeSecret } from '../config.js';

// Where `--cloud` goes when nobody said otherwise. A default that is wrong is
// still better than a flag nobody can guess: this is the box the project
// actually runs, and `--cloud-server` overrides it for anyone running their own.
export const DEFAULT_CLOUD_SERVER = 'https://repentandliveholy.org';

// The token is not a preference. config.json is meant to be pasted into a bug
// report; a token in it is an account handed over. So it lives in secrets.env,
// which is 0600 and exists for exactly this.
export const CLOUD_TOKEN_SECRET = 'TAILCHAT_CLOUD_TOKEN';

// One prefix for everything cloud/tailchat, so a single Caddy route covers the API, the
// socket and the browser client.
const PREFIX = '/tailchat';

// Accepts what a person would actually type — `repentandliveholy.org`,
// `https://host:7683`, a trailing slash — and refuses what cannot carry a
// session: a scheme that is not HTTP, a URL with a path of its own (which would
// silently break the /tailchat prefix), credentials in the authority.
export function normaliseServerUrl(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== '' && path !== '/tailchat' && path !== '/cloud') return null;
  return `${url.protocol}//${url.host}`;
}

// Flag beats the saved server beats the default: the flag is this run's
// intention, and the saved value is the last one that worked.
export function resolveCloudServer({ flag = null, config = {}, env = process.env } = {}) {
  for (const candidate of [flag, env?.TAILCHAT_CLOUD_SERVER, config?.cloudServer, DEFAULT_CLOUD_SERVER]) {
    const server = normaliseServerUrl(candidate);
    if (server) return server;
  }
  return null;
}

export function cloudApiUrl(server, path = '') {
  return `${server}${PREFIX}/api${path}`;
}

// The socket rides the same origin as the API, so a reverse proxy that forwards
// one forwards the other; only the scheme changes.
export function cloudSocketUrl(server) {
  return `${server.replace(/^http/, 'ws')}${PREFIX}/ws`;
}

export function cloudWebUrl(server) {
  return `${server}${PREFIX}/`;
}

export function readCloudToken(stateDir) {
  const token = readSecrets(stateDir)[CLOUD_TOKEN_SECRET];
  return typeof token === 'string' && token !== '' ? token : null;
}

export function saveCloudToken(stateDir, token) {
  writeSecret(stateDir, CLOUD_TOKEN_SECRET, token);
}

export function clearCloudToken(stateDir) {
  removeSecret(stateDir, CLOUD_TOKEN_SECRET);
}
