#!/usr/bin/env python3
"""Validate a YouTube URL before downloading."""

import sys
import json
import socket
import yt_dlp

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
    }
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
        if "This video is not available" in msg:
            reason = "not_available"
        elif "Video unavailable" in msg:
            reason = "not_available"
        elif "Sign in to confirm" in msg:
            reason = "sign_in_required"
        elif "Private video" in msg:
            reason = "private"
        elif "age-restricted" in msg.lower():
            reason = "age_restricted"
        return {"ok": False, "reason": reason, "error": msg}
    except Exception as e:
        return {"ok": False, "reason": "unknown", "error": str(e)}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: validate_youtube.py <youtube_url>", file=sys.stderr)
        sys.exit(1)

    result = validate(sys.argv[1])
    print(json.dumps(result, ensure_ascii=False))
