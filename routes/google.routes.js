import express from "express";
import {
  connectGoogle,
  googleCallback,
  importContactsFromSheet,
  exportCampaignToSheet,
} from "../controllers/google.controller.js";
import { authenticateUser } from "../middleware/authMiddleware.js";

const router = express.Router();

// 🔐 protected routes
router.get("/connect", connectGoogle, authenticateUser);
router.get("/callback", googleCallback);

router.post("/import-contacts", importContactsFromSheet);
router.post("/export-campaign", exportCampaignToSheet);

export default router;
