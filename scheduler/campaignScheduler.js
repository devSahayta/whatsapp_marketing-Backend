// scheduler/campaignScheduler.js - FIXED: Passing media_id correctly

import cron from "node-cron";
import { supabase } from "../config/supabase.js";
import axios from "axios";

let isProcessing = false;

export function startCampaignScheduler() {
  console.log("🚀 Campaign Scheduler Started!");
  console.log("⏰ Checking for campaigns every minute...");

  cron.schedule("* * * * *", async () => {
    if (isProcessing) {
      console.log("⏭️  Skipping: Previous run still processing");
      return;
    }

    try {
      isProcessing = true;
      await checkAndSendCampaigns();
    } catch (err) {
      console.error("❌ Scheduler error:", err);
    } finally {
      isProcessing = false;
    }
  });
}

async function checkAndSendCampaigns() {
  const now = new Date();
  console.log(`\n🔍 [${now.toISOString()}] Checking for campaigns...`);

  const { data: campaigns, error } = await supabase
    .from("campaigns")
    .select("*")
    .eq("status", "scheduled")
    .lte("scheduled_at", now.toISOString());

  if (error) {
    console.error("❌ Error fetching campaigns:", error);
    return;
  }

  if (!campaigns || campaigns.length === 0) {
    console.log("✅ No campaigns to send");
    return;
  }

  console.log(`📢 Found ${campaigns.length} campaign(s) to send`);

  for (const campaign of campaigns) {
    await processCampaign(campaign);
  }
}

async function processCampaign(campaign) {
  console.log(`\n📤 Processing: ${campaign.campaign_name}`);
  console.log(`   Campaign ID: ${campaign.campaign_id}`);
  console.log(`   Scheduled: ${campaign.scheduled_at}`);
  
  // 🔥 Log media_id if present
  if (campaign.media_id) {
    console.log(`   📎 Media ID: ${campaign.media_id}`);
  }

  try {
    // 1️⃣ Update status to processing
    await supabase
      .from("campaigns")
      .update({
        status: "processing",
        started_at: new Date().toISOString(),
      })
      .eq("campaign_id", campaign.campaign_id);

    console.log("   Status: PROCESSING");

    // 2️⃣ Get pending messages
    const { data: messages, error: msgError } = await supabase
      .from("campaign_messages")
      .select("*")
      .eq("campaign_id", campaign.campaign_id)
      .eq("status", "pending");

    if (msgError) throw msgError;

    if (!messages || messages.length === 0) {
      console.log("   ⚠️  No pending messages");
      await markCampaignCompleted(campaign.campaign_id, 0, 0);
      return;
    }

    console.log(`   Recipients: ${messages.length}`);

    // 3️⃣ Get template
    const { data: template } = await supabase
      .from("whatsapp_templates")
      .select("*")
      .eq("wt_id", campaign.wt_id)
      .single();

    if (!template) {
      throw new Error("Template not found");
    }

    console.log(`   Template: ${template.name}`);

    // 4️⃣ Get account
    const { data: account } = await supabase
      .from("whatsapp_accounts")
      .select("*")
      .eq("wa_id", campaign.account_id)
      .single();

    if (!account) {
      throw new Error("WhatsApp account not found");
    }

    console.log(`   Account: ${account.business_phone_number}`);

    // 5️⃣ Send messages
    let sent = 0;
    let failed = 0;

    for (const message of messages) {
      try {
        // 🔥 PASS campaign.media_id here!
        const result = await sendWhatsAppMessage(
          account,
          template,
          message.phone_number,
          message.contact_name,
          campaign.group_id,
          campaign.user_id,
          campaign.template_variables,
          campaign.media_id  // ← Pass media_id from campaign!
        );

        // Update campaign_messages
        await supabase
          .from("campaign_messages")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            wm_id: result.wm_id,
            wa_message_id: result.wa_message_id,
          })
          .eq("cm_id", message.cm_id);

        sent++;
        console.log(`   ✅ Sent to ${message.phone_number}`);
        await sleep(1000); // 1 second delay
      } catch (err) {
        await supabase
          .from("campaign_messages")
          .update({
            status: "failed",
            failed_at: new Date().toISOString(),
            error_message: err.message,
            error_code: err.code || "SEND_ERROR",
          })
          .eq("cm_id", message.cm_id);

        failed++;
        console.log(`   ❌ Failed: ${message.phone_number} - ${err.message}`);
      }
    }

    // 6️⃣ Complete campaign
    await markCampaignCompleted(campaign.campaign_id, sent, failed);

    console.log(`\n✅ Campaign completed!`);
    console.log(`   Sent: ${sent}`);
    console.log(`   Failed: ${failed}`);
  } catch (err) {
    console.error(`❌ Campaign failed:`, err);

    await supabase
      .from("campaigns")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
      })
      .eq("campaign_id", campaign.campaign_id);
  }
}

