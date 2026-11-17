#!/usr/bin/env bash
# Termux wrapper for tailchat: the real CLI (src/cli.js) run directly on the
# phone, same as android/ and android-ssh-wrapper/ reach the same protocol by
# different means — but this one runs no reimplementation at all, so it needs
# no maintenance when the wire protocol changes. It also links `tailchat` to
# a small wake-lock wrapper (launcher.sh) instead of the raw binary, because
# a long-lived listener like this one is exactly what Android suspends once
# the screen turns off. What the setup costs instead is a handful of
# fiddly, easy-to-forget steps (documented in the main README's "Termux,
# Android" section); this script is exactly those steps, made idempotent so
# it is safe to re-run as an update.
#
# Run it with an explicit interpreter, not by marking it executable and
# calling ./install.sh from outside an interactive Termux shell: bin/tailchat
# in this same repo explains why (no /usr/bin/env outside the interactive
# libtermux-exec shim). From Termux itself, either form works:
#   bash termux-wrapper/install.sh
#   ./termux-wrapper/install.sh
set -euo pipefail

REPO_URL="${TAILCHAT_REPO:-https://github.com/repentandliveholy/tailchat-oss.git}"
INSTALL_DIR="${TAILCHAT_DIR:-$HOME/tailchat}"
WITH_API=1
WITH_STORAGE=1

usage() {
  cat <<'EOF'
Usage: install.sh [--dir PATH] [--repo URL] [--no-api] [--no-storage] [-h]

  --dir PATH     where to check out tailchat (default: ~/tailchat)
  --repo URL     git remote to clone/pull (default: upstream tailchat)
  --no-api       skip installing the termux-api package (notifications)
  --no-storage   skip termux-setup-storage (shared Downloads folder)
  -h, --help     this help

Safe to re-run: it pulls the existing checkout and reinstalls deps instead
of failing, so it doubles as the update command.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR=$2; shift 2 ;;
    --repo) REPO_URL=$2; shift 2 ;;
    --no-api) WITH_API=0; shift ;;
    --no-storage) WITH_STORAGE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# $PREFIX is Termux's userland root (/data/data/com.termux/files/usr); no
# other Android shell sets it, so it is the cheapest reliable signal that
# this is actually Termux and not some other Linux the pkg-specific steps
# below would silently corrupt.
case "${PREFIX:-}" in
  */com.termux/*) ;;
  *)
    echo "this script only makes sense inside Termux (\$PREFIX is not set to a com.termux path)" >&2
    exit 1
    ;;
esac

echo "== packages: nodejs, git =="
pkg install -y nodejs git

# The Tailscale Android app is the VPN; a `tailscale` binary inside Termux
# has no tailscaled to talk to (no socket access into the app's sandbox), so
# every call it makes fails. Before 0.46.4 tailchat treated the binary's
# mere presence as an authority worth asking, and a call that always failed
# meant every inbound peer got rejected. The client no longer trusts a dead
# CLI, but there is still no reason to keep the failing binary around.
if command -v tailscale >/dev/null 2>&1; then
  echo "== removing the Termux tailscale CLI (dead weight next to the Tailscale app) =="
  pkg uninstall -y tailscale
fi

echo "== fetching tailchat into $INSTALL_DIR =="
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

echo "== npm install =="
npm install --prefix "$INSTALL_DIR"

# Two entry points exist in bin/ on purpose: `tailchat` has a
# #!/usr/bin/env node shebang for macOS/Linux/Windows, `tailchat-sh` has
# #!/bin/sh because Android has no /usr at all — outside an interactive
# shell the kernel finds no interpreter for `env` and the launch fails with
# rc=126. See the top comment of bin/tailchat and the main README's
# "Termux, Android" section. `tailchat` on PATH here is linked to
# termux-wrapper/launcher.sh instead of directly to bin/tailchat: same
# #!/bin/sh entry point underneath, plus termux-wake-lock/-unlock around it
# so the session survives the screen turning off (see launcher.sh's own
# comment for why that matters and why it can't just live in bin/tailchat).
mkdir -p "$PREFIX/bin"
ln -sf "$INSTALL_DIR/termux-wrapper/launcher.sh" "$PREFIX/bin/tailchat"

if [ "$WITH_API" -eq 1 ]; then
  echo "== package: termux-api (notifications) =="
  # termux-notification exists once this package is installed, but it only
  # talks to anything if the Termux:API *app* is also installed — and the
  # Google Play build of Termux ships without that bridge at all (calls
  # exit 0 and show nothing). tailchat detects that build via
  # TERMUX_VERSION and falls back to the terminal bell; this step is best
  # effort and not fatal either way.
  pkg install -y termux-api || echo "termux-api package failed to install; notifications will fall back to the bell"
fi

if [ "$WITH_STORAGE" -eq 1 ] && [ ! -d "$HOME/storage" ]; then
  echo "== termux-setup-storage (needed so received files land somewhere the gallery/share sheet can see) =="
  # Termux's own home directory is private to the app: a file tailchat saves
  # there is invisible to every other app. This grants access to the shared
  # Download folder and prompts for the Android permission — it is
  # interactive by design, expect a system dialog.
  termux-setup-storage || echo "termux-setup-storage failed or was declined; received files will stay in $INSTALL_DIR unless a shared Downloads path becomes writable later"
fi

node_version=$(node --version)
echo
echo "== done =="
echo "node: $node_version"
echo "tailchat: $INSTALL_DIR (git checkout, so /update inside the app works)"
echo "launcher: $PREFIX/bin/tailchat -> $INSTALL_DIR/termux-wrapper/launcher.sh (termux-wake-lock while running)"
echo
echo "Tailscale app must already be installed and signed in on this phone —"
echo "this script never touches it. Then, from anywhere in Termux:"
echo
echo "  tailchat <peer-magicdns-name-or-100.x-address>"
echo
echo "First contact needs the MagicDNS name or a 100.x address (no local"
echo "daemon here to resolve a login to a device list); after that the"
echo "remembered short name works. Re-run this script any time to update."
