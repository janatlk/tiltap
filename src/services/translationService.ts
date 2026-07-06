import { logger } from "../utils/logger";
import { config } from "../config";
import type { TranslateRequest, TranslateResponse } from "../types";
import { normalizeLanguageCodeOrKeep } from "../utils/languageCodes";
import { latinToCyrillic } from "../utils/uzbekTransliteration";
import { createHash } from "crypto";
import * as translationRepo from "../db/repos/translationRepo";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

const languageNames: Record<string, string> = {
  ru: "Russian",
  en: "English",
  ky: "Kyrgyz",
  tg: "Tajik",
  uz: "Uzbek",
  uz_cyrl: "Uzbek Cyrillic",
};

// ---------------------------------------------------------------------------
// Lingva Translate — free, no-API-key front-end for Google Translate
// ---------------------------------------------------------------------------

function mapLingvaLanguage(code: string | undefined): string {
  if (!code || code === "auto" || code === "multi") return "auto";
  // Some STT providers return ISO 639-3 codes (e.g. `kir`, `tgk`, `uzb`).
  // Lingva/Google Translate expect ISO 639-1, so normalize first.
  return normalizeLanguageCodeOrKeep(code) ?? code;
}

function chunkText(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const paragraph of paragraphs) {
    if ((current + "\n\n" + paragraph).length > maxSize && current.length > 0) {
      chunks.push(current.trim());
      current = paragraph;
    } else {
      current = current ? current + "\n\n" + paragraph : paragraph;
    }
  }

  if (current.trim()) chunks.push(current.trim());

  // If a single paragraph is still too long, split it by sentences.
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxSize) {
      result.push(chunk);
      continue;
    }
    const sentences = chunk.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [chunk];
    let sentenceBuffer = "";
    for (const sentence of sentences) {
      if ((sentenceBuffer + " " + sentence).length > maxSize && sentenceBuffer.length > 0) {
        result.push(sentenceBuffer.trim());
        sentenceBuffer = sentence;
      } else {
        sentenceBuffer = sentenceBuffer ? sentenceBuffer + " " + sentence : sentence;
      }
    }
    if (sentenceBuffer.trim()) result.push(sentenceBuffer.trim());
  }

  return result;
}

export interface TranslationQualityReport {
  isSuspicious: boolean;
  flags: string[];
}

export function detectTranslationIssues(text: string): TranslationQualityReport {
  const flags: string[] = [];
  const trimmed = text.trim();

  if (!trimmed) {
    flags.push("empty");
    return { isSuspicious: true, flags };
  }

  const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    flags.push("empty");
    return { isSuspicious: true, flags };
  }

  const counts = new Map<string, number>();
  for (const w of words) {
    // Strip punctuation so repeated words are counted together.
    const normalized = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }

  if (counts.size > 0) {
    const [topWord, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topCount >= 5 && topCount / words.length > 0.35) {
      flags.push(`repetition:${topWord}`);
    }
  }

  // Detect a degenerate tail where the same token is repeated to fill the context window.
  const tailMatch = trimmed.match(/(\S{2,})(?:\s+\1){8,}\s*$/i);
  if (tailMatch) {
    flags.push(`repeated-tail:${tailMatch[1].toLowerCase()}`);
  }

  return {
    isSuspicious: flags.length > 0,
    flags,
  };
}

class TranslationTruncatedError extends Error {
  constructor(provider: string) {
    super(`${provider} translation was truncated (max_tokens reached)`);
    this.name = "TranslationTruncatedError";
  }
}

async function translateWithLingva(req: TranslateRequest): Promise<TranslateResponse> {
  const baseUrl = config.LINGVA_TRANSLATE_URL.replace(/\/$/, "");
  const source = mapLingvaLanguage(req.sourceLang);
  const target = req.targetLang;
  const chunkSize = Math.max(500, config.LINGVA_TRANSLATE_CHUNK_SIZE || 2000);
  const chunks = chunkText(req.text, chunkSize);

  logger.info("Lingva translation started", { chunks: chunks.length, target, source });

  const translatedChunks: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const url = `${baseUrl}/api/v1/${source}/${target}/${encodeURIComponent(chunk)}`;
    const res = await fetch(url, { method: "GET" });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Lingva translation failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { translation?: string; error?: string };
    if (data.error) {
      throw new Error(`Lingva translation error: ${data.error}`);
    }
    if (typeof data.translation !== "string") {
      throw new Error("Lingva returned an unexpected response format");
    }

    translatedChunks.push(data.translation);

    // Be polite to the public instance.
    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  return {
    translatedText: translatedChunks.join("\n\n"),
    detectedLang: source === "auto" ? "auto" : source,
  };
}

