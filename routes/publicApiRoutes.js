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

// GET /v1/templates/:wt_id — fetch full template including components for preview
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
          "wt_id, name, language, category, header_format, header_handle, variables, buttons, components, status, media_id, created_at",
        )
        .eq("wt_id", wt_id)
        .eq("account_id", wa_id)
        .maybeSingle();

      if (error) throw error;
      if (!data) return res.status(404).json({ error: "Template not found" });

      logUsage(req, 200);
      return res.status(200).json({ success: true, data });
    } catch (err) {
      console.error("getTemplate error:", err);
      return res.status(500).json({ error: "Failed to fetch template" });
    }
  },
);

export default router;
