// controllers/chatController.js
import { supabase } from "../config/supabase.js";

/**
 * Ensure a chat exists for (phone_number, group_id).
 * FETCHES person_name from group_contacts table if available.
 * If not exists, insert and return the new chat.
 */

export async function ensureChat({ group_id, phone_number, person_name }) {
  // 🔍 STEP 1: Check if chat already exists
  const { data: existing, error: findErr } = await supabase
    .from("chats")
    .select("*")
    .eq("group_id", group_id)
    .eq("phone_number", phone_number)
    .maybeSingle();

  if (findErr) throw findErr;

  // 🔍 STEP 2: Fetch actual name from group_contacts table
  const actualName = await getPersonNameFromContacts(group_id, phone_number);

  // 🔁 If chat exists, update person_name if missing or different
  if (existing) {
    if (!existing.person_name || existing.person_name === phone_number) {
      await supabase
        .from("chats")
        .update({ person_name: actualName || phone_number })
        .eq("chat_id", existing.chat_id);

      // Return updated version
      return { ...existing, person_name: actualName || phone_number };
    }
    return existing;
  }

  // ✅ Create new chat with proper name
  const { data: inserted, error: insertErr } = await supabase
    .from("chats")
    .insert([
      {
        group_id,
        phone_number,
        person_name: actualName || phone_number, // Use actual name or fallback to phone
        last_message: "",
        last_message_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
    ])
    .select()
    .single();

  if (insertErr) throw insertErr;
  return inserted;
}

/**
 * 🔍 Fetch person's full_name from group_contacts table
 * Returns the name if found, otherwise null
 */
async function getPersonNameFromContacts(group_id, phone_number) {
  try {
    // Clean phone number for matching (remove spaces, dashes, etc.)
    const cleanPhone = phone_number.replace(/[\s\-\(\)]/g, "");

    const { data, error } = await supabase
      .from("group_contacts")
      .select("full_name, phone_number")
      .eq("group_id", group_id)
      .limit(100); // Get all contacts for this group

    if (error || !data) return null;

    // Find matching contact (handle different phone formats)
    const match = data.find((contact) => {
      const contactClean = contact.phone_number?.replace(/[\s\-\(\)]/g, "");

      // Match exact or last 10 digits
      return (
        contactClean === cleanPhone ||
        contactClean?.endsWith(cleanPhone.slice(-10)) ||
        cleanPhone?.endsWith(contactClean?.slice(-10))
      );
    });

    return match?.full_name?.trim() || null;
  } catch (err) {
    console.error("Error fetching person name from contacts:", err);
    return null;
  }
}

/**
 * Normalize person name - prevent phone numbers from being used as names
 */
const normalizePersonName = (person_name, phone_number) => {
  if (!person_name) return null;

  const clean = person_name.trim();

  // ❌ If name is same as phone number → ignore
  if (clean === phone_number) return null;

  // ❌ If name is only digits (likely a phone number)
  if (/^\d+$/.test(clean)) return null;

  // ❌ Too short / invalid
  if (clean.length < 2) return null;

  return clean;
};

/**
 * Save a message row.
 * Returns inserted message row.
 */
export async function saveMessage({
  chat_id,
  sender_type = "user",
  message,
  message_type = "text",
  media_path = null,
  buttons = null,
}) {
  if (!message || message.trim() === "") {
    message = `[${message_type.toUpperCase()}]`;
  }

  const payload = {
    chat_id,
    sender_type,
    message,
    message_type,
    media_path,
    buttons,
    created_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("messages")
    .insert([payload])
    .select();

  if (error) throw error;

  // Update last message in chats table
  await supabase
    .from("chats")
    .update({
      last_message: message,
      last_message_at: new Date().toISOString(),
    })
    .eq("chat_id", chat_id);

  return data[0];
}

/**
 * Fetch chats for a group — useful for left sidebar.
 * Returns chats ordered by last_message_at desc.
 */
export async function getChatsForGroup({ group_id, limit = 100, offset = 0 }) {
  const { data, error } = await supabase
    .from("chats")
    .select(
      "chat_id, group_id, phone_number, person_name, last_message, created_at, last_message_at, mode",
    )
    .eq("group_id", group_id)
    .order("last_message_at", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  // 🔍 Enhance with actual names from group_contacts
  const enhanced = await Promise.all(
    (data || []).map(async (chat) => {
      // If person_name is missing or is a phone number, fetch from contacts
      if (
        !chat.person_name ||
        chat.person_name === chat.phone_number ||
        /^\d+$/.test(chat.person_name)
      ) {
        const actualName = await getPersonNameFromContacts(
          group_id,
          chat.phone_number,
        );

        if (actualName) {
          // Update the chat with actual name
          await supabase
            .from("chats")
            .update({ person_name: actualName })
            .eq("chat_id", chat.chat_id);

          chat.person_name = actualName;
        }
      }
      return chat;
    }),
  );

  return enhanced;
}

export async function getChatsForUser({ user_id, limit = 100, offset = 0 }) {
  const { data, error } = await supabase
    .from("chats")
    .select(
      "chat_id, user_id, phone_number, person_name, last_message, last_message_at, created_at, mode",
    )
    .eq("user_id", user_id)
    .order("last_message_at", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  return data || [];
}

/**
 * Fetch messages for a chat with pagination.
 * Returns messages in chronological order (oldest -> newest)
 */
export async function getMessagesForChat({
  chat_id,
  limit = 50,
  before = null,
}) {
  let query = supabase
    .from("messages")
    .select(
      "message_id, chat_id, sender_type, message, message_type, media_path, created_at, buttons",
    )
    .eq("chat_id", chat_id)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (before) {
    query = query.lt("created_at", before);
  }

  const { data, error } = await query;
  if (error) {
    console.error("❌ getMessagesForChat error:", error);
    throw error;
  }

  const messages = data || [];

  // 🔥 Auto-generate new signed URLs for messages with media_path
  for (let msg of messages) {
    if (!msg.media_path) continue;

    const { data: signed } = await supabase.storage
      .from("participant-docs")
      .createSignedUrl(msg.media_path, 60 * 60 * 24); // 24 hours

    if (signed?.signedUrl) {
      msg.media_path = signed.signedUrl;
    }
  }

  return messages;
}

/**
 * 🔧 UTILITY: Fix all existing chats with phone numbers as person_name
 * Run this once to clean up existing data
 */
export async function fixExistingChatNames(group_id) {
  try {
    const { data: chats } = await supabase
      .from("chats")
      .select("chat_id, phone_number, person_name, group_id")
      .eq("group_id", group_id);

    if (!chats) return;

    for (const chat of chats) {
      // Skip if already has a valid name
      if (
        chat.person_name &&
        chat.person_name !== chat.phone_number &&
        !/^\d+$/.test(chat.person_name)
      ) {
        continue;
      }

      // Fetch actual name from contacts
      const actualName = await getPersonNameFromContacts(
        chat.group_id,
        chat.phone_number,
      );

      if (actualName) {
        await supabase
          .from("chats")
          .update({ person_name: actualName })
          .eq("chat_id", chat.chat_id);

        console.log(`✅ Updated chat ${chat.chat_id}: ${actualName}`);
      }
    }

    console.log("✅ All chat names fixed!");
  } catch (err) {
    console.error("❌ Error fixing chat names:", err);
  }
}
