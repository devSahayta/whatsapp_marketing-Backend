// import { supabase } from "../config/supabase.js";

// export const createWAccount = async (req, res) => {
//   try {
//     const {
//       user_id,
//       app_id,
//       waba_id,
//       phone_number_id,
//       business_phone_number,
//       system_user_access_token,
//     } = req.body;

//     const { data, error } = await supabase
//       .from("whatsapp_accounts")
//       .insert([
//         {
//           user_id,
//           app_id,
//           waba_id,
//           phone_number_id,
//           business_phone_number,
//           system_user_access_token,
//         },
//       ])
//       .select();

//     if (error) {
//       console.error("Supabase Error:", error);
//       return res.status(400).json({ success: false, message: error.message });
//     }

//     return res.status(200).json({
//       success: true,
//       message: "WhatsApp account saved successfully!",
//       data,
//     });
//   } catch (err) {
//     console.error("Server Error:", err);
//     return res.status(500).json({
//       success: false,
//       message: "Server error occurred",
//     });
//   }
// };

// ---------------------------updated Code-------------------

import { supabase } from "../config/supabase.js";

import {
  fetchMessagingTier,
  fetchQualityRating,
  getWarmupConfig,
} from "../services/metaWhatsApp.js";

// ------------------------------------------------------
// 1️⃣ CREATE OR INSERT WHATSAPP ACCOUNT
// ------------------------------------------------------
export const createWAccount = async (req, res) => {
  try {
    const {
      user_id,
      app_id,
      waba_id,
      phone_number_id,
      business_phone_number,
      system_user_access_token,
    } = req.body;

    // -------------------------------------
    // Check existing
    // -------------------------------------
    const { data: existing } = await supabase
      .from("whatsapp_accounts")
      .select("*")
      .eq("user_id", user_id)
      .single();

    if (existing) {
      return res.status(200).json({
        success: false,
        message: "WhatsApp account already exists for this user",
        data: existing,
      });
    }

    // -------------------------------------
    // 🔥 Fetch Tier + Quality from Meta
    // -------------------------------------
    const { tier, limit } = await fetchMessagingTier(
      waba_id,
      system_user_access_token,
    );

    const quality_rating = await fetchQualityRating(
      phone_number_id,
      system_user_access_token,
    );

    const warmupConfig = getWarmupConfig(tier);

    // -------------------------------------
    // Insert into DB
    // -------------------------------------
    const { data, error } = await supabase
      .from("whatsapp_accounts")
      .insert([
        {
          user_id,
          app_id,
          waba_id,
          phone_number_id,
          business_phone_number,
          system_user_access_token,

          //  New fields
          messaging_limit_tier: tier,
          messaging_limit_per_day: limit,
          quality_rating,
          last_tier_updated_at: new Date(),

          //  Warmup logic
          ...warmupConfig,
        },
      ])
      .select();

    if (error) {
      console.error("Supabase Error:", error);
      return res.status(400).json({ success: false, message: error.message });
    }

    return res.status(200).json({
      success: true,
      message: "WhatsApp account saved with tier & quality!",
      data,
    });
  } catch (err) {
    console.error("Server Error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error occurred",
    });
  }
};

// // ------------------------------------------------------
// // 1️⃣ CREATE OR INSERT WHATSAPP ACCOUNT
// // ------------------------------------------------------
// export const createWAccount = async (req, res) => {
//   try {
//     const {
//       user_id,
//       app_id,
//       waba_id,
//       phone_number_id,
//       business_phone_number,
//       system_user_access_token,
//     } = req.body;

//     const { data: existing } = await supabase
//       .from("whatsapp_accounts")
//       .select("*")
//       .eq("user_id", user_id)
//       .single();

//     // If account already exists → return message
//     if (existing) {
//       return res.status(200).json({
//         success: false,
//         message: "WhatsApp account already exists for this user",
//         data: existing,
//       });
//     }

//     const { data, error } = await supabase
//       .from("whatsapp_accounts")
//       .insert([
//         {
//           user_id,
//           app_id,
//           waba_id,
//           phone_number_id,
//           business_phone_number,
//           system_user_access_token,
//         },
//       ])
//       .select();

//     if (error) {
//       console.error("Supabase Error:", error);
//       return res.status(400).json({ success: false, message: error.message });
//     }

//     return res.status(200).json({
//       success: true,
//       message: "WhatsApp account saved successfully!",
//       data,
//     });
//   } catch (err) {
//     console.error("Server Error:", err);
//     return res.status(500).json({
//       success: false,
//       message: "Server error occurred",
//     });
//   }
// };

// ------------------------------------------------------
// 2️⃣ GET / FETCH WHATSAPP ACCOUNT BY USER ID
// ------------------------------------------------------
export const getWAccount = async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res
        .status(400)
        .json({ success: false, message: "user_id required" });
    }

    const { data, error } = await supabase
      .from("whatsapp_accounts")
      .select("*")
      .eq("user_id", user_id)
      .single();

    if (error && error.code !== "PGRST116") {
      console.error("Supabase Error:", error);
      return res.status(400).json({ success: false, message: error.message });
    }

    return res.status(200).json({
      success: true,
      data: data || null, // If no data, return null
    });
  } catch (err) {
    console.error("Server Error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error occurred",
    });
  }
};

