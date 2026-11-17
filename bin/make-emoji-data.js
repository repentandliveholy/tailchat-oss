#!/usr/bin/env node
// The web client draws emoji as Apple's 64px PNGs (spec 2026-10-27, A2) and its
// picker needs a table to lay them out and search them (A3). Both come from two
// pinned npm packages that never become dependencies of the app — they are
// fetched here with `npm pack` into a temporary directory, read, and thrown
// away:
//  * `emoji-datasource-apple@16.0.0` (iamcal/emoji-data, MIT; the Apple images
//    are © Apple Inc. — the owner accepted that risk, spec §0): `emoji.json`
//    for glyphs, categories, sort order and `short_names`, `img/apple/64/` for
//    the pictures.
//  * `cldr-annotations-full@49.0.0` and `cldr-annotations-derived-full@49.0.0`
//    (Unicode CLDR, Unicode-3.0 licence): ru/en keywords and names. The derived
//    set is what names flags, keycaps and ZWJ sequences.
//
// What is kept: every fully-qualified emoji emoji-data has an Apple image for,
// without skin-tone variants (`skin_variations` are never read) and without the
// `Component` category (bare skin-tone swatches and hair parts) — skin tones are
// out of scope. Every image file equals the glyph's code points in lower-case
// hex joined by `-` (asserted below); `emojiImageName` in app.js derives it the
// same way without loading the search table first.
//
// Output, both deterministic (re-running produces identical bytes):
//  * web/cloud/emoji/apple/64/<codepoints>.png
//  * web/cloud/emoji-data.js — `globalThis.TAILCHAT_EMOJI`, loaded by the
//    picker on first open. Not `self.…`: app.js declares a top-level `let self`
//    (the signed-in account), and classic scripts share that binding.
//
// Usage: node bin/make-emoji-data.js
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG_DIR = path.join(ROOT, 'web/cloud/emoji/apple/64');
const DATA_FILE = path.join(ROOT, 'web/cloud/emoji-data.js');

const PACKAGES = {
  emoji: 'emoji-datasource-apple@16.0.0',
  cldr: 'cldr-annotations-full@49.0.0',
  derived: 'cldr-annotations-derived-full@49.0.0',
};

// The picker's tab order (spec A3) — Activities before Travel, the way phone
// keyboards show it, not Unicode's order.
const CATEGORIES = [
  ['smileys', 'Smileys & Emotion'],
  ['people', 'People & Body'],
  ['animals', 'Animals & Nature'],
  ['food', 'Food & Drink'],
  ['activities', 'Activities'],
  ['travel', 'Travel & Places'],
  ['objects', 'Objects'],
  ['symbols', 'Symbols'],
  ['flags', 'Flags'],
];

// The repo budget for the PNG directory (spec A2): above it the spec switches
// to sprite sheets, so a package update that crosses it must stop here.
const PNG_BUDGET_BYTES = 10 * 1024 * 1024;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function fetchPackage(work, spec) {
  const tarball = run('npm', ['pack', spec, '--silent'], work).trim().split('\n').pop();
  const dir = path.join(work, path.basename(tarball, '.tgz'));
  fs.mkdirSync(dir);
  run('tar', ['-xzf', path.join(work, tarball), '-C', dir], work);
  return path.join(dir, 'package');
}

function readAnnotations(pkg, kind, lang) {
  const file = path.join(pkg, kind, lang, 'annotations.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'))[kind].annotations;
}

const glyphOf = (unified) => String.fromCodePoint(...unified.split('-').map((hex) => parseInt(hex, 16)));
const normalise = (word) => word.toLocaleLowerCase('ru').replaceAll('ё', 'е');

