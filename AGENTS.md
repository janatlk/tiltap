# TilTap Backend — Agent Notes

## Контекст проекта

См. заметку в Obsidian: `[[Projects/Tiltap]]` (`C:\Users\janat\Documents\Obsidian\KimiContext\Projects\Tiltap.md`).

Важные договорённости:
- Текущий фокус: довести транскрипцию ky/tg/uz до максимального качества.
- Озвучку и перевод пока НЕ трогаем.
- **Подход: локальные open-source STT-модели + инженерия.** Облачные STT API (ElevenLabs, OpenAI Whisper API и т.п.) не используются для транскрипции.
- Перед запуском бота проверять `.env` и наличие локальных моделей в `models/`.


## Sprint 1 Deliverables Checklist

| Requirement | Status | Notes |
|-------------|--------|-------|
| Node.js 22 + TypeScript strict | ✅ | `npm run build` passes |
| Express REST API | ✅ | `/api/translate`, `/health`, `/webhook/*` |
| PostgreSQL persistence | ✅ | Schema in `src/db/schema.sql`, migrations on startup |
| Swagger / OpenAPI docs | ✅ | Served at `/api-docs` from `swagger.yaml` |
| Docker support | ✅ | `Dockerfile` + `docker-compose.yml` |
| CI/CD prep | ✅ | `.github/workflows/ci.yml` |
| Telegram webhook | ✅ | `POST /webhook/telegram` |
| WhatsApp webhook | 🟡 | Placeholder endpoint only |

## Local Development Setup

### 1. Environment

```bash
cp .env.example .env
# Edit .env and fill in TELEGRAM_BOT_TOKEN, DATABASE_URL, and OPENAI_API_KEY (used for Tajik cleanup / translation)
```

### 2. PostgreSQL

Option A — Docker (recommended when Docker is available):

```bash
docker-compose up -d db
```

Option B — Local install:

```bash
# Windows (Chocolatey)
choco install postgresql

# Create database
psql -U postgres -c "CREATE USER tiltab WITH PASSWORD 'tiltap';"
psql -U postgres -c "CREATE DATABASE tiltab OWNER tiltap;"
```

### 3. Run

```bash
npm install
npm run dev
```

The server will auto-run migrations on startup.

### 4. Verify

- Health: `curl http://localhost:3000/health` — returns basic service health.
- Provider status is not used for STT; transcription runs locally via `transcribe_hybrid.py`.
- Swagger: `http://localhost:3000/api-docs`
- Translate: `curl -X POST http://localhost:3000/api/translate -H "Content-Type: application/json" -d '{"text":"hello","targetLang":"ru"}'`
- Telegram bot: Send `/test` to run the built-in accuracy benchmark

## Architecture

```
Telegram Update → routes/webhook.ts → controllers/telegramController.ts
                                                ↓
                                    services/fileDownloadService.ts
                                    services/transcriptionService.ts
                                      → transcribe_hybrid.py (local open-source models)
                                    services/translationService.ts
                                                ↓
                                    src/db/repos/*  ←  PostgreSQL
```

### Telegram flow

1. On first contact (`/start` or any message) the bot detects the user's Telegram `language_code` and creates a profile with a matching interface language, default source language (same as interface language), and a sensible default target language.
2. The user can send media (voice, audio, video, document) or a supported link directly. The main menu only offers **Settings** and **Help**, plus a list of supported platforms.
3. After media or a link arrives, the bot first asks for the **source language**. The user picks it, then sees a confirmation card with the selected source → target languages and a **Start** button.
4. Supported links: **YouTube**, **TikTok**, **Instagram Reels**. YouTube is validated via yt-dlp (with Cobalt fallback); TikTok and Instagram are downloaded directly through Cobalt. Invalid, private, age-restricted, or sign-in-required videos return a clear localized error.
5. Processing starts with a real-time loading bar and a **Stop** inline button. The loading message is deleted once the final document is sent.
6. The final transcription or translation document is sent with a **Back to menu** button attached. The chosen target language is saved as the user's default for future requests.
7. `/settings` opens a single **Settings** screen where users change interface language, default transcription language, and default translation language independently. Back navigation returns to Settings rather than the main menu.

