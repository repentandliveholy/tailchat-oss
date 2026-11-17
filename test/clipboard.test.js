import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clipboardImageSpec,
  readClipboardImage,
  clipboardTextSpec,
  writeClipboardText,
  powershellLiteral,
  secureClipboardImageSpec,
} from '../src/clipboard.js';

// PowerShell's own reading of a single-quoted string: the literal runs to the next
// lone quote, and a doubled quote is one quote inside it. Parsing the generated
// command with the same rule is the only way to tell an escaped path from a path
// that closed the literal early and left the rest of itself as executable code.
function singleQuotedLiterals(script) {
  const found = [];
  let i = 0;
  while (i < script.length) {
    if (script[i] !== "'") { i += 1; continue; }
    i += 1;
    let value = '';
    for (;;) {
      assert.ok(i < script.length, `unterminated literal in: ${script}`);
      if (script[i] === "'" && script[i + 1] === "'") { value += "'"; i += 2; continue; }
      if (script[i] === "'") { i += 1; break; }
      value += script[i];
      i += 1;
    }
    found.push(value);
  }
  return found;
}

test('macOS reads the clipboard PNG straight into the target file', () => {
  const spec = clipboardImageSpec('darwin', '/tmp/x.png');
  assert.equal(spec.cmd, 'osascript');
  assert.ok(spec.args.some((a) => a.includes('PNGf')), 'must request PNG flavour');
  assert.ok(spec.args.some((a) => a.includes('/tmp/x.png')), 'must name the target');
  assert.equal(spec.stdoutToFile, false);
});

test('Windows saves the clipboard image through PowerShell', () => {
  const spec = clipboardImageSpec('win32', 'C:\\tmp\\x.png');
  assert.equal(spec.cmd, 'powershell');
  const script = spec.args.join(' ');
  assert.match(script, /Clipboard\]::GetImage/);
  assert.match(script, /C:\\tmp\\x\.png/);
  assert.equal(spec.stdoutToFile, false);
});

test('a clipboard target with an apostrophe stays a single PowerShell literal', () => {
  // `C:\Users\O'Brien` is an ordinary profile directory and `don't.png` an
  // ordinary download, and either one used to close the literal and take the
  // command with it. Backslashes, spaces and `$` need no escaping in a
  // single-quoted string, so only the quote is doubled.
  const target = "C:\\Users\\O'Brien\\My Pictures\\don't $x.png";
  const spec = clipboardImageSpec('win32', target);
  const script = spec.args[spec.args.length - 1];
  assert.deepEqual(singleQuotedLiterals(script), [target], 'one literal, the path, intact');
  assert.ok(spec.args.includes('-NoProfile'), 'a profile script would corrupt the output');
});

test('a crafted target cannot append PowerShell statements', () => {
  // The path comes from a temp directory the app builds, but it is the same
  // escaping either way: if a quote could close the literal, everything after it
  // would be read as code rather than as a filename.
  const hostile = "C:\\tmp\\x'; Remove-Item C:\\Users -Recurse; '.png";
  const script = clipboardImageSpec('win32', hostile).args.slice(-1)[0];
  assert.deepEqual(singleQuotedLiterals(script), [hostile], 'the whole thing is data');
  const quotes = (s) => (s.match(/'/g) ?? []).length;
  assert.equal(
    quotes(script),
    2 + 2 * quotes(hostile),
    'only the two delimiters stand alone; every quote in the path is doubled',
  );
});

test('only the quote is special inside a single-quoted literal', () => {
  assert.equal(powershellLiteral("don't"), "don''t");
  assert.equal(powershellLiteral('C:\\tmp\\$x'), 'C:\\tmp\\$x', 'backslash and $ pass through');
  assert.equal(powershellLiteral("''"), "''''");
});

test('Linux pipes the clipboard image to stdout', () => {
  const spec = clipboardImageSpec('linux', '/tmp/x.png');
  assert.ok(['wl-paste', 'xclip'].includes(spec.cmd), `unexpected tool: ${spec.cmd}`);
  assert.match(spec.args.join(' '), /image\/png/);
  assert.equal(spec.stdoutToFile, true, 'output is captured from stdout');
});

test('an unsupported platform is reported instead of guessed', () => {
  assert.equal(clipboardImageSpec('sunos', '/tmp/x.png'), null);
});

test('readClipboardImage yields null when the helper cannot produce an image', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-cb-'));
  const result = await readClipboardImage({ dir, platform: 'sunos' });
  assert.equal(result, null);
  assert.deepEqual(fs.readdirSync(dir), [], 'no stray temp file is left behind');
});

test('readClipboardImage discards an empty result rather than sending 0 bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-cb-'));
  // `true` succeeds and writes nothing, standing in for an empty clipboard.
  const result = await readClipboardImage({
    dir,
    platform: 'linux',
    specOverride: () => ({ cmd: 'true', args: [], stdoutToFile: true }),
  });
  assert.equal(result, null);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('each platform copies text with the tool it actually ships', () => {
  // Getting this wrong is silent: the copy simply never happens, and the person
  // finds out when they paste something older.
  const spec = (platform, env = {}) => {
    const s = clipboardTextSpec(platform, env);
    return s ? [s.cmd, ...s.args].join(' ') : null;
  };
  assert.equal(spec('darwin'), 'pbcopy');
  assert.equal(spec('win32'), 'clip');
  assert.equal(spec('linux'), 'xclip -selection clipboard');
  assert.equal(spec('linux', { WAYLAND_DISPLAY: 'wayland-0' }), 'wl-copy');
  // Android has neither X nor Wayland; termux-api is the only route.
  assert.equal(spec('linux', { TERMUX_VERSION: '0.118' }), 'termux-clipboard-set');
  assert.equal(spec('sunos'), null);
});

