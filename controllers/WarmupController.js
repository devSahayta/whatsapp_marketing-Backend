// controllers/WarmupController.js - COMPLETE WITH POST-WARMUP TIER LIMITS
// Handles warm-up stages AND tier daily limits after completion

import { supabase } from "../config/supabase.js";
import { requiresWarmup, getWarmupLimits } from "../utils/warmupHelper.js";

/**
 * Check if daily counter needs reset (new day)
 */
// function shouldResetDailyCounter(last_reset) {
//   if (!last_reset) return true;

//   const now = new Date();
//   const lastReset = new Date(last_reset);

//   // Reset if last reset was on a different day (UTC)
//   const nowDay = now.toISOString().split("T")[0];
//   const lastResetDay = lastReset.toISOString().split("T")[0];

//   return nowDay !== lastResetDay;
// }

// /**
//  * Reset daily counter if needed
//  */
// async function resetDailyCounterIfNeeded(account_id, account) {
//   if (shouldResetDailyCounter(account.warmup_daily_reset_at)) {
//     console.log("🔄 Resetting daily counter (new day)");

//     await supabase
//       .from("whatsapp_accounts")
//       .update({
//         warmup_daily_sent: 0,
//         warmup_daily_reset_at: new Date().toISOString(),
//       })
//       .eq("wa_id", account_id);

//     return 0; // Return reset count
//   }

//   return account.warmup_daily_sent || 0;
// }

/**
 * Validate warm-up OR tier daily limit
 * Works during warm-up AND after warm-up completion
 */
