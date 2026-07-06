// controllers/whatsappTemplateController.js
import { v4 as uuidv4 } from "uuid";
import { supabase } from "../config/supabase.js";
import * as wsService from "../services/whatsappTemplateService.js";
import { getWhatsappAccount } from "../services/waAccountService.js";
import {
  renderTemplateBody,
  getOrCreateChat,
  extractTemplateButtons,
} from "../utils/whatsappTemplateHelpers.js";
import fetch from "node-fetch";

// ── Fetch actual media URL from Meta (for storing in messages table) ──────────
async function fetchMetaMediaUrl(mediaId, accessToken) {
  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    return data.url || null;
  } catch {
    return null;
  }
}

// ── Extract all display data from template components ─────────────────────────
function extractTemplateDisplayData(template, finalComponents) {
  const components = template.components || [];

  // Body text
  const renderedText = renderTemplateBody(template, finalComponents);

  // Footer
  const footerComp = components.find((c) => c.type === "FOOTER");
  const footerText = footerComp?.text || null;
  const fullMessage = footerText
    ? `${renderedText}\n\n**${footerText}**`
    : renderedText;

  // Header
  let mediaPath = null;
  let msgType = "template";
  const headerComp = components.find((c) => c.type === "HEADER");

  if (headerComp) {
    const fmt = headerComp.format;
    if (fmt === "VIDEO") msgType = "template_video";
    if (fmt === "DOCUMENT") msgType = "template_document";

    // 1. Dynamic media ID from send components
    const sendHeader = finalComponents.find((c) => c.type === "header");
    const dynamicId =
      sendHeader?.parameters?.[0]?.image?.id ||
      sendHeader?.parameters?.[0]?.video?.id ||
      sendHeader?.parameters?.[0]?.document?.id ||
      null;
    if (dynamicId) mediaPath = dynamicId;

    // 2. Permanent URL from preview (best — doesn't expire)
    if (!mediaPath) {
      const previewHeader = (template.preview?.components || []).find(
        (c) => c.type === "HEADER",
      );
      const permanentUrl = previewHeader?.example?.header_handle?.[0];
      if (permanentUrl?.startsWith("http")) mediaPath = permanentUrl;
    }

    // 3. Static header handle from components definition
    if (!mediaPath) {
      const staticUrl = headerComp?.example?.header_handle?.[0];
      if (staticUrl?.startsWith("http")) mediaPath = staticUrl;
    }

    // 4. Text header — prepend to message
    if (!mediaPath && fmt === "TEXT" && headerComp.text) {
      return {
        fullMessage: `**${headerComp.text}**\n\n${fullMessage}`,
        mediaPath: null,
        msgType: "template",
      };
    }
  }

  return { fullMessage, mediaPath, msgType };
}

const { FormData, Blob } = global;

// top of controller file
const bulkProgress = new Map();
// key: user_id + templateId

// create template (submit to Meta first, then insert into DB on success)
export async function createTemplate(req, res) {
  try {
    const payload = req.body;
    const wt_id = uuidv4();

    // fetch account row (reads system_user_access_token, waba_id, phone_number_id)
    let account;
    if (payload.account_id) {
      const { data } = await supabase
        .from("whatsapp_accounts")
        .select("*")
        .eq("wa_id", payload.account_id)
        .single();
      account = data;
    } else {
      const { data } = await supabase
        .from("whatsapp_accounts")
        .select("*")
        .eq("user_id", payload.user_id)
        .limit(1)
        .single();
      account = data;
    }

    // Check for duplicate template name if account exists
    if (account) {
      const { data: existingTemplate } = await supabase
        .from("whatsapp_templates")
        .select("wt_id")
        .eq("account_id", account.wa_id)
        .eq("name", payload.name)
        .limit(1)
        .single();

      if (existingTemplate) {
        return res.status(409).json({
          error: `A template with the name "${payload.name}" already exists.`,
        });
      }
    }

    // Extract BODY example variables safely
    let bodyVariables = [];
    const bodyComponent = payload.components?.find((c) => c.type === "BODY");
    if (bodyComponent?.example?.body_text?.[0]) {
      bodyVariables = bodyComponent.example.body_text[0];
    }

    // Extract buttons safely
    let buttonList = [];
    const buttonComponent = payload.components?.find(
      (c) => c.type === "BUTTONS",
    );
    if (buttonComponent?.buttons) {
      buttonList = buttonComponent.buttons;
    }

    if (account?.system_user_access_token && account.waba_id) {
      // ── Step 1: Create on Meta (with retry) ──────────────────────────────────
      let metaResp;
      let attempts = 0;
      while (attempts < 3) {
        try {
          attempts++;
          console.log(`📤 Meta API attempt ${attempts}...`);
          metaResp = await wsService.createTemplateOnMeta(
            account.waba_id,
            account.system_user_access_token,
            {
              name: payload.name,
              language: payload.language,
              category: payload.category,
              parameter_format: payload.parameter_format || "positional",
              components: payload.components,
            },
          );
          break;
        } catch (retryErr) {
          console.warn(`⚠️  Attempt ${attempts} failed:`, retryErr.message);
          if (attempts >= 3) {
            console.error("❌ Meta template creation failed:");
            console.error("Status:", retryErr.response?.status);
            console.error(
              "Error:",
              JSON.stringify(retryErr.response?.data, null, 2),
            );
            return res
              .status(retryErr.response?.status || 400)
              .json(retryErr.response?.data || { error: retryErr.message });
          }
          await new Promise((r) => setTimeout(r, 2000 * attempts));
        }
      }

      // ── Step 2: Fetch the created template from Meta for preview & status ────
      let preview = null;
      const templateId = metaResp?.id;
      try {
        const data = await wsService.listTemplatesFromMeta(
          account.waba_id,
          account.system_user_access_token,
        );
        const templates = data.data || data || [];
        if (templateId) {
          preview = templates.find((tpl) => tpl.id === templateId);
        }
        if (!preview) {
          preview = templates.find((tpl) => tpl.name === payload.name);
        }
      } catch (e) {
        console.warn("Template created but preview fetch failed:", e.message);
      }

      // ── Step 3: Insert into DB with all fields in one shot ───────────────────
      const insert = {
        wt_id,
        account_id: account.wa_id,
        template_id: metaResp.id || null,
        name: payload.name,
        language: payload.language || "en_US",
        category: payload.category || "MARKETING",
        parameter_format: payload.parameter_format || "positional",
        components: payload.components || [],
        header_format: payload.header_format || null,
        header_handle: payload.header_handle || null,
        variables: payload.variables || bodyVariables,
        buttons: payload.buttons || buttonList,
        preview: preview || {},
        status: preview?.status || metaResp.status || "PENDING",
        media_id: payload.media_id || null,
      };

      const { error: insertErr } = await supabase
        .from("whatsapp_templates")
        .insert(insert);
      if (insertErr) throw insertErr;

      return res.status(201).json({ template: insert, meta: metaResp });
    }

    return res.status(400).json({
      error:
        "WhatsApp account not configured. Cannot create template without Meta credentials.",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || err });
  }
}

