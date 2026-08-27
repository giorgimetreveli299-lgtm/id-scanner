"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import {
  DASHBOARD_FIELDS,
  fieldTitle,
  sanitizePlaceOfBirth,
  type DashboardField,
  type LicenseFields,
} from "@/lib/parseLicense";
import {
  BACK_SIDE_REQUIRED_ERROR,
  FRONT_SIDE_REQUIRED_ERROR,
  type FaceBox,
} from "@/lib/types";
import CropStraightenModal from "@/components/CropStraightenModal";
import { downloadLicensePdf } from "@/lib/buildLicensePdf";
import {
  formatBilingualName,
  formatBilingualPlace,
  formatResidence,
  joinBilingualName,
  splitBilingualName,
  syncBilingualFromGeo,
  syncBilingualFromLatin,
} from "@/lib/georgianTranslit";
import {
  buildQrCheckedSnapshot,
  findFieldInQr,
  getQrBadgeStatus,
  isQrCheckableField,
  qrBadgeValue,
  QR_CHECKABLE_FIELDS,
  type QrCheckableField,
  type QrHighlight,
} from "@/lib/qrCheck";

type Side = "front" | "back";

type SideState = {
  file: File | null;
  preview: string | null;
};

type ScanResponse = {
  fields?: LicenseFields;
  holderPhotoBox?: FaceBox | null;
  holderSignatureBox?: FaceBox | null;
  qrCodeBox?: FaceBox | null;
  qrCodeValue?: string | null;
  holderPhotoDataUrl?: string | null;
  holderSignatureDataUrl?: string | null;
  qrCodeDataUrl?: string | null;
  error?: string;
};

/** ISO ID-1 card ratio (driver license). */
const LICENSE_RATIO = 85.6 / 53.98;
const FRAME_WIDTH_PCT = 0.86;

const EMPTY_FIELDS = Object.fromEntries(
  DASHBOARD_FIELDS.filter((f) => f.kind === "text").map((f) => [f.key, ""])
) as Record<keyof LicenseFields, string>;

const EMPTY_SIDE: SideState = { file: null, preview: null };

function userFacingRequestError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : "";
  if (
    err instanceof TypeError ||
    /failed to fetch|networkerror|load failed|fetch failed/i.test(raw)
  ) {
    return "Could not reach the scanner. Keep the app running and try again.";
  }
  return raw || fallback;
}

function fieldsToForm(fields: LicenseFields): Record<keyof LicenseFields, string> {
  const out = { ...EMPTY_FIELDS };
  (Object.keys(EMPTY_FIELDS) as (keyof LicenseFields)[]).forEach((key) => {
    out[key] = fields[key] ?? "";
  });
  out.placeOfBirth = sanitizePlaceOfBirth(fields.placeOfBirth) ?? "";
  return out;
}

