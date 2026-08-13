#!/usr/bin/env python3
"""Download audio from a media link (YouTube, TikTok, Instagram) via Cobalt.

yt-dlp was removed in July 2026: on the Hetzner datacenter IP YouTube blocked it
on essentially every request ("Sign in to confirm you're not a bot"), so the
fallback path became the only path. Cobalt is now the single downloader.
"""

import json
import os
import subprocess
import sys
import tempfile

import youtube_ytdlp
from youtube_cobalt import download_media_via_cobalt


def emit_progress(percent: int, label: str):
    print(
        json.dumps({"type": "progress", "percent": max(0, min(100, int(percent))), "label": label}, ensure_ascii=False),
        flush=True,
    )


def convert_to_wav(input_path: str, output_path: str, ffmpeg_path: str):
    cmd = [
        ffmpeg_path,
        "-y",
        "-i", input_path,
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        output_path,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _find_media_file(tmpdir: str):
    """Return the first media file Cobalt wrote."""
    for ext in (".mp3", ".m4a", ".webm", ".ogg", ".opus", ".mp4", ".mov", ".mkv", ".flv"):
        for f in os.listdir(tmpdir):
            if f.lower().endswith(ext):
                return os.path.join(tmpdir, f)
    return None


def _mb_env(name: str, default_mb: int) -> int:
    try:
        return max(0, int(os.environ.get(name, default_mb))) * 1024 * 1024
    except ValueError:
        return default_mb * 1024 * 1024


# An hour of speech is roughly 60 MB of audio, so 400 MB is generous for the
# audio path. The video fallback is capped far tighter: it downloads the whole
# file only to throw the picture away, and it is the one path that can turn a
# single link into gigabytes of (on a metered proxy, billed) traffic.
AUDIO_MAX_BYTES = _mb_env("TILTAB_AUDIO_MAX_MB", 400)
VIDEO_FALLBACK_MAX_BYTES = _mb_env("TILTAB_VIDEO_FALLBACK_MAX_MB", 150)
VIDEO_FALLBACK_ENABLED = os.environ.get("TILTAB_VIDEO_FALLBACK", "1").lower() not in (
    "0",
    "false",
    "no",
    "off",
)


def download(url: str, tmpdir: str):
    """Fetch the media, preferring an audio-only stream.

    Cobalt is the primary engine for every service: it is our own instance, it
    answers in seconds, and it keeps its own cache. yt-dlp is the fallback for
    YouTube — it works too, but pays a minutes-long startup cost solving JS
    challenges, so it is not worth spending on every request.

    Not every service supports downloadMode=audio, so fall back to the full
    media file and let ffmpeg strip the audio track afterwards. Both paths are
    size-capped; see the constants above for why the fallback is the strict one.
    """
    def report(p, label):
        emit_progress(int(p * 0.8 + 5), label)

    def try_ytdlp(reason: str):
        """Second engine, YouTube only. Returns None when it is not usable."""
        if not (youtube_ytdlp.is_youtube(url) and youtube_ytdlp.available()):
            return None
        print(f"[download] Cobalt failed ({reason}); trying yt-dlp", file=sys.stderr, flush=True)
        try:
            return youtube_ytdlp.download_audio(
                url, tmpdir, progress_cb=report, max_bytes=AUDIO_MAX_BYTES
            )
        except Exception as ytdlp_error:
            print(f"[download] yt-dlp also failed: {ytdlp_error}", file=sys.stderr, flush=True)
            return None

    try:
        return download_media_via_cobalt(
            url, tmpdir, progress_cb=report, download_mode="audio",
            max_bytes=AUDIO_MAX_BYTES,
        )
    except Exception as audio_error:
        result = try_ytdlp(str(audio_error))
        if result:
            return result
        if not VIDEO_FALLBACK_ENABLED:
            raise RuntimeError(f"audio mode failed and video fallback is disabled: {audio_error}")
        emit_progress(5, "Скачиваю видео...")
        try:
            return download_media_via_cobalt(
                url, tmpdir, progress_cb=report, download_mode="auto",
                max_bytes=VIDEO_FALLBACK_MAX_BYTES,
            )
        except Exception as auto_error:
            raise RuntimeError(f"audio mode: {audio_error}; auto mode: {auto_error}") from auto_error


def main():
    if len(sys.argv) < 4:
        print("Usage: download_youtube.py <media_url> <ffmpeg_path> <output_wav_path>", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]
    ffmpeg_path = sys.argv[2]
    output_wav = sys.argv[3]

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            emit_progress(5, "Скачиваю запись...")
            download(url, tmpdir)

            media_file = _find_media_file(tmpdir)
            if not media_file:
                print("ERROR: Cobalt did not produce a media file", file=sys.stderr)
                sys.exit(1)

            emit_progress(90, "Готовлю запись...")
            convert_to_wav(media_file, output_wav, ffmpeg_path)
            emit_progress(100, "Аудио готово")
            print(f"Downloaded and converted to {output_wav}")
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
