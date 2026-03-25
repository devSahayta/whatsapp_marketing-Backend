import axios from "axios";

// --------------------------------------------
// Helper: Convert Tier → Daily Limit
// --------------------------------------------
export const getTierLimitNumber = (tier) => {
  switch (tier) {
    case "TIER_250":
      return 250;
    case "TIER_1K":
      return 1000;
    case "TIER_2K":
      return 2000;
    case "TIER_10K":
      return 10000;
    case "TIER_100K":
      return 100000;
    case "TIER_UNLIMITED":
      return 1000000; // practically unlimited
    default:
      return 0;
  }
};

// --------------------------------------------
// 1️⃣ Get Messaging Tier from WABA
// --------------------------------------------
export const fetchMessagingTier = async (waba_id, access_token) => {
  try {
    const url = `https://graph.facebook.com/v25.0/${waba_id}?fields=whatsapp_business_manager_messaging_limit`;

    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });

    const tier = res.data?.whatsapp_business_manager_messaging_limit || null;

    return {
      tier,
      limit: getTierLimitNumber(tier),
    };
  } catch (err) {
    console.error(
      "Error fetching messaging tier:",
      err.response?.data || err.message,
    );
    return { tier: null, limit: 0 };
  }
};

// --------------------------------------------
// 2️⃣ Get Quality Rating from Phone Number
// --------------------------------------------
export const fetchQualityRating = async (phone_number_id, access_token) => {
  try {
    const url = `https://graph.facebook.com/v19.0/${phone_number_id}`;

    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });

    return res.data?.quality_rating || null;
  } catch (err) {
    console.error(
      "Error fetching quality rating:",
      err.response?.data || err.message,
    );
    return null;
  }
};

// --------------------------------------------
// 3️⃣ Decide Warmup Based on Tier
// --------------------------------------------
export const getWarmupConfig = (tier) => {
  const highTiers = ["TIER_10K", "TIER_100K", "TIER_UNLIMITED"];

  if (highTiers.includes(tier)) {
    return {
      warmup_enabled: false,
      warmup_completed: true,
      // warmup_stage: 3,
    };
  }

  // For low tiers (250 / 1K / 2K)
  return {
    warmup_enabled: true,
    warmup_completed: false,
    // warmup_stage: 1,
  };
};