// ---------------------------------------------------------------------------
// OpenAI / Groq LLM translation
// ---------------------------------------------------------------------------

function buildSystemPrompt(targetName: string, sourceName?: string): string {
  const sourceHint =
    sourceName && sourceName !== "auto"
      ? `from ${sourceName} into ${targetName}`
      : `into ${targetName}`;

  return (
    "You are a highly disciplined translator. Your sole task is to translate the SOURCE text " +
    sourceHint +
    ".\n\n" +
    "The SOURCE text will be provided in the next user message inside <SOURCE></SOURCE> tags. " +
    "Follow these rules precisely:\n\n" +
    "1. Complete translation: translate every sentence and every word. Do not omit anything. " +
    "Do not leave any fragments in the source language.\n" +
    "2. Sentence-level fidelity: preserve the sentence structure of the source. " +
    "Do not merge two source sentences into one. Do not split one source sentence into several " +
    "unless the grammar of " +
    targetName +
    " absolutely requires it.\n" +
    "3. No additions or inferences: do not add explanations, headings, summaries, commentary, " +
    "or background information. Do not infer facts, emotions, judgements, or causes that are not " +
    "explicitly present in the source.\n" +
    "4. Preserve names and proper nouns: keep names of people, places, organizations, books, " +
    "brands, and abbreviations accurate. Use the established " +
    targetName +
    " form when one exists " +
    "(for example, the writer Mo Yan should be rendered as Мо Янь in Russian). " +
    "If no established form exists, transliterate consistently. Do not invent, shorten, " +
    "normalize, or replace names.\n" +
    "5. Consistent terminology: choose one target-language equivalent for each recurring term " +
    "and use it throughout the text. Do not switch synonyms arbitrarily.\n" +
    "6. Preserve tone and register: translate interviews as interviews, spoken style as spoken, " +
    "formal text as formal. Do not make the text more ideological, more emotional, or more literary " +
    "than the source.\n" +
    "7. Preserve repetitions: if the source repeats a phrase or question, keep the repetition. " +
    "Do not delete duplicates unless they are obvious speech-disfluency artifacts.\n" +
    "8. Numbers and dates: keep them exact and in the same order as the source.\n" +
    "9. Ambiguous or unclear words: translate literally rather than guessing or smoothing over.\n" +
    "10. Ideological neutrality: do not intensify, soften, or reframe meaning. " +
    "For example, do not turn 'certain risks for humanity' into 'a threat to the nation'.\n\n" +
    "Output only the translation. No markdown, no XML tags, no code fences, no explanations."
  );
}

function buildPayload(
  targetName: string,
  sourceName: string | undefined,
  text: string,
  model: string,
  maxTokens?: number
): object {
  const payload: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: buildSystemPrompt(targetName, sourceName) },
      {
        role: "user",
        content: `<SOURCE>\n${text}\n</SOURCE>\n\nTranslate the SOURCE text exactly according to the rules above.`,
      },
    ],
    temperature: 0.0,
  };
  if (maxTokens && maxTokens > 0) {
    payload.max_tokens = maxTokens;
  }
  return payload;
}

