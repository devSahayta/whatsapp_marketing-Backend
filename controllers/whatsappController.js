// controllers/whatsappController.js - CLEANED & UPDATED

import dotenv from "dotenv";
dotenv.config();
import axios from "axios";
import {
  sendWhatsAppTextMessage,
  fetchMediaUrl,
} from "../utils/whatsappClient.js";
import { supabase } from "../config/supabase.js";
import * as chatCtrl from "./chatController.js";
import { downloadWhatsAppMedia } from "../utils/whatsappMedia.js";
import {
  handleBotMessage,
  startBotSession,
  matchKeywordTrigger,
} from "../services/chatbotEngine.js";
import { createNotification } from "../controllers/notificationController.js";

/* ─── Webhook Forwarding ────────────────────────────────────────────────────
   Forward incoming messages to any external app that has registered a
   webhook_url on their API key for this WhatsApp account.
   Runs fire-and-forget — never blocks the main webhook response.
   ─────────────────────────────────────────────────────────────────────────── */
async function forwardToApiWebhooks(account_id, payload) {
  try {
    const { data: apiKeys } = await supabase
      .from("api_keys")
      .select("webhook_url, key_name")
      .eq("account_id", account_id)
      .eq("is_active", true)
      .not("webhook_url", "is", null);

    if (!apiKeys?.length) return;

    for (const key of apiKeys) {
      axios
        .post(key.webhook_url, payload, {
          headers: { "Content-Type": "application/json" },
          timeout: 10000,
        })
        .then(() => {
          console.log(
            `✅ Webhook forwarded to [${key.key_name}]: ${key.webhook_url}`,
          );
        })
        .catch((err) => {
          console.error(
            `❌ Webhook forward failed for [${key.key_name}]:`,
            err.message,
          );
        });
    }
  } catch (err) {
    console.error("forwardToApiWebhooks error:", err.message);
  }
}

const BUCKET_NAME = process.env.SUPABASE_BUCKET || "message_media";
const TEMPLATE_URL = process.env.TEMPLATE_BASE_URL;

async function handleTemplateStatusUpdate(wabaId, value) {
  const templateId = value?.message_template_id?.toString();
  const templateName = value?.message_template_name;
  const language = value?.message_template_language;
  const status = value?.event;
  const category = value?.message_template_category;
  const reason = value?.reason;

  if (!wabaId || !templateId || !templateName || !status) {
    console.warn("Template status webhook missing required fields", {
      wabaId,
      templateId,
      templateName,
      status,
    });
    return;
  }

  const { data: account, error: accountError } = await supabase
    .from("whatsapp_accounts")
    .select("wa_id")
    .eq("waba_id", wabaId)
    .limit(1)
    .maybeSingle();

  if (accountError || !account?.wa_id) {
    console.error("No WhatsApp account mapped for template status update", {
      wabaId,
      error: accountError,
    });
    return;
  }

  let templateQuery = supabase
    .from("whatsapp_templates")
    .select("wt_id, preview")
    .eq("template_id", templateId)
    .eq("name", templateName);

  if (language) templateQuery = templateQuery.eq("language", language);

  const { data: templateRow, error: templateError } =
    await templateQuery.maybeSingle();

  if (templateError) {
    console.error("Failed to find template for status update:", {
      account_id: account.wa_id,
      error: templateError,
    });
    return;
  }

  if (!templateRow?.wt_id) {
    console.warn("Template not found for status update", {
      account_id: account.wa_id,
      templateId,
      templateName,
      language,
    });
    return;
  }

  const preview =
    templateRow.preview && typeof templateRow.preview === "object"
      ? {
          ...templateRow.preview,
          id: templateRow.preview.id || templateId,
          name: templateRow.preview.name || templateName,
          language: templateRow.preview.language || language,
          status,
          category: category || templateRow.preview.category,
        }
      : {
          id: templateId,
          name: templateName,
          language,
          status,
          category,
        };

  const updateData = {
    template_id: templateId,
    status,
    reason,
    preview,
  };

  if (category) updateData.category = category;

  const { data: updatedTemplate, error: updateError } = await supabase
    .from("whatsapp_templates")
    .update(updateData)
    .eq("wt_id", templateRow.wt_id)
    .select("wt_id, name, status, category")
    .maybeSingle();

  if (updateError) {
    console.error("Failed to update template status:", {
      account_id: account.wa_id,
      error: updateError,
    });
    return;
  }

  console.log("Template status updated:", updatedTemplate);
}

