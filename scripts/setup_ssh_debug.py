#!/usr/bin/env python3
"""Append a one-time debug SSH public key to root's authorized_keys."""
from pathlib import Path

KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEPloJoP7VVeqPacLkj9er94HW3ThachsYvZF4byUwjU debug2@local"

ssh_dir = Path("/root/.ssh")
ssh_dir.mkdir(mode=0o700, exist_ok=True)
auth = ssh_dir / "authorized_keys"

existing = auth.read_text(encoding="utf-8") if auth.exists() else ""
if KEY in existing:
    print("key already present")
else:
    with auth.open("a", encoding="utf-8") as f:
        if existing and not existing.endswith("\n"):
            f.write("\n")
        f.write(KEY + "\n")
    print("key appended")

auth.chmod(0o600)
print("done")
