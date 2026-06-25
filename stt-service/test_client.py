"""Test client for the STT microservice.

Usage:
    python test_client.py http://SERVER_IP:8000
"""

import json
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"

FIXTURES = [
    ("ky", ROOT / "test_audio" / "ky.wav"),
    ("uz", ROOT / "test_audio" / "uz.wav"),
    ("ru", ROOT / "test_audio" / "ru.wav"),
    ("en", ROOT / "test_audio" / "en.wav"),
]


def health_check():
    r = requests.get(f"{BASE_URL}/health", timeout=10)
    print("Health:", json.dumps(r.json(), indent=2, ensure_ascii=False))
    return r.status_code == 200


def transcribe(language: str, path: Path):
    if not path.exists():
        print(f"Skip {language}: {path} not found")
        return None
    print(f"\nTesting {language}: {path.name}")
    start = time.time()
    with open(path, "rb") as f:
        r = requests.post(
            f"{BASE_URL}/transcribe",
            files={"file": (path.name, f, "audio/wav")},
            data={"language": language},
            timeout=600,
        )
    elapsed = time.time() - start
    if r.status_code != 200:
        print(f"  ERROR {r.status_code}: {r.text[:500]}")
        return None
    data = r.json()
    text = data.get("text", "")[:200]
    proc = data.get("processing_time_seconds", 0)
    print(f"  Status: OK")
    print(f"  Total time: {elapsed:.2f}s")
    print(f"  Processing time: {proc}s")
    print(f"  Text preview: {text}...")
    return {
        "language": language,
        "file": path.name,
        "total_time": elapsed,
        "processing_time": proc,
        "text": data.get("text", ""),
        "segments_count": len(data.get("segments", [])),
    }


def main():
    print(f"Testing STT service at {BASE_URL}")
    if not health_check():
        sys.exit(1)

    results = []
    for lang, path in FIXTURES:
        res = transcribe(lang, path)
        if res:
            results.append(res)

    print("\n=== Summary ===")
    for r in results:
        print(
            f"{r['language']:3} | {r['file']:20} | "
            f"total {r['total_time']:6.2f}s | proc {r['processing_time']:6.2f}s | "
            f"segments {r['segments_count']:3}"
        )

    out = ROOT / "tmp" / "stt_service_test_report.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\nReport saved to {out}")


if __name__ == "__main__":
    main()
