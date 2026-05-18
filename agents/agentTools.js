// agents/agentTools.js
// Place at: backend/agents/agentTools.js

import { v4 as uuidv4 } from "uuid";
import { supabase } from "../config/supabase.js";
import * as wsService from "../services/whatsappTemplateService.js";

// ─────────────────────────────────────────────
// TOOL DEFINITIONS  (sent to Anthropic API)
// ─────────────────────────────────────────────

export const CAMPAIGN_TOOLS = [
  {
    name: "list_groups",
    description:
      "Fetch all contact groups for the user. Use this to find a group by name or show the user their available groups.",
    input_schema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description:
            "Optional search string to filter groups by name (case-insensitive).",
        },
      },
      required: [],
    },
  },
  {
    name: "list_templates",
    description:
      "Fetch all approved WhatsApp message templates. Returns each template's body text, variable count, variable names, header_format (TEXT/IMAGE/VIDEO/DOCUMENT), and media_id. For media templates (IMAGE/VIDEO/DOCUMENT), Claude must check if media_id is present and not expired before creating a campaign.",
    input_schema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description:
            "Optional search string to filter templates by name (case-insensitive).",
        },
      },
      required: [],
    },
  },
  {
    name: "create_template",
    description:
      "Create a new WhatsApp message template (text only, no media) and submit it to Meta for approval. Only call this AFTER showing the user a full preview and receiving explicit confirmation.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Template name — lowercase letters, numbers, and underscores only. No spaces. Example: 'order_confirmation'.",
        },
        category: {
          type: "string",
          enum: ["MARKETING", "UTILITY", "AUTHENTICATION"],
          description:
            "MARKETING for promotions/offers, UTILITY for transactional/order updates, AUTHENTICATION for OTPs.",
        },
        language: {
          type: "string",
          description:
            "Language code. Examples: 'en_US' (English), 'hi' (Hindi). Default: 'en_US'.",
        },
        body_text: {
          type: "string",
          description:
            "Main message body. Use {{1}}, {{2}}, etc. for dynamic variables. Example: 'Hi {{1}}, your order {{2}} is confirmed.'",
        },
        header_format: {
          type: "string",
          enum: ["TEXT", "IMAGE", "VIDEO", "DOCUMENT"],
          description:
            "Header type. Use TEXT for a plain text header (provide header_text). Use IMAGE, VIDEO, or DOCUMENT only when the user has already uploaded a media file — its handle is provided in the conversation context.",
        },
        header_text: {
          type: "string",
          description:
            "Text header content. Only used when header_format is TEXT. Plain text, no variables.",
        },
        header_handle: {
          type: "string",
          description:
            "The Meta media handle (starts with 'h:') for IMAGE/VIDEO/DOCUMENT headers. Use the exact value from the media_attachment context in the conversation. Never guess or construct this value.",
        },
        media_id: {
          type: "string",
          description:
            "The Meta media_id returned alongside header_handle in the media_attachment context. Pass it here so it is saved in the template record.",
        },
        footer_text: {
          type: "string",
          description:
            "Optional footer text shown below the body. Example: 'Reply STOP to unsubscribe.'",
        },
        body_examples: {
          type: "array",
          items: { type: "string" },
          description:
            "Example values for body variables in order. Required by Meta if body_text contains {{1}}, {{2}}, etc. Example: ['John', 'ORD-1234'].",
        },
        buttons: {
          type: "array",
          description:
            "Optional buttons to attach to the template. Max 3 buttons total. Each button is an object with a 'type' field.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["QUICK_REPLY", "URL", "PHONE_NUMBER"],
                description:
                  "QUICK_REPLY: a simple reply button. URL: opens a webpage. PHONE_NUMBER: calls a number.",
              },
              text: {
                type: "string",
                description:
                  "Button label shown to the user. Max 25 characters.",
              },
              url: {
                type: "string",
                description:
                  "Required for URL buttons. The link to open. Can end with {{1}} for a dynamic part. Example: 'https://example.com/order/{{1}}'.",
              },
              url_example: {
                type: "string",
                description:
                  "Required by Meta when the URL contains {{1}}. A full example URL. Example: 'https://example.com/order/ORD-1234'.",
              },
              phone_number: {
                type: "string",
                description:
                  "Required for PHONE_NUMBER buttons. Must include country code. Example: '+911234567890'.",
              },
            },
            required: ["type", "text"],
          },
        },
      },
      required: ["name", "category", "language", "body_text"],
    },
  },
  {
    name: "create_campaign",
    description:
      "Create and schedule a WhatsApp campaign. IMPORTANT: Only call this AFTER (1) collecting all required template variable values from the user if the template has variables, (2) confirming media is available if it is a media template, (3) showing the full summary, and (4) the user has explicitly confirmed. Never call without confirmation.",
    input_schema: {
      type: "object",
      properties: {
        campaign_name: {
          type: "string",
          description: "Name for the campaign.",
        },
        group_id: {
          type: "string",
          description:
            "The group_id UUID copied exactly from list_groups tool result. Never construct or guess this value.",
        },
        template_id: {
          type: "string",
          description:
            "The wt_id UUID copied exactly from list_templates tool result. Never use the template name here — always use the wt_id UUID.",
        },
        scheduled_at: {
          type: "string",
          description:
            "ISO 8601 datetime string. If user says 'now' use current timestamp. If only time given assume today, if past assume tomorrow.",
        },
        total_recipients: {
          type: "number",
          description: "Contact count from list_groups result.",
        },
        template_variables: {
          type: "object",
          description:
            'Variable values for the template. If template has variables like {{1}}, {{2}}, {{3}}, this must be {"1": "value1", "2": "value2", "3": "value3"}. If template has no variables, pass {}.',
        },
        media_id: {
          type: "string",
          description:
            "The media_id for media templates (IMAGE/VIDEO/DOCUMENT). Copy exactly from list_templates result. Only include if the template has a media header. Omit for text templates.",
        },
      },
      required: [
        "campaign_name",
        "group_id",
        "template_id",
        "scheduled_at",
        "total_recipients",
        "template_variables",
      ],
    },
  },
];

