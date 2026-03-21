// controllers/campaignController.js

import { log } from "console";
import { supabase } from "../config/supabase.js";
import { requiresWarmup, getWarmupLimits } from '../utils/warmupHelper.js';

/* =====================================
   1️⃣ CREATE CAMPAIGN - WITH DAILY LIMIT CHECK
====================================== */

export const createCampaign = async (req, res) => {
  try {
    const {
      user_id,
      campaign_name,
      description,
      group_id,
      wt_id,
      account_id,
      scheduled_at,
      timezone,
      template_variables,
      media_id,
    } = req.body;
 
    // Validate required fields
    if (
      !user_id ||
      !campaign_name ||
      !group_id ||
      !wt_id ||
      !account_id ||
      !scheduled_at
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Missing required fields: user_id, campaign_name, group_id, wt_id, account_id, scheduled_at",
      });
    }
 
    // Check if scheduled_at is in the future
    const scheduledDate = new Date(scheduled_at);
    const now = new Date();
 
    if (scheduledDate <= now) {
      return res.status(400).json({
        success: false,
        error: "Scheduled time must be in the future",
      });
    }
 
    // Validate media if template requires it
    const { data: template } = await supabase
      .from("whatsapp_templates")
      .select("components")
      .eq("wt_id", wt_id)
      .single();
 
    if (template) {
      let components = template.components;
      if (typeof components === "string") {
        components = JSON.parse(components);
      }
 
      const headerComp = components.find((c) => c.type === "HEADER");
      const hasMedia =
        headerComp &&
        ["IMAGE", "VIDEO", "DOCUMENT"].includes(headerComp.format);
 
      if (hasMedia && !media_id) {
        return res.status(400).json({
          success: false,
          error: `This template requires ${headerComp.format} media. Please select or upload media.`,
        });
      }
    }
 
    console.log(`📊 Fetching contacts for group: ${group_id}`);
 
    // 🔥 STEP 1: Get total count first (fast, no data fetched)
    const { count: totalContacts, error: countError } = await supabase
      .from("group_contacts")
      .select("contact_id", { count: "exact", head: true })
      .eq("group_id", group_id)
      .eq("user_id", user_id);
 
    if (countError) throw countError;
 
    console.log(`✅ Total contacts in group: ${totalContacts}`);
 
    if (totalContacts === 0) {
      return res.status(400).json({
        success: false,
        error: "No contacts found in this group",
      });
    }
 
// ✅ WARM-UP & DAILY LIMIT VALIDATION
// Get WhatsApp account details
const { data: account, error: accountError } = await supabase
  .from("whatsapp_accounts")
  .select("*")
  .eq("wa_id", account_id)
  .single();

if (accountError || !account) {
  return res.status(404).json({
    success: false,
    error: "WhatsApp account not found",
  });
}

// ✅ HELPER: Reset daily counter if new day
function shouldResetDailyCounter(last_reset) {
  if (!last_reset) return true;
  const now = new Date();
  const lastReset = new Date(last_reset);
  const nowDay = now.toISOString().split('T')[0];
  const lastResetDay = lastReset.toISOString().split('T')[0];
  return nowDay !== lastResetDay;
}

// ✅ Reset warmup daily counter if needed
let daily_sent = account.warmup_daily_sent || 0;
if (shouldResetDailyCounter(account.warmup_daily_reset_at)) {
  console.log('🔄 Resetting warmup daily counter (new day)');
  await supabase
    .from('whatsapp_accounts')
    .update({
      warmup_daily_sent: 0,
      warmup_daily_reset_at: new Date().toISOString()
    })
    .eq('wa_id', account_id);
  daily_sent = 0;
}