## `/test` Accuracy Benchmark

The bot includes a self-test that works for all five supported languages:

1. `/test` shows an inline keyboard to choose the test language (`ky`, `tg`, `uz`, `en`, `ru`) or run all languages.
2. For the selected language the bot temporarily switches the user's transcription language, then restores it after the test.
3. Shows a visual loading bar: 30% → 60% → 100% with the correct test header.
4. Transcribes the audio with the configured STT engine.
5. Applies conservative local post-processing (`text_postprocessing.py`) for Tajik script normalization and noise filtering.
6. Compares the cleaned text with a hand-curated reference transcript.
7. Computes character + word similarity (Levenshtein + Jaccard) and reports a percentage with color-coded emoji:
   - 🟢 ≥ 90%
   - 🟡 ≥ 70%
   - 🟠 ≥ 50%
   - 🔴 < 50%

Local audio fixtures live in `test_audio/` and are described by `test_audio/manifest.json` and `test_audio/hard_manifest.json`.

## Local STT Routing (`transcribe_hybrid.py`)

All transcription runs locally with open-source models. `TILTAB_STT_PROVIDER` defaults to `local`; cloud providers are only used if explicitly set.

Routing per language is based on the hard benchmark of real YouTube clips (`test_audio/hard_manifest.json`):

| Language | Primary model | Fallback chain | Hard char/word | Notes |
|----------|---------------|----------------|----------------|-------|
| `ky` | Whisper `nineninesix/kyrgyz-whisper-small` converted to CTranslate2 int8 on RunPod GPU | Vosk `vosk-model-ky-0.42` (CPU, if GPU fails/times out) | — | The GPU worker patches faster-whisper to accept the custom `<|ky|>` token and decodes with `beam_size=1`, `condition_on_previous_text=False`, `without_timestamps=True`, `no_repeat_ngram_size=3`, `temperature=0.0`. A post-decode byte-token cleanup step fixes any raw UTF-8 byte leakage from the model. CPU fallback is automatic when the GPU worker fails or is disabled. |
| `tg` | Fine-tuned Whisper `models/whisper-tajik-finetuned-ct2` | Local Whisper `models/whisper-large-v3-turbo-ct2` → Vosk small tg | 94.3% / 94.4% | Local Whisper needs enough RAM; on low-memory machines it falls back to Vosk small. |
| `uz` | Whisper fine-tuned Rubai `models/rubai-ct2-int8` (files < 600 s) | Local Whisper `models/whisper-large-v3-turbo-ct2` → Vosk small uz | 81.4% / 67.9% | Best known local Uzbek model. |
| `ru` | Local Whisper `models/whisper-large-v3-turbo-ct2` | Vosk small ru | — | Large-v3-turbo handles Russian better than the small Vosk model and avoids English bias. |
| `en` | Local Whisper `models/whisper-large-v3-turbo-ct2` | — | — | Same multilingual model as ru/auto. |
| `auto` / `multi` | Local Whisper `models/whisper-large-v3-turbo-ct2` dual-pass (auto-detect + Russian forced) | — | — | For Turkic/Russian code-switching. |

Latest run: `python benchmark.py test_audio/hard_manifest.json` (2026-07-02).

### Chunking

