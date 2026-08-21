// routes/shopifyRoutes.js
import express from "express";
import { authenticateUser } from "../middleware/authMiddleware.js";
import {
  connectStore,
  getConnections,
  disconnectStore,
} from "../controllers/shopifyController.js";

const router = express.Router();

// All routes protected by auth
router.use(authenticateUser);

// Store connection
router.post("/connect", connectStore);
router.get("/connections", getConnections);
router.delete("/connections/:id", disconnectStore);

export default router;
