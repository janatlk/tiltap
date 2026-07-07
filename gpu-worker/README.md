# TilTap GPU STT Worker

RunPod serverless handler that runs Whisper/faster-whisper on GPU for Russian,
English, Tajik, Uzbek, Kyrgyz and auto-detect transcription.

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
  - `HF_TOKEN` — HuggingFace access token. Recommended: avoids "unauthenticated requests" warnings and may speed up model/tokenizer downloads. Pass it both at build time (`--build-arg HF_TOKEN=...`) and as a runtime env var on RunPod.
  - `WHISPER_DEVICE=cuda` — device for all Whisper inference (`cuda` or `cpu`). Kyrgyz refuses CPU by default because it is too slow.
  - `WHISPER_COMPUTE_TYPE=float16` — dtype (`float16`, `bfloat16`, `float32`).
  - `WHISPER_BEAM_SIZE=5`
  - `WHISPER_VAD_FILTER=true`
  - `GPU_VAD_ENABLED=true` — enable Silero VAD chunking.
  - `GPU_VAD_THRESHOLD=0.5`
  - `GPU_VAD_MIN_SPEECH_DURATION_MS=250`
  - `GPU_VAD_MIN_SILENCE_MS=1500` — default silence length used to split speech (raised from 500 ms to avoid over-segmentation).
  - `GPU_VAD_SPEECH_PAD_MS=200`
  - `GPU_VAD_MAX_GAP_MS=3000` — merge speech segments separated by silence ≤ this value.
  - `GPU_VAD_MAX_CHUNK_SECONDS=30` — max chunk length.
  - `GPU_VAD_OVERLAP_SECONDS=5` — overlap added around each VAD speech segment.
  - `GPU_VAD_MAX_CHUNKS=40` — if VAD produces more chunks, fall back to fixed windows.
  - `GPU_JOB_TIMEOUT_SECONDS=900` — hard worker-side timeout for a single transcription job.
  - Kyrgyz-specific decoding knobs (all optional, defaults shown):
    - `KYRGYZ_BEAM_SIZE=1`
    - `KYRGYZ_BEST_OF=1`
    - `KYRGYZ_CONDITION_ON_PREVIOUS_TEXT=false`
    - `KYRGYZ_NO_REPEAT_NGRAM_SIZE=3`
    - `KYRGYZ_REPETITION_PENALTY=1.0`
    - `KYRGYZ_TEMPERATURE=0.0`
    - `KYRGYZ_WITHOUT_TIMESTAMPS=true`
    - `KYRGYZ_MAX_NEW_TOKENS=0` (`0` disables the hard cap)
    - `KYRGYZ_MAX_NEW_TOKENS_PER_SECOND=0` (`0` disables the dynamic cap)
    - `KYRGYZ_NORMALIZE_TEXT=false` — normalize Kazakh-lookalike Cyrillic to Kyrgyz and lowercase
    - `KYRGYZ_FILTER_CREDITS=true` — drop subtitle/credit phrases
    - `KYRGYZ_DEDUPE_MIN_CHARS=8` — remove repeated text at chunk boundaries
    - `KYRGYZ_REPEAT_MIN_WORDS=4` — drop a chunk whose first N words already appear in the output (`0` disables)

## Latency / cold start

RunPod serverless workers are cold by default. Real measurements for a 20 s
Uzbek file on a T4:

| Run | `delayTime` | `executionTime` | total |
|-----|-------------|-----------------|-------|
| 1st (cold worker, no cache) | ~21 s | ~5.9 s | ~27 s |
| 2nd (warm worker) | ~0.9 s | ~1.2 s | ~2.5 s |
| 3rd (warm worker) | ~0.9 s | ~1.3 s | ~2.5 s |

The bulk of the first-run delay is RunPod queue/cold-start time, not model
inference. Once a worker is warm, a 20 s file is transcribed in ~1–2 s.

What this image already does to reduce first-run overhead:

- The Whisper/CT2 models and the HuggingFace Kyrgyz model are baked into the
  image.
- Silero VAD is pre-cached during the Docker build.
- Missing `tokenizer.json` files for converted CT2 models are copied from
  `openai/whisper-tiny` at build time, so faster-whisper does not need to hit
  HuggingFace on the first request.

If you need consistently low latency (e.g. Telegram bot users expect a fast
reply), the practical options are:

1. **Keep at least one worker warm** on RunPod (set idle workers > 0). This is
   the single most effective change and is a cost/latency trade-off.
2. **Send a periodic warm-up request** from the backend every few minutes. A
   tiny silent/no-op request keeps the worker pool alive. Be careful with RunPod
   billing/free-tier quotas.
3. **Make sure `HF_TOKEN` is set** so any remaining HuggingFace downloads are
   authenticated and cached reliably.

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
