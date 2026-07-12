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
} from "../controllers/adminController";

const router = Router();

router.get("/translations/pending", listPendingTranslations);
router.get("/translations/confirmed", listConfirmedTranslations);
router.get("/translations/rejected", listRejectedTranslations);
router.get("/translations/errors", listErrorTranslations);

router.get("/translations/search/:number", searchTranslationByRequestNumber);

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

export default router;
