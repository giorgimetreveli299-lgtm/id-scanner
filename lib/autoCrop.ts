import { ImageAnnotatorClient, protos } from "@google-cloud/vision";
import path from "path";
import sharp from "sharp";
import { findQrPixelRect } from "@/lib/detectQr";

/** ISO ID-1 card ratio */
const LICENSE_RATIO = 85.6 / 53.98;

type Vertex = protos.google.cloud.vision.v1.IVertex;

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

function estimateSkewDegrees(
  annotations: protos.google.cloud.vision.v1.IEntityAnnotation[]
): number {
  const angles: number[] = [];

  for (const ann of annotations.slice(1)) {
    const v = ann.boundingPoly?.vertices;
    if (!v || v.length < 2) continue;
    const x0 = v[0].x ?? 0;
    const y0 = v[0].y ?? 0;
    const x1 = v[1].x ?? 0;
    const y1 = v[1].y ?? 0;
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 36) continue;

    let deg = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
    while (deg > 45) deg -= 90;
    while (deg < -45) deg += 90;
    if (Math.abs(deg) < 0.35) continue;
    angles.push(deg);
  }

  if (!angles.length) return 0;
  angles.sort((a, b) => a - b);
  const median = angles[Math.floor(angles.length / 2)] ?? 0;
  return Math.max(-45, Math.min(45, median));
}

function textUnionBox(
  annotations: protos.google.cloud.vision.v1.IEntityAnnotation[],
  imageWidth: number,
  imageHeight: number
): { left: number; top: number; width: number; height: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;

  for (const ann of annotations.slice(1)) {
    const vertices = ann.boundingPoly?.vertices as Vertex[] | undefined;
    if (!vertices?.length) continue;
    for (const p of vertices) {
      const x = p.x ?? 0;
      const y = p.y ?? 0;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count += 1;
    }
  }

  if (!count || !Number.isFinite(minX)) return null;

  // Extra horizontal pad: QR / photo sit outside OCR text and get clipped otherwise
  const padX = Math.max((maxX - minX) * 0.18, imageWidth * 0.06);
  const padY = Math.max((maxY - minY) * 0.14, imageHeight * 0.04);
  minX = Math.max(0, minX - padX);
  minY = Math.max(0, minY - padY);
  maxX = Math.min(imageWidth, maxX + padX);
  maxY = Math.min(imageHeight, maxY + padY);

  return {
    left: minX,
    top: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function fitLicenseAspect(
  box: { left: number; top: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number
) {
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  let width = box.width;
  let height = box.height;

  if (width / height > LICENSE_RATIO) {
    height = width / LICENSE_RATIO;
  } else {
    width = height * LICENSE_RATIO;
  }

  // Prefer covering the full card (QR / photo sit outside text)
  width *= 1.12;
  height *= 1.12;

  // Clamp to image by shrinking if needed
  if (width > imageWidth) {
    width = imageWidth;
    height = width / LICENSE_RATIO;
  }
  if (height > imageHeight) {
    height = imageHeight;
    width = height * LICENSE_RATIO;
  }

  let left = cx - width / 2;
  let top = cy - height / 2;
  left = Math.max(0, Math.min(left, imageWidth - width));
  top = Math.max(0, Math.min(top, imageHeight - height));

  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

function centerLicenseCrop(imageWidth: number, imageHeight: number) {
  let width: number;
  let height: number;
  if (imageWidth / imageHeight > LICENSE_RATIO) {
    height = imageHeight * 0.96;
    width = height * LICENSE_RATIO;
  } else {
    width = imageWidth * 0.96;
    height = width / LICENSE_RATIO;
  }
  return {
    left: Math.round((imageWidth - width) / 2),
    top: Math.round((imageHeight - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
}

type PixelRect = { left: number; top: number; width: number; height: number };

function expandCropToInclude(
  crop: PixelRect,
  include: PixelRect,
  imageWidth: number,
  imageHeight: number
): PixelRect {
  let left = Math.min(crop.left, include.left);
  let top = Math.min(crop.top, include.top);
  let right = Math.max(crop.left + crop.width, include.left + include.width);
  let bottom = Math.max(crop.top + crop.height, include.top + include.height);

  let width = right - left;
  let height = bottom - top;
  const cx = left + width / 2;
  const cy = top + height / 2;

  if (width / height > LICENSE_RATIO) {
    height = width / LICENSE_RATIO;
  } else {
    width = height * LICENSE_RATIO;
  }

  if (width > imageWidth) {
    width = imageWidth;
    height = width / LICENSE_RATIO;
  }
  if (height > imageHeight) {
    height = imageHeight;
    width = height * LICENSE_RATIO;
  }

  left = Math.max(0, Math.min(cx - width / 2, imageWidth - width));
  top = Math.max(0, Math.min(cy - height / 2, imageHeight - height));

  // If QR would still sit outside (clamped), pin crop to include it
  if (include.left < left) left = Math.max(0, include.left);
  if (include.top < top) top = Math.max(0, include.top);
  if (include.left + include.width > left + width) {
    left = Math.max(0, Math.min(include.left + include.width - width, imageWidth - width));
  }
  if (include.top + include.height > top + height) {
    top = Math.max(0, Math.min(include.top + include.height - height, imageHeight - height));
  }

  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

/** Auto straighten (deskew) + crop to ID-1 licence frame. */
export async function autoCropAndStraighten(
  imageBuffer: Buffer
): Promise<Buffer> {
  const vision = getClient();
  const [result] = await vision.documentTextDetection({
    image: { content: imageBuffer.toString("base64") },
  });

  const annotations = result.textAnnotations ?? [];
  const skew = estimateSkewDegrees(annotations);

  const rotatedBuf = await sharp(imageBuffer)
    .rotate(-skew, { background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .jpeg({ quality: 95 })
    .toBuffer();

  // Re-detect text on straightened image for a tighter crop
  const [rotatedResult] = await vision.documentTextDetection({
    image: { content: rotatedBuf.toString("base64") },
  });
  const meta = await sharp(rotatedBuf).metadata();
  const W = meta.width ?? 1;
  const H = meta.height ?? 1;

  const union = textUnionBox(rotatedResult.textAnnotations ?? [], W, H);
  let crop = union
    ? fitLicenseAspect(union, W, H)
    : centerLicenseCrop(W, H);

  // Keep QR fully inside the crop (Georgian DL back: QR is left of categories)
  const qrRect = await findQrPixelRect(rotatedBuf);
  if (qrRect) {
    crop = expandCropToInclude(crop, qrRect, W, H);
  }

  return sharp(rotatedBuf)
    .extract({
      left: crop.left,
      top: crop.top,
      width: Math.min(crop.width, W - crop.left),
      height: Math.min(crop.height, H - crop.top),
    })
    .jpeg({ quality: 92 })
    .toBuffer();
}
