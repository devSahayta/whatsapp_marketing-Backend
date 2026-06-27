// controllers/woocommerceController.js

import axios from "axios";
import FormData from "form-data";
import { supabase } from "../config/supabase.js";

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Make an authenticated call to the WooCommerce REST API
 */
function wcClient(storeUrl, consumerKey, consumerSecret) {
  return axios.create({
    baseURL: `${storeUrl.replace(/\/$/, "")}/wp-json/wc/v3`,
    auth: {
      username: consumerKey,
      password: consumerSecret,
    },
    timeout: 15000,
  });
}

/**
 * Normalize phone numbers to international format
 * WooCommerce stores them in all kinds of formats
 * e.g. "9876543210" → "+919876543210"
 *      "+91 98765 43210" → "+919876543210"
 *      "091-9876543210" → "+919876543210"
 */
function normalizePhone(phone, defaultCountryCode = "91") {
  if (!phone) return null;

  // Strip everything except digits and leading +
  let cleaned = phone.replace(/[\s\-().]/g, "");

  // Already has + prefix
  if (cleaned.startsWith("+")) {
    const digits = cleaned.replace(/\D/g, "");
    return digits.length >= 10 ? digits : null; // ✅ no +
  }

  // Starts with 00 (international prefix)
  if (cleaned.startsWith("00")) {
    cleaned = cleaned.slice(2);
    return cleaned.replace(/\D/g, ""); // ✅ no +
  }

  // Starts with 0 (local trunk prefix, e.g. India 09876543210)
  if (cleaned.startsWith("0")) {
    cleaned = cleaned.slice(1);
  }

  // Add default country code
  return defaultCountryCode + cleaned; // ✅ no +
}

/**
 * Extract template variable values from a WooCommerce order
 * template_variable_map example:
 * { "1": "order_number", "2": "total", "3": "billing_first_name" }
 *
 */

// ─── Get tracking URL from order meta ────────────────────────────────────────

function getTrackingUrl(order, fallbackUrl = null) {
  const meta = order.meta_data || [];

  const trackUrl =
    // Vedas Homes custom keys (track_url + awb)
    meta.find((m) => m.key === "track_url")?.value ||
    // ShipRocket standard plugin key
    meta.find((m) => m.key === "_shipment_track_url")?.value ||
    // Build from AWB if track_url not found
    (meta.find((m) => m.key === "awb")?.value
      ? `https://shiprocket.co/tracking/${meta.find((m) => m.key === "awb")?.value}`
      : null) ||
    // WooCommerce shipment tracking plugin
    (meta.find((m) => m.key === "_wc_shipment_tracking_items")?.value
      ? (() => {
          try {
            const items = JSON.parse(
              meta.find((m) => m.key === "_wc_shipment_tracking_items")?.value,
            );
            return items?.[0]?.custom_tracking_link || null;
          } catch {
            return null;
          }
        })()
      : null) ||
    // Merchant-configured fallback URL
    fallbackUrl ||
    null;

  return trackUrl;
}
// ─── FIXED: buildTemplateVariables — connection is now a parameter ───────────

