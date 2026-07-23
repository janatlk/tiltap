# TilTap — плейбук дебага

> Составлено 2026-07-23. Практические процедуры: где искать ошибки, чем их вытаскивать.

## 1. Где вообще живут ошибки

Три независимых источника — нужны все три, они не дублируют друг друга.

| Источник | Что там | Как достать | Нужен доступ |
|---|---|---|---|
| **journald на Hetzner** | всё: стектрейсы, `warn` о фолбэках GPU→CPU, ошибки Python-STT, HTTP-логи | `journalctl -u tiltab-backend.service` | SSH |
| **Таблица `web_jobs`** | ошибки STT из **веб-интерфейса** (`error_message`, `status`) | `GET /api/admin/web-jobs` | `X-Admin-Token` |
| **Таблица `translation_requests`** | ошибки **перевода** (все клиенты) | `GET /api/admin/translations/errors` | `X-Admin-Token` |
| **Таблица `transcription_requests`** | ошибки STT из **Telegram** | ⚠️ **API-эндпоинта нет** — только SQL или journald | SSH / доступ к БД |

Логгер (`src/utils/logger.ts`) настроен **только на Console-транспорт**, файлов логов нет.
В проде формат JSON, `LOG_LEVEL` по умолчанию `info`. Значит вся история — в journald,
и она ограничена ретенцией journald (проверить: `journalctl --disk-usage`, `/etc/systemd/journald.conf`).

## 2. Команды: логи за 7 дней по SSH

```bash
ssh root@95.216.169.56

# всё за 7 дней
journalctl -u tiltab-backend.service --since "7 days ago" --no-pager

# только ошибки и предупреждения (лог в JSON, поэтому грепаем по полю level)
journalctl -u tiltab-backend.service --since "7 days ago" --no-pager \
  | grep -E '"level":"(error|warn)"'

# топ повторяющихся сообщений
journalctl -u tiltab-backend.service --since "7 days ago" --no-pager -o cat \
  | grep -oP '"message":"[^"]+"' | sort | uniq -c | sort -rn | head -40

# падения/перезапуски сервиса
journalctl -u tiltab-backend.service --since "7 days ago" --no-pager \
  | grep -Ei 'Started|Stopped|Failed|Main process exited|out of memory'

# форвардер Telegram (если бот «молчит» — смотреть сюда)
journalctl -u tiltab-telegram-poll.service --since "7 days ago" --no-pager | tail -200

# OOM-killer (модели тяжёлые, 16 GB не бесконечны)
journalctl -k --since "7 days ago" --no-pager | grep -i 'killed process\|oom'
```

Выгрузить к себе одним файлом:

```bash
ssh root@95.216.169.56 'journalctl -u tiltab-backend.service --since "7 days ago" --no-pager -o cat' > logs_7d.jsonl
```

## 3. Команды: ошибки пользователей через админ-API

Токен = `TILTAB_ADMIN_TOKEN` из `/opt/tiltap/.env`. Передаётся **только** заголовком
`X-Admin-Token` (в query-строке не принимается — сделано намеренно).

```bash
TOKEN='<TILTAB_ADMIN_TOKEN>'
BASE='http://95.216.169.56:3000'

# ошибки перевода (limit по умолчанию 100, максимум 500)
curl -s -H "X-Admin-Token: $TOKEN" "$BASE/api/admin/translations/errors?limit=500"

# все веб-задачи STT — фильтровать по status/error_message на своей стороне
curl -s -H "X-Admin-Token: $TOKEN" "$BASE/api/admin/web-jobs?limit=500"

# что крутится прямо сейчас (живые PID-ы, веб-джобы, очередь remote STT)
curl -s -H "X-Admin-Token: $TOKEN" "$BASE/api/admin/processes"

# разбор конкретной жалобы по номеру, который пользователь назвал
curl -s -H "X-Admin-Token: $TOKEN" "$BASE/api/admin/translations/search/1234"
curl -s -H "X-Admin-Token: $TOKEN" "$BASE/api/admin/web-jobs/search/1234"
```

Готовый сборщик: `scripts/collect_errors.py` (см. §5).

## 4. Команды: ошибки Telegram-пользователей напрямую из БД

Эндпоинта нет, поэтому только SQL. На сервере узнать, какая БД реально используется:

```bash
grep DATABASE_URL /opt/tiltap/.env
journalctl -u tiltab-backend.service --no-pager | grep -E 'Connected to PostgreSQL|Using embedded PGlite' | tail -5
```

Если PostgreSQL:

```sql
SELECT request_number, created_at, source_type, language, provider, model,
       status, left(error_message, 300) AS err
FROM transcription_requests
WHERE created_at > NOW() - INTERVAL '7 days'
  AND (status = 'error' OR error_message IS NOT NULL)
ORDER BY created_at DESC;

-- сводка: что чаще всего ломается
SELECT language, source_type, count(*) AS n, left(error_message, 120) AS err
FROM transcription_requests
WHERE created_at > NOW() - INTERVAL '7 days' AND error_message IS NOT NULL
GROUP BY 1,2,4 ORDER BY n DESC;

-- то же по вебу и по переводам
SELECT * FROM web_jobs
 WHERE created_at > NOW() - INTERVAL '7 days' AND error_message IS NOT NULL
 ORDER BY created_at DESC;

SELECT * FROM translation_requests
 WHERE created_at > NOW() - INTERVAL '7 days' AND error_message IS NOT NULL
 ORDER BY created_at DESC;
```

