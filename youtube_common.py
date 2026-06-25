#!/usr/bin/env python3
"""Shared YouTube helpers for download/validation scripts."""

import base64
import os
import subprocess
import sys
import tempfile

# Desktop Chrome headers to mimic a real browser. YouTube datacenter/bot
# detection is less aggressive when the request looks like normal user traffic.
DESKTOP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,image/apng,*/*;q=0.8"
    ),
    "Sec-Ch-Ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Upgrade-Insecure-Requests": "1",
}


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

    - Use the web client with the BgUtils POT provider plugin so PO tokens are
      generated automatically instead of being collected manually.
    - Fall back to mobile/TV clients if the web client fails.
    - Skip heavy webpage/JS processing when possible.
    - Keep manual YOUTUBE_PO_TOKEN / YOUTUBE_VISITOR_DATA support for backwards
      compatibility, but prefer the POT provider when available.
    """
    extractor_args: dict = {
        "youtube": {
            # web needs a PO token on flagged IPs; the bgutil provider supplies it.
            "player_client": ["web", "ios", "android", "tv"],
            "player_skip": ["webpage", "configs", "js"],
        },
        # Automatic PO-token generation via the local bgutil-pot server.
        "youtubepot-bgutilhttp": {
            "base_url": os.environ.get("YOUTUBE_POT_PROVIDER_URL", "http://127.0.0.1:4416"),
        },
    }

    # Backwards compatibility: manual PO token / visitor data still works if set.
    po_token = os.environ.get("YOUTUBE_PO_TOKEN", "").strip()
    visitor_data = os.environ.get("YOUTUBE_VISITOR_DATA", "").strip()
    if po_token:
        extractor_args["youtube"]["po_token"] = [t.strip() for t in po_token.split(",") if t.strip()]
    if visitor_data:
        extractor_args["youtube"]["visitor_data"] = visitor_data

    return extractor_args


def is_youtube_bot_error(msg: str) -> bool:
    """Return True when yt-dlp failed because of bot detection or auth."""
    lower = msg.lower()
    return any(
        phrase in lower
        for phrase in [
            "sign in",
            "http error 403",
            "bot",
            "blocked",
            "unable to extract",
            "the provided youtube account cookies are no longer valid",
            "this request was detected as a bot",
        ]
    )


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
