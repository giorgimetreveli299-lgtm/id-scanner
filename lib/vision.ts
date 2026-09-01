import { ImageAnnotatorClient, protos } from "@google-cloud/vision";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import {
  ALLOWED_CATEGORIES,
  ISSUING_AUTHORITY,
  findCategoriesFromQr,
  formatCategory,
  mergeLicenseFields,
  parseLicenseText,
  type LicenseFields,
} from "./parseLicense";
import { detectQrOnLicenseBack } from "./detectQr";
import { formatBilingualPlace, applyQrLatinToName, applyQrLatinToResidence, extractLatinIdentityFromQr } from "./georgianTranslit";
import {
  BACK_SIDE_REQUIRED_ERROR,
  FRONT_SIDE_REQUIRED_ERROR,
  type FaceBox,
} from "./types";

export type { FaceBox };
export { BACK_SIDE_REQUIRED_ERROR, FRONT_SIDE_REQUIRED_ERROR };

export type ScanResult = {
  fields: LicenseFields;
  rawText: string;
  frontText: string;
  backText: string;
  /** Normalized 0–1 box of the holder face on the front image. */
  holderPhotoBox: FaceBox | null;
  /**
   * Signature crop on the front: only the stroke under field 5 / at field 7
   * (below the license number).
   */
  holderSignatureBox: FaceBox | null;
  /** QR code on the back (below coat of arms). */
  qrCodeBox: FaceBox | null;
  /** Decoded QR payload when available. */
  qrCodeValue: string | null;
  /** Server-cropped JPEG data URLs (reliable in the browser). */
  holderPhotoDataUrl: string | null;
  holderSignatureDataUrl: string | null;
  qrCodeDataUrl: string | null;
};

let client: ImageAnnotatorClient | null = null;

/** Normalize phone uploads: EXIF rotation + sensible size for Vision OCR. */
export async function prepareLicenseImage(imageBuffer: Buffer): Promise<Buffer> {
  try {
    const meta = await sharp(imageBuffer).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    let pipeline = sharp(imageBuffer).rotate();
    const longSide = Math.max(w, h);
    if (longSide > 0 && longSide < 1400) {
      pipeline = pipeline.resize({
        width: w >= h ? 2000 : undefined,
        height: h > w ? 2000 : undefined,
        fit: "inside",
        withoutEnlargement: false,
      });
    } else if (longSide > 4200) {
      pipeline = pipeline.resize(4200, 4200, {
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    return pipeline.jpeg({ quality: 92 }).toBuffer();
  } catch {
    return imageBuffer;
  }
}

function getClient(): ImageAnnotatorClient {
  if (!client) {
    const keyFilename =
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      path.join(process.cwd(), "clientdocsocr.json");
    client = fs.existsSync(keyFilename)
      ? new ImageAnnotatorClient({ keyFilename })
      : new ImageAnnotatorClient();
  }
  return client;
}

type Vertex = protos.google.cloud.vision.v1.IVertex;
type TextAnn = protos.google.cloud.vision.v1.IEntityAnnotation;

type PixelBox = { minX: number; minY: number; maxX: number; maxY: number };

function pixelBoxFromVertices(
  vertices: Vertex[] | null | undefined
): PixelBox | null {
  if (!vertices || vertices.length < 2) return null;
  const xs = vertices.map((v) => v.x ?? 0);
  const ys = vertices.map((v) => v.y ?? 0);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function normalizeBox(
  box: PixelBox,
  imageWidth: number,
  imageHeight: number
): FaceBox | null {
  if (!imageWidth || !imageHeight) return null;
  const left = Math.max(0, box.minX) / imageWidth;
  const top = Math.max(0, box.minY) / imageHeight;
  const right = Math.min(imageWidth, box.maxX) / imageWidth;
  const bottom = Math.min(imageHeight, box.maxY) / imageHeight;
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function boxFromVertices(
  vertices: Vertex[] | null | undefined,
  imageWidth: number,
  imageHeight: number,
  padRatio = { x: 0.12, y: 0.18 }
): FaceBox | null {
  const box = pixelBoxFromVertices(vertices);
  if (!box) return null;
  const padX = (box.maxX - box.minX) * padRatio.x;
  const padY = (box.maxY - box.minY) * padRatio.y;
  return normalizeBox(
    {
      minX: box.minX - padX,
      maxX: box.maxX + padX,
      minY: box.minY - padY,
      maxY: box.maxY + padY,
    },
    imageWidth,
    imageHeight
  );
}

function readImageDimensions(
  buf: Buffer
): { width: number; height: number } | null {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 8) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return {
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7),
        };
      }
      const len = buf.readUInt16BE(i + 2);
      i += 2 + len;
    }
  }
  if (
    buf.length > 30 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    if (buf.toString("ascii", 12, 16) === "VP8X") {
      return {
        width: 1 + buf.readUIntLE(24, 3),
        height: 1 + buf.readUIntLE(27, 3),
      };
    }
  }
  return null;
}