// Prepare a media header for a template via AI chat.
// File is uploaded directly from browser to Supabase (bypasses Vercel 4.5MB limit).
// This endpoint receives only storage_path (JSON) — no file binary.
// Flow: download from Supabase → createUploadSession → uploadBinaryToSession (h: handle)
//       → uploadMediaForMessage (media_id) → save to DB → cleanup Supabase
export async function prepareMediaHeader(req, res) {
  const BUCKET = "template-media"; // bucket in Supabase storage for uploaded media
  try {
    const { user_id, storage_path, file_name, file_type } = req.body;

    if (!user_id || !storage_path || !file_name || !file_type) {
      return res.status(400).json({
        error: "user_id, storage_path, file_name, and file_type are required",
      });
    }

    const account = await getWhatsappAccount(user_id);
    if (!account)
      return res.status(404).json({ error: "WhatsApp account not found" });
    if (!account.system_user_access_token)
      return res
        .status(400)
        .json({ error: "Missing system_user_access_token" });

    // Detect mime type and header format
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

    // Step 1: Download file from Supabase (outgoing request — no Vercel size limit)
    const { data, error: downloadErr } = await supabase.storage
      .from(BUCKET)
      .download(storage_path);

    if (downloadErr || !data) {
      throw new Error(
        "Failed to download from Supabase: " + downloadErr?.message,
      );
    }

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Step 2: Create Meta upload session
    const sessionData = await wsService.createUploadSession(
      account.app_id,
      account.system_user_access_token,
      { file_name, file_type: mimeType },
    );
    const session_id = sessionData.id;
    if (!session_id) {
      await supabase.storage.from(BUCKET).remove([storage_path]);
      throw new Error("Failed to create Meta upload session");
    }

    // Step 3: Upload buffer to Meta session → get h: handle
    const binaryResp = await wsService.uploadBinaryToSession(
      session_id,
      buffer,
      mimeType,
      account.system_user_access_token,
    );
    const header_handle = binaryResp.h;
    if (!header_handle) {
      await supabase.storage.from(BUCKET).remove([storage_path]);
      return res.status(500).json({
        error: "Meta did not return a header handle",
        debug: binaryResp,
      });
    }

    // Step 4: Upload buffer to Meta media API → get media_id (used in campaigns)
    const blob = new Blob([buffer], { type: mimeType });
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", mimeType);
    form.set("file", blob, file_name);

    const metaMediaResp = await wsService.uploadMediaForMessage(
      account.phone_number_id,
      account.system_user_access_token,
      form,
    );
    const media_id = metaMediaResp.id;

    // Step 5: Save media record to DB
    await supabase.from("whatsapp_media_uploads").insert({
      account_id: account.wa_id,
      media_id,
      file_name,
      type: mimeType,
      mime_type: mimeType,
      size_bytes: buffer.byteLength,
    });

    // Step 6: Clean up Supabase storage
    await supabase.storage.from(BUCKET).remove([storage_path]);

    return res.json({ success: true, header_handle, header_format, media_id });
  } catch (err) {
    console.error("PREPARE MEDIA HEADER ERROR:", err);

    if (req.body?.storage_path) {
      supabase.storage
        .from(BUCKET)
        .remove([req.body.storage_path])
        .catch(() => {});
    }

    return res.status(500).json({ error: err.response?.data || err.message });
  }
}

export async function createUploadSession(req, res) {
  try {
    const { user_id, file_name, file_type } = req.body;

    const account = await getWhatsappAccount(user_id);

    const sessionData = await wsService.createUploadSession(
      account.app_id,
      account.system_user_access_token,
      { file_name, file_type },
    );

    return res.json(sessionData);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

// upload binary: accepts multipart (multer) file forwarded as raw binary to Meta session
export async function uploadBinaryToSession(req, res) {
  try {
    const user_id = req.body.user_id || req.query.user_id;

    if (!user_id) {
      return res.status(400).json({ error: "user_id required" });
    }

    const account = await getWhatsappAccount(user_id);

    const sessionId = req.body.session_id || req.query.session_id;
    if (!sessionId || !req.file || !req.file.buffer)
      return res.status(400).json({ error: "session_id and file required" });
    const buffer = req.file.buffer;
    // use optional access token passed in body to authorize; otherwise rely on env (service)
    const resp = await wsService.uploadBinaryToSession(
      sessionId,
      buffer,
      req.file.mimetype || "application/octet-stream",
      account.system_user_access_token,
    );
    return res.json(resp);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || err });
  }
}

