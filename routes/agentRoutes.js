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

export default router;
