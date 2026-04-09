// routes/chatbotRoutes.js

import express from "express";
import {
  createFlow,
  getFlows,
  getFlowById,
  updateFlow,
  deleteFlow,
  saveFlow,
  createNode,
  updateNode,
  deleteNode,
  createEdge,
  deleteEdge,
  getFlowSessions,
  getTemplatesForAccount,
} from "../controllers/chatbotController.js";

const router = express.Router();

// ── Flows ─────────────────────────────────────────────────────────────────────
router.post("/flows", createFlow);                         // Create flow
router.get("/flows", getFlows);                            // List flows (query: user_id, account_id)
router.get("/flows/:flow_id", getFlowById);                // Get flow + nodes + edges
router.put("/flows/:flow_id", updateFlow);                 // Update name/description/status
router.delete("/flows/:flow_id", deleteFlow);              // Delete flow (cascades nodes+edges)
router.post("/flows/:flow_id/save", saveFlow);             // Bulk save canvas (replace all nodes+edges)

// ── Nodes ─────────────────────────────────────────────────────────────────────
router.post("/flows/:flow_id/nodes", createNode);          // Add a node to a flow
router.put("/nodes/:node_id", updateNode);                 // Update node config / position
router.delete("/nodes/:node_id", deleteNode);              // Delete node (also removes its edges)

// ── Edges ─────────────────────────────────────────────────────────────────────
router.post("/flows/:flow_id/edges", createEdge);          // Connect two nodes
router.delete("/edges/:edge_id", deleteEdge);              // Remove a connection

// ── Sessions ──────────────────────────────────────────────────────────────────
router.get("/flows/:flow_id/sessions", getFlowSessions);   // View sessions (query: status)

// ── Helpers ───────────────────────────────────────────────────────────────────
router.get("/templates", getTemplatesForAccount);          // Approved templates for account (query: account_id)

export default router;