// ✅ NEW: Reset tier daily counter if needed (for post-warmup tracking)
let tier_daily_sent = account.tier_daily_sent || 0;
if (shouldResetDailyCounter(account.tier_daily_reset_at)) {
  console.log('🔄 Resetting tier daily counter (new day)');
  await supabase
    .from('whatsapp_accounts')
    .update({
      tier_daily_sent: 0,
      tier_daily_reset_at: new Date().toISOString()
    })
    .eq('wa_id', account_id);
  tier_daily_sent = 0;
}
    // Check if tier requires warm-up and validate
    let warmupInfo = null;
    
    if (requiresWarmup(account.messaging_limit_tier)) {
      console.log(`🔥 Tier ${account.messaging_limit_tier} requires warm-up validation`);
      
      // ========================================
// CASE 1: WARM-UP COMPLETED - Check tier limit
// ========================================
if (account.warmup_completed) {
  const tier_daily_limit = account.messaging_limit_per_day;
  const daily_remaining = tier_daily_limit - tier_daily_sent;  // ✅ CHANGED: Use tier_daily_sent

  console.log(`✅ Warm-up completed - checking tier daily limit`);
  console.log(`   Tier limit: ${tier_daily_limit}/day`);
  console.log(`   Tier daily sent: ${tier_daily_sent}`);  // ✅ CHANGED
  console.log(`   Remaining: ${daily_remaining}`);

  if (totalContacts > daily_remaining) {
    return res.status(400).json({
      success: false,
      error: "TIER_DAILY_LIMIT_EXCEEDED",  // ✅ CHANGED: More specific error
      warmup_completed: true,
      tier: account.messaging_limit_tier,
      tier_daily_limit,
      tier_daily_sent,  // ✅ CHANGED: Return tier_daily_sent
      daily_remaining,
      contact_count: totalContacts,
      message: `⚠️ Daily Tier Limit Exceeded!\n\n✅ Warm-up completed!\n\nYour tier (${account.messaging_limit_tier}) allows ${tier_daily_limit} messages per day.\n\nToday's usage: ${tier_daily_sent}/${tier_daily_limit}\nRemaining: ${daily_remaining}\nYour campaign: ${totalContacts}\n\nReduce to ${daily_remaining} contacts or wait until tomorrow.`,
      suggestion: daily_remaining > 0 
        ? `Reduce to ${daily_remaining} contacts`
        : 'Daily limit reached. Resets at midnight UTC.'
    });
  }

  warmupInfo = {
    completed: true,
    tier_limit: tier_daily_limit,
    tier_daily_sent: tier_daily_sent,  // ✅ CHANGED
    daily_remaining: daily_remaining - totalContacts
  };

  console.log(`✅ Campaign (${totalContacts}) within tier limit (${daily_remaining} remaining)`);
}
      // ========================================
      // CASE 2: WARM-UP ACTIVE - Check warm-up limits + daily limit
      // ========================================
      else if (account.warmup_enabled && !account.warmup_completed) {
        const warmup_limits = account.warmup_limits || getWarmupLimits(account.messaging_limit_tier);
        const current_stage = account.warmup_stage || 1;
        const current_limit = warmup_limits[current_stage - 1];
        const stage_progress = account.warmup_stage_progress || 0;

        console.log(`🔥 Warm-up Stage ${current_stage}:`);
        console.log(`   Stage limit: ${current_limit}`);
        console.log(`   Stage progress: ${stage_progress}/${current_limit}`);
        console.log(`   Daily sent: ${daily_sent}/${current_limit}`);

        // ✅ CHECK 1: DAILY LIMIT (most important!)
        const daily_remaining = current_limit - daily_sent;
        
        if (totalContacts > daily_remaining) {
          return res.status(400).json({
            success: false,
            error: "WARMUP_DAILY_LIMIT_EXCEEDED",
            warmup_required: true,
            blocked_by: "daily_limit",
            current_stage,
            current_limit,
            daily_sent,
            daily_remaining,
            contact_count: totalContacts,
            warmup_limits,
            tier: account.messaging_limit_tier,
            message: `⚠️ Daily Limit Reached!\n\nWarm-up Stage ${current_stage} allows ${current_limit} messages per day.\n\nToday's usage: ${daily_sent}/${current_limit}\nRemaining today: ${daily_remaining}\nYour campaign: ${totalContacts}\n\nYou can send ${daily_remaining} more contacts today, or wait until tomorrow.`,
            suggestion: daily_remaining > 0 
              ? `Reduce campaign to ${daily_remaining} contacts`
              : 'Daily limit reached. Resets at midnight UTC.'
          });
        }

        // ✅ CHECK 2: STAGE LIMIT (for progression)
        const stage_remaining = current_limit - stage_progress;
        
        if (totalContacts > stage_remaining) {
          return res.status(400).json({
            success: false,
            error: "WARMUP_STAGE_LIMIT_EXCEEDED",
            warmup_required: true,
            blocked_by: "stage_limit",
            current_stage,
            current_limit,
            stage_progress,
            stage_remaining,
            contact_count: totalContacts,
            warmup_limits,
            tier: account.messaging_limit_tier,
            message: `⚠️ Warm-up Stage ${current_stage}: Maximum ${current_limit} contacts for stage completion.\n\nStage progress: ${stage_progress}/${current_limit}\nRemaining to complete stage: ${stage_remaining}\nYour campaign: ${totalContacts}\n\nNote: You've sent ${daily_sent} messages today.`,
            suggestion: `Reduce to ${stage_remaining} contacts to complete Stage ${current_stage}`,
            next_stage: current_stage < warmup_limits.length ? {
              stage: current_stage + 1,
              limit: warmup_limits[current_stage],
              message: `After ${current_limit} messages, unlock Stage ${current_stage + 1} (${warmup_limits[current_stage]}/day)`
            } : null
          });
        }

        warmupInfo = {
          stage: current_stage,
          limit: current_limit,
          progress: stage_progress,
          limits: warmup_limits,
          daily_sent,
          daily_remaining: daily_remaining - totalContacts
        };

        console.log(`✅ Campaign (${totalContacts}) within limits`);
        console.log(`   Daily: ${daily_sent + totalContacts}/${current_limit}`);
        console.log(`   Stage: ${stage_progress + totalContacts}/${current_limit}`);
      } else {
        console.log(`ℹ️ Warm-up disabled for this account`);
      }
    } else {
  // ========================================
  // Tier doesn't require warm-up (Tier 10K+)
  // BUT still check tier daily limit!
  // ========================================
  const tier_daily_limit = account.messaging_limit_per_day;
  const daily_remaining = tier_daily_limit - tier_daily_sent;  // ✅ CHANGED

  console.log(`⏭️  Tier ${account.messaging_limit_tier} - no warm-up required`);
  console.log(`   Tier limit: ${tier_daily_limit}/day`);
  console.log(`   Tier daily sent: ${tier_daily_sent}`);  // ✅ CHANGED
  console.log(`   Remaining: ${daily_remaining}`);

  if (totalContacts > daily_remaining) {
    return res.status(400).json({
      success: false,
      error: "TIER_DAILY_LIMIT_EXCEEDED",
      tier: account.messaging_limit_tier,
      tier_daily_limit,
      tier_daily_sent,  // ✅ CHANGED
      daily_remaining,
      contact_count: totalContacts,
      message: `⚠️ Daily Tier Limit Exceeded!\n\nYour tier (${account.messaging_limit_tier}) allows ${tier_daily_limit} messages per day.\n\nToday's usage: ${tier_daily_sent}/${tier_daily_limit}\nRemaining: ${daily_remaining}\nYour campaign: ${totalContacts}\n\nReduce to ${daily_remaining} or wait until tomorrow.`,
      suggestion: daily_remaining > 0 
        ? `Reduce to ${daily_remaining} contacts`
        : 'Daily limit reached. Resets at midnight UTC.'
    });
  }

  warmupInfo = {
    no_warmup: true,
    tier_limit: tier_daily_limit,
    tier_daily_sent,  // ✅ CHANGED
    daily_remaining: daily_remaining - totalContacts
  };

  console.log(`✅ Campaign (${totalContacts}) within tier limit`);
}
    // ✅ END: VALIDATION
 
    // 🔥 STEP 2: Fetch ALL contacts using pagination
    let allContacts = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;
 
    while (hasMore) {
      const { data: contacts, error: contactsError } = await supabase
        .from("group_contacts")
        .select("contact_id, phone_number, full_name")
        .eq("group_id", group_id)
        .eq("user_id", user_id)
        .range(page * pageSize, (page + 1) * pageSize - 1);
 
      if (contactsError) throw contactsError;
 
      if (contacts && contacts.length > 0) {
        allContacts = allContacts.concat(contacts);
        console.log(
          `📄 Fetched page ${page + 1}: ${contacts.length} contacts (Total so far: ${allContacts.length})`,
        );
        page++;
      }
 
      if (!contacts || contacts.length < pageSize) {
        hasMore = false;
      }
    }
 
    console.log(`✅ Total contacts fetched: ${allContacts.length}`);
 
    if (allContacts.length !== totalContacts) {
      console.warn(
        `⚠️ Mismatch: Expected ${totalContacts}, got ${allContacts.length}`,
      );
    }
 
    // 🔥 STEP 3: Create campaign
    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .insert({
        user_id,
        campaign_name,
        description,
        group_id,
        wt_id,
        account_id,
        scheduled_at,
        timezone: timezone || "UTC",
        template_variables: template_variables || {},
        media_id: media_id || null,
        status: "scheduled",
        total_recipients: allContacts.length,
        warmup_stage: (warmupInfo && warmupInfo.stage) ? warmupInfo.stage : null,
      })
      .select()
      .single();
 
    if (campaignError) throw campaignError;
 
    console.log(`📤 Campaign created: ${campaign.campaign_id}`);
    console.log(`👥 Creating ${allContacts.length} campaign messages...`);
 
    // 🔥 STEP 4: Insert campaign messages in BATCHES
    const batchSize = 1000;
    let insertedCount = 0;
 
    for (let i = 0; i < allContacts.length; i += batchSize) {
      const batch = allContacts.slice(i, i + batchSize);
 
      const campaignMessages = batch.map((contact) => ({
        campaign_id: campaign.campaign_id,
        contact_id: contact.contact_id,
        phone_number: contact.phone_number,
        contact_name: contact.full_name,
        status: "pending",
      }));
 
      const { error: messagesError } = await supabase
        .from("campaign_messages")
        .insert(campaignMessages);
 
      if (messagesError) {
        console.error(
          `❌ Error inserting batch ${i / batchSize + 1}:`,
          messagesError,
        );
        throw messagesError;
      }
 
      insertedCount += batch.length;
      console.log(
        `✅ Inserted batch ${i / batchSize + 1}: ${batch.length} messages (Total: ${insertedCount}/${allContacts.length})`,
      );
    }
 
    console.log(`✅ All ${insertedCount} campaign messages created!`);
 
    // ✅ Build response with warm-up info
    const response = {
      success: true,
      message: "Campaign created successfully",
      data: {
        ...campaign,
        total_contacts_processed: insertedCount,
      }
    };
 
    // Add warm-up/tier info
    if (warmupInfo) {
      if (warmupInfo.completed) {
        response.warmup_info = {
          completed: true,
          tier_limit: warmupInfo.tier_limit,
          daily_remaining: warmupInfo.daily_remaining
        };
        response.info_message = `✅ Warm-up completed! Sent ${insertedCount} (${warmupInfo.daily_remaining} remaining today)`;
      } else if (warmupInfo.stage) {
        response.warmup_info = warmupInfo;
        response.warmup_warning = `✅ Warm-up Stage ${warmupInfo.stage}: Sending ${insertedCount} (limit: ${warmupInfo.limit})`;
      } else if (warmupInfo.no_warmup) {
        response.tier_info = {
          tier_limit: warmupInfo.tier_limit,
          daily_remaining: warmupInfo.daily_remaining
        };
      }
    }
 
    return res.status(201).json(response);
    
  } catch (err) {
    console.error("createCampaign error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to create campaign",
      details: err.message,
    });
  }
};
/* =====================================
   2️⃣ GET ALL CAMPAIGNS (for a user)
====================================== */

