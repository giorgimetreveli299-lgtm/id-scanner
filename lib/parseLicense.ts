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

function normalize(text: string): string {
  return text.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").trim();
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
        const inLine = line.match(DATE_RE);
        if (inLine) return inLine[1];
        const next = lines[i + 1]?.match(DATE_RE);
        if (next) return next[1];
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
  const upper = fragment
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
    const prev = scopeLines[i - 1] ?? "";
    const next = scopeLines[i + 1] ?? "";
    const next2 = scopeLines[i + 2] ?? "";
    const codesHere = collectCategoryCodes(line);

    // Row OCR: "B 01.11.06 06.08.33"
    if (codesHere.length && lineHasCategoryDate(line)) {
      add(codesHere);
      continue;
    }

    // Code row, then col 10 / 11 dates on the next line(s)
    if (codesHere.length === 1 && !lineHasCategoryDate(line)) {
      if (isDateOnlyLine(next) || (isDateOnlyLine(next2) && isDateOnlyLine(next))) {
        add(codesHere);
      }
      continue;
    }

    // Date-only cell: belongs to the category code on the line above
    if (isDateOnlyLine(line)) {
      const prevCodes = collectCategoryCodes(prev);
      if (prevCodes.length === 1) add(prevCodes);
    }
  }

  // Whole-text pairs when OCR mixes columns on one stream
  if (!datedCodes.length) {
    const codesAlt = ALLOWED_CATEGORIES.join("|");
    const datePart =
      "\\d{2}[./-]\\d{2}[./-](?:\\d{4}|\\d{2})|\\d{4}[./-]\\d{2}[./-]\\d{2}";
    const pairRe = new RegExp(
      `(?:(?:^|[^A-Z0-9])(${codesAlt})(?=[^A-Z0-9]|$)[^\\n]{0,32}?(?:${datePart}))` +
        `|(?:(?:${datePart})[^\\n]{0,32}?(?:^|[^A-Z0-9])(${codesAlt})(?=[^A-Z0-9]|$))`,
      "gi"
    );
    let m: RegExpExecArray | null;
    const upper = text.toUpperCase();
    while ((m = pairRe.exec(upper)) !== null) {
      const code = (m[1] || m[2] || "").toUpperCase();
      if (code) add([code]);
    }
  }

  return datedCodes.length ? datedCodes.join(" ") : null;
}

/** Optional fallback: short list like "9. B C" when the date grid is unreadable. */
function findExplicitField9List(text: string, lines: string[]): string | null {
  const fromChunk = (chunk: string): string | null => {
    const cleaned = chunk
      .replace(/^(?:კატეგორი(?:ა|ები)?|Categor(?:y|ies)?)\s*[:：]?\s*/i, "")
      .trim();
    const codes = collectCategoryCodes(cleaned);
    if (codes.length >= 1 && codes.length <= 6) return codes.join(" ");
    return null;
  };

  const sameLine = text.match(
    /(?:^|\n)\s*9[\.\)]?\s+([A-Za-z0-9][^\n]*?)(?=\n\s*(?:\d+[a-d]?[\.\)]|[^\n]|$)|$)/i
  );
  if (sameLine?.[1] && !CAT_DATE_RE.test(sameLine[1])) {
    // Only treat as short list when the line is codes, not a table header dump
    const hit = fromChunk(sameLine[1]);
    if (hit) return hit;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^9[\.\)]?\s+[A-Za-z]/.test(line) && !lineHasCategoryDate(line)) {
      const hit = fromChunk(line.replace(/^9[\.\)]?\s*/, ""));
      if (hit) return hit;
    }
    if (/^9[\.\)]?\s*$/.test(line)) {
      const next = lines[i + 1]?.trim() ?? "";
      if (
        next &&
        !lineHasCategoryDate(next) &&
        !/^(?:1[0-9]|[1-8])[\.\)]\s/i.test(next)
      ) {
        const hit = fromChunk(next);
        if (hit) return hit;
      }
    }
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
  if (idx8 >= 0) return lines.slice(idx8 + 1, idx8 + 32);

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

  // Only if the date grid could not be read
  return findExplicitField9List(text, lines);
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