function buildTemplateVariables(order, variableMap, connection = null) {
  const metaData = order.meta_data || [];

  // ── AWB number ──────────────────────────────────────────────────────────────
  const awbValue =
    metaData.find((m) => m.key === "awb")?.value ||
    metaData.find((m) => m.key === "_shipment_awb_code")?.value ||
    (() => {
      const trackUrl =
        metaData.find((m) => m.key === "track_url")?.value ||
        metaData.find((m) => m.key === "_shipment_track_url")?.value;
      return trackUrl ? trackUrl.split("/").pop() : "";
    })() ||
    "";

  // ── Tracking URL ───────────────────────────────────────────────────────────
  const trackingUrlValue = getTrackingUrl(order) || "";

  // ── Product URL — dynamic per order ─────────────────────────────────────────
  // Priority: line_items[0].permalink → slug built from product name + store URL
  // connection is now passed in, so store_url is always available
  const productUrl = (() => {
    // 1. Some WooCommerce setups include permalink in line items
    if (order.line_items?.[0]?.permalink) {
      return order.line_items[0].permalink;
    }

    // 2. Build from product name slug + store URL
    const productName = order.line_items?.[0]?.name;
    const storeUrl = connection?.store_url || "";

    if (productName && storeUrl) {
      const slug = productName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      return `${storeUrl}/product/${slug}/`;
    }

    return "";
  })();

  // ── Full order fields map — every possible variable ──────────────────────────
  // Add new fields here; they become instantly available in the UI dropdown
  const orderFields = {
    order_number: String(order.number || order.id),
    order_id: String(order.id),
    total: `${order.currency_symbol || "₹"}${order.total}`,
    subtotal: String(order.subtotal || ""),
    status: order.status,
    payment_method: order.payment_method_title || "",
    billing_first_name: order.billing?.first_name || "",
    billing_last_name: order.billing?.last_name || "",
    billing_full_name:
      `${order.billing?.first_name || ""} ${order.billing?.last_name || ""}`.trim(),
    billing_email: order.billing?.email || "",
    billing_phone: order.billing?.phone || "",
    shipping_address:
      [
        order.shipping?.address_1,
        order.shipping?.city,
        order.shipping?.state,
        order.shipping?.postcode,
      ]
        .filter(Boolean)
        .join(", ") || "",
    order_date: new Date(order.date_created).toLocaleDateString("en-IN"),
    item_names: (order.line_items || []).map((i) => i.name).join(", "),
    item_count: String((order.line_items || []).length),
    tracking_url: trackingUrlValue,
    awb_number: awbValue,
    tracking_number: awbValue, // alias
    product_url: productUrl, // ✅ now dynamic per order
    cart_total: `${order.currency_symbol || "₹"}${order.total}`,
  };

  // ── Debug log — prints the resolved value for every mapped variable ──────────
  console.log(
    `\n   📊 Variable resolution for order #${order.number || order.id}:`,
  );
  for (const [position, fieldName] of Object.entries(variableMap)) {
    const resolved = orderFields[fieldName];
    const status = resolved ? "✅" : "⚠️ EMPTY";
    console.log(
      `      {{${position}}} → ${fieldName} = "${resolved || ""}" ${status}`,
    );
  }

  // ── Build the final variables object ─────────────────────────────────────────
  const variables = {};
  for (const [position, fieldName] of Object.entries(variableMap)) {
    variables[position] = orderFields[fieldName] ?? "";
  }

  return variables;
}

// ─── NEW: Fetch product image from WooCommerce ──────────────────────────────

async function fetchProductImage(order, connection) {
  try {
    const productId = order.line_items?.[0]?.product_id;
    if (!productId) {
      console.log("   ⚠️  No product_id in line items");
      return null;
    }

    console.log(`   🖼️  Fetching image for product_id: ${productId}`);

    const client = wcClient(
      connection.store_url,
      connection.consumer_key,
      connection.consumer_secret,
    );

    const response = await client.get(`/products/${productId}`);
    const imageUrl = response.data?.images?.[0]?.src;

    if (!imageUrl) {
      console.log("   ⚠️  No image found for this product");
      return null;
    }

    console.log(`   ✅ Image URL found: ${imageUrl}`);
    return imageUrl;
  } catch (err) {
    console.warn("   ⚠️  fetchProductImage failed:", err.message);
    return null;
  }
}

// ─── NEW: Download image and upload to Meta ─────────────────────────────────

async function uploadImageToMeta(imageUrl, account) {
  try {
    console.log(`   📤 Using image URL directly (no upload needed)`);
    // Return the URL itself — we'll use it as a link parameter
    return { type: "url", url: imageUrl };
  } catch (err) {
    console.warn("   ⚠️  uploadImageToMeta failed:", err.message);
    return null;
  }
}

//account id for whatsapp account linked to the user

