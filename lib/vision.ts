import { ImageAnnotatorClient, protos } from "@google-cloud/vision";
import path from "path";
import {
  ALLOWED_CATEGORIES,
  mergeLicenseFields,
  parseLicenseText,
  type LicenseFields,
} from "@/lib/parseLicense";
import { detectQrOnLicenseBack } from "@/lib/detectQr";
import type { FaceBox } from "@/lib/types";

export type { FaceBox };

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
};

function getCredentialsPath(): string {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
  return path.join(process.cwd(), "clientdocsocr.json");
}

let client: ImageAnnotatorClient | null = null;

function getClient(): ImageAnnotatorClient {
  if (!client) {
    client = new ImageAnnotatorClient({
      keyFilename: getCredentialsPath(),
    });
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

  const dates = items.filter((i) => isCategoryDateToken(i.text));
  if (!dates.length) return null;

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

  // Column 9 is on the left/center of the table; keep top-to-bottom order
  const leftBound = imageWidth * 0.78;
  const ranked = [...codeHits].sort(
    (a, b) => a.item.cy - b.item.cy || a.item.cx - b.item.cx
  );

  const found: string[] = [];
  const maxGapX = Math.max(140, imageWidth * 0.6);

  for (const { code, item } of ranked) {
    if (item.cx > leftBound) continue;
    const rowTol = Math.max(18, (item.maxY - item.minY) * 1.6);

    const hasDateToRight = dates.some((d) => {
      if (d.cx <= item.cx + 4) return false; // cols 10/11 sit to the right
      if (d.minX - item.maxX > maxGapX) return false;
      return Math.abs(d.cy - item.cy) <= rowTol;
    });

    if (hasDateToRight && !found.includes(code)) found.push(code);
  }

  return found.length ? found.join(" ") : null;
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

  const text =
    result.fullTextAnnotation?.text?.trim() ||
    result.textAnnotations?.[0]?.description?.trim() ||
    "";

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

  let best = faces[0];
  let bestArea = 0;
  for (const face of faces) {
    const v = face.boundingPoly?.vertices ?? [];
    if (v.length < 2) continue;
    const xs = v.map((p) => p.x ?? 0);
    const ys = v.map((p) => p.y ?? 0);
    const area =
      (Math.max(...xs) - Math.min(...xs)) *
      (Math.max(...ys) - Math.min(...ys));
    if (area > bestArea) {
      bestArea = area;
      best = face;
    }
  }

  return boxFromVertices(
    best.boundingPoly?.vertices,
    dims.width,
    dims.height
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
  const text =
    result.fullTextAnnotation?.text?.trim() ||
    result.textAnnotations?.[0]?.description?.trim() ||
    "";

  const parsed = text ? parseLicenseText(text) : parseLicenseText("");
  const licenseNumberHint = parsed.licenseNumber;

  const holderSignatureBox = detectSignatureBoxFromAnnotations(
    result.textAnnotations ?? [],
    dims,
    licenseNumberHint
  );

  return {
    text,
    holderPhotoBox: photoBox,
    holderSignatureBox,
    licenseNumberHint,
  };
}

async function detectQrOnBack(imageBuffer: Buffer): Promise<{
  box: FaceBox | null;
  value: string | null;
}> {
  const result = await detectQrOnLicenseBack(imageBuffer);
  return { box: result.box, value: result.value };
}

export async function scanLicenseSides(
  frontBuffer: Buffer,
  backBuffer: Buffer
): Promise<ScanResult> {
  const [frontAnalysis, backAnalysis, qr] = await Promise.all([
    analyzeFront(frontBuffer),
    analyzeBack(backBuffer),
    detectQrOnBack(backBuffer).catch(() => ({ box: null, value: null })),
  ]);

  const frontText = frontAnalysis.text;
  const backText = backAnalysis.text;

  if (!frontText && !backText) {
    throw new Error("Could not read any text. Try clearer photos of both sides.");
  }

  const frontFields = frontText
    ? parseLicenseText(frontText)
    : parseLicenseText("");
  const backFields = backText ? parseLicenseText(backText) : parseLicenseText("");
  const combinedText = [frontText, backText].filter(Boolean).join("\n\n---\n\n");
  const combinedFields = parseLicenseText(combinedText);

  // Prefer spatial table read (col 9 codes with dates in 10/11), then text parsers
  const category =
    backAnalysis.categoryFromTable ||
    backFields.category ||
    frontFields.category ||
    combinedFields.category;

  const licenseNumber =
    frontFields.licenseNumber ||
    frontAnalysis.licenseNumberHint ||
    combinedFields.licenseNumber ||
    backFields.licenseNumber;

  // Field 1 (surname) is on the front — prefer front OCR ("1. ქვათაძე / Kvatadze")
  const surname =
    frontFields.surname || combinedFields.surname || backFields.surname;

  // Field 2 (given names) is on the front — prefer front OCR ("2. ქეთევანი / Ketevani")
  const givenNames =
    frontFields.givenNames ||
    combinedFields.givenNames ||
    backFields.givenNames;

  // Field 3 place of birth sits beside the DOB on the front
  const placeOfBirth =
    frontFields.placeOfBirth ||
    combinedFields.placeOfBirth ||
    backFields.placeOfBirth;

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

  return {
    fields: {
      ...mergeLicenseFields(combinedFields, frontFields, backFields),
      category,
      licenseNumber,
      surname,
      givenNames,
      placeOfBirth,
      dateOfBirth,
      issueDate,
      expiryDate,
    },
    rawText: combinedText,
    frontText,
    backText,
    holderPhotoBox: frontAnalysis.holderPhotoBox,
    holderSignatureBox: frontAnalysis.holderSignatureBox,
    qrCodeBox: qr.box,
    qrCodeValue: qr.value,
  };
}
