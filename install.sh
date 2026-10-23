#!/usr/bin/env bash
# webos-orchestra installer.
#
# Copies the TV daemon and its boot scripts to a rooted LG webOS TV over SSH/SCP.
# Uses key-based SSH only: no password prompts, no sshpass, no sudo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BASE="/var/lib/webosbrew/orchestra"
INITD="/var/lib/webosbrew/init.d"
LOCAL_CONFIG="config.json"
SECRETS_DIR="secrets"

TV_IP=""
CAST_IP=""
GAIN=""
SSH_USER=""
CAST_PORT=""
DESIRED_OUTPUT=""
WATCHDOG=""
SKIP_PAIR=0
DRY_RUN=0

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Options:
  --tv-ip IP          TV address (required unless saved in config.json)
  --cast-ip IP        soundbar / Google Cast receiver address (required)
  --gain FLOAT        TV volume multiplier sent to the soundbar (default 2.6)
  --ssh-user USER     SSH user on the TV (default root)
  --skip-pair         use the existing secrets/client.key and secrets/registration.json
  --dry-run           print the ssh/scp commands and exit without touching the TV
  --help              show this help
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

is_positive_number() {
  [[ "$1" =~ ^[0-9]+([.][0-9]+)?$ ]] || return 1
  awk -v value="$1" 'BEGIN { exit !(value > 0) }'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tv-ip)
      [ $# -ge 2 ] || die "--tv-ip needs a value"
      TV_IP="$2"
      shift 2
      ;;
    --cast-ip)
      [ $# -ge 2 ] || die "--cast-ip needs a value"
      CAST_IP="$2"
      shift 2
      ;;
    --gain)
      [ $# -ge 2 ] || die "--gain needs a value"
      GAIN="$2"
      shift 2
      ;;
    --ssh-user)
      [ $# -ge 2 ] || die "--ssh-user needs a value"
      SSH_USER="$2"
      shift 2
      ;;
    --skip-pair)
      SKIP_PAIR=1
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

command -v python3 >/dev/null 2>&1 || die "python3 is required but was not found in PATH"
command -v ssh >/dev/null 2>&1 || die "ssh is required but was not found in PATH"
command -v scp >/dev/null 2>&1 || die "scp is required but was not found in PATH"

# Saved values are defaults; command line flags win.
if [ -f "$LOCAL_CONFIG" ]; then
  [ -n "$TV_IP" ] || TV_IP="$(python3 scripts/read_config.py "$LOCAL_CONFIG" tvHost "")"
  [ -n "$CAST_IP" ] || CAST_IP="$(python3 scripts/read_config.py "$LOCAL_CONFIG" castHost "")"
  [ -n "$SSH_USER" ] || SSH_USER="$(python3 scripts/read_config.py "$LOCAL_CONFIG" sshUser "")"
  [ -n "$GAIN" ] || GAIN="$(python3 scripts/read_config.py "$LOCAL_CONFIG" gain "")"
  CAST_PORT="$(python3 scripts/read_config.py "$LOCAL_CONFIG" castPort "")"
  DESIRED_OUTPUT="$(python3 scripts/read_config.py "$LOCAL_CONFIG" desiredOutput "")"
  WATCHDOG="$(python3 scripts/read_config.py "$LOCAL_CONFIG" watchdogSeconds "")"
fi

SSH_USER="${SSH_USER:-root}"
[[ "$SSH_USER" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid SSH user: '$SSH_USER'"
GAIN="${GAIN:-2.6}"
CAST_PORT="${CAST_PORT:-8009}"
DESIRED_OUTPUT="${DESIRED_OUTPUT:-tv_speaker_optical_arc}"
WATCHDOG="${WATCHDOG:-15}"

if [ -z "$TV_IP" ]; then
  if [ -t 0 ]; then
    read -r -p "TV IP address: " TV_IP
  else
    usage >&2
    die "the TV address is required (--tv-ip)"
  fi
fi

if [ -z "$CAST_IP" ]; then
  if [ -t 0 ]; then
    read -r -p "Soundbar (Google Cast) IP address: " CAST_IP
  else
    usage >&2
    die "the soundbar address is required (--cast-ip)"
  fi
fi

is_ipv4 "$TV_IP" || die "invalid TV address: '$TV_IP'"
is_ipv4 "$CAST_IP" || die "invalid soundbar address: '$CAST_IP'"
is_positive_number "$GAIN" || die "invalid gain: '$GAIN' (expected a number greater than 0)"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new)
SCP_OPTS=(-o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new)

ssh_run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "+ ssh ${SSH_USER}@${TV_IP} $*"
    return 0
  fi
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$TV_IP" "$@"
}