/* =====================================
   🔧 SEND WHATSAPP MESSAGE
   Now handles media templates!
====================================== */

async function sendWhatsAppMessage(account, template, phoneNumber, contactName, groupId, userId, variables, campaignMediaId) {
  try {
    console.log(`   📞 Preparing message for ${phoneNumber}`);
    
    // Parse template components
    let templateComponents = template.components;
    if (typeof templateComponents === 'string') {
      try {
        templateComponents = JSON.parse(templateComponents);
      } catch (e) {
        console.log('   ⚠️  Failed to parse template components');
        templateComponents = [];
      }
    }

    // Build template message
    const messageBody = {
      messaging_product: "whatsapp",
      to: phoneNumber,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language },
        components: [],
      },
    };

    // ========================================
    // 🎨 HANDLE MEDIA HEADER (IMAGE/VIDEO/DOCUMENT)
    // ========================================
    const headerComponent = templateComponents.find(comp => comp.type === 'HEADER');
    
    if (headerComponent && headerComponent.format) {
      const format = headerComponent.format.toUpperCase();
      
      if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) {
        console.log(`   🖼️  Media template detected: ${format}`);
        
        // 🔥 USE CAMPAIGN'S SELECTED MEDIA_ID
        const mediaId = campaignMediaId;
        
        if (!mediaId) {
          throw new Error(`Media ${format} template requires media_id but campaign has none selected`);
        }
        
        console.log(`   📎 Using campaign's media ID: ${mediaId}`);
        
        // Add header component with media
        messageBody.template.components.push({
          type: 'header',
          parameters: [
            {
              type: format.toLowerCase(), // 'image', 'video', or 'document'
              [format.toLowerCase()]: {
                id: mediaId, // WhatsApp media ID from campaign
              },
            },
          ],
        });
        
        console.log(`   ✅ Added ${format} header with media ID: ${mediaId}`);
      } else if (format === 'TEXT' && headerComponent.example) {
        // Handle TEXT header with variables
        const headerText = headerComponent.example.header_text || [];
        if (headerText.length > 0) {
          messageBody.template.components.push({
            type: 'header',
            parameters: headerText.map(text => ({
              type: 'text',
              text: text,
            })),
          });
        }
      }
    }

    // ========================================
    // 📝 HANDLE BODY VARIABLES
    // ========================================
    if (variables && Object.keys(variables).length > 0) {
      const parameters = Object.values(variables).map((value) => ({
        type: "text",
        text: value,
      }));

      messageBody.template.components.push({
        type: "body",
        parameters: parameters,
      });
      
      console.log(`   📝 Added ${parameters.length} body variable(s)`);
    }

    console.log(`   📤 Sending message payload:`, JSON.stringify(messageBody, null, 2));

    const phoneNumberId = account.phone_number_id;
    const accessToken = account.system_user_access_token;

    // Send via WhatsApp API
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
      messageBody,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const wa_message_id = response.data.messages?.[0]?.id;
    const templateText = extractTemplateText(template);

    console.log(`   📱 WhatsApp Message ID: ${wa_message_id}`);

    // 1️⃣ Store in whatsapp_messages table
    const { data: wmRecord, error: wmError } = await supabase
      .from("whatsapp_messages")
      .insert({
        account_id: account.wa_id,
        to_number: phoneNumber,
        template_name: template.name,
        message_body: JSON.stringify(messageBody),
        wa_message_id: wa_message_id,
        status: "sent",
        sent_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (wmError) throw wmError;

    console.log(`   💾 Stored in whatsapp_messages: ${wmRecord.wm_id}`);

    // 2️⃣ Find or create chat
    const chatId = await findOrCreateChat(phoneNumber, contactName, groupId, userId);
    console.log(`   💬 Chat ID: ${chatId}`);

    // 3️⃣ Store in messages table
    const { data: messageRecord, error: msgError } = await supabase
      .from("messages")
      .insert({
        chat_id: chatId,
        sender_type: "admin",
        message: templateText,
        message_type: "template",
      })
      .select()
      .single();

    if (msgError) {
      console.log(`   ⚠️  Failed to store in messages table: ${msgError.message}`);
    } else {
      console.log(`   ✉️  Stored in messages table: ${messageRecord.message_id}`);
    }

    return {
      wm_id: wmRecord.wm_id,
      wa_message_id: wa_message_id,
      chat_id: chatId,
    };
  } catch (err) {
    console.error("WhatsApp API Error:", err.response?.data || err.message);
    throw new Error(
      err.response?.data?.error?.message || err.message || "Failed to send message"
    );
  }
}

