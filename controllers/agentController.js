// controllers/agentController.js

import { supabase } from "../config/supabase.js";
import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "../config/anthropic.js";
import { executeTool, toolsForChannel } from "../agents/agentTools.js";
import { Readable } from "stream";
import { parse as parseCsv } from "@fast-csv/parse";
import {
  deductCredits,
  getCreditBalance,
  InsufficientCreditsError,
} from "../services/creditService.js";
import {
  usageToRealRupees,
  realRupeesToCredits,
} from "../config/creditConfig.js";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const VALID_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
];

// ─── MODEL INFO ───────────────────────────────────────────────────────────────
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

    if (!user_id || !account_id || !name) {
      return res.status(400).json({
        success: false,
        error: "user_id, account_id and name are required",
      });
    }
    if (!name.trim()) {
      return res
        .status(400)
        .json({ success: false, error: "Agent name cannot be empty" });
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
      return res
        .status(400)
        .json({ success: false, error: "user_id is required" });
    }

    let query = supabase
      .from("chatbot_agents")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (account_id) query = query.eq("account_id", account_id);

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
    if (!data)
      return res.status(404).json({ success: false, error: "Agent not found" });
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

// ─── TEST AGENT ───────────────────────────────────────────────────────────────
export const testAgent = async (req, res) => {
  try {
    const { agent_id } = req.params;
    const { message, history = [] } = req.body;

    if (!message?.trim()) {
      return res
        .status(400)
        .json({ success: false, error: "message is required" });
    }

    const { data: agent, error: agentErr } = await supabase
      .from("chatbot_agents")
      .select("*")
      .eq("agent_id", agent_id)
      .single();

    if (agentErr || !agent) {
      return res.status(404).json({ success: false, error: "Agent not found" });
    }

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
      updated_history: [...messages, { role: "assistant", content: reply }],
      usage: response.usage,
    });
  } catch (err) {
    console.error("❌ testAgent:", err);
    if (err.status === 401)
      return res
        .status(500)
        .json({ success: false, error: "Invalid Anthropic API key." });
    if (err.status === 429)
      return res.status(429).json({
        success: false,
        error: "Rate limit hit. Try again in a moment.",
      });
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ─── SAMVAADIK AI ASSISTANT ───────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

// ── Static base prompt ────────────────────────────────────────────────────────
const SAMVAADIK_SYSTEM_PROMPT = `You are Samvaadik AI, an assistant built into the Samvaadik WhatsApp marketing platform. You help users create and schedule campaigns, and send one-to-one messages and templates to individual contacts, through conversation.

Communicate like a knowledgeable colleague: clear, direct, no filler, no excessive punctuation. Do not use emojis. Write in plain sentences.

ID RULES (critical):
- group_id and wt_id are UUIDs like "f7e7c614-2734-4af7-94ad-ab0a8d4f3387".
- Never invent, guess, or construct IDs. Never use a template name as the template_id.
- Only use exact UUIDs returned from list_groups or list_templates tool results, copied character-for-character.
- If unsure, call the tool again rather than guessing.

DUPLICATE PREVENTION:
- Once create_campaign returns a campaign_id for the CURRENT confirmation, that campaign is created. Do not call create_campaign again for that same confirmation.
- If the user starts a NEW campaign request later in the conversation, treat it as a completely fresh flow from Step 1. You MUST call list_groups and list_templates again.
- One conversation can contain multiple separate campaign creation flows.
- CRITICAL: If the user says "yes" or confirms and you have NOT yet called create_campaign in this response, you MUST call it. Do NOT generate a confirmation text without first calling the tool. A campaign does not exist until create_campaign is called and returns a campaign_id.

GROUP CREATION FLOW:
There are two ways to create a group. Ask the user which they prefer if not clear from context.

Option A — CSV file upload:
- DO NOT call any tool. Just reply asking for:
  1. The group name (if not already given)
  2. Tell them to upload their CSV or Excel file using the + button in the chat
- The CSV must have these columns: name, phone number (phoneno / phone / mobile), and optionally email
- Once the user uploads a file, the system handles it automatically outside the tool loop. You will receive a confirmation message. Just relay that confirmation to the user naturally.

Option B — Google Sheets import:
- Step 1: Call list_google_sheets to fetch the spreadsheets Samvaadik can access. Samvaadik only sees sheets the user has selected from Google Drive (plus sheets it created), not their whole Drive.
  - If it returns requires_google_connection: true — output your response starting with exactly "GOOGLE_NOT_CONNECTED: " (including the colon and space), then explain they need to connect their Google account from the Integrations page first.
  - If it returns an empty list: output your response starting with exactly "GOOGLE_PICK_SHEET: " (including the colon and space), then tell the user to choose their sheet from Google Drive using the button below.
  - If it returns sheets: show a numbered list of sheet names so the user can pick one. Then output, on its own line at the very start of your response, exactly "GOOGLE_PICK_SHEET: " and mention that if their sheet is not listed they can choose it from Google Drive using the button below.
  - When the user says they selected a sheet from Google Drive, call list_google_sheets again and use the sheet they named.
- Step 2: Ask for the group name (if not already given) and optionally a description.
- Step 3: Show a summary before creating:
  ───────────────────────
  Group Summary
  Name: <group_name>
  Source: Google Sheet — <sheet name>
  ───────────────────────
  The sheet must have columns: name (A), phoneno (B), email optional (C). Ready to import?
- Step 4: On confirmation, call create_group_from_sheet with the exact spreadsheet id from the list_google_sheets result. CRITICAL: You MUST call list_google_sheets in the current conversation turn to get a fresh spreadsheet id. Never use a spreadsheet_id recalled from conversation history or a previous session — always get it fresh.
- After success, reply in one plain sentence: group name and contact count. Never show raw IDs.
- If create_group_from_sheet returns error_type "SHEET_ACCESS_REQUIRED": output your response starting with exactly "GOOGLE_PICK_SHEET: " and ask the user to select that sheet from Google Drive using the button below.
- If create_group_from_sheet returns error_type "INVALID_COLUMNS": tell the user the exact column format required — column A must be "name", column B must be "phoneno", column C (optional) must be "email" — and quote what was actually found. Ask them to fix the headers in their sheet and try again. Do NOT say the sheet was deleted or access was revoked.

Never create an empty group. Never call any tool for Option A (CSV) group creation.

CAMPAIGN CREATION FLOW:

Step 1 - Collect the four required inputs
Before calling any tool you need four things. Ask for any that are missing:
  a) Campaign name
  b) Contact group name
  c) Template name
  d) Scheduled date and time (user will give IST time — see DATETIME RULE below)

Step 2 - Resolve group and template
Call list_groups and list_templates once each to find the exact group and template the user mentioned.
list_templates now returns both APPROVED and PENDING templates — check the status field on the matched template.

Step 3 - Check template approval status
- If status is "APPROVED": continue normally to Step 4.
- If status is "PENDING": tell the user in one short sentence that this template is still awaiting Meta's approval, and that the campaign will be created now and will send automatically the moment Meta approves it — they do not need to come back and ask again. Then continue to Step 4.
- Any other status (e.g. REJECTED, DISABLED, PAUSED): tell the user this template cannot be used (state the status) and ask them to pick or create a different template. Do NOT call create_campaign.

Step 4 - Check media template
Look at header_format from list_templates:
- TEXT or null: plain text template, skip to Step 5.
- IMAGE / VIDEO / DOCUMENT: check media_status returned.
  Case A - media_status.valid is true: media is ready, note the filename and days remaining, continue to Step 5.
  Case B - media_status.valid is false (reason: no_media_id or not_found): output exactly:
    "REDIRECT_TO_TEMPLATES: The template '<name>' is a <TYPE> template but has no media uploaded yet. Please go to the Templates page, find this template, click Preview, and upload a <image/video/document> using the Upload Media button. Once done, come back here and we will continue."
  Case C - media_status.valid is false (reason: expired): output exactly:
    "REDIRECT_TO_TEMPLATES: The <TYPE> media for template '<name>' expired <N> days ago. Meta expires uploaded media after 25 days. Please go to the Templates page, find this template, click Preview, and upload fresh media. Once done, come back here and we will continue."
  For Case B and C: do NOT call create_campaign.

Step 5 - Collect variable values if needed
Check variables_count from the template result.
- If 0: skip to Step 6.
- If greater than 0: ask the user for each variable value before proceeding. Do not continue until all values are provided.
- If the user wants a variable personalized per recipient — they say things like "their name", "the contact's name", "each person's name", or ask a question such as "will it use their name?" / "it will send with participant name right?" — pass the exact literal string "{{contact_name}}" as that variable's value. The campaign sender replaces this with each recipient's own saved contact name automatically at send time, so every recipient gets their own name rather than one shared literal string.
- If the user's reply is a question rather than a value (ends with "?", asks for confirmation), answer their question first, then ask again for the actual value. Never treat a question as if it were the value itself.
- Only use a literal word as the variable value when the user clearly states a fixed value to use for every recipient (e.g. "use 'Ravi' for everyone").

Step 6 - Show summary and ask for confirmation
Output this block with no extra text or emoji on the separator lines:
  ───────────────────────
  Campaign Summary
  Name: <campaign_name>
  Group: <group_name> (<count> contacts)
  Template: <template_name>
  Status: <"Approved" or "Pending Meta approval — will send automatically once approved">
  Header: <TEXT / IMAGE / VIDEO / DOCUMENT>
  Media: <file name and days remaining, or "None">
  Scheduled: <show in IST — e.g. "Today, 16 May 2026 at 5:07 PM IST">
    Variables: <list values, showing "{{N}} = {{contact_name}} (personalized per recipient)" for any variable set that way, or "None">
  ───────────────────────
  Ready to create this campaign?

Step 7 - Create on confirmation only
Call create_campaign only after the user says yes, go ahead, confirm, or similar.
Pass template_variables exactly as collected. If no variables, pass {}.
For media templates, pass the media_id from the list_templates result.

SCHEDULED_AT DATETIME RULE (critical):
- All times the user gives are in IST (Asia/Kolkata, UTC+5:30).
- You MUST convert IST to UTC before passing scheduled_at to create_campaign.
- Subtract 5 hours and 30 minutes from the IST time to get UTC.
- Always pass a valid ISO 8601 string in UTC — e.g. "2026-05-16T11:37:00.000Z".
- NEVER pass natural-language strings like "Today at 5:07 PM" — the database will reject them.
- The create_campaign result includes scheduled_at_ist which is the IST display string. Use that in your confirmation message.
- In the Campaign Summary, show the scheduled time in IST.

AFTER REDIRECT - RESUMING:
If the user comes back and says they uploaded media, call list_templates again to re-check. If media_status.valid is now true, continue from Step 5.

TEMPLATE CREATION FLOW:
When the user asks to create a template, gather these details one at a time if missing:
1. Template name (auto-convert to lowercase_with_underscores)
2. Category: MARKETING, UTILITY, or AUTHENTICATION
3. Language — default en_US
4. Message body text (can include {{1}}, {{2}} for variables)
5. Header text (optional)
6. Footer text (optional)
7. Example values for any variables (required by Meta if body uses {{N}})
8. Buttons (optional) — Quick Reply, URL, or Phone Number. Max 3 total.

If user asks for a media template (IMAGE/VIDEO/DOCUMENT header), tell them:
"Media templates cannot be created through chat yet. You can create one from the Templates page. Text-based templates are fully supported here."

Before calling create_template, show this preview:
  ───────────────────────
  Template Preview
  Name: <normalized_name>
  Category: <category>
  Language: <language>
  Header: <header text or "None">
  Body: <body text>
  Footer: <footer text or "None">
  Buttons: <list each or "None">
  ───────────────────────
  Ready to submit this template to Meta for approval?

Call create_template only after confirmation.
After success, reply in one or two plain sentences with the template name, status, and that Meta typically approves within minutes to hours.

AGENT CREATION FLOW:
Collect details one at a time in this exact order. Ask only for what is missing.

Step 1 - Agent name
Ask: "What should the agent be called?" (e.g. "Order Support Bot")

Step 2 - Description (optional)
Ask: "Give it a short description — what does it do? (or say skip)"
If the user says skip or nothing meaningful, use null.

Step 3 - System prompt
Ask: "What should the agent do and how should it behave? Describe its role, what topics it can help with, and any limits."
Based on what the user tells you, write a clear and complete system prompt yourself.
Show it to the user: "Here is the system prompt I wrote: [prompt]. Does this look right, or would you like to change anything?"
If they want changes, update and show again. Continue until they approve.

Once you have name, description, and an approved system prompt, go directly to the preview.
Do NOT ask for model, max_turns, fallback_action, or exit keywords — use defaults silently:
- model: claude-haiku-4-5-20251001
- max_turns: 10
- fallback_action: handoff_to_agent
- exit_keywords: []

Show this preview:
  ───────────────────────
  Agent Preview
  Name: <name>
  Description: <description or "None">
  System prompt: <system_prompt>
  ───────────────────────
  Ready to create this agent?

Call create_agent only after the user confirms.
Pass model="claude-haiku-4-5-20251001", max_turns=10, fallback_action="handoff_to_agent", exit_keywords=[].
After success, reply in one sentence: the agent name and that it is now available on the Agents page.

CHATBOT FLOW MANAGEMENT:

LIST FLOWS:
When the user asks to see their flows (e.g. "show my flows", "list chatbot flows"), call list_flows.
Display each flow as: Name | Status | Description (if any).
If status is active show it as "Active", inactive as "Inactive".

CREATE FLOW:
Step 1 - Ask for the flow name if not given.
Step 2 - ALWAYS ask for a description before creating. Say exactly:
  "Got it. Give it a short description — what will this flow do? (or say skip)"
  Wait for the user's reply. If they say skip or nothing meaningful, use null.
  Do NOT skip this step even if the user gave the name in their first message.
Step 3 - Only after receiving both name and description (or skip), call create_flow.
  Do NOT show a summary card. Just create it.
Step 4 - After success, reply in one sentence and output the redirect token on its own line:
  REDIRECT_TO_BUILDER:<flow_id>
Example reply: "Flow 'Order Support' created. Open the builder to add nodes and connect them."
REDIRECT_TO_BUILDER:<the actual flow_id from the result>

ACTIVATE / DEACTIVATE:
1. If the user says "activate" or "deactivate" a flow by name, call list_flows to find it.
2. Call update_flow_status with the correct flow_id and status.
3. Confirm in one sentence: "Flow 'X' is now active." or "Flow 'X' is now inactive."

RENAME:
1. Call list_flows to find the flow by name.
2. Ask for the new name if not given.
3. Call rename_flow with the flow_id and new name.
4. Confirm in one sentence.

DELETE:
1. Call list_flows to find the flow by name.
2. Ask for confirmation: "Are you sure you want to delete 'X'? This cannot be undone."
3. Only call delete_flow after the user says yes or confirms.
4. Confirm: "Flow 'X' has been deleted."

COMPLEX FLOW EDITING (adding nodes, connecting edges, building logic):
If the user asks to add nodes, edit the flow logic, or build a complex flow,
tell them in one sentence that this is done in the visual builder, then output on its own line:
  REDIRECT_TO_FLOWS:
Example: "Adding nodes and connecting them is done in the visual builder."
REDIRECT_TO_FLOWS:

ONE-TO-ONE MESSAGING (send a message or a template to a single person):
This is different from a campaign (which sends to a whole group). Use it when the user wants to message one person, e.g. "send a message to Rahul", "send a template to 9876543210".

Step 1 - Identify the person
Call find_contact with the name or phone number the user gave.
- One clear match: use it.
- Several matches: show a short numbered list (name and phone) and ask which one. Do not guess.
- No match: if the user gave a full phone number, you can still send a TEMPLATE to it as a new contact (normal text is not possible because they have never replied). Otherwise ask for their phone number with country code.

Step 2a - Normal text message
WhatsApp only allows normal text within 24 hours of the person's last reply. Check can_send_text from find_contact:
- true: ask for the message text if not given. Then show:
  ───────────────────────
  Message Preview
  To: <name> (<phone>)
  Message: <the exact text>
  ───────────────────────
  Ready to send this message?
  Call send_text_message only after the user confirms, with phone_number copied from the preview's "To:" line and the exact message text. Do not pass a chat_id.
  Report the tool result truthfully. Only if the result has sent: true, reply in one plain sentence: the message was sent to <name>. If sent is false, say the message was NOT sent and give the reason from the error.
  If the user explicitly asks to send the same message again, no new preview is needed — call send_text_message again with the same phone_number and text, and report the real result.
- false with text_block_reason NO_USER_REPLY: explain in one sentence that this person has not replied yet, so WhatsApp only allows a template, and offer to send a template.
- false with text_block_reason WINDOW_EXPIRED: explain in one sentence that their last reply was more than 24 hours ago, so WhatsApp only allows a template now, and offer to send a template.
If send_text_message returns WINDOW_EXPIRED or NO_USER_REPLY, explain the same way and offer a template.

Step 2b - Template message
Templates can be sent any time. Do NOT ask in chat which template to use or for variable values, and do NOT call list_templates for this — the template picker handles choosing, filling values, preview and sending.
You MUST call open_template_picker in the same turn, every time, with phone_number (always) plus chat_id if find_contact returned one in this turn, and contact_name if known — even if you called it earlier in the conversation. The button only appears when this tool has been called in the current turn. After the tool returns, reply in one short sentence only, for example "Choose the template for Rahul using the button below." Do NOT write any token, placeholder, code or ID yourself.
If the user later says the template was sent, acknowledge in one sentence. Do not call open_template_picker again unless asked.

OTHER RULES:
- After create_campaign succeeds: if the result's pending_template_approval is true, reply in one or two plain sentences confirming the campaign was created and will send automatically as soon as Meta approves the "<template_name>" template (usually minutes to a few hours) — include the scheduled IST time too. If pending_template_approval is false, reply in one plain sentence as before: campaign name, group, and IST time (use scheduled_at_ist from the result). No emojis. Then stop.
- If a tool returns an error containing "Invalid scheduled time", tell the user there was a datetime error and ask them to state the schedule time again clearly in IST (e.g. "tomorrow at 3pm IST").
- If a tool returns any other error, explain it plainly. Never retry with fabricated IDs.
- Never show raw UUIDs. Always refer to things by name.`;

// ── Dynamic prompt builder — injects current IST time on every request ────────
function buildSystemPrompt() {
  const nowUtc = new Date();

  // Current IST time using Intl.DateTimeFormat — no manual offset math
  const istString = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(nowUtc);

  const timeContext = `\nCURRENT TIME (use for all date/time calculations):
- Current IST time (Asia/Kolkata): ${istString}
- Current UTC time: ${nowUtc.toISOString()}
- The user is in India. All times they mention are in IST (Asia/Kolkata, UTC+5:30) unless stated otherwise.
- To convert IST to UTC: subtract 5 hours and 30 minutes.
- Example: "5:07 PM IST" → 11:37 AM UTC → "2026-05-16T11:37:00.000Z"\n`;

  // Inject time context right after the first paragraph
  return SAMVAADIK_SYSTEM_PROMPT.replace(
    "ID RULES (critical):",
    timeContext + "\nID RULES (critical):",
  );
}

const MAX_TOOL_ITERATIONS = 8;

// The assistant's own "you're out of credits" reply — same shape as any other
// chat response, so the frontend doesn't need a special status-code path. The
// REDIRECT_TO_PRICING: marker is picked up by FormattedMessage on the
// frontend (see SamvaadikAssistant.jsx) to render a "Top Up Credits" card,
// the same way REDIRECT_TO_TEMPLATES / REDIRECT_TO_FLOWS etc. already do.
const buildOutOfCreditsPayload = (
  creditsRemaining,
  creditsChargedThisTurn = 0,
) => ({
  success: true,
  role: "assistant",
  content:
    "You're out of Samvaadik AI credits, so I can't continue with this right now. " +
    "Top up to keep chatting with me — once you're back I can pick up right where we left off.\n\n" +
    "REDIRECT_TO_PRICING:",
  credits_charged: creditsChargedThisTurn,
  credits_remaining: creditsRemaining,
  out_of_credits: true,
});
// The frontend shows the "Choose template" button when the reply contains
// OPEN_TEMPLATE_PICKER:<chat_id|new>|<phone>|<name>. The server appends it
// instead of trusting the model to copy it, and removes anything the model
// wrote in its place (token attempts, placeholders, raw UUIDs).
function attachPickerToken(text, token) {
  if (!token) return text;
  const cleaned = String(text || "")
    .replace(/`?OPEN_TEMPLATE_PICKER:\S*`?/g, "")
    .replace(/<[^>\n]*picker[^>\n]*>/gi, "")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "",
    )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const body = cleaned || "Choose the template using the button below.";
  return `${body}\n${token}`;
}