/** DD.MM.YY or DD.MM.YYYY (category table cols 10/11). */
const CAT_DATE_TOKEN_RE =
  /^\d{2}[./-]\d{2}[./-](?:\d{4}|\d{2})$/;

/** OCR often confuses Latin category letters with Cyrillic lookalikes. */
function normalizeCategoryToken(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/\u0410/g, "A") // А
    .replace(/\u0412/g, "B") // В
    .replace(/\u0421/g, "C") // С
    .replace(/\u0415/g, "E") // Е
    .replace(/\u0422/g, "T") // Т
    .replace(/\u041C/g, "M") // М (for AM)
    .replace(/[^A-Z0-9]/g, "");
}

function isCategoryDateToken(raw: string): boolean {
  const t = raw.replace(/\s+/g, "");
  if (CAT_DATE_TOKEN_RE.test(t)) return true;
  // OCR variants: 01.11.06 / 01-11-06 / 011106
  return /^\d{2}[./-]?\d{2}[./-]?\d{2}(\d{2})?$/.test(t) && t.length >= 6 && t.length <= 10;
}

/**
 * Spatial read of the back category table: column 9 codes that have a date
 * to their right in column 10 or 11 (same row). Empty rows are skipped.
 *
 * Uses nearest-left assignment so a date in row B does not also claim A / A1.
 */