async function callTranslationProvider(
  url: string,
  apiKey: string,
  payload: object,
  providerName: string,
  maxTokens?: number
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error(`${providerName} translation failed`, { status: res.status, body: text });
    throw new Error(`${providerName} translation error: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    model?: string;
  };

  const model = (payload as { model?: string }).model ?? data.model ?? "unknown";
  const completionTokens = data.usage?.completion_tokens ?? 0;
  logTranslationCost(providerName.toLowerCase(), model, data.usage?.prompt_tokens ?? 0, completionTokens);

  if (maxTokens && completionTokens >= maxTokens) {
    logger.warn(`${providerName} translation hit max_tokens and may be truncated`, {
      model,
      completionTokens,
      maxTokens,
    });
    throw new TranslationTruncatedError(providerName);
  }

  return data.choices[0]?.message?.content?.trim() ?? "";
}

function logTranslationCost(provider: string, model: string, promptTokens: number, completionTokens: number) {
  const prices: Record<string, { prompt: number; completion: number }> = {
    "gpt-4o-mini": { prompt: 0.15, completion: 0.6 },
    "gpt-4o": { prompt: 2.5, completion: 10.0 },
    "llama-3.3-70b-versatile": { prompt: 0, completion: 0 },
  };
  const price = prices[model] ?? { prompt: 0, completion: 0 };
  const costUsd = (promptTokens * price.prompt + completionTokens * price.completion) / 1_000_000;
  logger.info("Translation cost", { provider, model, promptTokens, completionTokens, costUsd: Math.round(costUsd * 1e6) / 1e6 });
}

function isRetryableError(status: number, body: string): boolean {
  // Auth errors should not be retried with the same key.
  if (status === 401 || status === 403) return false;
  if (status === 429) return true;
  if (status >= 500) return true;
  const lower = body.toLowerCase();
  if (lower.includes("quota")) return true;
  if (lower.includes("insufficient_quota")) return true;
  if (lower.includes("credit")) return true;
  return false;
}

async function translateWithOpenAI(
  req: TranslateRequest,
  options: { skipCache?: boolean } = {}
): Promise<TranslateResponse> {
  const openaiKey = config.OPENAI_API_KEY;
  const groqKey = config.GROQ_API_KEY;
  const targetName = languageNames[req.targetLang] ?? req.targetLang;
  const sourceLang = normalizeLanguageCodeOrKeep(req.sourceLang) ?? "auto";
  const sourceName = sourceLang === "auto" ? undefined : (languageNames[sourceLang] ?? sourceLang);
  const hash = createHash("sha256").update(req.text).digest("hex");

  if (!openaiKey && !groqKey) {
    throw new Error("Neither OPENAI_API_KEY nor GROQ_API_KEY is configured for translation");
  }

  if (!options.skipCache) {
    const cached = await translationRepo.getConfirmedTranslationCache(hash, req.targetLang);
    if (cached) {
      logger.info("Translation confirmed cache hit", { targetLang: req.targetLang, sourceLang });
      return { translatedText: cached.translated_text, detectedLang: sourceLang };
    }
  }

  const model = config.TILTAB_TRANSLATION_MODEL || "gpt-4o-mini";
  const maxTokens = config.TILTAB_TRANSLATION_MAX_TOKENS || 4096;

  if (openaiKey) {
    try {
      const translatedText = await callTranslationProvider(
        OPENAI_API_URL,
        openaiKey,
        buildPayload(targetName, sourceName, req.text, model, maxTokens),
        "OpenAI",
        maxTokens
      );
      logger.info("Translated with OpenAI", { targetLang: req.targetLang, model });
      await translationRepo.saveTranslationCache({
        sourceHash: hash,
        sourceText: req.text,
        sourceLang,
        targetLang: req.targetLang,
        translatedText,
        provider: "openai",
        model,
      });
      return { translatedText, detectedLang: sourceLang };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn("OpenAI translation failed", { error: errorMessage, fallbackToGroq: Boolean(groqKey) });

      if (!groqKey) {
        throw err;
      }
      // Continue to Groq fallback below.
    }
  }

  if (!groqKey) {
    throw new Error("OpenAI translation failed and no GROQ_API_KEY is configured");
  }

  const groqModel = config.TILTAB_GROQ_TRANSLATION_MODEL;
  try {
    const translatedText = await callTranslationProvider(
      GROQ_API_URL,
      groqKey,
      buildPayload(targetName, sourceName, req.text, groqModel, maxTokens),
      "Groq",
      maxTokens
    );
    logger.info("Translated with Groq fallback", { targetLang: req.targetLang, model: groqModel });
    await translationRepo.saveTranslationCache({
      sourceHash: hash,
      sourceText: req.text,
      sourceLang,
      targetLang: req.targetLang,
      translatedText,
      provider: "groq",
      model: groqModel,
    });
    return { translatedText, detectedLang: sourceLang };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("OpenAI and Groq translation failed, trying free fallback", { error: msg });

    const isTajikTranslation = req.targetLang === "tg" || sourceLang === "tg";
    if (config.LINGVA_TRANSLATE_URL && !isTajikTranslation) {
      const fallback = await translateWithLingva(req);
      return {
        translatedText: fallback.translatedText,
        detectedLang: fallback.detectedLang,
        warning: `Groq translation failed (${msg}). Used free Lingva/Google Translate fallback — quality may be lower.`,
      };
    }

    throw err;
  }
}

async function translateWithGroq(req: TranslateRequest): Promise<TranslateResponse> {
  const groqKey = config.GROQ_API_KEY;
  if (!groqKey) {
    throw new Error("GROQ_API_KEY is not configured for translation");
  }
  const targetName = languageNames[req.targetLang] ?? req.targetLang;
  const sourceLang = normalizeLanguageCodeOrKeep(req.sourceLang) ?? "auto";
  const sourceName = sourceLang === "auto" ? undefined : (languageNames[sourceLang] ?? sourceLang);

  const maxTokens = config.TILTAB_TRANSLATION_MAX_TOKENS || 4096;
  try {
    const translatedText = await callTranslationProvider(
      GROQ_API_URL,
      groqKey,
      buildPayload(targetName, sourceName, req.text, config.TILTAB_GROQ_TRANSLATION_MODEL, maxTokens),
      "Groq",
      maxTokens
    );
    logger.info("Translated with Groq", { targetLang: req.targetLang });
    return { translatedText, detectedLang: sourceLang };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("Groq translation failed, trying free fallback", { error: msg });

    // Free fallback: Lingva/Google Translate for non-Tajik pairs.
    const isTajikTranslation = req.targetLang === "tg" || sourceLang === "tg";
    if (config.LINGVA_TRANSLATE_URL && !isTajikTranslation) {
      const fallback = await translateWithLingva(req);
      return {
        translatedText: fallback.translatedText,
        detectedLang: fallback.detectedLang,
        warning: `Groq translation failed (${msg}). Used free Lingva/Google Translate fallback — quality may be lower.`,
      };
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Post-translation QA / review
// ---------------------------------------------------------------------------

const scriptByLanguage: Record<string, "cyrillic" | "latin" | "other"> = {
  ru: "cyrillic",
  ky: "cyrillic",
  tg: "cyrillic",
  uz_cyrl: "cyrillic",
  en: "latin",
  uz: "latin",
};

// Letters that strongly indicate a specific Cyrillic source language.
// Used only as a quick heuristic for same-script pairs.
const sourceSpecificLetters: Record<string, string> = {
  ky: "ңөү",
  tg: "ӯӣҳҷқғ",
  uz_cyrl: "ўқғҳ",
};

function detectUntranslatedFragments(
  text: string,
  sourceLang: string,
  targetLang: string
): string[] {
  const sourceScript = scriptByLanguage[sourceLang] ?? "other";
  const targetScript = scriptByLanguage[targetLang] ?? "other";
  const fragments = new Set<string>();

  if (sourceScript === targetScript && sourceLang !== targetLang) {
    // For same-script pairs, flag only words that contain source-specific letters.
    const markers = sourceSpecificLetters[sourceLang];
    if (markers) {
      const words = text.match(/[\p{L}\p{M}]+/gu) ?? [];
      for (const word of words) {
        if (Array.from(markers).some((ch) => word.includes(ch))) {
          fragments.add(word);
        }
      }
    }
    return Array.from(fragments).slice(0, 10);
  }

  if (sourceScript === "cyrillic" && targetScript === "latin") {
    const words = text.match(/[\u0400-\u04FF]{3,}/g);
    if (words) words.forEach((w) => fragments.add(w));
  }

  if (sourceScript === "latin" && targetScript === "cyrillic") {
    const words = text.match(/[a-zA-Z]{4,}/g);
    if (words) words.forEach((w) => fragments.add(w));
  }

  return Array.from(fragments).slice(0, 10);
}

function buildReviewPayload(
  sourceText: string,
  translatedText: string,
  sourceName: string,
  targetName: string,
  model: string,
  maxTokens?: number
): object {
  const prompt =
    `You are a senior translation quality reviewer. A text was translated from ${sourceName} into ${targetName}.\n\n` +
    `Review the current translation against the source. Produce a corrected translation that fixes ONLY these issues:\n` +
    `1. Untranslated fragments still in ${sourceName}. Translate them into ${targetName}.\n` +
    `2. Inconsistent names, places, or terms (e.g. "Issyk-Kul forum" vs "forum in Issyk-Kul"). Pick one standard form and use it throughout.\n` +
    `3. Hallucinated or invented names that do not appear in the source. Remove or replace them with [?].\n` +
    `4. Awkward or ungrammatical phrasing in ${targetName}.\n\n` +
    `Rules:\n` +
    `- Preserve the original meaning exactly. Do NOT summarize, expand, or change the message.\n` +
    `- Do NOT translate names of people, places, organizations, or brands unless there is a well-established ${targetName} form.\n` +
    `- Keep numbers, dates, and proper nouns accurate.\n` +
    `- Maintain paragraph structure.\n` +
    `- Return a JSON object with exactly these keys:\n` +
    `  - "corrected": the full corrected translation in ${targetName}\n` +
    `  - "issues": a short array of issue types you found (e.g. ["untranslated fragment", "inconsistent name"]), or []\n` +
    `  - "warning": a concise user-facing sentence in ${targetName} summarizing the problem, or null if no significant issue remains\n` +
    `- Output ONLY valid JSON, no markdown, no explanations.\n\n` +
    `Source (${sourceName}):\n${sourceText}\n\n` +
    `Current translation (${targetName}):\n${translatedText}`;

  const payload: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.0,
    response_format: { type: "json_object" },
  };
  if (maxTokens && maxTokens > 0) {
    payload.max_tokens = maxTokens;
  }
  return payload;
}

function parseReviewResponse(raw: string): {
  corrected: string;
  issues: string[];
  warning: string | null;
} {
  const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      corrected: typeof parsed.corrected === "string" ? parsed.corrected : cleaned,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      warning:
        parsed.warning === null || parsed.warning === undefined
          ? null
          : typeof parsed.warning === "string"
          ? parsed.warning
          : null,
    };
  } catch {
    // Fallback: treat the whole output as the corrected translation.
    return { corrected: raw, issues: [], warning: null };
  }
}

async function reviewTranslation(
  req: TranslateRequest,
  translatedText: string,
  providerName: "groq" | "openai"
): Promise<{ reviewedText: string; warning?: string }> {
  if (!config.TILTAB_REVIEW_ENABLED) {
    return { reviewedText: translatedText };
  }

  const sourceLang = normalizeLanguageCodeOrKeep(req.sourceLang) ?? "auto";
  const sourceName = languageNames[sourceLang] ?? sourceLang;
  const targetName = languageNames[req.targetLang] ?? req.targetLang;

  const combinedLength = req.text.length + translatedText.length;
  const maxReviewInputChars = config.TILTAB_REVIEW_MAX_INPUT_CHARS || 4000;
  if (combinedLength > maxReviewInputChars) {
    logger.info("Skipping translation review: combined input too long", {
      sourceLang,
      targetLang: req.targetLang,
      combinedLength,
      maxReviewInputChars,
    });
    return { reviewedText: translatedText };
  }

  const url = providerName === "groq" ? GROQ_API_URL : OPENAI_API_URL;
  const key = providerName === "groq" ? config.GROQ_API_KEY : config.OPENAI_API_KEY;
  const model =
    providerName === "groq"
      ? config.TILTAB_REVIEW_MODEL || config.TILTAB_GROQ_TRANSLATION_MODEL
      : config.TILTAB_REVIEW_MODEL || config.TILTAB_TRANSLATION_MODEL || "gpt-4o-mini";

  if (!key) {
    return { reviewedText: translatedText };
  }

  const maxTokens = config.TILTAB_REVIEW_MAX_TOKENS || 4096;
  const raw = await callTranslationProvider(
    url,
    key,
    buildReviewPayload(req.text, translatedText, sourceName, targetName, model, maxTokens),
    `${providerName}-review`,
    maxTokens
  );
  const parsed = parseReviewResponse(raw);
  logger.info("Translation review complete", {
    sourceLang,
    targetLang: req.targetLang,
    provider: providerName,
    issues: parsed.issues,
  });

  const heuristicFragments = detectUntranslatedFragments(
    parsed.corrected || translatedText,
    sourceLang,
    req.targetLang
  );
  let warning = parsed.warning ?? undefined;
  if (!warning && heuristicFragments.length > 0) {
    warning = `В переводе могут остаться непереведённые фрагменты: ${heuristicFragments.join(", ")}.`;
  }

  return { reviewedText: parsed.corrected || translatedText, warning };
}

function mockTranslation(req: TranslateRequest): TranslateResponse {
  logger.warn("No translation provider available, returning mock translation");
  return {
    translatedText: `[MOCK TRANSLATION to ${req.targetLang}]\n\n${req.text}`,
    detectedLang: "auto",
  };
}

// ---------------------------------------------------------------------------
// Admin confirmation
// ---------------------------------------------------------------------------

export async function confirmTranslation(payload: {
  sourceHash: string;
  targetLang: string;
  confirmedBy?: string;
  translatedText?: string;
}): Promise<translationRepo.TranslationCacheEntry | null> {
  return translationRepo.confirmTranslationCache(payload);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

async function doTranslate(translateReq: TranslateRequest): Promise<TranslateResponse> {
  const sourceLang = normalizeLanguageCodeOrKeep(translateReq.sourceLang) ?? "auto";
  const hash = createHash("sha256").update(translateReq.text).digest("hex");
  const cached = await translationRepo.getConfirmedTranslationCache(hash, translateReq.targetLang);
  if (cached) {
    logger.info("Translation confirmed cache hit", { targetLang: translateReq.targetLang, sourceLang });
    // Re-validate cached entries: old bad translations may have been stored before
    // the quality guard was introduced. If one is found, delete it and translate fresh.
    const cachedQuality = detectTranslationIssues(cached.translated_text);
    if (cachedQuality.isSuspicious) {
      logger.warn("Cached translation failed quality check, deleting and re-translating", {
        targetLang: translateReq.targetLang,
        sourceLang,
        flags: cachedQuality.flags,
      });
      await translationRepo.deleteTranslationCache(hash, translateReq.targetLang).catch((err) => {
        logger.error("Failed to delete bad translation cache", { error: err, hash });
      });
    } else {
      return { translatedText: cached.translated_text, detectedLang: sourceLang };
    }
  }

  // Tajik texts need accurate handling of Arabic/Cyrillic script and named entities.
  // Use OpenAI first; Lingva is not good enough for Tajik.
  const isTajikTranslation = translateReq.targetLang === "tg" || translateReq.sourceLang === "tg";

  let result: TranslateResponse;

  // If Daniel's module URL is configured, try to proxy to it first.
  // If it fails, fall through to the normal provider chain instead of failing the request.
  if (config.TRANSLATION_MODULE_URL) {
    logger.info("Proxying translation to Daniel's module", { targetLang: translateReq.targetLang });
    try {
      const res = await fetch(config.TRANSLATION_MODULE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(translateReq),
      });

      if (!res.ok) {
        throw new Error(`Translation module error: ${res.status} ${await res.text()}`);
      }

      const moduleResult = (await res.json()) as TranslateResponse;
      return moduleResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Translation module failed, falling back to provider chain", { error: msg });
      // Continue to provider chain below.
    }
  }

  // Normal provider chain (no translation module or module failed).
  const provider = config.TILTAB_TRANSLATION_PROVIDER;

  if (provider === "lingva" && !isTajikTranslation) {
    result = await translateWithLingva(translateReq);
  } else if (provider === "openai") {
    result = await translateWithOpenAI(translateReq);
  } else if (provider === "groq") {
    result = await translateWithGroq(translateReq);
  } else if (provider === "mock") {
    result = mockTranslation(translateReq);
  } else if (isTajikTranslation && (config.OPENAI_API_KEY || config.GROQ_API_KEY)) {
    result = await translateWithOpenAI(translateReq);
  } else if (config.LINGVA_TRANSLATE_URL) {
    try {
      result = await translateWithLingva(translateReq);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Lingva translation failed, falling back", { error: msg });
      if (config.OPENAI_API_KEY || config.GROQ_API_KEY) {
        result = await translateWithOpenAI(translateReq);
      } else {
        result = mockTranslation(translateReq);
      }
    }
  } else if (config.OPENAI_API_KEY || config.GROQ_API_KEY) {
    result = await translateWithOpenAI(translateReq);
  } else {
    result = mockTranslation(translateReq);
  }

  // -------------------------------------------------------------------------
  // Sanity check the raw translation before review / cache. LLMs can degenerate
  // into repetitive loops when they hit their output token limit. If the output
  // looks suspicious, fail the translation so the caller can fall back to the
  // source transcription instead of sending garbage to the user.
  // -------------------------------------------------------------------------
  const quality = detectTranslationIssues(result.translatedText);
  if (quality.isSuspicious) {
    logger.warn("Translation quality check failed", {
      sourceLang,
      targetLang: translateReq.targetLang,
      provider: provider ?? "auto",
      flags: quality.flags,
      translatedLength: result.translatedText.length,
    });
    throw new Error(`Translation output rejected: ${quality.flags.join(", ")}`);
  }

  // -------------------------------------------------------------------------
  // Quality review: fix untranslated fragments, inconsistent names, and
  // awkward phrasing. Runs for all language pairs. Respect TILTAB_REVIEW_PROVIDER
  // if set; otherwise prefer the same provider used for translation.
  // Fail-soft: review failures are logged but never surfaced to the user.
  // -------------------------------------------------------------------------
  const preferredReviewProvider: "openai" | "groq" | undefined = (() => {
    if (config.TILTAB_REVIEW_PROVIDER === "openai" && config.OPENAI_API_KEY) return "openai";
    if (config.TILTAB_REVIEW_PROVIDER === "groq" && config.GROQ_API_KEY) return "groq";
    if (config.TILTAB_REVIEW_PROVIDER === "auto") {
      if (provider === "openai" && config.OPENAI_API_KEY) return "openai";
      if (provider === "groq" && config.GROQ_API_KEY) return "groq";
      if (config.GROQ_API_KEY) return "groq";
      if (config.OPENAI_API_KEY) return "openai";
    }
    return undefined;
  })();

  if (preferredReviewProvider) {
    const fallbackProvider =
      preferredReviewProvider === "openai" && config.GROQ_API_KEY ? "groq" :
      preferredReviewProvider === "groq" && config.OPENAI_API_KEY ? "openai" : undefined;

    let reviewed: { reviewedText: string; warning?: string } = { reviewedText: result.translatedText };
    try {
      reviewed = await reviewTranslation(translateReq, result.translatedText, preferredReviewProvider);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Preferred review provider failed", { provider: preferredReviewProvider, error: msg });
      if (fallbackProvider) {
        try {
          reviewed = await reviewTranslation(translateReq, result.translatedText, fallbackProvider);
        } catch (err2) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          logger.warn("Fallback review provider also failed", { provider: fallbackProvider, error: msg2 });
        }
      }
    }

    result.translatedText = reviewed.reviewedText;
    if (reviewed.warning) {
      result.warning = result.warning ? `${result.warning} ${reviewed.warning}` : reviewed.warning;
    }
  }

  return result;
}

export async function translateText(req: TranslateRequest): Promise<TranslateResponse> {
  if (!req.text?.trim()) {
    return { translatedText: "", detectedLang: "auto" };
  }

  // Uzbek Cyrillic is a script variant of Uzbek Latin. Translate to Latin first,
  // then transliterate. For LLM providers we could ask directly, but transliteration
  // keeps the output consistent and works for all providers.
  const isUzbekCyrillic = req.targetLang === "uz_cyrl";
  const translateReq: TranslateRequest = isUzbekCyrillic
    ? { ...req, targetLang: "uz" }
    : req;

  const sourceLang = normalizeLanguageCodeOrKeep(translateReq.sourceLang) ?? "auto";
  const hash = createHash("sha256").update(translateReq.text).digest("hex");
  const provider = config.TILTAB_TRANSLATION_PROVIDER;
  const model = config.TILTAB_GROQ_TRANSLATION_MODEL || config.TILTAB_TRANSLATION_MODEL || "unknown";

  // Every user-facing translation gets a public request number. This lets users
  // report problems by quoting the number, and lets admins look up the exact
  // request in the audit log.
  const requestNumber = await translationRepo.getNextRequestNumber().catch((err) => {
    logger.error("Failed to generate request number", { error: err instanceof Error ? err.message : String(err) });
    return 0;
  });

  try {
    // If a confirmed cache entry already exists, serve it and log a confirmed
    // audit row. We re-validate quality here so bad cached entries are re-translated.
    const cached = await translationRepo.getConfirmedTranslationCache(hash, translateReq.targetLang);
    if (cached && !detectTranslationIssues(cached.translated_text).isSuspicious) {
      logger.info("Translation confirmed cache hit", { targetLang: translateReq.targetLang, sourceLang, requestNumber });
      await translationRepo.saveTranslationRequest({
        sourceHash: hash,
        sourceText: translateReq.text,
        sourceLang,
        targetLang: translateReq.targetLang,
        translatedText: cached.translated_text,
        provider: "cache",
        model: "cache",
        status: "confirmed",
        sourceUrl: translateReq.sourceUrl,
        sourceType: translateReq.sourceType,
        requestNumber,
      }).catch((logErr) => {
        logger.error("Failed to log translation request", { error: logErr instanceof Error ? logErr.message : String(logErr) });
      });

      const cachedResult: TranslateResponse = {
        translatedText: cached.translated_text,
        detectedLang: sourceLang,
        requestId: requestNumber,
      };
      if (isUzbekCyrillic) {
        cachedResult.translatedText = latinToCyrillic(cachedResult.translatedText);
      }
      return cachedResult;
    }

    const result = await doTranslate(translateReq);

    // Save reviewed result to cache as PENDING. It will not be auto-returned
    // until an admin confirms it via /web/admin.
    await translationRepo.saveTranslationCache({
      sourceHash: hash,
      sourceText: translateReq.text,
      sourceLang,
      targetLang: translateReq.targetLang,
      translatedText: result.translatedText,
      provider: provider ?? "auto",
      model,
      sourceUrl: translateReq.sourceUrl,
      sourceType: translateReq.sourceType,
      requestNumber,
    });

    await translationRepo.saveTranslationRequest({
      sourceHash: hash,
      sourceText: translateReq.text,
      sourceLang,
      targetLang: translateReq.targetLang,
      translatedText: result.translatedText,
      provider: provider ?? "auto",
      model,
      status: "pending",
      sourceUrl: translateReq.sourceUrl,
      sourceType: translateReq.sourceType,
      requestNumber,
    }).catch((logErr) => {
      logger.error("Failed to log translation request", { error: logErr instanceof Error ? logErr.message : String(logErr) });
    });

    if (isUzbekCyrillic) {
      return {
        translatedText: latinToCyrillic(result.translatedText),
        detectedLang: result.detectedLang,
        warning: result.warning,
        requestId: requestNumber,
      };
    }

    return { ...result, requestId: requestNumber };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error("Translation failed, logging error to cache", {
      sourceLang,
      targetLang: translateReq.targetLang,
      provider: provider ?? "auto",
      error: errorMessage,
      requestNumber,
    });

    await translationRepo.logTranslationError({
      sourceHash: hash,
      sourceText: translateReq.text,
      sourceLang,
      targetLang: translateReq.targetLang,
      errorMessage,
      provider: provider ?? "auto",
      model,
      sourceUrl: translateReq.sourceUrl,
      sourceType: translateReq.sourceType,
      requestNumber,
    }).catch((logErr) => {
      logger.error("Failed to log translation error", { error: logErr instanceof Error ? logErr.message : String(logErr) });
    });

    await translationRepo.saveTranslationRequest({
      sourceHash: hash,
      sourceText: translateReq.text,
      sourceLang,
      targetLang: translateReq.targetLang,
      provider: provider ?? "auto",
      model,
      status: "error",
      errorMessage,
      sourceUrl: translateReq.sourceUrl,
      sourceType: translateReq.sourceType,
      requestNumber,
    }).catch((logErr) => {
      logger.error("Failed to log translation request", { error: logErr instanceof Error ? logErr.message : String(logErr) });
    });

    throw err;
  }
}
