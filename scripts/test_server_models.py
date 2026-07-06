#!/usr/bin/env python3
"""Run per-language STT model tests on the Hetzner server with fallbacks disabled.

Uses local fixtures from test_audio/ and computes character/word similarity
against reference transcripts.
"""
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import transcribe_hybrid as th

os.environ.setdefault("TILTAB_KYRGYZ_DISABLE_FALLBACK", "1")
os.environ.setdefault("TILTAB_UZBEK_DISABLE_FALLBACK", "1")
os.environ.setdefault("TILTAB_TAJIK_DISABLE_FALLBACK", "1")
os.environ.setdefault("TILTAB_CLEANUP_PROVIDER", "none")


def _levenshtein(a: str, b: str) -> int:
    if len(a) < len(b):
        return _levenshtein(b, a)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i]
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            curr.append(min(curr[-1] + 1, prev[j] + 1, prev[j - 1] + cost))
        prev = curr
    return prev[-1]


def _similarity(ref: str, hyp: str) -> dict:
    ref_norm = ref.strip().lower()
    hyp_norm = hyp.strip().lower()
    char_dist = _levenshtein(ref_norm, hyp_norm)
    char_sim = max(0.0, 1 - char_dist / max(len(ref_norm), 1))
    ref_words = ref_norm.split()
    hyp_words = hyp_norm.split()
    word_dist = _levenshtein(ref_words, hyp_words)
    word_sim = max(0.0, 1 - word_dist / max(len(ref_words), 1))
    return {
        "char_distance": char_dist,
        "char_similarity": round(char_sim * 100, 2),
        "word_distance": word_dist,
        "word_similarity": round(word_sim * 100, 2),
    }


def _emoji(score: float) -> str:
    if score >= 90:
        return "🟢"
    if score >= 70:
        return "🟡"
    if score >= 50:
        return "🟠"
    return "🔴"


TESTS = [
    ("ky", ROOT / "test_audio/youtube/ky_yt_1min.wav"),
    ("uz", ROOT / "test_audio/youtube/uz_yt.wav"),
    ("tg", ROOT / "test_audio/youtube/tg_yt.wav"),
    ("ru", ROOT / "test_audio/ru.wav"),
    ("en", ROOT / "test_audio/ru_en.wav"),
]


def main():
    manifest_path = ROOT / "test_audio/hard_manifest.json"
    if manifest_path.exists():
        hard = json.loads(manifest_path.read_text(encoding="utf-8"))
        refs = {k: v["referenceText"] for k, v in hard.get("fixtures", {}).items()}
    else:
        refs = {}

    results = {}
    for lang, wav_path in TESTS:
        if not wav_path.exists():
            print(f"[skip {lang}] file not found: {wav_path}")
            continue
        print(f"\n[{lang}] transcribing {wav_path.name} ...")
        start = time.time()
        try:
            if lang == "ky":
                result = th.transcribe_kyrgyz(str(wav_path))
            elif lang == "uz":
                result = th.transcribe_uzbek(str(wav_path))
            elif lang == "tg":
                result = th.transcribe_tajik(str(wav_path))
            elif lang == "ru":
                result = th.transcribe_whisper(
                    str(wav_path), "ru", th.local_whisper_model_path(),
                    progress_label="Русский распознаю",
                    initial_prompt="Распознай речь на русском языке. Сохраняй русские слова и произношение.",
                )
            elif lang == "en":
                result = th.transcribe_whisper(str(wav_path), "en", th.local_whisper_model_path(), progress_label="English transcribing")
            else:
                raise ValueError(lang)
        except Exception as exc:
            results[lang] = {"status": "error", "error": f"{type(exc).__name__}: {exc}"}
            print(f"[{lang}] ERROR: {exc}")
            continue

        elapsed = round(time.time() - start, 2)
        text = result.get("text", "").strip()
        sample = text[:300].replace("\n", " ")
        ref = refs.get(lang, "")
        sim = _similarity(ref, text) if ref else {}
        results[lang] = {
            "status": "ok",
            "duration_seconds": elapsed,
            "text_length": len(text),
            "sample": sample,
            "reference": ref,
            **sim,
        }
        char = sim.get("char_similarity")
        word = sim.get("word_similarity")
        if char is not None:
            print(f"[{lang}] char {char}% {_emoji(char)} | word {word}% {_emoji(word)} | {elapsed}s")
        else:
            print(f"[{lang}] done in {elapsed}s | sample: {sample}")

    report_path = ROOT / "logs" / "server_model_test_report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nReport saved to {report_path}")


if __name__ == "__main__":
    main()
