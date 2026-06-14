import { describe, it } from "node:test";
import assert from "node:assert";
import { handleTranslate } from "../controllers/translateController";
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
