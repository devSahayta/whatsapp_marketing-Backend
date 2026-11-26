// controllers/paymentMethodController.js
// "Payment Details" backend: save a card via a refundable ₹1 authorization
// (standard card-tokenization pattern), list/set-default/delete it.
// Deliberately decoupled from the subscription/credit checkout flow in
// paymentController.js — this never touches createOrder/verifyPayment.

import Razorpay from "razorpay";
import crypto from "crypto";
import { supabase } from "../config/supabase.js";
import { getOrCreateRazorpayCustomer } from "../services/paymentMethodService.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// A ₹1 authorization used ONLY to securely tokenize a card with Razorpay.
// It is refunded immediately after the token is captured — the user is
// never actually charged ₹1 (shows as a brief hold, same as hotels/car
// rentals do for card verification).
const CARD_AUTH_AMOUNT_PAISE = 100;

export const createCardAuthOrder = async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }

    const customerId = await getOrCreateRazorpayCustomer(userId);

    const order = await razorpay.orders.create({
      amount: CARD_AUTH_AMOUNT_PAISE,
      currency: "INR",
      payment_capture: 1,
      receipt: `card_auth_${Date.now()}`,
      notes: { userId, purpose: "card_authorization" },
    });

    res.json({ order, customerId, amount: CARD_AUTH_AMOUNT_PAISE });
  } catch (err) {
    console.error("Create Card Auth Order Error:", err);
    res
      .status(500)
      .json({ message: err.message || "Failed to start card setup" });
  }
};

export const verifyCardAuthorization = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      userId,
    } = req.body;

    if (
      !userId ||
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      return res.status(400).json({ message: "Missing verification fields" });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ message: "Invalid signature" });
    }

    // Confirm this order really belongs to this user and this flow — never
    // trust the client-provided userId by itself.
    const order = await razorpay.orders.fetch(razorpay_order_id);
    if (
      order.notes?.userId !== userId ||
      order.notes?.purpose !== "card_authorization"
    ) {
      return res.status(400).json({ message: "Order/user mismatch" });
    }

    const payment = await razorpay.payments.fetch(razorpay_payment_id);

    if (!payment.token_id) {
      return res.status(400).json({
        message:
          "Card wasn't saved. Please make sure 'Save card as per RBI guidelines' is checked during checkout, then try again.",
      });
    }

    const { count } = await supabase
      .from("payment_methods")
      .select("payment_method_id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "active");

    const { data: saved, error } = await supabase
      .from("payment_methods")
      .insert({
        user_id: userId,
        razorpay_token_id: payment.token_id,
        method: "card",
        card_network: payment.card?.network || null,
        card_last4: payment.card?.last4 || null,
        card_type: payment.card?.type || null,
        card_issuer: payment.card?.issuer || null,
        card_expiry_month: payment.card?.expiry_month || null,
        card_expiry_year: payment.card?.expiry_year || null,
        is_default: !count, // first saved method becomes default automatically
        status: "active",
      })
      .select()
      .single();

    if (error) throw error;

    // Refund the ₹1 hold — the customer is never actually charged for
    // saving a card.
    try {
      await razorpay.payments.refund(razorpay_payment_id, {
        amount: CARD_AUTH_AMOUNT_PAISE,
        speed: "optimum",
        notes: { reason: "card_tokenization_verification" },
      });
    } catch (refundErr) {
      // Don't fail the whole request over the refund — the card is already
      // saved. But a silent console.error means nobody ever finds out a
      // real ₹1 is sitting uncredited (e.g. Razorpay balance was too low
      // at that moment) — so record it for a human to retry later.
      console.error("Card auth refund failed:", refundErr);
      await supabase.from("card_auth_refund_failures").insert({
        user_id: userId,
        razorpay_payment_id,
        amount_paise: CARD_AUTH_AMOUNT_PAISE,
        reason:
          refundErr?.error?.description ||
          refundErr?.message ||
          "Unknown error",
      });
    }

    res.json({ success: true, paymentMethod: saved });
  } catch (err) {
    console.error("Verify Card Authorization Error:", err);
    res.status(500).json({ message: err.message || "Failed to save card" });
  }
};

export const listPaymentMethods = async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }

    const { data, error } = await supabase
      .from("payment_methods")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "active")
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("List Payment Methods Error:", err);
    res.status(500).json({ message: "Failed to fetch payment methods" });
  }
};

