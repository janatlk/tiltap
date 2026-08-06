#!/usr/bin/env python3
"""yt-dlp download path for YouTube.

Cobalt cannot get past YouTube's checks any more (see the long trail in
docs/), so YouTube goes through yt-dlp instead. Three pieces are required
together — each alone still fails:

  * cookies from a logged-in account  -> passes the "confirm you're not a bot"
    check during extraction;
  * the EJS challenge solver          -> deciphers signatures and the n
    parameter, without it only storyboard images are offered;
  * Cloudflare WARP as a SOCKS proxy  -> the media fetch from googlevideo
    returns HTTP 403 from datacenter IPs; WARP exits through Cloudflare's
    network, which YouTube treats as ordinary consumer traffic.

Everything is configurable so the setup can be adjusted without a code change.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

YTDLP_BIN = os.environ.get("TILTAB_YTDLP_BIN", "yt-dlp")
PROXY = os.environ.get("TILTAB_YTDLP_PROXY", "socks5://127.0.0.1:40000")
COOKIES = os.environ.get("TILTAB_YTDLP_COOKIES", "/opt/tiltap/data/youtube_cookies.txt")
JS_RUNTIME = os.environ.get("TILTAB_YTDLP_JS_RUNTIME", "node:/usr/bin/node")
TIMEOUT = int(os.environ.get("TILTAB_YTDLP_TIMEOUT_SEC", "900"))
# Must stay well under the caller's idle watchdog (TILTAB_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS).
HEARTBEAT_SEC = int(os.environ.get("TILTAB_YTDLP_HEARTBEAT_SEC", "20"))

# We transcribe at 16 kHz mono, so a high-bitrate stream is wasted bandwidth.
# Prefer something modest and fall back only if nothing small is offered.
FORMAT = os.environ.get(
    "TILTAB_YTDLP_FORMAT", "bestaudio[abr<=80]/bestaudio/best"
)


def is_youtube(url: str) -> bool:
    u = url.lower()
    return "youtube.com" in u or "youtu.be" in u


def available() -> bool:
    """yt-dlp path is only usable when the binary and cookies both exist."""
    return bool(shutil.which(YTDLP_BIN)) and os.path.isfile(COOKIES)


def _build_cmd(url: str, out_template: str, max_bytes: int, cookies_path: str) -> list:
    cmd = [
        YTDLP_BIN,
        "--no-warnings",
        "--no-playlist",
        "--newline",  # progress on its own lines, so it can be parsed
        "--remote-components", "ejs:github",
        "--js-runtimes", JS_RUNTIME,
        "-f", FORMAT,
        "-o", out_template,
    ]
    if PROXY:
        cmd += ["--proxy", PROXY]
    if cookies_path:
        cmd += ["--cookies", cookies_path]
    if max_bytes:
        # yt-dlp aborts before writing anything when the declared size is over
        # the limit; the streaming cap in youtube_cobalt.py covers the case
        # where the size is not declared up front.
        cmd += ["--max-filesize", str(max_bytes)]
    cmd.append(url)
    return cmd


def _disposable_cookies(directory: str) -> str:
    """Return a throwaway copy of the cookie file for yt-dlp to use.

    yt-dlp rewrites its cookie file with whatever session the server hands back
    — including a logged-out one. Cobalt owns the master session and keeps it
    rotating; a second writer on the same session invalidates it for both. So
    yt-dlp only ever reads, through a copy that is discarded afterwards.
    """
    copy_path = os.path.join(directory, "cookies.session.txt")
    shutil.copyfile(COOKIES, copy_path)
    os.chmod(copy_path, 0o600)
    return copy_path


# Enough to tell a real stream from an extraction that succeeds and then serves
# nothing. Mirrors the tunnel probe used for Cobalt instances.
PROBE_BYTES = 16 * 1024
PROBE_TIMEOUT = int(os.environ.get("TILTAB_YTDLP_PROBE_TIMEOUT_SEC", "180"))


def probe(url: str) -> tuple:
    """Health probe for the yt-dlp path. Returns (ok, detail).

    Pulls a few KB of actual media through the full chain (cookies, EJS solver,
    WARP proxy) rather than just resolving a URL: extraction can succeed while
    the media fetch from googlevideo still returns 403, and only bytes tell the
    two apart.
    """
    if not available():
        return False, f"yt-dlp unavailable (bin={YTDLP_BIN}, cookies={COOKIES})"

    workdir = tempfile.mkdtemp(prefix="ytdlp-probe-")
    proc = None
    try:
        cmd = _build_cmd(url, "-", 0, _disposable_cookies(workdir))
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        # The read below blocks, so enforce the deadline by killing the process:
        # that closes the pipe and unblocks us.
        killer = threading.Timer(PROBE_TIMEOUT, proc.kill)
        killer.start()
        try:
            received = 0
            while received < PROBE_BYTES:
                chunk = proc.stdout.read(4096)
                if not chunk:
                    break
                received += len(chunk)
        finally:
            killer.cancel()
            proc.kill()
            err = proc.stderr.read().decode("utf-8", "replace")

        if received >= PROBE_BYTES:
            return True, f"{received} bytes"
        errors = [ln for ln in err.splitlines() if ln.startswith("ERROR:")]
        return False, errors[-1] if errors else f"only {received} bytes"
    except Exception as e:
        if proc:
            proc.kill()
        return False, str(e)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def download_audio(url: str, output_dir: str, progress_cb=None, max_bytes: int = 0) -> str:
    """Download the audio track and return the resulting file path.

    Raises RuntimeError with yt-dlp's own message so the caller can decide
    whether to fall back to Cobalt.
    """
    if not available():
        raise RuntimeError(f"yt-dlp unavailable (bin={YTDLP_BIN}, cookies={COOKIES})")

    session_copy = _disposable_cookies(output_dir)

    out_template = os.path.join(output_dir, "yt_audio.%(ext)s")
    # stderr is merged into stdout on purpose: reading it only after the process
    # exits deadlocks as soon as yt-dlp writes more than one pipe buffer of
    # warnings, and it is chatty about EJS and PO tokens.
    proc = subprocess.Popen(
        _build_cmd(url, out_template, max_bytes, session_copy),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    deadline = time.monotonic() + TIMEOUT
    tail = []
    last_beat = time.monotonic()
    percent = 0.0
    try:
        for line in proc.stdout:
            now = time.monotonic()
            if now > deadline:
                raise subprocess.TimeoutExpired(YTDLP_BIN, TIMEOUT)
            line = line.strip()
            if not line:
                continue
            tail.append(line)
            del tail[:-15]
            if not progress_cb:
                continue

            if line.startswith("[download]") and "%" in line:
                token = line.split("%")[0].split()[-1]
                try:
                    percent = float(token)
                    progress_cb(percent, "Скачиваю с YouTube...")
                    last_beat = now
                except ValueError:
                    pass
            elif now - last_beat >= HEARTBEAT_SEC:
                # Before the transfer starts yt-dlp fetches the player and solves
                # JS challenges, which prints no percentages and can run for
                # minutes. The caller's idle watchdog would kill us as stalled,
                # so keep emitting a beat while the process is clearly alive.
                progress_cb(percent, "Готовлю загрузку...")
                last_beat = now
        proc.wait(timeout=max(1, int(deadline - time.monotonic())))
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)
        raise RuntimeError(f"yt-dlp timed out after {TIMEOUT}s")

    if proc.returncode != 0:
        errors = [ln for ln in tail if ln.startswith("ERROR:")]
        raise RuntimeError(errors[-1] if errors else (tail[-1] if tail else f"yt-dlp exited {proc.returncode}"))

    for name in sorted(os.listdir(output_dir)):
        if name.startswith("yt_audio."):
            return os.path.join(output_dir, name)
    raise RuntimeError("yt-dlp reported success but produced no file: " + "; ".join(tail[-3:]))


if __name__ == "__main__":
    # Health probe (used by the backend monitor): --probe <url> -> JSON on stdout
    if len(sys.argv) >= 3 and sys.argv[1] == "--probe":
        ok, detail = probe(sys.argv[2])
        print(json.dumps({"ok": ok, "detail": detail}), flush=True)
        sys.exit(0)

    # Smoke test: python3 youtube_ytdlp.py <url> <output_dir>
    if len(sys.argv) < 3:
        sys.exit("usage: youtube_ytdlp.py <url> <output_dir> | --probe <url>")
    path = download_audio(
        sys.argv[1], sys.argv[2],
        progress_cb=lambda p, l: print(json.dumps({"percent": p, "label": l}), flush=True),
    )
    print("downloaded:", path, os.path.getsize(path), "bytes")
