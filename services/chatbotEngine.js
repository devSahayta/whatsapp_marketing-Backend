// services/chatbotEngine.js
// Core chatbot engine — processes nodes and advances sessions

import axios from "axios";
import { supabase } from "../config/supabase.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Replace {{variable}} placeholders in a string using session variables.
 */
function interpolate(text = "", variables = {}) {
  return text.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, key) => {
    const parts = key.split(".");
    let val = variables;
    for (const p of parts) {
      if (val == null) return "";
      val = val[p];
    }
    return val ?? "";
  });
}

/**
 * Fetch the WhatsApp account row so we can use its token + phone_number_id.
 */
async function getWaAccount(account_id) {
  const { data, error } = await supabase
    .from("whatsapp_accounts")
    .select(
      "wa_id, phone_number_id, system_user_access_token, business_phone_number",
    )
    .eq("wa_id", account_id)
    .single();
  if (error) throw new Error("WA account not found: " + account_id);
  return data;
}

/**
 * Send a plain text WhatsApp message using the account's own token.
 */
async function sendText(to, text, waAccount) {
  const { phone_number_id, system_user_access_token } = waAccount;
  const res = await axios.post(
    `https://graph.facebook.com/v21.0/${phone_number_id}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${system_user_access_token}`,
        "Content-Type": "application/json",
      },
    },
  );
  return res.data;
}

/**
 * Send a WhatsApp template message using the account's own token.
 * Resolves template_variable_map against session variables.
 */
async function sendTemplate(to, nodeConfig, sessionVariables, waAccount) {
  console.log({ nodeConfig, sessionVariables });
  const { template_id, template_name, template_variable_map = {} } = nodeConfig;
  // const { wt_id, template_variable_map = {} } = nodeConfig;
  const { phone_number_id, system_user_access_token } = waAccount;

  // Load template from DB — fetch media_id stored on the template row itself
  const { data: template, error } = await supabase
    .from("whatsapp_templates")
    .select("name, language, header_format, media_id")
    // .eq("wt_id", wt_id)
    .eq("template_id", template_id)
    .eq("name", template_name)
    .single();
  if (error || !template) throw new Error("Template not found: " + template_id);

  const components = [];

  // Header — node config can override the media_id, otherwise use the template's stored media_id
  const mediaId = nodeConfig.media_id || template.media_id;
  const headerFormat = template.header_format?.toUpperCase();

  if (mediaId && ["IMAGE", "VIDEO", "DOCUMENT"].includes(headerFormat)) {
    const mediaType = headerFormat.toLowerCase(); // "image" | "video" | "document"
    components.push({
      type: "header",
      parameters: [{ type: mediaType, [mediaType]: { id: mediaId } }],
    });
  }

  // Body variables — template_variable_map: { "1": "{{name}}", "2": "{{order_id}}" }
  const bodyParams = Object.keys(template_variable_map)
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => ({
      type: "text",
      text: interpolate(template_variable_map[key], sessionVariables),
    }));

  if (bodyParams.length > 0) {
    components.push({ type: "body", parameters: bodyParams });
  }

  const res = await axios.post(
    `https://graph.facebook.com/v21.0/${phone_number_id}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language || "en_US" },
        components,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${system_user_access_token}`,
        "Content-Type": "application/json",
      },
    },
  );
  return res.data;
}

// ─── session helpers ──────────────────────────────────────────────────────────

