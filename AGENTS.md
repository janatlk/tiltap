# TilTap Backend — Agent Notes

## Контекст проекта

См. заметку в Obsidian: `[[Projects/Tiltap]]` (`C:\Users\janat\Documents\Obsidian\KimiContext\Projects\Tiltap.md`).

Важные договорённости:
- Текущий фокус: довести транскрипцию ky/tg/uz до максимального качества.
- Озвучку и перевод пока НЕ трогаем.
- Подход: локальные модели + инженерия.
- Перед запуском бота проверять `.env` и наличие моделей.


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

- Health: `curl http://localhost:3000/health` — includes `elevenlabsConfigured` so you can confirm the key is loaded.
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

1. On first contact (`/start` or any message) the bot detects the user's Telegram `language_code` and creates a profile with a matching interface language, default source language (`auto`), and a sensible default target language.
2. The user can send media (voice, audio, video, document) or a YouTube link directly, or use the main menu.
3. The bot shows a confirmation card with the currently selected source → target languages and an **▶️ Start** button. Users can tap **🌐 Change language** to pick a different source/target for this request only, or **⚙️ Settings** to update their defaults.
4. YouTube links are validated before processing (title/duration/check availability). Invalid, private, age-restricted, or sign-in-required videos return a clear localized error.
5. Processing starts with a real-time loading bar and a **Stop** inline button. The button is removed once processing completes.
6. After transcription, a translate keyboard lets users translate the result into any supported language. The chosen target language is saved as the user's default for future requests.
7. `/settings` opens a single **⚙️ Settings** screen where users change interface language, default transcription language, and default translation language independently. The inline main menu uses the same grouped Settings entry, and Back navigation returns to Settings rather than the main menu.

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

## Hard Benchmark (priority languages)

A separate long-form benchmark uses real YouTube clips for the three priority languages and is driven by `test_audio/hard_manifest.json`:

| Language | Fixture | Primary model | Latest char similarity | Latest word accuracy |
|----------|---------|---------------|------------------------|----------------------|
| `ky` | `test_audio/youtube/ky_yt_1min.wav` (1 min podcast) | Vosk `vosk-model-ky-0.42` | 100.0% | 100.0% |
| `tg` | `test_audio/youtube/tg_yt.wav` (60 s interview) | Fine-tuned Whisper `models/whisper-tajik-finetuned-ct2` | 93.8% | 92.7% |
| `uz` | `test_audio/youtube/uz_yt.wav` (67 s video) | Fine-tuned Whisper Rubai `islomov/rubaistt_v2_medium` (CTranslate2 int8) | 91.5% | 91.5% |

Run the hard benchmark with:

```bash
python benchmark.py test_audio/hard_manifest.json
```

The report is written to `logs/benchmark_report.json`.

The Telegram `/test` command now also uses the hard YouTube fixtures for the priority languages (`ky`, `tg`, `uz`) instead of the synthetic phrasebook clips, because Vosk-based engines struggle with the phrasebook's short repeated phrases. The hard fixtures are keyed by language code in `test_audio/hard_manifest.json` and are played from the cached local WAV files, so `/test` works even when YouTube downloads are blocked.

### Model routing in `transcribe_hybrid.py`

- `ky` → Vosk large (fallback Vosk small). Whisper `distil-large-v3` does **not** support `ky`, so Kyrgyz never falls back to it.
- `tg` → **ElevenLabs Scribe v2** when `ELEVENLABS_API_KEY` is set (no `language_code`, letting the model auto-detect). Audio is first segmented with local Silero VAD so only speech regions are sent to the API; timestamps are preserved. Fallback chain: fine-tuned Whisper Tajik → `distil-large-v3` → Vosk.
- `uz` → Fine-tuned Whisper Rubai `islomov/rubaistt_v2_medium` converted to CTranslate2 int8 (saved in `models/rubai-ct2-int8`). Vosk `vosk-model-small-uz-0.22` is used as a fast fallback for files longer than 3 minutes or when the Rubai model is missing.
- `ru` → Vosk if present, else Whisper.
- `en` → Whisper.
- `auto` / `multi` → Whisper dual-pass.

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

