import { createOAuthClient } from "../config/google.js";
import { supabase } from "../config/supabase.js";
import { google } from "googleapis";
import { getSheetsClient } from "../services/google.service.js";

// ✅ Step 1: Generate Auth URL
export const connectGoogle = async (req, res) => {
  try {
    // const userId = req.user.user_id; // based on your auth middleware

    const userId = req.query.user_id; // For testing, pass user_id as query param (e.g., /connect?user_id=123)

    const oauth2Client = createOAuthClient();

    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
      state: userId, // VERY IMPORTANT
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
    const { code, state } = req.query;

    const userId = state;

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

    // 👉 Save in Supabase (UPSERT)
    const { error } = await supabase.from("user_google_accounts").upsert({
      user_id: userId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
      email,
      updated_at: new Date(),
    });

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

export const importContactsFromSheet = async (req, res) => {
  try {
    const { spreadsheetId, group_id, user_id: userId } = req.body;
    // const userId = req.user.user_id;

    const sheets = await getSheetsClient(userId);

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A1:C1000",
    });

    const rows = response.data.values;

    if (!rows || rows.length < 2) {
      return res.status(400).json({ error: "No data found" });
    }

    const contacts = rows.slice(1).map((row) => ({
      group_id,
      user_id: userId,
      full_name: row[0],
      phone_number: row[1],
      email: row[2],
    }));

    const { error } = await supabase.from("group_contacts").insert(contacts);

    if (error) throw error;

    res.json({ success: true, count: contacts.length });
  } catch (err) {
    console.error("importContacts error:", err);
    res.status(500).json({ error: "Import failed" });
  }
};

export const exportCampaignToSheet = async (req, res) => {
  try {
    const { campaign_id, spreadsheetId } = req.body;
    const userId = req.user.user_id;

    const sheets = await getSheetsClient(userId);

    const { data, error } = await supabase
      .from("campaign_messages")
      .select("phone_number, status, sent_at")
      .eq("campaign_id", campaign_id);

    if (error) throw error;

    const values = [
      ["Phone", "Status", "Sent At"],
      ...data.map((row) => [row.phone_number, row.status, row.sent_at]),
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "Sheet1!A1",
      valueInputOption: "RAW",
      requestBody: { values },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("exportCampaign error:", err);
    res.status(500).json({ error: "Export failed" });
  }
};
