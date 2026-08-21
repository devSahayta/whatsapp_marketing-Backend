// controllers/shopifyController.js

import axios from "axios";
import { supabase } from "../config/supabase.js";

const SHOPIFY_API_VERSION = "2024-10";

// Refresh the cached access token this many ms before it actually expires
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Make an authenticated call to the Shopify Admin REST API
 */
function shopifyClient(shopDomain, accessToken) {
  return axios.create({
    baseURL: `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}`,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    timeout: 25000,
  });
}

/**
 * Normalize a user-entered shop domain into "xxxx.myshopify.com"
 */
function normalizeShopDomain(input) {
  if (!input) return null;
  let domain = input
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  if (!domain.includes(".")) {
    domain = `${domain}.myshopify.com`;
  }
  return domain;
}

/**
 * Exchange a custom app's Client ID + Client Secret for a short-lived
 * Admin API access token (Shopify's client_credentials grant).
 * Shopify retired the old one-time "shpat_" token shown in the legacy
 * "Develop apps" screen — apps created in the Dev Dashboard must fetch
 * (and periodically refresh) a token this way instead.
 */
async function fetchAccessToken(shopDomain, clientId, clientSecret) {
  const response = await axios.post(
    `https://${shopDomain}/admin/oauth/access_token`,
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    },
  );
  return response.data; // { access_token, scope, expires_in }
}

/**
 * Return a live access token for a stored connection, refreshing it via
 * the client_credentials grant if the cached one is expired or close to it.
 * Exported so future features (automations, webhooks, cart recovery) can
 * reuse it instead of assuming `connection.access_token` is still valid.
 */
export async function getValidAccessToken(connection) {
  const expiresAt = connection.token_expires_at
    ? new Date(connection.token_expires_at).getTime()
    : 0;
  const isExpired = expiresAt - Date.now() < TOKEN_REFRESH_BUFFER_MS;

  if (!isExpired) return connection.access_token;

  const tokenData = await fetchAccessToken(
    connection.shop_domain,
    connection.client_id,
    connection.client_secret,
  );
  const newExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

  await supabase
    .from("user_shopify_connections")
    .update({
      access_token: tokenData.access_token,
      token_expires_at: newExpiresAt,
    })
    .eq("id", connection.id);

  return tokenData.access_token;
}

// ─── Controllers ────────────────────────────────────────────────

/**
 * POST /api/shopify/connect
 * Save a new Shopify store connection.
 * Exchanges the custom app's Client ID + Client Secret for an access
 * token, verifies it against the store, then saves the connection.
 */
export async function connectStore(req, res) {
  const { user_id } = req.user;
  const { shop_domain, client_id, client_secret } = req.body;

  if (!shop_domain || !client_id || !client_secret) {
    return res.status(400).json({
      success: false,
      message: "shop_domain, client_id, and client_secret are required",
    });
  }

  const normalizedDomain = normalizeShopDomain(shop_domain);
  if (!/^[a-z0-9-]+\.myshopify\.com$/i.test(normalizedDomain)) {
    return res.status(400).json({
      success: false,
      message:
        "Invalid shop domain. Use the format your-store.myshopify.com",
    });
  }

  try {
    // A shop domain can only be linked to one account at a time
    const { data: existing } = await supabase
      .from("user_shopify_connections")
      .select("user_id")
      .eq("shop_domain", normalizedDomain)
      .maybeSingle();

    if (existing && existing.user_id !== user_id) {
      return res.status(409).json({
        success: false,
        message: "This Shopify store is already connected to another account.",
      });
    }

    console.log(`🔌 Exchanging Shopify credentials: ${normalizedDomain}`);
    let tokenData;
    try {
      tokenData = await fetchAccessToken(
        normalizedDomain,
        client_id,
        client_secret,
      );
    } catch (tokenErr) {
      console.error(
        "Shopify token exchange failed:",
        tokenErr.response?.data || tokenErr.message,
      );
      return res.status(400).json({
        success: false,
        message:
          "Could not authenticate with Shopify. Check your shop domain, Client ID, and Client Secret.",
        detail: tokenErr.response?.data || tokenErr.message,
      });
    }

    let shopInfo;
    try {
      const client = shopifyClient(normalizedDomain, tokenData.access_token);
      const response = await client.get("/shop.json");
      shopInfo = response.data?.shop;
      if (!shopInfo) throw new Error("Unexpected response from Shopify");
    } catch (shopifyError) {
      console.error(
        "Shopify verification failed:",
        shopifyError.response?.data || shopifyError.message,
      );
      return res.status(400).json({
        success: false,
        message: "Connected to Shopify but could not read store details.",
        detail: shopifyError.response?.data?.errors || shopifyError.message,
      });
    }

    const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

    const { data, error } = await supabase
      .from("user_shopify_connections")
      .upsert(
        {
          user_id,
          shop_domain: normalizedDomain,
          client_id,
          client_secret,
          access_token: tokenData.access_token,
          token_expires_at: expiresAt,
          scope: tokenData.scope || null,
          store_name: shopInfo.name || normalizedDomain,
          store_currency: shopInfo.currency || "USD",
          is_active: true,
        },
        { onConflict: "shop_domain" },
      )
      .select()
      .single();

    if (error) throw error;

    console.log(`✅ Shopify store connected: ${shopInfo.name}`);

    return res.status(201).json({
      success: true,
      message: "Shopify store connected successfully",
      connection: {
        id: data.id,
        store_name: data.store_name,
        shop_domain: data.shop_domain,
        store_currency: data.store_currency,
        connected_at: data.connected_at,
      },
    });
  } catch (err) {
    console.error("connectStore error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * GET /api/shopify/connections
 * List all connections for the logged-in user
 */
export async function getConnections(req, res) {
  const { user_id } = req.user;

  try {
    const { data, error } = await supabase
      .from("user_shopify_connections")
      .select(
        "id, store_name, shop_domain, store_currency, is_active, connected_at, updated_at",
      )
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return res.json({ success: true, connections: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * DELETE /api/shopify/connections/:id
 * Disconnect a Shopify store
 */
export async function disconnectStore(req, res) {
  const { user_id } = req.user;
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from("user_shopify_connections")
      .delete()
      .eq("id", id)
      .eq("user_id", user_id); // safety: only delete own connections

    if (error) throw error;

    return res.json({ success: true, message: "Store disconnected" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}
