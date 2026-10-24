#!/bin/sh
# Install the Orchestra app on a rooted LG TV over SSH.
#
# Usage: scripts/install-app.sh --tv-ip 192.168.1.19 [--user root] [--ipk path]
#
# The TV needs root SSH with key authentication and the Homebrew Channel for
# the daemon (see install.sh). This script only installs the web app.
set -eu

TV_IP=""
SSH_USER="root"
IPK=""

while [ $# -gt 0 ]; do
  case "$1" in
    --tv-ip) TV_IP="$2"; shift 2 ;;
    --user) SSH_USER="$2"; shift 2 ;;
    --ipk) IPK="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$TV_IP" ]; then
  echo "--tv-ip is required" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "$IPK" ]; then
  IPK="$(ls -t "$ROOT"/dist/com.andrei.orchestra_*.ipk 2>/dev/null | head -n 1 || true)"
fi
if [ -z "$IPK" ] || [ ! -f "$IPK" ]; then
  echo "no IPK found; run scripts/build-app.sh first" >&2
  exit 1
fi

REMOTE="/tmp/orchestra-app.ipk"
echo "Copying $(basename "$IPK") to $SSH_USER@$TV_IP:$REMOTE"
scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$IPK" "$SSH_USER@$TV_IP:$REMOTE"

echo "Installing on the TV (this takes a few seconds)..."
# -i keeps the subscription open; the install reports progress and a final
# "installed" or "install failed" state.
ssh -tt -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$SSH_USER@$TV_IP" \
  "luna-send -a com.webos.appInstallService -f -i -w 60000 \
   luna://com.webos.appInstallService/dev/install \
   '{\"id\":\"com.andrei.orchestra\",\"ipkUrl\":\"$REMOTE\",\"subscribe\":true}'" \
  | tr -d '\r' | tee /tmp/orchestra-install.log | grep -E '"state"|"reason"|"errorText"' | tail -n 6

if grep -q '"state": "installed"' /tmp/orchestra-install.log; then
  echo "Installed: com.andrei.orchestra"
else
  echo "Install did not report success; see /tmp/orchestra-install.log" >&2
  exit 1
fi
