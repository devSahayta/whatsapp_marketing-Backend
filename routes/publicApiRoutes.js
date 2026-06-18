// routes/publicApiRoutes.js
// Public API routes — authenticated via X-API-Key header, NOT Kinde JWT.
// Mount in app.js: app.use("/v1", publicApiRoutes)
//
// Available endpoints:
//   GET   /v1/account
//   GET   /v1/templates
//   GET   /v1/templates/:wt_id
//   GET   /v1/templates/:wt_id/media-stream
//   POST  /v1/templates                     — create a new template (scope: manage_templates)
//   POST  /v1/messages/template
//   POST  /v1/messages/text
//   POST  /v1/messages/interactive
//   POST  /v1/messages/schedule
//   POST  /v1/media/upload                  — multipart upload (≤4.5 MB, Vercel limit)
//   POST  /v1/media/upload-from-url         — upload via public URL (no size limit)
//   POST  /v1/media/prepare-upload          — step 1: get Supabase signed URL
//   POST  /v1/media/process-upload          — step 2: move from Supabase → Meta
//   PATCH /v1/me/webhook

import express from "express";
import multer from "multer";
import { apiKeyAuth, scopeGuard } from "../middleware/apiKeyAuth.js";
import {
  getAccount,
  getTemplates,
  sendTemplateMessage,
  sendTextMessage,
  sendInteractiveMessage,
  scheduleTemplateMessage,
  uploadMedia,
  uploadMediaFromUrl,
  getMediaUploadUrl,
  processUploadedMedia,
  createTemplate,
} from "../controllers/publicApiController.js";

import { supabase } from "../config/supabase.js";
import axios from "axios";

const router = express.Router();

// multer — store uploads in memory (passed as buffer to Meta API)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 }, // 16 MB
});

// All /v1 routes require a valid API key
router.use(apiKeyAuth);

// ── Account ──────────────────────────────────────────────────────────────────
// GET /v1/account
router.get("/account", scopeGuard("get_account"), getAccount);

// ── Templates ─────────────────────────────────────────────────────────────────
// GET /v1/templates
router.get("/templates", scopeGuard("get_templates"), getTemplates);

router.get(
  "/templates/:wt_id",
  scopeGuard("get_templates"),
  async (req, res) => {
    try {
      const { wt_id } = req.params;
      const { wa_id } = req.account;

      const { data, error } = await supabase
        .from("whatsapp_templates")
        .select(
          "wt_id, name, language, category, header_format, variables, buttons, components, preview, status, media_id, created_at",
        )
        .eq("wt_id", wt_id)
        .eq("account_id", wa_id)
        .maybeSingle();

      if (error) throw error;
      if (!data)
        return res
          .status(404)
          .json({ success: false, error: "Template not found" });

      const safeParse = (v) => {
        try {
          return typeof v === "string" ? JSON.parse(v) : v;
        } catch {
          return v;
        }
      };

      return res.status(200).json({
        success: true,
        data: {
          ...data,
          components: safeParse(data.components),
          preview: safeParse(data.preview),
          variables: safeParse(data.variables),
          buttons: safeParse(data.buttons),
        },
      });
    } catch (err) {
      console.error("getTemplate error:", err);
      return res
        .status(500)
        .json({ success: false, error: "Failed to fetch template" });
    }
  },
);

