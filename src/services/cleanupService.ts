import { logger } from "../utils/logger";
import { config } from "../config";
import { createHash } from "crypto";
import * as cleanupRepo from "../db/repos/cleanupRepo";

export interface CleanupResult {
  cleanedText: string;
  provider: string;
  model: string;
}

export interface CleanupOptions {
  language?: string;
  enableCleanup?: boolean;
}

/**
 * Post-process an STT transcript via an LLM chain.
 *
 * Provider priority (unless overridden by TILTAB_CLEANUP_PROVIDER):
 *   - Gemini primary when available, then OpenAI, then Groq.
 *
 * Set TILTAB_CLEANUP_PROVIDER=none to disable.
 */
export async function cleanupTranscription(
  text: string,
  language: string,
  options: CleanupOptions = {}
): Promise<CleanupResult> {
  const enabled = options.enableCleanup ?? true;
  if (!enabled || config.TILTAB_CLEANUP_PROVIDER === "none") {
    return { cleanedText: text, provider: "disabled", model: "" };
  }

  if (!text.trim()) {
    return { cleanedText: text, provider: "none", model: "" };
  }

  const lang = language.split("+")[0];
  const hash = createHash("sha256").update(text).digest("hex");

  // Check DB cache first.
  const cached = await cleanupRepo.getCleanupByHash(hash, lang);
  if (cached) {
    logger.info("STT cleanup cache hit", { language: lang, provider: cached.provider });
    return { cleanedText: cached.cleaned_text, provider: `cached:${cached.provider}`, model: cached.model };
  }

  const systemPrompt = buildSystemPrompt(language);
  const userPrompt = text;

  const providers = buildProviderChain(lang);
  if (providers.length === 0) {
    logger.warn("No LLM cleanup providers configured; returning raw transcript");
    return { cleanedText: text, provider: "none", model: "" };
  }

  for (const provider of providers) {
    try {
      const result = await callProvider(provider, systemPrompt, userPrompt);
      if (result && isCleanupSane(text, result.cleanedText)) {
        logger.info("STT cleanup complete", { provider: result.provider, model: result.model, language: lang });
        await cleanupRepo.saveCleanup({
          sourceHash: hash,
          sourceText: text,
          cleanedText: result.cleanedText,
          language: lang,
          provider: result.provider,
          model: result.model,
        });
        return result;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`${provider.name} cleanup failed`, { error: msg });
    }
  }

  logger.warn("All LLM cleanup providers failed; returning raw transcript");
  return { cleanedText: text, provider: "fallback", model: "" };
}

// ---------------------------------------------------------------------------
// Provider chain
// ---------------------------------------------------------------------------

interface ProviderSpec {
  name: "groq" | "openai" | "gemini";
}

function buildProviderChain(language: string): ProviderSpec[] {
  const forced = config.TILTAB_CLEANUP_PROVIDER;
  if (forced && forced !== "none") {
    if (hasProviderKey(forced)) {
      return [{ name: forced }];
    }
    logger.warn(`Forced cleanup provider ${forced} has no API key configured`);
  }

  const chain: ProviderSpec[] = [];

  // Tajik uses Gemini primary when available, then OpenAI, then Groq.
  if (language === "tg") {
    if (config.GEMINI_API_KEY) chain.push({ name: "gemini" });
    if (config.OPENAI_API_KEY) chain.push({ name: "openai" });
    if (config.GROQ_API_KEY) chain.push({ name: "groq" });
    return chain;
  }

  if (config.GEMINI_API_KEY) chain.push({ name: "gemini" });
  if (config.GROQ_API_KEY) chain.push({ name: "groq" });
  if (config.OPENAI_API_KEY) chain.push({ name: "openai" });
  return chain;
}

function hasProviderKey(name: string): boolean {
  switch (name) {
    case "groq":
      return Boolean(config.GROQ_API_KEY);
    case "openai":
      return Boolean(config.OPENAI_API_KEY);
    case "gemini":
      return Boolean(config.GEMINI_API_KEY);
    default:
      return false;
  }
}

