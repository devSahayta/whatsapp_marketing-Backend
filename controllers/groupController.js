//Controllers/groupController.js

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

/* -------------------- GET GROUP PARTICIPANTS -------------------- */

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

/* -------------------- ADD SINGLE CONTACT -------------------- */

export const addContactToGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { full_name, phone_number, email } = req.body;

    // Validation
    if (!groupId) {
      return res.status(400).json({ error: "Group ID is required" });
    }

    if (!full_name || !phone_number) {
      return res.status(400).json({ 
        error: "full_name and phone_number are required" 
      });
    }

    // 1️⃣ Verify group exists
    const { data: group, error: groupError } = await supabase
      .from("groups")
      .select("group_id, user_id")
      .eq("group_id", groupId)
      .single();

    if (groupError || !group) {
      return res.status(404).json({ error: "Group not found" });
    }

    // 2️⃣ Check if contact already exists (prevent duplicates)
    const { data: existing } = await supabase
      .from("group_contacts")
      .select("contact_id")
      .eq("group_id", groupId)
      .eq("phone_number", phone_number.trim())
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ 
        error: "Contact with this phone number already exists in this group" 
      });
    }

    // 3️⃣ Insert new contact
    const { data: newContact, error: insertError } = await supabase
      .from("group_contacts")
      .insert([
        {
          group_id: groupId,
          user_id: group.user_id,
          full_name: full_name.trim(),
          phone_number: phone_number.trim(),
          email: email?.trim() || null,
        },
      ])
      .select()
      .single();

    if (insertError) {
      throw insertError;
    }

    return res.status(201).json({
      message: "Contact added successfully",
      contact: newContact,
    });
  } catch (err) {
    console.error("addContactToGroup error:", err);
    return res.status(500).json({ 
      error: "Failed to add contact" 
    });
  }
};

/* -------------------- DELETE SINGLE CONTACT -------------------- */

export const deleteContact = async (req, res) => {
  try {
    const { contactId } = req.params;

    if (!contactId) {
      return res.status(400).json({ error: "Contact ID is required" });
    }

    // 1️⃣ Check if contact exists
    const { data: contact, error: fetchError } = await supabase
      .from("group_contacts")
      .select("contact_id, phone_number, group_id")
      .eq("contact_id", contactId)
      .single();

    if (fetchError || !contact) {
      return res.status(404).json({ error: "Contact not found" });
    }

    // 2️⃣ Delete associated chat messages (if any)
    const { data: chats } = await supabase
      .from("chats")
      .select("chat_id")
      .eq("group_id", contact.group_id)
      .eq("phone_number", contact.phone_number);

    if (chats && chats.length > 0) {
      const chatIds = chats.map((c) => c.chat_id);

      // Delete messages
      await supabase
        .from("messages")
        .delete()
        .in("chat_id", chatIds);

      // Delete chats
      await supabase
        .from("chats")
        .delete()
        .in("chat_id", chatIds);
    }

    // 3️⃣ Delete contact
    const { error: deleteError } = await supabase
      .from("group_contacts")
      .delete()
      .eq("contact_id", contactId);

    if (deleteError) {
      throw deleteError;
    }

    return res.status(200).json({
      message: "Contact deleted successfully",
    });
  } catch (err) {
    console.error("deleteContact error:", err);
    return res.status(500).json({ 
      error: "Failed to delete contact" 
    });
  }
};

/* -------------------- BULK DELETE CONTACTS -------------------- */

export const bulkDeleteContacts = async (req, res) => {
  try {
    const { ids } = req.body;

    // Validation
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ 
        error: "ids array is required and must not be empty" 
      });
    }

    // 1️⃣ Get all contacts to delete
    const { data: contacts, error: fetchError } = await supabase
      .from("group_contacts")
      .select("contact_id, phone_number, group_id")
      .in("contact_id", ids);

    if (fetchError) {
      throw fetchError;
    }

    if (!contacts || contacts.length === 0) {
      return res.status(404).json({ 
        error: "No contacts found with provided IDs" 
      });
    }

    // 2️⃣ Get all chats for these contacts
    const phoneNumbers = contacts.map((c) => c.phone_number);
    const groupIds = [...new Set(contacts.map((c) => c.group_id))];

    const { data: chats } = await supabase
      .from("chats")
      .select("chat_id")
      .in("group_id", groupIds)
      .in("phone_number", phoneNumbers);

    // 3️⃣ Delete messages and chats
    if (chats && chats.length > 0) {
      const chatIds = chats.map((c) => c.chat_id);

      // Delete messages
      await supabase
        .from("messages")
        .delete()
        .in("chat_id", chatIds);

      // Delete chats
      await supabase
        .from("chats")
        .delete()
        .in("chat_id", chatIds);
    }

    // 4️⃣ Delete contacts
    const { error: deleteError } = await supabase
      .from("group_contacts")
      .delete()
      .in("contact_id", ids);

    if (deleteError) {
      throw deleteError;
    }

    return res.status(200).json({
      message: `${contacts.length} contact(s) deleted successfully`,
      deletedCount: contacts.length,
    });
  } catch (err) {
    console.error("bulkDeleteContacts error:", err);
    return res.status(500).json({ 
      error: "Failed to delete contacts" 
    });
  }
};

/* -------------------- DELETE GROUP -------------------- */

export const deleteGroup = async (req, res) => {
  try {
    const { groupId } = req.params;

    if (!groupId) {
      return res.status(400).json({ error: "Group ID is required" });
    }

    /* ---------- 1️⃣ Get group ---------- */
    const { data: group, error: groupErr } = await supabase
      .from("groups")
      .select("group_id, uploaded_csv")
      .eq("group_id", groupId)
      .single();

    if (groupErr || !group) {
      return res.status(404).json({ error: "Group not found" });
    }

    /* ---------- 2️⃣ Get chats under group ---------- */
    const { data: chats, error: chatErr } = await supabase
      .from("chats")
      .select("chat_id")
      .eq("group_id", groupId);

    if (chatErr) throw chatErr;

    const chatIds = chats?.map((c) => c.chat_id) || [];

    /* ---------- 3️⃣ Delete messages ---------- */
    if (chatIds.length > 0) {
      await supabase
        .from("messages")
        .delete()
        .in("chat_id", chatIds);
    }

    /* ---------- 4️⃣ Delete chats ---------- */
    await supabase
      .from("chats")
      .delete()
      .eq("group_id", groupId);

    /* ---------- 5️⃣ Delete group contacts ---------- */
    await supabase
      .from("group_contacts")
      .delete()
      .eq("group_id", groupId);

    /* ---------- 6️⃣ Delete CSV from storage ---------- */
    if (group.uploaded_csv) {
      try {
        const path = group.uploaded_csv.split("/group-csvs/")[1];
        if (path) {
          await supabase.storage.from("group-csvs").remove([path]);
        }
      } catch (storageErr) {
        console.warn("⚠️ CSV deletion failed:", storageErr.message);
        // DO NOT block deletion
      }
    }

    /* ---------- 7️⃣ Delete group ---------- */
    await supabase
      .from("groups")
      .delete()
      .eq("group_id", groupId);

    return res.status(200).json({
      message: "Group deleted successfully",
    });
  } catch (error) {
    console.error("deleteGroup error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};