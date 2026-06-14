const FILLED = "🟩";
const EMPTY = "⬜";
const TOTAL_BLOCKS = 10;

export function renderProgressBar(percent: number, label?: string): string {
  const clamped = Math.min(100, Math.max(0, percent));
  const filledCount = Math.round((clamped / 100) * TOTAL_BLOCKS);
  const emptyCount = TOTAL_BLOCKS - filledCount;

  const bar = FILLED.repeat(filledCount) + EMPTY.repeat(emptyCount);
  const lines: string[] = [`<b>${bar} ${clamped}%</b>`];
  if (label) {
    lines.push(`<i>${label}</i>`);
  }
  return lines.join("\n");
}

export function renderLoadingStages(
  stagePercent: number,
  stageLabel: string,
  details?: string,
  header = "⏳ <b>TilTap</b>\n"
): string {
  const bar = renderProgressBar(stagePercent, stageLabel);
  const extra = details ? `\n<code>${details}</code>` : "";
  return header + bar + extra;
}
