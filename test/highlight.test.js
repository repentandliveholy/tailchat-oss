import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenise, highlight, normaliseLanguage, TOKEN_COLOR, hexTo256 } from '../src/highlight.js';

const kinds = (line, language) => new Set(tokenise(line, language).map((t) => t.kind));
const rebuilt = (line, language) => tokenise(line, language).map((t) => t.text).join('');

test('a fence language is recognised by its usual names', () => {
  for (const name of ['sh', 'bash', 'zsh', 'shell', 'console']) {
    assert.equal(normaliseLanguage(name), 'shell', name);
  }
  assert.equal(normaliseLanguage('JavaScript'), 'js');
  assert.equal(normaliseLanguage('py'), 'python');
  // An unknown or absent language must not be invented.
  assert.equal(normaliseLanguage('cobol'), null);
  assert.equal(normaliseLanguage(''), null);
  assert.equal(normaliseLanguage(undefined), null);
});

test('nothing is lost or invented while tokenising', () => {
  const line = "cd /x && ssh lit 'pm2 restart x' # done";
  assert.equal(rebuilt(line, 'shell'), line, 'the tokens must rebuild the line exactly');
  assert.equal(rebuilt(line, null), line);
  assert.equal(rebuilt('', 'shell'), '');
});

test('a shell line marks commands, strings, pipes and comments', () => {
  const tokens = tokenise("cd /Users/g && ssh lit 'pm2 restart x' # готово", 'shell');
  const byKind = (kind) => tokens.filter((t) => t.kind === kind).map((t) => t.text);
  // Commands are found by call position now, not by a keyword list — an unlisted
  // command like `fastfetch` reads the same as `ls`.
  assert.deepEqual(byKind('function'), ['cd', 'ssh']);
  assert.deepEqual(byKind('operator'), ['&&']);
  // A bare path shares the string colour: `./src` and `'./src'` are the same
  // literal, and the quotes are the shell's business, not the reader's.
  assert.deepEqual(byKind('string'), ['/Users/g', "'pm2 restart x'"]);
  assert.deepEqual(byKind('comment'), ['# готово']);
});

test('a path and a flag are not operators', () => {
  // Otherwise half of every command line turns green for no reason.
  const tokens = tokenise('rsync -az --exclude node_modules ./ lit:bot/', 'shell');
  assert.deepEqual(tokens.filter((t) => t.kind === 'operator'), []);
});

test('a hash inside quotes is a string, not a comment', () => {
  const tokens = tokenise("echo '# not a comment'", 'shell');
  assert.deepEqual(tokens.filter((t) => t.kind === 'comment'), []);
  assert.ok(tokens.some((t) => t.kind === 'string' && t.text.includes('#')));
});

test('an unterminated quote runs to the end instead of swallowing the line', () => {
  const line = "echo 'half a paste";
  assert.equal(rebuilt(line, 'shell'), line);
  assert.ok(kinds(line, 'shell').has('string'));
});

test('javascript and python get their own keywords and operators', () => {
  assert.ok(kinds('const a = 1;', 'js').has('keyword'));
  assert.ok(tokenise('const a = 1;', 'js').some((t) => t.kind === 'operator' && t.text === '='));
  assert.ok(tokenise('a => b', 'js').some((t) => t.text === '=>'));
  assert.ok(tokenise('def f(x):', 'python').some((t) => t.kind === 'keyword' && t.text === 'def'));
  // `#` is a comment in Python and a shell, but not in JavaScript.
  assert.ok(kinds('# note', 'python').has('comment'));
  assert.ok(kinds('// note', 'js').has('comment'));
  assert.equal(kinds('# note', 'js').has('comment'), false);
});

test('without a language only what every language agrees on is coloured', () => {
  // Guessing from the first word labelled a JavaScript paste as shell, because
  // `export` and `function` belong to both lists. So keywords are dropped, but a
  // name being called, brackets and quoted text are safe in every language.
  assert.deepEqual(
    [...kinds("export function f() { throw new Error('bad'); }", null)].sort(),
    ['function', 'identifier', 'plain', 'punct', 'string'],
  );
  assert.ok(kinds('const a = 42', null).has('number'));
  assert.ok(kinds('# a note', null).has('comment'));
  assert.ok(kinds('a && b', null).has('operator'));
});

test('a generic comment rule does not eat a URL or a private field', () => {
  for (const line of ['fetch("https://x.dev")', 'this.#count = 1']) {
    assert.deepEqual(tokenise(line, null).filter((t) => t.kind === 'comment'), [], line);
  }
});

test('every colour becomes a numeric 256-colour tag, not a name', () => {
  // blessed caches hex matches against an 8-colour table at boot, so a hex on a
  // palette entry came back as a base colour. Numeric tags have no such cache:
  // every token colour must map to a real index in the 16-255 range.
  for (const [kind, color] of Object.entries(TOKEN_COLOR)) {
    const index = hexTo256(color);
    assert.ok(index >= 16 && index <= 255, `${kind} maps out of range: ${index}`);
  }
  const out = highlight('const a = 42', 'js', { escape: (v) => v });
  assert.match(out, /\{33-fg\}/, 'the keyword lands on the vivid blue cell');
});

