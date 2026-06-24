"""Unit tests for Tajik STT post-processing improvements.

Run with:
    python scripts/test_tajik_postprocessing.py
"""
import os
import sys

# Force no LLM for deterministic rule-based tests.
os.environ["TILTAB_CLEANUP_PROVIDER"] = "none"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from text_postprocessing import (
    postprocess_segment,
    postprocess_transcription,
    normalize_tajik_dates,
    normalize_tajik_clitics,
    UNINTELLIGIBLE,
)


def _assert_equal(actual, expected, label):
    if actual != expected:
        print(f"FAIL [{label}]: expected {expected!r}, got {actual!r}")
        return False
    return True


def test_dates():
    ok = True
    cases = [
        ("28 ва 23 май", "28-уми ва 23-юми май"),
        ("аз 23 то 25 майи", "аз 23-юми то 25-уми майи"),
        ("23 майи соли 2024", "23-юми майи соли 2024"),
        ("23.05.2024", "23-юми майи соли 2024"),
        ("23/05", "23-юми май"),
        ("1 май", "1-уми май"),
        ("2 май", "2-юми май"),
        ("12 май", "12-уми май"),
        ("22 май", "22-юми май"),
        ("23-ум май", "23-юми май"),
    ]
    for inp, expected in cases:
        ok &= _assert_equal(normalize_tajik_dates(inp), expected, f"date {inp}")
    return ok


def test_clitics():
    ok = True
    cases = [
        ("Аллоҳ мо ро бибахшад", "Аллоҳ моро бибахшад"),
        ("Аллоҳи меҳрабон ро бибинам", "Аллоҳи меҳрабонро бибинам"),
        ("шумо ро дидем", "шуморо дидем"),
    ]
    for inp, expected in cases:
        ok &= _assert_equal(normalize_tajik_clitics(inp), expected, f"clitic {inp}")
    return ok


def test_entities_and_noise():
    ok = True
    cases = [
        ("Ховар муқаддас", "Хонаи муқаддас"),
        ("Кони-бодом", "Конибодом"),
        ("ха ха ха", "[кулол]"),
        ("ҳа ҳа", "[кулол]"),
        ("каф каф", "[аплодисменты]"),
        ("ла ла ла", "[музыка]"),
        ("ой ой ой", "[плач]"),
        ("ҳақиқат дорад", "ҳақиқат дорад"),
    ]
    for inp, expected in cases:
        out, _ = postprocess_segment(inp, "tg")
        ok &= _assert_equal(out, expected, f"entity/noise {inp}")
    return ok


def test_garbage_not_over_triggered():
    ok = True
    # Two-word valid segments should not be dropped.
    for inp in ("хало салом", "Дидун боз пас Нозанин"):
        out, score = postprocess_segment(inp, "tg")
        if out == UNINTELLIGIBLE:
            print(f"FAIL [garbage {inp}]: marked unintelligible (score={score})")
            ok = False
    return ok


def test_code_switching_preserved():
    ok = True
    # Russian/English insertions should be left as-is by the rule-based layer.
    inp = "спасибо барои кӯмак thank you"
    out, _ = postprocess_segment(inp, "tg")
    ok &= _assert_equal(out, inp, "code-switching")
    return ok


def test_full_transcription_pipeline():
    ok = True
    result = {
        "text": "Ховар муқаддас. Аллоҳ мо ро бибахшад.",
        "language": "tg",
        "segments": [
            {"id": 0, "start": 0.0, "end": 1.0, "text": "Ховар муқаддас."},
            {"id": 1, "start": 1.0, "end": 2.0, "text": "Аллоҳ мо ро бибахшад."},
        ],
    }
    processed = postprocess_transcription(result, "tg")
    ok &= _assert_equal(
        processed["text"],
        "Хонаи муқаддас. Аллоҳ моро бибахшад.",
        "full text",
    )
    return ok


def main():
    tests = [
        test_dates,
        test_clitics,
        test_entities_and_noise,
        test_garbage_not_over_triggered,
        test_code_switching_preserved,
        test_full_transcription_pipeline,
    ]
    failed = []
    for t in tests:
        if not t():
            failed.append(t.__name__)
    if failed:
        print(f"\\nFAILED: {failed}")
        sys.exit(1)
    print("\\nAll Tajik post-processing tests passed.")


if __name__ == "__main__":
    main()