// NEW APPROACH for large file uploads using Supabase signed URLs
const BUCKET = "template-media"; // bucket in Supabase storage for uploaded media

export async function getSupabaseUploadUrl(req, res) {
  try {
    const { user_id, file_name, file_type } = req.body;
    if (!user_id || !file_name) {
      return res.status(400).json({ error: "user_id and file_name required" });
    }

    // Unique path per upload
    const ext = file_name.split(".").pop();
    const storagePath = `uploads/${user_id}/${Date.now()}.${ext}`;

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(storagePath);

    if (error) throw error;

    return res.json({
      signed_url: data.signedUrl, // frontend PUTs file here directly
      token: data.token,
      storage_path: storagePath, // frontend sends this back after upload
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

// This REPLACES the multer-based uploadBinaryToSession for large files

export async function uploadBinaryFromStorage(req, res) {
  try {
    const { user_id, session_id, storage_path } = req.body;

    if (!user_id || !session_id || !storage_path) {
      return res.status(400).json({
        error: "user_id, session_id, and storage_path required",
      });
    }

    const account = await getWhatsappAccount(user_id);

    // Download file from Supabase (outgoing request — no Vercel size limit)
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(storage_path);

    if (error || !data) {
      throw new Error("Failed to download from Supabase: " + error?.message);
    }

    // Convert Blob to Buffer
    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Detect mime type from path
    const ext = storage_path.split(".").pop().toLowerCase();
    const mimeMap = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      mp4: "video/mp4",
      "3gp": "video/3gpp",
      pdf: "application/pdf",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    const mimeType = mimeMap[ext] || "application/octet-stream";

    // Forward buffer to Meta — same logic as your existing controller
    const resp = await wsService.uploadBinaryToSession(
      session_id,
      buffer,
      mimeType,
      account.system_user_access_token,
    );

    // Clean up from Supabase after successful Meta upload (optional but recommended)
    // await supabase.storage.from(BUCKET).remove([storage_path]);

    return res.json(resp);
  } catch (err) {
    console.error(err);

    if (req.body?.storage_path) {
      supabase.storage
        .from(BUCKET)
        .remove([req.body.storage_path])
        .catch(() => {});
    }

    return res.status(500).json({ error: err.message || err });
  }
}

// New endpoint to upload media from Supabase storage directly to used in templates (not sessions) — useful for media templates and template components
export async function uploadMediaFromStorage(req, res) {
  try {
    const { user_id, type, storage_path, file_name, file_size } = req.body;

    if (!user_id) return res.status(400).json({ error: "user_id required" });
    if (!storage_path)
      return res.status(400).json({ error: "storage_path required" });

    const account = await getWhatsappAccount(user_id);
    if (!account)
      return res.status(404).json({ error: "WhatsApp account not found" });

    // Download from Supabase — outgoing request, no Vercel size limit
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(storage_path);

    if (error || !data) {
      throw new Error("Failed to download from Supabase: " + error?.message);
    }

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Detect mime type
    const ext = storage_path.split(".").pop().toLowerCase();
    const mimeMap = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      mp4: "video/mp4",
      "3gp": "video/3gpp",
      pdf: "application/pdf",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ppt: "application/vnd.ms-powerpoint",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      txt: "text/plain",
    };
    const mimeType = mimeMap[ext] || type || "application/octet-stream";
    const originalName = file_name || storage_path.split("/").pop();

    // Build FormData and forward to Meta — same logic as your original uploadMedia
    const blob = new Blob([buffer], { type: mimeType });
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", type || mimeType);
    form.set("file", blob, originalName);

    const metaResp = await wsService.uploadMediaForMessage(
      account.phone_number_id,
      account.system_user_access_token,
      form,
    );

    // Save in database
    const insertRow = {
      account_id: account.wa_id,
      media_id: metaResp.id,
      file_name: originalName,
      type: type || mimeType,
      mime_type: mimeType,
      size_bytes: file_size || buffer.byteLength,
    };

    await supabase.from("whatsapp_media_uploads").insert(insertRow);

    // ✅ Now safe to clean up from Supabase — both Meta uploads are done
    await supabase.storage.from(BUCKET).remove([storage_path]);

    return res.json({
      success: true,
      media: metaResp,
      saved: insertRow,
    });
  } catch (err) {
    console.error("UPLOAD MEDIA FROM STORAGE ERROR:", err);

    if (req.body?.storage_path) {
      supabase.storage
        .from(BUCKET)
        .remove([req.body.storage_path])
        .catch(() => {});
    }

    return res.status(500).json({
      error: err.response?.data || err.message,
    });
  }
}

export async function checkTemplateStatus(req, res) {
  try {
    const wt_id = req.params.wt_id;
    const { data: tpl, error: tplErr } = await supabase
      .from("whatsapp_templates")
      .select("*")
      .eq("wt_id", wt_id)
      .limit(1)
      .single();
    if (tplErr) return res.status(404).json({ error: "Template not found" });
    if (!tpl.template_id)
      return res
        .status(400)
        .json({ error: "Template has not been submitted to Meta" });

    const { data: account, error: acctErr } = await supabase
      .from("whatsapp_accounts")
      .select("*")
      .eq("wa_id", tpl.account_id)
      .limit(1)
      .single();
    if (acctErr)
      return res.status(400).json({ error: "Account not found for template" });
    if (!account.system_user_access_token)
      return res
        .status(400)
        .json({ error: "Account has no system_user_access_token" });

    console.log("No error till here");

    console.log({
      whatsappId: account.waba_id,
      templateName: tpl.name,
      token: account.system_user_access_token,
    });

    const status = await wsService.checkTemplateStatusOnMeta(
      account.waba_id,
      tpl.name,
      account.system_user_access_token,
    );

    console.log({ status });

    if (status && status.status)
      await supabase
        .from("whatsapp_templates")
        .update({ status: status.status })
        .eq("wt_id", wt_id);
    return res.json(status);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || err });
  }
}

export async function listTemplates(req, res) {
  try {
    const user_id = req.query.user_id;

    if (!user_id) {
      return res.status(400).json({ error: "user_id required" });
    }

    const account = await getWhatsappAccount(user_id);

    const account_id = account.wa_id;
    let q = supabase.from("whatsapp_templates").select("*");
    if (account_id) q = q.eq("account_id", account_id);
    const { data, error } = await q.order("created_at", { ascending: false });
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || err });
  }
}

