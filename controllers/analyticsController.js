// controllers/analyticsController.js

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

    /* =====================================================
       ✅ FETCH ALL MESSAGES (AUTO PAGINATION FIX)
    ====================================================== */

    const PAGE_SIZE = 1000;
    let allMessages = [];
    let fromIndex = 0;
    let toIndex = PAGE_SIZE - 1;

    while (true) {
      let query = supabase
        .from("whatsapp_messages")
        .select(`
          wm_id,
          status,
          sent_at,
          delivered_at,
          read_at,
          created_at
        `)
        .eq("account_id", account_id)
        .range(fromIndex, toIndex);

      if (from && to) {
        query = query
          .gte("created_at", `${from} 00:00:00`)
          .lte("created_at", `${to} 23:59:59`);
      }

      const { data, error } = await query;

      if (error) throw error;

      if (!data || data.length === 0) break;

      allMessages = [...allMessages, ...data];

      // stop when last page reached
      if (data.length < PAGE_SIZE) break;

      fromIndex += PAGE_SIZE;
      toIndex += PAGE_SIZE;
    }

    const messages = allMessages;

    /* =====================================================
       SECTION 2: STATUS COUNTS
    ====================================================== */

    let sent = 0;
    let delivered = 0;
    let read = 0;

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
      date_range: {
        from: from || "All time",
        to: to || "All time",
      },
      overview: {
        sent,
        delivered,
        read,
        open_rate: openRate,
      },
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

/* =====================================
   HELPER: Parse Date Range
====================================== */

const getDateRange = (from_date, to_date) => {
  let startDate, endDate;

  if (from_date) {
    startDate = new Date(from_date);
    startDate.setHours(0, 0, 0, 0);
  }

  if (to_date) {
    endDate = new Date(to_date);
    endDate.setHours(23, 59, 59, 999);
  }

  return {
    startDate: startDate ? startDate.toISOString() : null,
    endDate: endDate ? endDate.toISOString() : null,
  };
};

/* =====================================
   1️⃣ OVERVIEW STATS (4 Cards)
   - Total Groups
   - Total Contacts
   - Total Messages
   - Active Chats
====================================== */

