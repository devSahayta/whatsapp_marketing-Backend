// controllers/paymentController.js

import Razorpay from "razorpay";
import crypto from "crypto";
import { supabase } from "../config/supabase.js";
import { activateSubscription } from "../services/subscriptionService.js";
import { generateInvoicePdf, toRupees } from "../services/invoiceService.js";
import { addGst } from "../config/gstConfig.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const normalizeStatus = (status) => {
  const s = String(status || "").toLowerCase();
  if (["paid", "completed", "success", "captured"].includes(s)) return "paid";
  if (["failed", "error", "cancelled"].includes(s)) return "failed";
  return "pending";
};

/**
 * Create Razorpay Order
 */
export const createOrder = async (req, res) => {
  try {
    const { planId, userId } = req.body;
    // const userId = req.user.id;

    if (!planId) {
      return res.status(400).json({ message: "Plan ID required" });
    }

    const { data: plan, error } = await supabase
      .from("plans")
      .select("*")
      .eq("plan_id", planId)
      .eq("is_active", true)
      .single();

    if (error || !plan) {
      return res.status(404).json({ message: "Invalid plan" });
    }

    // plan.price is the base cost; GST is added on top of it here, so the
    // Razorpay order (and the amount we store) is the real, GST-inclusive
    // total the customer is charged.
    const chargeAmount = addGst(plan.price);

    const order = await razorpay.orders.create({
      amount: chargeAmount,
      currency: "INR",
      receipt: `receipt_${Date.now()}`,
      notes: {
        userId,
        planId,
      },
    });

    await supabase.from("payments").insert({
      user_id: userId,
      plan_id: planId,
      amount: chargeAmount,
      razorpay_order_id: order.id,
      status: "created",
    });

    res.json(order);
  } catch (err) {
    console.error("Create Order Error:", err);
    res.status(500).json({ message: "Failed to create order" });
  }
};

export const verifyPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body;

    // const userId = req.user.id;

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ message: "Invalid signature" });
    }

    const { data: payment } = await supabase
      .from("payments")
      .select("*")
      .eq("razorpay_order_id", razorpay_order_id)
      .single();

    if (!payment) {
      return res.status(404).json({ message: "Payment record not found" });
    }

    // Update payment status
    await supabase
      .from("payments")
      .update({
        razorpay_payment_id,
        razorpay_signature,
        status: "paid",
        paid_at: new Date(),
      })
      .eq("payment_id", payment.payment_id);

    // Fetch plan
    const { data: plan } = await supabase
      .from("plans")
      .select("*")
      .eq("plan_id", payment.plan_id)
      .single();

    // Activate subscription
    await activateSubscription(payment.user_id, plan, payment.payment_id);

    res.json({ success: true });
  } catch (err) {
    console.error("Verify Payment Error:", err);
    res.status(500).json({ message: "Payment verification failed" });
  }
};

export const razorpayWebhook = async (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  const signature = req.headers["x-razorpay-signature"];

  const expectedSignature = crypto
    .createHmac("sha256", webhookSecret)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (signature !== expectedSignature) {
    return res.status(400).send("Invalid webhook signature");
  }

  const event = req.body;

  if (event.event === "payment.captured") {
    const payment = event.payload.payment.entity;

    const { data: dbPayment } = await supabase
      .from("payments")
      .select("*")
      .eq("razorpay_order_id", payment.order_id)
      .single();

    if (dbPayment && dbPayment.status !== "paid") {
      await supabase
        .from("payments")
        .update({
          status: "paid",
          razorpay_payment_id: payment.id,
          paid_at: new Date(),
        })
        .eq("payment_id", dbPayment.payment_id);

      const { data: plan } = await supabase
        .from("plans")
        .select("*")
        .eq("plan_id", dbPayment.plan_id)
        .single();

      await activateSubscription(dbPayment.user_id, plan);
    }
  }

  res.status(200).json({ received: true });
};

