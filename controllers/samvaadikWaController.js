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

import {
  runSamvaadikAssistant,
  createGroupFromContacts,
} from "./agentController.js";
import { parseContactsFile } from "../utils/contactFileParser.js";
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
  getPendingAction,
  setPendingAction,
  clearPendingAction,
  getMediaAttachment,
  setMediaAttachment,
  clearMediaAttachment,
  downloadAssistantMedia,
  uploadMediaForTemplateHeader,
  attachMediaToExistingTemplate,
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
      return res.json({
        success: true,
        enabled: false,
        links: [],
        assistant_number: null,
      });
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
const YES_RE =
  /^\s*(yes|yeah|yep|y|confirm|ok|okay|go ahead|create it|sure|correct|crct)\s*[.!]?\s*$/i;
const NO_RE = /^\s*(no|n|cancel|stop|never ?mind)\s*[.!]?\s*$/i;
const CANCEL_MEDIA_RE =
  /^\s*(remove|cancel|discard)\s+(the\s+)?(photo|image|video|file|media|upload|attachment)\s*[.!]?\s*$/i;

// Files a WhatsApp user might send as a group's contact list.
const CONTACT_FILE_MIME = new Set([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const CONTACT_FILE_EXT = new Set(["csv", "xlsx", "xls"]);

function isContactFileDocument(message) {
  if (message.type !== "document") return false;
  const doc = message.document || {};
  const ext = (doc.filename || "").split(".").pop()?.toLowerCase();
  return CONTACT_FILE_MIME.has(doc.mime_type) || CONTACT_FILE_EXT.has(ext);
}

// Turns "diwali_buyers_oct.xlsx" into "Diwali Buyers Oct" as a starting
// group-name suggestion — the user can just reply with a different name
// instead of "yes" to override it, no special syntax needed.
function guessGroupNameFromFilename(filename) {
  const base = String(filename || "").replace(/\.[^.]+$/, "");
  const words = base
    .replace(/[_\-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length ? words.join(" ").slice(0, 60) : "New Group";
}

// Mirrors SamvaadikAssistant.jsx's own parsing of this marker (see
// UPLOAD_MEDIA_FOR_TEMPLATE handling there) — run on the model's raw reply,
// before adaptReplyForWhatsApp strips the marker out of the display text.
const UPLOAD_MEDIA_MARKER_RE =
  /UPLOAD_MEDIA_FOR_TEMPLATE:([A-Za-z0-9-]+)\|(IMAGE|VIDEO|DOCUMENT)\|(\S*)/;

function parseUploadMediaMarker(text) {
  const m = String(text || "").match(UPLOAD_MEDIA_MARKER_RE);
  if (!m) return null;
  let name = m[3];
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep raw
  }
  return { wt_id: m[1], header_format: m[2], name };
}

const DASHBOARD_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
const withLink = (label, path) =>
  DASHBOARD_URL
    ? `${label}: ${DASHBOARD_URL}${path}`
    : `${label} in the Samvaadik dashboard.`;

// LIST_GROUPS / LIST_TEMPLATES blocks ("<url-encoded name>|..." lines) are
// rendered as a list by the web app; here they become a plain numbered list,
// in the same order, so replying with a number still picks the right item.
const LIST_BLOCK_RE = /LIST_(GROUPS|TEMPLATES)_BEGIN([\s\S]*?)LIST_\1_END/g;

function formatListBlock(_match, kind, body) {
  return body
    .split("\n")
    .map((l) => l.trim().replace(/^(?:\d+[.)]|[-*•])\s*/, ""))
    .filter(Boolean)
    .map((line, i) => {
      const parts = line.split("|").map((p) => p.trim());
      let name = parts[0];
      try {
        name = decodeURIComponent(name);
      } catch {
        // keep raw name
      }
      // groups: name|contact_count — templates: name|header_format|status
      const detail =
        kind === "GROUPS" ? parts[1] && `${parts[1]} contacts` : parts[2];
      return `${i + 1}. ${name}${detail ? ` (${detail})` : ""}`;
    })
    .join("\n");
}

// The web assistant turns these markers into buttons/cards. A WhatsApp text
// message has none, so each marker is removed and replaced with a short line
// with a dashboard link — the assistant's own explanation text is kept.
export function adaptReplyForWhatsApp(text) {
  let out = String(text || "").replace(LIST_BLOCK_RE, formatListBlock);
  const notes = [];

  const take = (re, note) => {
    if (re.test(out)) {
      out = out.replace(re, "");
      if (note && !notes.includes(note)) notes.push(note);
    }
  };

  take(/REDIRECT_TO_PRICING:\s*/g, withLink("Top up credits", "/pricing"));
  take(/REDIRECT_TO_TEMPLATES:\s*/g, withLink("Open Templates", "/templates"));
  take(
    /REDIRECT_TO_BUILDER:[a-f0-9-]+\s*/gi,
    withLink("Open Chatbot Flows", "/chatbot"),
  );
  take(/REDIRECT_TO_FLOWS:\s*/g, withLink("Open Chatbot Flows", "/chatbot"));
  take(
    /GOOGLE_NOT_CONNECTED:\s*/g,
    withLink("Connect Google", "/integrations"),
  );
  take(
    /GOOGLE_PICK_SHEET:\s*/g,
    'To choose a sheet from Google Drive, open the AI Assistant in the Samvaadik dashboard and use "Choose from Google Drive", then come back here.',
  );
  // On the web this opens an in-chat upload button; here the user just sends
  // the photo/video/document as their next WhatsApp message instead (see
  // parseUploadMediaMarker / handleMediaUpload in processAssistantInbound,
  // which read this same marker off the raw reply before it's stripped here).
  take(
    /`?UPLOAD_MEDIA_FOR_TEMPLATE:\S*`?/g,
    "Just send the photo, video or document here and I'll use it.",
  );
  // Web-only template picker — should not appear here, but never leak it
  take(/`?OPEN_TEMPLATE_PICKER:\S*`?/g, null);

  out = out
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

// ── CSV/Excel group import (WhatsApp document → group) ──────────────────────
//
// Deterministic, same spirit as LINK/RESET: the model never sees raw contact
// rows. We download the file, parse it, store the parsed contacts as this
// link's pending_action, and ask a plain yes/no/rename question. Resolved in
// handlePendingActionReply below.
async function handleCsvDocument(link, from, message) {
  const doc = message.document || {};
  if (!doc.id) {
    await sendAssistantWhatsAppText(
      from,
      "I couldn't read that file — please try sending it again.",
    );
    return;
  }
  try {
    const { buffer, mimeType } = await downloadAssistantMedia(doc.id);
    const parsed = await parseContactsFile(buffer, {
      fileName: doc.filename || "contacts.csv",
      mimeType,
      userId: link.user_id,
    });
    const groupName = guessGroupNameFromFilename(doc.filename);
    await setPendingAction(link.link_id, {
      type: "group_import",
      group_name: groupName,
      contacts: parsed.contacts,
      skipped: parsed.skipped,
    });
    const count = parsed.contacts.length;
    await sendAssistantWhatsAppText(
      from,
      `Found *${count}* contact${count === 1 ? "" : "s"} in that file` +
        (parsed.skipped
          ? ` (${parsed.skipped} row${parsed.skipped === 1 ? "" : "s"} skipped — no valid phone number)`
          : "") +
        `.\n\nCreate a group called *"${groupName}"* with ${count === 1 ? "it" : "them"}? ` +
        "Reply *yes* to confirm, send a different name to use that instead, or *cancel*.",
    );
  } catch (err) {
    console.error("[SamvaadikWA] CSV/Excel import error:", err);
    await sendAssistantWhatsAppText(
      from,
      `I couldn't use that file: ${err.message}`,
    );
  }
}

// ── Template header media (WhatsApp photo/video/document → Meta upload) ─────
//
// The upload itself always uses the CUSTOMER'S OWN connected WABA
// credentials (see uploadMediaForTemplateHeader), never the assistant
// number's — templates belong to that WABA. What happens next depends on
// whether this link is currently waiting for a reupload on a SPECIFIC
// existing template (set from the model's own UPLOAD_MEDIA_FOR_TEMPLATE
// marker — see runModelTurn) or not:
//   - waiting on a specific template: attach the fresh media_id to it
//     directly and resume the conversation with a synthetic "I've uploaded
//     new media..." turn, exactly mirroring the web dashboard's
//     handleTemplateMediaUploaded flow.
//   - not waiting on anything: offer it as the header for a NEW template,
//     same as the spec's "Photos in" pattern — store it and ask yes/no.
async function handleMediaUpload(link, from, message) {
  const mediaObj = message.image || message.video || message.document;
  if (!mediaObj?.id) {
    await sendAssistantWhatsAppText(
      from,
      "I couldn't read that file — please try sending it again.",
    );
    return;
  }

  let uploaded;
  try {
    const { buffer, mimeType } = await downloadAssistantMedia(mediaObj.id);
    uploaded = await uploadMediaForTemplateHeader(link.user_id, {
      buffer,
      mimeType,
      fileName: mediaObj.filename,
    });
  } catch (err) {
    console.error("[SamvaadikWA] Template media upload error:", err);
    const notConnected = /whatsapp account not found/i.test(err.message || "");
    await sendAssistantWhatsAppText(
      from,
      notConnected
        ? "Your Samvaadik account isn't connected to a WhatsApp Business number yet, so I can't use this as a template header. Connect one from Integrations in the dashboard first."
        : `I couldn't process that file: ${err.message}`,
    );
    return;
  }

  const pending = await getPendingAction(link.link_id);
  if (pending?.type === "awaiting_template_reupload") {
    await clearPendingAction(link.link_id);
    try {
      const tpl = await attachMediaToExistingTemplate(
        link.user_id,
        pending.wt_id,
        uploaded.media_id,
      );
      const resumeText = `I've uploaded new media for the "${tpl.name}" template (media_id: ${uploaded.media_id}). Please continue.`;
      const history = await getSessionMessages(link.link_id);
      const withUser = [...history, { role: "user", content: resumeText }];
      await saveSessionMessages(link.link_id, withUser);
      await runModelTurn(link, from, withUser);
    } catch (err) {
      console.error("[SamvaadikWA] attachMediaToExistingTemplate error:", err);
      await sendAssistantWhatsAppText(
        from,
        `The file uploaded, but I couldn't attach it to "${pending.name}": ${err.message}`,
      );
    }
    return;
  }

  // No specific template was waiting — offer it for a new one.
  await setPendingAction(link.link_id, {
    type: "confirm_new_media",
    attachment: uploaded,
  });
  await sendAssistantWhatsAppText(
    from,
    `Got it — I've uploaded that ${uploaded.header_format.toLowerCase()}. Use it as the header for a *new* template? Reply *yes* to continue, or *cancel*.`,
  );
}

// ── Resolving a pending_action with the user's next text message ────────────
// Returns true when the message was fully handled (CSV import confirmed and
// run, a rename, a cancel, or a reupload reminder) — the caller stops there.
// Returns false to let the normal model turn run instead (used for the
// "confirm_new_media" yes-path, so the user's "yes" still becomes part of
// the conversation now that media_attachment is set).
async function handlePendingActionReply(link, from, text) {
  const pending = await getPendingAction(link.link_id);
  if (!pending) return false;

  if (pending.type === "group_import") {
    if (NO_RE.test(text)) {
      await clearPendingAction(link.link_id);
      await sendAssistantWhatsAppText(
        from,
        "No problem — group creation cancelled.",
      );
      return true;
    }
    if (YES_RE.test(text)) {
      await clearPendingAction(link.link_id);
      try {
        const result = await createGroupFromContacts({
          user_id: link.user_id,
          group_name: pending.group_name,
          contacts: pending.contacts,
        });
        await sendAssistantWhatsAppText(from, result.message);
        // Record it in history (no model call) so later turns ("send a
        // campaign to that group") have the context without re-asking.
        const history = await getSessionMessages(link.link_id);
        await saveSessionMessages(link.link_id, [
          ...history,
          {
            role: "user",
            content: `(Sent a contact file) Create group "${pending.group_name}" from the uploaded contacts.`,
          },
          { role: "assistant", content: result.message },
        ]);
      } catch (err) {
        console.error("[SamvaadikWA] createGroupFromContacts error:", err);
        await sendAssistantWhatsAppText(
          from,
          `Couldn't create the group: ${err.message}`,
        );
      }
      return true;
    }
    // Anything else is treated as a replacement group name.
    const newName = text.trim().slice(0, 60);
    if (!newName) return true;
    await setPendingAction(link.link_id, { ...pending, group_name: newName });
    const count = pending.contacts.length;
    await sendAssistantWhatsAppText(
      from,
      `Got it — create a group called *"${newName}"* with those ${count} contact${count === 1 ? "" : "s"}? Reply *yes* to confirm, or *cancel*.`,
    );
    return true;
  }

  if (pending.type === "awaiting_template_reupload") {
    if (NO_RE.test(text) || /cancel/i.test(text)) {
      await clearPendingAction(link.link_id);
      await sendAssistantWhatsAppText(
        from,
        `Okay, cancelled — the "${pending.name}" template still needs new media whenever you're ready.`,
      );
      return true;
    }
    await sendAssistantWhatsAppText(
      from,
      `Please send the photo, video or document to use as the new header for "${pending.name}" — or reply *cancel*.`,
    );
    return true;
  }

  if (pending.type === "confirm_new_media") {
    if (NO_RE.test(text)) {
      await clearPendingAction(link.link_id);
      await sendAssistantWhatsAppText(
        from,
        "No problem — discarded that upload.",
      );
      return true;
    }
    if (YES_RE.test(text)) {
      await clearPendingAction(link.link_id);
      await setMediaAttachment(link.link_id, pending.attachment);
      return false; // let the model turn run, media_attachment is now active
    }
    await sendAssistantWhatsAppText(
      from,
      "Should I use that file as a header for a new template? Reply *yes* or *cancel*.",
    );
    return true;
  }

  return false;
}

// ── One turn of the actual model loop, shared by the normal inbound path
// and the "media just finished uploading" resume path above ─────────────────
async function runModelTurn(link, from, withUser) {
  let mediaAttachment;
  try {
    mediaAttachment = await getMediaAttachment(link.link_id);
  } catch (err) {
    console.error("[SamvaadikWA] getMediaAttachment error:", err);
  }

  let result;
  try {
    result = await runSamvaadikAssistant({
      user_id: link.user_id,
      messages: toModelMessages(withUser),
      media_attachment: mediaAttachment || undefined,
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

  // The model asked for fresh/missing media on a SPECIFIC existing template
  // (channel-agnostic instruction — see SAMVAADIK_SYSTEM_PROMPT). On WhatsApp
  // the next photo/video/document IS the answer (see handleMediaUpload),
  // so remember which template it's for.
  const uploadTarget = parseUploadMediaMarker(result.content);
  if (uploadTarget) {
    await setPendingAction(link.link_id, {
      type: "awaiting_template_reupload",
      wt_id: uploadTarget.wt_id,
      header_format: uploadTarget.header_format,
      name: uploadTarget.name,
    });
  }

  const replyText = adaptReplyForWhatsApp(result.content);
  await sendAssistantWhatsAppText(from, replyText);

  // Persist the raw assistant text (markers included) — confirmation
  // detection on the next turn reads the preview titles from it.
  await saveSessionMessages(link.link_id, [
    ...withUser,
    { role: "assistant", content: result.content },
  ]);
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
      console.warn(
        "[SamvaadikWA] Could not normalize inbound wa_id:",
        message.from,
      );
      return;
    }

    // Documents (CSV/Excel contact lists, or anything offered as a template
    // header) and images/videos (template headers) are handled directly here
    // — downloaded, parsed/uploaded, and confirmed over plain text — rather
    // than being rejected the way audio/stickers/location still are below.
    if (["document", "image", "video"].includes(message.type)) {
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
      if (isContactFileDocument(message)) {
        await handleCsvDocument(link, from, message);
      } else {
        await handleMediaUpload(link, from, message);
      }
      return;
    }

    const text = extractInboundText(message);

    // Unsupported message type (audio, sticker, location, contacts, ...) —
    // no model call.
    if (text === null) {
      await sendAssistantWhatsAppText(
        from,
        "I can read text messages, photos/videos/documents (for template headers) " +
          "and CSV/Excel files (for contact groups) here — please send one of those.",
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
      await sendAssistantWhatsAppText(
        from,
        "Could you say that again as text?",
      );
      return;
    }

    if (RESET_RE.test(text)) {
      await clearSession(link.link_id);
      await clearPendingAction(link.link_id);
      await clearMediaAttachment(link.link_id);
      await sendAssistantWhatsAppText(
        from,
        "Started a fresh conversation. What would you like to do?",
      );
      return;
    }

    // Deterministic confirm/cancel/rename handling for a CSV group import or
    // a pending template-media upload — resolved here, outside the model
    // loop, same as LINK/RESET above. Returns true when it fully answered
    // this message (nothing left for the model to do this turn).
    if (await handlePendingActionReply(link, from, text)) return;

    if (CANCEL_MEDIA_RE.test(text)) {
      const attachment = await getMediaAttachment(link.link_id);
      if (attachment) {
        await clearMediaAttachment(link.link_id);
        await sendAssistantWhatsAppText(from, "Removed that upload.");
        return;
      }
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

    await runModelTurn(link, from, withUser);
  } catch (err) {
    // Last-resort guard — this function must never throw back into
    // whatsappController's waitUntil(), since nothing there would handle it.
    console.error("[SamvaadikWA] processAssistantInbound fatal error:", err);
  }
}
