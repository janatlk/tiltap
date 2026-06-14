#!/usr/bin/env python3
"""Hybrid transcription: Vosk for Kyrgyz/Russian, Whisper for others.

Model routing:
  ky -> Vosk (vosk-model-ky-0.42)
  tg -> Whisper (distil-large-v3)
  uz -> wav2vec2 (Beehzod/wav2vec2-large-xlsr-uzbek_STT_2) or Whisper fallback
  en -> Whisper (distil-large-v3)
  ru -> Vosk (vosk-model-ru-0.42) or Whisper fallback
  auto -> Whisper (base) for fast language detection
  multi -> Whisper dual-pass (auto + Russian) for Turkic/Russian code-switching

Whisper models are cached in memory to avoid reloading on every request.
Real-time progress is emitted as JSON lines to stdout.
"""

import json
import sys
import os
import wave
import subprocess
import tempfile
import math

PYTHON_PATH = "python" if sys.platform == "win32" else "python3"
FFMPEG_PATH = None

# Force UTF-8 on Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


# ---------------------------------------------------------------------------
# Progress reporting
# ---------------------------------------------------------------------------
def emit_progress(percent: int, label: str):
    """Emit a JSON progress line that the Node controller can consume."""
    print(
        json.dumps({"type": "progress", "percent": max(0, min(100, int(percent))), "label": label}, ensure_ascii=False),
        flush=True,
    )


def get_audio_duration(wav_path: str) -> float:
    try:
        with wave.open(wav_path, "rb") as wf:
            return wf.getnframes() / wf.getframerate()
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# Model cache
# ---------------------------------------------------------------------------
_whisper_models = {}
_wav2vec_models = {}
_whisper_hf_models = {}


def get_whisper_model(model_size="distil-large-v3"):
    """Load and cache a Whisper model. Models are kept in memory for reuse."""
    if model_size not in _whisper_models:
        from faster_whisper import WhisperModel
        print(f"[whisper] Loading model: {model_size} ...", file=sys.stderr, flush=True)
        _whisper_models[model_size] = WhisperModel(
            model_size,
            device="cpu",
            compute_type="int8",
        )
        print(f"[whisper] Model {model_size} loaded.", file=sys.stderr, flush=True)
    return _whisper_models[model_size]


# ---------------------------------------------------------------------------
# Audio preprocessing
# ---------------------------------------------------------------------------
def convert_to_wav(input_path: str, output_path: str, ffmpeg_path: str, enhance: bool = True):
    cmd = [
        ffmpeg_path,
        "-y",
        "-i", input_path,
    ]

    if enhance:
        # Audio enhancement pipeline:
        # 1. highpass=f=80     - remove low-frequency rumble/noise
        # 2. lowpass=f=8000    - remove high-frequency hiss (speech is mostly below 8kHz)
        # 3. dynaudnorm        - dynamic volume normalization
        # 4. afftdn            - FFT noise reduction (light)
        cmd.extend([
            "-af", "highpass=f=80,lowpass=f=8000,dynaudnorm=p=0.95:g=15,afftdn=nr=10:nf=-20",
        ])

    cmd.extend([
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        output_path,
    ])
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ---------------------------------------------------------------------------
# Vosk transcription
# ---------------------------------------------------------------------------
def transcribe_vosk(wav_path: str, model_path: str, progress_label: str = "Распознаю"):
    from vosk import Model, KaldiRecognizer

    emit_progress(0, f"{progress_label}: загрузка модели...")
    model = Model(model_path)
    wf = wave.open(wav_path, "rb")
    rec = KaldiRecognizer(model, wf.getframerate())
    rec.SetWords(True)

    total_frames = wf.getnframes()
    results = []
    emit_progress(5, progress_label)
    read_frames = 0

    while True:
        data = wf.readframes(4000)
        if len(data) == 0:
            break
        read_frames += len(data) // (wf.getsampwidth() * wf.getnchannels())
        if rec.AcceptWaveform(data):
            part = json.loads(rec.Result())
            if part.get("text"):
                results.append(part)
        progress = 5 + int(90 * read_frames / total_frames) if total_frames else 5
        emit_progress(progress, progress_label)

    final = json.loads(rec.FinalResult())
    if final.get("text"):
        results.append(final)

    wf.close()
    emit_progress(100, progress_label)
    return results


def build_vosk_segments(results):
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
            "confidence": 0.0,
        })
        seg_id += 1
    return segments


# ---------------------------------------------------------------------------
# Whisper transcription
# ---------------------------------------------------------------------------

