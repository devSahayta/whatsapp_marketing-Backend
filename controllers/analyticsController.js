import { supabase } from "../config/supabase.js";
import { getWhatsappAccount } from "../services/waAccountService.js";

export const getMessageStatsAndChart = async (req, res) => {
  try {
    const { user_id, from, to } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: "user_id is required",
      });
    }

    // Load WhatsApp Account
    const account = await getWhatsappAccount(user_id);
    if (!account)
      return res.status(400).json({ error: "WhatsApp account not found" });

    const account_id = account.wa_id;

    // Fetch filtered messages
    let query = supabase
      .from("whatsapp_messages")
      .select(
        `
    wm_id,
    status,
    sent_at,
    delivered_at,
    read_at,
    created_at
  `,
      )
      .eq("account_id", account_id);

    if (from && to) {
      query = query
        .gte("created_at", `${from} 00:00:00`)
        .lte("created_at", `${to} 23:59:59`);
    }

    const { data: messages, error } = await query;

    if (error) throw error;

    // -------- SECTION 2: STATUS COUNTS --------
    let sent = 0;
    let delivered = 0;
    let read = 0;

    // -------- SECTION 2.1: DAILY CHART --------
    const dailyStats = {};

    messages.forEach((msg) => {
      const date = msg.created_at.split("T")[0];

      if (!dailyStats[date]) {
        dailyStats[date] = {
          date,
          sent: 0,
          delivered: 0,
          read: 0,
        };
      }

      if (msg.sent_at) {
        sent++;
        dailyStats[date].sent++;
      }

      if (msg.delivered_at) {
        delivered++;
        dailyStats[date].delivered++;
      }

      if (msg.read_at) {
        read++;
        dailyStats[date].read++;
      }
    });

    const openRate =
      delivered > 0 ? Number(((read / delivered) * 100).toFixed(2)) : 0;

    return res.json({
      success: true,

      //date range
      date_range: {
        from: from ? from : "All time",
        to: to ? to : "All time",
      },

      // SECTION 2
      overview: {
        sent,
        delivered,
        read,
        open_rate: openRate,
      },

      // SECTION 2.1
      daily_chart: Object.values(dailyStats).sort(
        (a, b) => new Date(a.date) - new Date(b.date),
      ),
    });
  } catch (err) {
    console.error("Analytics Error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch analytics",
    });
  }
};
