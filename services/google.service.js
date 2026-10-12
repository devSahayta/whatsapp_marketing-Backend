import { google } from "googleapis";
import { supabase } from "../config/supabase.js";
import { createOAuthClient } from "../config/google.js";

// Builds an OAuth client for the user's stored Google tokens. Refreshed tokens
// are written back to Supabase automatically.
export const getGoogleAuthClient = async (userId) => {
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

  return oauth2Client;
};

export const getSheetsClient = async (userId) => {
  const auth = await getGoogleAuthClient(userId);
  return google.sheets({ version: "v4", auth });
};

// With the drive.file scope this only sees files the user picked in the
// Google Picker or files Samvaadik created (e.g. campaign exports).
export const getDriveClient = async (userId) => {
  const auth = await getGoogleAuthClient(userId);
  return google.drive({ version: "v3", auth });
};

// Short-lived access token handed to the browser for the Google Picker.
export const getPickerAccessToken = async (userId) => {
  const auth = await getGoogleAuthClient(userId);
  const { token } = await auth.getAccessToken();
  return {
    accessToken: token,
    expiresAt: auth.credentials.expiry_date || null,
  };
};

// True when Google refused access to a specific file — with drive.file this
// means the user has not picked that sheet (or picked it under an older token).
export const isGoogleFileAccessError = (err) => {
  const status = err?.code ?? err?.response?.status;
  return status === 403 || status === 404;
};
