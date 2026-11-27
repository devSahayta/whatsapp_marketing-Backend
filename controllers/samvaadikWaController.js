// controllers/samvaadikWaController.js
//
// Two surfaces for the "use the Samvaadik AI Assistant from your own
// WhatsApp number" feature:
//
//  1. Kinde-authed dashboard endpoints — start a link, list linked numbers,
//     unlink one. Mounted under /api/agents/samvaadik/wa/* (see agentRoutes.js).
//  2. processAssistantInbound — called from whatsappController.handleIncomingMessage
//     when an inbound message's phone_number_id is Samvaadik's own assistant
//     number (ASSISTANT_PHONE_NUMBER_ID), instead of the normal per-customer
//     whatsapp_accounts lookup. Runs the SAME tool-loop the dashboard chat
//     widget uses (runSamvaadikAssistant in agentController.js) — nothing
//     about campaign/template/contact logic is duplicated here.

import { runSamvaadikAssistant } from "./agentController.js";
import {
  startLinkCode,
  listLinksForUser,
  unlinkLink,
  getLinkByWaId,
  consumeLinkCode,
  getSessionMessages,
  saveSessionMessages,
  clearSession,
  sendAssistantWhatsAppText,
  markReadWithTyping,
  normalizeWaId,
  isAssistantConfigured,
} from "../services/samvaadikWaService.js";

// ── Dashboard endpoints (Kinde-authed) ──────────────────────────────────────

