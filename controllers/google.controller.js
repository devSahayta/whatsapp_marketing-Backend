// controllers/google.controller.js

import jwt from "jsonwebtoken";
import { createOAuthClient } from "../config/google.js";
import { supabase } from "../config/supabase.js";
import { google } from "googleapis";
import {
  getSheetsClient,
  getPickerAccessToken,
  isGoogleFileAccessError,
} from "../services/google.service.js";
import { createGroup } from "../models/groupModel.js";

// Only non-sensitive scopes, so Google shows no "unverified app" warning.
// drive.file grants access to sheets the user picks in the Google Picker and
// to sheets Samvaadik creates (campaign exports) — nothing else in their Drive.
const GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/drive.file",
];

const STATE_PURPOSE = "google_oauth";
const getStateSecret = () =>
  process.env.GOOGLE_STATE_SECRET || process.env.GOOGLE_CLIENT_SECRET;

const SHEET_ACCESS_REQUIRED_ERROR =
  "Samvaadik doesn't have access to this Google Sheet. Please select it again from Google Drive.";

// ✅ Step 1: Generate Auth URL
export const connectGoogle = async (req, res) => {
  try {
    const userId = req.user.user_id; // based on your auth middleware

    const oauth2Client = createOAuthClient();

    // Signed, short-lived state so a crafted callback URL can't link a Google
    // account to someone else's user.
    const state = jwt.sign(
      { uid: userId, purpose: STATE_PURPOSE },
      getStateSecret(),
      { expiresIn: "10m" },
    );

    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: GOOGLE_SCOPES,
      state,
    });

    return res.json({ url });
  } catch (err) {
    console.error("connectGoogle error:", err);
    res.status(500).json({ error: "Failed to connect Google" });
  }
};

// ✅ Step 2: Callback
export const googleCallback = async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError || !code || !state) {
      throw new Error(`Google OAuth aborted: ${oauthError || "missing code"}`);
    }

    const payload = jwt.verify(state, getStateSecret());
    if (payload?.purpose !== STATE_PURPOSE || !payload.uid) {
      throw new Error("Invalid OAuth state");
    }
    const userId = payload.uid;

    const oauth2Client = createOAuthClient();

    const { tokens } = await oauth2Client.getToken(code);

    oauth2Client.setCredentials(tokens);

    // 👉 Get user email
    const oauth2 = google.oauth2({
      auth: oauth2Client,
      version: "v2",
    });

    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email;

    // 👉 Save in Supabase (one row per user — requires UNIQUE (user_id))
    const { error } = await supabase.from("user_google_accounts").upsert(
      {
        user_id: userId,
        access_token: tokens.access_token,
        // Google only returns a refresh token on consent; never wipe a stored one
        ...(tokens.refresh_token && { refresh_token: tokens.refresh_token }),
        expiry_date: tokens.expiry_date,
        email,
        updated_at: new Date(),
      },
      { onConflict: "user_id" },
    );

    if (error) throw error;

    return res.redirect(
      `${process.env.FRONTEND_URL}/integrations?google=connected`,
    );
  } catch (err) {
    console.error("googleCallback error:", err);

    return res.redirect(
      `${process.env.FRONTEND_URL}/integrations?google=error`,
    );
  }
};

// Revokes Samvaadik's access at Google and removes the stored tokens.
// Groups keep their google_sheet_id, so sync works again after reconnecting.
export const disconnectGoogle = async (req, res) => {
  try {
    const userId = req.user.user_id;

    const { data: account, error: fetchError } = await supabase
      .from("user_google_accounts")
      .select("access_token, refresh_token")
      .eq("user_id", userId)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!account) {
      return res.status(404).json({ error: "Google account is not connected" });
    }

    // Revoking the refresh token also invalidates its access tokens. Best
    // effort — the token may already be revoked by the user in Google settings.
    const tokenToRevoke = account.refresh_token || account.access_token;
    if (tokenToRevoke) {
      try {
        await createOAuthClient().revokeToken(tokenToRevoke);
      } catch (err) {
        console.warn(
          "disconnectGoogle: token revoke failed, continuing:",
          err?.response?.data || err?.message,
        );
      }
    }

    const { error: deleteError } = await supabase
      .from("user_google_accounts")
      .delete()
      .eq("user_id", userId);

    if (deleteError) throw deleteError;

    res.json({ success: true });
  } catch (err) {
    console.error("disconnectGoogle error:", err);
    res.status(500).json({ error: "Failed to disconnect Google account" });
  }
};

