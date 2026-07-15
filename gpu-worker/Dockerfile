# RunPod serverless GPU handler for TilTap STT
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONIOENCODING=utf-8
ENV TORCH_HOME=/models/.torch_cache

WORKDIR /app

# Install Python build dependencies, pip, and ffmpeg with Opus + MP3 support
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev \
    build-essential cmake git wget \
    ffmpeg libopus0 libmp3lame0 \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip/setuptools/wheel
RUN pip3 install --no-cache-dir --upgrade pip setuptools wheel

# Copy requirements first for layer caching
COPY gpu-worker/requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# Copy handler, VAD utilities, and the shared post-processor.
COPY gpu-worker/handler.py .
COPY gpu-worker/vad_utils.py .
COPY gpu-worker/text_postprocessing.py .

# Models baked into the image. Place them in /models.
# Build context must contain the model directories relative to ARGs below.
ARG WHISPER_TURBO_DIR=models/whisper-large-v3-turbo-ct2
ARG TAJIK_DIR=models/muhtasham-whisper-tg-ct2
ARG UZBEK_DIR=models/rubai-ct2-int8
ARG KYRGYZ_DIR=models/kyrgyz-whisper-small-ct2

COPY ${WHISPER_TURBO_DIR} /models/whisper-large-v3-turbo-ct2
COPY ${TAJIK_DIR} /models/muhtasham-whisper-tg-ct2
COPY ${UZBEK_DIR} /models/rubai-ct2-int8
COPY ${KYRGYZ_DIR} /models/kyrgyz-whisper-small-ct2

# Pre-download Silero VAD so workers don't need internet at runtime.
RUN python3 - <<'PY'
import os
os.environ.setdefault("TORCH_HOME", "/models/.torch_cache")
from silero_vad import load_silero_vad
print("Caching Silero VAD model...")
load_silero_vad()
print("Silero VAD cached.")
PY

# Some converted CTranslate2 models do not ship a tokenizer.json.
# faster-whisper then downloads openai/whisper-tiny at runtime,
# adding a few seconds to the first warm request. Pre-cache/copy the tokenizer
# into those model directories so it is available offline.
ARG HF_TOKEN
ENV HF_TOKEN=${HF_TOKEN}
RUN python3 - <<'PY'
import os
from pathlib import Path
import shutil
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
source_id = "openai/whisper-tiny"
files = ["tokenizer.json", "preprocessor_config.json"]
try:
    from huggingface_hub import hf_hub_download
except Exception as e:
    print(f"huggingface_hub not available: {e}")
    hf_hub_download = None

cache_paths = {}
if hf_hub_download:
    token = os.environ.get("HF_TOKEN") or None
    for fname in files:
        try:
            cache_paths[fname] = hf_hub_download(source_id, fname, token=token)
            print(f"Cached {source_id}/{fname}")
        except Exception as e:
            print(f"Could not download {source_id}/{fname}: {e}")

for d in ["/models/rubai-ct2-int8", "/models/muhtasham-whisper-tg-ct2",
          "/models/whisper-large-v3-turbo-ct2", "/models/kyrgyz-whisper-small-ct2"]:
    p = Path(d)
    if not p.exists():
        continue
    for fname, src in cache_paths.items():
        dst = p / fname
        if not dst.exists():
            shutil.copy(src, dst)
            print(f"Copied {fname} -> {d}")
PY

ENV WHISPER_DEVICE=cuda
ENV WHISPER_COMPUTE_TYPE=int8
ENV WHISPER_BEAM_SIZE=5
ENV WHISPER_VAD_FILTER=true
ENV KYRGYZ_HF_BATCH_SIZE=8
ENV KYRGYZ_HF_CHUNK_LENGTH_S=30

EXPOSE 8000

CMD ["python3", "-u", "handler.py"]
