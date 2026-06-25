import { logger } from "../utils/logger";
import { config } from "../config";
import type { TranslateRequest, TranslateResponse } from "../types";
import { normalizeLanguageCodeOrKeep } from "../utils/languageCodes";
import { latinToCyrillic } from "../utils/uzbekTransliteration";

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

function buildSystemPrompt(targetName: string): string {
  return (
    `You are a professional translator. Translate the user's text into ${targetName}. ` +
    "Preserve meaning, tone, and context. Respond with ONLY the translated text, no explanations."
  );
}

function buildPayload(targetName: string, text: string, model: string): object {
  return {
    model,
    messages: [
      { role: "system", content: buildSystemPrompt(targetName) },
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
  };

  return data.choices[0]?.message?.content?.trim() ?? "";
}

function isRetryableError(status: number, body: string): boolean {
  if (status === 429) return true;
  if (status === 401 || status === 403) return true;
  if (status >= 500) return true;
  const lower = body.toLowerCase();
  if (lower.includes("quota")) return true;
  if (lower.includes("insufficient_quota")) return true;
  if (lower.includes("credit")) return true;
  return false;
}

async function translateWithOpenAI(req: TranslateRequest): Promise<TranslateResponse> {
  const openaiKey = config.OPENAI_API_KEY;
  const groqKey = config.GROQ_API_KEY;
  const targetName = languageNames[req.targetLang] ?? req.targetLang;

  if (!openaiKey && !groqKey) {
    throw new Error("Neither OPENAI_API_KEY nor GROQ_API_KEY is configured for translation");
  }

  if (openaiKey) {
    try {
      const translatedText = await callTranslationProvider(
        OPENAI_API_URL,
        openaiKey,
        buildPayload(targetName, req.text, "gpt-4o-mini"),
        "OpenAI"
      );
      logger.info("Translated with OpenAI", { targetLang: req.targetLang });
      return { translatedText, detectedLang: "auto" };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isRetryable = isRetryableError(0, errorMessage);
      logger.warn("OpenAI translation failed", { error: errorMessage, fallbackToGroq: Boolean(groqKey) && isRetryable });

      if (!groqKey || !isRetryable) {
        throw err;
      }
    }
  }

  if (!groqKey) {
    throw new Error("OpenAI translation failed and no GROQ_API_KEY is configured");
  }

  const translatedText = await callTranslationProvider(
    GROQ_API_URL,
    groqKey,
    buildPayload(targetName, req.text, "llama-3.3-70b-versatile"),
    "Groq"
  );
  logger.info("Translated with Groq fallback", { targetLang: req.targetLang });
  return { translatedText, detectedLang: "auto" };
}

async function translateWithGroq(req: TranslateRequest): Promise<TranslateResponse> {
  const groqKey = config.GROQ_API_KEY;
  if (!groqKey) {
    throw new Error("GROQ_API_KEY is not configured for translation");
  }
  const targetName = languageNames[req.targetLang] ?? req.targetLang;
  const translatedText = await callTranslationProvider(
    GROQ_API_URL,
    groqKey,
    buildPayload(targetName, req.text, "llama-3.3-70b-versatile"),
    "Groq"
  );
  logger.info("Translated with Groq", { targetLang: req.targetLang });
  return { translatedText, detectedLang: "auto" };
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

  let result: TranslateResponse;

  // If Daniel's module URL is configured, proxy to it.
  if (config.TRANSLATION_MODULE_URL) {
    logger.info("Proxying translation to Daniel's module", { targetLang: req.targetLang });
    const res = await fetch(config.TRANSLATION_MODULE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(translateReq),
    });

    if (!res.ok) {
      throw new Error(`Translation module error: ${res.status} ${await res.text()}`);
    }

    result = (await res.json()) as TranslateResponse;
  } else {
    const provider = config.TILTAB_TRANSLATION_PROVIDER;

    if (provider === "lingva") {
      result = await translateWithLingva(translateReq);
    } else if (provider === "openai") {
      result = await translateWithOpenAI(translateReq);
    } else if (provider === "groq") {
      result = await translateWithGroq(translateReq);
    } else if (provider === "mock") {
      result = mockTranslation(translateReq);
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
  }

  if (isUzbekCyrillic) {
    return {
      translatedText: latinToCyrillic(result.translatedText),
      detectedLang: result.detectedLang,
    };
  }

  return result;
}
