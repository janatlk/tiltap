import { Router } from "express";
import multer from "multer";
import {
  handleWebTranscribe,
  handleWebYouTube,
  handleWebTranslate,
  handleWebJobStatus,
  handleWebJobProgress,
  handleWebFeedback,
  handleWebFeedbackDetails,
} from "../controllers/webController";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  defParamCharset: "utf8",
});
const router = Router();

router.post("/transcribe", upload.single("file"), handleWebTranscribe);
router.post("/youtube", handleWebYouTube);
router.post("/translate", handleWebTranslate);
router.get("/jobs/:jobId", handleWebJobStatus);
router.get("/jobs/:jobId/progress", handleWebJobProgress);
router.post("/feedback", handleWebFeedback);
router.patch("/feedback/:id", handleWebFeedbackDetails);

export default router;
