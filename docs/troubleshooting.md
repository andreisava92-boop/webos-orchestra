# Troubleshooting

Start here:

```bash
./status.sh
ssh root@192.0.2.10 'tail -30 /tmp/orchestra-tv.log'
```

`status.sh` prints the PID, the running `orchestra.js` process, the last ten log lines,
the current `soundOutput` and the sound settings. It exits `0` when the daemon runs.
The settings service can still report `soundOutput=external_arc` while the hidden combined
mode is active; the Luna `soundOutput` line is the authoritative one.

## SSH fails

```
error: cannot open an SSH session to root@192.0.2.10.
```

- Start the SSH server: Homebrew Channel → SSH server → Start.
- The server listens on the port shown there (22 by default).
- Install your key:

  ```bash
  ssh-copy-id root@192.0.2.10
  ssh -o BatchMode=yes root@192.0.2.10 'echo ok'
  ```

  `BatchMode=yes` fails immediately when a password is required — that is exactly the
  check `install.sh` performs, so make this line work first.
- A changed host key (`REMOTE HOST IDENTIFICATION HAS CHANGED`) means the TV was
  reflashed or got a new address: `ssh-keygen -R 192.0.2.10`.

## Pairing PIN never works

- The PIN appears on the TV and is valid for a short time. Run `./install.sh` again; it
  reuses an existing key, so you only pair once.
- `lgtv add` failing with "already exists" is normal and is ignored.
- The pairing state lives in `~/.config/lgtvremote/devices.json`. `pair_tv.py` reads it
  but never modifies it.
- If pairing seems stuck, check the venv:

  ```bash
  .venv/bin/lgtv --tv 192.0.2.10 pair
  ```

- To pair from scratch: `./install.sh --skip-pair` will not help; delete `secrets/` and
  run `./install.sh` again.

## `ssap registered` is missing from the log

The WebSocket opened but the TV rejected the credentials.

- `ws handshake failed` right before it means the SSAP socket is not listening: check
  that the TV is on and not in a deep standby state.
- `ssap error: {...}` means the registration payload was rejected. The client key is
  wrong or belongs to another TV: delete `secrets/` and pair again.
- Confirm the files exist and are readable:

  ```bash
  ssh root@192.0.2.10 'ls -l /var/lib/webosbrew/orchestra'
  ```

  `client.key` and `registration.json` must be `600` and readable by root.

## `cast connected` is missing from the log

- Wrong address: check `castHost` in `/var/lib/webosbrew/orchestra/config.json`.
  `nmap -p 8009 --open 192.0.2.0/24` finds Cast devices on the LAN.
- The TV must reach the soundbar. Guest Wi-Fi, client isolation or separate VLANs break
  this even when your laptop can reach both.
- `cast error: ... ETIMEDOUT` is usually the network; `ECONNREFUSED` is the address (the
  port is closed). `ECONNRESET` right after connecting is often the soundbar being busy
  with another Cast client.
- The soundbar must be awake. Some bars drop Cast when idle; the daemon reconnects on the
  next volume change.

## The output falls back to `external_arc` again

```
output is external_arc -> re-applying tv_speaker_optical_arc
```

Seeing this occasionally is normal: the watchdog exists precisely because webOS resets
the mode. What matters is the next line, `re-applied: {...}`.

- If `re-applied` never appears, the TV refuses the mode. Check that the string exists:
  `grep -a tv_speaker_optical_arc /usr/sbin/audiod`.
- If the mode is re-applied every 30 seconds forever, something on the TV keeps resetting
  it (SIMPLINK/CEC from an attached device is the usual cause). Try disabling
  SIMPLINK in the TV settings.
- If `output check error: no json in luna output` appears, Luna is not answering:
  the `script -qc` wrapper is missing or `luna-send` is not in `PATH`.

## The volume is wrong

`TV 20% -> cast 52%` in the log is the mapping in action.

- Soundbar too loud: lower `gain` (try `2.0`, `1.6`). Too quiet: raise it (`3.0`, `3.5`).
- Editing `config.json` on the TV is not enough; restart the daemon:

  ```bash
  ssh root@192.0.2.10 'sh /var/lib/webosbrew/init.d/98-orchestra-daemon.sh'
  ```

- Check the mapping without a TV by running the tests:
  `node tests/run_tests.js`.
- If the soundbar jumps to 100 immediately, `gain` is too high for its curve.
- The reverse direction is not supported: changing the volume on the soundbar does not
  move the TV volume.

## No Wi-Fi, nothing happens

The Cast connection is outbound from the TV. With no network — or a network where the
soundbar is unreachable — the audio mode keeps working but the volume is not mirrored.
The log shows repeated `cast error` lines.

## The daemon is not running after a reboot

- The boot scripts must be in `/var/lib/webosbrew/init.d/` and executable (`755`).
- The Homebrew Channel must be set to run `init.d` at boot.
- `/tmp` is cleared on reboot; that is expected, `/tmp/orchestra-tv.pid` is recreated.
- Start it by hand and read the log:

  ```bash
  ssh root@192.0.2.10 'sh /var/lib/webosbrew/init.d/98-orchestra-daemon.sh; sleep 2; tail -20 /tmp/orchestra-tv.log'
  ```

## Config errors at startup

The daemon refuses to start with a clear message instead of guessing:

```
orchestra: config.castHost must be a non-empty string
orchestra: cannot load /var/lib/webosbrew/orchestra/client.key: ENOENT
```

Fix the file named in the message. `--once` prints the parsed config summary and exits,
which is the quickest way to validate a config:

```bash
/usr/bin/node /var/lib/webosbrew/orchestra/orchestra.js --once
```

## Uninstall

```bash
./uninstall.sh                       # stop, remove, restore tv_speaker
./uninstall.sh --restore-output none # leave the audio mode as it is
./uninstall.sh --keep-config         # keep /var/lib/webosbrew/orchestra/config.json
./uninstall.sh --purge               # also delete local secrets/ and config.json
```

If SSH is gone but the daemon still runs, disable it on the TV directly:

```sh
rm -f /var/lib/webosbrew/init.d/98-orchestra-daemon.sh /var/lib/webosbrew/init.d/99-orchestra.sh
kill "$(cat /tmp/orchestra-tv.pid)"
script -qc "luna-send -a webosbrew -f -n 1 -w 3000 luna://com.webos.service.audio/setSoundOutput '{\"soundOutput\":\"tv_speaker\"}'" /dev/null
```