// ─────────────────────────────────────────────
// TOOL EXECUTOR
// ─────────────────────────────────────────────

export async function executeTool(toolName, toolInput, userId) {
  switch (toolName) {
    case "list_groups":
      return await listGroups(userId, toolInput.search);
    case "list_templates":
      return await listTemplates(userId, toolInput.search);
    case "create_campaign":
      return await createCampaign(userId, toolInput);
    case "create_template":
      return await createTemplateTool(userId, toolInput);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ─────────────────────────────────────────────
// HELPER: get user's active WhatsApp account_id
// ─────────────────────────────────────────────

async function getAccountId(userId) {
  const { data, error } = await supabase
    .from("whatsapp_accounts")
    .select("wa_id")
    .eq("user_id", userId)
    .eq("status", "active")
    .single();

  if (error || !data) return null;
  return data.wa_id;
}

// ─────────────────────────────────────────────
// HELPER: extract variable info from template
// Returns: { count: N, variables: ["1","2","3"], labels: {"1":"Name","2":"Order"} }
// ─────────────────────────────────────────────

function extractTemplateVariables(components, variablesCol) {
  const bodyText = (() => {
    if (!Array.isArray(components)) return "";
    const body = components.find((c) => c.type === "BODY");
    return body?.text || "";
  })();

  // Find all {{N}} placeholders in body
  const matches = bodyText.match(/\{\{(\d+)\}\}/g) || [];
  const variableNumbers = [
    ...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, ""))),
  ].sort((a, b) => Number(a) - Number(b));

  // Try to get human-readable labels from the `variables` column
  let labels = {};
  if (variablesCol && typeof variablesCol === "object") {
    if (Array.isArray(variablesCol)) {
      variablesCol.forEach((item) => {
        Object.assign(labels, item);
      });
    } else {
      labels = variablesCol;
    }
  }

  return {
    count: variableNumbers.length,
    variable_numbers: variableNumbers,
    labels,
    body_text: bodyText,
  };
}

