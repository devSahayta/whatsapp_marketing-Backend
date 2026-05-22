import { google } from "googleapis";
import { supabase } from "../config/supabase.js";
import { createOAuthClient } from "../config/google.js";

export const getSheetsClient = async (userId) => {
  const { data, error } = await supabase
    .from("user_google_accounts")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new Error("Google account not connected");
  }

  const oauth2Client = createOAuthClient();

  oauth2Client.setCredentials({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_date: data.expiry_date ? Number(data.expiry_date) : undefined,
  });

  // Auto-save refreshed tokens
  oauth2Client.on("tokens", async (newTokens) => {
    await supabase
      .from("user_google_accounts")
      .update({
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token || data.refresh_token,
        expiry_date: newTokens.expiry_date,
        updated_at: new Date(),
      })
      .eq("user_id", userId);
  });

  // Force a proactive token refresh if expired — prevents the Sheets API
  // from receiving a stale token and returning a misleading 404
  await oauth2Client.getAccessToken();

  return google.sheets({ version: "v4", auth: oauth2Client });
};

export const getDriveClient = async (userId) => {
  const { data, error } = await supabase
    .from("user_google_accounts")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new Error("Google account not connected");
  }

  const oauth2Client = createOAuthClient();

  oauth2Client.setCredentials({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_date: data.expiry_date ? Number(data.expiry_date) : undefined,
  });

  // Auto-save refreshed tokens
  oauth2Client.on("tokens", async (newTokens) => {
    await supabase
      .from("user_google_accounts")
      .update({
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token || data.refresh_token,
        expiry_date: newTokens.expiry_date,
        updated_at: new Date(),
      })
      .eq("user_id", userId);
  });

  return google.drive({ version: "v3", auth: oauth2Client });
};
