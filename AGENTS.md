# TilTap Backend — Agent Notes

## Контекст проекта

См. заметку в Obsidian: `[[Projects/Tiltap]]` (`C:\Users\janat\Documents\Obsidian\KimiContext\Projects\Tiltap.md`).

Важные договорённости:
- Текущий фокус: довести транскрипцию ky/tg/uz до максимального качества.
- Озвучку и перевод пока НЕ трогаем.
- **Подход: облачный STT + LLM-постобработка.** Локальные STT-модели больше не используются в production.
- Перед запуском бота проверять `.env` и наличие API-ключей (ElevenLabs, Groq, Gemini, OpenAI).


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
# Edit .env and fill in TELEGRAM_BOT_TOKEN, DATABASE_URL, and cloud STT keys
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

- Health: `curl http://localhost:3000/health` — includes `elevenlabsConfigured` so you can confirm the key is loaded.
- Provider status & billing: `curl http://localhost:3000/health/providers` — returns quota, remaining credits, amount due, and next billing date for ElevenLabs/OpenAI and key validity for Groq/Gemini/Lingva.
- Swagger: `http://localhost:3000/api-docs`
- Translate: `curl -X POST http://localhost:3000/api/translate -H "Content-Type: application/json" -d '{"text":"hello","targetLang":"ru"}'`
- Telegram bot: Send `/test` to run the built-in accuracy benchmark

## Architecture

```
Telegram Update → routes/webhook.ts → controllers/telegramController.ts
                                                ↓
                                    services/fileDownloadService.ts
                                    services/transcriptionService.ts
                                      → elevenlabsSttService.ts (primary)
                                      → openaiSttService.ts (fallback)
                                    services/cleanupService.ts (LLM post-processing)
                                    services/translationService.ts
                                                ↓
                                    src/db/repos/*  ←  PostgreSQL
```

### Telegram flow

1. On first contact (`/start` or any message) the bot detects the user's Telegram `language_code` and creates a profile with a matching interface language, default source language (same as interface language), and a sensible default target language.
2. The user can send media (voice, audio, video, document) or a YouTube link directly. The main menu only offers **Settings** and **Help**.
3. After media or a YouTube link arrives, the bot first asks for the **source language**. The user picks it, then sees a confirmation card with the selected source → target languages and a **Start** button.
4. YouTube links are validated before processing (title/duration/check availability). Invalid, private, age-restricted, or sign-in-required videos return a clear localized error.
5. Processing starts with a real-time loading bar and a **Stop** inline button. The loading message is deleted once the final document is sent.
6. The final transcription or translation document is sent with a **Back to menu** button attached. The chosen target language is saved as the user's default for future requests.
7. `/settings` opens a single **Settings** screen where users change interface language, default transcription language, and default translation language independently. Back navigation returns to Settings rather than the main menu.

## `/test` Accuracy Benchmark

The bot includes a self-test that works for all five supported languages:

1. `/test` shows an inline keyboard to choose the test language (`ky`, `tg`, `uz`, `en`, `ru`) or run all languages.
2. For the selected language the bot temporarily switches the user's transcription language, then restores it after the test.
3. Shows a visual loading bar: 30% → 60% → 100% with the correct test header.
4. Transcribes the audio with the configured STT engine.
5. Runs LLM cleanup on the recognized text.
6. Compares the cleaned text with a hand-curated reference transcript.
7. Computes character + word similarity (Levenshtein + Jaccard) and reports a percentage with color-coded emoji:
   - 🟢 ≥ 90%
   - 🟡 ≥ 70%
   - 🟠 ≥ 50%
   - 🔴 < 50%

Local audio fixtures live in `test_audio/` and are described by `test_audio/manifest.json` and `test_audio/hard_manifest.json`.

## Cloud STT Routing

The primary STT provider is **ElevenLabs Scribe v2**. Fallbacks are used only when ElevenLabs fails or is not configured.

