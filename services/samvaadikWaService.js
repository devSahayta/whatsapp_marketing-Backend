// services/samvaadikWaService.js
//
// Backs the "use the Samvaadik AI Assistant from your own WhatsApp number"
// feature: linking a user's personal WhatsApp number to their Samvaadik
// account, storing the per-number conversation history, and sending the
// assistant's replies back out over WhatsApp.
//
// This talks to Samvaadik's OWN dedicated WhatsApp number (configured via
// ASSISTANT_* env vars below), never to a customer's connected WABA — those
// are a completely separate concept (see whatsapp_accounts / waAccountService.js)
// used only to message a business's own end customers.

import axios from "axios";
import crypto from "crypto";
import { supabase } from "../config/supabase.js";

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

// A business number cannot send a single WhatsApp text message over 4096
// characters; split on sentence/line boundaries where possible, hard-cut
// otherwise.
const WHATSAPP_TEXT_LIMIT = 4096;

const LINK_CODE_TTL_MINUTES = 10;
const MAX_LINKS_PER_USER = 5;
const SESSION_HISTORY_LIMIT = 20; // mirrors the trim handleSamvaadikChat already applies

/**
 * Digits-only WhatsApp id, matching the convention already used by
 * chatMessagingService.normalizePhone. Duplicated here (rather than
 * imported) to keep this service dependency-free of the customer-messaging
 * path — they solve similar but independently-evolving problems.
 */
