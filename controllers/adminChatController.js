import { supabase } from "../config/supabase.js";
import { sendWhatsAppTextMessage } from "../utils/whatsappClient.js";

// checking 24 hours meta rule before sending message
const is24HourWindowExpired = async (chat_id) => {
  const { data, error } = await supabase
    .from("messages")
    .select("created_at")
    .eq("chat_id", chat_id)
    .eq("message_type", "template")
    .eq("sender_type", "admin")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;

  // If no template was ever sent → window expired
  if (!data?.created_at) return true;

  const lastTemplateTime = new Date(data.created_at).getTime();
  const now = Date.now();

  const diffHours = (now - lastTemplateTime) / (1000 * 60 * 60);
  return diffHours > 24;
};

/**
 * POST /admin/chat/send
 * Body: { chat_id, message, admin_id }
 */
export const sendAdminMessage = async (req, res) => {
  try {
    const { chat_id, message } = req.body;
    const admin_id = req.user?.user_id;

    if (!chat_id || !message) {
      return res
        .status(400)
        .json({ error: "chat_id and message are required" });
    }

    /* 1️⃣ Fetch chat */
    const { data: chat, error: chatError } = await supabase
      .from("chats")
      .select("*")
      .eq("chat_id", chat_id)
      .single();

    if (chatError || !chat) {
      return res.status(404).json({ error: "Chat not found" });
    }

    /* 1.1 Enforce WhatsApp 24-hour rule */
    const isExpired = await is24HourWindowExpired(chat_id);

    if (isExpired) {
      return res.status(403).json({
        error:
          "24-hour window expired. Please send a WhatsApp template to re-open the conversation.",
        code: "WHATSAPP_24H_WINDOW_EXPIRED",
      });
    }

    /* 2️⃣ Save admin message */
    const { data: msgRow, error: messageError } = await supabase
      .from("messages")
      .insert({
        chat_id,
        sender_type: "admin",
        message,
        message_type: "text",
        media_path: null,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (messageError) throw messageError;

    /* 3️⃣ Update chat preview */
    await supabase
      .from("chats")
      .update({
        last_message: message,
        last_message_at: new Date().toISOString(),
      })
      .eq("chat_id", chat_id);

    /* 4️⃣ Send message to WhatsApp user */
    await sendWhatsAppTextMessage(chat.phone_number, message);

    return res.json({
      success: true,
      message: msgRow,
    });
  } catch (err) {
    console.error("❌ Admin send message error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// export const resumeAIChat = async (req, res) => {
//   try {
//     const { chat_id } = req.body;
// const admin_id = req.user.user_id;

//     if (!chat_id || !admin_id) {
//       return res.status(400).json({
//         error: "chat_id and admin_id are required"
//       });
//     }

//     // 1️⃣ Check chat exists
//     const { data: chat, error: chatError } = await supabase
//       .from("chats")
//       .select("*")
//       .eq("chat_id", chat_id)
//       .maybeSingle();

//     if (chatError || !chat) {
//       return res.status(404).json({
//         error: "Chat not found"
//       });
//     }

//     // 2️⃣ If already AI, no need to resume
//     if (chat.mode === "AI") {
//       return res.status(200).json({
//         message: "AI is already active for this chat"
//       });
//     }

//     // 3️⃣ Update chat → Resume AI
//     const { error: updateError } = await supabase
//       .from("chats")
//       .update({
//         mode: "AI",
//         manual_activated_by: null,
//         user_notified: false,
//         last_message_at: new Date().toISOString()
//       })
//       .eq("chat_id", chat_id);

//     if (updateError) {
//       console.error("❌ Failed to resume AI:", updateError);
//       return res.status(500).json({
//         error: "Failed to resume AI"
//       });
//     }

//     // 4️⃣ Insert system message (for chat history)
//     await supabase.from("messages").insert({
//       chat_id,
//       sender_type: "system",
//       message_type: "text",
//       message: "Automated replies have been resumed."
//     });

//     console.log(`✅ AI resumed for chat ${chat_id} by ${admin_id}`);

//     return res.json({
//       success: true,
//       message: "AI resumed successfully"
//     });

//   } catch (err) {
//     console.error("❌ resumeAIChat error:", err);
//     return res.status(500).json({
//       error: "Internal server error"
//     });
//   }
// };
