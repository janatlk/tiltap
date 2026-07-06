# RunPod serverless GPU handler for TilTap STT
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONIOENCODING=utf-8

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

# Copy handler
COPY gpu-worker/handler.py .

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
ARG KYRGYZ_DIR=models/kyrgyz-whisper-small-ct2

COPY ${WHISPER_TURBO_DIR} /models/whisper-large-v3-turbo-ct2
COPY ${TAJIK_DIR} /models/muhtasham-whisper-tg-ct2
COPY ${UZBEK_DIR} /models/rubai-ct2-int8
COPY ${KYRGYZ_DIR} /models/kyrgyz-whisper-small-ct2

ENV WHISPER_DEVICE=cuda
ENV WHISPER_COMPUTE_TYPE=float16
ENV WHISPER_BEAM_SIZE=5
ENV WHISPER_VAD_FILTER=true

EXPOSE 8000

CMD ["python3", "-u", "handler.py"]
