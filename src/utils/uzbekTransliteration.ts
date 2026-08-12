/**
 * Simple Uzbek Latin → Cyrillic transliteration.
 *
 * This is used for the `uz_cyrl` translation target: the translation module
 * first translates into Uzbek Latin, then converts the output to Cyrillic.
 */

// "ye" даёт кириллическую "е" в любой позиции, включая начало слова ("yer" →
// "ер"). Обычная же "e" в начале слова становится "э". Чтобы правило начала
// слова не превратило "ер" в "эр", буквы из этого диграфа помечаются и
// раскрываются последними.
const YE_UPPER = "";
const YE_LOWER = "";

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
  ["Ye", YE_UPPER],
  ["ye", YE_LOWER],
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
  // Внутри слова латинская "e" — это кириллическая "е": keladi → келади.
  // В начале слова она становится "э", это делается ниже одним правилом.
  E: "Е",
  e: "е",
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
  // Туткич белгиси. В латинице он пишется апострофом, в кириллице ему
  // соответствует "ъ": taʼsir → таъсир, isteʼmol → истеъмол. Апостроф,
  // оставленный как есть, — это латинская орфография внутри кириллицы.
  "ʼ": "ъ",
  "'": "ъ",
  "’": "ъ",
  "`": "ъ",
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

  // В начале слова "е" читается как "э": eshik → эшик, eʼtibor → эътибор.
  // Граница слова — это не только пробел: кавычки, скобки и тире тоже.
  output = output.replace(/(^|[^\p{L}\p{M}])([Ее])/gu, (_match, before: string, letter: string) =>
    before + (letter === "Е" ? "Э" : "э")
  );

  // Диграф "ye" раскрывается последним, уже после правила начала слова.
  output = output.split(YE_UPPER).join("Е").split(YE_LOWER).join("е");

  return output;
}