// NOTE: user_id is always read from req.user (set by authenticateUser from
// the verified Kinde token) rather than from the request body/query — a
// user_id could otherwise be supplied by the caller and used to start,
// list or unlink another account's WhatsApp links.
export const startLink = async (req, res) => {
  try {
    const result = await startLinkCode(req.user.user_id);
    return res.json({ success: true, ...result });
  } catch (err) {
    if (err.code === "LINK_LIMIT_REACHED") {
      return res.status(409).json({ success: false, error: err.message });
    }
    if (err.code === "ASSISTANT_NOT_CONFIGURED") {
      return res
        .status(503)
        .json({ success: false, error: err.message, enabled: false });
    }
    console.error("❌ startLink:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const listLinks = async (req, res) => {
  try {
    // Feature off (env not set): tell the card, skip the database entirely
    if (!isAssistantConfigured()) {
      return res.json({ success: true, enabled: false, links: [], assistant_number: null });
    }
    const links = await listLinksForUser(req.user.user_id);
    return res.json({
      success: true,
      enabled: true,
      links,
      assistant_number: process.env.ASSISTANT_WHATSAPP_BUSINESS_NUMBER || null,
    });
  } catch (err) {
    console.error("❌ listLinks:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

export const unlink = async (req, res) => {
  try {
    const { link_id } = req.params;
    const ok = await unlinkLink(link_id, req.user.user_id);
    if (!ok) {
      return res.status(404).json({
        success: false,
        error: "No active link found with that id for your account.",
      });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("❌ unlink:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ── Webhook path ────────────────────────────────────────────────────────────

const LINK_CODE_RE = /^\s*link\s*[:\-]?\s*([a-z0-9]{6})\s*[.!]?\s*$/i;
const RESET_RE = /^\s*(reset|new chat|start over|clear)\s*[.!]?\s*$/i;

const DASHBOARD_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
const withLink = (label, path) =>
  DASHBOARD_URL
    ? `${label}: ${DASHBOARD_URL}${path}`
    : `${label} in the Samvaadik dashboard.`;

// The web assistant turns these markers into buttons/cards. A WhatsApp text
// message has none, so each marker is removed and replaced with a short line
// with a dashboard link — the assistant's own explanation text is kept.
export function adaptReplyForWhatsApp(text) {
  let out = String(text || "");
  const notes = [];

  const take = (re, note) => {
    if (re.test(out)) {
      out = out.replace(re, "");
      if (note && !notes.includes(note)) notes.push(note);
    }
  };

  take(/REDIRECT_TO_PRICING:\s*/g, withLink("Top up credits", "/pricing"));
  take(/REDIRECT_TO_TEMPLATES:\s*/g, withLink("Open Templates", "/templates"));
  take(/REDIRECT_TO_BUILDER:[a-f0-9-]+\s*/gi, withLink("Open Chatbot Flows", "/chatbot"));
  take(/REDIRECT_TO_FLOWS:\s*/g, withLink("Open Chatbot Flows", "/chatbot"));
  take(/GOOGLE_NOT_CONNECTED:\s*/g, withLink("Connect Google", "/integrations"));
  take(
    /GOOGLE_PICK_SHEET:\s*/g,
    'To choose a sheet from Google Drive, open the AI Assistant in the Samvaadik dashboard and use "Choose from Google Drive", then come back here.',
  );
  // Web-only template picker — should not appear here, but never leak it
  take(/`?OPEN_TEMPLATE_PICKER:\S*`?/g, null);

  out = out
    // No buttons exist on WhatsApp — drop "using the button below" style
    // phrases the model may copy from the web instructions
    .replace(
      /(?<=\w)(?:,\s*|[ \t]+)(?:by\s+)?(?:using|use|with|via|click(?:ing)?|tap(?:ping)?)\s+(?:on\s+)?the\s+(?:[\w"'“”-]+\s+){0,4}button(?:\s+(?:below|above))?/gi,
      "",
    )
    .replace(/\s*\((?:see\s+)?(?:the\s+)?button\s+below\)/gi, "")
    // WhatsApp bold is *single*; the web assistant uses **double**
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (notes.length) out = `${out}\n\n${notes.join("\n")}`.trim();
  return out || "Done.";
}

function extractInboundText(message) {
  if (message.type === "text") return message.text?.body?.trim() || "";
  if (message.type === "button") {
    return message.button?.text || message.button?.payload || "";
  }
  if (message.type === "interactive") {
    return (
      message.interactive?.button_reply?.title ||
      message.interactive?.list_reply?.title ||
      ""
    );
  }
  return null; // unsupported type (image/audio/document/...) for v1
}

// The model API needs alternating turns that start with the user. Stored
// history can break that (a failed turn leaves two user messages in a row,
// trimming can cut the first user message), so normalise before each run.
// Also drops the stored wamid field, which the model API would reject.
export function toModelMessages(history) {
  const out = [];
  for (const m of history) {
    if (!m || !["user", "assistant"].includes(m.role)) continue;
    const content = String(m.content || "").trim();
    if (!content) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += `\n\n${content}`;
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

/**
 * Called from whatsappController.handleIncomingMessage, in the background
 * (after Meta already got its 200), when the inbound phone_number_id is
 * Samvaadik's own assistant number. Never throws — any failure here must not
 * crash the webhook's background task; it's logged and, where possible, the
 * user gets a plain "something went wrong" reply instead of silence.
 */
export async function processAssistantInbound(value) {
  try {
    const message = value?.messages?.[0];
    if (!message) return;

    const from = normalizeWaId(message.from);
    if (!from) {
      console.warn("[SamvaadikWA] Could not normalize inbound wa_id:", message.from);
      return;
    }

    const text = extractInboundText(message);

    // Unsupported message type (image, document, audio, ...) — no model call.
    if (text === null) {
      await sendAssistantWhatsAppText(
        from,
        "I can only read text messages here for now — please type your request. " +
          "For file uploads (like a contact list), use the Samvaadik dashboard.",
      );
      return;
    }

    // "LINK XXXXXX" — handled before anything else, and without a model
    // call either way, whether this number is already linked or not.
    const linkMatch = text.match(LINK_CODE_RE);
    if (linkMatch) {
      const result = await consumeLinkCode(linkMatch[1], from);
      if (result.error) {
        const reason =
          {
            NOT_FOUND: "That code doesn't match any pending link request.",
            ALREADY_USED: "That code has already been used.",
            EXPIRED: "That code has expired.",
            EMPTY_CODE: "That code looks empty.",
          }[result.error] || "That code isn't valid.";
        await sendAssistantWhatsAppText(
          from,
          `${reason} Get a new code from the Samvaadik dashboard (Integrations → WhatsApp Assistant) and try again.`,
        );
        return;
      }
      await sendAssistantWhatsAppText(
        from,
        "This number is now linked to your Samvaadik account. " +
          'You can ask me things like "create a campaign", "send a message to Rahul" ' +
          'or "send a template to 98765 43210" — I\'ll check with you before anything ' +
          "is actually sent or created.\n\nSend *reset* any time to start a fresh conversation.",
      );
      return;
    }

    // Any other message: this number must already be linked.
    const link = await getLinkByWaId(from);
    if (!link) {
      await sendAssistantWhatsAppText(
        from,
        "This WhatsApp number isn't linked to a Samvaadik account yet. " +
          "Open your Samvaadik dashboard → Integrations → WhatsApp Assistant " +
          'to get a link code, then send "LINK XXXXXX" here.',
      );
      return;
    }

    if (!text) {
      await sendAssistantWhatsAppText(from, "Could you say that again as text?");
      return;
    }

    if (RESET_RE.test(text)) {
      await clearSession(link.link_id);
      await sendAssistantWhatsAppText(
        from,
        "Started a fresh conversation. What would you like to do?",
      );
      return;
    }

    const history = await getSessionMessages(link.link_id);

    // Meta can deliver the same message more than once. Each stored user
    // message keeps its WhatsApp message id, so a repeat is ignored instead
    // of running (and possibly sending/creating) a second time.
    if (message.id && history.some((m) => m.wamid === message.id)) {
      console.log("[SamvaadikWA] Duplicate delivery ignored:", message.id);
      return;
    }

    const withUser = [
      ...history,
      { role: "user", content: text, wamid: message.id || null },
    ];
    // Saved before the (slow) model run so a duplicate arriving meanwhile is caught
    await saveSessionMessages(link.link_id, withUser);

    // Blue ticks + "typing…" while the assistant works (best effort)
    await markReadWithTyping(message.id);

    let result;
    try {
      result = await runSamvaadikAssistant({
        user_id: link.user_id,
        messages: toModelMessages(withUser),
        channel: "whatsapp",
      });
    } catch (err) {
      console.error("[SamvaadikWA] runSamvaadikAssistant error:", err);
      const friendly =
        err.code === "BAD_REQUEST"
          ? "I couldn't understand that — could you rephrase it?"
          : "Something went wrong on my end. Please try again in a moment.";
      await sendAssistantWhatsAppText(from, friendly);
      return;
    }

    const replyText = adaptReplyForWhatsApp(result.content);
    await sendAssistantWhatsAppText(from, replyText);

    // Persist the raw assistant text (markers included) — confirmation
    // detection on the next turn reads the preview titles from it.
    await saveSessionMessages(link.link_id, [
      ...withUser,
      { role: "assistant", content: result.content },
    ]);
  } catch (err) {
    // Last-resort guard — this function must never throw back into
    // whatsappController's waitUntil(), since nothing there would handle it.
    console.error("[SamvaadikWA] processAssistantInbound fatal error:", err);
  }
}
