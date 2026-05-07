// controllers/notificationController.js
import { supabase } from "../config/supabase.js";

const NOTIFICATION_LIMIT = 30;

// ─── Create a notification (called internally, not via API) ───────────────────
export async function createNotification({
  user_id,
  chat_id,
  phone_number,
  person_name,
  message_preview,
  message_type = "text",
  type = "incoming_message",
}) {
  console.log("🔔 Creating notification:", {
    user_id,
    phone_number,
    message_preview,
  });
  try {
    if (!user_id) return;

    const preview = message_preview ? message_preview.slice(0, 80) : null;

    await supabase.from("notifications").insert({
      user_id,
      chat_id,
      phone_number,
      person_name: person_name || null,
      message_preview: preview,
      message_type,
      type,
      is_read: false,
    });
  } catch (err) {
    console.warn("⚠️ createNotification failed:", err.message);
  }
}

// ─── GET /api/notifications ───────────────────────────────────────────────────
// Returns last 30 notifications for this user + unread count
export async function getNotifications(req, res) {
  try {
    const { user_id } = req.query;
    if (!user_id)
      return res.status(400).json({ ok: false, error: "user_id required" });

    // Fetch recent notifications
    const { data: notifications, error } = await supabase
      .from("notifications")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(NOTIFICATION_LIMIT);

    if (error) throw error;

    // Unread count
    const { count, error: countErr } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user_id)
      .eq("is_read", false);

    if (countErr) throw countErr;

    return res.json({
      ok: true,
      notifications: notifications || [],
      unread_count: count || 0,
    });
  } catch (err) {
    console.error("❌ getNotifications error:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── PATCH /api/notifications/:notification_id/read ──────────────────────────
// Mark a single notification as read
export async function markAsRead(req, res) {
  try {
    const { notification_id } = req.params;
    if (!notification_id)
      return res
        .status(400)
        .json({ ok: false, error: "notification_id required" });

    const { error } = await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("notification_id", notification_id);

    if (error) throw error;

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ markAsRead error:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── PATCH /api/notifications/read-all ───────────────────────────────────────
// Mark all notifications as read for this user
export async function markAllAsRead(req, res) {
  try {
    const { user_id } = req.body;
    if (!user_id)
      return res.status(400).json({ ok: false, error: "user_id required" });

    const { error } = await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("user_id", user_id)
      .eq("is_read", false);

    if (error) throw error;

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ markAllAsRead error:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── DELETE /api/notifications/clear ─────────────────────────────────────────
// Clear all read notifications for this user (housekeeping)
export async function clearReadNotifications(req, res) {
  try {
    const { user_id } = req.body;
    if (!user_id)
      return res.status(400).json({ ok: false, error: "user_id required" });

    const { error } = await supabase
      .from("notifications")
      .delete()
      .eq("user_id", user_id)
      .eq("is_read", true);

    if (error) throw error;

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ clearReadNotifications error:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
