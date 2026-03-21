import express from "express";
import {
  createWAccount,
  getWAccount,
  syncWhatsAppTier,
  updateWAccount,
} from "../controllers/waccountController.js";

const router = express.Router();

// CREATE (if not exist)
router.post("/create-waccount", createWAccount);

// FETCH
router.get("/get-waccount", getWAccount);

// UPDATE
router.post("/update-waccount", updateWAccount);

// sync with meta and update quality rating & messaging tier
router.post("/sync-meta-info", syncWhatsAppTier);

export default router;
