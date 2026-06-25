#!/usr/bin/env python3
"""Send local audio files to Groq Whisper and save raw STT text."""

import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

# Make stdout UTF-8 safe on Windows.
sys.stdout.reconfigure(encoding="utf-8")

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
if not GROQ_API_KEY:
    print("GROQ_API_KEY not found in .env", file=sys.stderr)
    sys.exit(1)

URL = "https://api.groq.com/openai/v1/audio/transcriptions"

# Use Windows-native paths because the script runs under Windows Python.
FILES = [
    ("ky", "C:/Users/janat/Downloads/Климаттын өзгөрүүсү_ Гутерреш дүйнөнү шашылыш чараларды көрүүгө чакырды - Би-Би-Си ТВ 23.06.26.mp3"),
    ("uz", "C:/Users/janat/Downloads/Қуддусдаги Ал-Ақсо масжиди  кимники бўлади_ - BBC News O'zbek.mp3"),
    ("en", "C:/Users/janat/Downloads/larpPixel reacts to ohnePixel.mp3"),
    ("ru", "C:/Users/janat/Downloads/НОВАЯ ВЕРСИЯ МАЙНКРАФТА - 1.48.8.mp3"),
]

MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"]

OUT_DIR = Path(__file__).resolve().parent.parent / "tmp" / "groq_whisper_tests"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def transcribe(lang: str, path: str, model: str) -> str:
    p = Path(path)
    print(f"[{lang}] [{model}] Uploading {p.name} ...")
    with open(p, "rb") as f:
        files = {"file": (p.name, f, "audio/mpeg")}
        data = {"model": model, "response_format": "text"}
        headers = {"Authorization": f"Bearer {GROQ_API_KEY}"}
        resp = requests.post(URL, headers=headers, files=files, data=data, timeout=300)
    resp.raise_for_status()
    return resp.text


def main() -> None:
    for lang, path in FILES:
        for model in MODELS:
            try:
                text = transcribe(lang, path, model)
                out_path = OUT_DIR / f"{lang}_{model}.txt"
                out_path.write_text(text, encoding="utf-8")
                print(f"[{lang}] [{model}] Saved -> {out_path}")
            except Exception as e:
                print(f"[{lang}] [{model}] ERROR: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