function detectCategoriesFromTableLayout(
  annotations: TextAnn[],
  imageWidth: number
): string | null {
  const words = annotations.slice(1);
  if (!words.length) return null;

  type Item = {
    text: string;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    cx: number;
    cy: number;
  };

  const items: Item[] = [];
  for (const ann of words) {
    const text = (ann.description ?? "").trim();
    const box = pixelBoxFromVertices(ann.boundingPoly?.vertices);
    if (!text || !box) continue;
    items.push({
      text,
      minX: box.minX,
      maxX: box.maxX,
      minY: box.minY,
      maxY: box.maxY,
      cx: (box.minX + box.maxX) / 2,
      cy: (box.minY + box.maxY) / 2,
    });
  }

  // Merge split date tokens: "01.11"+"06", or three parts "01" "11" "06"
  const dateItems: Item[] = [];
  const used = new Set<number>();
  const sameRow = (a: Item, b: Item) => Math.abs(b.cy - a.cy) <= 16;
  const toRight = (a: Item, b: Item) =>
    b.minX >= a.maxX - 2 && b.minX - a.maxX <= 36;
  const digitsOf = (t: string) => t.replace(/\s+/g, "").replace(/\D/g, "");

  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const a = items[i];
    if (isCategoryDateToken(a.text)) {
      dateItems.push(a);
      continue;
    }

    // 3-part DD MM YY sitting on one row
    if (/^\d{1,2}[./-]?$/.test(a.text.replace(/\s+/g, ""))) {
      const idxs = [i];
      for (let j = i + 1; j < items.length && idxs.length < 3; j++) {
        if (used.has(j)) continue;
        const b = items[j];
        const prev = items[idxs[idxs.length - 1]];
        if (!sameRow(prev, b) || !toRight(prev, b)) continue;
        if (!/^\d{1,2}[./-]?$/.test(b.text.replace(/\s+/g, ""))) break;
        idxs.push(j);
      }
      if (idxs.length === 3) {
        const compact = idxs.map((k) => digitsOf(items[k].text)).join("");
        if (compact.length === 6 || compact.length === 8) {
          idxs.slice(1).forEach((k) => used.add(k));
          const first = items[idxs[0]];
          const last = items[idxs[2]];
          dateItems.push({
            text: `${compact.slice(0, 2)}.${compact.slice(2, 4)}.${compact.slice(4)}`,
            minX: first.minX,
            maxX: last.maxX,
            minY: Math.min(first.minY, last.minY),
            maxY: Math.max(first.maxY, last.maxY),
            cx: (first.minX + last.maxX) / 2,
            cy: (first.cy + last.cy) / 2,
          });
          continue;
        }
      }
    }

    for (let j = i + 1; j < Math.min(i + 4, items.length); j++) {
      if (used.has(j)) continue;
      const b = items[j];
      if (!sameRow(a, b) || !toRight(a, b)) continue;
      const merged = `${a.text}${b.text}`.replace(/\s+/g, "");
      if (isCategoryDateToken(merged)) {
        used.add(j);
        dateItems.push({
          text: merged,
          minX: a.minX,
          maxX: b.maxX,
          minY: Math.min(a.minY, b.minY),
          maxY: Math.max(a.maxY, b.maxY),
          cx: (a.minX + b.maxX) / 2,
          cy: (a.cy + b.cy) / 2,
        });
        break;
      }
    }
  }
  if (!dateItems.length) return null;

  const codeHits: { code: string; item: Item }[] = [];
  for (const item of items) {
    const upper = normalizeCategoryToken(item.text);
    if (!upper) continue;
    for (const code of ALLOWED_CATEGORIES) {
      if (upper === code) {
        codeHits.push({ code, item });
        break;
      }
    }
  }
  if (!codeHits.length) return null;

  // Typical vertical gap between category rows — keep date→code matching tight
  const codeYs = [...codeHits.map((c) => c.item.cy)].sort((a, b) => a - b);
  let medianGap = 28;
  if (codeYs.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < codeYs.length; i++) {
      const g = codeYs[i] - codeYs[i - 1];
      if (g > 6) gaps.push(g);
    }
    gaps.sort((a, b) => a - b);
    if (gaps.length) medianGap = gaps[Math.floor(gaps.length / 2)];
  }
  const rowTol = Math.max(12, Math.min(28, medianGap * 0.5));
  const maxGapX = Math.max(80, imageWidth * 0.6);

  // Each date claims at most one code: nearest to its left on the same row
  const claimed = new Map<string, { code: string; cy: number }>();

  for (const date of dateItems) {
    let best: { code: string; item: Item; score: number } | null = null;
    for (const { code, item } of codeHits) {
      if (date.cx <= item.cx + 2) continue;
      if (date.minX - item.maxX > maxGapX) continue;
      const dy = Math.abs(date.cy - item.cy);
      if (dy > rowTol) continue;
      const dx = date.minX - item.maxX;
      const score = dy * 3 + Math.max(0, dx) * 0.02;
      if (!best || score < best.score) best = { code, item, score };
    }
    if (!best) continue;
    const prev = claimed.get(best.code);
    if (!prev || best.item.cy < prev.cy) {
      claimed.set(best.code, { code: best.code, cy: best.item.cy });
    }
  }

  if (!claimed.size) return null;

  const order = [...ALLOWED_CATEGORIES];
  const found = [...claimed.values()]
    .sort((a, b) => a.cy - b.cy)
    .map((c) => c.code);
  // Stable display order matching the licence table
  found.sort((a, b) => order.indexOf(a as (typeof order)[number]) - order.indexOf(b as (typeof order)[number]));
  return found.join(" ");
}

async function analyzeBack(imageBuffer: Buffer): Promise<{
  text: string;
  categoryFromTable: string | null;
}> {
  const vision = getClient();
  const dims =
    readImageDimensions(imageBuffer) ?? { width: 1600, height: 1000 };

  const [result] = await vision.documentTextDetection({
    image: { content: imageBuffer.toString("base64") },
  });

  let text =
    result.fullTextAnnotation?.text?.trim() ||
    result.textAnnotations?.[0]?.description?.trim() ||
    "";
  if (!text) {
    text = await readDocumentTextRobust(imageBuffer);
  }

  let categoryFromTable = detectCategoriesFromTableLayout(
    result.textAnnotations ?? [],
    dims.width
  );

  // Fallback: walk document words from fullTextAnnotation (sometimes richer)
  if (!categoryFromTable && result.fullTextAnnotation?.pages?.length) {
    const synthetic: TextAnn[] = [{ description: text }];
    for (const page of result.fullTextAnnotation.pages) {
      for (const block of page.blocks ?? []) {
        for (const para of block.paragraphs ?? []) {
          for (const word of para.words ?? []) {
            const desc = (word.symbols ?? [])
              .map((s) => s.text ?? "")
              .join("");
            synthetic.push({
              description: desc,
              boundingPoly: word.boundingBox,
            });
          }
        }
      }
    }
    categoryFromTable = detectCategoriesFromTableLayout(synthetic, dims.width);
  }

  return { text, categoryFromTable };
}