export async function getAccountId(req, res) {
  const { user_id } = req.user;
  try {
    const { data, error } = await supabase
      .from("whatsapp_accounts")
      .select("wa_id")
      .eq("user_id", user_id)
      .single();
    if (error || !data) {
      return res
        .status(404)
        .json({ success: false, message: "No WhatsApp account found" });
    }
    return res.json({ success: true, wa_id: data.wa_id });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ─── Controllers ────────────────────────────────────────────────

/**
 * POST /api/woocommerce/connect
 * Save a new WooCommerce store connection
 */
export async function connectStore(req, res) {
  const { user_id } = req.user;
  const { store_url, consumer_key, consumer_secret } = req.body;

  if (!store_url || !consumer_key || !consumer_secret) {
    return res.status(400).json({
      success: false,
      message: "store_url, consumer_key, and consumer_secret are required",
    });
  }

  try {
    // 1. Verify the credentials actually work by calling WC API
    console.log(`🔌 Verifying WooCommerce connection: ${store_url}`);
    const client = wcClient(store_url, consumer_key, consumer_secret);

    let storeInfo;
    try {
      // Verify credentials + get store name from WP site info (no auth needed)
      const [wcResponse, wpResponse] = await Promise.allSettled([
        client.get("/system_status"), // lighter call than orders
        axios.get(`${store_url.replace(/\/$/, "")}/wp-json`, {
          timeout: 10000,
        }),
      ]);

      // Log what we got for debugging
      console.log("WC Response status:", wcResponse.status);
      console.log(
        "WC Response data:",
        wcResponse.value?.data || wcResponse.reason?.message,
      );

      if (wcResponse.status === "rejected") {
        throw wcResponse.reason;
      }

      storeInfo = {
        name:
          wpResponse.status === "fulfilled"
            ? wpResponse.value.data?.name || store_url
            : store_url,
        currency: wcResponse.value?.data?.environment?.currency || "INR",
      };
    } catch (wcError) {
      console.error(
        "WC verification failed:",
        wcError.response?.data || wcError.message,
      );
      console.error("Status:", wcError.response?.status);
      console.error(
        "URL tried:",
        `${store_url.replace(/\/$/, "")}/wp-json/wc/v3/orders?per_page=1`,
      );
      return res.status(400).json({
        success: false,
        message:
          "Could not connect to WooCommerce store. Check your URL and API keys.",
        detail: wcError.response?.data?.message || wcError.message,
      });
    }

    // 2. Save to Supabase
    const { data, error } = await supabase
      .from("user_woocommerce_connections")
      .insert({
        user_id,
        store_url: store_url.replace(/\/$/, ""), // strip trailing slash
        consumer_key,
        consumer_secret,
        store_name: storeInfo.name || store_url,
        store_currency: storeInfo.currency || "INR",
        is_active: true,
      })
      .select()
      .single();

    if (error) throw error;

    // 3. Register webhooks on the WooCommerce store
    await registerWebhooks(store_url, consumer_key, consumer_secret, data.id);

    console.log(`✅ WooCommerce store connected: ${storeInfo.name}`);

    return res.status(201).json({
      success: true,
      message: "WooCommerce store connected successfully",
      connection: {
        id: data.id,
        store_name: data.store_name,
        store_url: data.store_url,
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
 * Register WooCommerce webhooks pointing to your Samvaadik backend
 * Called automatically on store connect
 */
async function registerWebhooks(
  storeUrl,
  consumerKey,
  consumerSecret,
  connectionId,
) {
  const client = wcClient(storeUrl, consumerKey, consumerSecret);

  // Your Render backend URL — read from env
  const baseWebhookUrl =
    process.env.BACKEND_URL || "https://your-backend.onrender.com";
  const webhookDeliveryUrl = `${baseWebhookUrl}/webhooks/woocommerce/${connectionId}`;

  // The 4 order events we care about for Phase 1
  const events = [
    { name: "Samvaadik - Order Created", topic: "order.created" },
    { name: "Samvaadik - Order Updated", topic: "order.updated" },
    { name: "Samvaadik - Order Deleted", topic: "order.deleted" },
  ];

  console.log(`📡 Registering ${events.length} webhooks on ${storeUrl}...`);

  for (const event of events) {
    try {
      await client.post("/webhooks", {
        name: event.name,
        topic: event.topic,
        delivery_url: webhookDeliveryUrl,
        secret: process.env.WC_WEBHOOK_SECRET || "samvaadik-secret",
        status: "active",
      });
      console.log(`   ✅ Registered: ${event.topic}`);
    } catch (err) {
      // Don't fail the whole connection if webhook registration fails
      // User can re-register manually later
      console.warn(
        `   ⚠️  Failed to register ${event.topic}:`,
        err.response?.data?.message || err.message,
      );
    }
  }
}

/**
 * GET /api/woocommerce/connections
 * List all connections for the logged-in user
 */
export async function getConnections(req, res) {
  const { user_id } = req.user;

  try {
    const { data, error } = await supabase
      .from("user_woocommerce_connections")
      .select(
        "id, store_name, store_url, store_currency, is_active, connected_at, last_synced_at",
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
 * DELETE /api/woocommerce/connections/:id
 * Disconnect a WooCommerce store
 */
export async function disconnectStore(req, res) {
  const { user_id } = req.user;
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from("user_woocommerce_connections")
      .delete()
      .eq("id", id)
      .eq("user_id", user_id); // safety: only delete own connections

    if (error) throw error;

    return res.json({ success: true, message: "Store disconnected" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * POST /api/woocommerce/automations
 * Create a new automation rule
 */
export async function createAutomation(req, res) {
  const { user_id } = req.user;
  const {
    connection_id,
    wt_id,
    account_id,
    trigger_event,
    delay_minutes = 0,
    delay_stages = null, // ✅ new
    template_variable_map = {},
    include_product_image = false, // ✅ added
    shipping_fallback_url = null,
  } = req.body;

  console.log("📥 createAutomation body:", JSON.stringify(req.body, null, 2));

  // ✅ If account_id not provided, fetch from whatsapp_accounts
  let resolvedAccountId = account_id;
  if (!resolvedAccountId) {
    const { data: account } = await supabase
      .from("whatsapp_accounts")
      .select("wa_id")
      .eq("user_id", user_id)
      .single();

    if (!account) {
      return res.status(400).json({
        success: false,
        message:
          "No WhatsApp account found. Please set up your WhatsApp account first.",
      });
    }
    resolvedAccountId = account.wa_id;
  }

  // Valid trigger events
  const validEvents = [
    "order.created",
    "order.processing",
    "order.completed",
    "order.cancelled",
    "order.refunded",
    "order.on-hold",
    "order.shipped",
    "cart.abandoned",
    "order.delayed",
  ];

  if (!validEvents.includes(trigger_event)) {
    return res.status(400).json({
      success: false,
      message: `Invalid trigger_event. Must be one of: ${validEvents.join(", ")}`,
    });
  }

  if (!connection_id || !wt_id) {
    return res.status(400).json({
      success: false,
      message: "connection_id and wt_id are required",
    });
  }

  try {
    const { data, error } = await supabase
      .from("woocommerce_automations")
      .insert({
        user_id,
        connection_id,
        wt_id,
        account_id: resolvedAccountId,
        trigger_event,
        delay_minutes,
        delay_stages:
          trigger_event === "order.delayed" ? delay_stages || [2, 4, 6] : null, // ✅
        template_variable_map,
        is_active: true,
        include_product_image, // ✅ now uses destructured value
        shipping_fallback_url,
      })
      .select()
      .single();

    if (error) throw error;

    return res.status(201).json({
      success: true,
      message: "Automation created",
      automation: data,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * GET /api/woocommerce/automations
 * List automations for the logged-in user
 */
export async function getAutomations(req, res) {
  const { user_id } = req.user;
  const { connection_id } = req.query; // ✅ optional filter

  try {
    let query = supabase
      .from("woocommerce_automations")
      .select(
        `*, user_woocommerce_connections(store_name, store_url), whatsapp_templates(name, language)`,
      )
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (connection_id) {
      query = query.eq("connection_id", connection_id); // ✅ filter by store
    }

    const { data, error } = await query;
    if (error) throw error;
    return res.json({ success: true, automations: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * PATCH /api/woocommerce/automations/:id
 * Toggle on/off or update an automation
 */
export async function updateAutomation(req, res) {
  const { user_id } = req.user;
  const { id } = req.params;

  // ✅ Guard: check body exists
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.status(400).json({
      success: false,
      message: "Request body is empty. Send at least one field to update.",
    });
  }

  const updates = req.body;

  // Only allow safe fields to be updated
  const allowed = [
    "is_active",
    "wt_id",
    "delay_minutes",
    "delay_stages",
    "template_variable_map",
    "trigger_event",
    "include_product_image",
    "shipping_fallback_url",
  ];
  const safeUpdates = {};

  for (const key of allowed) {
    if (key in updates) safeUpdates[key] = updates[key];
  }

  if (Object.keys(safeUpdates).length === 0) {
    return res.status(400).json({
      success: false,
      message: `No valid fields to update. Allowed fields: ${allowed.join(", ")}`,
    });
  }

  try {
    const { data, error } = await supabase
      .from("woocommerce_automations")
      .update({ ...safeUpdates, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", user_id)
      .select()
      .single();

    if (error) throw error;

    if (!data) {
      return res.status(404).json({
        success: false,
        message:
          "Automation not found or you do not have permission to update it.",
      });
    }

    return res.json({ success: true, automation: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * DELETE /api/woocommerce/automations/:id
 */
export async function deleteAutomation(req, res) {
  const { user_id } = req.user;
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from("woocommerce_automations")
      .delete()
      .eq("id", id)
      .eq("user_id", user_id);

    if (error) throw error;

    return res.json({ success: true, message: "Automation deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * GET /api/woocommerce/logs
 * Get automation send history
 */
export async function getLogs(req, res) {
  const { user_id } = req.user;
  const { connection_id, limit = 50, offset = 0 } = req.query;

  try {
    let query = supabase
      .from("woocommerce_automation_logs")
      .select("*")
      .eq("user_id", user_id)
      .order("triggered_at", { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (connection_id) {
      query = query.eq("connection_id", connection_id);
    }

    const { data, error } = await query;
    if (error) throw error;
    return res.json({ success: true, logs: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ─── WEBHOOK HANDLER ────────────────────────────────────────────

/**
 * POST /webhooks/woocommerce/:connection_id
 * Receives all WooCommerce order events
 * NO auth middleware on this route — WooCommerce calls this directly
 */
export async function handleWebhook(req, res) {
  const { connection_id } = req.params;

  // Always respond 200 immediately — WooCommerce will retry if it doesn't get 200 fast
  res.status(200).json({ received: true });

  try {
    const topic = req.headers["x-wc-webhook-topic"]; // e.g. "order.created"
    const payload = req.body; // the full WooCommerce order object

    // TEMPORARY
    if (payload?.meta_data?.length > 0) {
      console.log("📦 meta_data:", JSON.stringify(payload.meta_data, null, 2));
    }

    console.log(`\n📦 WooCommerce Webhook Received`);
    console.log(`   Connection: ${connection_id}`);
    console.log(`   Topic: ${topic}`);
    console.log(`   Order ID: ${payload?.id}`);

    if (!topic || !payload?.id) {
      console.warn("   ⚠️  Missing topic or payload, skipping");
      return;
    }

    // With this — retries 3 times with 1s gap:
    let connection = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { data, error } = await supabase
        .from("user_woocommerce_connections")
        .select("*")
        .eq("id", connection_id)
        .eq("is_active", true)
        .single();

      if (data) {
        connection = data;
        break;
      }

      console.warn(
        `   ⚠️  Connection lookup attempt ${attempt} failed, retrying...`,
      );
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!connection) {
      console.warn(
        `   ⚠️  Connection not found after 3 attempts: ${connection_id}`,
      );
      return;
    }

    // 2. Map WooCommerce topic to our trigger event format
    // WC sends "order.created", "order.updated" etc.
    // For "order.updated" we check the order status to fire the right automation
    let triggerEvent = topic;

    if (topic === "order.updated") {
      const statusMap = {
        processing: "order.processing",
        completed: "order.completed",
        "wc-completed": "order.completed",
        cancelled: "order.cancelled",
        refunded: "order.refunded",
        "on-hold": "order.on-hold",
        shipped: "order.shipped", // ✅ ShipRocket / custom plugins
        "in-transit": "order.shipped", // ✅ some plugins use this
        dispatched: "order.shipped", // ✅ some Indian plugins use this
      };
      triggerEvent = statusMap[payload.status] || `order.${payload.status}`;
    }

    console.log(`   Mapped trigger: ${triggerEvent}`);

    // Add inside handleWebhook, after triggerEvent is resolved
    console.log(`\n   🔍 Webhook debug:`);
    console.log(`      Raw topic:     ${topic}`);
    console.log(`      Order status:  ${payload.status}`);
    console.log(`      Trigger event: ${triggerEvent}`);
    console.log(`      Order ID:      ${payload?.id}`);
    console.log(`      Phone:         ${payload?.billing?.phone}`);

    // ✅ If order was created, check if it was an abandoned cart and mark recovered
    if (
      triggerEvent === "order.created" ||
      triggerEvent === "order.processing"
    ) {
      const { error: recErr } = await supabase
        .from("woocommerce_cart_recovery")
        .update({
          status: "recovered",
          recovered_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("connection_id", connection_id)
        .eq("wc_order_id", String(payload.id))
        .eq("status", "sent");

      if (!recErr) {
        console.log(`   🎉 Cart recovery detected for order ${payload.id}`);
      }
    }

    // 3. Find active automations matching this connection + trigger
    const { data: automations, error: autoError } = await supabase
      .from("woocommerce_automations")
      .select(
        `
        *,
        whatsapp_templates (*),
        whatsapp_accounts (*)
      `,
      )
      .eq("connection_id", connection_id)
      .eq("trigger_event", triggerEvent)
      .eq("is_active", true);

    if (autoError) {
      console.error("   ❌ Error fetching automations:", autoError);
      return;
    }

    if (!automations || automations.length === 0) {
      console.log(`   ℹ️  No active automations for: ${triggerEvent}`);
      return;
    }

    console.log(`   ✅ Found ${automations.length} automation(s) to run`);

    // 4. Get phone number from the order
    const rawPhone = payload.billing?.phone;
    const phone = normalizePhone(rawPhone);

    if (!phone) {
      console.warn(`   ⚠️  No valid phone number in order ${payload.id}`);
      // Log as skipped
      for (const automation of automations) {
        await supabase.from("woocommerce_automation_logs").insert({
          automation_id: automation.id,
          user_id: connection.user_id,
          connection_id,
          trigger_event: triggerEvent,
          wc_order_id: String(payload.id),
          phone_number: rawPhone || "unknown",
          status: "skipped",
          error_message: "No valid phone number found in order",
        });
      }
      return;
    }

    console.log(`   📱 Phone: ${phone}`);

    // 5. Run each matching automation
    for (const automation of automations) {
      await runAutomation(automation, payload, phone, connection);
    }
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
  }
}

/**
 * Execute one automation — send the WhatsApp message
 */
async function runAutomation(automation, order, phone, connection) {
  const logEntry = {
    automation_id: automation.id,
    user_id: connection.user_id,
    connection_id: connection.id,
    trigger_event: automation.trigger_event,
    wc_order_id: String(order.id),
    wc_customer_id: String(order.customer_id || ""),
    phone_number: phone,
    status: "pending",
  };

  try {
    const template = automation.whatsapp_templates;
    const account = automation.whatsapp_accounts;

    if (!template || !account) {
      throw new Error("Template or WhatsApp account not found in automation");
    }

    const templateVariables = buildTemplateVariables(
      order,
      automation.template_variable_map || {},
      connection, // ✅ pass connection
    );

    console.log(`   🤖 Running automation: ${automation.trigger_event}`);
    console.log(`   📋 Template: ${template.name}`);
    console.log(`   📊 Variables:`, templateVariables);

    // ✅ Fetch and upload product image if enabled on this automation
    let mediaId = null;
    if (automation.include_product_image) {
      console.log(`   🖼️  Product image enabled for this automation`);

      // Try payload first, then fallback to WooCommerce API
      let imageUrl = order.line_items?.[0]?.image?.src || null;
      console.log(`   🖼️  Image from payload: ${imageUrl || "none"}`);

      // Fallback — fetch from WooCommerce API with 10s timeout
      if (!imageUrl) {
        try {
          console.log(`   🔄 Fetching image from WooCommerce API...`);
          imageUrl = await Promise.race([
            fetchProductImage(order, connection),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("image fetch timeout")), 10000),
            ),
          ]);
          console.log(`   ✅ Image from API: ${imageUrl}`);
        } catch (e) {
          console.warn(`   ⚠️  Image fetch failed: ${e.message}`);
          imageUrl = null;
        }
      }

      // Upload to Meta
      if (imageUrl) {
        mediaId = await uploadImageToMeta(imageUrl, account);
      }

      // Still no image — use placeholder so message always goes through
      if (!mediaId) {
        try {
          console.log(`   🔄 Using placeholder image as final fallback...`);
          const account = automation.whatsapp_accounts;
          const placeholderUrl =
            "https://ygynmoezdffuencztefl.supabase.co/storage/v1/object/public/default_templateImage/randomImg.jpg";
          mediaId = await uploadImageToMeta(placeholderUrl, account);
          console.log(`   ✅ Placeholder image uploaded, media_id: ${mediaId}`);
        } catch (e) {
          console.warn(`   ⚠️  Placeholder upload also failed: ${e.message}`);
        }
      }

      // Absolute last resort — skip and log
      if (!mediaId) {
        console.warn(`   ❌ All image attempts failed — skipping`);
        await supabase.from("woocommerce_automation_logs").insert({
          ...logEntry,
          status: "skipped",
          error_message: "All image upload attempts failed",
        });
        return;
      }
    }

    // ✅ Get tracking URL from order meta
    const trackingUrl = getTrackingUrl(
      order,
      automation.shipping_fallback_url || null,
    );
    if (trackingUrl) {
      console.log(`   🔗 Tracking URL found: ${trackingUrl}`);
    }

    // Build payload — passes mediaId and trackingUrl
    const messageBody = buildWhatsAppPayload(
      template,
      phone,
      templateVariables,
      mediaId,
      trackingUrl,
    );

    console.log(`   📤 Sending WhatsApp message...`);
    if (mediaId) {
      console.log(`   🖼️  With product image (media_id: ${mediaId})`);
    }

    const waResponse = await axios.post(
      `https://graph.facebook.com/v21.0/${account.phone_number_id}/messages`,
      messageBody,
      {
        headers: {
          Authorization: `Bearer ${account.system_user_access_token}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      },
    );

    const wa_message_id = waResponse.data.messages?.[0]?.id;

    const { data: wmRecord } = await supabase
      .from("whatsapp_messages")
      .insert({
        account_id: account.wa_id,
        to_number: phone,
        template_name: template.name,
        message_body: messageBody,
        wa_message_id,
        status: "sent",
        sent_at: new Date().toISOString(),
      })
      .select()
      .single();

    await supabase.from("woocommerce_automation_logs").insert({
      ...logEntry,
      wm_id: wmRecord?.wm_id,
      status: "sent",
      sent_at: new Date().toISOString(),
    });

    console.log(`   ✅ Message sent! WA ID: ${wa_message_id}`);
  } catch (err) {
    console.error(
      `   ❌ Automation failed:`,
      err.response?.data || err.message,
    );
    await supabase.from("woocommerce_automation_logs").insert({
      ...logEntry,
      status: "failed",
      error_message: err.response?.data?.error?.message || err.message,
    });
  }
}

/**
 * Build the WhatsApp template message payload
 * Same structure as your campaign scheduler
 */
function buildWhatsAppPayload(
  template,
  phoneNumber,
  variables,
  mediaId = null,
  trackingUrl = null,
) {
  let templateComponents = template.components;
  if (typeof templateComponents === "string") {
    try {
      templateComponents = JSON.parse(templateComponents);
    } catch {
      templateComponents = [];
    }
  }

  // Check if template has a URL button component
  const hasUrlButton = templateComponents.some(
    (c) => c.type === "BUTTONS" && c.buttons?.some((b) => b.type === "URL"),
  );

  const messageBody = {
    messaging_product: "whatsapp",
    to: phoneNumber,
    type: "template",
    template: {
      name: template.name,
      language: { code: template.language },
      components: [],
    },
  };

  // Image header
  if (mediaId) {
    const imageParam =
      mediaId?.type === "url"
        ? { type: "image", image: { link: mediaId.url } } // ✅ URL link
        : { type: "image", image: { id: mediaId } }; // ✅ uploaded media ID

    messageBody.template.components.push({
      type: "header",
      parameters: [imageParam],
    });
  }

  // Body variables — filter out empty values to avoid Meta 131008 error
  if (variables && Object.keys(variables).length > 0) {
    const params = Object.values(variables).map((value) => ({
      type: "text",
      text: String(value) || " ", // ✅ never send empty string — use space as fallback
    }));

    messageBody.template.components.push({
      type: "body",
      parameters: params,
    });
  }

  // ✅ Extract just the AWB from the full tracking URL
  // e.g. "https://shiprocket.co/tracking/1904072514104" → "1904072514104"
  if (hasUrlButton && trackingUrl) {
    // Try to extract just the last path segment (AWB number)
    const urlParts = trackingUrl.split("/");
    const awbOrSuffix = urlParts[urlParts.length - 1] || trackingUrl;

    messageBody.template.components.push({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [
        {
          type: "text",
          text: awbOrSuffix, // ✅ just the dynamic suffix, e.g. "1904072514104"
        },
      ],
    });
    console.log(`   🔗 Tracking button added with AWB: ${awbOrSuffix}`);
  }

  return messageBody;
}

// ─── Handle cache — refreshes every 6 hours ─────────────────────────────────
let cachedHandle = null;
let cacheExpiry = null;

async function getPlaceholderHeaderHandle(account) {
  try {
    // Return cached handle if still valid
    if (cachedHandle && cacheExpiry && Date.now() < cacheExpiry) {
      console.log("✅ Using cached placeholder handle");
      return cachedHandle;
    }

    const PLACEHOLDER_URL =
      "https://ygynmoezdffuencztefl.supabase.co/storage/v1/object/public/default_templateImage/randomImg.jpg";

    console.log("📷 Downloading placeholder image...");
    const imageResponse = await axios.get(PLACEHOLDER_URL, {
      responseType: "arraybuffer",
      timeout: 30000,
    });

    const imageBuffer = Buffer.from(imageResponse.data);
    const contentType = "image/jpeg";
    console.log(`📷 Downloaded: ${imageBuffer.length} bytes`);

    // Step 1 — Create upload session
    const sessionResponse = await axios.post(
      `https://graph.facebook.com/v21.0/${account.app_id}/uploads`,
      null,
      {
        params: {
          file_name: "placeholder.jpg",
          file_length: imageBuffer.length,
          file_type: contentType,
          access_token: account.system_user_access_token,
        },
        timeout: 15000,
      },
    );

    const sessionId = sessionResponse.data?.id;
    if (!sessionId) throw new Error("No upload session ID returned");
    console.log(`📷 Upload session: ${sessionId}`);

    // Step 2 — Upload binary
    const uploadResponse = await axios.post(
      `https://graph.facebook.com/v21.0/${sessionId}`,
      imageBuffer,
      {
        headers: {
          Authorization: `OAuth ${account.system_user_access_token}`,
          "Content-Type": contentType,
          "Content-Length": imageBuffer.length,
          file_offset: "0",
        },
        timeout: 30000,
      },
    );

    const headerHandle = uploadResponse.data?.h;
    if (!headerHandle) throw new Error("No header handle returned");

    // Cache for 6 hours
    cachedHandle = headerHandle;
    cacheExpiry = Date.now() + 6 * 60 * 60 * 1000;

    console.log(`✅ Fresh placeholder handle obtained and cached`);
    return headerHandle;
  } catch (err) {
    console.error(
      "❌ getPlaceholderHeaderHandle failed:",
      err.response?.data || err.message,
    );
    throw err;
  }
}
// ─── NEW ENDPOINT ────────────────────────────────────────────────────────────

/**
 * POST /api/woocommerce/placeholder-handle
 * Gets a Meta header_handle using a placeholder image
 * Used by Template Guide when creating IMAGE header templates
 */
export async function getPlaceholderHandle(req, res) {
  const { user_id } = req.user;

  try {
    // Get WhatsApp account
    const { data: account, error: acctErr } = await supabase
      .from("whatsapp_accounts")
      .select("*")
      .eq("user_id", user_id)
      .single();

    if (acctErr || !account) {
      return res.status(400).json({
        success: false,
        message: "No WhatsApp account found",
      });
    }

    const headerHandle = await getPlaceholderHeaderHandle(account);

    return res.json({
      success: true,
      header_handle: headerHandle,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
}