export const getSubscriptionStatus = async (req, res) => {
  const { userId } = req.query;

  // console.log({ userId });

  const { data: sub } = await supabase
    .from("subscriptions")
    .select("*, plans(*)")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .maybeSingle();

  if (!sub) {
    return res.json({ active: false });
  }

  const isExpired = new Date(sub.end_date) < new Date();

  res.json({
    active: !isExpired,
    expiresAt: sub.end_date,
    plan: sub.plans,
  });
};

/**
 * Unified Payment Logs
 * Merges subscription payments (payments table) and the credit ledger
 * (credit_transactions table — top-ups, the one-time free-subscription
 * bonus, future deductions) into one timeline for the "Payment Logs" page.
 */
export const getPaymentLogs = async (req, res) => {
  try {
    const { userId, page = 1, pageSize = 20, kind = "all" } = req.query;

    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }

    // kind: "billing" -> plan payments + credit purchases only
    //       "usage"   -> AI Assistant deductions only
    //       "all"     -> everything (old behaviour)
    // The split happens BEFORE paging. Previously everything was merged and
    // only the newest rows were returned, so a busy AI-usage history pushed
    // every payment and purchase off the page and Billing History looked empty.
    const wantBilling = kind === "all" || kind === "billing";

    // Subscription payments (plan purchases/renewals)
    let payments = [];
    if (wantBilling) {
      const { data, error: paymentsError } = await supabase
        .from("payments")
        .select("*, plans(name)")
        .eq("user_id", userId);
      if (paymentsError) throw paymentsError;
      payments = data || [];
    }

    // Credit ledger (top-ups, the one-time free-subscription bonus, usage)
    let creditQuery = supabase
      .from("credit_transactions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(5000);
    if (kind === "billing") creditQuery = creditQuery.eq("type", "purchase");
    if (kind === "usage") creditQuery = creditQuery.eq("type", "deduction");
    const { data: creditTxns, error: creditError } = await creditQuery;

    if (creditError) throw creditError;

    console.log(
      `[payment-logs] user=${userId} payments=${(payments || []).length} ` +
        `creditTxns=${(creditTxns || []).length} ` +
        `deductions=${(creditTxns || []).filter((t) => t.type === "deduction").length}`,
    );

    const subscriptionLogs = (payments || []).map((p) => ({
      id: `payment_${p.payment_id}`,
      // Fall back through every timestamp-ish column so an order that was
      // created but never paid/webhooked still has a date to sort by.
      date: p.paid_at || p.created_at || p.updated_at || p.created_on || null,
      category: "subscription",
      label: p.plans?.name
        ? `${p.plans.name} subscription`
        : "Subscription payment",
      amount: p.amount != null ? Number(p.amount) : null,
      credits: null,
      status: p.status || "unknown",
      razorpayPaymentId: p.razorpay_payment_id || null,
      razorpayOrderId: p.razorpay_order_id || null,
      planId: p.plan_id || null,
    }));

    const creditLogs = (creditTxns || []).map((t) => {
      const defaultLabel =
        t.type === "subscription_bonus"
          ? "Free credits — first subscription"
          : t.type === "purchase"
            ? "Credit top-up"
            : t.type === "deduction"
              ? "Credits used"
              : "Credit adjustment";

      return {
        id: `credit_${t.transaction_id}`,
        date: t.created_at || null,
        category: t.type, // 'purchase' | 'subscription_bonus' | 'deduction' | 'adjustment'
        label: t.description || defaultLabel,
        amount: t.amount_paid != null ? Number(t.amount_paid) : null,
        credits: t.credits != null ? Number(t.credits) : null,
        status: t.status || "unknown",
        razorpayPaymentId: t.razorpay_payment_id || null,
        razorpayOrderId: t.razorpay_order_id || null,
        balanceAfter: t.balance_after != null ? Number(t.balance_after) : null,
      };
    });

    // Every row is kept — created-but-unpaid orders and failed attempts
    // included — so the page reflects the full payment history, not just
    // successful ones. Rows with no timestamp at all (shouldn't normally
    // happen) sort to the bottom instead of being dropped.
    const allLogs = [...subscriptionLogs, ...creditLogs].sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(b.date) - new Date(a.date);
    });

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const size = Math.min(500, Math.max(1, parseInt(pageSize, 10) || 20));
    const start = (pageNum - 1) * size;

    res.json({
      logs: allLogs.slice(start, start + size),
      total: allLogs.length,
      page: pageNum,
      pageSize: size,
    });
  } catch (err) {
    console.error("Get Payment Logs Error:", err);
    res.status(500).json({ message: "Failed to fetch payment logs" });
  }
};

