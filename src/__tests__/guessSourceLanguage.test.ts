import { describe, it } from "node:test";
import assert from "node:assert";
import { guessSourceLanguage } from "../services/translationService";

describe("guessSourceLanguage", () => {
  it("recognises Kyrgyz by its own letters", () => {
    assert.strictEqual(guessSourceLanguage("Турист ташыган Урал жөдө кетип түшүрүп"), "ky");
  });

  it("leaves Russian alone", () => {
    // Russian carries no markers of its own, so there is nothing to claim. The
    // model is already reliable when told nothing about plain Russian.
    assert.strictEqual(guessSourceLanguage("Привет, как твои дела сегодня"), undefined);
  });

  it("says nothing about text with no marker letters", () => {
    assert.strictEqual(guessSourceLanguage("Hello there, how are you"), undefined);
  });

  it("does not guess from a single stray letter", () => {
    assert.strictEqual(guessSourceLanguage("Привет ө"), undefined);
  });

  it("recognises Tajik by its own letters", () => {
    assert.strictEqual(guessSourceLanguage("Ин матни тоҷикӣ бо ҳарфҳои хос ӯҷ"), "tg");
  });

  it("stays silent when Tajik and Uzbek Cyrillic markers are tied", () => {
    // қ, ғ and ҳ belong to both, so a narrow lead is not evidence.
    assert.strictEqual(guessSourceLanguage("қғ"), undefined);
  });
});
