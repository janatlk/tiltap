# RunPod serverless GPU handler for TilTap STT
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONIOENCODING=utf-8
ENV TORCH_HOME=/models/.torch_cache

WORKDIR /app

# Install Python build dependencies and pip
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev \
    build-essential cmake git wget ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip/setuptools/wheel
RUN pip3 install --no-cache-dir --upgrade pip setuptools wheel

# Copy requirements first for layer caching
COPY gpu-worker/requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# Copy handler and VAD utilities
COPY gpu-worker/handler.py .
COPY gpu-worker/vad_utils.py .

# Patch faster-whisper to accept the custom Kyrgyz <|ky|> language token used by
# nineninesix/kyrgyz-whisper-small. The token exists in the model vocabulary; we
# just need to add "ky" to the internal language-code whitelist.
RUN for f in /usr/local/lib/python3.*/dist-packages/faster_whisper/tokenizer.py; do \
      sed -i 's/    "af",/    "af",\n    "ky",/' "$f"; \
    done

# Models baked into the image. Place them in /models.
# Build context must contain the model directories relative to ARGs below.
ARG WHISPER_TURBO_DIR=models/whisper-large-v3-turbo-ct2
ARG TAJIK_DIR=models/muhtasham-whisper-tg-ct2
ARG UZBEK_DIR=models/rubai-ct2-int8

COPY ${WHISPER_TURBO_DIR} /models/whisper-large-v3-turbo-ct2
COPY ${TAJIK_DIR} /models/muhtasham-whisper-tg-ct2
COPY ${UZBEK_DIR} /models/rubai-ct2-int8

# Download the original HuggingFace model for Kyrgyz. The Colab reference
# pipeline uses transformers with chunk_length_s=30 / batch_size=8, which gives
# much better quality on real-world Kyrgyz audio than the CTranslate2/faster-
# whisper conversion. We keep the faster-whisper path for ru/en/uz/tg.
RUN python3 - <<'PY'
import os
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
from transformers import WhisperForConditionalGeneration, WhisperProcessor
model_id = "nineninesix/kyrgyz-whisper-small"
out_dir = "/models/kyrgyz-whisper-small-hf"
print(f"Downloading {model_id} to {out_dir}...")
model = WhisperForConditionalGeneration.from_pretrained(model_id)
processor = WhisperProcessor.from_pretrained(model_id)
model.save_pretrained(out_dir)
processor.save_pretrained(out_dir)
print("Done.")
PY

# Pre-download Silero VAD so workers don't need internet at runtime.
RUN python3 - <<'PY'
import os
os.environ.setdefault("TORCH_HOME", "/models/.torch_cache")
from silero_vad import load_silero_vad
print("Caching Silero VAD model...")
load_silero_vad()
print("Silero VAD cached.")
PY

ENV WHISPER_DEVICE=cuda
ENV WHISPER_COMPUTE_TYPE=float16
ENV WHISPER_BEAM_SIZE=5
ENV WHISPER_VAD_FILTER=true
ENV KYRGYZ_HF_BATCH_SIZE=8
ENV KYRGYZ_HF_CHUNK_LENGTH_S=30

EXPOSE 8000

CMD ["python3", "-u", "handler.py"]