router.get(
  "/templates/:wt_id/media-stream",
  scopeGuard("get_templates"),
  async (req, res) => {
    try {
      const { wt_id } = req.params;
      const { wa_id, system_user_access_token } = req.account;

      const { data: template, error } = await supabase
        .from("whatsapp_templates")
        .select("media_id, header_format, preview")
        .eq("wt_id", wt_id)
        .eq("account_id", wa_id)
        .maybeSingle();

      if (error) throw error;
      if (!template)
        return res.status(404).json({ error: "Template not found" });

      let mediaUrl = null;

      // Step 1: Get fresh URL from Meta using media_id
      if (template.media_id) {
        try {
          const metaRes = await axios.get(
            `https://graph.facebook.com/v21.0/${template.media_id}`,
            {
              headers: { Authorization: `Bearer ${system_user_access_token}` },
            },
          );
          mediaUrl = metaRes.data?.url;
        } catch (metaErr) {
          console.warn(
            "Meta media_id fetch failed:",
            metaErr.response?.data?.error?.message,
          );
        }
      }

      // Fallback: use URL from preview field
      if (!mediaUrl) {
        const preview =
          typeof template.preview === "string"
            ? JSON.parse(template.preview)
            : template.preview;
        const headerComp = preview?.components?.find(
          (c) => c.type === "HEADER",
        );
        mediaUrl = headerComp?.example?.header_handle?.[0] || null;
      }

      if (!mediaUrl) {
        return res
          .status(404)
          .json({ error: "No media found for this template" });
      }

      // Step 2: Fetch the actual image bytes WITH the access token
      // Meta requires Authorization header even for the download URL
      const imageRes = await axios.get(mediaUrl, {
        responseType: "stream",
        timeout: 15000,
        headers: {
          Authorization: `Bearer ${system_user_access_token}`,
          "User-Agent": "WhatsApp/2.23.20.0 A",
        },
      });

      // Step 3: Stream bytes to Sutrak (which forwards to frontend)
      const contentType = imageRes.headers["content-type"] || "image/jpeg";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Access-Control-Allow-Origin", "*");
      imageRes.data.pipe(res);
    } catch (err) {
      const status = err.response?.status;
      console.error(
        "media-stream error:",
        status,
        err.response?.data || err.message,
      );
      // Return SVG placeholder so <img> doesn't break
      return res
        .status(200)
        .setHeader("Content-Type", "image/svg+xml")
        .setHeader("Access-Control-Allow-Origin", "*")
        .send(
          '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="160" viewBox="0 0 300 160">' +
            '<rect width="300" height="160" fill="#1a1a22" rx="8"/>' +
            '<text x="50%" y="45%" text-anchor="middle" fill="#3f3f46" font-size="22" dy=".3em">📷</text>' +
            '<text x="50%" y="65%" text-anchor="middle" fill="#3f3f46" font-size="11" font-family="system-ui">Preview unavailable</text>' +
            "</svg>",
        );
    }
  },
);

// ── Messages ──────────────────────────────────────────────────────────────────
// POST /v1/messages/template
router.post(
  "/messages/template",
  scopeGuard("send_template"),
  sendTemplateMessage,
);

// POST /v1/messages/text
router.post("/messages/text", scopeGuard("send_message"), sendTextMessage);

// POST /v1/messages/interactive
router.post(
  "/messages/interactive",
  scopeGuard("send_message"),
  sendInteractiveMessage,
);

// POST /v1/messages/schedule  — schedule a template for a future datetime
router.post(
  "/messages/schedule",
  scopeGuard("send_template"),
  scheduleTemplateMessage,
);

// ── Templates (write) ─────────────────────────────────────────────────────────
// POST /v1/templates
router.post("/templates", scopeGuard("manage_templates"), createTemplate);

// ── Media ─────────────────────────────────────────────────────────────────────
// POST /v1/media/upload  (multipart/form-data, ≤4.5 MB — Vercel hard limit)
router.post(
  "/media/upload",
  scopeGuard("upload_media"),
  upload.single("file"),
  uploadMedia,
);

// POST /v1/media/upload-from-url  (preferred — no size limit, server fetches binary)
router.post(
  "/media/upload-from-url",
  scopeGuard("upload_media"),
  uploadMediaFromUrl,
);

// POST /v1/media/prepare-upload  (step 1 of signed-URL flow)
router.post(
  "/media/prepare-upload",
  scopeGuard("upload_media"),
  getMediaUploadUrl,
);

// POST /v1/media/process-upload  (step 2 of signed-URL flow)
router.post(
  "/media/process-upload",
  scopeGuard("upload_media"),
  processUploadedMedia,
);

// PATCH /v1/me/webhook
router.patch("/me/webhook", async (req, res) => {
  try {
    const { webhook_url } = req.body;
    if (!webhook_url) {
      return res.status(400).json({ error: "webhook_url is required" });
    }

    const { error } = await supabase
      .from("api_keys")
      .update({ webhook_url })
      .eq("key_id", req.apiKey.key_id);

    if (error) throw error;

    return res.status(200).json({
      success: true,
      message: "Webhook URL updated",
      webhook_url,
    });
  } catch (err) {
    console.error("update webhook error:", err);
    return res.status(500).json({ error: "Failed to update webhook URL" });
  }
});

export default router;