- **Kyrgyz GPU**: long audio is handled by the GPU worker. Silero VAD splits at natural pauses (`GPU_VAD_MIN_SILENCE_MS=500`, `GPU_VAD_MAX_CHUNK_SECONDS=15`, `GPU_VAD_OVERLAP_SECONDS=0.5`) into ≤15 s chunks, which are transcribed one at a time with faster-whisper. Each chunk receives a short Cyrillic Kyrgyz `initial_prompt` to keep output in Kyrgyz script. Identical text at chunk boundaries (from the small overlap) is deduplicated inside the handler. If the GPU worker fails or times out, the backend automatically falls back to local Vosk.
- **Whisper (ru/en/auto/multi and VAD-disabled tg/uz)**: language-specific `initial_prompt`s prime each chunk toward the correct script and style (e.g. Cyrillic Uzbek, Cyrillic Tajik, Russian). Long audio (> `TILTAB_WHISPER_CHUNK_THRESHOLD_SECONDS`, default 300 s) is split into overlapping time chunks (`TILTAB_WHISPER_CHUNK_SECONDS` default 300 s, overlap 5 s). Each chunk is transcribed independently, timestamps are shifted back, and boundary segments are deduplicated. This keeps conditioning from drifting on long podcasts/interviews. When VAD is enabled, chunks are based on detected speech regions instead.
- **Kyrgyz CPU fallback (Vosk)**: if the GPU path is unavailable, long audio is split into sliding 25-second windows with 5-second overlap; timestamps are corrected and overlapping words are deduplicated.
- **RunPod upload compression**: the `/run` body has a 10 MiB limit. Files ≥ 6 MiB are re-encoded to MP3 (mono, 16 kHz, 32 kbps) before base64 upload. The re-encoding writes the input to a temporary file first; MP4/M4A containers cannot be reliably demuxed from a non-seekable pipe, and piping them produced empty/corrupt MP3s that caused `ffmpeg conversion failed` on the GPU worker.

Environment controls:
- `TILTAB_LOCAL_WHISPER_MODEL` — path to CTranslate2 model (default `models/whisper-large-v3-turbo-ct2`).
- `TILTAB_LOCAL_WHISPER_HF_MODEL` — optional HuggingFace-format fallback directory.
- `TILTAB_WHISPER_CHUNK_THRESHOLD_SECONDS` — only chunk when audio is longer than this (default `300`).
- `TILTAB_WHISPER_CHUNK_SECONDS` — chunk length in seconds (default `300`, minimum `60`).
- `TILTAB_WHISPER_CHUNK_OVERLAP_SECONDS` — overlap between chunks (default `5`).

### Known gaps

- **Short phrasebook clips** (`test_audio/manifest.json`) still score poorly (~20–30% char) for all models. The leading hypothesis is that the long silences between isolated phrases and Whisper's previous-text conditioning cause insertions/repetitions. A dedicated short-audio strategy (VAD split + per-phrase transcription without conditioning) is the next step.

## Local STT Post-processing

After local STT, `text_postprocessing.py` runs language-aware cleanup:

- Segment-level garbage detection (repetition, Latin/Arabic leakage, non-speech markers).
- Tajik-specific rules:
  - Arabic/Persian script normalization to Tajik Cyrillic.
  - Named-entity dictionary matching (`data/tajik_entities.json` or defaults).
  - Mixed-script typo correction (`муfассал` → `муфассал`).
  - Date ordinals and `ро` clitic normalization.
- Noise markers (`[плач]`, `[кулол]`, `[аплодисменты]`, `[музыка]`, `[неразборчиво]`).
- Tajik transcripts are passed through an LLM cleanup step by default. Provider chain: **OpenAI `gpt-4o-mini`** (primary) → **Groq** (fallback). Set `TILTAB_CLEANUP_PROVIDER=none` to keep only rule-based processing, or `=openai`/`=groq` to force a specific provider. Results are cached in `cleanup_cache` to avoid repeated API calls.

## Web Mini-Service

A browser-based UI mirrors the Telegram bot's core features at `http://localhost:3000/web`:

- Upload audio/video files (max 25 MB) or paste a YouTube link.
- Choose source transcription language and optional target translation language.
- Real-time progress via Server-Sent Events (with polling fallback).
- View transcription text and timed segments.
- Translate the result into any supported language.

Implementation:
- Static UI lives in `public/web/index.html`.
- API routes are mounted under `/api/web` in `src/routes/web.ts`.
- `src/controllers/webController.ts` manages asynchronous jobs in memory and reuses `transcriptionService`, `translationService`, and `youtubeService`.
- YouTube download/validation logic was refactored into `src/services/youtubeService.ts` so both Telegram and Web can share it.

