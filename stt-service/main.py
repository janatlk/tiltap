"""FastAPI STT microservice wrapping transcribe_hybrid models.

Supported languages:
  ky -> Vosk (local)
  uz -> Rubai Whisper CT2 int8 (local)
  tg -> ElevenLabs Scribe v2 (cloud, optional fallback chain)
  ru -> Vosk large or Whisper medium (local if model present, else cloud)
  en -> Whisper distil-large-v3 (local)
  multi -> Whisper dual-pass
"""

import gc
import json
import os
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, File, Form, UploadFile, status
from fastapi.responses import JSONResponse

# Make project root imports work inside stt-service/
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import transcribe_hybrid as th  # noqa: E402

SUPPORTED_LANGUAGES = {"ky", "uz", "tg", "ru", "en", "multi"}


def _convert_upload_to_wav(upload_path: str, wav_path: str) -> None:
    """Convert any audio/video file to 16kHz mono WAV using ffmpeg."""
    ffmpeg = os.environ.get("FFMPEG_PATH")
    if not ffmpeg:
        # Try npm-provided static ffmpeg on Windows, then system ffmpeg.
        candidate = ROOT / "node_modules" / "ffmpeg-static" / "ffmpeg.exe"
        ffmpeg = str(candidate) if candidate.exists() else "ffmpeg"
    cmd = [
        ffmpeg,
        "-y",
        "-i", upload_path,
        "-af", "highpass=f=80,lowpass=f=8000,dynaudnorm=p=0.95:g=15,afftdn=nr=10:nf=-20",
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        wav_path,
    ]
    import subprocess
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _transcribe_local(wav_path: str, language: str) -> dict:
    """Route to the best available local model, skipping cloud/download fallbacks."""
    if language == "ky":
        return th.transcribe_kyrgyz(wav_path)
    if language == "uz":
        return th.transcribe_uzbek(wav_path)
    if language == "tg":
        return th.transcribe_tajik(wav_path)
    if language == "ru":
        return th.transcribe_whisper(
            wav_path,
            "ru",
            th.local_whisper_model_path(),
            progress_label="Русский распознаю",
            initial_prompt="Распознай речь на русском языке. Сохраняй русские слова и произношение.",
        )
    if language == "en":
        return th.transcribe_whisper(wav_path, "en", th.local_whisper_model_path(), progress_label="English transcribing")
    if language == "multi":
        return th.transcribe_multilingual(wav_path, th.local_whisper_model_path())
    raise ValueError(f"Unsupported language: {language}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Warm up expensive models on startup so first request is fast."""
    # Pre-load Vosk small ky/uz because they are cheap to keep in RAM.
    # Rubai/Whisper are lazy-loaded on first request to avoid OOM at boot.
    for model_path in ("models/vosk-model-small-ky-0.42", "models/vosk-model-small-uz-0.22"):
        if os.path.exists(model_path):
            try:
                from vosk import Model
                _ = Model(model_path)
            except Exception as e:
                print(f"[warmup] Could not preload {model_path}: {e}", file=sys.stderr)
    yield


app = FastAPI(
    title="Tiltab STT Service",
    description="Local/cloud hybrid STT for ky, uz, tg, ru, en",
    version="1.0.0",
    lifespan=lifespan,
)


@app.get("/health")
async def health():
    """Health check with model availability."""
    models = {
        "vosk_small_ky": os.path.exists("models/vosk-model-small-ky-0.42"),
        "vosk_small_uz": os.path.exists("models/vosk-model-small-uz-0.22"),
        "rubai_uz": os.path.exists("models/rubai-ct2-int8"),
        "vosk_large_ru": os.path.exists("models/vosk-model-ru-0.42"),
        "whisper_distil": True,  # downloaded on first use if not present
    }
    return {"status": "ok", "models": models}


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form(...),
    webhook_url: Optional[str] = Form(None),
):
    """Transcribe an audio/video file.

    Args:
        file: Audio/video file (any ffmpeg-supported format).
        language: One of ky, uz, tg, ru, en, multi.
        webhook_url: Optional callback URL for async notification (reserved).
    """
    language = language.lower().strip()
    if language not in SUPPORTED_LANGUAGES:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"error": f"Unsupported language: {language}. Supported: {list(SUPPORTED_LANGUAGES)}"},
        )

    upload_path = ""
    wav_path = ""
    start_time = time.time()

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=Path(file.filename or "audio").suffix) as tmp:
            upload_path = tmp.name
            content = await file.read()
            tmp.write(content)

        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp:
            wav_path = tmp.name

        _convert_upload_to_wav(upload_path, wav_path)

        result = _transcribe_local(wav_path, language)
        result["processing_time_seconds"] = round(time.time() - start_time, 2)
        result["service"] = "tiltab-stt"

        # Clean internal quality field if present
        result.pop("quality", None)

        return JSONResponse(content=result)
    except Exception as exc:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": str(exc), "type": type(exc).__name__},
        )
    finally:
        for p in (upload_path, wav_path):
            try:
                if p and os.path.exists(p):
                    os.unlink(p)
            except Exception:
                pass
        # Keep Whisper models cached across requests on CX43 (16 GB RAM).
        # The backend serializes remote STT jobs, so only one heavy model is
        # active at a time; releasing after every request added latency.
        try:
            gc.collect()
        except Exception:
            pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "0.0.0.0")
    uvicorn.run("main:app", host=host, port=port, log_level="info")
