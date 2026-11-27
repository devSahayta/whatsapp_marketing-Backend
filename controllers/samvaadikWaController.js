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
import { parseContactsFile } from "../utils/contactFileParser.js";
import { formatDashboardLinks } from "../utils/dashboardLinks.js";
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
// Used ONLY to drop a waiting upload when the user clearly backs out. Agreement
// and renaming are understood by the assistant itself — never by regex.
// Deliberately excludes a bare "no": that is usually an answer to a question
// the assistant just asked ("want me to name it X?"), not a cancellation.
const NEVERMIND_RE =
  /^\s*(cancel|stop|never ?mind|forget it|leave it|drop it|cancel (it|that|the upload))\s*[.!]?\s*$/i;
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

// ── Inbound files (CSV/Excel contact lists, template header media) ─────────
//
// A file never goes to the model itself. We download and process it here,
// then hand the assistant a short plain-language note ("I sent a contact file
// with 214 contacts") and let it answer like a person would — it already
// knows what the user said earlier, e.g. the group name. Only the safe,
// effectful step stays in code: the group is created by the
// create_group_from_upload tool from the contacts staged below.

// "diwali list (final).xlsx" -> safe short label for the note to the assistant
const cleanFileName = (name) =>
  String(name || "")
    .replace(/[\u0000-\u001f"]/g, "")
    .trim()
    .slice(0, 80);

// Meta only accepts these as template headers.
const HEADER_MIME_OK = new Set([
  "image/jpeg",
  "image/png",
  "video/mp4",
  "application/pdf",
]);

// Adds `note` to history as if the user had typed it, then runs a normal
// assistant turn. wamid is stored so a Meta redelivery of the same file
// message is recognised and ignored.
async function continueWithNote(link, from, note, wamid) {
  const history = await getSessionMessages(link.link_id);
  const withUser = [
    ...history,
    { role: "user", content: note, wamid: wamid || null },
  ];
  await saveSessionMessages(link.link_id, withUser);
  await runModelTurn(link, from, withUser);
}

async function isDuplicateDelivery(link, wamid) {
  if (!wamid) return false;
  const history = await getSessionMessages(link.link_id);
  return history.some((m) => m.wamid === wamid);
}

async function handleCsvDocument(link, from, message) {
  const doc = message.document || {};
  if (await isDuplicateDelivery(link, message.id)) return;
  await markReadWithTyping(message.id);

  const fileLabel = cleanFileName(doc.filename) || "contacts file";
  let note;
  try {
    if (!doc.id) throw new Error("the file didn't come through");
    const { buffer, mimeType } = await downloadAssistantMedia(doc.id);
    const parsed = await parseContactsFile(buffer, {
      fileName: doc.filename || "contacts.csv",
      mimeType,
      userId: link.user_id,
    });
    await setPendingAction(link.link_id, {
      type: "staged_contacts",
      file_name: fileLabel,
      contacts: parsed.contacts,
      skipped: parsed.skipped,
    });
    const count = parsed.contacts.length;
    note =
      `(I just sent a contact file "${fileLabel}". It has ${count} valid contact${count === 1 ? "" : "s"}` +
      (parsed.skipped
        ? ` and ${parsed.skipped} row${parsed.skipped === 1 ? "" : "s"} without a phone number were skipped`
        : "") +
      `.)`;
  } catch (err) {
    console.error("[SamvaadikWA] CSV/Excel import error:", err);
    note = `(I just sent a file "${fileLabel}" but it couldn't be read: ${err.message} Please tell me what to fix and ask me to send it again.)`;
  }
  await continueWithNote(link, from, note, message.id);
}

// The upload always uses the CUSTOMER'S OWN connected WABA credentials (see
// uploadMediaForTemplateHeader) — templates belong to that WABA, not to the
// assistant's number. What happens next depends on whether the assistant just
// asked for fresh media on a SPECIFIC existing template (pending_action set
// from its UPLOAD_MEDIA_FOR_TEMPLATE marker, see runModelTurn):
//   - yes: attach the new media_id to that template, same as the web
//     dashboard's handleTemplateMediaUploaded flow.
//   - no:  hold it as the media_attachment for a NEW template header.
async function handleMediaUpload(link, from, message) {
  const mediaObj = message.image || message.video || message.document || {};
  if (await isDuplicateDelivery(link, message.id)) return;
  await markReadWithTyping(message.id);

  const fileLabel = cleanFileName(mediaObj.filename) || message.type;
  let note;
  try {
    if (!mediaObj.id) throw new Error("the file didn't come through");
    const { buffer, mimeType } = await downloadAssistantMedia(mediaObj.id);
    if (!HEADER_MIME_OK.has(mimeType)) {
      throw new Error(
        `a ${mimeType || "file of that type"} can't be used as a template header. WhatsApp templates accept JPG/PNG images, MP4 videos and PDFs`,
      );
    }
    const uploaded = await uploadMediaForTemplateHeader(link.user_id, {
      buffer,
      mimeType,
      fileName: mediaObj.filename,
    });

    const pending = await getPendingAction(link.link_id);
    if (pending?.type === "awaiting_template_reupload") {
      const tpl = await attachMediaToExistingTemplate(
        link.user_id,
        pending.wt_id,
        uploaded.media_id,
      );
      await clearPendingAction(link.link_id);
      note = `I've uploaded new media for the "${tpl.name}" template (media_id: ${uploaded.media_id}). Please continue.`;
    } else {
      await setMediaAttachment(link.link_id, uploaded);
      note = `(I just sent a ${uploaded.header_format.toLowerCase()} "${fileLabel}" to use as a template header. It's already uploaded and attached.)`;
    }
  } catch (err) {
    console.error("[SamvaadikWA] Template media upload error:", err);
    const notConnected = /whatsapp account not found/i.test(err.message || "");
    note = notConnected
      ? `(I just sent a ${message.type} "${fileLabel}" for a template header, but my account has no WhatsApp Business number connected yet, so it couldn't be used. Tell me to connect one from Integrations in the dashboard.)`
      : `(I just sent a ${message.type} "${fileLabel}" for a template header but it failed: ${err.message}.)`;
  }
  await continueWithNote(link, from, note, message.id);
}

// ── One turn of the actual model loop ───────────────────────────────────────
async function runModelTurn(link, from, withUser) {
  let mediaAttachment;
  let pending;
  try {
    mediaAttachment = await getMediaAttachment(link.link_id);
    pending = await getPendingAction(link.link_id);
  } catch (err) {
    console.error("[SamvaadikWA] session state read error:", err);
  }

  const stagedUpload =
    pending?.type === "staged_contacts"
      ? {
          file_name: pending.file_name,
          count: pending.contacts?.length || 0,
          skipped: pending.skipped || 0,
        }
      : null;

  let result;
  try {
    result = await runSamvaadikAssistant({
      user_id: link.user_id,
      messages: toModelMessages(withUser),
      media_attachment: mediaAttachment || undefined,
      channel: "whatsapp",
      channelContext: { link_id: link.link_id, staged_upload: stagedUpload },
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

  // The assistant asked for fresh/missing media on a SPECIFIC existing
  // template (channel-agnostic instruction in the main prompt). Remember which
  // one, so the next photo/video/PDF is attached to it (handleMediaUpload).
  const uploadTarget = parseUploadMediaMarker(result.content);
  if (uploadTarget) {
    await setPendingAction(link.link_id, {
      type: "awaiting_template_reupload",
      wt_id: uploadTarget.wt_id,
      header_format: uploadTarget.header_format,
      name: uploadTarget.name,
    });
  }

  let replyText = adaptReplyForWhatsApp(result.content);
  // Link to whatever was just created (group / template / campaign / flow / agent)
  const linkLines = formatDashboardLinks(result.dashboard_links, DASHBOARD_URL);
  if (linkLines) replyText = `${replyText}\n\n${linkLines}`;
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

    // The user clearly backing out of an upload that is waiting: drop it.
    // (Agreeing, renaming, etc. is understood by the assistant — no regex.)
    if (NEVERMIND_RE.test(text)) {
      const waiting = await getPendingAction(link.link_id);
      if (
        waiting?.type === "staged_contacts" ||
        waiting?.type === "awaiting_template_reupload"
      ) {
        await clearPendingAction(link.link_id);
        await sendAssistantWhatsAppText(from, "No problem, I've dropped that.");
        return;
      }
    }

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