async function getActiveSession(chat_id) {
  const { data } = await supabase
    .from("chatbot_sessions")
    .select("*")
    .eq("chat_id", chat_id)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function updateSession(session_id, patch) {
  await supabase
    .from("chatbot_sessions")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("session_id", session_id);
}

async function getNode(node_id) {
  const { data, error } = await supabase
    .from("chatbot_nodes")
    .select("*")
    .eq("node_id", node_id)
    .single();
  if (error) throw new Error("Node not found: " + node_id);
  return data;
}

/**
 * Get the next node(s) from edges.
 * condition_label null  → unconditional edge
 * condition_label set   → branching edge (buttons / conditions)
 */
async function getNextNode(source_node_id, condition_label = null) {
  let query = supabase
    .from("chatbot_edges")
    .select("target_node_id, condition_label")
    .eq("source_node_id", source_node_id);

  if (condition_label) {
    query = query.eq("condition_label", condition_label);
  } else {
    query = query.is("condition_label", null);
  }

  const { data } = await query.limit(1).maybeSingle();
  return data?.target_node_id ?? null;
}

// ─── node processors ──────────────────────────────────────────────────────────

async function processSendMessage(node, session, phoneNumber, waAccount) {
  const text = interpolate(node.config.text || "", session.variables);
  await sendText(phoneNumber, text, waAccount);

  // Advance immediately to next node
  const nextId = await getNextNode(node.node_id);
  return { next_node_id: nextId, variables: session.variables };
}

async function processSendTemplate(node, session, phoneNumber, waAccount) {
  await sendTemplate(phoneNumber, node.config, session.variables, waAccount);

  const nextId = await getNextNode(node.node_id);
  return { next_node_id: nextId, variables: session.variables };
}

async function processWaitForInput(node, session) {
  // Stay on this node — we are waiting for user's next message.
  // The caller must NOT advance. Return same node_id.
  return {
    next_node_id: node.node_id,
    variables: session.variables,
    waiting: true,
  };
}

async function processCondition(node, session) {
  const { variable, operator, value } = node.config;

  // Get the actual value of the variable from session
  const actual = String(session.variables[variable] ?? "").trim().toLowerCase();
  const expected = String(value ?? "").trim().toLowerCase();

  let conditionMet = false;
  switch (operator) {
    case "==":  conditionMet = actual === expected; break;
    case "!=":  conditionMet = actual !== expected; break;
    case ">":   conditionMet = Number(actual) > Number(expected); break;
    case "<":   conditionMet = Number(actual) < Number(expected); break;
    case ">=":  conditionMet = Number(actual) >= Number(expected); break;
    case "<=":  conditionMet = Number(actual) <= Number(expected); break;
    case "contains": conditionMet = actual.includes(expected); break;
    default:
      console.warn("⚠️ Unknown condition operator:", operator);
  }

  console.log(`🔀 Condition [${variable} ${operator} ${value}]: actual="${actual}" → ${conditionMet}`);

  // Edges from a condition node always have condition_label "yes" or "no"
  // (set by the frontend via the ReactFlow sourceHandle)
  const nextId = await getNextNode(node.node_id, conditionMet ? "yes" : "no");

  return { next_node_id: nextId, variables: session.variables };
}

async function processHttpRequest(node, session) {
  const { method = "GET", url, save_response_as } = node.config;
  const resolvedUrl = interpolate(url, session.variables);

  let responseData = null;
  try {
    const res = await axios({ method, url: resolvedUrl });
    responseData = res.data;
  } catch (err) {
    console.error("❌ HTTP Request node error:", err.message);
  }

  const updatedVars = { ...session.variables };
  if (save_response_as && responseData !== null) {
    updatedVars[save_response_as] = responseData;
  }

  const nextId = await getNextNode(node.node_id);
  return { next_node_id: nextId, variables: updatedVars };
}

async function processDelay(node, session) {
  const seconds = node.config.seconds || 0;
  if (seconds > 0) {
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
  const nextId = await getNextNode(node.node_id);
  return { next_node_id: nextId, variables: session.variables };
}

async function processAiFallback(node, session, phoneNumber, waAccount) {
  // Simple fallback — sends a configurable fallback message
  const fallbackText =
    node.config.fallback_message ||
    "I'm sorry, I didn't understand that. Please try again or type HELP.";
  await sendText(phoneNumber, fallbackText, waAccount);

  const nextId = await getNextNode(node.node_id);
  return { next_node_id: nextId, variables: session.variables };
}

async function processHandoffToAgent(node, session, phoneNumber, waAccount, chat_id) {
  // Send handoff message to user if configured
  const message = node.config?.message;
  if (message) {
    const text = interpolate(message, session.variables);
    await sendText(phoneNumber, text, waAccount);
  }

  // Switch chat to MANUAL mode and end session
  await supabase
    .from("chats")
    .update({ mode: "MANUAL", active_flow_id: null })
    .eq("chat_id", chat_id);

  return {
    next_node_id: null,
    variables: session.variables,
    status: "handed_off",
  };
}

async function processEndFlow(node, session, chat_id) {
  await supabase
    .from("chats")
    .update({ mode: "MANUAL", active_flow_id: null })
    .eq("chat_id", chat_id);

  return {
    next_node_id: null,
    variables: session.variables,
    status: "completed",
  };
}

// ─── dispatch ────────────────────────────────────────────────────────────────

async function processNode(node, session, phoneNumber, waAccount) {
  switch (node.node_type) {
    case "send_message":
      return processSendMessage(node, session, phoneNumber, waAccount);
    case "send_template":
      return processSendTemplate(node, session, phoneNumber, waAccount);
    case "wait_for_input":
      return processWaitForInput(node, session);
    case "condition":
      return processCondition(node, session, phoneNumber, waAccount);
    case "http_request":
      return processHttpRequest(node, session);
    case "delay":
      return processDelay(node, session);
    case "ai_fallback":
      return processAiFallback(node, session, phoneNumber, waAccount);
    case "handoff_to_agent":
      return processHandoffToAgent(node, session, phoneNumber, waAccount, session.chat_id);
    case "end_flow":
      return processEndFlow(node, session, session.chat_id);
    default:
      console.warn("⚠️ Unknown node type:", node.node_type);
      return {
        next_node_id: null,
        variables: session.variables,
        status: "completed",
      };
  }
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Called by whatsappController when an incoming message arrives for a chat in BOT mode.
 *
 * Flow:
 *  1. Load active session for chat.
 *  2. If session waiting at a wait_for_input node → save user input to variables, advance.
 *  3. Run nodes sequentially until we hit a wait_for_input or terminal node.
 */
export async function handleBotMessage({
  chat_id,
  phone_number,
  user_text,
  account_id,
}) {
  try {
    const session = await getActiveSession(chat_id);
    if (!session) {
      // Stale BOT mode — session ended but chat was never reset to MANUAL.
      // Reset now and re-check keyword triggers so the user can restart the flow.
      console.warn(
        "⚠️ No active chatbot session for chat:",
        chat_id,
        "— resetting to MANUAL",
      );
      await supabase
        .from("chats")
        .update({ mode: "MANUAL", active_flow_id: null })
        .eq("chat_id", chat_id);

      const matchedFlowId = await matchKeywordTrigger(user_text, account_id);
      if (matchedFlowId) {
        await startBotSession({
          chat_id,
          phone_number,
          flow_id: matchedFlowId,
          account_id,
          user_text,
        });
      }
      return;
    }

    const waAccount = await getWaAccount(account_id);
    let currentNodeId = session.current_node_id;
    let variables = { ...session.variables };

    // If we were waiting for user input, capture it
    if (currentNodeId) {
      const currentNode = await getNode(currentNodeId);
      if (currentNode.node_type === "wait_for_input") {
        const saveAs = currentNode.config.save_as || "user_input";
        variables[saveAs] = user_text;

        // Advance past the wait_for_input node
        currentNodeId = await getNextNode(currentNodeId);
      }
    }

    // Run nodes until we must wait or terminate
    while (currentNodeId) {
      const node = await getNode(currentNodeId);
      console.log(`🤖 Processing node [${node.node_type}] ${node.node_id}`);

      const result = await processNode(
        node,
        { ...session, variables, chat_id },
        phone_number,
        waAccount,
      );

      variables = result.variables;
      const sessionStatus = result.status || "active";

      if (sessionStatus !== "active") {
        // Terminal node — end or handoff
        await updateSession(session.session_id, {
          current_node_id: null,
          variables,
          status: sessionStatus,
        });
        return;
      }

      if (result.waiting) {
        // wait_for_input — stay on this node, persist and stop
        await updateSession(session.session_id, {
          current_node_id: currentNodeId,
          variables,
        });
        return;
      }

      currentNodeId = result.next_node_id;
    }

    // Ran out of nodes — treat as completed
    await updateSession(session.session_id, {
      current_node_id: null,
      variables,
      status: "completed",
    });
    await supabase
      .from("chats")
      .update({ mode: "MANUAL", active_flow_id: null })
      .eq("chat_id", chat_id);
  } catch (err) {
    console.error("❌ Chatbot engine error:", err);
  }
}

/**
 * Start a new chatbot session for a chat.
 * Finds the keyword_trigger node in the flow and begins processing from the first connected node.
 */
export async function startBotSession({
  chat_id,
  phone_number,
  flow_id,
  account_id,
  user_text,
}) {
  try {
    // Find the trigger node
    const { data: triggerNode, error } = await supabase
      .from("chatbot_nodes")
      .select("*")
      .eq("flow_id", flow_id)
      .eq("node_type", "keyword_trigger")
      .limit(1)
      .maybeSingle();

    if (error || !triggerNode) {
      console.error("❌ No keyword_trigger node found for flow:", flow_id);
      return;
    }

    // Create session
    const { data: session } = await supabase
      .from("chatbot_sessions")
      .insert({
        flow_id,
        chat_id,
        current_node_id: triggerNode.node_id,
        variables: {},
        status: "active",
      })
      .select()
      .single();

    // Mark chat as BOT mode
    await supabase
      .from("chats")
      .update({ mode: "BOT", active_flow_id: flow_id })
      .eq("chat_id", chat_id);

    // Advance past the trigger node immediately
    const firstNodeId = await getNextNode(triggerNode.node_id);
    if (!firstNodeId) return;

    const waAccount = await getWaAccount(account_id);
    let currentNodeId = firstNodeId;
    let variables = {};

    while (currentNodeId) {
      const node = await getNode(currentNodeId);
      console.log(`🤖 Processing node [${node.node_type}] ${node.node_id}`);

      const result = await processNode(
        node,
        { ...session, variables, chat_id },
        phone_number,
        waAccount,
      );

      variables = result.variables;
      const sessionStatus = result.status || "active";

      if (sessionStatus !== "active") {
        await updateSession(session.session_id, {
          current_node_id: null,
          variables,
          status: sessionStatus,
        });
        return;
      }

      if (result.waiting) {
        await updateSession(session.session_id, {
          current_node_id: currentNodeId,
          variables,
        });
        return;
      }

      currentNodeId = result.next_node_id;
    }

    await updateSession(session.session_id, {
      current_node_id: null,
      variables,
      status: "completed",
    });
    await supabase
      .from("chats")
      .update({ mode: "MANUAL", active_flow_id: null })
      .eq("chat_id", chat_id);
  } catch (err) {
    console.error("❌ startBotSession error:", err);
    // Reset chat to MANUAL so keyword triggers keep working
    await supabase
      .from("chats")
      .update({ mode: "MANUAL", active_flow_id: null })
      .eq("chat_id", chat_id)
      .catch(() => {});
  }
}

/**
 * Check if any active flow for this account has a keyword_trigger matching the user text.
 * Returns the flow if matched, otherwise null.
 */
export async function matchKeywordTrigger(user_text, account_id) {
  if (!user_text) return null;

  // Get all active flows for this account
  const { data: flows } = await supabase
    .from("chatbot_flows")
    .select("flow_id")
    .eq("account_id", account_id)
    .eq("status", "active");

  if (!flows?.length) return null;

  const flowIds = flows.map((f) => f.flow_id);

  // Get all keyword_trigger nodes for these flows
  const { data: triggers } = await supabase
    .from("chatbot_nodes")
    .select("flow_id, config")
    .eq("node_type", "keyword_trigger")
    .in("flow_id", flowIds);

  if (!triggers?.length) return null;

  const upperText = user_text.toUpperCase().trim();

  for (const trigger of triggers) {
    const keywords = (trigger.config.keywords || []).map((k) =>
      k.toUpperCase().trim(),
    );
    const matchType = trigger.config.match_type || "exact";

    const matched =
      matchType === "contains"
        ? keywords.some((k) => upperText.includes(k))
        : keywords.includes(upperText); // exact

    if (matched) return trigger.flow_id;
  }

  return null;
}
