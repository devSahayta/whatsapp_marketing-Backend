// services/invoiceService.js
//
// Generates a branded PDF invoice on the fly, streamed straight to the
// response — nothing is pre-generated or stored. Razorpay has no invoice
// object tied to our order-based Checkout flow (its Invoices API is a
// request-to-pay tool, not a post-payment receipt generator), so this is
// entirely our own layout built from data we already store in
// `payments` / `credit_transactions`.

import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

// ── Business details ──────────────────────────────────────────────────
// NOTE: plans/credit prices are stored as the base cost; GST (18%) is added
// on top at charge time (see config/gstConfig.js), so `amount` here is
// genuinely GST-inclusive and the split below is a real breakdown, not a
// back-calculated guess — EXCEPT for payments made before this went live,
// where `amount` was the base cost with no GST actually collected. If you
// ever need to tell those apart on an invoice, add a `gst_included` column
// and branch on it here; for now this always shows the split.
//
// GSTIN provided is registered in Jharkhand (state code 20). We don't
// currently collect each customer's billing state, so this is shown as one
// flat "GST" line rather than split CGST+SGST (intra-state) vs IGST
// (inter-state) — confirm with your CA whether a split is needed later.
const BUSINESS = {
  legalName: "Sahayta",
  brandName: "Samvaadik",
  addressLines: [
    "677 Mahatma Gandhi Main Road, Gurudwara",
    "Ranchi 834001, Jharkhand, India",
  ],
  gstin: "20ECZPA4523H1ZQ",
  supportEmail: "tejas@sahayta.co.in",
};

const GST_RATE = 0.18;

// Lives in THIS (backend) repo, not the frontend's public/ folder — the two
// are separate processes/deployments and the backend can't reach the
// frontend's filesystem. Drop logo-samvaadik.png into backend/assets/.
const LOGO_PATH = path.resolve(process.cwd(), "assets", "logo-samvaadik.png");

// PDFKit's built-in Helvetica is the old 14 standard PDF fonts (WinAnsi
// encoding) — no glyph for ₹ (a 2010 Unicode addition), so it silently
// substitutes a stray character instead. Using "Rs." avoids the encoding
// gap entirely; embedding a Unicode TTF font would be the other fix but
// isn't worth the extra dependency just for one symbol.
const formatINR = (value) =>
  `Rs. ${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(
    Number(value) || 0,
  )}`;

const formatDate = (value) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

// Support either paise or rupees from backend records, same convention
// used across the frontend for plan prices / credit amounts.
export const toRupees = (amount) => {
  const value = Number(amount);
  if (Number.isNaN(value)) return 0;
  return value >= 100000 ? value / 100 : value;
};

/**
 * invoice = {
 *   invoiceNumber, date, description, amount (rupees, GST-inclusive),
 *   customerName, customerEmail, paymentId, orderId, status
 * }
 */
