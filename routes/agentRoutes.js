// routes/agentRoutes.js

import express from "express";
import multer from "multer";
import {
  createAgent,
  getAgents,
  getAgentById,
  updateAgent,
  deleteAgent,
  testAgent,
  getModelInfo,
  handleSamvaadikChat,
  handleGroupPreview,
  handleGroupFromCsv,
} from "../controllers/agentController.js";
import { extractKindeUser } from "../middleware/extractKindeUser.js";
import { authenticateUser } from "../middleware/authMiddleware.js";

const router = express.Router();

// Multer — for CSV/Excel preview upload only (max 10MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.split(".").pop().toLowerCase();
    const allowed = ["csv", "xlsx", "xls"];
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV and Excel files are allowed"));
    }
  },
});

// Model info
router.get("/models", getModelInfo);

// Agent CRUD
router.post("/", createAgent);
router.get("/", getAgents);
router.get("/:agent_id", getAgentById);
router.put("/:agent_id", updateAgent);
router.delete("/:agent_id", deleteAgent);

// Test agent in isolation
router.post("/:agent_id/test", testAgent);

// ─── Samvaadik AI Assistant ───────────────────────────────────────────────────
// NOTE: declared before /:agent_id to avoid param collision
//
// These routes act on the user's account (send WhatsApp messages, create
// campaigns/groups/templates), so they require a valid Kinde login. The
// user is taken from the verified token; any user_id in the body is
// overwritten so one user can never act as another.
const bindAuthenticatedUser = (req, res, next) => {
  req.body = { ...(req.body || {}), user_id: req.user.user_id };
  next();
};

// Agentic chat loop
router.post(
  "/samvaadik/chat",
  extractKindeUser,
  authenticateUser,
  bindAuthenticatedUser,
  handleSamvaadikChat,
);

// Step 1: Parse CSV, return preview + contacts array. NO DB writes.
// multipart/form-data: group_name, file  (multer runs before binding the user
// because it replaces req.body)
router.post(
  "/samvaadik/preview-group",
  extractKindeUser,
  authenticateUser,
  upload.single("file"),
  bindAuthenticatedUser,
  handleGroupPreview,
);

// Step 2: Create group + insert contacts. Accepts JSON contacts array from preview.
// application/json: { group_name, description, contacts: [...] }
router.post(
  "/samvaadik/create-group",
  extractKindeUser,
  authenticateUser,
  bindAuthenticatedUser,
  handleGroupFromCsv,
);

export default router;
