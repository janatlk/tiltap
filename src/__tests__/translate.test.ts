import { describe, it } from "node:test";
import assert from "node:assert";
import { handleTranslate } from "../controllers/translateController";
import { detectTranslationIssues } from "../services/translationService";
import type { Request, Response } from "express";

describe("POST /api/translate", () => {
  it("returns 400 when text is missing", async () => {
    let status = 0;
    const json: unknown[] = [];

    const res = {
      status: (s: number) => {
        status = s;
        return res;
      },
      json: (payload: unknown) => {
        json.push(payload);
        return res;
      },
    } as unknown as Response;

    await handleTranslate({ body: { targetLang: "ru" } } as Request, res);

    assert.strictEqual(status, 400);
    assert.deepStrictEqual(json[0], { error: "Missing or invalid 'text' field" });
  });

  it("returns 400 when targetLang is missing", async () => {
    let status = 0;
    const json: unknown[] = [];

    const res = {
      status: (s: number) => {
        status = s;
        return res;
      },
      json: (payload: unknown) => {
        json.push(payload);
        return res;
      },
    } as unknown as Response;

    await handleTranslate({ body: { text: "hello" } } as Request, res);

    assert.strictEqual(status, 400);
    assert.deepStrictEqual(json[0], { error: "Missing or invalid 'targetLang' field" });
  });
});

describe("detectTranslationIssues", () => {
  it("flags empty translation", () => {
    const result = detectTranslationIssues("   ");
    assert.strictEqual(result.isSuspicious, true);
    assert.ok(result.flags.includes("empty"));
  });

  it("flags a translation where one word dominates", () => {
    const repeated = Array(20).fill("меҳнати").join(" ");
    const result = detectTranslationIssues(repeated);
    assert.strictEqual(result.isSuspicious, true);
    assert.ok(result.flags.some((f) => f.startsWith("repetition:меҳнати")));
  });

  it("flags a degenerate repeated tail", () => {
    const text = "Дар оғози сухан мо роҳи меҳнати " + Array(10).fill("меҳнати").join(" ");
    const result = detectTranslationIssues(text);
    assert.strictEqual(result.isSuspicious, true);
    assert.ok(result.flags.some((f) => f.startsWith("repeated-tail:")));
  });

  it("passes for a normal short translation", () => {
    const result = detectTranslationIssues("Салом, чӣ хелед?");
    assert.strictEqual(result.isSuspicious, false);
    assert.deepStrictEqual(result.flags, []);
  });
});
