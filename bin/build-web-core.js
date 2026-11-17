// Builds the core for the browser (stage 7): `tailchat-web` for
// wasm32-unknown-unknown, then wasm-bindgen's ES-module glue, into
// web/cloud/core/pkg/. Needs the wasm32 target (`rustup target add
// wasm32-unknown-unknown`) and wasm-bindgen-cli of exactly the version
// crates/Cargo.lock pins (`cargo install wasm-bindgen-cli --version <v> --locked`).
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = join(root, 'crates', 'Cargo.toml');
const out = join(root, 'web', 'cloud', 'core', 'pkg');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error(`build-web-core: ${command} is not installed (see the header of bin/build-web-core.js)`);
      process.exit(1);
    }
    throw result.error;
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The glue must come from the same wasm-bindgen as the crate, or it refuses.
const lock = readFileSync(join(root, 'crates', 'Cargo.lock'), 'utf8');
const pinned = /name = "wasm-bindgen"\nversion = "([^"]+)"/.exec(lock)?.[1];
const cli = spawnSync('wasm-bindgen', ['--version'], { encoding: 'utf8' });
const installed = /wasm-bindgen (\S+)/.exec(cli.stdout ?? '')?.[1];
if (pinned && installed && pinned !== installed) {
  console.error(`build-web-core: wasm-bindgen-cli ${installed} does not match the crate's ${pinned}`);
  console.error(`  cargo install wasm-bindgen-cli --version ${pinned} --locked`);
  process.exit(1);
}

run('cargo', ['build', '--release', '-p', 'tailchat-web', '--target', 'wasm32-unknown-unknown', '--manifest-path', manifest]);
const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(root, 'crates', 'target');
rmSync(out, { recursive: true, force: true });
run('wasm-bindgen', [
  '--target', 'web',
  '--no-typescript',
  '--out-dir', out,
  join(target, 'wasm32-unknown-unknown', 'release', 'tailchat_web.wasm'),
]);