export const getCampaigns = async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id is required",
      });
    }

    // Get campaigns with relations using foreign keys
    const { data: campaigns, error } = await supabase
      .from("campaigns")
      .select(
        `
        *,
        groups!fk_campaigns_group_id (
          group_name,
          description
        ),
        whatsapp_templates!fk_campaigns_wt_id (
          name,
          category,
          language,
          status,
          template_id
        ),
        whatsapp_accounts!fk_campaigns_account_id (
          business_phone_number
        )
      `,
      )
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return res.status(200).json({
      success: true,
      total: campaigns?.length || 0,
      data: campaigns || [],
    });
  } catch (err) {
    console.error("getCampaigns error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch campaigns",
      details: err.message,
    });
  }
};

/* =====================================
   3️⃣ GET SINGLE CAMPAIGN (with details)
====================================== */

export const getCampaignById = async (req, res) => {
  try {
    const { campaign_id } = req.params;
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id is required",
      });
    }

    // Get campaign details with relations
    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .select(
        `
        *,
        groups!fk_campaigns_group_id (
          group_name,
          description,
          status
        ),
        whatsapp_templates!fk_campaigns_wt_id (
          name,
          category,
          language,
          components,
          preview,
          template_id
        ),
        whatsapp_accounts!fk_campaigns_account_id (
          business_phone_number
        )
      `,
      )
      .eq("campaign_id", campaign_id)
      .eq("user_id", user_id)
      .single();

    if (campaignError) throw campaignError;

    if (!campaign) {
      return res.status(404).json({
        success: false,
        error: "Campaign not found",
      });
    }

    // Get campaign messages (FETCH ALL ROWS)
    let allMessages = [];
    let from = 0;
    const batchSize = 1000;
    let done = false;

    while (!done) {
      const { data, error } = await supabase
        .from("campaign_messages")
        .select("*")
        .eq("campaign_id", campaign_id)
        .order("created_at", { ascending: false })
        .range(from, from + batchSize - 1);

      if (error) throw error;

      allMessages = [...allMessages, ...(data || [])];

      if (!data || data.length < batchSize) {
        done = true;
      } else {
        from += batchSize;
      }
    }

    const messages = allMessages;

    // Calculate statistics
    // const stats = {
    //   total: messages?.length || 0,
    //   pending: messages?.filter((m) => m.status === "pending").length || 0,
    //   sent: messages?.filter((m) => m.status === "sent").length || 0,
    //   delivered: messages?.filter((m) => m.status === "delivered").length || 0,
    //   read: messages?.filter((m) => m.status === "read").length || 0,
    //   failed: messages?.filter((m) => m.status === "failed").length || 0,
    // };

    const stats = {
      total: messages?.length || 0,
      pending: messages?.filter((m) => m.status === "pending").length || 0,
      // sent: messages?.filter((m) => m.sent_at !== null).length || 0,
      sent:
        messages?.filter(
          (m) =>
            m.status === "sent" ||
            m.status === "delivered" ||
            m.status === "read",
        ).length || 0,
      delivered: messages?.filter((m) => m.delivered_at !== null).length || 0,
      read: messages?.filter((m) => m.read_at !== null).length || 0,
      failed: messages?.filter((m) => m.status === "failed").length || 0,
    };

    return res.status(200).json({
      success: true,
      data: {
        campaign,
        messages: messages || [],
        stats,
      },
    });
  } catch (err) {
    console.error("getCampaignById error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch campaign details",
      details: err.message,
    });
  }
};

