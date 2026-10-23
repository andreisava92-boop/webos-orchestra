# How it works

This document describes what actually runs on the TV and why each piece exists.

## Overview

```
TV remote ──► webOS audio service
                  │
                  │ SSAP over ws://127.0.0.1:3000
                  ▼
            tv/orchestra.js  ──── TLS 8009 ──► soundbar (Google Cast)
                  │
                  └─ luna-send ──► setSoundOutput / getSoundOutput
```

Nothing runs outside the TV. The installer computer is only used to copy files and to
pair once.

## SSAP over a WebSocket

webOS exposes its services through SSAP (second-screen application protocol). The daemon
connects to `ws://127.0.0.1:3000`, performs the RFC 6455 handshake by hand (Node 8 on the
TV has no `ws` package, and the project deliberately has no dependencies), then sends:

```json
{ "type": "register", "id": "reg", "payload": { "...": "registration payload" } }
```

The payload comes from `registration.json`, with `client-key` injected from `client.key`,
`pairingType` set to `PROMPT` and `forcePairing` to `false`. When the TV answers with
`{"type":"registered"}` the daemon logs `ssap registered` and subscribes to
`ssap://audio/getVolume`.

After that the TV pushes `volumeStatus` objects whenever the volume or the mute state
changes:

```json
{ "volumeStatus": { "volume": 12, "muteStatus": false } }
```

The daemon does not poll the volume; it reacts to those pushes. If the socket drops, a
5-second timer reconnects and re-registers.

## The hidden output mode

`setSoundOutput` normally accepts `tv_speaker`, `external_optical`, `external_arc`,
`bt_soundbar`, `wisa_speaker`, `headphone`, `lineout`, `tv_external_speaker`,
`tv_speaker_headphone`, `lgSoundSync` and `mobile_phone`. The value
`tv_speaker_optical_arc` is not in that list — it engages the internal speakers and the
eARC/optical output at the same time. It exists in the audio daemon
(`/usr/sbin/audiod`) but has no user interface.

Because it is not a documented value, webOS re-evaluates the output on boot, on input
changes, on SIMPLINK/CEC events and after some app switches, and usually falls back to
`external_arc` (or `tv_speaker` when nothing is connected). That is why the daemon needs
a watchdog.

## Volume mirroring with Cast

The soundbar is treated as a Google Cast receiver. The daemon opens a TLS connection to
`castHost:castPort` (8009), sends a `CONNECT` on
`urn:x-cast:com.google.cast.tp.connection`, and then sends `SET_VOLUME` messages on
`urn:x-cast:com.google.cast.receiver`:

```json
{ "type": "SET_VOLUME", "volume": { "level": 0.26 }, "requestId": 7 }
```

Cast messages are protobuf-framed: a 4-byte big-endian length prefix followed by a
`CastMessage` with fields

1. `protocol_version` (varint, 0),
2. `source_id` (string, `sender-0`),
3. `destination_id` (string, `receiver-0`),
4. `namespace` (string),
5. `payload_type` (varint, 0 = string),
6. `payload_utf8` (string, the JSON above).

The protobuf encoder in `tv/orchestra.js` is about 40 lines and covers exactly these
fields. `level` is `0..1`, so the percentage is divided by 100 before sending.

## Gain

TV volume and soundbar volume do not share a curve: a soundbar at 26 % is usually much
louder than TV speakers at 26 %. The daemon therefore sends

```
cast_level_percent = min(100, round(tv_volume_percent * gain))
```

with `gain` from the config (default `2.6`). Muting maps to `0`, and anything above
`100 / gain` saturates at 100. The mapping is deliberately linear and has a single
parameter: it is easy to reason about and to tune by ear.

`computeTarget()` and `applyGain()` are exported so the mapping is unit-tested without a
TV.

## Watchdog

Every `watchdogSeconds` (default 15) the daemon calls
`luna://com.webos.service.audio/getSoundOutput` and compares the result with
`desiredOutput`. When it differs, it logs

```
output is external_arc -> re-applying tv_speaker_optical_arc
```

and calls `setSoundOutput`, then logs the TV's answer as `re-applied: {...}`. A 30-second
throttle keeps a firmware that refuses the mode from producing an endless write loop.

## Why luna-send needs a TTY

`luna-send` talks to the Luna bus over a Unix socket. When its standard input is not a
terminal it exits with status 0 and writes nothing — a silent no-op that looks like a
successful call. All Luna calls are therefore wrapped as

```sh
script -qc "luna-send -a webosbrew -f -n 1 -w 3000 <uri> '<json>'" /dev/null
```

`script` allocates a pseudo-terminal for the command, which is what `luna-send` needs.
The JSON payload is single-quoted so it survives the two shell layers (the local shell
and the shell started by `script`). Removing the `script -qc` wrapper is the most common
way to break this project: everything looks fine and nothing is ever written.

## Boot scripts

Two scripts are installed in `/var/lib/webosbrew/init.d/`, which the Homebrew Channel
runs at boot. Their filenames have **no `.sh` extension on purpose**: `run-parts` ignores
names containing a dot, so `99-orchestra.sh` would never run.

- `98-orchestra-daemon` kills a previously recorded PID, waits a second, refuses to
  start when `orchestra.js` or `config.json` is missing, then starts
  `nohup /usr/bin/node "$BASE/orchestra.js" >> /tmp/orchestra-tv.log 2>&1 &` and records
  the PID in `/tmp/orchestra-tv.pid`.
- `99-orchestra` polls `getSoundOutput` until the audio service answers (15 attempts,
  2 seconds apart), waits another 5 seconds, then applies
  `tv_speaker_optical_arc` once. Ordering matters: at boot the audio service is not ready
  when `init.d` starts, and a `setSoundOutput` that arrives too early is dropped.

The daemon itself has no supervisor loop; the init script starts it once and the process
runs until stopped. WebSocket and Cast reconnection are handled inside the process.

## Log markers

`install.sh` greps the log, so these lines are part of the contract:

| Line                                             | Meaning                              |
| ------------------------------------------------ | ------------------------------------ |
| `ws connected`                                   | WebSocket handshake finished         |
| `ssap registered`                                | TV accepted the pairing credentials  |
| `cast connected`                                 | TLS to the soundbar is up            |
| `TV <n>% -> cast <n>%`                           | a volume change was mirrored         |
| `output is <mode> -> re-applying <mode>`         | the watchdog saw a fallback          |
| `re-applied: <json>`                             | the TV accepted the audio mode       |
| `DRY_RUN cast level=<0-1>`                       | would have sent a Cast level         |

Every line is prefixed with an ISO timestamp.