// Search tokens, one space-separated string per glyph: emoji-data's
// `short_names` (whole and split on `_`) plus CLDR's keywords and spoken name in
// both languages. CLDR keys drop the FE0F a fully-qualified glyph carries, so
// both spellings are tried.
function keywordsFor(entry, sources) {
  const glyph = glyphOf(entry.unified);
  const bare = glyph.replaceAll('\uFE0F', '');
  const words = new Set();
  for (const name of entry.short_names) {
    words.add(normalise(name));
    for (const part of name.split(/[_-]+/)) if (part) words.add(normalise(part));
  }
  for (const table of sources) {
    const found = table[glyph] ?? table[bare];
    if (!found) continue;
    for (const phrase of [...(found.tts ?? []), ...(found.default ?? [])]) {
      for (const word of phrase.split(/[\s:,.«»“”"()]+/u)) if (word) words.add(normalise(word));
    }
  }
  return [...words].join(' ');
}

function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-emoji-'));
  try {
    const emojiPkg = fetchPackage(work, PACKAGES.emoji);
    const cldrPkg = fetchPackage(work, PACKAGES.cldr);
    const derivedPkg = fetchPackage(work, PACKAGES.derived);
    const sources = ['en', 'ru'].flatMap((lang) => [
      readAnnotations(cldrPkg, 'annotations', lang),
      readAnnotations(derivedPkg, 'annotationsDerived', lang),
    ]);
    const entries = JSON.parse(fs.readFileSync(path.join(emojiPkg, 'emoji.json'), 'utf8'))
      .filter((entry) => entry.has_img_apple && entry.category !== 'Component')
      .sort((a, b) => a.sort_order - b.sort_order);

    fs.rmSync(PNG_DIR, { recursive: true, force: true });
    fs.mkdirSync(PNG_DIR, { recursive: true });
    let bytes = 0;
    const byCategory = new Map(CATEGORIES.map(([id]) => [id, []]));
    const categoryId = new Map(CATEGORIES.map(([id, name]) => [name, id]));
    for (const entry of entries) {
      if (/-1F3F[B-F]/u.test(entry.unified)) throw new Error(`skin tone outside skin_variations: ${entry.unified}`);
      if (entry.image !== `${entry.unified.toLowerCase()}.png`) {
        throw new Error(`image name is not the code points: ${entry.unified} → ${entry.image}`);
      }
      const id = categoryId.get(entry.category);
      if (!id) throw new Error(`unknown category ${entry.category}`);
      const source = path.join(emojiPkg, 'img/apple/64', entry.image);
      fs.copyFileSync(source, path.join(PNG_DIR, entry.image));
      bytes += fs.statSync(source).size;
      byCategory.get(id).push([
        glyphOf(entry.unified), keywordsFor(entry, sources),
        entry.image, entry.sort_order, entry.short_names,
      ]);
    }
    if (bytes > PNG_BUDGET_BYTES) throw new Error(`PNG set is ${bytes} bytes, over the ${PNG_BUDGET_BYTES} budget`);

    const lines = [
      `// Generated by bin/make-emoji-data.js from ${PACKAGES.emoji} (MIT; images © Apple Inc.),`,
      `// ${PACKAGES.cldr} and ${PACKAGES.derived} (Unicode-3.0). Do not edit by hand.`,
      '// Sources: https://github.com/iamcal/emoji-data and https://github.com/unicode-org/cldr-json',
      '/* Bundled source notices (Apple artwork remains © Apple Inc.):',
      fs.readFileSync(path.join(emojiPkg, 'LICENSE'), 'utf8'),
      fs.readFileSync(path.join(cldrPkg, 'LICENSE'), 'utf8'),
      '*/',
      '// Shape: [categoryId, [[glyph, "ru/en search tokens", image, sortOrder, shortNames], …]].',
      '// Category order follows spec A3; entries retain emoji-data sort order.',
      'globalThis.TAILCHAT_EMOJI = [',
    ];
    for (const [id, list] of byCategory) {
      lines.push(`  [${JSON.stringify(id)}, [`);
      for (const item of list) lines.push(`    ${JSON.stringify(item)},`);
      lines.push('  ]],');
    }
    lines.push('];', '');
    fs.writeFileSync(DATA_FILE, lines.join('\n'));
    const listed = [...byCategory.values()].reduce((sum, list) => sum + list.length, 0);
    console.log(`${entries.length} PNGs, ${bytes} bytes → ${path.relative(ROOT, PNG_DIR)}`);
    console.log(`${listed} picker entries, ${fs.statSync(DATA_FILE).size} bytes → ${path.relative(ROOT, DATA_FILE)}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main();
