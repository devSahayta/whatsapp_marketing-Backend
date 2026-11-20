// controllers/customPricingController.js
import { supabase } from "../config/supabase.js";
import { sendMail, getSalesEmail } from "../services/mailerService.js";

const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const LOGO_URL = "https://samvaadik.com/images/logo-samvaadik.png";
const SITE_URL = process.env.FRONTEND_URL || "https://samvaadik.com";

// ─── Shared branded shell (same header/card/footer structure as the daily
// digest email, recolored to the emerald/teal used across the pricing page)
const buildEmailShell = ({ eyebrow, heading, bodyHtml, footerNote }) =>
  `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>${heading}</title>
</head>
<body style="margin:0;padding:0;background:#f6f6fa;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6fa;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:#ffffff;border-radius:16px 16px 0 0;padding:28px 32px 20px;text-align:center;border-bottom:1px solid #f0f0f7;">
              <img src="${LOGO_URL}" alt="Samvaadik" width="150" style="display:block;margin:0 auto 10px;height:auto;max-width:150px;"/>
              <p style="margin:0;color:#9ca3af;font-size:13px;">${eyebrow}</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:#ffffff;padding:28px 32px;border-left:1px solid #e4e4eb;border-right:1px solid #e4e4eb;">
              <h1 style="margin:0 0 18px;font-size:19px;font-weight:700;color:#0f1117;letter-spacing:-0.02em;">
                ${heading}
              </h1>
              ${bodyHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f5fbf8;border:1px solid #e4e4eb;border-top:none;border-radius:0 0 16px 16px;padding:20px 32px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#6ee7c7;">
                ${footerNote}
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim();

// A labeled "field row" used inside the details table in both emails.
const fieldRow = (label, value, { link } = {}) => {
  if (!value) return "";
  const valueHtml = link
    ? `<a href="${link}" style="color:#059669;text-decoration:none;font-weight:600;">${value}</a>`
    : `<span style="color:#1a1523;font-weight:600;">${value}</span>`;

  return `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #f0f0f5;font-size:12px;color:#6b7280;font-weight:600;letter-spacing:0.03em;text-transform:uppercase;white-space:nowrap;vertical-align:top;">
        ${label}
      </td>
      <td style="padding:10px 14px;border-bottom:1px solid #f0f0f5;font-size:13.5px;">
        ${valueHtml}
      </td>
    </tr>`;
};

const detailsTable = (rowsHtml) => `
  <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e4eb;border-radius:10px;overflow:hidden;margin:0 0 24px;border-collapse:collapse;">
    <tbody>${rowsHtml}</tbody>
  </table>`;

const ctaButton = (href, label) => `
  <div style="text-align:center;margin:4px 0 8px;">
    <a href="${href}" style="display:inline-block;background:#111827;color:#ffffff;font-size:14px;font-weight:700;padding:13px 32px;border-radius:9999px;text-decoration:none;letter-spacing:-0.01em;">
      ${label}
    </a>
  </div>`;

// ─── Sales/admin notification ─────────────────────────────────────────────
const buildSalesEmailHtml = ({
  fullName,
  workEmail,
  companyName,
  phone,
  teamSize,
  message,
  leadId,
  submittedAt,
}) => {
  const rows = [
    fieldRow("Name", fullName),
    fieldRow("Work email", workEmail, { link: `mailto:${workEmail}` }),
    fieldRow("Company", companyName),
    fieldRow("Phone", phone),
    fieldRow("Team size", teamSize),
  ]
    .filter(Boolean)
    .join("");

  const requirementsHtml = message
    ? `
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#0f1117;">What they're looking for</p>
      <div style="background:#f5fbf8;border:1px solid #d1fae5;border-radius:10px;padding:14px 16px;margin:0 0 24px;font-size:13.5px;color:#374151;line-height:1.6;white-space:pre-wrap;">
        ${message.replace(/\n/g, "<br/>")}
      </div>`
    : "";

  const bodyHtml = `
    <p style="margin:0 0 20px;font-size:14.5px;color:#374151;">
      A visitor just submitted the Custom Pricing form on the pricing page. Here are the details:
    </p>
    ${detailsTable(rows)}
    ${requirementsHtml}
    ${ctaButton(`mailto:${workEmail}`, `Reply to ${fullName.split(" ")[0]} →`)}
    <p style="margin:24px 0 0;font-size:11.5px;color:#9ca3af;text-align:center;">
      Lead ID: ${leadId} · Submitted ${submittedAt}
    </p>`;

  return buildEmailShell({
    eyebrow: "New lead — Custom Pricing form",
    heading: `New Custom Pricing request from ${fullName}`,
    bodyHtml,
    footerNote: "Samvaadik internal notification · pricing page lead capture",
  });
};

// ─── Confirmation sent to the person who filled the form ──────────────────
const buildUserEmailHtml = ({ fullName, companyName, teamSize, message }) => {
  const firstName = fullName.split(" ")[0];

  const rows = [
    fieldRow("Company", companyName),
    fieldRow("Team size", teamSize),
  ]
    .filter(Boolean)
    .join("");

  const requirementsHtml = message
    ? `
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#0f1117;">What you told us</p>
      <div style="background:#f5fbf8;border:1px solid #d1fae5;border-radius:10px;padding:14px 16px;margin:0 0 24px;font-size:13.5px;color:#374151;line-height:1.6;white-space:pre-wrap;">
        ${message.replace(/\n/g, "<br/>")}
      </div>`
    : "";

  const bodyHtml = `
    <p style="margin:0 0 20px;font-size:14.5px;color:#374151;">
      Hi ${firstName} 👋<br/>
      Thanks for your interest in Samvaadik's custom plan. Our team has received your request and
      will get back to you shortly at this email address.
    </p>
    ${rows ? detailsTable(rows) : ""}
    ${requirementsHtml}
    ${ctaButton(SITE_URL, "Explore Samvaadik →")}
    <p style="margin:24px 0 0;font-size:13px;color:#6b7280;text-align:center;">
      — The Samvaadik Team
    </p>`;

  return buildEmailShell({
    eyebrow: "Custom Pricing request received",
    heading: "We've got your request!",
    bodyHtml,
    footerNote:
      "You're receiving this because you submitted the Custom Pricing form on samvaadik.com.",
  });
};

export const submitCustomPricingRequest = async (req, res) => {
  try {
    const {
      userId = null,
      fullName,
      workEmail,
      companyName,
      phone,
      teamSize,
      message,
    } = req.body || {};

    if (!fullName || !workEmail) {
      return res
        .status(400)
        .json({ message: "fullName and workEmail are required" });
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(workEmail)) {
      return res.status(400).json({ message: "Enter a valid work email" });
    }

    const { data: lead, error } = await supabase
      .from("custom_pricing_leads")
      .insert({
        user_id: userId,
        full_name: fullName,
        work_email: workEmail,
        company_name: companyName || null,
        phone: phone || null,
        team_size: teamSize || null,
        message: message || null,
      })
      .select()
      .single();

    if (error) throw error;

    // Email sending is best-effort: the lead is already saved above, so a
    // mail outage never loses the request — it just logs a warning.
    const safeName = escapeHtml(fullName);
    const safeCompany = companyName ? escapeHtml(companyName) : null;
    const safeTeamSize = teamSize ? escapeHtml(teamSize) : null;
    const safeMessage = message ? escapeHtml(message) : null;
    const safeEmail = escapeHtml(workEmail);
    const safePhone = phone ? escapeHtml(phone) : null;

    const submittedAt = new Date(lead.created_at || Date.now()).toLocaleString(
      "en-IN",
      { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" },
    );

    const salesHtml = buildSalesEmailHtml({
      fullName: safeName,
      workEmail: safeEmail,
      companyName: safeCompany,
      phone: safePhone,
      teamSize: safeTeamSize,
      message: safeMessage,
      leadId: lead.lead_id,
      submittedAt,
    });

    const userHtml = buildUserEmailHtml({
      fullName: safeName,
      companyName: safeCompany,
      teamSize: safeTeamSize,
      message: safeMessage,
    });

    try {
      await Promise.all([
        sendMail({
          to: getSalesEmail(),
          subject: `New Custom Pricing request — ${fullName}${companyName ? ` (${companyName})` : ""}`,
          html: salesHtml,
          replyTo: workEmail,
        }),
        sendMail({
          to: workEmail,
          subject: "We've received your Samvaadik custom pricing request",
          html: userHtml,
        }),
      ]);
    } catch (mailErr) {
      console.error("Custom pricing lead email failed to send:", mailErr);
      // Don't fail the request — the lead is safely stored either way.
    }

    res.status(201).json({ message: "Request received", leadId: lead.lead_id });
  } catch (err) {
    console.error("Submit Custom Pricing Request Error:", err);
    res.status(500).json({ message: "Failed to submit request" });
  }
};