async function detectHolderPhotoBox(
  imageBuffer: Buffer,
  dims: { width: number; height: number }
): Promise<FaceBox | null> {
  const vision = getClient();
  const [result] = await vision.faceDetection({
    image: { content: imageBuffer.toString("base64") },
  });

  const faces = result.faceAnnotations ?? [];
  if (!faces.length) return null;

  // Prefer the face on the right (holder photo on Georgian DL front)
  let best = faces[0];
  let bestScore = -1;
  for (const face of faces) {
    const v = face.boundingPoly?.vertices ?? [];
    if (v.length < 2) continue;
    const xs = v.map((p) => p.x ?? 0);
    const ys = v.map((p) => p.y ?? 0);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const area = Math.max(1, (maxX - minX) * (maxY - minY));
    const cx = (minX + maxX) / 2;
    const rightBias = cx / Math.max(1, dims.width); // 0..1
    const score = area * (0.35 + rightBias); // favor right-side faces
    if (score > bestScore) {
      bestScore = score;
      best = face;
    }
  }

  return boxFromVertices(
    best.boundingPoly?.vertices,
    dims.width,
    dims.height,
    { x: 0.22, y: 0.28 }
  );
}

/**
 * Signature is only the handwritten stroke under the license number (field 5),
 * i.e. field 7 on Georgian DLs — directly below "5. LLDDDDDDD".
 */
function detectSignatureBoxFromAnnotations(
  annotations: TextAnn[],
  dims: { width: number; height: number },
  licenseNumber: string | null
): FaceBox | null {
  const words = annotations.slice(1); // [0] is full text
  if (!words.length) return null;

  const { width: W, height: H } = dims;
  let licenseBox: PixelBox | null = null;
  let fiveBox: PixelBox | null = null;
  let sevenBox: PixelBox | null = null;

  const target = licenseNumber?.toUpperCase() ?? null;

  for (const ann of words) {
    const desc = (ann.description ?? "").trim();
    const box = pixelBoxFromVertices(ann.boundingPoly?.vertices);
    if (!box) continue;

    if (target && desc.toUpperCase().replace(/\s+/g, "") === target) {
      licenseBox = box;
    } else if (/^[A-Za-z]{2}\d{7}$/.test(desc) && !licenseBox) {
      licenseBox = box;
    }

    if (/^5[\.\)]?$/.test(desc)) fiveBox = box;
    if (/^7[\.\)]?$/.test(desc)) sevenBox = box;
  }

  // If "5." and number are separate, merge horizontally for the field-5 row
  let field5Row = licenseBox;
  if (licenseBox && fiveBox) {
    field5Row = {
      minX: Math.min(fiveBox.minX, licenseBox.minX),
      maxX: Math.max(fiveBox.maxX, licenseBox.maxX),
      minY: Math.min(fiveBox.minY, licenseBox.minY),
      maxY: Math.max(fiveBox.maxY, licenseBox.maxY),
    };
  } else if (!field5Row && fiveBox) {
    field5Row = fiveBox;
  }

  if (!field5Row && !sevenBox) return null;

  const rowHeight = field5Row
    ? Math.max(14, field5Row.maxY - field5Row.minY)
    : sevenBox
      ? Math.max(14, sevenBox.maxY - sevenBox.minY)
      : H * 0.04;

  // Signature sits immediately under the license number line (field 7)
  const top = field5Row
    ? field5Row.maxY + rowHeight * 0.15
    : (sevenBox?.minY ?? H * 0.7);

  const bottom = sevenBox
    ? Math.max(sevenBox.maxY + rowHeight * 1.6, top + rowHeight * 2.4)
    : top + rowHeight * 3.1;

  const left = field5Row
    ? Math.max(0, field5Row.minX - rowHeight * 0.3)
    : Math.max(0, (sevenBox?.minX ?? W * 0.55) - rowHeight);

  // Signature stroke is usually wider than the number
  const right = field5Row
    ? Math.min(W, Math.max(field5Row.maxX + rowHeight * 2.5, left + (field5Row.maxX - field5Row.minX) * 1.8))
    : Math.min(W, (sevenBox?.maxX ?? W * 0.95) + rowHeight * 3);

  // Extra bottom margin (~a few mm on a typical ID-1 scan)
  const bottomPad = Math.max(rowHeight * 0.55, H * 0.018);

  return normalizeBox(
    {
      minX: left,
      maxX: Math.max(left + 8, right),
      minY: top,
      maxY: Math.min(H, Math.max(top + 8, bottom + bottomPad)),
    },
    W,
    H
  );
}

