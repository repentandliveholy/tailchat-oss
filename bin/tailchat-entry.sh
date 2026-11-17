#!/usr/bin/env sh
set -eu

export LANG=C.UTF-8
export LC_ALL=C.UTF-8

exec /usr/bin/node /opt/tailchat/bin/gateway-ssh.js