export async function getAllTemplates(req, res) {
  try {
    const user_id = req.query.user_id;

    if (!user_id) {
      return res.status(400).json({ error: "user_id required" });
    }

    const account = await getWhatsappAccount(user_id);

    const { data, error } = await supabase
      .from("whatsapp_templates")
      .select("*")
      .eq("account_id", account.wa_id)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || err });
  }
}

export async function getTemplateById(req, res) {
  try {
    const { wt_id } = req.params;

    if (!wt_id) {
      return res.status(400).json({ error: "wt_id is required" });
    }

    const { data, error } = await supabase
      .from("whatsapp_templates")
      .select("*")
      .eq("wt_id", wt_id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Template not found" });
    }

    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || err });
  }
}

// export async function sendTemplate(req, res) {
//   try {
//     const wt_id = req.params.wt_id;
//     const body = req.body;

//     // 1. Load template row
//     const { data: tpl, error: tplErr } = await supabase
//       .from("whatsapp_templates")
//       .select("*")
//       .eq("wt_id", wt_id)
//       .single();

//     if (tplErr || !tpl) {
//       return res.status(404).json({ error: "Template not found" });
//     }

//     // 2. Load WhatsApp account
//     const user_id = body.user_id || tpl.user_id;
//     const account = await getWhatsappAccount(user_id);
//     if (!account)
//       return res.status(400).json({ error: "WhatsApp account not found" });

//     if (!account.system_user_access_token)
//       return res
//         .status(400)
//         .json({ error: "Missing system_user_access_token" });

//     if (!account.phone_number_id)
//       return res.status(400).json({ error: "Missing phone_number_id" });

//     // -------------------------------------------------------------
//     // 3. Build components EXACTLY as Meta expects
//     // -------------------------------------------------------------

//     let finalComponents = [];

//     // Case A: frontend provides exact components → use them
//     if (body.components && Array.isArray(body.components)) {
//       finalComponents = body.components;
//     }

//     // Case B: variables provided (for normal templates)
//     else if (body.variables && Array.isArray(body.variables)) {
//       finalComponents = [
//         {
//           type: "body",
//           parameters: body.variables.map((v) => ({
//             type: "text",
//             text: v,
//           })),
//         },
//       ];
//     }

//     // Case C: template is stored as media template (if nothing provided)
//     else if (tpl.components && tpl.components.length > 0) {
//       finalComponents = tpl.components;
//     }

//     // -------------------------------------------------------------
//     // 4. Final message payload
//     // -------------------------------------------------------------
//     const messagePayload = {
//       messaging_product: "whatsapp",
//       to: body.to,
//       type: "template",
//       template: {
//         name: tpl.name,
//         language: { code: tpl.language || "en_US" },
//         components: finalComponents,
//       },
//     };

//     // -------------------------------------------------------------
//     // 5. Send to Meta
//     // -------------------------------------------------------------
//     const sendResp = await wsService.sendTemplateMessage(
//       account.phone_number_id,
//       account.system_user_access_token,
//       messagePayload
//     );

//     // -------------------------------------------------------------
//     // 6. Log message
//     // -------------------------------------------------------------
//     const log = {
//       wm_id: uuidv4(),
//       account_id: account.wa_id,
//       to_number: body.to,
//       template_name: tpl.name,
//       message_body: messagePayload,
//       wa_message_id: sendResp?.messages?.[0]?.id || null,
//       status: sendResp.error ? "FAILED" : "SENT",
//     };

//     await supabase.from("whatsapp_messages").insert(log);

//     return res.json({ sendResp, log });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: err.response?.data || err.message });
//   }
// }