/* =====================================
   HELPER: FIND OR CREATE CHAT
====================================== */

async function findOrCreateChat(phoneNumber, contactName, groupId, userId) {
  const { data: existingChats } = await supabase
    .from("chats")
    .select("chat_id, group_id, person_name")
    .eq("phone_number", phoneNumber)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (existingChats && existingChats.length > 0) {
    const existingChat = existingChats[0];
    console.log(`   🔄 Updating existing chat: ${existingChat.chat_id}`);
    
    await supabase
      .from("chats")
      .update({
        last_message: "Template message sent via campaign",
        last_message_at: new Date().toISOString(),
        last_admin_message_at: new Date().toISOString(),
        group_id: groupId,
        person_name: contactName || existingChat.person_name || "Unknown",
        updated_at: new Date().toISOString()
      })
      .eq("chat_id", existingChat.chat_id);

    return existingChat.chat_id;
  }

  console.log(`   🆕 Creating new chat for ${phoneNumber}`);
  
  const { data: newChat, error } = await supabase
    .from("chats")
    .insert({
      phone_number: phoneNumber,
      person_name: contactName || "Unknown",
      last_message: "Template message sent via campaign",
      last_message_at: new Date().toISOString(),
      group_id: groupId,
      mode: "AUTO",
      last_admin_message_at: new Date().toISOString(),
      user_id: userId,
      updated_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    console.log(`   ⚠️  Failed to create chat: ${error.message}`);
    throw error;
  }

  console.log(`   ✅ New chat created: ${newChat.chat_id}`);
  return newChat.chat_id;
}

/* =====================================
   HELPER: EXTRACT TEMPLATE TEXT
====================================== */

function extractTemplateText(template) {
  try {
    if (!template.components || !Array.isArray(template.components)) {
      return `Template: ${template.name}`;
    }

    let components = template.components;
    if (typeof components === 'string') {
      try {
        components = JSON.parse(components);
      } catch (e) {
        return `Template: ${template.name}`;
      }
    }

    const bodyComponent = components.find(
      (comp) => comp.type === "BODY"
    );

    if (bodyComponent && bodyComponent.text) {
      return bodyComponent.text;
    }

    return `Template: ${template.name}`;
  } catch (err) {
    return `Template: ${template.name}`;
  }
}

/* =====================================
   HELPER: MARK CAMPAIGN COMPLETED
====================================== */

async function markCampaignCompleted(campaignId, sent, failed) {
  await supabase
    .from("campaigns")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      messages_sent: sent,
      messages_failed: failed,
    })
    .eq("campaign_id", campaignId);
}

/* =====================================
   HELPER: SLEEP
====================================== */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default { startCampaignScheduler };