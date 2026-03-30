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
} from "../controllers/woocommerceController.js";

const router = express.Router();

// All routes protected by auth
router.use(authenticateUser);

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

export default router;