// export const getCampaignById = async (req, res) => {
//   try {
//     const { campaign_id } = req.params;
//     const { user_id } = req.query;

//     if (!user_id) {
//       return res.status(400).json({
//         success: false,
//         error: "user_id is required",
//       });
//     }

//     /* -------------------------------------
//        1. Fetch campaign
//     ------------------------------------- */
//     const { data: campaign, error: campaignError } = await supabase
//       .from("campaigns")
//       .select(
//         `
//         *,
//         groups!fk_campaigns_group_id (
//           group_name,
//           description,
//           status
//         ),
//         whatsapp_templates!fk_campaigns_wt_id (
//           name,
//           category,
//           language,
//           components,
//           preview,
//           template_id
//         ),
//         whatsapp_accounts!fk_campaigns_account_id (
//           business_phone_number
//         )
//       `,
//       )
//       .eq("campaign_id", campaign_id)
//       .eq("user_id", user_id)
//       .single();

//     if (campaignError) throw campaignError;
//     if (!campaign) {
//       return res.status(404).json({
//         success: false,
//         error: "Campaign not found",
//       });
//     }

//     /* -------------------------------------
//        2. Fetch campaign messages
//     ------------------------------------- */
//     const { data: campaignMessages, error: cmError } = await supabase
//       .from("campaign_messages")
//       .select("*")
//       .eq("campaign_id", campaign_id)
//       .order("created_at", { ascending: false });