async function callProvider(
  provider: ProviderSpec,
  systemPrompt: string,
  userPrompt: string
): Promise<CleanupResult | null> {
  switch (provider.name) {
    case "groq":
      return callGroq(systemPrompt, userPrompt);
    case "openai":
      return callOpenAI(systemPrompt, userPrompt);
    case "gemini":
      return callGemini(systemPrompt, userPrompt);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Groq
// ---------------------------------------------------------------------------

async function callGroq(systemPrompt: string, userPrompt: string): Promise<CleanupResult | null> {
  if (!config.GROQ_API_KEY) return null;

  const model = config.TILTAB_CLEANUP_MODEL || "llama-3.3-70b-versatile";
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API error: ${res.status} ${errText}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const cleaned = data.choices?.[0]?.message?.content?.trim() ?? userPrompt;
  logCleanupCost("groq", model, data.usage?.prompt_tokens ?? 0, data.usage?.completion_tokens ?? 0);
  return { cleanedText: stripMarkdownCodeBlock(cleaned), provider: "groq", model };
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

async function callOpenAI(systemPrompt: string, userPrompt: string): Promise<CleanupResult | null> {
  if (!config.OPENAI_API_KEY) return null;

  const model = config.TILTAB_CLEANUP_MODEL || "gpt-4o-mini";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API error: ${res.status} ${errText}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const cleaned = data.choices?.[0]?.message?.content?.trim() ?? userPrompt;
  logCleanupCost("openai", model, data.usage?.prompt_tokens ?? 0, data.usage?.completion_tokens ?? 0);
  return { cleanedText: stripMarkdownCodeBlock(cleaned), provider: "openai", model };
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

async function callGemini(systemPrompt: string, userPrompt: string): Promise<CleanupResult | null> {
  if (!config.GEMINI_API_KEY) return null;

  const model = config.TILTAB_CLEANUP_MODEL || "gemini-1.5-flash";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.GEMINI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error: ${res.status} ${errText}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const cleaned = data.choices?.[0]?.message?.content?.trim() ?? userPrompt;
  logCleanupCost("gemini", model, data.usage?.prompt_tokens ?? 0, data.usage?.completion_tokens ?? 0);
  return { cleanedText: stripMarkdownCodeBlock(cleaned), provider: "gemini", model };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function logCleanupCost(provider: string, model: string, promptTokens: number, completionTokens: number) {
  const prices: Record<string, { prompt: number; completion: number }> = {
    "gpt-4o-mini": { prompt: 0.15, completion: 0.6 }, // per 1M tokens in USD
    "gpt-4o": { prompt: 2.5, completion: 10.0 },
    "llama-3.3-70b-versatile": { prompt: 0.0, completion: 0.0 }, // Groq pricing varies; log tokens only
  };
  const price = prices[model] ?? { prompt: 0, completion: 0 };
  const costUsd = (promptTokens * price.prompt + completionTokens * price.completion) / 1_000_000;
  logger.info("STT cleanup cost", { provider, model, promptTokens, completionTokens, costUsd: Math.round(costUsd * 1e6) / 1e6 });
}

function stripMarkdownCodeBlock(text: string): string {
  return text.replace(/^```(?:\w+)?\n?/, "").replace(/\n?```$/, "").trim();
}

function isCleanupSane(original: string, cleaned: string): boolean {
  if (!cleaned || cleaned.length < original.length * 0.4) return false;
  if (cleaned.length > original.length * 3) return false;
  if (/\n\n|^(Here is|Below is|Note:|Translation:|Output:)/i.test(cleaned)) return false;
  return true;
}

function languageName(code: string): string {
  const names: Record<string, string> = {
    en: "English",
    ru: "Russian",
    uz: "Uzbek (Latin script)",
    ky: "Kyrgyz (Cyrillic script)",
    tg: "Tajik (Cyrillic script)",
    uz_cyrl: "Uzbek (Cyrillic script)",
  };
  return names[code.split("+")[0]] ?? code;
}

function buildSystemPrompt(language: string): string {
  const base =
    "You are a conservative STT transcript editor. " +
    "Your ONLY job is to clean up the raw transcript. " +
    "Do NOT translate. Do NOT change the meaning. Do NOT rephrase. Do NOT add explanations. " +
    "Do NOT add markdown. Return ONLY the cleaned text.";

  const lang = language.split("+")[0];

  if (lang === "tg") {
    return (
      `${base}\n\n` +
      "Language: Tajik (Cyrillic script).\n\n" +
      "Rules:\n" +
      "1. Output must be clean Tajik Cyrillic.\n" +
      "2. Convert any Arabic/Persian script leaks to Tajik Cyrillic.\n" +
      "3. Fix dates: use ordinal suffixes -ум/-юm. Examples: '1-ум', '2-юм', '3-юм', '12-ум', '13-ум', '22-юм', '23-юм'. '23 май' → '23-юми май'; '23.05.2024' → '23-юми майи соли 2024'.\n" +
      "4. Attach the object clitic 'ро' to the preceding word: 'мо ро' → 'моро', 'Аллоҳи меҳрабон ро' → 'Аллоҳи меҳрабонро'.\n" +
      "5. Normalize common names/places to standard Tajik spellings: Конибодом, Душанбе, Хуҷанд, Маҳбуба Ахмедова, Нозанин Ахмедова, Абдуфаттоҳ Иброҳимов, Қурбонгул Иброҳимова, Радиои Озоди, Хонаи муқаддас.\n" +
      "6. Preserve Russian, Uzbek, or English code-switching insertions exactly as they appear. Do not translate them.\n" +
      "7. If a segment is crying, laughter, applause, music, or unintelligible, replace it with [плач], [кулол], [аплодисменты], [музыка], or [неразборчиво] respectively.\n" +
      "8. Do NOT change verb tenses, names, or word order."
    );
  }

  if (lang === "ky") {
    return (
      `${base}\n\n` +
      "Language: Kyrgyz (Cyrillic script).\n\n" +
      "Rules:\n" +
      "1. Fix grammar, case, and punctuation only.\n" +
      "2. Capitalize proper nouns (country names, cities, people, organizations).\n" +
      "3. Preserve Russian/English code-switching exactly as it appears.\n" +
      "4. Mark obvious noise/garbage as [неразборчиво].\n" +
      "5. Do NOT change names, word order, or meaning."
    );
  }

  if (lang === "uz" || lang === "uz_cyrl") {
    return (
      `${base}\n\n` +
      "Language: Uzbek (Latin script).\n\n" +
      "Rules:\n" +
      "1. Fix grammar, spelling, and punctuation only.\n" +
      "2. Capitalize proper nouns.\n" +
      "3. Preserve Russian/English code-switching exactly as it appears.\n" +
      "4. Mark obvious noise/garbage as [неразборчиво].\n" +
      "5. Do NOT change names, word order, or meaning."
    );
  }

  if (lang === "ru") {
    return (
      `${base}\n\n` +
      "Language: Russian.\n\n" +
      "Rules:\n" +
      "1. Fix grammar, punctuation, and capitalization only.\n" +
      "2. Preserve any Kyrgyz/Uzbek/English code-switching exactly as it appears.\n" +
      "3. Mark obvious noise/garbage as [неразборчиво].\n" +
      "4. Do NOT change names, word order, or meaning."
    );
  }

  return (
    `${base}\n\n` +
    `Language: ${languageName(language)}.\n\n` +
    "Rules:\n" +
    "1. Add proper punctuation and fix capitalization.\n" +
    "2. Preserve any code-switching or loanwords exactly as they appear.\n" +
    "3. Mark obvious noise/garbage as [unintelligible].\n" +
    "4. Do NOT translate, do NOT change names, do NOT change meaning."
  );
}

// ---------------------------------------------------------------------------
// Quality / hallucination detection
// ---------------------------------------------------------------------------

export interface QualityReport {
  isSuspicious: boolean;
  flags: string[];
  meanConfidence?: number;
}

export function detectTranscriptionIssues(
  text: string,
  language: string,
  _segments?: Array<{ id: number; start: number; end: number; text: string; confidence?: number }>
): QualityReport {
  const flags: string[] = [];
  const trimmed = text.trim();

  if (!trimmed) {
    flags.push("empty");
  }

  const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    const counts = new Map<string, number>();
    for (const w of words) {
      counts.set(w, (counts.get(w) || 0) + 1);
    }
    const [topWord, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topCount >= 5 && topCount / words.length > 0.35) {
      flags.push(`repetition:${topWord}`);
    }
  }

  return {
    isSuspicious: flags.length > 0,
    flags,
  };
}
