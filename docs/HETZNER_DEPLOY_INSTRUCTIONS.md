# Tiltab STT Service — Hetzner Deployment Guide

## 1. Create a Hetzner Cloud server

1. Go to [hetzner.com/cloud](https://www.hetzner.com/cloud/) and sign up/log in.
2. In the Cloud Console click **Add Server**.
3. Choose location: **Nuremberg** or **Falkenstein** (cheapest, EU).
4. Select image: **Ubuntu 24.04**.
5. Select type:
   - For testing: **CX22** (2 vCPU / 4 GB RAM / 40 GB) — €3.79/month
   - For production with all local models: **CX32** (4 vCPU / 8 GB RAM / 80 GB) — €6.80/month
6. Add your **SSH public key** (so you can connect without password).
7. Give it a name, e.g. `tiltab-stt`.
8. Click **Create & Buy**.
9. Copy the **IPv4 address**.

## 2. Open firewall ports

In Hetzner Cloud Console:
1. Go to **Firewalls** → **Create Firewall**.
2. Add inbound rules:
   - **SSH** (TCP 22) — your IP only
   - **HTTP/HTTPS** (TCP 80/443) — or just 8000 for testing
3. Attach firewall to your server.

For quick testing you can allow port **8000**:
```bash
ufw allow 8000/tcp
```

## 3. Connect to the server

```bash
ssh root@YOUR_SERVER_IP
```

## 4. Run the deployment script

```bash
curl -fsSL https://raw.githubusercontent.com/janatlk/tiltap/main/stt-service/deploy.sh | bash
```

This installs Docker, clones the repo, downloads Vosk models, and builds the STT container.

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
    ...
  }
}
```

## 7. Test transcription

From your local machine:

```bash
cd stt-service
python test_client.py http://YOUR_SERVER_IP:8000
```

## 8. Update the main bot

In your main application `.env` add:

```env
STT_SERVICE_URL=http://YOUR_SERVER_IP:8000
```

Then configure `transcriptionService.ts` to call `/transcribe` for `ky` and `uz`.
