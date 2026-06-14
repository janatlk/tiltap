import { logger } from "../utils/logger";
import { config } from "../config";

export async function getFilePath(fileId: string): Promise<string> {
  const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getFile`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });

  if (!res.ok) {
    throw new Error(`Telegram getFile failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    ok: boolean;
    result?: { file_path: string };
    description?: string;
  };

  if (!data.ok || !data.result?.file_path) {
    throw new Error(`Telegram getFile error: ${data.description ?? "unknown"}`);
  }

  return data.result.file_path;
}

export async function downloadFile(filePath: string): Promise<Buffer> {
  const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${filePath}`;
  logger.debug("Downloading file from Telegram", { url });

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Telegram file download failed: ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function fetchTelegramFile(fileId: string): Promise<{ buffer: Buffer; filePath: string }> {
  const filePath = await getFilePath(fileId);
  const buffer = await downloadFile(filePath);
  logger.info("Downloaded file from Telegram", { fileId, sizeBytes: buffer.length });
  return { buffer, filePath };
}
