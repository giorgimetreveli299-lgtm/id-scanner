function isCarPhotoSlot(slot) {
  return typeof slot === "string" && slot.startsWith("car-");
}

function isCarOdometerVideoSlot(slot) {
  return slot === "car-odometer-video";
}

function isCarGuideVideoSlot(slot) {
  return slot === "car-odometer-video" || slot === "car-roof";
}

function carGuideVideoEl(slot) {
  if (slot === "car-roof") return document.getElementById("video-car-roof");
  return document.getElementById("video-car-odometer");
}

function carGuideVideoRecordBtn(slot) {
  if (slot === "car-roof") return document.getElementById("btn-roof-video-capture");
  return document.getElementById("btn-odo-video-capture");
}

const CAR_ODOMETER_PHOTO_SLOTS = [
  { id: "car-odometer-before", title: "Before starting the engine" },
  { id: "car-odometer-after", title: "After starting the engine" },
];
const CAR_ODOMETER_VIDEO_SLOT = {
  id: "car-odometer-video",
  title: "Odometer video",
};

const CAR_ROOF_SLOT = { id: "car-roof", title: "Roof", kind: "video" };

const CAR_PHOTO_SLOTS = [
  { id: "car-front", title: "Front" },
  { id: "car-rear", title: "Rear" },
  { id: "car-left", title: "Left side" },
  { id: "car-right", title: "Right side" },
  { id: "car-engine", title: "Engine" },
  { id: "car-front-seat", title: "Front seat" },
  { id: "car-back-seat", title: "Back seat" },
  { id: "car-gearbox", title: "Gearbox" },
  { id: "car-vin", title: "VIN" },
  { id: "car-truck", title: "Truck" },
  {
    id: "car-odometer",
    title: "Odometer",
    kind: "odometer",
    photoChildren: CAR_ODOMETER_PHOTO_SLOTS,
    videoChild: CAR_ODOMETER_VIDEO_SLOT,
  },
];

const CAR_PHOTO_PREVIEWS = {
  "car-front": "car-previews/car-front.jpg",
  "car-rear": "car-previews/car-rear.jpg",
  "car-left": "car-previews/car-left.jpg",
  "car-right": "car-previews/car-right.jpg",
  "car-engine": "car-previews/car-engine.jpg",
  "car-front-seat": "car-previews/car-front-seat.jpg",
  "car-back-seat": "car-previews/car-back-seat.jpg",
  "car-gearbox": "car-previews/car-gearbox.jpg",
  "car-vin": "car-previews/car-vin.png",
  "car-roof": "car-previews/car-roof.png",
  "car-truck": "car-previews/car-truck.jpg",
  "car-odometer": "car-previews/car-odometer.jpg",
  "car-odometer-before": "car-previews/car-odometer-before.jpg",
  "car-odometer-after": "car-previews/car-odometer-after.jpg",
};

function carPhotoPreviewUrl(slotId) {
  const path = CAR_PHOTO_PREVIEWS[slotId] || "";
  if (!path) return "";
  return path.charAt(0) === "/" ? path : `/${path}`;
}

function carThumbCell(slotId, title, capturedUrl) {
  const url = capturedUrl || carPhotoPreviewUrl(slotId);
  if (!url) return `<div class="car-thumb-empty">—</div>`;
  if (!capturedUrl) {
    return `<img class="car-thumb-preview" src="${url}" alt="${title}">`;
  }
  return `<img class="license-zoomable" src="${url}" alt="${title}">`;
}

const carPhotoBlobs = {};
const carPhotoDataUrls = {};
let carPhotoStepIndex = 0;
let carOdometerMode = null; // null | "photos" | "video"
let carCabriolet = false;
let carOdoRecordStream = null;
let carOdoRecorder = null;
let carOdoRecordChunks = [];
let carVideoRecordSlot = null;
let carSessionId = null;
let carSessionToken = "";
let carSessionPollTimer = null;
let carSessionLastRevision = -1;
let carSessionKnownSlots = {}; // slotId -> updatedAt
let carSessionSkipPush = false;
let carSessionPushMetaTimer = null;
let carSessionReadOnly = false;
// Local guide edits (odometer mode, cabriolet) until the server confirms them.
let carSessionMetaEpoch = 0;
let carSessionMetaEpochSynced = 0;

function carPhotoEditsBlocked() {
  if (carSessionReadOnly) return true;
  const view = document.getElementById("car-photo-view");
  return Boolean(view && view.classList.contains("is-lock-pending"));
}

function syncCarSessionReadOnlyClass() {
  const view = document.getElementById("car-photo-view");
  if (!view) return;
  if (carPhotoGuideComplete()) carSessionReadOnly = true;
  view.classList.toggle("is-readonly", carSessionReadOnly);
  if (carSessionReadOnly) view.classList.remove("is-lock-pending");
}

function carSessionAuthHeaders(extra) {
  const headers = Object.assign({}, extra || {});
  if (carSessionToken) headers["X-Car-Session-Token"] = carSessionToken;
  return headers;
}

function carPhotoSessionUrl(sessionId) {
  const id = Number(sessionId);
  if (!Number.isFinite(id) || id < 1 || !carSessionToken) return "";
  return `${window.location.origin}/car-photo/${id}?k=${encodeURIComponent(carSessionToken)}`;
}

function setCarPhotoSessionInUrl(sessionId) {
  const id = Number(sessionId);
  if (!Number.isFinite(id) || id < 1 || !carSessionToken) return;
  const next = `/car-photo/${id}?k=${encodeURIComponent(carSessionToken)}`;
  if (`${window.location.pathname}${window.location.search}` !== next) {
    history.replaceState({ carSessionId: id }, "", next);
  }
}

function stopCarSessionPoll() {
  if (carSessionPollTimer) {
    clearInterval(carSessionPollTimer);
    carSessionPollTimer = null;
  }
  if (carSessionPushMetaTimer) {
    clearTimeout(carSessionPushMetaTimer);
    carSessionPushMetaTimer = null;
  }
}

