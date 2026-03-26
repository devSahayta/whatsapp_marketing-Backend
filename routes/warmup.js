// routes/warmup.js
import express from "express";
import {
  validateWarmup,
  getWarmupStatus,
} from "../controllers/WarmupController.js";

const router = express.Router();

// Validate warm-up before creating campaign
router.post("/validate", validateWarmup);

// // Get warm-up status for account
router.get("/status", getWarmupStatus);

export default router;
