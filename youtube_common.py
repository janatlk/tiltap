#!/usr/bin/env python3
"""Shared YouTube helpers for download/validation scripts."""

import base64
import os
import subprocess
import sys
import tempfile


def write_cookies_from_env(tmpdir: str) -> str | None:
    """Decode YOUTUBE_COOKIES_BASE64 or return YOUTUBE_COOKIES_PATH if present."""
    b64_cookies = os.environ.get("YOUTUBE_COOKIES_BASE64", "").strip()
    if b64_cookies:
        try:
            decoded = base64.b64decode(b64_cookies).decode("utf-8")
            cookies_path = os.path.join(tmpdir, "youtube_cookies.txt")
            with open(cookies_path, "w", encoding="utf-8") as f:
                f.write(decoded)
            return cookies_path
        except Exception as e:
            print(f"WARNING: Failed to decode YOUTUBE_COOKIES_BASE64: {e}", file=sys.stderr)

    path_cookies = os.environ.get("YOUTUBE_COOKIES_PATH", "").strip()
    if path_cookies and os.path.exists(path_cookies):
        return path_cookies

    return None


def get_cookies_path() -> str | None:
    """Decode YOUTUBE_COOKIES_BASE64 into a temp file or return YOUTUBE_COOKIES_PATH."""
    b64_cookies = os.environ.get("YOUTUBE_COOKIES_BASE64", "").strip()
    if b64_cookies:
        try:
            decoded = base64.b64decode(b64_cookies).decode("utf-8")
            fd, path = tempfile.mkstemp(suffix="_youtube_cookies.txt")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(decoded)
            return path
        except Exception as e:
            print(f"WARNING: Failed to decode YOUTUBE_COOKIES_BASE64: {e}", file=sys.stderr)

    path_cookies = os.environ.get("YOUTUBE_COOKIES_PATH", "").strip()
    if path_cookies and os.path.exists(path_cookies):
        return path_cookies

    return None


def cleanup_temp_cookies(cookies_path: str | None) -> None:
    if cookies_path and cookies_path.startswith(tempfile.gettempdir()):
        try:
            os.unlink(cookies_path)
        except OSError:
            pass


def get_extractor_args() -> dict:
    """Build yt-dlp extractor_args optimized for datacenter/cloud IPs.

    - Prefer mobile/TV clients which are less likely to demand sign-in.
    - Skip heavy webpage/JS processing when possible.
    - Optionally inject a PO token and/or visitor_data for the web client.
    - Add the web client as a final fallback when a PO token or visitor_data is
      provided, because a valid token can sometimes bypass strict sign-in checks.
    """
    clients = ["ios", "android", "tv"]

    po_token = os.environ.get("YOUTUBE_PO_TOKEN", "").strip()
    visitor_data = os.environ.get("YOUTUBE_VISITOR_DATA", "").strip()

    # Only fall back to the web client if we have something to feed it.
    if po_token or visitor_data:
        clients.append("web")

    extractor_args: dict = {
        "youtube": {
            # ios/tv/android usually work without cookies/PO tokens on flagged IPs.
            "player_client": clients,
            "player_skip": ["webpage", "configs", "js"],
        }
    }

    if po_token:
        # Comma-separated list of CLIENT.CONTEXT+TOKEN entries.
        extractor_args["youtube"]["po_token"] = [t.strip() for t in po_token.split(",") if t.strip()]

    if visitor_data:
        extractor_args["youtube"]["visitor_data"] = visitor_data

    return extractor_args


def update_ytdlp() -> None:
    """Optionally upgrade yt-dlp at runtime. Called by startup script."""
    if os.environ.get("YOUTUBE_AUTO_UPDATE_YTDLP", "").lower() not in ("true", "1"):
        return
    try:
        print("Updating yt-dlp to the latest version...", flush=True)
        subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--break-system-packages",
                "--no-cache-dir",
                "--upgrade",
                "yt-dlp[default]",
            ],
            check=True,
            stdout=sys.stderr,
            stderr=subprocess.STDOUT,
        )
        import importlib

        import yt_dlp

        importlib.reload(yt_dlp)
        print(f"yt-dlp updated to {yt_dlp.version.__version__}", flush=True)
    except Exception as e:
        print(f"WARNING: Failed to update yt-dlp: {e}", file=sys.stderr)


if __name__ == "__main__":
    pass