async function analyzeFront(imageBuffer: Buffer): Promise<{
  text: string;
  holderPhotoBox: FaceBox | null;
  holderSignatureBox: FaceBox | null;
  licenseNumberHint: string | null;
}> {
  const vision = getClient();
  const dims =
    readImageDimensions(imageBuffer) ?? { width: 1600, height: 1000 };

  const [docResult, photoBox] = await Promise.all([
    vision.documentTextDetection({
      image: { content: imageBuffer.toString("base64") },
    }),
    detectHolderPhotoBox(imageBuffer, dims).catch(() => null),
  ]);

  const result = docResult[0];
  let text =
    result.fullTextAnnotation?.text?.trim() ||
    result.textAnnotations?.[0]?.description?.trim() ||
    "";
  if (!text) {
    text = await readDocumentTextRobust(imageBuffer);
  }

  const parsed = text ? parseLicenseText(text) : parseLicenseText("");
  const licenseNumberHint = parsed.licenseNumber;

  const holderSignatureBox =
    detectSignatureBoxFromAnnotations(
      result.textAnnotations ?? [],
      dims,
      licenseNumberHint
    ) ?? {
      left: 0.5,
      top: 0.74,
      width: 0.44,
      height: 0.18,
    };

  return {
    text,
    holderPhotoBox:
      photoBox ?? {
        left: 0.66,
        top: 0.14,
        width: 0.3,
        height: 0.56,
      },
    holderSignatureBox,
    licenseNumberHint,
  };
}

async function detectQrOnBack(imageBuffer: Buffer): Promise<{
  box: FaceBox | null;
  value: string | null;
  source: "decoded" | "plate" | "layout";
}> {
  const result = await detectQrOnLicenseBack(imageBuffer);
  return { box: result.box, value: result.value, source: result.source };
}

/** True when the image contains a person face (typical of the front photo). */
async function imageHasFace(imageBuffer: Buffer): Promise<boolean> {
  const vision = getClient();
  const [result] = await vision.faceDetection({
    image: { content: imageBuffer.toString("base64") },
  });
  const faces = result.faceAnnotations ?? [];
  return faces.some((face) => (face.detectionConfidence ?? 0) >= 0.35);
}

function looksLikeLicenseFrontText(text: string): boolean {
  if (!text) return false;
  if (/driving\s*licen[cs]e/i.test(text)) return true;
  if (/მართვის\s*მოწმობა/i.test(text) && /(?:^|\n)\s*1[\.\)]/.test(text)) {
    return true;
  }
  return false;
}

function looksLikeLicenseBackText(text: string): boolean {
  if (!text || looksLikeLicenseFrontText(text)) return false;
  const has8 = /(?:^|\n)\s*8[\.\)]/.test(text);
  const has9 =
    /(?:^|\n)\s*9[\.\)]/.test(text) || /^9\s+10(\s+11)?/m.test(text);
  if (has8 && has9) return true;
  if (/საცხოვრებელი\s*ადგილი|place\s*of\s*residence/i.test(text)) return true;
  if (has8 && /კატეგორი|categor(?:y|ies)/i.test(text)) return true;
  return false;
}

function qrWasDecoded(qr: { value: string | null; source: string }): boolean {
  return Boolean(qr.value) || qr.source === "decoded";
}

async function readDocumentText(imageBuffer: Buffer): Promise<string> {
  const vision = getClient();
  const [docResult] = await vision.documentTextDetection({
    image: { content: imageBuffer.toString("base64") },
  });
  return (
    docResult.fullTextAnnotation?.text?.trim() ||
    docResult.textAnnotations?.[0]?.description?.trim() ||
    ""
  );
}

/** Retry OCR with contrast boost when the first pass returns nothing. */
async function readDocumentTextRobust(imageBuffer: Buffer): Promise<string> {
  const primary = await readDocumentText(imageBuffer);
  if (primary) return primary;
  try {
    const enhanced = await sharp(imageBuffer)
      .rotate()
      .greyscale()
      .normalize()
      .sharpen()
      .jpeg({ quality: 92 })
      .toBuffer();
    return readDocumentText(enhanced);
  } catch {
    return "";
  }
}

