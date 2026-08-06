import { NextRequest, NextResponse } from "next/server";
import { autoCropAndStraighten } from "@/lib/autoCrop";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("image");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "Please upload an image." },
        { status: 400 }
      );
    }

    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "File is too large (max 10MB)." },
        { status: 400 }
      );
    }

    const input = Buffer.from(await file.arrayBuffer());
    const output = await autoCropAndStraighten(input);

    return new NextResponse(new Uint8Array(output), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("Auto-crop error:", err);
    const message =
      err instanceof Error ? err.message : "Auto crop failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
