import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn as spawnProcess } from 'node:child_process';
import crypto from 'node:crypto';

// PowerShell takes a single-quoted string literally, which is why the temp paths
// below are wrapped in single quotes: Windows backslashes and `$` survive without
// escaping. An apostrophe does not — and an apostrophe is ordinary in a Windows
// path, since `C:\Users\O'Brien` and a download called `don't.png` both contain
// one. Unescaped it closes the literal early, so at best the command is malformed
// and the feature silently stops working, and at worst the rest of the path is
// read as PowerShell statements and runs. Doubling every quote is the escape the
// language defines, and it is the only one needed inside a single-quoted literal.
export function powershellLiteral(value) {
  return String(value).replace(/'/g, "''");
}

// Each platform ships a way to pull a PNG out of the clipboard without extra
// dependencies. macOS and Windows write the file themselves; the Linux tools
// stream to stdout, so the caller captures it.
export function clipboardImageSpec(platform, target) {
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: [
        '-e', `set f to (open for access POSIX file "${target}" with write permission)`,
        '-e', 'write (the clipboard as «class PNGf») to f',
        '-e', 'close access f',
      ],
      stdoutToFile: false,
    };
  }
  if (platform === 'win32') {
    const file = powershellLiteral(target);
    return {
      cmd: 'powershell',
      args: [
        '-NoProfile', '-STA', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;'
        + '$i=[System.Windows.Forms.Clipboard]::GetImage();'
        + `if ($i -eq $null) { exit 1 }; $i.Save('${file}', `
        + '[System.Drawing.Imaging.ImageFormat]::Png)',
      ],
      stdoutToFile: false,
    };
  }
  if (platform === 'linux') {
    return process.env.WAYLAND_DISPLAY
      ? { cmd: 'wl-paste', args: ['--type', 'image/png'], stdoutToFile: true }
      : { cmd: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'], stdoutToFile: true };
  }
  return null;
}
export function secureClipboardImageSpec(platform) {
  if (platform === 'darwin') return {
    cmd: 'osascript', args: ['-e', 'the clipboard as «class PNGf»'], encoding: 'utf8',
    decode: (stdout) => {
      const match = /^«data PNGf([0-9a-fA-F]+)»\\s*$/.exec(stdout.trim());
      if (!match) throw new Error('Clipboard contains no PNG image');
      return Buffer.from(match[1], 'hex');
    },
  };
  if (platform === 'win32') return {
    cmd: 'powershell.exe',
    args: ['-NoProfile', '-STA', '-Command', 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $i=[System.Windows.Forms.Clipboard]::GetImage(); if ($null -eq $i) { exit 1 }; $s=New-Object System.IO.MemoryStream; try { $i.Save($s,[System.Drawing.Imaging.ImageFormat]::Png); [Console]::Out.Write([Convert]::ToBase64String($s.ToArray())) } finally { $s.Dispose(); $i.Dispose() }'],
    encoding: 'utf8',
    decode: (stdout) => Buffer.from(stdout.trim(), 'base64'),
  };
  if (platform === 'linux') {
    const spec = clipboardImageSpec(platform, '');
    return { ...spec, encoding: 'buffer', decode: (stdout) => stdout };
  }
  return null;
}

export function readSecureClipboardImage({ dir, store, platform = process.platform } = {}) {
  if (!store) throw new Error('Clipboard capture requires a secure store');
  const spec = secureClipboardImageSpec(platform);
  if (!spec) return Promise.resolve(null);
  const target = path.join(dir, `clipboard-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.png`);
  return new Promise((resolve) => {
    execFile(spec.cmd, spec.args, { maxBuffer: 64 * 1024 * 1024, encoding: spec.encoding }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const bytes = spec.decode(stdout);
        if (!bytes.length) return resolve(null);
        store.write(target, bytes);
        resolve({ path: target, size: bytes.length });
      } catch { resolve(null); }
    });
  });
}

export function readClipboardImage({
  dir,
  platform = process.platform,
  specOverride = null,
} = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = path.join(dir, `clipboard-${stamp}.png`);
  const spec = specOverride ? specOverride(platform, target) : clipboardImageSpec(platform, target);
  if (!spec) return Promise.resolve(null);

  return new Promise((resolve) => {
    const cleanup = () => {
      try {
        fs.unlinkSync(target);
      } catch { /* nothing was written */ }
      resolve(null);
    };

    execFile(
      spec.cmd,
      spec.args,
      { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout) => {
        if (error) return cleanup();
        if (spec.stdoutToFile) {
          if (!stdout || stdout.length === 0) return cleanup();
          fs.writeFileSync(target, stdout, { mode: 0o600 });
        }
        // An empty file means the clipboard held no image; do not ship 0 bytes.
        let size = 0;
        try {
          size = fs.statSync(target).size;
        } catch {
          return cleanup();
        }
        if (size === 0) return cleanup();
        try {
          fs.chmodSync(target, 0o600);
        } catch { /* filesystem without POSIX modes */ }
        return resolve({ path: target, size });
      },
    );
  });
}

// Copying out of a full-screen TUI cannot go through the terminal's own
// selection: the app owns the alternate screen, so the terminal can only see the
// current page. Writing to the system clipboard is the way out, and every
// platform ships a tool for it.
export function clipboardTextSpec(platform, env = process.env) {
  if (platform === 'darwin') return { cmd: 'pbcopy', args: [] };
  if (platform === 'win32') return { cmd: 'clip', args: [] };
  if (platform === 'linux') {
    if (env.TERMUX_VERSION) return { cmd: 'termux-clipboard-set', args: [] };
    return env.WAYLAND_DISPLAY
      ? { cmd: 'wl-copy', args: [] }
      : { cmd: 'xclip', args: ['-selection', 'clipboard'] };
  }
  return null;
}

export function writeClipboardText(text, {
  platform = process.platform,
  env = process.env,
  spawn = spawnProcess,
} = {}) {
  const spec = clipboardTextSpec(platform, env);
  if (!spec || !text) return Promise.resolve(false);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.cmd, spec.args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      return resolve(false);
    }
    // A missing tool is not worth an error dialog in a chat: the copy simply
    // did not happen, and the caller says so. Whichever of these fires first is
    // the answer; a later event cannot flip a promise that already settled.
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    // The write itself needs the same treatment, and it is the one that used to
    // kill the process. If clip.exe or pbcopy exits while a long selection is
    // still being pushed into it, the pipe breaks and Node reports the EPIPE
    // asynchronously, as an 'error' event on the writable — which the try below
    // never sees, because that only catches a synchronous throw. An unhandled
    // 'error' on a stream is fatal, so a copy that lost its reader took the whole
    // chat down with it.
    if (typeof child.stdin?.once === 'function') child.stdin.once('error', () => resolve(false));
    try {
      child.stdin.end(text);
    } catch {
      resolve(false);
    }
    return undefined;
  });
}
