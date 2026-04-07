// routes/woocommerceRoutes.js
import express from "express";
import { authenticateUser } from "../middleware/authMiddleware.js";
import {
  connectStore,
  getConnections,
  disconnectStore,
  createAutomation,
  getAutomations,
  updateAutomation,
  deleteAutomation,
  getLogs,
  getPlaceholderHandle,
} from "../controllers/woocommerceController.js";

import { getAccountId } from "../controllers/woocommerceController.js";

import {
  getCartRecoveryStats,
  getCartRecoveryLogs,
} from "../controllers/cartRecoveryController.js";

const router = express.Router();

// All routes protected by auth
router.use(authenticateUser);
router.get("/account-id", getAccountId);
// Store connection
router.post("/connect", connectStore);
router.get("/connections", getConnections);
router.delete("/connections/:id", disconnectStore);

// Automations
router.post("/automations", createAutomation);
router.get("/automations", getAutomations);
router.patch("/automations/:id", updateAutomation);
router.delete("/automations/:id", deleteAutomation);

// Logs
router.get("/logs", getLogs);

router.post("/placeholder-handle", getPlaceholderHandle);

router.get("/cart-recovery/stats", getCartRecoveryStats);
router.get("/cart-recovery/logs", getCartRecoveryLogs);

export default router;
