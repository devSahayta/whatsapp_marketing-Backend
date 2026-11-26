//controllers/autoPayController.js

import {
  getAutoPaySettings,
  setAutoPaySettings,
  maybeAutoReloadCredits,
} from "../services/autoPayService.js";

export const getSettings = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }
    const settings = await getAutoPaySettings(userId);
    res.json(settings);
  } catch (err) {
    console.error("Get auto-pay settings error:", err.message);
    res
      .status(400)
      .json({ message: err.message || "Could not load auto-reload settings" });
  }
};

export const updateSettings = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }
    const { enabled, lowCreditThreshold, reloadCredits } = req.body;
    const settings = await setAutoPaySettings(userId, {
      enabled,
      lowCreditThreshold,
      reloadCredits,
    });
    res.json(settings);
  } catch (err) {
    console.error("Update auto-pay settings error:", err.message);
    res
      .status(400)
      .json({
        message: err.message || "Could not update auto-reload settings",
      });
  }
};

// TEMPORARY — for manually testing the auto-reload charge path without
// waiting to wire it into real credit deduction. Pass the "current balance"
// you want to simulate; if it's below the saved threshold and auto-reload
// is on, this fires a real charge on the saved card, same as production.
// Remove this route once deductCredits calls maybeAutoReloadCredits itself.
export const testTrigger = async (req, res) => {
  try {
    const { userId } = req.params;
    const { simulatedBalance } = req.body;
    if (!userId) {
      return res.status(400).json({ message: "userId is required" });
    }
    if (simulatedBalance == null) {
      return res.status(400).json({ message: "simulatedBalance is required" });
    }
    // maybeAutoReloadCredits never throws by design (fire-and-forget in
    // production) — for this test endpoint we just call it and report back
    // the settings afterward so you can see last_credit_reload_at update.
    await maybeAutoReloadCredits(userId, Number(simulatedBalance));
    const settings = await getAutoPaySettings(userId);
    res.json({ triggered: true, settings });
  } catch (err) {
    console.error("Auto-reload test trigger error:", err.message);
    res.status(400).json({ message: err.message || "Test trigger failed" });
  }
};
