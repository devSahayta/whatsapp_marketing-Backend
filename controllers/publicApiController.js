// controllers/publicApiController.js
// Public API endpoints — authenticated via API key (apiKeyAuth middleware).
// Consumed by external apps (Doctor CRM, etc.) to use Samvaadik as a WhatsApp service.

import axios from "axios";
import FormData from "form-data";
import { supabase } from "../config/supabase.js";
import { createScheduledMessage } from "../services/scheduledMessageService.js";

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/* ─── helpers ────────────────────────────────────────────────────────────── */

function logUsage(req, status_code, error = null) {
  const { key_id, user_id, account_id } = req.apiKey;
  supabase
    .from("api_usage_logs")
    .insert({
      key_id,
      user_id,
      account_id,
      endpoint: req.originalUrl,
      method: req.method,
      status_code,
      error,
    })
    .then(() => {})
    .catch(() => {});
}

function graphHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/* ─── GET /v1/account ────────────────────────────────────────────────────── */

export const getAccount = async (req, res) => {
  try {
    const { wa_id, business_phone_number, status, waba_id } = req.account;

    logUsage(req, 200);
    return res.status(200).json({
      success: true,
      data: { wa_id, business_phone_number, status, waba_id },
    });
  } catch (err) {
    console.error("getAccount error:", err);
    logUsage(req, 500, err.message);
    return res.status(500).json({ error: "Failed to get account info" });
  }
};

/* ─── GET /v1/templates ─────────────────────────────────────────────────── */

export const getTemplates = async (req, res) => {
  try {
    const { wa_id } = req.account;

    const { data, error } = await supabase
      .from("whatsapp_templates")
      .select(
        "wt_id, name, language, category, header_format, variables, buttons, status, created_at",
      )
      .eq("account_id", wa_id)
      .eq("status", "APPROVED")
      .order("created_at", { ascending: false });

    if (error) throw error;

    logUsage(req, 200);
    return res.status(200).json({
      success: true,
      total: data?.length ?? 0,
      data: data ?? [],
    });
  } catch (err) {
    console.error("getTemplates error:", err);
    logUsage(req, 500, err.message);
    return res.status(500).json({ error: "Failed to fetch templates" });
  }
};

/* ─── POST /v1/messages/template ────────────────────────────────────────── */
/*
  Body:
  {
    "phone": "919876543210",
    "template_name": "mri_followup",
    "language": "en_US",           // optional, default en_US
    "parameters": ["John", "7 days"], // body text parameters in order
    "header_media_id": "abc123"    // optional — if template has media header
  }
*/

export const sendTemplateMessage = async (req, res) => {
  try {
    const { phone_number_id, system_user_access_token, wa_id } = req.account;
    const {
      phone,
      template_name,
      language = "en_US",
      parameters = [],
      header_media_id,
    } = req.body;

    if (!phone || !template_name) {
      logUsage(req, 400, "Missing phone or template_name");
      return res
        .status(400)
        .json({ error: "phone and template_name are required" });
    }

    // Fetch template from DB to get header_format
    const { data: template } = await supabase
      .from("whatsapp_templates")
      .select("name, language, header_format, media_id")
      .eq("account_id", wa_id)
      .eq("name", template_name)
      .maybeSingle();

    const components = [];

    // Build header component if template has media
    const mediaId = header_media_id || template?.media_id;
    const headerFormat = template?.header_format?.toUpperCase();

    if (mediaId && ["IMAGE", "VIDEO", "DOCUMENT"].includes(headerFormat)) {
      const mediaType = headerFormat.toLowerCase();
      components.push({
        type: "header",
        parameters: [{ type: mediaType, [mediaType]: { id: mediaId } }],
      });
    }

    // Build body parameters
    if (parameters.length > 0) {
      components.push({
        type: "body",
        parameters: parameters.map((p) => ({ type: "text", text: String(p) })),
      });
    }

    const payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: template_name,
        language: { code: language },
        ...(components.length > 0 && { components }),
      },
    };

    const graphRes = await axios.post(
      `${GRAPH_BASE}/${phone_number_id}/messages`,
      payload,
      { headers: graphHeaders(system_user_access_token) },
    );

    const wa_message_id = graphRes.data?.messages?.[0]?.id;

    // Log in whatsapp_messages
    await supabase.from("whatsapp_messages").insert({
      account_id: wa_id,
      to_number: phone,
      template_name,
      message_body: payload,
      wa_message_id,
      status: "sent",
      sent_at: new Date().toISOString(),
    });

    logUsage(req, 200);
    return res.status(200).json({
      success: true,
      wa_message_id,
      message: "Template message sent",
    });
  } catch (err) {
    const apiError = err.response?.data || err.message;
    console.error("sendTemplateMessage error:", apiError);
    logUsage(req, 500, JSON.stringify(apiError));
    return res.status(500).json({ error: "Failed to send template message", details: apiError });
  }
};

