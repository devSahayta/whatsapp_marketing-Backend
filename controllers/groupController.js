import { Readable } from "stream";
import { parse } from "@fast-csv/parse";
import { supabase } from "../config/supabase.js";
import {
  createGroup,
  bulkInsertGroupContacts,
  listGroupsByUser,
  getGroupWithContacts,
} from "../models/groupModel.js";

/* -------------------- Helpers -------------------- */

// Safe filename
const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .slice(0, 60);

// Find CSV column
const findColumn = (headers, candidates) => {
  const lower = headers.map((h) => h.toLowerCase());
  for (const c of candidates) {
    const i = lower.indexOf(c.toLowerCase());
    if (i !== -1) return headers[i];
  }
  return null;
};

/* -------------------- CREATE GROUP + CSV -------------------- */

export const createGroupWithCsv = async (req, res) => {
  try {
    const { user_id, group_name, description } = req.body;
    const file = req.file;

    if (!user_id || !group_name) {
      return res.status(400).json({
        error: "user_id and group_name are required",
      });
    }

    if (!file) {
      return res.status(400).json({
        error: "CSV file is required (field name: dataset)",
      });
    }

    /* ---------- 1️⃣ Upload CSV ---------- */
    const key = `${user_id}/${Date.now()}_${slug(group_name)}.csv`;

    const upload = await supabase.storage
      .from("group-csvs")
      .upload(key, file.buffer, {
        contentType: "text/csv",
      });

    if (upload.error) {
      return res.status(500).json({
        error: `CSV upload failed: ${upload.error.message}`,
      });
    }

    const { data: publicUrl } = supabase.storage
      .from("group-csvs")
      .getPublicUrl(key);

    /* ---------- 2️⃣ Create Group ---------- */
    const group = await createGroup({
      user_id,
      group_name,
      description,
      uploaded_csv: publicUrl.publicUrl,
      status: "active",
    });

    /* ---------- 3️⃣ Parse CSV ---------- */
    const rows = [];
    const headers = [];

    await new Promise((resolve, reject) => {
      Readable.from(file.buffer)
        .pipe(parse({ headers: true, ignoreEmpty: true, trim: true }))
        .on("headers", (h) => headers.push(...h))
        .on("data", (row) => rows.push(row))
        .on("error", reject)
        .on("end", resolve);
    });

    if (!rows.length) {
      return res.status(201).json({
        message: "Group created (CSV had no rows)",
        group,
        contactsInserted: 0,
      });
    }

    /* ---------- 4️⃣ Detect Columns ---------- */
    const nameCol = findColumn(headers, ["name", "full_name"]);
    const phoneCol = findColumn(headers, [
      "phone",
      "phone_number",
      "mobile",
      "phoneno",
    ]);
    const emailCol = findColumn(headers, ["email"]);

    if (!phoneCol) {
      return res.status(400).json({
        error: "CSV must contain a phone number column",
      });
    }

    /* ---------- 5️⃣ Build Contacts ---------- */
    const contacts = rows
      .map((r) => ({
        group_id: group.group_id,
        user_id,
        full_name: nameCol ? r[nameCol]?.trim() : null,
        email: emailCol ? r[emailCol]?.trim() : null,
        phone_number: r[phoneCol]?.trim(),
      }))
      .filter((c) => c.phone_number);

    /* ---------- 6️⃣ Insert Contacts ---------- */
    let insertedCount = 0;
    if (contacts.length) {
      const inserted = await bulkInsertGroupContacts(contacts);
      insertedCount = inserted.length;
    }

    return res.status(201).json({
      message: "Group created successfully",
      group,
      contactsInserted: insertedCount,
    });
  } catch (err) {
    console.error("createGroupWithCsv error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

/* -------------------- GET GROUPS -------------------- */

export const getGroupsByUser = async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: "user_id required" });

    const groups = await listGroupsByUser(user_id);
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch groups" });
  }
};

/* -------------------- GET SINGLE GROUP -------------------- */

export const getGroupById = async (req, res) => {
  try {
    const { groupId } = req.params;

    const group = await getGroupWithContacts(groupId);
    if (!group) return res.status(404).json({ error: "Group not found" });

    res.json(group);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch group" });
  }
};

// GET all participants (contacts) for a group
export const getGroupParticipants = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { user_id } = req.query; // optional ownership check

    if (!groupId) {
      return res.status(400).json({ error: "groupId is required" });
    }

    // 1️⃣ Fetch group (optional ownership validation)
    const { data: group, error: groupError } = await supabase
      .from("groups")
      .select("group_id, user_id")
      .eq("group_id", groupId)
      .single();

    if (groupError || !group) {
      return res.status(404).json({ error: "Group not found" });
    }

    // 2️⃣ Ownership check (recommended)
    if (user_id && group.user_id !== user_id) {
      return res.status(403).json({ error: "Unauthorized access" });
    }

    // 3️⃣ Fetch group contacts
    const { data: contacts, error } = await supabase
      .from("group_contacts")
      .select("*" )
      .eq("group_id", groupId)
      .order("uploaded_at", { ascending: false });

    if (error) {
      throw error;
    }

    return res.status(200).json({
      group_id: groupId,
      total: contacts.length,
      participants: contacts,
    });
  } catch (err) {
    console.error("getGroupParticipants error:", err);
    return res.status(500).json({
      error: "Failed to fetch group participants",
    });
  }
};