test('escaping happens per token, so code cannot inject markup', () => {
  // `{red-fg}` in code, unescaped, would paint the rest of the line. The escape
  // is applied per token, so the brace is neutralised before any tag is built.
  const escape = (v) => v.replace(/\{/g, '{open}');
  const out = highlight('echo {red-fg}', 'shell', { escape });
  assert.ok(out.includes('{open}'), 'the injected brace was escaped');
  assert.ok(!out.includes('{red-fg}'), 'raw markup did not survive');
});

test('monochrome returns the line with no tags at all', () => {
  const line = "cd /x && echo 'y'";
  assert.equal(highlight(line, 'shell', { themed: false }), line);
  assert.equal(highlight(line, null, { themed: false }), line);
});

test('numbers, constants and variables each get their own colour', () => {
  // A port or a timeout must not read as part of the warm string next to it,
  // and a value handed in from outside differs from one you can read off the line.
  assert.ok(tokenise('const a = 42', 'js').some((t) => t.kind === 'number' && t.text === '42'));
  assert.ok(tokenise('if (x == null)', 'js').some((t) => t.kind === 'builtin' && t.text === 'null'));
  assert.ok(tokenise('x = None', 'python').some((t) => t.kind === 'builtin' && t.text === 'None'));
  assert.ok(tokenise('echo $HOME ${x} $1', 'shell').filter((t) => t.kind === 'builtin').length === 3);
});

test('a string escape lifts off the text without leaving the string', () => {
  const tokens = tokenise('"a\\nb"', 'python');
  assert.deepEqual(
    tokens.map((t) => [t.kind, t.text]),
    [['string', '"a'], ['escape', '\\n'], ['string', 'b"']],
  );
  // A backslash is literal inside shell single quotes, so no escape is claimed.
  assert.deepEqual(tokenise("'a\\nb'", 'shell').map((t) => t.kind), ['string']);
});

test('operators stay loud while brackets stay quiet', () => {
  const tokens = tokenise('a |= b[i]', 'python');
  // Adjacent same-kind tokens render identically to one, so the split inside
  // `|=` is invisible; what matters is that neither half reads as punctuation.
  assert.ok(tokens.filter((t) => t.kind === 'operator' && /^[|=]$/.test(t.text)).length >= 2);
  assert.ok(tokens.some((t) => t.kind === 'punct' && t.text === '['));
  assert.ok(tokens.some((t) => t.kind === 'punct' && t.text === ']'));
});

test('a line that is only punctuation does not crash', () => {
  for (const line of ['{', '}', '[[[', ')))))', '...']) {
    assert.equal(rebuilt(line, 'shell'), line);
    assert.equal(rebuilt(line, null), line);
  }
});

test('a function name in call position is told apart from a bare name', () => {
  assert.ok(tokenise('run(x)', 'js').some((t) => t.kind === 'function' && t.text === 'run'));
  // A name not being called stays plain text; a bare one at line end has no
  // neighbour to merge with, so the distinction is easy to see.
  assert.ok(tokenise('x = run', 'python').some((t) => t.kind === 'identifier' && t.text.trim() === 'run'));
});

test('monochrome output is byte-identical to the input', () => {
  const line = "cd /x && ssh lit 'pm2 restart x' # done";
  assert.equal(highlight(line, 'shell', { themed: false }), line);
  assert.equal(highlight(line, null, { themed: false }), line);
});

test('variables, members and types each get their own colour', () => {
  // The bulk of a line used to be plain white, so a whole line read as one
  // colour. Now a variable is light blue, a field after a dot is pink, and a
  // PascalCase type is teal.
  assert.ok(tokenise('const cfg = 42', 'js').some((t) => t.kind === 'identifier' && t.text === 'cfg'));
  assert.ok(tokenise('user.name', 'js').some((t) => t.kind === 'member' && t.text === 'name'));
  assert.ok(tokenise('class MyWidget(Widget):', 'python').some((t) => t.kind === 'type' && t.text === 'MyWidget'));
  // A class head's `(` is a base list, not a call, so the bases are types too.
  assert.ok(tokenise('class MyWidget(Widget):', 'python').some((t) => t.kind === 'type' && t.text === 'Widget'));
  // A function definition names a callable, not a type.
  assert.ok(tokenise('function greet() {}', 'js').some((t) => t.kind === 'function' && t.text === 'greet'));
});

test('only keywords are bold — calls and types stay quiet', () => {
  // `const` and `function` open a line; `load(x)` and `Widget` sit inside it. The
  // eye must land on the first, which is why it is the only bold kind.
  assert.match(highlight('const a = 1', 'js', { escape: (v) => v }), /\{bold\}\{33-fg\}const/);
  assert.doesNotMatch(highlight('load(x)', 'js', { escape: (v) => v }), /\{bold\}/, 'a call is not bold');
  assert.doesNotMatch(highlight('Widget', 'python', { escape: (v) => v }), /\{bold\}/, 'a type is not bold');
});

test('a shell argument is plain, not a green variable', () => {
  // `git push origin main` read as a magenta command and three green words; the
  // middle was one flat colour. Arguments are plain so the command, flags, paths
  // and pipes around them stand out.
  const tokens = tokenise('git push origin main --force', 'shell');
  assert.ok(tokens.some((t) => t.kind === 'function' && t.text === 'git'));
  assert.ok(tokens.some((t) => t.kind === 'plain' && t.text.includes('push origin main')));
  assert.ok(tokens.some((t) => t.kind === 'flag' && t.text === '--force'));
});

test('a shell flag is a flag, not a keyword', () => {
  assert.ok(tokenise('rsync -az --exclude', 'shell').some((t) => t.kind === 'flag' && t.text === '-az'));
  assert.ok(tokenise('rsync -az --exclude', 'shell').some((t) => t.kind === 'flag' && t.text === '--exclude'));
  assert.equal(tokenise('rsync -az', 'shell').some((t) => t.kind === 'keyword'), false);
});
