import { supabase } from "../config/supabase.js";
import { grantFirstSubscriptionBonusIfEligible } from "./creditService.js";

/**
 * Create or Extend Subscription
 */
export const activateSubscription = async (userId, plan, paymentId) => {
  const now = new Date();

  // 1️⃣ Check existing subscription
  const { data: existingSub, error: fetchError } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (fetchError) throw fetchError;

  let startDate;
  let endDate;
  let subscription;

  if (existingSub) {
    const currentEnd = new Date(existingSub.end_date);

    // 2️⃣ If subscription still active → extend
    if (currentEnd > now) {
      startDate = new Date(existingSub.start_date);
      endDate = new Date(currentEnd);
      endDate.setMonth(endDate.getMonth() + plan.duration_months);
    } else {
      // 3️⃣ If expired → restart
      startDate = now;
      endDate = new Date(now);
      endDate.setMonth(endDate.getMonth() + plan.duration_months);
    }

    // UPDATE existing row
    const { data: updatedSub, error } = await supabase
      .from("subscriptions")
      .update({
        plan_id: plan.plan_id,
        start_date: startDate,
        end_date: endDate,
        status: "active",
        payment_id: paymentId, // Link payment to subscription
      })
      .eq("subscription_id", existingSub.subscription_id)
      .select()
      .single();

    if (error) throw error;

    subscription = updatedSub;
  } else {
    // 4️⃣ No subscription → create new
    startDate = now;
    endDate = new Date(now);
    endDate.setMonth(endDate.getMonth() + plan.duration_months);

    const { data: newSub, error } = await supabase
      .from("subscriptions")
      .insert({
        user_id: userId,
        plan_id: plan.plan_id,
        start_date: startDate,
        end_date: endDate,
        status: "active",
        payment_id: paymentId, // Link payment to subscription
      })
      .select()
      .single();

    if (error) throw error;

    subscription = newSub;
  }

  // 5️⃣ Update user pointer
  await supabase
    .from("users")
    .update({
      current_subscription_id: subscription.subscription_id,
    })
    .eq("user_id", userId);

  // 6️⃣ One-time 1000 free AI credits for a user's first-ever subscription.
  // Guarded atomically inside creditService so it never double-grants, even
  // if this runs for both a renewal and a brand-new subscriber, or if the
  // Razorpay webhook and the verify-payment call race each other.
  try {
    await grantFirstSubscriptionBonusIfEligible(userId);
  } catch (err) {
    // Never let a credit-bonus hiccup block subscription activation itself.
    console.error("Free credit bonus grant failed:", err);
  }

  return subscription;
};
