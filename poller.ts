const TOKEN = "8827791174:AAHMdPO7ckPdb94qRWYTYPgUzg1BNd2JoZ0";
const WEBHOOK_URL = "http://localhost:3000/webhook/telegram";
const OFFSET_FILE = "poller_offset.txt";

import * as fs from "fs";

function readOffset(): number {
  try {
    const data = fs.readFileSync(OFFSET_FILE, "utf-8");
    const n = parseInt(data.trim(), 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

function writeOffset(offset: number): void {
  try {
    fs.writeFileSync(OFFSET_FILE, String(offset), "utf-8");
  } catch (err) {
    console.error("[Poller] Failed to write offset:", err);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function deleteWebhook(retries = 5): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      console.log("[Poller] Deleting existing webhook...");
      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/deleteWebhook`, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        console.log("[Poller] Webhook deleted.");
        return;
      }
      console.warn("[Poller] deleteWebhook returned", res.status);
    } catch (err) {
      console.warn(`[Poller] deleteWebhook attempt ${i + 1}/${retries} failed:`, (err as Error).message);
    }
    await sleep(3000);
  }
  console.error("[Poller] Could not delete webhook after retries, continuing anyway...");
}

async function main() {
  await deleteWebhook();

  let offset = readOffset();
  console.log("[Poller] Started. Offset:", offset, "Forwarding to", WEBHOOK_URL);

  while (true) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${offset}&limit=10`,
        { signal: AbortSignal.timeout(30000) }
      );
      const data = (await res.json()) as { ok: boolean; result: Array<{ update_id: number }> };

      if (!data.ok || !data.result) {
        await sleep(3000);
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;
        writeOffset(offset);
        try {
          const forwardRes = await fetch(WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(update),
            signal: AbortSignal.timeout(30000),
          });
          if (!forwardRes.ok) {
            console.error("[Poller] Forward failed:", forwardRes.status, await forwardRes.text());
          }
        } catch (err) {
          console.error("[Poller] Forward error:", (err as Error).message);
        }
      }

      // Short sleep when no updates to avoid hammering
      if (data.result.length === 0) {
        await sleep(500);
      }
    } catch (err) {
      console.error("[Poller] Poll error:", (err as Error).message);
      await sleep(5000);
    }
  }
}

main().catch((err) => {
  console.error("[Poller] Fatal error:", err);
  process.exit(1);
});
