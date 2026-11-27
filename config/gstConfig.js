// config/gstConfig.js
//
// Single source of truth for GST math across subscriptions and credits.
// Per business decision: prices stored everywhere else (plans.price, credit
// packages) are the BASE cost — GST is added on top at charge time, not
// baked into the stored price. Shown as one flat "GST" line (not split
// CGST/SGST/IGST) until billing-state collection + a CA's sign-off make a
// proper split possible.

export const GST_RATE = 0.18; // 18%

// baseAmountPaise: pre-GST base amount, in paise. Returns the amount
// actually charged (base + GST), in paise, rounded to the nearest paisa.
export const addGst = (baseAmountPaise) => {
  const base = Number(baseAmountPaise) || 0;
  return Math.round(base * (1 + GST_RATE));
};