export async function sendTemplate(req, res) {
  try {
    const templateId = req.params.templateId;
    const { user_id, to, components, variables } = req.body;

    if (!templateId) {
      return res.status(400).json({ error: "templateId is required" });
    }

    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }

    if (!to) {
      return res
        .status(400)
        .json({ error: "Receiver number 'to' is required" });
    }

    // -------------------------------------------------------------
    // 1. Load WhatsApp Account
    // -------------------------------------------------------------
    const account = await getWhatsappAccount(user_id);
    if (!account)
      return res.status(400).json({ error: "WhatsApp account not found" });

    if (!account.system_user_access_token)
      return res
        .status(400)
        .json({ error: "Missing system_user_access_token" });

    if (!account.phone_number_id)
      return res.status(400).json({ error: "Missing phone_number_id" });

    // -------------------------------------------------------------
    // 2. Get Template Data from Meta
    // -------------------------------------------------------------
    // const metaTemplates = await wsService.listTemplatesFromMeta(
    //   account.waba_id,
    //   account.system_user_access_token
    // );

    const metaTemplates = await wsService.listTemplatesFromDb(
      account.wa_id,
      account.waba_id,
      account.system_user_access_token,
    );

    const allTemplates = metaTemplates.data || metaTemplates || [];

    const template = allTemplates.find((t) => t.id === templateId);

    if (!template) {
      return res.status(404).json({ error: "Template not found on Meta" });
    }

    // -------------------------------------------------------------
    // 3. Build correct Component Payload
    // -------------------------------------------------------------
    let finalComponents = [];

    // CASE A → Frontend sends FULL components (best)
    if (components && Array.isArray(components)) {
      finalComponents = components;
    }
    // CASE B → frontend sends only variables (normal)
    else if (variables && Array.isArray(variables)) {
      finalComponents = [
        {
          type: "body",
          parameters: variables.map((v) => ({
            type: "text",
            text: v,
          })),
        },
      ];
    }
    // CASE C → Template has NO variables (simple, static template)
    else {
      finalComponents = []; // No components needed
    }

    // -------------------------------------------------------------
    // 4. Prepare Final Meta Payload
    // -------------------------------------------------------------
    const messagePayload = {
      messaging_product: "whatsapp",
      to: to,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language || "en_US" },
        components: finalComponents,
      },
    };

    // console.log("FINAL PAYLOAD:", JSON.stringify(messagePayload, null, 2));

    // -------------------------------------------------------------
    // 5. Send to Meta
    // -------------------------------------------------------------
    const sendResp = await wsService.sendTemplateMessage(
      account.phone_number_id,
      account.system_user_access_token,
      messagePayload,
    );

    // -------------------------------------------------------------
    // 6. Log message (Supabase)
    // -------------------------------------------------------------
    const log = {
      wm_id: uuidv4(),
      account_id: account.wa_id,
      to_number: to,
      template_name: template.name,
      message_body: messagePayload,
      wa_message_id: sendResp?.messages?.[0]?.id || null,
      status: sendResp.error ? "FAILED" : "SENT",
    };

    await supabase.from("whatsapp_messages").insert(log);

    // ── Save to messages table for chat dashboard ─────────────────────────────
    // ── Save to messages table ─────────────────────────────
    try {
      const { fullMessage, mediaPath, msgType } = extractTemplateDisplayData(
        template,
        finalComponents,
      );

      const chat = await getOrCreateChat({ phone_number: to, user_id });
      const buttons = extractTemplateButtons(template);

      await supabase.from("messages").insert({
        chat_id: chat.chat_id,
        sender_type: "admin",
        message: fullMessage,
        message_type: msgType,
        media_path: mediaPath,
        buttons,
        created_at: new Date(),
      });

      await supabase
        .from("chats")
        .update({ last_message: fullMessage, last_message_at: new Date() })
        .eq("chat_id", chat.chat_id);
    } catch (chatErr) {
      console.warn(
        "⚠️ Could not save template to chat dashboard:",
        chatErr.message,
      );
    }

    // -------------------------------------------------------------
    // 7. Return Response
    // -------------------------------------------------------------
    return res.json({ success: true, sendResp, log });
  } catch (err) {
    console.error("SEND TEMPLATE ERROR:", err);
    res.status(500).json({
      error: err.response?.data || err.message,
    });
  }
}

//in bulk sending template

