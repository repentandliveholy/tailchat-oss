#!/bin/sh
# Wraps the real launcher (../bin/tailchat) with termux-wake-lock: tailchat
# is a long-lived listener plus an open rendezvous connection, and Android
# 12+'s Doze mode / phantom-process killing suspends or kills exactly that
# kind of background process once the screen turns off — the session dies
# silently, with nothing in the transcript to explain why. termux-wake-lock
# is precisely the tool Termux ships to stop that; termux-wake-unlock
# releases it once tailchat itself exits, for any reason (normal quit,
# Ctrl-C, a crash).
#
# termux-wake-lock/-unlock ship in termux-tools, part of every Termux
# bootstrap including the Google Play build — unlike termux-api, no extra
# package or companion app is needed, so this works everywhere Termux does.
#
# Kept out of bin/tailchat, which stays the same dependency-free launcher on
# every other platform: this file only ever runs on Android (linked here by
# termux-wrapper/install.sh), so only it needs to know termux-wake-lock
# exists.
#
# Same shebang reasoning as bin/tailchat: #!/bin/sh, not
# #!/usr/bin/env bash — Android has no /usr, so outside an interactive
# Termux shell (another app's exec, a script, cron) there is nowhere for
# env to live and the launch would fail with rc=126.
#
# Deliberately not `exec`ing the real launcher: exec replaces this process
# image outright, so a trap set beforehand would never run once tailchat
# exits. Running it as a plain foreground child, then unlocking after it
# returns, is what makes the cleanup happen at all.

self=$0
while [ -L "$self" ]; do
  target=$(readlink "$self")
  case $target in
    /*) self=$target ;;
    *) self=$(dirname "$self")/$target ;;
  esac
done
root=$(dirname "$(dirname "$self")")

have_lock=0
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
  have_lock=1
fi

release() {
  [ "$have_lock" -eq 1 ] && termux-wake-unlock >/dev/null 2>&1
}
trap release EXIT

"$root/bin/tailchat" "$@"
exit $?
