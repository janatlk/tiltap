#!/usr/bin/env python3
"""Cobalt API fallback for YouTube audio downloads.

Public Cobalt instances are community-run and may change or break.  This
module is intentionally small so we can swap the provider quickly if an
instance stops working.
"""

import json
import os
import sys

import requests

# Default community instance that currently allows unauthenticated YouTube
# audio downloads.  Override with COBALT_API_URL if it breaks.
DEFAULT_COBALT_API = "https://api.cobalt.blackcat.sweeux.org/"

# How long to wait for Cobalt to resolve a stream and for the first bytes.
COBALT_TIMEOUT = 45
DOWNLOAD_TIMEOUT = 300


def _api_url() -> str:
    return os.environ.get("COBALT_API_URL", DEFAULT_COBALT_API).rstrip("/") + "/"


def _emit(progress_cb, percent: int, label: str):
    if progress_cb:
        progress_cb(percent, label)


def _cobalt_error_text(data: dict) -> str:
    err = data.get("error", {})
    code = err.get("code", "unknown")
    context = err.get("context", {})
    service = context.get("service", "unknown")
    return f"Cobalt error: {code} (service: {service})"


def download_audio_via_cobalt(
    youtube_url: str,
    output_dir: str,
    progress_cb=None,
    audio_format: str = "mp3",
):
    """Download a YouTube video's audio track via a Cobalt API instance.

    Returns the path to the downloaded audio file (mp3/m4a/webm depending on
    Cobalt's choice).  Raises RuntimeError on failure.
    """
    api = _api_url()
    payload = {
        "url": youtube_url,
        "downloadMode": "audio",
        "audioFormat": audio_format,
        "filenameStyle": "basic",
    }

    _emit(progress_cb, 5, "Пробую Cobalt API...")

    try:
        resp = requests.post(
            api,
            json=payload,
            headers={"Accept": "application/json", "Content-Type": "application/json"},
            timeout=COBALT_TIMEOUT,
        )
    except requests.RequestException as e:
        raise RuntimeError(f"Cobalt API request failed: {e}") from e

    try:
        data = resp.json()
    except Exception as e:
        raise RuntimeError(f"Cobalt API returned non-JSON ({resp.status_code}): {resp.text[:200]}") from e

    if data.get("status") == "error":
        raise RuntimeError(_cobalt_error_text(data))

    if data.get("status") not in ("tunnel", "redirect"):
        raise RuntimeError(f"Cobalt API unexpected status: {data.get('status')}")

    media_url = data.get("url")
    if not media_url:
        raise RuntimeError("Cobalt API did not return a media URL")

    filename = data.get("filename") or "audio.mp3"
    output_path = os.path.join(output_dir, filename)

    _emit(progress_cb, 15, "Скачиваю аудио через Cobalt...")
    try:
        with requests.get(media_url, stream=True, timeout=DOWNLOAD_TIMEOUT) as dl:
            dl.raise_for_status()
            with open(output_path, "wb") as f:
                for chunk in dl.iter_content(chunk_size=64 * 1024):
                    if chunk:
                        f.write(chunk)
    except requests.RequestException as e:
        raise RuntimeError(f"Cobalt media download failed: {e}") from e

    if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        raise RuntimeError("Cobalt returned an empty audio file")

    _emit(progress_cb, 85, "Конвертирую аудио...")
    return output_path


def validate_via_cobalt(youtube_url: str) -> dict:
    """Validate a YouTube URL by asking Cobalt to resolve it.

    Returns {"ok": True, ...} if Cobalt can produce a stream, otherwise
    {"ok": False, "reason": ..., "error": ...}.
    """
    api = _api_url()
    payload = {
        "url": youtube_url,
        "downloadMode": "audio",
        "audioFormat": "mp3",
    }

    try:
        resp = requests.post(
            api,
            json=payload,
            headers={"Accept": "application/json", "Content-Type": "application/json"},
            timeout=COBALT_TIMEOUT,
        )
    except requests.RequestException as e:
        return {"ok": False, "reason": "network", "error": f"Cobalt API request failed: {e}"}

    try:
        data = resp.json()
    except Exception as e:
        return {"ok": False, "reason": "unknown", "error": f"Cobalt API non-JSON response: {e}"}

    if data.get("status") in ("tunnel", "redirect"):
        return {"ok": True, "title": "", "duration": 0, "uploader": ""}

    if data.get("status") == "error":
        code = data.get("error", {}).get("code", "unknown")
        reason = "unknown"
        if "login" in code.lower():
            reason = "sign_in_required"
        elif "age" in code.lower():
            reason = "age_restricted"
        elif "unavailable" in code.lower() or "not.found" in code.lower():
            reason = "not_available"
        elif "bot" in code.lower() or "turnstile" in code.lower():
            reason = "bot_detected"
        return {"ok": False, "reason": reason, "error": _cobalt_error_text(data)}

    return {"ok": False, "reason": "unknown", "error": f"Cobalt unexpected status: {data.get('status')}"}


if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else "https://www.youtube.com/watch?v=kJQP7kiw5Fk"
    result = validate_via_cobalt(url)
    print(json.dumps(result, ensure_ascii=False))
