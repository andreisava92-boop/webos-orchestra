#!/usr/bin/env python3
"""Read one top-level key from a JSON config file.

Usage: python3 read_config.py <config.json> <key> [default]

Prints the value without quotes (or the default) and exits 0.
Exits 1 when the key is missing and no default was given.
"""

import json
import sys


def format_value(value):
    """Render a JSON value the way a shell script expects it."""
    if isinstance(value, str):
        return value
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    return json.dumps(value)


def main(argv):
    if len(argv) not in (2, 3):
        sys.stderr.write("usage: read_config.py <config.json> <key> [default]\n")
        return 2

    path = argv[0]
    key = argv[1]
    has_default = len(argv) == 3
    default = argv[2] if has_default else None

    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError as exc:
        if has_default:
            print(default)
            return 0
        sys.stderr.write("cannot read %s: %s\n" % (path, exc))
        return 1
    except ValueError as exc:
        sys.stderr.write("%s is not valid JSON: %s\n" % (path, exc))
        return 1

    if not isinstance(data, dict):
        sys.stderr.write("%s must contain a JSON object\n" % path)
        return 1

    if key not in data:
        if has_default:
            print(default)
            return 0
        sys.stderr.write("key %r not found in %s\n" % (key, path))
        return 1

    print(format_value(data[key]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
