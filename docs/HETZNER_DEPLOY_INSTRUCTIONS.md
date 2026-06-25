# Tiltab STT Service — Hetzner Deployment Guide

## 1. Create a Hetzner Cloud server

1. Go to [hetzner.com/cloud](https://www.hetzner.com/cloud/) and sign up/log in.
2. In the Cloud Console click **Add Server**.
3. Choose location: **Nuremberg** or **Falkenstein**.
4. Select image: **Ubuntu 22.04**.
5. Select type:
   - For testing with small models: **CPX22** (2 vCPU / 4 GB RAM / 80 GB) — ~$23.59/month
   - For production with large Kyrgyz model active for all lengths: **CPX32** (4 vCPU / 8 GB RAM / 160 GB) — ~$33.59/month
   > Note: Cost-optimized CX22/CX23 were unavailable at the time of writing.
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

## 5. Upload Rubai model

The Rubai Uzbek model (`models/rubai-ct2-int8`, ~740 MB) is too large to download anonymously.
From your local machine run:

```bash
scp -r models/rubai-ct2-int8 root@YOUR_SERVER_IP:/opt/tiltap/models/
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
