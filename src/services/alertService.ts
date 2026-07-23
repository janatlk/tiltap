import { logger } from "../utils/logger";
import { config } from "../config";
import { sendTextMessage } from "./telegramService";

// Per-alert-key timestamp of the last message actually sent. Throttling is
// in-memory: it resets on restart, which is acceptable — a restart is itself a
// reason to re-evaluate and alert again if a problem persists.
const lastSentAt = new Map<string, number>();

/**
 * Send an operational alert to the admin Telegram chat, throttled per key so a
 * persistent fault does not spam the admin. Returns true if a message was sent.
 */
export async function sendAdminAlert(
  key: string,
  text: string,
  throttleHours: number
): Promise<boolean> {
  const chatId = config.TILTAB_ADMIN_CHAT_ID;
  if (!chatId) {
    logger.warn("Admin alert not delivered: TILTAB_ADMIN_CHAT_ID is not set", { key });
    return false;
  }

  const now = Date.now();
  const last = lastSentAt.get(key) ?? 0;
  if (now - last < throttleHours * 3_600_000) {
    logger.debug("Admin alert throttled", { key, minutesSinceLast: Math.round((now - last) / 60000) });
    return false;
  }

  try {
    await sendTextMessage(chatId, text);
    lastSentAt.set(key, now);
    logger.info("Admin alert sent", { key, chatId });
    return true;
  } catch (err) {
    logger.error("Failed to send admin alert", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Clear the throttle for a key so the next alert (e.g. a recovery notice) is
 * sent immediately regardless of when the last one went out.
 */
export function resetAlertThrottle(key: string): void {
  lastSentAt.delete(key);
}
