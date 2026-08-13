import { test, describe } from "node:test";
import assert from "node:assert";
import {
  extractWords,
  assessResultConfidence,
  formatConfidenceLine,
} from "../services/transcriptQualityService";

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

describe("assessResultConfidence", () => {
  const seg = (text: string, end: number) => ({ text, end });

  test("пустой текст — ноль и прямая причина", () => {
    const c = assessResultConfidence({ text: "", language: "ky", segments: [] });
    assert.strictEqual(c.percent, 0);
    assert.deepStrictEqual(c.reasons, ["речь не распознана"]);
  });

  test("пустые фрагменты роняют оценку", () => {
    // Настоящий случай: таджикское видео распознали кыргызской моделью, она
    // вернула шестнадцать пустых кусков, а запрос закрылся как успешный.
    const segments = Array.from({ length: 16 }, (_, i) => seg("", (i + 1) * 24));
    const c = assessResultConfidence({ text: "бир", language: "ky", segments });
    assert.ok(c.percent <= 20, `ожидали низкую оценку, получили ${c.percent}`);
    assert.ok(c.reasons.some((r) => r.includes("не распознан")), c.reasons.join("; "));
  });

  test("мало слов на длинной записи — низкая оценка", () => {
    const c = assessResultConfidence({
      text: "бир эки үч төрт беш алты жети сегиз",
      language: "ky",
      segments: [seg("бир эки", 600)],
    });
    assert.ok(c.percent < 60, `ожидали ниже 60, получили ${c.percent}`);
  });

  test("нормальная расшифровка не получает лишних предупреждений", () => {
    const words = Array.from({ length: 200 }, () => "сүйлөм").join(" ");
    const c = assessResultConfidence({
      text: words,
      language: "ru",
      segments: [seg(words, 120)],
    });
    assert.strictEqual(c.percent, 100);
    assert.deepStrictEqual(c.reasons, []);
  });

  test("высокая уверенность показывается без объяснений", () => {
    const line = formatConfidenceLine({ percent: 100, reasons: [] }, "ky");
    assert.strictEqual(line, "Уверенность бота: 100%");
  });

  test("низкая уверенность советует проверить язык записи", () => {
    const line = formatConfidenceLine({ percent: 0, reasons: ["речь не распознана"] }, "ky");
    assert.ok(line.includes("0%"));
    assert.ok(line.includes("речь не распознана"));
    assert.ok(line.includes("Кыргызча"), "название языка, а не код");
  });
});