Endpoints:
- `POST /api/web/transcribe` — multipart upload, returns `{ jobId }`.
- `POST /api/web/youtube` — YouTube URL, returns `{ jobId }`.
- `POST /api/web/translate` — direct text translation.
- `GET /api/web/jobs/:jobId` — job status.
- `GET /api/web/jobs/:jobId/progress` — SSE progress stream.

## State Persistence

- `users` — Telegram chat IDs, interface language, default transcription (`preferred_language`) and default translation (`target_language`)
- `messages` — Every incoming Telegram message for audit
- `transcriptions` — STT results with segments
- `translations` — Cached translations to avoid re-calling the module

Temporary in-memory state that is intentionally not persisted:

- `activeProcesses` Map — currently running Python PIDs keyed by chat ID

`pendingActions` is backed by PostgreSQL: audio buffers and YouTube URLs awaiting user confirmation are persisted to the `pending_actions` table so the confirmation flow survives Render free-tier spin-downs and container restarts. Rows are removed when the action is started/cancelled and expire after 60 minutes.

## Translation

Translation is available both in the Telegram bot (after transcription, if a target language was selected) and via the Web API (`POST /api/translate`).

Provider priority (unless overridden by `TILTAB_TRANSLATION_PROVIDER`):

1. **OpenAI `gpt-4o-mini`** — primary for Tajik (`tg`) source or target, and for `TILTAB_TRANSLATION_PROVIDER=openai`.
2. **Lingva Translate** — free, open-source front-end for Google Translate. No API key required for public instances. Supports all Tiltap languages (`en/ru/tg/uz/ky`). Long texts are automatically split into chunks. Used by default for non-Tajik pairs.
3. **Groq `llama-3.3-70b-versatile`** — LLM fallback (requires `GROQ_API_KEY`).
4. **Mock** — returns a placeholder translation if nothing else is available.

Translation results are cached in `translation_cache` keyed by SHA-256 of the source text and target language, minimizing repeat API costs.

The LLM translation prompt is intentionally strict: it forbids adding, removing, summarizing, or inferring information; merging or splitting sentences; inventing names; and reframing meaning (e.g. intensifying "certain risks" into "a threat"). Names are preserved or rendered using their established target-language form when one exists.

A post-translation QA review step (`TILTAB_REVIEW_ENABLED`, default `true`) checks the result for source-language leftovers, inconsistent terminology, and hallucinated names. It uses the configured review provider (`TILTAB_REVIEW_PROVIDER`, default `auto`) and model (`TILTAB_REVIEW_MODEL`), falling back between Groq and OpenAI if one fails. Review failures are logged and silently ignored so they never block a translation. Review is skipped when the combined source + translated text exceeds `TILTAB_REVIEW_MAX_INPUT_CHARS` (default `4000`) to avoid JSON-format failures on long inputs.

Before a translation is cached or returned, a lightweight sanity check rejects degenerate outputs such as empty text or a single word repeated more than 35% of the time (e.g. the model getting stuck in a loop). When this happens the service throws, letting the caller fall back to the original transcription instead of sending garbage to the user. Cached translations are also re-validated on read, so any bad entries stored before this guard was introduced are automatically deleted and re-translated.

LLM translation calls now set `max_tokens` (`TILTAB_TRANSLATION_MAX_TOKENS`, default `4096`). If the model consumes the entire budget, the request is treated as truncated and fails over rather than returning an incomplete, possibly repetitive result.

If Daniel's module URL is configured (`TRANSLATION_MODULE_URL`), all translation requests are proxied to it instead.

## Translation Audit Log

Every translation request is recorded:

- `translation_cache` stores the current lifecycle state of each unique `(source_hash, target_lang)`: `pending`, `confirmed`, `rejected`, or `error`.
- `translation_requests` is an append-only audit log that captures each request with its source text, target language, provider/model, source URL, source type, and any error message.
- Every translation response includes a public `requestId` (the `request_number` from the audit log). Users can quote this number when reporting errors; admins can look it up directly in the admin panel search box or via `GET /api/admin/translations/search/:number`.

