#!/usr/bin/env python3
"""Pair an LG webOS TV and export the SSAP credentials the daemon needs.

Usage:
  python3 scripts/pair_tv.py --tv-ip <ip> --out-dir <dir> [--tv-name <name>] [--force]

The script creates ./.venv in the repo when missing, installs lgtvremote-cli
into it, registers the TV, runs the pairing (the PIN is typed on the TV), and
writes <out-dir>/client.key and <out-dir>/registration.json with mode 0600.

The client key is never printed. Only stdlib is used by this script itself;
the third-party package lives inside the venv.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

REPO_ROOT = Path(__file__).resolve().parent.parent
VENV_DIR = REPO_ROOT / ".venv"
PACKAGE_SPEC = "lgtvremote-cli==1.6.4"
DEVICES_FILE = Path.home() / ".config" / "lgtvremote" / "devices.json"
DEFAULT_TV_NAME = "webos-orchestra"
IPV4_RE = re.compile(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$")


def info(message):
    print(message, flush=True)


def fail(message: str) -> NoReturn:
    sys.stderr.write("error: %s\n" % message)
    sys.exit(1)


def is_ipv4(value):
    match = IPV4_RE.match(value or "")
    if not match:
        return False
    return all(0 <= int(part) <= 255 for part in match.groups())


def venv_python():
    return VENV_DIR / "bin" / "python"


def ensure_venv():
    """Create ./.venv if missing and return its python binary."""
    python = venv_python()
    if python.exists():
        return python

    info("Creating virtualenv in %s ..." % VENV_DIR)
    try:
        subprocess.check_call([sys.executable, "-m", "venv", str(VENV_DIR)])
    except (OSError, subprocess.CalledProcessError) as exc:
        fail("could not create a virtualenv (%s); install python3-venv and retry" % exc)

    if not python.exists():
        fail("virtualenv %s was created but %s is missing" % (VENV_DIR, python))
    return python


def ensure_package(python):
    """Install lgtvremote-cli into the venv (no-op when already satisfied)."""
    info("Installing %s into %s ..." % (PACKAGE_SPEC, VENV_DIR))
    try:
        subprocess.check_call([
            str(python), "-m", "pip", "install",
            "--disable-pip-version-check",
            "--upgrade-strategy", "only-if-needed",
            PACKAGE_SPEC,
        ])
    except (OSError, subprocess.CalledProcessError) as exc:
        fail("could not install %s (%s); check your network connection" % (PACKAGE_SPEC, exc))

    lgtv = VENV_DIR / "bin" / "lgtv"
    if not lgtv.exists():
        fail("%s was installed but %s is missing" % (PACKAGE_SPEC, lgtv))
    return lgtv


def add_device(lgtv, tv_ip, tv_name):
    """Register the TV in ~/.config/lgtvremote. An existing entry is fine."""
    info("Registering %s as %r ..." % (tv_ip, tv_name))
    try:
        proc = subprocess.run(
            [str(lgtv), "add", tv_ip, "--name", tv_name, "--no-enrich"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
    except OSError as exc:
        fail("could not run %s: %s" % (lgtv, exc))

    output = (proc.stdout or "").strip()
    if proc.returncode == 0:
        return
    lowered = output.lower()
    if "already" in lowered or "exist" in lowered:
        info("TV already registered, continuing.")
        return
    # Not fatal: pairing below is the authoritative step.
    info("warning: lgtv add returned %d" % proc.returncode)
    if output:
        info(output)


def pair(lgtv, tv_ip):
    """Run the pairing flow with inherited stdio so the PIN can be typed."""
    info("Pairing with %s. Accept the prompt on the TV and type the PIN here." % tv_ip)
    try:
        code = subprocess.call([str(lgtv), "--tv", tv_ip, "pair"])
    except OSError as exc:
        fail("could not run %s: %s" % (lgtv, exc))
    if code != 0:
        info("warning: pairing exited with %d; checking for an existing key" % code)


def load_devices():
    try:
        with open(DEVICES_FILE, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except OSError:
        return None
    except ValueError:
        return None


def find_client_key(data, tv_ip):
    """devices[<ip>]["client_key"]; never fall back to another TV's key."""
    if isinstance(data, dict):
        devices = data.get("devices")
        if isinstance(devices, dict):
            entry = devices.get(tv_ip)
            if isinstance(entry, dict):
                for name in ("client_key", "clientKey"):
                    value = entry.get(name)
                    if isinstance(value, str) and value.strip():
                        return value.strip()
    return None


def read_client_key(tv_ip):
    data = load_devices()
    if data is None:
        fail(
            "cannot read %s.\n"
            "Pairing did not complete. Run this script again, accept the prompt on the TV "
            "and type the PIN within 60 seconds." % DEVICES_FILE
        )
    key = find_client_key(data, tv_ip)
    if not key:
        fail(
            "no client key for %s in %s.\n"
            "Pairing did not complete. Make sure the TV shows a pairing prompt, run this "
            "script again and type the PIN shown on screen." % (tv_ip, DEVICES_FILE)
        )
    return key


def read_registration_payload(python):
    code = (
        "import json, lgtvremote_cli as l; "
        "print(json.dumps(l.REGISTRATION_PAYLOAD))"
    )
    try:
        proc = subprocess.run(
            [str(python), "-c", code],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except OSError as exc:
        fail("could not run %s: %s" % (python, exc))

    if proc.returncode != 0:
        fail(
            "could not read REGISTRATION_PAYLOAD from %s:\n%s"
            % (PACKAGE_SPEC, (proc.stderr or "").strip())
        )

    try:
        payload = json.loads(proc.stdout)
    except ValueError as exc:
        fail("REGISTRATION_PAYLOAD is not valid JSON: %s" % exc)

    if not isinstance(payload, dict) or not payload:
        fail("REGISTRATION_PAYLOAD is empty or not an object")
    return payload


def write_private_file(path, content):
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(content)
    os.chmod(str(path), 0o600)


def main():
    parser = argparse.ArgumentParser(
        description="Pair an LG webOS TV and export client.key + registration.json."
    )
    parser.add_argument("--tv-ip", required=True, help="TV IPv4 address")
    parser.add_argument("--out-dir", required=True, help="directory for the secret files")
    parser.add_argument("--tv-name", default=DEFAULT_TV_NAME, help="name used by lgtv add")
    parser.add_argument(
        "--force",
        action="store_true",
        help="pair again even if client.key and registration.json already exist",
    )
    args = parser.parse_args()

    tv_ip = args.tv_ip.strip()
    if not is_ipv4(tv_ip):
        fail("--tv-ip must be an IPv4 address, got %r" % args.tv_ip)

    out_dir = Path(args.out_dir).expanduser().resolve()
    key_path = out_dir / "client.key"
    registration_path = out_dir / "registration.json"

    if not args.force and key_path.is_file() and key_path.stat().st_size > 0 \
            and registration_path.is_file() and registration_path.stat().st_size > 0:
        info("Reusing existing pairing in %s" % out_dir)
        info("  %s" % key_path)
        info("  %s" % registration_path)
        return 0

    python = ensure_venv()
    lgtv = ensure_package(python)
    add_device(lgtv, tv_ip, args.tv_name)
    pair(lgtv, tv_ip)

    client_key = read_client_key(tv_ip)
    payload = read_registration_payload(python)

    out_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(str(out_dir), 0o700)
    write_private_file(key_path, client_key + "\n")
    write_private_file(registration_path, json.dumps(payload, indent=2) + "\n")

    info("Wrote pairing files:")
    info("  %s" % key_path)
    info("  %s" % registration_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
