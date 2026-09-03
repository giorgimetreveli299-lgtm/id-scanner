import {
  BinaryBitmap,
  HybridBinarizer,
  RGBLuminanceSource,
  QRCodeReader,
} from "@zxing/library";
import jsQR from "jsqr";
import sharp from "sharp";
import type { FaceBox } from "./types";

export type QrDetectResult = {
  box: FaceBox;
  value: string | null;
  /** How the box was obtained — layout fallback must not steer auto-crop. */
  source: "decoded" | "plate" | "layout";
};

/** True when QR was decoded or a white plate was found in the left column. */
export function qrIsOnLicenseBackLeft(result: {
  box: FaceBox | null;
  source: QrDetectResult["source"];
}): boolean {
  if (result.source === "layout" || !result.box) return false;
  const centerX = result.box.left + result.box.width / 2;
  return centerX <= 0.55;
}

type PixelBox = { minX: number; maxX: number; minY: number; maxY: number };

/** Georgian DL back: QR sits on a white plate in the left column. */
const LAYOUT_FALLBACK: FaceBox = {
  left: 0.07,
  top: 0.12,
  width: 0.24,
  height: 0.38,
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function normalizeBox(
  box: PixelBox,
  imageWidth: number,
  imageHeight: number
): FaceBox | null {
  if (!imageWidth || !imageHeight) return null;
  const left = clamp(box.minX, 0, imageWidth) / imageWidth;
  const top = clamp(box.minY, 0, imageHeight) / imageHeight;
  const right = clamp(box.maxX, 0, imageWidth) / imageWidth;
  const bottom = clamp(box.maxY, 0, imageHeight) / imageHeight;
  const width = right - left;
  const height = bottom - top;
  if (width < 0.02 || height < 0.02) return null;
  return { left, top, width, height };
}

/** Tight square crop around QR with quiet-zone margin (matches reference crop). */
function squareFaceBox(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  imageWidth: number,
  imageHeight: number,
  padRatio = 0.12
): FaceBox | null {
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const side = Math.max(w, h) * (1 + padRatio * 2);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return normalizeBox(
    {
      minX: cx - side / 2,
      maxX: cx + side / 2,
      minY: cy - side / 2,
      maxY: cy + side / 2,
    },
    imageWidth,
    imageHeight
  );
}

function layoutFallbackBox(imageWidth: number, imageHeight: number): FaceBox {
  // Keep visual square regardless of aspect ratio
  const widthPx = LAYOUT_FALLBACK.width * imageWidth;
  const heightPx = widthPx;
  const leftPx = LAYOUT_FALLBACK.left * imageWidth;
  const topPx = LAYOUT_FALLBACK.top * imageHeight;
  return (
    normalizeBox(
      {
        minX: leftPx,
        maxX: leftPx + widthPx,
        minY: topPx,
        maxY: topPx + heightPx,
      },
      imageWidth,
      imageHeight
    ) ?? LAYOUT_FALLBACK
  );
}

type RgbaPass = {
  data: Buffer;
  width: number;
  height: number;
  /** Map work-space coords → original image coords */
  toSrc: (x: number, y: number) => { x: number; y: number };
};

async function buildPasses(
  imageBuffer: Buffer,
  srcW: number,
  srcH: number
): Promise<RgbaPass[]> {
  const passes: RgbaPass[] = [];
  const scales = [1200, 900, 700];

  for (const maxSide of scales) {
    const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const inv = 1 / scale;

    const variants = [
      sharp(imageBuffer).resize(w, h, { fit: "fill" }),
      sharp(imageBuffer)
        .resize(w, h, { fit: "fill" })
        .greyscale()
        .normalize(),
      sharp(imageBuffer)
        .resize(w, h, { fit: "fill" })
        .greyscale()
        .normalize()
        .linear(1.35, -(128 * 0.35)),
    ];

    for (const pipeline of variants) {
      const { data, info } = await pipeline
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      passes.push({
        data,
        width: info.width,
        height: info.height,
        toSrc: (x, y) => ({ x: x * inv, y: y * inv }),
      });
    }

    // Left 48% only — Georgian QR lives in the left column
    const leftW = Math.max(1, Math.round(w * 0.48));
    const leftVariants = [
      sharp(imageBuffer)
        .resize(w, h, { fit: "fill" })
        .extract({ left: 0, top: 0, width: leftW, height: h }),
      sharp(imageBuffer)
        .resize(w, h, { fit: "fill" })
        .extract({ left: 0, top: 0, width: leftW, height: h })
        .greyscale()
        .normalize(),
    ];
    for (const pipeline of leftVariants) {
      const { data, info } = await pipeline
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      passes.push({
        data,
        width: info.width,
        height: info.height,
        toSrc: (x, y) => ({ x: x * inv, y: y * inv }),
      });
    }
  }

  return passes;
}

function tryJsQr(
  pass: RgbaPass
): { value: string; box: PixelBox } | null {
  const code = jsQR(
    new Uint8ClampedArray(
      pass.data.buffer,
      pass.data.byteOffset,
      pass.data.byteLength
    ),
    pass.width,
    pass.height,
    { inversionAttempts: "attemptBoth" }
  );
  if (!code) return null;

  const corners = [
    code.location.topLeftCorner,
    code.location.topRightCorner,
    code.location.bottomLeftCorner,
    code.location.bottomRightCorner,
  ].map((p) => pass.toSrc(p.x, p.y));

  return {
    value: code.data?.trim() || "",
    box: {
      minX: Math.min(...corners.map((c) => c.x)),
      maxX: Math.max(...corners.map((c) => c.x)),
      minY: Math.min(...corners.map((c) => c.y)),
      maxY: Math.max(...corners.map((c) => c.y)),
    },
  };
}

function tryZxing(pass: RgbaPass): { value: string; box: PixelBox } | null {
  try {
    const { width, height, data } = pass;
    const luminances = new Uint8ClampedArray(width * height);
    for (let i = 0, p = 0; i < luminances.length; i++, p += 4) {
      luminances[i] =
        (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    }
    const source = new RGBLuminanceSource(luminances, width, height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(source));
    const reader = new QRCodeReader();
    const result = reader.decode(bitmap);
    const points = result.getResultPoints?.() ?? [];
    if (points.length < 3) {
      return {
        value: result.getText()?.trim() || "",
        box: {
          minX: width * 0.1,
          maxX: width * 0.9,
          minY: height * 0.1,
          maxY: height * 0.9,
        },
      };
    }
    const mapped = points.map((pt) => pass.toSrc(pt.getX(), pt.getY()));
    return {
      value: result.getText()?.trim() || "",
      box: {
        minX: Math.min(...mapped.map((c) => c.x)),
        maxX: Math.max(...mapped.map((c) => c.x)),
        minY: Math.min(...mapped.map((c) => c.y)),
        maxY: Math.max(...mapped.map((c) => c.y)),
      },
    };
  } catch {
    return null;
  }
}

/**
 * Find the bright white QR plate in the left half when decode fails.
 * Looks for a high-contrast square block typical of Georgian DL QR.
 */
async function findWhiteQrPlate(
  imageBuffer: Buffer,
  srcW: number,
  srcH: number
): Promise<PixelBox | null> {
  const workW = Math.min(srcW, 640);
  const scale = workW / srcW;
  const workH = Math.max(1, Math.round(srcH * scale));

  const { data, info } = await sharp(imageBuffer)
    .resize(workW, workH, { fit: "fill" })
    .greyscale()
    .normalize()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const gray = data;
  const searchRight = Math.floor(w * 0.5);

  // Integral images for mean + variance of candidate windows
  const integral = new Float64Array((w + 1) * (h + 1));
  const integralSq = new Float64Array((w + 1) * (h + 1));
  const idx = (x: number, y: number) => y * (w + 1) + x;

  for (let y = 1; y <= h; y++) {
    let row = 0;
    let rowSq = 0;
    for (let x = 1; x <= w; x++) {
      const v = gray[(y - 1) * w + (x - 1)];
      row += v;
      rowSq += v * v;
      integral[idx(x, y)] = integral[idx(x, y - 1)] + row;
      integralSq[idx(x, y)] = integralSq[idx(x, y - 1)] + rowSq;
    }
  }

  const rectSum = (
    arr: Float64Array,
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ) =>
    arr[idx(x1, y1)] -
    arr[idx(x0, y1)] -
    arr[idx(x1, y0)] +
    arr[idx(x0, y0)];

  const minSide = Math.floor(Math.min(w, h) * 0.16);
  const maxSide = Math.floor(Math.min(w, h) * 0.55);
  let best: { score: number; box: PixelBox } | null = null;

  for (let side = maxSide; side >= minSide; side -= Math.max(4, Math.floor(side * 0.08))) {
    const step = Math.max(3, Math.floor(side * 0.12));
    for (let y0 = Math.floor(h * 0.04); y0 + side < h * 0.85; y0 += step) {
      for (let x0 = Math.floor(w * 0.02); x0 + side <= searchRight; x0 += step) {
        const x1 = x0 + side;
        const y1 = y0 + side;
        const n = side * side;
        const sum = rectSum(integral, x0, y0, x1, y1);
        const sumSq = rectSum(integralSq, x0, y0, x1, y1);
        const mean = sum / n;
        const variance = sumSq / n - mean * mean;
        // White QR plate: bright mean + high module contrast
        if (mean < 145 || variance < 900) continue;
        if (mean > 245 && variance < 1200) continue;

        // Prefer plates that are brighter than surrounding card pattern
        const border = Math.max(2, Math.floor(side * 0.08));
        const ox0 = Math.max(0, x0 - border);
        const oy0 = Math.max(0, y0 - border);
        const ox1 = Math.min(w, x1 + border);
        const oy1 = Math.min(h, y1 + border);
        const outerN = (ox1 - ox0) * (oy1 - oy0) - n;
        if (outerN < 1) continue;
        const outerSum =
          rectSum(integral, ox0, oy0, ox1, oy1) - sum;
        const outerMean = outerSum / outerN;
        if (mean < outerMean + 8) continue;

        const score = variance * 0.45 + (mean - outerMean) * 6 + side * 0.35;
        if (!best || score > best.score) {
          best = {
            score,
            box: { minX: x0, maxX: x1, minY: y0, maxY: y1 },
          };
        }
      }
    }
  }

  if (!best) return null;
  const inv = 1 / scale;
  return {
    minX: best.box.minX * inv,
    maxX: best.box.maxX * inv,
    minY: best.box.minY * inv,
    maxY: best.box.maxY * inv,
  };
}

/**
 * Locate the QR plate on a Georgian DL back and optionally decode it.
 * Always returns a box suitable for the dashboard QR slot.
 */
export async function detectQrOnLicenseBack(
  imageBuffer: Buffer
): Promise<QrDetectResult> {
  const meta = await sharp(imageBuffer).metadata();
  const srcW = meta.width ?? 1;
  const srcH = meta.height ?? 1;
  const fallback = layoutFallbackBox(srcW, srcH);

  try {
    const passes = await buildPasses(imageBuffer, srcW, srcH);

    for (const pass of passes) {
      const hit = tryJsQr(pass) ?? tryZxing(pass);
      if (!hit) continue;
      const box =
        squareFaceBox(
          hit.box.minX,
          hit.box.maxX,
          hit.box.minY,
          hit.box.maxY,
          srcW,
          srcH,
          0.14
        ) ?? fallback;
      return {
        box,
        value: hit.value || null,
        source: "decoded",
      };
    }

    const plate = await findWhiteQrPlate(imageBuffer, srcW, srcH);
    if (plate) {
      const box =
        squareFaceBox(
          plate.minX,
          plate.maxX,
          plate.minY,
          plate.maxY,
          srcW,
          srcH,
          0.1
        ) ?? fallback;
      return { box, value: null, source: "plate" };
    }

    return { box: fallback, value: null, source: "layout" };
  } catch {
    return { box: fallback, value: null, source: "layout" };
  }
}

/** Pixel rect of a real QR hit for auto-crop; null if only layout guess. */
export async function findQrPixelRect(
  imageBuffer: Buffer
): Promise<{ left: number; top: number; width: number; height: number } | null> {
  const meta = await sharp(imageBuffer).metadata();
  const W = meta.width ?? 1;
  const H = meta.height ?? 1;
  const detected = await detectQrOnLicenseBack(imageBuffer);
  if (detected.source === "layout") return null;
  const { box } = detected;
  return {
    left: Math.round(box.left * W),
    top: Math.round(box.top * H),
    width: Math.max(1, Math.round(box.width * W)),
    height: Math.max(1, Math.round(box.height * H)),
  };
}