def get_wav2vec_model(model_name: str):
    """Load and cache a HuggingFace Wav2Vec2 model."""
    if model_name not in _wav2vec_models:
        import torch
        from transformers import AutoProcessor, AutoModelForCTC
        print(f"[wav2vec2] Loading model: {model_name} ...", file=sys.stderr, flush=True)
        processor = AutoProcessor.from_pretrained(model_name)
        model = AutoModelForCTC.from_pretrained(model_name)
        model.eval()
        device = torch.device("cpu")
        model.to(device)
        _wav2vec_models[model_name] = (processor, model, device)
        print(f"[wav2vec2] Model {model_name} loaded.", file=sys.stderr, flush=True)
    return _wav2vec_models[model_name]


def load_audio(wav_path: str):
    """Load 16kHz mono WAV and return numpy array."""
    import numpy as np
    wf = wave.open(wav_path, "rb")
    frames = wf.readframes(wf.getnframes())
    wf.close()
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    return audio, 16000


def transcribe_wav2vec2(wav_path: str, model_name: str, language: str, progress_label: str = "Распознаю"):
    """Transcribe audio with a cached Wav2Vec2 model."""
    import torch
    import numpy as np

    processor, model, device = get_wav2vec_model(model_name)
    audio, sr = load_audio(wav_path)
    duration = len(audio) / sr

    chunk_samples = 30 * sr
    full_text_parts = []
    segments = []
    seg_id = 0

    total_chunks = math.ceil(len(audio) / chunk_samples)
    emit_progress(5, progress_label)

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
            "confidence": 0.0,
        })
        seg_id += 1
        progress = 5 + int(90 * seg_id / total_chunks) if total_chunks else 5
        emit_progress(progress, progress_label)

    full_text = " ".join(full_text_parts)
    emit_progress(100, progress_label)
    return {
        "text": full_text,
        "language": language,
        "segments": segments,
    }


def get_whisper_hf_pipeline(model_name: str):
    """Load and cache a HuggingFace Whisper pipeline."""
    if model_name not in _whisper_hf_models:
        from transformers import pipeline
        print(f"[whisper-hf] Loading model: {model_name} ...", file=sys.stderr, flush=True)
        _whisper_hf_models[model_name] = pipeline(
            "automatic-speech-recognition",
            model=model_name,
            device="cpu",
            chunk_length_s=30,
        )
        print(f"[whisper-hf] Model {model_name} loaded.", file=sys.stderr, flush=True)
    return _whisper_hf_models[model_name]


def transcribe_whisper_hf(wav_path: str, model_name: str, language: str, progress_label: str = "Распознаю"):
    """Transcribe audio with a HuggingFace Whisper model (fine-tuned)."""
    pipe = get_whisper_hf_pipeline(model_name)
    emit_progress(5, progress_label)
    result = pipe(wav_path, return_timestamps=True)
    emit_progress(95, progress_label)

    full_text = result.get("text", "").strip()
    chunks = result.get("chunks", [])
    segments = []
    seg_id = 0
    for chunk in chunks:
        timestamp = chunk.get("timestamp") or (0.0, 0.0)
        start = timestamp[0] if isinstance(timestamp, (list, tuple)) else 0.0
        end = timestamp[1] if isinstance(timestamp, (list, tuple)) and len(timestamp) > 1 and timestamp[1] is not None else start
        text = chunk.get("text", "").strip()
        if text:
            segments.append({
                "id": seg_id,
                "start": float(start),
                "end": float(end),
                "text": text,
                "confidence": 0.0,
            })
            seg_id += 1

    if not full_text and segments:
        full_text = " ".join(s["text"] for s in segments)

    emit_progress(100, progress_label)
    return {
        "text": full_text,
        "language": language,
        "segments": segments,
    }


def transcribe_whisper(wav_path: str, language: str | None, model_size: str = "distil-large-v3", progress_label: str = "Распознаю"):
    model = get_whisper_model(model_size)
    duration = get_audio_duration(wav_path)
    emit_progress(0, f"{progress_label}: загрузка модели...")

    segments_iter, info = model.transcribe(
        wav_path,
        language=language if language else None,
        word_timestamps=False,
        condition_on_previous_text=True,
        vad_filter=True,
        beam_size=1,
        best_of=1,
        initial_prompt="Transcribe the spoken words accurately, including any loanwords from other languages.",
    )

    emit_progress(5, progress_label)

    result_segments = []
    seg_id = 0
    full_text_parts = []

    for segment in segments_iter:
        result_segments.append({
            "id": seg_id,
            "start": segment.start,
            "end": segment.end,
            "text": segment.text.strip(),
            "confidence": getattr(segment, "avg_logprob", 0.0) or 0.0,
        })
        seg_id += 1
        full_text_parts.append(segment.text.strip())
        if duration:
            progress = 5 + int(90 * segment.end / duration)
            emit_progress(progress, progress_label)

    emit_progress(100, progress_label)
    return {
        "text": " ".join(full_text_parts),
        "language": info.language,
        "segments": result_segments,
    }


