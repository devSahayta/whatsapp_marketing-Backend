// middleware/apiKeyAuth.js
// Validates X-API-Key header for public API routes.
// Injects req.apiKey (the key row) and req.account (the whatsapp_accounts row).

import crypto from "crypto";
import { supabase } from "../config/supabase.js";

/**
 * SHA-256 hash of the raw key — this is what we store in DB.
 */
export function hashApiKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Middleware — authenticate via X-API-Key header.
 * On success: req.apiKey and req.account are populated.
 * On failure: 401 returned immediately.
 */
export const apiKeyAuth = async (req, res, next) => {
  const rawKey = req.headers["x-api-key"];

  if (!rawKey) {
    return res.status(401).json({
      error: "Missing API key. Pass it in the X-API-Key header.",
    });
  }

  const hashed = hashApiKey(rawKey);

  const { data: keyRow, error } = await supabase
    .from("api_keys")
    .select(
      `
      key_id, user_id, account_id, key_name, key_prefix,
      scopes, webhook_url, is_active, expires_at,
      whatsapp_accounts (
        wa_id, phone_number_id, system_user_access_token,
        business_phone_number, waba_id, app_id, status
      )
    `,
    )
    .eq("api_key_hash", hashed)
    .maybeSingle();

  if (error) {
    console.error("apiKeyAuth DB error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }

  if (!keyRow) {
    return res.status(401).json({ error: "Invalid API key." });
  }

  if (!keyRow.is_active) {
    return res.status(401).json({ error: "API key has been revoked." });
  }

  if (keyRow.expires_at && new Date(keyRow.expires_at) < new Date()) {
    return res.status(401).json({ error: "API key has expired." });
  }

  if (!keyRow.whatsapp_accounts) {
    return res.status(403).json({
      error: "No WhatsApp account linked to this API key.",
    });
  }

  // Attach to request
  req.apiKey = keyRow;
  req.account = keyRow.whatsapp_accounts;

  // Update last_used_at asynchronously — don't block the request
  supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("key_id", keyRow.key_id)
    .then(() => {})
    .catch(() => {});

  return next();
};

/**
 * Scope guard middleware factory.
 * Usage: scopeGuard("send_template")
 * Place after apiKeyAuth.
 */
export const scopeGuard = (requiredScope) => (req, res, next) => {
  const scopes = req.apiKey?.scopes ?? [];
  if (!scopes.includes(requiredScope)) {
    return res.status(403).json({
      error: `Forbidden. This API key does not have the '${requiredScope}' scope.`,
    });
  }
  return next();
};
