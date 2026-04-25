// controllers/chatbotEngine.js
// Runtime engine — executes chatbot flows node by node
// Called from whatsappController.js

import { supabase } from "../config/supabase.js";
import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "../config/anthropic.js";

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — WhatsApp message sender
// Fetches account credentials and sends a text message via WhatsApp Cloud API
// ─────────────────────────────────────────────────────────────────────────────

async function sendWhatsAppText(phone_number, text, account_id) {
  try {
    // Fetch the WhatsApp account credentials
    const { data: acc, error } = await supabase
      .from("whatsapp_accounts")
      .select("phone_number_id, system_user_access_token")
      .eq("wa_id", account_id)
      .single();

    if (error || !acc) {
      console.error(
        "❌ [Engine] Could not fetch WA account for sending:",
        error,
      );
      return;
    }

    const url = `https://graph.facebook.com/v19.0/${acc.phone_number_id}/messages`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${acc.system_user_access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone_number,
        type: "text",
        text: { body: text },
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("❌ [Engine] WA send failed:", JSON.stringify(result));
    } else {
      console.log("✅ [Engine] Message sent to", phone_number);
    }
  } catch (err) {
    console.error("❌ [Engine] sendWhatsAppText error:", err.message);
  }
}

// Save outgoing bot message to the chat dashboard
async function saveBotMessage(chat_id, text) {
  try {
    const now = new Date().toISOString();

    // Save message to messages table
    await supabase.from("messages").insert({
      chat_id,
      sender_type: "bot",
      message: text,
      message_type: "text",
    });

    // Also update the chat's last_message so the chat list shows the bot reply
    await supabase
      .from("chats")
      .update({
        last_message: text.length > 80 ? text.slice(0, 80) + "…" : text,
        last_message_at: now,
      })
      .eq("chat_id", chat_id);
  } catch (err) {
    // Non-critical — don't crash the engine if logging fails
    console.warn(
      "⚠️ [Engine] saveBotMessage failed (non-critical):",
      err.message,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Variable interpolation
// Replaces {{variable_name}} in text with values from session variables
// ─────────────────────────────────────────────────────────────────────────────

function interpolate(text, variables = {}) {
  if (!text) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return variables[key] !== undefined ? String(variables[key]) : `{{${key}}}`;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Session helpers
// ─────────────────────────────────────────────────────────────────────────────

// Get active session for a chat
async function getActiveSession(chat_id) {
  const { data, error } = await supabase
    .from("chatbot_sessions")
    .select("*")
    .eq("chat_id", chat_id)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) console.error("❌ [Engine] getActiveSession:", error);
  return data || null;
}

// Update session state (current node + variables)
async function updateSession(session_id, current_node_id, variables) {
  const { error } = await supabase
    .from("chatbot_sessions")
    .update({
      current_node_id,
      variables,
      updated_at: new Date().toISOString(),
    })
    .eq("session_id", session_id);

  if (error) console.error("❌ [Engine] updateSession:", error);
}

// End a session and reset chat mode
async function endSession(session_id, chat_id) {
  await supabase
    .from("chatbot_sessions")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("session_id", session_id);

  // Reset chat back to AI/MANUAL mode
  await supabase
    .from("chats")
    .update({ mode: "AI", active_flow_id: null })
    .eq("chat_id", chat_id);

  console.log("✅ [Engine] Session ended, chat reset to AI mode:", chat_id);
}

// Handoff — set chat to MANUAL so a human agent takes over
async function handoffSession(session_id, chat_id) {
  await supabase
    .from("chatbot_sessions")
    .update({ status: "handed_off", updated_at: new Date().toISOString() })
    .eq("session_id", session_id);

  await supabase
    .from("chats")
    .update({ mode: "MANUAL", active_flow_id: null })
    .eq("chat_id", chat_id);

  console.log("🤝 [Engine] Chat handed off to human agent:", chat_id);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Flow / node helpers
// ─────────────────────────────────────────────────────────────────────────────

// Load all nodes and edges for a flow (cached per request via simple object)
async function loadFlowGraph(flow_id) {
  const [nodesRes, edgesRes] = await Promise.all([
    supabase.from("chatbot_nodes").select("*").eq("flow_id", flow_id),
    supabase.from("chatbot_edges").select("*").eq("flow_id", flow_id),
  ]);

  if (nodesRes.error) throw nodesRes.error;
  if (edgesRes.error) throw edgesRes.error;

  // Build a quick-lookup map: node_id → node
  const nodeMap = {};
  for (const n of nodesRes.data || []) {
    nodeMap[n.node_id] = n;
  }

  return {
    nodes: nodesRes.data || [],
    edges: edgesRes.data || [],
    nodeMap,
  };
}

// Get the next node to execute after the current one
// conditionLabel: "yes" | "no" | null
function getNextNode(current_node_id, edges, nodeMap, conditionLabel = null) {
  const outgoing = edges.filter((e) => e.source_node_id === current_node_id);

  if (outgoing.length === 0) return null;

  // For condition nodes, find the matching yes/no edge
  if (conditionLabel !== null) {
    const match = outgoing.find((e) => e.condition_label === conditionLabel);
    if (match) return nodeMap[match.target_node_id] || null;
    return null;
  }

  // For all other nodes, take the first outgoing edge
  const edge = outgoing[0];
  return nodeMap[edge.target_node_id] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Node executors
// Each function handles one node type.
// Returns { advance: bool, conditionLabel: string|null, variables: object }
// ─────────────────────────────────────────────────────────────────────────────

// send_message: interpolate and send text
async function execSendMessage(
  node,
  variables,
  phone_number,
  account_id,
  chat_id,
) {
  const text = interpolate(node.config.text || "", variables);
  if (text) {
    await sendWhatsAppText(phone_number, text, account_id);
    await saveBotMessage(chat_id, text);
  }
  return { advance: true, variables };
}

// send_template: send a WhatsApp template message
async function execSendTemplate(
  node,
  variables,
  phone_number,
  account_id,
  chat_id,
) {
  try {
    const { template_name, template_variable_map = {} } = node.config;
    if (!template_name) return { advance: true, variables };

    // Build template components with interpolated variables
    const components = [];
    const mappedVars = Object.entries(template_variable_map);

    if (mappedVars.length > 0) {
      const bodyParams = mappedVars.map(([pos, varName]) => ({
        type: "text",
        text: interpolate(varName, variables) || "",
      }));
      components.push({ type: "body", parameters: bodyParams });
    }

    const { data: acc } = await supabase
      .from("whatsapp_accounts")
      .select(
        "phone_number_id, system_user_access_token, business_phone_number",
      )
      .eq("wa_id", account_id)
      .single();

    if (!acc) return { advance: true, variables };

    await fetch(
      `https://graph.facebook.com/v19.0/${acc.phone_number_id}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${acc.system_user_access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone_number,
          type: "template",
          template: {
            name: template_name,
            language: { code: "en_US" },
            components: components.length > 0 ? components : undefined,
          },
        }),
      },
    );

    console.log("✅ [Engine] Template sent:", template_name);
  } catch (err) {
    console.error("❌ [Engine] execSendTemplate error:", err.message);
  }

  return { advance: true, variables };
}

// wait_for_input: save user's message into a session variable, then advance
// Uses a sentinel variable _waiting_for_<save_as> to distinguish:
//   1st call = send prompt (if any) and stop, waiting for reply
//   2nd call = user replied -> save their text and advance
async function execWaitForInput(
  node,
  variables,
  userText,
  phone_number,
  account_id,
  chat_id,
) {
  const { prompt, save_as } = node.config;
  const sentinelKey = `_waiting_for_${save_as || "input"}`;

  // Second call: sentinel is set, meaning user has replied -> save and advance
  if (variables[sentinelKey]) {
    const newVars = { ...variables };
    delete newVars[sentinelKey]; // clean up sentinel
    if (save_as && userText) {
      newVars[save_as] = userText;
      console.log(`[Engine] Saved variable: ${save_as} = "${userText}"`);
    }
    return { advance: true, variables: newVars };
  }

  // First call: send prompt if configured, set sentinel, stop and wait
  if (prompt) {
    const text = interpolate(prompt, variables);
    await sendWhatsAppText(phone_number, text, account_id);
    await saveBotMessage(chat_id, text);
  }

  // Set sentinel so the next incoming message knows to save and advance
  const newVars = { ...variables, [sentinelKey]: true };
  return { advance: false, variables: newVars };
}

// condition: evaluate a variable against a value, return yes/no edge
async function execCondition(node, variables) {
  const { variable, operator = "==", value } = node.config;

  const actual = variables[variable];
  const expected = value;
  let result = false;

  switch (operator) {
    case "==":
      result = String(actual).toLowerCase() === String(expected).toLowerCase();
      break;
    case "!=":
      result = String(actual).toLowerCase() !== String(expected).toLowerCase();
      break;
    case "contains":
      result = String(actual)
        .toLowerCase()
        .includes(String(expected).toLowerCase());
      break;
    case "not_contains":
      result = !String(actual)
        .toLowerCase()
        .includes(String(expected).toLowerCase());
      break;
    case ">":
      result = parseFloat(actual) > parseFloat(expected);
      break;
    case "<":
      result = parseFloat(actual) < parseFloat(expected);
      break;
    default:
      result = false;
  }

  console.log(
    `✅ [Engine] Condition: {{${variable}}} (${actual}) ${operator} "${expected}" → ${result ? "YES" : "NO"}`,
  );

  return { advance: true, conditionLabel: result ? "yes" : "no", variables };
}

// delay: pause execution for N seconds
async function execDelay(node) {
  const seconds = node.config.seconds || 5;
  console.log(`⏳ [Engine] Delaying ${seconds}s`);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  return { advance: true };
}

// ai_fallback: send a static fallback message
async function execAiFallback(
  node,
  variables,
  phone_number,
  account_id,
  chat_id,
) {
  const text = interpolate(
    node.config.fallback_message || "I'm sorry, I didn't understand that.",
    variables,
  );
  await sendWhatsAppText(phone_number, text, account_id);
  await saveBotMessage(chat_id, text);
  return { advance: true, variables };
}

// handoff_to_agent: send message + hand chat to human
async function execHandoff(
  node,
  variables,
  phone_number,
  account_id,
  chat_id,
  session_id,
) {
  const text = interpolate(
    node.config.message || "Transferring you to a human agent. Please wait…",
    variables,
  );
  await sendWhatsAppText(phone_number, text, account_id);
  await saveBotMessage(chat_id, text);
  await handoffSession(session_id, chat_id);
  return { advance: false, variables }; // session ends here
}

// end_flow: send goodbye + end session
async function execEndFlow(
  node,
  variables,
  phone_number,
  account_id,
  chat_id,
  session_id,
) {
  const text = interpolate(
    node.config.message || "Thank you for contacting us!",
    variables,
  );
  if (text) {
    await sendWhatsAppText(phone_number, text, account_id);
    await saveBotMessage(chat_id, text);
  }
  await endSession(session_id, chat_id);
  return { advance: false, variables }; // session ends here
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — AI Agent executor (multi-turn)
// This is the most complex node — it stays on this node across multiple
// messages until an exit condition is met
// ─────────────────────────────────────────────────────────────────────────────

// REPLACE the existing execAiAgent function in services/chatbotEngine.js
// with this updated version

// REPLACE the entire execAiAgent function in services/chatbotEngine.js with this

async function execAiAgent(
  node,
  variables,
  userText,
  phone_number,
  account_id,
  chat_id,
  session_id,
) {
  const { agent_id, save_response_as } = node.config;

  if (!agent_id) {
    console.error("❌ [Engine] ai_agent node has no agent_id configured");
    return { advance: true, variables };
  }

  // Load agent config
  const { data: agent, error: agentErr } = await supabase
    .from("chatbot_agents")
    .select("*")
    .eq("agent_id", agent_id)
    .single();

  if (agentErr || !agent) {
    console.error("❌ [Engine] Agent not found:", agent_id);
    return { advance: true, variables };
  }

  const upperText = userText.toUpperCase().trim();

  // ── Handle incoming image from customer ───────────────────────────────────
  if (userText === "__CUSTOMER_SENT_IMAGE__") {
    const orderStage = variables._order_stage;

    if (orderStage === "awaiting_payment_screenshot") {
      // ── Extract order details from conversation history ──────────────────────
      const history = variables._agent_history || [];

      // Extract product name — use last product context first, then scan history
      let productName = variables._last_product_name || "Unknown Product";
      let totalAmount = 0;
      let deliveryAddress = "To be confirmed";
      let customerName = "Customer";

      // Helper to extract field from Claude's messages in history
      const extractFromHistory = (label) => {
        for (let i = history.length - 1; i >= 0; i--) {
          const msg = history[i];
          if (msg.role === "assistant") {
            const match = msg.content.match(
              new RegExp(`${label}[:\\s*]+([^\\n]+)`, "i"),
            );
            if (match) return match[1].replace(/\*+/g, "").trim();
          }
        }
        return null;
      };

      // Extract amount from history — look for ₹ followed by numbers
      for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i];
        if (msg.role === "assistant") {
          const amountMatch = msg.content.match(/₹\s*([\d,]+)/);
          if (amountMatch) {
            totalAmount = parseFloat(amountMatch[1].replace(/,/g, "")) || 0;
            break;
          }
        }
      }

      // Extract product from history
      const extractedProduct = extractFromHistory("product");
      if (extractedProduct) productName = extractedProduct;

      // Extract address from history
      const extractedAddress = extractFromHistory("address");
      if (extractedAddress) deliveryAddress = extractedAddress;

      // Extract customer name — find where agent asked for name, next user message is the name
      for (let i = 0; i < history.length; i++) {
        const msg = history[i];
        if (
          msg.role === "assistant" &&
          (msg.content.toLowerCase().includes("what's your name") ||
            msg.content.toLowerCase().includes("your name") ||
            msg.content.toLowerCase().includes("may i know your name"))
        ) {
          const nextMsg = history[i + 1];
          if (nextMsg?.role === "user" && nextMsg.content.trim().length < 40) {
            customerName = nextMsg.content.trim();
            break;
          }
        }
      }

      // Save order to DB
      await saveShopOrder({
        chat_id,
        account_id,
        phone_number,
        customer_name: customerName,
        product_name: productName,
        quantity: 1,
        total_amount: totalAmount,
        payment_method: "UPI",
        delivery_address: deliveryAddress,
        notes: "Payment screenshot received — verify manually",
      });

      // Reply to customer with full details
      const confirmMsg =
        `✅ Thank you! Your payment screenshot has been received.\n\n` +
        `We will verify your payment and confirm your order within *30 minutes*. 🙏\n\n` +
        `*Order Summary:*\n` +
        `📦 ${productName}\n` +
        `💰 ₹${totalAmount}\n` +
        `📍 ${deliveryAddress}\n` +
        `👤 ${customerName}\n\n` +
        `Thank you for shopping with Baby's Shop! 👶🛍️`;

      await sendWhatsAppText(phone_number, confirmMsg, account_id);
      await saveBotMessage(chat_id, confirmMsg);

      // Update session — order done, clear stage
      return {
        advance: false,
        variables: {
          ...variables,
          _order_stage: "completed",
          _agent_turns_left:
            (variables._agent_turns_left ?? agent.max_turns) - 1,
        },
      };
    }

    // Image received but not in payment flow — ignore gracefully
    const msg = "I can only process text messages. Please type your reply! 😊";
    await sendWhatsAppText(phone_number, msg, account_id);
    await saveBotMessage(chat_id, msg);
    return { advance: false, variables };
  }

  // ── Fix 1: Broad photo request detection ─────────────────────────────────
  const PHOTO_TRIGGERS = [
    "PHOTO",
    "PIC",
    "PICTURE",
    "IMAGE",
    "SHOW ME",
    "SEND PHOTO",
    "SEND IMAGE",
    "SEND PIC",
    "CAN YOU SHARE",
    "SHARE THE PIC",
    "SHARE THE PHOTO",
    "SHARE THE IMAGE",
    "SEE THE PRODUCT",
    "SHOW THE PRODUCT",
    "PRODUCT PHOTO",
    "PRODUCT IMAGE",
    "PRODUCT PIC",
    "CAN I SEE",
  ];

  const isPhotoRequest = PHOTO_TRIGGERS.some((t) => upperText.includes(t));

  if (isPhotoRequest) {
    const lastProduct = variables._last_product_name;

    if (!lastProduct) {
      // Ask Claude to clarify which product — don't hardcode a response
      // Fall through to Claude below with a note injected
    } else {
      // Look up the product image
      const { data: products } = await supabase
        .from("shop_products")
        .select("name, image_url, price, description")
        .eq("account_id", account_id)
        .ilike("name", `%${lastProduct}%`)
        .limit(1);

      const product = products?.[0];

      if (product?.image_url) {
        // Send acknowledgement text first
        const ackMsg = `Here's the photo of *${product.name}*! 📸`;
        await sendWhatsAppText(phone_number, ackMsg, account_id);
        await saveBotMessage(chat_id, ackMsg);

        // Send the actual image
        const caption = `${product.name} — ₹${product.price}`;
        await sendWhatsAppImage(
          phone_number,
          product.image_url,
          caption,
          account_id,
        );
        await saveBotMessage(chat_id, `[Image: ${product.name}]`);

        // Follow up
        const followUp = `Would you like to *ORDER* this, or shall I show you more products? 😊`;
        await sendWhatsAppText(phone_number, followUp, account_id);
        await saveBotMessage(chat_id, followUp);

        console.log(`📸 [Engine] Image sent for: ${product.name}`);

        // Update history so Claude knows what happened
        const newHistory = [
          ...(variables._agent_history || []),
          { role: "user", content: userText },
          {
            role: "assistant",
            content: `${ackMsg}\n[Product image sent]\n${followUp}`,
          },
        ];

        return {
          advance: false,
          variables: {
            ...variables,
            _agent_history: newHistory,
            _agent_turns_left:
              (variables._agent_turns_left ?? agent.max_turns) - 1,
          },
        };
      } else {
        // No image in DB — let Claude respond naturally
        const noPhotoMsg = `Sorry, I don't have a photo for *${product?.name || lastProduct}* right now. Would you like to ORDER it or see other products? 😊`;
        await sendWhatsAppText(phone_number, noPhotoMsg, account_id);
        await saveBotMessage(chat_id, noPhotoMsg);

        const newHistory = [
          ...(variables._agent_history || []),
          { role: "user", content: userText },
          { role: "assistant", content: noPhotoMsg },
        ];

        return {
          advance: false,
          variables: {
            ...variables,
            _agent_history: newHistory,
            _agent_turns_left:
              (variables._agent_turns_left ?? agent.max_turns) - 1,
          },
        };
      }
    }
  }

  // ── Check exit keywords ───────────────────────────────────────────────────
  const exitKeywords = (agent.exit_keywords || []).map((k) => k.toUpperCase());
  if (exitKeywords.length > 0 && exitKeywords.includes(upperText)) {
    console.log("🚪 [Engine] Exit keyword detected:", userText);
    return { advance: true, variables };
  }

  // ── Check turn limit ──────────────────────────────────────────────────────
  const turnsLeft = variables._agent_turns_left ?? agent.max_turns;

  if (turnsLeft <= 0) {
    console.log("⚠️ [Engine] Agent max turns reached");
    if (agent.fallback_action === "handoff_to_agent") {
      const msg =
        "Let me connect you with our team directly. Please wait a moment! 🙏";
      await sendWhatsAppText(phone_number, msg, account_id);
      await saveBotMessage(chat_id, msg);
      await handoffSession(session_id, chat_id);
      return { advance: false, variables };
    } else {
      await endSession(session_id, chat_id);
      return { advance: false, variables };
    }
  }

  // ── Build conversation history ────────────────────────────────────────────
  const agentHistory = variables._agent_history || [];
  const systemPrompt = interpolate(
    agent.system_prompt || "You are a helpful assistant.",
    variables,
  );

  const updatedHistory = [...agentHistory, { role: "user", content: userText }];

  // ── Call Claude ───────────────────────────────────────────────────────────
  let reply = "";
  try {
    const response = await anthropic.messages.create({
      model: agent.model || "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      temperature: parseFloat(agent.temperature) || 0.7,
      system: systemPrompt,
      messages: updatedHistory,
    });

    reply =
      response.content?.[0]?.text || "I'm sorry, I couldn't process that.";
    console.log(
      `✅ [Engine] AI Agent replied (${response.usage?.output_tokens} tokens)`,
    );
  } catch (err) {
    console.error("❌ [Engine] Claude API error:", err.message);
    if (err.status === 429) {
      reply = "I'm a little busy right now. Please try again in a moment! 🙏";
    } else {
      reply = "Sorry, I'm having a little trouble. Please try again!";
    }
  }

  // ── Send Claude's text reply ──────────────────────────────────────────────
  await sendWhatsAppText(phone_number, reply, account_id);
  await saveBotMessage(chat_id, reply);

  // After the UPI stage detection above

  // ── Fix 2: If Claude promised a photo, actually send it ───────────────────
  const PHOTO_PROMISE_PHRASES = [
    "sending you the photo",
    "sending the photo",
    "photo is being sent",
    "image is being sent",
    "sending the image",
    "here's the photo",
    "here is the photo",
    "sending now",
    "photo now",
    "sending you a photo",
    "the photo is on its way",
    "dispatching the photo",
  ];

  const claudePromisedPhoto = PHOTO_PROMISE_PHRASES.some((phrase) =>
    reply.toLowerCase().includes(phrase),
  );

  if (claudePromisedPhoto) {
    const lastProduct = variables._last_product_name;

    if (lastProduct) {
      const { data: products } = await supabase
        .from("shop_products")
        .select("name, image_url, price")
        .eq("account_id", account_id)
        .ilike("name", `%${lastProduct}%`)
        .limit(1);

      const product = products?.[0];

      if (product?.image_url) {
        const caption = `${product.name} — ₹${product.price}`;
        await sendWhatsAppImage(
          phone_number,
          product.image_url,
          caption,
          account_id,
        );
        await saveBotMessage(chat_id, `[Image sent: ${product.name}]`);
        console.log(
          `📸 [Engine] Auto-sent promised image for: ${product.name}`,
        );
      }
    }
  }

  // ── Detect product name from Claude's reply → update context ─────────────
  let newLastProduct = variables._last_product_name;
  try {
    const { data: allProducts } = await supabase
      .from("shop_products")
      .select("name")
      .eq("account_id", account_id);

    if (allProducts) {
      const replyLower = reply.toLowerCase();
      const found = allProducts.find((p) =>
        replyLower.includes(p.name.toLowerCase()),
      );
      if (found) {
        newLastProduct = found.name;
        console.log(`📦 [Engine] Product context updated: ${found.name}`);
      }
    }
  } catch {
    // Non-critical
  }

  // ── Detect and save order ─────────────────────────────────────────────────
  // ── Detect order confirmation from Claude's reply ─────────────────────────
  // Works for both COD and UPI — detects when Claude confirms an order
  const ORDER_CONFIRMED_PHRASES = [
    "order confirmed",
    "✅ order confirmed",
    "order is confirmed",
    "your order has been confirmed",
    "thank you for shopping",
  ];

  const isOrderConfirmed = ORDER_CONFIRMED_PHRASES.some((phrase) =>
    reply.toLowerCase().includes(phrase),
  );

  if (isOrderConfirmed) {
    try {
      // Extract details from Claude's reply using regex
      const extractField = (label, text) => {
        const match = text.match(new RegExp(`${label}[:\\s*]+([^\\n]+)`, "i"));
        return match ? match[1].replace(/\*+/g, "").trim() : null;
      };

      const productName =
        extractField("product", reply) ||
        variables._last_product_name ||
        "Unknown Product";
      const amountStr = extractField("amount", reply) || "0";
      const amount = parseFloat(amountStr.replace(/[₹,\s]/g, "")) || 0;
      const paymentMethod =
        extractField("payment", reply) || (upperText === "COD" ? "COD" : "UPI");
      const address =
        extractField("address", reply) ||
        variables.delivery_address ||
        "To be confirmed";

      // Extract customer name from conversation history
      const history = variables._agent_history || [];
      let customerName = "Customer";
      for (let i = 0; i < history.length; i++) {
        const msg = history[i];
        if (
          msg.role === "assistant" &&
          msg.content.toLowerCase().includes("name")
        ) {
          const nextMsg = history[i + 1];
          if (nextMsg?.role === "user" && nextMsg.content.length < 40) {
            customerName = nextMsg.content.trim();
            break;
          }
        }
      }

      console.log("🛍️ [Engine] Order detected — saving:", {
        productName,
        amount,
        paymentMethod,
      });

      await saveShopOrder({
        chat_id,
        account_id,
        phone_number,
        customer_name: customerName,
        product_name: productName,
        quantity: 1,
        total_amount: amount,
        payment_method: paymentMethod,
        delivery_address: address,
        notes: reply.includes("screenshot")
          ? "Payment screenshot received — verify manually"
          : `Session: ${session_id}`,
      });

      console.log("✅ [Engine] Order saved and owner notified");
    } catch (err) {
      console.error("❌ [Engine] Failed to save order:", err.message);
    }
  }

  // ── Update session variables ──────────────────────────────────────────────
  const newHistory = [...updatedHistory, { role: "assistant", content: reply }];

  // ── Detect UPI payment stage ──────────────────────────────────────────────
  const UPI_SENT_PHRASES = [
    "babyshop@ybl",
    "upi id:",
    "send ₹",
    "once you've paid",
    "once paid",
    "reply paid",
  ];

  const justSentUpiDetails = UPI_SENT_PHRASES.some((phrase) =>
    reply.toLowerCase().includes(phrase),
  );

  // Build new variables — declared HERE before any use
  const newVariables = {
    ...variables,
    _agent_history: newHistory,
    _agent_turns_left: turnsLeft - 1,
    _last_product_name: newLastProduct,
  };

  // Now safely set UPI stage and send QR
  if (justSentUpiDetails) {
    newVariables._order_stage = "awaiting_payment_screenshot";
    console.log("💳 [Engine] UPI payment stage set — waiting for screenshot");

    // Send UPI QR image
    const qrUrl = process.env.UPI_QR_URL;
    console.log("💳 [Engine] QR URL being sent:", qrUrl);
    if (qrUrl) {
      await sendWhatsAppImage(
        phone_number,
        qrUrl,
        "Scan to pay via UPI — babyshop@ybl",
        account_id,
      );
      await saveBotMessage(chat_id, "[UPI QR sent]");
      console.log("💳 [Engine] UPI QR image sent");
    } else {
      console.warn("⚠️ [Engine] UPI_QR_URL not set in .env");
    }
  }

  if (save_response_as) {
    newVariables[save_response_as] = reply;
  }

  return { advance: false, variables: newVariables };
}

// ─── ADD THESE TWO HELPERS anywhere after sendWhatsAppText ───────────────────

async function sendWhatsAppImage(phone_number, image_url, caption, account_id) {
  try {
    const { data: acc, error } = await supabase
      .from("whatsapp_accounts")
      .select("phone_number_id, system_user_access_token")
      .eq("wa_id", account_id)
      .single();

    if (error || !acc) {
      console.error(
        "❌ [Engine] Could not fetch WA account for image send:",
        error,
      );
      return;
    }

    const url = `https://graph.facebook.com/v19.0/${acc.phone_number_id}/messages`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${acc.system_user_access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone_number,
        type: "image",
        image: {
          link: image_url,
          caption: caption || "",
        },
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error(
        "❌ [Engine] WA image send failed:",
        JSON.stringify(result),
      );
    } else {
      console.log("✅ [Engine] Image sent to", phone_number);
    }
  } catch (err) {
    console.error("❌ [Engine] sendWhatsAppImage error:", err.message);
  }
}

// ── Save a shop order to DB + notify shop owner via WhatsApp ──────────────────
async function saveShopOrder({
  chat_id,
  account_id,
  phone_number,
  customer_name,
  product_name,
  quantity = 1,
  total_amount,
  payment_method,
  delivery_address,
  notes,
}) {
  try {
    // 1. Save order to DB
    const { data: order, error } = await supabase
      .from("shop_orders")
      .insert({
        chat_id,
        account_id,
        customer_name,
        customer_phone: phone_number,
        product_name,
        quantity,
        total_amount,
        payment_method,
        delivery_address,
        status: "pending",
        notes,
      })
      .select()
      .single();

    if (error) {
      console.error("❌ [Engine] saveShopOrder DB error:", error);
      return null;
    }

    console.log("✅ [Engine] Order saved:", order.order_id);

    // 2. Notify shop owner via WhatsApp
    const OWNER_PHONE = process.env.SHOP_OWNER_PHONE; // e.g. "919876543210"
    const OWNER_ACCOUNT = account_id;

    if (OWNER_PHONE) {
      const notification =
        `🛍️ *New Order — Baby's Shop*\n\n` +
        `📦 Product: ${product_name}\n` +
        `🔢 Qty: ${quantity}\n` +
        `💰 Amount: ₹${total_amount}\n` +
        `💳 Payment: ${payment_method}\n` +
        `👤 Customer: ${customer_name}\n` +
        `📞 Phone: ${phone_number}\n` +
        `📍 Address: ${delivery_address}\n` +
        `🕐 Time: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}\n\n` +
        `Order ID: ${order.order_id.slice(0, 8).toUpperCase()}`;

      await sendWhatsAppText(OWNER_PHONE, notification, OWNER_ACCOUNT);
      console.log("✅ [Engine] Owner notified about new order");
    }

    return order;
  } catch (err) {
    console.error("❌ [Engine] saveShopOrder error:", err.message);
    return null;
  }
}

// ── Detect if Claude's reply contains a PHOTO request and send image ──────────
// Call this after Claude replies in execAiAgent
// Claude will say something like: "SEND_PHOTO:Fisher-Price Activity Cube"
// or we detect the word PHOTO in the user's message and look up the product
async function handlePhotoRequest(
  userText,
  variables,
  phone_number,
  account_id,
  chat_id,
) {
  const text = userText.toUpperCase().trim();

  if (text !== "PHOTO" && !text.startsWith("PHOTO")) return false;

  // Get the last product the user was looking at (stored in session variables)
  const lastProduct = variables._last_product_name;
  if (!lastProduct) {
    await sendWhatsAppText(
      phone_number,
      "Which product would you like to see? Please tell me the product name first.",
      account_id,
    );
    await saveBotMessage(chat_id, "Which product would you like to see?");
    return true;
  }

  // Look up the product in DB by name (fuzzy match)
  const { data: products } = await supabase
    .from("shop_products")
    .select("name, image_url, price, description")
    .eq("account_id", account_id)
    .ilike("name", `%${lastProduct}%`)
    .limit(1);

  const product = products?.[0];

  if (!product?.image_url) {
    await sendWhatsAppText(
      phone_number,
      `Sorry, no photo available for ${lastProduct} right now. Would you like to order it?`,
      account_id,
    );
    await saveBotMessage(
      chat_id,
      `Sorry, no photo available for ${lastProduct}.`,
    );
    return true;
  }

  // Send the image
  const caption = `${product.name}\n₹${product.price}\n${product.description || ""}`;
  await sendWhatsAppImage(phone_number, product.image_url, caption, account_id);
  await saveBotMessage(chat_id, `[Image: ${product.name}]`);

  // Follow up with order prompt
  const followUp = `Here's the photo of *${product.name}*! 😊\n\nWould you like to order it?\nReply *ORDER* to proceed or *BACK* to see more products.`;
  await sendWhatsAppText(phone_number, followUp, account_id);
  await saveBotMessage(chat_id, followUp);

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — Main node executor
// Routes to the correct handler based on node type
// ─────────────────────────────────────────────────────────────────────────────

async function executeNode({
  node,
  variables,
  userText,
  phone_number,
  account_id,
  chat_id,
  session_id,
}) {
  const type = node.node_type;
  console.log(`⚙️  [Engine] Executing node: ${type} (${node.node_id})`);

  switch (type) {
    case "keyword_trigger":
      // Trigger nodes have no action — just advance
      return { advance: true, conditionLabel: null, variables };

    case "send_message":
      return await execSendMessage(
        node,
        variables,
        phone_number,
        account_id,
        chat_id,
      );

    case "send_template":
      return await execSendTemplate(
        node,
        variables,
        phone_number,
        account_id,
        chat_id,
      );

    case "wait_for_input":
      return await execWaitForInput(
        node,
        variables,
        userText,
        phone_number,
        account_id,
        chat_id,
      );

    case "condition":
      return await execCondition(node, variables);

    case "delay":
      return await execDelay(node);

    case "ai_agent":
      return await execAiAgent(
        node,
        variables,
        userText,
        phone_number,
        account_id,
        chat_id,
        session_id,
      );

    case "ai_fallback":
      return await execAiFallback(
        node,
        variables,
        phone_number,
        account_id,
        chat_id,
      );

    case "handoff_to_agent":
      return await execHandoff(
        node,
        variables,
        phone_number,
        account_id,
        chat_id,
        session_id,
      );

    case "end_flow":
      return await execEndFlow(
        node,
        variables,
        phone_number,
        account_id,
        chat_id,
        session_id,
      );

    case "trigger_campaign":
      // TODO: Phase 4 — trigger a campaign
      console.log("⚠️ [Engine] trigger_campaign not yet implemented");
      return { advance: true, variables };

    default:
      console.warn(`⚠️ [Engine] Unknown node type: ${type} — skipping`);
      return { advance: true, variables };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — Flow runner
// Executes nodes in sequence until we hit a "wait" state or end
// ─────────────────────────────────────────────────────────────────────────────

async function runFlow({
  session,
  startNode,
  edges,
  nodeMap,
  userText,
  phone_number,
  account_id,
  chat_id,
}) {
  let currentNode = startNode;
  let variables = session.variables || {};
  const session_id = session.session_id;

  // Safety limit — prevents infinite loops in misconfigured flows
  const MAX_STEPS = 20;
  let steps = 0;

  while (currentNode && steps < MAX_STEPS) {
    steps++;

    const result = await executeNode({
      node: currentNode,
      variables,
      userText,
      phone_number,
      account_id,
      chat_id,
      session_id,
    });

    variables = result.variables ?? variables;

    if (!result.advance) {
      // Terminated nodes (end_flow, handoff_to_agent) already closed the session
      // Waiting nodes (wait_for_input, ai_agent) need state saved for next message
      const terminatedTypes = ["end_flow", "handoff_to_agent"];
      if (!terminatedTypes.includes(currentNode.node_type)) {
        await updateSession(session_id, currentNode.node_id, variables);
        console.log(
          `[Engine] Paused at node: ${currentNode.node_type} — waiting for next message`,
        );
      }
      return;
    }

    // Advance to next node
    const nextNode = getNextNode(
      currentNode.node_id,
      edges,
      nodeMap,
      result.conditionLabel || null,
    );

    if (!nextNode) {
      // No outgoing edges — flow is done
      console.log("✅ [Engine] Flow reached end (no more edges)");
      await endSession(session_id, chat_id);
      return;
    }

    currentNode = nextNode;
  }

  if (steps >= MAX_STEPS) {
    console.error(
      "❌ [Engine] MAX_STEPS reached — possible infinite loop in flow:",
      session.flow_id,
    );
    await endSession(session_id, chat_id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — Public API (called from whatsappController.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * matchKeywordTrigger
 * Scans all active flows for this account and checks if userText matches
 * a keyword_trigger node. Returns the flow_id if matched, null otherwise.
 */
export async function matchKeywordTrigger(userText, account_id) {
  try {
    if (!userText) return null;

    // Get all active flows for this account
    const { data: flows, error: flowErr } = await supabase
      .from("chatbot_flows")
      .select("flow_id")
      .eq("account_id", account_id)
      .eq("status", "active");

    if (flowErr || !flows?.length) return null;

    const flowIds = flows.map((f) => f.flow_id);

    // Get all keyword_trigger nodes across those flows
    const { data: triggerNodes, error: nodeErr } = await supabase
      .from("chatbot_nodes")
      .select("*")
      .in("flow_id", flowIds)
      .eq("node_type", "keyword_trigger");

    if (nodeErr || !triggerNodes?.length) return null;

    const normalizedText = userText.trim().toLowerCase();

    for (const node of triggerNodes) {
      const keywords = (node.config?.keywords || []).map((k) =>
        k.toLowerCase(),
      );
      const matchType = node.config?.match_type || "contains";

      const matched = keywords.some((kw) => {
        switch (matchType) {
          case "exact":
            return normalizedText === kw;
          case "starts_with":
            return normalizedText.startsWith(kw);
          case "contains":
          default:
            return normalizedText.includes(kw);
        }
      });

      if (matched) {
        console.log(`✅ [Engine] Keyword matched in flow: ${node.flow_id}`);
        return node.flow_id;
      }
    }

    return null;
  } catch (err) {
    console.error("❌ [Engine] matchKeywordTrigger error:", err.message);
    return null;
  }
}

/**
 * startBotSession
 * Creates a new session for this chat, sets chat mode to BOT,
 * and begins executing the flow from the trigger node.
 */
export async function startBotSession({
  chat_id,
  phone_number,
  flow_id,
  account_id,
  user_text,
}) {
  try {
    console.log("🚀 [Engine] Starting bot session:", { chat_id, flow_id });

    // Load the flow graph
    const { nodes, edges, nodeMap } = await loadFlowGraph(flow_id);

    // Find the trigger node (starting point)
    const triggerNode = nodes.find((n) => n.node_type === "keyword_trigger");
    if (!triggerNode) {
      console.error(
        "❌ [Engine] No keyword_trigger node found in flow:",
        flow_id,
      );
      return;
    }

    // Create a new session
    const { data: session, error: sessionErr } = await supabase
      .from("chatbot_sessions")
      .insert({
        flow_id,
        chat_id,
        current_node_id: triggerNode.node_id,
        variables: {},
        status: "active",
      })
      .select()
      .single();

    if (sessionErr || !session) {
      console.error("❌ [Engine] Failed to create session:", sessionErr);
      return;
    }

    // Set chat mode to BOT
    await supabase
      .from("chats")
      .update({ mode: "BOT", active_flow_id: flow_id })
      .eq("chat_id", chat_id);

    // Run the flow starting from the trigger node
    await runFlow({
      session,
      startNode: triggerNode,
      edges,
      nodeMap,
      userText: user_text,
      phone_number,
      account_id,
      chat_id,
    });
  } catch (err) {
    console.error("❌ [Engine] startBotSession error:", err.message);
  }
}

/**
 * handleBotMessage
 * Called when a chat is already in BOT mode and has an active session.
 * Continues execution from the current node.
 */
export async function handleBotMessage({
  chat_id,
  phone_number,
  user_text,
  account_id,
}) {
  try {
    console.log("🤖 [Engine] Handling bot message for chat:", chat_id);

    // Get the active session
    const session = await getActiveSession(chat_id);
    if (!session) {
      console.warn("⚠️ [Engine] No active session found for chat:", chat_id);
      // Reset chat mode since session is gone
      await supabase
        .from("chats")
        .update({ mode: "AI", active_flow_id: null })
        .eq("chat_id", chat_id);
      return;
    }

    // Load the flow graph
    const { edges, nodeMap } = await loadFlowGraph(session.flow_id);

    // Get the current node
    const currentNode = nodeMap[session.current_node_id];
    if (!currentNode) {
      console.error(
        "❌ [Engine] Current node not found:",
        session.current_node_id,
      );
      await endSession(session.session_id, chat_id);
      return;
    }

    // Continue the flow from the current node
    await runFlow({
      session,
      startNode: currentNode,
      edges,
      nodeMap,
      userText: user_text,
      phone_number,
      account_id,
      chat_id,
    });
  } catch (err) {
    console.error("❌ [Engine] handleBotMessage error:", err.message);
  }
}
