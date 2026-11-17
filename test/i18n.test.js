import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LANGUAGES, DICTIONARIES, detectLanguage, normaliseLanguage, createTranslator,
} from '../src/i18n.js';

test('every language covers every key the reference language defines', () => {
  const reference = Object.keys(DICTIONARIES.en).sort();
  for (const lang of LANGUAGES) {
    const keys = Object.keys(DICTIONARIES[lang]).sort();
    assert.deepEqual(keys, reference, `${lang} does not match the English key set`);
  }
});

test('a translation keeps every placeholder its English original uses', () => {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const lang of LANGUAGES) {
    for (const [key, text] of Object.entries(DICTIONARIES[lang])) {
      assert.deepEqual(
        placeholders(text),
        placeholders(DICTIONARIES.en[key]),
        `${lang}/${key} changed its placeholders`,
      );
    }
  }
});

test('no translation is left as a copy of the English text', () => {
  for (const lang of LANGUAGES.filter((l) => l !== 'en')) {
    const copies = Object.entries(DICTIONARIES[lang])
      // Marker glyphs and command names are deliberately identical everywhere.
      .filter(([key, text]) => text === DICTIONARIES.en[key] && !key.startsWith('marker'))
      .map(([key]) => key);
    assert.deepEqual(copies, [], `${lang} has untranslated keys`);
  }
});

test('language is detected from the usual environment variables', () => {
  assert.equal(detectLanguage({ LANG: 'ru_RU.UTF-8' }), 'ru');
  assert.equal(detectLanguage({ LC_ALL: 'fr_CA.UTF-8' }), 'fr');
  assert.equal(detectLanguage({ LC_MESSAGES: 'en_GB' }), 'en');
  // An explicit override beats the locale, which is how a Russian desktop can
  // still run an English client.
  assert.equal(detectLanguage({ TAILCHAT_LANG: 'fr', LANG: 'ru_RU.UTF-8' }), 'fr');
});

test('an unsupported or missing locale falls back to English', () => {
  assert.equal(detectLanguage({ LANG: 'de_DE.UTF-8' }), 'en');
  assert.equal(detectLanguage({ LANG: 'C.UTF-8' }), 'en');
  assert.equal(detectLanguage({}), 'en');
});

test('an explicit language flag rejects what it cannot honour', () => {
  assert.equal(normaliseLanguage('RU'), 'ru');
  assert.equal(normaliseLanguage('fr-CA'), 'fr');
  assert.throws(() => normaliseLanguage('de'), /unknown language/);
  assert.throws(() => normaliseLanguage(''), /unknown language/);
});

test('placeholders are substituted and unknown ones are left visible', () => {
  const t = createTranslator('ru');
  assert.match(t('wake.wait', { seconds: 7 }), /7/);
  assert.equal(t('cmd.unknown', { name: '/zzz' }).includes('/zzz'), true);
  // A typo in the caller must not silently vanish from the output.
  assert.match(t('wake.wait', { wrong: 1 }), /\{seconds\}/);
});

test('a key missing from a translation still renders in English', () => {
  const t = createTranslator('ru');
  const original = DICTIONARIES.ru['cmd.quit'];
  delete DICTIONARIES.ru['cmd.quit'];
  try {
    assert.equal(t('cmd.quit'), DICTIONARIES.en['cmd.quit']);
  } finally {
    DICTIONARIES.ru['cmd.quit'] = original;
  }
});

test('an unknown key is a programming error, not a blank line', () => {
  const t = createTranslator('en');
  assert.throws(() => t('nope.not.here'), /missing translation key/);
});

test('every static translation key called with t() in src/ exists in dictionaries', () => {
  const srcDir = path.resolve('src');
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js') && f !== 'i18n.js');
  const keyPattern = /\bt\(\s*['"]([a-zA-Z0-9_.-]+)['"]/g;
  for (const file of files) {
    const code = fs.readFileSync(path.join(srcDir, file), 'utf8');
    for (const match of code.matchAll(keyPattern)) {
      const key = match[1];
      assert.ok(
        Object.hasOwn(DICTIONARIES.en, key),
        `File src/${file} uses missing translation key: "${key}"`,
      );
    }
  }
});