// Token + config the frontend needs to open the Google Picker.
export const getPickerToken = async (req, res) => {
  try {
    const userId = req.user.user_id;

    if (!process.env.GOOGLE_PICKER_API_KEY || !process.env.GOOGLE_PROJECT_NUMBER) {
      console.error(
        "getPickerToken: GOOGLE_PICKER_API_KEY / GOOGLE_PROJECT_NUMBER not set",
      );
      return res
        .status(500)
        .json({ error: "Google Picker is not configured on the server" });
    }

    let token;
    try {
      token = await getPickerAccessToken(userId);
    } catch (err) {
      console.error("getPickerToken token error:", err?.message || err);
      return res.status(400).json({
        error:
          "Google account is not connected or the connection expired. Please reconnect Google from the Integrations page.",
        code: "GOOGLE_NOT_CONNECTED",
      });
    }

    res.json({
      ...token,
      apiKey: process.env.GOOGLE_PICKER_API_KEY,
      appId: process.env.GOOGLE_PROJECT_NUMBER,
    });
  } catch (err) {
    console.error("getPickerToken error:", err);
    res.status(500).json({ error: "Failed to get Google Picker token" });
  }
};

// google.controller.js — patched importContactsFromSheet (and syncContactsFromSheet
// has the identical fix — see the bottom of this file).
//
// Change from the original: every `return` inside the row loop that used to
// silently drop a row now pushes a reason into `invalidRows` first.
// Nothing else about the endpoint's shape changes — `skippedRows` in the
// response now finally reflects the true drop count.

export const importContactsFromSheet = async (req, res) => {
  let createdGroupId = null;

  try {
    const { spreadsheetId, group_name, description } = req.body;
    const userId = req.user.user_id;

    if (!spreadsheetId) {
      return res.status(400).json({ error: "spreadsheetId is required" });
    }
    if (!group_name || !description) {
      return res
        .status(400)
        .json({ error: "group_name and description are required" });
    }

    const sheets = await getSheetsClient(userId);

    let response;
    try {
      response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "A1:C1000",
      });
    } catch (err) {
      if (isGoogleFileAccessError(err)) {
        return res.status(403).json({
          error: SHEET_ACCESS_REQUIRED_ERROR,
          code: "SHEET_ACCESS_REQUIRED",
        });
      }
      throw err;
    }

    const rows = response.data.values;

    if (!rows || rows.length < 2) {
      return res.status(400).json({ error: "No data found in the sheet" });
    }

    const headers = rows[0].map((h) => h?.toString().trim().toLowerCase());
    if (headers[0] !== "name") {
      return res.status(400).json({
        error: "Invalid column format: first column header must be 'name'",
      });
    }
    if (headers[1] !== "phoneno") {
      return res.status(400).json({
        error: "Invalid column format: second column header must be 'phoneno'",
      });
    }
    if (headers.length >= 3 && headers[2] !== "email") {
      return res.status(400).json({
        error: "Invalid column format: third column header must be 'email'",
      });
    }

    const invalidRows = [];
    const seenPhones = new Map(); // rawPhone -> first row number it appeared on
    const validRows = [];

    rows.slice(1).forEach((row, index) => {
      const rowNumber = index + 2;
      const name = row[0]?.toString().trim();
      const rawPhone = row[1]?.toString().trim();
      const email = row[2]?.toString().trim() || null;

      // Was: `if (!name || !rawPhone) return;` — silent. Now reported.
      if (!name && !rawPhone) {
        invalidRows.push({
          row: rowNumber,
          name,
          phone: rawPhone,
          reason: "Empty row",
        });
        return;
      }
      if (!name) {
        invalidRows.push({
          row: rowNumber,
          name,
          phone: rawPhone,
          reason: "Missing name",
        });
        return;
      }
      if (!rawPhone) {
        invalidRows.push({
          row: rowNumber,
          name,
          phone: rawPhone,
          reason: "Missing phone number",
        });
        return;
      }

      // Validate phone number: must contain only digits (optionally leading +)
      const phoneDigits = rawPhone.replace(/^\+/, "");
      if (!/^\d+$/.test(phoneDigits)) {
        invalidRows.push({
          row: rowNumber,
          name,
          phone: rawPhone,
          reason: `Invalid phone number format ("${rawPhone}")`,
        });
        return;
      }

      // Was: `if (seenPhones.has(rawPhone)) return;` — silent. Now reported.
      if (seenPhones.has(rawPhone)) {
        invalidRows.push({
          row: rowNumber,
          name,
          phone: rawPhone,
          reason: `Duplicate of row ${seenPhones.get(rawPhone)} (same phone number)`,
        });
        return;
      }
      seenPhones.set(rawPhone, rowNumber);

      validRows.push({ name, phone: rawPhone, email });
    });

    if (validRows.length === 0) {
      return res.status(400).json({
        error: "No valid contacts found",
        ...(invalidRows.length > 0 && { skippedRows: invalidRows }),
      });
    }

    const group = await createGroup({
      user_id: userId,
      group_name,
      description,
      status: "active",
      google_sheet_id: spreadsheetId,
    });
    createdGroupId = group.group_id;

    const contacts = validRows.map(({ name, phone, email }) => ({
      group_id: createdGroupId,
      user_id: userId,
      full_name: name,
      phone_number: phone,
      email,
    }));

    const { error } = await supabase.from("group_contacts").insert(contacts);

    if (error) throw error;

    res.json({
      success: true,
      group,
      count: contacts.length,
      ...(invalidRows.length > 0 && { skippedRows: invalidRows }),
    });
  } catch (err) {
    console.error("importContacts error:", err);

    if (createdGroupId) {
      await supabase
        .from("groups")
        .delete()
        .eq("group_id", createdGroupId)
        .catch((e) =>
          console.error("Rollback failed for group:", createdGroupId, e),
        );
    }

    res.status(500).json({ error: "Import failed" });
  }
};

