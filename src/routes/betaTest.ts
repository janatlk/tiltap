import { Router } from "express";
import multer from "multer";
import { listBetaModels, handleBetaTranscribe, handleBetaLink, handleBetaCompare, getBetaJob, abortBetaJob } from "../controllers/betaTestController";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const router = Router();

router.get("/models", listBetaModels);
router.post("/transcribe", upload.single("file"), handleBetaTranscribe);
router.post("/link", handleBetaLink);
router.get("/jobs/:jobId", getBetaJob);
router.delete("/jobs/:jobId", abortBetaJob);
router.post("/compare", upload.single("file"), handleBetaCompare);

export default router;
