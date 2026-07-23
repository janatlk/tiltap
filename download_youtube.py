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


def download(url: str, tmpdir: str):
    """Fetch the media via Cobalt, preferring an audio-only stream.

    Not every service supports downloadMode=audio, so fall back to the full
    media file and let ffmpeg strip the audio track afterwards.
    """
    def report(p, label):
        emit_progress(int(p * 0.8 + 5), label)

    try:
        return download_media_via_cobalt(url, tmpdir, progress_cb=report, download_mode="audio")
    except Exception as audio_error:
        emit_progress(5, "Аудиопоток недоступен, скачиваю видео...")
        try:
            return download_media_via_cobalt(url, tmpdir, progress_cb=report, download_mode="auto")
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
            emit_progress(5, "Скачиваю через Cobalt...")
            download(url, tmpdir)

            media_file = _find_media_file(tmpdir)
            if not media_file:
                print("ERROR: Cobalt did not produce a media file", file=sys.stderr)
                sys.exit(1)

            convert_to_wav(media_file, output_wav, ffmpeg_path)
            emit_progress(100, "Аудио готово")
            print(f"Downloaded and converted to {output_wav}")
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
