# Compatibility

## Tested configuration

| Item               | Value                                |
| ------------------ | ------------------------------------ |
| TV model           | LG OLED55A13LA                       |
| webOS version      | 6.5.3-47                             |
| Firmware           | 03.53.45                             |
| Root method        | Homebrew Channel (`webosbrew`)       |
| Node.js on the TV  | `/usr/bin/node`, Node 8              |
| Soundbar link      | HDMI eARC, Google Cast on port 8009  |

This is the only configuration the project has been run on. Everything else below is an
educated guess based on the same platform.

## Requirements checklist

A TV works with webos-orchestra when all of these are true:

1. **Rooted with the Homebrew Channel.** `/var/lib/webosbrew/init.d` must exist; that is
   how the boot scripts run. A TV without it can still run the daemon manually, but it
   will not survive a reboot.
2. **SSH with key authentication.** The Homebrew Channel's SSH server must be running and
   your public key must be in `/home/root/.ssh/authorized_keys`.
3. **`/usr/bin/node` present.** webOS ships its own Node build. `node --version` on the
   TV should print `v8.x` or similar.
4. **The hidden output mode exists in the firmware.** Check from the TV shell:

   ```sh
   strings /usr/sbin/audiod | grep tv_speaker_optical_arc
   # or, when strings is not available:
   grep -a tv_speaker_optical_arc /usr/sbin/audiod
   ```

   A match means `setSoundOutput` should accept the value.
5. **A Cast receiver on the same LAN.** The soundbar must answer on port 8009 and be
   reachable from the TV, not only from your computer.

`install.sh` checks 1, 2, 3 and 4 before it copies anything.

## Checking the output mode by hand

```sh
script -qc "luna-send -a webosbrew -n 1 -f luna://com.webos.service.audio/getSoundOutput '{}'" /dev/null
```

A working TV answers with JSON containing `"soundOutput": "..."`. To test the hidden
mode without installing anything:

```sh
script -qc "luna-send -a webosbrew -f -n 1 -w 3000 luna://com.webos.service.audio/setSoundOutput '{\"soundOutput\":\"tv_speaker_optical_arc\"}'" /dev/null
```

If the TV speakers and the soundbar both play, the mode is supported. If the answer is
an error or the audio drops out, stop here: this project cannot help that firmware.

## Known unsupported setups

- **No root.** Without root there is no `init.d`, no persistent daemon and no way to call
  the audio service at boot. Nothing in this project works without root.
- **No Cast receiver.** If the soundbar does not expose Google Cast (many older optical
  and HDMI-ARC-only bars do not), volume mirroring cannot work. The audio mode part
  still works; set `castHost` to any reachable Cast device or accept the failing
  `cast connected` step.
- **No hidden mode.** Firmware where `/usr/sbin/audiod` does not contain
  `tv_speaker_optical_arc`. `install.sh` exits before copying files.
- **webOS versions without a usable Node runtime.** The daemon needs Node 8 or newer with
  `net`, `tls`, `crypto` and `child_process`.
- **TVs whose audio service rejects `setSoundOutput` while an app is in the foreground.**
  The watchdog retries, but some apps hold the audio path for themselves.
- **Different volume curve per input.** `gain` is global; per-input calibration is out of
  scope.

## Reporting your setup

If it works on a different model, the useful details are: model, webOS version, firmware
version, root method, `node --version` output, and whether `strings /usr/sbin/audiod`
contains the mode name.
