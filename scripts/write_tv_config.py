#!/usr/bin/env python3
"""Write the TV-side config.json consumed by tv/orchestra.js.

Usage:
  python3 write_tv_config.py <output.json> <castHost> <castPort> <gain> \
      <desiredOutput> <watchdogSeconds>

Validates every value, then writes pretty-printed JSON (mode 0644).
Exits non-zero on bad input.
"""

import json
import math
import sys

USAGE = (
    "usage: write_tv_config.py <output.json> <castHost> <castPort> <gain> "
    "<desiredOutput> <watchdogSeconds>\n"
)


def parse_port(raw):
    try:
        value = int(raw, 10)
    except ValueError:
        raise ValueError("castPort must be an integer, got %r" % raw)
    if value < 1 or value > 65535:
        raise ValueError("castPort must be between 1 and 65535, got %d" % value)
    return value


def parse_gain(raw):
    try:
        value = float(raw)
    except ValueError:
        raise ValueError("gain must be a number, got %r" % raw)
    if not math.isfinite(value) or value <= 0:
        raise ValueError("gain must be greater than 0, got %r" % raw)
    return value


def parse_watchdog(raw):
    try:
        value = float(raw)
    except ValueError:
        raise ValueError("watchdogSeconds must be a number, got %r" % raw)
    if not math.isfinite(value) or value < 5:
        raise ValueError("watchdogSeconds must be >= 5, got %r" % raw)
    return int(value) if value == int(value) else value


def require_text(name, raw):
    value = (raw or "").strip()
    if not value:
        raise ValueError("%s must not be empty" % name)
    return value


def main(argv):
    if len(argv) != 6:
        sys.stderr.write(USAGE)
        return 2

    output, cast_host, cast_port, gain, desired_output, watchdog = argv

    try:
        config = {
            "castHost": require_text("castHost", cast_host),
            "castPort": parse_port(cast_port),
            "gain": parse_gain(gain),
            "desiredOutput": require_text("desiredOutput", desired_output),
            "watchdogSeconds": parse_watchdog(watchdog),
        }
    except ValueError as exc:
        sys.stderr.write("error: %s\n" % exc)
        return 1

    try:
        with open(output, "w", encoding="utf-8") as handle:
            json.dump(config, handle, indent=2)
            handle.write("\n")
    except OSError as exc:
        sys.stderr.write("error: cannot write %s: %s\n" % (output, exc))
        return 1

    print("wrote %s" % output)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
