/**
 * Local development helper: poll Telegram getUpdates and forward them
 * to the local webhook endpoint. This lets the webhook-based bot work
 * without a public HTTPS URL.
 *
 * Single-instance guard: exits if another forwarder is already running.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import os from "os";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.LOCAL_WEBHOOK_URL || "http://localhost:3000/webhook/telegram";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1000);
const LOCK_FILE = path.join(os.tmpdir(), "telegram_poll_forwarder.lock");

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): boolean {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const existing = fs.readFileSync(LOCK_FILE, "utf8").trim();
      const pid = Number(existing);
      if (pid && isProcessAlive(pid)) {
        console.error(`Another forwarder is already running (PID ${pid}). Exiting.`);
        return false;
      }
      console.log(`Stale lock file found (PID ${existing}), removing.`);
      fs.unlinkSync(LOCK_FILE);
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch (err) {
    console.error("Failed to acquire lock:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const current = fs.readFileSync(LOCK_FILE, "utf8").trim();
      if (current === String(process.pid)) {
        fs.unlinkSync(LOCK_FILE);
      }
    }
  } catch {
    // ignore
  }
}

if (!acquireLock()) {
  process.exit(1);
}

process.on("exit", releaseLock);
process.on("SIGINT", () => {
  releaseLock();
  process.exit(0);
});
process.on("SIGTERM", () => {
  releaseLock();
  process.exit(0);
});

const API = `https://api.telegram.org/bot${TOKEN}`;
let offset = 0;
let running = true;

async function poll() {
  try {
    const res = await fetch(`${API}/getUpdates?offset=${offset}&limit=10`, {
      method: "GET",
    });
    if (!res.ok) {
      const text = await res.text();
      console.error("getUpdates failed:", res.status, text);
      if (res.status === 409) {
        console.error("Conflict detected: another getUpdates poll is active. Exiting.");
        releaseLock();
        process.exit(1);
      }
      return;
    }
    const data = (await res.json()) as { ok: boolean; result: Array<{ update_id: number }> };
    if (!data.ok || !Array.isArray(data.result)) return;

    for (const update of data.result) {
      offset = Math.max(offset, update.update_id + 1);
      try {
        const forward = await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        });
        if (!forward.ok) {
          console.error("Webhook forward failed:", forward.status, await forward.text());
        }
      } catch (err) {
        console.error("Failed to forward update:", err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    console.error("Polling error:", err instanceof Error ? err.message : String(err), err instanceof Error ? err.cause : "");
  }
}

async function main() {
  console.log(`Forwarding Telegram updates to ${WEBHOOK_URL}`);
  console.log(`Bot token length: ${TOKEN.length}`);
  while (running) {
    await poll();
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();
