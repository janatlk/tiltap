#!/usr/bin/env python3
"""
Prepare and convert nineninesix/kyrgyz-whisper-small to CTranslate2 (float16).

Steps:
1. Download model + tokenizer from Hugging Face locally.
2. Remove "auto_map" from config.json to strip remote code dependencies.
3. Build tokenizer.json from the custom HF tokenizer files (vocab.json,
   added_tokens.json, merges.txt) because the repo uses custom Python
   tokenization code and does not ship a pre-built tokenizer.json.
4. Run ct2-transformers-converter with quantization float16.
5. Copy tokenizer.json and added_tokens.json into the CT2 output dir so the
   custom <|ky|> token mapping is preserved.

Usage:
    python scripts/kyrgyz_ct2/prepare_and_convert.py \
        --model_id nineninesix/kyrgyz-whisper-small \
        --output_dir models/kyrgyz-whisper-small-ct2 \
        --quantization float16

Deployment targets:
- Hetzner CX43 (8 vCPU / 16 GB RAM / 160 GB NVMe) — models live in /opt/tiltap/models
- RunPod serverless GPU — models baked into the Docker image at /models
"""

import argparse
import json
import os
import shutil
import subprocess
import sys

from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download Kyrgyz Whisper and convert to CTranslate2"
    )
    parser.add_argument(
        "--model_id",
        type=str,
        default="nineninesix/kyrgyz-whisper-small",
        help="Hugging Face model identifier",
    )
    parser.add_argument(
        "--output_dir",
        type=str,
        default="models/kyrgyz-whisper-small-ct2",
        help="Directory where the converted CT2 model will be saved",
    )
    parser.add_argument(
        "--quantization",
        type=str,
        default="float16",
        choices=["int8", "int8_float16", "float16", "float32"],
        help="CTranslate2 quantization mode",
    )
    parser.add_argument(
        "--cache_dir",
        type=str,
        default=None,
        help="Hugging Face cache directory (optional)",
    )
    return parser.parse_args()


def download_model(model_id: str, local_dir: Path, cache_dir: str | None) -> None:
    """Download model weights, config, and tokenizer files using huggingface_hub."""
    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:
        raise RuntimeError("huggingface_hub is required. Install it: pip install huggingface_hub") from exc

    print(f"[1/5] Downloading {model_id} ...")
    snapshot_download(
        repo_id=model_id,
        local_dir=str(local_dir),
        local_dir_use_symlinks=False,
        cache_dir=cache_dir,
        resume_download=True,
    )
    print(f"       Saved to {local_dir}")


def strip_auto_map(config_path: Path) -> None:
    """Remove 'auto_map' key from config.json so CT2 doesn't try to load remote code."""
    print("[2/5] Stripping 'auto_map' from config.json ...")
    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)

    if "auto_map" in config:
        del config["auto_map"]
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        print("       'auto_map' removed.")
    else:
        print("       'auto_map' not present — nothing to do.")


def _load_standard_tokenizer_json() -> dict:
    """Load a standard Whisper tokenizer.json as a template."""
    # Try to find a local standard Whisper tokenizer.json
    candidates = [
        "models/whisper-large-v3-turbo/tokenizer.json",
        "models/whisper-large-v3-turbo-ct2/tokenizer.json",
    ]
    for path in candidates:
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
    # Fallback: download from HF
    try:
        from huggingface_hub import hf_hub_download
        path = hf_hub_download("openai/whisper-tiny", "tokenizer.json")
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        raise RuntimeError(
            "Could not find a standard Whisper tokenizer.json template. "
            "Please download openai/whisper-tiny or ensure models/whisper-large-v3-turbo/tokenizer.json exists."
        ) from e


