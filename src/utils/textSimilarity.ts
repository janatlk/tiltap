/**
 * Normalize text for comparison:
 * - lowercase
 * - remove punctuation
 * - collapse whitespace
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Levenshtein distance between two strings.
 */
export function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Similarity score from 0 to 1 based on Levenshtein distance.
 */
export function similarity(a: string, b: string): number {
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - dist / maxLen;
}

/**
 * Word-level Jaccard similarity (useful for languages with flexible word order).
 */
export function wordJaccard(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.split(/\s+/).filter(Boolean));

  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);

  if (union.size === 0) return 1;
  return intersection.size / union.size;
}

/**
 * Combined similarity score (character + word), scaled to 0-100.
 */
export function combinedAccuracy(predicted: string, reference: string): number {
  const charSim = similarity(normalizeText(predicted), normalizeText(reference));
  const wordSim = wordJaccard(normalizeText(predicted), normalizeText(reference));
  const score = charSim * 0.6 + wordSim * 0.4;
  return Math.round(Math.min(1, Math.max(0, score)) * 100);
}