The admin panel at `/web/admin.html` exposes four tabs:

1. **Pending** — unconfirmed translations awaiting admin review.
2. **Confirmed (Accepted)** — approved translations that are now served from cache for matching source text.
3. **Rejected** — translations an admin rejected; preserved for audit and not served from cache.
4. **Errors** — translation requests that failed (logged in `translation_requests`).

Rejecting a translation updates its status instead of deleting it. Admins can still hard-delete a row from the Confirmed or Rejected tab if needed.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather |
| `OPENAI_API_KEY` | no | Tajik cleanup and Tajik translation primary; also general translation fallback |
| `GROQ_API_KEY` | no | Cleanup and translation fallback |
| `TILTAB_CLEANUP_PROVIDER` | no | `openai` (default), `groq`, or `none` |
| `TILTAB_CLEANUP_MODEL` | no | Override the default model for the chosen cleanup provider |
| `LINGVA_TRANSLATE_URL` | no | Free Lingva instance, default `https://lingva.ml` |
| `LINGVA_TRANSLATE_CHUNK_SIZE` | no | Max characters per Lingva chunk (default `2000`) |
| `TILTAB_TRANSLATION_PROVIDER` | no | `lingva`, `openai`, `groq`, `mock`, or `auto` |
| `TILTAB_REVIEW_ENABLED` | no | Run post-translation QA review (default `true`) |
| `TILTAB_REVIEW_PROVIDER` | no | `openai`, `groq`, or `auto` (default `auto`; prefers the same provider used for translation) |
| `TILTAB_REVIEW_MODEL` | no | Override the model used for QA review |
| `TILTAB_TRANSLATION_MAX_TOKENS` | no | Max output tokens for LLM translation (default `4096`). Hitting the limit raises an error so the caller can fall back to the source transcript. |
| `TILTAB_REVIEW_MAX_TOKENS` | no | Max output tokens for the post-translation review step (default `4096`) |
| `TILTAB_REVIEW_MAX_INPUT_CHARS` | no | Skip the review step when source + translated text exceeds this length (default `4000`) |
| `TILTAB_ADMIN_TOKEN` | **yes** | Required to open `/web/admin.html` and to call `/api/admin/*` endpoints. Without it the admin UI and API return `401`. |
| `TILTAB_STT_PROVIDER` | no | `local` (default), `auto`, `openai`, or `elevenlabs` |
| `TILTAB_GPU_STT_URL` | no | RunPod GPU STT endpoint URL (e.g. `https://api.runpod.ai/v2/xxx/runsync`). When set, supported languages are offloaded to GPU. |
| `TILTAB_GPU_STT_API_KEY` | no | RunPod endpoint API key |
| `TILTAB_GPU_STT_LANGUAGES` | no | Comma-separated list of languages routed to GPU (default `ru,en,uz,tg,ky,auto,multi`) |
| `TILTAB_GPU_STT_TIMEOUT_MS` | no | Backend polling timeout for a GPU STT job (default `600000` = 10 min) |
| `GPU_VAD_MIN_SILENCE_MS` | no | Silero VAD minimum silence to split chunks on the GPU worker (default `1500`) |
| `GPU_VAD_MAX_CHUNK_SECONDS` | no | Maximum chunk length on the GPU worker (default `30`) |
| `GPU_VAD_OVERLAP_SECONDS` | no | Padding overlap added to each GPU worker VAD chunk (default `5`) |
| `GPU_JOB_TIMEOUT_SECONDS` | no | Worker-side hard timeout for a single GPU job (default `900`) |
| `KYRGYZ_BEAM_SIZE` | no | Kyrgyz model beam size on GPU worker (default `1`) |
| `KYRGYZ_BEST_OF` | no | Kyrgyz model `best_of` on GPU worker (default `1`) |
| `KYRGYZ_CONDITION_ON_PREVIOUS_TEXT` | no | Whether to condition Kyrgyz decoding on previous text (default `false`) |
| `KYRGYZ_NO_REPEAT_NGRAM_SIZE` | no | Kyrgyz model `no_repeat_ngram_size` (default `3`) |
| `KYRGYZ_REPETITION_PENALTY` | no | Kyrgyz model repetition penalty (default `1.0`) |
| `KYRGYZ_TEMPERATURE` | no | Kyrgyz model temperature (default `0.0`) |
| `KYRGYZ_WITHOUT_TIMESTAMPS` | no | Disable timestamp tokens for Kyrgyz (default `true`) |
| `KYRGYZ_MAX_NEW_TOKENS` | no | Hard cap on Kyrgyz output tokens, `0` = no cap (default `0`) |
| `KYRGYZ_MAX_NEW_TOKENS_PER_SECOND` | no | Dynamic token cap per chunk second, `0` = disabled (default `0`) |
| `KYRGYZ_NORMALIZE_TEXT` | no | Normalize Kazakh-lookalike Cyrillic to Kyrgyz and lowercase (default `false`) |
| `KYRGYZ_FILTER_CREDITS` | no | Drop subtitle/credit phrases from Kyrgyz output (default `true`) |
| `KYRGYZ_PREFIX` | no | Force the Kyrgyz decode to start with this text (default empty) |
| `KYRGYZ_INITIAL_PROMPT` | no | Prompt priming for each Kyrgyz VAD chunk (default: short Cyrillic Kyrgyz instruction) |
| `KYRGYZ_DEDUPE_MIN_CHARS` | no | Minimum overlap length to remove from chunk boundaries (default `8`) |
| `WHISPER_COMPUTE_TYPE` | no | GPU worker CTranslate2 compute type: `int8`, `float16`, `float32`, etc. (default `int8`) |
| `TILTAB_LOCAL_WHISPER_MODEL` | no | Path to local CTranslate2 Whisper model for ru/en/auto/multi (default `models/whisper-large-v3-turbo-ct2`) |
| `TILTAB_LOCAL_WHISPER_HF_MODEL` | no | Optional HuggingFace-format Whisper fallback directory |
| `TILTAB_WHISPER_CHUNK_THRESHOLD_SECONDS` | no | Audio length threshold for external time chunking (default `300`) |
| `TILTAB_WHISPER_CHUNK_SECONDS` | no | Length of each external Whisper chunk in seconds (default `300`) |
| `TILTAB_WHISPER_CHUNK_OVERLAP_SECONDS` | no | Overlap between external Whisper chunks in seconds (default `5`) |
| `YOUTUBE_COOKIES_BASE64` | no | Base64-encoded Netscape-format YouTube cookies file; helps bypass "Sign in to confirm" on datacenter IPs |
| `YOUTUBE_COOKIES_PATH` | no | Path to a Netscape-format YouTube cookies file (alternative to base64) |
| `YOUTUBE_PO_TOKEN` | no | Proof-of-Origin token(s) for YouTube web client, comma-separated `CLIENT.CONTEXT+TOKEN` entries |
| `YOUTUBE_VISITOR_DATA` | no | YouTube visitor data for Innertube API requests (use with PO token, not cookies) |
| `YOUTUBE_PROXY` | no | HTTP/HTTPS/SOCKS proxy for YouTube requests (e.g. `http://user:pass@host:port`) |
| `COBALT_API_URL` | no | Single Cobalt API fallback URL. Default rotates through public instances |
| `COBALT_API_URLS` | no | Comma-separated list of Cobalt API URLs for rotation |
| `YOUTUBE_AUTO_UPDATE_YTDLP` | no | Set `true` to upgrade `yt-dlp` on every container start (recommended on Render) |
| `TRANSLATION_MODULE_URL` | no | Daniel's translation module endpoint |
| `TELEGRAM_WEBHOOK_SECRET` | no | Future webhook validation |
| `LOG_LEVEL` | no | `error`, `warn`, `info`, `debug` |

