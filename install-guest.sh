#!/usr/bin/env bash
# ==============================================================================
# Tailchat Universal Installer & Cloud Setup
# ==============================================================================
# Универсальный скрипт установки Tailchat для macOS, Linux и Android (Termux).
#
# Использование:
#   curl -fsSL https://raw.githubusercontent.com/repentandliveholy/tailchat-oss/main/install.sh | bash
#   или локально: ./install.sh
# ==============================================================================

set -euo pipefail

# Цвета для вывода
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

# 1. Определение платформы
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

log "Платформа: $PLATFORM"

# 2. Проверка и установка Git
if ! command -v git >/dev/null 2>&1; then
  log "Установка Git..."
  if [ "$IS_TERMUX" -eq 1 ]; then
    pkg update -y && pkg install -y git
  elif [ "$IS_MACOS" -eq 1 ]; then
    xcode-select --install 2>/dev/null || true
  elif [ "$IS_LINUX" -eq 1 ]; then
    if command -v apt-get >/dev/null 2>&1; then
      sudo apt-get update && sudo apt-get install -y git
    elif command -v dnf >/dev/null 2>&1; then
      sudo dnf install -y git
    elif command -v pacman >/dev/null 2>&1; then
      sudo pacman -Sy --noconfirm git
    elif command -v apk >/dev/null 2>&1; then
      sudo apk add git
    fi
  fi
fi

# 3. Проверка и установка Node.js (>= 22)
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 22 ]; then
    NODE_OK=1
    info "Node.js $(node -v) уже установлен"
  fi
fi

if [ "$NODE_OK" -eq 0 ]; then
  log "Установка Node.js (>= 22)..."
  if [ "$IS_TERMUX" -eq 1 ]; then
    pkg update -y && pkg install -y nodejs
  elif [ "$IS_MACOS" -eq 1 ]; then
    if command -v brew >/dev/null 2>&1; then
      brew install node
    else
      warn "Homebrew не найден. Установите Node.js с официального сайта: https://nodejs.org"
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

# 4. Определение рабочей директории
if [ -f "./bin/tailchat.js" ] && [ -f "./package.json" ]; then
  REPO_DIR="$(pwd)"
  info "Используется текущий репозиторий: $REPO_DIR"
else
  REPO_DIR="${HOME}/.tailchat-app"
  log "Клонирование/обновление Tailchat в $REPO_DIR..."
  if [ -d "$REPO_DIR/.git" ]; then
    cd "$REPO_DIR"
    git fetch --quiet origin
    git reset --hard --quiet origin/main || git pull --quiet
  else
    mkdir -p "$REPO_DIR"
    git clone --quiet https://github.com/repentandliveholy/tailchat-oss.git "$REPO_DIR"
    cd "$REPO_DIR"
  fi
fi

cd "$REPO_DIR"

# 5. Установка зависимостей
log "Установка зависимостей проекта..."
npm ci --omit=dev --silent

# 6. Настройка команды tailchat в системе
log "Настройка команды 'tailchat'..."
if [ "$IS_TERMUX" -eq 1 ]; then
  mkdir -p "$PREFIX/bin"
  if [ -f "$REPO_DIR/termux-wrapper/launcher.sh" ]; then
    ln -sf "$REPO_DIR/termux-wrapper/launcher.sh" "$PREFIX/bin/tailchat"
  else
    ln -sf "$REPO_DIR/bin/tailchat.js" "$PREFIX/bin/tailchat"
  fi
  chmod +x "$PREFIX/bin/tailchat"
else
  npm link --silent 2>/dev/null || true
  # Если npm link не добавил в PATH, настроим в ~/.local/bin
  if ! command -v tailchat >/dev/null 2>&1; then
    mkdir -p "${HOME}/.local/bin"
    ln -sf "$REPO_DIR/bin/tailchat.js" "${HOME}/.local/bin/tailchat"
    chmod +x "${HOME}/.local/bin/tailchat"
    if [[ ":$PATH:" != *":${HOME}/.local/bin:"* ]]; then
      export PATH="${HOME}/.local/bin:$PATH"
    fi
  fi
fi

echo
log "Установка успешно завершена! 🎉"
echo
echo -e "Для запуска облачного терминального чата введите:"
echo -e "  ${GREEN}${BOLD}tailchat --cloud${NC}"
echo
echo -e "Веб-версия доступна по адресу:"
echo -e "  ${CYAN}https://repentandliveholy.org/tailchat/${NC}"
echo

# 7. Автоматический запуск (если запущен интерактивно)
if [ -t 0 ] && [ -t 1 ]; then
  read -p "Запустить Tailchat Cloud прямо сейчас? [Y/n] " -n 1 -r || true
  echo
  if [[ ! ${REPLY:-} =~ ^[Nn]$ ]]; then
    node "$REPO_DIR/bin/tailchat.js" --cloud
  fi
fi

