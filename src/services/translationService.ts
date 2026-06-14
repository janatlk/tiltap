import { logger } from "../utils/logger";
import { config } from "../config";
import type { TranslateRequest, TranslateResponse } from "../types";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

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

  // Fallback: use OpenAI GPT-4o-mini as a demo stand-in.
  if (!config.OPENAI_API_KEY) {
    logger.warn("No OpenAI API key configured, returning mock translation");
    return {
      translatedText: `[MOCK TRANSLATION to ${req.targetLang}]\n\n${req.text}`,
      detectedLang: "auto",
    };
  }

  logger.info("Using OpenAI fallback for translation", { targetLang: req.targetLang });

  const languageNames: Record<string, string> = {
    ru: "Russian",
    en: "English",
    ky: "Kyrgyz",
    tg: "Tajik",
    uz: "Uzbek",
  };

  const targetName = languageNames[req.targetLang] ?? req.targetLang;

  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a professional translator. Translate the user's text into ${targetName}. Preserve meaning, tone, and context. Respond with ONLY the translated text, no explanations.`,
        },
        {
          role: "user",
          content: req.text,
        },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI translation error: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    choices: Array<{
      message: { content: string };
    }>;
  };

  const translatedText = data.choices[0]?.message?.content?.trim() ?? "";

  return {
    translatedText,
    detectedLang: "auto",
  };
}
