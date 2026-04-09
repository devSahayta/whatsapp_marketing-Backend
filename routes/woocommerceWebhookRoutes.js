// routes/woocommerceWebhookRoutes.js
// ⚠️ NO auth middleware — WooCommerce calls this directly
import express from "express";
import { handleWebhook } from "../controllers/woocommerceController.js";

const router = express.Router();

router.post("/:connection_id", handleWebhook);

export default router;
