#!/usr/bin/env python3
"""Hybrid transcription engine optimized for Kyrgyz, Tajik and Uzbek.

Local-first model routing:
  ky -> Vosk large (fallback Vosk small)
  tg -> Fine-tuned Whisper Tajik (CTranslate2)
  uz -> Fine-tuned Whisper Uzbek Rubai (CTranslate2 int8)
  ru -> Whisper large-v3-turbo (CTranslate2 int8)
  en -> Whisper large-v3-turbo (CTranslate2 int8)
  auto -> Whisper large-v3-turbo (CTranslate2 int8) for language detection
  multi -> Whisper large-v3-turbo dual-pass (auto + Russian) for Turkic/Russian code-switching

Long Whisper audio is split into time-based overlapping chunks when VAD is
not enabled, so transcription stays stable and does not drift on podcasts,
interviews and long YouTube videos.

Real-time progress is emitted as JSON lines to stdout.
Diagnostics (model choice, confidence, hallucination flags) go to stderr.
"""

import json
import sys
import os
import re
import wave
import subprocess
import tempfile
import math
from collections import Counter
from difflib import SequenceMatcher

import vad_utils
import text_postprocessing

PYTHON_PATH = "python" if sys.platform == "win32" else "python3"
FFMPEG_PATH = None

# Primary multilingual Whisper model used for ru/en/auto/multi when available.
# This is a local CTranslate2 conversion of openai/whisper-large-v3-turbo.
LOCAL_WHISPER_MODEL = os.environ.get("TILTAB_LOCAL_WHISPER_MODEL", "models/whisper-large-v3-turbo-ct2")

# Initial prompts passed to faster-whisper to prime style, script, and
# guardrails. Keep them short (< ~100 tokens) because they are repeated per
# VAD chunk on the CPU path and per VAD chunk on the GPU worker.
DEFAULT_INITIAL_PROMPT = (
    "Transcribe the spoken words accurately. "
    "Preserve names, numbers, and loanwords. "
    "Do not translate or add explanations."
)
RUSSIAN_INITIAL_PROMPT = (
    "Распознай речь на русском языке. "
    "Сохраняй имена собственные, числа и заимствованные слова. "
    "Не переводи и не добавляй пояснений."
)
UZBEK_INITIAL_PROMPT = (
    "Бу ўзбекча матн. Илтимос, аниқ ёзиб беринг. "
    "Русча ёки инглизча сўзларни фақат айтилганда сақла."
)
TAJIK_INITIAL_PROMPT = (
    "Ин матни тоҷикӣ аст. Лутфан, дақиқ нависед. "
    "Номҳо, рақамҳо ва калимаҳори русӣ ё англисиро "
    "агар гуфта шуда бошанд, нигоҳ дор."
)

# Force UTF-8 on Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


# ---------------------------------------------------------------------------
# Progress / diagnostics
# ---------------------------------------------------------------------------
def emit_progress(percent: int, label: str):
    """Emit a JSON progress line that the Node controller can consume."""
    print(
        json.dumps({"type": "progress", "percent": max(0, min(100, int(percent))), "label": label}, ensure_ascii=False),
        flush=True,
    )


def log_diagnostic(**kwargs):
    """Structured diagnostics to stderr; ignored by Node controller."""
    print(json.dumps(kwargs, ensure_ascii=False), file=sys.stderr, flush=True)


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
_whisper_hf_pipelines = {}


def get_whisper_model(model_path=LOCAL_WHISPER_MODEL):
    """Load and cache a faster-whisper model. Models are kept in memory for reuse."""
    if model_path not in _whisper_models:
        from faster_whisper import WhisperModel
        print(f"[whisper] Loading model: {model_path} ...", file=sys.stderr, flush=True)
        try:
            _whisper_models[model_path] = WhisperModel(
                model_path,
                device="cpu",
                compute_type="int8",
            )
        except (MemoryError, RuntimeError) as e:
            # If the model failed to load because of memory pressure, drop any
            # previously cached whisper models and try once more.
            if "memory" in str(e).lower() or "allocate" in str(e).lower():
                release_whisper_models()
                _whisper_models[model_path] = WhisperModel(
                    model_path,
                    device="cpu",
                    compute_type="int8",
                )
            else:
                raise
        print(f"[whisper] Model {model_path} loaded.", file=sys.stderr, flush=True)
    return _whisper_models[model_path]


def release_whisper_models():
    """Drop cached faster-whisper models to free memory."""
    import gc
    _whisper_models.clear()
    gc.collect()
    print("[whisper] Dropped cached models to free memory.", file=sys.stderr, flush=True)


def local_whisper_model_path() -> str:
    """Return the path to the best available local multilingual Whisper model.

    Prefer the CTranslate2 conversion for speed; fall back to the HuggingFace
    Transformers directory if the conversion is missing. As a last resort return
    the model name so faster-whisper can try to download it (useful on first
    install but not recommended for offline/air-gapped servers).
    """
    ct2_path = LOCAL_WHISPER_MODEL
    if os.path.isdir(ct2_path) and os.path.exists(os.path.join(ct2_path, "model.bin")):
        return ct2_path
    hf_path = os.environ.get("TILTAB_LOCAL_WHISPER_HF_MODEL", "models/whisper-large-v3-turbo")
    if os.path.isdir(hf_path) and os.path.exists(os.path.join(hf_path, "model.safetensors")):
        return hf_path
    return ct2_path


def release_hf_pipelines():
    """Drop cached HuggingFace pipelines to free memory."""
    import gc
    _whisper_hf_pipelines.clear()
    gc.collect()
    print("[whisper-hf] Dropped cached pipelines to free memory.", file=sys.stderr, flush=True)


def get_whisper_hf_pipeline(model_name: str):
    """Load and cache a HuggingFace Whisper pipeline for fine-tuned models."""
    if model_name not in _whisper_hf_pipelines:
        from transformers import pipeline
        print(f"[whisper-hf] Loading model: {model_name} ...", file=sys.stderr, flush=True)
        _whisper_hf_pipelines[model_name] = pipeline(
            "automatic-speech-recognition",
            model=model_name,
            device="cpu",
            chunk_length_s=30,
        )
        print(f"[whisper-hf] Model {model_name} loaded.", file=sys.stderr, flush=True)
    return _whisper_hf_pipelines[model_name]


# ---------------------------------------------------------------------------
# Audio preprocessing
# ---------------------------------------------------------------------------
def _build_ffmpeg_cmd(
    ffmpeg_path: str,
    input_path: str,
    output_path: str,
    enhance: bool,
) -> list[str]:
    cmd = [
        ffmpeg_path,
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i", input_path,
    ]

    if enhance:
        # Audio enhancement pipeline.  Kept conservative: over-aggressive
        # denoising/normalization hurts low-resource-language speech more than
        # it helps, especially for fine-tuned Whisper models.
        # 1. highpass=f=80      - remove low-frequency rumble
        # 2. lowpass=f=8000     - remove high-frequency hiss above speech band
        # 3. dynaudnorm         - dynamic volume normalization
        # 4. afftdn             - light FFT noise reduction
        filter_chain = "highpass=f=80,lowpass=f=8000,dynaudnorm=p=0.95:g=15,afftdn=nr=10:nf=-20"
        cmd.extend(["-af", filter_chain])

    cmd.extend([
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        output_path,
    ])
    return cmd