⚠️ Если бэкенд свалился на **PGlite**, эти данные лежат в файловой БД
`/opt/tiltap/.pglite-data*` и psql-ом не читаются — только через Node/PGlite.

## 5. Готовый скрипт сбора

`scripts/collect_errors.py` — тянет ошибки через админ-API, фильтрует по окну в днях,
печатает сводку и сохраняет сырой JSON.

```bash
# Linux/macOS
TILTAB_ADMIN_TOKEN=xxx python scripts/collect_errors.py --days 7

# Windows PowerShell
$env:TILTAB_ADMIN_TOKEN='xxx'; python scripts/collect_errors.py --days 7
```

## 6. Известные классы ошибок (чего ожидать в логах)

Из кода и прошлых сессий — чтобы узнавать их в потоке:

| Сообщение / симптом | Где | Что значит |
|---|---|---|
| `GPU STT failed, falling back to local hybrid` | `transcriptionService.ts:43` | RunPod не ответил → CPU. Медленно, но пользователь получит результат |
| `GPU STT job ... timed out after 600s` | `gpuSttService.ts:135` | холодный старт + очередь RunPod, либо воркер завис |
| `GPU STT service returned 4xx/5xx` | `gpuSttService.ts:80` | эндпоинт/ключ RunPod неверный или лимит |
| `GPU audio compression failed` / `tiny output` | `gpuSttService.ts:276,282` | ffmpeg не разобрал контейнер (MP4/M4A из пайпа — старая бага, чинилась через temp-файлы) |
| `Transcription failed (code N)` | `transcriptionService.ts:275` | упал `transcribe_hybrid.py` — stderr в том же логе |
| `Failed to parse transcription output` | `transcriptionService.ts:285` | Python не отдал финальный JSON |
| `Sign in to confirm` / HTTP 403 | YouTube-скрипты | IP Hetzner забанен YouTube → нужны cookies/PO-token/Cobalt |
| `relay.all_instances_failed` / `not_available` | Cobalt | все публичные Cobalt-инстансы легли |
| `PostgreSQL unreachable, falling back to embedded PGlite` | `db/connection.ts:29` | **критично** — боевая БД потеряна, пишем в локальный файл |
| HTTP 403 Cloudflare от `lingva.ml` | `/health/providers` | подтверждено 2026-07-23; ломает `TILTAB_TRANSLATION_PROVIDER=lingva\|auto` |
| перевод-заглушка / обрезанный перевод | `translationService.ts` | сработал sanity-check (одно слово >35%) или упёрлись в `max_tokens` |
| бот не отвечает вообще | — | смотреть `tiltab-telegram-poll.service`, а НЕ webhook (webhook не используется) |

## 6b. Cobalt: мониторинг и алерты (добавлено 2026-07-23)

После удаления yt-dlp Cobalt — единственный загрузчик. Фоновый монитор
(`src/services/cobaltHealthService.ts`) раз в `COBALT_HEALTHCHECK_INTERVAL_MINUTES`
(деф. 30) пингует эффективный список инстансов тестовой ссылкой. Когда **все**
падают — шлёт Telegram-алерт на `TILTAB_ADMIN_CHAT_ID` (не чаще раза в
`COBALT_ALERT_THROTTLE_HOURS`, деф. 6), при восстановлении — «снова работает».

**Приоритет источника инстансов** (одинаков для Python-загрузчика и Node-монитора):
1. Админ-панель — `data/cobalt-config.json` (Beta-test → Cobalt manager). **Не в git.**
2. `.env` → `COBALT_API_URLS` (через запятую) или `COBALT_API_URL`.
3. Встроенный дефолт (`DEFAULT_COBALT_APIS` в `youtube_cobalt.py`).

Если пришёл алерт «все инстансы недоступны» — добавить рабочий инстанс со списка
https://instances.cobalt.best через админ-панель (приоритетнее .env, применяется
без пересборки) и проверить кнопкой Test.

## 7. Быстрая проверка живости (без доступов)

```bash
curl -s http://95.216.169.56:3000/health
curl -s http://95.216.169.56:3000/health/providers
```

`/health` вернёт 503 при недоступной БД. Но он **не различает** PostgreSQL и PGlite —
`"database":"connected"` бывает и на аварийном PGlite.

## 8. Локальная среда разработки — текущее состояние

Проверено 2026-07-23 на этой машине:

| Компонент | Статус |
|---|---|
| git 2.55 | ✅ |
| Python 3.12.10 | ✅ (но зависимости проекта не установлены) |
| **Node.js / npm** | ❌ **не установлены** — `npm run build`, `npm test`, `tsx` недоступны |
| Docker | ❌ не установлен |
| `.env` | ❌ отсутствует |
| `models/` | ❌ отсутствуют (~3–5 GB) |
| SSH-ключи (`.keys/`, `~/.ssh`) | ❌ отсутствуют |

Чтобы локально собирать/типизировать код, нужен **Node.js 22+**. Без него правки в TypeScript
нельзя проверить даже компиляцией — только читать код глазами.

Минимальный локальный запуск без моделей и без БД: `.env` с `DATABASE_URL` (упадёт на PGlite),
`TILTAB_STT_PROVIDER=openai` + `OPENAI_API_KEY` — тогда STT уйдёт в облако и Python-модели не нужны.
