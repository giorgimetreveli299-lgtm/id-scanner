/** Document crop. The car photo guide does not use this file. */
const LICENSE_ASPECT = 85.6 / 54;
const LICENSE_SCAN_WIDTH = 1400;

/** True if image border looks like a white / very light background. */
function borderLooksWhite(gray, w, h) {
  const band = Math.max(2, Math.floor(Math.min(w, h) * 0.07));
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= band && x < w - band && y >= band && y < h - band) continue;
      sum += gray[y * w + x];
      n++;
    }
  }
  return n > 0 && sum / n >= 205;
}

/** Pull mask back from its edges so a thin ring next to the card survives. */
function erodeMask(mask, w, h, rounds) {
  let cur = mask;
  for (let r = 0; r < rounds; r++) {
    const next = new Uint8Array(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!cur[i]) continue;
        const up = y > 0 ? cur[i - w] : 1;
        const down = y < h - 1 ? cur[i + w] : 1;
        const left = x > 0 ? cur[i - 1] : 1;
        const right = x < w - 1 ? cur[i + 1] : 1;
        if (!up || !down || !left || !right) next[i] = 0;
      }
    }
    cur = next;
  }
  return cur;
}

/**
 * Flood-fill near-white pixels connected to the image border.
 * Returns Uint8Array mask (1 = background to paint black).
 */
function floodWhiteBackgroundMask(rgba, w, h, thresh) {
  const mask = new Uint8Array(w * h);
  const seen = new Uint8Array(w * h);
  const stack = [];

  const bright = (i) => {
    const o = i * 4;
    return 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2] >= thresh;
  };

  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (seen[i]) return;
    seen[i] = 1;
    if (!bright(i)) return;
    mask[i] = 1;
    stack.push(i);
  };

  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }

  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i / w) | 0;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  return mask;
}

/**
 * Build a TEMP analysis image only (never used as final crop pixels):
 * - black padding
 * - optional outer-band white→black to help find the card contour
 * Original bitmap is never modified.
 */
async function buildAnalysisBlackBg(bitmap) {
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const pad = Math.max(32, Math.round(Math.min(srcW, srcH) * 0.06));

  const maxSide = 360;
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const sw = Math.max(2, Math.round(srcW * scale));
  const sh = Math.max(2, Math.round(srcH * scale));

  const sample = document.createElement("canvas");
  sample.width = sw;
  sample.height = sh;
  const sctx = sample.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(bitmap, 0, 0, sw, sh);
  const sampleData = sctx.getImageData(0, 0, sw, sh);
  const gray = new Float32Array(sw * sh);
  for (let i = 0, p = 0; i < sampleData.data.length; i += 4, p++) {
    gray[p] = 0.299 * sampleData.data[i] + 0.587 * sampleData.data[i + 1] + 0.114 * sampleData.data[i + 2];
  }

  const whiteBg = borderLooksWhite(gray, sw, sh);

  const out = document.createElement("canvas");
  out.width = srcW + pad * 2;
  out.height = srcH + pad * 2;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, out.width, out.height);
  // Draw ORIGINAL pixels unchanged into analysis canvas
  ctx.drawImage(bitmap, pad, pad);

  if (whiteBg) {
    // Only darken outer band of white background on the ANALYSIS copy.
    // High threshold + erosion keep the card's own light edge out of the mask,
    // otherwise the detected contour eats into the card (over-crop on white desks).
    let mask = floodWhiteBackgroundMask(sampleData.data, sw, sh, 234);
    mask = erodeMask(mask, sw, sh, 2);
    const bx = Math.max(2, Math.floor(sw * 0.11));
    const by = Math.max(2, Math.floor(sh * 0.11));
    for (let y = by; y < sh - by; y++) {
      for (let x = bx; x < sw - bx; x++) {
        mask[y * sw + x] = 0; // never touch card interior on analysis either
      }
    }

    const id = ctx.getImageData(pad, pad, srcW, srcH);
    const px = id.data;
    for (let y = 0; y < srcH; y++) {
      const my = Math.min(sh - 1, Math.floor(y * scale));
      for (let x = 0; x < srcW; x++) {
        const mx = Math.min(sw - 1, Math.floor(x * scale));
        if (!mask[my * sw + mx]) continue;
        const i = (y * srcW + x) * 4;
        px[i] = 0;
        px[i + 1] = 0;
        px[i + 2] = 0;
      }
    }
    ctx.putImageData(id, pad, pad);
  }

  const analysisBitmap = await toDrawableBitmap(out);
  return { analysisBitmap, pad, whiteBg };
}

