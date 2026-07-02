// controllers/publicApiController.js
// Public API endpoints — authenticated via API key (apiKeyAuth middleware).
// Consumed by external apps (Doctor CRM, etc.) to use Samvaadik as a WhatsApp service.

import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import FormData from "form-data";
import { supabase } from "../config/supabase.js";
import { createScheduledMessage } from "../services/scheduledMessageService.js";
import * as wsService from "../services/whatsappTemplateService.js";

const { FormData: NativeFormData, Blob } = global;
const PUBLIC_API_BUCKET = "template-media";

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
    return res
      .status(500)
      .json({ error: "Failed to send template message", details: apiError });
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
    (Date.now() - new Date(lastUserMsg.created_at).getTime()) /
    (1000 * 60 * 60);

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
    // x-skip-window-check: "true" bypasses this for trusted internal callers
    // (e.g. Sutrak smart fields bot replying to a guest mid-session)
    const skipWindowCheck = req.headers["x-skip-window-check"] === "true";

    if (!skipWindowCheck) {
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
      return res.status(400).json({
        error: "No file uploaded. Use multipart/form-data with field 'file'.",
      });
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
        ...(result.required_count !== undefined && {
          required_variable_count: result.required_count,
        }),
        ...(result.missing_indices && {
          missing_variables: result.missing_indices.map((i) => `{{${i}}}`),
        }),
        ...(result.required_media_type && {
          required_media_type: result.required_media_type,
        }),
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

/* ─── GET /v1/messages/schedule/:sm_id ──────────────────────────────────── */
/*
  Get the status of a single scheduled message.
*/
export const getScheduledMessageStatus = async (req, res) => {
  try {
    const { wa_id } = req.account;
    const { sm_id } = req.params;

    const { data, error } = await supabase
      .from("scheduled_messages")
      .select(
        "sm_id, phone_number, contact_name, wt_id, scheduled_at, timezone, status, wa_message_id, wm_id, sent_at, failed_at, error_message, error_code, created_at, updated_at",
      )
      .eq("sm_id", sm_id)
      .eq("account_id", wa_id)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      logUsage(req, 404, "Scheduled message not found");
      return res
        .status(404)
        .json({ success: false, error: "Scheduled message not found" });
    }

    logUsage(req, 200);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("getScheduledMessageStatus error:", err);
    logUsage(req, 500, err.message);
    return res
      .status(500)
      .json({ error: "Failed to fetch scheduled message status" });
  }
};

