import { logger } from "../utils/logger";
import { config } from "../config";
import type { TranslateRequest, TranslateResponse } from "../types";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

const languageNames: Record<string, string> = {
  ru: "Russian",
  en: "English",
  ky: "Kyrgyz",
  tg: "Tajik",
  uz: "Uzbek",
};

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

export async function translateText(req: TranslateRequest): Promise<TranslateResponse> {
  // If Daniel's module URL is configured, proxy to it.
  if (config.TRANSLATION_MODULE_URL) {
    logger.info("Proxying translation to Daniel's module", { targetLang: req.targetLang });
    const res = await fetch(config.TRANSLATION_MODULE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });

    if (!res.ok) {
      throw new Error(`Translation module error: ${res.status} ${await res.text()}`);
    }

    return (await res.json()) as TranslateResponse;
  }

  const targetName = languageNames[req.targetLang] ?? req.targetLang;

  // Fallback chain: OpenAI -> Groq -> mock.
  const openaiKey = config.OPENAI_API_KEY;
  const groqKey = config.GROQ_API_KEY;

  if (openaiKey) {
    try {
      const translatedText = await callTranslationProvider(
        OPENAI_API_URL,
        openaiKey,
        buildPayload(targetName, req.text, "gpt-4o-mini"),
        "OpenAI"
      );
      logger.info("Using OpenAI fallback for translation", { targetLang: req.targetLang });
      return { translatedText, detectedLang: "auto" };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isRetryable = isRetryableError(0, errorMessage);
      logger.warn("OpenAI translation failed", { error: errorMessage, fallbackToGroq: Boolean(groqKey) && isRetryable });

      if (!groqKey || !isRetryable) {
        if (!groqKey) {
          logger.warn("No Groq API key configured, returning mock translation");
          return {
            translatedText: `[MOCK TRANSLATION to ${req.targetLang}]\n\n${req.text}`,
            detectedLang: "auto",
          };
        }
        throw err;
      }
      // Fall through to Groq.
    }
  }

  if (groqKey) {
    const translatedText = await callTranslationProvider(
      GROQ_API_URL,
      groqKey,
      buildPayload(targetName, req.text, "llama-3.3-70b-versatile"),
      "Groq"
    );
    logger.info("Using Groq fallback for translation", { targetLang: req.targetLang });
    return { translatedText, detectedLang: "auto" };
  }

  logger.warn("No translation provider configured, returning mock translation");
  return {
    translatedText: `[MOCK TRANSLATION to ${req.targetLang}]\n\n${req.text}`,
    detectedLang: "auto",
  };
}
