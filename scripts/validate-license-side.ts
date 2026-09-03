/**
 * CLI: validate a single license photo is the correct side (QR on front → reject).
 * Usage: npx tsx scripts/validate-license-side.ts <front|back> <image.jpg>
 */
import fs from "fs";
import { validateLicenseSide } from "../lib/vision.js";

async function main() {
  const side = process.argv[2];
  const imagePath = process.argv[3];
  if (!side || !imagePath || (side !== "front" && side !== "back")) {
    console.log(
      JSON.stringify({
        ok: false,
        error: "Usage: validate-license-side.ts <front|back> <image>",
      })
    );
    process.exit(1);
  }

  try {
    const buffer = fs.readFileSync(imagePath);
    await validateLicenseSide(buffer, side);
    console.log(JSON.stringify({ ok: true, side }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ ok: false, error: message, side }));
  }
}

main();
