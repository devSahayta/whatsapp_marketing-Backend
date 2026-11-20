import { supabase } from "../config/supabase.js";
import { sendTextToChat } from "../services/chatMessagingService.js";

/**
 * POST /admin/chat/send
 * Body: { chat_id, message }
 * The 24-hour window rule lives in services/chatMessagingService.js
 * (shared with the Samvaadik AI assistant).
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

    const { data: chat, error: chatError } = await supabase
      .from("chats")
      .select("chat_id, user_id, phone_number")
      .eq("chat_id", chat_id)
      .maybeSingle();

    // Only the chat's owner may message this contact
    if (chatError || !chat || chat.user_id !== admin_id) {
      return res.status(404).json({ error: "Chat not found" });
    }

    const result = await sendTextToChat(chat, message);
    if (!result.ok) {
      return res
        .status(result.status)
        .json({ error: result.error, code: result.code });
    }

    return res.json({ success: true, message: result.message });
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