async function fetchTemplateFromSystem(templateName) {
  const userId = "kp_c7f2725ff7a74158bb7eae3060d6f1de"; // static for now
  const url = `${TEMPLATE_URL}?user_id=${userId}&templateName=${templateName}`;
  try {
    const { data } = await axios.get(url);
    return data.template;
  } catch (err) {
    console.error("⚠️ Failed to fetch WA template:", err.response?.data || err);
    return null;
  }
}

export const verifyWebhook = (req, res) => {
  const verify_token = process.env.WHATSAPP_VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token) {
    if (mode === "subscribe" && token === verify_token) {
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  return res.sendStatus(400);
};

/* ---------------------------
   🔹 MAIN WEBHOOK HANDLER
   --------------------------- */
export const handleIncomingMessage = async (req, res) => {
  console.log("🔹 FULL WHATSAPP PAYLOAD:", JSON.stringify(req.body, null, 2));

  const change = req.body.entry?.[0]?.changes?.[0];
  const value = change?.value;

  const wabaId = req.body.entry?.[0]?.id;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (change?.field === "message_template_status_update") {
    try {
      await handleTemplateStatusUpdate(wabaId, value);
    } catch (err) {
      console.error("Template status webhook handler error:", err);
    }
    return res.sendStatus(200);
  }

  if (!wabaId || !phoneNumberId) {
    console.error("❌ Missing WABA ID or phone_number_id");
    return res.sendStatus(200);
  }

  // if (value?.statuses) {
  //   console.log("ℹ️ Status notification received:", value.statuses[0]?.status);
  //   return res.sendStatus(200);
  // }

  if (value?.statuses) {
    for (const statusObj of value.statuses) {
      const waMessageId = statusObj.id;
      const status = statusObj.status; // sent | delivered | read
      const timestamp = new Date(Number(statusObj.timestamp) * 1000);

      console.log("📌 WA Status Update:", waMessageId, status);

      const updateData = {
        status,
      };

      if (status === "sent") updateData.sent_at = timestamp;
      if (status === "delivered") updateData.delivered_at = timestamp;
      if (status === "read") updateData.read_at = timestamp;
      if (status === "failed") updateData.failed_at = timestamp;

      if (statusObj.errors && statusObj.errors.length > 0) {
        const err = statusObj.errors[0];

        updateData.error_code = err.code || "unknown_error";

        updateData.error_message =
          err.message ||
          err?.error_data?.details ||
          err?.title ||
          "Unknown error";
      }

      // new logic to also update campaign_messages when whatsapp_messages is updated
      const { data: updatedMsg, error } = await supabase
        .from("whatsapp_messages")
        .update(updateData)
        .eq("wa_message_id", waMessageId)
        .select("wm_id")
        .maybeSingle();

      if (error) {
        console.error("❌ Failed to update message status:", error);
      }

      console.log({ updatedMsg });

      // 🔹 NEW: log this status event into whatsapp_status_events so the
      // sync scheduler/cron can pick it up and propagate it to whichever
      // tables need it (campaign_messages, scheduled_messages, etc.)
      // instead of us having to hardcode every table update right here.
      const { error: eventError } = await supabase
        .from("whatsapp_status_events")
        .insert({
          wm_id: updatedMsg?.wm_id || null,
          wa_message_id: waMessageId,
          status,
          event_at: timestamp,
          error_code: updateData.error_code || null,
          error_message: updateData.error_message || null,
        });

      if (eventError) {
        console.error(
          "❌ Failed to insert whatsapp_status_events:",
          eventError,
        );
      }

      // if (updatedMsg?.wm_id) {
      //   // 🔹 ALSO UPDATE CAMPAIGN MESSAGE
      //   const { data: campaignMsg, error: cmError } = await supabase
      //     .from("campaign_messages")
      //     .update({
      //       status: status,
      //       delivered_at: updateData.delivered_at || undefined,
      //       read_at: updateData.read_at || undefined,
      //       sent_at: updateData.sent_at || undefined,
      //       failed_at: updateData.failed_at || undefined,
      //       error_code: updateData.error_code || undefined,
      //       error_message: updateData.error_message || undefined,
      //       updated_at: new Date().toISOString(),
      //     })
      //     .eq("wm_id", updatedMsg.wm_id);

      //   if (cmError) {
      //     console.error("❌ Failed to update campaign message:", cmError);
      //   }

      //   console.log(
      //     campaignMsg
      //       ? { campaignMsg }
      //       : `No campaign message linked to this WhatsApp message`,
      //   );
      // }
    }

    return res.sendStatus(200);
  }

  if (!value?.messages) {
    console.log("⚠️ No messages field in webhook (not a user message)");
    return res.sendStatus(200);
  }

  try {
    const message = value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from.trim();
    let userText = message.text?.body?.trim() || "";
    if (message.type === "button") {
      userText = message?.button?.payload || message?.button?.text || userText;
    }

    // engineText is what gets sent to the bot engine
    // userText stays as the real content for saving to messages table
    let engineText = userText;
    if (
      message.type === "image" ||
      message.type === "document" ||
      message.type === "video"
    ) {
      engineText = "__CUSTOMER_SENT_IMAGE__";
    }

    let mediaId =
      message.image?.id || message.document?.id || message.video?.id || null;

    let mediaUrl = null;

    if (mediaId) {
      mediaUrl = await fetchMediaUrl(mediaId);
    }

    console.log("📩 Incoming:", {
      from,
      type: message.type,
      preview: (userText || "").slice(0, 120),
      mediaUrl: mediaUrl ? "YES" : "NO",
      mediaId,
    });

    // Get user id from whatsapp account table
    const { data: waAccounts, error: waErr } = await supabase
      .from("whatsapp_accounts")
      .select("user_id, wa_id")
      .eq("waba_id", wabaId)
      .eq("phone_number_id", phoneNumberId);

    if (waErr || !waAccounts?.length) {
      console.error("❌ No WhatsApp accounts mapped", {
        wabaId,
        phoneNumberId,
      });
      return res.sendStatus(200);
    }

    let storedMediaPath = mediaId || null;

    if (mediaUrl) {
      try {
        const { buffer, contentType } = await downloadWhatsAppMedia(mediaUrl);

        const ts = Date.now();
        const ext = contentType.split("/")[1] || "bin";
        const fileName = `${message.type}_${ts}.${ext}`;
        const storagePath = `${chatRow.chat_id}/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from("message_media")
          .upload(storagePath, buffer, { contentType });

        if (uploadError) {
          console.error("❌ Upload error:", uploadError);
        } else {
          const { data } = supabase.storage
            .from("message_media")
            .getPublicUrl(storagePath);

          storedMediaPath = data.publicUrl; // ✅ PUBLIC URL
          console.log("✅ Public media URL:", storedMediaPath);
        }
      } catch (err) {
        console.error("❌ Media handling error:", err.message);
      }
    }

    // loop through every user to store message in their chat dashboard
    for (const acc of waAccounts) {
      const user_id = acc.user_id;
      const account_id = acc.wa_id;

      // find chat
      let { data: chatRow } = await supabase
        .from("chats")
        .select("chat_id, mode, active_flow_id, user_id, person_name")
        .eq("user_id", user_id)
        .eq("phone_number", from)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!chatRow?.chat_id) {
        console.warn(
          "⚠️ No chat found for",
          { user_id, from },
          "— creating one",
        );

        // Auto-create a chat record for this phone number
        const contactName = value?.contacts?.[0]?.profile?.name || from;

        const { data: newChat, error: createErr } = await supabase
          .from("chats")
          .insert({
            user_id,
            phone_number: from,
            person_name: contactName,
            last_message: userText || "",
            last_message_at: new Date().toISOString(),
            mode: "BOT",
            status: "active",
          })
          .select("chat_id, mode, active_flow_id, user_id, person_name")
          .single();

        if (createErr || !newChat) {
          console.error("❌ Failed to auto-create chat:", createErr);
          continue;
        }

        console.log("✅ Auto-created chat:", newChat.chat_id, "for", from);

        // Re-assign chatRow so the rest of the loop uses the new chat
        chatRow = newChat;

        // Since this is a brand new chat, re-declare with let so we can reassign
        // NOTE: you'll need to change `const { data: chatRow }` to `let chatRow`
        // at the top of the loop — see note below
      }

      // save incoming user message to chat dashboard
      await chatCtrl.saveMessage({
        chat_id: chatRow.chat_id,
        sender_type: "user",
        message:
          userText || (mediaUrl ? `[${message.type.toUpperCase()}]` : "TEXT"),
        message_type: message.type || "text",
        media_path: storedMediaPath,
      });

      console.log("✅ Message saved for user:", user_id);

      // Only create notification for the account that actually owns this WhatsApp number
      // Prevents duplicate notifications when multiple accounts share the same waba_id
      const { data: isOwner } = await supabase
        .from("whatsapp_accounts")
        .select("wa_id")
        .eq("waba_id", wabaId)
        .eq("phone_number_id", phoneNumberId)
        .eq("wa_id", account_id)
        .maybeSingle();

      if (isOwner) {
        await createNotification({
          user_id,
          chat_id: chatRow.chat_id,
          phone_number: from,
          person_name: chatRow.person_name || null,
          message_preview: userText,
          message_type: message.type || "text",
          type: "incoming_message",
        });
        console.log("🔔 Notification created for account owner:", user_id);
      } else {
        console.log("⏭️ Skipping notification for non-owner account:", user_id);
      }

      // ── Forward to external API webhooks (fire-and-forget) ───────────────
      forwardToApiWebhooks(account_id, {
        event: "message.received",
        account_id,
        from: from,
        message: userText || `[${message.type?.toUpperCase()}]`,
        message_type: message.type || "text",
        media_url: storedMediaPath || null,
        timestamp: new Date().toISOString(),
      });

      // ── Chatbot routing ──────────────────────────────────────────────────
      // Check if the active flow is still active before resuming session
      let shouldResume = false;

      if (chatRow.mode === "BOT" && chatRow.active_flow_id) {
        const { data: activeFlow } = await supabase
          .from("chatbot_flows")
          .select("status")
          .eq("flow_id", chatRow.active_flow_id)
          .maybeSingle();

        if (activeFlow?.status === "active") {
          // Flow is still active — resume the session normally
          shouldResume = true;
        } else {
          // Flow was deactivated — reset chat so new triggers can fire
          console.log(
            "⚠️ [Controller] Active flow is inactive — resetting chat to AI mode",
          );
          await supabase
            .from("chatbot_sessions")
            .update({
              status: "completed",
              updated_at: new Date().toISOString(),
            })
            .eq("chat_id", chatRow.chat_id)
            .in("status", ["active", "handed_off"]);

          await supabase
            .from("chats")
            .update({ mode: "AI", active_flow_id: null })
            .eq("chat_id", chatRow.chat_id);

          // Update local chatRow so keyword matching proceeds below
          chatRow.mode = "AI";
          chatRow.active_flow_id = null;
        }
      }

      if (shouldResume) {
        await handleBotMessage({
          chat_id: chatRow.chat_id,
          phone_number: from, // ← same fix here
          user_text: engineText,
          account_id,
        });
      } else {
        const matchedFlowId = await matchKeywordTrigger(engineText, account_id);
        if (matchedFlowId) {
          await startBotSession({
            chat_id: chatRow.chat_id,
            phone_number: from, // ← use the actual variable name from your controller
            flow_id: matchedFlowId,
            account_id,
            user_text: engineText,
          });
        }
      }
      // ─────────────────────────────────────────────────────────────────────
    }

    // // MESSAGE SAVING — use real userText + media_path
    // await chatCtrl.saveMessage({
    //   chat_id: chatRow.chat_id,
    //   sender_type: "user",
    //   message:
    //     userText || (storedMediaPath ? `[${message.type.toUpperCase()}]` : ""),
    //   message_type: message.type || "text",
    //   media_path: storedMediaPath,
    // });

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook Handler Error:", err);
    return res.sendStatus(500);
  }
};

/* ---------------------------
   🔹 INITIAL MESSAGE BATCH
   --------------------------- */
export const startInitialMessage = async (req, res) => {
  try {
    const { event_id } = req.body;
    if (!event_id)
      return res.status(400).json({ error: "Event ID is required" });

    const { data: participants } = await supabase
      .from("participants")
      .select("participant_id, full_name, phone_number, event_id")
      .eq("event_id", event_id);

    if (!participants?.length)
      return res.status(404).json({ error: "No participants found" });

    const templateName = "rsvp_initial_message";
    const metaTemplate = await fetchTemplateFromSystem(templateName);
    const templateBody = metaTemplate?.components?.find(
      (c) => c.type === "BODY",
    )?.text;
    if (!templateBody)
      return res.status(500).json({ error: "Template body missing" });

    for (const p of participants) {
      let phone = p.phone_number?.toString().trim();
      if (!phone.startsWith("91")) phone = "91" + phone;

      const name = p.full_name?.trim() || "Guest";
      const personalizedMessage = templateBody.replace("{{1}}", name);

      // Ensure chat exists
      let chat_id;
      const { data: existingChat } = await supabase
        .from("chats")
        .select("chat_id")
        .eq("phone_number", phone)
        .eq("event_id", p.event_id)
        .maybeSingle();

      if (existingChat?.chat_id) chat_id = existingChat.chat_id;
      else {
        const { data: newChat } = await supabase
          .from("chats")
          .insert({
            event_id: p.event_id,
            phone_number: phone,
            person_name: name,
            last_message: personalizedMessage,
          })
          .select("chat_id")
          .single();
        chat_id = newChat.chat_id;
      }

      await supabase.from("messages").insert({
        chat_id,
        sender_type: "system",
        message_type: "text",
        message: personalizedMessage,
      });
    }

    return res.json({
      success: true,
      message: "✅ Initial messages triggered successfully!",
    });
  } catch (err) {
    console.error("❌ WhatsApp Send Error:", err);
    return res.status(500).json({ error: "WhatsApp send failed" });
  }
};

/* ---------------------------
   🔹 BATCH INVITE MESSAGE
   --------------------------- */
export const sendBatchInitialMessage = async (req, res) => {
  try {
    const { event_id } = req.body;
    if (!event_id) return res.status(400).json({ error: "event_id required" });

    const { data: participants } = await supabase
      .from("participants")
      .select("participant_id, full_name, phone_number, event_id")
      .eq("event_id", event_id);

    if (!participants?.length)
      return res.status(404).json({ error: "No participants found" });

    const templateName = "invite_rsvp";
    const metaTemplate = await fetchTemplateFromSystem(templateName);
    const templateBody = metaTemplate?.components?.find(
      (c) => c.type === "BODY",
    )?.text;
    if (!templateBody)
      return res.status(500).json({ error: "Template body missing" });

    let successCount = 0;
    for (const p of participants) {
      try {
        let phone = p.phone_number?.toString().trim();
        if (!phone.startsWith("91")) phone = "91" + phone;
        const name = p.full_name?.trim() || "Guest";
        const personalizedMessage = templateBody.replace("{{1}}", name);

        // Send via WhatsApp (template)
        await sendInitialTemplateMessage(phone, templateName, [
          { type: "body", parameters: [{ type: "text", text: name }] },
        ]);

        // Ensure chat exists
        let chat_id;
        const { data: existingChat } = await supabase
          .from("chats")
          .select("chat_id")
          .eq("phone_number", phone)
          .eq("event_id", p.event_id)
          .maybeSingle();
        if (existingChat?.chat_id) chat_id = existingChat.chat_id;
        else {
          const { data: newChat } = await supabase
            .from("chats")
            .insert({
              event_id: p.event_id,
              phone_number: phone,
              person_name: name,
              last_message: personalizedMessage,
            })
            .select("chat_id")
            .single();
          chat_id = newChat.chat_id;
        }

        // Save system message
        await supabase.from("messages").insert({
          chat_id,
          sender_type: "system",
          message_type: "text",
          message: personalizedMessage,
        });

        successCount++;
      } catch (err) {
        console.error("❌ Failed for participant", p.phone_number, err);
      }
    }

    return res.json({
      message: "✅ Batch sent",
      total: participants.length,
      sent: successCount,
    });
  } catch (err) {
    console.error("❌ sendBatchInitialMessage error:", err);
    return res.status(500).json({ error: "Failed to send batch messages" });
  }
};