## Deployment (Hetzner CX43)

Production runs on a Hetzner CX43 (8 vCPU / 16 GB RAM / 160 GB NVMe, hel2) with local open-source models. Models live in `/opt/tiltap/models` and are part of the deployment artifact.

### Required server secrets

- `TELEGRAM_BOT_TOKEN`
- `DATABASE_URL`

Optional:
- `TILTAB_GPU_STT_URL` / `TILTAB_GPU_STT_API_KEY` / `TILTAB_GPU_STT_TIMEOUT_MS` (RunPod GPU offloading)
- GPU worker tuning: `GPU_VAD_MIN_SILENCE_MS`, `GPU_VAD_MAX_CHUNK_SECONDS`, `GPU_VAD_OVERLAP_SECONDS`, `GPU_JOB_TIMEOUT_SECONDS`, plus Kyrgyz knobs (`KYRGYZ_*`) listed above.
- `OPENAI_API_KEY` (Tajik cleanup / translation primary)
- `GROQ_API_KEY` (cleanup / translation fallback)
- `TILTAB_CLEANUP_PROVIDER` / `TILTAB_CLEANUP_MODEL`
- `LINGVA_TRANSLATE_URL` / `TILTAB_TRANSLATION_PROVIDER`
- `TILTAB_REVIEW_ENABLED` / `TILTAB_REVIEW_PROVIDER` / `TILTAB_REVIEW_MODEL`
- `YOUTUBE_COOKIES_BASE64` or `YOUTUBE_COOKIES_PATH`
- `YOUTUBE_PO_TOKEN` / `YOUTUBE_VISITOR_DATA`
- `YOUTUBE_PROXY`
- `COBALT_API_URL` / `COBALT_API_URLS`
- `YOUTUBE_AUTO_UPDATE_YTDLP=true`

