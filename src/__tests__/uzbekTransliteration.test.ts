import { test, describe } from "node:test";
import assert from "node:assert";
import { latinToCyrillic } from "../utils/uzbekTransliteration";

/**
 * Слова взяты из отчёта лингвистов "СУНУШТАР БОТ БОЮНЧА" (12.08.2026): это
 * ровно то, что бот выдавал неправильно. Тест держит именно их, чтобы правка
 * проверялась на настоящих жалобах, а не на придуманных примерах.
 */
describe("latinToCyrillic", () => {
  test("латинская e внутри слова даёт е, а не э", () => {
    const cases: Array<[string, string]> = [
      ["keladi", "келади"],
      ["beramiz", "берамиз"],
      ["teri", "тери"],
      ["kelgan", "келган"],
      ["kerakli", "керакли"],
      ["berib", "бериб"],
      ["deydi", "дейди"],
      ["kelasi", "келаси"],
      ["kelishni", "келишни"],
      ["Batkendagi", "Баткендаги"],
    ];
    for (const [latin, expected] of cases) {
      assert.strictEqual(latinToCyrillic(latin), expected, latin);
    }
  });

  test("туткич белгиси становится ъ, а не апострофом", () => {
    const cases: Array<[string, string]> = [
      ["taʼsir", "таъсир"],
      ["isteʼmol", "истеъмол"],
      ["meʼda", "меъда"],
      ["maʼlum", "маълум"],
      ["eʼtibor", "эътибор"],
    ];
    for (const [latin, expected] of cases) {
      assert.strictEqual(latinToCyrillic(latin), expected, latin);
    }
    // Тот же знак часто приходит обычным апострофом или косой кавычкой.
    assert.strictEqual(latinToCyrillic("ta'sir"), "таъсир");
    assert.strictEqual(latinToCyrillic("ta’sir"), "таъсир");
  });

  test("в начале слова e читается как э", () => {
    assert.strictEqual(latinToCyrillic("eshik"), "эшик");
    assert.strictEqual(latinToCyrillic("Eshik"), "Эшик");
    assert.strictEqual(latinToCyrillic("esa keladi"), "эса келади");
  });

  test("диграф ye даёт е даже в начале слова", () => {
    assert.strictEqual(latinToCyrillic("yer"), "ер");
    assert.strictEqual(latinToCyrillic("Yer"), "Ер");
    // Иначе правило начала слова превратило бы "ер" в "эр".
    assert.strictEqual(latinToCyrillic("yetti"), "етти");
  });

  test("граница слова — не только пробел", () => {
    assert.strictEqual(latinToCyrillic("(eshik)"), "(эшик)");
    assert.strictEqual(latinToCyrillic("«eshik»"), "«эшик»");
    assert.strictEqual(latinToCyrillic("bir-eshik"), "бир-эшик");
    // А внутри слова после буквы правило не срабатывает.
    assert.strictEqual(latinToCyrillic("beshik"), "бешик");
  });

  test("остальные диграфы не сломались", () => {
    assert.strictEqual(latinToCyrillic("oʻzbek"), "ўзбек");
    assert.strictEqual(latinToCyrillic("gʻalaba"), "ғалаба");
    assert.strictEqual(latinToCyrillic("shahar"), "шаҳар");
    assert.strictEqual(latinToCyrillic("choy"), "чой");
    assert.strictEqual(latinToCyrillic("yozmoq"), "ёзмоқ");
  });

  test("предложение целиком", () => {
    assert.strictEqual(
      latinToCyrillic("Sizga maʼlum boʻlsin, biz ertaga keladi deb aytdik."),
      "Сизга маълум бўлсин, биз эртага келади деб айтдик."
    );
  });
});
