import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The version history lives in the repository, newest first, one section per
// release. Resolved from this module's own location so it works no matter
// where the client was launched from.
export const CHANGELOG_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'docs',
  'worklog.md',
);

const ENTRY = /^##\s+(.*)$/;
const VERSION = /—\s*(\d+(?:\.\d+)+)\s*:/;

// Pure split of the file into sections, each carrying the version its header
// names (or null when the header has none). A `###` subheading is a line
// inside a section, never a new one: after `##` a space is required.
export function parseChangelog(text) {
  const entries = [];
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    const head = ENTRY.exec(line);
    if (head) {
      current = { version: null, text: line };
      entries.push(current);
      continue;
    }
    if (current) current.text += `\n${line}`;
  }
  for (const entry of entries) {
    const match = VERSION.exec(entry.text.split('\n')[0]);
    if (match) entry.version = match[1];
  }
  return entries;
}

// What the model gets for a `!changelog` line. `arg` is the text after the
// marker: empty (the latest entries), a version, or `since <version>`.
export function readChangelog(arg = '', { file = CHANGELOG_FILE, maxChars = 6000 } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return `(version history: no file at ${file})`;
  }
  const entries = parseChangelog(raw);
  if (entries.length === 0) return '(version history: no entries found)';

  const wanted = String(arg).trim();
  const since = /^since\s+(.+)$/i.exec(wanted)?.[1]?.trim();
  let picked;
  if (since) {
    // The file is newest-first, so "since X" walks down until X appears.
    picked = [];
    for (const entry of entries) {
      picked.push(entry.text);
      if (entry.version === since) break;
    }
  } else if (wanted !== '') {
    const entry = entries.find((item) => item.version === wanted);
    if (!entry) {
      const known = entries.map((item) => item.version).filter(Boolean).join(', ');
      return `(version history: no entry for ${wanted} — known: ${known})`;
    }
    picked = [entry.text];
  } else {
    picked = entries.slice(0, 3).map((item) => item.text);
  }

  let out = picked.join('\n\n---\n\n').trim();
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}…`;
  return out;
}
