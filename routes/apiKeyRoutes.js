// routes/apiKeyRoutes.js
// Kinde-authenticated routes for managing API keys.
// Mount in app.js: app.use("/api/apikeys", apiKeyRoutes)

import express from "express";
import { authenticateUser } from "../middleware/authMiddleware.js";
import {
  createApiKey,
  listApiKeys,
  updateApiKey,
  revokeApiKey,
  deleteApiKey,
  getUsageLogs,
} from "../controllers/apiKeyController.js";

const router = express.Router();

// All routes require Kinde auth
router.use(authenticateUser);

// POST   /api/apikeys          → create new key
router.post("/", createApiKey);

// GET    /api/apikeys          → list all keys (optional ?account_id=)
router.get("/", listApiKeys);

// PATCH  /api/apikeys/:key_id  → update name / webhook_url / scopes
router.patch("/:key_id", updateApiKey);

// POST   /api/apikeys/:key_id/revoke → soft-disable the key
router.post("/:key_id/revoke", revokeApiKey);

// DELETE /api/apikeys/:key_id  → permanently delete the key
router.delete("/:key_id", deleteApiKey);

// GET    /api/apikeys/logs     → usage logs
router.get("/logs", getUsageLogs);

export default router;