// ── WhatsApp channel instructions ───────────────────────────────────────────
// Appended to the system prompt when the assistant is used from the user's
// own WhatsApp (samvaadikWaController). Plain text only: no buttons, no file
// uploads, no template picker — so those flows are replaced here.
// The summary titles ("Campaign Summary", "Message Preview", "Template Message
// Preview", ...) and their "Ready to ..." questions must stay word-for-word:
// confirmation detection in runSamvaadikAssistant relies on them.
const WHATSAPP_CHANNEL_PROMPT = `

CHANNEL: WHATSAPP
This conversation is happening in WhatsApp text messages from the user's own phone, not in the dashboard. The user is the account owner (or their team) — not a customer.

Formatting:
- Plain WhatsApp text. Use *single asterisks* for bold, never **double**. No markdown headings or tables.
- Keep replies short. Summaries/previews: keep the exact title line (e.g. "Campaign Summary", "Message Preview", "Template Message Preview") and the exact "Ready to ..." question; the "───" separator lines are optional.

What is different on WhatsApp:
- CSV/Excel group upload (Group creation Option A) is not possible here — there is no file upload. Offer Option B (Google Sheets), or tell the user to upload the file from the Samvaadik dashboard.
- If a Google Sheet must be picked from Google Drive, tell the user to do that once from the AI Assistant in the Samvaadik dashboard, then continue here.
- Images, videos and documents sent here cannot be read. Media templates cannot be created here.

ONE-TO-ONE TEMPLATE MESSAGE (replaces Step 2b of ONE-TO-ONE MESSAGING — there is no template picker here; open_template_picker does not exist):
1. Identify the person with find_contact as usual (or use the full phone number the user gave).
2. If the user did not name a template, call list_templates and show the APPROVED ones as a short numbered list (name and a few words of the body). Ask which one.
3. Call get_template_details with the template's wt_id. If can_send is false, explain the reason in one sentence and stop.
4. Ask for every value that is needed, in one message:
   - each body variable (show its example as a hint; offer the contact's name for a name-like variable),
   - the header value if header_variable_needed is true,
   - each button value that is not optional.
5. Show:
   ───────────────────────
   Template Message Preview
   To: <name> (<phone>)
   Template: <exact template name>
   Values: <{{1}} = value, {{2}} = value, ... or "None">
   ───────────────────────
   Ready to send this template?
6. Only after the user confirms, call send_template_message with phone_number from the "To:" line, template_name exactly as in the preview, and the values. Do not rely on remembering wt_id from an earlier message.
7. Report the result truthfully: only if sent is true say it was sent. If sent is false, say it was NOT sent and give the reason; if values are missing, ask for them.`;

