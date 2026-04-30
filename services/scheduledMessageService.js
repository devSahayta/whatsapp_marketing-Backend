// services/scheduledMessageService.js
// Reusable service for creating scheduled WhatsApp template messages.
// Used by the public API (/v1/messages/schedule) and can be called
// internally by any other part of the system.

import { supabase } from "../config/supabase.js";
import { getWhatsappAccount } from "./waAccountService.js";

const MEDIA_HEADER_FORMATS = ["IMAGE", "VIDEO", "DOCUMENT"];

/**
 * Parse the components array from a template row.
 * Handles both JSON string and parsed object.
 */
function parseComponents(raw) {
  if (!raw) return [];
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw : [];
}

/**
 * Count {{N}} placeholders in a template's BODY component.
 * Returns the highest index found (= number of required variables).
 */
function countRequiredVariables(components) {
  const body = components.find((c) => c.type === "BODY");
  if (!body?.text) return 0;
  const matches = body.text.match(/\{\{\d+\}\}/g) ?? [];
  if (!matches.length) return 0;
  const indices = matches.map((m) => parseInt(m.replace(/\D/g, ""), 10));
  return Math.max(...indices); // e.g. {{1}} {{2}} → 2
}

/**
 * Validate template requirements against the provided data, then
 * insert a row into scheduled_messages.
 *
 * @param {object} params
 * @param {string}  params.user_id
 * @param {string}  params.account_id        — wa_id of the WhatsApp account
 * @param {string}  params.phone_number       — E.164 format e.g. "919876543210"
 * @param {string}  [params.contact_name]
 * @param {string}  params.wt_id             — whatsapp_templates primary key
 * @param {object}  [params.template_variables] — { "1": "Rahul", "2": "Order #123" }
 * @param {string}  [params.media_id]        — Meta media ID (overrides template's stored one)
 * @param {string}  params.scheduled_at      — ISO 8601 datetime string (future)
 * @param {string}  [params.timezone]        — e.g. "Asia/Kolkata" (default UTC)
 *
 * @returns {{ success: boolean, data?: object, error?: string, code?: string }}
 */
export async function createScheduledMessage({
  user_id,
  account_id,
  phone_number,
  contact_name = null,
  wt_id,
  template_variables = {},
  media_id = null,
  scheduled_at,
  timezone = "UTC",
}) {
  // // checking whaatapp account existence and status is handled in the API route before calling this service.
  // const account = await getWhatsappAccount(user_id);
  // if (!account)
  //   return {
  //     success: false,
  //     error: "WhatsApp account not found",
  //     code: "ACCOUNT_NOT_FOUND",
  //   };

  // ── 1. Resolve the template ────────────────────────────────────────────────
  const { data: template, error: tplErr } = await supabase
    .from("whatsapp_templates")
    .select(
      "wt_id, name, status, header_format, media_id, components, variables",
    )
    .eq("wt_id", wt_id)
    .eq("account_id", account_id)
    .maybeSingle();

  if (tplErr || !template) {
    return {
      success: false,
      error: "Template not found for this account.",
      code: "TEMPLATE_NOT_FOUND",
    };
  }

  if (template.status?.toUpperCase() !== "APPROVED") {
    return {
      success: false,
      error: `Template is not approved (current status: ${template.status}). Only APPROVED templates can be scheduled.`,
      code: "TEMPLATE_NOT_APPROVED",
    };
  }

  // ── 2. Validate scheduled_at is in the future ──────────────────────────────
  const scheduledDate = new Date(scheduled_at);
  if (isNaN(scheduledDate.getTime())) {
    return {
      success: false,
      error: "Invalid scheduled_at datetime. Use ISO 8601 format.",
      code: "INVALID_SCHEDULED_AT",
    };
  }
  if (scheduledDate <= new Date()) {
    return {
      success: false,
      error: "scheduled_at must be a future datetime.",
      code: "SCHEDULED_AT_IN_PAST",
    };
  }

  // ── 3. Validate media requirement ──────────────────────────────────────────
  const components = parseComponents(template.components);
  const headerComp = components.find((c) => c.type === "HEADER");
  const headerFormat = headerComp?.format?.toUpperCase();
  const requiresMedia = MEDIA_HEADER_FORMATS.includes(headerFormat);

  // Effective media_id: caller-supplied > template's stored media_id
  const effectiveMediaId = media_id || template.media_id || null;

  if (requiresMedia && !effectiveMediaId) {
    return {
      success: false,
      error: `This template requires a ${headerFormat} media file. Provide media_id in the request.`,
      code: "MEDIA_REQUIRED",
      required_media_type: headerFormat.toLowerCase(),
    };
  }

  // ── 4. Validate template variables ────────────────────────────────────────
  const requiredVarCount = countRequiredVariables(components);

  if (requiredVarCount > 0) {
    const providedKeys = Object.keys(template_variables ?? {});

    // Check all indices 1..requiredVarCount are present
    const missingIndices = [];
    for (let i = 1; i <= requiredVarCount; i++) {
      if (!template_variables?.[String(i)] && !template_variables?.[i]) {
        missingIndices.push(i);
      }
    }

    if (missingIndices.length > 0) {
      return {
        success: false,
        error: `Template requires ${requiredVarCount} variable(s). Missing: ${missingIndices.map((i) => `{{${i}}}`).join(", ")}.`,
        code: "MISSING_TEMPLATE_VARIABLES",
        required_count: requiredVarCount,
        missing_indices: missingIndices,
        hint: `Provide template_variables as { "1": "value1", "2": "value2", ... }`,
      };
    }
  }

  // ── 5. Insert into scheduled_messages ─────────────────────────────────────
  const { data: inserted, error: insertErr } = await supabase
    .from("scheduled_messages")
    .insert({
      user_id,
      account_id,
      phone_number,
      contact_name,
      wt_id,
      template_variables: template_variables ?? {},
      media_id: effectiveMediaId,
      scheduled_at: scheduledDate.toISOString(),
      timezone,
      status: "scheduled",
    })
    .select()
    .single();

  if (insertErr) {
    console.error("createScheduledMessage insert error:", insertErr);
    return {
      success: false,
      error: "Failed to save scheduled message.",
      code: "DB_INSERT_ERROR",
    };
  }

  return { success: true, data: inserted };
}
