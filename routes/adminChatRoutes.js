import express from "express";
import { sendAdminMessage } from "../controllers/adminChatController.js";
import { sendChatTemplate } from "../controllers/chatTemplateController.js";
import { extractKindeUser } from "../middleware/extractKindeUser.js";
import { authenticateUser } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post(
  "/chat/send",
  extractKindeUser,
  authenticateUser,
  sendAdminMessage
);

// Send one approved template (incl. carousel) to a chat — works outside the 24h window
router.post(
  "/chat/send-template",
  extractKindeUser,
  authenticateUser,
  sendChatTemplate
);

// router.post(
//   "/chat/resume-ai",
//   extractKindeUser,
//   authenticateUser,
//   resumeAIChat
// );

export default router;
