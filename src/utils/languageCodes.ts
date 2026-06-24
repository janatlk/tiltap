/**
 * Language code normalization.
 *
 * STT providers (especially ElevenLabs Scribe v2) return ISO 639-3 codes such
 * as `kir`, `tgk`, `uzb`, `rus`, `eng`. Most of our internal code and the
 * Lingva translation front-end expect ISO 639-1 (`ky`, `tg`, `uz`, `ru`, `en`).
 * This module centralizes the mapping so callers don't have to handle it
 * everywhere.
 */

export type SupportedLanguage = "ky" | "tg" | "uz" | "ru" | "en";

const ISO_639_3_TO_1: Record<string, SupportedLanguage> = {
  // Kyrgyz
  kir: "ky",
  kyr: "ky",
  // Tajik
  tgk: "tg",
  // Uzbek
  uzb: "uz",
  // Russian
  rus: "ru",
  // English
  eng: "en",
};

// Some Whisper providers return full language names instead of codes.
const NAME_TO_CODE: Record<string, SupportedLanguage> = {
  kazakh: "ky",
  kyrgyz: "ky",
  tajik: "tg",
  uzbek: "uz",
  russian: "ru",
  english: "en",
};

const CANONICAL_CODES = new Set<string>(["ky", "tg", "uz", "ru", "en"]);

/**
 * Normalize a language code to our internal 2-letter canonical form.
 * Returns `undefined` for unknown codes (callers may treat it as "auto").
 */
export function normalizeLanguageCode(code: string | undefined): SupportedLanguage | undefined {
  if (!code) return undefined;
  const lower = code.trim().toLowerCase();
  if (lower === "auto" || lower === "multi") return undefined;
  if (CANONICAL_CODES.has(lower)) return lower as SupportedLanguage;
  return ISO_639_3_TO_1[lower] ?? NAME_TO_CODE[lower];
}

/**
 * Normalize a language code, falling back to the original string if unknown.
 * Useful when preserving provider-specific codes is safer than dropping them.
 */
export function normalizeLanguageCodeOrKeep(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const normalized = normalizeLanguageCode(code);
  return normalized ?? code;
}

/**
 * Return a human-readable label for a supported language.
 */
export function getLanguageLabel(code: string | undefined): string {
  const labels: Record<string, string> = {
    ky: "Кыргызча",
    tg: "Тоҷикӣ",
    uz: "O'zbekcha",
    ru: "Русский",
    en: "English",
  };
  return labels[normalizeLanguageCode(code) ?? code ?? ""] ?? code ?? "auto";
}
