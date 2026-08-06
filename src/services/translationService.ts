import { logger } from "../utils/logger";
import { config } from "../config";
import type { TranslateRequest, TranslateResponse } from "../types";
import { normalizeLanguageCodeOrKeep } from "../utils/languageCodes";
import { latinToCyrillic } from "../utils/uzbekTransliteration";
import { similarity } from "../utils/textSimilarity";
import { createHash } from "crypto";
import * as translationRepo from "../db/repos/translationRepo";
import * as glossaryRepo from "../db/repos/glossaryRepo";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const AZURE_TRANSLATOR_API_VERSION = "3.0";

// Keep each LLM translation request small enough that its output cannot exceed
// the max_tokens budget (which would truncate mid-sentence, invisibly to the
// user). The previous 4000 assumed ~2 chars/token, which only holds for Latin
// script: our targets are mostly Cyrillic, where the tokenizer is far less
// efficient and a 4000-char chunk regularly blew past the cap.
const TRANSLATION_CHUNK_CHARS = 2500;

// Azure Translator character cost (USD per character).
const AZURE_TRANSLATOR_COST_PER_CHAR = 10 / 1_000_000;
// Yandex Translate character cost (USD per character).
const YANDEX_TRANSLATE_COST_PER_CHAR = 4.101_638_688 / 1_000_000;

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
    costUsd: 0,
    model: "lingva",
  };
}

// ---------------------------------------------------------------------------
// Azure Translator — cheap paid NMT fallback
// ---------------------------------------------------------------------------

function mapAzureLanguage(code: string | undefined): string {
  if (!code || code === "auto" || code === "multi") return "auto";
  const normalized = normalizeLanguageCodeOrKeep(code) ?? code;
  // Azure uses ISO 639-1 codes like Lingva/Google.
  if (normalized === "uz_cyrl") return "uz";
  return normalized;
}

async function translateWithAzure(req: TranslateRequest): Promise<TranslateResponse> {
  const key = config.AZURE_TRANSLATOR_KEY;
  if (!key) {
    throw new Error("AZURE_TRANSLATOR_KEY is not configured");
  }

  const endpoint = (config.AZURE_TRANSLATOR_ENDPOINT || "https://api.cognitive.microsofttranslator.com").replace(/\/$/, "");
  const region = config.AZURE_TRANSLATOR_REGION;
  const source = mapAzureLanguage(req.sourceLang);
  const target = mapAzureLanguage(req.targetLang);
  const chunkSize = 5000; // Azure max request size is 50K chars; keep chunks safe.
  const chunks = chunkText(req.text, chunkSize);

  logger.info("Azure Translator started", { chunks: chunks.length, target, source });

  const params = new URLSearchParams({ "api-version": AZURE_TRANSLATOR_API_VERSION, to: target });
  if (source !== "auto") params.set("from", source);
  const url = `${endpoint}/translate?${params.toString()}`;

  const translatedChunks: string[] = [];
  let totalChars = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    totalChars += chunk.length;
    const headers: Record<string, string> = {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/json",
    };
    if (region && region.toLowerCase() !== "global") {
      headers["Ocp-Apim-Subscription-Region"] = region;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify([{ Text: chunk }]),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Azure Translator failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as Array<{
      translations: Array<{ text: string; to: string }>;
    }>;
    const text = data[0]?.translations?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error("Azure Translator returned unexpected response format");
    }
    translatedChunks.push(text);
  }

  const costUsd = totalChars * AZURE_TRANSLATOR_COST_PER_CHAR;
  logger.info("Azure Translator finished", { chunks: chunks.length, totalChars, costUsd });

  return {
    translatedText: translatedChunks.join("\n\n"),
    detectedLang: source === "auto" ? "auto" : source,
    costUsd,
    model: "azure-translator",
  };
}

// ---------------------------------------------------------------------------
// Yandex Translate — cheap paid NMT fallback, strong for Russian pairs
// ---------------------------------------------------------------------------

function mapYandexLanguage(code: string | undefined): string {
  if (!code || code === "auto" || code === "multi") return "auto";
  const normalized = normalizeLanguageCodeOrKeep(code) ?? code;
  if (normalized === "uz_cyrl") return "uz";
  return normalized;
}