| Provider | When used | Notes |
|----------|-----------|-------|
| **ElevenLabs Scribe v2** | Primary in `auto` when `ELEVENLABS_API_KEY` is set; always when `TILTAB_STT_PROVIDER=elevenlabs` | Best quality for `en/ru/tg/uz/ky`. No local models required. |
| **OpenAI Whisper API** | Fallback when ElevenLabs fails and `OPENAI_API_KEY` is set | Used when `TILTAB_STT_PROVIDER=openai`. |
| **Groq Whisper** | Fallback inside `openaiSttService` for English only | Controlled by `TILTAB_GROQ_WHISPER_LANGUAGES` (default `en`). |
| **Local hybrid (`transcribe_hybrid.py`)** | When `TILTAB_STT_PROVIDER=local` or no cloud keys are configured | Deprecated for production; kept for offline development. |

Language codes sent to ElevenLabs:
- `en` → `en`
- `ru` → `ru`
- `uz` → `uz`
- `ky` → `ky`
- `tg` → `tgk` (ISO 639-3)
- For provider-level auto-detection (e.g., Scribe), pass no language hint.

## LLM Post-processing

Every successful transcription is passed through `cleanupService.ts`:

1. Provider chain (unless `TILTAB_CLEANUP_PROVIDER` overrides):
   - **Gemini** (default)
   - **Groq**
   - **OpenAI**
2. Set `TILTAB_CLEANUP_PROVIDER=none` to skip cleanup entirely.
3. Provider-specific model can be set via `TILTAB_CLEANUP_MODEL`.

For Tajik, the prompt includes guardrails for:
- Cyrillic output and Arabic/Persian script normalization.
- Date ordinals (`1-ум`, `2-юм`, `3-юм`, `12-ум`, `13-ум`, `22-юм`, `23-юм`).
- Direct-object clitic `ро` attachment (`мо ро` → `моро`).
- Common Tajik names/places normalization.
- Preserving Russian/Uzbek/English code-switching.
- Noise markers (`[плач]`, `[кулол]`, `[аплодисменты]`, `[музыка]`, `[неразборчиво]`).
- No changes to verb tenses, names, or word order.

Other languages get a conservative punctuation/capitalization cleanup prompt.

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

1. **Lingva Translate** — free, open-source front-end for Google Translate. No API key required for public instances. Supports all Tiltap languages (`en/ru/tg/uz/ky`). Long texts are automatically split into chunks.
2. **OpenAI GPT-4o-mini** — high-quality LLM translation (requires `OPENAI_API_KEY`).
3. **Groq llama-3.3-70b** — LLM fallback (requires `GROQ_API_KEY`).
4. **Mock** — returns a placeholder translation if nothing else is available.

If Daniel's module URL is configured (`TRANSLATION_MODULE_URL`), all translation requests are proxied to it instead.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather |
| `ELEVENLABS_API_KEY` | yes (production) | Primary STT provider |
| `ELEVENLABS_MODEL_ID` | no | Defaults to `scribe_v2` |
| `OPENAI_API_KEY` | no | Fallback STT and translator |
| `GROQ_API_KEY` | no | Fallback STT (English only), translation, and LLM cleanup |
| `GEMINI_API_KEY` | no | Primary LLM cleanup provider |
| `TILTAB_STT_PROVIDER` | no | `elevenlabs` (default primary in auto), `openai`, `local`, `auto` |
| `TILTAB_GROQ_WHISPER_LANGUAGES` | no | Comma-separated list of languages allowed for Groq Whisper fallback (default `en`) |
| `TILTAB_CLEANUP_PROVIDER` | no | Override cleanup provider: `gemini`, `openai`, `groq`, or `none` |
| `TILTAB_CLEANUP_MODEL` | no | Override the default model for the chosen cleanup provider |
| `LINGVA_TRANSLATE_URL` | no | Free Lingva instance, default `https://lingva.ml` |
| `LINGVA_TRANSLATE_CHUNK_SIZE` | no | Max characters per Lingva chunk (default `2000`) |
| `TILTAB_TRANSLATION_PROVIDER` | no | `lingva`, `openai`, `groq`, `mock`, or `auto` |
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

