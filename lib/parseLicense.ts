export type LicenseFields = {
  surname: string | null;
  givenNames: string | null;
  dateOfBirth: string | null;
  placeOfBirth: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  issuingAuthority: string | null;
  personalNumber: string | null;
  licenseNumber: string | null;
  residence: string | null;
  category: string | null;
};

/** Fixed on every Georgian driver license (field 4c). */
export const ISSUING_AUTHORITY =
  "შსს მომსახურების სააგენტო / Service Agency of MIA";

const EMPTY: LicenseFields = {
  surname: null,
  givenNames: null,
  dateOfBirth: null,
  placeOfBirth: null,
  issueDate: null,
  expiryDate: null,
  issuingAuthority: null,
  personalNumber: null,
  licenseNumber: null,
  residence: null,
  category: null,
};

/** Allowed category codes at licence field 9 (longer codes first for matching). */
export const ALLOWED_CATEGORIES = [
  "C1E",
  "D1E",
  "D13",
  "AM",
  "A1",
  "A2",
  "B1",
  "C1",
  "D1",
  "BE",
  "CE",
  "DE",
  "A",
  "B",
  "C",
  "D",
  "T",
  "S",
] as const;

export type AllowedCategory = (typeof ALLOWED_CATEGORIES)[number];

export type FieldKind = "text" | "image";

export type DashboardField = {
  key: keyof LicenseFields | "holderPhoto" | "holderSignature" | "qrCode";
  code: string;
  labelKa: string;
  labelEn: string;
  kind: FieldKind;
  maxLength?: number;
};

/** Display order matching EU / Georgian licence layout. */
export const DASHBOARD_FIELDS: DashboardField[] = [
  { key: "surname", code: "1", labelKa: "გვარი", labelEn: "Surname", kind: "text" },
  { key: "givenNames", code: "2", labelKa: "სახელი", labelEn: "Given names", kind: "text" },
  { key: "dateOfBirth", code: "3", labelKa: "დაბადების თარიღი", labelEn: "Date of birth", kind: "text" },
  { key: "placeOfBirth", code: "", labelKa: "დაბადების ადგილი", labelEn: "Place of birth", kind: "text" },
  { key: "issueDate", code: "4a", labelKa: "გაცემის თარიღი", labelEn: "Date of issue", kind: "text" },
  { key: "expiryDate", code: "4b", labelKa: "გაუქმების თარიღი", labelEn: "Date of expiry", kind: "text" },
  { key: "issuingAuthority", code: "4c", labelKa: "გამცემი ორგანო", labelEn: "Issuing authority", kind: "text" },
  { key: "personalNumber", code: "4d", labelKa: "პირადი ნომერი", labelEn: "Personal number", kind: "text" },
  { key: "licenseNumber", code: "5", labelKa: "მოწმობის ნომერი", labelEn: "License number", kind: "text", maxLength: 9 },
  { key: "holderPhoto", code: "6", labelKa: "მფლობელის ფოტო", labelEn: "Holder photo", kind: "image" },
  { key: "holderSignature", code: "7", labelKa: "მფლობელის ხელმოწერა", labelEn: "Holder signature", kind: "image" },
  { key: "residence", code: "8", labelKa: "საცხოვრებელი ადგილი", labelEn: "Place of residence", kind: "text" },
  { key: "category", code: "9", labelKa: "კატეგორია", labelEn: "Category", kind: "text", maxLength: 32 },
  { key: "qrCode", code: "", labelKa: "QR კოდი", labelEn: "QR code", kind: "image" },
];

export function fieldTitle(field: DashboardField): string {
  return `${field.labelKa} / ${field.labelEn}`;
}

const DATE_RE =
  /(\d{2}[./-]\d{2}[./-]\d{4}|\d{4}[./-]\d{2}[./-]\d{2})/;

/** Category table dates are often DD.MM.YY (2-digit year). */
const CAT_DATE_RE =
  /(\d{2}[./-]\d{2}[./-](?:\d{4}|\d{2})|\d{4}[./-]\d{2}[./-]\d{2})/;

/**
 * Flexible date for fields 4a/4b — OCR often inserts spaces: `30 / 03 / 2023`.
 * Also accepts 2-digit years.
 */
const FLEX_DATE_RE =
  /(\d{1,2})\s*[./\-]\s*(\d{1,2})\s*[./\-]\s*(\d{4}|\d{2})|(\d{4})\s*[./\-]\s*(\d{1,2})\s*[./\-]\s*(\d{1,2})/;

function normalize(text: string): string {
  return text.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").trim();
}

/** Turn a flexible OCR date into `DD/MM/YYYY` (or null if invalid). */
function normalizeFlexDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(FLEX_DATE_RE);
  if (!m) return null;

  let day: number;
  let month: number;
  let year: number;

  if (m[1] != null) {
    day = parseInt(m[1], 10);
    month = parseInt(m[2], 10);
    year = parseInt(m[3], 10);
    if (m[3].length === 2) {
      year += year >= 70 ? 1900 : 2000;
    }
  } else {
    year = parseInt(m[4], 10);
    month = parseInt(m[5], 10);
    day = parseInt(m[6], 10);
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 1970 || year > 2100) return null;

  const dd = String(day).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  return `${dd}/${mm}/${year}`;
}

function firstFlexDate(fragment: string): string | null {
  if (!fragment) return null;
  // Prefer the first plausible date token in the fragment
  const re = new RegExp(FLEX_DATE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) {
    const hit = normalizeFlexDate(m[0]);
    if (hit) return hit;
  }
  return null;
}

