#!/usr/bin/env python3
"""Test Llama 3.3 70B via Groq for translation and Tajik cleanup quality."""
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

TRANSLATE_URL = "http://localhost:3000/api/translate"


def translate(text: str, source: str, target: str) -> dict:
    payload = json.dumps({"text": text, "sourceLang": source, "targetLang": target}, ensure_ascii=False).encode()
    req = urllib.request.Request(TRANSLATE_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def test_translation():
    samples = [
        {
            "name": "Simple Uzbek sentence",
            "source": "uz",
            "targets": ["ky", "ru", "en", "tg"],
            "text": "Assalomu alaykum, bugun biz sizga yangi xizmatimiz haqida gapirib beramiz.",
        },
        {
            "name": "Uzbek STT transcript fragment",
            "source": "uz",
            "targets": ["ky", "ru"],
            "text": "men hozir sizlarga ma'lumot beradigan kitoblarimni hayotingiz davomida mutlaqo o'qiy ko'rmang. men chunki jiddiy gapiryapman. ayrim marketologlarning turli xil chiroyli reklamalari asosida siz ushbu kitoblarni nomiga uchib olib qo'yasiz.",
        },
    ]
    results = {}
    for sample in samples:
        name = sample["name"]
        results[name] = {}
        for target in sample["targets"]:
            try:
                start = time.time()
                res = translate(sample["text"], sample["source"], target)
                dur = round(time.time() - start, 2)
                results[name][target] = {"time_s": dur, "translation": res.get("translatedText", "")}
            except Exception as e:
                results[name][target] = {"error": str(e)}
    return results


def test_cleanup():
    os.environ.setdefault("TILTAB_CLEANUP_PROVIDER", "groq")
    import text_postprocessing as tp

    cases = [
        {
            "name": "Clean Tajik",
            "language": "tg",
            "input": {
                "text": "Салом! Ман мехоҳам, ки шумо ҳамаи он чизҳое, ки дар ин ҷо гуфта шуданд, ба ғайрии як китоб бидонед.",
                "language": "tg",
                "segments": [
                    {"id": 0, "start": 0, "end": 5, "text": "Салом! Ман мехоҳам, ки шумо ҳамаи он чизҳое, ки дар ин ҷо гуфта шуданд, ба ғайрии як китоб бидонед."}
                ],
            },
        },
        {
            "name": "Dirty Tajik with repetition and noise",
            "language": "tg",
            "input": {
                "text": "[музыка] Салом салом салом. Ман мехоҳам мехоҳам ки шумо шумо [неразборчиво] биёед. Это позволит нам прости доступ к населению.",
                "language": "tg",
                "segments": [
                    {"id": 0, "start": 0, "end": 10, "text": "[музыка] Салом салом салом. Ман мехоҳам мехоҳам ки шумо шумо [неразборчиво] биёед. Это позволит нам прости доступ к населению."}
                ],
            },
        },
        {
            "name": "Tajik with Arabic script leak",
            "language": "tg",
            "input": {
                "text": "سلام. Ман мехоҳам, ки шумо ин китобро бихонед.",
                "language": "tg",
                "segments": [
                    {"id": 0, "start": 0, "end": 10, "text": "سلام. Ман мехоҳам, ки шумо ин китобро бихонед."}
                ],
            },
        },
    ]
    results = {}
    for case in cases:
        try:
            start = time.time()
            cleaned = tp.postprocess_transcription(case["input"], case["language"])
            dur = round(time.time() - start, 2)
            results[case["name"]] = {
                "time_s": dur,
                "before": case["input"]["text"],
                "after": cleaned.get("text", ""),
                "segments": cleaned.get("segments", []),
            }
        except Exception as e:
            results[case["name"]] = {"error": str(e)}
    return results


def main():
    print("Testing Llama 3.3 70B (Groq) quality...")
    translation_results = test_translation()
    cleanup_results = test_cleanup()
    report = {
        "translation": translation_results,
        "cleanup": cleanup_results,
    }
    out_path = os.path.join(ROOT, "logs", "llama70b_quality_report.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"Report saved to {out_path}")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