// ── runSamvaadikAssistant ─────────────────────────────────────────────────────
// The actual agentic tool-loop, independent of req/res. Used by both the
// dashboard's HTTP endpoint (handleSamvaadikChat, below — a thin wrapper that
// maps this to res.json) and the WhatsApp assistant webhook (see
// controllers/samvaadikWaController.js), which has no browser session to hold
// `messages` in and persists them to samvaadik_wa_sessions instead. Throws a
// tagged error ({ code, status }) on bad input / unknown user / upstream
// Anthropic failure; each caller decides how to surface that on its own
// channel (HTTP status vs a plain WhatsApp text reply).
//
// `channel` lets the system prompt adapt to where the reply is actually
// going: "web" (default) keeps every flow exactly as before (template-picker
// button, CSV upload via the dashboard's + button). "whatsapp" swaps those
// two for text-only fallbacks, since a plain WhatsApp text message has no
// button or file-upload widget.
export async function runSamvaadikAssistant({
  user_id,
  messages,
  media_attachment,
  channel = "web",
}) {
  if (!user_id) {
    throw Object.assign(new Error("user_id is required"), {
      code: "BAD_REQUEST",
      status: 400,
    });
  }
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw Object.assign(new Error("messages array is required"), {
      code: "BAD_REQUEST",
      status: 400,
    });
  }
  for (const msg of messages) {
    if (!msg.role || !msg.content) {
      throw Object.assign(
        new Error("Each message must have role and content."),
        { code: "BAD_REQUEST", status: 400 },
      );
    }
    if (!["user", "assistant"].includes(msg.role)) {
      throw Object.assign(new Error(`Invalid role "${msg.role}".`), {
        code: "BAD_REQUEST",
        status: 400,
      });
    }
  }

  // ── Credits pre-check ───────────────────────────────────────────────────
  // Refuse up front if the user has nothing left, instead of spending real
  // Anthropic API cost on a turn we already know we can't bill for. This is
  // a normal (200) chat-shaped response, not an error — the assistant
  // itself tells the user, with a redirect card, same as any other
  // "you need to do X first" message (see REDIRECT_TO_PRICING below).
  let creditBalance;
  try {
    creditBalance = await getCreditBalance(user_id);
  } catch (err) {
    throw Object.assign(new Error("User not found"), {
      code: "USER_NOT_FOUND",
      status: 404,
    });
  }
  if (creditBalance <= 0) {
    return buildOutOfCreditsPayload(creditBalance);
  }

  // Build system prompt with current IST time + optional media attachment context
  let systemPrompt = buildSystemPrompt();
  if (channel === "whatsapp") {
    systemPrompt += WHATSAPP_CHANNEL_PROMPT;
  }
  if (media_attachment?.header_handle) {
    systemPrompt +=
      `\n\nMEDIA ATTACHMENT FOR THIS SESSION:\n` +
      `The user has already uploaded a ${media_attachment.header_format || "IMAGE"} file` +
      (media_attachment.file_name
        ? ` named "${media_attachment.file_name}"`
        : "") +
      ` to use as a template header. ` +
      `Meta header handle: ${media_attachment.header_handle}. ` +
      (media_attachment.media_id
        ? `Meta media_id: ${media_attachment.media_id}. `
        : "") +
      `When creating a template with this media, pass ` +
      `header_format="${media_attachment.header_format || "IMAGE"}", ` +
      `header_handle="${media_attachment.header_handle}"` +
      (media_attachment.media_id
        ? `, and media_id="${media_attachment.media_id}"`
        : "") +
      ` to the create_template tool. Do NOT ask the user to upload a file — the upload is already complete.`;
  }

  // Trim to last 20 messages to prevent context bloat across multiple campaigns
  // Earlier picker tokens are replaced with a short note so the model
  // never sees (and imitates) them.
  const trimmedMessages = (
    messages.length > 20 ? messages.slice(-20) : messages
  ).map((m) =>
    m.role === "assistant" && m.content.includes("OPEN_TEMPLATE_PICKER:")
      ? {
          ...m,
          content: m.content.replace(
            /OPEN_TEMPLATE_PICKER:\S*/g,
            "[Choose template button shown]",
          ),
        }
      : m,
  );
  let currentMessages = [...trimmedMessages];
  let iteration = 0;
  let pickerToken = null; // set when open_template_picker succeeds this turn

  // ── Detect if user just confirmed a campaign or agent summary ─────────────
  // If yes, force Claude to call a tool on the first iteration using tool_choice:any.
  // This is enforced at the API level — Claude physically cannot return text
  // without calling a tool when tool_choice is "any".
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  // Trailing punctuation/emoji ("Yes.", "ok 👍" — common on WhatsApp) still counts
  const confirmText = (lastUserMsg?.content || "")
    .trim()
    .replace(/[\s.!,]+$/u, "")
    .replace(/\s*\p{Extended_Pictographic}+$/u, "")
    .trim();
  const isConfirmation =
    !!lastUserMsg &&
    /^(yes|yeah|yep|confirm|go ahead|sure|ok|okay|proceed|do it|create it|create( the)? (campaign|agent)|send( it)?|send (the )?(message|template)|correct|crct|looks good|that('s| is) (fine|good|correct)|yep do it)$/i.test(
      confirmText,
    );

  // Check if the last assistant message contains a pending summary/preview.
  // Matched on the title + question only (not the "───" separators, which the
  // WhatsApp channel may leave out).
  const lastAssistantMsg = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");
  const lastAssistantText = lastAssistantMsg?.content || "";
  // Which send tool a confirmed preview must lead to (null for create flows)
  const pendingSendTool = lastAssistantText.includes("Template Message Preview")
    ? lastAssistantText.includes("Ready to send this template")
      ? "send_template_message"
      : null
    : lastAssistantText.includes("Message Preview") &&
        lastAssistantText.includes("Ready to send this message")
      ? "send_text_message"
      : null;
  const hasSummaryPending =
    // Campaign summary pending
    (lastAssistantText.includes("Campaign Summary") &&
      lastAssistantText.includes("Ready to create")) ||
    // Agent preview pending
    (lastAssistantText.includes("Agent Preview") &&
      lastAssistantText.includes("Ready to create this agent")) ||
    // One-to-one text / template message preview pending
    !!pendingSendTool;

  // Force tool use only when user confirmed AND a summary was just shown
  const forceToolUse = isConfirmation && hasSummaryPending;

  if (forceToolUse) {
    console.log(
      "[SamvaadikAI] Confirmation after summary detected — forcing tool call (tool_choice:any)",
    );
  }

  // Every iteration below is a separate Anthropic API call and therefore a
  // separate real cost. Charged right after it happens (not lumped at the
  // end of the whole turn) so a multi-tool-call turn that runs a user out
  // of credits partway through is caught BEFORE the next, un-billable
  // Anthropic call — not after racking up more cost we can't charge for.
  let turnCreditsCharged = 0; // sum across every iteration of this turn

  const chargeIteration = async (usage) => {
    const realRupees = usageToRealRupees(usage);
    const creditsCharged =
      realRupees > 0 ? realRupeesToCredits(realRupees) : 0;

    console.log(
      `[SamvaadikAI][billing] user=${user_id} iteration=${iteration} ` +
        `tokens(in=${usage?.input_tokens || 0}, out=${usage?.output_tokens || 0}, ` +
        `cacheWrite=${usage?.cache_creation_input_tokens || 0}, cacheRead=${usage?.cache_read_input_tokens || 0}) ` +
        `realCost=₹${realRupees.toFixed(4)} creditsCharged=${creditsCharged}`,
    );

    if (creditsCharged === 0) return;

    try {
      const updatedUser = await deductCredits(
        user_id,
        creditsCharged,
        "Samvaadik AI Assistant usage",
      );
      creditBalance = Number(updatedUser.credits) || 0;
      turnCreditsCharged += creditsCharged;
      console.log(
        `[SamvaadikAI][billing] user=${user_id} balance -> ${creditBalance}`,
      );
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        // Balance couldn't cover this iteration's real cost. Treat the
        // user as depleted (stops the turn before the next API call)
        // without writing a charge the ledger would reject anyway.
        console.warn(
          `[SamvaadikAI][billing] user=${user_id} insufficient credits for this iteration (needed ${creditsCharged}) — treating as depleted.`,
        );
        creditBalance = 0;
      } else {
        console.error("[SamvaadikAI][billing] Credit deduction failed:", err);
      }
    }
  };
  // Set when the model promises the template button without having called
  // open_template_picker — the next iteration forces exactly that tool.
  let forcePickerTool = false;
  let pickerRetried = false;

  // Outcome of the last send_text_message / send_template_message call this
  // turn (null = not called). Used so the reply can never claim a message
  // was sent when it was not.
  let lastTextSend = null;
  let forceSendTool = false;
  let sendRetried = false;
  const confirmedSendTool = forceToolUse ? pendingSendTool : null;
  const confirmedMessagePreview = !!confirmedSendTool;

  const tools = toolsForChannel(channel);
  const toolNames = new Set(tools.map((t) => t.name));

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++;

    // First iteration after confirmation: force a tool call so Claude cannot
    // hallucinate a confirmation text. After that, let Claude respond freely.
    const toolChoice = forcePickerTool
      ? { type: "tool", name: "open_template_picker" }
      : forceSendTool
        ? { type: "tool", name: confirmedSendTool }
        : forceToolUse && iteration === 1
          ? { type: "any" }
          : { type: "auto" };
    forcePickerTool = false;
    forceSendTool = false;

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      tool_choice: toolChoice,
      messages: currentMessages,
    });

    const { stop_reason, content, usage } = response;
    await chargeIteration(usage);

    if (stop_reason === "end_turn") {
      const textBlock = content.find((b) => b.type === "text");

      // Guard: the reply points to a template button but the picker tool
      // was never called this turn, so no button would appear. Make the
      // model call it (once), then let it answer again.
      // Web only — the picker (and this tool) doesn't exist on WhatsApp.
      const promisesPicker =
        toolNames.has("open_template_picker") &&
        /template/i.test(textBlock?.text || "") &&
        /button (below|above)/i.test(textBlock?.text || "") &&
        !/REDIRECT_TO_TEMPLATES|GOOGLE_/.test(textBlock?.text || "");
      if (promisesPicker && !pickerToken && !pickerRetried) {
        if (creditBalance <= 0) {
          return buildOutOfCreditsPayload(creditBalance, turnCreditsCharged);
        }
        console.warn(
          "[SamvaadikAI] Template button promised without open_template_picker — forcing the tool call",
        );
        pickerRetried = true;
        forcePickerTool = true;
        currentMessages.push({ role: "assistant", content });
        currentMessages.push({
          role: "user",
          content:
            "(System note, not from the user) You mentioned the template button but did not call open_template_picker, so no button is shown. Call open_template_picker now with the exact chat_id from find_contact, or the phone_number for a new contact. Then reply again in one short sentence.",
        });
        continue;
      }

      let replyText = textBlock?.text || "";
      const claimsSent =
        /\bsent\b/i.test(replyText) &&
        !/\b(not|n't|unable|fail|failed|couldn|could not|cannot)\b/i.test(
          replyText,
        );

      // Guard: user confirmed a Message Preview but the model replied
      // without calling send_text_message. Force the call once.
      if (confirmedMessagePreview && !lastTextSend && !sendRetried) {
        if (creditBalance <= 0) {
          return buildOutOfCreditsPayload(creditBalance, turnCreditsCharged);
        }
        console.warn(
          `[SamvaadikAI] Preview confirmed but ${confirmedSendTool} not called — forcing the tool call`,
        );
        sendRetried = true;
        forceSendTool = true;
        currentMessages.push({ role: "assistant", content });
        currentMessages.push({
          role: "user",
          content:
            confirmedSendTool === "send_template_message"
              ? "(System note, not from the user) The user confirmed the Template Message Preview but send_template_message was not called, so nothing was sent. Call send_template_message now with the phone_number from the preview's 'To:' line, the template_name and the values from the preview. Then report the real result."
              : "(System note, not from the user) The user confirmed the Message Preview but send_text_message was not called, so nothing was sent. Call send_text_message now with the phone_number from the preview's 'To:' line and the exact message text. Then report the real result.",
        });
        continue;
      }

      // Guard: never tell the user a text was sent when the tool failed
      // (or was never called).
      if (claimsSent && lastTextSend && !lastTextSend.sent) {
        const reason = String(lastTextSend.error || "")
          .replace(/^MESSAGE NOT SENT:\s*/i, "")
          .trim();
        replyText = `The message was not sent. ${reason || "Please try again."}`;
        if (["NO_USER_REPLY", "WINDOW_EXPIRED"].includes(lastTextSend.code)) {
          replyText += " Would you like to send a template instead?";
        }
      } else if (claimsSent && !lastTextSend && confirmedMessagePreview) {
        replyText =
          "The message was not sent because something went wrong. Please try again.";
      }

      return {
        success: true,
        role: "assistant",
        content: attachPickerToken(replyText, pickerToken),
        usage,
        iterations: iteration,
        credits_charged: turnCreditsCharged,
        credits_remaining: creditBalance,
      };
    }

    if (stop_reason === "tool_use") {
      // Claude wants another round (tool results fed back in), which means
      // another billable Anthropic call. If this iteration's charge just
      // used up what was left, stop here instead of making that call.
      if (creditBalance <= 0) {
        return buildOutOfCreditsPayload(creditBalance, turnCreditsCharged);
      }

      currentMessages.push({ role: "assistant", content });

      const toolResults = [];
      for (const block of content) {
        if (block.type === "tool_use") {
          console.log(
            `[SamvaadikAI] Tool call: ${block.name}`,
            JSON.stringify(block.input),
          );
          // Only tools offered on this channel may run (defence in depth)
        const result = toolNames.has(block.name)
          ? await executeTool(block.name, block.input, user_id)
          : { error: `Tool ${block.name} is not available here.` };
          // The template-picker token is attached to the reply by the server
          // (see attachPickerToken). Hide it from the model so it can't
          // echo a mangled copy (placeholder text / bare UUID).
          if (
          block.name === "send_text_message" ||
          block.name === "send_template_message"
        ) {
            lastTextSend = result || { sent: false, error: "No result" };
          }
          if (block.name === "open_template_picker" && result?.picker_token) {
            pickerToken = result.picker_token;
            delete result.picker_token;
          }
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

      currentMessages.push({ role: "user", content: toolResults });
      continue;
    }

    console.warn("[SamvaadikAI] Unexpected stop_reason:", stop_reason);
    return {
      success: true,
      role: "assistant",
      content: "I ran into an unexpected issue. Please try again.",
      iterations: iteration,
      credits_charged: turnCreditsCharged,
      credits_remaining: creditBalance,
    };
  }

  return {
    success: true,
    role: "assistant",
    content:
      "I had trouble completing that. Could you rephrase or break it into smaller steps?",
    iterations: iteration,
    credits_charged: turnCreditsCharged,
    credits_remaining: creditBalance,
  };
}