export function normalizeWaId(raw, defaultCountryCode = "91") {
  if (!raw) return null;
  let cleaned = String(raw).replace(/[\s\-().]/g, "");
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
 * The feature is on only when Samvaadik's assistant number is configured.
 * With the env empty, existing clients see no change (webhooks skip the
 * assistant branch, the dashboard card shows as unavailable, no codes).
 */
export function isAssistantConfigured() {
  return !!(
    process.env.ASSISTANT_PHONE_NUMBER_ID &&
    process.env.ASSISTANT_WA_TOKEN &&
    process.env.ASSISTANT_WHATSAPP_BUSINESS_NUMBER
  );
}

function generateCode() {
  // 6 chars, uppercase letters + digits, unambiguous (no 0/O/1/I).
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// ─── Linking ──────────────────────────────────────────────────────────────

/**
 * Starts (or restarts) the link flow for user_id. Returns a fresh code plus
 * the wa.me deep link the dashboard renders as a button/QR — tapping it
 * opens WhatsApp with "LINK XXXXXX" prefilled to Samvaadik's assistant
 * number, so the user only has to hit send.
 */
export async function startLinkCode(user_id) {
  if (!isAssistantConfigured()) {
    const err = new Error(
      "The WhatsApp Assistant is not available yet. Please try again later.",
    );
    err.code = "ASSISTANT_NOT_CONFIGURED";
    throw err;
  }

  const { count, error: countErr } = await supabase
    .from("samvaadik_wa_links")
    .select("link_id", { count: "exact", head: true })
    .eq("user_id", user_id)
    .eq("status", "active");

  if (countErr) throw countErr;
  if ((count || 0) >= MAX_LINKS_PER_USER) {
    const err = new Error(
      `You can link up to ${MAX_LINKS_PER_USER} WhatsApp numbers to the assistant. Unlink one first.`,
    );
    err.code = "LINK_LIMIT_REACHED";
    throw err;
  }

  const code = generateCode();
  const expires_at = new Date(
    Date.now() + LINK_CODE_TTL_MINUTES * 60 * 1000,
  ).toISOString();

  const { error } = await supabase
    .from("samvaadik_wa_link_codes")
    .insert({ code, user_id, expires_at });
  if (error) throw error;

  const assistantNumber = process.env.ASSISTANT_WHATSAPP_BUSINESS_NUMBER;
  const prefilled = encodeURIComponent(`LINK ${code}`);
  return {
    code,
    expires_at,
    expires_in_minutes: LINK_CODE_TTL_MINUTES,
    wa_me_link: assistantNumber
      ? `https://wa.me/${assistantNumber}?text=${prefilled}`
      : null,
  };
}

export async function listLinksForUser(user_id) {
  const { data, error } = await supabase
    .from("samvaadik_wa_links")
    .select("link_id, wa_id, status, linked_at, unlinked_at")
    .eq("user_id", user_id)
    .order("linked_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function unlinkLink(link_id, user_id) {
  const { data, error } = await supabase
    .from("samvaadik_wa_links")
    .update({ status: "unlinked", unlinked_at: new Date().toISOString() })
    .eq("link_id", link_id)
    .eq("user_id", user_id) // ownership check — a user can only unlink their own
    .eq("status", "active")
    .select("link_id")
    .maybeSingle();
  if (error) throw error;
  // Drop the conversation too — it may hold account details
  if (data) await clearSession(link_id);
  return !!data;
}

/** Active link for an inbound wa_id, or null if this number isn't linked. */
export async function getLinkByWaId(wa_id) {
  const { data, error } = await supabase
    .from("samvaadik_wa_links")
    .select("link_id, user_id, wa_id, status")
    .eq("wa_id", wa_id)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * Consumes a "LINK XXXXXX" code sent from wa_id. Creates the link if this
 * is the first time this number has linked, or re-activates it if it was
 * previously unlinked. Returns { user_id, link_id } on success, or
 * { error: "..." } on an invalid/expired/already-used code.
 */
export async function consumeLinkCode(rawCode, wa_id) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return { error: "EMPTY_CODE" };

  const { data: codeRow, error: codeErr } = await supabase
    .from("samvaadik_wa_link_codes")
    .select("code, user_id, expires_at, used_at")
    .eq("code", code)
    .maybeSingle();
  if (codeErr) throw codeErr;
  if (!codeRow) return { error: "NOT_FOUND" };
  if (codeRow.used_at) return { error: "ALREADY_USED" };
  if (new Date(codeRow.expires_at).getTime() < Date.now()) {
    return { error: "EXPIRED" };
  }

  // Mark the code used first (best-effort single-use guarantee under
  // concurrent taps — a second request racing here will find used_at set
  // by the UPDATE...WHERE used_at IS NULL below and get zero rows back).
  const { data: claimed, error: claimErr } = await supabase
    .from("samvaadik_wa_link_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("code", code)
    .is("used_at", null)
    .select("code")
    .maybeSingle();
  if (claimErr) throw claimErr;
  if (!claimed) return { error: "ALREADY_USED" };

  const { data: link, error: linkErr } = await supabase
    .from("samvaadik_wa_links")
    .upsert(
      {
        wa_id,
        user_id: codeRow.user_id,
        status: "active",
        linked_at: new Date().toISOString(),
        unlinked_at: null,
      },
      { onConflict: "wa_id" },
    )
    .select("link_id, user_id")
    .single();
  if (linkErr) throw linkErr;

  // The upsert keeps the same link_id when a number is re-linked (possibly to
  // a different account), so start with an empty conversation — never carry
  // over history from the previous link.
  await clearSession(link.link_id);

  return { user_id: link.user_id, link_id: link.link_id };
}

// ─── Session history (per linked number, not per account — see migration) ──

export async function getSessionMessages(link_id) {
  const { data, error } = await supabase
    .from("samvaadik_wa_sessions")
    .select("messages")
    .eq("link_id", link_id)
    .maybeSingle();
  if (error) throw error;
  return data?.messages || [];
}

export async function saveSessionMessages(link_id, messages) {
  const trimmed =
    messages.length > SESSION_HISTORY_LIMIT
      ? messages.slice(-SESSION_HISTORY_LIMIT)
      : messages;
  const { error } = await supabase.from("samvaadik_wa_sessions").upsert({
    link_id,
    messages: trimmed,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
  return trimmed;
}

export async function clearSession(link_id) {
  const { error } = await supabase
    .from("samvaadik_wa_sessions")
    .delete()
    .eq("link_id", link_id);
  if (error) console.error("[SamvaadikWA] clearSession error:", error);
}

// ─── Sending replies back over WhatsApp ────────────────────────────────────

/**
 * Marks the user's message as read (blue ticks) and shows "typing…" while
 * the assistant works — a turn can take several seconds. Best effort only:
 * failures are logged and ignored.
 */
export async function markReadWithTyping(messageId) {
  const phoneNumberId = process.env.ASSISTANT_PHONE_NUMBER_ID;
  const token = process.env.ASSISTANT_WA_TOKEN;
  if (!messageId || !phoneNumberId || !token) return;
  try {
    await axios.post(
      `${GRAPH_BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 8000,
      },
    );
  } catch (err) {
    console.warn(
      "[SamvaadikWA] typing indicator failed:",
      err.response?.data?.error?.message || err.message,
    );
  }
}

function splitForWhatsApp(text) {
  if (text.length <= WHATSAPP_TEXT_LIMIT) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > WHATSAPP_TEXT_LIMIT) {
    // Prefer to break on a paragraph/line boundary near the limit so a
    // sentence doesn't get cut mid-word across two messages.
    let cut = rest.lastIndexOf("\n", WHATSAPP_TEXT_LIMIT);
    if (cut < WHATSAPP_TEXT_LIMIT * 0.5) cut = WHATSAPP_TEXT_LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Sends the assistant's reply to `to` (wa_id) from Samvaadik's own assistant
 * number — distinct from sendTextToChat in chatMessagingService.js, which
 * sends from a *customer's* connected WABA number. Fire-and-forget safe:
 * failures are logged and swallowed, since by this point the webhook has
 * already returned 200 to Meta and there is no HTTP response left to fail.
 */
export async function sendAssistantWhatsAppText(to, text) {
  const phoneNumberId = process.env.ASSISTANT_PHONE_NUMBER_ID;
  const token = process.env.ASSISTANT_WA_TOKEN;
  if (!phoneNumberId || !token) {
    console.error(
      "[SamvaadikWA] ASSISTANT_PHONE_NUMBER_ID / ASSISTANT_WA_TOKEN not configured",
    );
    return;
  }

  const chunks = splitForWhatsApp(String(text || "").trim() || "(empty reply)");
  for (const chunk of chunks) {
    try {
      await axios.post(
        `${GRAPH_BASE}/${phoneNumberId}/messages`,
        {
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: chunk },
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          timeout: 15000,
        },
      );
    } catch (err) {
      console.error(
        "[SamvaadikWA] Failed to send assistant reply:",
        err.response?.data || err.message,
      );
    }
  }
}
