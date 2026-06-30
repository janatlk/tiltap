# Tiltab — Deployment & Integration Log

## Overview

This document records the deployment of the standalone STT microservice on Hetzner Cloud and its integration with the main Tiltab backend.

---

## 1. STT Service Deployment on Hetzner

### Server
- **Provider**: Hetzner Cloud
- **Name**: `tiltab-stt-1`
- **IP**: `46.225.238.161`
- **Type**: CPX22 (2 vCPU / 4 GB RAM / 80 GB SSD)
- **Location**: Nuremberg
- **OS**: Ubuntu 22.04
- **Cost**: ~$23.59/month (CPX22 $22.99 + IPv4 $0.60)

> Note: The originally planned CX22/CX23 (cost-optimized) instances were unavailable in the Hetzner console, so CPX22 was used instead.

### SSH Key
- Private key: `stt-service/.keys/hetzner_deploy_key`
- Public key added to the Hetzner server during creation

### Models on Server (`/opt/tiltap/models/`)
- `vosk-model-small-ky-0.42` (~87 MB) — downloaded by `deploy.sh`
- `vosk-model-small-uz-0.22` (~102 MB) — downloaded by `deploy.sh`
- `vosk-model-ky-0.42` (~1.9 GB) — large Kyrgyz Vosk model
- `rubai-ct2-int8` (~740 MB) — Uzbek fine-tuned Whisper (Rubai), uploaded manually

### Deployment Script
- File: `stt-service/deploy.sh`
- Actions:
  1. Updates system packages
  2. Installs Docker and docker-compose-plugin
  3. Clones/pulls the repo to `/opt/tiltap`
  4. Downloads required Vosk models
  5. Builds and starts the Docker container

### Container
- Image: `tiltab-stt:latest`
- Container name: `tiltab-stt`
- Port: `8000`
- Compose: `stt-service/docker-compose.yml`
- Memory limit: `2.5G`

### Dockerfile Fixes Applied
1. Removed an invalid `COPY ... 2>/dev/null || true` line that Docker cannot parse.
2. Added a symlink `ln -s /app/models /app/stt-service/models` so relative model paths resolve correctly inside the container.

### OOM Fix for Kyrgyz on 4 GB RAM
- Original code always loaded `vosk-model-ky-0.42` (~1.9 GB) for Kyrgyz.
- Combined with Rubai in memory, this caused the container to be killed by the OOM killer.
- Fix in `transcribe_hybrid.py`: use the large model only for clips shorter than 60 seconds; use `vosk-model-small-ky-0.42` for longer audio.

---

## 2. Backend Integration

### Configuration
- Added `TILTAB_STT_SERVICE_URL` to:
  - `src/config/index.ts` (Zod schema)
  - `.env.example`
  - Local `.env` (set to `http://46.225.238.161:8000`)

### New Service
- File: `src/services/remoteSttService.ts`
- Sends multipart/form-data audio to `POST {TILTAB_STT_SERVICE_URL}/transcribe`
- Returns a normalized `TranscriptionResult`

### Routing Logic (`src/services/transcriptionService.ts`)
- If `TILTAB_STT_SERVICE_URL` is set and language is `ky` or `uz` → use remote Hetzner STT.
- Otherwise → existing cloud/local logic (ElevenLabs → OpenAI/Groq → local hybrid).

### Health Check
- `GET /health` now returns `remoteSttConfigured: true/false`.

---

## 3. Verification

### Hetzner STT Service
```bash
curl http://46.225.238.161:8000/health
```
Response:
```json
{
  "status": "ok",
  "models": {
    "vosk_small_ky": true,
    "vosk_small_uz": true,
    "rubai_uz": true,
    "vosk_large_ru": false,
    "whisper_distil": true
  }
}
```