export const validateWarmup = async (req, res) => {
  try {
    const { account_id, contact_count } = req.body;

    if (!account_id || !contact_count) {
      return res.status(400).json({
        success: false,
        error: "account_id and contact_count are required",
      });
    }

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

    // ✅ ALWAYS RESET DAILY COUNTER IF NEW DAY
    const daily_sent = account.warmup_daily_sent || 0;

    // ========================================
    // CASE 1: TIER DOESN'T REQUIRE WARM-UP (Tier 10K+)
    // ========================================
    if (!requiresWarmup(account.messaging_limit_tier)) {
      const tier_daily_limit = account.messaging_limit_per_day;
      const daily_remaining = tier_daily_limit - daily_sent;

      // Still check tier daily limit
      if (contact_count > daily_remaining) {
        return res.json({
          success: true,
          warmup_required: false,
          can_send: false,
          tier: account.messaging_limit_tier,
          tier_daily_limit,
          daily_sent,
          daily_remaining,
          contact_count,
          message: `⚠️ Daily Tier Limit\n\nYour tier (${account.messaging_limit_tier}) allows ${tier_daily_limit} messages per day.\n\nToday's usage: ${daily_sent}/${tier_daily_limit}\nRemaining: ${daily_remaining}\nYour campaign: ${contact_count}\n\nReduce to ${daily_remaining} or wait until tomorrow.`,
          suggestion:
            daily_remaining > 0
              ? `Reduce to ${daily_remaining} contacts`
              : "Daily limit reached. Resets at midnight UTC.",
        });
      }

      return res.json({
        success: true,
        warmup_required: false,
        can_send: true,
        tier: account.messaging_limit_tier,
        tier_daily_limit,
        daily_sent: daily_sent + contact_count,
        daily_remaining: daily_remaining - contact_count,
        contact_count,
        message: `✅ You can send ${contact_count} contacts.\n\nTier limit: ${tier_daily_limit}/day\nAfter campaign: ${daily_sent + contact_count}/${tier_daily_limit}`,
      });
    }

    // ========================================
    // CASE 2: WARM-UP DISABLED
    // ========================================
    if (!account.warmup_enabled) {
      const tier_daily_limit = account.messaging_limit_per_day;
      const daily_remaining = tier_daily_limit - daily_sent;

      if (contact_count > daily_remaining) {
        return res.json({
          success: true,
          warmup_required: false,
          can_send: false,
          tier: account.messaging_limit_tier,
          tier_daily_limit,
          daily_sent,
          daily_remaining,
          message: `Daily tier limit: ${daily_sent}/${tier_daily_limit}. Remaining: ${daily_remaining}.`,
        });
      }

      return res.json({
        success: true,
        warmup_required: false,
        can_send: true,
        tier_daily_limit,
        message: "Warm-up disabled. Tier limit applies.",
      });
    }

    // ========================================
    // CASE 3: WARM-UP COMPLETED - CHECK TIER LIMIT
    // ========================================
    // Case 3: Warm-up completed - check tier daily limit
    if (account.warmup_completed) {
      const tierDailyLimit = account.messaging_limit_per_day || 0;
      const tierDailySent = account.tier_daily_sent || 0;

      // Reset daily counter if new day
      // const now = new Date();
      // const lastResetDate = account.tier_daily_reset_at
      //   ? new Date(account.tier_daily_reset_at).toISOString().split("T")[0]
      //   : null;
      // const todayDate = now.toISOString().split("T")[0];

      // let currentTierDailySent = tierDailySent;

      // if (!lastResetDate || lastResetDate !== todayDate) {
      //   // New day - reset counter
      //   console.log(`🔄 Resetting tier daily counter (new day)`);
      //   currentTierDailySent = 0;

      //   // Update in database
      //   await supabase
      //     .from("whatsapp_accounts")
      //     .update({
      //       tier_daily_sent: 0,
      //       tier_daily_reset_at: now.toISOString(),
      //     })
      //     .eq("wa_id", account_id);
      // }
      const currentTierDailySent = account.tier_daily_sent || 0;
      const dailyRemaining = tierDailyLimit - currentTierDailySent;

      // Check if campaign exceeds tier limit
      if (contact_count > dailyRemaining) {
        return res.status(200).json({
          success: true,
          warmup_required: false,
          warmup_completed: true,
          can_send: false,
          blocked_by: "tier_limit",
          tier_daily_limit: tierDailyLimit,
          tier_daily_sent: currentTierDailySent,
          daily_remaining: dailyRemaining,
          contact_count,
          tier: account.messaging_limit_tier,
          message: `⚠️ Daily Tier Limit Exceeded!\n\n✅ Warm-up completed!\n\nYour tier (${account.messaging_limit_tier}) allows ${tierDailyLimit.toLocaleString()} messages per day.\n\nToday's usage: ${currentTierDailySent.toLocaleString()}/${tierDailyLimit.toLocaleString()}\nRemaining: ${dailyRemaining.toLocaleString()}\nYour campaign: ${contact_count.toLocaleString()}\n\nTo proceed:\n• Reduce campaign to ${dailyRemaining.toLocaleString()} contacts\n• Wait until tomorrow (resets at midnight UTC)`,
          suggestion:
            dailyRemaining > 0
              ? `Reduce campaign to ${dailyRemaining.toLocaleString()} contacts`
              : "Daily limit reached. Resets at midnight UTC.",
        });
      }

      // Within tier limit
      return res.status(200).json({
        success: true,
        warmup_required: false,
        warmup_completed: true,
        can_send: true,
        tier_daily_limit: tierDailyLimit,
        tier_daily_sent: currentTierDailySent,
        daily_remaining: dailyRemaining - contact_count,
        contact_count,
        tier: account.messaging_limit_tier,
        message: `✅ Warm-up completed!\n\nTier limit check:\nCurrent: ${currentTierDailySent.toLocaleString()}/${tierDailyLimit.toLocaleString()}\nAfter campaign: ${(currentTierDailySent + contact_count).toLocaleString()}/${tierDailyLimit.toLocaleString()}\n\nYou can send this campaign.`,
      });
    }
    // ========================================
    // CASE 4: WARM-UP ACTIVE - CHECK WARM-UP LIMITS
    // ========================================
    console.log("🔥 Warm-up active - checking warm-up limits");

    const warmup_limits =
      account.warmup_limits || getWarmupLimits(account.messaging_limit_tier);
    const current_stage = account.warmup_stage || 1;
    const current_stage_limit = warmup_limits[current_stage - 1];
    const stage_progress = account.warmup_stage_progress || 0;

    // ✅ CHECK 1: DAILY LIMIT (most restrictive)
    const daily_remaining = current_stage_limit - daily_sent;

    if (contact_count > daily_remaining) {
      return res.json({
        success: true,
        warmup_required: true,
        can_send: false,
        blocked_by: "daily_limit",
        current_stage,
        current_stage_limit,
        daily_limit: current_stage_limit,
        daily_sent,
        daily_remaining,
        contact_count,
        warmup_limits,
        tier: account.messaging_limit_tier,
        message: `⚠️ Daily Limit Reached!\n\nWarm-up Stage ${current_stage} allows ${current_stage_limit} messages per day.\n\nToday's usage: ${daily_sent}/${current_stage_limit}\nRemaining today: ${daily_remaining}\nYour campaign: ${contact_count}\n\nYou can send ${daily_remaining} more contacts today, or wait until tomorrow.`,
        suggestion:
          daily_remaining > 0
            ? `Reduce campaign to ${daily_remaining} contacts or split into multiple days`
            : `Daily limit reached. Counter resets at midnight UTC.`,
      });
    }

    // ✅ CHECK 2: STAGE LIMIT (for stage progression)
    const stage_remaining = current_stage_limit - stage_progress;

    if (contact_count > stage_remaining) {
      return res.json({
        success: true,
        warmup_required: true,
        can_send: false,
        blocked_by: "stage_limit",
        current_stage,
        current_stage_limit,
        stage_progress,
        stage_remaining,
        contact_count,
        warmup_limits,
        tier: account.messaging_limit_tier,
        message: `⚠️ Warm-up Stage ${current_stage}: Maximum ${current_stage_limit} contacts for stage completion.\n\nStage progress: ${stage_progress}/${current_stage_limit}\nRemaining to complete stage: ${stage_remaining}\nYour campaign: ${contact_count}\n\nNote: You've sent ${daily_sent} messages today.`,
        suggestion: `Reduce to ${stage_remaining} contacts to complete Stage ${current_stage}`,
      });
    }

    // ✅ ALL CHECKS PASSED
    return res.json({
      success: true,
      warmup_required: true,
      can_send: true,
      current_stage,
      current_stage_limit,
      stage_progress,
      daily_sent,
      daily_remaining,
      contact_count,
      warmup_limits,
      tier: account.messaging_limit_tier,
      message: `✅ Warm-up Stage ${current_stage}: You can send ${contact_count} contacts.\n\nDaily: ${daily_sent + contact_count}/${current_stage_limit}\nStage: ${stage_progress + contact_count}/${current_stage_limit}`,
      next_stage_info:
        current_stage < warmup_limits.length
          ? `After ${current_stage_limit} total messages, unlock Stage ${current_stage + 1} (${warmup_limits[current_stage]}/day)`
          : "Final warm-up stage!",
    });
  } catch (error) {
    console.error("Error validating warm-up:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to validate warm-up",
      details: error.message,
    });
  }
};

