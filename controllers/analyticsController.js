// controllers/analyticsController.js

import { supabase } from "../config/supabase.js";

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

    // 1️⃣ Total Groups (filtered by created_at if date range provided)
    let groupsQuery = supabase
      .from("groups")
      .select("group_id, created_at")
      .eq("user_id", user_id);

    if (startDate) groupsQuery = groupsQuery.gte("created_at", startDate);
    if (endDate) groupsQuery = groupsQuery.lte("created_at", endDate);

    const { data: groupsData, error: groupsError } = await groupsQuery;

    if (groupsError) throw groupsError;
    const totalGroups = groupsData.length;

    // 2️⃣ Total Contacts (filtered by uploaded_at if date range provided)
    let contactsQuery = supabase
      .from("group_contacts")
      .select("contact_id, uploaded_at")
      .eq("user_id", user_id);

    if (startDate) contactsQuery = contactsQuery.gte("uploaded_at", startDate);
    if (endDate) contactsQuery = contactsQuery.lte("uploaded_at", endDate);

    const { data: contactsData, error: contactsError } = await contactsQuery;

    if (contactsError) throw contactsError;
    const totalContacts = contactsData.length;

    // 3️⃣ Total Messages from whatsapp_messages table
    // Get user's WhatsApp accounts first
    const { data: accounts } = await supabase
      .from("whatsapp_accounts")
      .select("wa_id")
      .eq("user_id", user_id);

    const accountIds = accounts ? accounts.map((a) => a.wa_id) : [];

    let totalMessages = 0;

    if (accountIds.length > 0) {
      let messagesQuery = supabase
        .from("whatsapp_messages")
        .select("wm_id, created_at")
        .in("account_id", accountIds);

      if (startDate) messagesQuery = messagesQuery.gte("created_at", startDate);
      if (endDate) messagesQuery = messagesQuery.lte("created_at", endDate);

      const { data: messagesData } = await messagesQuery;
      totalMessages = messagesData ? messagesData.length : 0;
    }

    // 4️⃣ Active Chats (filtered by created_at if date range provided)
    let chatsQuery = supabase.from("chats").select(
      `
        chat_id,
        created_at,
        groups!inner (
          group_id,
          user_id
        )
      `
    ).eq("groups.user_id", user_id);

    if (startDate) chatsQuery = chatsQuery.gte("created_at", startDate);
    if (endDate) chatsQuery = chatsQuery.lte("created_at", endDate);

    const { data: chatsData, error: chatsError } = await chatsQuery;

    if (chatsError) throw chatsError;
    const activeChats = chatsData.length;

    // 5️⃣ Calculate trends (for selected date range vs previous period)
    let groupsTrend = 0;
    let contactsTrend = 0;
    let messagesTodayCount = 0;
    let chatActivePercentage = 0;

    // Groups trend - count from start of month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { data: newGroupsThisMonth } = await supabase
      .from("groups")
      .select("group_id")
      .eq("user_id", user_id)
      .gte("created_at", startOfMonth.toISOString());

    groupsTrend = newGroupsThisMonth ? newGroupsThisMonth.length : 0;

    // Contacts added today
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const { data: newContactsToday } = await supabase
      .from("group_contacts")
      .select("contact_id")
      .eq("user_id", user_id)
      .gte("uploaded_at", startOfDay.toISOString());

    contactsTrend = newContactsToday ? newContactsToday.length : 0;

    // Messages sent today
    if (accountIds.length > 0) {
      const { data: messagesToday } = await supabase
        .from("whatsapp_messages")
        .select("wm_id")
        .in("account_id", accountIds)
        .gte("created_at", startOfDay.toISOString());

      messagesTodayCount = messagesToday ? messagesToday.length : 0;
    }

    // Chat active percentage
    // Calculate: (groups with at least 1 chat / total groups) * 100
    // let chatActivePercentage = 0;
    if (totalGroups > 0) {
      // Get groups that have chats
      const { data: groupsWithChats } = await supabase
        .from("chats")
        .select("group_id")
        .in("group_id", groupsData.map(g => g.group_id));

      const uniqueGroupsWithChats = new Set(
        groupsWithChats ? groupsWithChats.map(c => c.group_id) : []
      );

      chatActivePercentage = Math.round(
        (uniqueGroupsWithChats.size / totalGroups) * 100
      );
    }

    return res.status(200).json({
      date_range: {
        from: from_date || "All time",
        to: to_date || "All time",
      },
      overview: {
        total_groups: totalGroups,
        total_contacts: totalContacts,
        total_messages: totalMessages,
        active_chats: activeChats,
        trends: {
          groups_this_month: groupsTrend,
          contacts_today: contactsTrend,
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

    // Get all groups for user
    let groupsQuery = supabase
      .from("groups")
      .select("*")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    // Note: We get all groups, but filter their data by date range
    const { data: groups, error: groupsError } = await groupsQuery;

    if (groupsError) throw groupsError;

    // Get user's WhatsApp accounts
    const { data: accounts } = await supabase
      .from("whatsapp_accounts")
      .select("wa_id")
      .eq("user_id", user_id);

    const accountIds = accounts ? accounts.map((a) => a.wa_id) : [];

    // For each group, get contacts and messages count within date range
    const groupsPerformance = await Promise.all(
      groups.map(async (group) => {
        // Count contacts (filtered by date if provided)
        let contactsQuery = supabase
          .from("group_contacts")
          .select("contact_id")
          .eq("group_id", group.group_id);

        if (startDate) contactsQuery = contactsQuery.gte("uploaded_at", startDate);
        if (endDate) contactsQuery = contactsQuery.lte("uploaded_at", endDate);

        const { data: contacts } = await contactsQuery;
        const contactCount = contacts ? contacts.length : 0;

        // Count messages from chats within this group
        let chatsQuery = supabase
          .from("chats")
          .select("chat_id, created_at")
          .eq("group_id", group.group_id);

        if (startDate) chatsQuery = chatsQuery.gte("created_at", startDate);
        if (endDate) chatsQuery = chatsQuery.lte("created_at", endDate);

        const { data: chats } = await chatsQuery;
        const chatIds = chats ? chats.map((c) => c.chat_id) : [];

        let messageCount = 0;
        let adminMessageCount = 0;
        let userMessageCount = 0;

        // Count messages in chats
        if (chatIds.length > 0) {
          let messagesQuery = supabase
            .from("messages")
            .select("message_id, sender_type, created_at")
            .in("chat_id", chatIds);

          if (startDate) messagesQuery = messagesQuery.gte("created_at", startDate);
          if (endDate) messagesQuery = messagesQuery.lte("created_at", endDate);

          const { data: messages } = await messagesQuery;

          messageCount = messages ? messages.length : 0;
          adminMessageCount = messages
            ? messages.filter((m) => m.sender_type === "admin").length
            : 0;
          userMessageCount = messages
            ? messages.filter((m) => m.sender_type === "user").length
            : 0;
        }

        // Calculate response rate (user replies / admin messages * 100)
        const responseRate =
          adminMessageCount > 0
            ? Math.round((userMessageCount / adminMessageCount) * 100)
            : 0;

        return {
          group_id: group.group_id,
          group_name: group.group_name,
          description: group.description,
          contact_count: contactCount,
          message_count: messageCount,
          admin_messages: adminMessageCount,
          user_messages: userMessageCount,
          response_rate: responseRate,
          status: group.status,
          created_at: group.created_at,
        };
      })
    );

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

    // Manually fetch both datasets
    const overviewData = await fetchOverviewData(user_id, from_date, to_date, startDate, endDate);
    const groupsData = await fetchGroupsData(user_id, from_date, to_date, startDate, endDate);

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
    return res.status(500).json({ error: "Failed to fetch dashboard analytics" });
  }
};

// Helper function to fetch overview data
async function fetchOverviewData(user_id, from_date, to_date, startDate, endDate) {
  // Total Groups
  let groupsQuery = supabase
    .from("groups")
    .select("group_id")
    .eq("user_id", user_id);

  if (startDate) groupsQuery = groupsQuery.gte("created_at", startDate);
  if (endDate) groupsQuery = groupsQuery.lte("created_at", endDate);

  const { data: groupsData } = await groupsQuery;
  const totalGroups = groupsData?.length || 0;

  // Total Contacts
  let contactsQuery = supabase
    .from("group_contacts")
    .select("contact_id")
    .eq("user_id", user_id);

  if (startDate) contactsQuery = contactsQuery.gte("uploaded_at", startDate);
  if (endDate) contactsQuery = contactsQuery.lte("uploaded_at", endDate);

  const { data: contactsData } = await contactsQuery;
  const totalContacts = contactsData?.length || 0;

  // Total Messages
  const { data: accounts } = await supabase
    .from("whatsapp_accounts")
    .select("wa_id")
    .eq("user_id", user_id);

  const accountIds = accounts ? accounts.map((a) => a.wa_id) : [];
  let totalMessages = 0;

  if (accountIds.length > 0) {
    let messagesQuery = supabase
      .from("whatsapp_messages")
      .select("wm_id")
      .in("account_id", accountIds);

    if (startDate) messagesQuery = messagesQuery.gte("created_at", startDate);
    if (endDate) messagesQuery = messagesQuery.lte("created_at", endDate);

    const { data: messagesData } = await messagesQuery;
    totalMessages = messagesData?.length || 0;
  }

  // Active Chats
  let chatsQuery = supabase.from("chats").select(
    `
      chat_id,
      groups!inner (
        user_id
      )
    `
  ).eq("groups.user_id", user_id);

  if (startDate) chatsQuery = chatsQuery.gte("created_at", startDate);
  if (endDate) chatsQuery = chatsQuery.lte("created_at", endDate);

  const { data: chatsData } = await chatsQuery;
  const activeChats = chatsData?.length || 0;

  // Calculate trends
  let groupsTrend = 0;
  let contactsTrend = 0;
  let messagesTodayCount = 0;
  let chatActivePercentage = 0;

  // Groups trend - count from start of month
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { data: newGroupsThisMonth } = await supabase
    .from("groups")
    .select("group_id")
    .eq("user_id", user_id)
    .gte("created_at", startOfMonth.toISOString());

  groupsTrend = newGroupsThisMonth ? newGroupsThisMonth.length : 0;

  // Contacts added today
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data: newContactsToday } = await supabase
    .from("group_contacts")
    .select("contact_id")
    .eq("user_id", user_id)
    .gte("uploaded_at", startOfDay.toISOString());

  contactsTrend = newContactsToday ? newContactsToday.length : 0;

  // Messages sent today
  if (accountIds.length > 0) {
    const { data: messagesToday } = await supabase
      .from("whatsapp_messages")
      .select("wm_id")
      .in("account_id", accountIds)
      .gte("created_at", startOfDay.toISOString());

    messagesTodayCount = messagesToday ? messagesToday.length : 0;
  }

  // Chat active percentage - Calculate: (groups with at least 1 chat / total groups) * 100
  if (totalGroups > 0 && chatsData && chatsData.length > 0) {
    // Get all groups from chats
    const { data: allChats } = await supabase.from("chats").select(
      `
        chat_id,
        group_id,
        groups!inner (
          user_id
        )
      `
    ).eq("groups.user_id", user_id);

    const uniqueGroupsWithChats = new Set(
      allChats ? allChats.map(c => c.group_id) : []
    );

    chatActivePercentage = Math.round(
      (uniqueGroupsWithChats.size / totalGroups) * 100
    );
  }

  return {
    total_groups: totalGroups,
    total_contacts: totalContacts,
    total_messages: totalMessages,
    active_chats: activeChats,
    trends: {
      groups_this_month: groupsTrend,
      contacts_today: contactsTrend,
      messages_today: messagesTodayCount,
      chat_active_percentage: chatActivePercentage,
    },
  };
}

// Helper function to fetch groups performance data
async function fetchGroupsData(user_id, from_date, to_date, startDate, endDate) {
  const { data: groups } = await supabase
    .from("groups")
    .select("*")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false });

  if (!groups) return { total: 0, groups: [] };

  const groupsPerformance = await Promise.all(
    groups.map(async (group) => {
      let contactsQuery = supabase
        .from("group_contacts")
        .select("contact_id")
        .eq("group_id", group.group_id);

      if (startDate) contactsQuery = contactsQuery.gte("uploaded_at", startDate);
      if (endDate) contactsQuery = contactsQuery.lte("uploaded_at", endDate);

      const { data: contacts } = await contactsQuery;
      const contactCount = contacts?.length || 0;

      let chatsQuery = supabase
        .from("chats")
        .select("chat_id")
        .eq("group_id", group.group_id);

      if (startDate) chatsQuery = chatsQuery.gte("created_at", startDate);
      if (endDate) chatsQuery = chatsQuery.lte("created_at", endDate);

      const { data: chats } = await chatsQuery;
      const chatIds = chats ? chats.map((c) => c.chat_id) : [];

      let messageCount = 0;
      let adminMessageCount = 0;
      let userMessageCount = 0;

      if (chatIds.length > 0) {
        let messagesQuery = supabase
          .from("messages")
          .select("message_id, sender_type")
          .in("chat_id", chatIds);

        if (startDate) messagesQuery = messagesQuery.gte("created_at", startDate);
        if (endDate) messagesQuery = messagesQuery.lte("created_at", endDate);

        const { data: messages } = await messagesQuery;

        messageCount = messages?.length || 0;
        adminMessageCount = messages?.filter((m) => m.sender_type === "admin").length || 0;
        userMessageCount = messages?.filter((m) => m.sender_type === "user").length || 0;
      }

      const responseRate = adminMessageCount > 0 
        ? Math.round((userMessageCount / adminMessageCount) * 100) 
        : 0;

      return {
        group_id: group.group_id,
        group_name: group.group_name,
        description: group.description,
        contact_count: contactCount,
        message_count: messageCount,
        admin_messages: adminMessageCount,
        user_messages: userMessageCount,
        response_rate: responseRate,
        status: group.status,
        created_at: group.created_at,
      };
    })
  );

  return {
    total: groupsPerformance.length,
    groups: groupsPerformance,
  };
}