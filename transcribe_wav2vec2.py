#!/usr/bin/env python3
"""Transcribe audio using HuggingFace wav2vec2 models for Uzbek and Tajik."""

import sys
import os
import json
import wave
import subprocess
import tempfile
import math

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
        "-af", "highpass=f=80,lowpass=f=8000,dynaudnorm=p=0.95:g=15,afftdn=nr=10:nf=-20",
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        output_path,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def load_audio(wav_path: str):
    """Load 16kHz mono WAV and return numpy array."""
    import numpy as np
    wf = wave.open(wav_path, "rb")
    frames = wf.readframes(wf.getnframes())
    wf.close()
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    return audio, 16000


def transcribe_wav2vec2(wav_path: str, model_name: str, language: str):
    import torch
    from transformers import AutoProcessor, AutoModelForCTC
    import numpy as np

    print(f"[wav2vec2] Loading model: {model_name} ...", file=sys.stderr, flush=True)
    processor = AutoProcessor.from_pretrained(model_name)
    model = AutoModelForCTC.from_pretrained(model_name)
    model.eval()

    device = torch.device("cpu")
    model.to(device)

    audio, sr = load_audio(wav_path)
    duration = len(audio) / sr

    # Process in 30-second chunks to avoid OOM
    chunk_samples = 30 * sr
    full_text_parts = []
    segments = []
    seg_id = 0

    for start_idx in range(0, len(audio), chunk_samples):
        end_idx = min(start_idx + chunk_samples, len(audio))
        chunk = audio[start_idx:end_idx]
        chunk_start = start_idx / sr
        chunk_end = end_idx / sr

        inputs = processor(chunk, sampling_rate=sr, return_tensors="pt", padding=True)
        input_values = inputs.input_values.to(device)

        with torch.no_grad():
            logits = model(input_values).logits

        predicted_ids = torch.argmax(logits, dim=-1)
        transcription = processor.batch_decode(predicted_ids)[0]

        full_text_parts.append(transcription.strip())
        segments.append({
            "id": seg_id,
            "start": chunk_start,
            "end": chunk_end,
            "text": transcription.strip(),
        })
        seg_id += 1

    full_text = " ".join(full_text_parts)
    return {
        "text": full_text,
        "language": language,
        "segments": segments,
    }


def main():
    if len(sys.argv) < 5:
        print("Usage: transcribe_wav2vec2.py <input_file> <ffmpeg_path> <model_name> <language>", file=sys.stderr)
        sys.exit(1)

    input_file = sys.argv[1]
    ffmpeg_path = sys.argv[2]
    model_name = sys.argv[3]
    language = sys.argv[4]

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name

    try:
        convert_to_wav(input_file, wav_path, ffmpeg_path)
        output = transcribe_wav2vec2(wav_path, model_name, language)
        print(json.dumps(output, ensure_ascii=False))
    finally:
        os.unlink(wav_path)


if __name__ == "__main__":
    main()
