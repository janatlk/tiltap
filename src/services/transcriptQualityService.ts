import { readFileSync, existsSync } from "fs";
import { logger } from "../utils/logger";
import { config } from "../config";

/**
 * Определяет, что распознавание выдало мусор, и предупреждает об этом.
 *
 * Повод: лингвисты прислали запись с базара, где шум, торг и несколько голосов
 * разом. Модель выдала бессвязный набор ("Тедибиекаектериңизчи", "үзкүавай"),
 * перевод честно повторил бессмыслицу, а пользователь получил результат без
 * единого намёка на то, что доверять ему нельзя.
 *
 * Признак — доля слов, которых нет в словаре языка. Проверено на реальных
 * расшифровках с прода: у базарной записи 0.22, у следующей по "плохости"
 * 0.11, у основной массы 0.01–0.09. Порог 0.15 разделяет их с запасом.
 *
 * Что пробовали до этого и отвергли: доля коротких слов и доля латиницы. На
 * тех же данных они не разделяют ничего — у обычных русских расшифровок
 * коротких слов 0.28, а у испорченной базарной 0.09.
 */

const VOCABULARY_PATHS: Record<string, string> = {
  ky: "/opt/tiltap/models/vosk-model-ky-0.42/graph/words.txt",
  tg: "/opt/tiltap/models/vosk-model-small-tg-0.22/graph/words.txt",
};

const vocabularies = new Map<string, Set<string> | null>();

/** Слова короче трёх букв выкидываются: они одинаково часты и в мусоре, и в норме. */
const MIN_WORD_LENGTH = 3;

/**
 * На коротком куске доля скачет от одного неудачного слова, и предупреждение
 * начинает срабатывать на нормальных записях.
 */
const MIN_TOKENS = 40;

function loadVocabulary(language: string): Set<string> | null {
  if (vocabularies.has(language)) return vocabularies.get(language) ?? null;

  const path = VOCABULARY_PATHS[language];
  if (!path || !existsSync(path)) {
    vocabularies.set(language, null);
    return null;
  }

  try {
    const words = new Set<string>();
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const word = line.split(/\s+/)[0]?.trim().toLowerCase();
      // Служебные символы графа (<eps>, #0) словами не являются.
      if (word && word.length >= MIN_WORD_LENGTH && !word.startsWith("<") && !word.startsWith("#")) {
        words.add(word);
      }
    }
    logger.info("Loaded vocabulary for transcript quality check", { language, words: words.size });
    vocabularies.set(language, words);
    return words;
  } catch (err) {
    logger.warn("Failed to load vocabulary", {
      language,
      error: err instanceof Error ? err.message : String(err),
    });
    vocabularies.set(language, null);
    return null;
  }
}

export interface TranscriptQuality {
  /** Доля слов вне словаря, 0..1. undefined — проверить было нечем. */
  oovRate?: number;
  /** Сколько слов участвовало в оценке. */
  tokens: number;
  /** Похоже, что запись слишком шумная и расшифровке доверять нельзя. */
  noisy: boolean;
}

/**
 * Слова текста в нижнем регистре.
 *
 * Именно \p{L}, а не \W: в JavaScript \W остаётся ASCII-классом даже с флагом
 * u, поэтому [^\W\d_] означает "латинская буква" и на кириллице не находит ни
 * одного слова. В Python тот же шаблон работает — на этом легко обжечься, и
 * первая версия здесь обожглась: детектор молча считал ноль слов на всех
 * кириллических расшифровках и потому не срабатывал никогда.
 */
export function extractWords(text: string): string[] {
  return (text.match(/[\p{L}\p{M}]+/gu) ?? [])
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= MIN_WORD_LENGTH);
}

export function assessTranscript(text: string, language: string): TranscriptQuality {
  const vocabulary = loadVocabulary(language.toLowerCase());
  const words = extractWords(text);

  if (!vocabulary || words.length < MIN_TOKENS) {
    return { tokens: words.length, noisy: false };
  }

  let unknown = 0;
  for (const word of words) {
    if (!vocabulary.has(word)) unknown += 1;
  }
  const oovRate = unknown / words.length;

  return {
    oovRate,
    tokens: words.length,
    noisy: oovRate >= config.TILTAB_NOISY_TRANSCRIPT_OOV,
  };
}

/**
 * Текст предупреждения. Говорит, что делать, а не только что случилось:
 * "плохое качество" без совета оставляет человека ровно там же, где он был.
 */
export function noisyTranscriptWarning(): string {
  return (
    "⚠️ Запись похоже сильно зашумлена: много слов распознано неуверенно. " +
    "Расшифровка и перевод могут быть неточными. " +
    "Если возможно, пришлите запись с меньшим фоновым шумом или более чёткой речью."
  );
}
