#!/usr/bin/env python3
"""Translate a text file via the local Tiltab API."""
import json
import sys
import urllib.request


def translate(text: str, target_lang: str, source_lang: str = "auto"):
    payload = json.dumps({
        "text": text,
        "targetLang": target_lang,
        "sourceLang": source_lang,
        "sourceType": "stt",
    }, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        "http://localhost:3000/api/translate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=600) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    input_file = sys.argv[1]
    target_lang = sys.argv[2]
    source_lang = sys.argv[3]
    output_file = sys.argv[4]
    with open(input_file, "r", encoding="utf-8") as f:
        text = f.read().strip()
    print(f"Translating {len(text)} chars from {source_lang} to {target_lang}...", file=sys.stderr)
    result = translate(text, target_lang, source_lang)
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"Done. requestId={result.get('requestId')}", file=sys.stderr)


if __name__ == "__main__":
    main()
