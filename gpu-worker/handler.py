#!/usr/bin/env python3
"""RunPod serverless handler for TilTap GPU STT.

Expects input:
{
  "audio_base64": "<base64-encoded WAV/MP3/...>",
  "language": "ru" | "en" | "tg" | "uz" | "ky" | "auto" | "multi",
  "filename": "optional.mp3"
}

Returns:
{
  "text": "...",
  "language": "ru",
  "segments": [{"start": 0.0, "end": 1.0, "text": "..."}],
  "model": "/models/whisper-large-v3-turbo-ct2",
  "gpu": "NVIDIA T4"
}
"""

import base64
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import librosa
import runpod
import torch
from faster_whisper import WhisperModel

MODEL_PATHS = {
    "ru": "/models/whisper-large-v3-turbo-ct2",
    "en": "/models/whisper-large-v3-turbo-ct2",
    "auto": "/models/whisper-large-v3-turbo-ct2",
    "multi": "/models/whisper-large-v3-turbo-ct2",
    "tg": "/models/muhtasham-whisper-tg-ct2",
    "uz": "/models/rubai-ct2-int8",
}

# The Kyrgyz model uses a custom <|ky|> token (id 51865). It must be loaded
# with trust_remote_code=True and transcribed with manual 30-second chunking
# through model.generate(), otherwise the model truncates to the first 30 s
# and the custom token can send the decoder into a loop.
KYRGYZ_MODEL_PATH = "/models/kyrgyz-whisper-small-hf"
KYRGYZ_LANGUAGE_TOKEN_ID = 51865

DEFAULT_MODEL = "/models/whisper-large-v3-turbo-ct2"

# Cache loaded models so warm workers reuse them.
_models: dict[str, WhisperModel] = {}
_kyrgyz_bundle: dict[str, Any] = {}


def _get_gpu_name() -> str:
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            check=False,
        )
        return (result.stdout.strip() or "unknown").splitlines()[0].strip()
    except Exception:
        return "unknown"


def _convert_to_wav(input_path: str, output_path: str) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-i", input_path, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", output_path],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _load_model(model_path: str) -> WhisperModel:
    if model_path not in _models:
        compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "float16")
        device = os.environ.get("WHISPER_DEVICE", "cuda")
        _models[model_path] = WhisperModel(
            model_path,
            device=device,
            compute_type=compute_type,
            cpu_threads=int(os.environ.get("WHISPER_CPU_THREADS", "4")),
        )
    return _models[model_path]


def _load_kyrgyz_bundle(model_path: str) -> dict[str, Any]:
    if model_path not in _kyrgyz_bundle:
        from transformers import (
            AutoModelForSpeechSeq2Seq,
            AutoProcessor,
            AutoTokenizer,
        )

        device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.float16 if device == "cuda" else torch.float32
        print(f"Loading Kyrgyz model from {model_path} on {device} ({dtype})...")
        model = AutoModelForSpeechSeq2Seq.from_pretrained(
            model_path,
            torch_dtype=dtype,
            low_cpu_mem_usage=True,
            use_safetensors=True,
        ).to(device)
        processor = AutoProcessor.from_pretrained(model_path)
        tokenizer = AutoTokenizer.from_pretrained(model_path)
        _kyrgyz_bundle[model_path] = {
            "model": model,
            "processor": processor,
            "tokenizer": tokenizer,
            "device": device,
            "dtype": dtype,
        }
    return _kyrgyz_bundle[model_path]


