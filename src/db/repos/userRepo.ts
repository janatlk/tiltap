import { query, queryOne } from "../connection";

export interface User {
  id: number;
  telegram_chat_id: string;
  preferred_language: string | null;
  interface_language: string | null;
  target_language: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function getUserByChatId(chatId: number): Promise<User | null> {
  return queryOne<User>(
    "SELECT * FROM users WHERE telegram_chat_id = $1",
    [chatId]
  );
}

export async function ensureUser(chatId: number, defaults?: Partial<Pick<User, "preferred_language" | "interface_language" | "target_language">>): Promise<User> {
  const existing = await getUserByChatId(chatId);
  if (existing) {
    return existing;
  }
  return queryOne<User>(
    `INSERT INTO users (telegram_chat_id, preferred_language, interface_language, target_language)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [chatId, defaults?.preferred_language ?? "auto", defaults?.interface_language ?? "ru", defaults?.target_language ?? null]
  ) as Promise<User>;
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

export async function setTargetLanguage(chatId: number, language: string): Promise<User> {
  const existing = await getUserByChatId(chatId);
  if (existing) {
    return queryOne<User>(
      `UPDATE users
       SET target_language = $1, updated_at = NOW()
       WHERE telegram_chat_id = $2
       RETURNING *`,
      [language, chatId]
    ) as Promise<User>;
  }
  return queryOne<User>(
    `INSERT INTO users (telegram_chat_id, target_language)
     VALUES ($1, $2)
     RETURNING *`,
    [chatId, language]
  ) as Promise<User>;
}

export async function getTargetLanguage(chatId: number): Promise<string | null> {
  const user = await getUserByChatId(chatId);
  return user?.target_language ?? null;
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

export async function updateUserPreferences(
  chatId: number,
  prefs: Partial<Pick<User, "preferred_language" | "interface_language" | "target_language">>
): Promise<User> {
  const existing = await getUserByChatId(chatId);
  if (existing) {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    let idx = 1;
    if (prefs.preferred_language !== undefined) {
      sets.push(`preferred_language = $${idx++}`);
      values.push(prefs.preferred_language);
    }
    if (prefs.interface_language !== undefined) {
      sets.push(`interface_language = $${idx++}`);
      values.push(prefs.interface_language);
    }
    if (prefs.target_language !== undefined) {
      sets.push(`target_language = $${idx++}`);
      values.push(prefs.target_language);
    }
    if (sets.length === 0) {
      return existing;
    }
    sets.push(`updated_at = NOW()`);
    values.push(chatId);
    return queryOne<User>(
      `UPDATE users SET ${sets.join(", ")} WHERE telegram_chat_id = $${idx} RETURNING *`,
      values
    ) as Promise<User>;
  }
  return queryOne<User>(
    `INSERT INTO users (telegram_chat_id, preferred_language, interface_language, target_language)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [chatId, prefs.preferred_language ?? "auto", prefs.interface_language ?? "ru", prefs.target_language ?? null]
  ) as Promise<User>;
}