/** Straighten tilted photo without cropping to document contour. */
async function deskewBitmapOnly(bitmap) {
  const analysis = analyzeForDeskew(bitmap);
  const angle = analysis.angle;
  // Conservative: only small confident corrections
  if (Math.abs(angle) < 1.2 || !analysis.confident) {
    return canvasToJpeg(bitmap, 0, 0, bitmap.width, bitmap.height);
  }

  const rotated = await rotateBitmap(bitmap, -angle);
  const result = await canvasToJpeg(rotated, 0, 0, rotated.width, rotated.height);
  if (typeof rotated.close === "function") rotated.close();
  return result;
}

/** Analyze image and return deskew angle only if clearly better than original. */
function analyzeForDeskew(bitmap) {
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const maxSide = 420;
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const w = Math.max(2, Math.round(srcW * scale));
  const h = Math.max(2, Math.round(srcH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const gray = new Float32Array(w * h);
  let sumG = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    gray[p] = g;
    sumG += g;
  }
  const meanG = sumG / gray.length;
  const blur = boxBlurGray(gray, w, h, Math.max(2, Math.round(Math.min(w, h) * 0.03)));
  const ID_ASPECT = 85.6 / 54;

  let best = findBestIdWindow(blur, w, h, ID_ASPECT);
  const brightBox = findBrightCardBox(blur, gray, w, h, meanG, ID_ASPECT);
  if (brightBox && (!best || brightBox.score > best.score)) best = brightBox;
  const edgeBox = findEdgeCardBox(gray, w, h, ID_ASPECT);
  if (edgeBox && (!best || edgeBox.score > best.score * 1.05)) best = edgeBox;
  if (!best) {
    return { angle: 0, confident: false };
  }

  return estimateDeskewAngle(gray, w, h, best);
}

/** Auto-crop ID card tightly — remove patterned/dark backgrounds. */
/**
 * Detect ID box on an analysis image (may have black assist bg).
 * Returns { best, gray, blur, meanG, w, h, scale } or best=null.
 */
function detectCardBoxOnBitmap(analysisBitmap, aspectRatio) {
  const srcW = analysisBitmap.width;
  const srcH = analysisBitmap.height;
  const maxSide = 480;
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const w = Math.max(2, Math.round(srcW * scale));
  const h = Math.max(2, Math.round(srcH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(analysisBitmap, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const gray = new Float32Array(w * h);
  let sumG = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    gray[p] = g;
    sumG += g;
  }
  const meanG = sumG / gray.length;
  const blur = boxBlurGray(gray, w, h, Math.max(2, Math.round(Math.min(w, h) * 0.03)));
  const ID_ASPECT = aspectRatio || 85.6 / 54;

  let best = findBestIdWindow(blur, w, h, ID_ASPECT);
  const brightBox = findBrightCardBox(blur, gray, w, h, meanG, ID_ASPECT);
  if (brightBox && (!best || brightBox.score > best.score)) best = brightBox;
  const edgeBox = findEdgeCardBox(gray, w, h, ID_ASPECT);
  if (edgeBox && (!best || edgeBox.score > best.score * 1.05)) best = edgeBox;

  return { best, gray, blur, meanG, w, h, scale, ID_ASPECT };
}

/**
 * Crop to document. Black-bg assist is ONLY for finding the contour —
 * final JPEG pixels always come from the unmodified original (or its rotate).
 * Tilts are corrected toward a flat ID-aspect rectangle (like a straight scan).
 *
 * options.passport — slightly easier warp acceptance + deskew for biodata pages.
 * options.idCard — tighter full-bleed crop (match flat ID front/back scans).
 * options.protectMrz — keep extra bottom margin; skip aggressive border trim (ID back).
 */
async function cropDocumentBitmap(bitmap, aspectRatio, options = {}) {
  // ID aspect stays 85.6/54 unless caller (passport) passes another ratio
  const ID_ASPECT = aspectRatio || 85.6 / 54;
  const passport = !!options.passport;
  const licenseScan = !!options.licenseScan;
  const idCard = !!options.idCard || licenseScan || (!passport && !aspectRatio);
  const protectMrz = !!options.protectMrz;
  let analysisTemps = [];

  const closeTemp = (bmp) => {
    if (bmp && typeof bmp.close === "function") {
      try { bmp.close(); } catch (_) {}
    }
  };

  const analyze = async (origBmp) => {
    const assist = await buildAnalysisBlackBg(origBmp);
    analysisTemps.push(assist.analysisBitmap);
    const det = detectCardBoxOnBitmap(assist.analysisBitmap, ID_ASPECT);
    return {
      ...det,
      pad: assist.pad,
      whiteBg: assist.whiteBg,
      assistBitmap: assist.analysisBitmap,
    };
  };

  // Map analysis-full-res crop rect → original bitmap coords
  const mapToOriginal = (minX, minY, maxX, maxY, scale, pad, origW, origH) => {
    let sx = Math.floor(minX / scale) - pad;
    let sy = Math.floor(minY / scale) - pad;
    let ex = Math.ceil((maxX + 1) / scale) - pad;
    let ey = Math.ceil((maxY + 1) / scale) - pad;
    sx = Math.max(0, Math.min(origW - 1, sx));
    sy = Math.max(0, Math.min(origH - 1, sy));
    ex = Math.max(sx + 1, Math.min(origW, ex));
    ey = Math.max(sy + 1, Math.min(origH, ey));
    return { sx, sy, sw: ex - sx, sh: ey - sy };
  };

  const mapPtToOriginal = (x, y, scale, pad, origW, origH) => ({
    x: Math.max(0, Math.min(origW - 1, x / scale - pad)),
    y: Math.max(0, Math.min(origH - 1, y / scale - pad)),
  });

  let workingOrig = bitmap;
  let rotatedExtra = null;
  let warpedExtra = null;
  let turnedExtra = null;
  let straightenShot = null; // jpeg after straighten only (before crop)
  let det = await analyze(workingOrig);

  const cleanupTemps = () => {
    for (const t of analysisTemps) closeTemp(t);
    analysisTemps = [];
    closeTemp(rotatedExtra);
    closeTemp(warpedExtra);
    closeTemp(turnedExtra);
  };

  // Sideways capture: the card box only matches inside a landscape frame,
  // so give the detector a quarter-turned copy before giving up.
  if (!det.best) {
    const turned = await rotateBitmap(workingOrig, 90);
    const turnedDet = await analyze(turned);
    if (turnedDet.best) {
      turnedExtra = turned;
      workingOrig = turned;
      det = turnedDet;
      straightenShot = await canvasToJpeg(turned, 0, 0, turned.width, turned.height);
    } else {
      closeTemp(turned);
    }
  }

  // 1) Perspective straighten when we can lock onto the 4 card corners
  if (det.best) {
    const quadA = findCardQuad(det.gray, det.w, det.h, det.best);
    if (quadA) {
      const quadOrig = quadA.map((p) =>
        mapPtToOriginal(p.x, p.y, det.scale, det.pad, workingOrig.width, workingOrig.height)
      );
      if (isPlausibleCardQuad(quadOrig, workingOrig.width, workingOrig.height, ID_ASPECT, {
        passport,
      })) {
        try {
          warpedExtra = await warpQuadToIdBitmap(workingOrig, quadOrig, ID_ASPECT, {
            targetWidth: licenseScan ? LICENSE_SCAN_WIDTH : undefined,
          });
          let result = await canvasToJpeg(
            warpedExtra, 0, 0, warpedExtra.width, warpedExtra.height
          );
          // Never run aggressive border trim on ID back — MRZ lives on the bottom edge
          if (idCard && !protectMrz) {
            result = await trimIdScanBorders(result, ID_ASPECT);
          }
          cleanupTemps();
          // Warp already straightens + crops to ID aspect
          return { ...result, straighten: result };
        } catch (err) {
          console.warn("perspective warp failed, falling back:", err);
        }
      }
    }
  }

  // 2) Fallback: rotate deskew + axis-aligned crop
  if (det.best) {
    const skew = estimateDeskewAngle(det.gray, det.w, det.h, det.best);
    const minSkew = passport ? 0.5 : 0.6;
    if (skew.confident && Math.abs(skew.angle) >= minSkew) {
      rotatedExtra = await rotateBitmap(workingOrig, -skew.angle);
      workingOrig = rotatedExtra;
      straightenShot = await canvasToJpeg(
        workingOrig, 0, 0, workingOrig.width, workingOrig.height
      );
      det = await analyze(workingOrig);
    }
  }

  const outW = workingOrig.width;
  const outH = workingOrig.height;

  if (!det.best) {
    const fallback = await canvasToJpeg(workingOrig, 0, 0, outW, outH);
    cleanupTemps();
    return { ...fallback, straighten: straightenShot || fallback };
  }

  let { minX, minY, maxX, maxY } = tightenCardBox(
    det.blur, det.gray, det.w, det.h, det.best, det.meanG, { idCard, protectMrz }
  );

  // Prefer full-bleed card (reference scans have almost no desk margin).
  // ID back keeps a larger bottom pad so the MRZ strip is never shaved.
  const padRatio = licenseScan
    ? (det.whiteBg ? 0.003 : 0.001)
    : idCard
    ? (det.whiteBg ? 0.008 : 0.004)
    : (det.whiteBg ? 0.03 : 0.015);
  const padX = Math.max(1, Math.round((maxX - minX) * padRatio));
  const padY = Math.max(1, Math.round((maxY - minY) * padRatio));
  const padBottom = protectMrz
    ? Math.max(padY, Math.round((maxY - minY) * 0.035))
    : padY;
  minX = Math.max(0, minX - padX);
  minY = Math.max(0, minY - padY);
  maxX = Math.min(det.w - 1, maxX + padX);
  maxY = Math.min(det.h - 1, maxY + padBottom);

  const { sx, sy, sw, sh } = mapToOriginal(
    minX, minY, maxX, maxY, det.scale, det.pad, outW, outH
  );

  if (sw < outW * 0.12 || sh < outH * 0.08) {
    const fallback = await canvasToJpeg(workingOrig, 0, 0, outW, outH);
    cleanupTemps();
    return { ...fallback, straighten: straightenShot || fallback };
  }

  // Crop from ORIGINAL pixels only — analysis black paint never reaches output
  let result = await rectifyToIdAspect(workingOrig, sx, sy, sw, sh, ID_ASPECT, {
    targetWidth: licenseScan ? LICENSE_SCAN_WIDTH : undefined,
    fillColor: licenseScan ? "#ffffff" : "#111111",
  });
  if (idCard && !protectMrz) {
    result = await trimIdScanBorders(result, ID_ASPECT);
  }
  cleanupTemps();
  return { ...result, straighten: straightenShot || result };
}

/** Brighten a processed JPEG for better OCR readability. */
async function applyBrightnessToResult(result, amount = 1.04) {
  const bmp = await toDrawableBitmap(result.blob);
  try {
    const out = document.createElement("canvas");
    out.width = bmp.width;
    out.height = bmp.height;
    const ctx = out.getContext("2d");
    ctx.filter = `brightness(${amount}) contrast(1.01)`;
    ctx.drawImage(bmp, 0, 0);
    ctx.filter = "none";
    return await canvasToJpeg(out, 0, 0, out.width, out.height);
  } finally {
    if (typeof bmp.close === "function") {
      try { bmp.close(); } catch (_) {}
    }
  }
}

/** Georgian REMARKS page wash — lavender/magenta (low green, mid luminance). */
function isRemarksPurple(r, g, b) {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum < 70 || lum > 210) return false;
  // Classic blue-purple header OR pink-lavender illustration wash
  if (b > r + 12 && b > g + 8 && b > 90) return true;
  if (g + 14 < r && g + 14 < b && Math.max(r, b) > 110) return true;
  return false;
}

/**
 * Score a horizontal band: MRZ-like dense dark text near the bottom of biodata,
 * vs purple/lavender REMARKS wash on page 03.
 */
function scorePassportHalf(rgba, w, h, y0, y1) {
  let purple = 0;
  let dark = 0;
  let edge = 0;
  let n = 0;
  const yStart = Math.max(0, y0 | 0);
  const yEnd = Math.min(h, y1 | 0);
  for (let y = yStart; y < yEnd; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      n++;
      if (lum < 70) dark++;
      if (isRemarksPurple(r, g, b)) purple++;
      if (x + 2 < w) {
        const i2 = (y * w + x + 2) * 4;
        const lum2 = 0.299 * rgba[i2] + 0.587 * rgba[i2 + 1] + 0.114 * rgba[i2 + 2];
        if (Math.abs(lum - lum2) > 40) edge++;
      }
    }
  }
  if (!n) return { purple: 0, dark: 0, edge: 0, mrz: 0 };
  // MRZ sits in the lower ~30% of the biodata page — dense dark + edges
  const bandH = Math.max(1, yEnd - yStart);
  const mrzY0 = yStart + Math.floor(bandH * 0.65);
  let mrzDark = 0;
  let mrzN = 0;
  for (let y = mrzY0; y < yEnd; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      mrzN++;
      if (lum < 85) mrzDark++;
    }
  }
  return {
    purple: purple / n,
    dark: dark / n,
    edge: edge / n,
    mrz: mrzN ? mrzDark / mrzN : 0,
  };
}

