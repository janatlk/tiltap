import { Request, Response } from "express";
import { logger } from "../utils/logger";
import { translateText } from "../services/translationService";
import type { TranslateRequest } from "../types";

export async function handleTranslate(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();

  try {
    const body = req.body as TranslateRequest;

    if (!body.text || typeof body.text !== "string") {
      res.status(400).json({ error: "Missing or invalid 'text' field" });
      return;
    }

    if (!body.targetLang || typeof body.targetLang !== "string") {
      res.status(400).json({ error: "Missing or invalid 'targetLang' field" });
      return;
    }

    const result = await translateText({
      ...body,
      sourceUrl: body.sourceUrl,
      sourceType: body.sourceType ?? "text",
    });

    res.status(200).json(result);
    logger.info("Translation request handled", {
      targetLang: body.targetLang,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    logger.error("Translation error", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    res.status(500).json({ error: "Internal server error" });
  }
}
