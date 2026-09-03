import { joinBilingualName, splitBilingualName } from "./georgianTranslit";

export type QrHighlight = { start: number; end: number };

/** Fields that can be cross-checked against the QR payload. */
export const QR_CHECKABLE_FIELDS = [
  "surname",
  "givenNames",
  "dateOfBirth",
  "personalNumber",
  "licenseNumber",
  "residence",
  "category",
  "expiryDate",
] as const;

export type QrCheckableField = (typeof QR_CHECKABLE_FIELDS)[number];

export function isQrCheckableField(key: string): key is QrCheckableField {
  return (QR_CHECKABLE_FIELDS as readonly string[]).includes(key);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Collect searchable needles for a dashboard field value. */
function needlesForField(
  key: QrCheckableField,
  value: string
): string[] {
  const raw = (value || "").trim();
  if (!raw) return [];

  if (key === "surname" || key === "givenNames") {
    const { latin } = splitBilingualName(raw);
    const n = (latin || raw).trim();
    return n ? [n] : [];
  }

  if (key === "residence") {
    const { latin } = splitBilingualName(raw);
    // Prefer the English side only (e.g. "Georgia, Kutaisi")
    let side = (latin || "").trim();
    if (!side && !/[\u10A0-\u10FF]/.test(raw)) side = raw;
    side = side.replace(/\s+/g, " ").trim();
    const out: string[] = [];
    if (side) {
      out.push(side);
      out.push(side.replace(/[.,]/g, " ").replace(/\s+/g, " ").trim());
    }
    for (const part of side.split(/[.,;/|\s]+/)) {
      const t = part.trim();
      if (t.length >= 3) out.push(t);
    }
    return [...new Set(out.filter(Boolean))];
  }

  if (key === "category") {
    return raw
      .toUpperCase()
      .split(/[\s,;|/+\-]+/)
      .map((c) => c.trim())
      .filter((c) => /^[A-Z0-9]{1,3}$/.test(c));
  }

  if (key === "dateOfBirth" || key === "expiryDate") {
    return dateNeedles(raw);
  }

  if (key === "personalNumber") {
    const digits = raw.replace(/\D/g, "");
    return digits.length >= 11 ? [digits.slice(0, 11)] : digits ? [digits] : [];
  }

  if (key === "licenseNumber") {
    const code = raw.replace(/\s+/g, "").toUpperCase();
    return code ? [code] : [];
  }

  return [raw];
}

function dateNeedles(raw: string): string[] {
  const compact = raw.replace(/\s+/g, "");
  const m =
    compact.match(/^(\d{1,2})[./\-](\d{1,2})[./\-](\d{4}|\d{2})$/) ||
    compact.match(/^(\d{4})[./\-](\d{1,2})[./\-](\d{1,2})$/);
  if (!m) return compact.length >= 6 ? [compact] : [];

  let day: string;
  let month: string;
  let year: string;
  if (m[0].startsWith(m[1]) && m[1].length === 4) {
    year = m[1];
    month = m[2].padStart(2, "0");
    day = m[3].padStart(2, "0");
  } else {
    day = m[1].padStart(2, "0");
    month = m[2].padStart(2, "0");
    year = m[3].length === 2 ? (parseInt(m[3], 10) >= 70 ? `19${m[3]}` : `20${m[3]}`) : m[3];
  }
  const yy = year.slice(-2);
  return [
    `${day}/${month}/${year}`,
    `${day}.${month}.${year}`,
    `${day}-${month}-${year}`,
    `${day}/${month}/${yy}`,
    `${day}.${month}.${yy}`,
    `${day}-${month}-${yy}`,
    `${year}${month}${day}`,
    `${day}${month}${year}`,
    `${year}-${month}-${day}`,
  ];
}

function findInsensitive(
  haystack: string,
  needle: string,
  wholeWord = false
): QrHighlight | null {
  if (!haystack || !needle) return null;
  const flags = wholeWord ? "gi" : "i";
  const pattern = wholeWord
    ? `(?<![A-Za-z0-9])${escapeRegExp(needle)}(?![A-Za-z0-9])`
    : escapeRegExp(needle);
  try {
    const re = new RegExp(pattern, flags);
    const m = re.exec(haystack);
    if (!m || m.index == null) return null;
    return { start: m.index, end: m.index + m[0].length };
  } catch {
    const lower = haystack.toLowerCase();
    const idx = lower.indexOf(needle.toLowerCase());
    if (idx < 0) return null;
    return { start: idx, end: idx + needle.length };
  }
}

/** Split English residence into country + city tokens. */
function residenceCountryCity(value: string): {
  country: string;
  city: string;
  tokens: string[];
} {
  const { latin } = splitBilingualName(value);
  let side = (latin || "").trim();
  if (!side && !/[\u10A0-\u10FF]/.test(value)) side = value.trim();
  side = side.replace(/\s+/g, " ").trim();

  const parts = side
    .split(/[.,;/|]+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2);

  // "Georgia, Kutaisi" or "Georgia. Rustavi" or "Georgia Kutaisi"
  let country = "";
  let city = "";
  if (parts.length >= 2) {
    country = parts[0];
    city = parts.slice(1).join(" ");
  } else if (parts.length === 1) {
    const spaced = parts[0].split(/\s+/).filter(Boolean);
    if (spaced.length >= 2) {
      country = spaced[0];
      city = spaced.slice(1).join(" ");
    } else {
      city = parts[0];
    }
  }

  const tokens = [...new Set([country, city].filter((t) => t.length >= 2))];
  return { country, city, tokens };
}

/**
 * Locate where a form field value appears inside the QR payload.
 * Returns one or more highlight spans, or null if not verified.
 * Residence highlights both country and city; category highlights every code.
 */
export function findFieldInQr(
  qrPayload: string | null | undefined,
  fieldKey: QrCheckableField,
  fieldValue: string
): QrHighlight[] | null {
  const qr = (qrPayload || "").trim();
  if (!qr) return null;

  const needles = needlesForField(fieldKey, fieldValue);
  if (!needles.length) return null;

  // Category: every listed code must appear in QR as its own token
  if (fieldKey === "category") {
    const hits: QrHighlight[] = [];
    for (const code of needles) {
      const hit = findCategoryCodeInQr(qr, code);
      if (!hit) return null;
      hits.push(hit);
    }
    hits.sort((a, b) => a.start - b.start);
    return hits.length ? hits : null;
  }

  // Residence: city must appear in QR; country is optional
  if (fieldKey === "residence") {
    const { country, city } = residenceCountryCity(fieldValue);
    if (!city) return null;

    const cityHit =
      findInsensitive(qr, city, false) ||
      findInsensitive(qr, city.replace(/\s+/g, ""), false);
    if (!cityHit) return null;

    const hits: QrHighlight[] = [cityHit];
    if (country) {
      const countryHit = findInsensitive(qr, country, false);
      if (countryHit) hits.push(countryHit);
    }
    hits.sort((a, b) => a.start - b.start);
    return hits;
  }

  // Given names: every name token must appear in QR
  if (fieldKey === "givenNames") {
    const primary = needles[0] || "";
    const words = primary.split(/\s+/).map((w) => w.trim()).filter((w) => w.length >= 2);
    if (!words.length) return null;
    const hits: QrHighlight[] = [];
    for (const word of words) {
      const hit = findInsensitive(qr, word, false);
      if (!hit) return null;
      hits.push(hit);
    }
    hits.sort((a, b) => a.start - b.start);
    return hits;
  }

  const wholeWord = fieldKey === "licenseNumber";

  // Prefer longer needles first (more specific)
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  for (const needle of ordered) {
    const hit = findInsensitive(qr, needle, wholeWord);
    if (hit) return [hit];
  }

  return null;
}

/**
 * Georgian licence QR rule (field 9): a standalone single uppercase Latin letter
 * in the payload is a category code (e.g. `B`, `C`). Multi-char codes must appear
 * as their own token too (`AM`, `B1`).
 */
export function findCategoryCodeInQr(
  qrPayload: string | null | undefined,
  code: string
): QrHighlight | null {
  const qr = (qrPayload || "").trim();
  const c = code.trim().toUpperCase();
  if (!qr || !c) return null;

  if (c.length === 1 && /^[A-Z]$/.test(c)) {
    return findInsensitive(qr, c, true);
  }

  return findInsensitive(qr, c, true) || findInsensitive(qr, c, false);
}

export function fieldIsQrChecked(
  qrPayload: string | null | undefined,
  fieldKey: string,
  fieldValue: string
): boolean {
  return getQrCompareStatus(qrPayload, fieldKey, fieldValue) === "checked";
}

/**
 * Compare a form field to the QR payload.
 * - `checked` — value is present / matches in QR
 * - `error` — field has a value to check, QR exists, but they do not match
 * - `null` — nothing to compare (no QR, empty field, or not a checkable field)
 */
export function getQrCompareStatus(
  qrPayload: string | null | undefined,
  fieldKey: string,
  fieldValue: string
): "checked" | "error" | null {
  if (!isQrCheckableField(fieldKey)) return null;
  const qr = (qrPayload || "").trim();
  if (!qr) return null;

  const raw = (fieldValue || "").trim();
  if (!raw) return null;

  // Bilingual English-side fields: need Latin text to compare
  if (
    fieldKey === "surname" ||
    fieldKey === "givenNames" ||
    fieldKey === "residence"
  ) {
    const { latin } = splitBilingualName(raw);
    const side = (latin || (!/[\u10A0-\u10FF]/.test(raw) ? raw : "")).trim();
    if (!side) return null;
  }

  const hits = findFieldInQr(qr, fieldKey, raw);
  if (hits && hits.length) return "checked";
  return "error";
}

/** English-side (or full) string used for the QR badge on a field. */
export function qrBadgeValue(
  fieldKey: QrCheckableField,
  formValue: string
): string {
  if (
    fieldKey === "surname" ||
    fieldKey === "givenNames" ||
    fieldKey === "residence"
  ) {
    const { geo, latin } = splitBilingualName(formValue);
    return latin || joinBilingualName(geo, latin);
  }
  return formValue;
}

/**
 * Form values that were Checked against the QR at scan time.
 * Any later edit (even one character) must show Error.
 */
export function buildQrCheckedSnapshot(
  qrPayload: string | null | undefined,
  fields: Record<string, string>
): Partial<Record<QrCheckableField, string>> {
  const snap: Partial<Record<QrCheckableField, string>> = {};
  for (const key of QR_CHECKABLE_FIELDS) {
    const raw = fields[key] ?? "";
    if (getQrCompareStatus(qrPayload, key, qrBadgeValue(key, raw)) === "checked") {
      snap[key] = raw;
    }
  }
  return snap;
}

/** Status after scan: Checked only if the field is still exactly the scanned value. */
export function getQrBadgeStatus(
  qrPayload: string | null | undefined,
  fieldKey: string,
  badgeValue: string,
  currentFormValue: string,
  snapshot: Partial<Record<QrCheckableField, string>>
): "checked" | "error" | null {
  if (!isQrCheckableField(fieldKey)) return null;
  if (!(qrPayload || "").trim()) return null;

  if (Object.prototype.hasOwnProperty.call(snapshot, fieldKey)) {
    return currentFormValue === snapshot[fieldKey] ? "checked" : "error";
  }

  return getQrCompareStatus(qrPayload, fieldKey, badgeValue);
}