export const exportCampaignToSheet = async (req, res) => {
  try {
    const { campaign_id } = req.body;
    const userId = req.user.user_id;

    if (!campaign_id) {
      return res.status(400).json({ error: "campaign_id is required" });
    }

    // Fetch campaign to get its name
    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .select(
        "campaign_name, status, total_recipients, messages_sent, messages_failed, scheduled_at",
      )
      .eq("campaign_id", campaign_id)
      .eq("user_id", userId)
      .single();

    if (campaignError || !campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    // Fetch all campaign messages (paginated to bypass Supabase 1000-row limit)
    const batchSize = 1000;
    let from = 0;
    let messages = [];
    let keepFetching = true;

    while (keepFetching) {
      const { data: batch, error: messagesError } = await supabase
        .from("campaign_messages")
        .select(
          "contact_name, phone_number, status, sent_at, delivered_at, read_at, failed_at, error_message",
        )
        .eq("campaign_id", campaign_id)
        .range(from, from + batchSize - 1);

      if (messagesError) throw messagesError;

      messages = [...messages, ...batch];

      if (batch.length < batchSize) {
        keepFetching = false;
      } else {
        from += batchSize;
      }
    }

    // Check Google connection separately so we can give a clear error
    let sheets;
    try {
      sheets = await getSheetsClient(userId);
    } catch {
      return res.status(400).json({
        error:
          "Google account is not connected. Please connect your Google account first.",
      });
    }

    // Create a new spreadsheet named after the campaign
    const sheetTitle = `Campaign Export - ${campaign.campaign_name}`;
    const created = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: sheetTitle },
        sheets: [{ properties: { title: "Messages" } }],
      },
    });

    const newSpreadsheetId = created.data.spreadsheetId;
    const spreadsheetUrl = created.data.spreadsheetUrl;

    // Build rows
    const header = [
      "Contact Name",
      "Phone",
      "Status",
      "Sent At",
      "Delivered At",
      "Read At",
      "Failed At",
      "Error Message",
    ];
    const rows = messages.map((m) => [
      m.contact_name ?? "",
      m.phone_number,
      m.status,
      m.sent_at ?? "",
      m.delivered_at ?? "",
      m.read_at ?? "",
      m.failed_at ?? "",
      m.error_message ?? "",
    ]);

    await sheets.spreadsheets.values.update({
      spreadsheetId: newSpreadsheetId,
      range: "Messages!A1",
      valueInputOption: "RAW",
      requestBody: { values: [header, ...rows] },
    });

    res.json({
      success: true,
      spreadsheetId: newSpreadsheetId,
      spreadsheetUrl,
      rowsExported: rows.length,
    });
  } catch (err) {
    console.error("exportCampaign error:", err);
    res.status(500).json({ error: "Export failed" });
  }
};