/**
 * Download Invoice
 * Generates a branded PDF invoice on the fly for one subscription payment
 * or one credit purchase (never for a deduction/bonus/adjustment row —
 * those aren't money-in events). Nothing is pre-generated or stored; the
 * PDF is streamed straight to the response on each request.
 */
export const downloadInvoice = async (req, res) => {
  try {
    const { type, id } = req.params;
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }
    if (!["subscription", "credits"].includes(type)) {
      return res.status(400).json({ message: "Invalid invoice type" });
    }

    let invoice;

    if (type === "subscription") {
      const { data: payment, error } = await supabase
        .from("payments")
        .select("*, plans(name)")
        .eq("payment_id", id)
        .eq("user_id", userId)
        .single();

      if (error || !payment) {
        return res.status(404).json({ message: "Payment not found" });
      }
      if (normalizeStatus(payment.status) !== "paid") {
        return res.status(400).json({
          message: "Invoice is only available for completed payments",
        });
      }

      invoice = {
        invoiceNumber: `SMVK-SUB-${String(payment.payment_id).slice(0, 8).toUpperCase()}`,
        date: payment.paid_at || payment.created_at,
        description: payment.plans?.name
          ? `${payment.plans.name} Subscription`
          : "Subscription",
        amount: toRupees(payment.amount),
        paymentId: payment.razorpay_payment_id,
        orderId: payment.razorpay_order_id,
        status: normalizeStatus(payment.status),
      };
    } else {
      const { data: txn, error } = await supabase
        .from("credit_transactions")
        .select("*")
        .eq("transaction_id", id)
        .eq("user_id", userId)
        .eq("type", "purchase")
        .single();

      if (error || !txn) {
        return res.status(404).json({ message: "Transaction not found" });
      }
      if (normalizeStatus(txn.status) !== "paid") {
        return res.status(400).json({
          message: "Invoice is only available for completed payments",
        });
      }

      invoice = {
        invoiceNumber: `SMVK-CR-${String(txn.transaction_id).slice(0, 8).toUpperCase()}`,
        date: txn.created_at,
        description: `${Number(txn.credits)} Samvaadik AI credits`,
        amount: toRupees(txn.amount_paid),
        paymentId: txn.razorpay_payment_id,
        orderId: txn.razorpay_order_id,
        status: normalizeStatus(txn.status),
      };
    }

    // Best-effort customer details — invoice still generates fine without them
    const { data: userRow } = await supabase
      .from("users")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    invoice.customerName =
      userRow?.full_name || userRow?.name || userRow?.email || "Customer";
    invoice.customerEmail = userRow?.email || null;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${invoice.invoiceNumber}.pdf"`,
    );
    generateInvoicePdf(invoice, res);
  } catch (err) {
    console.error("Download Invoice Error:", err);
    res.status(500).json({ message: "Failed to generate invoice" });
  }
};

export const getPlans = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("plans")
      .select("*")
      .eq("is_active", true)
      .order("price", { ascending: true });

    if (error) {
      return res.status(500).json({ message: "Failed to fetch plans" });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};