/** Reject a front/back upload that is clearly the other side of the card. */
export async function validateLicenseSide(
  imageBuffer: Buffer,
  side: "front" | "back"
): Promise<void> {
  const [text, qr, hasFace] = await Promise.all([
    readDocumentText(imageBuffer),
    detectQrOnBack(imageBuffer).catch(() => ({
      box: null,
      value: null,
      source: "layout" as const,
    })),
    imageHasFace(imageBuffer).catch(() => false),
  ]);
  const qrFound = qrWasDecoded(qr);
  if (side === "back") {
    if (!qrFound && (hasFace || looksLikeLicenseFrontText(text))) {
      throw new Error(BACK_SIDE_REQUIRED_ERROR);
    }
    return;
  }
  if (qrFound || (!hasFace && looksLikeLicenseBackText(text))) {
    throw new Error(FRONT_SIDE_REQUIRED_ERROR);
  }
}

async function cropBoxToDataUrl(
  imageBuffer: Buffer,
  box: FaceBox | null | undefined,
  fallback: FaceBox
): Promise<string | null> {
  const b = box ?? fallback;
  try {
    const meta = await sharp(imageBuffer).rotate().metadata();
    const W = meta.width ?? 1;
    const H = meta.height ?? 1;
    const left = Math.max(0, Math.min(W - 1, Math.round(b.left * W)));
    const top = Math.max(0, Math.min(H - 1, Math.round(b.top * H)));
    const width = Math.max(1, Math.min(W - left, Math.round(b.width * W)));
    const height = Math.max(1, Math.min(H - top, Math.round(b.height * H)));
    const jpeg = await sharp(imageBuffer)
      .rotate()
      .extract({ left, top, width, height })
      .jpeg({ quality: 90 })
      .toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch (err) {
    console.error("cropBoxToDataUrl failed:", err);
    return null;
  }
}

export async function scanLicenseSides(
  frontBufferIn: Buffer,
  backBufferIn: Buffer,
  options?: {
    strictSides?: boolean;
    /** Skip Vision text OCR (Python fallback supplies text). */
    frontText?: string;
    backText?: string;
  }
): Promise<ScanResult> {
  const strictSides = options?.strictSides !== false;
  const [frontBuffer, backBuffer] = await Promise.all([
    prepareLicenseImage(frontBufferIn),
    prepareLicenseImage(backBufferIn),
  ]);

  const suppliedFront = options?.frontText?.trim() || "";
  const suppliedBack = options?.backText?.trim() || "";

  const [frontAnalysis, backAnalysis, backQr, frontQr, backHasFace, frontHasFace] =
    await Promise.all([
      suppliedFront
        ? (async () => {
            const dims =
              readImageDimensions(frontBuffer) ?? { width: 1600, height: 1000 };
            const photoBox = await detectHolderPhotoBox(frontBuffer, dims).catch(
              () => null
            );
            const parsed = parseLicenseText(suppliedFront);
            return {
              text: suppliedFront,
              holderPhotoBox: photoBox,
              holderSignatureBox: {
                left: 0.5,
                top: 0.74,
                width: 0.44,
                height: 0.18,
              },
              licenseNumberHint: parsed.licenseNumber,
            };
          })()
        : analyzeFront(frontBuffer),
      suppliedBack
        ? Promise.resolve({
            text: suppliedBack,
            categoryFromTable: null as string | null,
          })
        : analyzeBack(backBuffer),
      detectQrOnBack(backBuffer).catch(() => ({
        box: null,
        value: null,
        source: "layout" as const,
      })),
      detectQrOnBack(frontBuffer).catch(() => ({
        box: null,
        value: null,
        source: "layout" as const,
      })),
      imageHasFace(backBuffer).catch(() => false),
      imageHasFace(frontBuffer).catch(() => false),
    ]);

  const frontText = frontAnalysis.text;
  const backText = backAnalysis.text;
  const qr = backQr;

  const frontLooksWrong =
    qrWasDecoded(frontQr) ||
    (!frontHasFace && looksLikeLicenseBackText(frontText));
  const backLooksWrong =
    !qrWasDecoded(backQr) &&
    (backHasFace || looksLikeLicenseFrontText(backText));

  if (strictSides) {
    if (frontLooksWrong) {
      throw new Error(FRONT_SIDE_REQUIRED_ERROR);
    }
    if (backLooksWrong) {
      throw new Error(BACK_SIDE_REQUIRED_ERROR);
    }
  }

  if (!frontText && !backText) {
    throw new Error(
      "Could not read any text from the photos. Try brighter, sharper images of both sides."
    );
  }

  const safeParse = (raw: string): LicenseFields => {
    try {
      return parseLicenseText(raw);
    } catch {
      return parseLicenseText("");
    }
  };

  const frontFields = safeParse(frontText || "");
  const backFields = safeParse(backText || "");
  const combinedText = [frontText, backText].filter(Boolean).join("\n\n---\n\n");
  const combinedFields = safeParse(combinedText);

  let qrCategory: string | null = null;
  try {
    qrCategory = findCategoriesFromQr(qr.value);
  } catch {
    qrCategory = null;
  }

  const qrLatin = extractLatinIdentityFromQr(qr.value);

  // Field 9: uppercase Latin category codes from the QR payload first
  const category = formatCategory(
    qrCategory ||
      backAnalysis.categoryFromTable ||
      backFields.category ||
      frontFields.category ||
      combinedFields.category
  );

  const licenseNumber =
    frontFields.licenseNumber ||
    frontAnalysis.licenseNumberHint ||
    combinedFields.licenseNumber ||
    backFields.licenseNumber;

  // English sides from QR exactly as decoded; Georgian from OCR
  const surname = applyQrLatinToName(
    frontFields.surname || combinedFields.surname || backFields.surname,
    qrLatin.surname
  );

  const givenNames = applyQrLatinToName(
    frontFields.givenNames || combinedFields.givenNames || backFields.givenNames,
    qrLatin.givenNames
  );

  // Field 3 place of birth sits beside the DOB on the front
  const placeOfBirth = (() => {
    try {
      return formatBilingualPlace(
        frontFields.placeOfBirth ||
          combinedFields.placeOfBirth ||
          backFields.placeOfBirth
      );
    } catch {
      return (
        frontFields.placeOfBirth ||
        combinedFields.placeOfBirth ||
        backFields.placeOfBirth
      );
    }
  })();

  // Field 8: English country + city exactly as in the QR; OCR is fallback
  const residence = applyQrLatinToResidence(
    backFields.residence || combinedFields.residence || frontFields.residence,
    qrLatin.country,
    qrLatin.city
  );

  const dateOfBirth =
    frontFields.dateOfBirth ||
    combinedFields.dateOfBirth ||
    backFields.dateOfBirth;

  // 4a = issue, 4b = expiry — always; prefer front OCR
  const issueDate =
    frontFields.issueDate || combinedFields.issueDate || backFields.issueDate;
  const expiryDate =
    frontFields.expiryDate ||
    combinedFields.expiryDate ||
    backFields.expiryDate;

  const photoFallback: FaceBox = {
    left: 0.66,
    top: 0.14,
    width: 0.3,
    height: 0.56,
  };
  const signatureFallback: FaceBox = {
    left: 0.5,
    top: 0.74,
    width: 0.44,
    height: 0.18,
  };
  const qrFallback: FaceBox = {
    left: 0.07,
    top: 0.12,
    width: 0.24,
    height: 0.38,
  };

  const [holderPhotoDataUrl, holderSignatureDataUrl, qrCodeDataUrl] =
    await Promise.all([
      cropBoxToDataUrl(
        frontBuffer,
        frontAnalysis.holderPhotoBox,
        photoFallback
      ),
      cropBoxToDataUrl(
        frontBuffer,
        frontAnalysis.holderSignatureBox,
        signatureFallback
      ),
      cropBoxToDataUrl(backBuffer, qr.box, qrFallback),
    ]);

  return {
    fields: {
      ...mergeLicenseFields(combinedFields, frontFields, backFields),
      category,
      licenseNumber,
      surname,
      givenNames,
      placeOfBirth,
      residence,
      dateOfBirth,
      issueDate,
      expiryDate,
      issuingAuthority: ISSUING_AUTHORITY,
    },
    rawText: combinedText,
    frontText,
    backText,
    holderPhotoBox: frontAnalysis.holderPhotoBox,
    holderSignatureBox: frontAnalysis.holderSignatureBox,
    qrCodeBox: qr.box,
    qrCodeValue: qr.value,
    holderPhotoDataUrl,
    holderSignatureDataUrl,
    qrCodeDataUrl,
  };
}