/* ─── POST /v1/messages/text ────────────────────────────────────────────── */
/*
  Body:
  {
    "phone": "919876543210",
    "message": "Hello! Your report is ready."
  }
  WhatsApp rule: text messages are only allowed within the 24-hour window
  after the contact last replied. Use /v1/messages/template outside that window.
*/

/**
 * Check whether a free-form text message is allowed to this phone number
 * for the given account, using the same 3-rule logic as adminChatController:
 *   1. User must have replied at least once.
 *   2. The last user reply must be MORE RECENT than any template we sent after it
 *      (i.e. conversation window was re-opened by the user, not just a template blast).
 *   3. Last user reply must be within the past 24 hours.
 *
 * Returns { allowed: boolean, reason?: string }
 */
async function check24hWindow(phone, user_id) {
  // Find the chat for this phone number under this Samvaadik user account
  const { data: chat } = await supabase
    .from("chats")
    .select("chat_id")
    .eq("phone_number", phone)
    .eq("user_id", user_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!chat?.chat_id) {
    // No chat record means the contact has never messaged us
    return { allowed: false, reason: "NO_USER_REPLY" };
  }

  const chat_id = chat.chat_id;

  // 1. Last inbound (user) message
  const { data: lastUserMsg } = await supabase
    .from("messages")
    .select("created_at")
    .eq("chat_id", chat_id)
    .eq("sender_type", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!lastUserMsg?.created_at) {
    return { allowed: false, reason: "NO_USER_REPLY" };
  }

  // 2. Last outbound template message
  const { data: lastTemplateMsg } = await supabase
    .from("messages")
    .select("created_at")
    .eq("chat_id", chat_id)
    .eq("sender_type", "admin")
    .eq("message_type", "template")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // If a template was sent AFTER the last user reply, the window is not yet open —
  // we are waiting for the user to reply to that template first.
  if (
    lastTemplateMsg?.created_at &&
    new Date(lastTemplateMsg.created_at) > new Date(lastUserMsg.created_at)
  ) {
    return { allowed: false, reason: "TEMPLATE_ONLY_WAITING_FOR_USER" };
  }

  // 3. 24-hour window from last user message
  const diffHours =
    (Date.now() - new Date(lastUserMsg.created_at).getTime()) / (1000 * 60 * 60);

  if (diffHours > 24) {
    return { allowed: false, reason: "WINDOW_EXPIRED" };
  }

  return { allowed: true };
}

