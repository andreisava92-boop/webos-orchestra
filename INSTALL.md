# Install Orchestra

Orchestra has two parts:

1. **The daemon** — runs as root on the TV. It keeps the chosen output mode, mirrors
   the TV volume to the soundbar over Google Cast, and exposes a loopback-only HTTP API
   for the app. Without it the app cannot switch anything.
2. **The TV app** — an optional launcher icon with the same controls. It only talks to
   `127.0.0.1:8099`, so it needs no TV credentials and no special permissions.

## Requirements

- A **rooted LG webOS TV** (webOS 6 or newer; tested on an OLED55A13LA) with
  [Homebrew Channel](https://www.webosbrew.org/) installed.
- **SSH access as root with a public key.** The installer is non-interactive and never
  prompts for a password; add your `~/.ssh/id_ed25519.pub` to
  `/home/root/.ssh/authorized_keys` on the TV first.
- `python3` (3.8+) and `git` on the computer you install from.
- The TV and the computer on the same network.
- A Google Cast receiver (the soundbar), if you want volume mirroring.

Rooting is out of scope here: it depends on the TV model and firmware. If you already
have Homebrew Channel and key-based SSH, you are ready.

## 1. The daemon (required)

```bash
git clone https://github.com/andreisava92-boop/webos-orchestra.git
cd webos-orchestra
./install.sh --tv-ip 192.168.1.50 --cast-ip 192.168.1.60
```

The script:

- checks SSH, the firmware and the audio modes,
- pairs with the TV over SSAP (a PIN appears on screen — type it in the terminal),
- writes `secrets/client.key` and `secrets/registration.json` locally with mode `600`,
- copies the daemon to `/var/lib/webosbrew/orchestra/`,
- installs the boot scripts `98-orchestra-daemon` and `99-orchestra`,
- starts the daemon and prints its PID and log tail.

Useful flags: `--gain 4` (volume multiplier), `--skip-pair`, `--dry-run`.
Check it later with `./status.sh`, remove it with `./uninstall.sh`.

## 2. The app (optional)

The app is published in a Homebrew Channel repository. On the TV:

1. Open **Homebrew Channel → Settings (gear) → Repositories**.
2. Choose **Add repository** and enter:

   ```
   https://raw.githubusercontent.com/andreisava92-boop/webos-orchestra/main/repo/apps.json
   ```

3. Go back to the app list, select **Orchestra** and press **Install**.

Updates appear the same way: bump the version in the repository and Homebrew Channel
offers **Update**.

Alternative, without Homebrew Channel: download the IPK from the
[releases page](https://github.com/andreisava92-boop/webos-orchestra/releases) and run
`./scripts/install-app.sh --tv-ip 192.168.1.50 --ipk /path/to/com.andrei.orchestra_x.y.z_all.ipk`.

## How the modes behave

| Mode | Speakers | Digital audio |
| --- | --- | --- |
| TV only | TV speakers | — |
| Soundbar only | HDMI ARC soundbar | **Pass Through** = Dolby/DTS |
| TV + soundbar | both | **PCM only** (the TV downmixes) |

The TV cannot send bitstream to ARC and PCM to its own speakers at the same time.
Selecting **Soundbar only** from `auto` switches Digital audio to `passThrough`;
selecting **TV + soundbar** switches it back to `auto`, because dual output ignores
pass-through and plays PCM. LG documents these simultaneous modes as **stereo PCM**;
there is no software setting that changes that.

## Troubleshooting

- **The PIN prompt fails.** Run `./install.sh --skip-pair` after a successful pairing,
  and make sure nothing else is paired under the same name.
- **The app says "Service unavailable".** The daemon is not running:
  `ssh root@TV 'tail -20 /tmp/orchestra-tv.log'` and start it with
  `sh /var/lib/webosbrew/init.d/98-orchestra-daemon` (no TTY).
- **`ipk verified failed`.** The IPK must contain
  `usr/palm/packages/<id>/packageinfo.json`, not just the app directory.
- **The soundbar shows PCM.** That is expected in TV + soundbar mode, and with
  `soundOutputDigital` set to `auto`/`pcm`. Use Soundbar only + Pass Through for Dolby.
- **No sound after switching.** Re-select the mode in the app; the daemon re-applies
  `desiredOutput` every `watchdogSeconds`.

## Security

- The daemon API listens on `127.0.0.1:8099` only; it is not reachable from the LAN.
- `secrets/client.key` and `secrets/registration.json` are per-TV credentials. Keep
  them out of git and out of backups you share.
- The app contains no credentials; it can only call the local API.
