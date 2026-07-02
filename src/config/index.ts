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
  TILTAB_TRANSLATION_PROVIDER: z.enum(["lingva", "openai", "groq", "mock", "auto"]).default("auto"),
  YOUTUBE_COOKIES_BASE64: z.string().optional().or(z.literal("")),
  YOUTUBE_COOKIES_PATH: z.string().optional().or(z.literal("")),
  YOUTUBE_PO_TOKEN: z.string().optional().or(z.literal("")),
  YOUTUBE_VISITOR_DATA: z.string().optional().or(z.literal("")),
  YOUTUBE_AUTO_UPDATE_YTDLP: z.enum(["true", "false", "1", "0", ""]).optional().or(z.literal("")).default("false"),
  GROQ_API_KEY: z.string().optional().or(z.literal("")),
  GEMINI_API_KEY: z.string().optional().or(z.literal("")),


  ELEVENLABS_API_KEY: z.string().optional().or(z.literal("")),
  ELEVENLABS_MODEL_ID: z.string().optional().or(z.literal("")).default("scribe_v2"),
  TILTAB_STT_PROVIDER: z.enum(["openai", "local", "auto", "elevenlabs"]).default("local"),
  TILTAB_STT_SERVICE_URL: z.string().url().optional().or(z.literal("")),
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
  TILTAB_CLEANUP_PROVIDER: z.enum(["openai", "groq", "gemini", "none"]).optional(),
  TILTAB_CLEANUP_MODEL: z.string().optional().or(z.literal("")),
  // Enable LLM cleanup for non-Tajik languages. Tajik cleanup is always enabled unless provider is "none".
  TILTAB_CLEANUP_NON_TAJIK: z
    .string()
    .optional()
    .or(z.literal(""))
    .default("1")
    .transform((v) => !v || ["1", "true", "yes", "on"].includes(v.toLowerCase())),
  TILTAB_TRANSLATION_MODEL: z.string().optional().or(z.literal("")).default("gpt-4o-mini"),
  TILTAB_GROQ_TRANSLATION_MODEL: z.string().optional().or(z.literal("")).default("llama-3.3-70b-versatile"),
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