function findSurnameFromField1(text: string, lines: string[]): string | null {
  const clean = (raw: string) =>
    raw
      .replace(/^1[\.\),:]?\s*/i, "")
      .replace(/^(გვარი|surname|family\s*name)\s*[:：]?\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();

  // Primary: full value on the same line as "1." (space optional)
  const sameLine = text.match(
    /(?:^|\n)\s*1[\.\),:]?\s*([^\n]+?)(?=\n\s*2[\.\)]|\n\s*$|$)/
  );
  if (sameLine?.[1]) {
    const v = clean(sameLine[1]);
    if (v && isNameLike(v)) return v;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^1[\.\),:]?\s*\S/.test(line)) {
      const v = clean(line);
      if (v && isNameLike(v)) return v;
    }
    if (/^1[\.\),:]?\s*$/.test(line)) {
      const next = lines[i + 1]?.trim() ?? "";
      if (next && !/^2[\.\)]/.test(next) && isNameLike(clean(next))) {
        return clean(next);
      }
    }
  }

  const labeled = lineValue(lines, [/გვარი/i, /surname/i, /family\s*name/i]);
  if (!labeled) return null;
  const v = clean(labeled);
  return v && isNameLike(v) ? v : null;
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
      .replace(/\s+/g, " ")
      .trim();

  // Primary: value on the same line as "2." (space optional — OCR often glues it)
  const sameLine = text.match(
    /(?:^|\n)\s*2[\.\),:]?\s*([^\n]+?)(?=\n\s*3[\.\)]|\n\s*$|$)/
  );
  if (sameLine?.[1]) {
    const v = clean(sameLine[1]);
    if (v && isNameLike(v)) return v;
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

    const v = clean(line);
    if (!v || !isNameLike(v)) continue;

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
    const v = clean(labeled);
    if (v && isNameLike(v)) return v;
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
        const v = clean(cand);
        if (v && isNameLike(v)) return v;
        const next = lines[i + j + 1]?.trim() ?? "";
        if (next && isNameLike(clean(next))) return clean(next);
      }
      if (/^2[\.\),:]?/.test(cand)) continue;
      // Unnumbered name line between 1 and 3
      if (isNameLike(cand) && !/^1[\.\)]/.test(cand)) {
        // Avoid re-using surname line content if identical
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
  if (fromText?.[2]) return fromText[2];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (label.test(line)) {
      const inLine = line.match(DATE_RE);
      if (inLine) return inLine[1];
      const next = lines[i + 1]?.match(DATE_RE);
      if (next) return next[1];
    }
  }
  return null;
}

/** Parse OCR text from a Georgian / EU-style driving licence into structured fields. */
export function parseLicenseText(raw: string): LicenseFields {
  const text = normalize(raw);
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const fields: LicenseFields = { ...EMPTY };

  fields.surname = findSurnameFromField1(text, lines);
  fields.givenNames = findGivenNamesFromField2(text, lines);

  const field3 = findField3DateAndPlace(text, lines);
  fields.dateOfBirth =
    field3.date ||
    findDateNear(lines, [
      /^3[\.\)]?\s/,
      /დაბადების\s*თარიღი/i,
      /date\s*of\s*birth/i,
      /\bDOB\b/i,
    ]) ||
    null;

  fields.placeOfBirth =
    field3.place ||
    sanitizePlaceOfBirth(
      lineValue(lines, [/დაბადების\s*ადგილი/i, /place\s*of\s*birth/i])
    );

  // On every licence: 4a = issue date, 4b = expiry date
  fields.issueDate =
    findDateFromFieldLabel(text, lines, /4a[\.\)]?/i) ||
    findDateNear(lines, [
      /გაცემის\s*თარიღი/i,
      /date\s*of\s*issue/i,
    ]) ||
    null;

  fields.expiryDate =
    findDateFromFieldLabel(text, lines, /4b[\.\)]?/i) ||
    findDateNear(lines, [
      /გაუქმების\s*თარიღი/i,
      /მოქმედების\s*ვადა/i,
      /date\s*of\s*expiry/i,
    ]) ||
    null;

  fields.issuingAuthority =
    lineValue(lines, [
      /^4c[\.\)]?\s/i,
      /გამცემი\s*ორგანო/i,
      /issuing\s*authority/i,
      /issued\s*by/i,
    ]) || null;

  fields.personalNumber = findPersonalNumber(text);
  fields.licenseNumber = findLicenseNumber(text, lines);

  fields.residence =
    lineValue(lines, [
      /^8[\.\)]?\s/,
      /საცხოვრებელი\s*ადგილი/i,
      /მისამართი/i,
      /place\s*of\s*residence/i,
      /permanent\s*address/i,
      /address/i,
    ]) || null;

  fields.category = findCategoryAtField9(text, lines);

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
