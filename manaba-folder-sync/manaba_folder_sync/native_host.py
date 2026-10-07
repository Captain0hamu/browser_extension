"""Firefox Native Messaging bridge. It only reads credentials from Secret Service."""
from __future__ import annotations

import json
import shutil
import struct
import subprocess
import sys


SERVICE = "manaba-folder-sync"
ACCOUNT = "tid"


def secret(name: str) -> str:
    tool = shutil.which("secret-tool")
    if tool is None:
        raise RuntimeError("secret-tool is not installed")
    completed = subprocess.run(
        [tool, "lookup", "service", SERVICE, "account", ACCOUNT, "field", name],
        check=True,
        capture_output=True,
        text=True,
    )
    value = completed.stdout.rstrip("\n")
    if not value:
        raise RuntimeError(f"Secret Service has no {name} entry")
    return value


def receive() -> dict | None:
    length_data = sys.stdin.buffer.read(4)
    if len(length_data) != 4:
        return None
    length = struct.unpack("@I", length_data)[0]
    return json.loads(sys.stdin.buffer.read(length))


def send(payload: dict) -> None:
    encoded = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main() -> None:
    while request := receive():
        try:
            if request.get("action") != "credentials":
                raise RuntimeError("Unknown native message action")
            send({"ok": True, "username": secret("username"), "password": secret("password")})
        except (RuntimeError, subprocess.CalledProcessError) as error:
            send({"ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
