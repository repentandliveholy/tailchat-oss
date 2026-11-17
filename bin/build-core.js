import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
// Older rustc's implicit cdylib stripping misaligns Mach-O LINKEDIT on macOS 27.
if (process.platform === 'darwin') {
  if (env.CARGO_ENCODED_RUSTFLAGS !== undefined) {
    env.CARGO_ENCODED_RUSTFLAGS += '\x1f-C\x1fstrip=none';
  } else {
    env.RUSTFLAGS = `${env.RUSTFLAGS || ''} -C strip=none`.trim();
  }
}
const result = spawnSync('cargo', ['build', '--release', '-p', 'tailchat-node', '--manifest-path', join(root, 'crates', 'Cargo.toml')], { stdio: 'inherit', env });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const library = process.platform === 'win32' ? 'tailchat_node.dll' : process.platform === 'darwin' ? 'libtailchat_node.dylib' : 'libtailchat_node.so';
const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, 'crates', 'target');
mkdirSync(join(root, 'native'), { recursive: true });
// Copied beside the old module and renamed over it, never written into it:
// macOS keeps the code signature of a loaded file per inode, and a library
// overwritten in place fails dlopen with "code signature does not cover entire
// file" even though the bytes are a correctly signed build.
const installed = join(root, 'native', 'tailchat_core.node');
copyFileSync(join(target, 'release', library), `${installed}.tmp`);
renameSync(`${installed}.tmp`, installed);