export const sendTextMessage = async (req, res) => {
  try {
    const { phone_number_id, system_user_access_token, wa_id } = req.account;
    const { phone, message } = req.body;

    if (!phone || !message) {
      logUsage(req, 400, "Missing phone or message");
      return res.status(400).json({ error: "phone and message are required" });
    }

    // ── 24-hour window check ─────────────────────────────────────────────────
    const windowCheck = await check24hWindow(phone, req.apiKey.user_id);

    if (!windowCheck.allowed) {
      const reasons = {
        NO_USER_REPLY:
          "The contact has never replied to you. Only template messages are allowed to initiate a conversation.",
        WINDOW_EXPIRED:
          "The 24-hour messaging window has expired. Send a template message to re-open the conversation.",
        TEMPLATE_ONLY_WAITING_FOR_USER:
          "A template was sent but the contact hasn't replied yet. Wait for their reply before sending free-form text.",
      };

      const errorMessage =
        reasons[windowCheck.reason] ??
        "Cannot send text message outside the 24-hour window. Use /v1/messages/template instead.";

      logUsage(req, 403, windowCheck.reason);
      return res.status(403).json({
        error: errorMessage,
        code: windowCheck.reason,
        hint: "Use POST /v1/messages/template to reach this contact.",
      });
    }
    // ────────────────────────────────────────────────────────────────────────

    const payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: message },
    };

    const graphRes = await axios.post(
      `${GRAPH_BASE}/${phone_number_id}/messages`,
      payload,
      { headers: graphHeaders(system_user_access_token) },
    );

    const wa_message_id = graphRes.data?.messages?.[0]?.id;

    // Log in whatsapp_messages
    await supabase.from("whatsapp_messages").insert({
      account_id: wa_id,
      to_number: phone,
      message_body: payload,
      wa_message_id,
      status: "sent",
      sent_at: new Date().toISOString(),
    });

    logUsage(req, 200);
    return res.status(200).json({
      success: true,
      wa_message_id,
      message: "Text message sent",
    });
  } catch (err) {
    const apiError = err.response?.data || err.message;
    console.error("sendTextMessage error:", apiError);
    logUsage(req, 500, JSON.stringify(apiError));
    return res
      .status(500)
      .json({ error: "Failed to send text message", details: apiError });
  }
};

/* ─── POST /v1/media/upload ─────────────────────────────────────────────── */
/*
  Multipart form-data:
    file: <binary>
    type: image | video | document | audio
*/

export const uploadMedia = async (req, res) => {
  try {
    const { phone_number_id, system_user_access_token, wa_id } = req.account;

    if (!req.file) {
      logUsage(req, 400, "No file provided");
      return res.status(400).json({ error: "No file uploaded. Use multipart/form-data with field 'file'." });
    }

    const form = new FormData();
    form.append("file", req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });
    form.append("messaging_product", "whatsapp");
    form.append("type", req.file.mimetype);

    const graphRes = await axios.post(
      `${GRAPH_BASE}/${phone_number_id}/media`,
      form,
      {
        headers: {
          Authorization: `Bearer ${system_user_access_token}`,
          ...form.getHeaders(),
        },
      },
    );

    const media_id = graphRes.data?.id;

    // Save to whatsapp_media_uploads
    await supabase.from("whatsapp_media_uploads").insert({
      account_id: wa_id,
      media_id,
      file_name: req.file.originalname,
      type: req.file.mimetype.split("/")[0],
      mime_type: req.file.mimetype,
      size_bytes: String(req.file.size),
    });

    logUsage(req, 200);
    return res.status(200).json({
      success: true,
      media_id,
      message: "Media uploaded. Use this media_id in template messages.",
    });
  } catch (err) {
    const apiError = err.response?.data || err.message;
    console.error("uploadMedia error:", apiError);
    logUsage(req, 500, JSON.stringify(apiError));
    return res
      .status(500)
      .json({ error: "Failed to upload media", details: apiError });
  }
};

/* ─── POST /v1/messages/interactive ─────────────────────────────────────── */
/*
  Send an interactive message with quick-reply buttons (within 24hr window).
  Body:
  {
    "phone": "919876543210",
    "body_text": "Please choose an option:",
    "buttons": [
      { "id": "btn_yes", "title": "Yes" },
      { "id": "btn_no",  "title": "No" }
    ]
  }
*/