/* ─── GET /v1/messages/schedule ─────────────────────────────────────────── */
/*
  List scheduled messages for this account, most recent first.

  Query params (all optional):
    status  — filter by status: scheduled | sent | failed | cancelled
    phone   — filter by recipient phone number
    limit   — max rows to return (default 50, max 200)
    offset  — pagination offset (default 0)
*/
export const listScheduledMessages = async (req, res) => {
  try {
    const { wa_id } = req.account;
    const { status, phone } = req.query;

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let query = supabase
      .from("scheduled_messages")
      .select(
        "sm_id, phone_number, contact_name, wt_id, scheduled_at, timezone, status, wa_message_id, wm_id, sent_at, failed_at, error_message, error_code, created_at, updated_at",
        { count: "exact" },
      )
      .eq("account_id", wa_id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq("status", status);
    if (phone) query = query.eq("phone_number", phone);

    const { data, error, count } = await query;

    if (error) throw error;

    logUsage(req, 200);
    return res.status(200).json({
      success: true,
      total: count ?? data?.length ?? 0,
      limit,
      offset,
      data: data ?? [],
    });
  } catch (err) {
    console.error("listScheduledMessages error:", err);
    logUsage(req, 500, err.message);
    return res
      .status(500)
      .json({ error: "Failed to fetch scheduled messages" });
  }
};

/* ─── POST /v1/media/upload-from-url ────────────────────────────────────── */
/*
  Primary approach for media uploads — avoids Vercel 4.5 MB request limit.
  The file binary is fetched server-side from the developer's URL, so nothing
  large ever hits the Vercel request body.

  Body (JSON):
  {
    "url":       "https://your-cdn.com/banner.jpg",   // publicly accessible URL
    "file_name": "banner.jpg",
    "file_type": "image/jpeg"                         // MIME type
  }

  Returns: { media_id, header_handle, header_format }
  - media_id      → use in sendTemplateMessage / createTemplate
  - header_handle → use in createTemplate (media header)
  - header_format → IMAGE | VIDEO | DOCUMENT
*/
export const uploadMediaFromUrl = async (req, res) => {
  try {
    const { phone_number_id, system_user_access_token, wa_id, app_id } =
      req.account;
    const { url: fileUrl, file_name, file_type } = req.body;

    if (!fileUrl || !file_name || !file_type) {
      logUsage(req, 400, "Missing url, file_name, or file_type");
      return res
        .status(400)
        .json({ error: "url, file_name, and file_type are required" });
    }

    if (!app_id) {
      return res.status(400).json({
        error:
          "WhatsApp account is not fully configured (missing app_id). Contact Samvaadik support.",
      });
    }

    const mimeType = file_type;
    let header_format = "IMAGE";
    if (mimeType.startsWith("video/")) header_format = "VIDEO";
    else if (!mimeType.startsWith("image/")) header_format = "DOCUMENT";

    // Step 1: Fetch file from external URL — no Vercel body limit on outgoing requests
    let buffer;
    try {
      const fileRes = await axios.get(fileUrl, {
        responseType: "arraybuffer",
        timeout: 30000,
        maxContentLength: 50 * 1024 * 1024,
      });
      buffer = Buffer.from(fileRes.data);
    } catch (fetchErr) {
      logUsage(req, 400, "Failed to fetch file from URL");
      return res.status(400).json({
        error: "Could not fetch file from the provided URL.",
        details: fetchErr.message,
      });
    }

    // Step 2: Create Meta upload session → needed for header_handle
    const sessionData = await wsService.createUploadSession(
      app_id,
      system_user_access_token,
      { file_name, file_type: mimeType },
    );
    const session_id = sessionData.id;
    if (!session_id) throw new Error("Failed to create Meta upload session");

    // Step 3: Upload buffer to session → header_handle (used when creating template)
    const binaryResp = await wsService.uploadBinaryToSession(
      session_id,
      buffer,
      mimeType,
      system_user_access_token,
    );
    const header_handle = binaryResp.h;
    if (!header_handle)
      throw new Error("Meta did not return a header handle");

    // Step 4: Upload to media API → media_id (used when sending template messages)
    const blob = new Blob([buffer], { type: mimeType });
    const form = new NativeFormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", mimeType);
    form.set("file", blob, file_name);
    const metaMediaResp = await wsService.uploadMediaForMessage(
      phone_number_id,
      system_user_access_token,
      form,
    );
    const media_id = metaMediaResp.id;

    // Step 5: Persist to DB
    await supabase.from("whatsapp_media_uploads").insert({
      account_id: wa_id,
      media_id,
      file_name,
      type: mimeType,
      mime_type: mimeType,
      size_bytes: buffer.byteLength,
    });

    logUsage(req, 200);
    return res.status(200).json({
      success: true,
      media_id,
      header_handle,
      header_format,
      message:
        "Media uploaded successfully. Use media_id and header_handle when calling POST /v1/templates.",
    });
  } catch (err) {
    const apiError = err.response?.data || err.message;
    console.error("uploadMediaFromUrl error:", apiError);
    logUsage(req, 500, JSON.stringify(apiError));
    return res
      .status(500)
      .json({ error: "Failed to upload media from URL", details: apiError });
  }
};

/* ─── POST /v1/media/prepare-upload ─────────────────────────────────────── */
/*
  Step 1 of the Supabase-signed-URL flow (alternative when you don't have a
  hosted URL for your file).

  Body (JSON): { "file_name": "banner.jpg", "file_type": "image/jpeg" }

  Returns: { signed_url, storage_path, expires_in_seconds: 300 }

  After this call:
    PUT <signed_url>   ← upload your file binary here (direct to Supabase, NOT via Samvaadik)
    Content-Type: <file_type>

  Then call POST /v1/media/process-upload with storage_path.
*/
export const getMediaUploadUrl = async (req, res) => {
  try {
    const { file_name, file_type } = req.body;

    if (!file_name || !file_type) {
      logUsage(req, 400, "Missing file_name or file_type");
      return res
        .status(400)
        .json({ error: "file_name and file_type are required" });
    }

    const ext = file_name.split(".").pop().toLowerCase();
    const storagePath = `public-api/${req.apiKey.key_id}/${Date.now()}.${ext}`;

    const { data, error } = await supabase.storage
      .from(PUBLIC_API_BUCKET)
      .createSignedUploadUrl(storagePath);

    if (error) throw error;

    logUsage(req, 200);
    return res.status(200).json({
      success: true,
      signed_url: data.signedUrl,
      storage_path: storagePath,
      expires_in_seconds: 300,
      next_step:
        "PUT your file binary to signed_url, then call POST /v1/media/process-upload with storage_path.",
    });
  } catch (err) {
    console.error("getMediaUploadUrl error:", err);
    logUsage(req, 500, err.message);
    return res
      .status(500)
      .json({ error: "Failed to generate upload URL", details: err.message });
  }
};

/* ─── POST /v1/media/process-upload ─────────────────────────────────────── */
/*
  Step 2 of the Supabase-signed-URL flow.
  Call this after you have PUT your file to the signed_url from prepare-upload.

  Body (JSON):
  {
    "storage_path": "<value from prepare-upload response>",
    "file_name":    "banner.jpg",
    "file_type":    "image/jpeg"
  }

  Returns: { media_id, header_handle, header_format }
*/
export const processUploadedMedia = async (req, res) => {
  try {
    const { phone_number_id, system_user_access_token, wa_id, app_id } =
      req.account;
    const { storage_path, file_name, file_type } = req.body;

    if (!storage_path || !file_name || !file_type) {
      logUsage(req, 400, "Missing storage_path, file_name, or file_type");
      return res
        .status(400)
        .json({ error: "storage_path, file_name, and file_type are required" });
    }

    if (!app_id) {
      return res.status(400).json({
        error:
          "WhatsApp account is not fully configured (missing app_id). Contact Samvaadik support.",
      });
    }

    // Reject paths that don't belong to this API key — prevents accessing other keys' uploads
    const expectedPrefix = `public-api/${req.apiKey.key_id}/`;
    if (!storage_path.startsWith(expectedPrefix)) {
      logUsage(req, 403, "storage_path does not belong to this API key");
      return res.status(403).json({ error: "Invalid storage_path." });
    }

    const ext = storage_path.split(".").pop().toLowerCase();
    const mimeMap = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      mp4: "video/mp4",
      "3gp": "video/3gpp",
      mov: "video/quicktime",
      pdf: "application/pdf",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    const mimeType = mimeMap[ext] || file_type || "application/octet-stream";

    let header_format = "IMAGE";
    if (mimeType.startsWith("video/")) header_format = "VIDEO";
    else if (!mimeType.startsWith("image/")) header_format = "DOCUMENT";

    // Download from Supabase (outgoing request — no Vercel size limit)
    const { data: fileBlob, error: downloadErr } = await supabase.storage
      .from(PUBLIC_API_BUCKET)
      .download(storage_path);

    if (downloadErr || !fileBlob) {
      throw new Error(
        "Failed to download file from storage: " + downloadErr?.message,
      );
    }

    const arrayBuffer = await fileBlob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Create Meta upload session
    const sessionData = await wsService.createUploadSession(
      app_id,
      system_user_access_token,
      { file_name, file_type: mimeType },
    );
    const session_id = sessionData.id;
    if (!session_id) throw new Error("Failed to create Meta upload session");

    // Upload binary → header_handle
    const binaryResp = await wsService.uploadBinaryToSession(
      session_id,
      buffer,
      mimeType,
      system_user_access_token,
    );
    const header_handle = binaryResp.h;
    if (!header_handle)
      throw new Error("Meta did not return a header handle");

    // Upload to media API → media_id
    const blob = new Blob([buffer], { type: mimeType });
    const form = new NativeFormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", mimeType);
    form.set("file", blob, file_name);
    const metaMediaResp = await wsService.uploadMediaForMessage(
      phone_number_id,
      system_user_access_token,
      form,
    );
    const media_id = metaMediaResp.id;

    // Persist to DB
    await supabase.from("whatsapp_media_uploads").insert({
      account_id: wa_id,
      media_id,
      file_name,
      type: mimeType,
      mime_type: mimeType,
      size_bytes: buffer.byteLength,
    });

    // Cleanup Supabase storage — file has been forwarded to Meta
    await supabase.storage.from(PUBLIC_API_BUCKET).remove([storage_path]);

    logUsage(req, 200);
    return res.status(200).json({
      success: true,
      media_id,
      header_handle,
      header_format,
      message:
        "Media processed successfully. Use media_id and header_handle when calling POST /v1/templates.",
    });
  } catch (err) {
    const apiError = err.response?.data || err.message;
    console.error("processUploadedMedia error:", apiError);
    logUsage(req, 500, JSON.stringify(apiError));

    // Clean up Supabase storage even on failure — bucket is only 50 MB
    if (req.body?.storage_path) {
      supabase.storage
        .from(PUBLIC_API_BUCKET)
        .remove([req.body.storage_path])
        .catch(() => {});
    }

    return res.status(500).json({
      error: "Failed to process uploaded media",
      details: apiError,
    });
  }
};

/* ─── POST /v1/templates ─────────────────────────────────────────────────── */
/*
  Create a WhatsApp message template and submit it to Meta for approval.

  For TEXT-only templates:
  {
    "name":          "order_confirmation",
    "category":      "UTILITY",           // MARKETING | UTILITY | AUTHENTICATION
    "language":      "en_US",
    "body_text":     "Hi {{1}}, your order {{2}} is confirmed.",
    "body_examples": ["John", "ORD-1234"],  // required when body has variables
    "header_format": "TEXT",              // optional
    "header_text":   "Order Update",      // required when header_format is TEXT
    "footer_text":   "Reply STOP to opt out.",  // optional
    "buttons": [                          // optional, max 3
      { "type": "QUICK_REPLY", "text": "Track Order" },
      { "type": "URL", "text": "View Details", "url": "https://example.com/order/{{1}}", "url_example": "https://example.com/order/ORD-1234" }
    ]
  }

  For MEDIA templates (IMAGE / VIDEO / DOCUMENT):
  — First call POST /v1/media/upload-from-url (or the prepare/process flow)
    to get header_handle and media_id, then include them here:
  {
    "name":           "promo_banner",
    "category":       "MARKETING",
    "language":       "en_US",
    "body_text":      "Check out our new offer!",
    "header_format":  "IMAGE",
    "header_handle":  "<h: handle from media upload>",
    "media_id":       "<media_id from media upload>"
  }
*/
export const createTemplate = async (req, res) => {
  try {
    const { wa_id, waba_id, system_user_access_token } = req.account;
    const {
      name,
      category,
      language = "en_US",
      body_text,
      body_examples = [],
      header_format,
      header_text,
      header_handle,
      media_id,
      footer_text,
      buttons = [],
    } = req.body;

    if (!name || !category || !body_text) {
      logUsage(req, 400, "Missing name, category, or body_text");
      return res
        .status(400)
        .json({ error: "name, category, and body_text are required" });
    }

    if (!["MARKETING", "UTILITY", "AUTHENTICATION"].includes(category)) {
      return res.status(400).json({
        error: "category must be one of: MARKETING, UTILITY, AUTHENTICATION",
      });
    }

    // Normalize name — Meta requires lowercase, underscores only
    const normalizedName = name
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "");

    if (!normalizedName) {
      return res.status(400).json({
        error:
          "Template name is invalid. Use letters, numbers, and underscores only.",
      });
    }

    // Duplicate check
    const { data: existing } = await supabase
      .from("whatsapp_templates")
      .select("wt_id")
      .eq("account_id", wa_id)
      .eq("name", normalizedName)
      .limit(1)
      .maybeSingle();

    if (existing) {
      logUsage(req, 409, "Duplicate template name");
      return res.status(409).json({
        error: `A template named "${normalizedName}" already exists.`,
      });
    }

    // Build Meta components array
    const components = [];

    if (
      header_format &&
      ["IMAGE", "VIDEO", "DOCUMENT"].includes(header_format) &&
      header_handle
    ) {
      components.push({
        type: "HEADER",
        format: header_format,
        example: { header_handle: [header_handle] },
      });
    } else if (header_text?.trim()) {
      components.push({
        type: "HEADER",
        format: "TEXT",
        text: header_text.trim(),
      });
    }

    const variableMatches = body_text.match(/\{\{\d+\}\}/g) || [];
    const bodyComponent = { type: "BODY", text: body_text };
    if (variableMatches.length > 0 && body_examples.length > 0) {
      bodyComponent.example = { body_text: [body_examples] };
    }
    components.push(bodyComponent);

    if (footer_text?.trim()) {
      components.push({ type: "FOOTER", text: footer_text.trim() });
    }

    if (buttons.length > 0) {
      const builtButtons = buttons.map((btn) => {
        if (btn.type === "QUICK_REPLY")
          return { type: "QUICK_REPLY", text: btn.text };
        if (btn.type === "PHONE_NUMBER")
          return {
            type: "PHONE_NUMBER",
            text: btn.text,
            phone_number: btn.phone_number,
          };
        if (btn.type === "URL") {
          const urlBtn = { type: "URL", text: btn.text, url: btn.url };
          if (btn.url?.includes("{{1}}") && btn.url_example)
            urlBtn.example = [btn.url_example];
          return urlBtn;
        }
        return btn;
      });
      components.push({ type: "BUTTONS", buttons: builtButtons });
    }

    // Submit to Meta (with retry)
    let metaResp;
    let attempts = 0;
    while (attempts < 3) {
      try {
        attempts++;
        metaResp = await wsService.createTemplateOnMeta(
          waba_id,
          system_user_access_token,
          {
            name: normalizedName,
            language,
            category,
            parameter_format: "positional",
            components,
          },
        );
        break;
      } catch (retryErr) {
        if (attempts >= 3) {
          const apiError =
            retryErr.response?.data || { error: retryErr.message };
          logUsage(
            req,
            retryErr.response?.status || 400,
            JSON.stringify(apiError),
          );
          return res
            .status(retryErr.response?.status || 400)
            .json(apiError);
        }
        await new Promise((r) => setTimeout(r, 2000 * attempts));
      }
    }

    // Fetch preview from Meta (best-effort)
    let preview = {};
    try {
      const allTemplates = await wsService.listTemplatesFromMeta(
        waba_id,
        system_user_access_token,
      );
      preview =
        (metaResp?.id
          ? allTemplates.find((t) => t.id === metaResp.id)
          : null) ||
        allTemplates.find((t) => t.name === normalizedName) ||
        {};
    } catch {
      // preview stays {} — not worth failing the request over
    }

    // Persist to DB
    const wt_id = uuidv4();
    const insert = {
      wt_id,
      account_id: wa_id,
      template_id: metaResp.id || null,
      name: normalizedName,
      language,
      category,
      parameter_format: "positional",
      components,
      header_format: ["IMAGE", "VIDEO", "DOCUMENT"].includes(header_format)
        ? header_format
        : header_text?.trim()
          ? "TEXT"
          : null,
      header_handle: header_handle || null,
      variables: body_examples,
      buttons: buttons.length > 0 ? buttons : [],
      preview,
      status: preview?.status || metaResp.status || "PENDING",
      media_id: media_id || null,
    };

    const { error: insertErr } = await supabase
      .from("whatsapp_templates")
      .insert(insert);
    if (insertErr) throw insertErr;

    logUsage(req, 201);
    return res.status(201).json({
      success: true,
      data: {
        wt_id,
        name: normalizedName,
        category,
        language,
        status: insert.status,
        header_format: insert.header_format,
        media_id: insert.media_id,
      },
      message:
        insert.status === "APPROVED"
          ? "Template created and approved by Meta."
          : "Template submitted to Meta for approval. It usually takes a few minutes to a few hours.",
    });
  } catch (err) {
    const apiError = err.response?.data || err.message;
    console.error("createTemplate error:", apiError);
    logUsage(req, 500, JSON.stringify(apiError));
    return res
      .status(500)
      .json({ error: "Failed to create template", details: apiError });
  }
};
