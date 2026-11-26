//controllers/subscriptionRenewalController.js

import {
  renewSubscriptionWithSavedMethod,
  runSubscriptionAutoRenewals,
  subscribeToPlanWithSavedMethod,
} from "../services/subscriptionRenewalService.js";

// Manual test endpoint — renews one user right now via the exact charge
// path the cron will use. Handy for testing before the schedule exists.
export const renewNow = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }
    const result = await renewSubscriptionWithSavedMethod(userId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Manual renewal error:", err.message);
    res.status(400).json({ message: err.message || "Renewal failed" });
  }
};

// Cron entrypoint, guarded by a shared secret so it can't be triggered by
// anyone who finds the URL. Processes at most one renewal per call by
// default (see subscriptionRenewalService.js for why) — point an external
// scheduler (cron-job.org, GitHub Actions scheduled workflow, etc.) at
// this endpoint every 10-15 minutes, sending the secret as a header:
// x-cron-secret: <CRON_SECRET>. Do NOT rely on Vercel's own daily cron for
// this — it needs to run more often than once a day to safely drain more
// than one same-day renewal without ever risking the function timeout.
export const runAutoRenewals = async (req, res) => {
  const providedSecret = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  try {
    const results = await runSubscriptionAutoRenewals(1);
    res.json({ success: true, processed: results.length, results });
  } catch (err) {
    console.error("Run auto-renewals error:", err.message);
    res.status(500).json({ message: err.message || "Auto-renewal run failed" });
  }
};

// User-initiated from the pricing page — "pay with saved card" on a
// specific plan card. No secret guard needed here (same trust model as
// purchase-with-saved-method for credits): it only acts on the userId sent,
// same as every other userId-scoped endpoint in this app.
export const subscribeWithSavedMethod = async (req, res) => {
  try {
    const { userId, planId } = req.body;
    if (!userId || !planId) {
      return res
        .status(400)
        .json({ message: "userId and planId are required" });
    }
    const result = await subscribeToPlanWithSavedMethod({ userId, planId });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Subscribe with saved method error:", err.message);
    res.status(400).json({ message: err.message || "Subscription failed" });
  }
};
