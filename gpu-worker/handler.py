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
import math
import os
import signal
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import librosa
import runpod
import torch
from faster_whisper import WhisperModel

import vad_utils

# ---------------------------------------------------------------------------
# Monkey-patch faster_whisper.tokenizer for Kyrgyz BEFORE any model load
# ---------------------------------------------------------------------------
import faster_whisper.tokenizer as _tok

if "ky" not in _tok._LANGUAGE_CODES:
    _tok._LANGUAGE_CODES = (*_tok._LANGUAGE_CODES, "ky")

# ---------------------------------------------------------------------------
# Model paths
# ---------------------------------------------------------------------------
MODEL_PATHS = {
    "ru": "/models/whisper-large-v3-turbo-ct2",
    "en": "/models/whisper-large-v3-turbo-ct2",
    "auto": "/models/whisper-large-v3-turbo-ct2",
    "multi": "/models/whisper-large-v3-turbo-ct2",
    "tg": "/models/muhtasham-whisper-tg-ct2",
    "uz": "/models/rubai-ct2-int8",
}

# Kyrgyz is now a native faster-whisper model (CT2 conversion + tokenizer fix).
# No more HF transformers remote-code path.
KYRGYZ_MODEL_PATH = "/models/kyrgyz-whisper-small-ct2"
KYRGYZ_LANGUAGE_TOKEN_ID = 51865  # kept for reference; not used with faster-whisper

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


def _decode_whisper_bytes(text: str) -> str:
    """Fix Whisper byte-level token leakage.

    Some CT2/faster-whisper runs (especially float16 GPU) emit raw UTF-8 bytes
    encoded as cp1251-looking characters instead of decoded text. If the bytes
    form valid UTF-8, decode them; otherwise leave the text untouched.
    """
    if not text:
        return text
    try:
        raw_bytes = text.encode("cp1251")
        decoded = raw_bytes.decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return text
    # Only use the decoded form if it actually differs (sanity check).
    if decoded == text:
        return text
    return decoded


