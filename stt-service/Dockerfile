FROM python:3.11-slim

# Install system dependencies: ffmpeg for audio conversion, git for model downloads.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    git \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy Python deps first for better Docker layer caching.
COPY stt-service/requirements.txt /app/stt-service/requirements.txt
RUN pip install --no-cache-dir -r /app/stt-service/requirements.txt

# Copy application source. Models are mounted at runtime via volume.
COPY transcribe_hybrid.py /app/transcribe_hybrid.py
COPY vad_utils.py /app/vad_utils.py
COPY text_postprocessing.py /app/text_postprocessing.py
COPY stt-service/main.py /app/stt-service/main.py

# Optional entity dictionary can be mounted at runtime; default entities are baked into text_postprocessing.py

ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1
ENV FFMPEG_PATH=ffmpeg

EXPOSE 8000

WORKDIR /app/stt-service
# Models are mounted at /app/models at runtime; symlink so relative "models/..." paths work.
RUN ln -s /app/models /app/stt-service/models
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-keep-alive", "0"]