async function translateWithYandex(req: TranslateRequest): Promise<TranslateResponse> {
  const key = config.YANDEX_TRANSLATE_API_KEY;
  if (!key) {
    throw new Error("YANDEX_TRANSLATE_API_KEY is not configured");
  }

  const endpoint = (config.YANDEX_TRANSLATE_ENDPOINT || "https://translate.api.cloud.yandex.net/translate/v2/translate").replace(/\/$/, "");
  const folderId = config.YANDEX_TRANSLATE_FOLDER_ID;
  const source = mapYandexLanguage(req.sourceLang);
  const target = mapYandexLanguage(req.targetLang);

  // Yandex recommends max ~10K chars per request.
  const chunkSize = 5000;
  const chunks = chunkText(req.text, chunkSize);

  logger.info("Yandex Translate started", { chunks: chunks.length, target, source });

  const translatedChunks: string[] = [];
  let totalChars = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    totalChars += chunk.length;

    const body: Record<string, unknown> = {
      targetLanguageCode: target,
      texts: [chunk],
      format: "PLAIN_TEXT",
    };
    if (source !== "auto") body.sourceLanguageCode = source;
    if (folderId) body.folderId = folderId;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Yandex Translate failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as { translations: Array<{ text: string }> };
    const translated = data.translations?.[0]?.text;
    if (typeof translated !== "string") {
      throw new Error("Yandex Translate returned unexpected response format");
    }
    translatedChunks.push(translated);
  }

  const costUsd = totalChars * YANDEX_TRANSLATE_COST_PER_CHAR;
  logger.info("Yandex Translate finished", { chunks: chunks.length, totalChars, costUsd });

  return {
    translatedText: translatedChunks.join("\n\n"),
    detectedLang: source === "auto" ? "auto" : source,
    costUsd,
    model: "yandex-translate",
  };
}

// ---------------------------------------------------------------------------
// OpenAI LLM translation
// ---------------------------------------------------------------------------

function buildSystemPrompt(targetName: string, sourceName?: string): string {
  const sourceHint =
    sourceName && sourceName !== "auto"
      ? `from ${sourceName} into ${targetName}`
      : `into ${targetName}`;

  return (
    `Translate the SOURCE text ${sourceHint}. ` +
    "Rules: translate every sentence and word; preserve sentence structure and repetitions; " +
    "keep names, numbers, and dates accurate; use established target-language forms for names when they exist; " +
    "do not add, omit, infer, reframe, or explain. " +
    // Sources reach us from speech recognition and from users pasting text, so
    // stray sentence breaks are common. Carrying one through produces a
    // fragment in the target language that reads as a translation error, when
    // the punctuation was wrong to begin with. Rejoining is the one structural
    // liberty worth allowing: it changes no wording and adds no meaning.
    "One exception to preserving structure: if a sentence break is clearly a " +
    "typo — a full stop followed by a lower-case word, or a fragment that " +
    "cannot stand alone — treat the parts as one sentence and translate them " +
    "as such. Never split or merge sentences for any other reason. " +
    "Output only the translation, no markdown, no XML, no notes."
  );
}


// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------

export interface GlossaryMatch {
  term: string;
  translation: string;
  note?: string | null;
}

/**
 * Find glossary terms that occur in the text.
 *
 * Matching is prefix-based on purpose. Kyrgyz and Uzbek are agglutinative:
 * a term appears in running text with case and possessive suffixes attached
 * ("китеп" -> "китепти", "китебинде"), so requiring an exact word would miss
 * nearly every real occurrence. Short terms are matched exactly instead,
 * because a three-letter prefix would fire on half the vocabulary.
 */
export function findGlossaryMatches(
  text: string,
  entries: { term: string; translation: string; note?: string | null }[]
): GlossaryMatch[] {
  const lower = text.toLowerCase();
  // Split on anything that is not a letter, digit or hyphen, so word-internal
  // hyphens survive but punctuation does not glue onto the token.
  const words = lower.split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
  const wordSet = new Set(words);

  const matches: GlossaryMatch[] = [];
  for (const entry of entries) {
    const term = entry.term.toLowerCase().trim();
    if (!term) continue;

    let hit: boolean;
    if (term.includes(" ")) {
      // Multi-word terms: look them up in the raw text, since the words must
      // stay adjacent for the term to mean what the glossary says.
      hit = lower.includes(term);
    } else if (term.length <= 3) {
      hit = wordSet.has(term);
    } else {
      hit = wordSet.has(term) || words.some((w) => w.startsWith(term));
    }

    if (hit) {
      matches.push({ term: entry.term, translation: entry.translation, note: entry.note });
    }
  }
  return matches;
}

