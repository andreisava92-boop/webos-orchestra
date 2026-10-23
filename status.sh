#!/usr/bin/env bash
# webos-orchestra status.
#
# Shows the daemon state, the current sound output mode and the sound settings
# that affect the dual-output behaviour. Exits 0 when the daemon is running,
# 1 otherwise, so it can be used from scripts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOCAL_CONFIG="config.json"
TV_IP=""
SSH_USER=""

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./status.sh [--tv-ip IP] [--ssh-user USER]

Reads tvHost and sshUser from config.json when the flags are omitted.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tv-ip)
      [ $# -ge 2 ] || die "--tv-ip needs a value"
      TV_IP="$2"
      shift 2
      ;;
    --ssh-user)
      [ $# -ge 2 ] || die "--ssh-user needs a value"
      SSH_USER="$2"
      shift 2
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -f "$LOCAL_CONFIG" ]; then
  [ -n "$TV_IP" ] || TV_IP="$(python3 scripts/read_config.py "$LOCAL_CONFIG" tvHost "")"
  [ -n "$SSH_USER" ] || SSH_USER="$(python3 scripts/read_config.py "$LOCAL_CONFIG" sshUser "")"
fi

SSH_USER="${SSH_USER:-root}"

if [ -z "$TV_IP" ]; then
  if [ -t 0 ]; then
    read -r -p "TV IP address: " TV_IP
  else
    usage >&2
    die "the TV address is required (--tv-ip or config.json)"
  fi
fi

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new)

ssh_run() {
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$TV_IP" "$@"
}

# Run a Luna call through `script -qc` because luna-send needs a TTY.
luna() {
  local uri="$1"
  local payload="$2"
  local escaped="${payload//\"/\\\"}"
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$TV_IP" \
    "script -qc \"luna-send -a webosbrew -f -n 1 -w 3000 $uri '$escaped'\" /dev/null"
}

echo "Orchestra status"
echo "  TV:       $SSH_USER@$TV_IP"
echo "  daemon:   /var/lib/webosbrew/orchestra/orchestra.js"
echo

echo "--- process ---"
ssh_run 'cat /tmp/orchestra-tv.pid 2>/dev/null | sed "s/^/pid: /"; ps -ef | grep "[o]rchestra.js" || true'
echo

echo "--- last log lines ---"
ssh_run 'tail -10 /tmp/orchestra-tv.log 2>/dev/null'
echo

echo "--- sound output ---"
SOUND_JSON="$(luna 'luna://com.webos.service.audio/getSoundOutput' '{}' 2>/dev/null || true)"
printf '%s\n' "$SOUND_JSON"
printf '%s\n' "$SOUND_JSON" | python3 -c 'import json, sys; print("soundOutput: " + str(json.load(sys.stdin).get("soundOutput", "(unknown)")))' 2>/dev/null || true
echo

echo "--- sound settings ---"
SETTINGS_PAYLOAD='{"category":"sound","keys":["soundOutput","avSync","avSyncSpeaker","avSyncSpdif","lgSoundSync","soundModeSync","soundAlive"]}'
luna 'luna://com.webos.settingsservice/getSystemSettings' "$SETTINGS_PAYLOAD" 2>/dev/null || true
echo

RUNNING="$(ssh_run 'ps -ef | grep -c "[o]rchestra.js"' 2>/dev/null || true)"
if [ "${RUNNING:-0}" -gt 0 ]; then
  echo "Result: daemon is running."
  exit 0
fi

echo "Result: daemon is NOT running."
exit 1
