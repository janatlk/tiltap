# TilTap — рабочий контекст (для агента)

> Собрано 2026-07-23 при первом клонировании репозитория в `C:\work\tiltap`.
> Это «карта проекта» для быстрого входа в дебаг. Первоисточник по STT/переводу — `AGENTS.md` в корне.

## 1. Что это за проект

Многоязычный STT + перевод для центральноазиатских языков (`ky`, `tg`, `uz`, `ru`, `en`).
Два клиента — Telegram-бот и веб-страница — ходят в один Node.js бэкенд, тяжёлый STT
может уезжать на GPU.

```
Telegram Bot ─┐
              ├─→ Backend (Node 22 / TS, Express 5) ─→ RunPod GPU worker (Whisper/CT2)
Web UI /web  ─┘         на Hetzner CX43              └─→ локальные модели (Python) на том же хосте
                              │
                              └─→ PostgreSQL (fallback — встроенный PGlite)
```

## 2. Инфраструктура (боевая)

| Что | Где | Детали |
|---|---|---|
| Бэкенд | Hetzner CX43, `95.216.169.56:3000` | hostname `tiltab-cx43-hel2`, hel2, Ubuntu 22.04, 8 vCPU / 16 GB / 160 GB |
| Путь на сервере | `/opt/tiltap` | git-репозиторий = этот же репозиторий |
| systemd | `tiltab-backend.service` | `node dist/server.js`, `EnvironmentFile=/opt/tiltap/.env`, `Restart=always` |
| systemd | `tiltab-telegram-poll.service` | `npx tsx scripts/telegram_poll_forwarder.ts` — polling вместо webhook, т.к. нет HTTPS/домена |
| Модели | `/opt/tiltap/models` | НЕ в git (`.gitignore`), заливаются вручную через scp |
| GPU | RunPod serverless | образ из `gpu-worker/`, T4; `TILTAB_GPU_STT_URL` = `.../runsync` |
| STT-микросервис | `stt-service/` (FastAPI, Docker, :8000) | исторический; сейчас бэкенд шлёт туда только `uz` |
| Старый сервер | `46.225.238.161` (CPX22) | из `docs/DEPLOYMENT_LOG.md`, судя по всему уже не боевой |

**Telegram:** webhook НЕ установлен. Работает форвардер `getUpdates` → `http://localhost:3000/webhook/telegram`.
Значит: если бот «молчит» — проверять `tiltab-telegram-poll.service`, а не webhook.

**Chat ID владельца:** см. `documents/Telegram.md` (локально, не в git).

## 3. Состояние на 2026-07-23 (проверено)

```
GET http://95.216.169.56:3000/health
{"status":"ok","database":"connected","sttProvider":"local",
 "remoteSttConfigured":true,"openaiConfigured":true,
 "groqConfigured":true,"elevenlabsConfigured":true}
```

`GET /health/providers`:
- `elevenlabs` — ok, но ключу не хватает права `user_read` (биллинг не читается).
- `openai` — ok (биллинг через API не читается — это норма, нужен session key).
- `groq` — ok, модели доступны.
- **`lingva` — error, HTTP 403 Cloudflare challenge.** Провайдер по умолчанию — `openai`, так что
  на боевой путь не влияет, но `TILTAB_TRANSLATION_PROVIDER=lingva`/`auto` сейчас сломан.

Доступность: `/web/` 200, `/api-docs/` 200, `/web/admin.html` 200, `/api/admin/*` → 401 (нужен `X-Admin-Token`).

## 4. Карта кода

```
src/
  server.ts, app.ts          # bootstrap, монтирование роутов, /health, /health/providers
  config/index.ts            # ЕДИНЫЙ источник env — zod-схема, при ошибке process.exit(1)
  routes/                    # webhook | translate | web | admin | betaTest
  controllers/
    telegramController.ts    # 1224 строки — весь UX бота (меню, языки, прогресс, Stop)
    webController.ts         # job-и веб-UI (in-memory + web_jobs в БД), SSE прогресс
    adminController.ts       # админка переводов
    betaTestController.ts    # страница сравнения моделей /web/admin-beta-test.html
    providersController.ts   # /health/providers
    translateController.ts   # POST /api/translate
  services/
    transcriptionService.ts  # ★ маршрутизация STT (см. §5)
    gpuSttService.ts         # RunPod: /run → polling /status/{id}; сжатие в MP3 при ≥6 MiB
    remoteSttService.ts      # HTTP в stt-service (:8000), очередь «по одному запросу»
    openaiSttService.ts / elevenlabsSttService.ts
    cleanupService.ts        # LLM-очистка транскрипта (единственный путь очистки)
    translationService.ts    # 1053 строки — провайдеры, кэш, QA-review, sanity-check
    telegramService.ts       # 1021 строка — Telegram Bot API + локализация
    youtubeService.ts / youtubeCaptionService.ts / cobaltConfigService.ts
    fileDownloadService.ts
  db/
    schema.sql               # миграции идемпотентные, гоняются на старте
    connection.ts            # PostgreSQL → при недоступности молча падает на PGlite
    repos/*
  utils/                     # logger, languageCodes, progressBar, textSimilarity, tempCleanup
Python (корень):
  transcribe_hybrid.py       # ★ локальный STT-роутер (GigaAM / Whisper CT2 / Vosk)
  text_postprocessing.py     # правиловая чистка (особенно таджикский)
  download_youtube.py, validate_youtube.py, youtube_cobalt.py, youtube_common.py
  vad_utils.py, benchmark.py
gpu-worker/handler.py        # RunPod serverless handler
stt-service/main.py          # FastAPI-микросервис локальных моделей
public/web/                  # index.html (юзер), admin.html (переводы), admin-beta-test.html
```

