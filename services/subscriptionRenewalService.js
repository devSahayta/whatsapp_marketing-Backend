//services/subscriptionRenewalService.js

import Razorpay from "razorpay";
import { supabase } from "../config/supabase.js";
import { activateSubscription } from "./subscriptionService.js";
import {
  chargeOrderWithSavedToken,
  getDefaultSavedMethod,
} from "./paymentMethodService.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// How far ahead of expiry the cron is allowed to renew a subscription.
export const RENEWAL_WINDOW_DAYS = 1;

// Shared core: charge the user's default saved card for one `plan`, then run
// it through the exact same activateSubscription() that a manual
// Razorpay-checkout payment uses — so this extends end_date (or creates a
// fresh subscription if none exists), updates users.current_subscription_id,
// and re-checks the first-subscription bonus exactly like a real payment
// would. Used by both renewal (plan comes from the existing subscription)
// and a user-initiated "pay with saved card" subscribe (plan comes from
// whichever plan card they clicked).
const chargeAndActivatePlan = async (
  userId,
  plan,
  { receiptPrefix = "sub" } = {},
) => {
  // Fail fast, before creating any order, if there's no default saved
  // card — mirrors the guard used for credit auto-reload.
  await getDefaultSavedMethod(userId);

  const order = await razorpay.orders.create({
    amount: plan.price,
    currency: "INR",
    receipt: `${receiptPrefix}_${Date.now()}`,
    notes: { userId, planId: plan.plan_id, type: "subscription_saved_card" },
  });

  const { data: payment, error: insertErr } = await supabase
    .from("payments")
    .insert({
      user_id: userId,
      plan_id: plan.plan_id,
      amount: plan.price,
      razorpay_order_id: order.id,
      status: "created",
    })
    .select()
    .single();

  if (insertErr) throw insertErr;

  let razorpayPayment;
  try {
    razorpayPayment = await chargeOrderWithSavedToken({
      userId,
      order,
      description: `Samvaadik ${plan.name || "subscription"}`,
    });
  } catch (chargeErr) {
    await supabase
      .from("payments")
      .update({ status: "failed" })
      .eq("payment_id", payment.payment_id);
    throw new Error(
      chargeErr?.error?.description || chargeErr?.message || "Charge failed",
    );
  }

  await supabase
    .from("payments")
    .update({
      razorpay_payment_id: razorpayPayment.id,
      status: "paid",
      paid_at: new Date(),
    })
    .eq("payment_id", payment.payment_id);

  const subscription = await activateSubscription(
    userId,
    plan,
    payment.payment_id,
  );

  return { subscription, paymentId: razorpayPayment.id };
};

// Renews one user's existing (active-or-lapsed) subscription, keeping it on
// whatever plan it's already on. Used by the cron / auto-renewal path.
export const renewSubscriptionWithSavedMethod = async (userId) => {
  if (!userId) throw new Error("userId is required");

  const { data: sub, error: subErr } = await supabase
    .from("subscriptions")
    .select("*, plans(*)")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .maybeSingle();

  if (subErr) throw subErr;
  if (!sub) throw new Error("No active subscription found for this user");

  const plan = sub.plans;
  if (!plan) throw new Error("Subscription has no linked plan");

  const result = await chargeAndActivatePlan(userId, plan, {
    receiptPrefix: "renewal",
  });

  await supabase
    .from("auto_pay_settings")
    .update({ last_subscription_renewal_at: new Date().toISOString() })
    .eq("user_id", userId);

  return result;
};

// User-initiated: subscribe to a SPECIFIC plan (the one they clicked on the
// pricing page) using their saved card — no Razorpay popup. Unlike
// renewSubscriptionWithSavedMethod, this doesn't require an existing
// subscription row at all; it works for a true first-time subscriber who
// already has a saved card, and for anyone whose subscription lapsed.
// activateSubscription() itself already handles all three cases (extend an
// active sub, restart an expired one, or create a brand-new one).
export const subscribeToPlanWithSavedMethod = async ({ userId, planId }) => {
  if (!userId) throw new Error("userId is required");
  if (!planId) throw new Error("planId is required");

  const { data: plan, error: planErr } = await supabase
    .from("plans")
    .select("*")
    .eq("plan_id", planId)
    .eq("is_active", true)
    .single();

  if (planErr || !plan) throw new Error("Invalid plan");

  return chargeAndActivatePlan(userId, plan, { receiptPrefix: "subscribe" });
};

// Cron entrypoint. Deliberately processes at most `batchSize` renewals per
// call (default 1) and nothing more — this runs as a Vercel serverless
// function with a hard execution-time limit (as low as 10s on some plans),
// and each renewal does a real Razorpay order + charge + several DB writes.
// Looping over every due subscription in one request risks the function
// being killed mid-renewal, which could strand a payment row in
// "created" status. Instead: call this endpoint frequently (every 10-15
// min) from an external scheduler; each call picks off the single oldest
// subscription still due, so a handful of same-day renewals just get
// processed one per call over the next few minutes, never all at once.
export const runSubscriptionAutoRenewals = async (batchSize = 1) => {
  const windowEnd = new Date();
  windowEnd.setDate(windowEnd.getDate() + RENEWAL_WINDOW_DAYS);

  const { data: subs, error } = await supabase
    .from("subscriptions")
    .select("subscription_id, user_id, end_date")
    .eq("status", "active")
    .lte("end_date", windowEnd.toISOString())
    .order("end_date", { ascending: true })
    .limit(Math.max(1, Math.min(batchSize, 5))); // hard safety cap regardless of input

  if (error) throw error;
  if (!subs || subs.length === 0) return [];

  const userIds = subs.map((s) => s.user_id);

  // Separate query rather than an embedded join — there's no foreign key
  // between subscriptions and auto_pay_settings for PostgREST to infer.
  const { data: settingsRows, error: settingsErr } = await supabase
    .from("auto_pay_settings")
    .select("user_id, enabled, last_subscription_renewal_at")
    .in("user_id", userIds)
    .eq("enabled", true);

  if (settingsErr) throw settingsErr;

  const settingsByUser = new Map(
    (settingsRows || []).map((s) => [s.user_id, s]),
  );

  const results = [];

  for (const sub of subs) {
    const settings = settingsByUser.get(sub.user_id);
    if (!settings) continue; // auto-reload not enabled for this user

    // Guard against renewing twice if the cron fires more than once
    // before the extended end_date takes effect.
    if (settings.last_subscription_renewal_at) {
      const hoursSince =
        (Date.now() -
          new Date(settings.last_subscription_renewal_at).getTime()) /
        (1000 * 60 * 60);
      if (hoursSince < 20) continue;
    }

    try {
      const result = await renewSubscriptionWithSavedMethod(sub.user_id);
      results.push({ userId: sub.user_id, success: true, ...result });
    } catch (err) {
      console.error(
        `Auto-renewal failed for user ${sub.user_id}:`,
        err.message,
      );
      await supabase.from("subscription_renewal_failures").insert({
        user_id: sub.user_id,
        subscription_id: sub.subscription_id,
        reason: err.message || "Unknown error",
      });
      results.push({
        userId: sub.user_id,
        success: false,
        reason: err.message,
      });
    }
  }

  return results;
};
