import { logger } from "../utils/logger";
import { config } from "../config";

export interface CleanupResult {
  cleanedText: string;
  provider: string;
}

/**
 * Clean up a transcription by adding punctuation, fixing proper nouns,
 * and correcting abbreviations.
 *
 * Tries LLM providers in order (Groq → Gemini) and falls back to
 * rule-based cleanup if no API keys are configured.
 */
export async function cleanupTranscription(
  text: string,
  language: string
): Promise<CleanupResult> {
  const providers: Array<() => Promise<CleanupResult | null>> = [
    () => cleanupWithGroq(text, language),
    () => cleanupWithGemini(text, language),
  ];

  for (const provider of providers) {
    try {
      const result = await provider();
      if (result) {
        logger.info("Transcription cleaned up", { provider: result.provider, language });
        return result;
      }
    } catch (err) {
      logger.warn("LLM cleanup provider failed", { error: err, provider: provider.name });
    }
  }

  // Fallback to rule-based cleanup
  const cleaned = ruleBasedCleanup(text, language);
  logger.info("Transcription cleaned up (rule-based fallback)", { language });
  return { cleanedText: cleaned, provider: "rule-based" };
}

// ---------------------------------------------------------------------------
// Groq provider (free tier: 20 req/min, 600K tokens/day)
// ---------------------------------------------------------------------------
async function cleanupWithGroq(text: string, language: string): Promise<CleanupResult | null> {
  if (!config.GROQ_API_KEY) return null;

  const prompt = buildCleanupPrompt(text, language);

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content:
            "You are a conservative text cleanup assistant. Your ONLY job is to add proper punctuation (periods, commas, question marks, exclamation marks), fix capitalization of proper nouns, and correct common abbreviations. Do NOT translate the text. Do NOT change any words, do NOT add explanations, do NOT add markdown, do NOT transliterate. Preserve all loanwords and code-switching exactly as they appear. Return ONLY the cleaned text in the ORIGINAL language(s).",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API error: ${res.status} ${errText}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  let cleaned = data.choices?.[0]?.message?.content?.trim() ?? text;
  cleaned = stripMarkdownCodeBlock(cleaned);

  if (!isCleanupSane(text, cleaned)) {
    throw new Error("Groq cleanup produced an implausible result; falling back");
  }

  return { cleanedText: cleaned, provider: "groq" };
}

// ---------------------------------------------------------------------------
// Gemini provider (free tier: 15 req/min, 1M tokens/day)
// ---------------------------------------------------------------------------
async function cleanupWithGemini(text: string, language: string): Promise<CleanupResult | null> {
  if (!config.GEMINI_API_KEY) return null;

  const prompt = buildCleanupPrompt(text, language);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${config.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4096,
        },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error: ${res.status} ${errText}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  let cleaned = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? text;
  cleaned = stripMarkdownCodeBlock(cleaned);

  if (!isCleanupSane(text, cleaned)) {
    throw new Error("Gemini cleanup produced an implausible result; falling back");
  }

  return { cleanedText: cleaned, provider: "gemini" };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------
function cleanupLanguageName(language: string): string {
  const primary = language.split("+")[0];
  const langName: Record<string, string> = {
    ky: "Kyrgyz",
    tg: "Tajik",
    uz: "Uzbek",
    ru: "Russian",
    en: "English",
  };
  return langName[primary] ?? primary;
}

function stripMarkdownCodeBlock(text: string): string {
  return text.replace(/^```(?:\w+)?\n?/, "").replace(/\n?```$/, "").trim();
}

function isCleanupSane(original: string, cleaned: string): boolean {
  if (!cleaned || cleaned.length < original.length * 0.5) return false;
  if (cleaned.length > original.length * 2.5) return false;
  // Reject if the model returned explanations or lists
  if (/\n\n|^(Here is|Below is|Note:|Translation:)/i.test(cleaned)) return false;
  return true;
}

function buildCleanupPrompt(text: string, language: string): string {
  const langName = cleanupLanguageName(language);

  return `Add proper punctuation (periods, commas, question marks, exclamation marks) to the following ${langName} transcript. Fix capitalization of proper nouns (country names, cities, organizations, people's names). Fix abbreviations (e.g., "би би си" → "BBC", "кыргызстан" → "Кыргызстан", "tadjikistan" → "Tajikistan"). IMPORTANT: Do NOT translate the text to any other language. Keep the text in ${langName}. Preserve any Russian loanwords or code-switched segments exactly as they appear. Do NOT change any words or their order. Do NOT add explanations. Do NOT use markdown. Return ONLY the cleaned text.

Text:
${text}`;
}

// ---------------------------------------------------------------------------
// Rule-based fallback
// ---------------------------------------------------------------------------
function ruleBasedCleanup(text: string, language: string): string {
  let cleaned = text;

  // Capitalize first letter of each sentence
  cleaned = cleaned.replace(/(^|[.!?]\s+)([a-zа-яёқӯҳҷғӣүөъ])/g, (_, prefix, letter) => {
    return prefix + letter.toUpperCase();
  });

  // Ensure text ends with punctuation
  if (cleaned.length > 0 && !/[.!?]$/.test(cleaned)) {
    cleaned += ".";
  }

  // Language-specific proper noun fixes
  const dictionaries: Record<string, Record<string, string>> = {
    ky: {
      кыргызстан: "Кыргызстан",
      бишкек: "Бишкек",
      ош: "Ош",
      жасал: "Жасал",
      садыр: "Садыр",
      жапаров: "Жапаров",
    },
    tg: {
      таджикистан: "Таджикистан",
      душанбе: "Душанбе",
      хуҷанд: "Хуҷанд",
      тоҷикистон: "Тоҷикистон",
      эмомали: "Эмомали",
      раҳмон: "Раҳмон",
    },
    uz: {
      "o'zbekiston": "O'zbekiston",
      "oʻzbekiston": "Oʻzbekiston",
      toshkent: "Toshkent",
      samarqand: "Samarqand",
      buxorо: "Buxoro",
      "shavkat mirziyoyev": "Shavkat Mirziyoyev",
    },
    ru: {
      кыргызстан: "Кыргызстан",
      таджикистан: "Таджикистан",
      узбекистан: "Узбекистан",
      россия: "Россия",
      москва: "Москва",
      "би би си": "BBC",
      сиэнэн: "CNN",
      "нато ": "НАТО ",
      оон: "ООН",
    },
    en: {
      kyrgyzstan: "Kyrgyzstan",
      tajikistan: "Tajikistan",
      uzbekistan: "Uzbekistan",
      bishkek: "Bishkek",
      dushanbe: "Dushanbe",
      tashkent: "Tashkent",
    },
  };

  const dict = dictionaries[language] ?? {};
  for (const [lower, proper] of Object.entries(dict)) {
    const regex = new RegExp(`\\b${lower}\\b`, "gi");
    cleaned = cleaned.replace(regex, proper);
  }

  return cleaned;
}