//     if (cmError) throw cmError;

//     if (!campaignMessages || campaignMessages.length === 0) {
//       return res.status(200).json({
//         success: true,
//         data: {
//           campaign,
//           messages: [],
//           stats: {
//             total: 0,
//             pending: 0,
//             sent: 0,
//             delivered: 0,
//             read: 0,
//             failed: 0,
//           },
//         },
//       });
//     }

//     /* -------------------------------------
//        3. Fetch whatsapp_messages (source of truth)
//     ------------------------------------- */
//     const wmIds = campaignMessages.map((m) => m.wm_id).filter(Boolean);

//     const { data: whatsappMessages, error: wmError } = await supabase
//       .from("whatsapp_messages")
//       .select("wm_id, status, delivered_at, read_at")
//       .in("wm_id", wmIds);

//     if (wmError) throw wmError;

//     const wmMap = new Map();
//     whatsappMessages.forEach((wm) => {
//       wmMap.set(wm.wm_id, wm);
//     });

//     /* -------------------------------------
//        4. Merge delivery/read info
//     ------------------------------------- */
//     // const mergedMessages = campaignMessages.map((cm) => {
//     //   const wm = wmMap.get(cm.wm_id);

//     //   if (!wm) return cm;

//     //   return {
//     //     ...cm,
//     //     status: wm.status || cm.status,
//     //     delivered_at: wm.delivered_at || cm.delivered_at,
//     //     read_at: wm.read_at || cm.read_at,
//     //   };
//     // });

//     const mergedMessages = campaignMessages.map((cm) => {
//       const wm = wmMap.get(cm.wm_id);
//       if (!wm) return cm;

//       return {
//         ...cm,
//         status: wm.status, // 🔥 ALWAYS trust whatsapp_messages
//         delivered_at: wm.delivered_at,
//         read_at: wm.read_at,
//         failed_at:
//           wm.status === "failed"
//             ? cm.failed_at || new Date().toISOString()
//             : cm.failed_at,
//       };
//     });

//     /* -------------------------------------
//        5. (OPTIONAL BUT RECOMMENDED)
//        Sync delivery/read back to campaign_messages
//     ------------------------------------- */
//     // const updates = mergedMessages.filter(
//     //   (m) =>
//     //     m.wm_id &&
//     //     (m.delivered_at || m.read_at) &&
//     //     (m.delivered_at !==
//     //       campaignMessages.find((x) => x.cm_id === m.cm_id)?.delivered_at ||
//     //       m.read_at !==
//     //         campaignMessages.find((x) => x.cm_id === m.cm_id)?.read_at),
//     // );

//     // if (updates.length > 0) {
//     //   await Promise.all(
//     //     updates.map((m) =>
//     //       supabase
//     //         .from("campaign_messages")
//     //         .update({
//     //           status: m.status,
//     //           delivered_at: m.delivered_at,
//     //           read_at: m.read_at,
//     //           updated_at: new Date().toISOString(),
//     //         })
//     //         .eq("cm_id", m.cm_id),
//     //     ),
//     //   );
//     // }

//     const updates = mergedMessages.filter((m) => {
//       const original = campaignMessages.find((x) => x.cm_id === m.cm_id);

//       if (!original) return false;

//       return (
//         m.status !== original.status || // ✅ status-only changes
//         m.delivered_at !== original.delivered_at ||
//         m.read_at !== original.read_at
//       );
//     });

//     if (updates.length > 0) {
//       await Promise.all(
//         updates.map((m) =>
//           supabase
//             .from("campaign_messages")
//             .update({
//               status: m.status,
//               delivered_at: m.delivered_at,
//               read_at: m.read_at,
//               failed_at: m.status === "failed" ? m.failed_at : null,
//               updated_at: new Date().toISOString(),
//             })
//             .eq("cm_id", m.cm_id),
//         ),
//       );
//     }

//     /* -------------------------------------
//        6. Calculate stats (final truth)
//     ------------------------------------- */
//     const stats = {
//       total: mergedMessages.length,
//       pending: mergedMessages.filter((m) => m.status === "pending").length,
//       sent: mergedMessages.filter((m) => m.status === "sent").length,
//       delivered: mergedMessages.filter((m) => m.status === "delivered").length,
//       read: mergedMessages.filter((m) => m.status === "read").length,
//       failed: mergedMessages.filter((m) => m.status === "failed").length,
//     };

//     /* -------------------------------------
//        7. Response
//     ------------------------------------- */
//     return res.status(200).json({
//       success: true,
//       data: {
//         campaign,
//         messages: mergedMessages,
//         stats,
//       },
//     });
//   } catch (err) {
//     console.error("getCampaignById error:", err);
//     return res.status(500).json({
//       success: false,
//       error: "Failed to fetch campaign details",
//       details: err.message,
//     });
//   }
// };

