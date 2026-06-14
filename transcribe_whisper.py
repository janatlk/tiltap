#!/usr/bin/env python3
"""Local transcription using faster-whisper + ffmpeg. Outputs JSON to stdout."""

import json
import sys
import os
import subprocess
import tempfile

# Force UTF-8 on Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


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
    if len(sys.argv) < 3:
        print("Usage: transcribe_whisper.py <input_file> <ffmpeg_path> [model_size] [language]", file=sys.stderr)
        sys.exit(1)

    input_file = sys.argv[1]
    ffmpeg_path = sys.argv[2]
    model_size = sys.argv[3] if len(sys.argv) > 3 else "small"
    language = sys.argv[4] if len(sys.argv) > 4 else None

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name

    try:
        convert_to_wav(input_file, wav_path, ffmpeg_path)

        from faster_whisper import WhisperModel

        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        whisper_lang = None
        if language and language != "auto":
            whisper_lang = language
        segments, info = model.transcribe(
            wav_path,
            language=whisper_lang,
            word_timestamps=False,
            condition_on_previous_text=True,
            vad_filter=True,
        )

        result_segments = []
        seg_id = 0
        full_text_parts = []

        for segment in segments:
            result_segments.append({
                "id": seg_id,
                "start": segment.start,
                "end": segment.end,
                "text": segment.text.strip(),
            })
            seg_id += 1
            full_text_parts.append(segment.text.strip())

        output = {
            "text": " ".join(full_text_parts),
            "language": info.language,
            "segments": result_segments,
        }
        print(json.dumps(output, ensure_ascii=False))
    finally:
        os.unlink(wav_path)


if __name__ == "__main__":
    main()
