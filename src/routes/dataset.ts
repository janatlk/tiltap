import { Router } from "express";
import multer from "multer";
import { loginAnnotator, logoutAnnotator, annotatorSession } from "../services/datasetAuthService";
import {
  listTasks,
  createLinkTask,
  createUploadTask,
  getTask,
  claimTask,
  completeTask,
  deleteTask,
  updateSegment,
  getSegmentAudio,
  getStats,
  exportArchive,
  downloadArchive,
} from "../controllers/datasetController";

const upload = multer({
  storage: multer.memoryStorage(),
  // Source recordings are longer than what the bot accepts; an hour of MP3 is
  // roughly 60 MB, so this leaves headroom without inviting a whole archive.
  limits: { fileSize: 200 * 1024 * 1024 },
});

const router = Router();

// Login sits in front of the gate, or nobody could ever get in.
router.post("/login", loginAnnotator);
router.post("/logout", logoutAnnotator);
router.get("/session", annotatorSession);

// Every handler below checks the annotator session itself and answers 401 with
// loginRequired, so the page can show its login form instead of an error.
router.get("/tasks", listTasks);
router.post("/tasks/link", createLinkTask);
router.post("/tasks/upload", upload.single("file"), createUploadTask);
router.get("/tasks/:id", getTask);
router.post("/tasks/:id/claim", claimTask);
router.post("/tasks/:id/complete", completeTask);
router.delete("/tasks/:id", deleteTask);

router.put("/segments/:id", updateSegment);
router.get("/segments/:id/audio", getSegmentAudio);

router.get("/stats", getStats);
router.post("/export", exportArchive);
router.get("/export/archive", downloadArchive);

export default router;
