import { supabase } from "../config/supabase.js";

export const getIntegrationStatus = async (req, res) => {
  try {
    const userId = req.user.user_id;

    const [googleResult, wooResult] = await Promise.all([
      supabase
        .from("user_google_accounts")
        .select("id, email, connected_at, updated_at")
        .eq("user_id", userId)
        .single(),

      supabase
        .from("user_woocommerce_connections")
        .select("id, store_url, store_name, store_currency, is_active, last_synced_at, connected_at")
        .eq("user_id", userId)
        .eq("is_active", true)
        .single(),
    ]);

    res.json({
      google: {
        connected: !!googleResult.data,
        ...(googleResult.data && {
          email: googleResult.data.email,
          connected_at: googleResult.data.connected_at,
          updated_at: googleResult.data.updated_at,
        }),
      },
      woocommerce: {
        connected: !!wooResult.data,
        ...(wooResult.data && {
          store_url: wooResult.data.store_url,
          store_name: wooResult.data.store_name,
          store_currency: wooResult.data.store_currency,
          last_synced_at: wooResult.data.last_synced_at,
          connected_at: wooResult.data.connected_at,
        }),
      },
    });
  } catch (err) {
    console.error("getIntegrationStatus error:", err);
    res.status(500).json({ error: "Failed to fetch integration status" });
  }
};