## 5. Маршрутизация STT — порядок решений

`src/services/transcriptionService.ts:transcribeAudio()`:

1. **GPU**, если `TILTAB_GPU_STT_URL` задан И язык ∈ `TILTAB_GPU_STT_LANGUAGES`
   (по умолчанию `ru,en,uz,tg,ky,auto,multi`). При ошибке → лог `warn` и падение на локальный hybrid.
2. **Remote STT-сервис**, если `TILTAB_STT_SERVICE_URL` задан И язык `uz`.
3. Дальше по `TILTAB_STT_PROVIDER`: `openai` / `elevenlabs` / `local` / `auto` (cloud-first).
   **На бою стоит `local`.**
4. Локально — `transcribe_hybrid.py`: `ky`/`uz`/`ru` → GigaAM Multilingual CTC (CPU),
   `tg` → whisper-tajik-finetuned-ct2, `en`/`auto`/`multi` → whisper-large-v3-turbo-ct2,
   последний рубеж — Vosk.

После STT: `collapseRepeatedWords()` в Node → `cleanupService.ts` (LLM, по умолчанию `gpt-4o-mini`).
Python-сторонняя LLM-очистка принудительно выключена (`TILTAB_CLEANUP_PROVIDER=none` в spawn-env),
чтобы не платить дважды.

Качество (hard benchmark, из `AGENTS.md`): `uz` 96.5% char, `tg` 94.3%, **`ky` 74.6% char / 32.1% word — главный провал.**

