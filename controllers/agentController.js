// controllers/agentController.js

import { supabase } from "../config/supabase.js";
import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "../config/anthropic.js";
import { CAMPAIGN_TOOLS, executeTool } from "../agents/agentTools.js";
import { Readable } from "stream";
import { parse as parseCsv } from "@fast-csv/parse";

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
      return res
        .status(400)
        .json({
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
      return res
        .status(400)
        .json({
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
      return res
        .status(400)
        .json({
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
      return res
        .status(429)
        .json({
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
const SAMVAADIK_SYSTEM_PROMPT = `You are Samvaadik AI, an assistant built into the Samvaadik WhatsApp marketing platform. You help users create and schedule campaigns through conversation.

Communicate like a knowledgeable colleague: clear, direct, no filler, no excessive punctuation. Do not use emojis. Write in plain sentences.

ID RULES (critical):
- group_id and wt_id are UUIDs like "f7e7c614-2734-4af7-94ad-ab0a8d4f3387".
- Never invent, guess, or construct IDs. Never use a template name as the template_id.
- Only use exact UUIDs returned from list_groups or list_templates tool results, copied character-for-character.
- If unsure, call the tool again rather than guessing.

DUPLICATE PREVENTION:
- Once create_campaign returns a campaign_id, the campaign exists. Stop. Never call create_campaign again.

GROUP CREATION FLOW:
- When the user wants to create a group, DO NOT call any tool. Just reply asking for:
  1. The group name (if not already given)
  2. Tell them to upload their CSV or Excel file using the + button in the chat
- The CSV must have these columns: name, phone number (phoneno / phone / mobile), and optionally email
- Once the user uploads a file, the system handles it automatically outside the tool loop. You will receive a confirmation message. Just relay that confirmation to the user naturally.
- Never create an empty group. Never call any tool for group creation.

CAMPAIGN CREATION FLOW:

Step 1 - Collect the four required inputs
Before calling any tool you need four things. Ask for any that are missing:
  a) Campaign name
  b) Contact group name
  c) Template name
  d) Scheduled date and time (user will give IST time — see DATETIME RULE below)

Step 2 - Resolve group and template
Call list_groups and list_templates once each to find the exact group and template the user mentioned.

Step 3 - Check media template
Look at header_format from list_templates:
- TEXT or null: plain text template, skip to Step 4.
- IMAGE / VIDEO / DOCUMENT: check media_status returned.
  Case A - media_status.valid is true: media is ready, note the filename and days remaining, continue to Step 4.
  Case B - media_status.valid is false (reason: no_media_id or not_found): output exactly:
    "REDIRECT_TO_TEMPLATES: The template '<name>' is a <TYPE> template but has no media uploaded yet. Please go to the Templates page, find this template, click Preview, and upload a <image/video/document> using the Upload Media button. Once done, come back here and we will continue."
  Case C - media_status.valid is false (reason: expired): output exactly:
    "REDIRECT_TO_TEMPLATES: The <TYPE> media for template '<name>' expired <N> days ago. Meta expires uploaded media after 25 days. Please go to the Templates page, find this template, click Preview, and upload fresh media. Once done, come back here and we will continue."
  For Case B and C: do NOT call create_campaign.

Step 4 - Collect variable values if needed
Check variables_count from the template result.
- If 0: skip to Step 5.
- If greater than 0: ask the user for each variable value before proceeding. Do not continue until all values are provided.

Step 5 - Show summary and ask for confirmation
Output this block with no extra text or emoji on the separator lines:
  ───────────────────────
  Campaign Summary
  Name: <campaign_name>
  Group: <group_name> (<count> contacts)
  Template: <template_name>
  Header: <TEXT / IMAGE / VIDEO / DOCUMENT>
  Media: <file name and days remaining, or "None">
  Scheduled: <show in IST — e.g. "Today, 16 May 2026 at 5:07 PM IST">
  Variables: <list values or "None">
  ───────────────────────
  Ready to create this campaign?

Step 6 - Create on confirmation only
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
If the user comes back and says they uploaded media, call list_templates again to re-check. If media_status.valid is now true, continue from Step 4.

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

OTHER RULES:
- After create_campaign succeeds, use scheduled_at_ist from the result in your confirmation. Reply in one plain sentence: campaign name, group, and IST time. No emojis. Then stop.
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

// ── handleSamvaadikChat ───────────────────────────────────────────────────────
export const handleSamvaadikChat = async (req, res) => {
  try {
    const { user_id, messages } = req.body;

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
    for (const msg of messages) {
      if (!msg.role || !msg.content) {
        return res
          .status(400)
          .json({
            success: false,
            error: "Each message must have role and content.",
          });
      }
      if (!["user", "assistant"].includes(msg.role)) {
        return res
          .status(400)
          .json({ success: false, error: `Invalid role "${msg.role}".` });
      }
    }

    let currentMessages = [...messages];
    let iteration = 0;

    while (iteration < MAX_TOOL_ITERATIONS) {
      iteration++;

      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: buildSystemPrompt(), // dynamic — injects current IST time each request
        tools: CAMPAIGN_TOOLS,
        messages: currentMessages,
      });

      const { stop_reason, content, usage } = response;

      if (stop_reason === "end_turn") {
        const textBlock = content.find((b) => b.type === "text");
        return res.json({
          success: true,
          role: "assistant",
          content: textBlock?.text || "",
          usage,
          iterations: iteration,
        });
      }

      if (stop_reason === "tool_use") {
        currentMessages.push({ role: "assistant", content });

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

        currentMessages.push({ role: "user", content: toolResults });
        continue;
      }

      console.warn("[SamvaadikAI] Unexpected stop_reason:", stop_reason);
      return res.json({
        success: true,
        role: "assistant",
        content: "I ran into an unexpected issue. Please try again.",
        iterations: iteration,
      });
    }

    return res.json({
      success: true,
      role: "assistant",
      content:
        "I had trouble completing that. Could you rephrase or break it into smaller steps?",
      iterations: iteration,
    });
  } catch (err) {
    console.error("❌ handleSamvaadikChat:", err);
    if (err.status === 401)
      return res
        .status(500)
        .json({ success: false, error: "Invalid Anthropic API key." });
    if (err.status === 429)
      return res
        .status(429)
        .json({
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
      return res
        .status(400)
        .json({
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
      return res
        .status(400)
        .json({
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