// ------------------------------------------------------
// 3️⃣ UPDATE WHATSAPP ACCOUNT
// ------------------------------------------------------
export const updateWAccount = async (req, res) => {
  try {
    const {
      user_id,
      app_id,
      waba_id,
      phone_number_id,
      business_phone_number,
      system_user_access_token,
    } = req.body;

    const { data: existing } = await supabase
      .from("whatsapp_accounts")
      .select("*")
      .eq("user_id", user_id)
      .single();

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "No WhatsApp account found to update",
      });
    }

    const { data, error } = await supabase
      .from("whatsapp_accounts")
      .update({
        app_id,
        waba_id,
        phone_number_id,
        business_phone_number,
        system_user_access_token,
      })
      .eq("user_id", user_id)
      .select();

    if (error) {
      console.error("Supabase Update Error:", error);
      return res.status(400).json({ success: false, message: error.message });
    }

    return res.status(200).json({
      success: true,
      message: "WhatsApp account updated successfully!",
      data,
    });
  } catch (err) {
    console.error("Server Error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error occurred",
    });
  }
};

// ------------------------------------------------------
// 4️⃣ SYNC MESSAGING TIER & QUALITY RATING FROM META
// ------------------------------------------------------

export const syncWhatsAppTier = async (req, res) => {
  try {
    const { user_id } = req.query;

    const { data: account, error } = await supabase
      .from("whatsapp_accounts")
      .select("*")
      .eq("user_id", user_id)
      .single();

    if (error || !account) {
      return res.status(404).json({
        success: false,
        message: "Account not found",
      });
    }

    const { tier, limit } = await fetchMessagingTier(
      account.waba_id,
      account.system_user_access_token,
    );

    const quality_rating = await fetchQualityRating(
      account.phone_number_id,
      account.system_user_access_token,
    );

    // const warmupConfig = getWarmupConfig(tier);

    const { error: updateError } = await supabase
      .from("whatsapp_accounts")
      .update({
        messaging_limit_tier: tier,
        messaging_limit_per_day: limit,
        quality_rating,
        last_tier_updated_at: new Date(),

        // //  Auto warmup update
        // ...warmupConfig,
      })
      .eq("wa_id", account.wa_id);

    if (updateError) {
      return res.status(400).json({
        success: false,
        message: updateError.message,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Tier & quality synced successfully",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// ------------------------------------------------------
// 5️⃣ EMBEDDED SIGNUP — Exchange code and create account
// ------------------------------------------------------
import {
  exchangeCodeForToken,
  getLongLivedToken,
  fetchWABADetails,
} from "../services/metaEmbeddedSignup.js";

export const embeddedSignupHandler = async (req, res) => {
  try {
    const { code, user_id } = req.body;

    if (!code || !user_id) {
      return res.status(400).json({
        success: false,
        message: "code and user_id are required",
      });
    }

    // -------------------------------------
    // Check if account already exists
    // -------------------------------------
    const { data: existing } = await supabase
      .from("whatsapp_accounts")
      .select("*")
      .eq("user_id", user_id)
      .single();

    if (existing) {
      return res.status(200).json({
        success: false,
        message: "WhatsApp account already connected. Use update instead.",
        data: existing,
      });
    }

    // -------------------------------------
    // Step 1: Exchange code → short token
    // -------------------------------------
    const shortLivedToken = await exchangeCodeForToken(code);

    // -------------------------------------
    // Step 2: Exchange short → long-lived token (60 days)
    // -------------------------------------
    const { token: longLivedToken, expiresAt } =
      await getLongLivedToken(shortLivedToken);

    // -------------------------------------
    // Step 3: Fetch WABA + Phone details
    // -------------------------------------
    const { waba_id, phone_number_id, business_phone_number } =
      await fetchWABADetails(longLivedToken);

    // -------------------------------------
    // Step 4: Fetch tier + quality from Meta
    // (reuse your existing service functions)
    // -------------------------------------
    const { tier, limit } = await fetchMessagingTier(waba_id, longLivedToken);

    const quality_rating = await fetchQualityRating(
      phone_number_id,
      longLivedToken,
    );

    const warmupConfig = getWarmupConfig(tier);

    // -------------------------------------
    // Step 5: Save to DB
    // -------------------------------------
    // Step 5: Save to DB
    const { data, error } = await supabase
      .from("whatsapp_accounts")
      .insert([
        {
          user_id,
          app_id: process.env.META_APP_ID, // ← add this
          app_secret: process.env.META_APP_SECRET, // ← add this
          waba_id,
          phone_number_id,
          business_phone_number,
          system_user_access_token: longLivedToken,
          access_token_expires_at: expiresAt,

          // Tier + quality
          messaging_limit_tier: tier,
          messaging_limit_per_day: limit,
          quality_rating,
          last_tier_updated_at: new Date(),

          // Warmup
          ...warmupConfig,
        },
      ])
      .select();

    if (error) {
      console.error("Supabase Insert Error:", error);
      return res.status(400).json({ success: false, message: error.message });
    }

    return res.status(200).json({
      success: true,
      message: "WhatsApp account connected successfully via Embedded Signup!",
      data,
    });
  } catch (err) {
    console.error("Embedded Signup Error:", err.message);
    return res.status(500).json({
      success: false,
      message: err.message || "Server error during embedded signup",
    });
  }
};
