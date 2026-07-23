#!/usr/bin/env python3
"""Cobalt API fallback for YouTube audio downloads.

Public Cobalt instances are community-run and may change or break.  This
module rotates through a list of instances so a single broken instance does
not block downloads.
"""

import json
import os
import queue
import sys
import threading
import time

import requests

# Community instances that currently allow unauthenticated downloads (Turnstile
# disabled).  Override with COBALT_API_URL or COBALT_API_URLS (comma-separated).
#
# Since yt-dlp was removed these instances are the ONLY download path, so the
# list is a rotation rather than a single entry: instances break often and
# individually (a healthy instance can still answer relay.all_instances_failed
# for a while).
#
# Last verified 2026-07-23 from the Hetzner host:
#   liubquanti  — YouTube tunnel + full MP3 download OK
#   otomir23    — alive, but YouTube needs login (may still serve tiktok/instagram)
#   canine      — alive, but requires a JWT for YouTube
DEFAULT_COBALT_APIS = [
    "https://api.cobalt.liubquanti.click/",
    "https://co.otomir23.me/",
    "https://cobalt-backend.canine.tools/",
]

COBALT_TIMEOUT = 45
COBALT_VALIDATE_TIMEOUT = int(os.environ.get("COBALT_VALIDATE_TIMEOUT", "12"))
# Per-instance timeout when racing all instances to resolve a link. Kept modest
# so a hanging instance does not keep the (short-lived) process alive for long.
COBALT_RESOLVE_TIMEOUT = int(os.environ.get("COBALT_RESOLVE_TIMEOUT", "20"))
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


def _resolve_one(api: str, payload: dict, timeout: int):
    """Ask one Cobalt instance to resolve a link. Returns (api, resp, data)."""
    resp = requests.post(
        api,
        json=payload,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        timeout=timeout,
    )
    data = {}
    try:
        data = resp.json()
    except Exception:
        pass
    return api, resp, data


def _race_resolve(payload: dict, timeout: int, progress_cb=None):
    """Query all configured Cobalt instances in parallel and return (api, data)
    for the FIRST one that resolves the link to a stream.

    Instances vary a lot in speed and health, and a slow/dead one used to block
    the whole download while it timed out. Racing picks the fastest responder
    per request and never waits on the slow ones.

    Workers run as daemon threads so a request left hanging on a dead instance
    is abandoned at process exit instead of holding the (short-lived) process
    open until its timeout.
    """
    apis = _api_urls()
    if not apis:
        raise RuntimeError("No Cobalt API URLs configured")
    if len(apis) == 1:
        api, resp, data = _resolve_one(apis[0], payload, timeout)
        if resp.ok and data.get("status") in ("tunnel", "redirect") and data.get("url"):
            return apis[0], data
        raise RuntimeError(_cobalt_error_text(data) if data.get("status") == "error" else f"HTTP {resp.status_code}")

    _emit(progress_cb, 8, f"Выбираю быстрейший Cobalt из {len(apis)}...")
    result_q: "queue.Queue" = queue.Queue()
    errors = []
    errors_lock = threading.Lock()

    def worker(api: str):
        try:
            api_, resp, data = _resolve_one(api, payload, timeout)
            if resp.ok and data.get("status") in ("tunnel", "redirect") and data.get("url"):
                result_q.put((api_, data))
                return
            with errors_lock:
                if isinstance(data, dict) and data.get("status") == "error":
                    errors.append(_cobalt_error_text(data))
                else:
                    errors.append(f"{api}: HTTP {getattr(resp, 'status_code', '?')}")
        except Exception as e:  # network error / timeout for this instance
            with errors_lock:
                errors.append(f"{api}: {e}")
        result_q.put(None)

    for api in apis:
        threading.Thread(target=worker, args=(api,), daemon=True).start()

    completed = 0
    deadline = time.time() + timeout + 5
    while completed < len(apis):
        try:
            item = result_q.get(timeout=max(0.1, deadline - time.time()))
        except queue.Empty:
            break
        if item is not None:
            return item  # first valid tunnel = fastest healthy instance
        completed += 1

    raise RuntimeError("; ".join(errors) or "all Cobalt instances failed")


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

    # Race all instances; the fastest to return a working tunnel wins.
    api, data = _race_resolve(payload, COBALT_RESOLVE_TIMEOUT, progress_cb)

    media_url = data.get("url")
    filename = data.get("filename") or "audio.mp3"
    output_path = os.path.join(output_dir, filename)

    _emit(progress_cb, 15, "Скачиваю аудио через Cobalt...")
    _download_media(media_url, output_path)

    if not os.path.exists(output_path) or os.path.getsize(output_path) == 0:
        raise RuntimeError("Cobalt returned an empty audio file")

    _emit(progress_cb, 85, "Обрабатываю аудио...")
    return output_path


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

    # Race all instances; validation succeeds as soon as any one resolves.
    try:
        _race_resolve(payload, COBALT_VALIDATE_TIMEOUT)
        return {"ok": True, "title": "", "duration": 0, "uploader": ""}
    except Exception as e:
        text = str(e).lower()
        reason = "unknown"
        if "jwt" in text or "auth" in text:
            reason = "cobalt_auth_required"
        elif "login" in text:
            reason = "sign_in_required"
        elif "age" in text:
            reason = "age_restricted"
        elif "unavailable" in text or "not.found" in text or "all_instances_failed" in text:
            reason = "not_available"
        elif "bot" in text or "turnstile" in text:
            reason = "bot_detected"
        return {"ok": False, "reason": reason, "error": str(e)}


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
