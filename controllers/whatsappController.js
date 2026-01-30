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
import {
  downloadWhatsAppMedia
} from "../utils/whatsappMedia.js";


const BUCKET_NAME = process.env.SUPABASE_BUCKET || "message_media";
const TEMPLATE_URL = process.env.TEMPLATE_BASE_URL;

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

  const value = req.body.entry?.[0]?.changes?.[0]?.value;

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

      const { error } = await supabase
        .from("whatsapp_messages")
        .update(updateData)
        .eq("wa_message_id", waMessageId);

      if (error) {
        console.error("❌ Failed to update message status:", error);
      }
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

    let mediaId =
  message.image?.id ||
  message.document?.id ||
  message.video?.id ||
  null;

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

    // 🔹 FIND CHAT BY PHONE NUMBER
    const { data: chatRow } = await supabase
      .from("chats")
      .select("chat_id, group_id ")
      .eq("phone_number", from)
      
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!chatRow) {
      console.warn("⚠️ No chat found for phone:", from);
      return res.sendStatus(200);
    }

  
let storedMediaPath = null;

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



    // 🔹 SAVE USER MESSAGE
    await chatCtrl.saveMessage({
      chat_id: chatRow.chat_id,
      sender_type: "user",
      message:
        userText || (mediaUrl ? `[${message.type.toUpperCase()}]` : "TEXT"),
      message_type: message.type || "text",
      media_path: storedMediaPath,
    });

    console.log("✅ Message saved for chat:", chatRow.chat_id);

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
