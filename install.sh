#!/usr/bin/env bash
# ==============================================================================
# Tailchat Universal Installer & Cloud Setup
# ==============================================================================
# Universal installation script for macOS, Linux, and Android (Termux).
#
# Usage:
#   curl -fsSL https://repentandliveholy.org/tailchat/install.sh | bash
#   or locally: ./install.sh
# ==============================================================================

set -euo pipefail

# Output colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

log() {
  echo -e "${GREEN}==>${NC} ${BOLD}$1${NC}"
}

info() {
  echo -e "${CYAN}-->${NC} $1"
}

warn() {
  echo -e "${YELLOW}⚠️  $1${NC}"
}

err() {
  echo -e "${RED}❌ $1${NC}" >&2
}

# 1. Platform Detection
IS_TERMUX=0
IS_MACOS=0
IS_LINUX=0

if [ -n "${PREFIX:-}" ] && echo "$PREFIX" | grep -q "com.termux"; then
  IS_TERMUX=1
  PLATFORM="Android (Termux)"
elif [[ "$OSTYPE" == "darwin"* ]]; then
  IS_MACOS=1
  PLATFORM="macOS"
elif [[ "$OSTYPE" == "linux-gnu"* ]] || [[ "$OSTYPE" == "linux"* ]]; then
  IS_LINUX=1
  PLATFORM="Linux"
else
  PLATFORM="Unix-like"
fi

log "Platform: $PLATFORM"

# 2. Check and Install Node.js (>= 22)
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 22 ]; then
    NODE_OK=1
    info "Node.js $(node -v) is already installed"
  fi
fi

if [ "$NODE_OK" -eq 0 ]; then
  log "Installing Node.js (>= 22)..."
  if [ "$IS_TERMUX" -eq 1 ]; then
    pkg update -y && pkg install -y nodejs
  elif [ "$IS_MACOS" -eq 1 ]; then
    if command -v brew >/dev/null 2>&1; then
      brew install node
    else
      warn "Homebrew not found. Please install Node.js from https://nodejs.org"
    fi
  elif [ "$IS_LINUX" -eq 1 ]; then
    if command -v apt-get >/dev/null 2>&1; then
      # Debian/Ubuntu's own package is often older than Node 22, and the
      # usual fix — piping a third-party setup script into `sudo bash` — is not
      # something an installer should do on your behalf.
      err "Node.js 22+ is required. Install it, then run this installer again:"
      err "  https://nodejs.org/en/download/package-manager"
      exit 1
    elif command -v dnf >/dev/null 2>&1; then
      sudo dnf install -y nodejs
    elif command -v pacman >/dev/null 2>&1; then
      sudo pacman -Sy --noconfirm nodejs npm
    elif command -v apk >/dev/null 2>&1; then
      sudo apk add nodejs npm
    fi
  fi
fi

# 3. Target Directory and Direct Server Package Download
if [ -f "./bin/tailchat.js" ] && [ -f "./package.json" ]; then
  REPO_DIR="$(pwd)"
  info "Using current repository: $REPO_DIR"
else
  REPO_DIR="${HOME}/.tailchat-app"
  log "Downloading and installing Tailchat in $REPO_DIR..."
  mkdir -p "$REPO_DIR"
  TMP_TAR="${HOME}/.tailchat-download.tar.gz"
  if curl -fsSL https://repentandliveholy.org/tailchat/tailchat.tar.gz -o "$TMP_TAR"; then
    tar -xzf "$TMP_TAR" -C "$REPO_DIR"
    rm -f "$TMP_TAR"
  else
    err "Failed to download Tailchat archive from server."
    exit 1
  fi
fi

cd "$REPO_DIR"

# 4. Project Dependencies
log "Installing dependencies..."
npm ci --omit=dev --silent

# 5. Default Cloud Server Config (~/.tailchat/config.json)
mkdir -p "${HOME}/.tailchat"
if [ ! -f "${HOME}/.tailchat/config.json" ]; then
  echo '{"cloudServer":"https://repentandliveholy.org"}' > "${HOME}/.tailchat/config.json"