export const getOverviewStats = async (req, res) => {
  try {
    const { user_id, from_date, to_date } = req.query;

    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }

    const { startDate, endDate } = getDateRange(from_date, to_date);

    /* ======================================================
       1️⃣ TOTAL GROUPS (COUNT FIX)
    ====================================================== */

    let groupsQuery = supabase
      .from("groups")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user_id);

    if (startDate) groupsQuery = groupsQuery.gte("created_at", startDate);
    if (endDate) groupsQuery = groupsQuery.lte("created_at", endDate);

    const { count: totalGroups, error: groupsError } =
      await groupsQuery;

    if (groupsError) throw groupsError;

    /* ======================================================
       2️⃣ TOTAL CONTACTS (✅ FIXED 1000 ISSUE)
    ====================================================== */

    let contactsQuery = supabase
      .from("group_contacts")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user_id);

    if (startDate) contactsQuery = contactsQuery.gte("uploaded_at", startDate);
    if (endDate) contactsQuery = contactsQuery.lte("uploaded_at", endDate);

    const { count: totalContacts, error: contactsError } =
      await contactsQuery;

    if (contactsError) throw contactsError;

    /* ======================================================
       3️⃣ GET USER ACCOUNTS
    ====================================================== */

    const { data: accounts } = await supabase
      .from("whatsapp_accounts")
      .select("wa_id")
      .eq("user_id", user_id);

    const accountIds = accounts?.map((a) => a.wa_id) || [];

    /* ======================================================
       4️⃣ TOTAL MESSAGES (✅ FIXED 1000 ISSUE)
    ====================================================== */

    let totalMessages = 0;

    if (accountIds.length > 0) {
      let messagesQuery = supabase
        .from("whatsapp_messages")
        .select("*", { count: "exact", head: true })
        .in("account_id", accountIds);

      if (startDate) messagesQuery = messagesQuery.gte("created_at", startDate);
      if (endDate) messagesQuery = messagesQuery.lte("created_at", endDate);

      const { count } = await messagesQuery;
      totalMessages = count || 0;
    }

    /* ======================================================
       5️⃣ ACTIVE CHATS
    ====================================================== */

    let chatsQuery = supabase
      .from("chats")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user_id);

    if (startDate) chatsQuery = chatsQuery.gte("created_at", startDate);
    if (endDate) chatsQuery = chatsQuery.lte("created_at", endDate);

    const { count: activeChats } = await chatsQuery;

    /* ======================================================
       6️⃣ TRENDS
    ====================================================== */

    // Start of month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { count: groupsTrend } = await supabase
      .from("groups")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user_id)
      .gte("created_at", startOfMonth.toISOString());

    // Contacts today (✅ FIXED)
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const { count: contactsTrend } = await supabase
      .from("group_contacts")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user_id)
      .gte("uploaded_at", startOfDay.toISOString());

    // Messages today (✅ FIXED)
    let messagesTodayCount = 0;

    if (accountIds.length > 0) {
      const { count } = await supabase
        .from("whatsapp_messages")
        .select("*", { count: "exact", head: true })
        .in("account_id", accountIds)
        .gte("created_at", startOfDay.toISOString());

      messagesTodayCount = count || 0;
    }

    /* ======================================================
       7️⃣ CHAT ACTIVE %
    ====================================================== */

    let chatActivePercentage = 0;

    if (totalGroups > 0) {
      const { data: groupsWithChats } = await supabase
        .from("chats")
        .select("group_id");

      const uniqueGroups = new Set(
        groupsWithChats?.map((c) => c.group_id) || [],
      );

      chatActivePercentage = Math.round(
        (uniqueGroups.size / totalGroups) * 100,
      );
    }

    /* ======================================================
       RESPONSE
    ====================================================== */

    return res.status(200).json({
      date_range: {
        from: from_date || "All time",
        to: to_date || "All time",
      },
      overview: {
        total_groups: totalGroups || 0,
        total_contacts: totalContacts || 0,
        total_messages: totalMessages,
        active_chats: activeChats || 0,
        trends: {
          groups_this_month: groupsTrend || 0,
          contacts_today: contactsTrend || 0,
          messages_today: messagesTodayCount,
          chat_active_percentage: chatActivePercentage,
        },
      },
    });
  } catch (err) {
    console.error("getOverviewStats error:", err);
    return res.status(500).json({ error: "Failed to fetch overview stats" });
  }
};

/* =====================================
   2️⃣ GROUPS PERFORMANCE TABLE
   - Group name, contacts, messages, response rate
====================================== */

