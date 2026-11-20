// services/chatMessagingService.js
// Shared one-to-one chat messaging used by the chat dashboard
// (adminChatController) and the Samvaadik AI assistant (agentTools).

import axios from "axios";
import { supabase } from "../config/supabase.js";
import { getWhatsappAccount } from "./waAccountService.js";

const GRAPH_BASE = "https://graph.facebook.com/v21.0";
export const WINDOW_HOURS = 24;

/**
 * Normalise a phone number to WhatsApp's digits-only international format.
 * 10-digit numbers without a country code are treated as Indian (+91),
 * matching the scheduler's normalizePhone.
 */
export function normalizePhone(phone, defaultCountryCode = "91") {
  if (!phone) return null;
  let cleaned = String(phone).replace(/[\s\-().]/g, "");
  if (cleaned.startsWith("+")) {
    const digits = cleaned.replace(/\D/g, "");
    return digits.length >= 10 ? digits : null;
  }
  if (cleaned.startsWith("00")) cleaned = cleaned.slice(2);
  else if (cleaned.startsWith("0")) cleaned = cleaned.slice(1);
  cleaned = cleaned.replace(/\D/g, "");
  if (cleaned.length === 10) return defaultCountryCode + cleaned;
  return cleaned.length >= 11 && cleaned.length <= 15 ? cleaned : null;
}

/**
 * Meta's customer service window: free-form text is allowed only within
 * 24 hours of the user's LAST inbound message. A template sent by the admin
 * does not close or shorten an open window.
 * Mirrored by computeWindowStatus in the frontend ChatWindow.jsx.
 *
 * Returns { allowed, reason, last_user_message_at, hours_left }
 */
export async function getTextWindowStatus(chat_id) {
  const { data: lastUserMsg } = await supabase
    .from("messages")
    .select("created_at")
    .eq("chat_id", chat_id)
    .eq("sender_type", "user")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!lastUserMsg?.created_at) {
    return { allowed: false, reason: "NO_USER_REPLY", last_user_message_at: null, hours_left: 0 };
  }

  const diffHours =
    (Date.now() - new Date(lastUserMsg.created_at).getTime()) / (1000 * 60 * 60);

  if (diffHours >= WINDOW_HOURS) {
    return {
      allowed: false,
      reason: "WINDOW_EXPIRED",
      last_user_message_at: lastUserMsg.created_at,
      hours_left: 0,
    };
  }

  return {
    allowed: true,
    reason: null,
    last_user_message_at: lastUserMsg.created_at,
    hours_left: Math.round((WINDOW_HOURS - diffHours) * 10) / 10,
  };
}

export const WINDOW_ERROR_MESSAGES = {
  NO_USER_REPLY: "User has not replied yet. You can only send templates.",
  WINDOW_EXPIRED:
    "24-hour window expired. Please send a template to re-engage the user.",
};

/**
 * Send a free-form text message into an existing chat.
 * `chat` must already be ownership-checked by the caller.
 *
 * Returns { ok: true, message } or { ok: false, status, error, code }
 */
export async function sendTextToChat(chat, message) {
  const text = (message || "").trim();
  if (!text) return { ok: false, status: 400, error: "Message is empty", code: "EMPTY_MESSAGE" };

  const permission = await getTextWindowStatus(chat.chat_id);
  if (!permission.allowed) {
    return {
      ok: false,
      status: 403,
      error: WINDOW_ERROR_MESSAGES[permission.reason] ||
        "You can only send WhatsApp templates at this time.",
      code: permission.reason,
    };
  }

  // Send from the chat owner's own WhatsApp number
  const account = await getWhatsappAccount(chat.user_id);
  if (!account?.phone_number_id || !account?.system_user_access_token) {
    return { ok: false, status: 400, error: "WhatsApp account not found", code: "NO_ACCOUNT" };
  }

  let whatsappResponse;
  try {
    const metaRes = await axios.post(
      `${GRAPH_BASE}/${account.phone_number_id}/messages`,
      {
        messaging_product: "whatsapp",
        to: chat.phone_number,
        type: "text",
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${account.system_user_access_token}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      },
    );
    whatsappResponse = metaRes.data;
  } catch (err) {
    const metaError = err.response?.data?.error;
    console.error("❌ Failed to send WhatsApp text:", metaError || err.message);

    // 131047 = re-engagement required (window closed on Meta's side)
    if (metaError?.code === 131047) {
      return {
        ok: false,
        status: 403,
        error: WINDOW_ERROR_MESSAGES.WINDOW_EXPIRED,
        code: "WINDOW_EXPIRED",
      };
    }
    return {
      ok: false,
      status: 502,
      error:
        metaError?.error_data?.details ||
        metaError?.message ||
        "Failed to send WhatsApp message",
      code: metaError?.code || "META_SEND_FAILED",
    };
  }

  const waMessageId = whatsappResponse?.messages?.[0]?.id;
  if (!waMessageId) {
    return { ok: false, status: 502, error: "Failed to send WhatsApp message", code: "META_SEND_FAILED" };
  }

  const now = new Date().toISOString();

  // Log in whatsapp_messages (status webhooks update this row → chat ticks)
  const { data: log, error: logError } = await supabase
    .from("whatsapp_messages")
    .insert({
      account_id: account.wa_id,
      to_number: chat.phone_number,
      message_body: whatsappResponse,
      wa_message_id: waMessageId,
      status: "sent",
      sent_at: now,
    })
    .select()
    .single();
  if (logError) console.error("sendTextToChat wm insert error:", logError);

  const { data: msgRow, error: messageError } = await supabase
    .from("messages")
    .insert({
      chat_id: chat.chat_id,
      sender_type: "admin",
      message: text,
      message_type: "text",
      media_path: null,
      wm_id: log?.wm_id || null,
      created_at: now,
    })
    .select()
    .single();
  if (messageError) throw messageError;

  await supabase
    .from("chats")
    .update({
      last_message: text,
      last_message_at: now,
      last_admin_message_at: now,
      last_sender_type: "admin",
      updated_at: now,
    })
    .eq("chat_id", chat.chat_id);

  return { ok: true, message: msgRow };
}
