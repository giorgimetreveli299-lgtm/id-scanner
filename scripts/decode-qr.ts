/**
 * Decode QR from a single image (full frame).
 * Usage: npx tsx scripts/decode-qr.ts <image.jpg>
 */
import fs from "fs";
import { detectQrOnLicenseBack } from "../lib/detectQr";

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.log(JSON.stringify({ error: "Usage: decode-qr.ts <image>" }));
    process.exit(1);
  }
  try {
    const buf = fs.readFileSync(path);
    const result = await detectQrOnLicenseBack(buf);
    console.log(
      JSON.stringify({
        value: result.value || "",
        source: result.source,
        box: result.box,
      })
    );
  } catch (e) {
    console.log(JSON.stringify({ error: String(e), value: "" }));
    process.exit(1);
  }
}

main();