function scorePassportVStrip(rgba, w, h, x0, x1) {
  let purple = 0;
  let n = 0;
  let mrzDark = 0;
  let mrzN = 0;
  const xa = Math.max(0, x0 | 0);
  const xb = Math.min(w, x1 | 0);
  const mrzY0 = Math.floor(h * 0.55);
  for (let y = 0; y < h; y += 2) {
    for (let x = xa; x < xb; x += 2) {
      const i = (y * w + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      n++;
      if (isRemarksPurple(r, g, b)) purple++;
      if (y >= mrzY0) {
        mrzN++;
        if (lum < 85) mrzDark++;
      }
    }
  }
  return {
    purple: n ? purple / n : 0,
    mrz: mrzN ? mrzDark / mrzN : 0,
  };
}

/**
 * Drop REMARKS (შენიშვნები / page 03) when the open book clearly has two pages.
 * Returns { bitmap, cropped }. Never blind-crops a single biodata page.
 */
async function isolatePassportBiodataBitmap(bitmap) {
  const w = bitmap.width;
  const h = bitmap.height;
  if (!w || !h) return { bitmap, cropped: false };

  const maxSide = 420;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const aw = Math.max(2, Math.round(w * scale));
  const ah = Math.max(2, Math.round(h * scale));
  const c = document.createElement("canvas");
  c.width = aw;
  c.height = ah;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, aw, ah);
  const { data } = ctx.getImageData(0, 0, aw, ah);

  const aspect = w / h;
  let sx = 0;
  let sy = 0;
  let sw = w;
  let sh = h;
  let cut = false;

  if (aspect < 0.95) {
    // Tall open book: REMARKS on top, biodata (+ MRZ) underneath
    const mid = Math.floor(ah / 2);
    const top = scorePassportHalf(data, aw, ah, 0, mid);
    const bot = scorePassportHalf(data, aw, ah, mid, ah);
    // Require purple REMARKS wash OR very tall double-page + clear MRZ below
    const remarksLikely =
      (top.purple > 0.04 && bot.mrz > top.mrz + 0.02) ||
      (top.purple > 0.08) ||
      (aspect < 0.55 && bot.mrz > top.mrz + 0.05 && bot.mrz > 0.08 && top.purple > 0.02);
    if (remarksLikely) {
      sy = Math.floor(h * 0.48);
      sh = h - sy;
      cut = true;
    }
  } else if (aspect > 1.55) {
    // Wide open book: REMARKS left, biodata right — purple REQUIRED
    // (MRZ-only signal would wrongly cut a single landscape biodata page)
    const mid = Math.floor(aw / 2);
    const left = scorePassportVStrip(data, aw, ah, 0, mid);
    const right = scorePassportVStrip(data, aw, ah, mid, aw);
    if (left.purple > 0.04 && (right.mrz >= left.mrz || left.purple > 0.08)) {
      sx = Math.floor(w * 0.48);
      sw = w - sx;
      cut = true;
    }
  } else {
    const mid = Math.floor(ah / 2);
    const top = scorePassportHalf(data, aw, ah, 0, mid);
    const bot = scorePassportHalf(data, aw, ah, mid, ah);
    if (top.purple > 0.05 && bot.mrz > top.mrz + 0.02) {
      sy = Math.floor(h * 0.48);
      sh = h - sy;
      cut = true;
    }
  }

  if (!cut) return { bitmap, cropped: false };

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const octx = canvas.getContext("2d");
  octx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  const out = await toDrawableBitmap(canvas);
  return { bitmap: out, cropped: true };
}

