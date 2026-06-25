#!/usr/bin/env python3
"""Download YouTube audio for /youtube command with real-time progress."""

import json
import sys
import os
import tempfile
import subprocess
import yt_dlp

from youtube_common import write_cookies_from_env, get_extractor_args, DESKTOP_HEADERS, is_youtube_bot_error
from youtube_cobalt import download_audio_via_cobalt



def emit_progress(percent: int, label: str):
    print(
        json.dumps({"type": "progress", "percent": max(0, min(100, int(percent))), "label": label}, ensure_ascii=False),
        flush=True,
    )


def progress_hook(d):
    if d["status"] == "downloading":
        downloaded = d.get("downloaded_bytes", 0)
        total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
        if total:
            percent = int(100 * downloaded / total)
            emit_progress(percent, "Скачиваю с YouTube...")
    elif d["status"] == "finished":
        emit_progress(95, "Конвертирую аудио...")


def download_audio(url: str, output_path: str, ffmpeg_path: str, cookies_path: str | None = None):
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": output_path.replace(".mp3", ""),
        "ffmpeg_location": ffmpeg_path,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ],
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [progress_hook],
        # Some videos are geo/age restricted; try to bypass geo restrictions.
        "geo_bypass": True,
        # Mimic a real desktop browser to reduce bot detection.
        "http_headers": DESKTOP_HEADERS,
        # Use the BgUtils POT provider plugin + cookies.
        "extractor_args": get_extractor_args(),
    }

    proxy = os.environ.get("YOUTUBE_PROXY", "").strip()
    if proxy:
        ydl_opts["proxy"] = proxy

    if cookies_path and os.path.exists(cookies_path):
        ydl_opts["cookies"] = cookies_path

    emit_progress(5, "Начинаю загрузку...")
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])


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


def _find_audio_file(tmpdir: str):
    """Return the first audio file Cobalt/yt-dlp may have written."""
    for ext in (".mp3", ".m4a", ".webm", ".ogg", ".opus"):
        for f in os.listdir(tmpdir):
            if f.lower().endswith(ext):
                return os.path.join(tmpdir, f)
    return None


def _format_ytdlp_error(e: yt_dlp.utils.DownloadError) -> str:
    msg = str(e)
    if "This video is not available" in msg:
        return "Video is not available (may be private, geo-blocked, or deleted)"
    if "Sign in to confirm" in msg:
        return "YouTube requires sign-in for this video"
    if "Video unavailable" in msg:
        return "Video unavailable"
    if "HTTP Error 403" in msg:
        return "YouTube blocked the download (HTTP 403). Try another video or update yt-dlp."
    return msg


def main():
    if len(sys.argv) < 4:
        print("Usage: download_youtube.py <youtube_url> <ffmpeg_path> <output_wav_path>", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]
    ffmpeg_path = sys.argv[2]
    output_wav = sys.argv[3]

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            cookies_path = write_cookies_from_env(tmpdir)
            mp3_base = os.path.join(tmpdir, "audio")

            try:
                download_audio(url, mp3_base, ffmpeg_path, cookies_path)
            except yt_dlp.utils.DownloadError as e:
                ytdlp_error = _format_ytdlp_error(e)
                if is_youtube_bot_error(str(e)):
                    emit_progress(5, "YouTube заблокировал yt-dlp, пробую Cobalt...")
                    try:
                        download_audio_via_cobalt(
                            url,
                            tmpdir,
                            progress_cb=lambda p, l: emit_progress(int(p * 0.8 + 5), l),
                        )
                    except Exception as ce:
                        raise RuntimeError(
                            f"yt-dlp: {ytdlp_error}; Cobalt fallback: {ce}"
                        ) from ce
                else:
                    raise

            audio_file = _find_audio_file(tmpdir)
            if not audio_file:
                print("Audio file not found after download", file=sys.stderr)
                sys.exit(1)

            convert_to_wav(audio_file, output_wav, ffmpeg_path)
            emit_progress(100, "Аудио готово")
            print(f"Downloaded and converted to {output_wav}")
    except yt_dlp.utils.DownloadError as e:
        print(f"ERROR: {_format_ytdlp_error(e)}", file=sys.stderr)
        sys.exit(1)
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
