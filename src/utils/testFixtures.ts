import { readFileSync, existsSync } from "fs";
import { join } from "path";

export interface TestFixture {
  language: string;
  title: string;
  /** Path relative to project root (for local fixtures) */
  wavPath: string;
  /** YouTube URL (for remote fixtures) */
  url?: string;
  referenceText: string;
  source: "local" | "youtube";
  phraseCount?: number;
  durationSeconds?: number;
}

/**
 * Default accuracy-test fixture.
 *
 * Video: 40-second Kyrgyz fairy tale "Чолой Чол кыз" from AI JOMOKTOR.
 * Reference text is a hand-normalized transcript of the spoken Kyrgyz.
 */
export const DEFAULT_TEST_FIXTURE: TestFixture = {
  source: "youtube",
  language: "ky",
  title: "🐰 Кыргызча жомок: Чолой Чол кыз — 40 сек",
  wavPath: "",
  referenceText: `Охо Динка Чолой чол кыз болуп калыпсың го гана ыр айтып берчи бизге кысып айтбек коем кызым болду эми бул билбейм кайыштан күтөт ата эми бул эми айтып берип кой эми бул окуйт дедим жок токтом жэби тепсем суу чыгат сууну ичсем чыгат уу соту гана иштейм кудай кааласа буу чыгат`,
};

function loadManifest(): Record<string, TestFixture> {
  const manifestPath = join(process.cwd(), "test_audio", "manifest.json");
  if (!existsSync(manifestPath)) {
    return {};
  }
  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as { fixtures: Record<string, TestFixture> };
    return parsed.fixtures ?? {};
  } catch (err) {
    console.warn("Failed to load test audio manifest", err);
    return {};
  }
}

function loadHardManifest(): Record<string, TestFixture> {
  const manifestPath = join(process.cwd(), "test_audio", "hard_manifest.json");
  if (!existsSync(manifestPath)) {
    return {};
  }
  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as { fixtures: Record<string, TestFixture> };
    return parsed.fixtures ?? {};
  } catch (err) {
    console.warn("Failed to load hard test audio manifest", err);
    return {};
  }
}

const manifestFixtures = loadManifest();
const hardFixtures = loadHardManifest();

// For the priority languages we prefer real-world YouTube fixtures over the
// synthetic phrasebook clips, because Vosk-based engines struggle with the
// phrasebook's short repeated phrases.
const PRIORITY_LANGUAGES = new Set(["ky", "tg", "uz"]);
const mergedFixtures: Record<string, TestFixture> = { ...manifestFixtures };
for (const lang of PRIORITY_LANGUAGES) {
  if (hardFixtures[lang]) {
    mergedFixtures[lang] = hardFixtures[lang];
  }
}

export const TEST_FIXTURES: Record<string, TestFixture> = {
  ...mergedFixtures,
  // Fallback Kyrgyz YouTube fixture if no fixtures are present.
  ky: mergedFixtures.ky ?? DEFAULT_TEST_FIXTURE,
};

export function getTestFixture(language: string): TestFixture | undefined {
  return TEST_FIXTURES[language];
}

export function listTestLanguages(): string[] {
  return Object.keys(TEST_FIXTURES);
}