### Backend
```bash
curl http://localhost:3000/health
```
Response:
```json
{
  "status": "ok",
  "database": "connected",
  "sttProvider": "auto",
  "remoteSttConfigured": true,
  "openaiConfigured": true,
  "groqConfigured": true,
  "elevenlabsConfigured": true
}
```

### End-to-End Tests
| Language | Input | Route | Status |
|----------|-------|-------|--------|
| `uz` | `test_audio/uz.wav` | backend → Hetzner | ✅ completed |
| `ky` | `test_audio/ky.wav` | backend → Hetzner (small Vosk) | ✅ completed, no OOM |
| `uz` | YouTube URL via web UI | backend → Hetzner | ✅ completed |
| `en` | YouTube URL via web UI (`/api/web/youtube`) | backend → cloud Whisper | ✅ completed |

### Telegram Bot
- The bot runs as part of the backend on Hetzner.
- Telegram webhooks require HTTPS, which is not available on a bare IP.
- Workaround: run `tiltab-telegram-poll.service`, which polls `getUpdates` and forwards them to `http://localhost:3000/webhook/telegram`.
- Bot token updated in `/opt/tiltap/.env` and verified via `getWebhookInfo` (webhook empty, polling active).

---

## 4. Known Issues & Notes

### Windows Console Mojibake
- Cyrillic JSON from the server is valid UTF-8.
- Windows console may display it as gibberish due to `cp1251`/`cp1252` encoding.
- Use `python -c "import json; print(json.load(open('file.json'))['text'])"` with UTF-8 output or save to a file and open in an editor.

### Rubai Quality Guard
- Rubai runs for Uzbek audio but is sometimes rejected by `detect_hallucination()` (e.g., `english_intrusion` flag on transliterated greetings).
- When rejected, the service falls back to `vosk-model-small-uz-0.22`.
- This is expected behavior; tune `detect_hallucination()` if you want to prefer Rubai output more aggressively.

### Server Memory
- 4 GB is tight when Rubai + large Kyrgyz Vosk are loaded together.
- The current workaround uses small Kyrgyz Vosk for clips ≥ 60 s.
- For full large-model Kyrgyz on long audio, upgrade to CPX32 (8 GB RAM).

### YouTube on Hetzner backend
- The Node backend needs `yt-dlp` on the host OS for `validate_youtube.py` and `download_youtube.py`.
- The base Ubuntu 22.04 image does **not** include `python3-pip` or `yt-dlp`.
- Fix: `apt-get install -y python3-pip && pip3 install -U yt-dlp`.
- After installing yt-dlp, `POST /api/web/youtube` validates, downloads, and transcribes YouTube links end-to-end.
- **Datacenter IP block**: most videos return "Sign in to confirm". The free fix is fresh browser cookies + PO token/visitor_data (see `docs/YOUTUBE_COOKIES.md`). Cloudflare WARP was tested and **broke SSH access** — not recommended.

### STT queue & memory safety
- Added a Promise-based queue in `src/services/remoteSttService.ts` so only one remote STT request runs at a time.
- The STT service now drops cached Whisper models after every request (`transcribe_hybrid.release_whisper_models()`), preventing Rubai + Vosk large ky from coexisting in the 2.5 GB Docker limit.

### Deploy Script Caveat
- `deploy.sh` clones to `/opt/tiltap` and runs `git pull`.
- If the server working tree has local modifications, `git pull` will fail.
- Workaround used during this deployment: `cd /opt/tiltap && git reset --hard origin/main && bash stt-service/deploy.sh`

---

## 5. Next Steps / Improvements

- [ ] Add real-time progress streaming from the remote STT service (currently the backend job stays at 0% until Hetzner returns).
- [ ] Add a Makefile or GitHub Actions workflow to run `deploy.sh` automatically on push.
- [ ] Consider upgrading Hetzner to CPX32 (8 GB) to keep Vosk large ky active for all lengths.
- [ ] Add a retry/fallback mechanism if the remote STT service is temporarily unreachable.
- [ ] Document how to upload/update the Rubai model in one command.
