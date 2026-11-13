// routes/whatsappRoutes.js
import express from "express";
import {
  verifyWebhook,
  handleIncomingMessage,
} from "../controllers/whatsappController.js";
import { authenticateUser } from "../middleware/authMiddleware.js";

const router = express.Router();

router.get("/whatsapp/webhook", verifyWebhook);
router.post("/whatsapp/webhook", handleIncomingMessage);

export default router;