def _transcribe_kyrgyz(wav_path: str) -> dict:
    bundle = _load_kyrgyz_bundle(KYRGYZ_MODEL_PATH)
    model = bundle["model"]
    processor = bundle["processor"]
    tokenizer = bundle["tokenizer"]
    device = bundle["device"]
    dtype = bundle["dtype"]

    audio, sr = librosa.load(wav_path, sr=16000, mono=True)
    if audio.ndim == 0 or len(audio) == 0:
        return {"text": "", "language": "ky", "segments": [], "model": KYRGYZ_MODEL_PATH, "gpu": _get_gpu_name()}

    sr_value = 16000
    chunk_seconds = 30
    chunk_samples = chunk_seconds * sr_value
    forced_decoder_ids = [[1, KYRGYZ_LANGUAGE_TOKEN_ID]]

    text_parts: list[str] = []
    segments: list[dict] = []
    for i, start in enumerate(range(0, len(audio), chunk_samples)):
        chunk = audio[start : start + chunk_samples]
        if len(chunk) < sr_value:
            # Very short trailing fragment; skip to avoid noise.
            continue
        inputs = processor(
            chunk,
            sampling_rate=sr_value,
            return_tensors="pt",
        ).input_features.to(device).to(dtype)
        predicted_ids = model.generate(
            inputs,
            forced_decoder_ids=forced_decoder_ids,
            no_repeat_ngram_size=3,
            max_length=448,
        )
        chunk_text = tokenizer.batch_decode(predicted_ids, skip_special_tokens=True)[0].strip()
        if chunk_text:
            text_parts.append(chunk_text)
        seg_start = start / sr_value
        seg_end = min((start + len(chunk)) / sr_value, len(audio) / sr_value)
        segments.append(
            {
                "start": round(seg_start, 3),
                "end": round(seg_end, 3),
                "text": chunk_text,
            }
        )

    full_text = " ".join(text_parts)
    return {
        "text": full_text,
        "language": "ky",
        "segments": segments,
        "model": KYRGYZ_MODEL_PATH,
        "gpu": _get_gpu_name(),
    }


def _transcribe_with_faster_whisper(wav_path: str, model_path: str, language: str) -> dict:
    whisper_language = None if language in ("auto", "multi") else language
    model = _load_model(model_path)
    segments_iter, info = model.transcribe(
        wav_path,
        language=whisper_language,
        task="transcribe",
        beam_size=int(os.environ.get("WHISPER_BEAM_SIZE", "5")),
        best_of=int(os.environ.get("WHISPER_BEST_OF", "5")),
        condition_on_previous_text=os.environ.get("WHISPER_CONDITION_ON_PREVIOUS_TEXT", "true").lower()
        in ("1", "true", "yes"),
        word_timestamps=os.environ.get("WHISPER_WORD_TIMESTAMPS", "false").lower()
        in ("1", "true", "yes"),
        vad_filter=os.environ.get("WHISPER_VAD_FILTER", "true").lower()
        in ("1", "true", "yes"),
    )

    segments = []
    full_text_parts = []
    for seg in segments_iter:
        text = seg.text.strip()
        segments.append(
            {
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "text": text,
            }
        )
        if text:
            full_text_parts.append(text)

    full_text = " ".join(full_text_parts)
    return {
        "text": full_text,
        "language": info.language or language,
        "segments": segments,
        "model": model_path,
        "gpu": _get_gpu_name(),
    }


def handler(event):
    job_input = event.get("input", {})
    audio_b64 = job_input.get("audio_base64")
    language = (job_input.get("language") or "auto").lower()
    filename = job_input.get("filename", "audio")

    if not audio_b64:
        return {"error": "Missing audio_base64"}

    audio_bytes = base64.b64decode(audio_b64)

    with tempfile.TemporaryDirectory() as tmpdir:
        input_ext = Path(filename).suffix or ".bin"
        input_path = os.path.join(tmpdir, f"input{input_ext}")
        wav_path = os.path.join(tmpdir, "audio.wav")

        with open(input_path, "wb") as f:
            f.write(audio_bytes)

        try:
            _convert_to_wav(input_path, wav_path)
        except subprocess.CalledProcessError as e:
            return {"error": f"ffmpeg conversion failed: {e}"}

        try:
            if language == "ky":
                if not os.path.isdir(KYRGYZ_MODEL_PATH):
                    return {"error": f"Kyrgyz model not found: {KYRGYZ_MODEL_PATH}"}
                return _transcribe_kyrgyz(wav_path)

            model_path = MODEL_PATHS.get(language, DEFAULT_MODEL)
            if not os.path.isdir(model_path):
                return {"error": f"Model not found: {model_path}"}
            return _transcribe_with_faster_whisper(wav_path, model_path, language)
        except Exception as e:
            return {"error": f"Transcription failed: {e}"}


def audio_ext(filename: str) -> str:
    ext = Path(filename).suffix
    if not ext or "." not in ext:
        return ".bin"
    return ext


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
