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
from youtube_cobalt import download_media_via_cobalt, download_picker_item, list_picker_items


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
        """Второй движок. Возвращает None, когда он неприменим.

        Кроме YouTube сюда попадает Facebook: Cobalt разбирает только ссылки
        вида /watch/?v= и /reel/, а кнопка «Поделиться» сегодня даёт share/v/…
        и адреса страниц. У yt-dlp есть и facebook, и facebook:reel, и разбор
        коротких fb.watch — то есть ровно те виды, на которых Cobalt сдаётся.
        """
        if not (youtube_ytdlp.is_youtube(url) or youtube_ytdlp.is_facebook(url)):
            return None
        if not youtube_ytdlp.available(url):
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


def _concat_wavs(parts: list, output_wav: str, ffmpeg_path: str):
    """Склеить несколько записей в одну, разделив секундой тишины.

    Пауза нужна не для красоты: без неё конец одного ролика и начало другого
    сливаются в одно слово, и распознавание выдумывает несуществующее.
    """
    silence = os.path.join(os.path.dirname(parts[0]), "silence.wav")
    subprocess.run([ffmpeg_path, "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
                    "-t", "1", "-c:a", "pcm_s16le", silence],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    listing = os.path.join(os.path.dirname(parts[0]), "parts.txt")
    with open(listing, "w", encoding="utf-8") as f:
        for i, part in enumerate(parts):
            if i:
                f.write("file '%s'\n" % silence)
            f.write("file '%s'\n" % part)
    subprocess.run([ffmpeg_path, "-y", "-f", "concat", "-safe", "0", "-i", listing,
                    "-c", "copy", output_wav],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def download_items(url: str, tmpdir: str, ffmpeg_path: str, output_wav: str, wanted: str):
    """Скачать выбранные видео поста-карусели и свести их в одну запись.

    `wanted` — "all" или номер элемента, как его видел пользователь (с единицы).
    """
    items = list_picker_items(url)
    videos = [i for i in items if i["type"] == "video"]
    if not videos:
        raise RuntimeError("В этом посте не нашлось видео")

    if wanted == "all":
        chosen = videos
    else:
        picked = [v for v in videos if v["index"] == int(wanted)]
        if not picked:
            raise RuntimeError("Такого видео в посте нет")
        chosen = picked

    parts = []
    for n, item in enumerate(chosen, 1):
        emit_progress(int(5 + 70 * (n - 1) / len(chosen)),
                      f"Скачиваю видео {n} из {len(chosen)}..." if len(chosen) > 1 else "Скачиваю запись...")
        raw = download_picker_item(item["url"], tmpdir, f"item{item['index']}.mp4",
                                   max_bytes=VIDEO_FALLBACK_MAX_BYTES)
        wav = os.path.join(tmpdir, f"part{item['index']}.wav")
        convert_to_wav(raw, wav, ffmpeg_path)
        parts.append(wav)
        try:
            os.remove(raw)
        except OSError:
            pass

    emit_progress(85, "Готовлю запись...")
    if len(parts) == 1:
        os.replace(parts[0], output_wav)
    else:
        _concat_wavs(parts, output_wav, ffmpeg_path)


def main():
    # Список вложений поста: download_youtube.py --list <url>
    if len(sys.argv) >= 3 and sys.argv[1] == "--list":
        try:
            items = list_picker_items(sys.argv[2])
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)
            sys.exit(1)
        print(json.dumps({"items": [{"index": i["index"], "type": i["type"]} for i in items]}), flush=True)
        return

    if len(sys.argv) < 4:
        print("Usage: download_youtube.py <media_url> <ffmpeg_path> <output_wav_path> [--item N|--item all]"
              " | --list <media_url>", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]
    ffmpeg_path = sys.argv[2]
    output_wav = sys.argv[3]
    wanted = sys.argv[5] if len(sys.argv) >= 6 and sys.argv[4] == "--item" else None

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            if wanted:
                download_items(url, tmpdir, ffmpeg_path, output_wav, wanted)
                emit_progress(100, "Аудио готово")
                print(f"Downloaded and converted to {output_wav}")
                return

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
