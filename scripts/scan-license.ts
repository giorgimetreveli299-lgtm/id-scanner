/**
 * CLI: scan driver license front + back images → JSON on stdout.
 * Usage: npx tsx scripts/scan-license.ts <front.jpg> <back.jpg>
 *
 * Optional env:
 *   LICENSE_RELAX_SIDES=1 — skip strict front/back side checks
 *   LICENSE_FRONT_TEXT / LICENSE_BACK_TEXT — pre-OCR text (Python fallback)
 */
import fs from "fs";
import { buildLicenseApiPayload } from "../lib/scanOutput.js";
import { scanLicenseSides } from "../lib/vision.js";

async function main() {
  const frontPath = process.argv[2];
  const backPath = process.argv[3];
  if (!frontPath || !backPath) {
    console.log(JSON.stringify({ error: "Usage: scan-license.ts <front> <back>" }));
    process.exit(1);
  }

  try {
    const front = fs.readFileSync(frontPath);
    const back = fs.readFileSync(backPath);
    const relaxSides = process.env.LICENSE_RELAX_SIDES === "1";
    const frontText = process.env.LICENSE_FRONT_TEXT?.trim() || undefined;
    const backText = process.env.LICENSE_BACK_TEXT?.trim() || undefined;
    const result = await scanLicenseSides(front, back, {
      strictSides: !relaxSides,
      frontText,
      backText,
    });
    console.log(JSON.stringify(buildLicenseApiPayload(result)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ ok: false, error: message }));
    process.exit(1);
  }
}

main();
