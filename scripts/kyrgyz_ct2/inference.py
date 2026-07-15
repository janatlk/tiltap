#!/usr/bin/env python3
"""
Local faster-whisper inference for the converted Kyrgyz Whisper CT2 model.

- Monkey-patches faster_whisper.tokenizer BEFORE model load so that language="ky"
  is accepted natively.
- Loads the model 100% offline from the converted CT2 directory.
- Runs a test transcription on a dummy audio file.

Deployment targets:
- Hetzner CX43 (CPU inference fallback if GPU worker is down)
- RunPod serverless GPU (primary — fast inference, low VRAM)

Usage:
    python scripts/kyrgyz_ct2/inference.py \
        --model_dir models/kyrgyz-whisper-small-ct2 \
        --audio test_audio/ky.wav \
        --language ky

Environment:
    WHISPER_DEVICE        — cuda | cpu (default: auto)
    WHISPER_COMPUTE_TYPE  — float16 | int8 | float32 (default: float16)
"""

import argparse
import os
import sys
import wave

from pathlib import Path

# ---------------------------------------------------------------------------
# Monkey-patch faster_whisper.tokenizer so Kyrgyz is a first-class citizen
# ---------------------------------------------------------------------------

def _patch_faster_whisper_tokenizer():
    """Append 'ky' to _LANGUAGE_CODES in faster_whisper.tokenizer module."""
    import faster_whisper.tokenizer as _tok

    if "ky" not in _tok._LANGUAGE_CODES:
        _tok._LANGUAGE_CODES = (*_tok._LANGUAGE_CODES, "ky")
        print("[patch] 'ky' added to faster_whisper.tokenizer._LANGUAGE_CODES")
    else:
        print("[patch] 'ky' already present in _LANGUAGE_CODES")


# Apply patch immediately on import so every downstream call sees it.
_patch_faster_whisper_tokenizer()

# Now it's safe to import the rest of faster_whisper
from faster_whisper import WhisperModel  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Offline Kyrgyz ASR with faster-whisper"
    )
    parser.add_argument(
        "--model_dir",
        type=str,
        required=True,
        help="Path to the local CT2 converted model directory",
    )
    parser.add_argument(
        "--audio",
        type=str,
        default=None,
        help="Path to audio file to transcribe (WAV, MP3, etc.)",
    )
    parser.add_argument(
        "--language",
        type=str,
        default="ky",
        help="Language code to force (default: ky)",
    )
    parser.add_argument(
        "--device",
        type=str,
        default=os.environ.get("WHISPER_DEVICE", "auto"),
        choices=["auto", "cpu", "cuda"],
        help="Inference device",
    )
    parser.add_argument(
        "--compute_type",
        type=str,
        default=os.environ.get("WHISPER_COMPUTE_TYPE", "float16"),
        choices=["int8", "int8_float16", "float16", "float32"],
        help="CTranslate2 compute type",
    )
    parser.add_argument(
        "--beam_size",
        type=int,
        default=int(os.environ.get("WHISPER_BEAM_SIZE", "5")),
        help="Beam size for decoding",
    )
    parser.add_argument(
        "--generate_dummy",
        action="store_true",
        help="Generate a 1-second silent WAV if --audio is omitted",
    )
    return parser.parse_args()


def generate_dummy_wav(path: Path, duration_sec: float = 1.0, sample_rate: int = 16000) -> Path:
    """Create a silent mono WAV file for a quick smoke test."""
    print(f"[dummy] Generating {duration_sec}s silent WAV -> {path}")
    n_samples = int(sample_rate * duration_sec)
    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00" * (n_samples * 2))
    return path


def transcribe(
    model_dir: str,
    audio_path: str,
    language: str,
    device: str,
    compute_type: str,
    beam_size: int,
) -> None:
    """Load the CT2 model and run transcription."""
    print(f"[load] Loading CT2 model from: {model_dir}")
    print(f"[load] device={device}, compute_type={compute_type}")

    model = WhisperModel(
        model_size_or_path=model_dir,
        device=device,
        compute_type=compute_type,
        local_files_only=True,  # <-- enforce 100% offline, no internet
    )

    print(f"[transcribe] Running inference on: {audio_path}")
    segments, info = model.transcribe(
        audio_path,
        language=language,
        beam_size=beam_size,
        vad_filter=True,
    )

    print(f"[info] Detected language: {info.language} (prob={info.language_probability:.4f})")
    print(f"[info] Duration: {info.duration:.2f}s")
    print("-" * 60)

    full_text = []
    for seg in segments:
        line = f"[{seg.start:.2f}s -> {seg.end:.2f}s] {seg.text.strip()}"
        print(line)
        full_text.append(seg.text.strip())

    print("-" * 60)
    print("[result] Full text:")
    print(" ".join(full_text))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    args = parse_args()

    model_dir = Path(args.model_dir).resolve()
    if not model_dir.exists():
        raise FileNotFoundError(f"Model directory not found: {model_dir}")

    # Determine audio input
    if args.audio:
        audio_path = Path(args.audio).resolve()
        if not audio_path.exists():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")
    elif args.generate_dummy:
        audio_path = Path("tmp_ky_dummy.wav").resolve()
        generate_dummy_wav(audio_path, duration_sec=1.0)
    else:
        raise SystemExit(
            "Error: provide --audio or use --generate_dummy to create a test WAV."
        )

    transcribe(
        model_dir=str(model_dir),
        audio_path=str(audio_path),
        language=args.language,
        device=args.device,
        compute_type=args.compute_type,
        beam_size=args.beam_size,
    )


if __name__ == "__main__":
    main()
