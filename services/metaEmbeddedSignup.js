// services/metaEmbeddedSignup.js

const META_API_VERSION = "v23.0";
const GRAPH_URL = `https://graph.facebook.com/${META_API_VERSION}`;

// ------------------------------------------------------
// 1. Exchange short-lived code for user access token
// ------------------------------------------------------
export const exchangeCodeForToken = async (code) => {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  const url = `${GRAPH_URL}/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${code}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.access_token) {
    console.error("Token exchange failed:", data);
    throw new Error(data.error?.message || "Failed to exchange code for token");
  }

  return data.access_token; // short-lived user access token
};

// ------------------------------------------------------
// 2. Exchange short-lived token for long-lived token (60 days)
// ------------------------------------------------------
export const getLongLivedToken = async (shortLivedToken) => {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  const url = `https://graph.facebook.com/v23.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortLivedToken}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.access_token) {
    throw new Error("Failed to get long-lived token");
  }

  // expires_in = 0 means never expires (system user token)
  const expiresAt =
    data.expires_in && data.expires_in > 0
      ? new Date(Date.now() + data.expires_in * 1000)
      : null;

  return {
    token: data.access_token,
    expiresAt,
  };
};

// ------------------------------------------------------
// 3. Fetch WABA ID linked to this user/token
// ------------------------------------------------------
export const fetchWABADetails = async (accessToken) => {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  const appAccessToken = `${appId}|${appSecret}`;
  const debugRes = await fetch(
    `https://graph.facebook.com/v23.0/debug_token?input_token=${accessToken}&access_token=${appAccessToken}`,
  );
  const debugData = await debugRes.json();

  if (debugData.error) {
    throw new Error(debugData.error.message || "Failed to debug token");
  }

  const granularScopes = debugData.data?.granular_scopes || [];

  const wabaScope = granularScopes.find(
    (scope) => scope.scope === "whatsapp_business_management",
  );

  if (!wabaScope || !wabaScope.target_ids?.length) {
    throw new Error(
      "No WhatsApp Business Account found in granted permissions",
    );
  }

  const waba_id = wabaScope.target_ids[0];

  const wabaRes = await fetch(
    `https://graph.facebook.com/v23.0/${waba_id}?fields=phone_numbers{id,display_phone_number}&access_token=${accessToken}`,
  );
  const wabaData = await wabaRes.json();

  if (wabaData.error) {
    throw new Error(wabaData.error.message || "Failed to fetch WABA details");
  }

  const phone = wabaData.phone_numbers?.data?.[0];

  if (!phone) {
    throw new Error("No phone number found in this WABA");
  }

  return {
    waba_id,
    phone_number_id: phone.id,
    business_phone_number: phone.display_phone_number,
  };
};
