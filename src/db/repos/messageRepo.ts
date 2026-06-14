import { queryOne } from "../connection";

export interface Message {
  id: number;
  telegram_chat_id: string;
  telegram_message_id: string | null;
  update_id: string | null;
  message_type: string;
  file_id: string | null;
  file_size: number | null;
  mime_type: string | null;
  raw_payload: Record<string, unknown> | null;
  created_at: Date;
}

export async function createMessage(payload: {
  telegramChatId: number;
  telegramMessageId?: number;
  updateId?: number;
  messageType: string;
  fileId?: string;
  fileSize?: number;
  mimeType?: string;
  rawPayload?: Record<string, unknown>;
}): Promise<Message> {
  return queryOne<Message>(
    `INSERT INTO messages
       (telegram_chat_id, telegram_message_id, update_id, message_type, file_id, file_size, mime_type, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      payload.telegramChatId,
      payload.telegramMessageId ?? null,
      payload.updateId ?? null,
      payload.messageType,
      payload.fileId ?? null,
      payload.fileSize ?? null,
      payload.mimeType ?? null,
      payload.rawPayload ?? null,
    ]
  ) as Promise<Message>;
}
