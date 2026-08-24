"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  DASHBOARD_FIELDS,
  fieldTitle,
  sanitizePlaceOfBirth,
  type DashboardField,
  type LicenseFields,
} from "@/lib/parseLicense";
import type { FaceBox } from "@/lib/types";
import CropStraightenModal from "@/components/CropStraightenModal";
import { downloadLicensePdf } from "@/lib/buildLicensePdf";
import {
  formatBilingualName,
  formatBilingualPlace,
  formatResidence,
  joinBilingualName,
  splitBilingualName,
} from "@/lib/georgianTranslit";

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

export default function HomePage() {
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

  const frontInputRef = useRef<HTMLInputElement>(null);
  const backInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scannedPairRef = useRef<string | null>(null);
  const scanningRef = useRef(false);

  const bothReady = Boolean(front.file && back.file);
  const pairKey =
    front.file && back.file
      ? `${front.file.name}:${front.file.size}:${front.file.lastModified}|${back.file.name}:${back.file.size}:${back.file.lastModified}`
      : null;
  // Extract only after both sides are present and no camera/crop/auto-crop is active
  const canExtract =
    bothReady && !cropSide && !cameraSide && !autoCropping;
  const showResults = canExtract && (loading || scanned || Boolean(error));

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraSide(null);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

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

  const setSideFile = useCallback(
    (
      side: Side,
      next: File,
      options?: { openEditor?: boolean; skipAutoCrop?: boolean }
    ) => {
      if (side === "back" && !front.file) {
        setError("Upload the front side before adding the back.");
        return;
      }
      stopCamera();
      setError(null);
      setForm(EMPTY_FIELDS);
      setScanned(false);
      setHolderPhoto(null);
      setHolderSignature(null);
      setQrCodeImage(null);
      setQrCodeValue(null);
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

      if (options?.skipAutoCrop) return;

      void (async () => {
        setAutoCropping(side);
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 14000);
        try {
          const body = new FormData();
          body.append("image", next);
          const res = await fetch("/api/autocrop", {
            method: "POST",
            body,
            signal: controller.signal,
          });
          if (!res.ok) return;
          const blob = await res.blob();
          if (!blob.type.startsWith("image/")) return;
          const processed = new File([blob], `license-${side}-auto.jpg`, {
            type: "image/jpeg",
          });
          const processedUrl = URL.createObjectURL(processed);
          const apply = (prev: SideState): SideState => {
            revokePreview(prev.preview);
            return { file: processed, preview: processedUrl };
          };
          setForm(EMPTY_FIELDS);
          setScanned(false);
          setHolderPhoto(null);
          setHolderSignature(null);
          setQrCodeImage(null);
          setQrCodeValue(null);
          scannedPairRef.current = null;
          if (side === "front") setFront(apply);
          else setBack(apply);
        } catch {
          // Keep original if auto-crop fails / times out
        } finally {
          window.clearTimeout(timer);
          setAutoCropping((current) => (current === side ? null : current));
        }
      })();
    },
    [stopCamera, front.file]
  );

  const clearSide = (side: Side) => {
    stopCamera();
    setError(null);
    setForm(EMPTY_FIELDS);
    setScanned(false);
    setHolderPhoto(null);
    setHolderSignature(null);
    setQrCodeImage(null);
    setQrCodeValue(null);
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

  const newDriver = () => {
    stopCamera();
    setError(null);
    setForm(EMPTY_FIELDS);
    setScanned(false);
    setHolderPhoto(null);
    setHolderSignature(null);
    setQrCodeImage(null);
    setQrCodeValue(null);
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
    if (side === "back" && !front.file) {
      setError("Upload the front side before capturing the back.");
      return;
    }
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
    try {
      const body = new FormData();
      body.append("front", front.file);
      body.append("back", back.file);
      const res = await fetch("/api/scan", { method: "POST", body });
      const data = (await res.json()) as ScanResponse;
      if (!res.ok || data.error) {
        throw new Error(data.error || "Scan failed.");
      }
      if (data.fields) setForm(fieldsToForm(data.fields));
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
      setError(err instanceof Error ? err.message : "Error");
      setScanned(false);
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

  const renderSideCard = (side: Side, state: SideState) => {
    const label = side === "front" ? "Front" : "Back";
    const inputRef = side === "front" ? frontInputRef : backInputRef;
    const locked = side === "back" && !front.file;

    return (
      <div className={`side-card ${locked ? "locked" : ""}`}>
        <div className="side-card-head">
          <h2>{label}</h2>
          {locked ? (
            <span className="side-badge">Upload front first</span>
          ) : autoCropping === side ? (
            <span className="side-badge">Cropping…</span>
          ) : state.file ? (
            <span className="side-badge ready">Ready</span>
          ) : (
            <span className="side-badge">Required</span>
          )}
        </div>

        <div
          className={`dropzone compact ${dragging === side ? "active" : ""} ${state.preview ? "has-preview" : ""} ${locked ? "locked" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            if (locked) return;
            setDragging(side);
          }}
          onDragLeave={() => setDragging(null)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(null);
            if (locked) return;
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
            disabled={locked}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f && !locked) setSideFile(side, f);
              e.target.value = "";
            }}
          />
        </div>

        <div className="actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={locked || autoCropping === side}
            onClick={() => inputRef.current?.click()}
          >
            Upload
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={locked || autoCropping === side}
            onClick={() => startCamera(side)}
          >
            Camera
          </button>
          {state.file && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={autoCropping === side}
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

  const cropState = cropSide === "front" ? front : cropSide === "back" ? back : null;

  const renderTextField = (field: DashboardField) => {
    const textKey = field.key as keyof LicenseFields;
    const title = fieldTitle(field);
    const bilingualKeys: (keyof LicenseFields)[] = [
      "surname",
      "givenNames",
      "placeOfBirth",
      "residence",
    ];

    if (bilingualKeys.includes(textKey)) {
      const raw = form[textKey];
      const normalized =
        textKey === "residence"
          ? formatResidence(raw) || raw
          : textKey === "placeOfBirth"
            ? formatBilingualPlace(raw) || raw
            : formatBilingualName(raw) || raw;
      const { geo, latin } = splitBilingualName(normalized);
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
              onChange={(e) => {
                const nextGeo = e.target.value;
                setForm((prev) => {
                  const parts = splitBilingualName(prev[textKey]);
                  return {
                    ...prev,
                    [textKey]: joinBilingualName(nextGeo, parts.latin),
                  };
                });
              }}
            />
            <input
              id={`${textKey}-en`}
              value={latin}
              maxLength={field.maxLength}
              aria-label={`${title} (English)`}
              placeholder="—"
              onChange={(e) => {
                const nextLatin = e.target.value;
                setForm((prev) => {
                  const parts = splitBilingualName(prev[textKey]);
                  return {
                    ...prev,
                    [textKey]: joinBilingualName(parts.geo, nextLatin),
                  };
                });
              }}
            />
          </div>
        </div>
      );
    }

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
      </div>
    );
  };

  return (
    <main className="shell">
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
      </section>

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
                            <details className="qr-details">
                              <summary>
                                {qrCodeValue
                                  ? "QR ინფორმაცია / QR data"
                                  : "ინფორმაცია არ წაიკითხა / No data"}
                              </summary>
                              <pre className="qr-payload">
                                {qrCodeValue || "—"}
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
                  onClick={newDriver}
                >
                  New Driver
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
    </main>
  );
}
