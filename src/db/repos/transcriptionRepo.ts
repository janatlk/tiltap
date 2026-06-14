import { queryOne } from "../connection";

export interface TranscriptionSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

export interface Transcription {
  id: number;
  telegram_chat_id: string;
  message_id: number | null;
  language: string;
  full_text: string;
  segments: TranscriptionSegment[];
  created_at: Date;
}

export async function createTranscription(payload: {
  telegramChatId: number;
  messageId: number | null;
  language: string;
  fullText: string;
  segments: TranscriptionSegment[];
}): Promise<Transcription> {
  return queryOne<Transcription>(
    `INSERT INTO transcriptions
       (telegram_chat_id, message_id, language, full_text, segments)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      payload.telegramChatId,
      payload.messageId,
      payload.language,
      payload.fullText,
      JSON.stringify(payload.segments),
    ]
  ) as Promise<Transcription>;
}

export async function getLatestTranscription(chatId: number): Promise<Transcription | null> {
  return queryOne<Transcription>(
    `SELECT * FROM transcriptions
     WHERE telegram_chat_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [chatId]
  );
}
