#!/usr/bin/env python3
"""Validate a YouTube URL before downloading."""

import sys
import json
import socket
import os
import signal
import tempfile
import yt_dlp

from urllib.parse import urlparse

from youtube_common import get_cookies_path, get_extractor_args, cleanup_temp_cookies, DESKTOP_HEADERS, is_youtube_bot_error
from youtube_cobalt import validate_via_cobalt


# Hard timeout so we never hang forever on slow/unreachable URLs
socket.setdefaulttimeout(15)

# Absolute wall-clock limit for the whole validation step (yt-dlp can still
# spend a lot of time retrying player clients/manifests even with the socket
# timeout).  This must be shorter than the Node timeout so the process returns
# a reason instead of being killed mid-flight.
VALIDATION_TIMEOUT_SECONDS = 20


class ValidationTimeout(Exception):
    pass


def _timeout_handler(signum, frame):
    raise ValidationTimeout()


def _is_youtube_domain(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    return any(d in host for d in ("youtube.com", "youtu.be", "youtube-nocookie.com"))


def _extract_live_status(info) -> str | None:
    """Return 'live_stream' if the URL points to an active/upcoming live stream."""
    if not info:
        return None
    if info.get("is_live"):
        return "live_stream"
    live_status = info.get("live_status")
    if live_status in ("is_live", "is_upcoming"):
        return "live_stream"
    return None


def _validate(url: str):
    opts = {
        "quiet": True,
        "simulate": True,
        "no_warnings": True,
        # Skip expensive metadata extraction where possible
        "skip_download": True,
        "extract_flat": False,
        "noplaylist": True,
        "playlist_items": "1",
        "geo_bypass": True,
        # Mimic a real desktop browser to reduce bot detection.
        "http_headers": DESKTOP_HEADERS,
        # Use the BgUtils POT provider plugin + cookies.
        "extractor_args": get_extractor_args(),
    }

    proxy = os.environ.get("YOUTUBE_PROXY", "").strip()
    if proxy:
        opts["proxy"] = proxy

    cookies_path = get_cookies_path()
    if cookies_path:
        opts["cookies"] = cookies_path

    try:
        # For non-YouTube platforms (TikTok, Instagram, etc.) go straight to Cobalt.
        if not _is_youtube_domain(url):
            cobalt = validate_via_cobalt(url, download_mode="auto")
            if cobalt["ok"]:
                return {"ok": True, "title": "", "duration": 0, "uploader": ""}
            return {"ok": False, "reason": cobalt.get("reason", "unknown"), "error": cobalt.get("error", "unknown")}

        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if not info:
                return {"ok": False, "reason": "unknown", "error": "No metadata returned"}

            live_status = _extract_live_status(info)
            if live_status == "live_stream":
                return {"ok": False, "reason": "live_stream", "error": "Live streams cannot be transcribed"}

            return {
                "ok": True,
                "title": info.get("title", ""),
                "duration": info.get("duration") or 0,
                "uploader": info.get("uploader", ""),
            }
    except yt_dlp.utils.DownloadError as e:
        msg = str(e)
        reason = "unknown"
        lower = msg.lower()
        if any(s in lower for s in ["this video is not available", "video unavailable", "this video is unavailable"]):
            reason = "not_available"
        elif "sign in to confirm" in lower or "sign in to view" in lower:
            reason = "sign_in_required"
        elif "private video" in lower:
            reason = "private"
        elif "age-restricted" in lower:
            reason = "age_restricted"
        elif "login" in lower or "logged in" in lower:
            reason = "sign_in_required"

        # If yt-dlp is blocked by bot detection, ask a Cobalt instance instead.
        if is_youtube_bot_error(msg):
            cobalt = validate_via_cobalt(url)
            if cobalt["ok"]:
                return {"ok": True, "title": "", "duration": 0, "uploader": ""}
            return {"ok": False, "reason": cobalt.get("reason", reason), "error": f"yt-dlp: {msg}; Cobalt: {cobalt.get('error', 'unknown')}"}

        return {"ok": False, "reason": reason, "error": msg}
    except Exception as e:
        return {"ok": False, "reason": "unknown", "error": str(e)}
    finally:
        cleanup_temp_cookies(cookies_path)


def validate(url: str):
    """Run _validate with a hard wall-clock timeout."""
    has_alarm = hasattr(signal, "SIGALRM") and hasattr(signal, "alarm")
    old_handler = None
    if has_alarm:
        old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
        signal.alarm(VALIDATION_TIMEOUT_SECONDS)

    try:
        return _validate(url)
    except ValidationTimeout:
        return {"ok": False, "reason": "timeout", "error": "Validation timed out"}
    finally:
        if has_alarm:
            signal.alarm(0)
            if old_handler is not None:
                signal.signal(signal.SIGALRM, old_handler)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: validate_youtube.py <youtube_url>", file=sys.stderr)
        sys.exit(1)

    result = validate(sys.argv[1])
    print(json.dumps(result, ensure_ascii=False))
