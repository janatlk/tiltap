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
# A tunnel that "succeeds" with a few bytes is a failed instance, not a short
# clip: real audio is orders of magnitude bigger.
MIN_MEDIA_BYTES = 1024


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


def _iter_resolved(payload: dict, timeout: int, progress_cb=None, resolve_errors: list | None = None):
    """Yield (api, data) for every instance that resolves the link, fastest first.

    Resolving is raced because instances vary a lot in speed and a slow/dead one
    used to block the whole download while it timed out. But the race must not
    end the rotation: an instance can hand out a tunnel URL that then streams
    nothing, and a broken instance tends to *win* the race precisely because it
    does no real work. So the slower responders stay available as fallbacks and
    the caller keeps pulling until one actually delivers bytes.

    Workers run as daemon threads so a request left hanging on a dead instance
    is abandoned at process exit instead of holding the (short-lived) process
    open until its timeout.

    Instances that fail to resolve are appended to `resolve_errors` so the caller
    can report them too: when some instances resolve and the download still
    fails, the ones that never got that far are exactly the missing half of the
    picture.
    """
    apis = _api_urls()
    if not apis:
        raise RuntimeError("No Cobalt API URLs configured")

    if len(apis) > 1:
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
                    errors.append(f"{api}: {_cobalt_error_text(data)}")
                else:
                    errors.append(f"{api}: HTTP {getattr(resp, 'status_code', '?')}")
        except Exception as e:  # network error / timeout for this instance
            with errors_lock:
                errors.append(f"{api}: {e}")
        result_q.put(None)

    for api in apis:
        threading.Thread(target=worker, args=(api,), daemon=True).start()

    received = 0
    yielded = 0
    deadline = time.time() + timeout + 5
    while received < len(apis):
        try:
            item = result_q.get(timeout=max(0.1, deadline - time.time()))
        except queue.Empty:
            break
        received += 1
        if item is None:
            continue
        yielded += 1
        yield item
        # The consumer just spent a download's worth of time on the previous
        # candidate; give the remaining workers a fresh window to be collected.
        deadline = time.time() + timeout + 5

    with errors_lock:
        if resolve_errors is not None:
            resolve_errors.extend(errors)
        if yielded == 0:
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

    # Try instances fastest-first and keep going until one actually delivers
    # bytes. Resolving successfully proves nothing: an instance whose YouTube
    # access is blocked still answers with a tunnel that then streams zero bytes.
    errors = []
    resolve_errors: list = []
    for api, data in _iter_resolved(payload, COBALT_RESOLVE_TIMEOUT, progress_cb, resolve_errors):
        media_url = data.get("url")
        # basename: a service-supplied filename must never escape output_dir.
        filename = os.path.basename(data.get("filename") or "") or "audio.mp3"
        output_path = os.path.join(output_dir, filename)

        _emit(progress_cb, 15, "Скачиваю аудио через Cobalt...")
        try:
            _download_media(media_url, output_path)
            size = os.path.getsize(output_path) if os.path.exists(output_path) else 0
            if size < MIN_MEDIA_BYTES:
                raise RuntimeError(f"empty audio file ({size} bytes)")
            _emit(progress_cb, 85, "Обрабатываю аудио...")
            return output_path
        except Exception as e:
            # Leave nothing behind: the caller picks the first media file it
            # finds in this directory, and a truncated carcass would win.
            try:
                os.remove(output_path)
            except OSError:
                pass
            errors.append(f"{api}: {e}")
            _emit(progress_cb, 10, "Инстанс не отдал аудио, пробую следующий...")

    raise RuntimeError("; ".join(errors + resolve_errors) or "all Cobalt instances failed")


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

    # Validation only needs to know the link is resolvable, so the first
    # responder is enough — no download is attempted here.
    try:
        next(_iter_resolved(payload, COBALT_VALIDATE_TIMEOUT))
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
