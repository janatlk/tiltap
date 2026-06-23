"""Local voice-activity detection (VAD) utilities.

Uses Silero VAD via torch.hub to find speech regions in an audio file.
The detected segments can then be transcribed individually (e.g. by ElevenLabs
Scribe) while preserving original timestamps.
"""

import os
import sys
import wave
import math
from typing import List, Dict, Optional, Tuple

# Keep torch hub cache inside the project so it is easy to ship/cache offline.
os.environ.setdefault("TORCH_HOME", os.path.join(os.path.dirname(os.path.abspath(__file__)), ".torch_cache"))

_silero_model = None
_silero_get_timestamps = None


def _silero_available() -> bool:
    try:
        import torch  # noqa: F401
        return True
    except ImportError:
        return False


def load_silero_vad_model():
    """Lazy-load the Silero VAD model and timestamp utility.

    Returns (model, get_speech_timestamps_fn) or (None, None) if torch is
    unavailable or the model cannot be loaded.
    """
    global _silero_model, _silero_get_timestamps
    if _silero_model is not None and _silero_get_timestamps is not None:
        return _silero_model, _silero_get_timestamps

    if not _silero_available():
        print("[vad] torch not installed, VAD unavailable", file=sys.stderr, flush=True)
        return None, None

    try:
        import torch
        # trust_repo=True avoids the interactive prompt when downloading for the first time.
        model, utils = torch.hub.load(
            repo_or_dir="snakers4/silero-vad",
            model="silero_vad",
            trust_repo=True,
            force_reload=False,
            onnx=False,
        )
        get_timestamps = utils[0]
        _silero_model = model
        _silero_get_timestamps = get_timestamps
        print("[vad] Silero VAD model loaded", file=sys.stderr, flush=True)
        return model, get_timestamps
    except Exception as e:
        print(f"[vad] failed to load Silero VAD: {e}", file=sys.stderr, flush=True)
        return None, None


def read_wav_as_torch(wav_path: str) -> Tuple["torch.Tensor", int]:
    """Read a 16-bit PCM WAV file and return a normalized float32 torch tensor.

    The tensor is mono and its sample rate is whatever the file contains; Silero
    VAD expects 16 kHz, so callers must ensure the file is already resampled.
    """
    import torch

    with wave.open(wav_path, "rb") as wf:
        n_channels = wf.getnchannels()
        sample_width = wf.getsampwidth()
        sample_rate = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    if sample_width == 2:
        import array
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
    min_silence_duration_ms: int = 100,
    speech_pad_ms: int = 100,
) -> Optional[List[Dict[str, float]]]:
    """Return speech segments as [{'start': sec, 'end': sec}, ...] or None on failure."""
    model, get_timestamps = load_silero_vad_model()
    if model is None or get_timestamps is None:
        return None

    try:
        audio, sr = read_wav_as_torch(wav_path)
        if sr != sample_rate:
            # Simple linear-interpolation resample. Good enough for VAD.
            import torch.nn.functional as F
            target_len = int(round(len(audio) * sample_rate / sr))
            audio = F.interpolate(
                audio.unsqueeze(0).unsqueeze(0),
                size=target_len,
                mode="linear",
                align_corners=False,
            ).squeeze()

        timestamps = get_timestamps(
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


def merge_speech_segments(
    segments: List[Dict[str, float]],
    max_gap: float = 0.3,
    max_duration: float = 30.0,
) -> List[Dict[str, float]]:
    """Merge adjacent speech segments and split overly long chunks.

    Args:
        segments: Speech segments from Silero VAD.
        max_gap: Segments separated by silence <= this value are merged.
        max_duration: No output chunk will exceed this duration (seconds).

    Returns:
        A list of chunks suitable for passing to an ASR engine.
    """
    if not segments:
        return []

    # Sort and merge by gap.
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

    # Split any chunk that is longer than max_duration.
    final: List[Dict[str, float]] = []
    for chunk in merged:
        duration = chunk["end"] - chunk["start"]
        if duration <= max_duration:
            final.append(chunk)
            continue

        n_splits = math.ceil(duration / max_duration)
        split_duration = duration / n_splits
        start = chunk["start"]
        for _ in range(n_splits):
            end = min(start + split_duration, chunk["end"])
            final.append({"start": start, "end": end})
            start = end

    return final


def slice_wav_chunk(input_wav: str, output_wav: str, start: float, end: float) -> None:
    """Write a slice of a 16-bit PCM WAV to output_wav using the wave module."""
    with wave.open(input_wav, "rb") as wf:
        n_channels = wf.getnchannels()
        sample_width = wf.getsampwidth()
        sample_rate = wf.getframerate()
        start_frame = int(start * sample_rate)
        end_frame = int(end * sample_rate)
        n_frames = end_frame - start_frame
        wf.setpos(start_frame)
        frames = wf.readframes(n_frames)

    with wave.open(output_wav, "wb") as of:
        of.setnchannels(n_channels)
        of.setsampwidth(sample_width)
        of.setframerate(sample_rate)
        of.writeframes(frames)
