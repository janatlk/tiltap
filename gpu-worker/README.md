# TilTap GPU STT Worker

RunPod serverless handler that runs Whisper/faster-whisper on GPU for Russian,
English, Tajik, Uzbek and auto-detect transcription.

## Build

```bash
cd gpu-worker
# If running from project root, include the model directories in the build context.
docker build -t yourdockerhub/tiltap-gpu-stt:latest .
```

## Push

```bash
docker push yourdockerhub/tiltap-gpu-stt:latest
```

## RunPod endpoint settings

- Source: **Docker image**
- Image: `yourdockerhub/tiltap-gpu-stt:latest`
- GPU: **NVIDIA T4**
- Workers: **0 idle / 2 max** (or as budget allows)
- Container port: `8000` (RunPod expects the HTTP handler here)
- Handler: leave empty if using `runpod.serverless.start`
- Environment variables (optional):
  - `WHISPER_DEVICE=cuda`
  - `WHISPER_COMPUTE_TYPE=float16`
  - `WHISPER_BEAM_SIZE=5`
  - `WHISPER_VAD_FILTER=true`

## Test

```bash
python test_local.py sample.wav ru
```

RunPod endpoints can be tested from the console with a base64-encoded audio
payload:

```json
{
  "input": {
    "audio_base64": "...",
    "language": "ru"
  }
}
```