function lineValue(lines: string[], patterns: RegExp[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        const after = line.split(/[:：]/).slice(1).join(":").trim();
        if (after && after.length > 1) return after;
        const next = lines[i + 1]?.trim();
        if (next && next.length > 1 && !/^[0-9.]+$/.test(next.split(/\s/)[0] ?? "")) {
          return next;
        }
      }
    }
  }
  return null;
}

function findDateNear(lines: string[], patterns: RegExp[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        const inLine = firstFlexDate(line) || line.match(DATE_RE)?.[1];
        if (inLine) return normalizeFlexDate(inLine) || inLine;
        const nextRaw = lines[i + 1] ?? "";
        const next = firstFlexDate(nextRaw) || nextRaw.match(DATE_RE)?.[1];
        if (next) return normalizeFlexDate(next) || next;
      }
    }
  }
  return null;
}

function findPersonalNumber(text: string): string | null {
  const m =
    text.match(
      /(?:4d|პირადი\s*ნომერი|Personal\s*No\.?|ID\s*No\.?)[:\s]*([0-9]{11})/i
    ) || text.match(/\b([0-9]{11})\b/);
  return m?.[1] ?? null;
}

/** Georgian DL number under photo: 2 letters + 7 digits (LLDDDDDDD), e.g. AH7457231 */
const LICENSE_NUMBER_RE = /\b([A-Za-z]{2}\d{7})\b/;

function findLicenseNumber(text: string, lines: string[]): string | null {
  const normalizeCode = (raw: string) => raw.replace(/\s+/g, "").toUpperCase();

  const pickLLDDDDDDD = (fragment: string): string | null => {
    const m = fragment.match(LICENSE_NUMBER_RE);
    return m?.[1] ? normalizeCode(m[1]) : null;
  };

  // Primary: value right after "5." (under the holder photo)
  const afterFive =
    text.match(/(?:^|\n)\s*5[\.\)]\s*([A-Za-z]{2}\d{7})\b/) ||
    text.match(/(?:^|\n)\s*5[\.\)]\s*([A-Za-z0-9]{6,12})\b/);
  if (afterFive?.[1]) {
    const direct = pickLLDDDDDDD(afterFive[1]) || pickLLDDDDDDD(afterFive[0]);
    if (direct) return direct;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^5[\.\)]/.test(line)) {
      const fromLine = pickLLDDDDDDD(line);
      if (fromLine) return fromLine;
    }
    if (/^5[\.\)]\s*$/.test(line.trim())) {
      const fromNext = pickLLDDDDDDD(lines[i + 1] ?? "");
      if (fromNext) return fromNext;
    }
  }

  // Anywhere near field-5 / license labels — still only LLDDDDDDD
  const labeled = text.match(
    /(?:მოწმობის\s*ნომერი|License\s*No\.?|Document\s*No\.?|DL\s*No\.?)[:\s]*([A-Za-z]{2}\d{7})\b/i
  );
  if (labeled?.[1]) return normalizeCode(labeled[1]);

  const fromLine = lineValue(lines, [
    /^5[\.\)]/,
    /მოწმობის\s*ნომერი/i,
    /license\s*no/i,
    /document\s*no/i,
  ]);
  if (fromLine) {
    const code = pickLLDDDDDDD(fromLine);
    if (code) return code;
  }

  // Last resort: first LLDDDDDDD on the front-side-like text
  return pickLLDDDDDDD(text);
}

