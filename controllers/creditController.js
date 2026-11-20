// controllers/creditController.js
import crypto from "crypto";
import {
  getCreditPricing,
  createCreditOrder,
  verifyCreditPurchase,
  handleCreditPaymentCaptured,
  InsufficientCreditsError,
} from "../services/creditService.js";
import { getUserById } from "../models/userModel.js";

// GET /api/credits/pricing
export const getPricing = async (req, res) => {
  try {
    res.json(getCreditPricing());
  } catch (err) {
    console.error("Get credit pricing error:", err);
    res.status(500).json({ message: "Failed to load credit pricing" });
  }
};

// GET /api/credits/:userId  (balance; mirrors /api/users/:id/credits)
export const getBalance = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await getUserById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ credits: user.credits });
  } catch (err) {
    console.error("Get credit balance error:", err);
    res.status(500).json({ message: "Failed to fetch credit balance" });
  }
};

// POST /api/credits/create-order  { userId, credits?, packageId? }
export const createOrder = async (req, res) => {
  try {
    const { userId, credits, packageId } = req.body;

    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }
    if (!credits && !packageId) {
      return res
        .status(400)
        .json({ message: "Provide either a packageId or a credits amount" });
    }

    const {
      order,
      credits: finalCredits,
      amountRupees,
    } = await createCreditOrder({ userId, credits, packageId });

    res.json({ ...order, credits: finalCredits, amountRupees });
  } catch (err) {
    console.error("Create credit order error:", err.message);
    res.status(400).json({ message: err.message || "Failed to create order" });
  }
};

// POST /api/credits/verify  { razorpay_order_id, razorpay_payment_id, razorpay_signature }
export const verify = async (req, res) => {
  try {
    const result = await verifyCreditPurchase(req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Verify credit purchase error:", err.message);
    res.status(400).json({ message: err.message || "Verification failed" });
  }
};

// POST /api/credits/webhook  (Razorpay payment.captured for credit orders)
export const webhook = async (req, res) => {
  try {
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
      // Only act on credit-purchase orders; subscription orders are handled
      // by paymentController's own webhook.
      if (payment.notes?.type === "credit_purchase") {
        await handleCreditPaymentCaptured(payment);
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Credit webhook error:", err);
    res.status(500).json({ message: "Webhook processing failed" });
  }
};

export { InsufficientCreditsError };
