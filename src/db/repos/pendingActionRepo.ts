import { query, queryOne } from "../connection";

export interface PendingActionRow {
  id: number;
  telegram_chat_id: string;
  action_id: string;
  action_type: string;
  payload: Record<string, unknown>;
  buffer: Buffer | null;
  created_at: Date;
}

export async function getPendingAction(chatId: number): Promise<PendingActionRow | null> {
  return queryOne<PendingActionRow>(
    "SELECT * FROM pending_actions WHERE telegram_chat_id = $1",
    [chatId]
  );
}

export async function setPendingAction(
  chatId: number,
  actionId: string,
  actionType: string,
  payload: Record<string, unknown>,
  buffer?: Buffer
): Promise<PendingActionRow> {
  return queryOne<PendingActionRow>(
    `INSERT INTO pending_actions (telegram_chat_id, action_id, action_type, payload, buffer)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (telegram_chat_id)
     DO UPDATE SET action_id = EXCLUDED.action_id,
                   action_type = EXCLUDED.action_type,
                   payload = EXCLUDED.payload,
                   buffer = EXCLUDED.buffer,
                   created_at = NOW()
     RETURNING *`,
    [chatId, actionId, actionType, JSON.stringify(payload), buffer ?? null]
  ) as Promise<PendingActionRow>;
}

export async function deletePendingAction(chatId: number): Promise<void> {
  await query("DELETE FROM pending_actions WHERE telegram_chat_id = $1", [chatId]);
}

export async function listPendingActions(): Promise<PendingActionRow[]> {
  return query<PendingActionRow>("SELECT * FROM pending_actions");
}

export async function deleteExpiredPendingActions(ttlMs: number): Promise<void> {
  await query(
    "DELETE FROM pending_actions WHERE created_at < NOW() - INTERVAL '1 millisecond' * $1",
    [ttlMs]
  );
}
