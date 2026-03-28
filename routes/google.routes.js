import express from "express";
import {
  connectGoogle,
  googleCallback,
  importContactsFromSheet,
  exportCampaignToSheet,
  getGoogleSheets,
} from "../controllers/google.controller.js";
import { authenticateUser } from "../middleware/authMiddleware.js";

const router = express.Router();

// Public — called by Google redirect, no auth token present
router.get("/callback", googleCallback);

// Protected routes
router.get("/connect", authenticateUser, connectGoogle);
router.get("/sheets", authenticateUser, getGoogleSheets);
router.post("/import-contacts", authenticateUser, importContactsFromSheet);
router.post("/export-campaign", authenticateUser, exportCampaignToSheet);

export default router;
