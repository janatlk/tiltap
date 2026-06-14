import { Router } from "express";
import { handleTelegramWebhook } from "../controllers/telegramController";

const router = Router();

router.post("/telegram", handleTelegramWebhook);

// WhatsApp placeholder for Sprint 1
router.post("/whatsapp", (_req, res) => {
  res.sendStatus(200);
});

export default router;
