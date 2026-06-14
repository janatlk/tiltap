#!/usr/bin/env python3
"""Build local test audio fixtures from Folkways phrasebooks.

Generates one 16 kHz mono WAV per supported language in ./test_audio/
and a manifest.json describing reference transcripts.
"""

from __future__ import annotations

import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import List, Tuple
from urllib.request import Request, urlopen

PROJECT_ROOT = Path(__file__).resolve().parent.parent
TEST_DIR = PROJECT_ROOT / "test_audio"
CACHE_DIR = TEST_DIR / "cache"

PHRASEBOOKS = {
    "ky": {
        "url": "https://folkways.today/the-talking-kyrgyz-phrasebook/",
        "title": "Кыргызча фразбук — 15 фраз",
    },
    "tg": {
        "url": "https://folkways.today/tajik-talking-phrasebook/",
        "title": "Тоҷикӣ фразбук — 15 фраз",
    },
    "uz": {
        "url": "https://folkways.today/the-talking-uzbek-phrasebook/",
        "title": "O'zbekcha phrasebook — 15 ta ibora",
    },
    "ru": {
        "url": "https://folkways.today/talking-russian-phrasebook/",
        "title": "Русский разговорник — 15 фраз",
    },
}

ENGLISH_FROM_LANG = "ru"
MAX_PHRASES = 10


def http_get_text(url: str) -> str:
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 (TilTap fixture builder)"})
    with urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8")


