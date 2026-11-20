// config/creditConfig.js
// Central place for all Samvaadik AI credit pricing rules.
// Change the numbers here only — every other file derives from this.
//
// Purchase rate: 1 credit = ₹1, flat. Stated plainly in the UI ("1 credit =
// ₹1"), no hidden markup here — what a user buys is exactly what they pay.
//
// The business's markup is applied on the SPEND side instead: when AI usage
// deducts credits (not wired up yet — see deductCredits() in
// services/creditService.js), that future logic should deduct roughly
// double the credits a real action costs. That is intentionally not a
// concern of this file or of purchasing — nothing here needs to change
// when that lands.
//
// Because the purchase rate has always effectively been ₹1 = 1 credit from
// the ledger's point of view (credits are fungible — a credit bought
// yesterday and one bought today spend the same), no migration of existing
// balances is needed for this rate to apply going forward.

// What the user pays per credit (rupees). Always 1 — shown plainly as such.
export const CREDIT_VALUE_RUPEES = 1;
export const PRICE_PER_CREDIT_RUPEES = CREDIT_VALUE_RUPEES;

// Free credits granted exactly once, on a user's first-ever paid subscription.
export const FREE_CREDITS_ON_FIRST_SUBSCRIPTION = 1000;

// Bounds for the "custom amount" add-credit option.
export const MIN_CUSTOM_CREDITS = 50;
export const MAX_CUSTOM_CREDITS = 100000;

// Fixed, selectable credit packages shown on the pricing page.
// `price` (rupees) is always derived — never hand-entered — so it can never
// drift from PRICE_PER_CREDIT_RUPEES.
export const CREDIT_PACKAGES = [
  { id: "starter", label: "Starter", credits: 100 },
  { id: "growth", label: "Growth", credits: 500, popular: false },
  { id: "pro", label: "Pro", credits: 1000, popular: true },
  { id: "scale", label: "Scale", credits: 2500 },
  { id: "bulk", label: "Bulk", credits: 5000 },
].map((pkg) => ({
  ...pkg,
  price: pkg.credits * PRICE_PER_CREDIT_RUPEES, // rupees
}));

// Rupees -> paise for Razorpay (which always expects the smallest currency unit).
export const toPaise = (rupees) => Math.round(rupees * 100);

// How many rupees a given number of credits costs the user (flat 1=1 rate).
export const creditsToRupees = (credits) => credits * PRICE_PER_CREDIT_RUPEES;

// ── AI usage billing (the Samvaadik AI Assistant's actual spend) ───────────
// This is the one place the business's real markup lives. A credit is
// bought at ₹1 flat (above), but when the assistant actually does work for
// a user, we deduct roughly DOUBLE the real cost of that work — in
// credits, silently. The user only ever sees "N credits used", never a
// rate or a rupee figure.
export const USAGE_MARKUP_MULTIPLIER = 2;

// Approximate USD -> INR rate, used only to price AI usage (never shown to
// users, and never used in the purchase flow above). The Anthropic API
// bills in USD; update this periodically, or swap it for a live FX lookup,
// as the real rate drifts.
export const USD_TO_INR_RATE = Number(process.env.USD_TO_INR_RATE) || 95;

// Anthropic list pricing (USD per 1,000,000 tokens) for the model
// handleSamvaadikChat actually calls. If that model changes, update this
// to match — see https://platform.claude.com/docs/en/about-claude/pricing.
export const CLAUDE_HAIKU_4_5_PRICING_USD_PER_MILLION = {
  input: 1.0,
  output: 5.0,
  cacheWrite: 1.25, // 5-minute cache write (not currently used by this call)
  cacheRead: 0.1,
};

/**
 * Real cost (in rupees, no markup) of one or more Anthropic API calls, from
 * their combined token usage.
 */
export const usageToRealRupees = (
  usage,
  pricing = CLAUDE_HAIKU_4_5_PRICING_USD_PER_MILLION,
) => {
  const million = 1_000_000;
  const usd =
    ((usage?.input_tokens || 0) / million) * pricing.input +
    ((usage?.output_tokens || 0) / million) * pricing.output +
    ((usage?.cache_creation_input_tokens || 0) / million) * pricing.cacheWrite +
    ((usage?.cache_read_input_tokens || 0) / million) * pricing.cacheRead;

  return usd * USD_TO_INR_RATE;
};

/**
 * Credits to deduct for a given real rupee cost — the real cost, doubled,
 * rounded up, with a 1-credit floor so no AI turn is ever free.
 */
export const realRupeesToCredits = (rupees) =>
  Math.max(1, Math.ceil(rupees * USAGE_MARKUP_MULTIPLIER));
