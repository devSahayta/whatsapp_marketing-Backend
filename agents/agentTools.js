// agents/agentTools.js
// Place at: backend/agents/agentTools.js

import { supabase } from "../config/supabase.js";

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
      "Fetch all approved WhatsApp message templates. Returns each template's body text, variable count, and variable names so Claude knows if the template needs variable values before creating a campaign.",
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
    name: "create_campaign",
    description:
      "Create and schedule a WhatsApp campaign. IMPORTANT: Only call this AFTER (1) collecting all required template variable values from the user if the template has variables, (2) showing the full summary, and (3) the user has explicitly confirmed. Never call without confirmation.",
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
  // This column is jsonb and may contain example values or labels
  let labels = {};
  if (variablesCol && typeof variablesCol === "object") {
    // Handle array format: [{ "1": "CustomerName" }, ...]
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
    variable_numbers: variableNumbers, // e.g. ["1","2","3"]
    labels, // e.g. {"1":"Customer Name","2":"Order ID"}
    body_text: bodyText,
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
// Now returns: variables_count + variable_numbers + labels
// so Claude knows whether to collect values
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
        "wt_id, name, category, language, status, components, variables, header_format",
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

    return {
      templates: templates.map((t) => {
        const varInfo = extractTemplateVariables(t.components, t.variables);
        return {
          wt_id: t.wt_id,
          name: t.name,
          category: t.category,
          language: t.language,
          header_format: t.header_format || "TEXT", // TEXT, IMAGE, VIDEO, DOCUMENT
          body_text: varInfo.body_text,
          variables_count: varInfo.count,
          // e.g. ["1","2","3"] — Claude uses this to know which values to ask for
          variable_numbers: varInfo.variable_numbers,
          // e.g. {"1":"Customer Name"} — hints for what to ask the user
          variable_labels: varInfo.labels,
        };
      }),
    };
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
    // IMPORTANT: match on wt_id (UUID) only, never on name
    const { data: template, error: templateErr } = await supabase
      .from("whatsapp_templates")
      .select("wt_id, name, status, components, variables")
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

    // Insert campaign with template_variables populated
    const { data: campaign, error: insertErr } = await supabase
      .from("campaigns")
      .insert({
        user_id: userId,
        account_id: accountId,
        campaign_name,
        group_id,
        wt_id: template_id,
        scheduled_at: new Date(scheduled_at).toISOString(),
        status: "scheduled",
        total_recipients: finalRecipients,
        timezone: "UTC",
        template_variables: template_variables, // ← now populated correctly
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
    };
  } catch (err) {
    return { error: err.message };
  }
}
