#!/usr/bin/env python3
"""Benchmark the RunPod serverless GPU STT endpoint across all Tiltap languages.

Usage:
    python scripts/benchmark_gpu_stt.py
    python scripts/benchmark_gpu_stt.py test_audio/hard_manifest.json
    python scripts/benchmark_gpu_stt.py --all

Reads TILTAB_GPU_STT_URL / TILTAB_GPU_STT_API_KEY from the environment or .env.
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent


def load_env():
    """Load env vars from .env if present."""
    env_file = ROOT / ".env"
    if env_file.exists():
        with open(env_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value


def get_credentials():
    url = os.environ.get("TILTAB_GPU_STT_URL", "").strip()
    key = os.environ.get("TILTAB_GPU_STT_API_KEY", "").strip()
    if not key:
        key_path = ROOT / ".keys" / "runpod_personal_api_key"
        if key_path.exists():
            key = key_path.read_text(encoding="utf-8").strip()
    if not url or not key:
        print(
            "ERROR: Set TILTAB_GPU_STT_URL and TILTAB_GPU_STT_API_KEY in .env",
            file=sys.stderr,
        )
        sys.exit(1)
    return url, key


def levenshtein(a: str, b: str) -> int:
    if len(a) < len(b):
        return levenshtein(b, a)
    if len(b) == 0:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        curr = [i + 1]
        for j, cb in enumerate(b):
            curr.append(min(curr[-1] + 1, prev[j + 1] + 1, prev[j] + (0 if ca == cb else 1)))
        prev = curr
    return prev[-1]


def char_similarity(a: str, b: str) -> float:
    distance = levenshtein(a, b)
    max_len = max(len(a), len(b))
    if max_len == 0:
        return 100.0
    return round(100 * (1 - distance / max_len), 1)


def word_accuracy(ref: str, hyp: str) -> float:
    ref_words = set(ref.lower().split())
    hyp_words = set(hyp.lower().split())
    if not ref_words:
        return 100.0 if not hyp_words else 0.0
    intersection = len(ref_words & hyp_words)
    union = len(ref_words | hyp_words)
    if union == 0:
        return 100.0
    return round(100 * intersection / union, 1)


def _status_url(run_url: str, job_id: str) -> str:
    base = run_url.rsplit("/", 1)[0]  # e.g. https://api.runpod.ai/v2/ENDPOINT_ID
    return f"{base}/status/{job_id}"


def _poll_status(job_id: str, run_url: str, api_key: str, timeout: int = 600) -> dict:
    url = _status_url(run_url, job_id)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
    deadline = time.time() + timeout
    while time.time() < deadline:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
        status = data.get("status")
        if status == "COMPLETED":
            return data
        if status == "FAILED":
            raise RuntimeError(f"RunPod job failed: {data.get('error', data)}")
        time.sleep(5)
    raise RuntimeError(f"RunPod job timed out after {timeout}s: {job_id}")


def transcribe_gpu(audio_path: str, language: str, url: str, api_key: str, timeout: int = 600) -> dict:
    with open(audio_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()

    payload = json.dumps({
        "input": {
            "audio_base64": b64,
            "language": language,
            "filename": os.path.basename(audio_path),
        }
    }).encode("utf-8")

    req = urllib.request.Request(url, data=payload, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {e.code}: {body}") from e

    # RunPod sync endpoint may return IN_QUEUE on cold start; poll for completion.
    if data.get("status") in ("IN_QUEUE", "IN_PROGRESS") and data.get("id"):
        data = _poll_status(data["id"], url, api_key, timeout=timeout)

    if isinstance(data.get("output"), dict):
        return data["output"]
    if "error" in data:
        raise RuntimeError(f"RunPod error: {data['error']}")
    raise RuntimeError(f"Unexpected RunPod response: {data}")


def load_manifest(manifest_path: Path) -> list[dict]:
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    fixtures = []
    raw_fixtures = manifest.get("fixtures", {})
    for language, fixture in raw_fixtures.items():
        wav = fixture["wavPath"]
        if not os.path.isabs(wav):
            # Manifest wavPaths are relative to the repo root (e.g. test_audio/...)
            wav = str((ROOT / wav).resolve())
        fixtures.append({
            "language": language,
            "title": fixture.get("title", ""),
            "wav_path": wav,
            "reference": fixture.get("referenceText", ""),
        })
    return fixtures


def benchmark_gpu(fixtures: list[dict], url: str, api_key: str) -> list[dict]:
    results = []
    for i, fixture in enumerate(fixtures, 1):
        language = fixture["language"]
        wav_path = fixture["wav_path"]
        print(f"[{i}/{len(fixtures)}] {language}: {fixture.get('title', wav_path)} ...", flush=True)

        if not os.path.exists(wav_path):
            print(f"  File not found: {wav_path}", file=sys.stderr)
            results.append({**fixture, "error": "file not found"})
            continue

        t0 = time.time()
        try:
            output = transcribe_gpu(wav_path, language, url, api_key)
        except Exception as e:
            elapsed = time.time() - t0
            print(f"  FAILED after {elapsed:.1f}s: {e}", file=sys.stderr)
            results.append({**fixture, "error": str(e), "elapsed_seconds": elapsed})
            continue

        elapsed = time.time() - t0
        hypothesis = output.get("text", "").strip()
        reference = fixture.get("reference", "")

        result = {
            **fixture,
            "elapsed_seconds": round(elapsed, 2),
            "model": output.get("model"),
            "gpu": output.get("gpu"),
            "hypothesis": hypothesis,
        }

        if reference:
            result["char_similarity"] = char_similarity(reference, hypothesis)
            result["word_accuracy"] = word_accuracy(reference, hypothesis)
            result["reference_chars"] = len(reference)
            result["hypothesis_chars"] = len(hypothesis)
            result["reference_words"] = len(reference.split())
            result["hypothesis_words"] = len(hypothesis.split())
            print(
                f"  DONE in {elapsed:.1f}s | char {result['char_similarity']}% | word {result['word_accuracy']}%",
                flush=True,
            )
        else:
            print(f"  DONE in {elapsed:.1f}s | (no reference)", flush=True)

        results.append(result)
    return results


def print_report(results: list[dict]):
    print("\n" + "=" * 110)
    print(f"{'Lang':<8} {'Title':<40} {'Char':<8} {'Word':<8} {'Sec':<8} {'Model':<30}")
    print("=" * 110)

    scored = []
    for r in results:
        lang = r["language"]
        title = (r.get("title") or "")[:39]
        if "error" in r:
            print(f"{lang:<8} {title:<40} ERROR: {r['error'][:50]}")
            continue
        char = f"{r.get('char_similarity', '-'):>6}%" if "char_similarity" in r else "-"
        word = f"{r.get('word_accuracy', '-'):>6}%" if "word_accuracy" in r else "-"
        secs = f"{r.get('elapsed_seconds', 0):.1f}"
        model = (r.get("model") or "")[:29]
        print(f"{lang:<8} {title:<40} {char:<8} {word:<8} {secs:<8} {model:<30}")

    print("=" * 110)
    scored = [r for r in results if "char_similarity" in r]
    if scored:
        avg_char = sum(r["char_similarity"] for r in scored) / len(scored)
        avg_word = sum(r["word_accuracy"] for r in scored) / len(scored)
        print(f"Average char similarity: {avg_char:.1f}%")
        print(f"Average word accuracy:   {avg_word:.1f}%")


def main():
    parser = argparse.ArgumentParser(description="Benchmark RunPod GPU STT")
    parser.add_argument("manifests", nargs="*", help="Manifest JSON files")
    parser.add_argument("--all", action="store_true", help="Run hard + phrasebook manifests")
    parser.add_argument("--auto-multi", action="store_true", help="Also run auto/multi on hard fixtures (no reference)")
    args = parser.parse_args()

    load_env()
    url, api_key = get_credentials()

    manifests = []
    if args.all:
        manifests = [ROOT / "test_audio" / "hard_manifest.json", ROOT / "test_audio" / "manifest.json"]
    elif args.manifests:
        manifests = [Path(m) for m in args.manifests]
    else:
        manifests = [ROOT / "test_audio" / "hard_manifest.json"]

    fixtures: list[dict] = []
    for m in manifests:
        fixtures.extend(load_manifest(m))

    if args.auto_multi:
        hard = load_manifest(ROOT / "test_audio" / "hard_manifest.json")
        for lang in ("auto", "multi"):
            for h in hard:
                fixtures.append({
                    "language": lang,
                    "title": f"{h['title']} ({lang})",
                    "wav_path": h["wav_path"],
                    "reference": "",
                })

    print(f"Benchmarking {len(fixtures)} fixture(s) against {url}")
    results = benchmark_gpu(fixtures, url, api_key)
    print_report(results)

    report_path = ROOT / "logs" / "benchmark_gpu_stt_report.json"
    report_path.parent.mkdir(exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\nDetailed report saved to {report_path}")


if __name__ == "__main__":
    main()
