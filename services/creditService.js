// services/creditService.js
// All business logic for the Samvaadik AI credit system:
//  - 1000 free credits granted once, on a user's first-ever paid subscription
//  - buying extra credits via Razorpay (fixed packages or a custom amount)
//  - a small ledger (credit_transactions) so every movement is auditable
//
// 1 credit = ₹1, flat — that's the only rate ever shown to users.
// All pricing math lives in config/creditConfig.js — nothing here hardcodes ₹.
// GST (18%) is added on top of the base credit price at charge time — see
// config/gstConfig.js, the single source of truth for that math.

import Razorpay from "razorpay";
import crypto from "crypto";
import { supabase } from "../config/supabase.js";
import { chargeOrderWithSavedToken } from "./paymentMethodService.js";
import { addGst } from "../config/gstConfig.js";
import {
  CREDIT_PACKAGES,
  PRICE_PER_CREDIT_RUPEES,
  FREE_CREDITS_ON_FIRST_SUBSCRIPTION,
  MIN_CUSTOM_CREDITS,
  MAX_CUSTOM_CREDITS,
  creditsToRupees,
  toPaise,
} from "../config/creditConfig.js";

import { maybeAutoReloadCredits } from "./autoPayService.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

export class InsufficientCreditsError extends Error {
  constructor(message = "Insufficient credits") {
    super(message);
    this.name = "InsufficientCreditsError";
  }
}

// ── Pricing info exposed to the frontend ────────────────────────────────────
export const getCreditPricing = () => ({
  pricePerCredit: PRICE_PER_CREDIT_RUPEES,
  minCustomCredits: MIN_CUSTOM_CREDITS,
  maxCustomCredits: MAX_CUSTOM_CREDITS,
  packages: CREDIT_PACKAGES,
});

// Quick balance read — used by the AI assistant to refuse a call up front
// instead of spending real API cost on a user who can't be charged for it.
export const getCreditBalance = async (userId) => {
  const user = await getUserOrThrow(userId);
  return Number(user.credits) || 0;
};

const assertValidCreditAmount = (credits) => {
  const n = Number(credits);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error("Credits must be a positive whole number");
  }
  if (n < MIN_CUSTOM_CREDITS || n > MAX_CUSTOM_CREDITS) {
    throw new Error(
      `Credits must be between ${MIN_CUSTOM_CREDITS} and ${MAX_CUSTOM_CREDITS}`,
    );
  }
  return n;
};

// ── Low-level helpers ────────────────────────────────────────────────────────

const getUserOrThrow = async (userId) => {
  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error || !user) throw new Error("User not found");
  return user;
};

/**
 * Adds (or subtracts, if negative) credits on a user's balance and writes a
 * ledger row. Not a real DB transaction (Supabase REST has none for this),
 * but each caller only ever calls this once per request, so the read-modify
 * write window is small and matches the rest of this codebase's style.
 */
const applyCreditDelta = async (userId, delta, ledgerEntry) => {
  const user = await getUserOrThrow(userId);
  const currentCredits = Number(user.credits) || 0;
  const newBalance = currentCredits + delta;

  if (newBalance < 0) {
    throw new InsufficientCreditsError();
  }

  const { data: updatedUser, error: updateError } = await supabase
    .from("users")
    .update({ credits: newBalance })
    .eq("user_id", userId)
    .select()
    .single();

  if (updateError) throw updateError;

  await supabase.from("credit_transactions").insert({
    user_id: userId,
    credits: delta,
    balance_after: newBalance,
    ...ledgerEntry,
  });

  return updatedUser;
};

// ── Free credits on first-ever subscription ─────────────────────────────────

/**
 * Grants FREE_CREDITS_ON_FIRST_SUBSCRIPTION once per user, no matter how many
 * times activateSubscription runs for them (new sub, renewal, or a race
 * between the webhook and the verify-payment call).
 *
 * No extra flag column on `users` — the guard is a unique index on
 * credit_transactions(user_id) WHERE type = 'subscription_bonus' (see the
 * SQL migration). We INSERT that ledger row first; Postgres itself rejects a
 * second insert for the same user, so only the caller that wins the race
 * gets to add the credits. The existing `users.credits` balance column is
 * reused as-is — same column the signup default (100) already writes to.
 */