function cropFromImage(
  src: string,
  box: FaceBox
): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const sx = Math.round(box.left * img.naturalWidth);
        const sy = Math.round(box.top * img.naturalHeight);
        const sw = Math.max(1, Math.round(box.width * img.naturalWidth));
        const sh = Math.max(1, Math.round(box.height * img.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        resolve(canvas.toDataURL("image/jpeg", 0.9));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Crop from File so revoked preview blob URLs cannot break photo/signature. */
async function cropFromFile(
  file: File,
  box: FaceBox
): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    return await cropFromImage(url, box);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Fallback only: zone under field 5 on the lower-right of a typical ID-1 front. */
function signatureBoxFallback(): FaceBox {
  return { left: 0.5, top: 0.74, width: 0.44, height: 0.18 };
}

/** Fallback: holder photo on the right of a Georgian DL front. */
function photoBoxFallback(): FaceBox {
  return { left: 0.66, top: 0.14, width: 0.3, height: 0.56 };
}

/** Fallback: white QR plate on left column of Georgian DL back. */
function qrCodeBoxFallback(): FaceBox {
  return { left: 0.07, top: 0.12, width: 0.24, height: 0.38 };
}

function getCoverCrop(
  videoW: number,
  videoH: number,
  viewW: number,
  viewH: number
) {
  const videoRatio = videoW / videoH;
  const viewRatio = viewW / viewH;
  let drawW: number;
  let drawH: number;
  let offsetX: number;
  let offsetY: number;

  if (videoRatio > viewRatio) {
    drawH = videoH;
    drawW = videoH * viewRatio;
    offsetX = (videoW - drawW) / 2;
    offsetY = 0;
  } else {
    drawW = videoW;
    drawH = videoW / viewRatio;
    offsetX = 0;
    offsetY = (videoH - drawH) / 2;
  }

  return { drawW, drawH, offsetX, offsetY };
}

/** Only allow http(s) return URLs back to the ID/passport hub. */
function safeHubReturnUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function getIdScannerAppUrl(): string {
  const fromEnv = (process.env.NEXT_PUBLIC_ID_SCANNER_APP_URL || "").trim();
  const url = fromEnv || "http://127.0.0.1:8080";
  return url.replace(/\/$/, "");
}

export default function HomePage() {
  const [hubMethod, setHubMethod] = useState<"id" | "passport" | "license" | null>(
    null
  );
  const [hubReady, setHubReady] = useState(false);
  const [hubReturnUrl, setHubReturnUrl] = useState<string | null>(null);
  const [legacyError, setLegacyError] = useState<string | null>(null);
  const [legacyBusy, setLegacyBusy] = useState(false);
  const [front, setFront] = useState<SideState>(EMPTY_SIDE);
  const [back, setBack] = useState<SideState>(EMPTY_SIDE);
  const [dragging, setDragging] = useState<Side | null>(null);
  const [cameraSide, setCameraSide] = useState<Side | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FIELDS);
  const [scanned, setScanned] = useState(false);
  const [holderPhoto, setHolderPhoto] = useState<string | null>(null);
  const [holderSignature, setHolderSignature] = useState<string | null>(null);
  const [qrCodeImage, setQrCodeImage] = useState<string | null>(null);
  const [qrCodeValue, setQrCodeValue] = useState<string | null>(null);
  const [cropSide, setCropSide] = useState<Side | null>(null);
  const [autoCropping, setAutoCropping] = useState<Side | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; title: string } | null>(
    null
  );
  const [pdfBusy, setPdfBusy] = useState(false);
  const [qrHighlight, setQrHighlight] = useState<QrHighlight[] | null>(null);
  const [qrDetailsOpen, setQrDetailsOpen] = useState(false);
  const [qrCheckedSnapshot, setQrCheckedSnapshot] = useState<
    Partial<Record<QrCheckableField, string>>
  >({});
  const [sideIssue, setSideIssue] = useState<{
    front: string | null;
    back: string | null;
  }>({ front: null, back: null });
  const [checkingBySide, setCheckingBySide] = useState({
    front: false,
    back: false,
  });

  const frontInputRef = useRef<HTMLInputElement>(null);
  const backInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scannedPairRef = useRef<string | null>(null);
  const scanningRef = useRef(false);
  const sideOpGenRef = useRef({ front: 0, back: 0 });
  const checkingInflightRef = useRef({ front: 0, back: 0 });
  const qrDetailsRef = useRef<HTMLDetailsElement>(null);
  const qrHitRef = useRef<HTMLElement | null>(null);

  const bothReady = Boolean(front.file && back.file);
  const pairKey =
    front.file && back.file
      ? `${front.file.name}:${front.file.size}:${front.file.lastModified}|${back.file.name}:${back.file.size}:${back.file.lastModified}`
      : null;
  // Extract only after both sides are present and no camera/crop/auto-crop is active
  const canExtract =
    bothReady &&
    !cropSide &&
    !cameraSide &&
    !autoCropping &&
    !checkingBySide.front &&
    !checkingBySide.back &&
    !sideIssue.front &&
    !sideIssue.back;
  const showResults = canExtract && scanned && !error;

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraSide(null);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  // Resolve ?mode= before paint so the method-choice screen never flashes.
  useLayoutEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setHubReturnUrl(safeHubReturnUrl(params.get("return")));
    if (params.get("mode") === "license") {
      setHubMethod("license");
    }
    setHubReady(true);
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event?.data?.type === "id-scanner-back") {
        setHubMethod(null);
        setLegacyError(null);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const openLicenseMethod = useCallback(() => {
    setLegacyError(null);
    setHubMethod("license");
  }, []);

  const backToMethodChoice = useCallback(() => {
    if (hubReturnUrl) {
      window.location.href = hubReturnUrl;
      return;
    }
    setHubMethod(null);
    setLegacyError(null);
  }, [hubReturnUrl]);

  const openLegacyMethod = useCallback(async (method: "id" | "passport") => {
    setLegacyBusy(true);
    setLegacyError(null);
    const base = getIdScannerAppUrl();
    try {
      const res = await fetch(`${base}/health`, { cache: "no-store" });
      if (!res.ok) throw new Error("bad status");
      setHubMethod(method);
    } catch {
      setLegacyError(
        "ID/Passport server is not running on port 8080. Stop this page, run npm run dev again (it starts both servers), then retry."
      );
    } finally {
      setLegacyBusy(false);
    }
  }, []);
  useEffect(() => {
    if (!cameraSide || !streamRef.current || !videoRef.current) return;
    videoRef.current.srcObject = streamRef.current;
  }, [cameraSide]);

  useEffect(() => {
    if (!cameraSide) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") stopCamera();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [cameraSide, stopCamera]);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [lightbox]);

  const revokePreview = (url: string | null) => {
    if (url) URL.revokeObjectURL(url);
  };

  const checkLicenseSide = useCallback(async (side: Side, file: File) => {
    const gen = sideOpGenRef.current[side];
    checkingInflightRef.current[side] += 1;
    setCheckingBySide((prev) => ({ ...prev, [side]: true }));
    setSideIssue((prev) => ({ ...prev, [side]: null }));
    try {
      const body = new FormData();
      body.append("image", file);
      body.append("side", side);
      const res = await fetch("/api/validate-side", { method: "POST", body });
      const data = (await res.json()) as { error?: string };
      if (sideOpGenRef.current[side] !== gen) return;
      if (!res.ok || data.error) {
        const msg =
          data.error ||
          (side === "front"
            ? FRONT_SIDE_REQUIRED_ERROR
            : BACK_SIDE_REQUIRED_ERROR);
        setSideIssue((prev) => ({ ...prev, [side]: msg }));
        setScanned(false);
        setForm(EMPTY_FIELDS);
      }
    } catch (err) {
      if (sideOpGenRef.current[side] !== gen) return;
      setSideIssue((prev) => ({
        ...prev,
        [side]: userFacingRequestError(err, "Could not check this photo."),
      }));
      setScanned(false);
      setForm(EMPTY_FIELDS);
    } finally {
      if (sideOpGenRef.current[side] !== gen) return;
      checkingInflightRef.current[side] = Math.max(
        0,
        checkingInflightRef.current[side] - 1
      );
      if (checkingInflightRef.current[side] === 0) {
        setCheckingBySide((prev) => ({ ...prev, [side]: false }));
      }
    }
  }, []);

  const setSideFile = useCallback(
    (
      side: Side,
      next: File,
      options?: { openEditor?: boolean; skipAutoCrop?: boolean }
    ) => {
      if (side === "back" && (!front.file || Boolean(sideIssue.front))) {
        return;
      }
      sideOpGenRef.current[side] += 1;
      const gen = sideOpGenRef.current[side];
      checkingInflightRef.current[side] = 0;
      setCheckingBySide((prev) => ({ ...prev, [side]: false }));
      stopCamera();
      setError(null);
      setForm(EMPTY_FIELDS);
      setScanned(false);
      setHolderPhoto(null);
      setHolderSignature(null);
      setQrCodeImage(null);
      setQrCodeValue(null);
      setQrCheckedSnapshot({});
      setSideIssue((prev) => ({ ...prev, [side]: null }));
      scannedPairRef.current = null;

      const url = URL.createObjectURL(next);
      const updater = (prev: SideState): SideState => {
        revokePreview(prev.preview);
        return { file: next, preview: url };
      };

      if (side === "front") setFront(updater);
      else setBack(updater);

      // Manual editor only when explicitly requested
      if (options?.openEditor) {
        setCropSide(side);
        return;
      }

      if (options?.skipAutoCrop) {
        void checkLicenseSide(side, next);
        return;
      }

      void (async () => {
        setAutoCropping(side);
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 14000);
        const stillCurrent = () => sideOpGenRef.current[side] === gen;
        try {
          const body = new FormData();
          body.append("image", next);
          const res = await fetch("/api/autocrop", {
            method: "POST",
            body,
            signal: controller.signal,
          });
          if (!stillCurrent()) return;
          if (!res.ok) {
            await checkLicenseSide(side, next);
            return;
          }
          const blob = await res.blob();
          if (!stillCurrent()) return;
          if (!blob.type.startsWith("image/")) {
            await checkLicenseSide(side, next);
            return;
          }
          const processed = new File([blob], `license-${side}-auto.jpg`, {
            type: "image/jpeg",
          });
          const processedUrl = URL.createObjectURL(processed);
          const apply = (prev: SideState): SideState => {
            revokePreview(prev.preview);
            return { file: processed, preview: processedUrl };
          };
          if (!stillCurrent()) {
            URL.revokeObjectURL(processedUrl);
            return;
          }
          setForm(EMPTY_FIELDS);
          setScanned(false);
          setHolderPhoto(null);
          setHolderSignature(null);
          setQrCodeImage(null);
          setQrCodeValue(null);
          setQrCheckedSnapshot({});
          scannedPairRef.current = null;
          if (side === "front") setFront(apply);
          else setBack(apply);
          await checkLicenseSide(side, processed);
        } catch {
          if (!stillCurrent()) return;
          await checkLicenseSide(side, next);
        } finally {
          window.clearTimeout(timer);
          if (stillCurrent()) {
            setAutoCropping((current) => (current === side ? null : current));
          }
        }
      })();
    },
    [stopCamera, front.file, checkLicenseSide, sideIssue.front]
  );

  const clearSide = (side: Side) => {
    sideOpGenRef.current[side] += 1;
    checkingInflightRef.current[side] = 0;
    if (side === "front") {
      sideOpGenRef.current.back += 1;
      checkingInflightRef.current.back = 0;
    }
    setCheckingBySide((prev) =>
      side === "front" ? { front: false, back: false } : { ...prev, back: false }
    );
    setAutoCropping((current) =>
      current === side || (side === "front" && current === "back") ? null : current
    );
    stopCamera();
    setError(null);
    setForm(EMPTY_FIELDS);
    setScanned(false);
    setHolderPhoto(null);
    setHolderSignature(null);
    setQrCodeImage(null);
    setQrCodeValue(null);
    setQrCheckedSnapshot({});
    setSideIssue((prev) =>
      side === "front" ? { front: null, back: null } : { ...prev, back: null }
    );
    scannedPairRef.current = null;
    setCropSide((current) =>
      current === side || (side === "front" && current === "back") ? null : current
    );
    const clearer = (prev: SideState): SideState => {
      revokePreview(prev.preview);
      return EMPTY_SIDE;
    };
    if (side === "front") {
      setFront(clearer);
      setBack(clearer); // back cannot remain without front
    } else {
      setBack(clearer);
    }
  };

  const newClient = () => {
    stopCamera();

    // Leave the license screen immediately — do not paint the empty upload stage first.
    if (hubReturnUrl) {
      window.location.replace(hubReturnUrl);
      return;
    }
    flushSync(() => {
      setHubMethod(null);
      setLegacyError(null);
    });

    sideOpGenRef.current.front += 1;
    sideOpGenRef.current.back += 1;
    checkingInflightRef.current.front = 0;
    checkingInflightRef.current.back = 0;
    setError(null);
    setForm(EMPTY_FIELDS);
    setScanned(false);
    setHolderPhoto(null);
    setHolderSignature(null);
    setQrCodeImage(null);
    setQrCodeValue(null);
    setQrCheckedSnapshot({});
    setSideIssue({ front: null, back: null });
    setCheckingBySide({ front: false, back: false });
    setQrHighlight(null);
    setQrDetailsOpen(false);
    scannedPairRef.current = null;
    scanningRef.current = false;
    setCropSide(null);
    setLightbox(null);
    setAutoCropping(null);
    setPdfBusy(false);
    setFront((prev) => {
      revokePreview(prev.preview);
      return EMPTY_SIDE;
    });
    setBack((prev) => {
      revokePreview(prev.preview);
      return EMPTY_SIDE;
    });
    if (frontInputRef.current) frontInputRef.current.value = "";
    if (backInputRef.current) backInputRef.current.value = "";
  };

  const handleDownloadPdf = async () => {
    if (!front.file || !back.file || pdfBusy) return;
    setPdfBusy(true);
    setError(null);
    try {
      const surnameSlug = (form.surname || "driver")
        .split("/")[0]
        .trim()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
      await downloadLicensePdf({
        front: front.file,
        back: back.file,
        fileName: `driver-license-${surnameSlug || "driver"}.pdf`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "PDF download failed.");
    } finally {
      setPdfBusy(false);
    }
  };

  const startCamera = async (side: Side) => {
    if (side === "back" && (!front.file || Boolean(sideIssue.front))) {
      return;
    }
    if (autoCropping === side || checkingBySide[side]) return;
    setError(null);
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      setCameraSide(side);
    } catch {
      setError("Could not access the camera.");
    }
  };

  const captureFrame = () => {
    if (!cameraSide) return;
    const video = videoRef.current;
    const stage = stageRef.current;
    if (!video || !stage) return;

    const videoW = video.videoWidth || 1280;
    const videoH = video.videoHeight || 720;
    const viewW = stage.clientWidth;
    const viewH = stage.clientHeight;
    if (!viewW || !viewH) return;

    const { drawW, drawH, offsetX, offsetY } = getCoverCrop(
      videoW,
      videoH,
      viewW,
      viewH
    );

    const frameW = viewW * FRAME_WIDTH_PCT;
    const frameH = frameW / LICENSE_RATIO;
    const frameLeft = (viewW - frameW) / 2;
    const frameTop = (viewH - frameH) / 2;

    const scaleX = drawW / viewW;
    const scaleY = drawH / viewH;

    const sx = offsetX + frameLeft * scaleX;
    const sy = offsetY + frameTop * scaleY;
    const sw = frameW * scaleX;
    const sh = frameH * scaleY;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw));
    canvas.height = Math.max(1, Math.round(sh));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(
      video,
      sx,
      sy,
      sw,
      sh,
      0,
      0,
      canvas.width,
      canvas.height
    );

    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        setSideFile(
          cameraSide,
          new File([blob], `license-${cameraSide}.jpg`, { type: "image/jpeg" })
        );
      },
      "image/jpeg",
      0.92
    );
  };

  const scan = useCallback(async (force = false) => {
    if (!front.file || !back.file || !pairKey) {
      return;
    }
    if (scanningRef.current) return;
    if (!force && scannedPairRef.current === pairKey) return;

    scanningRef.current = true;
    scannedPairRef.current = pairKey;
    setLoading(true);
    setError(null);
    setScanned(false);
    setHolderPhoto(null);
    setHolderSignature(null);
    setQrCodeImage(null);
    setQrCodeValue(null);
    setQrCheckedSnapshot({});
    setQrHighlight(null);
    setQrDetailsOpen(false);
    try {
      const body = new FormData();
      body.append("front", front.file);
      body.append("back", back.file);
      const res = await fetch("/api/scan", { method: "POST", body });
      const data = (await res.json()) as ScanResponse;
      if (!res.ok || data.error) {
        throw new Error(data.error || "Scan failed.");
      }
      if (data.fields) {
        const nextForm = fieldsToForm(data.fields);
        setForm(nextForm);
        setQrCheckedSnapshot(
          buildQrCheckedSnapshot(data.qrCodeValue ?? null, nextForm)
        );
      } else {
        setQrCheckedSnapshot({});
      }
      setQrCodeValue(data.qrCodeValue ?? null);

      // Prefer server-cropped images (browser crop often fails on revoked/HEIC blobs)
      if (data.holderPhotoDataUrl) {
        setHolderPhoto(data.holderPhotoDataUrl);
      } else if (front.file) {
        setHolderPhoto(
          await cropFromFile(
            front.file,
            data.holderPhotoBox ?? photoBoxFallback()
          )
        );
      }

      if (data.holderSignatureDataUrl) {
        setHolderSignature(data.holderSignatureDataUrl);
      } else if (front.file) {
        setHolderSignature(
          await cropFromFile(
            front.file,
            data.holderSignatureBox ?? signatureBoxFallback()
          )
        );
      }

      if (data.qrCodeDataUrl) {
        setQrCodeImage(data.qrCodeDataUrl);
      } else if (back.file) {
        setQrCodeImage(
          await cropFromFile(back.file, data.qrCodeBox ?? qrCodeBoxFallback())
        );
      }

      setScanned(true);
    } catch (err) {
      scannedPairRef.current = null;
      const message = userFacingRequestError(err, "Error");
      setError(message);
      setScanned(false);
      setForm(EMPTY_FIELDS);
      setHolderPhoto(null);
      setHolderSignature(null);
      setQrCodeImage(null);
      setQrCodeValue(null);
      setQrCheckedSnapshot({});
      if (message === FRONT_SIDE_REQUIRED_ERROR) {
        setSideIssue((prev) => ({ ...prev, front: message }));
      } else if (message === BACK_SIDE_REQUIRED_ERROR) {
        setSideIssue((prev) => ({ ...prev, back: message }));
      }
    } finally {
      scanningRef.current = false;
      setLoading(false);
    }
  }, [front.file, back.file, pairKey]);

  useEffect(() => {
    if (!canExtract || !pairKey) return;
    void scan(false);
  }, [canExtract, pairKey, scan]);

  const hasResult =
    Object.values(form).some(Boolean) ||
    Boolean(holderPhoto || holderSignature || qrCodeImage);
  const cameraLabel = cameraSide === "front" ? "Front" : "Back";

  const extractionErrorFields = (() => {
    if (!showResults || !hasResult) return [] as string[];
    const labels: string[] = [];
    for (const key of QR_CHECKABLE_FIELDS) {
      const raw = form[key] ?? "";
      const status = getQrBadgeStatus(
        qrCodeValue,
        key,
        qrBadgeValue(key, raw),
        raw,
        qrCheckedSnapshot
      );
      if (status !== "error") continue;
      const field = DASHBOARD_FIELDS.find((f) => f.key === key);
      labels.push(field?.labelEn ?? key);
    }
    return labels;
  })();

  const renderSideCard = (side: Side, state: SideState) => {
    const label = side === "front" ? "Front" : "Back";
    const inputRef = side === "front" ? frontInputRef : backInputRef;
    const locked = side === "back" && (!front.file || Boolean(sideIssue.front));
    const sideBusy = autoCropping === side || checkingBySide[side];
    const invalidMsg = side === "front" ? sideIssue.front : sideIssue.back;
    const sideInvalid = Boolean(state.file && invalidMsg);

    return (
      <div className={`side-card ${locked ? "locked" : ""} ${sideInvalid ? "has-error" : ""}`}>
        <div className="side-card-head">
          <h2>{label}</h2>
          {locked ? (
            <span className="side-badge">
              {sideIssue.front ? "Fix front first" : "Upload front first"}
            </span>
          ) : autoCropping === side || checkingBySide[side] ? (
            <span className="side-badge">Checking…</span>
          ) : sideInvalid ? (
            <span className="side-badge err">Error</span>
          ) : loading && state.file ? (
            <span className="side-badge">Checking…</span>
          ) : state.file ? (
            <span className="side-badge ready">Ready</span>
          ) : (
            <span className="side-badge">Required</span>
          )}
        </div>

        <div
          className={`dropzone compact ${dragging === side ? "active" : ""} ${state.preview ? "has-preview" : ""} ${locked ? "locked" : ""} ${sideInvalid ? "invalid" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (locked || sideBusy) return;
            setDragging(side);
          }}
          onDragLeave={() => setDragging(null)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(null);
            if (locked || sideBusy) return;
            const dropped = e.dataTransfer.files?.[0];
            if (dropped) setSideFile(side, dropped);
          }}
        >
          {state.preview ? (
            <button
              type="button"
              className="preview-hit"
              onClick={() =>
                setLightbox({ src: state.preview!, title: `${label} side` })
              }
              aria-label={`Enlarge ${label} photo`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="preview" src={state.preview} alt={`${label} preview`} />
            </button>
          ) : (
            <div>
              <p className="drop-title">{label} side</p>
              <p className="drop-hint">
                {locked
                  ? "Add the front photo before uploading the back"
                  : "Drop photo or choose a file"}
              </p>
            </div>
          )}
          <input
            ref={inputRef}
            className="hidden-input"
            type="file"
            accept="image/*"
            capture="environment"
            disabled={locked || sideBusy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f && !locked && !sideBusy) setSideFile(side, f);
              e.target.value = "";
            }}
          />
        </div>
        {sideInvalid ? (
          <p className="side-error">{invalidMsg}</p>
        ) : null}

        <div className="actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={locked || sideBusy}
            onClick={() => inputRef.current?.click()}
          >
            Upload
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={locked || sideBusy}
            onClick={() => startCamera(side)}
          >
            Camera
          </button>
          {state.file && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={sideBusy}
                onClick={() => setCropSide(side)}
              >
                Crop & Straighten
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => clearSide(side)}
              >
                Clear
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  useEffect(() => {
    if (!qrHighlight?.length || !qrDetailsOpen) return;
    const t = window.setTimeout(() => {
      qrHitRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 60);
    return () => window.clearTimeout(t);
  }, [qrHighlight, qrDetailsOpen]);

  const revealQrMatch = (fieldKey: string, value: string) => {
    if (!qrCodeValue || !isQrCheckableField(fieldKey)) return;
    const hits = findFieldInQr(qrCodeValue, fieldKey, value);
    if (hits?.length) {
      setQrHighlight(hits);
    } else {
      setQrHighlight(null);
    }
    setQrDetailsOpen(true);
    const el = qrDetailsRef.current;
    if (el && !el.open) el.open = true;
  };

  const renderQrCompareBadge = (fieldKey: string, value: string) => {
    const status = getQrBadgeStatus(
      qrCodeValue,
      fieldKey,
      value,
      isQrCheckableField(fieldKey) ? form[fieldKey] : value,
      qrCheckedSnapshot
    );
    if (!status) return null;
    if (status === "checked") {
      return (
        <button
          type="button"
          className="checked-badge"
          title="ემთხვევა QR-ს — დააჭირე ადგილის სანახავად"
          onClick={() => revealQrMatch(fieldKey, value)}
        >
          Checked
        </button>
      );
    }
    return (
      <button
        type="button"
        className="error-badge"
        title="არ ემთხვევა QR-ს — დააჭირე QR ინფორმაციის სანახავად"
        onClick={() => revealQrMatch(fieldKey, value)}
      >
        Error
      </button>
    );
  };

  const renderHighlightedQr = (text: string) => {
    if (!qrHighlight?.length) return text;
    const ranges = [...qrHighlight]
      .filter((h) => h.start >= 0 && h.end <= text.length && h.start < h.end)
      .sort((a, b) => a.start - b.start);
    if (!ranges.length) return text;

    // Merge overlapping ranges
    const merged: QrHighlight[] = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end) {
        last.end = Math.max(last.end, r.end);
      } else {
        merged.push({ ...r });
      }
    }

    const nodes: ReactNode[] = [];
    let cursor = 0;
    merged.forEach((h, i) => {
      if (h.start > cursor) nodes.push(text.slice(cursor, h.start));
      nodes.push(
        <mark
          key={`qr-hit-${h.start}-${h.end}`}
          ref={i === 0 ? qrHitRef : undefined}
          className="qr-hit"
        >
          {text.slice(h.start, h.end)}
        </mark>
      );
      cursor = h.end;
    });
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return <>{nodes}</>;
  };

  const cropState = cropSide === "front" ? front : cropSide === "back" ? back : null;

  const renderTextField = (field: DashboardField) => {
    const textKey = field.key as keyof LicenseFields;
    const title = fieldTitle(field);
    const bilingualKeys: (keyof LicenseFields)[] = [
      "surname",
      "givenNames",
      "placeOfBirth",
      "issuingAuthority",
      "residence",
    ];

    if (bilingualKeys.includes(textKey)) {
      const raw = form[textKey];
      const { geo, latin } = splitBilingualName(raw);
      const bilingualKind =
        textKey === "residence"
          ? "residence"
          : textKey === "placeOfBirth"
            ? "place"
            : textKey === "issuingAuthority"
              ? "authority"
              : "name";
      const commitBilingual = () => {
        setForm((prev) => {
          if (
            isQrCheckableField(textKey) &&
            Object.prototype.hasOwnProperty.call(qrCheckedSnapshot, textKey) &&
            prev[textKey] === qrCheckedSnapshot[textKey]
          ) {
            return prev;
          }
          const current = prev[textKey];
          const formatted =
            textKey === "residence"
              ? formatResidence(current)
              : textKey === "placeOfBirth"
                ? formatBilingualPlace(current)
                : formatBilingualName(current);
          return { ...prev, [textKey]: formatted || current };
        });
      };
      // Badge checks English side for bilingual fields (surname / names / residence)
      const checkValue =
        textKey === "surname" ||
        textKey === "givenNames" ||
        textKey === "residence"
          ? latin || joinBilingualName(geo, latin)
          : raw;
      const enBadge = renderQrCompareBadge(textKey, checkValue);
      return (
        <div className="field" key={`${field.code}-${field.key}`}>
          <label htmlFor={`${textKey}-ka`}>
            {field.code ? (
              <span className="field-code">{field.code}</span>
            ) : null}
            <span className="field-title">
              <span className="field-title-ka">{field.labelKa}</span>
              <span className="field-title-en">{field.labelEn}</span>
            </span>
          </label>
          <div className="field-split">
            <input
              id={`${textKey}-ka`}
              value={geo}
              maxLength={field.maxLength}
              aria-label={`${title} (ქართული)`}
              placeholder="—"
              onBlur={commitBilingual}
              onChange={(e) => {
                const nextGeo = e.target.value;
                setForm((prev) => ({
                  ...prev,
                  [textKey]: syncBilingualFromGeo(nextGeo, bilingualKind),
                }));
              }}
            />
            <div className={`input-with-badge${enBadge ? " has-badge" : ""}`}>
              <input
                id={`${textKey}-en`}
                value={latin}
                maxLength={field.maxLength}
                aria-label={`${title} (English)`}
                placeholder="—"
                onBlur={commitBilingual}
                onChange={(e) => {
                  const nextLatin = e.target.value;
                  setForm((prev) => ({
                    ...prev,
                    [textKey]: syncBilingualFromLatin(nextLatin, bilingualKind),
                  }));
                }}
              />
              {enBadge}
            </div>
          </div>
        </div>
      );
    }

    const singleBadge = renderQrCompareBadge(textKey, form[textKey]);
    return (
      <div className="field" key={`${field.code}-${field.key}`}>
        <label htmlFor={textKey}>
          {field.code ? (
            <span className="field-code">{field.code}</span>
          ) : null}
          <span className="field-title">
            <span className="field-title-ka">{field.labelKa}</span>
            <span className="field-title-en">{field.labelEn}</span>
          </span>
        </label>
        <div className={`input-with-badge${singleBadge ? " has-badge" : ""}`}>
          <input
            id={textKey}
            value={form[textKey]}
            maxLength={field.maxLength}
            aria-label={title}
            onChange={(e) => {
              let value = e.target.value;
              if (textKey === "category") {
                value = value.toUpperCase().replace(/\s+/g, " ");
              }
              setForm((prev) => ({
                ...prev,
                [textKey]: value,
              }));
            }}
            placeholder="—"
          />
          {singleBadge}
        </div>
      </div>
    );
  };

  return (
    <main className="shell">
      {!hubReady ? (
        <div className="hub-boot" aria-busy="true" aria-label="Loading" />
      ) : hubMethod === null ? (
        <section className="method-choice-card">
          <h1 className="brand method-choice-title">
            Select a document type to continue.
          </h1>
          {legacyError ? (
            <p className="side-error method-choice-error">{legacyError}</p>
          ) : null}
          <div className="method-options">
            <button
              type="button"
              className="method-box"
              disabled={legacyBusy}
              onClick={() => void openLegacyMethod("id")}
            >
              <span className="method-box-title">ID</span>
              <span className="method-box-sub">ID card</span>
            </button>
            <button
              type="button"
              className="method-box"
              disabled={legacyBusy}
              onClick={() => void openLegacyMethod("passport")}
            >
              <span className="method-box-title">Passport</span>
              <span className="method-box-sub">Passport</span>
            </button>
            <button
              type="button"
              className="method-box method-box-wide"
              disabled={legacyBusy}
              onClick={openLicenseMethod}
            >
              <span className="method-box-title">Driver License</span>
              <span className="method-box-sub">Driver license</span>
            </button>
          </div>
        </section>
      ) : hubMethod === "id" || hubMethod === "passport" ? (
        <>
          <button
            type="button"
            className="hub-back"
            onClick={() => {
              setHubMethod(null);
              setLegacyError(null);
            }}
          >
            ← Back
          </button>
          <iframe
            className="legacy-frame"
            title={hubMethod === "id" ? "ID card scanner" : "Passport scanner"}
            src={`${getIdScannerAppUrl()}/?method=${hubMethod}&embed=1`}
            allow="camera; microphone; fullscreen"
          />
        </>
      ) : (
        <>
      <button
        type="button"
        className="hub-back"
        onClick={backToMethodChoice}
      >
        ← Back
      </button>
      <h1 className="brand">Driver License Verificator</h1>
      <p className="lede">
        Capture both sides of the driver license. Identification fields appear
        after the front and back photos are ready.
      </p>

      <section className="panel capture-panel">
        <div className="sides-grid">
          {renderSideCard("front", front)}
          {renderSideCard("back", back)}
        </div>
        {error &&
        error !== FRONT_SIDE_REQUIRED_ERROR &&
        error !== BACK_SIDE_REQUIRED_ERROR ? (
          <p className="side-error capture-error">{error}</p>
        ) : null}
      </section>

      {showResults && hasResult && !loading ? (
        <div
          className={`extract-status-banner ${
            extractionErrorFields.length ? "is-error" : "is-ok"
          }`}
          role="status"
          aria-live="polite"
        >
          {extractionErrorFields.length
            ? `There is error in (${extractionErrorFields.join(", ")})`
            : "Every extracted information is correct and ready to process"}
        </div>
      ) : null}

      {showResults && (
        <section className="panel results-panel">
          <div className="results-head">
            <h2>Identification data</h2>
            <span className={`status ${error ? "err" : hasResult ? "ok" : ""}`}>
              {error
                ? "Error"
                : loading
                  ? "Processing…"
                  : hasResult
                    ? "Extracted"
                    : "No data"}
            </span>
          </div>

          {error && (
            <p className="status err" style={{ marginBottom: "1rem" }}>
              {error}
            </p>
          )}

          {loading && !hasResult ? (
            <p className="empty">Reading text from both sides…</p>
          ) : (
            <>
            <div className="fields">
              {(() => {
                const nodes: ReactNode[] = [];
                for (let i = 0; i < DASHBOARD_FIELDS.length; i++) {
                  const field = DASHBOARD_FIELDS[i];

                  if (field.key === "placeOfBirth") continue;

                  if (field.key === "dateOfBirth") {
                    const placeField = DASHBOARD_FIELDS.find(
                      (f) => f.key === "placeOfBirth"
                    )!;
                    nodes.push(
                      <div className="field-pair" key="field-3-pair">
                        {renderTextField(field)}
                        {renderTextField(placeField)}
                      </div>
                    );
                    continue;
                  }

                  if (field.kind === "image") {
                    const src =
                      field.key === "holderPhoto"
                        ? holderPhoto
                        : field.key === "holderSignature"
                          ? holderSignature
                          : qrCodeImage;
                    const slotClass =
                      field.key === "holderPhoto"
                        ? "photo"
                        : field.key === "holderSignature"
                          ? "signature"
                          : "qr";
                    const isQr = field.key === "qrCode";
                    nodes.push(
                      <div
                        className={`field field-image${isQr ? " field-qr" : ""}`}
                        key={field.key}
                      >
                        <label>
                          <span className="field-code">{field.code}</span>
                          <span className="field-title">
                            <span className="field-title-ka">{field.labelKa}</span>
                            <span className="field-title-en">{field.labelEn}</span>
                          </span>
                        </label>
                        <div className={isQr ? "qr-row" : undefined}>
                          <div className={`image-slot ${slotClass}`}>
                            {src ? (
                              <button
                                type="button"
                                className="preview-hit"
                                onClick={() =>
                                  setLightbox({
                                    src,
                                    title: fieldTitle(field),
                                  })
                                }
                                aria-label={`Enlarge ${fieldTitle(field)}`}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={src} alt={fieldTitle(field)} />
                              </button>
                            ) : (
                              <span>Not detected</span>
                            )}
                          </div>
                          {isQr ? (
                            <details
                              ref={qrDetailsRef}
                              className="qr-details"
                              open={qrDetailsOpen || undefined}
                              onToggle={(e) => {
                                const open = (e.currentTarget as HTMLDetailsElement)
                                  .open;
                                setQrDetailsOpen(open);
                                if (!open) setQrHighlight(null);
                              }}
                            >
                              <summary>
                                {qrCodeValue
                                  ? "QR ინფორმაცია / QR data"
                                  : "ინფორმაცია არ წაიკითხა / No data"}
                              </summary>
                              <pre className="qr-payload" aria-readonly="true">
                                {qrCodeValue
                                  ? renderHighlightedQr(qrCodeValue)
                                  : "—"}
                              </pre>
                            </details>
                          ) : null}
                        </div>
                      </div>
                    );
                    continue;
                  }

                  nodes.push(renderTextField(field));
                }
                return nodes;
              })()}
            </div>

            {hasResult ? (
              <section className="footer-actions" aria-label="Session actions">
                <button
                  type="button"
                  className="btn btn-xl btn-ghost"
                  onClick={newClient}
                >
                  New Client
                </button>
                <button
                  type="button"
                  className="btn btn-xl btn-primary"
                  disabled={!bothReady || pdfBusy || Boolean(autoCropping)}
                  onClick={() => void handleDownloadPdf()}
                >
                  {pdfBusy ? "Preparing PDF…" : "Download PDF"}
                </button>
              </section>
            ) : null}
            </>
          )}
        </section>
      )}

      {cameraSide && (
        <div
          className="camera-modal"
          role="dialog"
          aria-modal="true"
          aria-label={`Capture ${cameraLabel} side`}
        >
          <div className="camera-modal-backdrop" onClick={stopCamera} />
          <div className="camera-modal-sheet">
            <div className="camera-modal-head">
              <div>
                <p className="camera-modal-kicker">Align the license</p>
                <h2>{cameraLabel} side</h2>
              </div>
              <button
                type="button"
                className="btn btn-ghost camera-close"
                onClick={stopCamera}
                aria-label="Close camera"
              >
                Close
              </button>
            </div>

            <div className="camera-stage" ref={stageRef}>
              <video ref={videoRef} autoPlay playsInline muted />
              <div className="license-frame" aria-hidden>
                <span className="corner tl" />
                <span className="corner tr" />
                <span className="corner bl" />
                <span className="corner br" />
              </div>
              <p className="camera-guide-text">
                Fit the driver license inside the outline
              </p>
            </div>

            <div className="camera-modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={stopCamera}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-capture"
                onClick={captureFrame}
              >
                Capture
              </button>
            </div>
          </div>
        </div>
      )}

      {cropSide && cropState?.preview && (
        <CropStraightenModal
          imageSrc={cropState.preview}
          title={`${cropSide === "front" ? "Front" : "Back"} side`}
          onCancel={() => setCropSide(null)}
          onApply={(file) => {
            const side = cropSide;
            setCropSide(null);
            setSideFile(side, file, { openEditor: false, skipAutoCrop: true });
          }}
        />
      )}

      {lightbox && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.title}
        >
          <div
            className="lightbox-backdrop"
            onClick={() => setLightbox(null)}
          />
          <div className="lightbox-sheet">
            <div className="lightbox-head">
              <h2>{lightbox.title}</h2>
              <button
                type="button"
                className="btn btn-ghost lightbox-close"
                onClick={() => setLightbox(null)}
              >
                Close
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="lightbox-image"
              src={lightbox.src}
              alt={lightbox.title}
            />
          </div>
        </div>
      )}
        </>
      )}
    </main>
  );
}
