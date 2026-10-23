# Spec v0.1 — webos-orchestra (private MVP)

## Context

Build a standalone, installable open-source project in `~/webos-orchestra` that reproduces the working "Orchestra" setup from `~/lg-tv-root`:

- rooted LG webOS TV (tested: OLED55A13LA, webOS 6.5.3-47, firmware 03.53.45)
- TV speakers + HDMI eARC soundbar play simultaneously via the hidden output mode `tv_speaker_optical_arc`
- TV volume is mirrored to the soundbar over Google Cast (`SET_VOLUME`, port 8009)
- a TV-side Node daemon does the mirroring and re-applies the audio mode if it falls back to `external_arc`
- installation must be possible for a non-AI user: clone repo, run `install.sh`, answer prompts, accept pairing PIN on TV

This is a PRIVATE repo for now. Do not publish it.

## Hard constraints

- Do NOT modify anything under `~/lg-tv-root` (read-only reference).
- Do NOT touch the live TV, do not SSH to it, do not run pairing or install anything on it during this task. Local tests only.
- Do NOT `git add`, `git commit`, `git push`, or create GitHub repos. The architect commits after review.
- No secrets in the repo: no `client.key`, no `registration.json`, no real IPs, no real MACs, no personal paths.
- TV-side code must run on **Node 8** (webOS). Use `var`, functions, callbacks; no npm dependencies on the TV.
- Installer-side code may use Python 3.8+ stdlib. Extra Python packages are allowed only inside a local venv created by the installer.
- All user-facing docs and code comments in **English**.
- License: MIT.

## Repo tree (create exactly this)

```
webos-orchestra/
├── README.md
├── LICENSE
├── SECURITY.md
├── .gitignore
├── .github/workflows/test.yml
├── config.example.json
├── install.sh
├── uninstall.sh
├── status.sh
├── package.json
├── tv/
│   ├── orchestra.js
│   └── init.d/
│       ├── 98-orchestra-daemon
│       └── 99-orchestra
├── scripts/
│   ├── pair_tv.py
│   ├── read_config.py
│   └── write_tv_config.py
├── tests/
│   └── run_tests.js
└── docs/
    ├── how-it-works.md
    ├── compatibility.md
    └── troubleshooting.md
```

## File contracts

### `tv/orchestra.js`

Start from `~/lg-tv-root/orchestra-tv-ws.js` (read it first). Copy the working logic (SSAP WebSocket on `127.0.0.1:3000`, Cast TLS on port 8009, protobuf helpers, watchdog) and refactor:

- `BASE = '/var/lib/webosbrew/orchestra'`.
- Read `BASE + '/config.json'`. Required shape:

```json
{
  "castHost": "192.0.2.60",
  "castPort": 8009,
  "gain": 2.6,
  "desiredOutput": "tv_speaker_optical_arc",
  "watchdogSeconds": 15
}
```

- If the config is missing or invalid, print a clear error and `process.exit(1)`. Do not silently fall back to a hardcoded IP.
- Remove every hardcoded IP, gain, and path except `BASE`, `127.0.0.1`, and port `3000`.
- Read `BASE + '/registration.json'` and `BASE + '/client.key'`.
- Export testable helpers and start the daemon only when run directly:

```js
if (require.main === module) { start(); }
module.exports = {
  varint, fieldVarint, fieldString, castMessage, frameCast,
  encodeFrame, loadConfig, computeTarget, applyGain
};
```

- `computeTarget(volume, muted, gain)`:
  - returns `0` when `muted` is true;
  - otherwise `Math.min(100, Math.round(volume * gain))`;
  - invalid volume -> `0`.
- `applyGain(volume, gain)` is the non-muted form used by `computeTarget`.
- `loadConfig(path)` parses JSON and validates: `castHost` non-empty string, `castPort` integer 1-65535, `gain` number > 0, `desiredOutput` non-empty string, `watchdogSeconds` number >= 5. Throw `Error` with a useful message otherwise.
- `ORCHESTRA_DRY_RUN=1`: never open a Cast socket; log `DRY_RUN cast level=<0-1>` instead.
- `--once`: load config, print a one-line JSON summary (`{"ok":true,"castHost":...,"gain":...,"desiredOutput":...}`), exit 0. Useful for the installer.
- Log lines must include an ISO timestamp and these exact markers (the installer greps them):
  - `ws connected`
  - `ssap registered`
  - `cast connected`
  - `TV <n>% -> cast <n>%`
  - `output is <mode> -> re-applying <mode>`
  - `re-applied: <json>`