/** Load the glossary for a direction and match it against the text. */
async function glossaryFor(text: string, sourceLang: string, targetLang: string): Promise<GlossaryMatch[]> {
  if (!config.TILTAB_GLOSSARY_ENABLED) return [];
  try {
    const entries = await glossaryRepo.listForDirection(sourceLang, targetLang);
    if (entries.length === 0) return [];
    const matches = findGlossaryMatches(text, entries);
    const cap = config.TILTAB_GLOSSARY_MAX_TERMS || 120;
    // listForDirection already orders by term length descending, so slicing
    // keeps the most specific terms and drops the generic ones first.
    const applied = matches.slice(0, cap);
    if (matches.length > 0) {
      logger.info("Glossary terms applied", {
        sourceLang,
        targetLang,
        matched: matches.length,
        applied: applied.length,
        available: entries.length,
        ...(matches.length > cap ? { droppedOverCap: matches.length - cap } : {}),
      });
    }
    return applied;
  } catch (err) {
    // The glossary improves a translation; it must never prevent one.
    logger.warn("Glossary lookup failed, translating without it", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function glossaryPrompt(matches: GlossaryMatch[]): string {
  if (matches.length === 0) return "";
  const lines = matches.map((m) =>
    m.note ? `${m.term} = ${m.translation} (${m.note})` : `${m.term} = ${m.translation}`
  );
  return (
    " A glossary of approved translations for terms appearing in this text is " +
    "given below. Use exactly these renderings, adjusting only grammatical form " +
    "to fit the sentence:\n" +
    lines.join("\n")
  );
}

function buildPayload(
  targetName: string,
  sourceName: string | undefined,
  text: string,
  model: string,
  maxTokens?: number,
  glossary: GlossaryMatch[] = []
): object {
  const payload: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "system",
        content: buildSystemPrompt(targetName, sourceName) + glossaryPrompt(glossary),
      },
      {
        role: "user",
        content: `<SOURCE>\n${text}\n</SOURCE>`,
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
): Promise<{ text: string; costUsd: number }> {
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
  const costUsd = logTranslationCost(providerName.toLowerCase(), model, data.usage?.prompt_tokens ?? 0, completionTokens);

  if (maxTokens && completionTokens >= maxTokens) {
    logger.warn(`${providerName} translation hit max_tokens and may be truncated`, {
      model,
      completionTokens,
      maxTokens,
    });
    throw new TranslationTruncatedError(providerName);
  }

  return { text: data.choices[0]?.message?.content?.trim() ?? "", costUsd };
}

function logTranslationCost(provider: string, model: string, promptTokens: number, completionTokens: number): number {
  const prices: Record<string, { prompt: number; completion: number }> = {
    "gpt-4o-mini": { prompt: 0.15, completion: 0.6 },
    "gpt-4o": { prompt: 2.5, completion: 10.0 },
    "gpt-4.1-mini": { prompt: 0.4, completion: 1.6 },
    "gpt-4.1": { prompt: 2.0, completion: 8.0 },
    "llama-3.3-70b-versatile": { prompt: 0.59, completion: 0.79 },
  };
  const price = prices[model] ?? { prompt: 0, completion: 0 };
  const costUsd = (promptTokens * price.prompt + completionTokens * price.completion) / 1_000_000;
  logger.info("Translation cost", { provider, model, promptTokens, completionTokens, costUsd: Math.round(costUsd * 1e6) / 1e6 });
  return costUsd;
}

// Budget output tokens. Non-Latin scripts (Cyrillic Tajik/Uzbek/Kyrgyz/Russian)
// tokenize at roughly 2 characters per token, and a translation can be somewhat
// longer than its source, so reserve input-length/2 plus a margin. The old
// input/3 estimate under-budgeted badly for Cyrillic and caused truncation.
// Long inputs are chunked (see TRANSLATION_CHUNK_CHARS) so this stays under cap.
function estimateMaxTokens(text: string, cap: number): number {
  // Budget ~1.2 tokens per character. That is deliberately pessimistic for
  // Latin text and roughly right for Cyrillic; under-budgeting silently
  // truncates the user's translation, over-budgeting costs nothing because
  // billing is on tokens actually produced.
  return Math.min(cap, Math.max(256, Math.ceil(text.length * 1.2) + 512));
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

// Translate one piece of text with OpenAI. If the model still hits max_tokens
// (should not happen for chunk-sized input, but is possible on pathological
// input), split the text and retry so the user never sees a truncation error.
async function translateChunkWithOpenAI(
  text: string,
  targetName: string,
  sourceName: string | undefined,
  model: string,
  apiKey: string,
  glossary: GlossaryMatch[] = []
): Promise<{ text: string; costUsd: number }> {
  const cap = config.TILTAB_TRANSLATION_MAX_TOKENS || 4096;
  const maxTokens = estimateMaxTokens(text, cap);
  try {
    return await callTranslationProvider(
      OPENAI_API_URL,
      apiKey,
      buildPayload(targetName, sourceName, text, model, maxTokens, glossary),
      "OpenAI",
      maxTokens
    );
  } catch (err) {
    // Only truncation is recoverable by splitting; anything else propagates.
    if (!(err instanceof TranslationTruncatedError) || text.length < 400) {
      throw err;
    }
    logger.warn("OpenAI translation chunk truncated; splitting and retrying", { chars: text.length });
    const halves = chunkText(text, Math.ceil(text.length / 2));
    const parts: string[] = [];
    let cost = 0;
    for (const half of halves) {
      const r = await translateChunkWithOpenAI(half, targetName, sourceName, model, apiKey, glossary);
      parts.push(r.text);
      cost += r.costUsd;
    }
    return { text: parts.join("\n\n"), costUsd: cost };
  }
}

/**
 * Choose the translation model from the language pair.
 *
 * The cheap mini model is only good enough when both ends are high-resource
 * languages. On Kyrgyz, Tajik and Uzbek it invents word forms and produces
 * Russian/Turkic hybrids, so anything touching those — or an unknown source,
 * which may well be one of them — goes to the stronger model. The price
 * difference is a fraction of a cent per request, so quality wins.
 */
function pickTranslationModel(sourceLang: string, targetLang: string): string {
  const lowResource = config.TILTAB_LOWRESOURCE_LANGUAGES;
  const strong = config.TILTAB_TRANSLATION_MODEL_LOWRESOURCE || "gpt-4o";
  const cheap = config.TILTAB_TRANSLATION_MODEL || "gpt-4o-mini";

  const source = sourceLang.toLowerCase();
  const target = targetLang.toLowerCase();
  const needsStrong =
    source === "auto" ||
    lowResource.includes(source) ||
    lowResource.includes(target);

  return needsStrong ? strong : cheap;
}

async function translateWithOpenAI(
  req: TranslateRequest,
  options: { skipCache?: boolean; model?: string; skipSave?: boolean } = {}
): Promise<TranslateResponse> {
  const openaiKey = config.OPENAI_API_KEY;
  if (!openaiKey) {
    throw new Error("OPENAI_API_KEY is not configured for translation");
  }
  const targetName = languageNames[req.targetLang] ?? req.targetLang;
  const declared = normalizeLanguageCodeOrKeep(req.sourceLang) ?? "auto";
  // Pasted text arrives without a language. Naming one when the script makes it
  // obvious is what stops the model from mistaking garbled Kyrgyz for Russian
  // and returning it untranslated.
  const guessed = declared === "auto" ? guessSourceLanguage(req.text) : undefined;
  const sourceLang = guessed ?? declared;
  if (guessed) {
    logger.info("Guessed source language from script", { guessed, targetLang: req.targetLang });
  }
  const sourceName = sourceLang === "auto" ? undefined : (languageNames[sourceLang] ?? sourceLang);
  const hash = createHash("sha256").update(req.text).digest("hex");

  if (!options.skipCache) {
    const cached = await translationRepo.getConfirmedTranslationCache(hash, req.targetLang);
    if (cached) {
      logger.info("Translation confirmed cache hit", { targetLang: req.targetLang, sourceLang });
      return { translatedText: cached.translated_text, detectedLang: sourceLang };
    }
  }

  // The override exists for the beta comparison page, which needs to run the
  // same code path on a named model rather than the one routing would choose.
  const model = options.model || pickTranslationModel(sourceLang, req.targetLang);

  // Chunk long inputs so no single request can hit the output token limit.
  const chunks =
    req.text.length > TRANSLATION_CHUNK_CHARS ? chunkText(req.text, TRANSLATION_CHUNK_CHARS) : [req.text];

  // Matched once against the whole text, not per chunk: a term can appear in
  // one chunk and its translation must stay consistent across all of them.
  const glossary = await glossaryFor(req.text, sourceLang, req.targetLang);

  const parts: string[] = [];
  let costUsd = 0;
  for (const chunk of chunks) {
    const r = await translateChunkWithOpenAI(chunk, targetName, sourceName, model, openaiKey, glossary);
    parts.push(r.text);
    costUsd += r.costUsd;
  }
  const translatedText = parts.join("\n\n");

  logger.info("Translated with OpenAI", { targetLang: req.targetLang, model, chunks: chunks.length, costUsd });
  // Comparison runs must not write to the cache: they deliberately produce
  // several translations of the same text, and the last one to finish would
  // otherwise become the cached answer for real users.
  if (!options.skipSave) {
    await translationRepo.saveTranslationCache({
      sourceHash: hash,
      sourceText: req.text,
      sourceLang,
      targetLang: req.targetLang,
      translatedText,
      provider: "openai",
      model,
      costUsd,
    });
  }
  return { translatedText, detectedLang: sourceLang, costUsd, model };
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

const COMMON_UNTRANSLATED_TERMS = new Set([
  "google",
  "translate",
  "google translate",
  "youtube",
  "instagram",
  "tiktok",
  "facebook",
  "whatsapp",
  "telegram",
  "twitter",
  "x",
  "netflix",
  "amazon",
  "apple",
  "microsoft",
  "openai",
  "chatgpt",
  "gpt",
  "ai",
]);

function isCommonUntranslatedTerm(word: string): boolean {
  return COMMON_UNTRANSLATED_TERMS.has(word.toLowerCase().replace(/[^a-zа-яёўқғҳңөүӯӣҷ0-9]/gi, ""));
}

/**
 * Guess the source language from script-specific letters when the caller does
 * not know it.
 *
 * Saying "auto" is honest but costly with same-script pairs: asked to render
 * garbled Kyrgyz into Russian, the model looks at Cyrillic it cannot parse,
 * concludes the text is already Russian, and hands it straight back. Measured
 * on a real report — the same text with "ky" stated translated correctly, and
 * the same text into English worked either way, because there the scripts
 * differ and no such confusion is possible.
 *
 * A guess only, so it stays silent unless the evidence is unambiguous: the
 * markers must appear, and one language must clearly lead. Russian carries no
 * markers of its own and so is never guessed — it simply falls through to auto,
 * which is where the model is already reliable.
 */
export function guessSourceLanguage(text: string): string | undefined {
  const scores = Object.entries(sourceSpecificLetters).map(([lang, markers]) => {
    let hits = 0;
    for (const ch of text.toLowerCase()) {
      if (markers.includes(ch)) hits += 1;
    }
    return { lang, hits };
  });

  scores.sort((a, b) => b.hits - a.hits);
  const [best, runnerUp] = scores;
  if (!best || best.hits < 2) return undefined;
  // Tajik and Uzbek Cyrillic share қ, ғ and ҳ, so a narrow win proves nothing.
  if (runnerUp && best.hits < runnerUp.hits * 2) return undefined;
  return best.lang;
}

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
    if (words) words.filter((w) => !isCommonUntranslatedTerm(w)).forEach((w) => fragments.add(w));
  }

  if (sourceScript === "latin" && targetScript === "cyrillic") {
    const words = text.match(/[a-zA-Z]{4,}/g);
    if (words) words.filter((w) => !isCommonUntranslatedTerm(w)).forEach((w) => fragments.add(w));
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
    `Review a translation from ${sourceName} to ${targetName}. ` +
    `You may fix only: untranslated fragments, inconsistent names/terms, invented names, or awkward phrasing. ` +
    `Preserve meaning exactly; do not add, remove, reframe, or explain. ` +
    `If the translation is already accurate and natural, return corrected identical to the Translation, issues=[], warning=null. ` +
    `Return warning only when a concrete problem remains that a user should know about. ` +
    `Do not warn about minor style differences or awkward phrasing that you have already corrected. ` +
    `Return JSON: {"corrected":"...","issues":[],"warning":null|string}. No markdown.\n\n` +
    `Source:\n${sourceText}\n\n` +
    `Translation:\n${translatedText}`;

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
  previousCostUsd = 0
): Promise<{ reviewedText: string; warning?: string; costUsd: number }> {
  if (!config.TILTAB_REVIEW_ENABLED) {
    return { reviewedText: translatedText, costUsd: previousCostUsd };
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
    return { reviewedText: translatedText, costUsd: previousCostUsd };
  }

  const key = config.OPENAI_API_KEY;
  // A reviewer weaker than the translator is pointless: for low-resource pairs
  // the mini model cannot judge what it could not translate in the first place.
  const model = config.TILTAB_REVIEW_MODEL || pickTranslationModel(sourceLang, req.targetLang);

  if (!key) {
    return { reviewedText: translatedText, costUsd: previousCostUsd };
  }

  const maxTokens = estimateMaxTokens(req.text + translatedText, config.TILTAB_REVIEW_MAX_TOKENS || 4096);
  const { text: raw, costUsd: reviewCostUsd } = await callTranslationProvider(
    OPENAI_API_URL,
    key,
    buildReviewPayload(req.text, translatedText, sourceName, targetName, model, maxTokens),
    "OpenAI-review",
    maxTokens
  );
  const totalCostUsd = previousCostUsd + reviewCostUsd;
  const parsed = parseReviewResponse(raw);

  let reviewedText = parsed.corrected || translatedText;
  const reviewSimilarity = similarity(translatedText, reviewedText);
  if (reviewSimilarity < 0.75) {
    logger.warn("Review changed translation too much; discarding correction", {
      sourceLang,
      targetLang: req.targetLang,
      provider: "openai",
      similarity: reviewSimilarity,
    });
    reviewedText = translatedText;
  }

  logger.info("Translation review complete", { totalCostUsd, reviewCostUsd,
    sourceLang,
    targetLang: req.targetLang,
    provider: "openai",
    issues: parsed.issues,
  });

  const heuristicFragments = detectUntranslatedFragments(reviewedText, sourceLang, req.targetLang);
  let warning: string | undefined;
  if (parsed.issues.length > 0 || heuristicFragments.length > 0) {
    warning = parsed.warning ?? undefined;
    if (!warning && heuristicFragments.length > 0) {
      warning = `В переводе могут остаться непереведённые фрагменты: ${heuristicFragments.join(", ")}.`;
    }
  } else if (parsed.warning) {
    logger.info("Ignoring generic review warning", { warning: parsed.warning, sourceLang, targetLang: req.targetLang });
  }

  return { reviewedText, warning, costUsd: totalCostUsd };
}

function mockTranslation(req: TranslateRequest): TranslateResponse {
  logger.warn("No translation provider available, returning mock translation");
  return {
    translatedText: `[MOCK TRANSLATION to ${req.targetLang}]\n\n${req.text}`,
    detectedLang: "auto",
    costUsd: 0,
    model: "mock",
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
        logger.error("Failed to delete bad translation cache", { error: err instanceof Error ? err.message : String(err), hash });
      });
    } else {
      return { translatedText: cached.translated_text, detectedLang: sourceLang };
    }
  }

  // Tajik texts need accurate handling of Arabic/Cyrillic script and named entities.
  // Use OpenAI first; Lingva is not good enough for Tajik.
  const isTajikTranslation = translateReq.targetLang === "tg" || translateReq.sourceLang === "tg";

  let result: TranslateResponse | undefined;

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
  const hasOpenAi = Boolean(config.OPENAI_API_KEY);
  const hasAzure = Boolean(config.AZURE_TRANSLATOR_KEY);
  const hasYandex = Boolean(config.YANDEX_TRANSLATE_API_KEY);
  const hasLingva = Boolean(config.LINGVA_TRANSLATE_URL);

  // Tajik and Uzbek Cyrillic strongly prefer LLMs because of script/entity handling.
  const prefersLlm = isTajikTranslation || translateReq.targetLang === "uz_cyrl";

  async function tryLingva(): Promise<TranslateResponse> {
    if (!hasLingva) throw new Error("Lingva not configured");
    return await translateWithLingva(translateReq);
  }
  async function tryAzure(): Promise<TranslateResponse> {
    if (!hasAzure) throw new Error("Azure Translator not configured");
    return await translateWithAzure(translateReq);
  }
  async function tryYandex(): Promise<TranslateResponse> {
    if (!hasYandex) throw new Error("Yandex Translate not configured");
    return await translateWithYandex(translateReq);
  }
  async function tryOpenAI(): Promise<TranslateResponse> {
    if (!hasOpenAi) throw new Error("No LLM provider configured (OPENAI_API_KEY missing)");
    return await translateWithOpenAI(translateReq);
  }

  if (provider === "lingva" && !isTajikTranslation) {
    result = await tryLingva();
  } else if (provider === "azure") {
    result = await tryAzure();
  } else if (provider === "yandex") {
    result = await tryYandex();
  } else if (provider === "openai") {
    result = await tryOpenAI();
  } else if (provider === "mock") {
    result = mockTranslation(translateReq);
  } else if (prefersLlm && hasOpenAi) {
    // Tajik / uz_cyrl: use LLM first for best script/entity handling.
    result = await tryOpenAI();
  } else {
    // Default auto chain: free → cheap paid NMT → LLM → mock.
    const errors: string[] = [];
    if (hasLingva) {
      try {
        result = await tryLingva();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Lingva translation failed, trying next provider", { error: msg });
        errors.push(`Lingva: ${msg}`);
      }
    }
    if (!result && hasYandex) {
      try {
        result = await tryYandex();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Yandex translation failed, trying next provider", { error: msg });
        errors.push(`Yandex: ${msg}`);
      }
    }
    if (!result && hasAzure) {
      try {
        result = await tryAzure();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Azure translation failed, trying next provider", { error: msg });
        errors.push(`Azure: ${msg}`);
      }
    }
    if (!result && hasOpenAi) {
      try {
        result = await tryOpenAI();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("OpenAI translation failed", { error: msg });
        errors.push(`LLM: ${msg}`);
      }
    }
    if (!result) {
      if (errors.length > 0) {
        logger.error("All translation providers failed", { errors });
      }
      result = mockTranslation(translateReq);
    }
  }

  // TypeScript narrowing: by this point result is always assigned.
  if (!result) {
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
  if (config.TILTAB_REVIEW_ENABLED && config.OPENAI_API_KEY) {
    const initialCostUsd = result.costUsd ?? 0;
    try {
      const reviewed = await reviewTranslation(translateReq, result.translatedText, initialCostUsd);
      result.translatedText = reviewed.reviewedText;
      result.costUsd = reviewed.costUsd;
      if (reviewed.warning) {
        result.warning = result.warning ? `${result.warning} ${reviewed.warning}` : reviewed.warning;
      }
    } catch (err) {
      // Review is fail-soft: never surface its failure to the user.
      logger.warn("Translation review failed", { error: err instanceof Error ? err.message : String(err) });
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
  // Only a placeholder for the failure paths below: the real model is chosen
  // per language pair inside doTranslate and comes back on the result, so
  // recording the configured default here would misreport every low-resource
  // translation as the cheap model that never ran.
  const configuredModel = config.TILTAB_TRANSLATION_MODEL || "unknown";

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
        costUsd: 0,
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
      model: result.model ?? configuredModel,
      sourceUrl: translateReq.sourceUrl,
      sourceType: translateReq.sourceType,
      requestNumber,
      costUsd: result.costUsd,
    });

    await translationRepo.saveTranslationRequest({
      sourceHash: hash,
      sourceText: translateReq.text,
      sourceLang,
      targetLang: translateReq.targetLang,
      translatedText: result.translatedText,
      provider: provider ?? "auto",
      model: result.model ?? configuredModel,
      status: "pending",
      sourceUrl: translateReq.sourceUrl,
      sourceType: translateReq.sourceType,
      requestNumber,
      costUsd: result.costUsd,
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
      model: configuredModel,
      sourceUrl: translateReq.sourceUrl,
      sourceType: translateReq.sourceType,
      requestNumber,
      costUsd: 0,
    }).catch((logErr) => {
      logger.error("Failed to log translation error", { error: logErr instanceof Error ? logErr.message : String(logErr) });
    });

    await translationRepo.saveTranslationRequest({
      sourceHash: hash,
      sourceText: translateReq.text,
      sourceLang,
      targetLang: translateReq.targetLang,
      provider: provider ?? "auto",
      model: configuredModel,
      status: "error",
      errorMessage,
      sourceUrl: translateReq.sourceUrl,
      sourceType: translateReq.sourceType,
      requestNumber,
      costUsd: 0,
    }).catch((logErr) => {
      logger.error("Failed to log translation request", { error: logErr instanceof Error ? logErr.message : String(logErr) });
    });

    throw err;
  }
}


// ---------------------------------------------------------------------------
// Beta comparison
//
// Runs one text through every translation engine the project has, so the
// options can be judged side by side on real input instead of in the abstract.
// Nothing here writes to the cache or the audit log: a comparison produces
// several competing translations of the same text, and letting any of them
// reach the cache would poison the answer real users get.
// ---------------------------------------------------------------------------

export interface TranslationEngineInfo {
  /** Stable id used by the API and the UI. */
  id: string;
  label: string;
  /** Why the engine cannot run, when it cannot. */
  unavailable?: string;
  /** Roughly what a million characters through this engine costs, for orientation. */
  pricing: string;
}

export interface EngineComparisonResult extends TranslationEngineInfo {
  translatedText?: string;
  model?: string;
  durationMs: number;
  costUsd?: number;
  error?: string;
  /** Flags from the same quality check that guards production translations. */
  qualityFlags?: string[];
  /** True for the engine production would have chosen for this language pair. */
  isProductionChoice?: boolean;
}

export function listTranslationEngines(): TranslationEngineInfo[] {
  const strong = config.TILTAB_TRANSLATION_MODEL_LOWRESOURCE || "gpt-4o";
  const cheap = config.TILTAB_TRANSLATION_MODEL || "gpt-4o-mini";
  return [
    {
      id: `openai:${cheap}`,
      label: `OpenAI ${cheap}`,
      pricing: "$0.15 / $0.60 за 1M токенов",
      unavailable: config.OPENAI_API_KEY ? undefined : "OPENAI_API_KEY не задан",
    },
    {
      id: `openai:${strong}`,
      label: `OpenAI ${strong}`,
      pricing: "$2.50 / $10.00 за 1M токенов",
      unavailable: config.OPENAI_API_KEY ? undefined : "OPENAI_API_KEY не задан",
    },
    {
      id: "lingva",
      label: "Lingva (Google Translate)",
      pricing: "бесплатно",
      unavailable: config.LINGVA_TRANSLATE_URL ? undefined : "LINGVA_TRANSLATE_URL не задан",
    },
    {
      id: "azure",
      label: "Azure Translator",
      pricing: "$10 за 1M символов",
      unavailable: config.AZURE_TRANSLATOR_KEY ? undefined : "AZURE_TRANSLATOR_KEY не задан",
    },
    {
      id: "yandex",
      label: "Yandex Translate",
      pricing: "$4.10 за 1M символов",
      unavailable: config.YANDEX_TRANSLATE_API_KEY ? undefined : "YANDEX_TRANSLATE_API_KEY не задан",
    },
  ];
}

/** The engine id production routing would pick for this pair. */
export function productionEngineId(sourceLang: string, targetLang: string): string {
  const provider = config.TILTAB_TRANSLATION_PROVIDER;
  if (provider === "openai" || provider === "auto") {
    return `openai:${pickTranslationModel(normalizeLanguageCodeOrKeep(sourceLang) ?? "auto", targetLang)}`;
  }
  return provider;
}

async function runEngine(id: string, req: TranslateRequest): Promise<TranslateResponse> {
  if (id.startsWith("openai:")) {
    return await translateWithOpenAI(req, {
      model: id.slice("openai:".length),
      skipCache: true,
      skipSave: true,
    });
  }
  if (id === "lingva") return await translateWithLingva(req);
  if (id === "azure") return await translateWithAzure(req);
  if (id === "yandex") return await translateWithYandex(req);
  throw new Error(`Unknown engine: ${id}`);
}

export async function compareTranslationEngines(
  req: TranslateRequest,
  engineIds?: string[]
): Promise<EngineComparisonResult[]> {
  const all = listTranslationEngines();
  const selected = engineIds?.length ? all.filter((e) => engineIds.includes(e.id)) : all;
  const productionChoice = productionEngineId(req.sourceLang ?? "auto", req.targetLang);

  // In parallel: these are independent providers, and a serial run of five
  // engines over a long text is slow enough that nobody would use the page.
  return await Promise.all(
    selected.map(async (engine): Promise<EngineComparisonResult> => {
      const base: EngineComparisonResult = {
        ...engine,
        durationMs: 0,
        isProductionChoice: engine.id === productionChoice,
      };
      if (engine.unavailable) return base;

      const started = Date.now();
      try {
        const result = await runEngine(engine.id, req);
        return {
          ...base,
          durationMs: Date.now() - started,
          translatedText: result.translatedText,
          model: result.model,
          costUsd: result.costUsd,
          qualityFlags: detectTranslationIssues(result.translatedText).flags,
        };
      } catch (err) {
        // Providers that answer with an HTML error page (a Cloudflare challenge,
        // for one) would otherwise dump the whole document into the UI.
        const raw = err instanceof Error ? err.message : String(err);
        return {
          ...base,
          durationMs: Date.now() - started,
          error: raw.length > 300 ? raw.slice(0, 300) + "…" : raw,
        };
      }
    })
  );
}
