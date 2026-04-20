// controllers/agentController.js

import { supabase } from "../config/supabase.js";
import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "../config/anthropic.js";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const VALID_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
];

// ─── MODEL INFO (sent to frontend for warnings) ───────────────────────────────
export const getModelInfo = async (req, res) => {
  return res.json({
    success: true,
    models: [
      {
        id: "claude-haiku-4-5-20251001",
        label: "Claude Haiku",
        description: "Fastest and most economical. Best for simple Q&A.",
        warning: null,
        input_cost_per_1k: 0.00025,
        output_cost_per_1k: 0.00125,
        recommended: true,
      },
      {
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet",
        description: "Balanced speed and intelligence. Good for complex flows.",
        warning:
          "Sonnet uses ~4x more tokens than Haiku. Monitor your usage carefully.",
        input_cost_per_1k: 0.003,
        output_cost_per_1k: 0.015,
        recommended: false,
      },
      {
        id: "claude-opus-4-6",
        label: "Claude Opus",
        description: "Most powerful. Best for nuanced, multi-step reasoning.",
        warning:
          "Opus uses ~15x more tokens than Haiku. Only use if absolutely needed.",
        input_cost_per_1k: 0.015,
        output_cost_per_1k: 0.075,
        recommended: false,
      },
    ],
  });
};

// ─── CREATE AGENT ─────────────────────────────────────────────────────────────
export const createAgent = async (req, res) => {
  try {
    const {
      user_id,
      account_id,
      name,
      description,
      system_prompt,
      model,
      temperature,
      max_turns,
      fallback_action,
      exit_keywords,
    } = req.body;

    // Validation
    if (!user_id || !account_id || !name) {
      return res.status(400).json({
        success: false,
        error: "user_id, account_id and name are required",
      });
    }

    if (!name.trim()) {
      return res.status(400).json({
        success: false,
        error: "Agent name cannot be empty",
      });
    }

    if (model && !VALID_MODELS.includes(model)) {
      return res.status(400).json({
        success: false,
        error: `Invalid model. Must be one of: ${VALID_MODELS.join(", ")}`,
      });
    }

    const { data, error } = await supabase
      .from("chatbot_agents")
      .insert({
        user_id,
        account_id,
        name: name.trim(),
        description: description?.trim() || null,
        system_prompt: system_prompt?.trim() || "",
        model: model || "claude-haiku-4-5-20251001",
        temperature: temperature ?? 0.7,
        max_turns: max_turns ?? 10,
        fallback_action: fallback_action || "handoff_to_agent",
        exit_keywords: exit_keywords || [],
        status: "active",
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({ success: true, agent: data });
  } catch (err) {
    console.error("❌ createAgent:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── LIST AGENTS ──────────────────────────────────────────────────────────────
export const getAgents = async (req, res) => {
  try {
    const { user_id, account_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id is required",
      });
    }

    let query = supabase
      .from("chatbot_agents")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (account_id) {
      query = query.eq("account_id", account_id);
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.json({ success: true, agents: data });
  } catch (err) {
    console.error("❌ getAgents:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── GET SINGLE AGENT ─────────────────────────────────────────────────────────
export const getAgentById = async (req, res) => {
  try {
    const { agent_id } = req.params;

    const { data, error } = await supabase
      .from("chatbot_agents")
      .select("*")
      .eq("agent_id", agent_id)
      .single();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ success: false, error: "Agent not found" });
    }

    return res.json({ success: true, agent: data });
  } catch (err) {
    console.error("❌ getAgentById:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── UPDATE AGENT ─────────────────────────────────────────────────────────────
export const updateAgent = async (req, res) => {
  try {
    const { agent_id } = req.params;
    const {
      name,
      description,
      system_prompt,
      model,
      temperature,
      max_turns,
      fallback_action,
      exit_keywords,
      status,
    } = req.body;

    if (model && !VALID_MODELS.includes(model)) {
      return res.status(400).json({
        success: false,
        error: `Invalid model. Must be one of: ${VALID_MODELS.join(", ")}`,
      });
    }

    // Build patch — only update fields that were sent
    const patch = { updated_at: new Date().toISOString() };
    if (name !== undefined) patch.name = name.trim();
    if (description !== undefined)
      patch.description = description?.trim() || null;
    if (system_prompt !== undefined) patch.system_prompt = system_prompt.trim();
    if (model !== undefined) patch.model = model;
    if (temperature !== undefined) patch.temperature = temperature;
    if (max_turns !== undefined) patch.max_turns = max_turns;
    if (fallback_action !== undefined) patch.fallback_action = fallback_action;
    if (exit_keywords !== undefined) patch.exit_keywords = exit_keywords;
    if (status !== undefined) patch.status = status;

    const { data, error } = await supabase
      .from("chatbot_agents")
      .update(patch)
      .eq("agent_id", agent_id)
      .select()
      .single();

    if (error) throw error;

    return res.json({ success: true, agent: data });
  } catch (err) {
    console.error("❌ updateAgent:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── DELETE AGENT ─────────────────────────────────────────────────────────────
export const deleteAgent = async (req, res) => {
  try {
    const { agent_id } = req.params;

    // Check if this agent is used in any active flows before deleting
    const { data: usedInNodes } = await supabase
      .from("chatbot_nodes")
      .select("node_id, flow_id")
      .eq("node_type", "ai_agent")
      .contains("config", { agent_id });

    if (usedInNodes && usedInNodes.length > 0) {
      return res.status(409).json({
        success: false,
        error: `This agent is used in ${usedInNodes.length} flow(s). Remove it from flows before deleting.`,
        used_in: usedInNodes,
      });
    }

    const { error } = await supabase
      .from("chatbot_agents")
      .delete()
      .eq("agent_id", agent_id);

    if (error) throw error;

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ deleteAgent:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── TEST AGENT (single turn chat for testing in UI) ─────────────────────────
export const testAgent = async (req, res) => {
  try {
    const { agent_id } = req.params;
    const { message, history = [] } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({
        success: false,
        error: "message is required",
      });
    }

    // Fetch agent config
    const { data: agent, error: agentErr } = await supabase
      .from("chatbot_agents")
      .select("*")
      .eq("agent_id", agent_id)
      .single();

    if (agentErr || !agent) {
      return res.status(404).json({ success: false, error: "Agent not found" });
    }

    // Build messages array for Claude
    // history = [ { role: "user"|"assistant", content: "..." }, ... ]
    const messages = [...history, { role: "user", content: message.trim() }];

    const response = await anthropic.messages.create({
      model: agent.model,
      max_tokens: 1024,
      temperature: parseFloat(agent.temperature),
      system: agent.system_prompt || "You are a helpful assistant.",
      messages,
    });

    const reply = response.content?.[0]?.text || "";

    return res.json({
      success: true,
      reply,
      // Send back updated history so frontend can keep track
      updated_history: [...messages, { role: "assistant", content: reply }],
      usage: response.usage, // input/output tokens for transparency
    });
  } catch (err) {
    console.error("❌ testAgent:", err);

    // Handle Anthropic-specific errors cleanly
    if (err.status === 401) {
      return res.status(500).json({
        success: false,
        error:
          "Invalid Anthropic API key. Check your ANTHROPIC_API_KEY env variable.",
      });
    }
    if (err.status === 429) {
      return res.status(429).json({
        success: false,
        error: "Rate limit hit. Try again in a moment.",
      });
    }

    return res.status(500).json({ success: false, error: err.message });
  }
};