// ── handleSamvaadikChat ───────────────────────────────────────────────────────
// Thin HTTP wrapper around runSamvaadikAssistant for the dashboard chat
// widget (SamvaadikAssistant.jsx). Request/response shape is unchanged from
// before the refactor — only the actual loop moved.
export const handleSamvaadikChat = async (req, res) => {
  try {
    const { user_id, messages, media_attachment } = req.body;
    const result = await runSamvaadikAssistant({
      user_id,
      messages,
      media_attachment,
      channel: "web",
    });
    return res.json(result);
  } catch (err) {
    console.error("❌ handleSamvaadikChat:", err);
    if (err.code === "BAD_REQUEST") {
      return res.status(400).json({ success: false, error: err.message });
    }
    if (err.code === "USER_NOT_FOUND") {
      return res.status(404).json({ success: false, error: err.message });
    }
    if (err.status === 401)
      return res
        .status(500)
        .json({ success: false, error: "Invalid Anthropic API key." });
    if (err.status === 429)
      return res.status(429).json({
        success: false,
        error: "Rate limit hit. Try again in a moment.",
      });
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── HELPERS for group CSV parsing ────────────────────────────────────────────

const findColumn = (headers, candidates) => {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const c of candidates) {
    const i = lower.indexOf(c.toLowerCase());
    if (i !== -1) return headers[i];
  }
  return null;
};

const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .slice(0, 60);

// ─── GROUP PREVIEW ────────────────────────────────────────────────────────────
// POST /api/agents/samvaadik/preview-group
// multipart/form-data: user_id, group_name, file
// Parses CSV, uploads to Supabase storage, returns preview + contacts[].
// NO DB writes to groups or group_contacts.
export const handleGroupPreview = async (req, res) => {
  try {
    const { user_id, group_name } = req.body;
    const file = req.file;

    if (!user_id)
      return res
        .status(400)
        .json({ success: false, error: "user_id is required" });
    if (!group_name?.trim())
      return res
        .status(400)
        .json({ success: false, error: "group_name is required" });
    if (!file)
      return res
        .status(400)
        .json({ success: false, error: "A CSV or Excel file is required" });

    // Parse CSV
    const rows = [];
    const headers = [];

    try {
      await new Promise((resolve, reject) => {
        Readable.from(file.buffer)
          .pipe(parseCsv({ headers: true, ignoreEmpty: true, trim: true }))
          .on("headers", (h) => headers.push(...h))
          .on("data", (row) => rows.push(row))
          .on("error", reject)
          .on("end", resolve);
      });
    } catch {
      return res.status(400).json({
        success: false,
        error:
          "Could not parse the file. Make sure it is a valid CSV with headers.",
      });
    }

    if (!rows.length) {
      return res
        .status(400)
        .json({ success: false, error: "The file has no data rows." });
    }

    // Detect columns
    const nameCol = findColumn(headers, ["name", "full_name", "fullname"]);
    const phoneCol = findColumn(headers, [
      "phone",
      "phone_number",
      "phoneno",
      "mobile",
      "contact",
    ]);
    const emailCol = findColumn(headers, ["email", "email_address"]);

    if (!phoneCol) {
      return res.status(400).json({
        success: false,
        error: `No phone column found. Columns in your file: ${headers.join(", ")}. Rename one to "phone", "phoneno", or "mobile".`,
      });
    }

    // Build contacts
    const contacts = rows
      .map((r) => ({
        user_id,
        full_name: nameCol ? r[nameCol]?.trim() || null : null,
        email: emailCol ? r[emailCol]?.trim() || null : null,
        phone_number: r[phoneCol]?.trim(),
      }))
      .filter((c) => c.phone_number);

    if (!contacts.length) {
      return res.status(400).json({
        success: false,
        error: "No valid phone numbers found in the file.",
      });
    }

    // Upload CSV to Supabase storage (non-fatal)
    let csvUrl = null;
    try {
      const storageKey = `${user_id}/${Date.now()}_${slugify(group_name)}.csv`;
      const { error: uploadErr } = await supabase.storage
        .from("group-csvs")
        .upload(storageKey, file.buffer, { contentType: "text/csv" });

      if (!uploadErr) {
        const { data: urlData } = supabase.storage
          .from("group-csvs")
          .getPublicUrl(storageKey);
        csvUrl = urlData?.publicUrl || null;
      } else {
        console.warn(
          "[AgentGroup] CSV storage upload failed:",
          uploadErr.message,
        );
      }
    } catch (storageErr) {
      console.warn("[AgentGroup] CSV storage error:", storageErr.message);
    }

    return res.status(200).json({
      success: true,
      group_name: group_name.trim(),
      contact_count: contacts.length,
      skipped: rows.length - contacts.length,
      columns_found: {
        name: nameCol || null,
        phone: phoneCol,
        email: emailCol || null,
      },
      sample: contacts.slice(0, 3),
      contacts, // full list — frontend holds and sends back on confirm
      csv_url: csvUrl, // Supabase storage URL — stored in groups.uploaded_csv
    });
  } catch (err) {
    console.error("❌ handleGroupPreview:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ─── GROUP CREATION FROM CSV ──────────────────────────────────────────────────
// POST /api/agents/samvaadik/create-group
// JSON body: { user_id, group_name, description, contacts[], csv_url }
// contacts[] and csv_url come from the preview step — no file upload here.
export const handleGroupFromCsv = async (req, res) => {
  try {
    const {
      user_id,
      group_name,
      description = "",
      contacts,
      csv_url = null,
    } = req.body;

    if (!user_id)
      return res
        .status(400)
        .json({ success: false, error: "user_id is required" });
    if (!group_name?.trim())
      return res
        .status(400)
        .json({ success: false, error: "group_name is required" });
    if (!contacts?.length)
      return res
        .status(400)
        .json({ success: false, error: "No contacts provided" });

    // Create group row
    const { data: group, error: groupErr } = await supabase
      .from("groups")
      .insert({
        user_id,
        group_name: group_name.trim(),
        description: description?.trim() || null,
        uploaded_csv: csv_url, // Supabase storage URL from preview step
        status: "active",
      })
      .select()
      .single();

    if (groupErr)
      return res.status(500).json({ success: false, error: groupErr.message });

    // Bulk insert contacts — attach group_id (preview didn't know it yet)
    const contactsWithGroup = contacts.map((c) => ({
      ...c,
      group_id: group.group_id,
      user_id,
    }));

    const BATCH = 500;
    let insertedCount = 0;

    for (let i = 0; i < contactsWithGroup.length; i += BATCH) {
      const batch = contactsWithGroup.slice(i, i + BATCH);
      const { data: inserted, error: insertErr } = await supabase
        .from("group_contacts")
        .insert(batch)
        .select("contact_id");

      if (insertErr) {
        console.error(
          `[AgentGroup] Batch insert error at offset ${i}:`,
          insertErr.message,
        );
      } else {
        insertedCount += inserted?.length ?? 0;
      }
    }

    const skipped = contacts.length - insertedCount;

    return res.status(201).json({
      success: true,
      group_id: group.group_id,
      group_name: group.group_name,
      contacts_inserted: insertedCount,
      skipped,
      message: `Group "${group.group_name}" created with ${insertedCount} contact${insertedCount !== 1 ? "s" : ""}${skipped > 0 ? ` (${skipped} skipped)` : ""}.`,
    });
  } catch (err) {
    console.error("❌ handleGroupFromCsv:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
