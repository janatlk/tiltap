"""Silero VAD utilities for the RunPod GPU STT worker.

Uses the pip package `silero-vad` instead of torch.hub so the model can be
pre-downloaded and cached inside the Docker image.
"""

import math
import os
import sys
import wave
from typing import Dict, List, Optional, Tuple

import torch

_silero_model: Optional[torch.jit.ScriptModule] = None


def load_silero_vad_model() -> torch.jit.ScriptModule:
    """Lazy-load and cache the Silero VAD model."""
    global _silero_model
    if _silero_model is None:
        from silero_vad import load_silero_vad

        print("[vad] Loading Silero VAD model...", file=sys.stderr, flush=True)
        _silero_model = load_silero_vad()
        print("[vad] Silero VAD model loaded.", file=sys.stderr, flush=True)
    return _silero_model


def read_wav_as_torch(wav_path: str) -> Tuple[torch.Tensor, int]:
    """Read a 16-bit PCM WAV file and return normalized float32 torch tensor."""
    import array

    with wave.open(wav_path, "rb") as wf:
        n_channels = wf.getnchannels()
        sample_width = wf.getsampwidth()
        sample_rate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    if sample_width == 2:
        samples = array.array("h", raw)
        audio = torch.tensor(samples, dtype=torch.float32) / 32768.0
    elif sample_width == 1:
        audio = torch.frombuffer(raw, dtype=torch.uint8).to(torch.float32)
        audio = (audio - 128.0) / 128.0
    else:
        raise ValueError(f"Unsupported sample width: {sample_width}")

    if n_channels > 1:
        audio = audio.view(-1, n_channels).mean(dim=1)

    return audio, sample_rate


def get_speech_segments(
    wav_path: str,
    sample_rate: int = 16000,
    threshold: float = 0.5,
    min_speech_duration_ms: int = 250,
    min_silence_duration_ms: int = 2000,
    speech_pad_ms: int = 200,
) -> Optional[List[Dict[str, float]]]:
    """Return speech segments as [{'start': sec, 'end': sec}] or None on failure."""
    from silero_vad.utils_vad import get_speech_timestamps

    model = load_silero_vad_model()
    try:
        audio, sr = read_wav_as_torch(wav_path)
        if sr != sample_rate:
            target_len = int(round(len(audio) * sample_rate / sr))
            audio = torch.nn.functional.interpolate(
                audio.unsqueeze(0).unsqueeze(0),
                size=target_len,
                mode="linear",
                align_corners=False,
            ).squeeze()

        timestamps = get_speech_timestamps(
            audio,
            model,
            sampling_rate=sample_rate,
            threshold=threshold,
            min_speech_duration_ms=min_speech_duration_ms,
            min_silence_duration_ms=min_silence_duration_ms,
            speech_pad_ms=speech_pad_ms,
            return_seconds=True,
        )
        return [{"start": float(t["start"]), "end": float(t["end"])} for t in timestamps]
    except Exception as e:
        print(f"[vad] segmentation failed: {e}", file=sys.stderr, flush=True)
        return None


def _sliding_split(chunk: Dict[str, float], max_duration: float, overlap: float) -> List[Dict[str, float]]:
    """Split a chunk that has no natural silence gaps into sliding windows."""
    duration = chunk["end"] - chunk["start"]
    if duration <= max_duration:
        return [chunk]

    step = max_duration - overlap
    out: List[Dict[str, float]] = []
    start = chunk["start"]
    while start < chunk["end"]:
        end = min(chunk["end"], start + max_duration)
        out.append({"start": start, "end": end})
        if end == chunk["end"]:
            break
        start += step
    return out


def merge_speech_segments(
    segments: List[Dict[str, float]],
    max_gap: float = 2.0,
    max_duration: float = 30.0,
    overlap: float = 5.0,
) -> List[Dict[str, float]]:
    """Merge adjacent speech segments and split overly long chunks.

    Args:
        segments: Speech segments from Silero VAD.
        max_gap: Segments separated by silence <= this value (seconds) are merged.
        max_duration: No output chunk will exceed this duration (seconds).
        overlap: Overlap for the sliding-window fallback on continuous speech.

    Returns:
        Chunks suitable for passing to an ASR engine. Long chunks are first
        split at the largest internal silence gaps; if no gaps exist, a sliding
        30-second window is used, so words are cut only as a last resort.
    """
    if not segments:
        return []

    sorted_segs = sorted(segments, key=lambda x: x["start"])
    merged: List[Dict[str, float]] = []
    current = dict(sorted_segs[0])

    for seg in sorted_segs[1:]:
        if seg["start"] - current["end"] <= max_gap:
            current["end"] = max(current["end"], seg["end"])
        else:
            merged.append(current)
            current = dict(seg)
    merged.append(current)

    final: List[Dict[str, float]] = []
    for chunk in merged:
        duration = chunk["end"] - chunk["start"]
        if duration <= max_duration:
            final.append(chunk)
            continue

        # Find original VAD segments inside this merged chunk.
        inner_segs = [
            s for s in sorted_segs
            if s["start"] >= chunk["start"] - 1e-6 and s["end"] <= chunk["end"] + 1e-6
        ]

        # Build silence gaps between consecutive inner segments.
        gaps: List[Tuple[float, float]] = []
        prev_end = chunk["start"]
        for seg in inner_segs:
            if seg["start"] > prev_end:
                gaps.append((prev_end, seg["start"]))
            prev_end = max(prev_end, seg["end"])
        if chunk["end"] > prev_end:
            gaps.append((prev_end, chunk["end"]))

        # Prefer the widest gaps near the middle of the chunk.
        mid = (chunk["start"] + chunk["end"]) / 2
        gaps.sort(key=lambda g: (-(g[1] - g[0]), abs((g[0] + g[1]) / 2 - mid)))

        pieces: List[Dict[str, float]] = [chunk]
        for gap_start, gap_end in gaps:
            split_at = (gap_start + gap_end) / 2
            new_pieces: List[Dict[str, float]] = []
            for pc in pieces:
                if pc["start"] < split_at < pc["end"]:
                    if split_at - pc["start"] >= 0.5:
                        new_pieces.append({"start": pc["start"], "end": split_at})
                    if pc["end"] - split_at >= 0.5:
                        new_pieces.append({"start": split_at, "end": pc["end"]})
                else:
                    new_pieces.append(pc)
            pieces = new_pieces
            if all((p["end"] - p["start"]) <= max_duration for p in pieces):
                break

        for pc in pieces:
            final.extend(_sliding_split(pc, max_duration, overlap))

    return final


def slice_wav_chunk(input_wav: str, output_wav: str, start: float, end: float) -> None:
    """Write a [start, end) slice of a 16-bit PCM WAV file to output_wav."""
    with wave.open(input_wav, "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        start_frame = int(start * framerate)
        end_frame = int(end * framerate)
        wf.setpos(start_frame)
        frames = wf.readframes(end_frame - start_frame)

    with wave.open(output_wav, "wb") as of:
        of.setnchannels(n_channels)
        of.setsampwidth(sampwidth)
        of.setframerate(framerate)
        of.writeframes(frames)
