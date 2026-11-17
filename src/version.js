import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

// Display version: strips trailing `.0` so `0.6.0` shows as `0.6`,
// but `0.6.1` stays `0.6.1`.
export function shortVersion(v = VERSION) {
  return String(v).replace(/\.0$/, '');
}

export const SHORT_VERSION = shortVersion(VERSION);
