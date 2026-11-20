import express from "express";
import {
  createOrder,
  verifyPayment,
  razorpayWebhook,
  getSubscriptionStatus,
  getPlans,
  getPaymentLogs,
} from "../controllers/paymentController.js";

const router = express.Router();

router.get("/plans", getPlans);

router.post("/create-order", createOrder);
router.post("/verify", verifyPayment);
router.get("/status", getSubscriptionStatus);
router.get("/logs", getPaymentLogs);

// Webhook must be raw body middleware
router.post("/webhook", razorpayWebhook);

export default router;