- `pendingActions` Map — ephemeral audio buffers / YouTube URLs while the user confirms language selection (auto-expires after 10 minutes)
- `activeProcesses` Map — currently running Python PIDs keyed by chat ID

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather |
| `OPENAI_API_KEY` | no | Fallback translator |
| `TRANSLATION_MODULE_URL` | no | Daniel's translation module endpoint |
| `TELEGRAM_WEBHOOK_SECRET` | no | Future webhook validation |
| `ELEVENLABS_API_KEY` | no | Enables ElevenLabs Scribe v2 for Tajik (`tg`) transcription |
| `ELEVENLABS_MODEL_ID` | no | Defaults to `scribe_v2` |
| `GEMINI_API_KEY` | no | Primary LLM cleanup provider for Tajik script normalization |
| `GROQ_API_KEY` | no | Fallback LLM cleanup provider |
| `TILTAB_CLEANUP_PROVIDER` | no | Override provider: `gemini`, `openai`, `groq`, or `none` |
| `TILTAB_CLEANUP_MODEL` | no | Override the default model for the chosen provider |
| `TILTAB_ENTITIES_PATH` | no | Path to a custom `tajik_entities.json` dictionary |

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

- ElevenLabs Scribe v2 produces very clean Tajik speech recognition, but it can hallucinate on long non-speech sections (intro/outro music, title cards). For full YouTube downloads this may produce trailing garbage segments.

- **VAD pre-segmentation** (`vad_utils.py`) now runs locally before ElevenLabs Scribe. It uses Silero VAD via `torch.hub` to detect speech regions, merges short gaps (≤ 0.3 s), splits chunks at 30 s, and transcribes only the speech chunks. Returned segment timestamps are offset back to the original audio timeline, so subtitle placement is not affected. This eliminated the trailing hallucinations on the Konibodom test video.

- **STT post-processing layer** (`text_postprocessing.py`) runs after the Tajik STT step and does not touch the STT model, ffmpeg, or VAD:
  - `score_segment()` — scores a segment by Latin/English ratio, repetition, entropy, and dictionary presence.
  - `is_garbage()` — marks obvious noise (Latin spam, repetitive nonsense, patterns like `Straßen...`, `Н?р...`).
  - `LLMTextCleaner` — normalizes Persian/Arabic-script output to Tajik Cyrillic and fixes STT errors. Provider priority: **Gemini → OpenAI → Groq**, with automatic fallback if the primary fails. Retries with backoff on 429/503. Set `TILTAB_CLEANUP_PROVIDER=gemini|openai|groq|none` and `TILTAB_CLEANUP_MODEL` to override the default model. `TILTAB_CLEANUP_PROVIDER=none` disables the LLM step for a fast/cheap mode.
  - The cleaner is invoked conditionally: only when a segment contains Arabic script, has significant Latin leakage, or scores below the quality threshold. This saves cost and prevents strong models from over-editing already clean Cyrillic text.
  - Prompt guardrails forbid changing verb tenses, names, or word order; the cleaner must only convert script and fix obvious STT noise.
  - Rule-based Arabic/Persian transliterator — converts isolated Arabic-script loanwords to Tajik Cyrillic before any LLM call (`عқл` → `ақл`).
  - `NamedEntityFixer` — fuzzy-matches names/places against a dictionary (`DEFAULT_ENTITIES` or `data/tajik_entities.json`). Dictionary entries map a canonical form to known STT variants, so variants are normalized to the canonical spelling. Multi-word variants (e.g. `Радио Озоди` → `Радиои Озоди`) are replaced first. A stoplist protects common function words and verb forms from being replaced. The default fuzzy threshold is 0.80 to avoid false positives.
  - Mixed-script typo fixer — replaces Latin look-alike chars inside Cyrillic words (`муfассал` → `муфассал`).

- Real-time progress is emitted as JSON lines (`{"type":"progress","percent":..,"label":".."}`) from `transcribe_hybrid.py` and `download_youtube.py`; the Node controller streams stdout and updates the Telegram loading bar.
