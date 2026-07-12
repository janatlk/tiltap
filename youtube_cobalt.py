#!/usr/bin/env python3
"""Cobalt API fallback for YouTube audio downloads.

Public Cobalt instances are community-run and may change or break.  This
module rotates through a list of instances so a single broken instance does
not block downloads.
"""

import json
import os
import sys

import requests

# Community instances that currently allow unauthenticated YouTube audio
# downloads (Turnstile disabled).  Override with COBALT_API_URL or
# COBALT_API_URLS (comma-separated).
# Last verified: api.cobalt.liubquanti.click returns tunnels for YouTube
# from Hetzner; most other public instances now require JWT or are blocked.
DEFAULT_COBALT_APIS = [
    "https://api.cobalt.liubquanti.click/",
]

COBALT_TIMEOUT = 45
COBALT_VALIDATE_TIMEOUT = int(os.environ.get("COBALT_VALIDATE_TIMEOUT", "12"))
DOWNLOAD_TIMEOUT = 300


def _api_urls() -> list[str]:
    """Return the list of Cobalt API URLs to try."""
    env_urls = os.environ.get("COBALT_API_URLS", "").strip()
    if env_urls:
        return [u.strip().rstrip("/") + "/" for u in env_urls.split(",") if u.strip()]
    single = os.environ.get("COBALT_API_URL", "").strip()
    if single:
        return [single.rstrip("/") + "/"]
    return [u.rstrip("/") + "/" for u in DEFAULT_COBALT_APIS]


def _emit(progress_cb, percent: int, label: str):
    if progress_cb:
        progress_cb(percent, label)


def _cobalt_error_text(data: dict) -> str:
    err = data.get("error", {})
    code = err.get("code", "unknown")
    context = err.get("context", {})
    service = context.get("service", "unknown")
    return f"Cobalt error: {code} (service: {service})"


def _request_stream(url: str, payload: dict, timeout: int | None = None) -> dict:
    """POST to a Cobalt API and return the JSON response."""
    resp = requests.post(
        url,
        json=payload,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        timeout=timeout if timeout is not None else COBALT_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


def _download_media(media_url: str, output_path: str):
    """Download a media file from a Cobalt tunnel/redirect URL."""
    with requests.get(media_url, stream=True, timeout=DOWNLOAD_TIMEOUT) as dl:
        dl.raise_for_status()
        with open(output_path, "wb") as f:
            for chunk in dl.iter_content(chunk_size=64 * 1024):
                if chunk:
                    f.write(chunk)


def download_media_via_cobalt(
    url: str,
    output_dir: str,
    progress_cb=None,
    download_mode: str = "audio",
    audio_format: str = "mp3",
):
    """Download media via a Cobalt API instance.

    Tries each configured Cobalt URL in order.  Returns the path to the
    downloaded file.  Raises RuntimeError if all instances fail.
    """
    payload = {
        "url": url,
        "downloadMode": download_mode,
        "filenameStyle": "basic",
    }
    if download_mode == "audio":
        payload["audioFormat"] = audio_format

    last_error = "No Cobalt API URLs configured"
    for api in _api_urls():
        try:
            _emit(progress_cb, 5, f"Пробую Cobalt ({api})...")
            data = _request_stream(api, payload)

            if data.get("status") == "error":
                last_error = _cobalt_error_text(data)
                continue

            if data.get("status") not in ("tunnel", "redirect"):
                last_error = f"Cobalt unexpected status: {data.get('status')}"
                continue

            media_url = data.get("url")
            if not media_url:
                last_error = "Cobalt API did not return a media URL"
                continue

            filename = data.get("filename") or "audio.mp3"
            output_path = os.path.join(output_dir, filename)

            _emit(progress_cb, 15, "Скачиваю аудио через Cobalt...")
            _download_media(media_url, output_path)

            if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
                last_error = "Cobalt returned an empty audio file"
                continue

            _emit(progress_cb, 85, "Обрабатываю аудио...")
            return output_path
        except requests.RequestException as e:
            last_error = f"Cobalt API request failed ({api}): {e}"
        except Exception as e:
            last_error = f"Cobalt error ({api}): {e}"

    raise RuntimeError(last_error)


def validate_via_cobalt(url: str, download_mode: str = "auto") -> dict:
    """Validate a media URL by asking Cobalt to resolve it.

    Returns {"ok": True, ...} if any instance can produce a stream, otherwise
    {"ok": False, "reason": ..., "error": ...}.
    """
    payload = {
        "url": url,
        "downloadMode": download_mode,
    }
    if download_mode == "audio":
        payload["audioFormat"] = "mp3"

    last_error = "No Cobalt API URLs configured"
    for api in _api_urls():
        try:
            # Use a short timeout for validation so a single slow/dead instance
            # does not exhaust the caller's timeout budget.
            resp = requests.post(
                api,
                json=payload,
                headers={"Accept": "application/json", "Content-Type": "application/json"},
                timeout=COBALT_VALIDATE_TIMEOUT,
            )

            # Try to parse Cobalt's JSON error body even on 4xx/5xx.
            try:
                data = resp.json()
            except Exception:
                data = {}

            if resp.ok and data.get("status") in ("tunnel", "redirect"):
                return {"ok": True, "title": "", "duration": 0, "uploader": ""}

            if data.get("status") == "error" or not resp.ok:
                code = data.get("error", {}).get("code", "unknown") if data.get("error") else f"http_{resp.status_code}"
                reason = "unknown"
                if "jwt" in code.lower() or "auth" in code.lower():
                    reason = "cobalt_auth_required"
                elif "login" in code.lower():
                    reason = "sign_in_required"
                elif "age" in code.lower():
                    reason = "age_restricted"
                elif "unavailable" in code.lower() or "not.found" in code.lower() or "all_instances_failed" in code.lower():
                    reason = "not_available"
                elif "bot" in code.lower() or "turnstile" in code.lower():
                    reason = "bot_detected"
                last_error = _cobalt_error_text(data) if data.get("error") else f"HTTP {resp.status_code}"
                # Surface the Cobalt reason instead of hiding it behind unknown.
                if reason != "unknown":
                    return {"ok": False, "reason": reason, "error": last_error}
                continue

            last_error = f"Cobalt unexpected status: {data.get('status')}"
        except requests.Timeout as e:
            last_error = f"Cobalt API timed out ({api}): {e}"
        except requests.RequestException as e:
            last_error = f"Cobalt API request failed ({api}): {e}"
        except Exception as e:
            last_error = f"Cobalt error ({api}): {e}"

    return {"ok": False, "reason": "unknown", "error": last_error}


def download_audio_via_cobalt(
    youtube_url: str,
    output_dir: str,
    progress_cb=None,
    audio_format: str = "mp3",
):
    """Backward-compatible wrapper for YouTube audio downloads."""
    return download_media_via_cobalt(
        youtube_url, output_dir, progress_cb, download_mode="audio", audio_format=audio_format
    )


if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else "https://www.youtube.com/watch?v=kJQP7kiw5Fk"
    result = validate_via_cobalt(url)
    print(json.dumps(result, ensure_ascii=False))