- Keep the working Luna quoting fix: run `luna-send` through `script -qc "..."` with single quotes around the escaped JSON. Do not regress to plain `luna-send` (no TTY = silently no write).
- Add `process.on('uncaughtException', ...)` that logs and exits 1.
- Do not add a supervisor loop; the init script starts it once.

### `config.example.json`

Documentation-only example, no real addresses. Use TEST-NET addresses (`192.0.2.x`). Include all keys from the config shape plus installer-side keys:

```json
{
  "tvHost": "192.0.2.10",
  "sshUser": "root",
  "castHost": "192.0.2.60",
  "castPort": 8009,
  "gain": 2.6,
  "desiredOutput": "tv_speaker_optical_arc",
  "watchdogSeconds": 15
}
```

`tvHost`/`sshUser` are used only by `install.sh`, `uninstall.sh`, `status.sh`; they are not copied to the TV config.

### `scripts/read_config.py`

- Usage: `python3 scripts/read_config.py <config.json> <key> [default]`.
- Print the value (no quotes) or the default; exit 1 if key missing and no default.
- Stdlib only.

### `scripts/write_tv_config.py`

- Usage: `python3 scripts/write_tv_config.py <output.json> <castHost> <castPort> <gain> <desiredOutput> <watchdogSeconds>`.
- Validate types, write pretty JSON, exit non-zero on bad input.
- Stdlib only.

### `scripts/pair_tv.py`

- Usage: `python3 scripts/pair_tv.py --tv-ip <ip> --out-dir <dir> [--tv-name <name>]`.
- Create `./.venv` in the repo if missing (`python3 -m venv .venv`), install `lgtvremote-cli==1.6.4` into it.
- Add the TV if needed: `.venv/bin/lgtv add <ip> --name <name> --no-enrich` (ignore "already exists").
- Pair non-destructively: `.venv/bin/lgtv --tv <ip> pair`, inheriting stdin/stdout so the user can type the PIN shown on the TV.
- Read `~/.config/lgtvremote/devices.json`; find `devices[<ip>]["client_key"]`. If missing, print clear instructions and exit 1. Never fall back to another TV's key.
- Extract `REGISTRATION_PAYLOAD` from the installed package:
  `.venv/bin/python -c "import json,lgtvremote_cli as l; print(json.dumps(l.REGISTRATION_PAYLOAD))"`.
- Write `<out-dir>/client.key` and `<out-dir>/registration.json`, both mode `0600`; directory mode `0700`.
- Never print the key value. Print only the output paths.
- If `client.key` and `registration.json` already exist in `<out-dir>` and are non-empty, reuse them unless `--force` is passed.
- Do not modify `~/.config/lgtvremote/devices.json`.

### `tv/init.d/98-orchestra-daemon`

- POSIX sh, `PATH=/usr/bin:/bin:/usr/sbin:/sbin`.
- `BASE=/var/lib/webosbrew/orchestra`, `PIDFILE=/tmp/orchestra-tv.pid`, `LOG=/tmp/orchestra-tv.log`.
- If PIDFILE exists, kill that PID, wait 1 s.
- Start `/usr/bin/nohup /usr/bin/node "$BASE/orchestra.js" >> "$LOG" 2>&1 &`, write `$!` to PIDFILE.
- Do not start if `orchestra.js` or `config.json` is missing; print an error to the log and exit 1.
- chmod 755.

### `tv/init.d/99-orchestra`

- POSIX sh, set PATH.
- Wait for Luna audio readiness by polling `script -qc "luna-send -a webosbrew -n 1 -f luna://com.webos.service.audio/getSoundOutput '{}'" /dev/null` up to 15 times, 2 s apart.
- Sleep 5 s.
- Set `tv_speaker_optical_arc` through `script -qc` with the single-quoted escaped JSON (same form as the working file).
- chmod 755.
- Add a comment explaining that `luna-send` needs a TTY.

### `install.sh`

Bash (`#!/usr/bin/env bash`), `set -euo pipefail`. Flags:

```
--tv-ip IP
--cast-ip IP
--gain FLOAT
--ssh-user USER        (default: root)
--skip-pair            use existing secrets/client.key + secrets/registration.json
--dry-run
--help
```

