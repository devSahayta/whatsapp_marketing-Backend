// services/mailerService.js
//
// Transactional email via Resend — reuses the SAME Resend account/API key
// already configured for scheduler/dailyNotificationDigest.js (the 8 AM
// daily summary email). No second key needed: one Resend account can send
// from any verified sender, for any feature, through the same key.
//
//   RESEND_API_KEY   - same key already set for the daily digest
//   MAIL_FROM        - e.g. "Samvaadik <noreply@samvaadik.com>"
//                       (reuse the same verified sender the digest already
//                       uses, or any other verified sender/domain on the
//                       same Resend account)
//   SALES_EMAIL      - inbox that should receive new custom-pricing leads
//
// Uses the official `resend` package — same one dailyNotificationDigest.js
// already imports, so no new dependency to install.
//
// If RESEND_API_KEY isn't set, sendMail() logs a warning and resolves
// instead of throwing, so the contact form still saves the lead even
// before email is wired up.
import { Resend } from "resend";

let resendClient = null;
let warnedMissingConfig = false;

const isConfigured = () => Boolean(process.env.RESEND_API_KEY);

const getClient = () => {
  if (!isConfigured()) return null;
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
};

/**
 * @param {{ to: string | string[], subject: string, html: string, replyTo?: string }} opts
 */
export const sendMail = async ({ to, subject, html, replyTo }) => {
  const client = getClient();
  if (!client) {
    if (!warnedMissingConfig) {
      console.warn(
        "[mailerService] RESEND_API_KEY is not set — skipping email send. Set RESEND_API_KEY and MAIL_FROM to enable it.",
      );
      warnedMissingConfig = true;
    }
    return { skipped: true };
  }

  const { error } = await client.emails.send({
    from: process.env.MAIL_FROM,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    ...(replyTo ? { reply_to: replyTo } : {}),
  });

  if (error) {
    throw new Error(
      `Resend API error: ${error.message || JSON.stringify(error)}`,
    );
  }

  return { sent: true };
};

export const getSalesEmail = () =>
  process.env.SALES_EMAIL || process.env.MAIL_FROM;
