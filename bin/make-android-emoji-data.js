#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const output = process.argv[2];
if (!output) throw new Error('Usage: node bin/make-android-emoji-data.js <generated-assets-directory>');
const sourcePath = fileURLToPath(new URL('../web/cloud/emoji-data.js', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8');
const context = {};
vm.runInNewContext(source, context, { timeout: 5000, filename: sourcePath });
if (!Array.isArray(context.TAILCHAT_EMOJI)) throw new Error('Missing web emoji catalog');
const directory = path.join(output, 'emoji');
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'catalog.json'), JSON.stringify({ categories: context.TAILCHAT_EMOJI }) + '\n');
fs.writeFileSync(path.join(directory, 'NOTICE.txt'), source.slice(0, source.indexOf('globalThis.TAILCHAT_EMOJI')));