elif ! grep -q "cloudServer" "${HOME}/.tailchat/config.json"; then
  node -e "
  import fs from 'node:fs';
  const file = '${HOME}/.tailchat/config.json';
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!c.cloudServer) { c.cloudServer = 'https://repentandliveholy.org'; fs.writeFileSync(file, JSON.stringify(c, null, 2)); }
  } catch {}
  " 2>/dev/null || true
fi

# 6. Configure Global Command
log "Setting up 'tailchat' and 'tc' executables..."
chmod +x "$REPO_DIR/bin/tailchat.js"

# 6.1 Try /usr/local/bin (standard system PATH on macOS and Linux)
if [ -w "/usr/local/bin" ]; then
  ln -sf "$REPO_DIR/bin/tailchat.js" /usr/local/bin/tailchat 2>/dev/null || true
  ln -sf "$REPO_DIR/bin/tailchat.js" /usr/local/bin/tc 2>/dev/null || true
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo ln -sf "$REPO_DIR/bin/tailchat.js" /usr/local/bin/tailchat 2>/dev/null || true
  sudo ln -sf "$REPO_DIR/bin/tailchat.js" /usr/local/bin/tc 2>/dev/null || true
fi

# 6.2 Termux path
if [ "$IS_TERMUX" -eq 1 ]; then
  mkdir -p "$PREFIX/bin"
  if [ -f "$REPO_DIR/termux-wrapper/launcher.sh" ]; then
    ln -sf "$REPO_DIR/termux-wrapper/launcher.sh" "$PREFIX/bin/tailchat"
    ln -sf "$REPO_DIR/termux-wrapper/launcher.sh" "$PREFIX/bin/tc"
  else
    ln -sf "$REPO_DIR/bin/tailchat.js" "$PREFIX/bin/tailchat"
    ln -sf "$REPO_DIR/bin/tailchat.js" "$PREFIX/bin/tc"
  fi
  chmod +x "$PREFIX/bin/tailchat" "$PREFIX/bin/tc" 2>/dev/null || true
fi

# 6.3 User local path ~/.local/bin
mkdir -p "${HOME}/.local/bin"
ln -sf "$REPO_DIR/bin/tailchat.js" "${HOME}/.local/bin/tailchat"
ln -sf "$REPO_DIR/bin/tailchat.js" "${HOME}/.local/bin/tc"

# 6.4 Ensure ~/.local/bin is in shell config
PATH_EXPORT='export PATH="$HOME/.local/bin:$PATH"'
for RC in "${HOME}/.zshrc" "${HOME}/.bashrc" "${HOME}/.profile"; do
  if [ -f "$RC" ]; then
    if ! grep -q "\.local/bin" "$RC" 2>/dev/null; then
      echo "" >> "$RC"
      echo "$PATH_EXPORT" >> "$RC"
    fi
  fi
done

# Also try npm link
npm link --silent 2>/dev/null || true

echo
log "Installation completed successfully! 🎉"
echo
echo -e "To start cloud terminal chat, run:"
echo -e "  ${GREEN}${BOLD}tailchat --cloud${NC}"
echo
echo -e "If 'tailchat' is not found in your current tab, run:"
echo -e "  ${CYAN}source ~/.zshrc${NC} (or restart terminal, or run: ${CYAN}~/.local/bin/tailchat --cloud${NC})"
echo
echo -e "Web version available at:"
echo -e "  ${CYAN}https://repentandliveholy.org/tailchat/${NC}"
echo

# 7. Interactive Launch
if [ -t 0 ] && [ -t 1 ]; then
  read -p "Launch Tailchat Cloud right now? [Y/n] " -n 1 -r || true
  echo
  if [[ ! ${REPLY:-} =~ ^[Nn]$ ]]; then
    node "$REPO_DIR/bin/tailchat.js" --cloud
  fi
fi