export async function sendTemplateBulk(req, res) {
  try {
    const templateId = req.params.templateId;
    const { user_id, recipients, components, variables } = req.body;

    if (!templateId)
      return res.status(400).json({ error: "templateId is required" });
    if (!user_id) return res.status(400).json({ error: "user_id is required" });

    if (!Array.isArray(recipients) || recipients.length === 0)
      return res.status(400).json({ error: "recipients[] required" });

    // --------------------------------------------
    // Load WhatsApp account
    // --------------------------------------------
    const account = await getWhatsappAccount(user_id);
    if (!account)
      return res.status(400).json({ error: "WhatsApp account not found" });

    const token = account.system_user_access_token;
    const phoneNumberId = account.phone_number_id;

    if (!token || !phoneNumberId)
      return res.status(400).json({ error: "Missing WhatsApp configuration" });

    // --------------------------------------------
    // Fetch template from Meta
    // --------------------------------------------
    // const metaTemplates = await wsService.listTemplatesFromMeta(
    //   account.waba_id,
    //   token
    // );

    const metaTemplates = await wsService.listTemplatesFromDb(
      account.wa_id,
      account.waba_id,
      account.system_user_access_token,
    );

    const allTemplates = metaTemplates.data || metaTemplates || [];

    const template = allTemplates.find((t) => t.id === templateId);
    if (!template)
      return res.status(404).json({ error: "Template not found on Meta" });

    // --------------------------------------------
    // Prepare component payload once
    // --------------------------------------------
    let finalComponents = [];

    if (components && Array.isArray(components)) {
      finalComponents = components;
    } else if (variables && Array.isArray(variables)) {
      finalComponents = [
        {
          type: "body",
          parameters: variables.map((v) => ({ type: "text", text: v })),
        },
      ];
    }

    // --------------------------------------------
    // Prepare result container
    // --------------------------------------------
    const results = {
      success: [],
      failed: [],
    };

    // Simple wait function for throttling
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const progressKey = `${user_id}_${templateId}`;

    bulkProgress.set(progressKey, {
      total: recipients.length,
      completed: 0,
    });

    // --------------------------------------------
    // Loop each recipient with throttling
    // --------------------------------------------
    // for (const to of recipients) {
    //   const payload = {
    //     messaging_product: "whatsapp",
    //     to: to,
    //     type: "template",
    //     template: {
    //       name: template.name,
    //       language: { code: template.language || "en_US" },
    //       components: finalComponents,
    //     },
    //   };

    //   try {
    //     const sendResp = await wsService.sendTemplateMessage(
    //       phoneNumberId,
    //       token,
    //       payload,
    //     );

    //     // Log success
    //     const log = {
    //       wm_id: uuidv4(),
    //       account_id: account.wa_id,
    //       to_number: to,
    //       template_name: template.name,
    //       message_body: payload,
    //       wa_message_id: sendResp?.messages?.[0]?.id || null,
    //       status: sendResp.error ? "FAILED" : "SENT",
    //     };

    //     if (!sendResp.error) {
    //       await supabase.from("whatsapp_messages").insert(log);

    //       results.success.push({ to, id: log.wm_id });
    //       // --------------------------------------------
    //       // Render message text for DB
    //       // --------------------------------------------
    //       const renderedText = renderTemplateBody(template, finalComponents);

    //       // --------------------------------------------
    //       // Detect media (optional)
    //       // --------------------------------------------
    //       const headerComp = finalComponents.find((c) => c.type === "header");

    //       const mediaPath =
    //         headerComp?.parameters?.[0]?.image?.id ||
    //         headerComp?.parameters?.[0]?.video?.id ||
    //         headerComp?.parameters?.[0]?.document?.id ||
    //         null;

    //       // --------------------------------------------
    //       // Create / Update Chat
    //       // --------------------------------------------
    //       const chat = await getOrCreateChat({
    //         phone_number: to,
    //         user_id: user_id,
    //       });

    //       // --------------------------------------------
    //       // Insert message
    //       // --------------------------------------------

    //       //checking if any button available in template
    //       const buttons = extractTemplateButtons(template);

    //       //write message
    //       await supabase.from("messages").insert({
    //         chat_id: chat.chat_id,
    //         sender_type: "admin",
    //         message: renderedText,
    //         message_type: "template",
    //         media_path: mediaPath,
    //         buttons,
    //         created_at: new Date(),
    //       });

    //       // --------------------------------------------
    //       // Update chat last message
    //       // --------------------------------------------
    //       await supabase
    //         .from("chats")
    //         .update({
    //           last_message: renderedText,
    //           last_message_at: new Date(),
    //         })
    //         .eq("chat_id", chat.chat_id);
    //     }
    //   } catch (err) {
    //     console.error("Send failed for:", to, err.message);

    //     results.failed.push({
    //       to,
    //       error: err.response?.data || err.message,
    //     });
    //   } finally {
    //     const prog = bulkProgress.get(progressKey);
    //     if (prog) {
    //       prog.completed += 1;
    //       bulkProgress.set(progressKey, prog);
    //     }
    //   }

    //   // Throttle to stay safe from Meta
    //   await wait(350); // 300–400ms is ideal
    // }

    const BATCH_SIZE = 40;

    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (to) => {
          const payload = {
            messaging_product: "whatsapp",
            to: to,
            type: "template",
            template: {
              name: template.name,
              language: { code: template.language || "en_US" },
              components: finalComponents,
            },
          };

          try {
            const sendResp = await wsService.sendTemplateMessage(
              phoneNumberId,
              token,
              payload,
            );

            // Log success
            const log = {
              wm_id: uuidv4(),
              account_id: account.wa_id,
              to_number: to,
              template_name: template.name,
              message_body: payload,
              wa_message_id: sendResp?.messages?.[0]?.id || null,
              status: sendResp.error ? "FAILED" : "SENT",
            };

            if (!sendResp.error) {
              await supabase.from("whatsapp_messages").insert(log);

              results.success.push({ to, id: log.wm_id });
              // --------------------------------------------
              // Render message text for DB
              // --------------------------------------------
              const { fullMessage, mediaPath, msgType } =
                extractTemplateDisplayData(template, finalComponents);

              const chat = await getOrCreateChat({
                phone_number: to,
                user_id: user_id,
              });
              const buttons = extractTemplateButtons(template);

              await supabase.from("messages").insert({
                chat_id: chat.chat_id,
                sender_type: "admin",
                message: fullMessage,
                message_type: msgType,
                media_path: mediaPath,
                buttons,
                wm_id: log.wm_id,
                created_at: new Date(),
              });

              await supabase
                .from("chats")
                .update({
                  last_message: fullMessage,
                  last_message_at: new Date(),
                })
                .eq("chat_id", chat.chat_id);
            }
          } catch (err) {
            console.error("Send failed for:", to, err.message);

            results.failed.push({
              to,
              error: err.response?.data || err.message,
            });
          } finally {
            const prog = bulkProgress.get(progressKey);
            if (prog) {
              prog.completed += 1;
              bulkProgress.set(progressKey, prog);
            }
          }
        }),
      );

      await wait(400);
    }

    bulkProgress.delete(progressKey);

    return res.json({
      success: true,
      total: recipients.length,
      summary: {
        success: results.success.length,
        failed: results.failed.length,
      },
      results,
    });
  } catch (err) {
    console.error("BULK SEND ERROR:", err);
    res.status(500).json({ error: err.response?.data || err.message });
  }
}

// For getting bulk-progress of template sending
export function getBulkProgress(req, res) {
  const { user_id, templateId } = req.query;
  const key = `${user_id}_${templateId}`;

  const progress = bulkProgress.get(key);

  if (!progress) {
    return res.json({ completed: 0, total: 0 });
  }

  // console.log({ progress });

  res.json(progress);
}