// ─────────────────────────────────────────────
// HELPER: check if a media_id is still valid
// Meta media expires after 25 days.
// We check the whatsapp_media_uploads table by media_id
// and return { valid: bool, uploaded_at, days_old }
// ─────────────────────────────────────────────

async function checkMediaValidity(accountId, mediaId) {
  if (!mediaId) return { valid: false, reason: "no_media_id" };

  const { data, error } = await supabase
    .from("whatsapp_media_uploads")
    .select("media_id, uploaded_at, file_name, type")
    .eq("account_id", accountId)
    .eq("media_id", mediaId)
    .order("uploaded_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return { valid: false, reason: "not_found" };

  const uploadedAt = new Date(data.uploaded_at);
  const now = new Date();
  const daysOld = Math.floor((now - uploadedAt) / (1000 * 60 * 60 * 24));

  // Meta expires media after 25 days
  if (daysOld >= 25) {
    return {
      valid: false,
      reason: "expired",
      days_old: daysOld,
      file_name: data.file_name,
      type: data.type,
    };
  }

  return {
    valid: true,
    media_id: data.media_id,
    days_old: daysOld,
    days_remaining: 25 - daysOld,
    file_name: data.file_name,
    type: data.type,
  };
}

// ─────────────────────────────────────────────
// list_groups
// ─────────────────────────────────────────────

async function listGroups(userId, search) {
  try {
    const { data, error } = await supabase
      .from("groups")
      .select(
        "group_id, group_name, description, created_at, group_contacts(count)",
      )
      .eq("user_id", userId)
      .order("group_name", { ascending: true });

    if (error) return { error: error.message };

    let groups = data || [];

    if (search) {
      const q = search.toLowerCase();
      groups = groups.filter((g) => g.group_name?.toLowerCase().includes(q));
    }

    if (groups.length === 0) {
      return {
        groups: [],
        message: search
          ? `No groups found matching "${search}".`
          : "No groups found. Please create a group first.",
      };
    }

    return {
      groups: groups.map((g) => ({
        group_id: g.group_id,
        group_name: g.group_name,
        description: g.description || "",
        contact_count: Number(g.group_contacts?.[0]?.count ?? 0),
      })),
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ─────────────────────────────────────────────
// list_templates
// Returns: variables_count + variable_numbers + labels
// + header_format + media_id + media_validity
// ─────────────────────────────────────────────

async function listTemplates(userId, search) {
  try {
    const accountId = await getAccountId(userId);
    if (!accountId) {
      return { error: "No active WhatsApp account found." };
    }

    const { data, error } = await supabase
      .from("whatsapp_templates")
      .select(
        "wt_id, name, category, language, status, components, variables, header_format, media_id, header_handle",
      )
      .eq("account_id", accountId)
      .eq("status", "APPROVED")
      .order("name", { ascending: true });

    if (error) return { error: error.message };

    let templates = data || [];

    if (search) {
      const q = search.toLowerCase();
      templates = templates.filter((t) => t.name?.toLowerCase().includes(q));
    }

    if (templates.length === 0) {
      return {
        templates: [],
        message: search
          ? `No approved templates found matching "${search}".`
          : "No approved templates found.",
      };
    }

    // For media templates, check validity in parallel
    const templateResults = await Promise.all(
      templates.map(async (t) => {
        const varInfo = extractTemplateVariables(t.components, t.variables);
        const isMediaTemplate = ["IMAGE", "VIDEO", "DOCUMENT"].includes(
          t.header_format,
        );

        let mediaStatus = null;
        if (isMediaTemplate) {
          mediaStatus = await checkMediaValidity(accountId, t.media_id);
        }

        return {
          wt_id: t.wt_id,
          name: t.name,
          category: t.category,
          language: t.language,
          header_format: t.header_format || "TEXT",
          is_media_template: isMediaTemplate,
          // For media templates: the stored media_id (may be null or expired)
          media_id: t.media_id || null,
          // Validity info so Claude knows whether to proceed or redirect
          media_status: mediaStatus,
          body_text: varInfo.body_text,
          variables_count: varInfo.count,
          variable_numbers: varInfo.variable_numbers,
          variable_labels: varInfo.labels,
        };
      }),
    );

    return { templates: templateResults };
  } catch (err) {
    return { error: err.message };
  }
}

// ─────────────────────────────────────────────
// create_campaign
// ─────────────────────────────────────────────

async function createCampaign(userId, input) {
  try {
    const {
      campaign_name,
      group_id,
      template_id,
      scheduled_at,
      total_recipients,
      template_variables = {},
      media_id = null,
    } = input;

    const accountId = await getAccountId(userId);
    if (!accountId) {
      return { error: "No active WhatsApp account found." };
    }

    // Validate group belongs to this user
    const { data: group, error: groupErr } = await supabase
      .from("groups")
      .select("group_id, group_name, group_contacts(count)")
      .eq("group_id", group_id)
      .eq("user_id", userId)
      .single();

    if (groupErr || !group) {
      return { error: "Group not found or access denied." };
    }

    // Validate template belongs to this account and is approved
    const { data: template, error: templateErr } = await supabase
      .from("whatsapp_templates")
      .select(
        "wt_id, name, status, components, variables, header_format, media_id",
      )
      .eq("wt_id", template_id)
      .eq("account_id", accountId)
      .single();

    if (templateErr || !template) {
      return { error: "Template not found or access denied." };
    }

    if (template.status !== "APPROVED") {
      return {
        error: `Template "${template.name}" is not approved (status: ${template.status}).`,
      };
    }

    // ── Media template validation ─────────────────────────────────────────
    const isMediaTemplate = ["IMAGE", "VIDEO", "DOCUMENT"].includes(
      template.header_format,
    );

    if (isMediaTemplate) {
      // Use the media_id passed in (from the user's confirmed selection)
      // or fall back to what's stored on the template
      const effectiveMediaId = media_id || template.media_id;

      if (!effectiveMediaId) {
        return {
          error: `MEDIA_REQUIRED: Template "${template.name}" is a ${template.header_format} template and requires a media file. Please go to the Templates page to upload media for this template, then come back to create the campaign.`,
          requires_media_upload: true,
          template_name: template.name,
          header_format: template.header_format,
        };
      }

      // Validate the media hasn't expired
      const mediaValidity = await checkMediaValidity(
        accountId,
        effectiveMediaId,
      );
      if (!mediaValidity.valid) {
        return {
          error: `MEDIA_EXPIRED: The ${template.header_format} media for template "${template.name}" has ${mediaValidity.reason === "expired" ? `expired (uploaded ${mediaValidity.days_old} days ago — Meta expires media after 25 days)` : "not been found"}. Please go to the Templates page to upload fresh media, then come back to create the campaign.`,
          requires_media_upload: true,
          template_name: template.name,
          header_format: template.header_format,
          media_reason: mediaValidity.reason,
        };
      }

      // All good — store the resolved media_id back for campaign use
      input.media_id = effectiveMediaId;
    }

    // Validate that all required variables have been provided
    const varInfo = extractTemplateVariables(
      template.components,
      template.variables,
    );
    if (varInfo.count > 0) {
      const missingVars = varInfo.variable_numbers.filter(
        (num) =>
          !template_variables[num] ||
          String(template_variables[num]).trim() === "",
      );
      if (missingVars.length > 0) {
        return {
          error: `Template "${template.name}" requires ${varInfo.count} variable(s). Missing values for: {{${missingVars.join("}}, {{")}}}. Please provide values for all variables.`,
        };
      }
    }

    const dbContactCount = Number(group.group_contacts?.[0]?.count ?? 0);
    const finalRecipients = dbContactCount || total_recipients || 0;

    // ── Parse and validate scheduled_at ──────────────────────────────────────
    // Claude should always send ISO 8601, but guard against natural-language
    // strings like "Today at 2:50 PM" which produce Invalid Date.
    const parsedDate = new Date(scheduled_at);
    if (isNaN(parsedDate.getTime())) {
      return {
        error: `Invalid scheduled time: "${scheduled_at}". Please provide an ISO 8601 datetime string (e.g. "2026-05-16T14:50:00.000Z"). Do not pass natural-language strings like "Today at 2:50 PM".`,
      };
    }
    const scheduledAtIso = parsedDate.toISOString();

    // Insert campaign
    const { data: campaign, error: insertErr } = await supabase
      .from("campaigns")
      .insert({
        user_id: userId,
        account_id: accountId,
        campaign_name,
        group_id,
        wt_id: template_id,
        scheduled_at: scheduledAtIso,
        status: "scheduled",
        total_recipients: finalRecipients,
        timezone: "UTC",
        template_variables,
        // Store the resolved media_id on the campaign so the sender can use it
        media_id: isMediaTemplate ? input.media_id || null : null,
      })
      .select()
      .single();

    if (insertErr) return { error: insertErr.message };

    // Fetch all contacts in this group
    const { data: contacts, error: contactsErr } = await supabase
      .from("group_contacts")
      .select("contact_id, phone_number, full_name")
      .eq("group_id", group_id)
      .eq("user_id", userId);

    if (contactsErr) {
      await supabase
        .from("campaigns")
        .delete()
        .eq("campaign_id", campaign.campaign_id);
      return {
        error: `Campaign creation failed: could not fetch contacts. ${contactsErr.message}`,
      };
    }

    if (!contacts || contacts.length === 0) {
      await supabase
        .from("campaigns")
        .delete()
        .eq("campaign_id", campaign.campaign_id);
      return {
        error:
          "This group has no contacts. Please add contacts before creating a campaign.",
      };
    }

    // Bulk-insert campaign_messages — one row per contact
    const campaignMessages = contacts.map((c) => ({
      campaign_id: campaign.campaign_id,
      contact_id: c.contact_id,
      phone_number: c.phone_number,
      contact_name: c.full_name || null,
      status: "pending",
    }));

    const { error: msgInsertErr } = await supabase
      .from("campaign_messages")
      .insert(campaignMessages);

    if (msgInsertErr) {
      await supabase
        .from("campaigns")
        .delete()
        .eq("campaign_id", campaign.campaign_id);
      return {
        error: `Campaign creation failed: could not queue messages. ${msgInsertErr.message}`,
      };
    }

    return {
      success: true,
      campaign_id: campaign.campaign_id,
      campaign_name: campaign.campaign_name,
      group_name: group.group_name,
      template_name: template.name,
      scheduled_at: campaign.scheduled_at,
      total_recipients: contacts.length,
      template_variables,
      media_id: isMediaTemplate ? input.media_id : null,
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ─────────────────────────────────────────────
// create_template
// ─────────────────────────────────────────────

async function createTemplateTool(userId, input) {
  try {
    const {
      name,
      category,
      language = "en_US",
      body_text,
      header_format,
      header_text,
      header_handle,
      media_id,
      footer_text,
      body_examples = [],
      buttons = [],
    } = input;

    // Normalize: lowercase, spaces → underscores, strip invalid chars
    const normalizedName = name
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "");

    if (!normalizedName) {
      return {
        error:
          "Template name is invalid. Use letters, numbers, and underscores only.",
      };
    }

    const accountId = await getAccountId(userId);
    if (!accountId) {
      return {
        error:
          "No active WhatsApp account found. Please connect your WhatsApp account first.",
      };
    }

    // Fetch full account row — need waba_id + system_user_access_token for Meta API
    const { data: account, error: acctErr } = await supabase
      .from("whatsapp_accounts")
      .select("wa_id, waba_id, system_user_access_token")
      .eq("wa_id", accountId)
      .single();

    if (acctErr || !account?.system_user_access_token || !account?.waba_id) {
      return {
        error:
          "WhatsApp account is not fully configured (missing waba_id or access token).",
      };
    }

    // Check for duplicate name
    const { data: existing } = await supabase
      .from("whatsapp_templates")
      .select("wt_id")
      .eq("account_id", accountId)
      .eq("name", normalizedName)
      .limit(1)
      .single();

    if (existing) {
      return {
        error: `A template named "${normalizedName}" already exists. Please choose a different name.`,
      };
    }

    // Build Meta components array
    const components = [];

    if (header_format && ["IMAGE", "VIDEO", "DOCUMENT"].includes(header_format) && header_handle) {
      // Media header — use the h: handle from the upload session
      components.push({
        type: "HEADER",
        format: header_format,
        example: { header_handle: [header_handle] },
      });
    } else if (header_text?.trim()) {
      // Text header
      components.push({ type: "HEADER", format: "TEXT", text: header_text.trim() });
    }

    const variableMatches = body_text.match(/\{\{\d+\}\}/g) || [];
    const bodyComponent = { type: "BODY", text: body_text };
    if (variableMatches.length > 0 && body_examples.length > 0) {
      bodyComponent.example = { body_text: [body_examples] };
    }
    components.push(bodyComponent);

    if (footer_text?.trim()) {
      components.push({ type: "FOOTER", text: footer_text.trim() });
    }

    if (buttons.length > 0) {
      const builtButtons = buttons.map((btn) => {
        if (btn.type === "QUICK_REPLY") {
          return { type: "QUICK_REPLY", text: btn.text };
        }
        if (btn.type === "PHONE_NUMBER") {
          return {
            type: "PHONE_NUMBER",
            text: btn.text,
            phone_number: btn.phone_number,
          };
        }
        if (btn.type === "URL") {
          const urlBtn = { type: "URL", text: btn.text, url: btn.url };
          if (btn.url?.includes("{{1}}") && btn.url_example) {
            urlBtn.example = [btn.url_example];
          }
          return urlBtn;
        }
        return btn;
      });
      components.push({ type: "BUTTONS", buttons: builtButtons });
    }

    // Submit to Meta with retry
    let metaResp;
    let attempts = 0;
    while (attempts < 3) {
      try {
        attempts++;
        metaResp = await wsService.createTemplateOnMeta(
          account.waba_id,
          account.system_user_access_token,
          {
            name: normalizedName,
            language,
            category,
            parameter_format: "positional",
            components,
          },
        );
        break;
      } catch (retryErr) {
        if (attempts >= 3) {
          const metaError =
            retryErr.response?.data?.error?.message || retryErr.message;
          return { error: `Meta rejected the template: ${metaError}` };
        }
        await new Promise((r) => setTimeout(r, 2000 * attempts));
      }
    }

    // Fetch preview from Meta (best-effort)
    let preview = {};
    try {
      const listed = await wsService.listTemplatesFromMeta(
        account.waba_id,
        account.system_user_access_token,
      );
      const all = listed.data || listed || [];
      preview =
        (metaResp?.id ? all.find((t) => t.id === metaResp.id) : null) ||
        all.find((t) => t.name === normalizedName) ||
        {};
    } catch {
      // preview stays {}
    }

    // Insert into DB
    const wt_id = uuidv4();
    const insert = {
      wt_id,
      account_id: accountId,
      template_id: metaResp.id || null,
      name: normalizedName,
      language,
      category,
      parameter_format: "positional",
      components,
      header_format: ["IMAGE", "VIDEO", "DOCUMENT"].includes(header_format)
        ? header_format
        : header_text?.trim()
        ? "TEXT"
        : null,
      header_handle: header_handle || null,
      variables: body_examples,
      buttons: buttons.length > 0 ? buttons : [],
      preview,
      status: preview?.status || metaResp.status || "PENDING",
      media_id: media_id || null,
    };

    const { error: insertErr } = await supabase
      .from("whatsapp_templates")
      .insert(insert);

    if (insertErr) return { error: insertErr.message };

    return {
      success: true,
      wt_id,
      name: normalizedName,
      category,
      language,
      status: insert.status,
      message:
        insert.status === "APPROVED"
          ? "Template created and approved by Meta."
          : "Template submitted to Meta for approval. It usually takes a few minutes to a few hours.",
    };
  } catch (err) {
    return { error: err.message };
  }
}
