// routes/creditRoutes.js
import express from "express";
import {
  getPricing,
  getBalance,
  createOrder,
  verify,
  webhook,
} from "../controllers/creditController.js";

const router = express.Router();

router.get("/pricing", getPricing);
router.get("/:userId", getBalance);

router.post("/create-order", createOrder);
router.post("/verify", verify);

// Webhook must receive the raw body for signature verification elsewhere;
// kept here for symmetry with paymentRoutes' webhook.
router.post("/webhook", webhook);

export default router;
