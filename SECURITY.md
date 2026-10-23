# Security

## What this project stores

Nothing secret belongs in this repository. The following files are gitignored and must
never be committed:

- `client.key` — the SSAP client key of one specific TV.
- `registration.json` — the registration payload sent to the TV's pairing service.
- `config.json` — installer settings, including the TV and soundbar addresses.
- `secrets/` — the directory the installer writes the two pairing files into.
- `.venv/` — the local virtualenv used for pairing.

The repository ships `config.example.json` only, with documentation addresses from the
TEST-NET-1 range (`192.0.2.0/24`).

## Pairing credentials

The client key is issued by the TV when you accept the pairing prompt. It is unique to
your TV and grants full SSAP access to it, which includes reading and changing settings,
launching applications and reading device information.

- Keep `secrets/` private; `pair_tv.py` writes it with mode `0700` and the files inside
  with mode `0600`.
- Do not share a `client.key` between TVs, and do not copy it into issues, logs or chat.
- If a key leaks, revoke the pairing on the TV (Settings → Connection → Device
  Connector → remove the paired device). The old key stops working immediately.
- `pair_tv.py` never prints the key. It only prints the paths it wrote.

## Runtime

- The daemon runs on the TV as `root`, because `/var/lib/webosbrew/init.d` and the SSAP
  socket require it. It has no sandbox of its own; treat the code you install as code
  running with full privileges on the TV.
- The daemon listens on **no** TCP port. It only opens outbound connections: a WebSocket
  to `127.0.0.1:3000` (loopback) and a TLS connection to the Cast device on the LAN.
- The Cast connection uses TLS with `rejectUnauthorized: false`, because Cast devices
  present self-signed certificates. The connection is outbound and limited to the
  configured `castHost`/`castPort`; no other host is contacted.
- `/tmp/orchestra-tv.log` records connection events and volume changes. It does not
  contain the client key.

## Installer

- `install.sh` uses `ssh` and `scp` with key authentication only. It never uses `sudo`,
  `sshpass` or password prompts, so no credentials pass through the script.
- It overwrites only `/var/lib/webosbrew/orchestra/*` and the two named files in
  `/var/lib/webosbrew/init.d/`. No other TV state is touched.
- `--dry-run` prints the commands instead of running them.

## Reporting a vulnerability

Please report security issues privately to the repository maintainer (open a private
security advisory on the hosting platform, or contact the maintainer directly). Do not
open a public issue for a vulnerability, and do not include keys, addresses or logs that
contain personal data.
