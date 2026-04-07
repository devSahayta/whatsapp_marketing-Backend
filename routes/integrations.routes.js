import express from "express";
import { getIntegrationStatus } from "../controllers/integrations.controller.js";
import { authenticateUser } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(authenticateUser);

router.get("/status", getIntegrationStatus);

export default router;