Behavior:

1. Resolve repo root from `$0`; `cd` there.
2. Load defaults from `config.json` if it exists (via `read_config.py`), then CLI flags override.
3. If `tvHost` or `castHost` missing and stdin is a TTY, prompt; otherwise print usage and exit 1.
4. Validate IPv4 shape (four dot-separated numbers 0-255). Reject empty/invalid.
5. `ssh` check: `ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "$SSH_USER@$TV_IP" 'echo ok'`. On failure, print: enable SSH in Homebrew Channel, add your public key to `/home/root/.ssh/authorized_keys`, then retry. Exit 1.
6. TV checks over SSH:
   - `command -v /usr/bin/node` and `/usr/bin/node --version`;
   - `/usr/sbin/audiod` contains `tv_speaker_optical_arc` (`strings ... | grep -q`, fallback `grep -a`);
   - `/var/lib/webosbrew/init.d` exists.
   On any failure, print the exact missing prerequisite and exit 1.
7. Pairing:
   - If `--skip-pair`, require `secrets/client.key` and `secrets/registration.json`; abort with instructions if absent.
   - Else, if both exist, reuse them (print "reusing existing pairing").
   - Else run `python3 scripts/pair_tv.py --tv-ip "$TV_IP" --out-dir secrets`.
8. Generate `secrets/tv-config.json` with `write_tv_config.py`.
9. `--dry-run`: print every `ssh`/`scp` command that would run and exit 0 without touching the TV.
10. Remote install:
    - `ssh ... 'mkdir -p /var/lib/webosbrew/orchestra'`
    - `scp tv/orchestra.js`, `secrets/tv-config.json`, `secrets/client.key`, `secrets/registration.json` into `BASE`.
    - `scp tv/init.d/98-orchestra-daemon tv/init.d/99-orchestra` into `/var/lib/webosbrew/init.d/`.
    - remote `chmod 755` on init scripts, `chmod 600` on key/registration, `chmod 644` on code/config; move `tv-config.json` to `config.json`.
11. Start: `ssh ... 'sh /var/lib/webosbrew/init.d/98-orchestra-daemon'`.
12. Wait 3 s, then `ssh ... 'cat /tmp/orchestra-tv.pid; tail -20 /tmp/orchestra-tv.log'`; print it.
13. Verify the log contains `ssap registered` and (`cast connected` or `DRY_RUN`). If not, print a warning and the log tail; exit 2.
14. Save the installer-side `config.json` with `tvHost`, `sshUser`, `castHost`, `castPort`, `gain`, `desiredOutput`, `watchdogSeconds` (gitignored) for reruns.
15. Print next steps: `./status.sh`, `./uninstall.sh`, and the README path.

Use only `ssh`/`scp`; no password prompts, no `sshpass`, no `sudo`.

### `uninstall.sh`

Bash, `set -euo pipefail`. Flags:

```
--tv-ip IP
--ssh-user USER        (default: root)
--restore-output MODE  (default: tv_speaker; allowed: tv_speaker, external_arc, external_optical, none)
--keep-config          keep BASE/config.json, remove the rest
--purge                also delete local secrets/ and config.json
--dry-run
```

Behavior:

- Resolve TV IP from flag or local `config.json`.
- SSH check as in install.
- Stop daemon: read `/tmp/orchestra-tv.pid` and kill; then `ps | grep` fallback to kill leftover `orchestra.js`.
- Remove `/var/lib/webosbrew/init.d/98-orchestra-daemon` and `99-orchestra`.
- Restore output through `script -qc` if `MODE != none`; verify with `getSoundOutput` and print the result.
- Remove `/var/lib/webosbrew/orchestra` (or keep only `config.json` with `--keep-config`).
- With `--purge`, remove local `secrets/` and `config.json`.
- Print a summary of what was removed/kept.

### `status.sh`

Bash, `set -euo pipefail`. Flags `--tv-ip IP --ssh-user USER`.

- Resolve TV IP from flag or local `config.json`.
- Print a header.
- SSH: pidfile contents, `ps | grep orchestra.js`, `tail -10 /tmp/orchestra-tv.log`.
- SSH: `getSoundOutput` through `script -qc`, print `soundOutput`.
- SSH: `getSystemSettings` for `category:"sound"` keys `["soundOutput","avSync","avSyncSpeaker","avSyncSpdif","lgSoundSync","soundModeSync","soundAlive"]`; print raw JSON (it is small).
- Exit 0 if the daemon process is present, 1 otherwise (so it can be used in scripts).