## Deployment (Render.com free tier)

Free-tier containers do not have enough disk/memory for local Vosk/Whisper models, so production uses **cloud STT providers**.

### Required Render secrets

- `TELEGRAM_BOT_TOKEN`
- `DATABASE_URL`
- `ELEVENLABS_API_KEY` (primary STT)
- `GROQ_API_KEY` (fallback + LLM cleanup)
- `GEMINI_API_KEY` (primary LLM cleanup)

Optional:
- `OPENAI_API_KEY` (fallback STT/translation)
- `TILTAB_CLEANUP_PROVIDER` / `TILTAB_CLEANUP_MODEL`
- `LINGVA_TRANSLATE_URL` / `TILTAB_TRANSLATION_PROVIDER`
- `YOUTUBE_COOKIES_BASE64` or `YOUTUBE_COOKIES_PATH` — if YouTube returns "Sign in to confirm" from Render's datacenter IP
- `YOUTUBE_PO_TOKEN` / `YOUTUBE_VISITOR_DATA` — if YouTube still blocks with HTTP 403 or "Sign in" even with cookies
- `YOUTUBE_PROXY` — route YouTube requests through a residential/proxy IP if datacenter IP is heavily flagged
- `COBALT_API_URL` / `COBALT_API_URLS` — override or extend the list of public Cobalt instances used when yt-dlp is blocked
- `YOUTUBE_AUTO_UPDATE_YTDLP=true` — keep `yt-dlp` up to date on Render

### Deploy to Render

1. Push to `main`.
2. In Render dashboard, create a **Blueprint** from `render.yaml` or create a Docker web service from the GitHub repo.
3. Set required secrets in Render dashboard.
4. Set the Telegram webhook:
   ```bash
   curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url":"https://<render-service-name>.onrender.com/webhook/telegram"}'
   ```

### CI/CD

`.github/workflows/ci.yml` builds, tests, and deploys to Render on every push to `main`. Add the Render deploy hook URL as a GitHub secret named `RENDER_DEPLOY_HOOK_URL`.

## Notes

- The bot runs on Windows locally and in Docker on Render.
- Python is still required for YouTube download (`yt-dlp`) and validation scripts.
- Cyrillic output safety: `PYTHONIOENCODING=utf-8` + `sys.stdout.reconfigure(encoding="utf-8")`.
- Real-time progress for cloud STT is simulated from the Node service because the APIs do not stream per-word progress.
- Local STT models (`models/`, `transcribe_hybrid.py`, Vosk, CTranslate2 Whisper) are deprecated and will be removed from the Docker image in a future cleanup pass.
- **YouTube on Render:** if all videos return "Sign in to confirm" or HTTP 403, set `YOUTUBE_AUTO_UPDATE_YTDLP=true`, add fresh browser cookies via `YOUTUBE_COOKIES_BASE64`, and (if still blocked) provide a PO token via `YOUTUBE_PO_TOKEN`. The Docker startup script now updates `yt-dlp` automatically when this flag is enabled, and `download_youtube.py`/`validate_youtube.py` prefer mobile/TV player clients to reduce bot detection.
- **YouTube Cobalt fallback:** when yt-dlp fails with bot detection or sign-in requirements, `download_youtube.py` and `validate_youtube.py` automatically fall back to public Cobalt API instances (`COBALT_API_URL` or `COBALT_API_URLS`). The downloader rotates through the list until one succeeds. This is the current workaround for datacenter IPs (including Hetzner) where YouTube blocks direct yt-dlp downloads. For production load, deploy a private Cobalt instance and point `COBALT_API_URL` at it.
