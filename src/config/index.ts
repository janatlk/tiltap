import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const isTest = process.env.NODE_ENV === "test";

const envSchema = z.object({
  PORT: z.string().default("3000").transform(Number),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  TELEGRAM_BOT_TOKEN: z.string().optional().or(z.literal("")),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  OPENAI_API_KEY: z.string().optional().or(z.literal("")),
  OPENAI_STT_MODEL: z.string().optional().or(z.literal("")).default("whisper-1"),
  TRANSLATION_MODULE_URL: z.string().url().optional().or(z.literal("")),
  LINGVA_TRANSLATE_URL: z.string().url().optional().or(z.literal("")).default("https://lingva.ml"),
  LINGVA_TRANSLATE_CHUNK_SIZE: z.string().default("2000").transform(Number),
  TILTAB_TRANSLATION_PROVIDER: z.enum(["lingva", "openai", "azure", "yandex", "mock", "auto"]).default("openai"),
  GROQ_API_KEY: z.string().optional().or(z.literal("")),
  GEMINI_API_KEY: z.string().optional().or(z.literal("")),


  ELEVENLABS_API_KEY: z.string().optional().or(z.literal("")),
  ELEVENLABS_MODEL_ID: z.string().optional().or(z.literal("")).default("scribe_v2"),
  TILTAB_STT_PROVIDER: z.enum(["openai", "local", "auto", "elevenlabs"]).default("local"),
  TILTAB_STT_SERVICE_URL: z.string().url().optional().or(z.literal("")),
  TILTAB_GPU_STT_URL: z.string().url().optional().or(z.literal("")),
  TILTAB_GPU_STT_API_KEY: z.string().optional().or(z.literal("")),
  TILTAB_GPU_STT_TIMEOUT_MS: z.string().default("600000").transform(Number),
  // Idle timeout for media download: abort only if no progress/output is seen
  // for this long (not an absolute cap), so long videos keep downloading.
  TILTAB_MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS: z.string().default("180000").transform(Number),
  // Persistent GigaAM worker (gigaam_server.py) that keeps the model resident so
  // it is not reloaded on every request. When set, GigaAM languages are sent
  // here; on any failure the backend falls back to spawning transcribe_hybrid.py.
  TILTAB_GIGAAM_SERVER_URL: z.string().url().optional().or(z.literal("")),
  TILTAB_GIGAAM_SERVER_TIMEOUT_MS: z.string().default("600000").transform(Number),
  TILTAB_GIGAAM_SERVER_LANGUAGES: z
    .string()
    .optional()
    .or(z.literal(""))
    .default("ky,uz,ru")
    .transform((val) =>
      val
        ?.split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean) ?? ["ky", "uz", "ru"]
    ),
  TILTAB_GPU_STT_LANGUAGES: z
    .string()
    .optional()
    .or(z.literal(""))
    .default("ru,en,uz,tg,ky,auto,multi")
    .transform((val) =>
      val
        ?.split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean) ?? ["ru", "en", "uz", "auto", "multi"]
    ),
  // Comma-separated list of language codes for which Groq Whisper may be used as a fallback.
  // Default is "en" because Groq Whisper quality drops significantly for non-English languages.
  TILTAB_GROQ_WHISPER_LANGUAGES: z
    .string()
    .optional()
    .or(z.literal(""))
    .default("en")
    .transform((val) =>
      val
        ?.split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean) ?? ["en"]
    ),
  TILTAB_CLEANUP_PROVIDER: z.enum(["openai", "groq", "gemini", "none"]).default("openai"),
  TILTAB_CLEANUP_MODEL: z.string().optional().or(z.literal("")),
  // Enable LLM cleanup for non-Tajik languages. Tajik cleanup is always enabled unless provider is "none".
  TILTAB_CLEANUP_NON_TAJIK: z
    .string()
    .optional()
    .or(z.literal(""))
    .default("1")
    .transform((v) => !v || ["1", "true", "yes", "on"].includes(v.toLowerCase())),
  // Cleanup output is about the same size as its input, so this has to scale
  // with the transcript rather than sit at a small fixed ceiling.
  TILTAB_CLEANUP_MAX_TOKENS: z.string().default("8192").transform(Number),
  // Bilingual glossary injected into the translation prompt. On by default:
  // with an empty table it costs one indexed query and changes nothing.
  TILTAB_GLOSSARY_ENABLED: z
    .string()
    .optional()
    .or(z.literal(""))
    .default("true")
    .transform((v) => !v || ["1", "true", "yes", "on"].includes(v.toLowerCase())),
  // Ceiling on terms injected into one prompt. Only terms found in the text
  // are sent, so a large glossary does not by itself produce a large prompt —
  // but a glossary of common words on a long transcript could, and a prompt
  // whose instructions outweigh the text is where models start applying
  // renderings where they do not belong. Longest terms win: they are the
  // specific, hard-to-guess ones.
  TILTAB_GLOSSARY_MAX_TERMS: z.string().default("120").transform(Number),
  // Доля слов вне словаря, выше которой расшифровка считается мусорной.
  // 0.15 выбрано по реальным расшифровкам с прода: испорченная запись дала
  // 0.22, худшая из нормальных — 0.11.
  TILTAB_NOISY_TRANSCRIPT_OOV: z.string().default("0.15").transform(Number),
  // Дополнительные модели для стенда сравнения. Нужны, чтобы примерить
  // кандидата на реальных текстах, ничего не меняя в бою.
  TILTAB_TRANSLATION_BENCH_MODELS: z
    .string()
    .optional()
    .or(z.literal(""))
    .default("gpt-5.6-luna,gpt-5.6-terra")
    .transform((val) =>
      val
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? []
    ),
  TILTAB_TRANSLATION_MODEL: z.string().optional().or(z.literal("")).default("gpt-5.6-luna"),
  // Раньше здесь стоял gpt-4o, а на остальных языках gpt-4o-mini. Замеры на
  // реальных текстах из базы показали, что обе проигрывают gpt-5.6-luna:
  // gpt-4o выдавал узбекскую кириллицу там, где нужна латиница, а mini на
  // таджикском возвращал исходник непереведённым. При этом luna в восемь раз
  // дешевле gpt-4o ($0.20/$1.20 против $2.50/$10.00 за 1M токенов).
  //
  // Разделение на "дешёвую" и "сильную" модель осталось на случай, если для
  // редких языков понадобится gpt-5.6-terra: она чуть точнее в обращениях
  // ("эже" сохраняет, luna переводит как "сестра"), но втрое дороже.
  TILTAB_TRANSLATION_MODEL_LOWRESOURCE: z
    .string()
    .optional()
    .or(z.literal(""))
    .default("gpt-5.6-luna"),
  TILTAB_LOWRESOURCE_LANGUAGES: z
    .string()
    .optional()
    .or(z.literal(""))
    .default("ky,tg,uz,uz_cyrl")
    .transform((val) =>
      val
        ?.split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean) ?? ["ky", "tg", "uz", "uz_cyrl"]
    ),
  TILTAB_REVIEW_ENABLED: z
    .string()
    .optional()
    .or(z.literal(""))
    .default("true")
    .transform((v) => !v || ["1", "true", "yes", "on"].includes(v.toLowerCase())),
  TILTAB_REVIEW_PROVIDER: z.enum(["openai", "auto"]).default("openai"),
  TILTAB_REVIEW_MODEL: z.string().optional().or(z.literal("")),
  // 4096 was the ceiling translations kept hitting; the models in use allow
  // considerably more, and unused budget is not billed.
  TILTAB_TRANSLATION_MAX_TOKENS: z.string().default("8192").transform(Number),
  TILTAB_REVIEW_MAX_TOKENS: z.string().default("4096").transform(Number),
  // At 3000 the review pass was skipped on virtually every real transcript
  // ("combined input too long" in the logs), so the setting existed but never
  // did anything. The limit counts source + translation together.
  TILTAB_REVIEW_MAX_INPUT_CHARS: z.string().default("12000").transform(Number),
  AZURE_TRANSLATOR_KEY: z.string().optional().or(z.literal("")),
  AZURE_TRANSLATOR_REGION: z.string().optional().or(z.literal("")),
  AZURE_TRANSLATOR_ENDPOINT: z.string().url().optional().or(z.literal("")).default("https://api.cognitive.microsofttranslator.com"),
  YANDEX_TRANSLATE_API_KEY: z.string().optional().or(z.literal("")),
  YANDEX_TRANSLATE_FOLDER_ID: z.string().optional().or(z.literal("")),
  YANDEX_TRANSLATE_ENDPOINT: z.string().url().optional().or(z.literal("")).default("https://translate.api.cloud.yandex.net/translate/v2/translate"),
  // Admin panel login. Generate with: node scripts/hash-admin-password.js
  // Only the hash lives here; the password itself is never stored.
  ADMIN_PASSWORD_HASH: z.string().optional().or(z.literal("")),
  TILTAB_ADMIN_SESSION_HOURS: z.string().default("12").transform(Number),
  TILTAB_ADMIN_LOGIN_MAX_ATTEMPTS: z.string().default("5").transform(Number),
  TILTAB_ADMIN_LOGIN_WINDOW_MINUTES: z.string().default("15").transform(Number),
  TILTAB_ADMIN_LOGIN_LOCKOUT_MINUTES: z.string().default("15").transform(Number),
  // Turn on once the panel is served over HTTPS; a Secure cookie is not
  // sent over plain HTTP, which would lock the panel out entirely.
  TILTAB_ADMIN_COOKIE_SECURE: z
    .string()
    .optional()
    .or(z.literal(""))
    .default("false")
    .transform((v) => ["1", "true", "yes", "on"].includes(String(v).toLowerCase())),
  // Kept for automation only, and only when it is at least 32 characters.
  TILTAB_ADMIN_TOKEN: z.string().optional().or(z.literal("")),
  // Telegram chat ID that receives operational alerts (e.g. all Cobalt
  // instances down). Leave empty to disable admin alerts.
  TILTAB_ADMIN_CHAT_ID: z
    .string()
    .optional()
    .or(z.literal(""))
    .transform((v) => {
      const n = v ? Number(v) : NaN;
      return Number.isFinite(n) ? n : undefined;
    }),
  // Background monitor that checks whether any Cobalt instance can still
  // resolve a video, and alerts the admin when they all fail.
  // Per-operator API keys for Cobalt instances that require one,
  // as "host.suffix=key" pairs. Matched by host suffix, so one entry
  // covers every instance an operator runs.
  COBALT_API_KEYS: z.string().optional().or(z.literal("")).default(""),
  COBALT_HEALTHCHECK_ENABLED: z
    .string()
    .optional()
    .or(z.literal(""))
    .default("true")
    .transform((v) => !v || ["1", "true", "yes", "on"].includes(v.toLowerCase())),
  COBALT_HEALTHCHECK_URL: z
    .string()
    .optional()
    .or(z.literal(""))
    .default("https://www.youtube.com/watch?v=jNQXAC9IVRw"),
  COBALT_HEALTHCHECK_INTERVAL_MINUTES: z.string().default("30").transform(Number),
  COBALT_ALERT_THROTTLE_HOURS: z.string().default("6").transform(Number),
  // Deferred problem reports are re-sent to the admin until they are answered
  // or closed: an item that is neither is the one that gets forgotten.
  TILTAB_FEEDBACK_REMINDERS_ENABLED: z
    .string()
    .optional()
    .or(z.literal(""))
    .default("true")
    .transform((v) => !v || ["1", "true", "yes", "on"].includes(v.toLowerCase())),
  TILTAB_FEEDBACK_REMINDER_HOURS: z.string().default("24").transform(Number),
  // Where the annotation corpus lives. Audio stays on this server: 20 hours of
  // 16 kHz mono is about 2 GB, which the disk absorbs without noticing, and a
  // local path keeps the linguists' work out of anyone else's infrastructure.
  TILTAB_DATASET_DIR: z.string().optional().or(z.literal("")).default(""),
  // A single source recording longer than this is almost always a mistake
  // (a whole playlist, a stream). Cutting it would bury the linguist.
  TILTAB_DATASET_MAX_DURATION_MINUTES: z.string().default("90").transform(Number),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
  DATABASE_URL: isTest
    ? z.string().default("")
    : z.string().min(1, "DATABASE_URL is required"),
  PGLITE_DATA_DIR: z.string().default("./.pglite-data"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:", parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