/**
 * Update warm-up progress OR daily counter
 * Works during warm-up AND after completion
 */
export const updateWarmupProgress = async (account_id, messages_sent) => {
  try {
    const { data: account, error: accountError } = await supabase
      .from("whatsapp_accounts")
      .select("*")
      .eq("wa_id", account_id)
      .single();

    if (accountError || !account) {
      return { success: false, error: "Account not found" };
    }

    // ✅ RESET DAILY COUNTER IF NEW DAY
    const current_daily_sent = account.warmup_daily_sent || 0;
    const new_daily_sent = current_daily_sent + messages_sent;

    // ========================================
    // CASE 1: WARM-UP COMPLETED - Just update daily counter
    // ========================================
    if (
      account.warmup_completed ||
      !account.warmup_enabled ||
      !requiresWarmup(account.messaging_limit_tier)
    ) {
      await supabase
        .from("whatsapp_accounts")
        .update({
          warmup_daily_sent: new_daily_sent,
          warmup_last_updated_at: new Date().toISOString(),
        })
        .eq("wa_id", account_id);

      const tier_limit = account.messaging_limit_per_day;
      const remaining = tier_limit - new_daily_sent;

      console.log(
        `📊 Daily counter updated: ${new_daily_sent}/${tier_limit} (${remaining} remaining)`,
      );

      return {
        success: true,
        warmup_completed: true,
        daily_sent: new_daily_sent,
        tier_limit,
        daily_remaining: remaining,
        message: `Daily usage: ${new_daily_sent}/${tier_limit}`,
      };
    }

    // ========================================
    // CASE 2: WARM-UP ACTIVE - Update both stage and daily
    // ========================================
    const warmup_limits =
      account.warmup_limits || getWarmupLimits(account.messaging_limit_tier);
    const current_stage = account.warmup_stage || 1;
    const current_limit = warmup_limits[current_stage - 1];
    const new_stage_progress =
      (account.warmup_stage_progress || 0) + messages_sent;

    console.log(`📊 Warm-up Update:`);
    console.log(
      `   Stage ${current_stage}: ${new_stage_progress}/${current_limit}`,
    );
    console.log(`   Daily: ${new_daily_sent}/${current_limit}`);

    // Check if stage completed
    if (new_stage_progress >= current_limit) {
      if (current_stage < warmup_limits.length) {
        // Move to next stage
        await supabase
          .from("whatsapp_accounts")
          .update({
            warmup_stage: current_stage + 1,
            warmup_stage_progress: 0,
            warmup_daily_sent: new_daily_sent,
            warmup_last_updated_at: new Date().toISOString(),
          })
          .eq("wa_id", account_id);

        console.log(`✅ Stage ${current_stage} COMPLETED!`);
        console.log(
          `   Advanced to Stage ${current_stage + 1} (${warmup_limits[current_stage]}/day)`,
        );

        return {
          success: true,
          stage_completed: true,
          new_stage: current_stage + 1,
          new_limit: warmup_limits[current_stage],
          daily_sent: new_daily_sent,
          message: `Stage ${current_stage} completed! Now at Stage ${current_stage + 1}`,
        };
      } else {
        // Warm-up completed! Continue tracking daily for tier limit
        await supabase
          .from("whatsapp_accounts")
          .update({
            warmup_completed: true,
            warmup_daily_sent: new_daily_sent,
            warmup_last_updated_at: new Date().toISOString(),
          })
          .eq("wa_id", account_id);

        console.log(`🏆 WARM-UP COMPLETED!`);
        console.log(
          `   Will now enforce tier limit: ${account.messaging_limit_per_day}/day`,
        );

        return {
          success: true,
          warmup_completed: true,
          tier_limit: account.messaging_limit_per_day,
          daily_sent: new_daily_sent,
          message: "Warm-up completed! Tier limit now applies.",
        };
      }
    } else {
      // Update both counters
      await supabase
        .from("whatsapp_accounts")
        .update({
          warmup_stage_progress: new_stage_progress,
          warmup_daily_sent: new_daily_sent,
          warmup_last_updated_at: new Date().toISOString(),
        })
        .eq("wa_id", account_id);

      const stage_remaining = current_limit - new_stage_progress;
      const daily_remaining = current_limit - new_daily_sent;

      console.log(`📈 Stage: ${stage_remaining} to next stage`);
      console.log(`📅 Daily: ${daily_remaining} remaining today`);

      return {
        success: true,
        progress_updated: true,
        stage_progress: new_stage_progress,
        daily_sent: new_daily_sent,
        stage_remaining,
        daily_remaining,
      };
    }
  } catch (error) {
    console.error("Error updating warm-up progress:", error);
    return { success: false, error: error.message };
  }
};