/**
 * Results photo: drop REMARKS when detected. Top capture slot stays original.
 * When cropped, OCR should also use this biodata image (Vision focuses on MRZ).
 */
async function processPassportImage(bitmap) {
  let isolated = null;
  try {
    const result = await isolatePassportBiodataBitmap(bitmap);
    isolated = result.bitmap;
    const jpeg = await canvasToJpeg(isolated, 0, 0, isolated.width, isolated.height);
    jpeg.cropped = !!result.cropped;
    return jpeg;
  } finally {
    if (isolated && isolated !== bitmap && typeof isolated.close === "function") {
      try { isolated.close(); } catch (_) {}
    }
  }
}

async function downscaleBitmap(bitmap, maxSide) {
  const w = bitmap.width;
  const h = bitmap.height;
  if (Math.max(w, h) <= maxSide) return bitmap;
  const scale = maxSide / Math.max(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.round(w * scale));
  canvas.height = Math.max(2, Math.round(h * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (typeof createImageBitmap === "function") return await createImageBitmap(canvas);
  return canvas;
}

async function processLicenseForGenerate(bitmap) {
  const working = await downscaleBitmap(bitmap, 1600);
  const owned = working !== bitmap;
  try {
    const cropped = await cropDocumentBitmap(working, LICENSE_ASPECT, {
      idCard: true,
      licenseScan: true,
    });
    const bright = await applyBrightnessToResult(cropped, 1.03);
    const straighten = cropped.straighten || cropped;
    return {
      crop: { blob: cropped.blob, dataUrl: cropped.dataUrl },
      straighten: { blob: straighten.blob, dataUrl: straighten.dataUrl },
      brightness: { blob: bright.blob, dataUrl: bright.dataUrl },
      final: { blob: bright.blob, dataUrl: bright.dataUrl },
    };
  } finally {
    if (owned && typeof working.close === "function") {
      try { working.close(); } catch (_) {}
    }
  }
}

/**
 * Normalize a license crop to flatbed-scan quality: tight trim, exact ID-1
 * aspect, thin white margin, consistent output size.
 */
async function polishLicenseScan(result, aspect = LICENSE_ASPECT) {
  let trimmed = await trimIdScanBorders(result, aspect);
  trimmed = await trimIdScanBorders(trimmed, aspect);
  const bmp = await toDrawableBitmap(trimmed.blob || trimmed.dataUrl);
  try {
    const outW = LICENSE_SCAN_WIDTH;
    const outH = Math.round(outW / aspect);
    const pad = 0.014;
    const innerW = Math.round(outW * (1 - 2 * pad));
    const innerH = Math.round(innerW / aspect);
    const px = Math.round((outW - innerW) / 2);
    const py = Math.round((outH - innerH) / 2);

    const out = document.createElement("canvas");
    out.width = outW;
    out.height = outH;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outW, outH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.filter = "contrast(1.02)";
    ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, px, py, innerW, innerH);
    ctx.filter = "none";
    return await canvasToJpeg(out, 0, 0, outW, outH, 0.97);
  } finally {
    if (typeof bmp.close === "function") {
      try { bmp.close(); } catch (_) {}
    }
  }
}

/**
 * Camera capture for ID front/back: same pipeline as upload —
 * detect card, straighten to ID-1 (85.6×54), full-bleed crop like a flat scan.
 * Back side uses protectMrz so the TD1 strip is not trimmed away.
 */
async function processFrameCaptureForGenerate(bitmap, options = {}) {
  return processDocumentForGenerate(bitmap, 85.6 / 54, options);
}

/**
 * Full generate pipeline for ID photos (camera or upload):
 * 1) Crop to card  2) Straighten to ID-1  3) Brightness  → final.
 * Output matches a clean scan: card fills the frame, no desk background.
 * options.protectMrz — gentler bottom crop for ID back (MRZ).
 */
async function processDocumentForGenerate(bitmap, aspectRatio, options = {}) {
  const idAspect = aspectRatio || 85.6 / 54;
  const cropped = await cropDocumentBitmap(bitmap, idAspect, {
    idCard: true,
    protectMrz: !!options.protectMrz,
  });
  const bright = await applyBrightnessToResult(cropped);
  const straighten = cropped.straighten || cropped;
  return {
    crop: { blob: cropped.blob, dataUrl: cropped.dataUrl },
    straighten: { blob: straighten.blob, dataUrl: straighten.dataUrl },
    brightness: { blob: bright.blob, dataUrl: bright.dataUrl },
    final: { blob: bright.blob, dataUrl: bright.dataUrl },
  };
}