def http_download(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 (TilTap fixture builder)"})
    with urlopen(req, timeout=120) as resp, open(dest, "wb") as f:
        shutil.copyfileobj(resp, f)


def strip_tags(text: str) -> str:
    return re.sub(r"<[^>]+>", " ", text)


def clean_cell(text: str) -> str:
    text = html.unescape(text)
    text = strip_tags(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def contains_cyrillic(text: str) -> bool:
    return bool(re.search(r"[\u0400-\u04FF]", text))


def extract_cyrillic_or_full(text: str) -> str:
    """Return Cyrillic text inside parentheses, or the full text if none."""
    matches = re.findall(r"\(([^)]+)\)", text)
    cyrillic_matches = [clean_cell(m) for m in matches if contains_cyrillic(m)]
    if cyrillic_matches:
        return " ".join(cyrillic_matches)
    return clean_cell(text)


def extract_english_text(text: str) -> str:
    return clean_cell(text)


def find_mp3_url(row_html: str) -> str | None:
    m = re.search(r'<source[^>]+src="([^"]+\.mp3)', row_html)
    if not m:
        m = re.search(r'<a[^>]+href="([^"]+\.mp3)', row_html)
    if m:
        return m.group(1).split("?")[0]
    return None


def parse_phrasebook_rows(lang: str) -> List[Tuple[str, str, str]]:
    """Return list of (english_text, mp3_url, target_text)."""
    cfg = PHRASEBOOKS[lang]
    html_text = http_get_text(cfg["url"])
    rows = re.findall(r"<tr[^>]*>.*?</tr>", html_text, re.DOTALL)
    results: List[Tuple[str, str, str]] = []
    for row in rows:
        mp3 = find_mp3_url(row)
        if not mp3:
            continue
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.DOTALL)
        if len(cells) < 3:
            continue
        english = extract_english_text(cells[0])
        target = extract_cyrillic_or_full(cells[2])
        if not english or not target:
            continue
        results.append((english, mp3, target))
        if len(results) >= MAX_PHRASES:
            break
    return results


def ffmpeg_path() -> Path:
    try:
        static = subprocess.check_output(
            ["node", "-e", "console.log(require('ffmpeg-static'))"],
            cwd=PROJECT_ROOT,
            text=True,
        ).strip()
        return Path(static)
    except Exception as exc:
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg:
            return Path(ffmpeg)
        raise RuntimeError("ffmpeg not found") from exc


def detect_first_speech_segment(ffmpeg: Path, mp3: Path) -> Tuple[float, float]:
    """Return (start, end) of the first continuous speech segment in seconds."""
    cmd = [
        str(ffmpeg),
        "-i",
        str(mp3),
        "-af",
        "silencedetect=noise=-40dB:d=0.15",
        "-f",
        "null",
        "-",
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    silence_starts: List[float] = []
    silence_ends: List[float] = []
    for line in out.stderr.splitlines():
        m = re.search(r"silence_start:\s*([\d.]+)", line)
        if m:
            silence_starts.append(float(m.group(1)))
        m = re.search(r"silence_end:\s*([\d.]+)", line)
        if m:
            silence_ends.append(float(m.group(1)))

    if silence_ends:
        start = silence_ends[0]
        end_candidates = [s for s in silence_starts if s > start]
        end = end_candidates[0] if end_candidates else start + 2.0
        return start, end
    return 0.0, 2.0


def convert_and_concat(
    ffmpeg: Path,
    mp3s: List[Path],
    out_wav: Path,
    trim_segments: List[Tuple[float, float]] | None = None,
) -> None:
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    temp_wavs: List[Path] = []
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        for idx, mp3 in enumerate(mp3s):
            wav = tmpdir / f"{idx:03d}.wav"
            trim = trim_segments[idx] if trim_segments else None
            trim_args: List[str] = []
            if trim:
                start, end = trim
                duration = max(0.1, end - start)
                trim_args = ["-ss", str(start), "-t", str(duration)]
            subprocess.run(
                [
                    str(ffmpeg),
                    "-y",
                    *trim_args,
                    "-i",
                    str(mp3),
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    "-c:a",
                    "pcm_s16le",
                    str(wav),
                ],
                check=True,
                capture_output=True,
                text=True,
                encoding="utf-8",
            )
            temp_wavs.append(wav)

        list_file = tmpdir / "concat.txt"
        with open(list_file, "w", encoding="utf-8") as f:
            for wav in temp_wavs:
                f.write(f"file '{wav.as_posix()}'\n")

        subprocess.run(
            [
                str(ffmpeg),
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(list_file),
                "-c",
                "copy",
                str(out_wav),
            ],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )


def build_fixture(
    ffmpeg: Path, lang: str, rows: List[Tuple[str, str, str]], english_only: bool = False
) -> dict:
    cfg = PHRASEBOOKS[lang]
    cache = CACHE_DIR / lang
    cache.mkdir(parents=True, exist_ok=True)
    mp3s: List[Path] = []
    references: List[str] = []
    trim_segments: List[Tuple[float, float]] | None = [] if english_only else None

    for idx, (english, mp3_url, target) in enumerate(rows):
        mp3_name = f"{idx:03d}_{Path(mp3_url).name}"
        mp3_dest = cache / mp3_name
        http_download(mp3_url, mp3_dest)
        mp3s.append(mp3_dest)
        if english_only:
            references.append(english)
            start, end = detect_first_speech_segment(ffmpeg, mp3_dest)
            trim_segments.append((start, end))
        else:
            references.append(target)

    suffix = "_en" if english_only else ""
    out_wav = TEST_DIR / f"{lang}{suffix}.wav"
    convert_and_concat(ffmpeg, mp3s, out_wav, trim_segments)

    title = cfg["title"]
    if english_only:
        title = "English phrases — " + title

    return {
        "language": "en" if english_only else lang,
        "title": title,
        "wavPath": str(out_wav.relative_to(PROJECT_ROOT).as_posix()),
        "referenceText": " ".join(references),
        "source": "local",
        "phraseCount": len(rows),
    }


def get_duration(ffmpeg: Path, wav: Path) -> float:
    cmd = [str(ffmpeg), "-i", str(wav), "-f", "null", "-"]
    out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    m = re.search(r"Duration:\s+(\d+):(\d+):([\d.]+)", out.stderr)
    if m:
        h, m_, s = map(float, m.groups())
        return h * 3600 + m_ * 60 + s
    return 0.0


def main() -> int:
    ffmpeg = ffmpeg_path()
    print(f"Using ffmpeg: {ffmpeg}")

    manifest: dict = {"fixtures": {}}

    for lang in ("ky", "tg", "uz", "ru"):
        print(f"\nBuilding {lang} fixture...")
        rows = parse_phrasebook_rows(lang)
        if not rows:
            print(f"No rows found for {lang}; skipping", file=sys.stderr)
            continue
        fixture = build_fixture(ffmpeg, lang, rows, english_only=False)
        fixture["durationSeconds"] = round(get_duration(ffmpeg, PROJECT_ROOT / fixture["wavPath"]), 2)
        manifest["fixtures"][lang] = fixture
        print(f"  -> {fixture['wavPath']} ({fixture['durationSeconds']}s, {fixture['phraseCount']} phrases)")

    # English fixture is derived from the Russian phrasebook's English prompts.
    print("\nBuilding en fixture from Russian phrasebook English segments...")
    ru_rows = parse_phrasebook_rows(ENGLISH_FROM_LANG)
    en_fixture = build_fixture(ffmpeg, ENGLISH_FROM_LANG, ru_rows, english_only=True)
    en_fixture["durationSeconds"] = round(
        get_duration(ffmpeg, PROJECT_ROOT / en_fixture["wavPath"]), 2
    )
    manifest["fixtures"]["en"] = en_fixture
    print(f"  -> {en_fixture['wavPath']} ({en_fixture['durationSeconds']}s, {en_fixture['phraseCount']} phrases)")

    manifest_path = TEST_DIR / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"\nManifest written to {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