/**
 * Get warm-up status
 */
export const getWarmupStatus = async (req, res) => {
  try {
    const { account_id } = req.query;

    if (!account_id) {
      return res.status(400).json({
        success: false,
        error: "account_id is required",
      });
    }

    const { data: account, error } = await supabase
      .from("whatsapp_accounts")
      .select("*")
      .eq("wa_id", account_id)
      .single();

    if (error || !account) {
      return res.status(404).json({
        success: false,
        error: "Account not found",
      });
    }

    // Reset daily counter if needed
    const daily_sent = account.warmup_daily_sent || 0;

    const tier_requires_warmup = requiresWarmup(account.messaging_limit_tier);
    const warmup_active =
      tier_requires_warmup &&
      account.warmup_enabled &&
      !account.warmup_completed;

    // Determine current daily limit
    let current_daily_limit;
    if (warmup_active) {
      const warmup_limits =
        account.warmup_limits || getWarmupLimits(account.messaging_limit_tier);
      const current_stage = account.warmup_stage || 1;
      current_daily_limit = warmup_limits[current_stage - 1];
    } else {
      current_daily_limit = account.messaging_limit_per_day;
    }

    return res.json({
      success: true,
      data: {
        tier: account.messaging_limit_tier,
        tier_requires_warmup,
        warmup_enabled: account.warmup_enabled,
        warmup_completed: account.warmup_completed,
        warmup_active,
        current_stage: warmup_active ? account.warmup_stage || 1 : null,
        current_daily_limit,
        warmup_limits: warmup_active
          ? account.warmup_limits ||
            getWarmupLimits(account.messaging_limit_tier)
          : null,
        stage_progress: warmup_active
          ? account.warmup_stage_progress || 0
          : null,
        daily_sent,
        daily_remaining: current_daily_limit - daily_sent,
        tier_daily_limit: account.messaging_limit_per_day,
        quality_rating: account.quality_rating,
        last_updated: account.warmup_last_updated_at,
      },
    });
  } catch (error) {
    console.error("Error getting warm-up status:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to get warm-up status",
    });
  }
};

