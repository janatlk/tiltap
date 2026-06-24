#!/usr/bin/env python3
"""Validate a YouTube URL before downloading."""

import sys
import json
import socket
import os
import tempfile
import yt_dlp

from youtube_common import get_cookies_path, get_extractor_args, cleanup_temp_cookies

# Hard timeout so we never hang forever on slow/unreachable URLs
socket.setdefaulttimeout(15)


def validate(url: str):
    opts = {
        "quiet": True,
        "simulate": True,
        "no_warnings": True,
        # Skip expensive metadata extraction where possible
        "skip_download": True,
        "format": "worstaudio/worst",
        "extract_flat": False,
        "playlist_items": "1",
        "geo_bypass": True,
        # Prefer mobile/TV clients and inject PO token / visitor_data if set.
        "extractor_args": get_extractor_args(),
    }

    proxy = os.environ.get("YOUTUBE_PROXY", "").strip()
    if proxy:
        opts["proxy"] = proxy

    cookies_path = get_cookies_path()
    if cookies_path:
        opts["cookies"] = cookies_path

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if not info:
                return {"ok": False, "reason": "unknown", "error": "No metadata returned"}
            return {
                "ok": True,
                "title": info.get("title", ""),
                "duration": info.get("duration", 0),
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
        return {"ok": False, "reason": reason, "error": msg}
    except Exception as e:
        return {"ok": False, "reason": "unknown", "error": str(e)}
    finally:
        cleanup_temp_cookies(cookies_path)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: validate_youtube.py <youtube_url>", file=sys.stderr)
        sys.exit(1)

    result = validate(sys.argv[1])
    print(json.dumps(result, ensure_ascii=False))
