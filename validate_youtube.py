#!/usr/bin/env python3
"""Validate a media URL (YouTube, TikTok, Instagram) before downloading.

yt-dlp was removed in July 2026 — see download_youtube.py for the reason.
Validation now means: can any configured Cobalt instance resolve this link to a
stream? Cobalt does not return metadata, so title/duration come back empty and
the caller must not depend on them.
"""

import json
import os
import signal
import socket
import sys

import youtube_ytdlp
from youtube_cobalt import validate_via_cobalt

# Hard timeout so we never hang forever on slow/unreachable URLs
socket.setdefaulttimeout(15)

# Absolute wall-clock limit for the whole validation step. Must stay shorter
# than the Node-side timeout so the process returns a reason instead of being
# killed mid-flight.
VALIDATION_TIMEOUT_SECONDS = int(os.environ.get("TILTAB_VALIDATION_TIMEOUT_SEC", "45"))


class ValidationTimeout(Exception):
    pass


def _timeout_handler(signum, frame):
    raise ValidationTimeout()


def _validate(url: str):
    # YouTube проверяем тем же движком, которым и качаем. Cobalt на нём
    # отвечает «нужен вход» и отклоняет живые ссылки, до скачивания дело даже
    # не доходило. Cobalt остаётся запасным: вдруг у yt-dlp свой сбой.
    if youtube_ytdlp.is_youtube(url) and youtube_ytdlp.available(url):
        ytdlp = youtube_ytdlp.validate(url)
        if ytdlp.get("ok"):
            return ytdlp
        if ytdlp.get("reason") in ("private", "age_restricted", "live_stream", "not_available"):
            return ytdlp

    cobalt = validate_via_cobalt(url, download_mode="auto")
    if cobalt["ok"]:
        return {"ok": True, "title": "", "duration": 0, "uploader": ""}
    return {
        "ok": False,
        "reason": cobalt.get("reason", "unknown"),
        "error": cobalt.get("error", "unknown"),
    }


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
    except Exception as e:
        return {"ok": False, "reason": "unknown", "error": str(e)}
    finally:
        if has_alarm:
            signal.alarm(0)
            if old_handler is not None:
                signal.signal(signal.SIGALRM, old_handler)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: validate_youtube.py <media_url>", file=sys.stderr)
        sys.exit(1)

    result = validate(sys.argv[1])
    print(json.dumps(result, ensure_ascii=False))