/**
 * Update warm-up limits based on tier (admin function)
 */
export const updateWarmupLimits = async (req, res) => {
  try {
    const { account_id } = req.body;

    if (!account_id) {
      return res.status(400).json({
        success: false,
        error: "account_id is required",
      });
    }

    const { data: account, error: accountError } = await supabase
      .from("whatsapp_accounts")
      .select("*")
      .eq("wa_id", account_id)
      .single();

    if (accountError || !account) {
      return res.status(404).json({
        success: false,
        error: "Account not found",
      });
    }

    // Check if tier requires warm-up
    if (!requiresWarmup(account.messaging_limit_tier)) {
      const { error: updateError } = await supabase
        .from("whatsapp_accounts")
        .update({
          warmup_enabled: false,
          warmup_completed: true,
          warmup_limits: null,
        })
        .eq("wa_id", account_id);

      if (updateError) {
        return res.status(500).json({
          success: false,
          error: "Failed to disable warm-up",
        });
      }

      return res.json({
        success: true,
        data: {
          account_id,
          tier: account.messaging_limit_tier,
          warmup_enabled: false,
          message: `Warm-up disabled for ${account.messaging_limit_tier}`,
        },
      });
    }

    // Get warm-up limits for tier
    const new_warmup_limits = getWarmupLimits(account.messaging_limit_tier);

    if (!new_warmup_limits) {
      return res.status(400).json({
        success: false,
        error: `No warm-up limits defined for ${account.messaging_limit_tier}`,
      });
    }

    // Enable warm-up with correct limits
    const { error: updateError } = await supabase
      .from("whatsapp_accounts")
      .update({
        warmup_enabled: true,
        warmup_limits: JSON.stringify(new_warmup_limits),
        warmup_last_updated_at: new Date().toISOString(),
      })
      .eq("wa_id", account_id);

    if (updateError) {
      return res.status(500).json({
        success: false,
        error: "Failed to update warm-up limits",
      });
    }

    return res.json({
      success: true,
      data: {
        account_id,
        tier: account.messaging_limit_tier,
        warmup_enabled: true,
        new_limits: new_warmup_limits,
        message: `Warm-up enabled for ${account.messaging_limit_tier}`,
      },
    });
  } catch (error) {
    console.error("Error updating warm-up limits:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to update warm-up limits",
    });
  }
};

export default {
  validateWarmup,
  updateWarmupProgress,
  getWarmupStatus,
  updateWarmupLimits,
};
