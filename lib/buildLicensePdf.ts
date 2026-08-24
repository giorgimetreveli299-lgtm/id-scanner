import { jsPDF } from "jspdf";

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read image."));
    reader.readAsDataURL(file);
  });
}

function imageFormat(dataUrl: string): "JPEG" | "PNG" | "WEBP" {
  if (dataUrl.startsWith("data:image/png")) return "PNG";
  if (dataUrl.startsWith("data:image/webp")) return "WEBP";
  return "JPEG";
}

function loadImageSize(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
    img.onerror = () => reject(new Error("Could not load image for PDF."));
    img.src = dataUrl;
  });
}

function drawImageOnly(
  doc: jsPDF,
  dataUrl: string,
  pageW: number,
  pageH: number,
  imgW: number,
  imgH: number
) {
  const margin = 10;
  const usableW = pageW - margin * 2;
  const usableH = pageH - margin * 2;
  const scale = Math.min(usableW / imgW, usableH / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  const x = (pageW - drawW) / 2;
  const y = (pageH - drawH) / 2;
  doc.addImage(dataUrl, imageFormat(dataUrl), x, y, drawW, drawH, undefined, "FAST");
}

/** PDF with processed front and back license photos only (no text). */
export async function downloadLicensePdf(opts: {
  front: File;
  back: File;
  fileName?: string;
}): Promise<void> {
  const [frontUrl, backUrl] = await Promise.all([
    fileToDataUrl(opts.front),
    fileToDataUrl(opts.back),
  ]);
  const [frontSize, backSize] = await Promise.all([
    loadImageSize(frontUrl),
    loadImageSize(backUrl),
  ]);

  const doc = new jsPDF({
    orientation: "landscape",
    unit: "mm",
    format: "a4",
  });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  drawImageOnly(doc, frontUrl, pageW, pageH, frontSize.w, frontSize.h);
  doc.addPage();
  drawImageOnly(doc, backUrl, pageW, pageH, backSize.w, backSize.h);

  const stamp = new Date().toISOString().slice(0, 10);
  const name = opts.fileName || `driver-license-${stamp}.pdf`;
  doc.save(name);
}
