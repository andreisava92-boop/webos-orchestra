#!/bin/sh
# Start the Orchestra daemon on the TV.
#
# webOS runs every executable in /var/lib/webosbrew/init.d at boot. This script
# starts the daemon once (restarting it if a previous PID is still recorded);
# the daemon itself handles its own reconnect logic.
PATH=/usr/bin:/bin:/usr/sbin:/sbin

BASE=/var/lib/webosbrew/orchestra
PIDFILE=/tmp/orchestra-tv.pid
LOG=/tmp/orchestra-tv.log

if [ -f "$PIDFILE" ]; then
  OLD_PID="$(cat "$PIDFILE" 2>/dev/null)"
  if [ -n "$OLD_PID" ]; then
    kill "$OLD_PID" 2>/dev/null
  fi
  sleep 1
  rm -f "$PIDFILE"
fi

if [ ! -f "$BASE/orchestra.js" ]; then
  echo "$(date) orchestra: $BASE/orchestra.js is missing, not starting" >> "$LOG"
  exit 1
fi

if [ ! -f "$BASE/config.json" ]; then
  echo "$(date) orchestra: $BASE/config.json is missing, not starting" >> "$LOG"
  exit 1
fi

/usr/bin/nohup /usr/bin/node "$BASE/orchestra.js" >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"
