import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { askName, runSetup } from '../src/setup.js';
import { createTranslator, LANGUAGES } from '../src/i18n.js';

// The wizard's other two questions are blessed menus and need a real terminal;
// the name is a plain prompt, so it can be driven with a pair of streams. A
// stream is not a TTY, which is exactly what `runSetup` refuses to ask into — so
// the name question is tested directly and `runSetup` is tested for the decision
// it makes about whether to ask at all.
function prompt(lines) {
  const input = new PassThrough();
  const output = new PassThrough();
  const written = [];
  output.on('data', (chunk) => written.push(String(chunk)));
  for (const line of lines) input.write(`${line}\n`);
  return { input, output, written };
}

const t = createTranslator('en');

test('a typed name is taken as the name', async () => {
  const { input, output } = prompt(['Roman']);
  assert.equal(await askName('mac-mini.local', { input, output, t }), 'Roman');
});

// The whole point of the question: before it existed the name was os.hostname(),
// which differs on every machine one person owns — several platforms report it
// as "localhost" — so the same correspondent showed up under a different name
// depending on what they happened to answer from.
test('Enter alone keeps the name the machine suggested', async () => {
  const { input, output } = prompt(['']);
  assert.equal(await askName('mac-mini.local', { input, output, t }), 'mac-mini.local');
});

test('a name is tidied rather than refused for spacing', async () => {
  const { input, output } = prompt(['   Roman K   ']);
  assert.equal(
    await askName('host', { input, output, t }), 'Roman K',
    'spaces inside a name are part of it; spaces around it are not',
  );
});

// A colon would make the stored transcript line `[HH:MM] name: text` ambiguous,
// and src/paste.js parses that shape back.
test('a name that would break the transcript is asked again', async () => {
  const { input, output, written } = prompt(['a: b', 'Roman']);
  assert.equal(await askName('host', { input, output, t }), 'Roman');
  assert.match(written.join(''), /will not do/, 'and the person is told why');
});

test('input that ends without an answer keeps the suggestion', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const answered = askName('host', { input, output, t });
  input.end();
  assert.equal(await answered, 'host');
});

test('the question exists in every language', () => {
  for (const lang of LANGUAGES) {
    const tt = createTranslator(lang);
    assert.ok(tt('setup.nameTitle').length > 0, lang);
    assert.match(tt('setup.namePrompt', { suggestion: 'host' }), /host/, lang);
  }
});

// Everything below is about *whether* to ask. A saved name must never be asked
// for twice — that was the rule the language and transcript questions already
// followed, and a wizard that reappears is worse than one that never ran.
test('a name already saved is never asked for again', async () => {
  const asked = await runSetup({
    args: { lang: 'en', name: 'host' },
    config: { lang: 'en', log: true, name: 'Roman' },
    t,
    input: new PassThrough(),
    output: new PassThrough(),
  });
  assert.equal(asked, null, 'nothing to ask means no wizard at all');
});

test('a script is given the defaults instead of a question it cannot answer', async () => {
  const answer = await runSetup({
    args: { lang: 'en', name: 'host' },
    config: {},
    t,
    input: new PassThrough(),
    output: new PassThrough(),
  });
  assert.equal(answer, null, 'no terminal, so no prompt and no hang');
});
