#!/usr/bin/env python3
"""Plan dataset clips for one audio file.

Reads a 16 kHz mono WAV and prints a JSON list of clip boundaries on stdout:

    {"clips": [{"start": 0.12, "end": 9.84}, ...], "method": "silero"}

The boundaries are chosen so that every clip starts and ends inside a pause.
Cutting on a fixed timer is what a naive splitter does, and it slices words in
half; a half word paired with its full transcript teaches the model that the
sound of "кыр" means "кыргыз", which is worse than not training on it at all.

Silero VAD supplies the speech regions. If it is unavailable the script falls
back to fixed-length slicing and says so in "method", so the caller can warn
the linguist rather than silently shipping worse data.
"""

import argparse
import json
import os
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import vad_utils  # noqa: E402

# Clip length policy. Fine-tuning wants utterance-sized audio: long enough to
# carry context, short enough that one bad word does not poison a long clip.
TARGET_SECONDS = 10.0
MAX_SECONDS = 15.0
MIN_SECONDS = 4.0
# Below this a clip is too short to be worth a linguist's attention.
FLOOR_SECONDS = 1.5
# Speech regions further apart than this belong to different clips even when
# the combined length would still fit.
MAX_GAP_SECONDS = 0.8


def audio_duration(wav_path: str) -> float:
    with wave.open(wav_path, "rb") as wf:
        return wf.getnframes() / float(wf.getframerate())


def split_long_region(start: float, end: float) -> list:
    """Cut a region with no usable pause into near-equal parts.

    Only reached when somebody talks for longer than MAX_SECONDS without
    drawing breath. The cut lands mid-word, so these clips are marked for the
    linguist rather than trusted.
    """
    length = end - start
    parts = max(2, int(length / TARGET_SECONDS + 0.5))
    step = length / parts
    return [
        {"start": start + i * step, "end": start + (i + 1) * step, "forced": True}
        for i in range(parts)
    ]


def plan_clips(regions: list, total: float) -> list:
    """Group speech regions into clips of roughly TARGET_SECONDS."""
    clips = []
    current = None

    for region in regions:
        r_start, r_end = region["start"], region["end"]

        if r_end - r_start > MAX_SECONDS:
            if current:
                clips.append(current)
                current = None
            clips.extend(split_long_region(r_start, r_end))
            continue

        if current is None:
            current = {"start": r_start, "end": r_end, "forced": False}
            continue

        gap = r_start - current["end"]
        would_be = r_end - current["start"]
        if gap <= MAX_GAP_SECONDS and would_be <= MAX_SECONDS:
            current["end"] = r_end
            # Long enough to stand on its own: close it rather than growing to
            # the ceiling, so clips cluster around the target instead of 15 s.
            if current["end"] - current["start"] >= TARGET_SECONDS:
                clips.append(current)
                current = None
        else:
            clips.append(current)
            current = {"start": r_start, "end": r_end, "forced": False}

    if current:
        clips.append(current)

    return absorb_short_clips(clips, total)


def absorb_short_clips(clips: list, total: float) -> list:
    """Fold undersized clips into a neighbour when they fit, drop the scraps."""
    result = []
    for clip in clips:
        length = clip["end"] - clip["start"]
        if length >= MIN_SECONDS or not result:
            result.append(clip)
            continue

        previous = result[-1]
        merged = clip["end"] - previous["start"]
        if merged <= MAX_SECONDS and clip["start"] - previous["end"] <= MAX_GAP_SECONDS:
            previous["end"] = clip["end"]
            previous["forced"] = previous["forced"] or clip["forced"]
        elif length >= FLOOR_SECONDS:
            result.append(clip)
        # else: shorter than the floor and unmergeable — a stray cough, dropped.

    for clip in result:
        clip["start"] = round(max(0.0, clip["start"]), 3)
        clip["end"] = round(min(total, clip["end"]), 3)
    return [c for c in result if c["end"] - c["start"] >= FLOOR_SECONDS]


def fallback_clips(total: float) -> list:
    """Fixed slicing, used only when VAD is unavailable."""
    clips = []
    pos = 0.0
    while pos < total:
        end = min(total, pos + TARGET_SECONDS)
        if end - pos >= FLOOR_SECONDS:
            clips.append({"start": round(pos, 3), "end": round(end, 3), "forced": True})
        pos = end
    return clips


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("wav_path")
    parser.add_argument("--threshold", type=float, default=0.5)
    args = parser.parse_args()

    if not os.path.isfile(args.wav_path):
        json.dump({"error": "file not found"}, sys.stdout)
        return 1

    total = audio_duration(args.wav_path)

    regions = vad_utils.get_speech_segments(
        args.wav_path,
        threshold=args.threshold,
        min_speech_duration_ms=250,
        # A natural sentence break is ~300 ms; shorter gaps are inside a phrase.
        min_silence_duration_ms=300,
        # Keep a sliver of the lead-in: VAD trims onsets, and a clipped first
        # consonant is exactly the kind of damage that is invisible in the text.
        speech_pad_ms=150,
    )

    # None means VAD could not run; an empty list means it ran and heard no
    # speech. Only the first deserves the fallback — slicing a file that holds
    # nothing but music or silence would hand the linguist a page of noise.
    if regions is None:
        clips = fallback_clips(total)
        method = "fixed"
    else:
        clips = plan_clips(regions, total)
        method = "silero"

    json.dump({"clips": clips, "method": method, "duration": round(total, 3)}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