function collectCategoryCodes(fragment: string): string[] {
  const upper = (fragment.length > 4000 ? fragment.slice(0, 4000) : fragment)
    .toUpperCase()
    .replace(/\u0410/g, "A")
    .replace(/\u0412/g, "B")
    .replace(/\u0421/g, "C")
    .replace(/\u0415/g, "E")
    .replace(/\u0422/g, "T")
    .replace(/\u041C/g, "M");
  const found: { index: number; code: string }[] = [];

  for (const code of ALLOWED_CATEGORIES) {
    const re = new RegExp(`(?:^|[^A-Z0-9])(${code})(?=[^A-Z0-9]|$)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(upper)) !== null) {
      const codeStart = m.index + m[0].length - code.length;
      const overlaps = found.some(
        (f) =>
          codeStart < f.index + f.code.length && codeStart + code.length > f.index
      );
      if (!overlaps) found.push({ index: codeStart, code });
    }
  }

  found.sort((a, b) => a.index - b.index || b.code.length - a.code.length);
  const ordered: string[] = [];
  for (const item of found) {
    if (!ordered.includes(item.code)) ordered.push(item.code);
  }
  return ordered;
}

/** Canonical `AM B C` list, official table order, no duplicates. */
export function formatCategory(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const codes = collectCategoryCodes(value);
  if (!codes.length) return null;
  const order = [...ALLOWED_CATEGORIES];
  const unique: string[] = [];
  for (const code of codes) {
    if (!unique.includes(code)) unique.push(code);
  }
  unique.sort(
    (a, b) =>
      order.indexOf(a as (typeof order)[number]) -
      order.indexOf(b as (typeof order)[number])
  );
  return unique.join(" ");
}

const SINGLE_LETTER_CATEGORIES = new Set(["A", "B", "C", "D", "T", "S"]);

/**
 * Field 9 from the back-side QR: standalone uppercase Latin category codes
 * (e.g. `B`, `C`, `AM`, `B1`). Rule: a token of exactly one uppercase Latin
 * letter is always a category code — not part of a name or place.
 */
export function findCategoriesFromQr(
  payload: string | null | undefined
): string | null {
  const raw = (payload || "").trim();
  if (!raw) return null;

  const allowed = new Set<string>(ALLOWED_CATEGORIES);
  const found: string[] = [];
  const add = (code: string) => {
    if (allowed.has(code) && !found.includes(code)) found.push(code);
  };

  const upper = raw
    .toUpperCase()
    .replace(/\u0410/g, "A")
    .replace(/\u0412/g, "B")
    .replace(/\u0421/g, "C")
    .replace(/\u0415/g, "E")
    .replace(/\u0422/g, "T")
    .replace(/\u041C/g, "M");

  // Standalone single uppercase Latin letters (field 9 category codes)
  const standaloneLetterRe = /(?<![A-Za-z0-9])([A-Z])(?![A-Za-z0-9])/g;
  let letterMatch: RegExpExecArray | null;
  while ((letterMatch = standaloneLetterRe.exec(upper)) !== null) {
    const ch = letterMatch[1];
    if (SINGLE_LETTER_CATEGORIES.has(ch)) add(ch);
  }

  const tokens = upper.split(/[^A-Z0-9]+/).filter(Boolean);

  for (const token of tokens) {
    if (allowed.has(token)) {
      add(token);
      continue;
    }
    // Glued single letters: "BC" → B C — only if every char is A/B/C/D/T/S
    if (
      token.length >= 2 &&
      token.length <= 4 &&
      [...token].every((ch) => SINGLE_LETTER_CATEGORIES.has(ch))
    ) {
      for (const ch of token) add(ch);
    }
  }

  return formatCategory(found.join(" "));
}

/**
 * Back-side category table: column 9 = codes, 10/11 = dates.
 * Only codes that have a date in col 10 or 11 belong in the Category box.
 */
function findDatedCategoriesFromGrid(
  text: string,
  lines: string[]
): string | null {
  const scopeLines = getCategoryTableLines(text, lines);
  const datedCodes: string[] = [];

  const add = (codes: string[]) => {
    for (const code of codes) {
      if (!datedCodes.includes(code)) datedCodes.push(code);
    }
  };

  const isDateOnlyLine = (line: string) =>
    lineHasCategoryDate(line) && collectCategoryCodes(line).length === 0;

  for (let i = 0; i < scopeLines.length; i++) {
    const line = scopeLines[i];
    const next = scopeLines[i + 1] ?? "";
    const next2 = scopeLines[i + 2] ?? "";
    const codesHere = collectCategoryCodes(line);

    // Strong signal: code(s) + date on the same OCR line — "B 01.11.06 06.08.33"
    if (codesHere.length && lineHasCategoryDate(line)) {
      // Prefer a single code on a dated row (multi-code same line is rare noise)
      if (codesHere.length === 1) add(codesHere);
      else {
        // "B 01.11.06 C 01.11.06" style — take each code that sits near a date token
        const parts = line.split(/\s+/);
        for (let p = 0; p < parts.length; p++) {
          const codes = collectCategoryCodes(parts[p]);
          if (codes.length !== 1) continue;
          const window = parts.slice(p, p + 4).join(" ");
          if (lineHasCategoryDate(window)) add(codes);
        }
      }
      continue;
    }

    // Code alone, then date(s) on the next line(s) — "B" / "01.11.06 06.08.33"
    if (codesHere.length === 1 && !lineHasCategoryDate(line)) {
      const nextCodes = collectCategoryCodes(next);
      if (isDateOnlyLine(next)) {
        add(codesHere);
      } else if (
        nextCodes.length === 0 &&
        isDateOnlyLine(next2)
      ) {
        add(codesHere);
      }
    }
  }

  if (!datedCodes.length) return null;

  const order = [...ALLOWED_CATEGORIES];
  datedCodes.sort(
    (a, b) =>
      order.indexOf(a as (typeof order)[number]) -
      order.indexOf(b as (typeof order)[number])
  );
  return datedCodes.join(" ");
}

/** Compact front-style list like "9. B C" — not the back table dump. */
function lineIsShortCategoryList(line: string): string | null {
  const cleaned = line
    .replace(/^9[\.\)]?\s*/i, "")
    .replace(/^(?:კატეგორი(?:ა|ები)?|Categor(?:y|ies)?)\s*[:：]?\s*/i, "")
    .trim();
  if (!cleaned || CAT_DATE_RE.test(cleaned)) return null;
  if (/^\d+[.\)]?$/.test(cleaned)) return null;
  const codes = collectCategoryCodes(cleaned);
  if (codes.length < 1 || codes.length > 4) return null;
  const letters = cleaned.replace(/[^A-Za-z]/g, "").toUpperCase();
  const joined = codes.join("");
  if (letters.length > joined.length + 1) return null;
  return codes.join(" ");
}

function windowLooksLikeCategoryGrid(lines: string[], i: number): boolean {
  const blob = lines.slice(Math.max(0, i - 1), i + 18).join("\n");
  return collectCategoryCodes(blob).length >= 6;
}

/**
 * Front (and some backs) print only held codes as a short list: "9. B C".
 * Never use this on the full back table — that prints every empty row too.
 */
function findFrontStyleCategoryList(text: string, lines: string[]): string | null {
  // Back table prints every row (AM A1 A2 A B1 …). Never treat its tail as a short list.
  if (collectCategoryCodes(lines.join("\n")).length >= 6) return null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (windowLooksLikeCategoryGrid(lines, i)) continue;
    if (lineHasCategoryDate(line) && collectCategoryCodes(line).length) continue;

    const hit = lineIsShortCategoryList(line);
    if (!hit) continue;

    const codes = collectCategoryCodes(hit);
    for (let j = 1; j <= 3 && i + j < lines.length; j++) {
      const next = lines[i + j];
      if (windowLooksLikeCategoryGrid(lines, i + j)) break;
      const extra = lineIsShortCategoryList(next);
      if (!extra) break;
      for (const code of collectCategoryCodes(extra)) {
        if (!codes.includes(code)) codes.push(code);
      }
    }
    if (codes.length >= 1 && codes.length <= 4) {
      return formatCategory(codes.join(" "));
    }
  }

  const sameLine = text.match(
    /(?:^|\n)\s*9[\.\)]\s+([A-Za-z][A-Za-z0-9\s]{0,20}?)(?=\n|$)/
  );
  if (
    sameLine?.[1] &&
    !CAT_DATE_RE.test(sameLine[1]) &&
    collectCategoryCodes(text).length < 6
  ) {
    const hit = lineIsShortCategoryList(`9. ${sameLine[1]}`);
    if (hit) return formatCategory(hit);
  }

  return null;
}

function getCategoryTableLines(text: string, lines: string[]): string[] {
  const field9Lines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Table header "9 10 11" or field "9." / category label
    if (
      /^9[\.\)]?\s/.test(line) ||
      /^9[\.\)]?\s*$/.test(line) ||
      /(?:^|\s)9[\.\)]?\s*(?:კატეგორი|Categor)/i.test(line) ||
      /^9\s+10\s+11\b/i.test(line) ||
      (/^9\b/.test(line) && /\b10\b/.test(line) && /\b11\b/.test(line))
    ) {
      field9Lines.push(line.replace(/^.*?9[\.\)]?\s*/, ""));
      for (let j = 1; j <= 28 && i + j < lines.length; j++) {
        const next = lines[i + j];
        if (/^(?:1[2-9]|[1-8])[\.\)]\s/i.test(next)) break;
        field9Lines.push(next);
      }
    }
  }

  const labeled = text.match(
    /(?:^|\n)\s*9(?:\s+10\s+11)?[\.\)]?\s*(?:კატეგორი(?:ა|ები)?|Categor(?:y|ies)?)?[:\s]*([^\n]+(?:\n[^\n]+){0,28})/i
  );
  if (labeled?.[1]) {
    field9Lines.push(
      ...labeled[1]
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    );
  }

  if (field9Lines.length) {
    return [...new Set(field9Lines.map((l) => l.trim()).filter(Boolean))];
  }

  const idxHeader = lines.findIndex(
    (l) =>
      (/^9\b/.test(l) && /\b10\b/.test(l)) ||
      /^9[\.\)]?\s/.test(l) ||
      /კატეგორი|Categor(?:y|ies)/i.test(l)
  );
  if (idxHeader >= 0) return lines.slice(idxHeader, idxHeader + 28);

  const idx8 = lines.findIndex((l) => /^8[\.\)]?\s/.test(l));
  if (idx8 >= 0) {
    let start = idx8 + 1;
    while (
      start < lines.length &&
      start < idx8 + 4 &&
      /საქართველო|georgia/i.test(lines[start] || "")
    ) {
      start += 1;
    }
    return lines.slice(start, start + 32);
  }

  // Prefer the densest category+date region on the back
  return lines;
}

function lineHasCategoryDate(line: string): boolean {
  return CAT_DATE_RE.test(line);
}

/**
 * Category box = codes from the back table (col 9) that have dates in col 10/11.
 * Example: B and C have 01.11.06 → write "B C". Empty rows (A, D, …) are ignored.
 */
function findCategoryAtField9(text: string, lines: string[]): string | null {
  const dated = findDatedCategoriesFromGrid(text, lines);
  if (dated) return dated;

  // Only if the date grid could not be read — and never the empty table rows
  return findFrontStyleCategoryList(text, lines);
}

/** Strip leaked neighbouring field labels/dates from place of birth. */
export function sanitizePlaceOfBirth(value: string | null): string | null {
  if (!value) return null;
  let v = value
    .replace(/\b4[a-dA-D][\.\)]?\s*/g, " ")
    .replace(new RegExp(DATE_RE.source, "g"), " ")
    .replace(/გაცემის\s*თარიღი/gi, " ")
    .replace(/date\s*of\s*issue/gi, " ")
    .replace(/issued\b/gi, " ")
    .replace(/^3[\.\)]?\s*/, "")
    .replace(/^[_‐–—−-]+\s*/g, "")
    .replace(/[:：]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!v) return null;
  if (/^4[a-d]/i.test(v)) return null;
  if (new RegExp(`^${DATE_RE.source}$`).test(v)) return null;
  return v;
}

/**
 * Field **1.** = surname (გვარი). Take only the text after `1.` and before `2.`
 * (example: `1. გარიბოვი / Garibov` → `გარიბოვი / Garibov`).
 */
function findSurnameFromField1(text: string, lines: string[]): string | null {
  const clean = (raw: string) =>
    raw
      .replace(/^[Il1|!][\.\),:]?\s*/i, "")
      .replace(/^1[\.\),:]?\s*/i, "")
      .replace(/^(გვარი|surname|family\s*name)\s*[:：]?\s*/i, "")
      // Hard stop if a later field leaked into the same chunk
      .replace(/\s+[2-9][a-d]?[\.\)][\s\S]*$/i, "")
      .replace(/\s*\/\s*/g, " / ")
      .replace(/\s+/g, " ")
      .trim();

  const accept = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const v = clean(raw);
    if (!v || v.length < 2) return null;
    if (/^[2-9][a-d]?[\.\)]?\s*$/i.test(v)) return null;
    if (/^(გვარი|surname)$/i.test(v)) return null;
    if (!/[\u10A0-\u10FFA-Za-z]/.test(v)) return null;
    // Still contains another field marker → too greedy
    if (/\b[2-9][a-d]?[\.\)]/i.test(v)) return null;
    return v;
  };

  // Same line or run-on OCR: stop at "2." even without a newline
  const sameLine = text.match(
    /(?:^|\n)\s*1[\.\),:]\s*(.+?)(?=\s+2[\.\),:]|$)/
  );
  if (sameLine?.[1]) {
    const hit = accept(sameLine[1]);
    if (hit) return hit;
  }

  // Bilingual right after 1.
  const bilingual = text.match(
    /(?:^|\n)\s*1[\.\),:]?\s*([\u10A0-\u10FF][\u10A0-\u10FF\s\-']{1,40}?)\s*\/\s*([A-Za-z][A-Za-z\s\-']{1,40}?)(?=\s*2[\.\),:]|\s*\n|$)/u
  );
  if (bilingual) {
    const hit = accept(`${bilingual[1]} / ${bilingual[2]}`);
    if (hit) return hit;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^1[\.\),:]?\s*\S/.test(line) || /^[Il|][\.\)]\s*\S/.test(line)) {
      // Cut at inline "2." if OCR glued fields on one line
      const cut = line.split(/\s+(?=2[\.\),:])/)[0] ?? line;
      const hit = accept(cut);
      if (hit) {
        const next = lines[i + 1]?.trim() ?? "";
        if (
          !hit.includes("/") &&
          next &&
          !/^2[\.\)]/.test(next) &&
          /^\/?\s*[A-Za-z]/.test(next)
        ) {
          const latin = accept(next.replace(/^\//, ""));
          if (latin) return `${hit} / ${latin}`;
        }
        return hit;
      }
    }
    if (/^1[\.\),:]?\s*$/.test(line) || /^[Il|][\.\)]\s*$/.test(line)) {
      const parts: string[] = [];
      for (let j = 1; j <= 3 && i + j < lines.length; j++) {
        const next = lines[i + j]?.trim() ?? "";
        if (/^2[\.\)]/.test(next) || /^[3-9][a-d]?[\.\)]/i.test(next)) break;
        if (/^[\/|]+$/.test(next)) continue;
        const piece = accept(next);
        if (piece) parts.push(piece);
      }
      if (parts.length) {
        return parts.join(" / ").replace(/\s*\/\s*\/\s*/g, " / ");
      }
    }
  }

  const labeled = lineValue(lines, [/გვარი/i, /surname/i, /family\s*name/i]);
  return labeled ? accept(labeled) : null;
}

function isNameLike(value: string): boolean {
  const v = value.trim();
  if (v.length < 2 || v.length > 80) return false;
  if (/^\d+[a-d]?[\.\)]?/i.test(v)) return false;
  if (/^(გვარი|სახელი|surname|given|first\s*name|family)/i.test(v)) return false;
  if (DATE_RE.test(v) && !/[\u10A0-\u10FFA-Za-z]{3,}/.test(v)) return false;
  return /[\u10A0-\u10FF]{2,}|[A-Za-z][A-Za-z\-']{1,}/.test(v);
}

function findGivenNamesFromField2(text: string, lines: string[]): string | null {
  const clean = (raw: string) =>
    raw
      .replace(/^2[\.\),:]?\s*/i, "")
      .replace(/^(სახელი|given\s*names?|first\s*name|forename)\s*[:：]?\s*/i, "")
      .replace(/\s+[3-9][a-d]?[\.\)][\s\S]*$/i, "")
      .replace(/\s*\/\s*/g, " / ")
      .replace(/\s+/g, " ")
      .trim();

  const accept = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const v = clean(raw);
    if (!v || !isNameLike(v)) return null;
    if (/\b[3-9][a-d]?[\.\)]/i.test(v)) return null;
    return v;
  };

  // Stop at "3." even when OCR glues fields on one line (2. may sit mid-string)
  const sameLine = text.match(
    /(?:^|\n|\s)2[\.\),:]\s*(.+?)(?=\s+3[\.\),:]|\s+4[a-d]?[\.\),:]|$)/i
  );
  if (sameLine?.[1]) {
    const hit = accept(sameLine[1]);
    if (hit) return hit;
  }

  // "2. ქართული" then "/ Latin" or Latin on the next line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^2[\.\),:]?\s*\S?/i.test(line) && !/^2[\.\),:]?\s*$/.test(line)) {
      continue;
    }

    if (/^2[\.\),:]?\s*$/.test(line)) {
      const parts: string[] = [];
      for (let j = 1; j <= 2 && i + j < lines.length; j++) {
        const next = lines[i + j]?.trim() ?? "";
        if (/^3[\.\)]/.test(next) || /^\d+[a-d]?[\.\)]/i.test(next)) break;
        if (isNameLike(clean(next))) parts.push(clean(next));
      }
      if (parts.length) return parts.join(" / ").replace(/\s*\/\s*\/\s*/g, " / ");
      continue;
    }

    const cut = line.split(/\s+(?=3[\.\),:])/)[0] ?? line;
    const v = accept(cut);
    if (!v) continue;

    const next = lines[i + 1]?.trim() ?? "";
    if (
      next &&
      !/^3[\.\)]/.test(next) &&
      !/^\d+[a-d]?[\.\)]/i.test(next) &&
      /^\/?\s*[A-Za-z]/.test(next)
    ) {
      const latin = clean(next.replace(/^\//, ""));
      if (isNameLike(latin) && !v.includes(latin)) {
        return `${v} / ${latin}`.replace(/\s*\/\s*\/\s*/g, " / ");
      }
    }
    return v;
  }

  const labeled = lineValue(lines, [
    /სახელი/i,
    /given\s*names?/i,
    /first\s*name/i,
    /forename/i,
  ]);
  if (labeled) {
    const v = accept(labeled);
    if (v) return v;
  }

  // After field 1, take the next name-like line before field 3
  for (let i = 0; i < lines.length; i++) {
    if (!/^1[\.\)]\s*\S/.test(lines[i]) && !/^1[\.\)]\s*$/.test(lines[i])) {
      continue;
    }
    for (let j = 1; j <= 4 && i + j < lines.length; j++) {
      const cand = lines[i + j];
      if (/^3[\.\)]/.test(cand)) break;
      if (/^2[\.\),:]?/.test(cand)) {
        const cut = cand.split(/\s+(?=3[\.\),:])/)[0] ?? cand;
        const v = accept(cut);
        if (v) return v;
        const next = lines[i + j + 1]?.trim() ?? "";
        if (next && isNameLike(clean(next))) return clean(next);
      }
      if (/^2[\.\),:]?/.test(cand)) continue;
      if (isNameLike(cand) && !/^1[\.\)]/.test(cand)) {
        const surname = findSurnameFromField1(text, lines);
        const v = clean(cand);
        if (v && surname && v === surname) continue;
        if (v && isNameLike(v)) return v;
      }
    }
  }

  return null;
}

function findField3DateAndPlace(
  text: string,
  lines: string[]
): { date: string | null; place: string | null } {
  const extractFromLine = (line: string) => {
    const body = line.replace(/^3[\.\)]\s*/, "").trim();
    const dateMatch = body.match(DATE_RE);
    const date = dateMatch?.[1] ?? null;
    const place = sanitizePlaceOfBirth(
      body
        .replace(DATE_RE, " ")
        .replace(/დაბადების\s*(თარიღი|ადგილი)?/gi, " ")
        .replace(/date\s*of\s*birth|place\s*of\s*birth|\bDOB\b/gi, " ")
        .replace(/[:：]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    );
    return { date, place };
  };

  // Primary: "3. 24/10/1985 თბილისი / TBILISI"
  const sameLine = text.match(
    /(?:^|\n)\s*3[\.\)]\s+([^\n]+?)(?=\n\s*4[a-d]?[\.\)]|\n\s*$|$)/i
  );
  if (sameLine?.[1]) {
    const from = extractFromLine(`3. ${sameLine[1]}`);
    if (from.date || from.place) return from;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^3[\.\)]\s+\S/.test(line)) {
      const from = extractFromLine(line);
      if (from.date || from.place) return from;
    }
    if (/^3[\.\)]\s*$/.test(line)) {
      const next = lines[i + 1]?.trim() ?? "";
      if (next && !/^4[a-d]?[\.\)]/i.test(next)) {
        const from = extractFromLine(`3. ${next}`);
        if (from.date || from.place) return from;
      }
    }
  }

  return { date: null, place: null };
}

/**
 * Field **4a.** = date of issue (გაცემის თარიღი).
 * Take only the date after `4a` and before `4b` / `4c` / `4d` / `5.`.
 */
function findIssueDateFromField4a(text: string, lines: string[]): string | null {
  const stripLabels = (raw: string) =>
    raw
      .replace(/^4\s*[aA\u0430\u0410][\.\),:]?\s*/i, "")
      .replace(/გაცემის\s*თარიღი/gi, " ")
      .replace(/date\s*of\s*issue/gi, " ")
      .replace(/issued\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

  // 1) Same line / run-on OCR: stop hard at 4b/4c/4d/5 so expiry never leaks in
  // NOTE: require whitespace before `5.` so dates like `15.11.2020` are not cut at `5.`
  const sameChunk = text.match(
    /(?:^|\n)\s*4\s*[aA\u0430\u0410][\.\),:]?\s*([^\n]*?)(?=\s+4\s*[bB\u0432\u0412cC\u0441\u0421dD]|\s+5[\.\)]|$)/im
  );
  if (sameChunk?.[1]) {
    const hit = firstFlexDate(stripLabels(sameChunk[1]));
    if (hit) return hit;
  }

  // 2) Dedicated line containing 4a (date may be glued or on following lines)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/4\s*[aA\u0430\u0410][\.\),:]?/i.test(line)) continue;
    // Ignore pure 4b/4c/4d lines
    if (/^4\s*[bB\u0432\u0412cC\u0441\u0421dD]/i.test(line.trim())) continue;

    const cut =
      line.split(/\s*(?=4\s*[bB\u0432\u0412cC\u0441\u0421dD]|5[\.\)])/i)[0] ?? line;
    const fromLine = firstFlexDate(stripLabels(cut));
    if (fromLine) return fromLine;

    for (let j = 1; j <= 3 && i + j < lines.length; j++) {
      const next = lines[i + j]?.trim() ?? "";
      if (!next) continue;
      if (/^4\s*[bB\u0432\u0412cC\u0441\u0421dD]/i.test(next)) break;
      if (/^5[\.\)]/.test(next)) break;
      if (/^[1-9][\.\)]\s/.test(next) && !/4\s*[aA\u0430\u0410]/i.test(next)) break;
      const fromNext = firstFlexDate(stripLabels(next));
      if (fromNext) return fromNext;
    }
  }

  // 3) Georgian / English labels
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/გაცემის\s*თარიღი|date\s*of\s*issue/i.test(line)) continue;
    const fromLine = firstFlexDate(stripLabels(line));
    if (fromLine) return fromLine;
    for (let j = 1; j <= 2 && i + j < lines.length; j++) {
      const next = lines[i + j]?.trim() ?? "";
      if (/^4\s*[bB\u0432\u0412]/i.test(next) || /გაუქმების|expiry/i.test(next)) break;
      const fromNext = firstFlexDate(next);
      if (fromNext) return fromNext;
    }
  }

  return null;
}

function findDateFromFieldLabel(
  text: string,
  lines: string[],
  label: RegExp
): string | null {
  const fromText = text.match(
    new RegExp(
      `(?:^|\\n)\\s*(${label.source})\\s*(${DATE_RE.source})`,
      "im"
    )
  );
  if (fromText?.[2]) return normalizeFlexDate(fromText[2]) || fromText[2];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (label.test(line)) {
      // Prefer date that follows the label on this line (avoid DOB when glued)
      const labelMatch = line.match(label);
      if (labelMatch && labelMatch.index != null) {
        const after = line.slice(labelMatch.index + labelMatch[0].length);
        const fromAfter = firstFlexDate(after);
        if (fromAfter) return fromAfter;
      }
      const inLine = firstFlexDate(line) || line.match(DATE_RE)?.[1];
      if (inLine) return normalizeFlexDate(inLine) || inLine;
      const nextRaw = lines[i + 1] ?? "";
      const next = firstFlexDate(nextRaw) || nextRaw.match(DATE_RE)?.[1];
      if (next) return normalizeFlexDate(next) || next;
    }
  }
  return null;
}

/** Parse OCR text from a Georgian / EU-style driving licence into structured fields. */
/**
 * Field **8.** = place of residence (back of the card).
 * On every Georgian DL this is two lines:
 * `საქართველო, ქალაქი` then `Georgia, City` (comma). Stops before **9.**
 */
function findResidenceFromField8(text: string, lines: string[]): string | null {
  const LABEL_RE =
    /^(საცხოვრებელი\s*ადგილი|მისამართი|place\s*of\s*residence|permanent\s*address|address)\s*[:：]?\s*/i;
  const JUNK_CITY =
    /^(DRIVING|LICENCE|LICENSE|PLACE|RESIDENCE|CATEGORY|CATEGORIES|SERVICE|AGENCY|REPUBLIC|PERMANENT|ADDRESS|HOLDER|მართვის|მოწმობა|ადგილი|საცხოვრებელი|კატეგორია)$/i;

  const isStopLine = (line: string): boolean => {
    const t = line.trim();
    if (!t) return false;
    if (/^9[\.\),:](?:\s|$)/i.test(t) || /^9[\.\),:]?\s*$/i.test(t)) return true;
    if (/^9\s+10(\s+11)?/i.test(t)) return true;
    if (/კატეგორი|categor(?:y|ies)/i.test(t)) return true;
    if (lineHasCategoryDate(t) && collectCategoryCodes(t).length > 0) return true;
    return false;
  };

  const isField8Marker = (line: string): boolean => {
    const t = line.trim();
    if (/^8[\.\),:]?\s*\d/.test(t)) return false;
    if (/^8[\.\),:](?:\s|$)/.test(t)) return true;
    if (/^8[\.\),:]?\s*$/.test(t)) return true;
    if (/^8\s+[\u10A0-\u10FFA-Za-z]/.test(t)) return true;
    return false;
  };

  const firstCity = (raw: string): string => {
    const words = raw
      .replace(/\s+/g, " ")
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= 2);
    if (!words.length) return "";
    if (JUNK_CITY.test(words[0])) return "";
    return words[0];
  };

  const cityAfterCountry = (
    chunk: string,
    country: "geo" | "lat",
    requireSep: boolean
  ): string => {
    if (!chunk) return "";
    const marker = country === "geo" ? "საქართველო" : "GEORGIA";
    const hay = country === "geo" ? chunk : chunk.toUpperCase();
    let from = 0;
    for (let n = 0; n < 12; n++) {
      const idx = hay.indexOf(marker, from);
      if (idx < 0) return "";
      if (country === "lat") {
        const before = idx === 0 ? " " : hay[idx - 1];
        const after = hay[idx + marker.length] || " ";
        if (/[A-Z0-9]/.test(before || "") || /[A-Z0-9]/.test(after)) {
          from = idx + marker.length;
          continue;
        }
      }
      const rest = chunk.slice(idx + marker.length, idx + marker.length + 96);
      const sep = /^\s*[,.\u060C\uFF0C:]/.test(rest);
      if (requireSep && !sep) {
        from = idx + marker.length;
        continue;
      }
      const cityMatch =
        country === "geo"
          ? rest.match(/^\s*[,.\u060C\uFF0C:]?\s*([\u10A0-\u10FF][\u10A0-\u10FF\-']{0,40})/u)
          : rest.match(/^\s*[,.\u060C\uFF0C:]?\s*([A-Za-z][A-Za-z\-']{0,40})/);
      const city = firstCity(cityMatch?.[1] || "");
      if (city) return city;
      from = idx + marker.length;
    }
    return "";
  };

  const pairFrom = (chunk: string, requireSep: boolean): string | null => {
    if (!chunk) return null;
    const slice = chunk.length > 8000 ? chunk.slice(0, 8000) : chunk;
    const geoCity = cityAfterCountry(slice, "geo", requireSep);
    const latCity = cityAfterCountry(slice, "lat", requireSep);
    if (geoCity && latCity) return `${geoCity} / ${latCity}`;
    if (geoCity) return geoCity;
    if (latCity) return latCity;
    return null;
  };

  const stripTrail = (raw: string) => {
    let s = raw
      .replace(/^8[\.\),:]?\s*/i, "")
      .replace(LABEL_RE, "")
      .replace(/\s+9[\.\)][\s\S]*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    const tokens = s.split(/\s+/);
    while (tokens.length) {
      const last = (tokens[tokens.length - 1] || "").replace(/[.,;:]+$/, "");
      if (
        /^(C1E|D1E|D13|AM|A1|A2|B1|C1|D1|BE|CE|DE|[ABCDTS])$/i.test(last)
      ) {
        tokens.pop();
        continue;
      }
      break;
    }
    return tokens.join(" ").trim();
  };

  // 1) Lines from `8.` until `9.` / the category table
  for (let i = 0; i < lines.length; i++) {
    if (!isField8Marker(lines[i])) continue;
    const block: string[] = [stripTrail(lines[i])];
    for (let j = 1; j <= 5 && i + j < lines.length; j++) {
      const next = lines[i + j]?.trim() ?? "";
      if (!next || isStopLine(next)) break;
      if (LABEL_RE.test(next) && !/საქართველო|georgia/i.test(next)) continue;
      block.push(stripTrail(next));
      const blob = block.filter(Boolean).join("\n");
      if (/საქართველო/i.test(blob) && /\bgeorgia\b/i.test(blob)) break;
    }
    const blob = block.filter(Boolean).join("\n");
    const hit = pairFrom(blob, false);
    if (hit) return hit;
  }

  // 2) Label then the two printed lines
  for (let i = 0; i < lines.length; i++) {
    if (
      !/საცხოვრებელი\s*ადგილი|place\s*of\s*residence|permanent\s*address/i.test(
        lines[i]
      )
    ) {
      continue;
    }
    const block: string[] = [stripTrail(lines[i])];
    for (let j = 1; j <= 4 && i + j < lines.length; j++) {
      const next = lines[i + j]?.trim() ?? "";
      if (!next || isStopLine(next)) break;
      block.push(stripTrail(next));
    }
    const hit = pairFrom(block.filter(Boolean).join("\n"), false);
    if (hit) return hit;
  }

  // 3) `საქართველო, City` / `Georgia, City` on lines that mention the country
  //    (skip the front header: "Georgia Driving Licence" has no comma/city)
  const relevant = (lines.length ? lines : text.split("\n"))
    .filter((l) => /საქართველო|georgia/i.test(l))
    .map((l) => {
      const windows: string[] = [];
      let from = 0;
      const upper = l.toUpperCase();
      while (windows.length < 8) {
        const geoAt = l.indexOf("საქართველო", from);
        const latAt = upper.indexOf("GEORGIA", from);
        const idx =
          geoAt >= 0 && latAt >= 0
            ? Math.min(geoAt, latAt)
            : Math.max(geoAt, latAt);
        if (idx < 0) break;
        windows.push(l.slice(Math.max(0, idx - 16), idx + 160));
        from = idx + 1;
      }
      return windows.join("\n") || l.slice(0, 200);
    })
    .join("\n");
  return pairFrom(relevant, true) || pairFrom(relevant, false);
}

export function parseLicenseText(raw: string): LicenseFields {
  const text = normalize(raw);
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const fields: LicenseFields = { ...EMPTY };
  const tryField = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  fields.surname = tryField(() => findSurnameFromField1(text, lines), null);
  fields.givenNames = tryField(() => findGivenNamesFromField2(text, lines), null);

  const field3 = tryField(
    () => findField3DateAndPlace(text, lines),
    { date: null, place: null }
  );
  fields.dateOfBirth =
    field3.date ||
    tryField(
      () =>
        findDateNear(lines, [
          /^3[\.\)]?\s/,
          /დაბადების\s*თარიღი/i,
          /date\s*of\s*birth/i,
          /\bDOB\b/i,
        ]),
      null
    ) ||
    null;

  fields.placeOfBirth =
    field3.place ||
    tryField(
      () =>
        sanitizePlaceOfBirth(
          lineValue(lines, [/დაბადების\s*ადგილი/i, /place\s*of\s*birth/i])
        ),
      null
    );

  // On every licence: 4a = issue date, 4b = expiry date
  fields.issueDate = tryField(
    () =>
      findIssueDateFromField4a(text, lines) ||
      findDateFromFieldLabel(text, lines, /4a[\.\)]?/i) ||
      findDateNear(lines, [
        /გაცემის\s*თარიღი/i,
        /date\s*of\s*issue/i,
      ]) ||
      null,
    null
  );
  if (fields.issueDate) {
    fields.issueDate = normalizeFlexDate(fields.issueDate) || fields.issueDate;
  }

  fields.expiryDate = tryField(
    () =>
      findDateFromFieldLabel(text, lines, /4b[\.\)]?/i) ||
      findDateNear(lines, [
        /გაუქმების\s*თარიღი/i,
        /მოქმედების\s*ვადა/i,
        /date\s*of\s*expiry/i,
      ]) ||
      null,
    null
  );

  fields.issuingAuthority = ISSUING_AUTHORITY;

  fields.personalNumber = tryField(() => findPersonalNumber(text), null);
  fields.licenseNumber = tryField(() => findLicenseNumber(text, lines), null);
  fields.residence = tryField(
    () => findResidenceFromField8(text, lines),
    null
  );
  fields.category = tryField(
    () => formatCategory(findCategoryAtField9(text, lines)),
    null
  );

  return fields;
}

/** Prefer the first non-empty value for each field. */
export function mergeLicenseFields(
  ...sources: LicenseFields[]
): LicenseFields {
  const merged: LicenseFields = { ...EMPTY };
  for (const key of Object.keys(EMPTY) as (keyof LicenseFields)[]) {
    for (const source of sources) {
      const value = source[key];
      if (value) {
        merged[key] = value;
        break;
      }
    }
  }
  return merged;
}
