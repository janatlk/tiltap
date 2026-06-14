import { describe, it } from "node:test";
import assert from "node:assert";
import { combinedAccuracy, normalizeText, similarity } from "../utils/textSimilarity";

describe("textSimilarity", () => {
  it("normalizes Cyrillic text", () => {
    assert.strictEqual(normalizeText("Салам, дүйнө!!!"), "салам дүйнө");
  });

  it("returns 100 for identical strings", () => {
    assert.strictEqual(combinedAccuracy("салам", "салам"), 100);
  });

  it("returns lower score for similar but different strings", () => {
    const score = combinedAccuracy("Салам алейкум", "салам алексус");
    assert.ok(score >= 50 && score <= 80, `expected moderate score, got ${score}`);
  });

  it("is case-insensitive", () => {
    assert.strictEqual(combinedAccuracy("Салам", "салам"), 100);
  });

  it("returns high score for nearly identical Kyrgyz sentence", () => {
    const a = "Менин атым Жанат";
    const b = "менин атым жанат";
    assert.strictEqual(combinedAccuracy(a, b), 100);
  });

  it("similarity handles empty strings", () => {
    assert.strictEqual(similarity("", ""), 1);
  });
});