/* =====================================
   4️⃣ UPDATE CAMPAIGN (reschedule)
====================================== */

export const updateCampaign = async (req, res) => {
  try {
    const { campaign_id } = req.params;
    const { user_id, scheduled_at, campaign_name, description } = req.body;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id is required",
      });
    }

    // Check if campaign exists and belongs to user
    const { data: existing, error: existError } = await supabase
      .from("campaigns")
      .select("campaign_id, status")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user_id)
      .single();

    if (existError || !existing) {
      return res.status(404).json({
        success: false,
        error: "Campaign not found",
      });
    }

    // Can only update scheduled campaigns
    if (existing.status !== "scheduled") {
      return res.status(400).json({
        success: false,
        error: `Cannot update campaign with status: ${existing.status}`,
      });
    }

    // Validate new scheduled_at if provided
    if (scheduled_at) {
      const scheduledDate = new Date(scheduled_at);
      const now = new Date();

      if (scheduledDate <= now) {
        return res.status(400).json({
          success: false,
          error: "Scheduled time must be in the future",
        });
      }
    }

    // Update campaign
    const updateData = {};
    if (scheduled_at) updateData.scheduled_at = scheduled_at;
    if (campaign_name) updateData.campaign_name = campaign_name;
    if (description !== undefined) updateData.description = description;

    const { data: updated, error: updateError } = await supabase
      .from("campaigns")
      .update(updateData)
      .eq("campaign_id", campaign_id)
      .eq("user_id", user_id)
      .select()
      .single();

    if (updateError) throw updateError;

    return res.status(200).json({
      success: true,
      message: "Campaign updated successfully",
      data: updated,
    });
  } catch (err) {
    console.error("updateCampaign error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to update campaign",
      details: err.message,
    });
  }
};

/* =====================================
   5️⃣ CANCEL CAMPAIGN
====================================== */

export const cancelCampaign = async (req, res) => {
  try {
    const { campaign_id } = req.params;
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id is required",
      });
    }

    // Check if campaign exists and belongs to user
    const { data: existing, error: existError } = await supabase
      .from("campaigns")
      .select("campaign_id, status")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user_id)
      .single();

    if (existError || !existing) {
      return res.status(404).json({
        success: false,
        error: "Campaign not found",
      });
    }

    // Can only cancel scheduled or processing campaigns
    if (!["scheduled", "processing"].includes(existing.status)) {
      return res.status(400).json({
        success: false,
        error: `Cannot cancel campaign with status: ${existing.status}`,
      });
    }

    // Update campaign status to cancelled
    const { data: cancelled, error: cancelError } = await supabase
      .from("campaigns")
      .update({ status: "cancelled" })
      .eq("campaign_id", campaign_id)
      .eq("user_id", user_id)
      .select()
      .single();

    if (cancelError) throw cancelError;

    return res.status(200).json({
      success: true,
      message: "Campaign cancelled successfully",
      data: cancelled,
    });
  } catch (err) {
    console.error("cancelCampaign error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to cancel campaign",
      details: err.message,
    });
  }
};

/* =====================================
   6️⃣ DELETE CAMPAIGN
====================================== */

export const deleteCampaign = async (req, res) => {
  try {
    const { campaign_id } = req.params;
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id is required",
      });
    }

    // Check if campaign exists and belongs to user
    const { data: existing, error: existError } = await supabase
      .from("campaigns")
      .select("campaign_id, status")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user_id)
      .single();

    if (existError || !existing) {
      return res.status(404).json({
        success: false,
        error: "Campaign not found",
      });
    }

    // Can only delete scheduled or cancelled campaigns
    if (
      !["scheduled", "cancelled", "completed", "failed"].includes(
        existing.status,
      )
    ) {
      return res.status(400).json({
        success: false,
        error: `Cannot delete campaign with status: ${existing.status}`,
      });
    }

    // Delete campaign (cascade will delete campaign_messages)
    const { error: deleteError } = await supabase
      .from("campaigns")
      .delete()
      .eq("campaign_id", campaign_id)
      .eq("user_id", user_id);

    if (deleteError) throw deleteError;

    return res.status(200).json({
      success: true,
      message: "Campaign deleted successfully",
    });
  } catch (err) {
    console.error("deleteCampaign error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to delete campaign",
      details: err.message,
    });
  }
};

/* =====================================
   7️⃣ GET USER'S GROUPS (for dropdown)
====================================== */

export const getUserGroups = async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id is required",
      });
    }

    const { data: groups, error } = await supabase
      .from("groups")
      .select(
        `
        group_id,
        group_name,
        description,
        status,
        created_at
      `,
      )
      .eq("user_id", user_id)
      .eq("status", "active")
      .order("created_at", { ascending: false });

    if (error) throw error;

    // 🔥 FIXED: Use .count() for accurate contact count (no 1000 limit)
    const groupsWithCounts = await Promise.all(
      (groups || []).map(async (group) => {
        const { count, error: countError } = await supabase
          .from("group_contacts")
          .select("contact_id", { count: "exact", head: true })
          .eq("group_id", group.group_id);

        if (countError) {
          console.error(
            `Error counting contacts for group ${group.group_id}:`,
            countError,
          );
        }

        return {
          ...group,
          contact_count: count || 0, // ✅ Shows 2137 instead of 1000
        };
      }),
    );

    return res.status(200).json({
      success: true,
      total: groupsWithCounts.length,
      data: groupsWithCounts,
    });
  } catch (err) {
    console.error("getUserGroups error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch groups",
      details: err.message,
    });
  }
};

