/**
 * Checks the car-guide script without a browser:
 * 1. The inline page script parses.
 * 2. Preview URLs resolve from the site root on /car-photo/{id}.
 * 3. Choosing odometer Photos stays on the odometer step.
 * 4. Preview images do not open zoom; a captured photo does.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const vm = require("vm");

const root = path.join(__dirname, "..");
const htmlPath = path.join(root, "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const guidePath = path.join(root, "js", "car-guide.js");
const cropPath = path.join(root, "js", "document-crop.js");
const scriptStart = html.lastIndexOf("<script>");
const scriptEnd = html.lastIndexOf("</script>");
assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "inline script not found");
const script = html.slice(scriptStart + "<script>".length, scriptEnd);

function checkSyntax(filePath, source) {
  const tmp = path.join(os.tmpdir(), `id-scanner-${path.basename(filePath, path.extname(filePath))}.js`);
  fs.writeFileSync(tmp, source);
  const syntax = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
  fs.unlinkSync(tmp);
  if (syntax.status !== 0) {
    console.error(filePath);
    console.error(syntax.stderr || syntax.stdout);
    process.exit(syntax.status || 1);
  }
}
checkSyntax("index.html", script);
checkSyntax(guidePath, fs.readFileSync(guidePath, "utf8"));
checkSyntax(cropPath, fs.readFileSync(cropPath, "utf8"));
const scriptForFns = fs.readFileSync(guidePath, "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

const previewStart = scriptForFns.indexOf("const CAR_PHOTO_PREVIEWS");
const previewEnd = scriptForFns.indexOf("function carPhotoPreviewUrl");
assert.ok(previewStart >= 0 && previewEnd > previewStart, "preview map not found");

const sandbox = {};
vm.runInNewContext(
  [
    scriptForFns.slice(previewStart, previewEnd),
    extractFunction(scriptForFns, "carPhotoPreviewUrl"),
    extractFunction(scriptForFns, "carThumbCell"),
    extractFunction(scriptForFns, "carPhotoStepAfterRemoteChange"),
    extractFunction(html, "carGuideImageOpensZoom"),
    "this.CAR_PHOTO_PREVIEWS = CAR_PHOTO_PREVIEWS;",
    "this.carPhotoPreviewUrl = carPhotoPreviewUrl;",
    "this.carThumbCell = carThumbCell;",
    "this.carPhotoStepAfterRemoteChange = carPhotoStepAfterRemoteChange;",
    "this.carGuideImageOpensZoom = carGuideImageOpensZoom;",
  ].join("\n"),
  sandbox
);

const page = "http://127.0.0.1:8080/car-photo/36";
for (const [slotId, rel] of Object.entries(sandbox.CAR_PHOTO_PREVIEWS)) {
  const url = sandbox.carPhotoPreviewUrl(slotId);
  assert.ok(url.startsWith("/"), `${slotId} preview must start at the site root`);
  const resolved = new URL(url, page);
  assert.strictEqual(resolved.pathname, `/${rel}`, `${slotId} resolved under /car-photo/36`);
}
assert.strictEqual(sandbox.carPhotoPreviewUrl("missing"), "");

const previewThumb = sandbox.carThumbCell("car-front", "Front", "");
assert.ok(previewThumb.includes("car-thumb-preview"), "empty thumb is a preview");
assert.ok(!previewThumb.includes("license-zoomable"), "preview thumb must not zoom");
const capturedThumb = sandbox.carThumbCell("car-front", "Front", "blob:captured");
assert.ok(capturedThumb.includes("license-zoomable"), "captured thumb zooms");
assert.ok(!capturedThumb.includes("car-thumb-preview"), "captured thumb is not a preview");

const slots = [
  { id: "car-front" },
  { id: "car-rear" },
  { id: "car-left" },
  { id: "car-right" },
  { id: "car-engine" },
  { id: "car-front-seat" },
  { id: "car-back-seat" },
  { id: "car-gearbox" },
  { id: "car-vin" },
  { id: "car-truck" },
  { id: "car-odometer", kind: "odometer" },
];
const odoIndex = slots.findIndex((step) => step.kind === "odometer");
const stayed = sandbox.carPhotoStepAfterRemoteChange({
  mediaOrModeChanged: true,
  metaPending: false,
  odometerModeChanged: true,
  slotsChanged: false,
  slots,
  currentIndex: odoIndex,
  isFilled: () => false,
});
assert.strictEqual(stayed, odoIndex, "odometer Photos must stay on the odometer step");

const whileSaving = sandbox.carPhotoStepAfterRemoteChange({
  mediaOrModeChanged: true,
  metaPending: true,
  odometerModeChanged: true,
  slotsChanged: false,
  slots,
  currentIndex: odoIndex,
  isFilled: () => false,
});
assert.strictEqual(whileSaving, odoIndex, "a poll during save must not jump to Front");

function fakeImg(className, src, slot) {
  const classes = new Set(className.split(/\s+/).filter(Boolean));
  return {
    style: { display: "block" },
    classList: { contains: (name) => classes.has(name) },
    getAttribute: (name) => (name === "src" ? src : ""),
    closest: (sel) => (sel === ".slot-box" ? slot : null),
  };
}

assert.strictEqual(
  sandbox.carGuideImageOpensZoom(fakeImg("license-zoomable car-slot-preview", "/car-previews/car-front.jpg", null)),
  false
);
assert.strictEqual(
  sandbox.carGuideImageOpensZoom(fakeImg("license-zoomable", "blob:captured", { classList: { contains: (n) => n === "done" } })),
  true
);
assert.strictEqual(
  sandbox.carGuideImageOpensZoom(fakeImg("license-zoomable", "blob:captured", { classList: { contains: () => false } })),
  false
);

console.log("car guide checks passed");
