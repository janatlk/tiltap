#!/usr/bin/env python3
"""Quick unit test for boundary segment deduplication."""
import json
import sys
sys.path.insert(0, "C:\\MyProjects\\Tiltab")

from transcribe_hybrid import deduplicate_segment_boundaries


def make_seg(start, end, text):
    return {"id": 0, "start": start, "end": end, "text": text}


def test_boundary_repeats():
    segments = [
        make_seg(11.3, 15.0, "Начнем с того, что есть онлайн и офлайн магазины, в большинстве случаев заказывать онлайн."),
        make_seg(14.5, 19.8, "Заказывать онлайн будет дешевле, но если вы хотите точно убедиться в размере, посадке или качестве какой-то конкретной вещи,"),
        make_seg(26.579, 29.559, "Первая категория это оригинальные брендовые вещи обычного сегмента."),
        make_seg(29.0, 33.079, "сегмента типа nike adidas new balance и так далее самый дешевый способ покупки в"),
        make_seg(33.079, 36.619, "большинстве случаев это заказать из китая если нужна новая вещь которую не"),
        make_seg(35.939, 40.060, "Поэтому ВБ и Озон, по моему мнению, подходят для самых дешевых вещей минимального качества."),
        make_seg(39.5, 40.479, "минимального качества."),
    ]
    result = deduplicate_segment_boundaries(segments)
    print("=== boundary repeats test ===")
    for s in result:
        print(f"[{s['start']:.3f} -> {s['end']:.3f}] {s['text']}")

    # Assertions
    texts = [s["text"] for s in result]
    assert texts[1].startswith("будет дешевле"), f"expected prefix stripped, got: {texts[1]}"
    assert not any(t == "минимального качества." for t in texts), "duplicate segment should be removed"
    assert texts[3].startswith("типа nike"), f"expected 'сегмента' stripped, got: {texts[3]}"
    print("PASSED\n")


def test_no_false_removal():
    # Speaker legitimately repeats a phrase after a pause - should be kept
    segments = [
        make_seg(0.0, 2.0, "Я думаю, что"),
        make_seg(5.0, 8.0, "Я думаю, что это правильно."),
    ]
    result = deduplicate_segment_boundaries(segments)
    print("=== no false removal test ===")
    for s in result:
        print(f"[{s['start']:.3f} -> {s['end']:.3f}] {s['text']}")
    # 3 second gap is below max_time_gap=2? Actually 5.0-2.0=3.0 > 2.0, so should NOT dedup
    assert result[1]["text"] == "Я думаю, что это правильно."
    print("PASSED\n")


if __name__ == "__main__":
    test_boundary_repeats()
    test_no_false_removal()
    print("All tests passed.")
