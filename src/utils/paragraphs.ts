import type { TranscriptionSegment } from "../types";

/**
 * Разбивка расшифровки на абзацы.
 *
 * Распознавание отдаёт сплошной поток без единого разрыва: лингвист,
 * проверявший таджикские переводы, отдельно отметил, что читать такое
 * невозможно. Разрывы приходится ставить нам.
 *
 * Опираемся на сегменты, а не на паузы: у нашего таджикского распознавателя
 * конец сегмента равен началу, поэтому длительности пауз попросту нет. Зато
 * сам сегмент — это кусок речи в 25–30 секунд, то есть ровно тот размер, на
 * котором человек и делает абзац.
 */

/** Пометки шума занимают целый сегмент и абзацем быть не должны. */
const NOISE_ONLY = /^\s*(\[[^\]]*\]\s*)+$/;

/**
 * Слишком короткие сегменты прилепляем к предыдущему: абзац в одну строку
 * рвёт чтение сильнее, чем его отсутствие.
 */
const MIN_PARAGRAPH_CHARS = 120;

export function paragraphsFromSegments(segments: TranscriptionSegment[]): string {
  const paragraphs: string[] = [];

  for (const segment of segments) {
    const text = (segment.text ?? "").trim();
    if (!text || NOISE_ONLY.test(text)) continue;

    const previous = paragraphs[paragraphs.length - 1];
    if (previous && previous.length < MIN_PARAGRAPH_CHARS) {
      paragraphs[paragraphs.length - 1] = `${previous} ${text}`;
      continue;
    }
    paragraphs.push(text);
  }

  return paragraphs.join("\n\n");
}

/**
 * Запасной путь: разбивка готового текста по предложениям.
 *
 * Нужен там, где сегментов нет или где вычитка склеила абзацы обратно.
 * Границы здесь не смысловые, а размерные — но читаемый текст без «правильных»
 * абзацев всё равно лучше, чем правильный текст одним полотном.
 */
export function paragraphsFromSentences(text: string, targetChars = 420): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("\n\n")) return trimmed;

  const sentences = trimmed.match(/[^.!?…]+[.!?…]+["»)]?\s*|[^.!?…]+$/g);
  if (!sentences || sentences.length < 2) return trimmed;

  const paragraphs: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    current += sentence;
    if (current.length >= targetChars) {
      paragraphs.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) {
    // Хвост короче абзаца не оставляем висеть отдельно.
    if (paragraphs.length > 0 && current.trim().length < MIN_PARAGRAPH_CHARS) {
      paragraphs[paragraphs.length - 1] += ` ${current.trim()}`;
    } else {
      paragraphs.push(current.trim());
    }
  }

  return paragraphs.join("\n\n");
}
