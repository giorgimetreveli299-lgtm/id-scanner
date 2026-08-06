import { NextRequest, NextResponse } from "next/server";
import { scanLicenseSides } from "@/lib/vision";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

function validateImage(file: FormDataEntryValue | null, label: string): File | NextResponse {
  if (!file || !(file instanceof File)) {
    return NextResponse.json(
      { error: `Please upload the ${label} of the license.` },
      { status: 400 }
    );
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `${label} file is too large (max 10MB).` },
      { status: 400 }
    );
  }

  if (file.type && !ALLOWED.has(file.type) && !file.type.startsWith("image/")) {
    return NextResponse.json(
      { error: `Only image files are allowed for the ${label}.` },
      { status: 400 }
    );
  }

  return file;
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const frontCheck = validateImage(form.get("front"), "front");
    if (frontCheck instanceof NextResponse) return frontCheck;
    const backCheck = validateImage(form.get("back"), "back");
    if (backCheck instanceof NextResponse) return backCheck;

    const result = await scanLicenseSides(
      Buffer.from(await frontCheck.arrayBuffer()),
      Buffer.from(await backCheck.arrayBuffer())
    );

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scan failed.";
    console.error("OCR error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
