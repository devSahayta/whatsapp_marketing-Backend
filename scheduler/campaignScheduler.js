// scheduler/campaignScheduler.js - OPTIMIZED FOR 2137+ CONTACTS

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

/* =====================================
   🔥 OPTIMIZED: Process Campaign
   - Handles 2137+ contacts
   - Batch processing (parallel)
   - Pagination for fetching
   - Progress tracking
   - Resumable
====================================== */

async function processCampaign(campaign) {
  console.log(`\n📤 Processing: ${campaign.campaign_name}`);
  console.log(`   Campaign ID: ${campaign.campaign_id}`);
  console.log(`   Scheduled: ${campaign.scheduled_at}`);
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

    // 2️⃣ Get total pending count
    const { count: totalPending, error: countError } = await supabase
      .from("campaign_messages")
      .select("cm_id", { count: "exact", head: true })
      .eq("campaign_id", campaign.campaign_id)
      .eq("status", "pending");

    if (countError) throw countError;

    console.log(`   📊 Total pending messages: ${totalPending}`);

    if (totalPending === 0) {
      console.log("   ⚠️  No pending messages");
      
      // Get current counts
      const { count: sentCount } = await supabase
        .from("campaign_messages")
        .select("cm_id", { count: "exact", head: true })
        .eq("campaign_id", campaign.campaign_id)
        .eq("status", "sent");

      const { count: failedCount } = await supabase
        .from("campaign_messages")
        .select("cm_id", { count: "exact", head: true })
        .eq("campaign_id", campaign.campaign_id)
        .eq("status", "failed");

      await markCampaignCompleted(campaign.campaign_id, sentCount || 0, failedCount || 0);
      return;
    }

    // 3️⃣ Fetch ALL pending messages with pagination
    let allMessages = [];
    let page = 0;
    const pageSize = 1000;

    while (true) {
      const { data: messages, error: msgError } = await supabase
        .from("campaign_messages")
        .select("*")
        .eq("campaign_id", campaign.campaign_id)
        .eq("status", "pending")
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (msgError) throw msgError;

      if (!messages || messages.length === 0) break;

      allMessages = allMessages.concat(messages);
      console.log(`   📄 Fetched page ${page + 1}: ${messages.length} messages (Total: ${allMessages.length})`);

      if (messages.length < pageSize) break;
      page++;
    }

    console.log(`   ✅ Total messages to send: ${allMessages.length}`);

    // 4️⃣ Get template
    const { data: template, error: templateError } = await supabase
      .from("whatsapp_templates")
      .select("*")
      .eq("wt_id", campaign.wt_id)
      .single();

    if (templateError || !template) {
      throw new Error("Template not found");
    }

    console.log(`   Template: ${template.name}`);

    // 5️⃣ Get account
    const { data: account, error: accountError } = await supabase
      .from("whatsapp_accounts")
      .select("*")
      .eq("wa_id", campaign.account_id)
      .single();

    if (accountError || !account) {
      throw new Error("WhatsApp account not found");
    }

    console.log(`   Account: ${account.business_phone_number}`);

    // 6️⃣ Send messages in BATCHES (parallel processing)
    let sent = 0;
    let failed = 0;

    const BATCH_SIZE = 10; // Send 10 messages in parallel
    const BATCH_DELAY = 2000; // 2 seconds between batches

    const totalBatches = Math.ceil(allMessages.length / BATCH_SIZE);

    for (let i = 0; i < allMessages.length; i += BATCH_SIZE) {
      const batch = allMessages.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;

      console.log(`   📤 Sending batch ${batchNumber}/${totalBatches} (${batch.length} messages)...`);

      // Send batch in parallel using Promise.allSettled
      const results = await Promise.allSettled(
        batch.map((message) =>
          sendWhatsAppMessage(
            account,
            template,
            message.phone_number,
            message.contact_name,
            campaign.group_id,
            campaign.user_id,
            campaign.template_variables,
            campaign.media_id
          )
        )
      );

      // Process results and update database
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const message = batch[j];

        if (result.status === "fulfilled") {
          // Success
          await supabase
            .from("campaign_messages")
            .update({
              status: "sent",
              sent_at: new Date().toISOString(),
              wm_id: result.value.wm_id,
              wa_message_id: result.value.wa_message_id,
            })
            .eq("cm_id", message.cm_id);

          sent++;
          console.log(`      ✅ ${message.phone_number}`);
        } else {
          // Failed
          await supabase
            .from("campaign_messages")
            .update({
              status: "failed",
              failed_at: new Date().toISOString(),
              error_message: result.reason?.message || "Unknown error",
              error_code: result.reason?.code || "SEND_ERROR",
            })
            .eq("cm_id", message.cm_id);

          failed++;
          console.log(`      ❌ ${message.phone_number}: ${result.reason?.message}`);
        }
      }

      // Update campaign progress after each batch
      await supabase
        .from("campaigns")
        .update({
          messages_sent: sent,
          messages_failed: failed,
          updated_at: new Date().toISOString(),
        })
        .eq("campaign_id", campaign.campaign_id);

      console.log(`   📊 Progress: ${sent + failed}/${allMessages.length} (Sent: ${sent}, Failed: ${failed})`);

      // Delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < allMessages.length) {
        await sleep(BATCH_DELAY);
      }
    }

    // 7️⃣ Complete campaign
    await markCampaignCompleted(campaign.campaign_id, sent, failed);

    console.log(`\n✅ Campaign completed!`);
    console.log(`   Total: ${sent + failed}`);
    console.log(`   Sent: ${sent}`);
    console.log(`   Failed: ${failed}`);
  } catch (err) {
    console.error(`❌ Campaign processing failed:`, err);

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
   SEND WHATSAPP MESSAGE (with media)
====================================== */

async function sendWhatsAppMessage(
  account,
  template,
  phoneNumber,
  contactName,
  groupId,
  userId,
  variables,
  campaignMediaId
) {
  try {
    // Parse template components
    let templateComponents = template.components;
    if (typeof templateComponents === "string") {
      try {
        templateComponents = JSON.parse(templateComponents);
      } catch (e) {
        console.log("   ⚠️  Failed to parse template components");
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

    // Handle MEDIA HEADER (IMAGE/VIDEO/DOCUMENT)
    const headerComponent = templateComponents.find(
      (comp) => comp.type === "HEADER"
    );

    if (headerComponent && headerComponent.format) {
      const format = headerComponent.format.toUpperCase();

      if (["IMAGE", "VIDEO", "DOCUMENT"].includes(format)) {
        let mediaId = campaignMediaId;

        if (!mediaId) {
          throw new Error(
            `Media ${format} template requires media_id but campaign has none selected`
          );
        }

        messageBody.template.components.push({
          type: "header",
          parameters: [
            {
              type: format.toLowerCase(),
              [format.toLowerCase()]: {
                id: mediaId,
              },
            },
          ],
        });
      } else if (format === "TEXT" && headerComponent.example) {
        const headerText = headerComponent.example.header_text || [];
        if (headerText.length > 0) {
          messageBody.template.components.push({
            type: "header",
            parameters: headerText.map((text) => ({
              type: "text",
              text: text,
            })),
          });
        }
      }
    }

    // Handle BODY VARIABLES
    if (variables && Object.keys(variables).length > 0) {
      const parameters = Object.values(variables).map((value) => ({
        type: "text",
        text: value,
      }));

      messageBody.template.components.push({
        type: "body",
        parameters: parameters,
      });
    }

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

    // Store in whatsapp_messages table
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

    // Find or create chat
    const chatId = await findOrCreateChat(phoneNumber, contactName, groupId, userId);

    // Store in messages table
    await supabase.from("messages").insert({
      chat_id: chatId,
      sender_type: "admin",
      message: templateText,
      message_type: "template",
    });

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
   HELPER FUNCTIONS
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

    await supabase
      .from("chats")
      .update({
        last_message: "Template message sent via campaign",
        last_message_at: new Date().toISOString(),
        last_admin_message_at: new Date().toISOString(),
        group_id: groupId,
        person_name: contactName || existingChat.person_name || "Unknown",
        updated_at: new Date().toISOString(),
      })
      .eq("chat_id", existingChat.chat_id);

    return existingChat.chat_id;
  }

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
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw error;

  return newChat.chat_id;
}

function extractTemplateText(template) {
  try {
    if (!template.components || !Array.isArray(template.components)) {
      return `Template: ${template.name}`;
    }

    let components = template.components;
    if (typeof components === "string") {
      try {
        components = JSON.parse(components);
      } catch (e) {
        return `Template: ${template.name}`;
      }
    }

    const bodyComponent = components.find((comp) => comp.type === "BODY");

    if (bodyComponent && bodyComponent.text) {
      return bodyComponent.text;
    }

    return `Template: ${template.name}`;
  } catch (err) {
    return `Template: ${template.name}`;
  }
}

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default { startCampaignScheduler };