export const syncContactsFromSheet = async (req, res) => {
  try {
    const { group_id } = req.body;
    const userId = req.user.user_id;

    if (!group_id) {
      return res.status(400).json({ error: "group_id is required" });
    }

    // Fetch the group and verify ownership + google_sheet_id
    const { data: group, error: groupError } = await supabase
      .from("groups")
      .select("group_id, google_sheet_id")
      .eq("group_id", group_id)
      .eq("user_id", userId)
      .single();

    if (groupError || !group) {
      return res.status(404).json({ error: "Group not found" });
    }

    if (!group.google_sheet_id) {
      return res
        .status(400)
        .json({ error: "This group is not linked to a Google Sheet" });
    }

    const spreadsheetId = group.google_sheet_id;

    const sheets = await getSheetsClient(userId);

    let response;
    try {
      response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "A1:C1000",
      });
    } catch (err) {
      // Groups linked before the drive.file switch lose access once the user
      // reconnects; the frontend re-opens the Picker on this code.
      if (isGoogleFileAccessError(err)) {
        return res.status(403).json({
          error: SHEET_ACCESS_REQUIRED_ERROR,
          code: "SHEET_ACCESS_REQUIRED",
          spreadsheetId,
        });
      }
      throw err;
    }

    const rows = response.data.values;

    if (!rows || rows.length < 2) {
      return res.status(400).json({ error: "No data found in the sheet" });
    }

    // Validate headers
    const headers = rows[0].map((h) => h?.toString().trim().toLowerCase());
    if (headers[0] !== "name") {
      return res.status(400).json({
        error: "Invalid column format: first column header must be 'name'",
      });
    }
    if (headers[1] !== "phoneno") {
      return res.status(400).json({
        error: "Invalid column format: second column header must be 'phoneno'",
      });
    }
    if (headers.length >= 3 && headers[2] !== "email") {
      return res.status(400).json({
        error: "Invalid column format: third column header must be 'email'",
      });
    }

    // Fetch existing phone numbers in this group to skip duplicates
    const { data: existingContacts, error: existingError } = await supabase
      .from("group_contacts")
      .select("phone_number")
      .eq("group_id", group_id);

    if (existingError) throw existingError;

    const existingPhones = new Set(existingContacts.map((c) => c.phone_number));

    const invalidRows = [];
    const seenPhones = new Map();
    const newContacts = [];

    rows.slice(1).forEach((row, index) => {
      const rowNumber = index + 2;
      const name = row[0]?.toString().trim();
      const rawPhone = row[1]?.toString().trim();
      const email = row[2]?.toString().trim() || null;

      // Was: `if (!name || !rawPhone) return;` — silent. Now reported.
      if (!name && !rawPhone) {
        invalidRows.push({
          row: rowNumber,
          name,
          phone: rawPhone,
          reason: "Empty row",
        });
        return;
      }
      if (!name) {
        invalidRows.push({
          row: rowNumber,
          name,
          phone: rawPhone,
          reason: "Missing name",
        });
        return;
      }
      if (!rawPhone) {
        invalidRows.push({
          row: rowNumber,
          name,
          phone: rawPhone,
          reason: "Missing phone number",
        });
        return;
      }

      const phoneDigits = rawPhone.replace(/^\+/, "");
      if (!/^\d+$/.test(phoneDigits)) {
        invalidRows.push({
          row: rowNumber,
          name,
          phone: rawPhone,
          reason: `Invalid phone number format ("${rawPhone}")`,
        });
        return;
      }

      // Was: `if (existingPhones.has(rawPhone) || seenPhones.has(rawPhone)) return;` — silent. Now reported.
      if (existingPhones.has(rawPhone)) {
        invalidRows.push({
          row: rowNumber,
          name,
          phone: rawPhone,
          reason: "Already in this group",
        });
        return;
      }
      if (seenPhones.has(rawPhone)) {
        invalidRows.push({
          row: rowNumber,
          name,
          phone: rawPhone,
          reason: `Duplicate of row ${seenPhones.get(rawPhone)} (same phone number)`,
        });
        return;
      }
      seenPhones.set(rawPhone, rowNumber);

      newContacts.push({ name, phone: rawPhone, email });
    });

    if (newContacts.length === 0) {
      return res.json({
        success: true,
        added: 0,
        message: "No new contacts to add",
        ...(invalidRows.length > 0 && { skippedRows: invalidRows }),
      });
    }

    const contactRows = newContacts.map(({ name, phone, email }) => ({
      group_id,
      user_id: userId,
      full_name: name,
      phone_number: phone,
      email,
    }));

    const { error: insertError } = await supabase
      .from("group_contacts")
      .insert(contactRows);

    if (insertError) throw insertError;

    res.json({
      success: true,
      added: newContacts.length,
      ...(invalidRows.length > 0 && { skippedRows: invalidRows }),
    });
  } catch (err) {
    console.error("syncContactsFromSheet error:", err);
    res.status(500).json({ error: "Sync failed" });
  }
};
