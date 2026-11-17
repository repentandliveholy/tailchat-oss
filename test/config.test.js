import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configFile, readConfig, writeConfig, languageOverride, resolveLanguage,
  secretsFile, readSecrets, writeSecret, removeSecret, parseSecrets, resetState,
} from '../src/config.js';
import { AI_PROVIDERS, resolveAi } from '../src/ai.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-config-'));

test('a missing config reads as empty, not an error', () => {
  assert.deepEqual(readConfig(tempDir()), {});
});

test('a hand-mangled config reads as empty, not an error', () => {
  const dir = tempDir();
  fs.writeFileSync(configFile(dir), '{not json');
  assert.deepEqual(readConfig(dir), {});
});

test('writeConfig round-trips and lands owner-private', () => {
  const dir = tempDir();
  writeConfig(dir, { lang: 'ru', log: false });
  assert.deepEqual(readConfig(dir), { lang: 'ru', log: false });
  assert.equal(fs.statSync(configFile(dir)).mode & 0o777, 0o600);
});

test('a missing secrets file reads as empty, so a fresh install still starts', () => {
  assert.deepEqual(readSecrets(tempDir()), {});
});

test('the secrets file reads what a person actually pastes into it', () => {
  const parsed = parseSecrets([
    '# a comment',
    '',
    'export GEMINI_API_KEY="abc123"',
    "  OPENROUTER_API_KEY = 'xyz'  ",
    'TAILCHAT_AI_KEY=plain',
    'nonsense',
    '=novalue',
  ].join('\n'));
  assert.deepEqual(parsed, {
    GEMINI_API_KEY: 'abc123',
    OPENROUTER_API_KEY: 'xyz',
    TAILCHAT_AI_KEY: 'plain',
  });
});

test('a written key round-trips, stays owner-private and keeps its neighbours', () => {
  const dir = tempDir();
  writeSecret(dir, 'GEMINI_API_KEY', 'first');
  writeSecret(dir, 'OPENROUTER_API_KEY', 'second');
  writeSecret(dir, 'GEMINI_API_KEY', 'third'); // set twice: the last word wins
  assert.deepEqual(readSecrets(dir), {
    GEMINI_API_KEY: 'third',
    OPENROUTER_API_KEY: 'second',
  });
  assert.equal(fs.statSync(secretsFile(dir)).mode & 0o777, 0o600);
});

// Why this exists: a key on both machines means both clients advertise an AI in
// their caps frame and both answer, so one conversation ends up with two
// assistants talking under the same name. Taking one away had to stop meaning
// `--reset`, which discards the language and the transcript choice with it.
test('a key can be taken away without touching the rest of the settings', () => {
  const dir = tempDir();
  writeSecret(dir, 'DEEPSEEK_API_KEY', 'roman-key');
  writeSecret(dir, 'OPENROUTER_API_KEY', 'keep-me');
  writeConfig(dir, { lang: 'ru', log: true, name: 'Roman' });

  const { removed } = removeSecret(dir, ['DEEPSEEK_API_KEY', 'TAILCHAT_AI_KEY']);
  assert.deepEqual(removed, ['DEEPSEEK_API_KEY']);
  assert.deepEqual(readSecrets(dir), { OPENROUTER_API_KEY: 'keep-me' });
  assert.deepEqual(
    readConfig(dir), { lang: 'ru', log: true, name: 'Roman' },
    'the settings are not collateral',
  );
  assert.equal(fs.statSync(secretsFile(dir)).mode & 0o777, 0o600);
});

// Found by a live test of /ai key none: removing only the active provider's key
// leaves the others on disk, and resolveProvider then picks whichever preset
// still has one — so the machine goes on answering under a different provider,
// the exact opposite of what "no key here" was asked to mean.
test('taking the key away takes every provider with it', () => {
  const dir = tempDir();
  writeSecret(dir, 'DEEPSEEK_API_KEY', 'one');
  writeSecret(dir, 'GEMINI_API_KEY', 'two');
  writeSecret(dir, 'OPENROUTER_API_KEY', 'three');
  writeSecret(dir, 'SOMETHING_UNRELATED', 'keep-me');

  const names = [
    ...Object.values(AI_PROVIDERS).map((preset) => preset.keyEnv),
    'TAILCHAT_AI_KEY',
  ];
  const { removed } = removeSecret(dir, names);

  assert.deepEqual(removed.sort(), ['DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']);
  assert.deepEqual(
    readSecrets(dir), { SOMETHING_UNRELATED: 'keep-me' },
    'a secret that is not an AI key is none of this command\'s business',
  );
  // The point of the whole exercise: nothing is left for resolveAi to find.
  assert.equal(resolveAi({ config: {}, env: readSecrets(dir) }).key, null);
});

