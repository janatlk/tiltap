#!/usr/bin/env python3
"""RunPod serverless handler for TilTap GPU STT.

Expects input:
{
  "audio_base64": "<base64-encoded WAV/MP3/...>",
  "language": "ru" | "en" | "tg" | "uz" | "auto" | "multi",
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
import io
import os
import subprocess
import tempfile
from pathlib import Path

import runpod
from faster_whisper import WhisperModel

MODEL_PATHS = {
    "ru": "/models/whisper-large-v3-turbo-ct2",
    "en": "/models/whisper-large-v3-turbo-ct2",
    "auto": "/models/whisper-large-v3-turbo-ct2",
    "multi": "/models/whisper-large-v3-turbo-ct2",
    "tg": "/models/muhtasham-whisper-tg-ct2",
    "uz": "/models/rubai-ct2-int8",
    "ky": "/models/kyrgyz-whisper-small-ct2",
}

DEFAULT_MODEL = "/models/whisper-large-v3-turbo-ct2"

# Cache loaded models so warm workers reuse them.
_models: dict[str, WhisperModel] = {}


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
        input_path = os.path.join(tmpdir, f"input{audio_ext(filename)}")
        wav_path = os.path.join(tmpdir, "audio.wav")

        with open(input_path, "wb") as f:
            f.write(audio_bytes)

        try:
            _convert_to_wav(input_path, wav_path)
        except subprocess.CalledProcessError as e:
            return {"error": f"ffmpeg conversion failed: {e}"}

        model_path = MODEL_PATHS.get(language, DEFAULT_MODEL)
        if not os.path.isdir(model_path):
            return {"error": f"Model not found: {model_path}"}

        try:
            model = _load_model(model_path)
        except Exception as e:
            return {"error": f"Failed to load model {model_path}: {e}"}

        whisper_language = None if language in ("auto", "multi") else language

        try:
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
                segments.append(
                    {
                        "start": round(seg.start, 3),
                        "end": round(seg.end, 3),
                        "text": seg.text.strip(),
                    }
                )
                text = seg.text.strip()
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
        except Exception as e:
            return {"error": f"Transcription failed: {e}"}


def audio_ext(filename: str) -> str:
    ext = Path(filename).suffix
    if not ext or "." not in ext:
        return ".bin"
    return ext


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
