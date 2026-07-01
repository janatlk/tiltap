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
  const sourceHint = sourceName && sourceName !== "auto"
    ? `Translate the user's text from ${sourceName} into ${targetName}.`
    : `Translate the user's text into ${targetName}.`;
  return (
    `${sourceHint} ` +
    "Preserve meaning, tone, and context. " +
    "Do not translate names of people, places, organizations, or loanwords that are commonly left in the original language. " +
    "Respond with ONLY the translated text, no explanations."
  );
}

function buildPayload(targetName: string, sourceName: string | undefined, text: string, model: string): object {
  return {
    model,
    messages: [
      { role: "system", content: buildSystemPrompt(targetName, sourceName) },
      { role: "user", content: text },
    ],
    temperature: 0.3,
  };
}

async function callTranslationProvider(
  url: string,
  apiKey: string,
  payload: object,
  providerName: string
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
  logTranslationCost(providerName.toLowerCase(), model, data.usage?.prompt_tokens ?? 0, data.usage?.completion_tokens ?? 0);

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
    const cached = await translationRepo.getTranslationCache(hash, req.targetLang);
    if (cached) {
      logger.info("Translation cache hit", { targetLang: req.targetLang, sourceLang });
      return { translatedText: cached.translated_text, detectedLang: sourceLang };
    }
  }

  const model = config.TILTAB_TRANSLATION_MODEL || "gpt-4o-mini";

  if (openaiKey) {
    try {
      const translatedText = await callTranslationProvider(
        OPENAI_API_URL,
        openaiKey,
        buildPayload(targetName, sourceName, req.text, model),
        "OpenAI"
      );
      logger.info("Translated with OpenAI", { targetLang: req.targetLang, model });
      await translationRepo.saveTranslationCache({
        sourceHash: hash,
        sourceText: req.text,
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
  const translatedText = await callTranslationProvider(
    GROQ_API_URL,
    groqKey,
    buildPayload(targetName, sourceName, req.text, groqModel),
    "Groq"
  );
  logger.info("Translated with Groq fallback", { targetLang: req.targetLang, model: groqModel });
  await translationRepo.saveTranslationCache({
    sourceHash: hash,
    sourceText: req.text,
    targetLang: req.targetLang,
    translatedText,
    provider: "groq",
    model: groqModel,
  });
  return { translatedText, detectedLang: sourceLang };
}

async function translateWithGroq(req: TranslateRequest): Promise<TranslateResponse> {
  const groqKey = config.GROQ_API_KEY;
  if (!groqKey) {
    throw new Error("GROQ_API_KEY is not configured for translation");
  }
  const targetName = languageNames[req.targetLang] ?? req.targetLang;
  const sourceLang = normalizeLanguageCodeOrKeep(req.sourceLang) ?? "auto";
  const sourceName = sourceLang === "auto" ? undefined : (languageNames[sourceLang] ?? sourceLang);
  const translatedText = await callTranslationProvider(
    GROQ_API_URL,
    groqKey,
    buildPayload(targetName, sourceName, req.text, config.TILTAB_GROQ_TRANSLATION_MODEL),
    "Groq"
  );
  logger.info("Translated with Groq", { targetLang: req.targetLang });
  return { translatedText, detectedLang: sourceLang };
}

function mockTranslation(req: TranslateRequest): TranslateResponse {
  logger.warn("No translation provider available, returning mock translation");
  return {
    translatedText: `[MOCK TRANSLATION to ${req.targetLang}]\n\n${req.text}`,
    detectedLang: "auto",
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

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
  const cached = await translationRepo.getTranslationCache(hash, translateReq.targetLang);
  if (cached) {
    logger.info("Translation cache hit (public)", { targetLang: translateReq.targetLang, sourceLang });
    let text = cached.translated_text;
    if (isUzbekCyrillic) text = latinToCyrillic(text);
    return { translatedText: text, detectedLang: sourceLang };
  }

  // Tajik texts need accurate handling of Arabic/Cyrillic script and named entities.
  // Use OpenAI first; Lingva is not good enough for Tajik.
  const isTajikTranslation = translateReq.targetLang === "tg" || translateReq.sourceLang === "tg";

  let result: TranslateResponse;

  // If Daniel's module URL is configured, try to proxy to it first.
  // If it fails, fall through to the normal provider chain instead of failing the request.
  if (config.TRANSLATION_MODULE_URL) {
    logger.info("Proxying translation to Daniel's module", { targetLang: req.targetLang });
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
      if (isUzbekCyrillic) {
        return {
          translatedText: latinToCyrillic(moduleResult.translatedText),
          detectedLang: moduleResult.detectedLang ?? sourceLang,
        };
      }
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

  if (isUzbekCyrillic) {
    return {
      translatedText: latinToCyrillic(result.translatedText),
      detectedLang: result.detectedLang,
    };
  }

  return result;
}
