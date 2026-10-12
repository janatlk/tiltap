import type { Request, Response } from "express";
import { logger } from "../utils/logger";
import { getPublicStats } from "../services/statsService";

export async function handlePublicStats(_req: Request, res: Response): Promise<void> {
  try {
    const stats = await getPublicStats();
    // Пять минут — тот же срок, что и у нашего кэша: незачем пересчитывать
    // ради читателя, который обновил страницу дважды подряд.
    res.setHeader("Cache-Control", "public, max-age=300");
    res.status(200).json(stats);
  } catch (err) {
    logger.error("Public stats failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "stats_unavailable" });
  }
}