export const sendInteractiveMessage = async (req, res) => {
  try {
    const { phone_number_id, system_user_access_token, wa_id } = req.account;
    const { phone, body_text, buttons } = req.body;

    if (!phone || !body_text || !buttons?.length) {
      logUsage(req, 400, "Missing required fields");
      return res
        .status(400)
        .json({ error: "phone, body_text, and buttons (array) are required" });
    }

    if (buttons.length > 3) {
      return res
        .status(400)
        .json({ error: "WhatsApp allows a maximum of 3 quick-reply buttons" });
    }

    const payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body_text },
        action: {
          buttons: buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    };

    const graphRes = await axios.post(
      `${GRAPH_BASE}/${phone_number_id}/messages`,
      payload,
      { headers: graphHeaders(system_user_access_token) },
    );

    const wa_message_id = graphRes.data?.messages?.[0]?.id;

    await supabase.from("whatsapp_messages").insert({
      account_id: wa_id,
      to_number: phone,
      message_body: payload,
      wa_message_id,
      status: "sent",
      sent_at: new Date().toISOString(),
    });

    logUsage(req, 200);
    return res.status(200).json({
      success: true,
      wa_message_id,
      message: "Interactive message sent",
    });
  } catch (err) {
    const apiError = err.response?.data || err.message;
    console.error("sendInteractiveMessage error:", apiError);
    logUsage(req, 500, JSON.stringify(apiError));
    return res
      .status(500)
      .json({ error: "Failed to send interactive message", details: apiError });
  }
};

/* ─── POST /v1/messages/schedule ────────────────────────────────────────── */
/*
  Schedule a WhatsApp template message to be sent at a future date/time.
  The scheduler cron (runs every minute) picks it up automatically.

  Body:
  {
    "phone":               "919876543210",
    "contact_name":        "Rahul",             // optional
    "wt_id":               "<template uuid>",
    "template_variables":  { "1": "Rahul", "2": "Order #123" },  // if template needs vars
    "media_id":            "<meta media id>",   // only if template has media header AND
                                                // the template doesn't already have one stored
    "scheduled_at":        "2026-04-25T18:30:00+05:30",
    "timezone":            "Asia/Kolkata"        // optional, informational
  }

  Validation (done inside scheduledMessageService):
  - Template must belong to this account and be APPROVED
  - scheduled_at must be in the future
  - If template HEADER is IMAGE/VIDEO/DOCUMENT → media_id required
  - If template BODY has {{N}} vars → all must be provided in template_variables
*/
export const scheduleTemplateMessage = async (req, res) => {
  try {
    const { wa_id } = req.account;
    const {
      phone,
      contact_name,
      wt_id,
      template_variables = {},
      media_id = null,
      scheduled_at,
      timezone = "UTC",
    } = req.body;

    if (!phone || !wt_id || !scheduled_at) {
      logUsage(req, 400, "Missing phone, wt_id, or scheduled_at");
      return res.status(400).json({
        error: "phone, wt_id, and scheduled_at are required",
      });
    }

    const result = await createScheduledMessage({
      user_id: req.apiKey.user_id,
      account_id: wa_id,
      phone_number: phone,
      contact_name,
      wt_id,
      template_variables,
      media_id,
      scheduled_at,
      timezone,
    });

    if (!result.success) {
      logUsage(req, 400, result.code);
      return res.status(400).json({
        error: result.error,
        code: result.code,
        ...(result.hint && { hint: result.hint }),
        ...(result.required_count !== undefined && { required_variable_count: result.required_count }),
        ...(result.missing_indices && { missing_variables: result.missing_indices.map((i) => `{{${i}}}`) }),
        ...(result.required_media_type && { required_media_type: result.required_media_type }),
      });
    }

    logUsage(req, 201);
    return res.status(201).json({
      success: true,
      message: "Message scheduled successfully.",
      data: result.data,
    });
  } catch (err) {
    console.error("scheduleTemplateMessage error:", err.message);
    logUsage(req, 500, err.message);
    return res
      .status(500)
      .json({ error: "Failed to schedule message", details: err.message });
  }
};