export async function uploadMedia(req, res) {
  try {
    const { user_id, type } = req.body;

    if (!user_id) return res.status(400).json({ error: "user_id required" });
    if (!req.file) return res.status(400).json({ error: "file required" });

    const account = await getWhatsappAccount(user_id);
    if (!account)
      return res.status(404).json({ error: "WhatsApp account not found" });

    // Convert buffer → Blob
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype });

    // Native Node FormData (no NPM package needed)
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", type || req.file.mimetype);
    form.set("file", blob, req.file.originalname);

    // Upload to Meta
    const metaResp = await wsService.uploadMediaForMessage(
      account.phone_number_id,
      account.system_user_access_token,
      form,
    );

    // Save in database
    const insertRow = {
      account_id: account.wa_id,
      media_id: metaResp.id,
      file_name: req.file.originalname,
      type: type || req.file.mimetype,
      mime_type: req.file.mimetype,
      size_bytes: req.file.size,
    };

    await supabase.from("whatsapp_media_uploads").insert(insertRow);

    return res.json({
      success: true,
      media: metaResp,
      saved: insertRow,
    });
  } catch (err) {
    console.error("UPLOAD MEDIA ERROR:", err);
    return res.status(500).json({
      error: err.response?.data || err.message,
      debug: err,
    });
  }
}

export async function listMedia(req, res) {
  try {
    const user_id = req.query.user_id;
    if (!user_id) return res.status(400).json({ error: "user_id required" });

    // get whatsapp account
    const account = await getWhatsappAccount(user_id);

    const { data, error } = await supabase
      .from("whatsapp_media_uploads")
      .select("*")
      .eq("account_id", account.wa_id)
      .order("uploaded_at", { ascending: false });

    if (error) throw error;

    return res.json({ media: data });
  } catch (err) {
    console.error("LIST MEDIA ERROR:", err);
    return res.status(500).json({ error: err.message || err });
  }
}

export async function deleteMedia(req, res) {
  try {
    const { media_id } = req.params;
    if (!media_id) return res.status(400).json({ error: "media_id required" });

    const user_id = req.query.user_id;
    if (!user_id) return res.status(400).json({ error: "user_id required" });

    // Get WhatsApp account
    const account = await getWhatsappAccount(req.query.user_id);
    if (!account)
      return res.status(404).json({ error: "WhatsApp account not found" });

    // Check for system_user_access_token
    if (!account || !account.system_user_access_token)
      return res.status(400).json({ error: "Account missing token" });

    // Get media row
    const { data: media, error: mediaErr } = await supabase
      .from("whatsapp_media_uploads")
      .select("*")
      .eq("media_id", media_id)
      .eq("account_id", account.wa_id)
      .single();

    if (mediaErr || !media)
      return res.status(404).json({ error: "Media record not found" });

    // ---- DELETE FROM META ----
    const metaResult = await wsService.deleteMediaFromMeta(
      media.media_id,
      account.system_user_access_token,
    );

    if (!metaResult.success) {
      console.warn("META DELETE FAILED → continuing:", metaResult.error);
    }

    // ---- DELETE FROM DATABASE ----
    await supabase
      .from("whatsapp_media_uploads")
      .delete()
      .eq("wmu_id", media.wmu_id);

    return res.json({
      success: true,
      deleted: media.media_id,
      meta: metaResult,
    });
  } catch (err) {
    console.error("DELETE MEDIA ERROR:", err);
    return res.status(500).json({ error: err.message || err });
  }
}

//List meta template
export async function listMetaTemplates(req, res) {
  try {
    const user_id = req.query.user_id;
    if (!user_id) return res.status(400).json({ error: "user_id is required" });

    const account = await getWhatsappAccount(user_id);

    //fetch from meta
    // const data = await wsService.listTemplatesFromMeta(
    //   account.waba_id,
    //   account.system_user_access_token
    // );

    //fetch from database
    const data = await wsService.listTemplatesFromDb(
      account.wa_id,
      account.waba_id,
      account.system_user_access_token,
    );

    res.json({ templates: data.data || data || [] });
  } catch (err) {
    console.error("LIST META TEMPLATES ERROR:", err);
    res.status(500).json({ error: err.message || err });
  }
}

// Get a single meta template by templateId
export async function getSingleMetaTemplate(req, res) {
  try {
    const user_id = req.query.user_id;
    const templateId = req.query?.templateId;
    const templateName = req.query?.templateName;

    if (!user_id) return res.status(400).json({ error: "user_id is required" });

    if (!templateId && !templateName)
      return res
        .status(400)
        .json({ error: "templateId or templateName is required" });

    // Fetch WhatsApp account details
    const account = await getWhatsappAccount(user_id);

    // Fetch all templates from Meta
    // const data = await wsService.listTemplatesFromMeta(
    //   account.waba_id,
    //   account.system_user_access_token
    // );

    const data = await wsService.listTemplatesFromDb(
      account.wa_id,
      account.waba_id,
      account.system_user_access_token,
    );

    const templates = data.data || data || [];

    // Find template by id

    let template;

    if (templateId) {
      template = templates.find((tpl) => tpl.id === templateId);
    } else if (templateName) {
      template = templates.find((tpl) => tpl.name === templateName);
    }
    // const template = templates.find((tpl) => tpl.id === templateId);

    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }

    res.json({ template });
  } catch (err) {
    console.error("GET META TEMPLATE ERROR:", err);
    res.status(500).json({ error: err.message || err });
  }
}

