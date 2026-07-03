# Tiltab STT Service — Hetzner Deployment Guide

## 1. Create a Hetzner Cloud server

1. Go to [hetzner.com/cloud](https://www.hetzner.com/cloud/) and sign up/log in.
2. In the Cloud Console click **Add Server**.
3. Choose location: **Nuremberg** or **Falkenstein**.
4. Select image: **Ubuntu 22.04**.
5. Select type:
   - Recommended for production: **CX43** (8 vCPU / 16 GB RAM / 160 GB) — ~$18.49/month
   - For testing with small models only: **CPX22** (2 vCPU / 4 GB RAM / 80 GB) — ~$23.59/month
   > Note: The CX43 line is the current cost-optimized Hetzner type and has enough RAM to keep multiple STT models resident.
6. Add your **SSH public key**.
7. Give it a name, e.g. `tiltab-stt`.
8. Click **Create & Buy**.
9. Copy the **IPv4 address**.

## 2. Open firewall ports

In Hetzner Cloud Console:
1. Go to **Firewalls** → **Create Firewall**.
2. Add inbound rules:
   - **SSH** (TCP 22) — your IP only
   - **STT API** (TCP 8000) — your backend IP / anywhere (use a reverse proxy for production)
3. Attach firewall to your server.

For quick testing you can allow port **8000** directly:
```bash
ufw allow 8000/tcp
```

## 3. Connect to the server

```bash
ssh root@YOUR_SERVER_IP
```

## 4. Run the deployment script

The recommended way is to clone the repo and run `deploy.sh` from it. This avoids issues with local modifications on the server:

```bash
rm -rf /opt/tiltap
git clone https://github.com/janatlk/tiltap.git /opt/tiltap
cd /opt/tiltap/stt-service
bash deploy.sh
```

If you already have `/opt/tiltap` and want a clean redeploy:

```bash
cd /opt/tiltap
git reset --hard origin/main
cd stt-service
bash deploy.sh
```

## 5. Upload custom models

The following models are too large or not publicly downloadable and must be copied from your local machine before running `deploy.sh`:

| Model | Local path | Size (approx) | Needed for |
|-------|------------|---------------|------------|
| Uzbek Rubai CT2 int8 | `models/rubai-ct2-int8` | ~740 MB | `uz` (primary) |
| Tajik fine-tuned Whisper CT2 | `models/whisper-tajik-finetuned-ct2` | ~780 MB | `tg` (primary) |
| Multilingual Whisper large-v3-turbo CT2 | `models/whisper-large-v3-turbo-ct2` | ~780 MB | `tg` fallback, `ru`/`en`/`auto` local |

Deploy Tajik models by setting `DEPLOY_TG=1` when running `deploy.sh`.

From your local machine run:

```bash
scp -r models/rubai-ct2-int8 root@YOUR_SERVER_IP:/opt/tiltap/models/
scp -r models/whisper-large-v3-turbo-ct2 root@YOUR_SERVER_IP:/opt/tiltap/models/
# If transcribing Tajik on the remote STT service:
DEPLOY_TG=1 bash deploy.sh   # or scp the model manually before running:
# scp -r models/whisper-tajik-finetuned-ct2 root@YOUR_SERVER_IP:/opt/tiltap/models/
```

Then restart the service:

```bash
ssh root@YOUR_SERVER_IP "cd /opt/tiltap/stt-service && docker compose restart"
```

## 6. Verify

```bash
curl http://YOUR_SERVER_IP:8000/health
```

Expected response:
```json
{
  "status": "ok",
  "models": {
    "vosk_small_ky": true,
    "vosk_small_uz": true,
    "rubai_uz": true,
    "whisper_distil": true
  }
}
```

## 7. Test transcription

From your local machine:

```bash
curl -X POST -F file=@test_audio/ky.wav -F language=ky http://YOUR_SERVER_IP:8000/transcribe
curl -X POST -F file=@test_audio/uz.wav -F language=uz http://YOUR_SERVER_IP:8000/transcribe
```

## 8. Wire the main backend

In your main application `.env` add:

```env
TILTAB_STT_SERVICE_URL=http://YOUR_SERVER_IP:8000
```

The backend (`src/services/transcriptionService.ts`) will automatically route `ky` and `uz` requests to the remote STT service.

## 9. Updating the service

After pushing changes to `main`:

```bash
ssh root@YOUR_SERVER_IP "cd /opt/tiltap && git reset --hard origin/main && cd stt-service && bash deploy.sh"
```

> The `git reset --hard origin/main` step is important because `deploy.sh` currently does not handle local modifications on the server.

## 10. Deploy/Update the backend on the same server

Because the backend is also running on `tiltab-stt-1`, it needs Node.js, npm dependencies, Python, and `yt-dlp` on the host.

### One-time host setup

```bash
# Node.js 22 (if not already installed)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Python tooling used by the YouTube scripts
apt-get install -y python3-pip
pip3 install -r /opt/tiltap/requirements.txt
```

### Install / build the backend

```bash
cd /opt/tiltap
npm ci
npm run build
```

### Create the systemd service

Copy the provided unit file:

```bash
cp /opt/tiltap/scripts/tiltab-backend.service /etc/systemd/system/tiltab-backend.service
```

Then enable and start it:

```bash
systemctl daemon-reload
systemctl enable --now tiltab-backend.service
```

### Environment file

Create `/opt/tiltap/.env` with at least:

```env
NODE_ENV=production
DATABASE_URL=...
TELEGRAM_BOT_TOKEN=...
TILTAB_STT_SERVICE_URL=http://localhost:8000
OPENAI_API_KEY=...
GROQ_API_KEY=...
ELEVENLABS_API_KEY=...
```

Then restart the service:

```bash
systemctl restart tiltab-backend.service
```

### Updating the backend

After pushing changes to `main`:

```bash
ssh root@YOUR_SERVER_IP "cd /opt/tiltap && git reset --hard origin/main && npm ci && npm run build && systemctl restart tiltab-backend.service"
```

### Telegram bot

Telegram requires an **HTTPS URL** for webhooks. On a bare Hetzner IP you can run the included polling forwarder instead:

```bash
cp /opt/tiltap/scripts/tiltab-telegram-poll.service /etc/systemd/system/tiltab-telegram-poll.service
systemctl daemon-reload
systemctl enable --now tiltab-telegram-poll.service
```

This polls `https://api.telegram.org/bot<TOKEN>/getUpdates` and forwards updates to `http://localhost:3000/webhook/telegram`.

If you have a domain with HTTPS later, disable the forwarder and set the webhook directly:

```bash
systemctl stop tiltab-telegram-poll.service
systemctl disable tiltab-telegram-poll.service

curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://YOUR_DOMAIN/webhook/telegram"}'
```

### Memory on CX43

CX43 has 16 GB RAM. The STT Docker container is limited to 12 GB, leaving headroom for the Node backend, PostgreSQL (if co-located), and OS buffers. The backend still queues remote STT requests (`src/services/remoteSttService.ts`) so only one heavy model is active at a time, which prevents CPU contention and keeps memory usage predictable. Cached Whisper models are kept in RAM between requests to reduce latency.

If you downgrade to a 4 GB instance, edit `stt-service/docker-compose.yml` to lower the memory limit and uncomment/adjust the `release_whisper_models()` call in `stt-service/main.py`.

### YouTube sign-in errors

Hetzner's datacenter IP is often blocked by YouTube. If every link returns "Sign in to confirm", follow `docs/YOUTUBE_COOKIES.md` to add fresh browser cookies, PO token, and visitor data to `/opt/tiltap/.env`.

> Do **not** use Cloudflare WARP on the server — it reroutes all traffic and can lock you out of SSH.

### Verify YouTube end-to-end

```bash
curl -X POST http://YOUR_SERVER_IP:3000/api/web/youtube \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","language":"en"}'
```

Expected response:

```json
{"jobId":"...","title":"Rick Astley - Never Gonna Give You Up ..."}
```

Then poll the job:

```bash
curl http://YOUR_SERVER_IP:3000/api/web/jobs/JOB_ID
```
