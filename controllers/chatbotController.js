// controllers/chatbotController.js
// CRUD for chatbot flows, nodes, edges + session listing

import { supabase } from "../config/supabase.js";

// ─── FLOWS ────────────────────────────────────────────────────────────────────

/** POST /api/chatbot/flows */
export const createFlow = async (req, res) => {
  try {
    const { user_id, account_id, name, description } = req.body;

    if (!user_id || !account_id || !name) {
      return res
        .status(400)
        .json({
          success: false,
          error: "user_id, account_id and name are required",
        });
    }

    const { data, error } = await supabase
      .from("chatbot_flows")
      .insert({ user_id, account_id, name, description, status: "draft" })
      .select()
      .single();

    if (error) throw error;
    return res.status(201).json({ success: true, flow: data });
  } catch (err) {
    console.error("❌ createFlow:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

/** GET /api/chatbot/flows?user_id=&account_id= */
export const getFlows = async (req, res) => {
  try {
    const { user_id, account_id } = req.query;
    if (!user_id)
      return res
        .status(400)
        .json({ success: false, error: "user_id is required" });

    let query = supabase
      .from("chatbot_flows")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (account_id) query = query.eq("account_id", account_id);

    const { data, error } = await query;
    if (error) throw error;
    return res.json({ success: true, flows: data });
  } catch (err) {
    console.error("❌ getFlows:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

/** GET /api/chatbot/flows/:flow_id */
export const getFlowById = async (req, res) => {
  try {
    const { flow_id } = req.params;

    // Return flow + all its nodes and edges in one call
    const [flowRes, nodesRes, edgesRes] = await Promise.all([
      supabase
        .from("chatbot_flows")
        .select("*")
        .eq("flow_id", flow_id)
        .single(),
      supabase.from("chatbot_nodes").select("*").eq("flow_id", flow_id),
      supabase.from("chatbot_edges").select("*").eq("flow_id", flow_id),
    ]);

    if (flowRes.error) throw flowRes.error;

    return res.json({
      success: true,
      flow: flowRes.data,
      nodes: nodesRes.data || [],
      edges: edgesRes.data || [],
    });
  } catch (err) {
    console.error("❌ getFlowById:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

/** PUT /api/chatbot/flows/:flow_id */
export const updateFlow = async (req, res) => {
  try {
    const { flow_id } = req.params;
    const { name, description, status } = req.body;

    const { data, error } = await supabase
      .from("chatbot_flows")
      .update({
        name,
        description,
        status,
        updated_at: new Date().toISOString(),
      })
      .eq("flow_id", flow_id)
      .select()
      .single();

    if (error) throw error;
    return res.json({ success: true, flow: data });
  } catch (err) {
    console.error("❌ updateFlow:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

/** DELETE /api/chatbot/flows/:flow_id */
export const deleteFlow = async (req, res) => {
  try {
    const { flow_id } = req.params;

    // Nodes and edges have ON DELETE CASCADE, so deleting the flow is enough
    const { error } = await supabase
      .from("chatbot_flows")
      .delete()
      .eq("flow_id", flow_id);

    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error("❌ deleteFlow:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── NODES ────────────────────────────────────────────────────────────────────

/** POST /api/chatbot/flows/:flow_id/nodes */
export const createNode = async (req, res) => {
  try {
    const { flow_id } = req.params;
    const { node_type, config = {}, position_x = 0, position_y = 0 } = req.body;

    const VALID_TYPES = [
      "keyword_trigger",
      "api_trigger",
      "send_message",
      "send_template",
      "wait_for_input",
      "condition",
      "http_request",
      "delay",
      "ai_fallback",
      "handoff_to_agent",
      "end_flow",
      "trigger_campaign",
    ];

    if (!node_type || !VALID_TYPES.includes(node_type)) {
      return res
        .status(400)
        .json({
          success: false,
          error: `Invalid node_type. Must be one of: ${VALID_TYPES.join(", ")}`,
        });
    }

    const { data, error } = await supabase
      .from("chatbot_nodes")
      .insert({ flow_id, node_type, config, position_x, position_y })
      .select()
      .single();

    if (error) throw error;
    return res.status(201).json({ success: true, node: data });
  } catch (err) {
    console.error("❌ createNode:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

/** PUT /api/chatbot/nodes/:node_id */
export const updateNode = async (req, res) => {
  try {
    const { node_id } = req.params;
    const { config, position_x, position_y } = req.body;

    const patch = {};
    if (config !== undefined) patch.config = config;
    if (position_x !== undefined) patch.position_x = position_x;
    if (position_y !== undefined) patch.position_y = position_y;

    const { data, error } = await supabase
      .from("chatbot_nodes")
      .update(patch)
      .eq("node_id", node_id)
      .select()
      .single();

    if (error) throw error;
    return res.json({ success: true, node: data });
  } catch (err) {
    console.error("❌ updateNode:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

/** DELETE /api/chatbot/nodes/:node_id */
export const deleteNode = async (req, res) => {
  try {
    const { node_id } = req.params;

    // Delete connected edges first (edges reference nodes but may not cascade if the DB wasn't set up yet)
    await supabase
      .from("chatbot_edges")
      .delete()
      .or(`source_node_id.eq.${node_id},target_node_id.eq.${node_id}`);

    const { error } = await supabase
      .from("chatbot_nodes")
      .delete()
      .eq("node_id", node_id);

    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error("❌ deleteNode:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── EDGES ────────────────────────────────────────────────────────────────────

/** POST /api/chatbot/flows/:flow_id/edges */
export const createEdge = async (req, res) => {
  try {
    const { flow_id } = req.params;
    const { source_node_id, target_node_id, condition_label = null } = req.body;

    if (!source_node_id || !target_node_id) {
      return res
        .status(400)
        .json({
          success: false,
          error: "source_node_id and target_node_id are required",
        });
    }

    const { data, error } = await supabase
      .from("chatbot_edges")
      .insert({ flow_id, source_node_id, target_node_id, condition_label })
      .select()
      .single();

    if (error) throw error;
    return res.status(201).json({ success: true, edge: data });
  } catch (err) {
    console.error("❌ createEdge:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

/** DELETE /api/chatbot/edges/:edge_id */
export const deleteEdge = async (req, res) => {
  try {
    const { edge_id } = req.params;
    const { error } = await supabase
      .from("chatbot_edges")
      .delete()
      .eq("edge_id", edge_id);

    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error("❌ deleteEdge:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── BULK SAVE (canvas save) ──────────────────────────────────────────────────

/**
 * POST /api/chatbot/flows/:flow_id/save
 * Replaces all nodes and edges for a flow in one shot.
 * Frontend sends the full canvas state on every save.
 *
 * Body: { nodes: [...], edges: [...] }
 * Each node: { node_id (optional), node_type, config, position_x, position_y }
 * Each edge: { source_node_id, target_node_id, condition_label }
 */
export const saveFlow = async (req, res) => {
  try {
    const { flow_id } = req.params;
    const { nodes = [], edges = [] } = req.body;

    // 1. Delete existing nodes (cascade deletes edges too via FK)
    await supabase.from("chatbot_edges").delete().eq("flow_id", flow_id);
    await supabase.from("chatbot_nodes").delete().eq("flow_id", flow_id);

    if (nodes.length === 0) {
      return res.json({ success: true, nodes: [], edges: [] });
    }

    // 2. Insert nodes — keep client-provided node_id so edges can reference them
    const nodeRows = nodes.map((n) => ({
      ...(n.node_id ? { node_id: n.node_id } : {}),
      flow_id,
      node_type: n.node_type,
      config: n.config || {},
      position_x: n.position_x || 0,
      position_y: n.position_y || 0,
    }));

    const { data: insertedNodes, error: nodeErr } = await supabase
      .from("chatbot_nodes")
      .insert(nodeRows)
      .select();

    if (nodeErr) throw nodeErr;

    // 3. Insert edges
    if (edges.length > 0) {
      const edgeRows = edges.map((e) => ({
        flow_id,
        source_node_id: e.source_node_id,
        target_node_id: e.target_node_id,
        condition_label: e.condition_label || null,
      }));

      const { error: edgeErr } = await supabase
        .from("chatbot_edges")
        .insert(edgeRows);

      if (edgeErr) throw edgeErr;
    }

    // 4. Update flow's updated_at
    await supabase
      .from("chatbot_flows")
      .update({ updated_at: new Date().toISOString() })
      .eq("flow_id", flow_id);

    return res.json({ success: true, nodes: insertedNodes });
  } catch (err) {
    console.error("❌ saveFlow:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── SESSIONS ─────────────────────────────────────────────────────────────────

/** GET /api/chatbot/flows/:flow_id/sessions */
export const getFlowSessions = async (req, res) => {
  try {
    const { flow_id } = req.params;
    const { status } = req.query;

    let query = supabase
      .from("chatbot_sessions")
      .select("*, chats(phone_number, person_name)")
      .eq("flow_id", flow_id)
      .order("started_at", { ascending: false })
      .limit(100);

    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) throw error;
    return res.json({ success: true, sessions: data });
  } catch (err) {
    console.error("❌ getFlowSessions:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── TEMPLATE HELPER ─────────────────────────────────────────────────────────

/** GET /api/chatbot/templates?account_id=
 * Returns approved templates for the account (reused from campaigns dropdown)
 */
export const getTemplatesForAccount = async (req, res) => {
  try {
    const { account_id } = req.query;
    if (!account_id)
      return res
        .status(400)
        .json({ success: false, error: "account_id is required" });

    const { data, error } = await supabase
      .from("whatsapp_templates")
      .select(
        "wt_id, name, language, category, components, header_format, variables, buttons, status",
      )
      .eq("account_id", account_id)
      .eq("status", "approved")
      .order("name");

    if (error) throw error;
    return res.json({ success: true, templates: data });
  } catch (err) {
    console.error("❌ getTemplatesForAccount:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