def build_tokenizer_json(hf_dir: Path) -> None:
    """Build tokenizer.json from the custom HF tokenizer files.

    The nineninesix/kyrgyz-whisper-small repo uses custom Python tokenization code
    (tokenization_whisper.py) and does not ship a pre-built tokenizer.json.
    We construct one by merging the base vocab with the added_tokens (including <|ky|>)
    into a standard Whisper tokenizer.json template.
    """
    print("[3/5] Building tokenizer.json from custom HF tokenizer files ...")

    vocab_path = hf_dir / "vocab.json"
    added_tokens_path = hf_dir / "added_tokens.json"
    merges_path = hf_dir / "merges.txt"

    if not vocab_path.exists():
        raise FileNotFoundError(f"vocab.json missing in {hf_dir}")
    if not added_tokens_path.exists():
        raise FileNotFoundError(f"added_tokens.json missing in {hf_dir}")
    if not merges_path.exists():
        raise FileNotFoundError(f"merges.txt missing in {hf_dir}")

    with open(vocab_path, "r", encoding="utf-8") as f:
        vocab = json.load(f)
    with open(added_tokens_path, "r", encoding="utf-8") as f:
        added_tokens = json.load(f)
    with open(merges_path, "r", encoding="utf-8") as f:
        merges_lines = f.read().strip().split("\n")

    # Merge vocab + added_tokens (preserving the exact IDs from added_tokens.json)
    merged_vocab = dict(vocab)
    for token, token_id in added_tokens.items():
        merged_vocab[token] = token_id

    print(f"       Merged vocab size: {len(merged_vocab)}")
    print(f"       <|ky|> token id: {merged_vocab.get('<|ky|>')}")

    # Load a standard Whisper tokenizer.json as template
    template = _load_standard_tokenizer_json()

    # Update vocab and merges
    template["model"]["vocab"] = merged_vocab
    template["model"]["merges"] = merges_lines[1:] if merges_lines[0].startswith("#") else merges_lines

    # Update added_tokens list
    template["added_tokens"] = [
        {
            "id": token_id,
            "content": token,
            "single_word": False,
            "lstrip": False,
            "rstrip": False,
            "normalized": False,
            "special": True,
        }
        for token, token_id in added_tokens.items()
    ]

    output_path = hf_dir / "tokenizer.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(template, f, ensure_ascii=False, indent=2)

    print(f"       tokenizer.json saved to {output_path}")


def run_ct2_converter(src_dir: Path, out_dir: Path, quantization: str) -> None:
    """Invoke ct2-transformers-converter via subprocess."""
    print(f"[4/5] Running ct2-transformers-converter (quantization={quantization}) ...")
    cmd = [
        sys.executable,
        "-m",
        "ctranslate2.converters.transformers",
        "--model",
        str(src_dir),
        "--output_dir",
        str(out_dir),
        "--quantization",
        quantization,
        "--force",
    ]
    subprocess.run(cmd, check=True)
    print(f"       CT2 model saved to {out_dir}")


def copy_tokenizer_files(src_dir: Path, out_dir: Path) -> None:
    """Copy tokenizer.json and added_tokens.json into CT2 output directory."""
    print("[5/5] Copying tokenizer files into CT2 output directory ...")
    for filename in ("tokenizer.json", "added_tokens.json"):
        src = src_dir / filename
        dst = out_dir / filename
        if src.exists():
            shutil.copy2(str(src), str(dst))
            print(f"       Copied {filename}")
        else:
            print(f"       WARNING: {filename} not found in {src_dir}")


def main() -> None:
    args = parse_args()

    # Resolve paths
    hf_local_dir = Path("hf_downloads") / args.model_id.replace("/", "--")
    output_dir = Path(args.output_dir)

    hf_local_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    # 1. Download
    download_model(args.model_id, hf_local_dir, args.cache_dir)

    # 2. Strip auto_map
    config_path = hf_local_dir / "config.json"
    if not config_path.exists():
        raise FileNotFoundError(f"config.json missing after download: {config_path}")
    strip_auto_map(config_path)

    # 3. Build tokenizer.json from custom HF tokenizer files
    build_tokenizer_json(hf_local_dir)

    # 4. Convert
    run_ct2_converter(hf_local_dir, output_dir, args.quantization)

    # 5. Copy tokenizer artifacts
    copy_tokenizer_files(hf_local_dir, output_dir)

    print("\n✅ All done. Converted model is at:", output_dir.resolve())
    print("\nNext steps:")
    print(f"  Hetzner:  sudo mkdir -p /opt/tiltap/models && sudo cp -r {output_dir.resolve()} /opt/tiltap/models/")
    print(f"  RunPod:   Update gpu-worker/Dockerfile to COPY {output_dir.name} /models/{output_dir.name}")


if __name__ == "__main__":
    main()
