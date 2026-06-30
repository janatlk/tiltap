"""Unified open-source STT benchmark for priority languages.

Runs every locally available model on the hard fixtures (real YouTube clips) and
optionally on the phrasebook fixtures, then reports character similarity and word
accuracy (Jaccard).

Usage:
    python scripts/benchmark_models.py
    python scripts/benchmark_models.py --phrasebook
    python scripts/benchmark_models.py --only ky,uz
"""
import argparse
import json
import os
import sys
import time
from typing import Dict, List, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# ---------------------------------------------------------------------------
# Similarity helpers
# ---------------------------------------------------------------------------
def _lev(a: str, b: str) -> int:
    if len(a) < len(b):
        return _lev(b, a)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        curr = [i + 1]
        for j, cb in enumerate(b):
            curr.append(min(curr[-1] + 1, prev[j + 1] + 1, prev[j] + (0 if ca == cb else 1)))
        prev = curr
    return prev[-1]


def char_similarity(ref: str, hyp: str) -> float:
    ref = ref.strip()
    hyp = hyp.strip()
    if not ref and not hyp:
        return 100.0
    if not ref or not hyp:
        return 0.0
    d = _lev(ref, hyp)
    return round(100 * (1 - d / max(len(ref), len(hyp))), 1)


def word_accuracy(ref: str, hyp: str) -> float:
    rw = set(ref.lower().split())
    hw = set(hyp.lower().split())
    if not rw and not hw:
        return 100.0
    if not rw or not hw:
        return 0.0
    return round(100 * len(rw & hw) / len(rw | hw), 1)


# ---------------------------------------------------------------------------
# Model runners
# ---------------------------------------------------------------------------
def run_vosk(model_path: str, wav_path: str) -> Tuple[str, float]:
    from transcribe_hybrid import transcribe_vosk_chunked, build_vosk_segments, normalize_repeated_punctuation

    t0 = time.time()
    results = transcribe_vosk_chunked(wav_path, model_path, progress_label="vosk")
    segments = build_vosk_segments(results)
    text = normalize_repeated_punctuation(" ".join(s["text"] for s in segments))
    return text, time.time() - t0


def run_whisper_ct2(model_path: str, wav_path: str, language: str, initial_prompt: str | None = None) -> Tuple[str, float]:
    from transcribe_hybrid import transcribe_whisper, normalize_repeated_punctuation

    t0 = time.time()
    result = transcribe_whisper(
        wav_path,
        language,
        model_path,
        progress_label="whisper-ct2",
        initial_prompt=initial_prompt,
        conservative=True,
    )
    text = normalize_repeated_punctuation(result.get("text", ""))
    return text, time.time() - t0


def run_whisper_transformers(model_dir: str, wav_path: str, language_code: str) -> Tuple[str, float]:
    import numpy as np
    import soundfile as sf
    import torch
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    processor = WhisperProcessor.from_pretrained(model_dir)
    model = WhisperForConditionalGeneration.from_pretrained(model_dir)
    model.eval()
    model.config.forced_decoder_ids = processor.get_decoder_prompt_ids(language=language_code, task="transcribe")

    audio, sr = sf.read(wav_path)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != 16000:
        import librosa
        audio = librosa.resample(audio.astype(np.float32), orig_sr=sr, target_sr=16000)

    inputs = processor(audio, sampling_rate=16000, return_tensors="pt")

    t0 = time.time()
    with torch.no_grad():
        predicted_ids = model.generate(inputs["input_features"])
    runtime = time.time() - t0

    text = processor.batch_decode(predicted_ids, skip_special_tokens=True)[0]
    return text, runtime


def run_vnegi1011_kyrgyz(model_dir: str, wav_path: str) -> Tuple[str, float]:
    import numpy as np
    import soundfile as sf
    import onnxruntime as ort
    from transformers import Wav2Vec2Processor

    processor = Wav2Vec2Processor.from_pretrained(model_dir)
    session = ort.InferenceSession(os.path.join(model_dir, "model.onnx"), providers=["CPUExecutionProvider"])

    audio, sr = sf.read(wav_path)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != 16000:
        import librosa
        audio = librosa.resample(audio.astype(np.float32), orig_sr=sr, target_sr=16000)

    inputs = processor(audio, sampling_rate=16000, return_tensors="np")
    input_values = inputs["input_values"].astype(np.float32)

    t0 = time.time()
    logits = session.run(None, {"input_values": input_values})[0]
    runtime = time.time() - t0

    predicted_ids = np.argmax(logits, axis=-1)
    text = processor.batch_decode(predicted_ids)[0]
    return text, runtime


# ---------------------------------------------------------------------------
# Benchmark configuration
# ---------------------------------------------------------------------------
HARD_MANIFEST = "test_audio/hard_manifest.json"
PHRASEBOOK_MANIFEST = "test_audio/manifest.json"


def available(path: str) -> bool:
    return os.path.exists(path)


