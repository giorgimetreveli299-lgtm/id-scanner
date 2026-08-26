import { ImageAnnotatorClient, protos } from "@google-cloud/vision";
import fs from "fs";
import jsQR from "jsqr";
import path from "path";
import sharp from "sharp";

/** ISO ID-1 card ratio */
const LICENSE_RATIO = 85.6 / 53.98;
const ANALYZE_MAX_SIDE = 1280;

type Vertex = protos.google.cloud.vision.v1.IVertex;
type PixelRect = { left: number; top: number; width: number; height: number };

let client: ImageAnnotatorClient | null = null;

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
    if (len < 28) continue;

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
): PixelRect | null {
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

  // Wide pad so QR / photo outside text are not clipped (esp. back side)
  const padX = Math.max((maxX - minX) * 0.22, imageWidth * 0.08);
  const padY = Math.max((maxY - minY) * 0.18, imageHeight * 0.06);
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

function cropHintBox(
  result: protos.google.cloud.vision.v1.IAnnotateImageResponse,
  imageWidth: number,
  imageHeight: number
): PixelRect | null {
  const hint = result.cropHintsAnnotation?.cropHints?.[0];
  const vertices = hint?.boundingPoly?.vertices as Vertex[] | undefined;
  if (!vertices?.length) return null;

  const xs = vertices.map((v) => v.x ?? 0);
  const ys = vertices.map((v) => v.y ?? 0);
  const minX = Math.max(0, Math.min(...xs));
  const maxX = Math.min(imageWidth, Math.max(...xs));
  const minY = Math.max(0, Math.min(...ys));
  const maxY = Math.min(imageHeight, Math.max(...ys));
  const width = maxX - minX;
  const height = maxY - minY;
  if (width < imageWidth * 0.25 || height < imageHeight * 0.25) return null;

  return { left: minX, top: minY, width, height };
}

function fitLicenseAspect(
  box: PixelRect,
  imageWidth: number,
  imageHeight: number,
  grow = 1.1
): PixelRect {
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  let width = box.width;
  let height = box.height;

  if (width / height > LICENSE_RATIO) {
    height = width / LICENSE_RATIO;
  } else {
    width = height * LICENSE_RATIO;
  }

  width *= grow;
  height *= grow;

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

function centerLicenseCrop(imageWidth: number, imageHeight: number): PixelRect {
  let width: number;
  let height: number;
  if (imageWidth / imageHeight > LICENSE_RATIO) {
    height = imageHeight * 0.94;
    width = height * LICENSE_RATIO;
  } else {
    width = imageWidth * 0.94;
    height = width / LICENSE_RATIO;
  }
  return {
    left: Math.round((imageWidth - width) / 2),
    top: Math.round((imageHeight - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
}

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

  if (include.left < left) left = Math.max(0, include.left);
  if (include.top < top) top = Math.max(0, include.top);
  if (include.left + include.width > left + width) {
    left = Math.max(
      0,
      Math.min(include.left + include.width - width, imageWidth - width)
    );
  }
  if (include.top + include.height > top + height) {
    top = Math.max(
      0,
      Math.min(include.top + include.height - height, imageHeight - height)
    );
  }

  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

/** One fast jsQR pass (left half) — for auto-crop only, not full decode pipeline. */
async function findQrFast(imageBuffer: Buffer): Promise<PixelRect | null> {
  try {
    const meta = await sharp(imageBuffer).metadata();
    const srcW = meta.width ?? 1;
    const srcH = meta.height ?? 1;
    const scale = Math.min(1, 900 / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const leftW = Math.max(1, Math.round(w * 0.55));

    const { data, info } = await sharp(imageBuffer)
      .resize(w, h, { fit: "fill" })
      .extract({ left: 0, top: 0, width: leftW, height: h })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const code = jsQR(
      new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
      info.width,
      info.height,
      { inversionAttempts: "attemptBoth" }
    );
    if (!code) return null;

    const inv = 1 / scale;
    const xs = [
      code.location.topLeftCorner.x,
      code.location.topRightCorner.x,
      code.location.bottomLeftCorner.x,
      code.location.bottomRightCorner.x,
    ].map((x) => x * inv);
    const ys = [
      code.location.topLeftCorner.y,
      code.location.topRightCorner.y,
      code.location.bottomLeftCorner.y,
      code.location.bottomRightCorner.y,
    ].map((y) => y * inv);

    const pad = Math.max(
      10,
      Math.round(
        Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) *
          0.2
      )
    );
    const left = Math.max(0, Math.min(...xs) - pad);
    const top = Math.max(0, Math.min(...ys) - pad);
    const right = Math.min(srcW, Math.max(...xs) + pad);
    const bottom = Math.min(srcH, Math.max(...ys) + pad);
    return {
      left,
      top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    };
  } catch {
    return null;
  }
}

function scaleRect(rect: PixelRect, scale: number): PixelRect {
  return {
    left: Math.round(rect.left * scale),
    top: Math.round(rect.top * scale),
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale)),
  };
}

/**
 * Fast auto straighten + crop to ID-1 frame.
 * One Vision call on a downscaled image; optional quick QR expand for the back.
 */
export async function autoCropAndStraighten(
  imageBuffer: Buffer
): Promise<Buffer> {
  const metaIn = await sharp(imageBuffer).metadata();
  const srcW = metaIn.width ?? 1;
  const srcH = metaIn.height ?? 1;
  const analyzeScale = Math.min(1, ANALYZE_MAX_SIDE / Math.max(srcW, srcH));

  const analyzeBuf = await sharp(imageBuffer)
    .rotate() // honour EXIF
    .resize({
      width: Math.round(srcW * analyzeScale),
      height: Math.round(srcH * analyzeScale),
      fit: "fill",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer();

  const analyzeMeta = await sharp(analyzeBuf).metadata();
  const aW = analyzeMeta.width ?? 1;
  const aH = analyzeMeta.height ?? 1;

  const vision = getClient();
  const [result] = await vision.annotateImage({
    image: { content: analyzeBuf.toString("base64") },
    features: [
      { type: "DOCUMENT_TEXT_DETECTION" },
      { type: "CROP_HINTS", maxResults: 1 },
    ],
    imageContext: {
      cropHintsParams: { aspectRatios: [LICENSE_RATIO] },
    },
  });

  const skew = estimateSkewDegrees(result.textAnnotations ?? []);

  let cropSrc = analyzeBuf;
  let cropW = aW;
  let cropH = aH;
  let cropAnnotations = result.textAnnotations ?? [];
  let cropHintsResult = result;

  // If noticeably skewed, deskew the small image and re-read bounds (still cheap)
  if (Math.abs(skew) >= 1.0) {
    cropSrc = await sharp(analyzeBuf)
      .rotate(-skew, { background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .jpeg({ quality: 85 })
      .toBuffer();
    const cm = await sharp(cropSrc).metadata();
    cropW = cm.width ?? aW;
    cropH = cm.height ?? aH;
    const [r2] = await vision.annotateImage({
      image: { content: cropSrc.toString("base64") },
      features: [
        { type: "DOCUMENT_TEXT_DETECTION" },
        { type: "CROP_HINTS", maxResults: 1 },
      ],
      imageContext: {
        cropHintsParams: { aspectRatios: [LICENSE_RATIO] },
      },
    });
    cropAnnotations = r2.textAnnotations ?? [];
    cropHintsResult = r2;
  }

  const rotatedFull = await sharp(imageBuffer)
    .rotate()
    .rotate(-skew, { background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .jpeg({ quality: 92 })
    .toBuffer();

  const fullMeta = await sharp(rotatedFull).metadata();
  const W = fullMeta.width ?? 1;
  const H = fullMeta.height ?? 1;
  const up = Math.max(W / cropW, H / cropH);

  const hint = cropHintBox(cropHintsResult, cropW, cropH);
  const union = textUnionBox(cropAnnotations, cropW, cropH);
  let cropAnalyze: PixelRect;
  if (hint && union) {
    cropAnalyze = {
      left: Math.min(hint.left, union.left),
      top: Math.min(hint.top, union.top),
      width:
        Math.max(hint.left + hint.width, union.left + union.width) -
        Math.min(hint.left, union.left),
      height:
        Math.max(hint.top + hint.height, union.top + union.height) -
        Math.min(hint.top, union.top),
    };
    cropAnalyze = fitLicenseAspect(cropAnalyze, cropW, cropH, 1.08);
  } else if (hint) {
    cropAnalyze = fitLicenseAspect(hint, cropW, cropH, 1.06);
  } else if (union) {
    cropAnalyze = fitLicenseAspect(union, cropW, cropH, 1.12);
  } else {
    cropAnalyze = centerLicenseCrop(cropW, cropH);
  }

  let crop = scaleRect(cropAnalyze, up);
  crop = {
    left: Math.max(0, Math.min(crop.left, W - 1)),
    top: Math.max(0, Math.min(crop.top, H - 1)),
    width: Math.min(crop.width, W - crop.left),
    height: Math.min(crop.height, H - crop.top),
  };
  crop = fitLicenseAspect(crop, W, H, 1.0);

  const qrRect = await Promise.race([
    findQrFast(rotatedFull),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
  ]);
  if (qrRect) {
    crop = expandCropToInclude(crop, qrRect, W, H);
  }

  return sharp(rotatedFull)
    .extract({
      left: crop.left,
      top: crop.top,
      width: Math.min(crop.width, W - crop.left),
      height: Math.min(crop.height, H - crop.top),
    })
    .jpeg({ quality: 90 })
    .toBuffer();
}
