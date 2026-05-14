// controllers/agentController.js

import { supabase } from "../config/supabase.js";
import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "../config/anthropic.js";
import { CAMPAIGN_TOOLS, executeTool } from "../agents/agentTools.js"; // ← NEW IMPORT

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

// ─────────────────────────────────────────────────────────────────────────────
// ─── SAMVAADIK AI ASSISTANT  (agentic campaign loop) ─────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
//
//  Route:  POST /api/agents/samvaadik/chat
//  Body:   { user_id: string, messages: [{ role, content }] }
//
//  Flow:
//    1. Receives full conversation history from frontend
//    2. Calls Claude with CAMPAIGN_TOOLS defined in agentTools.js
//    3. If Claude calls a tool → executes it against Supabase → feeds result back
//    4. Loops until Claude produces a final text response
//    5. Returns { role: "assistant", content: "..." } to frontend
//
// ─────────────────────────────────────────────────────────────────────────────

const SAMVAADIK_SYSTEM_PROMPT = `You are Samvaadik AI, an assistant built into the Samvaadik WhatsApp marketing platform. You help users create and schedule campaigns through conversation.

Communicate like a knowledgeable colleague: clear, direct, no filler, no excessive punctuation. Do not use emojis. Write in plain sentences.

ID RULES (critical):
- group_id and wt_id are UUIDs like "f7e7c614-2734-4af7-94ad-ab0a8d4f3387".
- Never invent, guess, or construct IDs. Never use a template name as the template_id.
- Only use exact UUIDs returned from list_groups or list_templates tool results, copied character-for-character.
- If unsure, call the tool again rather than guessing.

DUPLICATE PREVENTION:
- Once create_campaign returns a campaign_id, the campaign exists. Stop. Never call create_campaign again.

CONVERSATION FLOW:

Step 1 - Resolve group and template
Call list_groups and list_templates once each to find the exact group and template the user mentioned.

Step 2 - Collect variable values if needed
Check variables_count from the template result.
- If 0: skip to step 3.
- If greater than 0: ask the user for each variable value before proceeding. Example for 3 variables:
  "This template has 3 fields that need values:
   - {{1}} Customer name (e.g. Rahul)
   - {{2}} Order number (e.g. ORD-1234)
   - {{3}} Amount (e.g. 500)
   What should I use for each?"
  Wait for the reply. Do not continue until all values are provided.

Step 3 - Show summary and ask for confirmation
Output this block with no extra text or emoji on the separator lines:
  ───────────────────────
  Campaign Summary
  Name: <campaign_name>
  Group: <group_name> (<count> contacts)
  Template: <template_name>
  Scheduled: <full day, date at time>
  Variables: <list values or "None">
  ───────────────────────
  Ready to create this campaign?

Step 4 - Create on confirmation only
Call create_campaign only after the user says yes, go ahead, confirm, or similar.
Pass template_variables exactly as collected. If no variables, pass {}.

OTHER RULES:
- If a time is given without a date (e.g. "6pm"), assume today. If that time has already passed, assume tomorrow. Always show the full date in the summary.
- After create_campaign succeeds, reply in one plain sentence stating the campaign name, group, and scheduled time. No emojis. Then stop.
- If a tool returns an error, explain it plainly. Never retry with fabricated IDs.
- Never show raw UUIDs. Always refer to things by name.`;

const MAX_TOOL_ITERATIONS = 8;

export const handleSamvaadikChat = async (req, res) => {
  try {
    const { user_id, messages } = req.body;

    // ── Validation ──────────────────────────────────────────────────────────
    if (!user_id) {
      return res
        .status(400)
        .json({ success: false, error: "user_id is required" });
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "messages array is required" });
    }

    // Validate message shape — each must have role + content
    for (const msg of messages) {
      if (!msg.role || !msg.content) {
        return res.status(400).json({
          success: false,
          error:
            "Each message must have role ('user' or 'assistant') and content.",
        });
      }
      if (!["user", "assistant"].includes(msg.role)) {
        return res.status(400).json({
          success: false,
          error: `Invalid role "${msg.role}". Must be "user" or "assistant".`,
        });
      }
    }

    // ── Agentic loop ────────────────────────────────────────────────────────
    let currentMessages = [...messages];
    let iteration = 0;

    while (iteration < MAX_TOOL_ITERATIONS) {
      iteration++;

      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001", // Fast + cheap for tool-use loop
        max_tokens: 1024,
        system: SAMVAADIK_SYSTEM_PROMPT,
        tools: CAMPAIGN_TOOLS,
        messages: currentMessages,
      });

      const { stop_reason, content, usage } = response;

      // ── Claude finished → return text reply ──
      if (stop_reason === "end_turn") {
        const textBlock = content.find((b) => b.type === "text");
        return res.json({
          success: true,
          role: "assistant",
          content: textBlock?.text || "",
          usage, // expose token usage for debugging
          iterations: iteration, // how many tool loops ran
        });
      }

      // ── Claude wants to call tool(s) ──
      if (stop_reason === "tool_use") {
        // Add Claude's response (with tool_use blocks) to history
        currentMessages.push({ role: "assistant", content });

        // Execute all tool calls in this turn
        const toolResults = [];

        for (const block of content) {
          if (block.type === "tool_use") {
            console.log(
              `[SamvaadikAI] Tool call: ${block.name}`,
              JSON.stringify(block.input),
            );

            const result = await executeTool(block.name, block.input, user_id);

            console.log(
              `[SamvaadikAI] Tool result: ${block.name}`,
              JSON.stringify(result),
            );

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(result),
            });
          }
        }

        // Feed all results back to Claude and loop
        currentMessages.push({ role: "user", content: toolResults });
        continue;
      }

      // ── Unexpected stop reason ──
      console.warn("[SamvaadikAI] Unexpected stop_reason:", stop_reason);
      return res.json({
        success: true,
        role: "assistant",
        content: "I ran into an unexpected issue. Please try again.",
        iterations: iteration,
      });
    }

    // ── Safety: exceeded max iterations ──
    return res.json({
      success: true,
      role: "assistant",
      content:
        "I had trouble completing that. Could you rephrase or break it into smaller steps?",
      iterations: iteration,
    });
  } catch (err) {
    console.error("❌ handleSamvaadikChat:", err);

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