scp_run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "+ scp $*"
    return 0
  fi
  scp "${SCP_OPTS[@]}" "$@"
}

echo "Installing Orchestra on $SSH_USER@$TV_IP (soundbar $CAST_IP, gain $GAIN)."

if [ "$DRY_RUN" -eq 0 ]; then
  # ---- 1. SSH reachability -------------------------------------------------
  if ! ssh_run 'echo ok' >/dev/null 2>&1; then
    cat >&2 <<EOF
error: cannot open an SSH session to $SSH_USER@$TV_IP.

 1. Enable SSH on the TV: Homebrew Channel -> SSH server -> start.
 2. Add your public key to /home/root/.ssh/authorized_keys on the TV:
      ssh-copy-id $SSH_USER@$TV_IP
 3. Run ./install.sh again.
EOF
    exit 1
  fi

  # ---- 2. TV prerequisites ------------------------------------------------
  TV_CHECK_SCRIPT='
command -v /usr/bin/node >/dev/null 2>&1 || { echo "MISSING node: /usr/bin/node not found on the TV"; exit 10; }
/usr/bin/node --version >/dev/null 2>&1 || { echo "MISSING node: /usr/bin/node does not execute"; exit 11; }
FOUND=0
if command -v strings >/dev/null 2>&1; then
  strings /usr/sbin/audiod 2>/dev/null | grep -q tv_speaker_optical_arc && FOUND=1 || FOUND=0
fi
if [ "$FOUND" = "0" ]; then
  grep -a tv_speaker_optical_arc /usr/sbin/audiod >/dev/null 2>&1 || { echo "MISSING audiod: /usr/sbin/audiod does not contain tv_speaker_optical_arc (unsupported firmware)"; exit 12; }
fi
[ -d /var/lib/webosbrew/init.d ] || { echo "MISSING init.d: /var/lib/webosbrew/init.d not found (TV not rooted via Homebrew Channel?)"; exit 13; }
echo ok
'

  if ! CHECK_OUTPUT="$(ssh_run "$TV_CHECK_SCRIPT" 2>&1)"; then
    printf '%s\n' "$CHECK_OUTPUT" >&2
    echo "error: the TV does not meet the prerequisites listed above." >&2
    exit 1
  fi
fi

# ---- 3. Pairing -----------------------------------------------------------
have_secrets() {
  [ -s "$SECRETS_DIR/client.key" ] && [ -s "$SECRETS_DIR/registration.json" ]
}

if [ "$SKIP_PAIR" -eq 1 ]; then
  if ! have_secrets; then
    cat >&2 <<EOF
error: --skip-pair was given but the pairing files are missing or empty:
  $SECRETS_DIR/client.key
  $SECRETS_DIR/registration.json
Copy them from a previous install, or run ./install.sh without --skip-pair.
EOF
    exit 1
  fi
  echo "Using the existing pairing in $SECRETS_DIR/ (--skip-pair)."
elif have_secrets; then
  echo "Reusing the existing pairing in $SECRETS_DIR/."
elif [ "$DRY_RUN" -eq 1 ]; then
  echo "+ python3 scripts/pair_tv.py --tv-ip $TV_IP --out-dir $SECRETS_DIR   (skipped: dry run)"
else
  python3 scripts/pair_tv.py --tv-ip "$TV_IP" --out-dir "$SECRETS_DIR"
fi

