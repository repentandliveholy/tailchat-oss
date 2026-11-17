import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { CHANGELOG_FILE, parseChangelog, readChangelog } from '../src/changelog.js';

test('parseChangelog splits sections and reads the version from each header', () => {
  const entries = parseChangelog(
    '## 2026-08-22 — 0.47.0: draft in one line\nline one\nline two\n'
    + '### a subheading stays inside the section\n'
    + '## 2026-08-21 — 0.46.5: no CLI\nmore',
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].version, '0.47.0');
  assert.equal(entries[1].version, '0.46.5');
  assert.ok(entries[0].text.includes('### a subheading stays inside the section'));
});

test('readChangelog serves the latest, one version, and since a version', () => {
  const file = path.join(tmpdir(), `changelog-${process.pid}.md`);
  fs.writeFileSync(file, '## 2026-08-22 — 0.47.0: three\n'
    + '## 2026-08-21 — 0.46.5: two\n'
    + '## 2026-08-20 — 0.46.4: one\n');
  try {
    const all = readChangelog('', { file });
    assert.ok(all.includes('0.47.0') && all.includes('0.46.5'), 'the latest entries');
    const one = readChangelog('0.46.5', { file });
    assert.ok(one.includes('0.46.5') && !one.includes('0.47.0'));
    const since = readChangelog('since 0.46.5', { file });
    assert.ok(since.includes('0.47.0') && since.includes('0.46.5') && !since.includes('0.46.4'));
    const missing = readChangelog('9.9.9', { file });
    assert.ok(missing.includes('no entry for 9.9.9'));
    const bounded = readChangelog('', { file, maxChars: 20 });
    assert.ok(bounded.length <= 21);
  } finally {
    fs.unlinkSync(file);
  }
});

test('a missing file is reported, not thrown', () => {
  const out = readChangelog('', { file: path.join(tmpdir(), 'no-such-worklog.md') });
  assert.ok(out.startsWith('(version history: no file'));
});

// The journal stays out of the public copy (bin/export-public.js), where this
// one test has nothing to read; the missing-file path is covered above.
test('the real version history opens and names the latest release', { skip: !fs.existsSync(CHANGELOG_FILE) && 'no docs/worklog.md in this copy' }, () => {
  const out = readChangelog('0.47.0');
  assert.ok(out.includes('0.47.0'));
  assert.ok(!out.startsWith('(version history: no file'));
});
