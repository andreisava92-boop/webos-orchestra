#!/usr/bin/env bash
# webos-orchestra uninstaller.
#
# Stops the TV daemon, removes the installer files and optionally restores the
# original sound output mode. Uses key-based SSH only: no sudo, no sshpass.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BASE="/var/lib/webosbrew/orchestra"
INITD="/var/lib/webosbrew/init.d"
LOCAL_CONFIG="config.json"
SECRETS_DIR="secrets"

TV_IP=""
SSH_USER=""
RESTORE_MODE="tv_speaker"
KEEP_CONFIG=0
PURGE=0
DRY_RUN=0

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./uninstall.sh [options]

Options:
  --tv-ip IP              TV address (default: tvHost from config.json)
  --ssh-user USER         SSH user on the TV (default root)
  --restore-output MODE   sound output to restore: tv_speaker, external_arc,
                          external_optical or none (default tv_speaker)
  --keep-config           keep BASE/config.json and remove the rest
  --purge                 also delete local secrets/ and config.json
  --dry-run               print the commands and exit without touching the TV
  --help                  show this help
EOF
}

is_ipv4() {
  local ip="$1"
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  local octet
  local IFS='.'
  for octet in $ip; do
    [ "$((10#$octet))" -le 255 ] || return 1
  done
  return 0
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
    --restore-output)
      [ $# -ge 2 ] || die "--restore-output needs a value"
      RESTORE_MODE="$2"
      shift 2
      ;;
    --keep-config)
      KEEP_CONFIG=1
      shift
      ;;
    --purge)
      PURGE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
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

case "$RESTORE_MODE" in
  tv_speaker | external_arc | external_optical | none) ;;
  *)
    die "invalid --restore-output value: '$RESTORE_MODE' (allowed: tv_speaker, external_arc, external_optical, none)"
    ;;
esac

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

is_ipv4 "$TV_IP" || die "invalid TV address: '$TV_IP'"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new)

ssh_run() {
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$TV_IP" "$@"
}

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run: nothing was sent to the TV. Commands that would run:"
  echo "+ ssh ${SSH_USER}@${TV_IP} 'echo ok'"
  echo "+ ssh ${SSH_USER}@${TV_IP} 'kill \$(cat /tmp/orchestra-tv.pid); pkill -f orchestra.js'"
  echo "+ ssh ${SSH_USER}@${TV_IP} 'rm -f $INITD/98-orchestra-daemon $INITD/99-orchestra $INITD/98-orchestra-daemon.sh $INITD/99-orchestra.sh'"
  if [ "$RESTORE_MODE" != "none" ]; then
    echo "+ ssh ${SSH_USER}@${TV_IP} 'setSoundOutput $RESTORE_MODE; getSoundOutput'"
  fi
  if [ "$KEEP_CONFIG" -eq 1 ]; then
    echo "+ ssh ${SSH_USER}@${TV_IP} 'rm -rf $BASE/*; keep $BASE/config.json'"
  else
    echo "+ ssh ${SSH_USER}@${TV_IP} 'rm -rf $BASE'"
  fi
  if [ "$PURGE" -eq 1 ]; then
    echo "+ rm -rf $SECRETS_DIR $LOCAL_CONFIG"
  fi
  exit 0
fi

if ! ssh_run 'echo ok' >/dev/null 2>&1; then
  die "cannot open an SSH session to $SSH_USER@$TV_IP (is SSH enabled and your key authorized?)"
fi

# ---- 1. Stop the daemon ---------------------------------------------------
ssh_run '
if [ -f /tmp/orchestra-tv.pid ]; then
  PID="$(cat /tmp/orchestra-tv.pid 2>/dev/null)"
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null
  fi
  sleep 1
  rm -f /tmp/orchestra-tv.pid
fi
for P in $(ps -ef | grep "[o]rchestra.js" | awk "{print \$2}"); do
  kill "$P" 2>/dev/null
done
echo "daemon stopped"
'
echo "Daemon stopped."

# ---- 2. Remove the boot scripts -------------------------------------------
ssh_run "rm -f $INITD/98-orchestra-daemon $INITD/99-orchestra $INITD/98-orchestra-daemon.sh $INITD/99-orchestra.sh"
echo "Removed the init scripts from $INITD."

# ---- 3. Restore the sound output ------------------------------------------
if [ "$RESTORE_MODE" != "none" ]; then
  ssh_run "script -qc \"luna-send -a webosbrew -f -n 1 -w 3000 luna://com.webos.service.audio/setSoundOutput '{\\\"soundOutput\\\":\\\"$RESTORE_MODE\\\"}'\" /dev/null" >/dev/null 2>&1 || true
  echo "Requested sound output: $RESTORE_MODE"
  OUTPUT_JSON="$(ssh_run "script -qc \"luna-send -a webosbrew -n 1 -f luna://com.webos.service.audio/getSoundOutput '{}'\" /dev/null" 2>/dev/null || true)"
  printf '%s\n' "$OUTPUT_JSON"
else
  echo "Sound output left unchanged (--restore-output none)."
fi

# ---- 4. Remove the daemon directory ---------------------------------------
if [ "$KEEP_CONFIG" -eq 1 ]; then
  ssh_run "for F in $BASE/*; do [ -e \"\$F\" ] || continue; case \"\$F\" in $BASE/config.json) continue ;; esac; rm -rf \"\$F\"; done"
  echo "Removed $BASE except config.json."
else
  ssh_run "rm -rf $BASE"
  echo "Removed $BASE."
fi

# ---- 5. Optional local cleanup --------------------------------------------
if [ "$PURGE" -eq 1 ]; then
  rm -rf "$SECRETS_DIR" "$LOCAL_CONFIG"
  echo "Removed local $SECRETS_DIR/ and $LOCAL_CONFIG."
fi

cat <<EOF

Uninstall finished.
  daemon:        stopped
  init scripts:  removed
  sound output:  $RESTORE_MODE
  TV directory:  $([ "$KEEP_CONFIG" -eq 1 ] && echo "kept (config.json only)" || echo "removed")
EOF
