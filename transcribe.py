#!/usr/bin/env python3
"""Local transcription using Vosk + ffmpeg. Outputs JSON to stdout."""

import json
import sys
import os
import wave
import subprocess
import tempfile

# Force UTF-8 on Windows so Cyrillic/Tajik/Kyrgyz/Uzbek text is not mangled
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

# Language code -> model path mapping
MODELS = {
    "uz": "models/vosk-model-small-uz-0.22",
    "tg": "models/vosk-model-small-tg-0.22",
    "ky": "models/vosk-model-small-ky-0.42",
    "auto": None,  # will try each model and pick best
}


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


def transcribe_with_model(wav_path: str, model_path: str):
    from vosk import Model, KaldiRecognizer

    model = Model(model_path)
    wf = wave.open(wav_path, "rb")
    rec = KaldiRecognizer(model, wf.getframerate())
    rec.SetWords(True)

    results = []
    while True:
        data = wf.readframes(4000)
        if len(data) == 0:
            break
        if rec.AcceptWaveform(data):
            part = json.loads(rec.Result())
            if part.get("text"):
                results.append(part)

    final = json.loads(rec.FinalResult())
    if final.get("text"):
        results.append(final)

    wf.close()
    return results


def build_segments(results):
    segments = []
    seg_id = 0
    for r in results:
        words = r.get("result", [])
        if not words:
            continue
        text = r.get("text", "")
        start = words[0]["start"]
        end = words[-1]["end"]
        segments.append({
            "id": seg_id,
            "start": start,
            "end": end,
            "text": text,
        })
        seg_id += 1
    return segments


def auto_detect_language(wav_path: str):
    """Try each model and return the one with the most text."""
    best_lang = "uz"
    best_text = ""
    best_results = []

    for lang, model_path in MODELS.items():
        if lang == "auto" or not model_path:
            continue
        try:
            results = transcribe_with_model(wav_path, model_path)
            text = " ".join(r.get("text", "") for r in results)
            if len(text) > len(best_text):
                best_text = text
                best_lang = lang
                best_results = results
        except Exception as e:
            print(f"Model {lang} failed: {e}", file=sys.stderr)
            continue

    return best_lang, best_results


def main():
    if len(sys.argv) < 3:
        print("Usage: transcribe.py <input_file> <ffmpeg_path> [lang_code]", file=sys.stderr)
        sys.exit(1)

    input_file = sys.argv[1]
    ffmpeg_path = sys.argv[2]
    lang = sys.argv[3] if len(sys.argv) > 3 else "auto"

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name

    try:
        convert_to_wav(input_file, wav_path, ffmpeg_path)

        if lang == "auto":
            detected_lang, results = auto_detect_language(wav_path)
        else:
            model_path = MODELS.get(lang)
            if not model_path:
                print(f"Unknown language: {lang}", file=sys.stderr)
                sys.exit(1)
            detected_lang = lang
            results = transcribe_with_model(wav_path, model_path)

        segments = build_segments(results)
        full_text = " ".join(s["text"] for s in segments)

        output = {
            "text": full_text,
            "language": detected_lang,
            "segments": segments,
        }
        print(json.dumps(output, ensure_ascii=False))
    finally:
        os.unlink(wav_path)


if __name__ == "__main__":
    main()
