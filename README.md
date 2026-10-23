# webos-orchestra

Play the TV speakers and a soundbar at the same time on a rooted LG webOS TV, with the
TV volume mirrored to the soundbar over Google Cast.

On many LG TVs the combination of the internal speakers and the HDMI eARC / optical
output is hidden behind an undocumented `soundOutput` value: `tv_speaker_optical_arc`.
Setting it works, but webOS resets it after boot, input changes and firmware updates,
and the soundbar volume does not follow the TV remote.

webos-orchestra installs a tiny daemon on the TV that:

- re-applies `tv_speaker_optical_arc` whenever the TV falls back to another mode;
- subscribes to the TV volume and sends `SET_VOLUME` to the soundbar over Google Cast,
  scaled by a configurable gain.

No computer has to stay on, and nothing has to run on your phone.

## How it works in one paragraph

The daemon runs on the TV itself (webOS ships a Node.js runtime). It talks SSAP over a
WebSocket on `127.0.0.1:3000` using the TV's own pairing credentials, listens for
`ssap://audio/getVolume` events, and mirrors the volume to the soundbar with a Google
Cast `SET_VOLUME` message on port 8009. A watchdog re-applies the audio mode with
`luna-send`. See [docs/how-it-works.md](docs/how-it-works.md) for the details.

## Requirements

- A rooted LG webOS TV with the Homebrew Channel (SlopBro / `webosbrew`) installed.
  The daemon needs `/var/lib/webosbrew/init.d`, which the Homebrew Channel provides.
- Root SSH access to the TV with **key authentication** (no password prompts).
- `/usr/bin/node` on the TV (part of webOS).
- Firmware whose `/usr/sbin/audiod` contains the string `tv_speaker_optical_arc`.
  `install.sh` checks this for you.
- A soundbar or receiver that accepts Google Cast on the local network and is reachable
  from the TV (same LAN/Wi-Fi).
- Python 3.8+ on the computer you install from.

## Quick start

```bash
git clone https://github.com/andreisava92-boop/webos-orchestra.git webos-orchestra
cd webos-orchestra
./install.sh
```

`install.sh` asks for two addresses:

- **TV IP** — the TV on your LAN, for example `192.0.2.10`.
- **Soundbar (Cast) IP** — the Cast device, for example `192.0.2.60`.

It then opens an SSH session, checks the prerequisites, pairs with the TV (a PIN appears
on screen), copies the daemon to `/var/lib/webosbrew/orchestra`, installs the boot
scripts and starts the daemon.

During pairing the TV shows a 6-character PIN. Type it in the terminal when the script
asks for it.

After a successful install the script prints the daemon PID and the tail of
`/tmp/orchestra-tv.log`, and checks that the log contains `ssap registered` and
`cast connected`.

## Manual install

`install.sh` performs these steps; you can do them by hand if you prefer:

1. Copy `tv/orchestra.js` and the three config/secret files to
   `/var/lib/webosbrew/orchestra/` on the TV (`config.json`, `client.key`,
   `registration.json`).
2. Copy `tv/init.d/98-orchestra-daemon` and `tv/init.d/99-orchestra` to
   `/var/lib/webosbrew/init.d/` and make them executable (`chmod 755`).
3. Create `/var/lib/webosbrew/orchestra/config.json`:

   ```json
   {
     "castHost": "192.0.2.60",
     "castPort": 8009,
     "gain": 2.6,
     "desiredOutput": "tv_speaker_optical_arc",
     "watchdogSeconds": 15
   }
   ```

4. Start it: `sh /var/lib/webosbrew/init.d/98-orchestra-daemon` and watch
   `/tmp/orchestra-tv.log`.

To check a config without starting anything, run the daemon once:

```bash
/usr/bin/node /var/lib/webosbrew/orchestra/orchestra.js --once
# {"ok":true,"castHost":"192.0.2.60","gain":2.6,"desiredOutput":"tv_speaker_optical_arc"}
```

## Configuration

The TV-side file is `/var/lib/webosbrew/orchestra/config.json`:

| Key               | Type   | Meaning                                                        |
| ----------------- | ------ | -------------------------------------------------------------- |
| `castHost`        | string | IPv4 address of the Cast receiver (the soundbar).              |
| `castPort`        | number | Cast port, `8009` unless you changed it.                       |
| `gain`            | number | Multiplier applied to the TV volume before sending it.         |
| `fixedCastVolume` | number or null | Pin the soundbar at this level instead of using `gain`. |
| `desiredOutput`   | string | Output mode to enforce, normally `tv_speaker_optical_arc`.     |
| `watchdogSeconds` | number | How often the output mode is checked, minimum `5`.             |

The installer-side `config.json` in the repository root also stores `tvHost` and
`sshUser` so `install.sh`, `status.sh` and `uninstall.sh` can be re-run without flags.
It is gitignored, together with `secrets/`.

`gain` exists because soundbars and TVs do not share a volume curve. With `gain: 2.6`
a TV volume of 10 sends level 26 to the soundbar, and a TV volume of 50 (or anything
above ~38) sends level 100. If the soundbar is much louder or quieter than the TV
speakers, adjust `gain` and restart the daemon:

```bash
ssh root@192.0.2.10 'sh /var/lib/webosbrew/init.d/98-orchestra-daemon'
```

If the TV is still louder than the soundbar at every useful `gain`, set
`"fixedCastVolume": 100` in the TV-side `config.json` and restart the daemon. The daemon
then sends that level whenever the TV volume is above 0; mute and volume 0 still send 0.
This field is not written by the installer, so add it again after a reinstall.

## Finding the soundbar IP

Use your router's client list, or scan the LAN:

```bash
nmap -p 8009 --open 192.0.2.0/24
```

Reserve the address in your router's DHCP settings. If the soundbar gets a new address,
the daemon logs `cast error` and stops mirroring until `config.json` is updated.

## Status and uninstall

```bash
./status.sh     # process, log tail, current sound output, sound settings
./uninstall.sh  # stop and remove the daemon, restore the audio mode
```

`status.sh` exits `0` when the daemon is running and `1` otherwise.

`uninstall.sh` restores `tv_speaker` by default. Use
`--restore-output external_arc|external_optical|none` to choose something else, and
`--purge` to delete the local `secrets/` and `config.json` as well.

## Limitations

- **No network, no volume sync.** The Cast connection is outbound from the TV to the
  soundbar on the same LAN. If the TV or the soundbar is offline, or they are on
  different VLANs, only the audio mode keeps working.
- **There will be echo.** The TV speakers and the soundbar are never perfectly in sync;
  small delays are normal and depend on the soundbar's processing.
- **Firmware updates can remove the hidden mode.** If `/usr/sbin/audiod` no longer
  contains `tv_speaker_optical_arc`, `install.sh` refuses to install and the daemon
  cannot re-apply it.
- **Root is required.** Homebrew Channel access means the TV is out of its normal
  warranty and security model.
- **The gain is a single value.** It is not a per-step calibration table, so the
  balance between the two outputs can drift at the extremes of the range.
- **No volume sync in the other direction.** Changing the volume on the soundbar does
  not change the TV volume.

## Disclaimer

This is an unofficial project. It is not affiliated with, endorsed by or supported by
LG Electronics. Rooting a TV voids the warranty and can brick the device; you do it at
your own risk. The hidden output mode is undocumented and may disappear in any firmware
release.

## License

MIT — see [LICENSE](LICENSE).
