import Razorpay from "razorpay";
import crypto from "crypto";
import { supabase } from "../config/supabase.js";
import { activateSubscription } from "../services/subscriptionService.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

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

    const order = await razorpay.orders.create({
      amount: plan.price,
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
      amount: plan.price,
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