def convert_to_wav(input_path: str, output_path: str, ffmpeg_path: str, enhance: bool = True):
    skip_enhance = os.environ.get("TILTAB_SKIP_AUDIO_ENHANCE", "").lower() in ("1", "true", "yes")
    if skip_enhance:
        enhance = False

    if not enhance:
        subprocess.run(
            _build_ffmpeg_cmd(ffmpeg_path, input_path, output_path, enhance=False),
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return

    # Try the enhanced pipeline first.
    result = subprocess.run(
        _build_ffmpeg_cmd(ffmpeg_path, input_path, output_path, enhance=True),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode == 0:
        return

    stderr = (result.stderr or b"").decode("utf-8", "replace").strip()
    log_diagnostic(ffmpeg_enhance_failed=True, ffmpeg_returncode=result.returncode, ffmpeg_stderr=stderr)

    # Fallback to a plain conversion.  Some static ffmpeg builds or exotic
    # inputs fail on the filter chain but still produce a usable WAV.
    result2 = subprocess.run(
        _build_ffmpeg_cmd(ffmpeg_path, input_path, output_path, enhance=False),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result2.returncode == 0:
        return

    stderr2 = (result2.stderr or b"").decode("utf-8", "replace").strip()
    raise RuntimeError(
        f"ffmpeg conversion failed (enhance code {result.returncode}, fallback code {result2.returncode}).\n"
        f"Enhance stderr: {stderr}\n"
        f"Plain stderr: {stderr2}"
    )


def load_audio(wav_path: str):
    """Load 16kHz mono WAV and return numpy array."""
    import numpy as np
    wf = wave.open(wav_path, "rb")
    frames = wf.readframes(wf.getnframes())
    wf.close()
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    return audio, 16000


# ---------------------------------------------------------------------------
# Post-processing helpers
# ---------------------------------------------------------------------------
def strip_leading_repetitions(text: str) -> str:
    """Remove leading repeated syllables like 'ololololo...' produced by some models."""
    # Strip leading single repeated syllable/character clusters
    cleaned = text.strip()
    # Pattern: same short sequence (1-4 chars) repeated >= 4 times at the start
    match = re.match(r"^(\S{1,4})(?:\1){3,}", cleaned)
    if match:
        cleaned = cleaned[len(match.group(0)):].strip()
    # Also collapse repeated words at the very beginning
    words = cleaned.split()
    if len(words) >= 4 and words[0] == words[1] == words[2] == words[3]:
        cleaned = " ".join(words[1:]).strip()
    return cleaned


def normalize_repeated_punctuation(text: str) -> str:
    """Collapse repeated punctuation and clean up whitespace."""
    text = re.sub(r"\.{2,}", ".", text)
    text = re.sub(r"\?{2,}", "?", text)
    text = re.sub(r"!{2,}", "!", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def collapse_consecutive_repeats(text: str, max_repeats: int = 3) -> str:
    """Collapse consecutive repeated phrases (common Whisper stuck-token artifact).

    Only collapses immediate repetitions of the same word/phrase more than
    max_repeats times, which is conservative enough to avoid damaging real speech.
    """
    words = text.split()
    if not words:
        return text

    result = []
    i = 0
    while i < len(words):
        # Find longest repeated phrase starting here
        best_len = 1
        best_count = 1
        for phrase_len in range(1, min(9, len(words) - i + 1)):
            phrase = words[i:i + phrase_len]
            count = 1
            j = i + phrase_len
            while j + phrase_len <= len(words) and words[j:j + phrase_len] == phrase:
                count += 1
                j += phrase_len
            if count > best_count:
                best_count = count
                best_len = phrase_len

        phrase = words[i:i + best_len]
        if best_count > max_repeats:
            result.extend(phrase)
            i += best_len * best_count
        else:
            result.append(words[i])
            i += 1

    return " ".join(result)


def _normalize_word_for_dedup(word: str) -> str:
    """Strip punctuation and lowercase a word for boundary comparison."""
    return re.sub(r"[^\w]", "", word).lower()


def _longest_common_suffix_prefix(words_a, words_b, max_len=None):
    """Return length of longest common word sequence at end of a and start of b."""
    if not words_a or not words_b:
        return 0
    max_len = max_len or min(len(words_a), len(words_b))
    max_len = min(max_len, len(words_a), len(words_b))
    for length in range(max_len, 0, -1):
        suffix = [_normalize_word_for_dedup(w) for w in words_a[-length:]]
        prefix = [_normalize_word_for_dedup(w) for w in words_b[:length]]
        if suffix == prefix:
            return length
    return 0


def deduplicate_segment_boundaries(segments, max_time_gap=2.0, min_common_words=2, max_common_words=12):
    """Remove repeated word sequences at boundaries of adjacent/overlapping segments.

    Whisper (especially with condition_on_previous_text) often emits the same
    words at the end of one segment and the start of the next. This function
    detects such overlaps and strips the duplicated prefix from the later
    segment. Empty segments after trimming are dropped.
    """
    if not segments:
        return []
    segments = sorted(segments, key=lambda s: s.get("start", 0.0))
    deduped = [segments[0]]
    for seg in segments[1:]:
        last = deduped[-1]
        gap = seg.get("start", 0.0) - last.get("end", 0.0)
        # Allow segments that overlap or are very close in time.
        if gap <= max_time_gap:
            words_last = last.get("text", "").split()
            words_seg = seg.get("text", "").split()
            common = _longest_common_suffix_prefix(
                words_last,
                words_seg,
                max_len=min(max_common_words, len(words_last), len(words_seg)),
            )
            # Also allow single-word boundary duplicates if the word is long
            # enough and the segments actually overlap in time. This catches
            # cases like "...обычного сегмента." / "сегмента типа..." while
            # avoiding removal of short function words.
            time_overlap = max(0.0, min(seg["end"], last["end"]) - max(seg["start"], last["start"]))
            allow_single_word = (
                common == 1
                and words_last
                and words_seg
                and len(_normalize_word_for_dedup(words_last[-1])) > 3
                and time_overlap > 0.2
            )
            if common >= min_common_words or allow_single_word:
                remaining = words_seg[common:]
                if remaining:
                    seg["text"] = " ".join(remaining)
                    # If the segments overlap in time, push the start forward so
                    # the cleaned segment does not begin before the previous one.
                    if seg["start"] < last["end"]:
                        seg["start"] = last["end"]
                    deduped.append(seg)
                # If nothing remains, drop the duplicated segment entirely.
                continue
        deduped.append(seg)

    for new_id, seg in enumerate(deduped):
        seg["id"] = new_id
    return deduped


# ---------------------------------------------------------------------------
# Quality analysis / hallucination detection
# ---------------------------------------------------------------------------
def compute_mean_confidence(segments):
    if not segments:
        return 0.0
    values = [s.get("confidence", 0.0) for s in segments]
    return sum(values) / len(values)


def detect_hallucination(text: str, segments, expected_language: str):
    """Return a dict with quality flags."""
    flags = []
    text = text.strip()

    if not text:
        flags.append("empty_output")

    # Repetition of single word/phrase many times
    words = re.findall(r"\b\w+\b", text.lower())
    if words:
        most_common = Counter(words).most_common(1)[0]
        if most_common[1] >= 5 and most_common[1] / len(words) > 0.4:
            flags.append(f"repetition:{most_common[0]}")

    # Leading repetition artifact
    if re.match(r"^(\S{1,4})(?:\1){3,}", text):
        flags.append("leading_repetition")

    # English tokens in non-English target (cheap heuristic)
    if expected_language in ("tg", "ky", "uz", "ru"):
        english_words = re.findall(r"\b(have|has|had|you|your|was|were|this|that|with|from|they|them|their|there|then|than|also|been|having|said|only|god|real|kind|missed|thank|people|some|know|going|get|got|and|but|or|not|no)\b", text.lower())
        if len(english_words) > 3:
            flags.append("english_intrusion")

    # Very long segment without punctuation. Vosk does not add punctuation, so skip
    # this flag for languages where Vosk is the primary engine.
    if expected_language not in ("ky", "uz") and len(text) > 200 and not any(p in text for p in ".,!?؛؟،"):
        flags.append("unpunctuated_long_text")

    # Low average confidence. Vosk reports 0.0 confidence, so only flag low confidence
    # when the engine actually reported a positive confidence value.
    mean_conf = compute_mean_confidence(segments)
    if expected_language not in ("ky",) and 0 < mean_conf < 0.3:
        flags.append("low_confidence")

    # Latin characters in Cyrillic languages
    if expected_language in ("tg", "ky", "ru"):
        latin_ratio = len(re.findall(r"[a-zA-Z]", text)) / max(len(text), 1)
        if latin_ratio > 0.1:
            flags.append("latin_in_cyrillic")

    return {
        "is_hallucination": bool(flags),
        "flags": flags,
        "mean_confidence": mean_conf,
        "char_count": len(text),
        "word_count": len(words),
    }


def select_best_output(candidates):
    """Choose the candidate with the fewest hallucination flags and highest confidence."""
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]

    def score(candidate):
        quality = candidate.get("quality", {})
        flag_count = len(quality.get("flags", []))
        mean_conf = quality.get("mean_confidence", -1.0)
        length = quality.get("char_count", 0)
        return (-flag_count, mean_conf, length)

    return max(candidates, key=score)


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


def transcribe_vosk_chunked(wav_path: str, model_path: str, chunk_seconds: float = 25.0, overlap_seconds: float = 5.0, progress_label: str = "Распознаю"):
    """Transcribe long audio with Vosk by sliding-window chunks.

    Each chunk is processed independently and word timestamps are adjusted back
    to the original audio timeline. Overlapping words are deduplicated.
    """
    # Allow runtime tuning of chunk/overlap without code changes.
    env_chunk = os.environ.get("TILTAB_VOSK_CHUNK_SECONDS", "").strip()
    env_overlap = os.environ.get("TILTAB_VOSK_OVERLAP_SECONDS", "").strip()
    if env_chunk:
        try:
            chunk_seconds = max(5.0, float(env_chunk))
        except ValueError:
            pass
    if env_overlap:
        try:
            overlap_seconds = max(0.0, min(chunk_seconds / 2, float(env_overlap)))
        except ValueError:
            pass

    from vosk import Model, KaldiRecognizer

    emit_progress(0, f"{progress_label}: загрузка модели...")
    model = Model(model_path)

    wf = wave.open(wav_path, "rb")
    nchannels = wf.getnchannels()
    sampwidth = wf.getsampwidth()
    framerate = wf.getframerate()
    nframes = wf.getnframes()
    total_duration = nframes / framerate

    # Short files do not benefit from chunking.
    if total_duration <= chunk_seconds + overlap_seconds:
        wf.close()
        return transcribe_vosk(wav_path, model_path, progress_label=progress_label)

    frame_size = nchannels * sampwidth
    chunk_frames = int(chunk_seconds * framerate)
    overlap_frames = int(overlap_seconds * framerate)
    step_frames = chunk_frames - overlap_frames
    chunk_count = max(1, (nframes - overlap_frames + step_frames - 1) // step_frames)

    all_words = []
    start_frame = 0
    chunk_index = 0

    while start_frame < nframes:
        end_frame = min(start_frame + chunk_frames, nframes)
        chunk_duration_frames = end_frame - start_frame

        wf.setpos(start_frame)
        data = wf.readframes(chunk_duration_frames)

        rec = KaldiRecognizer(model, framerate)
        rec.SetWords(True)
        pos = 0
        frame_bytes = 4000 * frame_size
        while pos < len(data):
            chunk = data[pos:pos + frame_bytes]
            rec.AcceptWaveform(chunk)
            pos += len(chunk)
        part = json.loads(rec.FinalResult())
        offset = start_frame / framerate
        for w in part.get("result", []):
            all_words.append({
                "word": w["word"],
                "start": round(w["start"] + offset, 3),
                "end": round(w["end"] + offset, 3),
                "conf": w.get("conf", 0.0),
            })

        chunk_index += 1
        progress = int(10 + 80 * chunk_index / chunk_count) if chunk_count else 10
        emit_progress(progress, f"{progress_label}: чанк {chunk_index}/{chunk_count}")
        start_frame += step_frames

    wf.close()

    # Deduplicate words that appeared in overlapping regions.
    unique_words = []
    for w in sorted(all_words, key=lambda x: x["start"]):
        if (
            unique_words
            and w["word"] == unique_words[-1]["word"]
            and abs(w["start"] - unique_words[-1]["start"]) < 0.7
        ):
            continue
        unique_words.append(w)

    full_text = " ".join(w["word"] for w in unique_words)
    emit_progress(100, progress_label)
    return [{"text": full_text, "result": unique_words}]


# ---------------------------------------------------------------------------
# Whisper transcription (faster-whisper)
# ---------------------------------------------------------------------------
def _whisper_beam_size(conservative: bool) -> int:
    env = os.environ.get("TILTAB_WHISPER_BEAM_SIZE", "").strip()
    if env:
        try:
            return max(1, int(env))
        except ValueError:
            pass
    return 1 if conservative else 5


def transcribe_whisper(
    wav_path: str,
    language: str | None,
    model_path: str = LOCAL_WHISPER_MODEL,
    progress_label: str = "Распознаю",
    initial_prompt: str | None = None,
    conservative: bool = False,
    vad_parameters: dict | None = None,
    emit_progress_enabled: bool = True,
):
    model = get_whisper_model(model_path)
    duration = get_audio_duration(wav_path)

    def _emit(percent: int, label: str):
        if emit_progress_enabled:
            emit_progress(percent, label)

    _emit(0, f"{progress_label}: загрузка модели...")

    prompt = initial_prompt if initial_prompt else DEFAULT_INITIAL_PROMPT

    # Fine-tuned models are often more stable with greedy decoding, but allow override.
    beam_size = _whisper_beam_size(conservative)
    best_of = 1 if conservative else 5

    # Word timestamps give per-word confidence and cleaner segment boundaries.
    # Some fine-tuned CTranslate2 models produce garbage when word timestamps are
    # requested, so keep the original conservative/non-conservative split unless
    # explicitly overridden via TILTAB_WHISPER_WORD_TIMESTAMPS.
    env_wts = os.environ.get("TILTAB_WHISPER_WORD_TIMESTAMPS", "").strip().lower()
    if env_wts in ("0", "false", "off"):
        word_timestamps = False
    elif env_wts in ("1", "true", "on"):
        word_timestamps = True
    else:
        word_timestamps = False if conservative else True

    # Conditioning on previous text helps short clips but often causes drift and
    # repetition on longer audio. Short clips keep it on by default; long clips
    # (>30 s) turn it off by default.
    condition_on_previous_text = True
    if duration > 0 and duration <= 30:
        condition_on_previous_text = os.environ.get("TILTAB_WHISPER_CONDITION_SHORT", "true").lower() not in ("0", "false", "off")
    else:
        condition_on_previous_text = os.environ.get("TILTAB_WHISPER_CONDITION_LONG", "true").lower() not in ("0", "false", "off")

    use_vad_filter = os.environ.get("TILTAB_WHISPER_VAD_FILTER", "true").lower() not in ("0", "false", "off")

    transcribe_kwargs = dict(
        language=language if language else None,
        word_timestamps=word_timestamps,
        condition_on_previous_text=condition_on_previous_text,
        vad_filter=use_vad_filter,
        beam_size=beam_size,
        best_of=best_of,
        initial_prompt=prompt,
    )
    if vad_parameters:
        transcribe_kwargs["vad_parameters"] = vad_parameters

    segments_iter, info = model.transcribe(wav_path, **transcribe_kwargs)

    _emit(5, progress_label)

    result_segments = []
    seg_id = 0
    full_text_parts = []

    for segment in segments_iter:
        words = getattr(segment, "words", []) or []
        confidences = [getattr(w, "probability", 0.0) for w in words]
        avg_conf = sum(confidences) / len(confidences) if confidences else (getattr(segment, "avg_logprob", 0.0) or 0.0)

        result_segments.append({
            "id": seg_id,
            "start": segment.start,
            "end": segment.end,
            "text": segment.text.strip(),
            "confidence": avg_conf,
        })
        seg_id += 1
        full_text_parts.append(segment.text.strip())
        if duration:
            progress = 5 + int(90 * segment.end / duration)
            _emit(progress, progress_label)

    _emit(100, progress_label)
    full_text = normalize_repeated_punctuation(" ".join(full_text_parts))
    full_text = collapse_consecutive_repeats(full_text)
    return {
        "text": full_text,
        "language": info.language,
        "segments": result_segments,
    }


def _vad_enabled() -> bool:
    # VAD chunking is opt-in until it is validated on the target hardware.
    return os.environ.get("TILTAB_VAD_ENABLED", "false").lower() in ("1", "true", "on", "yes")


def _vad_float_env(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _vad_int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _time_chunk_params() -> tuple[float, float, float]:
    """Return (threshold_seconds, chunk_seconds, overlap_seconds) from env."""
    threshold = _vad_float_env("TILTAB_WHISPER_CHUNK_THRESHOLD_SECONDS", 300.0)
    chunk_seconds = _vad_float_env("TILTAB_WHISPER_CHUNK_SECONDS", 300.0)
    overlap_seconds = _vad_float_env("TILTAB_WHISPER_CHUNK_OVERLAP_SECONDS", 5.0)
    chunk_seconds = max(60.0, chunk_seconds)
    overlap_seconds = max(0.0, min(chunk_seconds / 2.0, overlap_seconds))
    threshold = max(60.0, threshold)
    return threshold, chunk_seconds, overlap_seconds


def _slice_wav_chunk(wav_path: str, output_wav: str, start_sec: float, end_sec: float) -> None:
    """Copy a [start_sec, end_sec) slice from a 16-bit PCM WAV file."""
    with wave.open(wav_path, "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        start_frame = int(start_sec * framerate)
        end_frame = int(end_sec * framerate)
        wf.setpos(start_frame)
        frames = wf.readframes(end_frame - start_frame)

    with wave.open(output_wav, "wb") as of:
        of.setnchannels(n_channels)
        of.setsampwidth(sampwidth)
        of.setframerate(framerate)
        of.writeframes(frames)


def transcribe_whisper_time_chunked(
    wav_path: str,
    language: str | None,
    model_path: str = LOCAL_WHISPER_MODEL,
    progress_label: str = "Распознаю",
    initial_prompt: str | None = None,
    conservative: bool = False,
    vad_parameters: dict | None = None,
):
    """Transcribe long audio by splitting it into overlapping time chunks.

    Each chunk is processed independently and timestamps are shifted back to the
    original audio timeline. Overlapping boundary segments are deduplicated so
    words on chunk edges are not doubled.
    """
    threshold, chunk_seconds, overlap_seconds = _time_chunk_params()
    duration = get_audio_duration(wav_path)

    # Short audio does not benefit from external chunking; let faster-whisper
    # handle it internally with its own 30 s windowing.
    if duration <= threshold:
        return transcribe_whisper(
            wav_path,
            language,
            model_path,
            progress_label,
            initial_prompt,
            conservative,
            vad_parameters,
        )

    log_diagnostic(
        language=language,
        chunking="time_based",
        chunk_seconds=chunk_seconds,
        overlap_seconds=overlap_seconds,
        duration=duration,
    )

    step = chunk_seconds - overlap_seconds
    chunk_starts = list(range(0, int(math.ceil(duration - overlap_seconds)), int(step)))
    if not chunk_starts:
        chunk_starts = [0]
    total_chunks = len(chunk_starts)

    all_segments = []
    full_text_parts = []
    detected_language = language

    for idx, start in enumerate(chunk_starts):
        end = min(duration, start + chunk_seconds)
        # Extend with overlap for acoustic context, then trim timestamps back.
        slice_start = max(0.0, start - overlap_seconds)
        slice_end = min(duration, end + overlap_seconds)

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            chunk_path = tmp.name
        try:
            _slice_wav_chunk(wav_path, chunk_path, slice_start, slice_end)
            result = transcribe_whisper(
                chunk_path,
                language,
                model_path,
                progress_label=f"{progress_label}: чанк {idx + 1}/{total_chunks}",
                initial_prompt=initial_prompt,
                conservative=conservative,
                vad_parameters=vad_parameters,
                emit_progress_enabled=False,
            )
            if detected_language is None and result.get("language"):
                detected_language = result["language"]
            offset = slice_start
            for seg in result.get("segments", []):
                seg_start = seg["start"] + offset
                seg_end = seg["end"] + offset
                # Keep only segments that overlap the original (non-overlapped) window.
                if seg_end <= start or seg_start >= end:
                    continue
                seg["start"] = round(max(start, seg_start), 3)
                seg["end"] = round(min(end, seg_end), 3)
                all_segments.append(seg)
            if result.get("text", "").strip():
                full_text_parts.append(result["text"].strip())
        finally:
            try:
                os.unlink(chunk_path)
            except OSError:
                pass

        emit_progress(int(10 + 85 * (idx + 1) / total_chunks), progress_label)

    all_segments.sort(key=lambda s: s["start"])
    # Deduplicate boundary overlaps: if two segments overlap heavily in time
    # and have very similar text, keep the longer/cleaner one.
    deduped = []
    for seg in all_segments:
        if deduped:
            last = deduped[-1]
            time_overlap = max(0.0, min(seg["end"], last["end"]) - max(seg["start"], last["start"]))
            text_similarity = SequenceMatcher(None, seg["text"], last["text"]).ratio()
            if time_overlap > 0.5 and text_similarity > 0.85:
                if len(seg["text"]) > len(last["text"]):
                    deduped[-1] = seg
                continue
        deduped.append(seg)

    # Remove repeated words/phrases at segment boundaries. This is common when
    # Whisper re-decodes the tail of one chunk at the start of the next.
    deduped = deduplicate_segment_boundaries(deduped)

    for new_id, seg in enumerate(deduped):
        seg["id"] = new_id

    # Rebuild full text from cleaned segments so boundary dedup is reflected.
    full_text = normalize_repeated_punctuation(" ".join(s["text"] for s in deduped if s.get("text", "").strip()))
    full_text = collapse_consecutive_repeats(full_text)
    emit_progress(100, progress_label)
    return {
        "text": full_text,
        "language": detected_language if detected_language else (deduped[0].get("language") if deduped else "auto"),
        "segments": deduped,
    }


def transcribe_whisper_with_vad(
    wav_path: str,
    language: str | None,
    model_path: str = "distil-large-v3",
    progress_label: str = "Распознаю",
    initial_prompt: str | None = None,
    conservative: bool = False,
    vad_parameters: dict | None = None,
):
    """Run Whisper transcription only on speech regions detected by Silero VAD.

    This avoids sending music, intro/outro noise, and long silences to the STT
    model, which is the main cause of hallucinated garbage segments.
    """
    if not _vad_enabled():
        # When VAD is off we still chunk very long audio in the time domain so
        # conditioning on previous text does not drift across long podcasts.
        return transcribe_whisper_time_chunked(
            wav_path, language, model_path, progress_label, initial_prompt, conservative, vad_parameters
        )

    duration = get_audio_duration(wav_path)
    # Conservative defaults: keep more speech, merge across longer pauses.
    # VAD chunking is opt-in, so these only apply when TILTAB_VAD_ENABLED=true.
    threshold = _vad_float_env("TILTAB_VAD_THRESHOLD", 0.3)
    min_speech_ms = _vad_int_env("TILTAB_VAD_MIN_SPEECH_MS", 150)
    min_silence_ms = _vad_int_env("TILTAB_VAD_MIN_SILENCE_MS", 100)
    speech_pad_ms = _vad_int_env("TILTAB_VAD_SPEECH_PAD_MS", 200)
    max_gap = _vad_float_env("TILTAB_VAD_MAX_GAP", 2.5)
    max_duration = _vad_float_env("TILTAB_VAD_MAX_DURATION", 60.0)
    overlap_ms = _vad_float_env("TILTAB_VAD_OVERLAP_MS", 400)
    overlap_sec = overlap_ms / 1000.0

    emit_progress(2, f"{progress_label}: VAD segmentation...")
    speech_segments = vad_utils.get_speech_segments(
        wav_path,
        sample_rate=16000,
        threshold=threshold,
        min_speech_duration_ms=min_speech_ms,
        min_silence_duration_ms=min_silence_ms,
        speech_pad_ms=speech_pad_ms,
    )

    if not speech_segments:
        log_diagnostic(language=language, vad_status="no_speech_detected", fallback="full_file")
        return transcribe_whisper_time_chunked(
            wav_path, language, model_path, progress_label, initial_prompt, conservative, vad_parameters
        )

    chunks = vad_utils.merge_speech_segments(speech_segments, max_gap=max_gap, max_duration=max_duration)

    log_diagnostic(language=language, vad_status="chunked", chunks=len(chunks), duration=duration)

    all_segments = []
    full_text_parts = []
    detected_language = language
    total_chunks = len(chunks)
    for idx, chunk in enumerate(chunks):
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            chunk_path = tmp.name
        try:
            # Slice with overlap so Whisper has acoustic context at chunk boundaries.
            slice_start = max(0.0, chunk["start"] - overlap_sec)
            slice_end = min(duration, chunk["end"] + overlap_sec)
            vad_utils.slice_wav_chunk(wav_path, chunk_path, slice_start, slice_end)
            result = transcribe_whisper(
                chunk_path,
                language,
                model_path,
                progress_label=f"{progress_label}: чанк {idx + 1}/{total_chunks}",
                initial_prompt=initial_prompt,
                conservative=conservative,
                vad_parameters=vad_parameters,
                emit_progress_enabled=False,
            )
            if detected_language is None and result.get("language"):
                detected_language = result["language"]
            offset = slice_start
            for seg in result.get("segments", []):
                seg_start = seg["start"] + offset
                seg_end = seg["end"] + offset
                # Keep segments that overlap the original chunk region.
                if seg_end <= chunk["start"] or seg_start >= chunk["end"]:
                    continue
                seg["start"] = round(seg_start, 3)
                seg["end"] = round(seg_end, 3)
                all_segments.append(seg)
            if result.get("text", "").strip():
                full_text_parts.append(result["text"].strip())
            emit_progress(int(10 + 85 * (idx + 1) / total_chunks), progress_label)
        finally:
            try:
                os.unlink(chunk_path)
            except OSError:
                pass

    all_segments.sort(key=lambda s: s["start"])
    # Deduplicate overlapping boundary segments (same text within ~1 s).
    deduped = []
    for seg in all_segments:
        if deduped:
            last = deduped[-1]
            time_overlap = max(0.0, min(seg["end"], last["end"]) - max(seg["start"], last["start"]))
            text_similarity = SequenceMatcher(None, seg["text"], last["text"]).ratio()
            if time_overlap > 0.5 and text_similarity > 0.85:
                # Keep the longer segment.
                if len(seg["text"]) > len(last["text"]):
                    deduped[-1] = seg
                continue
        deduped.append(seg)
    all_segments = deduped

    # Remove repeated words/phrases at segment boundaries produced by VAD chunk
    # overlap or Whisper's previous-text conditioning.
    all_segments = deduplicate_segment_boundaries(all_segments)

    for new_id, seg in enumerate(all_segments):
        seg["id"] = new_id

    # Rebuild full text from cleaned segments so boundary dedup is reflected.
    full_text = normalize_repeated_punctuation(" ".join(s["text"] for s in all_segments if s.get("text", "").strip()))
    full_text = collapse_consecutive_repeats(full_text)
    emit_progress(100, progress_label)
    return {
        "text": full_text,
        "language": detected_language if detected_language else (all_segments[0].get("language") if all_segments else "auto"),
        "segments": all_segments,
    }


# ---------------------------------------------------------------------------
# Whisper transcription (HuggingFace pipeline for fine-tuned models)
# ---------------------------------------------------------------------------
def transcribe_whisper_hf(wav_path: str, model_name: str, language: str, progress_label: str = "Распознаю"):
    """Transcribe audio with a HuggingFace Whisper pipeline (fine-tuned)."""
    import numpy as np

    pipe = get_whisper_hf_pipeline(model_name)
    audio, sr = load_audio(wav_path)

    emit_progress(5, progress_label)
    generate_kwargs = None
    if language and language != "auto":
        generate_kwargs = {"language": language, "task": "transcribe"}
    if generate_kwargs:
        result = pipe(audio, return_timestamps=True, generate_kwargs=generate_kwargs)
    else:
        result = pipe(audio, return_timestamps=True)
    emit_progress(95, progress_label)

    full_text = strip_leading_repetitions(result.get("text", "").strip())
    full_text = normalize_repeated_punctuation(full_text)
    chunks = result.get("chunks", [])
    segments = []
    seg_id = 0
    for chunk in chunks:
        timestamp = chunk.get("timestamp") or (0.0, 0.0)
        if not isinstance(timestamp, (list, tuple)):
            start, end = 0.0, 0.0
        else:
            start = timestamp[0] if timestamp[0] is not None else 0.0
            end = timestamp[1] if len(timestamp) > 1 and timestamp[1] is not None else start
        text = strip_leading_repetitions(chunk.get("text", "").strip())
        text = normalize_repeated_punctuation(text)
        if text:
            segments.append({
                "id": seg_id,
                "start": float(start),
                "end": float(end),
                "text": text,
                "confidence": 0.5,  # HF pipeline does not expose per-word probs easily
            })
            seg_id += 1

    if not full_text and segments:
        full_text = " ".join(s["text"] for s in segments)

    full_text = collapse_consecutive_repeats(full_text)

    emit_progress(100, progress_label)
    return {
        "text": full_text,
        "language": language,
        "segments": segments,
    }


# ---------------------------------------------------------------------------
# Wav2Vec2 transcription (kept as optional fallback)
# ---------------------------------------------------------------------------
def get_wav2vec_model(model_name: str):
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


def transcribe_wav2vec2(wav_path: str, model_name: str, language: str, progress_label: str = "Распознаю"):
    import torch
    import numpy as np

    processor, model, device = get_wav2vec_model(model_name)
    audio, sr = load_audio(wav_path)

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

        transcription = transcription.strip()
        if transcription:
            full_text_parts.append(transcription)
            segments.append({
                "id": seg_id,
                "start": chunk_start,
                "end": chunk_end,
                "text": transcription,
                "confidence": 0.0,
            })
            seg_id += 1
        progress = 5 + int(90 * seg_id / total_chunks) if total_chunks else 5
        emit_progress(progress, progress_label)

    full_text = normalize_repeated_punctuation(" ".join(full_text_parts))
    emit_progress(100, progress_label)
    return {
        "text": full_text,
        "language": language,
        "segments": segments,
    }


# ---------------------------------------------------------------------------
# Language-specific wrappers with fallbacks
# ---------------------------------------------------------------------------
def transcribe_kyrgyz(wav_path: str):
    large_path = "models/vosk-model-ky-0.42"
    small_path = "models/vosk-model-small-ky-0.42"
    disable_fallback = os.environ.get("TILTAB_KYRGYZ_DISABLE_FALLBACK", "").lower() in ("1", "true", "yes", "on")
    # The large Kyrgyz model is ~1.9 GB. On a 4 GB VPS it OOMs when Rubai is also resident,
    # so release cached Whisper models before loading large Vosk to free RAM.
    use_large = os.path.exists(large_path)
    if use_large:
        release_whisper_models()
    model_path = large_path if use_large else small_path

    log_diagnostic(language="ky", primary_model="vosk", model_path=model_path)

    results = transcribe_vosk_chunked(wav_path, model_path, progress_label="Кыргызча распознаю")
    segments = build_vosk_segments(results)
    full_text = normalize_repeated_punctuation(" ".join(s["text"] for s in segments))

    # If the large model produced too little speech (e.g. missed a quiet intro),
    # fall back to the small model which is more sensitive to weak audio.
    duration = get_audio_duration(wav_path)
    min_expected_words = max(3, int(duration / 2.5))
    if not disable_fallback and use_large and len(full_text.split()) < min_expected_words and os.path.exists(small_path):
        log_diagnostic(
            language="ky",
            fallback_reason="large_model_produced_too_few_words",
            large_word_count=len(full_text.split()),
            min_expected_words=min_expected_words,
        )
        results = transcribe_vosk_chunked(wav_path, small_path, progress_label="Кыргызча распознаю (small fallback)")
        segments = build_vosk_segments(results)
        full_text = normalize_repeated_punctuation(" ".join(s["text"] for s in segments))

    output = {"text": full_text, "language": "ky", "segments": segments}
    quality = detect_hallucination(full_text, segments, "ky")
    output["quality"] = quality

    if quality["is_hallucination"] or len(full_text.strip()) < 10:
        log_diagnostic(language="ky", fallback_reason=quality["flags"])
        # Whisper does not support Kyrgyz ('ky'), so we cannot fall back to it cleanly.
        # Instead we return the Vosk result with a warning flag for downstream handling.
        quality["flags"].append("vosk_quality_warning")

    return output


def transcribe_tajik(wav_path: str):
    fine_tuned_path = "models/whisper-tajik-finetuned-ct2"
    has_fine_tuned = os.path.exists(fine_tuned_path)

    # Conservative decoding is safer for clean speech; disable it for hard
    # multi-speaker/noisy audio if TILTAB_TAJIK_CONSERVATIVE=false.
    conservative_tg = os.environ.get("TILTAB_TAJIK_CONSERVATIVE", "true").lower() not in ("0", "false", "off")

    # Temporarily disable fallback models to isolate the primary fine-tuned model.
    disable_fallback = os.environ.get("TILTAB_TAJIK_DISABLE_FALLBACK", "").lower() in ("1", "true", "yes", "on")

    candidates = []

    # Primary: local open-source fine-tuned Whisper Tajik model (CTranslate2).
    if has_fine_tuned:
        log_diagnostic(language="tg", primary_model="whisper-tajik-finetuned-ct2", conservative=conservative_tg)
        try:
            fine = transcribe_whisper_with_vad(
                wav_path,
                "tg",
                fine_tuned_path,
                progress_label="Тоҷикӣ распознаю",
                conservative=conservative_tg,
                initial_prompt=TAJIK_INITIAL_PROMPT,
            )
            fine_quality = detect_hallucination(fine["text"], fine["segments"], "tg")
            fine["quality"] = fine_quality
            fine["model"] = "whisper-tajik-finetuned-ct2"
            log_diagnostic(language="tg", fine_tuned_quality=fine_quality)

            # Trust the fine-tuned model unless it shows obvious hallucination artifacts.
            # Low log-prob confidence is expected with conservative decoding and should
            # not trigger a fallback to the generic model.
            fine = text_postprocessing.postprocess_transcription(fine, "tg")

            if disable_fallback:
                log_diagnostic(language="tg", fallback="disabled", returning=fine.get("model", "fine-tuned"), char_count=len(fine.get("text", "")))
                return fine

            serious_flags = [f for f in fine_quality["flags"] if f not in ("low_confidence",)]
            if not serious_flags:
                log_diagnostic(language="tg", selected_model=fine["model"], selected_quality=fine_quality)
                return fine
            candidates.append(fine)
        except Exception as e:
            log_diagnostic(language="tg", fine_tuned_error=str(e))
            # Fine-tuned model may have failed due to memory pressure; release it
            # before trying the next model.
            if "memory" in str(e).lower() or "allocate" in str(e).lower():
                release_whisper_models()
            if disable_fallback:
                raise

    # Fall back to generic Whisper if the fine-tuned model failed or hallucinated.
    if not disable_fallback and (not candidates or all(c.get("quality", {}).get("is_hallucination", True) for c in candidates)):
        log_diagnostic(language="tg", fallback_model=local_whisper_model_path())
        try:
            fallback = transcribe_whisper_with_vad(
                wav_path,
                "tg",
                local_whisper_model_path(),
                progress_label="Тоҷикӣ (fallback) распознаю",
                initial_prompt=TAJIK_INITIAL_PROMPT,
            )
            fallback_quality = detect_hallucination(fallback["text"], fallback["segments"], "tg")
            fallback["quality"] = fallback_quality
            fallback["model"] = local_whisper_model_path()
            candidates.append(fallback)
        except Exception as e:
            log_diagnostic(language="tg", whisper_error=str(e))
            if "memory" in str(e).lower() or "allocate" in str(e).lower():
                release_whisper_models()

    # Final fallback: small Vosk Tajik model. It is much lighter and avoids OOM.
    if not disable_fallback and (not candidates or all(c.get("quality", {}).get("is_hallucination", True) for c in candidates)):
        vosk_path = "models/vosk-model-small-tg-0.22"
        if os.path.exists(vosk_path):
            log_diagnostic(language="tg", fallback_model="vosk-small-tg")
            try:
                results = transcribe_vosk(wav_path, vosk_path, progress_label="Тоҷикӣ Vosk fallback")
                segments = build_vosk_segments(results)
                full_text = normalize_repeated_punctuation(" ".join(s["text"] for s in segments))
                vosk_result = {"text": full_text, "language": "tg", "segments": segments}
                vosk_quality = detect_hallucination(full_text, segments, "tg")
                vosk_result["quality"] = vosk_quality
                vosk_result["model"] = "vosk-small-tg"
                candidates.append(vosk_result)
            except Exception as e:
                log_diagnostic(language="tg", vosk_error=str(e))

    best = select_best_output(candidates)

    if best is None:
        raise RuntimeError("All Tajik transcription models failed")

    log_diagnostic(
        language="tg",
        selected_model=best.get("model", "unknown"),
        selected_flags=best.get("quality", {}).get("flags", []),
        selected_char_count=len(best.get("text", "")),
    )

    return best


def transcribe_uzbek(wav_path: str):
    candidates = []
    disable_fallback = os.environ.get("TILTAB_UZBEK_DISABLE_FALLBACK", "").lower() in ("1", "true", "yes", "on")

    # Primary: fine-tuned Whisper Uzbek (Rubai) converted to CTranslate2 int8.
    # This model is much more accurate than Vosk small on our hard benchmark.
    # Use it for files up to 10 minutes; longer files fall back to generic Whisper
    # or Vosk to avoid excessive RAM/time on CPU.
    rubai_path = "models/rubai-ct2-int8"
    duration = get_audio_duration(wav_path)
    rubai_max_seconds = float(os.environ.get("TILTAB_RUBAI_MAX_DURATION_SECONDS", "600"))
    use_rubai = os.path.exists(rubai_path) and duration > 0 and duration <= rubai_max_seconds
    rubai_oom = False

    if use_rubai:
        log_diagnostic(language="uz", primary_model="rubai-ct2-int8", model_path=rubai_path, duration_seconds=duration)
        try:
            rubai_result = transcribe_whisper_with_vad(
                wav_path,
                "uz",
                rubai_path,
                progress_label="O'zbekcha Rubai распознаю",
                initial_prompt=UZBEK_INITIAL_PROMPT,
            )
            rubai_quality = detect_hallucination(rubai_result["text"], rubai_result["segments"], "uz")
            rubai_result["quality"] = rubai_quality
            log_diagnostic(language="uz", rubai_quality=rubai_quality)
            if not rubai_quality["is_hallucination"] and len(rubai_result["text"].strip()) >= 10:
                return rubai_result
            candidates.append(rubai_result)
        except Exception as e:
            log_diagnostic(language="uz", rubai_error=str(e))
            if "memory" in str(e).lower() or "allocate" in str(e).lower():
                rubai_oom = True
                release_whisper_models()

    # Fallback: generic local multilingual Whisper model. It is the next best
    # option if Rubai ran out of memory or was skipped.
    if not disable_fallback and (not candidates or rubai_oom or all(c.get("quality", {}).get("is_hallucination", True) for c in candidates)):
        fallback_path = local_whisper_model_path()
        log_diagnostic(language="uz", fallback_model=fallback_path)
        try:
            whisper_result = transcribe_whisper_with_vad(
                wav_path,
                "uz",
                fallback_path,
                progress_label="O'zbekcha Whisper fallback",
                initial_prompt=UZBEK_INITIAL_PROMPT,
            )
            whisper_quality = detect_hallucination(whisper_result["text"], whisper_result["segments"], "uz")
            whisper_result["quality"] = whisper_quality
            if not whisper_quality["is_hallucination"] and len(whisper_result["text"].strip()) >= 10:
                return whisper_result
            candidates.append(whisper_result)
        except Exception as e:
            log_diagnostic(language="uz", whisper_error=str(e))
            if "memory" in str(e).lower() or "allocate" in str(e).lower():
                release_whisper_models()

    # Last resort: Vosk Uzbek models are fast and robust for very long audio.
    large_path = "models/vosk-model-uz-0.42"
    small_path = "models/vosk-model-small-uz-0.22"
    model_path = large_path if os.path.exists(large_path) else small_path
    if not disable_fallback and os.path.exists(model_path):
        log_diagnostic(language="uz", fallback_model="vosk", model_path=model_path)
        try:
            results = transcribe_vosk(wav_path, model_path, progress_label="O'zbekcha Vosk распознаю")
            segments = build_vosk_segments(results)
            full_text = normalize_repeated_punctuation(" ".join(s["text"] for s in segments))
            vosk_result = {"text": full_text, "language": "uz", "segments": segments}
            vosk_quality = detect_hallucination(full_text, segments, "uz")
            vosk_result["quality"] = vosk_quality
            log_diagnostic(language="uz", vosk_quality=vosk_quality)
            candidates.append(vosk_result)
        except Exception as e:
            log_diagnostic(language="uz", vosk_error=str(e))

    best = select_best_output(candidates)
    return best


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
                last["end"] = cand["start"]
                merged.append(cand)
            else:
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


def transcribe_multilingual(wav_path: str, model_path: str = LOCAL_WHISPER_MODEL):
    """Transcribe Turkic + Russian code-switched audio using two Whisper passes."""
    emit_progress(0, "Мультиязычное распознавание: определение языка...")

    primary = transcribe_whisper_with_vad(wav_path, None, model_path, progress_label="Распознаю основной язык")
    primary_lang = primary["language"]

    emit_progress(0, "Мультиязычное распознавание: русские вставки...")
    russian = transcribe_whisper_with_vad(wav_path, "ru", model_path, progress_label="Распознаю русский")

    merged_segments = merge_segment_lists(primary["segments"], russian["segments"])
    full_text = " ".join(s["text"] for s in merged_segments)

    return {
        "text": full_text,
        "language": f"{primary_lang}+ru",
        "segments": merged_segments,
    }


# ---------------------------------------------------------------------------
# GigaAM Multilingual (ai-sage/GigaAM-Multilingual) — Conformer/CTC engine.
# Best local quality for ky/uz/ru (hard benchmark 2026-07-15: ky 74.9% char vs
# 68.1% on the GPU whisper fine-tune; uz 95.7% vs 92.0%) and ~20x realtime on
# CPU. CTC decoding cannot loop, so whisper-style repetition pathologies are
# impossible. Output has no punctuation/casing — the Node LLM cleanup adds it.
# ---------------------------------------------------------------------------
GIGAAM_MODEL_ID = os.environ.get("TILTAB_GIGAAM_MODEL_ID", "ai-sage/GigaAM-Multilingual")
GIGAAM_REVISION = os.environ.get("TILTAB_GIGAAM_REVISION", "ctc")
# The model rejects inputs over 25 s; keep a safety margin.
GIGAAM_CHUNK_SECONDS = int(os.environ.get("TILTAB_GIGAAM_CHUNK_SECONDS", "24"))

_gigaam_models: dict = {}


def gigaam_languages() -> set:
    raw = os.environ.get("TILTAB_GIGAAM_LANGUAGES", "ky,uz,ru")
    return {s.strip().lower() for s in raw.split(",") if s.strip()}


def get_gigaam_model(revision: str | None = None):
    revision = revision or GIGAAM_REVISION
    if revision not in _gigaam_models:
        # Keep the HF cache inside the project models dir so the service user
        # owns it in production (and it survives redeploys).
        os.environ.setdefault("HF_HOME", os.path.join(os.getcwd(), "models", "hf_cache"))
        from transformers import AutoModel

        model = AutoModel.from_pretrained(
            GIGAAM_MODEL_ID, revision=revision, trust_remote_code=True
        )
        model.eval()
        _gigaam_models[revision] = model
    return _gigaam_models[revision]


def transcribe_gigaam(wav_path: str, language: str, progress_label: str = "Распознаю", revision: str | None = None):
    """Transcribe with GigaAM CTC by slicing into <=24 s chunks."""
    import wave as _wave

    emit_progress(5, f"{progress_label} (GigaAM)...")
    model = get_gigaam_model(revision)

    segments = []
    text_parts = []
    with _wave.open(wav_path, "rb") as wf:
        framerate = wf.getframerate()
        nchannels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        total_frames = wf.getnframes()
        step = GIGAAM_CHUNK_SECONDS * framerate
        n_chunks = max(1, (total_frames + step - 1) // step)

        seg_id = 0
        pos = 0
        idx = 0
        while pos < total_frames:
            wf.setpos(pos)
            frames = wf.readframes(min(step, total_frames - pos))
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                chunk_path = tmp.name
            try:
                with _wave.open(chunk_path, "wb") as out:
                    out.setnchannels(nchannels)
                    out.setsampwidth(sampwidth)
                    out.setframerate(framerate)
                    out.writeframes(frames)
                result = model.transcribe(chunk_path)
                text = (result.text if hasattr(result, "text") else str(result)).strip()
            finally:
                os.unlink(chunk_path)

            if text:
                start = pos / framerate
                end = min(total_frames, pos + step) / framerate
                segments.append({
                    "id": seg_id,
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "text": text,
                })
                seg_id += 1
                text_parts.append(text)

            idx += 1
            emit_progress(5 + int(90 * idx / n_chunks), f"{progress_label} (GigaAM)...")
            pos += step

    return {
        "text": " ".join(text_parts),
        "language": language,
        "segments": segments,
        "model": f"gigaam-multilingual-{revision or GIGAAM_REVISION}",
    }


def gigaam_or_fallback(wav_path: str, language: str, fallback, progress_label: str = "Распознаю"):
    """Try GigaAM first for supported languages; fall back to the legacy engine."""
    if language in gigaam_languages():
        try:
            return transcribe_gigaam(wav_path, language, progress_label=progress_label)
        except Exception as exc:  # noqa: BLE001 — any failure means "use the old engine"
            log_diagnostic(gigaam_failed=True, gigaam_error=str(exc)[:500])
            print(f"[gigaam] failed, falling back: {exc}", file=sys.stderr, flush=True)
    return fallback()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def _is_ct2_model(model_path: str) -> bool:
    return os.path.isdir(model_path) and os.path.exists(os.path.join(model_path, "model.bin"))


def _is_hf_whisper_model(model_path: str) -> bool:
    if not os.path.isdir(model_path):
        return False
    has_weights = (
        os.path.exists(os.path.join(model_path, "model.safetensors"))
        or os.path.exists(os.path.join(model_path, "pytorch_model.bin"))
    )
    return has_weights and os.path.exists(os.path.join(model_path, "config.json"))


def _run_beta_transcription(wav_path: str, language: str | None, model_path: str) -> dict:
    """Run a specific local model without VAD and without post-processing.

    Used by the admin beta-test page to compare raw model outputs.
    Supports Vosk, CTranslate2 Whisper, and HuggingFace Whisper models.
    """
    # GigaAM entries are virtual (not directories): "gigaam:ctc" / "gigaam:large_ctc".
    if model_path.lower().startswith("gigaam"):
        revision = model_path.split(":", 1)[1] if ":" in model_path else "ctc"
        return transcribe_gigaam(
            wav_path,
            language or "auto",
            progress_label="GigaAM beta",
            revision=revision,
        )

    is_vosk = "vosk" in model_path.lower()
    if is_vosk:
        vosk_results = transcribe_vosk_chunked(wav_path, model_path, progress_label="Vosk beta")
        # transcribe_vosk_chunked returns a list of partial result objects; build
        # normalized segments and text so downstream code sees the same schema as
        # the Whisper path.
        segments = build_vosk_segments(vosk_results)
        full_text = normalize_repeated_punctuation(" ".join(s["text"] for s in segments))
        return {
            "text": full_text,
            "language": language or "auto",
            "segments": segments,
        }

    if _is_hf_whisper_model(model_path):
        return transcribe_whisper_hf(
            wav_path,
            model_path,
            language or "tg",
            progress_label="Whisper HF beta",
        )

    # Default: assume CTranslate2/faster-whisper compatible model.
    return transcribe_whisper_time_chunked(
        wav_path,
        language,
        model_path,
        progress_label="Whisper beta",
    )


def main():
    if len(sys.argv) < 4:
        print("Usage: transcribe_hybrid.py <input_file> <ffmpeg_path> <language>", file=sys.stderr)
        sys.exit(1)

    input_file = sys.argv[1]
    ffmpeg_path = sys.argv[2]
    FFMPEG_PATH = ffmpeg_path
    language = sys.argv[3] if sys.argv[3] != "auto" else None
    beta_model = os.environ.get("TILTAB_BETA_MODEL", "").strip()
    skip_postprocess = os.environ.get("TILTAB_SKIP_POSTPROCESS", "").lower() in ("1", "true", "yes")

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = tmp.name

    try:
        emit_progress(0, "Подготовка аудио...")
        convert_to_wav(input_file, wav_path, ffmpeg_path)
        duration = get_audio_duration(wav_path)
        log_diagnostic(input_duration_seconds=duration, requested_language=sys.argv[3], beta_mode=bool(beta_model))

        if beta_model:
            output = _run_beta_transcription(wav_path, language, beta_model)
        elif language == "ky":
            output = gigaam_or_fallback(
                wav_path, "ky", lambda: transcribe_kyrgyz(wav_path),
                progress_label="Кыргызча распознаю",
            )

        elif language == "tg":
            output = transcribe_tajik(wav_path)

        elif language == "ru":
            # Primary: GigaAM CTC (best local Russian per Sber benchmarks).
            # Fallback: local multilingual Whisper large-v3-turbo.
            output = gigaam_or_fallback(
                wav_path,
                "ru",
                lambda: transcribe_whisper_with_vad(
                    wav_path,
                    "ru",
                    local_whisper_model_path(),
                    progress_label="Русский распознаю",
                    initial_prompt=RUSSIAN_INITIAL_PROMPT,
                ),
                progress_label="Русский распознаю",
            )

        elif language == "uz":
            output = gigaam_or_fallback(
                wav_path, "uz", lambda: transcribe_uzbek(wav_path),
                progress_label="O'zbekcha распознаю",
            )

        elif language == "en":
            output = transcribe_whisper_with_vad(wav_path, "en", local_whisper_model_path(), progress_label="English transcribing")

        elif language == "multi":
            output = transcribe_multilingual(wav_path, local_whisper_model_path())

        else:
            output = transcribe_whisper_with_vad(wav_path, None, local_whisper_model_path(), progress_label="Определяю язык")

        if output is None:
            raise RuntimeError(f"Transcription returned no output for language {language}")

        # Add quality metadata for downstream logging
        quality = output.get("quality") or detect_hallucination(output["text"], output["segments"], language or "auto")
        output["quality"] = quality
        log_diagnostic(
            output_language=output.get("language"),
            output_char_count=len(output["text"]),
            output_word_count=len(output["text"].split()),
            output_segment_count=len(output["segments"]),
            quality=quality,
        )

        # Language-aware post-processing: remove garbage, fix grammar/case,
        # normalize scripts (Tajik). Applied to all languages with Tajik-specific
        # rules kept inside the post-processor. Skipped in beta mode.
        if not skip_postprocess:
            output = text_postprocessing.postprocess_transcription(output, language)
            log_diagnostic(
                postprocess_applied=True,
                output_language=output.get("language"),
                output_char_count=len(output.get("text", "")),
                output_segment_count=len(output.get("segments", [])),
            )

        # Remove internal quality field from final JSON to keep schema stable
        output.pop("quality", None)
        print(json.dumps(output, ensure_ascii=False))
    finally:
        os.unlink(wav_path)


def _is_media_preparation_error(exc: Exception) -> bool:
    name = exc.__class__.__name__
    return name in ("CalledProcessError", "RuntimeError") and ("ffmpeg" in str(exc).lower() or "conversion failed" in str(exc).lower())


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        technical = str(exc)
        log_diagnostic(error_type=exc.__class__.__name__, error_message=technical)
        if _is_media_preparation_error(exc):
            print(
                "Ошибка подготовки аудио/видео: файл не распознан или повреждён. "
                "Попробуйте другой файл или формат (MP3, WAV, MP4, WEBM, OGG).",
                file=sys.stderr,
                flush=True,
            )
        else:
            print(f"Ошибка транскрипции: {technical}", file=sys.stderr, flush=True)
        sys.exit(1)
