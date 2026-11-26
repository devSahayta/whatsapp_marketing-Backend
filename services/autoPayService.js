//services/autoPayService.js

import { supabase } from "../config/supabase.js";

export const DEFAULT_LOW_CREDIT_THRESHOLD = 100;
export const DEFAULT_RELOAD_CREDITS = 500;

export const getAutoPaySettings = async (userId) => {
  if (!userId) throw new Error("userId is required");

  const { data, error } = await supabase
    .from("auto_pay_settings")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;

  return (
    data || {
      user_id: userId,
      enabled: false,
      low_credit_threshold: DEFAULT_LOW_CREDIT_THRESHOLD,
      reload_credits: DEFAULT_RELOAD_CREDITS,
      last_credit_reload_at: null,
      last_subscription_renewal_at: null,
    }
  );
};

// Single toggle. Turning it on requires a default saved card to already
// exist — same way Claude Console's "Set up auto-reload" only makes sense
// once a payment method is on file.
export const setAutoPaySettings = async (
  userId,
  { enabled, lowCreditThreshold, reloadCredits },
) => {
  if (!userId) throw new Error("userId is required");

  if (enabled) {
    const { data: method, error: methodErr } = await supabase
      .from("payment_methods")
      .select("payment_method_id")
      .eq("user_id", userId)
      .eq("is_default", true)
      .eq("status", "active")
      .maybeSingle();

    if (methodErr) throw methodErr;
    if (!method) {
      throw new Error(
        "Add a default payment method before enabling auto-reload.",
      );
    }
  }

  const threshold = Number(lowCreditThreshold);
  const reload = Number(reloadCredits);

  const payload = {
    user_id: userId,
    enabled: Boolean(enabled),
    low_credit_threshold:
      Number.isFinite(threshold) && threshold > 0
        ? threshold
        : DEFAULT_LOW_CREDIT_THRESHOLD,
    reload_credits:
      Number.isFinite(reload) && reload > 0 ? reload : DEFAULT_RELOAD_CREDITS,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("auto_pay_settings")
    .upsert(payload, { onConflict: "user_id" })
    .select()
    .single();

  if (error) throw error;
  return data;
};

// Call this right after any credit deduction, with the user's *new*
// balance. Fire-and-forget by design — never throws, never blocks the
// deduction that triggered it. Dynamic import of creditService avoids a
// circular import (creditService -> autoPayService -> creditService).
export const maybeAutoReloadCredits = async (userId, newBalance) => {
  try {
    if (!userId || newBalance == null) return;

    const settings = await getAutoPaySettings(userId);
    if (!settings.enabled) return;
    if (newBalance >= settings.low_credit_threshold) return;

    const { purchaseCreditsWithSavedMethod } =
      await import("./creditService.js");

    await purchaseCreditsWithSavedMethod({
      userId,
      credits: settings.reload_credits,
    });

    await supabase
      .from("auto_pay_settings")
      .update({ last_credit_reload_at: new Date().toISOString() })
      .eq("user_id", userId);
  } catch (err) {
    console.error(`Auto-reload failed for user ${userId}:`, err.message);
    try {
      await supabase.from("auto_reload_failures").insert({
        user_id: userId,
        attempted_credits: null,
        reason: err?.message || "Unknown error",
      });
    } catch (logErr) {
      console.error("Failed to log auto-reload failure:", logErr.message);
    }
  }
};
