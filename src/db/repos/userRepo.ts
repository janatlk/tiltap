import { query, queryOne } from "../connection";

export interface User {
  id: number;
  telegram_chat_id: string;
  preferred_language: string | null;
  interface_language: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function getUserByChatId(chatId: number): Promise<User | null> {
  return queryOne<User>(
    "SELECT * FROM users WHERE telegram_chat_id = $1",
    [chatId]
  );
}

export async function setUserLanguage(chatId: number, language: string): Promise<User> {
  const existing = await getUserByChatId(chatId);
  if (existing) {
    return queryOne<User>(
      `UPDATE users
       SET preferred_language = $1, updated_at = NOW()
       WHERE telegram_chat_id = $2
       RETURNING *`,
      [language, chatId]
    ) as Promise<User>;
  }
  return queryOne<User>(
    `INSERT INTO users (telegram_chat_id, preferred_language)
     VALUES ($1, $2)
     RETURNING *`,
    [chatId, language]
  ) as Promise<User>;
}

export async function getUserLanguage(chatId: number): Promise<string | null> {
  const user = await getUserByChatId(chatId);
  return user?.preferred_language ?? null;
}

export async function setInterfaceLanguage(chatId: number, language: string): Promise<User> {
  const existing = await getUserByChatId(chatId);
  if (existing) {
    return queryOne<User>(
      `UPDATE users
       SET interface_language = $1, updated_at = NOW()
       WHERE telegram_chat_id = $2
       RETURNING *`,
      [language, chatId]
    ) as Promise<User>;
  }
  return queryOne<User>(
    `INSERT INTO users (telegram_chat_id, interface_language)
     VALUES ($1, $2)
     RETURNING *`,
    [chatId, language]
  ) as Promise<User>;
}

export async function getInterfaceLanguage(chatId: number): Promise<string> {
  const user = await getUserByChatId(chatId);
  return user?.interface_language ?? "ru";
}