# ---- 4. TV-side config ----------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  echo "+ python3 scripts/write_tv_config.py $SECRETS_DIR/tv-config.json $CAST_IP $CAST_PORT $GAIN $DESIRED_OUTPUT $WATCHDOG   (skipped: dry run)"
else
  mkdir -p "$SECRETS_DIR"
  chmod 700 "$SECRETS_DIR"
  chmod 600 "$SECRETS_DIR/client.key" "$SECRETS_DIR/registration.json" 2>/dev/null || true
  python3 scripts/write_tv_config.py "$SECRETS_DIR/tv-config.json" \
    "$CAST_IP" "$CAST_PORT" "$GAIN" "$DESIRED_OUTPUT" "$WATCHDOG"
fi

# ---- 5. Remote install ----------------------------------------------------
remote_install() {
  ssh_run "mkdir -p $BASE"
  scp_run tv/orchestra.js "$SECRETS_DIR/tv-config.json" "$SECRETS_DIR/client.key" \
    "$SECRETS_DIR/registration.json" "$SSH_USER@$TV_IP:$BASE/"
  scp_run tv/init.d/98-orchestra-daemon tv/init.d/99-orchestra \
    "$SSH_USER@$TV_IP:$INITD/"
  ssh_run "rm -f $INITD/98-orchestra-daemon.sh $INITD/99-orchestra.sh && chmod 755 $INITD/98-orchestra-daemon $INITD/99-orchestra && chmod 600 $BASE/client.key $BASE/registration.json && chmod 644 $BASE/orchestra.js $BASE/tv-config.json && mv -f $BASE/tv-config.json $BASE/config.json && chmod 644 $BASE/config.json && ls -l $BASE"
}

remote_start() {
  ssh_run "sh $INITD/98-orchestra-daemon"
  ssh_run "sh $INITD/99-orchestra"
}

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run: nothing was sent to the TV. Commands that would run:"
  remote_install
  remote_start
  exit 0
fi

remote_install
remote_start

# ---- 6. Verify ------------------------------------------------------------
sleep 3
LOG_OUT="$(ssh_run 'cat /tmp/orchestra-tv.pid 2>/dev/null; echo "--- log ---"; tail -20 /tmp/orchestra-tv.log 2>/dev/null' 2>&1 || true)"
printf '%s\n' "$LOG_OUT"

if printf '%s\n' "$LOG_OUT" | grep -q 'ssap registered' \
  && { printf '%s\n' "$LOG_OUT" | grep -q 'cast connected' || printf '%s\n' "$LOG_OUT" | grep -q 'DRY_RUN'; }; then
  echo "Daemon started and registered with the TV."
else
  echo "warning: the expected log lines were not found (ssap registered + cast connected)." >&2
  printf '%s\n' "$LOG_OUT" >&2
  exit 2
fi

# ---- 7. Remember the installer settings -----------------------------------
python3 - "$TV_IP" "$SSH_USER" "$CAST_IP" "$CAST_PORT" "$GAIN" "$DESIRED_OUTPUT" "$WATCHDOG" "$LOCAL_CONFIG" <<'PY'
import json
import sys


def number(raw):
    value = float(raw)
    return int(value) if value == int(value) else value


tv_host, ssh_user, cast_host, cast_port, gain, desired_output, watchdog, out = sys.argv[1:9]
data = {
    "tvHost": tv_host,
    "sshUser": ssh_user,
    "castHost": cast_host,
    "castPort": number(cast_port),
    "gain": number(gain),
    "desiredOutput": desired_output,
    "watchdogSeconds": number(watchdog),
}
with open(out, "w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2)
    handle.write("\n")
PY
chmod 600 "$LOCAL_CONFIG"

# ---- 8. Next steps --------------------------------------------------------
cat <<EOF

Done. The daemon mirrors the TV volume to $CAST_IP and keeps the
"$DESIRED_OUTPUT" output mode applied.

Next steps:
  ./status.sh      show daemon state, audio mode and sound settings
  ./uninstall.sh   remove the daemon from the TV and restore the audio mode
  README.md        configuration, troubleshooting and limitations
EOF
