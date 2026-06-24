#!/usr/bin/env python3
"""Download YouTube audio for /youtube command with real-time progress."""

import json
import sys
import os
import tempfile
import subprocess
import shutil
import yt_dlp


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


def download_audio(url: str, output_path: str, ffmpeg_path: str):
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
        # Try multiple player clients to avoid 403 Forbidden
        "extractor_args": {
            "youtube": {
                "player_client": ["web", "android", "ios"],
                "player_skip": ["webpage", "configs", "js"],
            }
        },
        # Mimic a real browser
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        },
    }

    # Use Node.js as JS runtime to bypass YouTube's bot checks when available.
    node_path = shutil.which("node") or (
        r"C:\Program Files\nodejs\node.exe" if sys.platform == "win32" else None
    )
    if node_path and os.path.exists(node_path):
        ydl_opts["js_runtime"] = node_path
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


def main():
    if len(sys.argv) < 4:
        print("Usage: download_youtube.py <youtube_url> <ffmpeg_path> <output_wav_path>", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]
    ffmpeg_path = sys.argv[2]
    output_wav = sys.argv[3]

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            mp3_base = os.path.join(tmpdir, "audio")
            download_audio(url, mp3_base, ffmpeg_path)

            # Find the downloaded mp3 file
            mp3_file = None
            for f in os.listdir(tmpdir):
                if f.endswith(".mp3"):
                    mp3_file = os.path.join(tmpdir, f)
                    break

            if not mp3_file:
                print("MP3 not found after download", file=sys.stderr)
                sys.exit(1)

            convert_to_wav(mp3_file, output_wav, ffmpeg_path)
            emit_progress(100, "Аудио готово")
            print(f"Downloaded and converted to {output_wav}")
    except yt_dlp.utils.DownloadError as e:
        # Extract a clean error message for the user
        msg = str(e)
        if "This video is not available" in msg:
            print("ERROR: Video is not available (may be private, geo-blocked, or deleted)", file=sys.stderr)
        elif "Sign in to confirm" in msg:
            print("ERROR: YouTube requires sign-in for this video", file=sys.stderr)
        elif "Video unavailable" in msg:
            print("ERROR: Video unavailable", file=sys.stderr)
        elif "HTTP Error 403" in msg:
            print("ERROR: YouTube blocked the download (HTTP 403). Try another video or update yt-dlp.", file=sys.stderr)
        else:
            print(f"ERROR: {msg}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
