// routes/publicApiRoutes.js
// Public API routes — authenticated via X-API-Key header, NOT Kinde JWT.
// Mount in app.js: app.use("/v1", publicApiRoutes)
//
// Available endpoints:
//   GET  /v1/account
//   GET  /v1/templates
//   POST /v1/messages/template
//   POST /v1/messages/text
//   POST /v1/messages/interactive
//   POST /v1/messages/schedule
//   POST /v1/media/upload

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
  "/templates/:wt_id/media",
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

      // Try media_id first — gives fresh non-expired URL from Meta
      if (template.media_id) {
        try {
          const metaRes = await axios.get(
            `https://graph.facebook.com/v21.0/${template.media_id}`,
            {
              headers: { Authorization: `Bearer ${system_user_access_token}` },
            },
          );
          const freshUrl = metaRes.data?.url;
          if (freshUrl)
            return res.json({ success: true, url: freshUrl, source: "meta" });
        } catch (metaErr) {
          console.warn(
            "Meta media fetch failed:",
            metaErr.response?.data?.error?.message,
          );
        }
      }

      // Fallback to preview field URL
      const preview =
        typeof template.preview === "string"
          ? JSON.parse(template.preview)
          : template.preview;
      const headerComp = preview?.components?.find((c) => c.type === "HEADER");
      const previewUrl = headerComp?.example?.header_handle?.[0];

      if (previewUrl)
        return res.json({ success: true, url: previewUrl, source: "preview" });

      return res
        .status(404)
        .json({ error: "No media found for this template" });
    } catch (err) {
      console.error(
        "getTemplateMedia error:",
        err.response?.data || err.message,
      );
      return res.status(500).json({ error: "Failed to get media URL" });
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

// ── Media ─────────────────────────────────────────────────────────────────────
// POST /v1/media/upload  (multipart/form-data, field: file)
router.post(
  "/media/upload",
  scopeGuard("upload_media"),
  upload.single("file"),
  uploadMedia,
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