def model_candidates(language: str) -> List[Dict]:
    """Return model specs for a language."""
    if language == "ky":
        return [
            {"name": "vosk-large", "path": "models/vosk-model-ky-0.42", "runner": "vosk"},
            {"name": "vosk-small", "path": "models/vosk-model-small-ky-0.42", "runner": "vosk"},
            {"name": "vnegi1011-wav2vec2", "path": "models/vnegi1011-kyrgyz-asr", "runner": "vnegi1011"},
            # Whisper large-v3-turbo does not list Kyrgyz as a supported language.
        ]
    if language == "tg":
        return [
            {"name": "whisper-tajik-finetuned-ct2", "path": "models/whisper-tajik-finetuned-ct2", "runner": "whisper-ct2", "lang": "tg"},
            {"name": "burhon97-whisper-tajik", "path": "models/burhon97-whisper-tajik-finetuned", "runner": "whisper-transformers", "lang": "tajik"},
            {"name": "abduaziz-whisper-small-tajik", "path": "models/abduaziz-whisper-small-tajik", "runner": "whisper-transformers", "lang": "tajik"},
            {"name": "vosk-small-tg", "path": "models/vosk-model-small-tg-0.22", "runner": "vosk"},
            # Generic Whisper large-v3-turbo hallucinates heavily on Tajik and is slower.
        ]
    if language == "uz":
        return [
            {"name": "rubai-ct2-int8", "path": "models/rubai-ct2-int8", "runner": "whisper-ct2", "lang": "uz", "prompt": "O'zbek tilida matnni aniq yozib ol."},
            {"name": "Kotib-uzbek-stt-v1", "path": "models/Kotib-uzbek-stt-v1", "runner": "whisper-transformers", "lang": "uzbek"},
            {"name": "vosk-small-uz", "path": "models/vosk-model-small-uz-0.22", "runner": "vosk"},
            # Generic Whisper large-v3-turbo produces Kazakh-like output on Uzbek.
        ]
    return []


def run_model(spec: Dict, wav_path: str) -> Tuple[str, float]:
    runner = spec["runner"]
    if runner == "vosk":
        return run_vosk(spec["path"], wav_path)
    if runner == "whisper-ct2":
        return run_whisper_ct2(spec["path"], wav_path, spec["lang"], spec.get("prompt"))
    if runner == "whisper-transformers":
        return run_whisper_transformers(spec["path"], wav_path, spec["lang"])
    if runner == "vnegi1011":
        return run_vnegi1011_kyrgyz(spec["path"], wav_path)
    raise ValueError(f"Unknown runner: {runner}")


def benchmark_fixture(fixture: Dict, language: str) -> Dict:
    wav_path = fixture["wavPath"]
    reference = fixture.get("referenceText", "")
    candidates = [m for m in model_candidates(language) if available(m["path"])]

    results = []
    for spec in candidates:
        print(f"  [{language}] {spec['name']} on {wav_path} ...", flush=True)
        try:
            hyp, runtime = run_model(spec, wav_path)
            results.append({
                "model": spec["name"],
                "char_similarity": char_similarity(reference, hyp),
                "word_accuracy": word_accuracy(reference, hyp),
                "runtime_seconds": round(runtime, 2),
                "hypothesis": hyp,
                "error": None,
            })
        except Exception as e:
            results.append({
                "model": spec["name"],
                "char_similarity": 0.0,
                "word_accuracy": 0.0,
                "runtime_seconds": 0.0,
                "hypothesis": "",
                "error": str(e),
            })

    return {
        "fixture": fixture.get("title", wav_path),
        "wav_path": wav_path,
        "reference": reference,
        "duration_seconds": fixture.get("durationSeconds"),
        "results": results,
    }


def main():
    parser = argparse.ArgumentParser(description="Benchmark open-source STT models")
    parser.add_argument("--phrasebook", action="store_true", help="Also run phrasebook fixtures")
    parser.add_argument("--only", type=str, default=None, help="Comma-separated language codes")
    args = parser.parse_args()

    languages = args.only.split(",") if args.only else ["ky", "tg", "uz"]

    with open(HARD_MANIFEST, "r", encoding="utf-8") as f:
        hard_data = json.load(f)["fixtures"]

    all_reports = []

    for lang in languages:
        if lang not in hard_data:
            continue
        print(f"\n=== Hard fixture: {lang} ===", flush=True)
        report = benchmark_fixture(hard_data[lang], lang)
        report["language"] = lang
        all_reports.append(report)

    if args.phrasebook:
        with open(PHRASEBOOK_MANIFEST, "r", encoding="utf-8") as f:
            pb = json.load(f)
        pb_fixtures = pb.get("fixtures", {})
        for lang in languages:
            fixture = pb_fixtures.get(lang)
            if not fixture:
                continue
            print(f"\n=== Phrasebook: {lang} ===", flush=True)
            report = benchmark_fixture(fixture, lang)
            report["language"] = lang
            report["fixture"] = "phrasebook-" + report["fixture"]
            all_reports.append(report)

    output = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "reports": all_reports,
    }
    os.makedirs("logs", exist_ok=True)
    out_path = "logs/benchmark_models_report.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    # Print summary
    print("\n=== SUMMARY ===", flush=True)
    for report in all_reports:
        print(f"\n{report.get('language','').upper()} — {report.get('fixture','')}", flush=True)
        for r in report["results"]:
            status = f"char={r['char_similarity']}% word={r['word_accuracy']}% time={r['runtime_seconds']}s"
            if r.get("error"):
                status += f" ERROR: {r['error']}"
            print(f"  {r['model']}: {status}", flush=True)
    print(f"\nFull report: {out_path}", flush=True)


if __name__ == "__main__":
    main()
