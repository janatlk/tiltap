import { test } from "node:test";
import assert from "node:assert/strict";
import { paragraphsFromSegments, paragraphsFromSentences } from "../utils/paragraphs";
import type { TranscriptionSegment } from "../types";

function segment(id: number, text: string): TranscriptionSegment {
  return { id, start: id * 30, end: id * 30, text };
}

test("каждый сегмент становится абзацем", () => {
  const out = paragraphsFromSegments([
    segment(0, "А".repeat(200)),
    segment(1, "Б".repeat(200)),
  ]);
  assert.equal(out.split("\n\n").length, 2);
});

test("пометки шума абзацами не становятся", () => {
  const out = paragraphsFromSegments([
    segment(0, "[неразборчиво]"),
    segment(1, "А".repeat(200)),
    segment(2, "[музыка] [неразборчиво]"),
  ]);
  assert.equal(out, "А".repeat(200));
});

test("короткий сегмент прилипает к предыдущему, а не висит абзацем", () => {
  const out = paragraphsFromSegments([
    segment(0, "Коротко."),
    segment(1, "Б".repeat(200)),
  ]);
  assert.equal(out.includes("\n\n"), false);
  assert.equal(out, `Коротко. ${"Б".repeat(200)}`);
});

test("готовую разбивку не трогаем", () => {
  const text = "Первый абзац.\n\nВторой абзац.";
  assert.equal(paragraphsFromSentences(text), text);
});

test("сплошной текст делится по предложениям", () => {
  const sentence = "Это предложение достаточной длины для проверки разбивки. ";
  const out = paragraphsFromSentences(sentence.repeat(20));
  assert.ok(out.split("\n\n").length > 1);
  // Ни одно слово не должно потеряться при перестановке.
  assert.equal(out.replace(/\s+/g, " ").trim(), sentence.repeat(20).replace(/\s+/g, " ").trim());
});

test("одно предложение остаётся одним абзацем", () => {
  const text = "Короткая мысль без продолжения.";
  assert.equal(paragraphsFromSentences(text), text);
});
