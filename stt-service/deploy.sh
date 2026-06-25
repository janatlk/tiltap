#!/usr/bin/env bash
set -euo pipefail

# Tiltab STT Service deployment script for Hetzner CX22/CX32.
# Run as root on a fresh Ubuntu 22.04/24.04 server.

REPO_URL="https://github.com/janatlk/tiltap.git"
REPO_DIR="/opt/tiltap"
MODELS_DIR="$REPO_DIR/models"

# Models required for the two priority local languages (ky, uz).
# Optional models can be enabled by setting DEPLOY_TG=1 or DEPLOY_RU=1.
DEPLOY_TG=${DEPLOY_TG:-0}
DEPLOY_RU=${DEPLOY_RU:-0}

echo "=== Updating system ==="
apt-get update && apt-get upgrade -y

echo "=== Installing Docker ==="
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
fi

echo "=== Installing docker-compose plugin ==="
if ! docker compose version &> /dev/null; then
    apt-get install -y docker-compose-plugin
fi

echo "=== Cloning/updating repository ==="
if [ -d "$REPO_DIR" ]; then
    cd "$REPO_DIR"
    git fetch origin
    git reset --hard origin/main
else
    git clone "$REPO_URL" "$REPO_DIR"
    cd "$REPO_DIR"
fi

echo "=== Creating models directory ==="
mkdir -p "$MODELS_DIR"
cd "$MODELS_DIR"

download_vosk() {
    local name=$1
    local url=$2
    if [ ! -d "$name" ]; then
        echo "Downloading $name..."
        wget -q --show-progress "$url"
        unzip -q "${name}.zip"
        rm "${name}.zip"
    else
        echo "$name already present, skipping."
    fi
}

echo "=== Downloading required Vosk models (ky/uz) ==="
download_vosk "vosk-model-small-ky-0.42" "https://alphacephei.com/vosk/models/vosk-model-small-ky-0.42.zip"
download_vosk "vosk-model-ky-0.42" "https://alphacephei.com/vosk/models/vosk-model-ky-0.42.zip"
download_vosk "vosk-model-small-uz-0.22" "https://alphacephei.com/vosk/models/vosk-model-small-uz-0.22.zip"

if [ "$DEPLOY_TG" -eq 1 ]; then
    echo "=== Downloading Tajik models ==="
    download_vosk "vosk-model-small-tg-0.22" "https://alphacephei.com/vosk/models/vosk-model-small-tg-0.22.zip"
fi

if [ "$DEPLOY_RU" -eq 1 ]; then
    echo "=== Downloading Russian Vosk model ==="
    download_vosk "vosk-model-ru-0.42" "https://alphacephei.com/vosk/models/vosk-model-ru-0.42.zip"
fi

# Large custom models must be provided by the user (no public direct link).
MISSING=0

if [ ! -d "rubai-ct2-int8" ]; then
    echo ""
    echo "WARNING: rubai-ct2-int8 model not found."
    echo "Upload it from your local machine:"
    echo "  scp -r models/rubai-ct2-int8 root@YOUR_SERVER_IP:$MODELS_DIR/"
    MISSING=1
fi

if [ "$DEPLOY_TG" -eq 1 ] && [ ! -d "whisper-tajik-finetuned-ct2" ]; then
    echo ""
    echo "WARNING: whisper-tajik-finetuned-ct2 model not found."
    echo "Upload it from your local machine:"
    echo "  scp -r models/whisper-tajik-finetuned-ct2 root@YOUR_SERVER_IP:$MODELS_DIR/"
    MISSING=1
fi

if [ "$MISSING" -eq 1 ]; then
    echo ""
    echo "Please upload the missing models and re-run this script."
    exit 1
fi

echo "=== Building and starting STT service ==="
cd "$REPO_DIR/stt-service"
docker compose down || true
docker compose up -d --build

echo ""
echo "=== Deployment complete ==="
echo "Health check: curl http://YOUR_SERVER_IP:8000/health"
echo "Test Kyrgyz:    curl -X POST -F file=@ky.wav -F language=ky http://YOUR_SERVER_IP:8000/transcribe"
echo "Test Uzbek:     curl -X POST -F file=@uz.wav -F language=uz http://YOUR_SERVER_IP:8000/transcribe"
