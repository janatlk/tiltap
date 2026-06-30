#!/usr/bin/env python3
"""Hybrid transcription engine optimized for Kyrgyz, Tajik and Uzbek.

Model routing:
  ky -> Vosk large (fallback Vosk small -> Whisper)
  tg -> ElevenLabs Scribe (fallback fine-tuned Whisper Tajik -> distil-large-v3)
  uz -> Fine-tuned Whisper Uzbek Rubai (CTranslate2 int8) -> Vosk small fallback
  en -> Whisper (distil-large-v3)
  ru -> Vosk (fallback Whisper)
  auto -> Whisper base for language detection
  multi -> Whisper dual-pass (auto + Russian) for Turkic/Russian code-switching

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

import vad_utils
import text_postprocessing

PYTHON_PATH = "python" if sys.platform == "win32" else "python3"
FFMPEG_PATH = None

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


def get_whisper_model(model_path="distil-large-v3"):
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
def convert_to_wav(input_path: str, output_path: str, ffmpeg_path: str, enhance: bool = True):
    cmd = [
        ffmpeg_path,
        "-y",
        "-i", input_path,
    ]

    if enhance:
        # Improved audio enhancement:
        # 1. highpass=f=80      - remove low-frequency rumble/noise
        # 2. lowpass=f=8000     - remove high-frequency hiss
        # 3. dynaudnorm         - dynamic volume normalization
        # 4. afftdn             - FFT noise reduction (moderate)
        # 5. silenceremove      - strip long silent heads/tails (0.5s threshold)
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
def transcribe_whisper(wav_path: str, language: str | None, model_path: str = "distil-large-v3", progress_label: str = "Распознаю", initial_prompt: str | None = None, conservative: bool = False, word_timestamps: bool | None = None, vad_parameters: dict | None = None):
    model = get_whisper_model(model_path)
    duration = get_audio_duration(wav_path)
    emit_progress(0, f"{progress_label}: загрузка модели...")

    default_prompt = "Transcribe the spoken words accurately, including any loanwords from other languages."
    prompt = initial_prompt if initial_prompt else default_prompt

    # Fine-tuned models are often more stable with greedy decoding
    beam_size = 1 if conservative else 5
    best_of = 1 if conservative else 5
    if word_timestamps is None:
        word_timestamps = False if conservative else True

    transcribe_kwargs = dict(
        language=language if language else None,
        word_timestamps=word_timestamps,
        condition_on_previous_text=condition_on_previous_text,
        vad_filter=True,
        beam_size=beam_size,
        best_of=best_of,
        initial_prompt=prompt,
    )
    if vad_parameters:
        transcribe_kwargs["vad_parameters"] = vad_parameters

    segments_iter, info = model.transcribe(wav_path, **transcribe_kwargs)

    emit_progress(5, progress_label)

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
            emit_progress(progress, progress_label)

    emit_progress(100, progress_label)
    full_text = normalize_repeated_punctuation(" ".join(full_text_parts))
    full_text = collapse_consecutive_repeats(full_text)
    return {
        "text": full_text,
        "language": info.language,
        "segments": result_segments,
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
    if use_large and len(full_text.split()) < min_expected_words and os.path.exists(small_path):
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

    candidates = []

    # Primary: local open-source fine-tuned Whisper Tajik model (CTranslate2).
    if has_fine_tuned:
        log_diagnostic(language="tg", primary_model="whisper-tajik-finetuned-ct2")
        try:
            fine = transcribe_whisper(
                wav_path,
                "tg",
                fine_tuned_path,
                progress_label="Тоҷикӣ распознаю",
                conservative=True,
                word_timestamps=True,
            )
            fine_quality = detect_hallucination(fine["text"], fine["segments"], "tg")
            fine["quality"] = fine_quality
            log_diagnostic(language="tg", fine_tuned_quality=fine_quality)

            # Trust the fine-tuned model unless it shows obvious hallucination artifacts.
            # Low log-prob confidence is expected with conservative decoding and should
            # not trigger a fallback to the generic model.
            fine = text_postprocessing.postprocess_transcription(fine, "tg")
            serious_flags = [f for f in fine_quality["flags"] if f not in ("low_confidence",)]
            if not serious_flags:
                return fine
            candidates.append(fine)
        except Exception as e:
            log_diagnostic(language="tg", fine_tuned_error=str(e))
            # Fine-tuned model may have failed due to memory pressure; release it
            # before trying the next model.
            if "memory" in str(e).lower() or "allocate" in str(e).lower():
                release_whisper_models()

    # Fall back to generic Whisper if the fine-tuned model failed or hallucinated.
    if not candidates or all(c.get("quality", {}).get("is_hallucination", True) for c in candidates):
        log_diagnostic(language="tg", fallback_model="distil-large-v3")
        try:
            fallback = transcribe_whisper(
                wav_path,
                "tg",
                "distil-large-v3",
                progress_label="Тоҷикӣ (fallback) распознаю",
            )
            fallback_quality = detect_hallucination(fallback["text"], fallback["segments"], "tg")
            fallback["quality"] = fallback_quality
            candidates.append(fallback)
        except Exception as e:
            log_diagnostic(language="tg", whisper_error=str(e))
            if "memory" in str(e).lower() or "allocate" in str(e).lower():
                release_whisper_models()

    # Final fallback: small Vosk Tajik model. It is much lighter and avoids OOM.
    if not candidates or all(c.get("quality", {}).get("is_hallucination", True) for c in candidates):
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
                candidates.append(vosk_result)
            except Exception as e:
                log_diagnostic(language="tg", vosk_error=str(e))

    best = select_best_output(candidates)

    if best is None:
        raise RuntimeError("All Tajik transcription models failed")

    return best


def transcribe_uzbek(wav_path: str):
    candidates = []

    # Primary: fine-tuned Whisper Uzbek (Rubai) converted to CTranslate2 int8.
    # This model is much more accurate than Vosk small on our hard benchmark,
    # at the cost of slower CPU inference (~2x realtime). Use Vosk as fallback
    # for very long files or when the Rubai model is not present.
    rubai_path = "models/rubai-ct2-int8"
    duration = get_audio_duration(wav_path)
    use_rubai = os.path.exists(rubai_path) and duration > 0 and duration < 180

    if use_rubai:
        log_diagnostic(language="uz", primary_model="rubai-ct2-int8", model_path=rubai_path, duration_seconds=duration)
        try:
            rubai_result = transcribe_whisper(
                wav_path,
                "uz",
                rubai_path,
                progress_label="O'zbekcha Rubai распознаю",
                initial_prompt="Bu o'zbekcha matn. Iltimos, aniq yozib bering.",
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
                release_whisper_models()

    # Fallback: Vosk Uzbek models are fast and robust for long-form audio.
    large_path = "models/vosk-model-uz-0.42"
    small_path = "models/vosk-model-small-uz-0.22"
    model_path = large_path if os.path.exists(large_path) else small_path
    if os.path.exists(model_path):
        log_diagnostic(language="uz", fallback_model="vosk", model_path=model_path)
        try:
            results = transcribe_vosk(wav_path, model_path, progress_label="O'zbekcha Vosk распознаю")
            segments = build_vosk_segments(results)
            full_text = normalize_repeated_punctuation(" ".join(s["text"] for s in segments))
            vosk_result = {"text": full_text, "language": "uz", "segments": segments}
            vosk_quality = detect_hallucination(full_text, segments, "uz")
            vosk_result["quality"] = vosk_quality
            log_diagnostic(language="uz", vosk_quality=vosk_quality)
            if not vosk_quality["is_hallucination"] and len(full_text.strip()) >= 10:
                return vosk_result
            candidates.append(vosk_result)
        except Exception as e:
            log_diagnostic(language="uz", vosk_error=str(e))

    # Fallback of last resort: generic Whisper (usually poor for Uzbek).
    if not candidates or all(c.get("quality", {}).get("is_hallucination", True) for c in candidates):
        log_diagnostic(language="uz", fallback_model="whisper-distil-large-v3")
        try:
            whisper_result = transcribe_whisper(
                wav_path,
                "uz",
                "distil-large-v3",
                progress_label="O'zbekcha Whisper fallback",
                initial_prompt="Bu o'zbekcha matn. Iltimos, aniq yozib bering.",
            )
            whisper_quality = detect_hallucination(whisper_result["text"], whisper_result["segments"], "uz")
            whisper_result["quality"] = whisper_quality
            candidates.append(whisper_result)
        except Exception as e:
            log_diagnostic(language="uz", whisper_error=str(e))
            if "memory" in str(e).lower() or "allocate" in str(e).lower():
                release_whisper_models()

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


def transcribe_multilingual(wav_path: str, model_size: str = "distil-large-v3"):
    """Transcribe Turkic + Russian code-switched audio using two Whisper passes."""
    emit_progress(0, "Мультиязычное распознавание: определение языка...")

    primary = transcribe_whisper(wav_path, None, model_size, progress_label="Распознаю основной язык")
    primary_lang = primary["language"]

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
        emit_progress(0, "Подготовка аудио...")
        convert_to_wav(input_file, wav_path, ffmpeg_path)
        duration = get_audio_duration(wav_path)
        log_diagnostic(input_duration_seconds=duration, requested_language=sys.argv[3])

        if language == "ky":
            output = transcribe_kyrgyz(wav_path)

        elif language == "tg":
            output = transcribe_tajik(wav_path)

        elif language == "ru":
            # Prefer a Russian-specific Vosk large model if available; otherwise
            # use Whisper medium, which handles Russian Cyrillic well and avoids
            # the English bias of distil-large-v3.
            large_vosk_path = "models/vosk-model-ru-0.42"
            if os.path.exists(large_vosk_path):
                results = transcribe_vosk(wav_path, large_vosk_path, progress_label="Русский распознаю")
                segments = build_vosk_segments(results)
                full_text = normalize_repeated_punctuation(" ".join(s["text"] for s in segments))
                output = {"text": full_text, "language": "ru", "segments": segments}
            else:
                output = transcribe_whisper(
                    wav_path,
                    "ru",
                    "medium",
                    progress_label="Русский распознаю",
                    initial_prompt="Распознай речь на русском языке. Сохраняй русские слова и произношение.",
                )

        elif language == "uz":
            output = transcribe_uzbek(wav_path)

        elif language == "en":
            output = transcribe_whisper(wav_path, "en", "distil-large-v3", progress_label="English transcribing")

        elif language == "multi":
            output = transcribe_multilingual(wav_path, "large-v3")

        else:
            output = transcribe_whisper(wav_path, None, "base", progress_label="Определяю язык")

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
        # rules kept inside the post-processor.
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


if __name__ == "__main__":
    main()