### Deploy

```bash
ssh root@95.216.169.56
cd /opt/tiltap
git fetch origin
git reset --hard origin/main
npm ci
npm run build
systemctl restart tiltab-backend.service
systemctl status tiltab-backend.service --no-pager
```

New models must be downloaded to `/opt/tiltap/models` and added to the server provisioning/automation so they persist across rebuilds.

### CI/CD

`.github/workflows/ci.yml` builds, tests, and deploys to Render on every push to `main`. Add the Render deploy hook URL as a GitHub secret named `RENDER_DEPLOY_HOOK_URL`.

## Notes

- The bot runs on Windows locally and on Ubuntu 22.04 on Hetzner.
- Python is required for local STT (`transcribe_hybrid.py`, Vosk, CTranslate2 Whisper), YouTube download (`yt-dlp`), and validation scripts.
- Cyrillic output safety: `PYTHONIOENCODING=utf-8` + `sys.stdout.reconfigure(encoding="utf-8")`.
- Real-time progress is emitted as JSON lines from `transcribe_hybrid.py` and consumed by the Node controller.
- **YouTube on Render:** if all videos return "Sign in to confirm" or HTTP 403, set `YOUTUBE_AUTO_UPDATE_YTDLP=true`, add fresh browser cookies via `YOUTUBE_COOKIES_BASE64`, and (if still blocked) provide a PO token via `YOUTUBE_PO_TOKEN`. The Docker startup script now updates `yt-dlp` automatically when this flag is enabled, and `download_youtube.py`/`validate_youtube.py` prefer mobile/TV player clients to reduce bot detection.
- **YouTube Cobalt fallback:** when yt-dlp fails with bot detection or sign-in requirements, `download_youtube.py` and `validate_youtube.py` automatically fall back to public Cobalt API instances (`COBALT_API_URL` or `COBALT_API_URLS`). The downloader rotates through the list until one succeeds. This is the current workaround for datacenter IPs (including Hetzner) where YouTube blocks direct yt-dlp downloads. For production load, deploy a private Cobalt instance and point `COBALT_API_URL` at it.