/* =====================================
   8️⃣ GET USER'S TEMPLATES (for dropdown)
====================================== */

export const getUserTemplates = async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id is required",
      });
    }

    // Get user's WhatsApp accounts
    const { data: accounts } = await supabase
      .from("whatsapp_accounts")
      .select("wa_id")
      .eq("user_id", user_id);

    if (!accounts || accounts.length === 0) {
      return res.status(200).json({
        success: true,
        total: 0,
        data: [],
      });
    }

    const accountIds = accounts.map((a) => a.wa_id);

    // Get templates for these accounts
    const { data: templates, error } = await supabase
      .from("whatsapp_templates")
      .select(
        `
        wt_id,
        account_id,
        template_id,
        name,
        language,
        category,
        components,
        header_format,
        variables,
        buttons,
        preview,
        status
      `,
      )
      .in("account_id", accountIds)
      .eq("status", "APPROVED")
      .order("created_at", { ascending: false });

    if (error) throw error;

    return res.status(200).json({
      success: true,
      total: templates?.length || 0,
      data: templates || [],
    });
  } catch (err) {
    console.error("getUserTemplates error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch templates",
      details: err.message,
    });
  }
};

/* =====================================
   🔁 RETRY FAILED CAMPAIGN
====================================== */

export const retryCampaign = async (req, res) => {
  try {
    const { campaign_id } = req.params;
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id is required",
      });
    }

    /* -------------------------------------
       1. Validate campaign
    ------------------------------------- */
    const { data: campaign, error } = await supabase
      .from("campaigns")
      .select("campaign_id, status")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user_id)
      .single();

    if (error || !campaign) {
      return res.status(404).json({
        success: false,
        error: "Campaign not found",
      });
    }

    if (campaign.status === "scheduled") {
      return res.status(400).json({
        success: false,
        error: "Campaign is already scheduled. Please wait for it to run.",
      });
    }

    if (campaign.status === "processing" && campaign.started_at) {
      return res.status(400).json({
        success: false,
        error: "Campaign is currently processing. Retry is not allowed.",
      });
    }

    if (!["completed", "failed"].includes(campaign.status)) {
      return res.status(400).json({
        success: false,
        error: `Retry not allowed for campaign status: ${campaign.status}`,
      });
    }

    // /* -------------------------------------
    //    2. Find FAILED messages (retry < 3)
    // ------------------------------------- */
    // const { data: failedMessages, error: fmError } = await supabase
    //   .from("campaign_messages")
    //   .select("cm_id, retry_count")
    //   .eq("campaign_id", campaign_id)
    //   .eq("status", "failed")
    //   .lt("retry_count", 3);

    // if (fmError) throw fmError;

    // if (!failedMessages || failedMessages.length === 0) {
    //   return res.status(400).json({
    //     success: false,
    //     error: "No failed messages eligible for retry",
    //   });
    // }

    /* -------------------------------------
   2. Find FAILED messages (retry < 3)
------------------------------------- */

    let failedMessages = [];
    let offset = 0;
    const batchSize = 500;

    while (true) {
      const { data, error } = await supabase
        .from("campaign_messages")
        .select("cm_id, retry_count")
        .eq("campaign_id", campaign_id)
        .eq("status", "failed")
        .lt("retry_count", 3)
        .range(offset, offset + batchSize - 1);

      if (error) throw error;

      if (!data.length) break;

      failedMessages.push(...data);
      offset += batchSize;
    }

    console.log("Retry messages:", failedMessages.length);

    if (failedMessages.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No failed messages eligible for retry",
      });
    }

    const failedIds = failedMessages.map((m) => m.cm_id);

    // /* -------------------------------------
    //    3. Reset failed → pending
    // ------------------------------------- */
    // await supabase
    //   .from("campaign_messages")
    //   .update({
    //     status: "pending",
    //     failed_at: null,
    //     error_message: null,
    //     error_code: null,
    //     updated_at: new Date().toISOString(),
    //   })
    //   .in("cm_id", failedIds);

    // /* -------------------------------------
    //    4. Increment retry_count
    // ------------------------------------- */
    // for (const msg of failedMessages) {
    //   await supabase
    //     .from("campaign_messages")
    //     .update({
    //       retry_count: msg.retry_count + 1,
    //     })
    //     .eq("cm_id", msg.cm_id);
    // }

    /* -------------------------------------
   3. Reset failed → pending (batch safe)
------------------------------------- */

    const chunkSize = 100;

    for (let i = 0; i < failedMessages.length; i += chunkSize) {
      const chunk = failedMessages.slice(i, i + chunkSize);

      const ids = chunk.map((m) => m.cm_id);

      await supabase
        .from("campaign_messages")
        .update({
          status: "pending",
          sent_at: null,
          failed_at: null,
          error_message: null,
          error_code: null,
          updated_at: new Date().toISOString(),
        })
        .in("cm_id", ids);

      /* 4. increment retry count */
      await Promise.all(
        chunk.map((msg) =>
          supabase
            .from("campaign_messages")
            .update({
              retry_count: msg.retry_count + 1,
            })
            .eq("cm_id", msg.cm_id),
        ),
      );
    }

    /* -------------------------------------
       5. Schedule retry after 2 minutes
    ------------------------------------- */
    const RETRY_DELAY_MINUTES = 2;
    const retryAt = new Date(
      Date.now() + RETRY_DELAY_MINUTES * 60 * 1000,
    ).toISOString();

    await supabase
      .from("campaigns")
      .update({
        status: "scheduled",
        scheduled_at: retryAt,
        started_at: null, // ⭐ VERY IMPORTANT
        completed_at: null, // optional but recommended
        messages_failed: 0,
        updated_at: new Date().toISOString(),
      })
      .eq("campaign_id", campaign_id);

    return res.status(200).json({
      success: true,
      message: `Retry scheduled for ${failedIds.length} failed messages`,
      retry_after_minutes: RETRY_DELAY_MINUTES,
    });
  } catch (err) {
    console.error("retryCampaign error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to retry campaign",
      details: err.message,
    });
  }
};

