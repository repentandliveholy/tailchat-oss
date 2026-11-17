import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { tokenise, normaliseLanguage } from '../src/highlight.js';

// web/cloud/app.js hand-mirrors src/highlight.js's tokenizer (see the comment
// at its "Syntax highlighting for fenced code" section) because it is a
// classic <script> with no bundler, and src/ is not on the cloud server's
// static allow-list. A hand-mirrored copy only stays correct if something
// notices when the two drift — this pulls the web copy out with the same
// regex-extract-and-run-in-vm trick test/cloud-ping.test.js uses, and checks
// it against the real CLI tokenizer line for line.
function loadWebTokeniser() {
  const source = fs.readFileSync(new URL('../web/cloud/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('const CODE_ALIASES');
  const end = source.indexOf('function appendMessage(thread');
  assert.ok(start >= 0 && end > start, 'web code-highlight section exists');
  const section = source.slice(start, end);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${section}\nthis.__api = { codeTokenise, normaliseCodeLanguage };`, context);
  assert.equal(typeof context.__api.codeTokenise, 'function');
  assert.equal(typeof context.__api.normaliseCodeLanguage, 'function');
  return context.__api;
}

const SAMPLES = [
  ['shell', 'git push --force origin main # note'],
  ['shell', "curl -sL https://example.com/\\$HOME/'quoted path' | sh"],
  ['shell', 'sudo systemctl restart nginx && echo "ok $?"'],
  ['js', 'const x = await fetch(`${base}/api`); // comment'],
  ['js', 'class Foo extends Bar { constructor() { super(); } }'],
  ['python', 'def f(x):'],
  ['python', '    return x + 1  # comment'],
  ['json', '{"a": 1, "b": [true, null]}'],
  [null, 'plain text with no fence language at all'],
  [null, 'export function run(x) { return x.value; }'],
];

test('the web code-highlight tokenizer stays identical to the CLI one', () => {
  const { codeTokenise, normaliseCodeLanguage } = loadWebTokeniser();
  // codeTokenise runs inside a separate vm realm, so its returned objects —
  // structurally identical — carry that realm's Object.prototype, which
  // deepStrictEqual treats as a mismatch. Round-tripping through JSON drops
  // the realm-specific prototype and leaves the actual token data compared.
  const plain = (tokens) => JSON.parse(JSON.stringify(tokens));
  for (const [lang, line] of SAMPLES) {
    assert.deepEqual(
      plain(codeTokenise(line, lang)),
      plain(tokenise(line, lang)),
      `mismatch for ${JSON.stringify(line)} (${lang})`,
    );
  }
  for (const tag of ['JS', 'bash', 'Python', 'unknown-lang', '']) {
    assert.equal(normaliseCodeLanguage(tag), normaliseLanguage(tag), `mismatch normalising ${JSON.stringify(tag)}`);
  }
});