export const getGroupsPerformance = async (req, res) => {
  try {
    const { user_id, from_date, to_date } = req.query;

    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }

    const { startDate, endDate } = getDateRange(from_date, to_date);

    /* =====================================================
       1️⃣ GET GROUPS
    ===================================================== */

    const { data: groups, error: groupsError } = await supabase
      .from("groups")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (groupsError) throw groupsError;

    /* =====================================================
       2️⃣ PROCESS EACH GROUP (COUNT FIXED)
    ===================================================== */

    const groupsPerformance = await Promise.all(
      groups.map(async (group) => {
        /* ---------------- CONTACT COUNT ---------------- */

        let contactsQuery = supabase
          .from("group_contacts")
          .select("*", { count: "exact", head: true })
          .eq("group_id", group.group_id);

        if (startDate)
          contactsQuery = contactsQuery.gte("uploaded_at", startDate);
        if (endDate)
          contactsQuery = contactsQuery.lte("uploaded_at", endDate);

        const { count: contactCount } = await contactsQuery;

        /* ---------------- GET CHAT IDS ---------------- */

        let chatsQuery = supabase
          .from("chats")
          .select("chat_id")
          .eq("group_id", group.group_id);

        if (startDate)
          chatsQuery = chatsQuery.gte("created_at", startDate);
        if (endDate)
          chatsQuery = chatsQuery.lte("created_at", endDate);

        const { data: chats } = await chatsQuery;

        const chatIds = chats?.map((c) => c.chat_id) || [];

        let messageCount = 0;
        let adminMessageCount = 0;
        let userMessageCount = 0;

        /* ---------------- MESSAGE COUNTS (FIXED) ---------------- */

        if (chatIds.length > 0) {
          // TOTAL MESSAGES
          let totalMsgQuery = supabase
            .from("messages")
            .select("*", { count: "exact", head: true })
            .in("chat_id", chatIds);

          if (startDate)
            totalMsgQuery = totalMsgQuery.gte("created_at", startDate);
          if (endDate)
            totalMsgQuery = totalMsgQuery.lte("created_at", endDate);

          const { count } = await totalMsgQuery;
          messageCount = count || 0;

          // ADMIN MESSAGES
          const { count: adminCount } = await supabase
            .from("messages")
            .select("*", { count: "exact", head: true })
            .in("chat_id", chatIds)
            .eq("sender_type", "admin");

          adminMessageCount = adminCount || 0;

          // USER MESSAGES
          const { count: userCount } = await supabase
            .from("messages")
            .select("*", { count: "exact", head: true })
            .in("chat_id", chatIds)
            .eq("sender_type", "user");

          userMessageCount = userCount || 0;
        }

        /* ---------------- RESPONSE RATE ---------------- */

        const responseRate =
          adminMessageCount > 0
            ? Math.round((userMessageCount / adminMessageCount) * 100)
            : 0;

        return {
          group_id: group.group_id,
          group_name: group.group_name,
          description: group.description,
          contact_count: contactCount || 0,
          message_count: messageCount,
          admin_messages: adminMessageCount,
          user_messages: userMessageCount,
          response_rate: responseRate,
          status: group.status,
          created_at: group.created_at,
        };
      }),
    );

    /* =====================================================
       RESPONSE
    ===================================================== */

    return res.status(200).json({
      date_range: {
        from: from_date || "All time",
        to: to_date || "All time",
      },
      total: groupsPerformance.length,
      groups: groupsPerformance,
    });
  } catch (err) {
    console.error("getGroupsPerformance error:", err);
    return res
      .status(500)
      .json({ error: "Failed to fetch groups performance" });
  }
};

/* =====================================
   3️⃣ COMBINED ANALYTICS (Both Sections)
====================================== */

export const getDashboardAnalytics = async (req, res) => {
  try {
    const { user_id, from_date, to_date } = req.query;

    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }

    const { startDate, endDate } = getDateRange(from_date, to_date);

    const overviewData = await fetchOverviewData(
      user_id,
      from_date,
      to_date,
      startDate,
      endDate,
    );

    const groupsData = await fetchGroupsData(
      user_id,
      from_date,
      to_date,
      startDate,
      endDate,
    );

    return res.status(200).json({
      date_range: {
        from: from_date || "All time",
        to: to_date || "All time",
      },
      overview: overviewData,
      groups_performance: groupsData,
    });
  } catch (err) {
    console.error("getDashboardAnalytics error:", err);
    return res
      .status(500)
      .json({ error: "Failed to fetch dashboard analytics" });
  }
};

