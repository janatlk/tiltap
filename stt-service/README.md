# Tiltab STT Service

Standalone FastAPI microservice for local STT models used by the Tiltap backend.

## Supported languages

| Language | Primary model | Notes |
|----------|---------------|-------|
| `ky` | Vosk `vosk-model-ky-0.42` | Local, highest priority |
| `uz` | Rubai `islomov/rubaistt_v2_medium` (CTranslate2 int8) | Local, highest priority |
| `ru` | Vosk `vosk-model-ru-0.42` or Whisper medium | Local if model present, else downloads |
| `en` | Whisper `distil-large-v3` | Downloaded on first use |
| `tg` | ElevenLabs Scribe v2 → fine-tuned Whisper Tajik → Whisper fallback | Cloud + local |

## Local development

```bash
python -m venv stt-service/.venv
stt-service/.venv/Scripts/pip install -r stt-service/requirements.txt

# On Windows
$env:FFMPEG_PATH = "node_modules/ffmpeg-static/ffmpeg.exe"
PYTHONPATH=. stt-service/.venv/Scripts/uvicorn stt-service.main:app --host 127.0.0.1 --port 8000

# On Linux/macOS
export FFMPEG_PATH=ffmpeg
PYTHONPATH=. uvicorn stt-service.main:app --host 127.0.0.1 --port 8000
```

## Test

```bash
curl -X POST -F "file=@test_audio/ky.wav" -F "language=ky" http://127.0.0.1:8000/transcribe
curl -X POST -F "file=@test_audio/uz.wav" -F "language=uz" http://127.0.0.1:8000/transcribe
```

## Local test results (2026-06-25)

| Language | Model | RT factor | Quality |
|----------|-------|-----------|---------|
| `ky` | Vosk large ky | ~1.2x | Good, clear Cyrillic output |
| `uz` | Rubai CT2 int8 | ~1.0x | Good Uzbek Latin output |
| `ru` | Vosk large ru | ~1.0x | Good |
| `en` | Whisper distil-large-v3 | ~4x | Excellent |
| `tg` | ElevenLabs (no key/failed) → Whisper Tajik (rejected) → distil-large-v3 | ~3x | Acceptable, fallback worked |

> Note: Cyrillic output may display as escaped Unicode in Windows bash terminals; the JSON itself is valid UTF-8.

## Deployment on Hetzner CX22

1. Create an Ubuntu 22.04/24.04 server (CX22: 2 vCPU / 4 GB RAM / 40 GB disk).
2. Copy `deploy.sh` to the server and run it as root.
3. Upload the custom models that have no public URL:

```bash
scp -r models/rubai-ct2-int8 root@YOUR_SERVER_IP:/opt/tiltap/models/
# Optional, only if you want local Tajik support:
# scp -r models/whisper-tajik-finetuned-ct2 root@YOUR_SERVER_IP:/opt/tiltap/models/
```

4. Re-run `deploy.sh` to finish.

### Disk usage estimate

| Model | Size |
|-------|------|
| vosk-model-ky-0.42 | ~1.9 GB |
| rubai-ct2-int8 | ~740 MB |
| vosk-model-small-ky-0.42 | ~87 MB |
| vosk-model-small-uz-0.22 | ~102 MB |
| **Total required** | **~2.8 GB** |

Optional:

| Model | Size |
|-------|------|
| vosk-model-ru-0.42 | ~1.9 GB |
| whisper-tajik-finetuned-ct2 | ~500 MB |

## Environment variables

| Variable | Description |
|----------|-------------|
| `PORT` | Listen port (default: 8000) |
| `HOST` | Listen host (default: 0.0.0.0) |
| `FFMPEG_PATH` | Path to ffmpeg binary |
| `ELEVENLABS_API_KEY` | For Tajik cloud transcription |
| `ELEVENLABS_MODEL_ID` | Defaults to `scribe_v2` |
| `GEMINI_API_KEY` / `GROQ_API_KEY` / `OPENAI_API_KEY` | For Tajik post-processing |