test('a copy on a platform we cannot serve fails instead of throwing', async () => {
  // The caller says whether the copy happened; it must never take the chat down.
  const never = () => assert.fail('nothing should be spawned');
  assert.equal(await writeClipboardText('x', { platform: 'sunos', spawn: never }), false);
  assert.equal(await writeClipboardText('', { platform: 'darwin', spawn: never }), false);
});

test('the selected text reaches the clipboard tool on stdin', async () => {
  // Passing it as an argument would break on any text with a quote or a newline
  // in it, which is most of a transcript.
  let written = null;
  let argv = null;
  const spawn = (cmd, args) => {
    argv = [cmd, ...args];
    return {
      stdin: { end: (text) => { written = text; } },
      on(event, cb) {
        if (event === 'close') setImmediate(() => cb(0));
        return this;
      },
    };
  };
  const ok = await writeClipboardText('первая\nвторая', { platform: 'darwin', spawn });
  assert.equal(ok, true);
  assert.deepEqual(argv, ['pbcopy']);
  assert.equal(written, 'первая\nвторая');
});

test('a missing clipboard tool is reported, not thrown', async () => {
  // A Linux box without xclip is ordinary, and the chat carries on.
  const missing = () => ({
    stdin: { end() {} },
    on(event, cb) {
      if (event === 'error') setImmediate(() => cb(new Error('ENOENT')));
      return this;
    },
  });
  assert.equal(await writeClipboardText('x', { platform: 'linux', spawn: missing }), false);

  const refused = () => ({
    stdin: { end() {} },
    on(event, cb) {
      if (event === 'close') setImmediate(() => cb(1));
      return this;
    },
  });
  assert.equal(await writeClipboardText('x', { platform: 'linux', spawn: refused }), false);

  const throws = () => { throw new Error('spawn failed'); };
  assert.equal(await writeClipboardText('x', { platform: 'darwin', spawn: throws }), false);
});

test('a clipboard tool that closes the pipe mid-write fails instead of killing the chat', async () => {
  // clip.exe exiting before the whole selection is written breaks the pipe, and
  // Node reports that EPIPE asynchronously as an 'error' event on stdin. Nobody
  // was listening there, and an unhandled 'error' on a stream is fatal, so
  // copying a long transcript could take the process down.
  let onStdinError = null;
  let onClose = null;
  const spawn = () => ({
    stdin: {
      once(event, cb) { if (event === 'error') onStdinError = cb; return this; },
      end() {
        // The reader is already gone; the broken pipe surfaces a tick later.
        setImmediate(() => onStdinError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
      },
    },
    on(event, cb) { if (event === 'close') onClose = cb; return this; },
  });
  const pending = writeClipboardText('a very long transcript', { platform: 'win32', spawn });
  assert.equal(await pending, false);

  // The child's exit arrives after the pipe broke. The answer was already given
  // and must not flip: a copy that lost its reader did not happen.
  assert.equal(typeof onClose, 'function', 'the close handler is still attached');
  onClose(0);
  assert.equal(await pending, false, 'the promise settled exactly once');
});

// `/paste` on macOS: osascript prints the clipboard's PNG as `«data PNGf<hex>»`.
// The decoder once read `»\\s*$` — a literal backslash and `s` — so every real
// paste on a Mac came back as "no image".
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('macOS /paste decodes the «data PNGf…» osascript prints', () => {
  const { decode } = secureClipboardImageSpec('darwin');
  const bytes = Buffer.concat([PNG_MAGIC, Buffer.from('rest')]);
  const printed = `«data PNGf${bytes.toString('hex').toUpperCase()}»\n`;
  assert.deepEqual(decode(printed), bytes);
  assert.throws(() => decode('«class utf8»'), /no PNG/);
  assert.throws(() => decode(''), /no PNG/);
});

test('macOS /paste decodes what the real osascript prints for a PNG', {
  skip: process.platform !== 'darwin' && 'needs osascript',
}, async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailchat-clip-'));
  try {
    const file = path.join(dir, 'p.png');
    execFileSync('sips', ['-s', 'format', 'png', '-z', '2', '2',
      '/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericDocumentIcon.icns',
      '--out', file], { stdio: 'ignore' });
    // Same AppleScript coercion `/paste` uses, read from a file so the
    // person's clipboard is never touched.
    const printed = execFileSync('osascript',
      ['-e', `read POSIX file "${file}" as «class PNGf»`], { encoding: 'utf8' });
    const { decode } = secureClipboardImageSpec('darwin');
    assert.deepEqual(decode(printed), fs.readFileSync(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