test('taking away a key that is not there changes nothing and says so', () => {
  const dir = tempDir();
  writeSecret(dir, 'OPENROUTER_API_KEY', 'keep-me');
  const { removed } = removeSecret(dir, 'DEEPSEEK_API_KEY');
  assert.deepEqual(removed, []);
  assert.deepEqual(readSecrets(dir), { OPENROUTER_API_KEY: 'keep-me' });
});

test('taking away the last key leaves a file the next one can be written into', () => {
  const dir = tempDir();
  writeSecret(dir, 'DEEPSEEK_API_KEY', 'only-one');
  removeSecret(dir, 'DEEPSEEK_API_KEY');
  assert.deepEqual(readSecrets(dir), {}, 'nothing left to find');
  // Unlinking instead would leave the next writeSecret creating a fresh file,
  // and on a filesystem that honours modes it is the existing 0600 that keeps
  // the next key private.
  assert.equal(fs.statSync(secretsFile(dir)).mode & 0o777, 0o600);
  writeSecret(dir, 'DEEPSEEK_API_KEY', 'second-life');
  assert.deepEqual(readSecrets(dir), { DEEPSEEK_API_KEY: 'second-life' });
});

test('a missing secrets file is not an error to remove from', () => {
  const dir = tempDir();
  const { removed } = removeSecret(dir, 'DEEPSEEK_API_KEY');
  assert.deepEqual(removed, []);
});

test('the key never lands in the config file people paste into bug reports', () => {
  const dir = tempDir();
  writeSecret(dir, 'GEMINI_API_KEY', 'secret-value');
  writeConfig(dir, { lang: 'ru', ai: { enabled: true, name: 'tailik' } });
  assert.equal(fs.readFileSync(configFile(dir), 'utf8').includes('secret-value'), false);
});

test('the flag and the variable are the only explicit overrides', () => {
  assert.equal(languageOverride({ argv: ['lit', '--lang', 'ru'] }), 'flag');
  assert.equal(languageOverride({ env: { TAILCHAT_LANG: 'fr' } }), 'env');
  assert.equal(languageOverride({ argv: [], env: {} }), null);
});

test('an explicit choice beats the saved one, and the saved one beats the locale', () => {
  // detected already carries the flag/env value; nothing may override it.
  assert.equal(resolveLanguage({
    argv: ['--lang', 'ru'], config: { lang: 'fr' }, detected: 'ru',
  }), 'ru');
  assert.equal(resolveLanguage({
    env: { TAILCHAT_LANG: 'en' }, config: { lang: 'fr' }, detected: 'en',
  }), 'en');
  // No override: the wizard's answer wins over the locale guess.
  assert.equal(resolveLanguage({ config: { lang: 'ru' }, detected: 'en' }), 'ru');
  assert.equal(resolveLanguage({ config: {}, detected: 'en' }), 'en');
});
test('resetState removes settings and keys but leaves the conversation alone', () => {
  const dir = tempDir();
  writeConfig(dir, { lang: 'ru', ai: { provider: 'deepseek' } });
  writeSecret(dir, 'DEEPSEEK_API_KEY', 'secret-value');
  const log = path.join(dir, 'peer.log');
  fs.writeFileSync(log, 'a transcript is not a setting');
  assert.deepEqual(resetState(dir), [configFile(dir), secretsFile(dir)]);
  assert.equal(fs.existsSync(configFile(dir)), false);
  assert.equal(fs.existsSync(secretsFile(dir)), false);
  assert.equal(fs.existsSync(log), true);
});

test('resetState on a fresh install removes nothing and does not throw', () => {
  const dir = tempDir();
  assert.deepEqual(resetState(dir), []);
});

test('a saved answer is normalised, and a broken one falls back', () => {
  const normalise = (v) => {
    if (!['en', 'ru', 'fr'].includes(String(v).toLowerCase())) throw new Error('unknown');
    return String(v).toLowerCase();
  };
  assert.equal(resolveLanguage({ config: { lang: 'RU' }, detected: 'en', normalise }), 'ru');
  assert.equal(resolveLanguage({ config: { lang: 'xx' }, detected: 'en', normalise }), 'en');
});
