import { createOAuthClient } from "../config/google.js";
import { supabase } from "../config/supabase.js";
import { google } from "googleapis";
import { getSheetsClient, getDriveClient } from "../services/google.service.js";
import { createGroup } from "../models/groupModel.js";

// ✅ Step 1: Generate Auth URL
export const connectGoogle = async (req, res) => {
  try {
    // console.log({ user: req.user }); // Debugging line to check req.user
    const userId = req.user.user_id; // based on your auth middleware

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

export const getGoogleSheets = async (req, res) => {
  try {
    const user_id = req.user.user_id;

    const drive = await getDriveClient(user_id);

    const response = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.spreadsheet'",
      fields: "files(id, name)",
    });

    res.json({ sheets: response.data.files });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch sheets" });
  }
};

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

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A1:C1000",
    });

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

    const invalidRows = [];
    const seenPhones = new Set();
    const validRows = [];

    rows.slice(1).forEach((row, index) => {
      const rowNumber = index + 2;
      const name = row[0]?.toString().trim();
      const rawPhone = row[1]?.toString().trim();
      const email = row[2]?.toString().trim() || null;

      if (!name || !rawPhone) return; // skip empty rows

      // Validate phone number: must contain only digits (optionally leading +)
      const phoneDigits = rawPhone.replace(/^\+/, "");
      if (!/^\d+$/.test(phoneDigits)) {
        invalidRows.push({
          row: rowNumber,
          phone: rawPhone,
          reason: "Invalid phone number",
        });
        return;
      }

      // Deduplicate by phone number
      if (seenPhones.has(rawPhone)) return;
      seenPhones.add(rawPhone);

      validRows.push({ name, phone: rawPhone, email });
    });

    if (validRows.length === 0) {
      return res.status(400).json({
        error: "No valid contacts found",
        ...(invalidRows.length > 0 && { invalidRows }),
      });
    }

    // Create a new group
    const group = await createGroup({
      user_id: userId,
      group_name,
      description,
      status: "active",
    });
    createdGroupId = group.group_id;

    // Build contacts with the new group_id
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

    // Rollback: delete the group if it was created but contacts insert failed
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
      return res
        .status(400)
        .json({
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
