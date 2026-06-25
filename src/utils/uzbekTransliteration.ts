/**
 * Simple Uzbek Latin → Cyrillic transliteration.
 *
 * This is used for the `uz_cyrl` translation target: the translation module
 * first translates into Uzbek Latin, then converts the output to Cyrillic.
 */

const DIGRAPHS: Array<[string, string]> = [
  ["Oʻ", "Ў"],
  ["oʻ", "ў"],
  ["O'", "Ў"],
  ["o'", "ў"],
  ["Gʻ", "Ғ"],
  ["gʻ", "ғ"],
  ["G'", "Ғ"],
  ["g'", "ғ"],
  ["Sh", "Ш"],
  ["sh", "ш"],
  ["Ch", "Ч"],
  ["ch", "ч"],
  ["Ng", "нг"],
  ["ng", "нг"],
  ["Ye", "Е"],
  ["ye", "е"],
  ["Yo", "Ё"],
  ["yo", "ё"],
  ["Yu", "Ю"],
  ["yu", "ю"],
  ["Ya", "Я"],
  ["ya", "я"],
];

const LETTERS: Record<string, string> = {
  A: "А",
  a: "а",
  B: "Б",
  b: "б",
  D: "Д",
  d: "д",
  E: "Э",
  e: "э",
  F: "Ф",
  f: "ф",
  G: "Г",
  g: "г",
  H: "Ҳ",
  h: "ҳ",
  I: "И",
  i: "и",
  J: "Ж",
  j: "ж",
  K: "К",
  k: "к",
  L: "Л",
  l: "л",
  M: "М",
  m: "м",
  N: "Н",
  n: "н",
  O: "О",
  o: "о",
  P: "П",
  p: "п",
  Q: "Қ",
  q: "қ",
  R: "Р",
  r: "р",
  S: "С",
  s: "с",
  T: "Т",
  t: "т",
  U: "У",
  u: "у",
  V: "В",
  v: "в",
  X: "Х",
  x: "х",
  Y: "Й",
  y: "й",
  Z: "З",
  z: "з",
  "ʼ": "'",
  "'": "'",
  "`": "'",
};

/**
 * Convert Uzbek Latin text to Cyrillic.
 *
 * Note: this handles the standard Uzbek alphabet. Edge cases (loanwords,
 * Russian words mixed in) may need manual review, but it is good enough for
 * translation output.
 */
export function latinToCyrillic(input: string): string {
  let result = input;

  // Replace digraphs first so single-letter mapping does not break them.
  for (const [latin, cyrillic] of DIGRAPHS) {
    result = result.split(latin).join(cyrillic);
  }

  // Replace single letters.
  let output = "";
  for (const char of result) {
    output += LETTERS[char] ?? char;
  }

  // Fix initial E → Э (Uzbek Latin E at word start sounds like Э).
  output = output.replace(/(^|\s)Е/g, "$1Э");

  return output;
}
