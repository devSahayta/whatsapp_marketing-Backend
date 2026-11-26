// routes/subscriptionRenewalRoutes.js
import express from "express";
import {
  renewNow,
  runAutoRenewals,
  subscribeWithSavedMethod,
} from "../controllers/subscriptionRenewalController.js";

const router = express.Router();

router.post("/renew-now/:userId", renewNow); // manual test — remove or keep for support use
router.post("/run-auto-renewals", runAutoRenewals); // cron entrypoint, secret-guarded
router.post("/subscribe-with-saved-method", subscribeWithSavedMethod); // user-initiated from pricing page

export default router;
