// routes/agentRoutes.js

import express from "express";
import {
  createAgent,
  getAgents,
  getAgentById,
  updateAgent,
  deleteAgent,
  testAgent,
  getModelInfo,
  handleSamvaadikChat, // ← NEW IMPORT
} from "../controllers/agentController.js";

const router = express.Router();

// Model info (for frontend warnings)
router.get("/models", getModelInfo);

// Agent CRUD
router.post("/", createAgent);
router.get("/", getAgents);
router.get("/:agent_id", getAgentById);
router.put("/:agent_id", updateAgent);
router.delete("/:agent_id", deleteAgent);

// Test agent in isolation
router.post("/:agent_id/test", testAgent);

// ─── Samvaadik AI Assistant (agentic campaign loop) ───
// POST /api/agents/samvaadik/chat
// Body: { user_id: string, messages: [{ role, content }] }
// NOTE: This route MUST be declared before /:agent_id routes to avoid
//       Express treating "samvaadik" as an agent_id param.
router.post("/samvaadik/chat", handleSamvaadikChat);

export default router;
