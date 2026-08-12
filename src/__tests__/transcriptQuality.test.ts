import { test, describe } from "node:test";
import assert from "node:assert";
import { extractWords } from "../services/transcriptQualityService";

/**
 * Детектор шумных записей считает долю слов вне словаря. Первая версия
 * разбивала текст шаблоном [^\W\d_], который в JavaScript остаётся ASCII —
 * на кириллице он находил ноль слов, доля не считалась, и предупреждение не
 * срабатывало ни разу. Ошибка была не видна: код не падал, тесты не было.
 */
describe("extractWords", () => {
  test("находит кыргызские слова, включая ө, ү, ң", () => {
    const words = extractWords("Көл жана кол — башка сөздөр, түшүнүктүү");
    assert.deepStrictEqual(words, ["көл", "жана", "кол", "башка", "сөздөр", "түшүнүктүү"]);
  });

  test("находит таджикские слова с ӯ, ҳ, ҷ", () => {
    const words = extractWords("Имрӯз мо дар бозор ҳастем ва ҷавоб медиҳем");
    assert.ok(words.includes("имрӯз"), "имрӯз");
    assert.ok(words.includes("ҳастем"), "ҳастем");
    assert.ok(words.includes("медиҳем"), "медиҳем");
    // "мо" и "ва" короче трёх букв и отбрасываются намеренно: такие слова
    // одинаково часты и в нормальной речи, и в мусоре.
    assert.deepStrictEqual(words, ["имрӯз", "дар", "бозор", "ҳастем", "ҷавоб", "медиҳем"]);
  });

  test("кириллица разбирается наравне с латиницей", () => {
    // Ровно та ошибка, ради которой написан тест: раньше кириллица давала 0.
    assert.deepStrictEqual(extractWords("бир эки төрт беш"), ["бир", "эки", "төрт", "беш"]);
    assert.deepStrictEqual(extractWords("bir eki tort besh"), ["bir", "eki", "tort", "besh"]);
  });

  test("отбрасывает цифры, знаки и слишком короткие слова", () => {
    assert.deepStrictEqual(extractWords("сом 300, 25% — да не"), ["сом"]);
  });

  test("приводит к нижнему регистру", () => {
    assert.deepStrictEqual(extractWords("Салам Дүйнө"), ["салам", "дүйнө"]);
  });

  test("пустой текст не ломает разбор", () => {
    assert.deepStrictEqual(extractWords(""), []);
    assert.deepStrictEqual(extractWords("   ...  "), []);
  });
});
