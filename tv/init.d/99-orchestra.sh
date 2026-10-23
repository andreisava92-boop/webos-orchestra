#!/bin/sh
# Re-apply the dual-output audio mode after boot.
#
# The hidden mode tv_speaker_optical_arc makes the TV speakers and the HDMI eARC
# / optical output play at the same time. webOS may reset it during boot, so it is
# re-applied here, after the audio service is ready.
#
# luna-send talks to Luna over a local socket and writes nothing when it has no
# controlling terminal, so every call is wrapped in `script -qc "..."`, which
# allocates a pseudo-TTY for the command. The JSON payload stays in single quotes
# so it survives both shell layers.
PATH=/usr/bin:/bin:/usr/sbin:/sbin

DESIRED_OUTPUT=tv_speaker_optical_arc

# Wait for Luna audio to answer (up to 15 attempts, 2 seconds apart).
i=0
while [ "$i" -lt 15 ]; do
  OUT="$(script -qc "luna-send -a webosbrew -n 1 -f luna://com.webos.service.audio/getSoundOutput '{}'" /dev/null 2>/dev/null)"
  case "$OUT" in
    *soundOutput*) break ;;
  esac
  i=$((i + 1))
  sleep 2
done

# Give audiod a moment to finish its own boot-time setup.
sleep 5

script -qc "luna-send -a webosbrew -f -n 1 -w 3000 luna://com.webos.service.audio/setSoundOutput '{\"soundOutput\":\"$DESIRED_OUTPUT\"}'" /dev/null
