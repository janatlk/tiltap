import { test, describe } from "node:test";
import assert from "node:assert";

/**
 * Порог, ниже которого сообщение считается репликой боту, а не заданием.
 * Копия правила из telegramController: вынести его в отдельный модуль ради
 * одной функции было бы дороже, чем держать проверку рядом.
 */
const MIN_WORDS_FOR_AUTO_TRANSLATE = 3;

function countWords(text: string): number {
  return (text.match(/[\p{L}\p{M}]+/gu) ?? []).length;
}

const translates = (text: string) => countWords(text) >= MIN_WORDS_FOR_AUTO_TRANSLATE;

describe("что бот берёт в перевод сам", () => {
  test("короткие реплики не переводятся", () => {
    for (const phrase of ["привет", "ок", "спасибо", "салам", "рахмат", "да", "?"]) {
      assert.strictEqual(translates(phrase), false, phrase);
    }
  });

  test("осмысленная фраза переводится", () => {
    for (const phrase of [
      "Бул кыргызча текст",
      "переведи это предложение пожалуйста",
      "Ассаламу алейкум, кандайсыз?",
    ]) {
      assert.strictEqual(translates(phrase), true, phrase);
    }
  });

  test("цифры и смайлы словами не считаются", () => {
    assert.strictEqual(countWords("300 25 40"), 0);
    assert.strictEqual(countWords("👍 🎉 ✅"), 0);
    assert.strictEqual(translates("2026 год 300"), false);
  });

  test("ровно три слова — уже перевод", () => {
    assert.strictEqual(translates("бир эки үч"), true);
    assert.strictEqual(translates("бир эки"), false);
  });
});