# ---------------------------------------------------------------------------
# Multilingual / code-switching transcription
# ---------------------------------------------------------------------------
def merge_segment_lists(segments_a, segments_b):
    """Merge two segment lists by keeping the higher-confidence segment in overlaps."""
    candidates = []
    for s in segments_a:
        candidates.append({**s, "src": "auto"})
    for s in segments_b:
        candidates.append({**s, "src": "ru"})
    candidates.sort(key=lambda x: x["start"])

    merged = []
    for cand in candidates:
        if not merged:
            merged.append(cand)
            continue
        last = merged[-1]
        if cand["start"] < last["end"] - 0.1:  # overlap
            if cand.get("confidence", 0) > last.get("confidence", 0):
                # trim last to the start of the better candidate
                last["end"] = cand["start"]
                merged.append(cand)
            else:
                # trim candidate to the end of last
                cand["start"] = last["end"]
                if cand["start"] < cand["end"]:
                    merged.append(cand)
        else:
            merged.append(cand)

    merged.sort(key=lambda x: x["start"])
    for idx, m in enumerate(merged):
        m["id"] = idx
        m.pop("src", None)
    return merged


def transcribe_multilingual(wav_path: str, model_size: str = "distil-large-v3"):
    """Transcribe Turkic + Russian code-switched audio using two Whisper passes."""
    emit_progress(0, "Мультиязычное распознавание: определение языка...")

    # First pass: auto-detect primary language
    primary = transcribe_whisper(wav_path, None, model_size, progress_label="Распознаю основной язык")
    primary_lang = primary["language"]

    # Second pass: force Russian to catch Russian loanwords
    emit_progress(0, "Мультиязычное распознавание: русские вставки...")
    russian = transcribe_whisper(wav_path, "ru", model_size, progress_label="Распознаю русский")

    merged_segments = merge_segment_lists(primary["segments"], russian["segments"])
    full_text = " ".join(s["text"] for s in merged_segments)

    return {
        "text": full_text,
        "language": f"{primary_lang}+ru",
        "segments": merged_segments,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    if len(sys.argv) < 4:
        print("Usage: transcribe_hybrid.py <input_file> <ffmpeg_path> <language>", file=sys.stderr)
        sys.exit(1)

    input_file = sys.argv[1]
    ffmpeg_path = sys.argv[2]
    FFMPEG_PATH = ffmpeg_path
    language = sys.argv[3] if sys.argv[3] != "auto" else None

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name

    try:
        convert_to_wav(input_file, wav_path, ffmpeg_path)

        if language == "ky":
            large_path = "models/vosk-model-ky-0.42"
            small_path = "models/vosk-model-small-ky-0.42"
            model_path = large_path if os.path.exists(large_path) else small_path
            results = transcribe_vosk(wav_path, model_path, progress_label="Кыргызча распознаю")
            segments = build_vosk_segments(results)
            full_text = " ".join(s["text"] for s in segments)
            output = {
                "text": full_text,
                "language": "ky",
                "segments": segments,
            }

        elif language == "tg":
            output = transcribe_whisper(wav_path, "tg", model_size="distil-large-v3", progress_label="Тоҷикӣ распознаю")

        elif language == "ru":
            large_path = "models/vosk-model-ru-0.42"
            small_path = "models/vosk-model-small-ru-0.22"
            model_path = large_path if os.path.exists(large_path) else small_path
            if os.path.exists(model_path):
                results = transcribe_vosk(wav_path, model_path, progress_label="Русский распознаю")
                segments = build_vosk_segments(results)
                full_text = " ".join(s["text"] for s in segments)
                output = {
                    "text": full_text,
                    "language": "ru",
                    "segments": segments,
                }
            else:
                output = transcribe_whisper(wav_path, "ru", model_size="distil-large-v3", progress_label="Русский распознаю")

        elif language == "uz":
            try:
                output = transcribe_wav2vec2(wav_path, "Beehzod/wav2vec2-large-xlsr-uzbek_STT_2", "uz", progress_label="O'zbekcha распознаю")
            except Exception as e:
                print(f"[wav2vec2] Uzbek failed: {e}, falling back to Whisper", file=sys.stderr, flush=True)
                output = transcribe_whisper(wav_path, "uz", model_size="distil-large-v3", progress_label="O'zbekcha распознаю")

        elif language == "en":
            output = transcribe_whisper(wav_path, "en", model_size="distil-large-v3", progress_label="English transcribing")

        elif language == "multi":
            output = transcribe_multilingual(wav_path, model_size="distil-large-v3")

        else:
            output = transcribe_whisper(wav_path, None, model_size="base", progress_label="Определяю язык")

        print(json.dumps(output, ensure_ascii=False))
    finally:
        os.unlink(wav_path)


if __name__ == "__main__":
    main()
