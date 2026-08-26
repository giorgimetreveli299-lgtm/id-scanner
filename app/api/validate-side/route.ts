import { NextRequest, NextResponse } from "next/server";
import { validateLicenseSide } from "@/lib/vision";
import {
  BACK_SIDE_REQUIRED_ERROR,
  FRONT_SIDE_REQUIRED_ERROR,
} from "@/lib/types";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("image");
    const sideRaw = String(form.get("side") || "");
    const side = sideRaw === "back" ? "back" : sideRaw === "front" ? "front" : null;

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "Please upload an image." },
        { status: 400 }
      );
    }

    if (!side) {
      return NextResponse.json(
        { error: "Please specify the license side." },
        { status: 400 }
      );
    }

    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "File is too large (max 10MB)." },
        { status: 400 }
      );
    }

    await validateLicenseSide(Buffer.from(await file.arrayBuffer()), side);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Validation failed.";
    if (
      message !== FRONT_SIDE_REQUIRED_ERROR &&
      message !== BACK_SIDE_REQUIRED_ERROR
    ) {
      console.error("Side validation error:", err);
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