export const grantFirstSubscriptionBonusIfEligible = async (userId) => {
  const { error: reserveError } = await supabase
    .from("credit_transactions")
    .insert({
      user_id: userId,
      type: "subscription_bonus",
      credits: FREE_CREDITS_ON_FIRST_SUBSCRIPTION,
      status: "completed",
      description: "Free credits for first Samvaadik subscription",
    });

  if (reserveError) {
    // 23505 = unique_violation -> bonus already granted for this user.
    if (reserveError.code === "23505") return null;
    console.error("Credit bonus reservation failed:", reserveError);
    return null;
  }

  // Reservation succeeded — this is genuinely the first time. Add the
  // credits to their balance and backfill balance_after on the row above.
  const user = await getUserOrThrow(userId);
  const newBalance =
    (Number(user.credits) || 0) + FREE_CREDITS_ON_FIRST_SUBSCRIPTION;

  const { data: updatedUser, error: updateError } = await supabase
    .from("users")
    .update({ credits: newBalance })
    .eq("user_id", userId)
    .select()
    .single();

  if (updateError) throw updateError;

  await supabase
    .from("credit_transactions")
    .update({ balance_after: newBalance })
    .eq("user_id", userId)
    .eq("type", "subscription_bonus");

  return updatedUser;
};

// ── Buying credits (Razorpay) ───────────────────────────────────────────────

/**
 * Creates a Razorpay order for a credit top-up.
 * `credits` must already be validated against the package list / custom
 * bounds — the price is always computed server-side from the credit count,
 * never trusted from the client. GST is added on top of the base credit
 * price so the order (and what we store) is the real, GST-inclusive total.
 */
export const createCreditOrder = async ({ userId, credits, packageId }) => {
  if (!userId) throw new Error("userId is required");

  let finalCredits;
  if (packageId) {
    const pkg = CREDIT_PACKAGES.find((p) => p.id === packageId);
    if (!pkg) throw new Error("Invalid credit package");
    finalCredits = pkg.credits;
  } else {
    finalCredits = assertValidCreditAmount(credits);
  }

  await getUserOrThrow(userId); // 404s cleanly if the user doesn't exist

  const baseAmountRupees = creditsToRupees(finalCredits);
  const baseAmountPaise = toPaise(baseAmountRupees);
  const amountPaise = addGst(baseAmountPaise); // GST added on top
  const amountRupees = amountPaise / 100;

  const order = await razorpay.orders.create({
    amount: amountPaise,
    currency: "INR",
    receipt: `credits_${Date.now()}`,
    notes: {
      userId,
      credits: String(finalCredits),
      type: "credit_purchase",
    },
  });

  await supabase.from("credit_transactions").insert({
    user_id: userId,
    type: "purchase",
    credits: finalCredits,
    amount_paid: amountRupees, // GST-inclusive — matches what's actually charged
    status: "created",
    razorpay_order_id: order.id,
    description: packageId
      ? `Credit purchase (${packageId} package)`
      : "Credit purchase (custom amount)",
  });

  return {
    order,
    credits: finalCredits,
    amountRupees, // GST-inclusive total — what the frontend should show as "you pay"
    baseAmountRupees, // pre-GST — for showing the breakdown
    amountPaise,
  };
};

const findPendingPurchaseByOrderId = async (razorpayOrderId) => {
  const { data, error } = await supabase
    .from("credit_transactions")
    .select("*")
    .eq("razorpay_order_id", razorpayOrderId)
    .eq("type", "purchase")
    .single();

  if (error || !data) return null;
  return data;
};

/**
 * Verifies the Razorpay checkout signature, then credits the user's balance.
 * Idempotent: if the transaction row is already 'paid' (e.g. the webhook won
 * the race), it just returns the current balance instead of crediting twice.
 */
export const verifyCreditPurchase = async ({
  razorpay_order_id,
  razorpay_payment_id,
  razorpay_signature,
}) => {
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    throw new Error("Missing Razorpay verification fields");
  }

  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  if (expectedSignature !== razorpay_signature) {
    throw new Error("Invalid signature");
  }

  const transaction = await findPendingPurchaseByOrderId(razorpay_order_id);
  if (!transaction) throw new Error("Credit order not found");

  if (transaction.status === "paid") {
    const user = await getUserOrThrow(transaction.user_id);
    return { credits: transaction.credits, balance: user.credits };
  }

  const { error: updateError } = await supabase
    .from("credit_transactions")
    .update({
      status: "paid",
      razorpay_payment_id,
      razorpay_signature,
    })
    .eq("transaction_id", transaction.transaction_id)
    .eq("status", "created"); // guards against a concurrent double-credit

  if (updateError) throw updateError;

  const updatedUser = await applyCreditDelta(
    transaction.user_id,
    transaction.credits,
    {
      type: "purchase",
      status: "completed",
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      amount_paid: transaction.amount_paid,
      description: "Credit purchase confirmed",
    },
  );

  return { credits: transaction.credits, balance: updatedUser.credits };
};

/**
 * Buys credits using the user's saved default payment method — no Razorpay
 * popup, no client-side signature to verify afterwards; the charge happens
 * synchronously on the server via the stored card token. Mirrors
 * createCreditOrder + verifyCreditPurchase's exact bookkeeping (same two
 * credit_transactions writes: the order row updated to 'paid', then a
 * separate 'completed' ledger row from applyCreditDelta) so this purchase
 * shows up in Billing History / invoice download identically to a normal
 * checkout purchase. GST is added on top here too, same as createCreditOrder.
 */