export const generateInvoicePdf = (invoice, res) => {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  doc.pipe(res);

  // ── Header: logo + "TAX INVOICE" + invoice meta ──────────────────────
  // Logo reads as the brand mark here, so it's sized to lead — taller and
  // more prominent than the "TAX INVOICE" label, which is deliberately
  // small/muted, the way most real invoices (Stripe, Razorpay's own, etc.)
  // put the logo first and treat "invoice" as a quiet label, not a headline.
  const headerTop = 50;
  const LOGO_HEIGHT = 52;
  if (fs.existsSync(LOGO_PATH)) {
    try {
      doc.image(LOGO_PATH, 50, headerTop, { height: LOGO_HEIGHT });
    } catch {
      // Corrupt/unreadable logo shouldn't block invoice generation
    }
  }

  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor("#374151")
    .text("TAX INVOICE", 300, headerTop + 6, { align: "right", width: 245 });

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#9ca3af")
    .text(`Invoice #: ${invoice.invoiceNumber}`, 300, headerTop + 24, {
      align: "right",
      width: 245,
    })
    .text(`Date: ${formatDate(invoice.date)}`, 300, doc.y + 1, {
      align: "right",
      width: 245,
    });

  // ── Divider ───────────────────────────────────────────────────────────
  let y = headerTop + LOGO_HEIGHT + 18;
  doc.moveTo(50, y).lineTo(545, y).strokeColor("#e5e7eb").lineWidth(1).stroke();
  y += 24;

  // ── From / Billed-to columns ─────────────────────────────────────────
  const colTop = y;
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#9ca3af")
    .text("FROM", 50, colTop);
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor("#111827")
    .text(BUSINESS.legalName, 50, colTop + 14);
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#6b7280")
    .text(`(operating as ${BUSINESS.brandName})`, 50, doc.y + 2, {
      width: 260,
    });
  BUSINESS.addressLines.forEach((line) =>
    doc.text(line, 50, doc.y + 1, { width: 260 }),
  );
  doc.text(`GSTIN: ${BUSINESS.gstin}`, 50, doc.y + 1);
  doc.text(`Support: ${BUSINESS.supportEmail}`, 50, doc.y + 1);

  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#9ca3af")
    .text("BILLED TO", 320, colTop, { width: 225 });
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#111827")
    .text(invoice.customerName || "Customer", 320, colTop + 14, { width: 225 });
  if (invoice.customerEmail) {
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#6b7280")
      .text(invoice.customerEmail, 320, doc.y + 1, { width: 225 });
  }

  // ── Line-items table ──────────────────────────────────────────────────
  y = Math.max(doc.y, colTop + 100) + 24;
  const tableTop = y;
  doc.rect(50, tableTop, 495, 24).fill("#f9fafb");
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#374151")
    .text("DESCRIPTION", 58, tableTop + 8)
    .text("QTY", 335, tableTop + 8)
    .text("RATE", 395, tableTop + 8)
    .text("AMOUNT", 460, tableTop + 8, { width: 77, align: "right" });

  const baseAmount = invoice.amount / (1 + GST_RATE);
  const gstAmount = invoice.amount - baseAmount;
  const rowY = tableTop + 24 + 12;

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#111827")
    .text(invoice.description, 58, rowY, { width: 260 })
    .text("1", 335, rowY)
    .text(formatINR(baseAmount), 395, rowY, { width: 55 })
    .text(formatINR(baseAmount), 460, rowY, { width: 77, align: "right" });

  // ── Totals ─────────────────────────────────────────────────────────────
  let totalsY = rowY + 36;
  doc.moveTo(320, totalsY).lineTo(545, totalsY).strokeColor("#e5e7eb").stroke();
  totalsY += 12;

  const totalsRow = (label, value, bold = false) => {
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(10)
      .fillColor(bold ? "#111827" : "#6b7280")
      .text(label, 320, totalsY, { width: 140 })
      .text(value, 460, totalsY, { width: 77, align: "right" });
    totalsY += 18;
  };

  totalsRow("Subtotal", formatINR(baseAmount));
  totalsRow("GST (18%)", formatINR(gstAmount));
  totalsY += 4;
  doc.moveTo(320, totalsY).lineTo(545, totalsY).strokeColor("#e5e7eb").stroke();
  totalsY += 10;
  totalsRow("Total Paid", formatINR(invoice.amount), true);

  // ── Payment reference ───────────────────────────────────────────────────
  totalsY += 24;
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#6b7280")
    .text(`Payment ID: ${invoice.paymentId || "—"}`, 50, totalsY)
    .text(`Order ID: ${invoice.orderId || "—"}`, 50, doc.y + 2)
    .text(
      `Status: ${invoice.status === "paid" ? "Paid" : invoice.status}`,
      50,
      doc.y + 2,
    );

  // ── Footer ───────────────────────────────────────────────────────────
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#9ca3af")
    .text(
      "This is a system-generated invoice and does not require a signature.",
      50,
      770,
      { width: 495, align: "center" },
    );

  doc.end();
};
