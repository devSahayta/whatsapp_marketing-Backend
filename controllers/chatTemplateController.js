// controllers/chatTemplateController.js
// Send ONE approved WhatsApp template to ONE chat from the chat dashboard.
// Templates are allowed outside the 24-hour customer-service window, so this
// is how an admin (re)starts a conversation.
//
// Payload building mirrors the scheduler (Samvaadik-campaign-scheduler/
// scheduledMessageJob.js) so normal, media-header and carousel templates are
// sent the same way they are from campaigns and scheduled messages.

import axios from "axios";
import { supabase } from "../config/supabase.js";
import { getWhatsappAccount } from "../services/waAccountService.js";
import { normalizePhone } from "../services/chatMessagingService.js";

const GRAPH_BASE = "https://graph.facebook.com/v21.0";
const MEDIA_HEADER_FORMATS = ["IMAGE", "VIDEO", "DOCUMENT"];

/* ─── small helpers ─────────────────────────────────────────────────────── */

const parseJson = (raw, fallback) => {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const findComp = (components, type) =>
  (components || []).find((c) => (c.type || "").toUpperCase() === type);

const isBlank = (v) => v === undefined || v === null || String(v).trim() === "";

/**
 * Unique placeholder keys in order of first appearance: "{{1}} {{2}}" -> ["1","2"],
 * "{{name}}" -> ["name"]. Numeric keys are sorted so positional params line up.
 */
const getPlaceholderKeys = (text) => {
  const keys = [];
  for (const m of String(text || "").matchAll(/\{\{\s*([\w]+)\s*\}\}/g)) {
    if (!keys.includes(m[1])) keys.push(m[1]);
  }
  const allNumeric = keys.every((k) => /^\d+$/.test(k));
  return allNumeric ? keys.sort((a, b) => Number(a) - Number(b)) : keys;
};

/** Build Meta text parameters for positional ({{1}}) or named ({{name}}) placeholders. */
const buildTextParams = (keys, values) =>
  keys.map((key) => {
    const param = { type: "text", text: String(values[key]) };
    if (!/^\d+$/.test(key)) param.parameter_name = key;
    return param;
  });

const fillPlaceholders = (text, values) =>
  String(text || "").replace(/\{\{\s*([\w]+)\s*\}\}/g, (match, key) =>
    isBlank(values?.[key]) ? match : String(values[key]),
  );

const isDynamicUrlButton = (btn) =>
  (btn?.type || "").toUpperCase() === "URL" &&
  typeof btn.url === "string" &&
  /\{\{\s*\w+\s*\}\}/.test(btn.url);

class SendValidationError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

/* ─── payload builders ──────────────────────────────────────────────────── */

function buildRegularComponents(template, components, input) {
  const out = [];
  const display = { mediaPath: null, headerText: null };

  // Header
  const header = findComp(components, "HEADER");
  const headerFormat = (header?.format || "").toUpperCase();

  if (MEDIA_HEADER_FORMATS.includes(headerFormat)) {
    const mediaId = template.media_id;
    if (!mediaId) {
      throw new SendValidationError(
        `This template needs a ${headerFormat.toLowerCase()} header, but no media is uploaded. Upload it from the Templates page and try again.`,
        "MEDIA_REQUIRED",
      );
    }
    const type = headerFormat.toLowerCase();
    const media = { id: mediaId };
    if (type === "document" && template.header_filename) {
      media.filename = template.header_filename;
    }
    out.push({ type: "header", parameters: [{ type, [type]: media }] });
    display.mediaPath = mediaId;
  } else if (headerFormat === "TEXT" && header?.text) {
    const keys = getPlaceholderKeys(header.text);
    if (keys.length > 0) {
      const value = input.header_variable;
      if (isBlank(value)) {
        throw new SendValidationError(
          "This template's header has a variable. Please fill it in.",
          "MISSING_HEADER_VARIABLE",
        );
      }
      const values = { [keys[0]]: value };
      out.push({ type: "header", parameters: buildTextParams(keys, values) });
      display.headerText = fillPlaceholders(header.text, values);
    } else {
      display.headerText = header.text;
    }
  }

  // Body
  out.push(...buildBodyComponents(components, input));

  // Dynamic URL buttons ({{1}} suffix). Static URL / quick reply / phone need nothing.
  const buttons = findComp(components, "BUTTONS")?.buttons || [];
  buttons.forEach((btn, index) => {
    if (!isDynamicUrlButton(btn)) return;
    const entry = (input.button_variables || []).find(
      (v) => Number(v.button_index) === index && v.card_index === undefined,
    );
    if (isBlank(entry?.value)) {
      throw new SendValidationError(
        `Button "${btn.text}" has a dynamic link. Please fill in its value.`,
        "MISSING_BUTTON_VARIABLE",
      );
    }
    out.push({
      type: "button",
      sub_type: "url",
      index: String(index),
      parameters: [{ type: "text", text: String(entry.value) }],
    });
  });

  return { components: out, display };
}

function buildBodyComponents(components, input) {
  const body = findComp(components, "BODY");
  const keys = getPlaceholderKeys(body?.text);
  if (keys.length === 0) return [];

  const values = input.body_variables || {};
  const missing = keys.filter((k) => isBlank(values[k]));
  if (missing.length > 0) {
    throw new SendValidationError(
      `Please fill in all template variables. Missing: ${missing.map((k) => `{{${k}}}`).join(", ")}`,
      "MISSING_TEMPLATE_VARIABLES",
      { missing },
    );
  }
  return [{ type: "body", parameters: buildTextParams(keys, values) }];
}

function buildCarouselComponents(template, components, input) {
  const carouselDef = findComp(components, "CAROUSEL");
  if (!Array.isArray(carouselDef?.cards) || carouselDef.cards.length === 0) {
    throw new SendValidationError(
      "Carousel template is missing its cards.",
      "INVALID_CAROUSEL",
    );
  }

  const carouselMedia = parseJson(template.carousel_media, []) || [];
  const templateButtonVars = parseJson(template.button_variables, []) || [];
  const preview = parseJson(template.preview, null);
  const previewCards = findComp(preview?.components, "CAROUSEL")?.cards || [];

  const cardsPayload = [];
  const displayCards = [];

  carouselDef.cards.forEach((card, cardIndex) => {
    const header = findComp(card.components, "HEADER");
    const cardBody = findComp(card.components, "BODY");
    const cardButtons = findComp(card.components, "BUTTONS")?.buttons || [];
    const format = (header?.format || "IMAGE").toUpperCase();
    const type = format.toLowerCase();

    const mediaEntry = carouselMedia.find(
      (m) => Number(m.card_index) === cardIndex,
    );
    if (!mediaEntry?.media_id) {
      throw new SendValidationError(
        `Carousel card ${cardIndex + 1} has no media. Re-upload it from the Templates page and try again.`,
        "CAROUSEL_MEDIA_REQUIRED",
        { card_index: cardIndex },
      );
    }

    const cardComponents = [
      {
        type: "header",
        parameters: [{ type, [type]: { id: mediaEntry.media_id } }],
      },
    ];

    // Card body variables are fixed at template creation — reuse the approved example.
    const cardBodyKeys = getPlaceholderKeys(cardBody?.text);
    if (cardBodyKeys.length > 0) {
      const examples = cardBody?.example?.body_text?.[0] || [];
      const values = Object.fromEntries(
        cardBodyKeys.map((k, i) => [k, examples[i] ?? ""]),
      );
      cardComponents.push({
        type: "body",
        parameters: buildTextParams(cardBodyKeys, values),
      });
    }

    cardButtons.forEach((btn, buttonIndex) => {
      if (!isDynamicUrlButton(btn)) return;
      const perSend = (input.button_variables || []).find(
        (v) =>
          Number(v.card_index) === cardIndex &&
          Number(v.button_index) === buttonIndex,
      );
      const templateDefault = templateButtonVars.find(
        (v) => Number(v.card_index) === cardIndex,
      );
      const value = !isBlank(perSend?.value)
        ? perSend.value
        : (templateDefault?.example ?? btn.example?.[0]);

      if (isBlank(value)) {
        throw new SendValidationError(
          `Card ${cardIndex + 1} button "${btn.text}" has a dynamic link. Please fill in its value.`,
          "MISSING_BUTTON_VARIABLE",
        );
      }
      cardComponents.push({
        type: "button",
        sub_type: "url",
        index: buttonIndex,
        parameters: [{ type: "text", text: String(value) }],
      });
    });

    cardsPayload.push({ card_index: cardIndex, components: cardComponents });

    // Same shape the chat dashboard (ChatWindow.jsx) and chatbot engine use.
    const previewImageUrl = findComp(
      previewCards[cardIndex]?.components,
      "HEADER",
    )?.example?.header_handle?.[0];
    displayCards.push({
      card_index: cardIndex,
      media_id: mediaEntry.media_id,
      header_format: format,
      preview_image_url: previewImageUrl || null,
      body_text: cardBody?.text || null,
      buttons: cardButtons.map((b) => ({
        text: b.text,
        type: b.type,
        url: b.url,
      })),
    });
  });

  return {
    components: [
      ...buildBodyComponents(components, input),
      { type: "carousel", cards: cardsPayload },
    ],
    displayCards,
  };
}

/**
 * What a sender must supply for this template — the text-only counterpart of
 * the template picker form (used by the AI assistant on WhatsApp, which has
 * no form). Mirrors the builders above so the two can't disagree.
 */
export function describeTemplateRequirements(template) {
  const components = parseJson(template.components, []) || [];
  const isCarousel =
    !!template.is_carousel || !!findComp(components, "CAROUSEL");
  const body = findComp(components, "BODY");
  const bodyKeys = getPlaceholderKeys(body?.text);
  const bodyExamples = body?.example?.body_text?.[0] || [];
  const namedExamples = Object.fromEntries(
    (body?.example?.body_text_named_params || []).map((p) => [
      p.param_name,
      p.example,
    ]),
  );

  const req = {
    wt_id: template.wt_id,
    name: template.name,
    status: template.status,
    is_carousel: isCarousel,
    body_text: body?.text || "",
    body_variables: bodyKeys.map((key, i) => ({
      key,
      example: namedExamples[key] ?? bodyExamples[i] ?? null,
    })),
    header_variable_needed: false,
    header_text: null,
    media_needed: null,
    media_ready: true,
    button_variables: [],
  };

  if (isCarousel) {
    const carouselMedia = parseJson(template.carousel_media, []) || [];
    const cards = findComp(components, "CAROUSEL")?.cards || [];
    req.card_count = cards.length;
    const missingCards = cards
      .map((_, i) => i)
      .filter(
        (i) =>
          !carouselMedia.find((m) => Number(m.card_index) === i)?.media_id,
      );
    req.media_needed = "CAROUSEL_CARDS";
    req.media_ready = missingCards.length === 0;
    if (missingCards.length) {
      req.cards_missing_media = missingCards.map((i) => i + 1);
    }
    // Card URL buttons fall back to the template's saved example, so they
    // are optional per send; list them so a value can be overridden.
    cards.forEach((card, cardIndex) => {
      (findComp(card.components, "BUTTONS")?.buttons || []).forEach(
        (btn, buttonIndex) => {
          if (isDynamicUrlButton(btn)) {
            req.button_variables.push({
              card_index: cardIndex,
              button_index: buttonIndex,
              button_text: btn.text,
              url: btn.url,
              optional: true,
            });
          }
        },
      );
    });
    return req;
  }

  const header = findComp(components, "HEADER");
  const headerFormat = (header?.format || "").toUpperCase();
  if (MEDIA_HEADER_FORMATS.includes(headerFormat)) {
    req.media_needed = headerFormat;
    req.media_ready = !!template.media_id;
  } else if (headerFormat === "TEXT" && header?.text) {
    req.header_text = header.text;
    req.header_variable_needed = getPlaceholderKeys(header.text).length > 0;
  }
  (findComp(components, "BUTTONS")?.buttons || []).forEach((btn, index) => {
    if (isDynamicUrlButton(btn)) {
      req.button_variables.push({
        button_index: index,
        button_text: btn.text,
        url: btn.url,
        optional: false,
      });
    }
  });
  return req;
}

// Result shape for sendTemplateToContact: HTTP-style status + JSON body, so
// both the Express route and the AI assistant tool can use it.
const reply = (status, data) => ({ status, data });

/* ─── Send one template to one contact (shared core) ────────────────────── */
// Used by POST /admin/chat/send-template and by the AI assistant's
// send_template_message tool (WhatsApp channel). user_id must already be
// authenticated by the caller.
/*
  Body:
  {
    "chat_id": "uuid",
    "wt_id": "uuid",                               // whatsapp_templates primary key
    "body_variables": { "1": "Rahul", "2": "#123" }, // keyed by placeholder
    "header_variable": "Diwali Sale",              // only if TEXT header has {{1}}
    "button_variables": [                          // only for dynamic URL buttons
      { "button_index": 0, "value": "ORD-1" },             // regular template
      { "card_index": 0, "button_index": 0, "value": "p1" } // carousel card
    ]
  }
*/
export async function sendTemplateToContact(user_id, body = {}) {
  const { chat_id: chatIdInput, wt_id, phone_number, person_name } = body;

  if ((!chatIdInput && !phone_number) || !wt_id) {
    return reply(400, { error: "chat_id (or phone_number) and wt_id are required" });
  }

  try {
    // 1. Resolve the chat. It must belong to the logged-in user.
    //    With phone_number (used by the AI assistant for new contacts), an
    //    existing chat is reused; otherwise one is created after Meta accepts.
    let chat;
    if (chatIdInput) {
      const { data, error: chatErr } = await supabase
        .from("chats")
        .select("chat_id, phone_number, user_id")
        .eq("chat_id", chatIdInput)
        .maybeSingle();
      if (chatErr) throw chatErr;
      if (!data || data.user_id !== user_id) {
        return reply(404, { error: "Chat not found" });
      }
      chat = data;
    } else {
      const phone = normalizePhone(phone_number);
      if (!phone) {
        return reply(400, {
          error: "Invalid phone number. Include the country code, e.g. +91 98765 43210.",
          code: "INVALID_PHONE",
        });
      }
      const { data, error: chatErr } = await supabase
        .from("chats")
        .select("chat_id, phone_number, user_id")
        .eq("user_id", user_id)
        .eq("phone_number", phone)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (chatErr) throw chatErr;
      chat = data || { chat_id: null, phone_number: phone, user_id };
    }

    // 2. WhatsApp account
    const account = await getWhatsappAccount(user_id);
    if (!account?.phone_number_id || !account?.system_user_access_token) {
      return reply(400, { error: "WhatsApp account is not connected" });
    }

    // 3. Template must belong to this account and be approved
    const { data: template, error: tplErr } = await supabase
      .from("whatsapp_templates")
      .select("*")
      .eq("wt_id", wt_id)
      .eq("account_id", account.wa_id)
      .maybeSingle();

    if (tplErr) throw tplErr;
    if (!template) {
      return reply(404, { error: "Template not found" });
    }
    if ((template.status || "").toUpperCase() !== "APPROVED") {
      return reply(400, {
        error: `Only approved templates can be sent (this one is ${template.status}).`,
        code: "TEMPLATE_NOT_APPROVED",
      });
    }

    // 4. Build payload
    const components = parseJson(template.components, []) || [];
    const isCarousel =
      !!template.is_carousel || !!findComp(components, "CAROUSEL");
    const input = {
      body_variables: body.body_variables || {},
      header_variable: body.header_variable,
      button_variables: Array.isArray(body.button_variables)
        ? body.button_variables
        : [],
    };

    let built;
    try {
      built = isCarousel
        ? buildCarouselComponents(template, components, input)
        : buildRegularComponents(template, components, input);
    } catch (err) {
      if (err instanceof SendValidationError) {
        return reply(400, { error: err.message, code: err.code, ...err.extra });
      }
      throw err;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: chat.phone_number,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language || "en_US" },
        ...(built.components.length > 0 && { components: built.components }),
      },
    };

    // 5. Send to Meta
    let graphRes;
    try {
      graphRes = await axios.post(
        `${GRAPH_BASE}/${account.phone_number_id}/messages`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${account.system_user_access_token}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        },
      );
    } catch (err) {
      const metaErr = err.response?.data?.error;
      console.error("sendChatTemplate Meta error:", metaErr || err.message);
      return reply(502, {
        error:
          metaErr?.error_data?.details ||
          metaErr?.message ||
          "WhatsApp rejected the template message",
        code: metaErr?.code ? String(metaErr.code) : "META_SEND_FAILED",
      });
    }

    const wa_message_id = graphRes.data?.messages?.[0]?.id || null;
    const now = new Date().toISOString();

    // 6. Log in whatsapp_messages (status webhooks update this row → chat ticks)
    const { data: wmRecord, error: wmErr } = await supabase
      .from("whatsapp_messages")
      .insert({
        account_id: account.wa_id,
        to_number: chat.phone_number,
        template_name: template.name,
        message_body: payload,
        wa_message_id,
        status: "sent",
        sent_at: now,
      })
      .select("wm_id")
      .single();
    if (wmErr) console.error("sendChatTemplate wm insert error:", wmErr);

    // 7. Save to the chat so it shows in the dashboard
    const bodyText = fillPlaceholders(
      findComp(components, "BODY")?.text || `Template: ${template.name}`,
      input.body_variables,
    );

    // New contact: create the chat now that Meta accepted the message
    if (!chat.chat_id) {
      const { data: newChat, error: newChatErr } = await supabase
        .from("chats")
        .upsert(
          {
            user_id,
            phone_number: chat.phone_number,
            person_name: (person_name || "").trim() || chat.phone_number,
            last_message: bodyText,
            last_message_at: now,
            last_sender_type: "admin",
            last_admin_message_at: now,
            mode: "AUTO",
            status: "active",
            updated_at: now,
          },
          { onConflict: "user_id,phone_number" },
        )
        .select("chat_id")
        .single();
      if (newChatErr) {
        console.error("sendChatTemplate chat create error:", newChatErr);
        // The message was delivered to Meta; report success without a chat row
        return reply(200, {
          success: true,
          wa_message_id,
          wm_id: wmRecord?.wm_id || null,
          chat_id: null,
          message: null,
        });
      }
      chat.chat_id = newChat.chat_id;
    }
    const chat_id = chat.chat_id;

    let messageRow;
    if (isCarousel) {
      messageRow = {
        message: bodyText,
        message_type: "template_carousel",
        media_path: null,
        buttons: null,
        carousel_cards: built.displayCards,
      };
    } else {
      const footer = findComp(components, "FOOTER")?.text;
      const headerFormat = (
        findComp(components, "HEADER")?.format || ""
      ).toUpperCase();
      let text = bodyText;
      if (built.display.headerText) text = `**${built.display.headerText}**\n\n${text}`;
      if (footer) text = `${text}\n\n**${footer}**`;

      const buttons = (findComp(components, "BUTTONS")?.buttons || []).map(
        (b) => ({ type: b.type, text: b.text, url: b.url }),
      );

      messageRow = {
        message: text,
        message_type:
          headerFormat === "VIDEO"
            ? "template_video"
            : headerFormat === "DOCUMENT"
              ? "template_document"
              : "template",
        media_path: built.display.mediaPath,
        buttons: buttons.length ? buttons : null,
        carousel_cards: null,
      };
    }

    const { data: savedMessage, error: msgErr } = await supabase
      .from("messages")
      .insert({
        chat_id,
        sender_type: "admin",
        ...messageRow,
        wm_id: wmRecord?.wm_id || null,
        created_at: now,
      })
      .select()
      .single();
    if (msgErr) console.error("sendChatTemplate message insert error:", msgErr);

    await supabase
      .from("chats")
      .update({
        last_message: bodyText,
        last_message_at: now,
        last_admin_message_at: now,
        last_sender_type: "admin",
        updated_at: now,
      })
      .eq("chat_id", chat_id);

    return reply(200, {
      success: true,
      wa_message_id,
      wm_id: wmRecord?.wm_id || null,
      chat_id,
      message: savedMessage || null,
    });
  } catch (err) {
    console.error("sendChatTemplate error:", err);
    return reply(500, { error: "Failed to send template" });
  }
}

/** Express handler: POST /admin/chat/send-template (chat dashboard + web assistant). */
export const sendChatTemplate = async (req, res) => {
  const { status, data } = await sendTemplateToContact(
    req.user?.user_id,
    req.body || {},
  );
  return res.status(status).json(data);
};