//get media proxy url for uploaded media files
export async function mediaProxy(req, res) {
  try {
    const mediaId = req.params.mediaId;
    const user_id = req.query.user_id;

    if (!mediaId) return res.status(400).json({ error: "mediaId required" });

    if (!user_id) return res.status(400).json({ error: "user_id required" });

    const account = await getWhatsappAccount(user_id);

    // 1) Get temp URL from Meta
    const meta = await wsService.getMediaMeta(
      mediaId,
      account.system_user_access_token,
    );

    if (!meta.url)
      return res.status(400).json({ error: "Meta returned no url", meta });

    // 2) Fetch actual file stream
    const fileRes = await wsService.fetchMediaFile(
      meta.url,
      account.system_user_access_token,
    );

    // 3) Return file stream to client
    res.setHeader("Content-Type", meta.mime_type || "application/octet-stream");
    fileRes.data.pipe(res);
  } catch (err) {
    console.error("MEDIA PROXY ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: err.message || "Media proxy failed" });
  }
}

export async function mediaProxyUrl(req, res) {
  try {
    const fileUrl = req.query.url;
    const user_id = req.query.user_id;

    if (!fileUrl) {
      return res.status(400).json({ error: "Missing url parameter" });
    }

    if (!user_id) {
      return res.status(400).json({ error: "Missing user_id parameter" });
    }

    // 🔥 Load WhatsApp Account from DB
    const account = await getWhatsappAccount(user_id);

    const accessToken = account.system_user_access_token;

    // Fetch the actual file from Meta CDN
    const fileRes = await fetch(fileUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!fileRes.ok) {
      const errText = await fileRes.text();
      return res.status(500).json({
        error: "Error fetching media",
        debug: errText,
      });
    }

    // Detect content type (image/png, video/mp4, etc.)
    const contentType = fileRes.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);

    // Stream file to frontend
    fileRes.body.pipe(res);
  } catch (err) {
    console.error("Media Proxy URL Error:", err);
    res.status(500).json({ error: err.message });
  }
}

export async function updateTemplateMediaId(req, res) {
  try {
    const { wt_id } = req.params;
    const { media_id, user_id } = req.body;

    if (!wt_id) return res.status(400).json({ error: "wt_id is required" });
    if (!media_id)
      return res.status(400).json({ error: "media_id is required" });
    if (!user_id) return res.status(400).json({ error: "user_id is required" });

    const account = await getWhatsappAccount(user_id);

    const { data, error } = await supabase
      .from("whatsapp_templates")
      .update({ media_id })
      .eq("wt_id", wt_id)
      .eq("account_id", account.wa_id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Template not found" });

    return res.json({ success: true, template: data });
  } catch (err) {
    console.error("UPDATE TEMPLATE MEDIA ID ERROR:", err);
    return res.status(500).json({ error: err.message || err });
  }
}

export async function deleteMetaTemplate(req, res) {
  try {
    const { templateId } = req.params;
    const { user_id, template_name } = req.query;

    if (!user_id) return res.status(400).json({ error: "user_id is required" });
    if (!templateId)
      return res.status(400).json({ error: "templateId is required" });

    // Load WhatsApp Account
    const account = await getWhatsappAccount(user_id);
    if (!account)
      return res.status(400).json({ error: "WhatsApp account not found" });

    if (!account.system_user_access_token)
      return res
        .status(400)
        .json({ error: "Missing system_user_access_token" });

    // Fetch Template list from Meta
    // const metaTemplates = await wsService.listTemplatesFromMeta(
    //   account.waba_id,
    //   account.system_user_access_token
    // );

    // const allTemplates = metaTemplates.data || [];

    // // Find template by ID
    // const tpl = allTemplates.find((t) => t.id === templateId);

    // if (!tpl) {
    //   return res.status(404).json({
    //     error: "Template not found on Meta",
    //   });
    // }

    // Perform delete API call
    const deleteResp = await wsService.deleteMetaTemplate(
      account.waba_id,
      account.system_user_access_token,
      templateId,
      template_name,
    );

    // Fetch template from DB to get media_id before deleting
    const { data: templateRow } = await supabase
      .from("whatsapp_templates")
      .select("media_id")
      .eq("template_id", templateId)
      .single();

    // If template has a linked media, delete it from Meta and DB
    if (templateRow?.media_id) {
      try {
        const mediaId = templateRow.media_id;

        // Delete from Meta
        const mediaMetaResult = await wsService.deleteMediaFromMeta(
          mediaId,
          account.system_user_access_token,
        );
        if (!mediaMetaResult.success) {
          console.warn(
            "META MEDIA DELETE FAILED → continuing:",
            mediaMetaResult.error,
          );
        }

        // Delete from whatsapp_media_uploads table
        await supabase
          .from("whatsapp_media_uploads")
          .delete()
          .eq("media_id", mediaId)
          .eq("account_id", account.wa_id);
      } catch (mediaErr) {
        console.warn("Could not delete linked media:", mediaErr.message);
      }
    }

    // Optionally delete it from your supabase DB also (if stored)
    try {
      await supabase
        .from("whatsapp_templates")
        .delete()
        .eq("template_id", templateId); // adjust column name if different
    } catch (dbErr) {
      console.warn("Could not delete from local DB:", dbErr.message);
    }

    // return res.json({
    //   success: true,
    //   message: "Template deleted successfully",
    //   deleteResp,
    // });

    return res.json({
      success: true,
      message: "Template deleted successfully",
      meta: deleteResp.data || { success: true },
    });
  } catch (err) {
    console.error("DELETE META TEMPLATE ERROR:", err);
    res.status(500).json({
      error: err.response?.data || err.message,
    });
  }
}