def _convert_to_wav(input_path: str, output_path: str) -> None:
    result = subprocess.run(
        ["ffmpeg", "-y", "-i", input_path, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", output_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        stderr_text = result.stderr.decode("utf-8", errors="replace")[-1000:]
        print(f"[ffmpeg] conversion failed for {input_path}: {stderr_text}", file=sys.stderr, flush=True)
        raise subprocess.CalledProcessError(result.returncode, result.args, output=result.stdout, stderr=result.stderr)


def _audio_duration(wav_path: str) -> float:
    try:
        with wave.open(wav_path, "rb") as wf:
            return wf.getnframes() / wf.getframerate()
    except Exception:
        return 0.0


def _load_model(model_path: str) -> WhisperModel:
    if model_path not in _models:
        compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "float16")
        device = os.environ.get("WHISPER_DEVICE", "cuda")
        _models[model_path] = WhisperModel(
            model_path,
            device=device,
            compute_type=compute_type,
            cpu_threads=int(os.environ.get("WHISPER_CPU_THREADS", "4")),
            local_files_only=True,  # 100% offline for cold-start efficiency
        )
    return _models[model_path]


# ---------------------------------------------------------------------------
# VAD configuration
# ---------------------------------------------------------------------------
def _vad_enabled() -> bool:
    return os.environ.get("GPU_VAD_ENABLED", "true").lower() not in ("0", "false", "off")


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def _bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if raw in ("1", "true", "yes"):
        return True
    if raw in ("0", "false", "no"):
        return False
    return default


# Kyrgyz fine-tuned model sometimes emits Kazakh/Tatar Cyrillic letters and
# mixes case. Normalize to standard Kyrgyz Cyrillic and lowercase everything.
_KYRGYZ_NORMALIZE_TABLE = str.maketrans(
    {
        "қ": "к",
        "Қ": "К",
        "ғ": "г",
        "Ғ": "Г",
        "ұ": "у",
        "Ұ": "У",
        "ә": "а",
        "Ә": "А",
        "һ": "х",
        "Һ": "Х",
    }
)

_NON_SPEECH_MARKERS = (
    "[музыка]",
    "[аплодисменты]",
    "[неразборчиво]",
    "[плач]",
    "[кулол]",
)

_CREDIT_PHRASES = (
    "субтитры создавал",
    "субтитры",
)


def _normalize_kyrgyz_text(text: str) -> str:
    text = text.lower().translate(_KYRGYZ_NORMALIZE_TABLE)
    # Remove standalone non-speech markers.
    for marker in _NON_SPEECH_MARKERS:
        text = text.replace(marker, "")
    return " ".join(text.split())


def _is_credit_text(text: str) -> bool:
    lower = text.lower()
    return any(phrase in lower for phrase in _CREDIT_PHRASES)


def _dedupe_chunk_overlap(prev_text: str, curr_text: str, min_chars: int = 8, max_search: int = 120) -> str:
    """If curr_text starts with text already present at the end of prev_text, drop it."""
    if not prev_text or not curr_text:
        return curr_text
    max_len = min(max_search, len(prev_text), len(curr_text))
    for length in range(max_len, min_chars - 1, -1):
        if prev_text.endswith(curr_text[:length]):
            return curr_text[length:].lstrip()
    return curr_text


def _vad_settings() -> Dict[str, Any]:
    return {
        "threshold": _float_env("GPU_VAD_THRESHOLD", 0.5),
        "min_speech_duration_ms": _int_env("GPU_VAD_MIN_SPEECH_DURATION_MS", 250),
        "min_silence_duration_ms": _int_env("GPU_VAD_MIN_SILENCE_MS", 1500),
        "speech_pad_ms": _int_env("GPU_VAD_SPEECH_PAD_MS", 200),
        "max_gap": _float_env("GPU_VAD_MAX_GAP_MS", 3000) / 1000.0,
        "max_duration": _float_env("GPU_VAD_MAX_CHUNK_SECONDS", 30.0),
        "overlap": _float_env("GPU_VAD_OVERLAP_SECONDS", 5.0),
        "max_chunks": _int_env("GPU_VAD_MAX_CHUNKS", 40),
    }


def _fixed_chunks(wav_path: str, chunk_seconds: float) -> List[Dict[str, float]]:
    """Fallback: split audio into fixed non-overlapping windows."""
    audio, sr = librosa.load(wav_path, sr=16000, mono=True)
    duration = len(audio) / sr
    chunk_samples = int(chunk_seconds * sr)
    chunks = [
        {"start": i / sr, "end": min((i + chunk_samples) / sr, duration)}
        for i in range(0, len(audio), chunk_samples)
        if min((i + chunk_samples) / sr, duration) - i / sr >= 1.0
    ]
    print(
        f"[vad] fixed chunks fallback: {len(chunks)} x {chunk_seconds:.0f}s for duration {duration:.1f}s",
        file=sys.stdout,
        flush=True,
    )
    print("[vad] fixed-window mode: no VAD-based silence skipping", file=sys.stdout, flush=True)
    return chunks


def _log_skipped_audio(duration: float, chunks: List[Dict[str, float]]) -> None:
    """Log timestamps of audio that VAD discarded (silence / non-speech)."""
    if not chunks:
        print(f"[vad] skipped silence/non-speech: 0.00s - {duration:.2f}s (duration {duration:.2f}s)", file=sys.stdout, flush=True)
        return

    sorted_chunks = sorted(chunks, key=lambda c: c["start"])
    cursor = 0.0
    total_skipped = 0.0
    for chunk in sorted_chunks:
        gap_start = cursor
        gap_end = chunk["start"]
        if gap_end > gap_start + 0.05:
            gap_duration = gap_end - gap_start
            total_skipped += gap_duration
            print(
                f"[vad] skipped silence/non-speech: {gap_start:.2f}s - {gap_end:.2f}s (duration {gap_duration:.2f}s)",
                file=sys.stdout,
                flush=True,
            )
        cursor = max(cursor, chunk["end"])

    if duration > cursor + 0.05:
        gap_duration = duration - cursor
        total_skipped += gap_duration
        print(
            f"[vad] skipped silence/non-speech: {cursor:.2f}s - {duration:.2f}s (duration {gap_duration:.2f}s)",
            file=sys.stdout,
            flush=True,
        )

    print(f"[vad] total skipped silence/non-speech: {total_skipped:.2f}s", file=sys.stdout, flush=True)


def _get_vad_chunks(wav_path: str) -> Optional[List[Dict[str, float]]]:
    """Return VAD-based audio chunks, or None to fall back to old behaviour."""
    if not _vad_enabled():
        return None

    settings = _vad_settings()
    segments = vad_utils.get_speech_segments(
        wav_path,
        threshold=settings["threshold"],
        min_speech_duration_ms=settings["min_speech_duration_ms"],
        min_silence_duration_ms=settings["min_silence_duration_ms"],
        speech_pad_ms=settings["speech_pad_ms"],
    )
    if segments is None:
        print("[vad] VAD failed, falling back to default chunking.", file=sys.stdout, flush=True)
        return None
    if not segments:
        print("[vad] No speech detected.", file=sys.stdout, flush=True)
        return []

    chunks = vad_utils.merge_speech_segments(
        segments,
        max_gap=settings["max_gap"],
        max_duration=settings["max_duration"],
        overlap=settings["overlap"],
    )
    duration = _audio_duration(wav_path)
    speech_duration = sum(c["end"] - c["start"] for c in chunks)
    overlap_total = max(0.0, speech_duration - duration)
    max_chunks = settings.get("max_chunks", 40)

    if len(chunks) > max_chunks:
        print(
            f"[vad] Too many VAD chunks ({len(chunks)} > {max_chunks}); using fixed windows instead.",
            file=sys.stdout,
            flush=True,
        )
        return _fixed_chunks(wav_path, settings["max_duration"])

    print(
        f"[vad] duration={duration:.1f}s chunks={len(chunks)} "
        f"speech={speech_duration:.1f}s overlap={overlap_total:.1f}s "
        f"skipped={max(0.0, duration - speech_duration + overlap_total):.1f}s",
        file=sys.stdout,
        flush=True,
    )
    _log_skipped_audio(duration, chunks)
    return chunks


# ---------------------------------------------------------------------------
# Transcription backends
# ---------------------------------------------------------------------------
def _transcribe_kyrgyz(wav_path: str) -> dict:
    """Transcribe Kyrgyz audio using the converted CT2 model + faster-whisper.

    The model is loaded natively via faster-whisper (monkey-patched for 'ky').
    VAD chunking is reused from the shared VAD pipeline.
    """
    t_start = time.time()
    model = _load_model(KYRGYZ_MODEL_PATH)

    duration = _audio_duration(wav_path)
    if duration <= 0:
        return {"text": "", "language": "ky", "segments": [], "model": KYRGYZ_MODEL_PATH, "gpu": _get_gpu_name()}

    chunks = _get_vad_chunks(wav_path)
    if chunks is None:
        chunks = _fixed_chunks(wav_path, _float_env("GPU_VAD_MAX_CHUNK_SECONDS", 30.0))

    if not chunks:
        print("[ky] No chunks to transcribe.", file=sys.stdout, flush=True)
        return {"text": "", "language": "ky", "segments": [], "model": KYRGYZ_MODEL_PATH, "gpu": _get_gpu_name()}

    text_parts: list[str] = []
    segments: list[dict] = []
    prev_chunk_text = ""  # for overlap deduplication

    # Decoding options for the Kyrgyz model. These are exposed as environment
    # variables so the RunPod template can be tuned without rebuilding the image.
    ky_beam_size = _int_env("KYRGYZ_BEAM_SIZE", 1)
    ky_best_of = _int_env("KYRGYZ_BEST_OF", 1)
    ky_condition = _bool_env("KYRGYZ_CONDITION_ON_PREVIOUS_TEXT", False)
    ky_no_repeat_ngram = _int_env("KYRGYZ_NO_REPEAT_NGRAM_SIZE", 3)
    ky_repetition_penalty = _float_env("KYRGYZ_REPETITION_PENALTY", 1.0)
    ky_temperature = _float_env("KYRGYZ_TEMPERATURE", 0.0)
    ky_without_timestamps = _bool_env("KYRGYZ_WITHOUT_TIMESTAMPS", True)
    ky_max_new_tokens = _int_env("KYRGYZ_MAX_NEW_TOKENS", 0)
    ky_max_tokens_per_sec = _float_env("KYRGYZ_MAX_NEW_TOKENS_PER_SECOND", 0.0)
    ky_prefix = os.environ.get("KYRGYZ_PREFIX", "")
    # Default prompt primes Cyrillic Kyrgyz output and tells the model to keep
    # Russian/English words only when they are actually spoken.
    ky_initial_prompt = os.environ.get(
        "KYRGYZ_INITIAL_PROMPT",
        "Бул кыргызча текст. Сөздөрдү так жаз, орусча/англисча сөздөрдү айтылганда гана калтыр.",
    )
    ky_normalize = _bool_env("KYRGYZ_NORMALIZE_TEXT", False)
    ky_filter_credits = _bool_env("KYRGYZ_FILTER_CREDITS", True)
    ky_dedupe_min_chars = _int_env("KYRGYZ_DEDUPE_MIN_CHARS", 8)

    print(
        f"[ky] decoding opts: beam={ky_beam_size} best_of={ky_best_of} "
        f"condition={ky_condition} no_repeat_ngram={ky_no_repeat_ngram} "
        f"repetition_penalty={ky_repetition_penalty:.2f} temperature={ky_temperature:.2f} "
        f"without_timestamps={ky_without_timestamps} normalize={ky_normalize} "
        f"filter_credits={ky_filter_credits} dedupe_min={ky_dedupe_min_chars}",
        file=sys.stdout,
        flush=True,
    )
    print(f"[ky] transcribing {len(chunks)} chunks with faster-whisper CT2...", file=sys.stdout, flush=True)
    t_transcribe = time.time()

    with tempfile.TemporaryDirectory() as chunk_dir:
        for idx, chunk_info in enumerate(chunks):
            chunk_path = os.path.join(chunk_dir, f"chunk_{idx:04d}.wav")
            chunk_duration = chunk_info["end"] - chunk_info["start"]
            vad_utils.slice_wav_chunk(wav_path, chunk_path, chunk_info["start"], chunk_info["end"])

            # The converted Kyrgyz model has broken timestamp tokens and hallucinates
            # when asked to predict timestamps on short VAD chunks. Disable timestamp
            # generation and assign the chunk boundaries as the segment timestamps.
            # A dynamic max_new_tokens cap prevents run-on repetitions on short chunks
            # while still allowing longer utterances to complete.
            # Whisper has a hard max_length of 448 tokens. Keep a small safety
            # margin so a long prompt + generated tokens never exceed it.
            max_new_tokens = ky_max_new_tokens if ky_max_new_tokens > 0 else None
            if ky_max_tokens_per_sec > 0:
                dynamic = max(64, int(chunk_duration * ky_max_tokens_per_sec))
                if max_new_tokens is None or dynamic < max_new_tokens:
                    max_new_tokens = dynamic
            if max_new_tokens is not None:
                max_new_tokens = min(max_new_tokens, 440)

            decode_kwargs: Dict[str, Any] = {
                "language": "ky",
                "task": "transcribe",
                "beam_size": ky_beam_size,
                "best_of": ky_best_of,
                "condition_on_previous_text": ky_condition,
                "no_repeat_ngram_size": ky_no_repeat_ngram,
                "repetition_penalty": ky_repetition_penalty,
                "temperature": ky_temperature,
                "word_timestamps": False,
                "vad_filter": False,  # already VAD-split
                "without_timestamps": ky_without_timestamps,
            }
            if max_new_tokens is not None:
                decode_kwargs["max_new_tokens"] = max_new_tokens
            if ky_prefix:
                decode_kwargs["prefix"] = ky_prefix
            if ky_initial_prompt:
                decode_kwargs["initial_prompt"] = ky_initial_prompt

            segments_iter, info = model.transcribe(chunk_path, **decode_kwargs)

            chunk_text_parts: list[str] = []
            for seg in segments_iter:
                text = seg.text.strip()
                if text:
                    chunk_text_parts.append(text)

            chunk_text = " ".join(chunk_text_parts)
            # Some GPU/float16 runs return raw byte-level tokens as text.
            chunk_text = _decode_whisper_bytes(chunk_text)
            if not chunk_text:
                continue

            # Optional script normalization (off by default — the user has
            # confirmed that Kazakh-lookalike letters are acceptable).
            if ky_normalize:
                chunk_text = _normalize_kyrgyz_text(chunk_text)

            # Drop subtitle/credit lines that sometimes leak into the audio.
            if ky_filter_credits and _is_credit_text(chunk_text):
                print(f"[ky] chunk {idx}: filtering credit text", file=sys.stdout, flush=True)
                continue

            # Drop text that already appeared at the end of the previous chunk
            # because of the small VAD overlap window.
            if prev_chunk_text:
                prev_cmp = prev_chunk_text.lower()
                curr_cmp = chunk_text.lower()
                deduped_cmp = _dedupe_chunk_overlap(prev_cmp, curr_cmp, min_chars=ky_dedupe_min_chars)
                removed = len(curr_cmp) - len(deduped_cmp)
                if removed > 0:
                    chunk_text = chunk_text[removed:].lstrip()
                    print(f"[ky] chunk {idx}: removed {removed} overlapping chars", file=sys.stdout, flush=True)

            if chunk_text:
                text_parts.append(chunk_text)
                segments.append({
                    "start": round(chunk_info["start"], 3),
                    "end": round(chunk_info["end"], 3),
                    "text": chunk_text,
                })
                prev_chunk_text = chunk_text if ky_normalize else chunk_text.lower()

    print(
        f"[ky] transcription done in {time.time() - t_transcribe:.1f}s "
        f"(total {time.time() - t_start:.1f}s)",
        file=sys.stdout,
        flush=True,
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

    chunks = _get_vad_chunks(wav_path)
    if chunks is None:
        # VAD disabled or failed: use faster-whisper's internal VAD filter.
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
            text = _decode_whisper_bytes(seg.text.strip())
            segments.append(
                {
                    "start": round(seg.start, 3),
                    "end": round(seg.end, 3),
                    "text": text,
                }
            )
            if text:
                full_text_parts.append(text)

        return {
            "text": " ".join(full_text_parts),
            "language": info.language or language,
            "segments": segments,
            "model": model_path,
            "gpu": _get_gpu_name(),
        }

    if not chunks:
        return {"text": "", "language": language, "segments": [], "model": model_path, "gpu": _get_gpu_name()}

    # Transcribe each VAD chunk separately and shift timestamps back.
    segments: list[dict] = []
    full_text_parts: list[str] = []
    detected_language = whisper_language

    with tempfile.TemporaryDirectory() as chunk_dir:
        for idx, chunk_info in enumerate(chunks):
            chunk_path = os.path.join(chunk_dir, f"chunk_{idx:04d}.wav")
            vad_utils.slice_wav_chunk(wav_path, chunk_path, chunk_info["start"], chunk_info["end"])
            segments_iter, info = model.transcribe(
                chunk_path,
                language=whisper_language,
                task="transcribe",
                beam_size=int(os.environ.get("WHISPER_BEAM_SIZE", "5")),
                best_of=int(os.environ.get("WHISPER_BEST_OF", "5")),
                condition_on_previous_text=os.environ.get("WHISPER_CONDITION_ON_PREVIOUS_TEXT", "true").lower()
                in ("1", "true", "yes"),
                word_timestamps=os.environ.get("WHISPER_WORD_TIMESTAMPS", "false").lower()
                in ("1", "true", "yes"),
                vad_filter=False,
            )

            chunk_offset = chunk_info["start"]
            for seg in segments_iter:
                text = _decode_whisper_bytes(seg.text.strip())
                segments.append(
                    {
                        "start": round(chunk_offset + seg.start, 3),
                        "end": round(chunk_offset + seg.end, 3),
                        "text": text,
                    }
                )
                if text:
                    full_text_parts.append(text)

            if detected_language is None and info.language:
                detected_language = info.language

    return {
        "text": " ".join(full_text_parts),
        "language": detected_language or language,
        "segments": segments,
        "model": model_path,
        "gpu": _get_gpu_name(),
    }


def _set_worker_timeout(seconds: int) -> None:
    """Raise TimeoutError if a single job runs too long (Unix only)."""
    if hasattr(signal, "SIGALRM"):

        def _alarm_handler(_signum, _frame):
            raise TimeoutError(f"Job exceeded worker-side timeout of {seconds}s")

        signal.signal(signal.SIGALRM, _alarm_handler)
        signal.alarm(seconds)


def handler(event):
    t_start = time.time()
    job_input = event.get("input", {})
    audio_b64 = job_input.get("audio_base64")
    language = (job_input.get("language") or "auto").lower()
    filename = job_input.get("filename", "audio")

    if not audio_b64:
        return {"error": "Missing audio_base64"}

    timeout_seconds = max(60, _int_env("GPU_JOB_TIMEOUT_SECONDS", 900))
    _set_worker_timeout(timeout_seconds)

    print(f"[job] started language={language} timeout={timeout_seconds}s", file=sys.stdout, flush=True)

    audio_bytes = base64.b64decode(audio_b64)

    with tempfile.TemporaryDirectory() as tmpdir:
        input_ext = Path(filename).suffix or ".bin"
        input_path = os.path.join(tmpdir, f"input{input_ext}")
        wav_path = os.path.join(tmpdir, "audio.wav")

        with open(input_path, "wb") as f:
            f.write(audio_bytes)

        print(f"[job] input_bytes={len(audio_bytes)} input_ext={input_ext}", file=sys.stdout, flush=True)
        try:
            _convert_to_wav(input_path, wav_path)
        except subprocess.CalledProcessError as e:
            stderr_text = (e.stderr.decode("utf-8", errors="replace") if e.stderr else "")[-1000:]
            return {
                "error": (
                    f"ffmpeg conversion failed: {e}. "
                    f"input_size={len(audio_bytes)} bytes, input_ext={input_ext}. "
                    f"stderr: {stderr_text}"
                )
            }

        try:
            if language == "ky":
                if not os.path.isdir(KYRGYZ_MODEL_PATH):
                    return {"error": f"Kyrgyz model not found: {KYRGYZ_MODEL_PATH}"}
                result = _transcribe_kyrgyz(wav_path)
            else:
                model_path = MODEL_PATHS.get(language, DEFAULT_MODEL)
                if not os.path.isdir(model_path):
                    return {"error": f"Model not found: {model_path}"}
                result = _transcribe_with_faster_whisper(wav_path, model_path, language)
            print(
                f"[job] finished in {time.time() - t_start:.1f}s",
                file=sys.stdout,
                flush=True,
            )
            return result
        except TimeoutError as e:
            return {"error": f"Job timed out: {e}"}
        except Exception as e:
            return {"error": f"Transcription failed: {e}"}


def audio_ext(filename: str) -> str:
    ext = Path(filename).suffix
    if not ext or "." not in ext:
        return ".bin"
    return ext


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
