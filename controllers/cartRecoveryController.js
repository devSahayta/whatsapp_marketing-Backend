// controllers/cartRecoveryController.js
// Handles cart recovery settings, logs, and stats

import { supabase } from "../config/supabase.js";

// GET /api/woocommerce/cart-recovery/stats
export async function getCartRecoveryStats(req, res) {
  const { user_id } = req.user;

  try {
    const { data, error } = await supabase
      .from("woocommerce_cart_recovery")
      .select("status, recovery_sent_at, recovered_at")
      .eq("user_id", user_id);

    if (error) throw error;

    const total = data.length;
    const sent = data.filter(
      (r) => r.status === "sent" || r.status === "recovered",
    ).length;
    const recovered = data.filter((r) => r.status === "recovered").length;
    const failed = data.filter((r) => r.status === "failed").length;
    const rate = sent > 0 ? Math.round((recovered / sent) * 100) : 0;

    return res.json({
      success: true,
      stats: { total, sent, recovered, failed, recovery_rate: rate },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

// GET /api/woocommerce/cart-recovery/logs
export async function getCartRecoveryLogs(req, res) {
  const { user_id } = req.user;
  const limit = parseInt(req.query.limit) || 20;

  try {
    const { data, error } = await supabase
      .from("woocommerce_cart_recovery")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    return res.json({ success: true, logs: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}