// Helper function to fetch overview data
async function fetchOverviewData(
  user_id,
  from_date,
  to_date,
  startDate,
  endDate,
) {
  // ✅ Total Groups
  let groupsQuery = supabase
    .from("groups")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user_id);

  if (startDate) groupsQuery = groupsQuery.gte("created_at", startDate);
  if (endDate) groupsQuery = groupsQuery.lte("created_at", endDate);

  const { count: totalGroups } = await groupsQuery;

  // ✅ Total Contacts
  let contactsQuery = supabase
    .from("group_contacts")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user_id);

  if (startDate) contactsQuery = contactsQuery.gte("uploaded_at", startDate);
  if (endDate) contactsQuery = contactsQuery.lte("uploaded_at", endDate);

  const { count: totalContacts } = await contactsQuery;

  // Accounts
  const { data: accounts } = await supabase
    .from("whatsapp_accounts")
    .select("wa_id")
    .eq("user_id", user_id);

  const accountIds = accounts?.map((a) => a.wa_id) || [];

  // ✅ Total Messages
  let totalMessages = 0;

  if (accountIds.length > 0) {
    let messagesQuery = supabase
      .from("whatsapp_messages")
      .select("*", { count: "exact", head: true })
      .in("account_id", accountIds);

    if (startDate) messagesQuery = messagesQuery.gte("created_at", startDate);
    if (endDate) messagesQuery = messagesQuery.lte("created_at", endDate);

    const { count } = await messagesQuery;
    totalMessages = count || 0;
  }

  // ✅ Active Chats
  let chatsQuery = supabase
    .from("chats")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user_id);

  if (startDate) chatsQuery = chatsQuery.gte("created_at", startDate);
  if (endDate) chatsQuery = chatsQuery.lte("created_at", endDate);

  const { count: activeChats } = await chatsQuery;

  /* ---------- Trends (FIXED) ---------- */

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { count: groupsTrend } = await supabase
    .from("groups")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user_id)
    .gte("created_at", startOfMonth.toISOString());

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { count: contactsTrend } = await supabase
    .from("group_contacts")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user_id)
    .gte("uploaded_at", startOfDay.toISOString());

  let messagesTodayCount = 0;

  if (accountIds.length > 0) {
    const { count } = await supabase
      .from("whatsapp_messages")
      .select("*", { count: "exact", head: true })
      .in("account_id", accountIds)
      .gte("created_at", startOfDay.toISOString());

    messagesTodayCount = count || 0;
  }

  // Chat active %
  let chatActivePercentage = 0;

  if (totalGroups > 0) {
    const { data: groupsWithChats } = await supabase
      .from("chats")
      .select("group_id")
      .eq("user_id", user_id);

    const uniqueGroupsWithChats = new Set(
      groupsWithChats?.map((c) => c.group_id) || [],
    );

    chatActivePercentage = Math.round(
      (uniqueGroupsWithChats.size / totalGroups) * 100,
    );
  }

  return {
    total_groups: totalGroups || 0,
    total_contacts: totalContacts || 0,
    total_messages: totalMessages,
    active_chats: activeChats || 0,
    trends: {
      groups_this_month: groupsTrend || 0,
      contacts_today: contactsTrend || 0,
      messages_today: messagesTodayCount,
      chat_active_percentage: chatActivePercentage,
    },
  };
}

// Helper function to fetch groups performance data
async function fetchGroupsData(
  user_id,
  from_date,
  to_date,
  startDate,
  endDate,
) {
  const { data: groups } = await supabase
    .from("groups")
    .select("*")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false });

  if (!groups) return { total: 0, groups: [] };

  const groupsPerformance = await Promise.all(
    groups.map(async (group) => {
      // ✅ contacts count (FIX)
      let contactsQuery = supabase
        .from("group_contacts")
        .select("*", { count: "exact", head: true })
        .eq("group_id", group.group_id);

      if (startDate)
        contactsQuery = contactsQuery.gte("uploaded_at", startDate);
      if (endDate) contactsQuery = contactsQuery.lte("uploaded_at", endDate);

      const { count: contactCount } = await contactsQuery;

      // chats
      const { data: chats } = await supabase
        .from("chats")
        .select("chat_id")
        .eq("group_id", group.group_id);

      const chatIds = chats?.map((c) => c.chat_id) || [];

      let messageCount = 0;
      let adminMessageCount = 0;
      let userMessageCount = 0;

      if (chatIds.length > 0) {
        const { data: messages } = await supabase
          .from("messages")
          .select("sender_type")
          .in("chat_id", chatIds);

        messageCount = messages?.length || 0;
        adminMessageCount =
          messages?.filter((m) => m.sender_type === "admin").length || 0;
        userMessageCount =
          messages?.filter((m) => m.sender_type === "user").length || 0;
      }

      const responseRate =
        adminMessageCount > 0
          ? Math.round((userMessageCount / adminMessageCount) * 100)
          : 0;

      return {
        group_id: group.group_id,
        group_name: group.group_name,
        description: group.description,
        contact_count: contactCount || 0,
        message_count: messageCount,
        admin_messages: adminMessageCount,
        user_messages: userMessageCount,
        response_rate: responseRate,
        status: group.status,
        created_at: group.created_at,
      };
    }),
  );

  return {
    total: groupsPerformance.length,
    groups: groupsPerformance,
  };
}
