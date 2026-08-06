import { Router } from "express";
import {
  listPendingTranslations,
  listConfirmedTranslations,
  listRejectedTranslations,
  listErrorTranslations,
  confirmTranslationEntry,
  rejectTranslationEntry,
  deleteTranslationEntry,
  getTranslationEntry,
  searchTranslationByRequestNumber,
  listWebJobs,
  getWebJobByRequestNumber,
  getLiveProcesses,
  getCobaltConfig,
  saveCobaltConfig,
  testCobaltConfig,
  listFeedbackEntries,
  listGlossary,
  saveGlossaryEntry,
  deleteGlossaryEntry,
  previewGlossaryMatches,
  replyToFeedbackEntry,
  setFeedbackStatus,
} from "../controllers/adminController";

const router = Router();

router.get("/translations/pending", listPendingTranslations);
router.get("/translations/confirmed", listConfirmedTranslations);
router.get("/translations/rejected", listRejectedTranslations);
router.get("/translations/errors", listErrorTranslations);

router.get("/translations/search/:number", searchTranslationByRequestNumber);

router.get("/feedback", listFeedbackEntries);

router.get("/web-jobs", listWebJobs);
router.get("/web-jobs/search/:number", getWebJobByRequestNumber);
router.get("/processes", getLiveProcesses);

router.get("/translations/:hash/:lang", getTranslationEntry);
router.post("/translations/:hash/:lang/confirm", confirmTranslationEntry);
router.post("/translations/confirm", confirmTranslationEntry);
router.post("/translations/:hash/:lang/reject", rejectTranslationEntry);
router.delete("/translations/:hash/:lang", deleteTranslationEntry);

router.get("/cobalt", getCobaltConfig);
router.post("/cobalt", saveCobaltConfig);
router.post("/cobalt/test", testCobaltConfig);

// Bilingual glossary injected into the translation prompt.
router.get("/glossary", listGlossary);
router.post("/glossary", saveGlossaryEntry);
router.delete("/glossary/:id", deleteGlossaryEntry);
router.post("/glossary/preview", previewGlossaryMatches);

// Problem reports: answer the user, mark resolved or defer.
router.post("/feedback/:id/reply", replyToFeedbackEntry);
router.post("/feedback/:id/status", setFeedbackStatus);

export default router;
