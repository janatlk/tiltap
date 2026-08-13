import { logger } from "../utils/logger";
import { config } from "../config";
import { sendTextMessage } from "./telegramService";
import { query, queryOne } from "../db/connection";

/**
 * Рассылка сообщения всем пользователям бота.
 *
 * Единственное действие в админке, которое нельзя отменить: отправленное
 * сообщение уже у людей. Поэтому здесь есть режим проверки (никому ничего не
 * уходит), пробная отправка себе и запись каждой рассылки в базу — чтобы
 * "мы это уже отправляли?" был вопросом с ответом.
 */

/** Телеграм пропускает около 30 сообщений в секунду; держимся заметно ниже. */
const MESSAGES_PER_SECOND = 20;
const PAUSE_MS = Math.ceil(1000 / MESSAGES_PER_SECOND);

export interface BroadcastResult {
  total: number;
  sent: number;
  blocked: number;
  failed: number;
  dryRun: boolean;
  errors: Array<{ chatId: number; reason: string }>;
}

async function recipients(): Promise<number[]> {
  const rows = await query<{ telegram_chat_id: string | number }>(
    `SELECT telegram_chat_id FROM users ORDER BY id`
  );
  return rows.map((r) => Number(r.telegram_chat_id)).filter((id) => Number.isFinite(id) && id !== 0);
}

export async function countRecipients(): Promise<number> {
  return (await recipients()).length;
}

export async function sendBroadcast(options: {
  text: string;
  dryRun: boolean;
  testOnly: boolean;
  author: string;
}): Promise<BroadcastResult> {
  const text = options.text.trim();
  if (!text) throw new Error("Пустое сообщение");

  let targets: number[];
  if (options.testOnly) {
    const adminChat = Number(config.TILTAB_ADMIN_CHAT_ID);
    if (!Number.isFinite(adminChat) || adminChat === 0) {
      throw new Error("TILTAB_ADMIN_CHAT_ID не задан — пробную отправку слать некуда");
    }
    targets = [adminChat];
  } else {
    targets = await recipients();
  }

  const result: BroadcastResult = {
    total: targets.length,
    sent: 0,
    blocked: 0,
    failed: 0,
    dryRun: options.dryRun,
    errors: [],
  };

  if (options.dryRun) {
    logger.info("Broadcast dry run", { author: options.author, recipients: targets.length });
    return result;
  }

  for (const chatId of targets) {
    try {
      await sendTextMessage(chatId, text);
      result.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Человек заблокировал бота или удалил чат — это не поломка рассылки,
      // и в отчёте это должно читаться отдельно от настоящих ошибок.
      if (/403|blocked|kicked|chat not found|deactivated/i.test(message)) {
        result.blocked += 1;
      } else {
        result.failed += 1;
        if (result.errors.length < 20) {
          result.errors.push({ chatId, reason: message.slice(0, 200) });
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  }

  if (!options.testOnly) {
    await query(
      `INSERT INTO broadcasts (text, author, total, sent, blocked, failed)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [text, options.author, result.total, result.sent, result.blocked, result.failed]
    ).catch((err) => {
      logger.error("Failed to record broadcast", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  logger.info("Broadcast finished", {
    author: options.author,
    testOnly: options.testOnly,
    ...result,
    errors: result.errors.length,
  });
  return result;
}

export interface BroadcastRecord {
  id: number;
  text: string;
  author: string;
  total: number;
  sent: number;
  blocked: number;
  failed: number;
  created_at: Date;
}

export async function listBroadcasts(limit = 20): Promise<BroadcastRecord[]> {
  return query<BroadcastRecord>(
    `SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
}

export async function lastBroadcast(): Promise<BroadcastRecord | null> {
  return queryOne<BroadcastRecord>(`SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 1`);
}
