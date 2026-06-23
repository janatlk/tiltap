#!/usr/bin/env python3
"""Quick language detection test using multilingual Whisper models."""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from transcribe_hybrid import convert_to_wav, get_whisper_model

FFMPEG = "node_modules/ffmpeg-static/ffmpeg.exe"
MODELS = ["base", "small"]


def detect_language(input_path: str, model_path: str) -> str:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name
    try:
        convert_to_wav(input_path, wav_path, FFMPEG)
        model = get_whisper_model(model_path)
        segments_iter, info = model.transcribe(
            wav_path,
            language=None,
            vad_filter=True,
            beam_size=5,
            initial_prompt="Transcribe the spoken words accurately, including any loanwords from other languages.",
        )
        next(segments_iter, None)
        return info.language
    finally:
        try:
            os.unlink(wav_path)
        except Exception:
            pass


files = {
    "ky phrasebook": "test_audio/ky.wav",
    "tg phrasebook": "test_audio/tg.wav",
    "uz phrasebook": "test_audio/uz.wav",
    "ru phrasebook": "test_audio/ru.wav",
    "ru_en phrasebook": "test_audio/ru_en.wav",
    "ky hard": "test_audio/youtube/ky_yt_1min.wav",
    "tg hard": "test_audio/youtube/tg_yt.wav",
    "uz hard": "test_audio/youtube/uz_yt.wav",
}

results = {}
for model_path in MODELS:
    model_results = {}
    for label, path in files.items():
        if not os.path.exists(path):
            model_results[label] = "FILE_MISSING"
            continue
        print(f"[detect] {model_path} / {label} ...", file=sys.stderr, flush=True)
        try:
            model_results[label] = detect_language(path, model_path)
        except Exception as e:
            model_results[label] = f"ERROR: {e}"
    results[model_path] = model_results

print(json.dumps(results, ensure_ascii=False, indent=2))
