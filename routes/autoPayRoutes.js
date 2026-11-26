// routes/autoPayRoutes.js
import express from "express";
import {
  getSettings,
  updateSettings,
  testTrigger,
} from "../controllers/autoPayController.js";

const router = express.Router();

router.get("/:userId", getSettings);
router.post("/:userId", updateSettings);
router.post("/:userId/test-trigger", testTrigger); // TEMPORARY — remove once deductCredits calls maybeAutoReloadCredits directly

export default router;
