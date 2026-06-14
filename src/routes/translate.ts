import { Router } from "express";
import { handleTranslate } from "../controllers/translateController";

const router = Router();

router.post("/", handleTranslate);

export default router;
