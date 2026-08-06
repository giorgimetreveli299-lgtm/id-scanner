"use client";

import { useCallback, useEffect, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { getCroppedImageFile } from "@/lib/cropImage";

/** ISO ID-1 card ratio */
const LICENSE_RATIO = 85.6 / 53.98;

type Props = {
  imageSrc: string;
  title: string;
  onCancel: () => void;
  onApply: (file: File) => void;
};

export default function CropStraightenModal({
  imageSrc,
  title,
  onCancel,
  onApply,
}: Props) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [busy, onCancel]);

  const onCropComplete = useCallback((_: Area, pixels: Area) => {
    setCroppedAreaPixels(pixels);
  }, []);

  const apply = async () => {
    if (!croppedAreaPixels) return;
    setBusy(true);
    setError(null);
    try {
      const file = await getCroppedImageFile(
        imageSrc,
        croppedAreaPixels,
        rotation,
        "license-cropped.jpg"
      );
      onApply(file);
    } catch {
      setError("Could not apply crop. Try again.");
      setBusy(false);
    }
  };

  return (
    <div
      className="crop-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Crop and straighten"
    >
      <div className="crop-modal-backdrop" onClick={() => !busy && onCancel()} />
      <div className="crop-modal-sheet">
        <div className="crop-modal-head">
          <div>
            <p className="crop-modal-kicker">Crop and straighten</p>
            <h2>{title}</h2>
          </div>
          <button
            type="button"
            className="btn btn-ghost crop-close"
            onClick={onCancel}
            disabled={busy}
          >
            Close
          </button>
        </div>

        <div className="crop-stage">
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            rotation={rotation}
            aspect={LICENSE_RATIO}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onRotationChange={setRotation}
            onCropComplete={onCropComplete}
            showGrid
            objectFit="contain"
          />
        </div>

        <div className="crop-controls">
          <label className="crop-slider">
            <span>Straighten</span>
            <input
              type="range"
              min={-45}
              max={45}
              step={0.5}
              value={rotation}
              onChange={(e) => setRotation(Number(e.target.value))}
            />
            <em>{rotation.toFixed(1)}°</em>
          </label>
          <label className="crop-slider">
            <span>Zoom</span>
            <input
              type="range"
              min={1}
              max={3}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
            <em>{zoom.toFixed(2)}×</em>
          </label>
          <div className="crop-quick">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setRotation((r) => Math.max(-45, r - 1))}
            >
              −1°
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setRotation(0)}
            >
              Reset angle
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setRotation((r) => Math.min(45, r + 1))}
            >
              +1°
            </button>
          </div>
        </div>

        {error && <p className="status err crop-error">{error}</p>}

        <div className="crop-modal-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void apply()}
            disabled={busy || !croppedAreaPixels}
          >
            {busy ? <span className="spinner" aria-hidden /> : null}
            {busy ? "Applying…" : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
