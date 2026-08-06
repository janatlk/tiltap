import { logger } from "../utils/logger";
import { config } from "../config";
import { sendTextMessage } from "./telegramService";
import * as feedbackRepo from "../db/repos/feedbackRepo";

/**
 * Delivering admin answers to problem reports, and keeping deferred ones from
 * being forgotten.
 *
 * Telegram reports can be answered directly — we have the chat id. Web reports
 * cannot: the reporter is an anonymous browser with no push channel, so the
 * reply is stored and handed over when that browser comes back. The distinction
 * is recorded per row (reply_delivered) instead of being assumed, so the admin
 * can see which answers actually reached someone.
 */

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface ReplyResult {
  delivered: boolean;
  reason?: string;
}

export async function replyToFeedback(id: number, replyText: string): Promise<ReplyResult> {
  const entries = await feedbackRepo.listFeedback({ limit: 500 });
  const entry = entries.find((e) => e.id === id);
  if (!entry) {
    throw new Error(`feedback ${id} not found`);
  }

  let delivered = false;
  let reason: string | undefined;

  if (entry.source === "telegram" && entry.telegram_chat_id) {
    const header = entry.request_number
      ? `💬 <b>Ответ на ваше обращение №${entry.request_number}</b>`
      : "💬 <b>Ответ на ваше обращение</b>";
    const quoted = entry.comment
      ? `\n\n<i>Вы писали:</i>\n<blockquote>${escapeHtml(entry.comment.slice(0, 500))}</blockquote>`
      : "";
    try {
      await sendTextMessage(entry.telegram_chat_id, `${header}${quoted}\n\n${escapeHtml(replyText)}`);
      delivered = true;
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
      logger.error("Failed to deliver feedback reply", { id, error: reason });
    }
  } else {
    // Stored, not sent: picked up by the web client on its next visit.
    reason = "web-обращение: ответ покажется пользователю при следующем заходе";
  }

  await feedbackRepo.saveAdminReply(id, replyText, delivered);
  logger.info("Feedback reply saved", { id, source: entry.source, delivered });
  return { delivered, reason };
}

// ---------------------------------------------------------------------------
// Daily reminder for deferred reports
// ---------------------------------------------------------------------------

let reminderTimer: ReturnType<typeof setInterval> | null = null;

function buildReminder(entries: feedbackRepo.FeedbackEntry[]): string {
  const lines = entries.slice(0, 15).map((e) => {
    const who = e.telegram_username ? `@${e.telegram_username}` : e.telegram_name || e.source;
    const days = e.created_at
      ? Math.floor((Date.now() - new Date(e.created_at).getTime()) / 86_400_000)
      : 0;
    const num = e.request_number ? `№${e.request_number}` : `#${e.id}`;
    const text = (e.comment || "(без текста)").replace(/\s+/g, " ").slice(0, 120);
    return `• <b>${num}</b> от ${escapeHtml(String(who))}, ${days} дн. назад\n  ${escapeHtml(text)}`;
  });

  const more = entries.length > lines.length ? `\n\n…и ещё ${entries.length - lines.length}.` : "";
  return (
    `⏳ <b>Отложенные обращения: ${entries.length}</b>\n\n` +
    lines.join("\n") +
    more +
    "\n\nОтветить или закрыть — в админке, вкладка Feedback."
  );
}

async function runReminderCheck(): Promise<void> {
  if (!config.TILTAB_ADMIN_CHAT_ID) return;
  try {
    const due = await feedbackRepo.listDeferredDueForReminder(config.TILTAB_FEEDBACK_REMINDER_HOURS);
    if (due.length === 0) return;

    await sendTextMessage(config.TILTAB_ADMIN_CHAT_ID, buildReminder(due));
    // Marked only after a successful send, so a Telegram outage postpones the
    // reminder rather than silently swallowing it.
    await feedbackRepo.markReminded(due.map((e) => e.id));
    logger.info("Deferred feedback reminder sent", { count: due.length });
  } catch (err) {
    logger.error("Deferred feedback reminder failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the reminder loop. It checks hourly but only reports items whose own
 * last-reminded timestamp is old enough, so the actual cadence comes from the
 * database and survives restarts.
 */
export function startFeedbackReminders(): void {
  if (reminderTimer) return;
  if (!config.TILTAB_FEEDBACK_REMINDERS_ENABLED) {
    logger.info("Deferred feedback reminders disabled");
    return;
  }

  setTimeout(() => {
    void runReminderCheck();
    reminderTimer = setInterval(() => void runReminderCheck(), 3_600_000);
  }, 60_000);

  logger.info("Deferred feedback reminders started", {
    everyHours: config.TILTAB_FEEDBACK_REMINDER_HOURS,
    adminChatConfigured: Boolean(config.TILTAB_ADMIN_CHAT_ID),
  });
}

export function stopFeedbackReminders(): void {
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
  }
}

/** Exposed for the admin panel's "send now" button and for tests. */
export const _runReminderCheck = runReminderCheck;
