// utils/contactFileParser.js
//
// Shared "turn a CSV/Excel file into a contacts array" parser used by:
//   - agentController.handleGroupPreview (dashboard, multipart upload)
//   - samvaadikWaController's WhatsApp document-upload flow (no multipart —
//     the file comes from a downloaded WhatsApp media buffer instead)
//
// Previously this logic lived only inside handleGroupPreview and only ever
// ran the buffer through @fast-csv's CSV parser — even though both the
// dashboard's multer filter and Samvaadik's own "Excel or CSV" copy promise
// Excel support. A real .xlsx/.xls file given to a CSV parser either throws
// or silently parses garbage. This module fixes that by sniffing the file
// extension/mime and routing to the right parser, with CSV as the fallback.

import { Readable } from "stream";
import { parse as parseCsv } from "@fast-csv/parse";
import * as XLSX from "xlsx";

const EXCEL_EXTENSIONS = new Set(["xlsx", "xls"]);
const EXCEL_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
]);

function getExtension(fileName = "") {
  const parts = String(fileName).split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function looksLikeExcel(fileName, mimeType) {
  if (mimeType && EXCEL_MIME_TYPES.has(mimeType)) return true;
  const ext = getExtension(fileName);
  return EXCEL_EXTENSIONS.has(ext);
}

/**
 * Parses an Excel workbook buffer (first sheet only) into { headers, rows }
 * using the same shape @fast-csv would have produced: rows are plain
 * objects keyed by header name, all values coerced to strings (so downstream
 * trimming/column-matching code doesn't have to special-case numbers/dates).
 */
function parseExcelBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [] };

  const sheet = workbook.Sheets[sheetName];
  // defval: "" keeps short rows aligned with the header row instead of
  // dropping keys for blank cells, matching @fast-csv's behaviour.
  const json = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });

  const headers = Object.keys(json[0] || {});
  const rows = json.map((row) => {
    const out = {};
    for (const key of headers) {
      const val = row[key];
      out[key] = val === null || val === undefined ? "" : String(val).trim();
    }
    return out;
  });
  return { headers, rows };
}

function parseCsvBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const headers = [];
    const rows = [];
    Readable.from(buffer)
      .pipe(parseCsv({ headers: true, ignoreEmpty: true, trim: true }))
      .on("headers", (h) => headers.push(...h))
      .on("data", (row) => rows.push(row))
      .on("error", reject)
      .on("end", () => resolve({ headers, rows }));
  });
}

const findColumn = (headers, candidates) => {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const c of candidates) {
    const i = lower.indexOf(c.toLowerCase());
    if (i !== -1) return headers[i];
  }
  return null;
};

export const slugifyFileName = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .slice(0, 60);

/**
 * Parses a CSV or Excel buffer into a contacts array, same shape regardless
 * of source format.
 *
 * @param {Buffer} buffer
 * @param {{ fileName?: string, mimeType?: string, userId?: string }} opts
 * @returns {Promise<{
 *   contacts: Array<{user_id:string|null, full_name:string|null, email:string|null, phone_number:string}>,
 *   headers: string[],
 *   rowCount: number,
 *   skipped: number,
 *   columns_found: { name: string|null, phone: string|null, email: string|null },
 * }>}
 * Throws a plain Error with a user-facing message on bad input.
 */
export async function parseContactsFile(buffer, opts = {}) {
  const { fileName = "", mimeType = "", userId = null } = opts;

  let headers = [];
  let rows = [];
  try {
    if (looksLikeExcel(fileName, mimeType)) {
      ({ headers, rows } = parseExcelBuffer(buffer));
    } else {
      ({ headers, rows } = await parseCsvBuffer(buffer));
    }
  } catch {
    throw new Error(
      "Could not read that file. Make sure it's a valid CSV or Excel (.xlsx/.xls) file with a header row.",
    );
  }

  if (!rows.length) {
    throw new Error("The file has no data rows.");
  }

  const nameCol = findColumn(headers, ["name", "full_name", "fullname"]);
  const phoneCol = findColumn(headers, [
    "phone",
    "phone_number",
    "phoneno",
    "mobile",
    "contact",
  ]);
  const emailCol = findColumn(headers, ["email", "email_address"]);

  if (!phoneCol) {
    throw new Error(
      `No phone column found. Columns in your file: ${headers.join(", ")}. Rename one to "phone", "phoneno", or "mobile".`,
    );
  }

  const contacts = rows
    .map((r) => ({
      user_id: userId,
      full_name: nameCol ? r[nameCol]?.trim() || null : null,
      email: emailCol ? r[emailCol]?.trim() || null : null,
      phone_number: r[phoneCol]?.trim(),
    }))
    .filter((c) => c.phone_number);

  if (!contacts.length) {
    throw new Error("No valid phone numbers found in the file.");
  }

  return {
    contacts,
    headers,
    rowCount: rows.length,
    skipped: rows.length - contacts.length,
    columns_found: {
      name: nameCol || null,
      phone: phoneCol,
      email: emailCol || null,
    },
  };
}
