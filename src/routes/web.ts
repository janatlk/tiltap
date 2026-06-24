import { Router } from "express";
import multer from "multer";
import {
  handleWebTranscribe,
  handleWebYouTube,
  handleWebTranslate,
  handleWebJobStatus,
  handleWebJobProgress,
} from "../controllers/webController";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});
const router = Router();

router.post("/transcribe", upload.single("file"), handleWebTranscribe);
router.post("/youtube", handleWebYouTube);
router.post("/translate", handleWebTranslate);
router.get("/jobs/:jobId", handleWebJobStatus);
router.get("/jobs/:jobId/progress", handleWebJobProgress);

export default router;
