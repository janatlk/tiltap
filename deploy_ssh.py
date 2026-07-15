#!/usr/bin/env python3
"""Run a command on the Hetzner server via the tiltab_deploy SSH key."""
import sys
from pathlib import Path

import paramiko

HOST = "95.216.169.56"
USER = "root"
KEY_PATH = Path(__file__).resolve().parent / ".keys" / "tiltab_deploy"


def run(cmd: str, timeout: int = 60):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, key_filename=str(KEY_PATH), timeout=30)
    try:
        stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        rc = stdout.channel.recv_exit_status()
        print("--- stdout ---")
        print(out)
        if err:
            print("--- stderr ---")
            print(err)
        print(f"--- exit code {rc} ---")
        return rc, out, err
    finally:
        client.close()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "whoami"
    run(cmd)
