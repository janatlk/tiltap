#!/usr/bin/env python3
"""Benchmark transcription accuracy against reference transcripts.

Usage:
    python benchmark.py

The script reads test fixtures from test_audio/manifest.json (or a custom
manifest passed as the first argument) and runs transcribe_hybrid.py for each.
It computes character-level and word-level similarity metrics and prints a table.
"""

import json
import os
import subprocess
import sys
import tempfile
from difflib import SequenceMatcher

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

PYTHON_PATH = "python" if sys.platform == "win32" else "python3"
FFMPEG_PATH = os.path.join("node_modules", "ffmpeg-static", "ffmpeg.exe")


def levenshtein(a: str, b: str) -> int:
    """Compute Levenshtein distance between two strings."""
    if len(a) < len(b):
        return levenshtein(b, a)
    if len(b) == 0:
        return len(a)

    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        curr = [i + 1]
        for j, cb in enumerate(b):
            curr.append(min(
                curr[-1] + 1,
                prev[j + 1] + 1,
                prev[j] + (0 if ca == cb else 1),
            ))
        prev = curr
    return prev[-1]


def similarity(a: str, b: str) -> float:
    """Return similarity ratio between 0 and 100."""
    distance = levenshtein(a, b)
    max_len = max(len(a), len(b))
    if max_len == 0:
        return 100.0
    return round(100 * (1 - distance / max_len), 1)


def word_accuracy(ref: str, hyp: str) -> float:
    """Return word-level accuracy (Jaccard-ish) between 0 and 100."""
    ref_words = set(ref.lower().split())
    hyp_words = set(hyp.lower().split())
    if not ref_words:
        return 100.0 if not hyp_words else 0.0
    intersection = len(ref_words & hyp_words)
    union = len(ref_words | hyp_words)
    if union == 0:
        return 100.0
    return round(100 * intersection / union, 1)


def run_transcription(wav_path: str, language: str) -> dict:
    script = os.path.join(os.getcwd(), "transcribe_hybrid.py")
    proc = subprocess.run(
        [PYTHON_PATH, script, wav_path, FFMPEG_PATH, language],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=os.getcwd(),
    )

    # Find the last JSON line in stdout
    result = {"text": "", "language": language, "segments": []}
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                parsed = json.loads(line)
                if "text" in parsed and "segments" in parsed:
                    result = parsed
            except json.JSONDecodeError:
                continue
    return result


def benchmark_fixture(fixture: dict) -> dict:
    wav_path = fixture["wavPath"]
    if not os.path.isabs(wav_path):
        wav_path = os.path.join(os.getcwd(), wav_path)

    language = fixture["language"]
    reference = fixture["referenceText"]

    print(f"Running {language}: {fixture.get('title', wav_path)} ...", flush=True)
    result = run_transcription(wav_path, language)
    hypothesis = result.get("text", "").strip()

    char_sim = similarity(reference, hypothesis)
    word_acc = word_accuracy(reference, hypothesis)

    return {
        "language": language,
        "title": fixture.get("title", ""),
        "char_similarity": char_sim,
        "word_accuracy": word_acc,
        "reference_chars": len(reference),
        "hypothesis_chars": len(hypothesis),
        "reference_words": len(reference.split()),
        "hypothesis_words": len(hypothesis.split()),
        "hypothesis": hypothesis,
    }


def main():
    manifest_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join("test_audio", "manifest.json")

    if not os.path.exists(manifest_path):
        print(f"Manifest not found: {manifest_path}", file=sys.stderr)
        sys.exit(1)

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    fixtures = manifest.get("fixtures", {})
    if not fixtures:
        print("No fixtures found in manifest", file=sys.stderr)
        sys.exit(1)

    results = []
    for language in sorted(fixtures.keys()):
        fixture = fixtures[language]
        try:
            result = benchmark_fixture(fixture)
            results.append(result)
        except Exception as e:
            print(f"Error benchmarking {language}: {e}", file=sys.stderr)
            results.append({
                "language": language,
                "title": fixture.get("title", ""),
                "char_similarity": 0.0,
                "word_accuracy": 0.0,
                "error": str(e),
            })

    print("\n" + "=" * 100)
    print(f"{'Language':<10} {'Title':<45} {'Char Sim':<12} {'Word Acc':<12} {'Ref/Hyp Chars':<18} {'Ref/Hyp Words':<18}")
    print("=" * 100)

    for r in results:
        if "error" in r:
            print(f"{r['language']:<10} {r['title'][:44]:<45} ERROR: {r['error']}", flush=True)
        else:
            chars = f"{r['reference_chars']}/{r['hypothesis_chars']}"
            words = f"{r['reference_words']}/{r['hypothesis_words']}"
            print(f"{r['language']:<10} {r['title'][:44]:<45} {r['char_similarity']:<12} {r['word_accuracy']:<12} {chars:<18} {words:<18}")

    print("=" * 100)
    avg_char = sum(r["char_similarity"] for r in results if "error" not in r) / len([r for r in results if "error" not in r])
    avg_word = sum(r["word_accuracy"] for r in results if "error" not in r) / len([r for r in results if "error" not in r])
    print(f"Average char similarity: {avg_char:.1f}%")
    print(f"Average word accuracy:   {avg_word:.1f}%")

    # Save detailed report
    report_path = os.path.join("logs", "benchmark_report.json")
    os.makedirs("logs", exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\nDetailed report saved to {report_path}")


if __name__ == "__main__":
    main()