export const purchaseCreditsWithSavedMethod = async ({
  userId,
  credits,
  packageId,
}) => {
  if (!userId) throw new Error("userId is required");

  let finalCredits;
  if (packageId) {
    const pkg = CREDIT_PACKAGES.find((p) => p.id === packageId);
    if (!pkg) throw new Error("Invalid credit package");
    finalCredits = pkg.credits;
  } else {
    finalCredits = assertValidCreditAmount(credits);
  }

  await getUserOrThrow(userId); // 404s cleanly if the user doesn't exist

  const baseAmountRupees = creditsToRupees(finalCredits);
  const baseAmountPaise = toPaise(baseAmountRupees);
  const amountPaise = addGst(baseAmountPaise); // GST added on top
  const amountRupees = amountPaise / 100;

  const order = await razorpay.orders.create({
    amount: amountPaise,
    currency: "INR",
    payment_capture: 1,
    receipt: `credits_saved_${Date.now()}`,
    notes: {
      userId,
      credits: String(finalCredits),
      type: "credit_purchase",
    },
  });

  const { data: transaction, error: insertError } = await supabase
    .from("credit_transactions")
    .insert({
      user_id: userId,
      type: "purchase",
      credits: finalCredits,
      amount_paid: amountRupees,
      status: "created",
      razorpay_order_id: order.id,
      description: packageId
        ? `Credit purchase (${packageId} package) — saved card`
        : "Credit purchase (custom amount) — saved card",
    })
    .select()
    .single();

  if (insertError) throw insertError;

  let payment;
  try {
    payment = await chargeOrderWithSavedToken({
      userId,
      order,
      description: `Samvaadik credits — ${finalCredits} credits`,
    });
  } catch (chargeErr) {
    await supabase
      .from("credit_transactions")
      .update({ status: "failed" })
      .eq("transaction_id", transaction.transaction_id);

    throw new Error(
      chargeErr?.error?.description || chargeErr?.message || "Charge failed",
    );
  }

  await supabase
    .from("credit_transactions")
    .update({
      status: "paid",
      razorpay_payment_id: payment.id,
    })
    .eq("transaction_id", transaction.transaction_id)
    .eq("status", "created"); // guards against a concurrent double-credit

  const updatedUser = await applyCreditDelta(userId, finalCredits, {
    type: "purchase",
    status: "completed",
    razorpay_order_id: order.id,
    razorpay_payment_id: payment.id,
    amount_paid: amountRupees,
    description: `Credit purchase confirmed (saved card — ${finalCredits} credits)`,
  });

  return {
    credits: finalCredits,
    balance: updatedUser.credits,
    paymentId: payment.id,
    amountRupees,
  };
};

/**
 * Mirrors paymentController's razorpayWebhook, but for credit top-up orders.
 * Safe to call even if verifyCreditPurchase already handled this order.
 */
export const handleCreditPaymentCaptured = async (paymentEntity) => {
  const transaction = await findPendingPurchaseByOrderId(
    paymentEntity.order_id,
  );
  if (!transaction || transaction.status === "paid") return;

  const { error: updateError } = await supabase
    .from("credit_transactions")
    .update({
      status: "paid",
      razorpay_payment_id: paymentEntity.id,
    })
    .eq("transaction_id", transaction.transaction_id)
    .eq("status", "created");

  if (updateError) throw updateError;

  await applyCreditDelta(transaction.user_id, transaction.credits, {
    type: "purchase",
    status: "completed",
    razorpay_order_id: paymentEntity.order_id,
    razorpay_payment_id: paymentEntity.id,
    amount_paid: transaction.amount_paid,
    description: "Credit purchase confirmed (webhook)",
  });
};

// ── Spending credits ─────────────────────────────────────────────────────────
// Called by handleSamvaadikChat (controllers/agentController.js) after every
// Samvaadik AI Assistant turn, for the doubled real cost of that turn's
// Anthropic usage. See realRupeesToCredits() in config/creditConfig.js.
//
// FIX: previously referenced an undefined `updatedUser` before the deduction
// even ran, throwing a ReferenceError on every call. Now the deduction runs
// first, and the auto-reload check fires off its result afterwards.
export const deductCredits = async (userId, amount, description) => {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("Deduction amount must be a positive number");
  }

  const updatedUser = await applyCreditDelta(userId, -n, {
    type: "deduction",
    status: "completed",
    description: description || "Credit usage",
  });

  // Fire-and-forget: check low-balance auto-reload using the post-deduction
  // balance. Never blocks or fails the deduction itself.
  maybeAutoReloadCredits(userId, updatedUser.credits).catch(() => {});

  return updatedUser;
};