## 6. HTTP API

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/health` | статус + флаги конфигурации |
| GET | `/health/providers` | живость и биллинг провайдеров |
| GET | `/api-docs` | Swagger из `swagger.yaml` |
| POST | `/webhook/telegram` | апдейты Telegram (через форвардер) |
| POST | `/webhook/whatsapp` | заглушка |
| POST | `/api/translate` | `{text,targetLang}` → `{translatedText,detectedLang,requestId}` |
| POST | `/api/web/transcribe` | multipart-загрузка → `{jobId}` |
| POST | `/api/web/youtube` | ссылка → `{jobId}` |
| POST | `/api/web/translate` | перевод текста |
| GET | `/api/web/jobs/:jobId` | статус job-а |
| GET | `/api/web/jobs/:jobId/progress` | SSE-прогресс |
| GET | `/api/admin/translations/{pending,confirmed,rejected,errors}` | вкладки админки |
| GET | `/api/admin/translations/search/:number` | поиск по номеру запроса |
| POST/DELETE | `/api/admin/translations/:hash/:lang[/confirm\|/reject]` | модерация |
| GET | `/api/admin/web-jobs`, `/web-jobs/search/:number` | **аудит STT-задач — главное для дебага** |
| GET | `/api/admin/processes` | живые процессы транскрипции |
| GET/POST | `/api/admin/cobalt`, `/cobalt/test` | управление Cobalt-инстансами |
| GET/POST/DELETE | `/api/admin/beta/{models,transcribe,link,jobs/:id,compare}` | бета-страница сравнения моделей |

Все `/api/admin/*` требуют заголовок `X-Admin-Token` (значение = `TILTAB_ADMIN_TOKEN`).

## 7. База данных

PostgreSQL; **если `DATABASE_URL` недоступен — молча используется встроенный PGlite** в
`PGLITE_DATA_DIR` (`./.pglite-data`). Это уже приводило к потере данных 2026-07-05
(битый `postmaster.pid`, восстановление из `.pglite-data.bak.current`). Сейчас `/health`
говорит `database: connected`, но он не различает postgres и pglite — проверять по логам
(`Connected to PostgreSQL` vs `Using embedded PGlite`).

Таблицы: `users`, `messages`, `transcriptions`, `translations`, `translation_cache`,
`translation_requests` (аудит переводов), `transcription_requests` (аудит STT из Telegram),
`web_jobs` (аудит STT из веба), `cleanup_cache`, `pending_actions`.

Единая последовательность `translation_request_number_seq` (со `START 1000`) выдаёт публичные
`request_number` во все три аудит-таблицы — по этому номеру пользователь сообщает об ошибке,
а админ ищет её в панели.

Схема применяется на старте (`src/db/migrate.ts`), все ALTER-ы идемпотентные.

## 8. Логика перевода

- Провайдер по умолчанию `openai` (`gpt-4o-mini`), фолбэк Groq `llama-3.3-70b-versatile`.
- Кэш в `translation_cache`, но **пользователю отдаётся только `confirmed`** — до подтверждения
  админом каждый раз новый перевод.
- QA-review (`TILTAB_REVIEW_ENABLED`, по умолчанию on) — ищет остатки исходного языка,
  выдуманные имена. Пропускается при длине > `TILTAB_REVIEW_MAX_INPUT_CHARS` (3000).
- Sanity-check отбрасывает вырожденный вывод (одно слово > 35% текста) — тогда сервис бросает
  ошибку, и вызывающий отдаёт исходный транскрипт.
- Если задан `TRANSLATION_MODULE_URL` — всё проксируется в модуль Даниэла.

## 9. YouTube / соцсети

- YouTube: `yt-dlp` → фолбэк на публичные Cobalt-инстансы.
- TikTok / Instagram Reels: только через Cobalt.
- IP Hetzner блокируется YouTube («Sign in to confirm»). Лечится `YOUTUBE_COOKIES_BASE64`,
  `YOUTUBE_PO_TOKEN` + `YOUTUBE_VISITOR_DATA`, `YOUTUBE_PROXY`, `YOUTUBE_AUTO_UPDATE_YTDLP=true`.
  Подробности — `docs/YOUTUBE_COOKIES.md`.
- Cloudflare WARP на сервере ставить нельзя — ломает SSH (проверено).

## 10. Деплой

```bash
ssh root@95.216.169.56
cd /opt/tiltap
git fetch origin && git reset --hard origin/main
npm ci && npm run build
systemctl restart tiltab-backend.service
systemctl status tiltab-backend.service --no-pager
```

`npm run build` = `tsc` + `scripts/copy-schema.js` + `scripts/write-build-info.js`
(последний пишет `public/web/build-info.json`, время сборки видно на бета-странице).

`deploy_ssh.py` запускает команды на сервере, но требует приватный ключ
`.keys/tiltab_deploy` — он в `.gitignore` и **в клоне отсутствует**.

CI (`.github/workflows/ci.yml`) деплоит на **Render**, не на Hetzner — это рудимент,
`render.yaml` и README про Render устарели относительно боевой схемы.

## 11. Файлы, которых нет в git (нужны отдельно)

| Что | Зачем |
|---|---|
| `.env` | все секреты; шаблон — `.env.example` |
| `models/` | локальные STT-модели, ~3–5 GB |
| `.keys/tiltab_deploy` | SSH-ключ для `deploy_ssh.py` |
| `stt-service/.keys/` | ключ деплоя STT-сервиса |
| `documents/` | в `.gitignore`, но при этом закоммичен — контракт, ТЗ, отчёты |
| `DEPLOY.md` | карта инфраструктуры с боевыми данными, только локально |

## 12. Прочая документация в репозитории

- `AGENTS.md` — **самый важный файл**: STT-роутинг, чанкинг, все env, известные провалы.
- `docs/HETZNER_DEPLOY_INSTRUCTIONS.md` — развёртывание с нуля.
- `docs/DEPLOYMENT_LOG.md` — история деплоя STT-сервиса, OOM-фиксы (частично про старый сервер).
- `docs/Session_Log_2026-07-05.md` — воркфлоу подтверждения переводов, восстановление PGlite.
- `docs/STT_Quality_Mitigation_Strategy.md`, `docs/OpenWeight_LLMs_for_Central_Asian_Languages.md`,
  `docs/OpenWeight_LLM_for_STT_Cleanup_A4500.md` — исследования по качеству.
- `docs/Translation_Providers_Cost_Report.md`, `docs/Monthly_Project_Cost_Estimate.md`,
  `docs/Cheap_Hosting_Options.md` — экономика.
- `docs/YOUTUBE_COOKIES.md` — обход блокировок YouTube.
- `.analysis/ТЗ_Жанат_Жанузаков.txt` — исходное ТЗ (Sprint 1, дедлайн 12.06.2026).

## 13. Требует внимания (найдено при разведке)

1. **`docs/Session_Log_2026-07-05.md:212` содержит SSH-пароль пользователя `tiltab` открытым
   текстом в публичном репозитории.** Пароль нужно сменить, строку — убрать (и учесть, что она
   останется в истории git).
2. Тот же файл рекомендует ротацию `OPENAI_API_KEY` / `GROQ_API_KEY` / `GEMINI_API_KEY` —
   неизвестно, сделана ли.
3. `lingva` возвращает 403 (Cloudflare) — режимы `auto`/`lingva` для перевода нерабочие.
4. У ключа ElevenLabs нет права `user_read` — биллинг не мониторится.
5. Тихий фолбэк PostgreSQL → PGlite маскирует потерю боевой БД.
6. README и `render.yaml` описывают деплой на Render и «production uses OpenAI Whisper API» —
   это противоречит текущей схеме (Hetzner + локальные модели).