export const setDefaultPaymentMethod = async (req, res) => {
  try {
    const { userId, paymentMethodId } = req.body;
    if (!userId || !paymentMethodId) {
      return res
        .status(400)
        .json({ message: "userId and paymentMethodId are required" });
    }

    const { data: method } = await supabase
      .from("payment_methods")
      .select("*")
      .eq("payment_method_id", paymentMethodId)
      .eq("user_id", userId)
      .eq("status", "active")
      .single();

    if (!method) {
      return res.status(404).json({ message: "Payment method not found" });
    }

    await supabase
      .from("payment_methods")
      .update({ is_default: false })
      .eq("user_id", userId)
      .eq("status", "active");

    await supabase
      .from("payment_methods")
      .update({ is_default: true })
      .eq("payment_method_id", paymentMethodId);

    res.json({ success: true });
  } catch (err) {
    console.error("Set Default Payment Method Error:", err);
    res
      .status(500)
      .json({ message: "Failed to update default payment method" });
  }
};

export const deletePaymentMethod = async (req, res) => {
  try {
    const { userId, paymentMethodId } = req.body;
    if (!userId || !paymentMethodId) {
      return res
        .status(400)
        .json({ message: "userId and paymentMethodId are required" });
    }

    const { data: method } = await supabase
      .from("payment_methods")
      .select("*, users!inner(razorpay_customer_id)")
      .eq("payment_method_id", paymentMethodId)
      .eq("user_id", userId)
      .single();

    if (!method) {
      return res.status(404).json({ message: "Payment method not found" });
    }

    const customerId = method.users?.razorpay_customer_id;
    if (customerId) {
      try {
        await razorpay.customers.deleteToken(
          customerId,
          method.razorpay_token_id,
        );
      } catch (tokenErr) {
        // Not fatal — still remove it from our side so it stops showing up
        // even if Razorpay's own token deletion call fails for some reason.
        console.error("Razorpay token delete failed:", tokenErr);
      }
    }

    await supabase
      .from("payment_methods")
      .update({ status: "deleted", is_default: false })
      .eq("payment_method_id", paymentMethodId);

    // If the deleted method was the default, promote the next most recent one.
    if (method.is_default) {
      const { data: next } = await supabase
        .from("payment_methods")
        .select("payment_method_id")
        .eq("user_id", userId)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (next) {
        await supabase
          .from("payment_methods")
          .update({ is_default: true })
          .eq("payment_method_id", next.payment_method_id);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Delete Payment Method Error:", err);
    res.status(500).json({ message: "Failed to remove payment method" });
  }
};

/**
 * Lists card-authorization refunds (₹1 holds) that failed to go through —
 * e.g. because Razorpay account balance was too low at the time. No auth
 * middleware here assumed; wire this behind your own admin check before
 * exposing it, since it lists other users' payment ids.
 */
export const listFailedRefunds = async (req, res) => {
  try {
    const { status = "pending" } = req.query;

    const { data, error } = await supabase
      .from("card_auth_refund_failures")
      .select("*")
      .eq("status", status)
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("List Failed Refunds Error:", err);
    res.status(500).json({ message: "Failed to fetch failed refunds" });
  }
};

/**
 * Retries one previously-failed ₹1 card-auth refund (e.g. once account
 * balance is topped up). Marks it 'refunded' on success, bumps the attempt
 * count and timestamp either way so repeated failures are visible.
 */
export const retryFailedRefund = async (req, res) => {
  try {
    const { id } = req.params;

    const { data: failure, error } = await supabase
      .from("card_auth_refund_failures")
      .select("*")
      .eq("id", id)
      .eq("status", "pending")
      .single();

    if (error || !failure) {
      return res
        .status(404)
        .json({ message: "No pending refund with that id" });
    }

    try {
      await razorpay.payments.refund(failure.razorpay_payment_id, {
        amount: failure.amount_paise,
        speed: "optimum",
        notes: { reason: "card_tokenization_verification_retry" },
      });

      await supabase
        .from("card_auth_refund_failures")
        .update({
          status: "refunded",
          resolved_at: new Date(),
          attempts: failure.attempts + 1,
          last_attempted_at: new Date(),
        })
        .eq("id", id);

      res.json({ success: true });
    } catch (refundErr) {
      await supabase
        .from("card_auth_refund_failures")
        .update({
          attempts: failure.attempts + 1,
          last_attempted_at: new Date(),
          reason:
            refundErr?.error?.description ||
            refundErr?.message ||
            failure.reason,
        })
        .eq("id", id);

      res.status(400).json({
        message:
          refundErr?.error?.description ||
          refundErr?.message ||
          "Refund retry failed again",
      });
    }
  } catch (err) {
    console.error("Retry Failed Refund Error:", err);
    res.status(500).json({ message: "Failed to retry refund" });
  }
};
