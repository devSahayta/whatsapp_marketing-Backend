// controllers/apiKeyController.js
// Kinde-authenticated CRUD for API keys.
// Users manage keys for their own WhatsApp accounts.

import crypto from "crypto";
import { supabase } from "../config/supabase.js";
import { hashApiKey } from "../middleware/apiKeyAuth.js";

const VALID_SCOPES = [
  "send_template",
  "send_message",
  "get_templates",
  "upload_media",
  "get_account",
];

/**
 * Generate a new API key string: sk_live_<32 random hex chars>
 * Returns { rawKey, prefix, hash }
 */
function generateApiKey() {
  const secret = crypto.randomBytes(32).toString("hex"); // 64 chars
  const rawKey = `sk_live_${secret}`;
  const prefix = `sk_live_${secret.slice(0, 8)}`;
  const hash = hashApiKey(rawKey);
  return { rawKey, prefix, hash };
}

/* ─── CREATE ─────────────────────────────────────────────────────────────── */

export const createApiKey = async (req, res) => {
  try {
    const user_id = req.user?.user_id;
    if (!user_id) return res.status(401).json({ error: "Unauthorized" });

    const {
      key_name,
      account_id,
      scopes = VALID_SCOPES,
      webhook_url = null,
      expires_at = null,
    } = req.body;

    if (!key_name || !account_id) {
      return res
        .status(400)
        .json({ error: "key_name and account_id are required" });
    }

    // Validate scopes
    const invalidScopes = scopes.filter((s) => !VALID_SCOPES.includes(s));
    if (invalidScopes.length) {
      return res.status(400).json({
        error: `Invalid scopes: ${invalidScopes.join(", ")}. Valid: ${VALID_SCOPES.join(", ")}`,
      });
    }

    // Ensure this account belongs to the requesting user
    const { data: account, error: accErr } = await supabase
      .from("whatsapp_accounts")
      .select("wa_id")
      .eq("wa_id", account_id)
      .eq("user_id", user_id)
      .maybeSingle();

    if (accErr || !account) {
      return res
        .status(403)
        .json({ error: "Account not found or does not belong to you." });
    }

    const { rawKey, prefix, hash } = generateApiKey();

    const { data, error } = await supabase
      .from("api_keys")
      .insert({
        user_id,
        account_id,
        key_name,
        api_key_hash: hash,
        key_prefix: prefix,
        scopes,
        webhook_url,
        expires_at,
      })
      .select(
        "key_id, key_name, key_prefix, scopes, webhook_url, is_active, expires_at, created_at",
      )
      .single();

    if (error) throw error;

    // Return the raw key ONCE — we never store or return it again
    return res.status(201).json({
      success: true,
      message:
        "API key created. Copy the api_key now — it will not be shown again.",
      data: {
        ...data,
        api_key: rawKey, // shown only on creation
      },
    });
  } catch (err) {
    console.error("createApiKey error:", err);
    return res.status(500).json({ error: "Failed to create API key" });
  }
};

/* ─── LIST ───────────────────────────────────────────────────────────────── */

