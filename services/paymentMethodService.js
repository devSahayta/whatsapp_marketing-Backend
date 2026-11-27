// services/paymentMethodService.js
// Handles the Razorpay "Customer" link and the saved-card token lifecycle
// used by the Payment Details screen and (later) auto-reload / renewals.

import Razorpay from "razorpay";
import { supabase } from "../config/supabase.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * Every user who wants to save a payment method needs a Razorpay Customer
 * record first — tokens are always linked to a customer_id, never to a
 * user directly. Creates one once and caches the id on users.razorpay_customer_id.
 */
export const getOrCreateRazorpayCustomer = async (userId) => {
  const { data: user, error } = await supabase
    .from("users")
    .select("user_id, name, email, razorpay_customer_id")
    .eq("user_id", userId)
    .single();

  if (error || !user) throw new Error("User not found");
  if (user.razorpay_customer_id) return user.razorpay_customer_id;

  let customer;
  try {
    customer = await razorpay.customers.create({
      name: user.name || "Samvaadik User",
      email: user.email,
      notes: { userId },
    });
  } catch (err) {
    // Razorpay rejects creating a second customer with the same
    // email+contact combination for this merchant account. There's no
    // "search customers by email" API to fall back to, so this surfaces a
    // clear error instead of guessing an existing customer id. In practice
    // this should only ever run once per user (the first time they save a
    // payment method), so it should rarely hit.
    console.error("Razorpay customer create error:", err?.error || err);
    throw new Error(
      "Couldn't set up a billing profile with Razorpay. Please try again or contact support.",
    );
  }

  await supabase
    .from("users")
    .update({ razorpay_customer_id: customer.id })
    .eq("user_id", userId);

  return customer.id;
};

/**
 * Looks up a user's Razorpay customer id + default saved payment method
 * together — the two things every saved-card charge needs. Throws a clear
 * error if either is missing, instead of letting a caller half-build a
 * charge request against nothing.
 */
export const getDefaultSavedMethod = async (userId) => {
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("user_id, name, email, razorpay_customer_id")
    .eq("user_id", userId)
    .single();

  if (userError || !user?.razorpay_customer_id) {
    throw new Error("No billing profile on file for this user");
  }

  const { data: method, error: methodError } = await supabase
    .from("payment_methods")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .eq("is_default", true)
    .maybeSingle();

  if (methodError || !method) {
    throw new Error("No default saved payment method for this user");
  }

  return { user, method };
};

/**
 * Charges an ALREADY-CREATED Razorpay order against a user's saved default
 * token. Split out from chargeSavedPaymentMethod (below) so a caller that
 * needs its own order notes/receipt format (e.g. creditService's
 * credit_transactions bookkeeping) can create the order itself and just use
 * this for the actual charge step, instead of duplicating the token lookup.
 *
 * NOTE: Razorpay's recurring-charge API technically requires `email` and,
 * in some integrations, `contact` (phone number). The `users` table doesn't
 * currently store a phone number — if Razorpay rejects this call over a
 * missing `contact`, add a `phone` column to `users` and pass it here.
 */
export const chargeOrderWithSavedToken = async ({
  userId,
  order,
  description,
}) => {
  const { user, method } = await getDefaultSavedMethod(userId);

  return razorpay.payments.createRecurringPayment({
    email: user.email,
    amount: order.amount,
    currency: order.currency || "INR",
    order_id: order.id,
    customer_id: user.razorpay_customer_id,
    token: method.razorpay_token_id,
    recurring: true,
    description: description || "Samvaadik auto-charge",
  });
};

/**
 * Convenience wrapper for a one-off charge of an arbitrary amount — creates
 * its own generic order, then charges it via chargeOrderWithSavedToken.
 * Used by auto-reload/subscription-renewal logic (not called directly from
 * a route). Caller is responsible for crediting the user and recording a
 * credit_transactions row only after this resolves successfully.
 */
export const chargeSavedPaymentMethod = async ({
  userId,
  amountPaise,
  description,
}) => {
  const order = await razorpay.orders.create({
    amount: amountPaise,
    currency: "INR",
    payment_capture: 1,
    receipt: `auto_${Date.now()}`,
    notes: { userId, purpose: "saved_method_charge" },
  });

  const payment = await chargeOrderWithSavedToken({
    userId,
    order,
    description,
  });

  return { order, payment };
};
