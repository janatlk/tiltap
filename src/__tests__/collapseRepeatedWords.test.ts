import { describe, it } from "node:test";
import assert from "node:assert";

import { collapseRepeatedWords } from "../services/transcriptionService";

describe("collapseRepeatedWords", () => {
  it("collapses pathological word loops", () => {
    const loop = Array(25).fill("жарандарыбыздын").join(" ");
    const input = `Ал эми биздин ${loop} атайын техникалар иштеп`;
    const output = collapseRepeatedWords(input);
    const runs = output.split(/\s+/).filter((w) => w === "жарандарыбыздын").length;
    assert.ok(runs <= 3, `expected <=3 repeats, got ${runs}`);
    assert.ok(output.includes("атайын техникалар иштеп"));
  });

  it("keeps natural short repetitions", () => {
    const input = "Кабар берет. Кабар берет БГК чындыгында";
    assert.strictEqual(collapseRepeatedWords(input), input);
  });

  it("ignores trailing punctuation when comparing", () => {
    const input = "да, да, да, да, да, да";
    const output = collapseRepeatedWords(input);
    assert.ok(output.split(/\s+/).length <= 3);
  });

  it("handles empty text", () => {
    assert.strictEqual(collapseRepeatedWords(""), "");
  });
});