export const listApiKeys = async (req, res) => {
  try {
    const user_id = req.user?.user_id;
    if (!user_id) return res.status(401).json({ error: "Unauthorized" });

    const { account_id } = req.query;

    let query = supabase
      .from("api_keys")
      .select(
        "key_id, key_name, key_prefix, scopes, webhook_url, is_active, last_used_at, expires_at, created_at, account_id",
      )
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (account_id) {
      query = query.eq("account_id", account_id);
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.status(200).json({ success: true, data: data ?? [] });
  } catch (err) {
    console.error("listApiKeys error:", err);
    return res.status(500).json({ error: "Failed to fetch API keys" });
  }
};

/* ─── UPDATE (name / webhook_url / scopes) ───────────────────────────────── */

export const updateApiKey = async (req, res) => {
  try {
    const user_id = req.user?.user_id;
    if (!user_id) return res.status(401).json({ error: "Unauthorized" });

    const { key_id } = req.params;
    const { key_name, webhook_url, scopes } = req.body;

    // Ensure key belongs to user
    const { data: existing, error: findErr } = await supabase
      .from("api_keys")
      .select("key_id")
      .eq("key_id", key_id)
      .eq("user_id", user_id)
      .maybeSingle();

    if (findErr || !existing) {
      return res.status(404).json({ error: "API key not found." });
    }

    const patch = {};
    if (key_name !== undefined) patch.key_name = key_name;
    if (webhook_url !== undefined) patch.webhook_url = webhook_url;
    if (scopes !== undefined) {
      const invalidScopes = scopes.filter((s) => !VALID_SCOPES.includes(s));
      if (invalidScopes.length) {
        return res.status(400).json({
          error: `Invalid scopes: ${invalidScopes.join(", ")}`,
        });
      }
      patch.scopes = scopes;
    }

    if (!Object.keys(patch).length) {
      return res
        .status(400)
        .json({ error: "Nothing to update. Provide key_name, webhook_url, or scopes." });
    }

    const { data, error } = await supabase
      .from("api_keys")
      .update(patch)
      .eq("key_id", key_id)
      .select(
        "key_id, key_name, key_prefix, scopes, webhook_url, is_active, expires_at, created_at",
      )
      .single();

    if (error) throw error;

    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("updateApiKey error:", err);
    return res.status(500).json({ error: "Failed to update API key" });
  }
};

/* ─── REVOKE ─────────────────────────────────────────────────────────────── */

export const revokeApiKey = async (req, res) => {
  try {
    const user_id = req.user?.user_id;
    if (!user_id) return res.status(401).json({ error: "Unauthorized" });

    const { key_id } = req.params;

    const { data: existing, error: findErr } = await supabase
      .from("api_keys")
      .select("key_id")
      .eq("key_id", key_id)
      .eq("user_id", user_id)
      .maybeSingle();

    if (findErr || !existing) {
      return res.status(404).json({ error: "API key not found." });
    }

    const { error } = await supabase
      .from("api_keys")
      .update({ is_active: false })
      .eq("key_id", key_id);

    if (error) throw error;

    return res.status(200).json({ success: true, message: "API key revoked." });
  } catch (err) {
    console.error("revokeApiKey error:", err);
    return res.status(500).json({ error: "Failed to revoke API key" });
  }
};

/* ─── DELETE PERMANENTLY ─────────────────────────────────────────────────── */

export const deleteApiKey = async (req, res) => {
  try {
    const user_id = req.user?.user_id;
    if (!user_id) return res.status(401).json({ error: "Unauthorized" });

    const { key_id } = req.params;

    const { data: existing, error: findErr } = await supabase
      .from("api_keys")
      .select("key_id")
      .eq("key_id", key_id)
      .eq("user_id", user_id)
      .maybeSingle();

    if (findErr || !existing) {
      return res.status(404).json({ error: "API key not found." });
    }

    const { error } = await supabase
      .from("api_keys")
      .delete()
      .eq("key_id", key_id);

    if (error) throw error;

    return res
      .status(200)
      .json({ success: true, message: "API key deleted permanently." });
  } catch (err) {
    console.error("deleteApiKey error:", err);
    return res.status(500).json({ error: "Failed to delete API key" });
  }
};

/* ─── GET USAGE LOGS ─────────────────────────────────────────────────────── */

export const getUsageLogs = async (req, res) => {
  try {
    const user_id = req.user?.user_id;
    if (!user_id) return res.status(401).json({ error: "Unauthorized" });

    const { key_id, limit = 50, offset = 0 } = req.query;

    let query = supabase
      .from("api_usage_logs")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (key_id) {
      query = query.eq("key_id", key_id);
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.status(200).json({ success: true, data: data ?? [] });
  } catch (err) {
    console.error("getUsageLogs error:", err);
    return res.status(500).json({ error: "Failed to fetch usage logs" });
  }
};
