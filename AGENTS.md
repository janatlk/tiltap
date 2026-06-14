# TilTap Backend — Agent Notes

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
# Edit .env and fill in TELEGRAM_BOT_TOKEN and DATABASE_URL
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

- Health: `curl http://localhost:3000/health`
- Swagger: `http://localhost:3000/api-docs`
- Translate: `curl -X POST http://localhost:3000/api/translate -H "Content-Type: application/json" -d '{"text":"hello","targetLang":"ru"}'`
- Telegram bot: Send `/test` to run the built-in Kyrgyz accuracy benchmark

## Architecture

```
Telegram Update → routes/webhook.ts → controllers/telegramController.ts
                                                ↓
                                    services/fileDownloadService.ts
                                    services/transcriptionService.ts
                                    services/translationService.ts
                                                ↓
                                    src/db/repos/*  ←  PostgreSQL
```

### Telegram flow

1. User sends media or a YouTube link.
2. Bot asks for the source (transcription) language. A **🌍 Auto / Multilingual** option is available for Turkic + Russian code-switching.
3. After the user picks it, the same message is edited to ask for the target translation language (including a **No translation** option).
4. Processing starts; a **Stop** inline button is attached to the status message and removed once processing completes.
5. The loading bar is updated in real time as the Python worker emits progress JSON.

## `/test` Accuracy Benchmark

The bot includes a self-test that works for all five supported languages:

1. `/test` shows an inline keyboard to choose the test language (`ky`, `tg`, `uz`, `en`, `ru`) or run all languages.
2. For the selected language the bot temporarily switches the user's transcription language, then restores it after the test.
3. Shows a visual loading bar: 30% → 60% → 100% with the correct test header.
4. Transcribes the audio with the configured STT engine.
5. Compares the recognized text with a hand-curated reference transcript.
6. Computes character + word similarity (Levenshtein + Jaccard) and reports a percentage with color-coded emoji:
   - 🟢 ≥ 90%
   - 🟡 ≥ 70%
   - 🟠 ≥ 50%
   - 🔴 < 50%

Local audio fixtures live in `test_audio/` and are described by `test_audio/manifest.json`. To rebuild them run:

```bash
python scripts/prepare_test_audio.py
```

This downloads phrasebook clips from Folkways Today for `ky/tg/uz/ru` and builds an English fixture from the English prompts of the Russian phrasebook.

## State Persistence

- `users` — Telegram chat IDs and preferred languages
- `messages` — Every incoming Telegram message for audit
- `transcriptions` — STT results with segments
- `translations` — Cached translations to avoid re-calling the module

Temporary in-memory state that is intentionally not persisted:

- `pendingAudio` Map — ephemeral audio buffers while the user is choosing a language

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather |
| `OPENAI_API_KEY` | no | Fallback translator |
| `TRANSLATION_MODULE_URL` | no | Daniel's translation module endpoint |
| `TELEGRAM_WEBHOOK_SECRET` | no | Future webhook validation |

## Multilingual / code-switching STT

The `🌍 Auto / Multilingual` mode runs Whisper twice:

1. Auto-detect the primary language.
2. Force Russian recognition to catch Russian loanwords.
3. Merge segment lists by keeping the higher-confidence segment in overlapping regions.

This is especially useful for Turkic languages (Kyrgyz, Uzbek, Tajik) that frequently mix in Russian words.

## Notes

- The demo bot works on Windows using local Python scripts (`transcribe_hybrid.py`, etc.).
- Python environment must have `vosk`, `faster-whisper`, `yt-dlp`, and `ffmpeg-static` is provided by npm.
- Cyrillic output safety: `PYTHONIOENCODING=utf-8` + `sys.stdout.reconfigure(encoding="utf-8")`.

- Real-time progress is emitted as JSON lines (`{"type":"progress","percent":..,"label":".."}`) from `transcribe_hybrid.py` and `download_youtube.py`; the Node controller streams stdout and updates the Telegram loading bar.