function clearCarPhotoSessionUrl() {
  stopCarSessionPoll();
  carSessionId = null;
  carSessionToken = "";
  carSessionLastRevision = -1;
  carSessionKnownSlots = {};
  carSessionReadOnly = false;
  document.getElementById("car-photo-view")?.classList.remove("is-readonly", "is-lock-pending");
  if (/^\/car-photo\/\d+\/?$/.test(window.location.pathname)) {
    history.replaceState({}, "", "/");
  }
  const label = document.getElementById("car-session-label");
  const qrHost = document.getElementById("car-session-qr");
  if (label) label.textContent = "—";
  if (qrHost) qrHost.innerHTML = "";
}

function renderCarSessionQr(sessionId) {
  const id = Number(sessionId);
  const label = document.getElementById("car-session-label");
  const qrHost = document.getElementById("car-session-qr");
  if (!label || !qrHost) return;

  if (!Number.isFinite(id) || id < 1) {
    label.textContent = "—";
    qrHost.innerHTML = "";
    return;
  }

  const url = carPhotoSessionUrl(id);
  label.textContent = `#${id}`;
  qrHost.innerHTML = "";
  if (typeof QRCode === "function") {
    try {
      new QRCode(qrHost, {
        text: url,
        width: 180,
        height: 180,
        colorDark: "#2a1840",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.M,
      });
      return;
    } catch (err) {
      console.warn("QR render failed:", err);
    }
  }
  qrHost.innerHTML = `<p style="margin:0;font-size:0.85rem;color:var(--muted);">Session #${id}</p>`;
}