### `tests/run_tests.js`

Plain Node (no test framework), `assert`, prints `OK <n> tests`, exit non-zero on failure.

Required tests:

- `varint(0)`, `varint(127)`, `varint(128)`, `varint(300)` produce the known byte arrays.
- `fieldString(6, "x")` starts with `0x32, 0x01, 0x78`.
- `castMessage(...)` contains fields 1,2,3,4,5,6 in order and a valid UTF-8 payload.
- `encodeFrame(1, Buffer.from("hi"))`: first byte `0x81`, second `0x82`, four mask bytes, masked payload unmasks to `hi`.
- `computeTarget(10,false,2.6) === 26`, `computeTarget(10,true,2.6) === 0`, `computeTarget(50,false,2.6) === 100`, `computeTarget(NaN,false,2.6) === 0`.
- `loadConfig` with a temp file returns normalized values; missing file throws; invalid `gain` throws.
- `applyGain(15,2.6) === 39`.

### `package.json`

```json
{
  "name": "webos-orchestra",
  "version": "0.1.0",
  "private": true,
  "description": "Dual audio and volume sync for rooted LG webOS TVs",
  "scripts": { "test": "node tests/run_tests.js" },
  "license": "MIT"
}
```

No dependencies.

### `.github/workflows/test.yml`

On `push` and `pull_request`: Ubuntu latest, Node 18 and 20, run `node --check tv/orchestra.js`, `npm test`, `bash -n install.sh uninstall.sh status.sh`.

### `.gitignore`

```
secrets/
config.json
.venv/
__pycache__/
*.pyc
*.log
.DS_Store
```

### Docs

- `README.md`: what it does; requirements (rooted TV via SlopBro/Homebrew Channel, SSH key auth, Node on TV, soundbar with Google Cast); quick start (`git clone`, `./install.sh`, PIN); manual install; configuration (`castHost`, `gain`); how to find the soundbar IP; status/uninstall; limitations (no WiFi -> no volume sync; echo; firmware updates; root risk); disclaimer (unofficial, no LG affiliation, warranty void); MIT.
- `SECURITY.md`: no secrets in repo; per-TV client key; daemon runs as root; listens on localhost only; Cast is outbound LAN only; report issues privately.
- `docs/how-it-works.md`: SSAP WebSocket, `tv_speaker_optical_arc`, Cast `SET_VOLUME`, gain, watchdog, boot scripts, why `luna-send` needs a TTY.
- `docs/compatibility.md`: tested model/firmware; requirements; how to check `tv_speaker_optical_arc`; known unsupported: no root, no Cast, no hidden mode.
- `docs/troubleshooting.md`: SSH fails; pairing PIN; `ssap registered` missing; `cast connected` missing; output falls back; volume wrong -> gain; no WiFi; uninstall.

## Acceptance criteria

Run and paste real output:

```bash
cd ~/webos-orchestra
node --check tv/orchestra.js
node tests/run_tests.js
bash -n install.sh uninstall.sh status.sh
python3 -m py_compile scripts/pair_tv.py scripts/read_config.py scripts/write_tv_config.py
grep -RIn "192\.168\.1\." . || true
find . -name 'config.json' -o -name 'client.key' -o -name 'registration.json'
```

Expected:

- `node tests/run_tests.js` -> `OK <n> tests`.
- `bash -n` -> no output, exit 0.
- `py_compile` -> exit 0.
- `grep` for real LAN addresses -> no output.
- `find` -> no output (no secrets, no real config).

## What NOT to do

- Do not copy `client.key`, `registration.json`, `config.json`, logs, or the real IPs into the repo.
- Do not implement rooting, SlopBro, service menus, I2C, or service-menu changes.
- Do not add a web UI, GUI, daemon supervisor, database, or npm dependencies to the TV code.
- Do not change the existing `~/lg-tv-root` files.
- Do not commit or push.

## Report format

Reply with:

1. `git status --porcelain` (should show only new files).
2. Full tree (`find . -maxdepth 3 -type f | sort`).
3. The exact output of every acceptance command.
4. Any deviation from this spec and why.
5. What you could NOT verify locally.