/* =====================================
   🔄 SYNC CAMPAIGN MESSAGE STATUS
===================================== */

export const syncCampaignMessageStatus = async (req, res) => {
  try {
    const { campaign_id } = req.params;
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id is required",
      });
    }

    /* -------------------------------------
       1. Validate campaign
    ------------------------------------- */
    const { data: campaign, error: cError } = await supabase
      .from("campaigns")
      .select("campaign_id, status")
      .eq("campaign_id", campaign_id)
      .eq("user_id", user_id)
      .single();

    if (cError || !campaign) {
      return res.status(404).json({
        success: false,
        error: "Campaign not found",
      });
    }

    if (campaign.status === "scheduled") {
      return res.status(200).json({
        success: true,
        skipped: true,
        message: "Campaign is scheduled. Sync skipped.",
      });
    }

    /* -------------------------------------
       2. Process in batches
    ------------------------------------- */

    const batchSize = 500;
    let offset = 0;
    let totalUpdated = 0;

    while (true) {
      const { data: campaignMessages, error } = await supabase
        .from("campaign_messages")
        .select("cm_id, wm_id, status, delivered_at, read_at")
        .eq("campaign_id", campaign_id)
        .not("wm_id", "is", null)
        .range(offset, offset + batchSize - 1);

      if (error) throw error;

      if (!campaignMessages.length) break;

      const wmIds = campaignMessages.map((m) => m.wm_id);

      /* -------------------------------------
         3. Fetch whatsapp_messages
      ------------------------------------- */

      let whatsappMessages = [];
      const chunkSize = 100;

      for (let i = 0; i < wmIds.length; i += chunkSize) {
        const chunk = wmIds.slice(i, i + chunkSize);

        const { data, error } = await supabase
          .from("whatsapp_messages")
          .select("wm_id, status, delivered_at, read_at")
          .in("wm_id", chunk);

        if (error) throw error;

        whatsappMessages.push(...data);
      }

      // console.log("Batch size:", campaignMessages.length);
      // console.log("wmIds count:", wmIds.length);

      const wmMap = new Map();
      whatsappMessages.forEach((wm) => wmMap.set(wm.wm_id, wm));

      /* -------------------------------------
         4. Detect updates
      ------------------------------------- */

      const updates = [];

      for (const cm of campaignMessages) {
        const wm = wmMap.get(cm.wm_id);
        if (!wm) continue;

        const statusChanged = wm.status && wm.status !== cm.status;

        const deliveredChanged =
          wm.delivered_at &&
          (!cm.delivered_at ||
            new Date(wm.delivered_at).getTime() !==
              new Date(cm.delivered_at).getTime());

        const readChanged =
          wm.read_at &&
          (!cm.read_at ||
            new Date(wm.read_at).getTime() !== new Date(cm.read_at).getTime());

        if (statusChanged || deliveredChanged || readChanged) {
          updates.push({
            cm_id: cm.cm_id,
            status: wm.status,
            delivered_at: wm.delivered_at,
            read_at: wm.read_at,
          });
        }
      }

      /* -------------------------------------
         5. Apply updates
      ------------------------------------- */

      await Promise.all(
        updates.map((u) =>
          supabase
            .from("campaign_messages")
            .update({
              status: u.status,
              delivered_at: u.delivered_at,
              read_at: u.read_at,
              updated_at: new Date().toISOString(),
            })
            .eq("cm_id", u.cm_id),
        ),
      );

      // console.log("Updates to apply:", updates.length);

      totalUpdated += updates.length;
      offset += batchSize;
    }

    return res.status(200).json({
      success: true,
      updated: totalUpdated,
      message:
        totalUpdated > 0
          ? "Campaign messages synced successfully"
          : "No updates required",
    });
  } catch (err) {
    console.error("syncCampaignMessageStatus error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to sync campaign messages",
      details: err.message,
    });
  }
};
