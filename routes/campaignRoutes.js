// routes/campaignRoutes.js

import express from "express";
import {
  createCampaign,
  getCampaigns,
  getCampaignById,
  updateCampaign,
  cancelCampaign,
  deleteCampaign,

  getUserGroups,
  getUserTemplates,
} from "../controllers/campaignController.js";

const router = express.Router();

// Campaign CRUD
router.post("/", createCampaign);                    // Create new campaign
router.get("/", getCampaigns);                       // Get all campaigns for user
router.get("/:campaign_id", getCampaignById);   
router.put("/:campaign_id", updateCampaign);         // Update campaign (reschedule)
router.post("/:campaign_id/cancel", cancelCampaign); // Cancel campaign
router.delete("/:campaign_id", deleteCampaign);

// Helper endpoints for dropdowns
router.get("/helpers/groups", getUserGroups);        // Get user's groups
router.get("/helpers/templates", getUserTemplates); // Get single campaign details

export default router;