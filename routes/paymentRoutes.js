//routes/paymentRoutes.js

import express from "express";
import {
  createOrder,
  verifyPayment,
  razorpayWebhook,
  getSubscriptionStatus,
  getPlans,
  getPaymentLogs,
  downloadInvoice,
} from "../controllers/paymentController.js";

import {
  createCardAuthOrder,
  verifyCardAuthorization,
  listPaymentMethods,
  setDefaultPaymentMethod,
  deletePaymentMethod,
  listFailedRefunds,
  retryFailedRefund,
} from "../controllers/paymentMethodController.js";

const router = express.Router();

router.get("/plans", getPlans);

router.post("/create-order", createOrder);
router.post("/verify", verifyPayment);
router.get("/status", getSubscriptionStatus);
router.get("/logs", getPaymentLogs);
router.get("/invoice/:type/:id", downloadInvoice);

// Webhook must be raw body middleware
router.post("/webhook", razorpayWebhook);

//PAYMENT METHODS

router.post("/payment-method/card-auth/order", createCardAuthOrder);
router.post("/payment-method/card-auth/verify", verifyCardAuthorization);
router.get("/payment-methods", listPaymentMethods);
router.post("/payment-method/set-default", setDefaultPaymentMethod);
router.post("/payment-method/delete", deletePaymentMethod);

router.get("/payment-method/refund-failures", listFailedRefunds);
router.post("/payment-method/refund-failures/:id/retry", retryFailedRefund);

export default router;