async function allocateNextCarSessionId() {
  // Global counter on the shared server — unique across all office PCs
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${window.location.origin}/api/car-sessions/next`, {
        method: "POST",
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`session allocate failed: ${res.status}`);
      const data = await res.json();
      const id = Number(data && data.id);
      const token = data && data.token;
      if (!Number.isFinite(id) || id < 1 || !token) throw new Error("invalid session id");
      carSessionToken = String(token);
      return id;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  throw lastErr || new Error("session allocate failed");
}

function carSessionMetaPending() {
  return carSessionMetaEpoch !== carSessionMetaEpochSynced || Boolean(carSessionPushMetaTimer);
}

function scheduleCarSessionMetaPush() {
  if (!carSessionId || carSessionSkipPush || carSessionReadOnly) return;
  carSessionMetaEpoch += 1;
  const epoch = carSessionMetaEpoch;
  if (carSessionPushMetaTimer) clearTimeout(carSessionPushMetaTimer);
  carSessionPushMetaTimer = setTimeout(() => {
    carSessionPushMetaTimer = null;
    pushCarSessionMeta(epoch).catch((err) => console.warn("car session meta push:", err));
  }, 250);
}

async function pushCarSessionMeta(epoch) {
  if (!carSessionId || carSessionReadOnly) {
    if (epoch === carSessionMetaEpoch) carSessionMetaEpochSynced = epoch;
    return;
  }
  if (carSessionSkipPush) {
    if (epoch === carSessionMetaEpoch) {
      carSessionPushMetaTimer = setTimeout(() => {
        carSessionPushMetaTimer = null;
        pushCarSessionMeta(epoch).catch((err) => console.warn("car session meta push:", err));
      }, 300);
    }
    return;
  }
  const res = await fetch(
    `${window.location.origin}/api/car-sessions/${carSessionId}/meta`,
    {
      method: "PUT",
      headers: carSessionAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        stepIndex: carPhotoStepIndex,
        cabriolet: Boolean(carCabriolet),
        odometerMode: carOdometerMode,
      }),
    }
  );
  if (res.status === 409) {
    carSessionReadOnly = true;
    syncCarSessionReadOnlyClass();
    updateCarPhotoStepHint();
    return;
  }
  if (!res.ok) throw new Error(`meta push failed: ${res.status}`);
  const data = await res.json();
  if (data && Number.isFinite(Number(data.revision))) {
    carSessionLastRevision = Number(data.revision);
  }
  if (epoch === carSessionMetaEpoch) carSessionMetaEpochSynced = epoch;
}

async function pushCarSessionSlot(slotId, blob) {
  if (!carSessionId || carSessionSkipPush || !slotId || !blob) return;
  if (carSessionReadOnly && carSessionKnownSlots[slotId] != null) return;
  const fd = new FormData();
  const isVideo = isCarGuideVideoSlot(slotId);
  const filename = isVideo
    ? `${slotId}.webm`
    : `${slotId}.jpg`;
  fd.append("file", blob, filename);
  const res = await fetch(
    `${window.location.origin}/api/car-sessions/${carSessionId}/slots/${encodeURIComponent(slotId)}`,
    { method: "POST", body: fd, headers: carSessionAuthHeaders() }
  );
  if (res.status === 409) {
    carSessionReadOnly = true;
    syncCarSessionReadOnlyClass();
    updateCarPhotoStepHint();
    pullCarSessionState().catch((err) => console.warn("car session relock pull:", err));
    return;
  }
  if (!res.ok) throw new Error(`slot push failed: ${res.status}`);
  const data = await res.json();
  if (data && data.readOnly) carSessionReadOnly = true;
  if (data && data.slot && data.slot.updatedAt != null) {
    carSessionKnownSlots[slotId] = data.slot.updatedAt;
  }
  if (data && Number.isFinite(Number(data.revision))) {
    carSessionLastRevision = Number(data.revision);
  }
  scheduleCarSessionMetaPush();
}

async function deleteCarSessionSlotRemote(slotId) {
  if (!carSessionId || carSessionSkipPush || carSessionReadOnly || !slotId) return;
  const res = await fetch(
    `${window.location.origin}/api/car-sessions/${carSessionId}/slots/${encodeURIComponent(slotId)}`,
    { method: "DELETE", headers: carSessionAuthHeaders() }
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`slot delete failed: ${res.status}`);
  }
  delete carSessionKnownSlots[slotId];
  try {
    const data = await res.json();
    if (data && Number.isFinite(Number(data.revision))) {
      carSessionLastRevision = Number(data.revision);
    }
  } catch (_) {}
  scheduleCarSessionMetaPush();
}

async function clearLocalCarSlotMedia(slotId, opts = {}) {
  const fromRemote = Boolean(opts.fromRemote);
  const url = carPhotoDataUrls[slotId];
  if (url && String(url).startsWith("blob:")) {
    try { URL.revokeObjectURL(url); } catch (_) {}
  }
  delete carPhotoBlobs[slotId];
  delete carPhotoDataUrls[slotId];
  if (isCarGuideVideoSlot(slotId)) {
    const vidEl = carGuideVideoEl(slotId);
    if (vidEl) {
      vidEl.removeAttribute("src");
      vidEl.srcObject = null;
      vidEl.style.display = "none";
    }
  }
  if (!fromRemote) {
    try {
      await deleteCarSessionSlotRemote(slotId);
    } catch (err) {
      console.warn("car session slot delete:", err);
    }
  }
}

async function applyRemoteCarSlot(slotId, blob, contentType) {
  carSessionSkipPush = true;
  try {
    const isVideo =
      String(contentType || "").startsWith("video") || isCarGuideVideoSlot(slotId);
    if (isVideo) {
      applyCarVideoSlot(blob, slotId, { fromRemote: true });
    } else {
      const prev = carPhotoDataUrls[slotId];
      if (prev && String(prev).startsWith("blob:")) {
        try { URL.revokeObjectURL(prev); } catch (_) {}
      }
      const url = URL.createObjectURL(blob);
      carPhotoBlobs[slotId] = blob;
      carPhotoDataUrls[slotId] = url;
    }
  } finally {
    carSessionSkipPush = false;
  }
}

async function pullCarSessionState() {
  if (!carSessionId) return;
  const res = await fetch(
    `${window.location.origin}/api/car-sessions/${carSessionId}`,
    { cache: "no-store", headers: carSessionAuthHeaders() }
  );
  if (!res.ok) throw new Error(`session pull failed: ${res.status}`);
  const meta = await res.json();
  const revision = Number(meta && meta.revision);
  if (
    Number.isFinite(revision) &&
    carSessionLastRevision >= 0 &&
    revision < carSessionLastRevision
  ) {
    document.getElementById("car-photo-view")?.classList.remove("is-lock-pending");
    return;
  }
  const remoteSlots = (meta && meta.slots) || {};
  const metaPending = carSessionMetaPending();
  if (meta && meta.readOnly) {
    carSessionReadOnly = true;
    const view = document.getElementById("car-photo-view");
    if (view) {
      view.classList.add("is-readonly");
      view.classList.remove("is-lock-pending");
    }
  }
  // Only jump steps when remote media/mode actually changed.
  // Blindly applying meta.stepIndex rewound the UI after capture
  // (stale poll overwrote local advanceCarPhotoStep).
  let mediaOrModeChanged = false;

  // Apply guide meta from remote (phone / office stay aligned).
  // While a local Photos/Video choice is still being saved, a poll
  // that left before that save must not put the guide back on Front.
  let odometerModeChanged = false;
  let slotsChanged = false;
  carSessionSkipPush = true;
  try {
    if (!metaPending) {
      const nextCabriolet = Boolean(meta.cabriolet);
      if (nextCabriolet !== carCabriolet) {
        carCabriolet = nextCabriolet;
        const cabCb = document.getElementById("car-cabriolet");
        if (cabCb) cabCb.checked = carCabriolet;
        if (!carCabriolet) await clearCarRoofMedia();
        mediaOrModeChanged = true;
      }
      const nextOdo =
        meta.odometerMode === "photos" || meta.odometerMode === "video"
          ? meta.odometerMode
          : null;
      if (nextOdo !== carOdometerMode) {
        carOdometerMode = nextOdo;
        odometerModeChanged = true;
        mediaOrModeChanged = true;
      }
    }
  } finally {
    carSessionSkipPush = false;
  }

  // Remove local slots deleted remotely
  for (const localId of Object.keys(carSessionKnownSlots)) {
    if (!(localId in remoteSlots)) {
      delete carSessionKnownSlots[localId];
      carSessionSkipPush = true;
      try {
        await clearLocalCarSlotMedia(localId, { fromRemote: true });
        slotsChanged = true;
        mediaOrModeChanged = true;
      } finally {
        carSessionSkipPush = false;
      }
    }
  }

  // Download new/updated slots
  for (const [slotId, slotMeta] of Object.entries(remoteSlots)) {
    const updatedAt = slotMeta && slotMeta.updatedAt;
    if (updatedAt != null && carSessionKnownSlots[slotId] === updatedAt) continue;
    const fileRes = await fetch(
      `${window.location.origin}/api/car-sessions/${carSessionId}/slots/${encodeURIComponent(slotId)}`,
      { cache: "no-store", headers: carSessionAuthHeaders() }
    );
    if (!fileRes.ok) continue;
    const blob = await fileRes.blob();
    await applyRemoteCarSlot(slotId, blob, slotMeta.contentType || blob.type);
    carSessionKnownSlots[slotId] = updatedAt;
    slotsChanged = true;
    mediaOrModeChanged = true;
  }

  if (Number.isFinite(revision) && revision > carSessionLastRevision) {
    carSessionLastRevision = revision;
  }

  carPhotoStepIndex = carPhotoStepAfterRemoteChange({
    mediaOrModeChanged,
    metaPending: carSessionMetaPending(),
    odometerModeChanged,
    slotsChanged,
    slots: activeCarPhotoSlots(),
    currentIndex: carPhotoStepIndex,
    isFilled: carPhotoStepFilled,
  });
  refreshCarPhotoStage();
  document.getElementById("car-photo-view")?.classList.remove("is-lock-pending");
}

function carPhotoStepAfterRemoteChange(state) {
  const slots = state.slots || [];
  if (state.mediaOrModeChanged && !state.metaPending) {
    if (state.odometerModeChanged && !state.slotsChanged) {
      const odoIdx = slots.findIndex((step) => step.kind === "odometer");
      if (odoIdx >= 0) return odoIdx;
      return state.currentIndex;
    }
    const nextEmpty = slots.findIndex((step) => !state.isFilled(step));
    return nextEmpty >= 0 ? nextEmpty : Math.max(0, slots.length - 1);
  }
  const maxIdx = Math.max(0, slots.length - 1);
  return Math.max(0, Math.min(maxIdx, state.currentIndex));
}

function startCarSessionPoll() {
  stopCarSessionPoll();
  if (!carSessionId) return;
  carSessionPollTimer = setInterval(() => {
    pullCarSessionState().catch((err) => console.warn("car session poll:", err));
  }, 1600);
  pullCarSessionState().catch((err) => console.warn("car session pull:", err));
}

async function enterCarPhotoGuide(options = {}) {
  const allocate = options.allocate !== false;
  const existingId = Number(options.sessionId);
  const needNew = allocate || !Number.isFinite(existingId) || existingId < 1;

  if (!needNew) {
    carSessionToken = String(options.token || "");
    if (!carSessionToken) {
      alert("This session link is missing its key.");
      showMethodChoice();
      return;
    }
  }

  selectedMethod = "car-photo";
  clearPassportUploadError();
  clearIdUploadError();
  stopCarSessionPoll();
  carSessionReadOnly = false;
  document.getElementById("car-photo-view")?.classList.remove("is-readonly", "is-lock-pending");
  document.getElementById("method-choice").classList.add("hidden");
  document.getElementById("scanner-view").classList.remove("visible");
  document.getElementById("passport-view").classList.remove("visible");
  document.getElementById("license-view").classList.remove("visible");
  document.getElementById("tech-passport-view")?.classList.remove("visible");
  document.getElementById("car-photo-view")?.classList.add("visible");
  window.scrollTo({ top: 0, behavior: "auto" });

  await resetCarPhotoGuide();
  carSessionKnownSlots = {};
  carSessionLastRevision = -1;

  let id = existingId;
  if (needNew) {
    carSessionId = null;
    carSessionToken = "";
    try {
      // Always from shared server counter so PC-A=#1, PC-B=#2, …
      id = await allocateNextCarSessionId();
    } catch (err) {
      console.warn("car session allocate failed:", err);
      alert(
        "Could not create a new session number from the server.\n" +
          "Check that all PCs use the same server address, then try again."
      );
      showMethodChoice();
      return;
    }
  }

  carSessionId = id;
  setCarPhotoSessionInUrl(id);
  renderCarSessionQr(id);

  if (!needNew) {
    document.getElementById("car-photo-view")?.classList.add("is-lock-pending");
  }

  // Joining an existing session: load photos already taken on the other device
  if (!needNew) {
    try {
      await pullCarSessionState();
    } catch (err) {
      console.warn("car session join pull:", err);
    }
  } else {
    scheduleCarSessionMetaPush();
  }
  startCarSessionPoll();
}

/** Active guide steps — inserts Roof before Odometer when Cabriolet is checked. */
function activeCarPhotoSlots() {
  if (!carCabriolet) return CAR_PHOTO_SLOTS;
  const out = [];
  CAR_PHOTO_SLOTS.forEach((step) => {
    if (step.kind === "odometer") out.push(CAR_ROOF_SLOT);
    out.push(step);
  });
  return out;
}

async function clearCarRoofMedia() {
  const id = CAR_ROOF_SLOT.id;
  if (carVideoRecordSlot === id) await stopCarGuideVideoRecording(false);
  const url = carPhotoDataUrls[id];
  if (url && String(url).startsWith("blob:")) {
    try { URL.revokeObjectURL(url); } catch (_) {}
  }
  delete carPhotoBlobs[id];
  delete carPhotoDataUrls[id];
  const vidEl = document.getElementById("video-car-roof");
  if (vidEl) {
    vidEl.removeAttribute("src");
    vidEl.srcObject = null;
    vidEl.style.display = "none";
  }
  if (!carSessionSkipPush) {
    deleteCarSessionSlotRemote(id).catch((err) =>
      console.warn("car session roof delete:", err)
    );
  }
}

async function setCarCabriolet(checked) {
  if (carPhotoEditsBlocked()) {
    const cabCb = document.getElementById("car-cabriolet");
    if (cabCb) cabCb.checked = carCabriolet;
    return;
  }
  const next = Boolean(checked);
  if (next === carCabriolet) {
    refreshCarPhotoStage();
    return;
  }
  carCabriolet = next;
  if (!carCabriolet) await clearCarRoofMedia();
  const slots = activeCarPhotoSlots();
  carPhotoStepIndex = Math.max(0, Math.min(slots.length - 1, carPhotoStepIndex));
  clearCarUploadError();
  refreshCarPhotoStage();
  scheduleCarSessionMetaPush();
}

function carOdometerAllIds() {
  return [
    ...CAR_ODOMETER_PHOTO_SLOTS.map((s) => s.id),
    CAR_ODOMETER_VIDEO_SLOT.id,
  ];
}

function carPhotoLeafSlots() {
  const out = [];
  activeCarPhotoSlots().forEach((step) => {
    if (step.kind === "odometer") {
      if (carOdometerMode === "photos") out.push(...step.photoChildren);
      else if (carOdometerMode === "video") out.push(step.videoChild);
      return;
    }
    out.push(step);
  });
  return out;
}

/** Photo slots for the PDF (includes odometer before/after when no video was chosen). */
function carPhotoPdfSlots() {
  const out = [];
  activeCarPhotoSlots().forEach((step) => {
    if (step.kind === "video" || isCarGuideVideoSlot(step.id)) return;
    if (step.kind === "odometer") {
      const hasVideo = Boolean(carPhotoDataUrls[step.videoChild.id]);
      if (hasVideo) return;
      (step.photoChildren || []).forEach((child) => {
        if (carPhotoDataUrls[child.id]) out.push(child);
      });
      return;
    }
    if (carPhotoDataUrls[step.id]) out.push(step);
  });
  return out;
}

function carPhotoVideoSlots() {
  const out = [];
  if (carPhotoDataUrls[CAR_ODOMETER_VIDEO_SLOT.id] || carPhotoBlobs[CAR_ODOMETER_VIDEO_SLOT.id]) {
    out.push(CAR_ODOMETER_VIDEO_SLOT);
  }
  if (carCabriolet && (carPhotoDataUrls[CAR_ROOF_SLOT.id] || carPhotoBlobs[CAR_ROOF_SLOT.id])) {
    out.push(CAR_ROOF_SLOT);
  }
  return out;
}

function carPhotoGuideComplete() {
  const slots = activeCarPhotoSlots();
  return slots.length > 0 && slots.every((step) => carPhotoStepFilled(step));
}

function carPhotoStepFilled(step) {
  if (!step) return false;
  if (step.kind === "odometer") {
    if (carOdometerMode === "photos") {
      return step.photoChildren.every(({ id }) => Boolean(carPhotoDataUrls[id]));
    }
    if (carOdometerMode === "video") {
      return Boolean(carPhotoDataUrls[step.videoChild.id]);
    }
    return false;
  }
  if (step.kind === "video" || isCarGuideVideoSlot(step.id)) {
    return Boolean(carPhotoDataUrls[step.id]);
  }
  return Boolean(carPhotoDataUrls[step.id]);
}

function carPhotoStepIndexForSlot(slot) {
  return activeCarPhotoSlots().findIndex((step) => {
    if (step.id === slot) return true;
    if (step.kind === "odometer") {
      if (step.photoChildren?.some((c) => c.id === slot)) return true;
      if (step.videoChild?.id === slot) return true;
    }
    return false;
  });
}

function currentCarPhotoSlot() {
  const slots = activeCarPhotoSlots();
  const step = slots[carPhotoStepIndex] || slots[0];
  if (step?.kind === "odometer") {
    if (carOdometerMode === "photos") {
      const empty = step.photoChildren.find(({ id }) => !carPhotoDataUrls[id]);
      return (empty || step.photoChildren[0]).id;
    }
    if (carOdometerMode === "video") return step.videoChild.id;
    return step.id;
  }
  return step ? step.id : "car-front";
}

async function clearCarOdometerMedia(modeToKeep) {
  await stopCarOdometerRecording(false);
  const clearId = async (id) => {
    const url = carPhotoDataUrls[id];
    if (url && String(url).startsWith("blob:")) {
      try { URL.revokeObjectURL(url); } catch (_) {}
    }
    delete carPhotoBlobs[id];
    delete carPhotoDataUrls[id];
    if (!carSessionSkipPush) {
      try {
        await deleteCarSessionSlotRemote(id);
      } catch (err) {
        console.warn("car session odo delete:", err);
      }
    }
  };
  if (modeToKeep === "photos") {
    await clearId(CAR_ODOMETER_VIDEO_SLOT.id);
  } else if (modeToKeep === "video") {
    for (const id of CAR_ODOMETER_PHOTO_SLOTS.map((s) => s.id)) {
      await clearId(id);
    }
  } else {
    for (const id of carOdometerAllIds()) {
      await clearId(id);
    }
  }
}

async function setCarOdometerMode(mode) {
  if (carPhotoEditsBlocked()) return;
  const next = mode === "photos" || mode === "video" ? mode : null;
  if (next !== carOdometerMode) {
    await clearCarOdometerMedia(next);
    carOdometerMode = next;
  }
  const slots = activeCarPhotoSlots();
  const odoIdx = slots.findIndex((s) => s.kind === "odometer");
  if (odoIdx >= 0) carPhotoStepIndex = odoIdx;
  clearCarUploadError();
  refreshCarPhotoStage();
  scheduleCarSessionMetaPush();
}

function setCarPhotoStep(index) {
  const slots = activeCarPhotoSlots();
  carPhotoStepIndex = Math.max(0, Math.min(slots.length - 1, index));
  refreshCarPhotoStage();
}

function refreshCarPhotoStage() {
  syncCarSessionReadOnlyClass();
  const slots = activeCarPhotoSlots();
  if (carPhotoStepIndex >= slots.length) {
    carPhotoStepIndex = Math.max(0, slots.length - 1);
  }
  const step = slots[carPhotoStepIndex] || slots[0];
  const isOdometer = step?.kind === "odometer";
  const isRoofVideo = step?.kind === "video" || step?.id === "car-roof";
  const single = document.getElementById("slot-car-active");
  const roofStage = document.getElementById("slot-car-roof");
  const odometer = document.getElementById("car-odometer-stage");
  const sectionHeading = document.getElementById("car-interior-heading");

  if (single) single.style.display = isOdometer || isRoofVideo ? "none" : "";
  if (roofStage) roofStage.classList.toggle("visible", isRoofVideo);
  if (odometer) odometer.classList.toggle("visible", isOdometer);
  if (sectionHeading) {
    sectionHeading.textContent = step
      ? `${carPhotoStepIndex + 1}. ${step.title}`
      : "";
    sectionHeading.classList.toggle("visible", isOdometer);
  }

  if (isRoofVideo) {
    const roofLabel = document.getElementById("car-roof-label");
    if (roofLabel && step) {
      roofLabel.textContent = `${carPhotoStepIndex + 1}. ${step.title}`;
    }
    const vidId = CAR_ROOF_SLOT.id;
    const vidUrl = carPhotoDataUrls[vidId] || "";
    const recording = Boolean(carOdoRecorder && carVideoRecordSlot === vidId);
    const vidEl = document.getElementById("video-car-roof");
    const roofImg = document.getElementById("img-car-roof");
    const vidCancel = document.getElementById("btn-car-roof-cancel");
    if (vidEl) {
      if (vidUrl && !recording) {
        if (vidEl.src !== vidUrl) vidEl.src = vidUrl;
        vidEl.style.display = "block";
      } else if (!recording) {
        vidEl.removeAttribute("src");
        vidEl.style.display = "none";
      }
    }
    if (roofImg) {
      const preview = !vidUrl && !recording ? carPhotoPreviewUrl(vidId) : "";
      if (preview) {
        roofImg.src = preview;
        roofImg.style.display = "block";
        roofImg.classList.add("car-slot-preview");
      } else {
        roofImg.removeAttribute("src");
        roofImg.style.display = "none";
        roofImg.classList.remove("car-slot-preview");
      }
    }
    if (roofStage) roofStage.classList.toggle("done", Boolean(vidUrl));
    if (vidCancel) vidCancel.style.display = vidUrl ? "inline-block" : "none";
    const recBtn = document.getElementById("btn-roof-video-capture");
    if (recBtn && !(carOdoRecorder && carVideoRecordSlot === vidId)) {
      recBtn.textContent = "Record";
    }
  } else if (isOdometer) {
    const modeRow = document.getElementById("car-odometer-mode");
    const resetBtn = document.getElementById("btn-odo-mode-reset");
    const photosWrap = document.getElementById("car-odometer-photos");
    const videoWrap = document.getElementById("car-odometer-video-wrap");
    const photosBtn = document.getElementById("btn-odo-mode-photos");
    const videoBtn = document.getElementById("btn-odo-mode-video");
    const hasMode = carOdometerMode === "photos" || carOdometerMode === "video";
    if (modeRow) modeRow.style.display = hasMode ? "none" : "flex";
    if (resetBtn) resetBtn.classList.toggle("visible", hasMode);
    if (photosWrap) photosWrap.classList.toggle("visible", carOdometerMode === "photos");
    if (videoWrap) videoWrap.classList.toggle("visible", carOdometerMode === "video");
    if (photosBtn) photosBtn.classList.toggle("is-selected", carOdometerMode === "photos");
    if (videoBtn) videoBtn.classList.toggle("is-selected", carOdometerMode === "video");

    CAR_ODOMETER_PHOTO_SLOTS.forEach(({ id }) => {
      const captured = carPhotoDataUrls[id] || "";
      const url = captured || carPhotoPreviewUrl(id);
      const img = document.getElementById(`img-${id}`);
      const box = document.getElementById(`slot-${id}`);
      const cancelBtn = document.getElementById(`btn-${id}-cancel`);
      if (img) {
        if (url) {
          img.src = url;
          img.style.display = "block";
          img.classList.toggle("car-slot-preview", !captured);
        } else {
          img.src = "";
          img.style.display = "none";
          img.classList.remove("car-slot-preview");
        }
      }
      if (box) box.classList.toggle("done", Boolean(captured));
      if (cancelBtn) cancelBtn.style.display = captured ? "inline-block" : "none";
    });

    const vidId = CAR_ODOMETER_VIDEO_SLOT.id;
    const vidUrl = carPhotoDataUrls[vidId] || "";
    const vidEl = document.getElementById("video-car-odometer");
    const vidBox = document.getElementById(`slot-${vidId}`);
    const vidCancel = document.getElementById(`btn-${vidId}-cancel`);
    if (vidEl) {
      if (vidUrl && !carOdoRecorder) {
        if (vidEl.src !== vidUrl) vidEl.src = vidUrl;
        vidEl.style.display = "block";
      } else if (!carOdoRecorder) {
        vidEl.removeAttribute("src");
        vidEl.style.display = "none";
      }
    }
    if (vidBox) vidBox.classList.toggle("done", Boolean(vidUrl));
    if (vidCancel) vidCancel.style.display = vidUrl ? "inline-block" : "none";
    const recBtn = document.getElementById("btn-odo-video-capture");
    if (recBtn && !carOdoRecorder) recBtn.textContent = "Record";
  } else {
    const label = document.getElementById("car-photo-current-label");
    if (label && step) {
      label.textContent = `${carPhotoStepIndex + 1}. ${step.title}`;
    }
    const activeImg = document.getElementById("img-car-active");
    const captured = step ? carPhotoDataUrls[step.id] : "";
    const url = captured || (step ? carPhotoPreviewUrl(step.id) : "");
    if (activeImg) {
      if (url) {
        activeImg.src = url;
        activeImg.style.display = "block";
        activeImg.classList.toggle("car-slot-preview", !captured);
      } else {
        activeImg.src = "";
        activeImg.style.display = "none";
        activeImg.classList.remove("car-slot-preview");
      }
    }
    if (single) single.classList.toggle("done", Boolean(captured));
    const cancelBtn = document.getElementById("btn-car-cancel");
    if (cancelBtn) cancelBtn.style.display = captured ? "inline-block" : "none";
  }

  renderCarPhotoThumbs();
  updateCarPhotoStepHint();
  updateCarPhotoActionButtons();
}

function renderCarPhotoThumbs() {
  const host = document.getElementById("car-photo-thumbs");
  if (!host) return;
  host.innerHTML = activeCarPhotoSlots().map((step, idx) => {
    const active = idx === carPhotoStepIndex ? " is-active" : "";
    const done = carPhotoStepFilled(step) ? " is-done" : "";
    let media = "";
    if (step.kind === "odometer") {
      if (carOdometerMode === "photos") {
        const cells = step.photoChildren
          .map(({ id, title }) => carThumbCell(id, title, carPhotoDataUrls[id] || ""))
          .join("");
        media = `<div class="car-thumb-pair">${cells}</div>`;
      } else if (carOdometerMode === "video" && carPhotoDataUrls[step.videoChild.id]) {
        media = `<div class="car-thumb-video">VIDEO</div>`;
      } else if (!carOdometerMode) {
        media = carThumbCell(step.id, step.title, "");
      } else {
        media = `<div class="car-thumb-empty">—</div>`;
      }
    } else if (step.kind === "video" || isCarGuideVideoSlot(step.id)) {
      media = carPhotoDataUrls[step.id]
        ? `<div class="car-thumb-video">VIDEO</div>`
        : carThumbCell(step.id, step.title, "");
    } else {
      media = carThumbCell(step.id, step.title, carPhotoDataUrls[step.id] || "");
    }
    return `<button type="button" class="car-thumb${active}${done}" onclick="setCarPhotoStep(${idx})" title="${step.title}">
      <span class="car-thumb-label">${idx + 1}. ${step.title}</span>
      ${media}
    </button>`;
  }).join("");
}

async function resetCarPhotoGuide() {
  await stopCarOdometerRecording(false);
  carPhotoLeafSlots().forEach(({ id }) => {
    const url = carPhotoDataUrls[id];
    if (url && String(url).startsWith("blob:")) {
      try { URL.revokeObjectURL(url); } catch (_) {}
    }
    delete carPhotoBlobs[id];
    delete carPhotoDataUrls[id];
  });
  carOdometerAllIds().forEach((id) => {
    const url = carPhotoDataUrls[id];
    if (url && String(url).startsWith("blob:")) {
      try { URL.revokeObjectURL(url); } catch (_) {}
    }
    delete carPhotoBlobs[id];
    delete carPhotoDataUrls[id];
  });
  await clearCarRoofMedia();
  carOdometerMode = null;
  carCabriolet = false;
  const cabCb = document.getElementById("car-cabriolet");
  if (cabCb) cabCb.checked = false;
  carPhotoStepIndex = 0;
  clearCarUploadError();
  refreshCarPhotoStage();
}

function updateCarPhotoStepHint() {
  const hint = document.getElementById("car-photo-step-hint");
  if (!hint) return;
  if (carSessionReadOnly) {
    hint.textContent = "This session is complete. You can view the photos and download.";
    return;
  }
  const slots = activeCarPhotoSlots();
  const filledBase = slots.filter(
    (s) => s.kind !== "odometer" && carPhotoStepFilled(s)
  ).length;
  const odoFilled = carPhotoStepFilled(
    slots.find((s) => s.kind === "odometer")
  );
  const filledSteps =
    filledBase + (odoFilled ? 1 : 0);
  const totalSteps = slots.length;
  const step = slots[carPhotoStepIndex];
  if (!step) return;
  if (filledSteps === totalSteps) {
    hint.textContent = "All captures are ready. Download PDF (photos) and video zip when finished.";
    return;
  }
  if (step.kind === "odometer") {
    if (!carOdometerMode) {
      hint.textContent = `Odometer (${filledSteps}/${totalSteps}): choose Photos or Video.`;
    } else if (carOdometerMode === "photos") {
      const n = step.photoChildren.filter(({ id }) => carPhotoDataUrls[id]).length;
      hint.textContent =
        n === step.photoChildren.length
          ? `Odometer photos saved (${filledSteps}/${totalSteps}).`
          : `Odometer photos: before and after starting the engine (${n}/2).`;
    } else {
      hint.textContent = carPhotoDataUrls[step.videoChild.id]
        ? `Odometer video saved (${filledSteps}/${totalSteps}).`
        : "Odometer: record or upload a video (photos are not accepted).";
    }
    return;
  }
  if (step.kind === "video" || step.id === "car-roof") {
    hint.textContent = carPhotoDataUrls[step.id]
      ? `Roof video saved (${filledSteps}/${totalSteps}).`
      : "Roof: record or upload a video (photos are not accepted).";
    return;
  }
  if (carPhotoDataUrls[step.id]) {
    hint.textContent = `${step.title} saved (${filledSteps}/${totalSteps}). Select another angle or continue.`;
  } else {
    hint.textContent = ALLOW_FILE_UPLOAD
      ? `Now capture or upload: ${step.title} (${filledSteps}/${totalSteps}).`
      : `Now capture: ${step.title} (${filledSteps}/${totalSteps}).`;
  }
}

function updateCarPhotoActionButtons() {
  const btn = document.getElementById("btn-car-download");
  if (!btn) return;
  btn.disabled = !activeCarPhotoSlots().every((step) => carPhotoStepFilled(step));
}

function advanceCarPhotoStep() {
  const nextEmpty = activeCarPhotoSlots().findIndex((step) => !carPhotoStepFilled(step));
  if (nextEmpty >= 0) carPhotoStepIndex = nextEmpty;
  refreshCarPhotoStage();
  scheduleCarSessionMetaPush();
}

function openCarPhotoCamera(slot) {
  if (carPhotoEditsBlocked()) return;
  const target = slot || currentCarPhotoSlot();
  if (isCarGuideVideoSlot(target)) {
    triggerCarVideoUpload(target);
    return;
  }
  openCamera(target);
}

function triggerCarPhotoUpload(slot) {
  if (carPhotoEditsBlocked()) return;
  const target = slot || currentCarPhotoSlot();
  if (isCarGuideVideoSlot(target)) {
    triggerCarVideoUpload(target);
    return;
  }
  triggerUpload(target);
}

function triggerCarVideoUpload(slot) {
  if (carPhotoEditsBlocked()) return;
  if (!ALLOW_FILE_UPLOAD) {
    alert("File upload is disabled.");
    return;
  }
  const input = document.getElementById("car-video-input");
  if (!input) return;
  activeSlot = slot || currentCarPhotoSlot() || CAR_ODOMETER_VIDEO_SLOT.id;
  input.value = "";
  input.click();
}

async function cancelCurrentCarPhoto() {
  if (carPhotoEditsBlocked()) return;
  await cancelSlotPhoto(currentCarPhotoSlot());
}

async function carPhotoNewClient() {
  await resetCarPhotoGuide();
  clearCarPhotoSessionUrl();
  showMethodChoice();
}

async function stopCarGuideVideoRecording(save) {
  const slot = carVideoRecordSlot || CAR_ODOMETER_VIDEO_SLOT.id;
  const recBtn = carGuideVideoRecordBtn(slot);
  if (carOdoRecorder && carOdoRecorder.state !== "inactive") {
    await new Promise((resolve) => {
      carOdoRecorder.addEventListener("stop", resolve, { once: true });
      try { carOdoRecorder.stop(); } catch (_) { resolve(); }
    });
  }
  carOdoRecorder = null;
  if (carOdoRecordStream) {
    carOdoRecordStream.getTracks().forEach((t) => t.stop());
    carOdoRecordStream = null;
  }
  if (recBtn) recBtn.textContent = "Record";
  const recordSlot = carVideoRecordSlot;
  carVideoRecordSlot = null;
  if (!save) {
    carOdoRecordChunks = [];
    return;
  }
  if (!carOdoRecordChunks.length) return;
  const blob = new Blob(carOdoRecordChunks, {
    type: carOdoRecordChunks[0]?.type || "video/webm",
  });
  carOdoRecordChunks = [];
  applyCarVideoSlot(blob, recordSlot || slot);
}

async function stopCarOdometerRecording(save) {
  return stopCarGuideVideoRecording(save);
}

async function toggleCarGuideVideoRecord(slot) {
  if (carPhotoEditsBlocked()) return;
  const target = slot || currentCarPhotoSlot() || CAR_ODOMETER_VIDEO_SLOT.id;
  if (isCarOdometerVideoSlot(target) && carOdometerMode !== "video") {
    await setCarOdometerMode("video");
  }
  if (carOdoRecorder && carOdoRecorder.state === "recording") {
    await stopCarGuideVideoRecording(true);
    return;
  }
  try {
    clearCarUploadError();
    carVideoRecordSlot = target;
    carOdoRecordStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: true,
    });
    const vidEl = carGuideVideoEl(target);
    if (vidEl) {
      vidEl.srcObject = carOdoRecordStream;
      vidEl.muted = true;
      vidEl.controls = false;
      vidEl.style.display = "block";
      try { await vidEl.play(); } catch (_) {}
    }
    carOdoRecordChunks = [];
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : MediaRecorder.isTypeSupported("video/webm")
        ? "video/webm"
        : "";
    carOdoRecorder = mime
      ? new MediaRecorder(carOdoRecordStream, { mimeType: mime })
      : new MediaRecorder(carOdoRecordStream);
    carOdoRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) carOdoRecordChunks.push(ev.data);
    };
    carOdoRecorder.start(250);
    const recBtn = carGuideVideoRecordBtn(target);
    if (recBtn) recBtn.textContent = "Stop";
  } catch (err) {
    console.warn("car guide video record failed:", err);
    await stopCarGuideVideoRecording(false);
    showCarUploadError("Could not start video recording. Try Upload instead.");
  }
}

function applyCarVideoSlot(fileOrBlob, slotId, opts = {}) {
  const fromRemote = Boolean(opts.fromRemote);
  const slot = slotId || activeSlot || CAR_ODOMETER_VIDEO_SLOT.id;
  if (!fromRemote && carPhotoEditsBlocked()) return;
  const prev = carPhotoDataUrls[slot];
  if (prev && String(prev).startsWith("blob:")) {
    try { URL.revokeObjectURL(prev); } catch (_) {}
  }
  const blob = fileOrBlob;
  const url = URL.createObjectURL(blob);
  carPhotoBlobs[slot] = blob;
  carPhotoDataUrls[slot] = url;
  if (isCarOdometerVideoSlot(slot)) carOdometerMode = "video";
  const vidEl = carGuideVideoEl(slot);
  if (vidEl) {
    vidEl.srcObject = null;
    vidEl.src = url;
    vidEl.muted = false;
    vidEl.controls = true;
    vidEl.style.display = "block";
  }
  const idx = carPhotoStepIndexForSlot(slot);
  if (idx >= 0) carPhotoStepIndex = idx;
  if (!fromRemote) {
    advanceCarPhotoStep();
    pushCarSessionSlot(slot, blob).catch((err) =>
      console.warn("car session video push:", err)
    );
  } else {
    refreshCarPhotoStage();
  }
}

function carPhotoParentForSlot(id) {
  return activeCarPhotoSlots().find(
    (s) =>
      s.photoChildren?.some((c) => c.id === id) ||
      s.videoChild?.id === id
  );
}

function carPhotoFileStem(id, title, parentTitle) {
  const label = parentTitle ? `${parentTitle}-${title}` : title;
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || id;
}

function carPhotoPageTitle(id, title) {
  const parent = carPhotoParentForSlot(id);
  return parent?.title ? `${parent.title} — ${title}` : title;
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

function placeCarPhotoOnPdfPage(pdf, jpegDataUrl, imgW, imgH, title) {
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 14;
  const titleTop = margin + 4;
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(16);
  pdf.setTextColor(30, 30, 30);
  pdf.text(String(title || ""), pageW / 2, titleTop, {
    align: "center",
    maxWidth: pageW - margin * 2,
  });

  const titleBlock = 16;
  const maxW = pageW - margin * 2;
  const maxH = pageH - margin * 2 - titleBlock;
  const ratio = imgW / imgH;
  let w = maxW;
  let h = w / ratio;
  if (h > maxH) {
    h = maxH;
    w = h * ratio;
  }
  const x = margin + (maxW - w) / 2;
  const y = margin + titleBlock + (maxH - h) / 2;
  pdf.addImage(jpegDataUrl, "JPEG", x, y, w, h);
}

async function ensureJSZip() {
  if (window.JSZip) return window.JSZip;
  const cdns = [
    "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
    "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
  ];
  for (const url of cdns) {
    try {
      await loadScript(url);
      if (window.JSZip) return window.JSZip;
    } catch (e) {
      console.warn(e);
    }
  }
  return null;
}

async function buildCarPhotoPdfBlob(photoLeaves) {
  const JsPDF = await ensureJsPDF();
  if (!JsPDF) throw new Error("jsPDF unavailable");
  const pdf = new JsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  let pages = 0;
  for (let i = 0; i < photoLeaves.length; i++) {
    const { id, title } = photoLeaves[i];
    const src = carPhotoDataUrls[id];
    if (!src) continue;
    const prepared = await dataUrlForPdf(src);
    if (pages > 0) pdf.addPage();
    placeCarPhotoOnPdfPage(
      pdf,
      prepared.dataUrl,
      prepared.width,
      prepared.height,
      carPhotoPageTitle(id, title)
    );
    pages += 1;
  }
  if (!pages) throw new Error("No photo pages for PDF");
  return pdf.output("blob");
}

async function downloadCarPhotoBundle() {
  if (!activeCarPhotoSlots().every((step) => carPhotoStepFilled(step))) {
    alert("Capture or upload all car photo angles first.");
    return;
  }
  const photoLeaves = carPhotoPdfSlots();
  const videoLeaves = carPhotoVideoSlots();

  if (!photoLeaves.length) {
    alert("No photos to put in the PDF.");
    return;
  }

  try {
    const pdfBlob = await buildCarPhotoPdfBlob(photoLeaves);

    if (!videoLeaves.length) {
      triggerBlobDownload(pdfBlob, "car_photo_guide.pdf");
      return;
    }

    const JSZip = await ensureJSZip();
    if (!JSZip) {
      alert("Zip library failed to load. Check your internet and try again.");
      return;
    }

    // One button: PDF download + separate video zip (short delay avoids browser blocking).
    triggerBlobDownload(pdfBlob, "car_photo_guide.pdf");

    const zip = new JSZip();
    for (let i = 0; i < videoLeaves.length; i++) {
      const { id, title } = videoLeaves[i];
      const blob = carPhotoBlobs[id];
      if (!blob) continue;
      const parent = carPhotoParentForSlot(id);
      const stem = carPhotoFileStem(id, title, parent?.title);
      const num = String(i + 1).padStart(2, "0");
      const ext = (blob.type || "").includes("mp4")
        ? "mp4"
        : (blob.type || "").includes("quicktime")
          ? "mov"
          : "webm";
      zip.file(`${num}-${stem}.${ext}`, blob);
    }
    const zipBlob = await zip.generateAsync({ type: "blob" });
    setTimeout(() => {
      triggerBlobDownload(zipBlob, "car_guide_videos.zip");
    }, 400);
  } catch (err) {
    console.error("Car photo download failed:", err);
    alert("Could not build the download. Try again.");
  }
}

