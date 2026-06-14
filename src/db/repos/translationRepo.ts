import { queryOne } from "../connection";

export interface Translation {
  id: number;
  telegram_chat_id: string;
  transcription_id: number;
  source_text: string;
  target_lang: string;
  translated_text: string;
  created_at: Date;
}

export async function saveTranslation(payload: {
  telegramChatId: number;
  transcriptionId: number;
  sourceText: string;
  targetLang: string;
  translatedText: string;
}): Promise<Translation> {
  return queryOne<Translation>(
    `INSERT INTO translations
       (telegram_chat_id, transcription_id, source_text, target_lang, translated_text)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      payload.telegramChatId,
      payload.transcriptionId,
      payload.sourceText,
      payload.targetLang,
      payload.translatedText,
    ]
  ) as Promise<Translation>;
}

export async function getTranslation(
  transcriptionId: number,
  targetLang: string
): Promise<Translation | null> {
  return queryOne<Translation>(
    `SELECT * FROM translations
     WHERE transcription_id = $1 AND target_lang = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [transcriptionId, targetLang]
  );
}
