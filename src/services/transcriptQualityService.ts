import { readFileSync, existsSync } from "fs";
import { logger } from "../utils/logger";
import { config } from "../config";
import { getLanguageLabel } from "../utils/languageCodes";

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

// ---------------------------------------------------------------------------
// Оценка адекватности результата
// ---------------------------------------------------------------------------

export interface ResultConfidence {
  /** 0..100, округлено до пяти: точнее мы всё равно не знаем. */
  percent: number;
  /** Почему именно столько. Без этого число бесполезно. */
  reasons: string[];
}

/** Обычная речь идёт примерно 100–150 слов в минуту. */
const WORDS_PER_MINUTE_POOR = 20;
const WORDS_PER_MINUTE_LOW = 50;

/**
 * Насколько можно доверять расшифровке.
 *
 * Повод: таджикское видео распознали кыргызской моделью. Она вернула
 * шестнадцать пустых кусков, запрос закрылся как успешный, и пользователь
 * получил шестнадцать строк "[неразборчиво]" — результат, неотличимый по виду
 * от работы. Единственный вывод, который он мог сделать, — "бот не работает".
 *
 * Это оценка на признаках, а не вероятность: калибровать её не на чем.
 * Поэтому рядом с числом всегда идёт причина, а само число огрублено.
 */
export function assessResultConfidence(input: {
  text: string;
  language: string;
  segments?: Array<{ text: string; end: number }>;
}): ResultConfidence {
  const reasons: string[] = [];
  const text = input.text.trim();

  if (!text) {
    return { percent: 0, reasons: ["речь не распознана"] };
  }

  let score = 100;
  const segments = input.segments ?? [];

  // Пустые куски: модель слушала, но ничего не разобрала. Верный признак того,
  // что язык записи выбран не тот.
  if (segments.length > 0) {
    const empty = segments.filter((s) => !s.text?.trim()).length;
    const emptyRatio = empty / segments.length;
    if (emptyRatio > 0.5) {
      score -= 60;
      reasons.push("больше половины фрагментов не распознаны");
    } else if (emptyRatio > 0.2) {
      score -= 30;
      reasons.push("часть фрагментов не распознана");
    }
  }

  // Слишком мало слов для такой длительности — речь была, а текста нет.
  const words = extractWords(text).length;
  const durationSec = segments.length > 0 ? segments[segments.length - 1].end : 0;
  if (durationSec > 30) {
    const perMinute = words / (durationSec / 60);
    if (perMinute < WORDS_PER_MINUTE_POOR) {
      score -= 50;
      reasons.push("распознано очень мало слов для такой длительности");
    } else if (perMinute < WORDS_PER_MINUTE_LOW) {
      score -= 25;
      reasons.push("распознано мало слов для такой длительности");
    }
  }

  // Слова вне словаря: запись шумная или язык не тот.
  const quality = assessTranscript(text, input.language);
  if (quality.oovRate !== undefined) {
    if (quality.oovRate >= config.TILTAB_NOISY_TRANSCRIPT_OOV) {
      score -= 40;
      reasons.push("много слов не похожи на слова этого языка");
    } else if (quality.oovRate >= 0.1) {
      score -= 15;
      reasons.push("местами речь разобрана неуверенно");
    }
  }

  const percent = Math.max(5, Math.min(100, Math.round(score / 5) * 5));
  return { percent, reasons };
}

/**
 * Строка для начала ответа. Про низкую уверенность прямо говорится, что делать:
 * чаще всего виноват язык записи, а не бот.
 */
export function formatConfidenceLine(confidence: ResultConfidence, language: string): string {
  const { percent, reasons } = confidence;
  const head = `Уверенность бота: ${percent}%`;

  if (percent >= 80) return head;

  const why = reasons.length > 0 ? ` — ${reasons.join(", ")}` : "";
  // Название языка, а не код: "ky" человеку ничего не говорит, а сверить
  // "Кыргызча" с тем, что он слышит в записи, можно за секунду.
  const advice =
    percent <= 40
      ? `\nПроверьте, что язык записи выбран верно (сейчас: ${getLanguageLabel(language)}). ` +
        `Если речь на другом языке, выберите его и отправьте снова.`
      : "";
  return `${head}${why}.${advice}`;
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
