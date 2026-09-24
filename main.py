import json
import os
import re
import secrets
import time
import traceback
from pathlib import Path

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response

# ID path — only id_verifier
from id_verifier import (
    _get_vision_client,
    extract_id_info,
    extract_mrz_ids,
    extract_mrz_strip,
    image_has_face,
    ocr_image,
)
from google.cloud import vision

# Passport path — only passport_verifier (does not change ID logic)
from passport_verifier import (
    extract_passport_info,
    extract_passport_mrz_strip,
    has_passport_mrz,
)

from license_verifier import extract_license_info, validate_license_side
from tech_passport_verifier import extract_tech_passport_info, validate_tech_passport_side
from car_photo_verifier import (
    CAR_DOCUMENT_ERROR,
    CAR_FRONT_ERROR,
    validate_car_photo_angle,
)
from car_session_store import (
    SessionLocked,
    allocate_id,
    new_session_token,
    delete_slot,
    mutate_meta,
    read_last_id,
    read_meta,
    read_slot,
    write_slot,
)

BASE_DIR = Path(__file__).resolve().parent
_CAR_SLOT_ID_RE = re.compile(r"^car-[a-z0-9-]+$")

_local_creds = BASE_DIR / "clientdocsocr.json"
if _local_creds.is_file():
    os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", str(_local_creds))

app = FastAPI(title="Georgian ID Scanner")


def _index_html_response() -> HTMLResponse:
    """Serve the scanner UI with no-cache headers."""
    html = (BASE_DIR / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(
        content=html,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


def _normalize_car_session_meta(session_id: int, data: dict | None) -> dict:
    base = _default_car_session_meta(session_id)
    if isinstance(data, dict):
        base.update({k: data.get(k, base[k]) for k in base.keys()})
    if not isinstance(base.get("slots"), dict):
        base["slots"] = {}
    base["id"] = int(session_id)
    return base


def _default_car_session_meta(session_id: int) -> dict:
    return {
        "id": int(session_id),
        "revision": 0,
        "stepIndex": 0,
        "cabriolet": False,
        "odometerMode": None,
        "slots": {},
        "token": "",
    }


def _read_car_session_meta(session_id: int) -> dict:
    return _normalize_car_session_meta(session_id, read_meta(session_id))


def _ensure_car_session(session_id: int) -> dict:
    if session_id < 1:
        raise ValueError("invalid session id")
    existing = read_meta(session_id)
    if existing is not None:
        return _normalize_car_session_meta(session_id, existing)
    return mutate_meta(
        session_id,
        _default_car_session_meta(session_id),
        lambda meta: _normalize_car_session_meta(session_id, meta),
    )


def _valid_car_slot_id(slot_id: str) -> bool:
    return bool(_CAR_SLOT_ID_RE.match(str(slot_id or "")))


_CAR_GUIDE_PHOTO_SLOTS = (
    "car-front",
    "car-rear",
    "car-left",
    "car-right",
    "car-engine",
    "car-front-seat",
    "car-back-seat",
    "car-gearbox",
    "car-vin",
    "car-truck",
)


def _car_session_is_complete(meta: dict) -> bool:
    """True when every slot required by the saved guide choices is stored."""
    if not isinstance(meta, dict):
        return False
    slots = meta.get("slots") or {}
    if not isinstance(slots, dict):
        return False
    if not all(slot_id in slots for slot_id in _CAR_GUIDE_PHOTO_SLOTS):
        return False
    if meta.get("cabriolet") and "car-roof" not in slots:
        return False
    mode = meta.get("odometerMode")
    if mode == "photos":
        return "car-odometer-before" in slots and "car-odometer-after" in slots
    if mode == "video":
        return "car-odometer-video" in slots
    return False


def _car_session_view(meta: dict) -> dict:
    view = dict(meta)
    view.pop("token", None)
    view["readOnly"] = _car_session_is_complete(meta)
    return view


def _presented_session_token(request: Request) -> str:
    return (
        request.headers.get("x-car-session-token")
        or request.query_params.get("k")
        or ""
    ).strip()


def _session_token_ok(meta: dict | None, request: Request) -> bool:
    expected = str((meta or {}).get("token") or "")
    presented = _presented_session_token(request)
    if not expected or not presented:
        return False
    return secrets.compare_digest(expected, presented)


def _car_session_locked_response() -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content={"error": "Session is complete", "readOnly": True},
    )


def _slot_ext_for_upload(filename: str | None, content_type: str | None) -> str:
    name = (filename or "").lower()
    ctype = (content_type or "").lower()
    if name.endswith(".webm") or "webm" in ctype:
        return ".webm"
    if name.endswith(".mp4") or "mp4" in ctype:
        return ".mp4"
    if name.endswith(".png") or "png" in ctype:
        return ".png"
    if name.endswith(".webp") or "webp" in ctype:
        return ".webp"
    return ".jpg"


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request: Request, exc: Exception):
    print("Unhandled error:", ascii(str(exc)))
    traceback.print_exc()
    return JSONResponse(
        status_code=500,
        content={
            "error": str(exc) or "Internal server error",
            "extracted_data": {},
            "display": {},
            "is_valid": False,
        },
    )


def _license_json_response(payload: dict) -> JSONResponse:
    """Ensure license responses always serialize as JSON."""
    try:
        json.dumps(payload)
    except (TypeError, ValueError) as exc:
        print("License JSON encode failed:", ascii(str(exc)))
        return JSONResponse(
            status_code=500,
            content={
                "error": "License response could not be encoded as JSON.",
                "extracted_data": {},
                "display": {},
                "is_valid": False,
            },
        )
    return JSONResponse(content=payload)


@app.get("/favicon.ico")
async def favicon():
    return Response(status_code=204)


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/")
async def serve_index():
    return _index_html_response()


_CAR_PREVIEW_NAME = re.compile(r"^car-[a-z0-9-]+\.(?:jpg|jpeg|png|webp)$")


@app.get("/car-previews/{name}")
async def car_photo_preview(name: str):
    """Example photo shown in a car-guide slot until a real capture replaces it."""
    if not _CAR_PREVIEW_NAME.match(name):
        return JSONResponse(status_code=404, content={"error": "Not found"})
    path = (BASE_DIR / "car-previews" / name).resolve()
    root = (BASE_DIR / "car-previews").resolve()
    if root not in path.parents or not path.is_file():
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return FileResponse(path, headers={"Cache-Control": "no-cache"})


_JS_FILES = {"document-crop.js", "car-guide.js"}


@app.get("/js/{name}")
async def serve_page_script(name: str):
    if name not in _JS_FILES:
        return JSONResponse(status_code=404, content={"error": "Not found"})
    path = (BASE_DIR / "js" / name).resolve()
    if path.parent != (BASE_DIR / "js").resolve() or not path.is_file():
        return JSONResponse(status_code=404, content={"error": "Not found"})
    return FileResponse(
        path,
        media_type="text/javascript",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/car-photo/{session_id}")
async def serve_car_photo_session(session_id: int):
    """Same UI as /; client boots into Car photo guide for this session id."""
    if session_id < 1:
        return JSONResponse(status_code=404, content={"error": "Invalid session id"})
    return _index_html_response()


@app.post("/api/car-sessions/next")
async def allocate_car_session():
    """
    Next session number from the shared cloud counter.
    Every computer that opens this site draws from the same sequence.
    """
    try:
        sid = allocate_id()
        token = new_session_token()
        created = _default_car_session_meta(sid)
        created["token"] = token
        meta = mutate_meta(
            sid,
            created,
            lambda current: _normalize_car_session_meta(sid, current),
        )
    except Exception:
        traceback.print_exc()
        return JSONResponse(
            status_code=503,
            content={"error": "Shared session counter is unavailable."},
        )
    return {
        "id": sid,
        "token": token,
        "path": f"/car-photo/{sid}?k={token}",
        "revision": meta.get("revision", 0),
    }


@app.get("/api/car-sessions/counter")
async def get_car_session_counter():
    """Peek at the shared session counter (does not allocate)."""
    try:
        last = read_last_id()
    except Exception:
        traceback.print_exc()
        return JSONResponse(
            status_code=503,
            content={"error": "Shared session counter is unavailable."},
        )
    return {"lastId": last, "nextId": last + 1}


@app.get("/api/car-sessions/{session_id}")
async def get_car_session(session_id: int, request: Request):
    """Return session metadata + which slots have media (no file bytes)."""
    if session_id < 1:
        return JSONResponse(status_code=404, content={"error": "Invalid session id"})
    try:
        meta = read_meta(session_id)
        if not _session_token_ok(meta, request):
            return JSONResponse(status_code=404, content={"error": "Session not found"})
        meta = _normalize_car_session_meta(session_id, meta)
    except Exception:
        traceback.print_exc()
        return JSONResponse(
            status_code=503,
            content={"error": "Shared session store is unavailable."},
        )
    return _car_session_view(meta)


@app.put("/api/car-sessions/{session_id}/meta")
async def put_car_session_meta(session_id: int, request: Request):
    """Update shared guide state (step, cabriolet, odometer mode)."""
    if session_id < 1:
        return JSONResponse(status_code=404, content={"error": "Invalid session id"})
    if not _session_token_ok(read_meta(session_id), request):
        return JSONResponse(status_code=404, content={"error": "Session not found"})
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}

    def apply(current: dict) -> dict:
        meta = _normalize_car_session_meta(session_id, current)
        if _car_session_is_complete(meta):
            raise SessionLocked()
        if "stepIndex" in body:
            try:
                meta["stepIndex"] = max(0, int(body["stepIndex"]))
            except (TypeError, ValueError):
                pass
        if "cabriolet" in body:
            meta["cabriolet"] = bool(body["cabriolet"])
        if "odometerMode" in body:
            mode = body["odometerMode"]
            meta["odometerMode"] = mode if mode in ("photos", "video") else None
        return meta

    try:
        meta = mutate_meta(session_id, _default_car_session_meta(session_id), apply)
    except SessionLocked:
        return _car_session_locked_response()
    except Exception:
        traceback.print_exc()
        return JSONResponse(
            status_code=503,
            content={"error": "Shared session store is unavailable."},
        )
    return _car_session_view(meta)


@app.post("/api/car-sessions/{session_id}/slots/{slot_id}")
async def upload_car_session_slot(
    session_id: int,
    slot_id: str,
    request: Request,
    file: UploadFile = File(...),
):
    """Store a photo/video for a car-photo slot in this session."""
    if session_id < 1:
        return JSONResponse(status_code=404, content={"error": "Invalid session id"})
    if not _session_token_ok(read_meta(session_id), request):
        return JSONResponse(status_code=404, content={"error": "Session not found"})
    if not _valid_car_slot_id(slot_id):
        return JSONResponse(status_code=400, content={"error": "Invalid slot id"})

    raw = await file.read()
    if not raw:
        return JSONResponse(status_code=400, content={"error": "Empty file"})

    ext = _slot_ext_for_upload(file.filename, file.content_type)
    content_type = file.content_type or (
        "video/webm" if ext in (".webm", ".mp4") else "image/jpeg"
    )
    slot_info: dict = {}

    def apply(current: dict) -> dict:
        meta = _normalize_car_session_meta(session_id, current)
        if _car_session_is_complete(meta):
            raise SessionLocked()
        filename = write_slot(session_id, slot_id, ext, raw, content_type)
        slots = dict(meta.get("slots") or {})
        slots[slot_id] = {
            "filename": filename,
            "contentType": content_type,
            "size": len(raw),
            "updatedAt": int(time.time() * 1000),
        }
        meta["slots"] = slots
        slot_info.clear()
        slot_info.update(slots[slot_id])
        return meta

    try:
        meta = mutate_meta(session_id, _default_car_session_meta(session_id), apply)
    except SessionLocked:
        return _car_session_locked_response()
    except Exception:
        traceback.print_exc()
        return JSONResponse(
            status_code=503,
            content={"error": "Shared session store is unavailable."},
        )
    return {
        "ok": True,
        "slotId": slot_id,
        "revision": meta.get("revision", 0),
        "slot": slot_info,
        "readOnly": _car_session_is_complete(meta),
    }


@app.get("/api/car-sessions/{session_id}/slots/{slot_id}")
async def download_car_session_slot(session_id: int, slot_id: str, request: Request):
    """Download media for one slot."""
    if session_id < 1:
        return JSONResponse(status_code=404, content={"error": "Invalid session id"})
    if not _session_token_ok(read_meta(session_id), request):
        return JSONResponse(status_code=404, content={"error": "Session not found"})
    if not _valid_car_slot_id(slot_id):
        return JSONResponse(status_code=400, content={"error": "Invalid slot id"})

    try:
        meta = read_meta(session_id) or {}
        slot_meta = (meta.get("slots") or {}).get(slot_id) or {}
        filename = slot_meta.get("filename") or ""
        raw = read_slot(session_id, filename) if filename else None
    except Exception:
        traceback.print_exc()
        return JSONResponse(
            status_code=503,
            content={"error": "Shared session store is unavailable."},
        )

    if raw is None:
        return JSONResponse(status_code=404, content={"error": "Slot not found"})

    media_type = slot_meta.get("contentType") or "application/octet-stream"
    return Response(
        content=raw,
        media_type=media_type,
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f'inline; filename="{filename}"',
        },
    )


@app.delete("/api/car-sessions/{session_id}/slots/{slot_id}")
async def delete_car_session_slot(session_id: int, slot_id: str, request: Request):
    """Remove one slot from the session."""
    if session_id < 1:
        return JSONResponse(status_code=404, content={"error": "Invalid session id"})
    if not _session_token_ok(read_meta(session_id), request):
        return JSONResponse(status_code=404, content={"error": "Session not found"})
    if not _valid_car_slot_id(slot_id):
        return JSONResponse(status_code=400, content={"error": "Invalid slot id"})

    def apply(current: dict) -> dict:
        meta = _normalize_car_session_meta(session_id, current)
        if _car_session_is_complete(meta):
            raise SessionLocked()
        delete_slot(session_id, slot_id)
        slots = dict(meta.get("slots") or {})
        slots.pop(slot_id, None)
        meta["slots"] = slots
        return meta

    try:
        meta = mutate_meta(session_id, _default_car_session_meta(session_id), apply)
    except SessionLocked:
        return _car_session_locked_response()
    except Exception:
        traceback.print_exc()
        return JSONResponse(
            status_code=503,
            content={"error": "Shared session store is unavailable."},
        )
    return {
        "ok": True,
        "revision": meta.get("revision", 0),
        "readOnly": _car_session_is_complete(meta),
    }


def _detect_doc_type(full_text: str) -> dict:
    """Classify Georgian ID / passport / driver license from OCR text."""
    text = full_text or ""
    blob = text.upper().replace(" ", "")
    # Legacy Georgian passports use P<GEO; the new document code is PP and its
    # MRZ starts PPGEO. Keep both as explicit, strong passport signals.
    raw_passport_prefix = bool(
        re.search(r"(?:P<|PP)GE[O0]", blob)
    )
    mrz_strip = extract_mrz_strip(full_text)
    mrz_ids = extract_mrz_ids(full_text)
    has_mrz = bool(mrz_strip) or bool(
        mrz_ids.get("card_number") and mrz_ids.get("personal_id")
    )
    # Soft TD1 cue even when full strip parse fails (common on phone photos)
    if not has_mrz and ("IDGEO" in blob or "TRGEO" in blob or "IDGE" in blob or "TRGE" in blob):
        has_mrz = True

    passport_strip = extract_passport_mrz_strip(full_text) or ""
    # Strong passport only: real TD3 P< row (not a loose line-2 false positive)
    td3_candidate = bool(
        passport_strip.startswith("P<")
        or re.search(r"P<[A-Z0-9]{3}", blob)
        or re.search(r"PPGE[O0]", blob)
    )
    # The passport parser can reconstruct a P<GEO name row from an ID's TD1
    # third line. Keep line-2-only passport recovery, but never report TD3 over
    # an already-confirmed TD1 unless the raw P<GEO/PPGEO prefix is present.
    has_td3 = bool(td3_candidate and (raw_passport_prefix or not has_mrz))
    strong_passport = bool(has_td3 and raw_passport_prefix)

    # PPGEO can resemble a TD1 ID prefix to the generic ID extractor. An
    # explicit passport row is authoritative and must not be exposed as ID MRZ.
    if strong_passport:
        has_mrz = False
        mrz_strip = ""

    id_label = bool(
        re.search(
            r"პირადობ|IDGEO|TRGEO|ID\s*CARD|IDENTITY\s*CARD|"
            r"ბარათის\s*№|CARD\s*NO\.?",
            text,
            re.I,
        )
    ) or ("IDGE" in blob or "TRGE" in blob)
    # Avoid matching driving-licence "მოწმობა" as an ID cue
    if re.search(r"პირადობის\s*მოწმობ", text, re.I):
        id_label = True

    passport_label = bool(
        re.search(
            r"პასპორტის?\s|PASSPORT|REMARKS|შენიშვნებ|"
            r"TYPE\s*/?\s*P\b|DOCUMENT\s*TYPE\s*P\b",
            text,
            re.I,
        )
    )

    license_label = bool(
        re.search(
            r"მართვის\s*მოწმობა|driving\s*licen[cs]e|driver'?s?\s*licen[cs]e",
            text,
            re.I,
        )
    )
    # Typical GEO license field markers (1…9) + categories / residence
    license_fields = bool(
        re.search(r"(?:^|\n)\s*1[\.\)]", text)
        and (
            re.search(r"(?:^|\n)\s*5[\.\)]", text)
            or re.search(r"(?:^|\n)\s*8[\.\)]", text)
            or re.search(r"(?:^|\n)\s*9[\.\)]", text)
        )
        and re.search(
            r"კატეგორი|categor(?:y|ies)|საცხოვრებელი|place\s*of\s*residence|"
            r"4a|4b|4c",
            text,
            re.I,
        )
    )
    license_number = bool(re.search(r"\b[A-Z]{2}\d{7}\b", blob))
    looks_license = bool(
        license_label
        or (license_fields and not has_mrz and not strong_passport)
        or (license_number and license_label)
    )

    # Explicit P<GEO / PPGEO wins; TD1 still wins over weak passport cues;
    # license labels win over weak ID/passport labels when no MRZ is present.
    doc_type = "unknown"
    if strong_passport:
        doc_type = "passport"
    elif has_mrz:
        doc_type = "id"
    elif looks_license and not (has_td3 and raw_passport_prefix):
        doc_type = "license"
    elif has_td3:
        doc_type = "passport"
    elif passport_label and not id_label and not license_label:
        doc_type = "passport"
    elif id_label and not passport_label and not license_label:
        doc_type = "id"
    elif looks_license:
        doc_type = "license"

    return {
        "has_mrz": has_mrz,
        "has_td3": has_td3,
        "doc_type": doc_type,
        "mrz_strip": mrz_strip,
        "passport_mrz_strip": passport_strip if has_td3 else "",
    }


@app.post("/verify-id")
async def verify_id(
    front: UploadFile = File(...),
    back: UploadFile = File(...),
):
    """ID card only — front + back → id_verifier."""
    try:
        front_bytes = await front.read()
        back_bytes = await back.read()
        # Reject passport / driver license uploaded in ID mode
        for label, raw in (("front", front_bytes), ("back", back_bytes)):
            text, _lines, _words = ocr_image(raw)
            hint = _detect_doc_type(text)
            # Only the guarded strip may be trusted: the raw passport parser can
            # rebuild a P<GEO row from an ID's TD1 name line and reject a valid ID.
            passport_first = (
                (hint.get("passport_mrz_strip") or "")
                .splitlines()[0]
                .replace(" ", "")
                .upper()
                if hint.get("passport_mrz_strip")
                else ""
            )
            blob = (text or "").upper().replace(" ", "")
            mrz_starts_with_p = bool(
                passport_first.startswith("P")
                or re.search(r"(?:^|[^A-Z0-9])P(?:<|P)?GE[O0]", blob)
            )
            wrong = hint.get("doc_type") in ("passport", "license") or (
                not hint["has_mrz"] and mrz_starts_with_p
            )
            if wrong:
                return {
                    "error": "Please upload ID card",
                    "error_code": "wrong_document_for_id",
                    "extracted_data": {},
                    "is_valid": False,
                }
        result = extract_id_info(front_bytes, back_bytes)
        back_text = result.get("raw_text", {}).get("back", "")
        mrz_ids = extract_mrz_ids(back_text)
        result["debug"] = {
            "mrz_card": mrz_ids.get("card_number", ""),
            "mrz_personal": mrz_ids.get("personal_id", ""),
            "back_has_idgeo": ("IDGE" in back_text.upper()) or ("TRGE" in back_text.upper()),
        }
        print(
            "OCR card:", result["extracted_data"].get("card_number"),
            "| personal:", result["extracted_data"].get("personal_id"),
            "| issue:", result["extracted_data"].get("issue_date"),
            "| MRZ:", mrz_ids,
        )
        if not result["extracted_data"].get("issue_date"):
            bt = back_text or ""
            idx = bt.upper().find("ISSUE")
            if idx < 0:
                idx = bt.find("გაცემ")
            snippet = bt[max(0, idx - 40) : idx + 80] if idx >= 0 else bt[:120]
            print("Issue date MISSING. Back snippet:", ascii(snippet))
        return result
    except Exception as e:
        print("Error:", ascii(str(e)))
        return {"error": str(e), "extracted_data": {}, "is_valid": False}


@app.post("/verify-passport")
async def verify_passport(image: UploadFile = File(...)):
    """Passport only — one photo → passport_verifier."""
    try:
        image_bytes = await image.read()
        text, _lines, _words = ocr_image(image_bytes)
        hint = _detect_doc_type(text)
        # Explicit rule: MRZ starting with ID belongs to an identity card.
        id_mrz = (hint.get("mrz_strip") or extract_mrz_strip(text) or "")
        id_mrz_first_line = id_mrz.splitlines()[0].replace(" ", "").upper() if id_mrz else ""
        if (
            id_mrz_first_line.startswith("ID")
            or hint["doc_type"] in ("id", "license")
        ):
            return {
                "error": "Please upload passport",
                "error_code": "wrong_document_for_passport",
                "extracted_data": {},
                "is_valid": False,
            }
        result = extract_passport_info(image_bytes)
        mrz = result.get("mrz_fields", {})
        print(
            "Passport OCR doc:", result["extracted_data"].get("card_number"),
            "| personal:", result["extracted_data"].get("personal_id"),
            "| names:", ascii(result["extracted_data"].get("first_name") or ""),
            ascii(result["extracted_data"].get("last_name") or ""),
            "| issue:", result["extracted_data"].get("issue_date"),
            "| MRZ:", mrz.get("last_name"), mrz.get("first_name"),
        )
        strip = result["extracted_data"].get("mrz_strip") or ""
        if not (mrz.get("card_number") and mrz.get("birth_date")):
            print("Passport MRZ WEAK. strip:", ascii(strip))
        return result
    except Exception as e:
        print("Passport error:", ascii(str(e)))
        return {"error": str(e), "extracted_data": {}, "is_valid": False}


@app.post("/verify-license")
async def verify_license(
    front: UploadFile = File(...),
    back: UploadFile = File(...),
):
    """Driver license — front + back → license_verifier (Node OCR)."""
    try:
        front_bytes = await front.read()
        back_bytes = await back.read()
        for raw in (front_bytes, back_bytes):
            text, _lines, _words = ocr_image(raw)
            hint = _detect_doc_type(text)
            if hint.get("doc_type") in ("id", "passport"):
                return _license_json_response(
                    {
                        "error": "Please upload driver license",
                        "error_code": "wrong_document_for_license",
                        "extracted_data": {},
                        "display": {},
                        "is_valid": False,
                    }
                )
        result = extract_license_info(front_bytes, back_bytes)
        if not result.get("ok"):
            print("License OCR failed:", ascii(result.get("error") or ""))
            return _license_json_response(
                {
                    "error": result.get("error") or "License scan failed",
                    "extracted_data": result.get("extracted_data") or {},
                    "display": result.get("display") or {},
                    "is_valid": False,
                }
            )
        return _license_json_response(
            {
                "extracted_data": result.get("extracted_data") or {},
                "display": result.get("display") or {},
            "qr_code_value": result.get("qr_code_value"),
            "holder_photo_data_url": result.get("holder_photo_data_url"),
                "holder_signature_data_url": result.get("holder_signature_data_url"),
                "qr_code_data_url": result.get("qr_code_data_url"),
                "is_valid": True,
            }
        )
    except Exception as e:
        print("License error:", ascii(str(e)))
        traceback.print_exc()
        return _license_json_response(
            {
                "error": str(e),
                "extracted_data": {},
                "display": {},
                "is_valid": False,
            }
        )


@app.post("/verify-tech-passport")
async def verify_tech_passport(
    front: UploadFile = File(...),
    back: UploadFile = File(...),
):
    """Tech passport (vehicle registration) — front + back → tech_passport_verifier."""
    try:
        front_bytes = await front.read()
        back_bytes = await back.read()
        # Persist last uploads for OCR debugging
        try:
            dump_dir = Path(__file__).resolve().parent / "debug_uploads"
            dump_dir.mkdir(exist_ok=True)
            (dump_dir / "tech_front.jpg").write_bytes(front_bytes)
            (dump_dir / "tech_back.jpg").write_bytes(back_bytes)
        except Exception:
            pass
        result = extract_tech_passport_info(front_bytes, back_bytes)
        extracted = result.get("extracted_data") or {}
        # Avoid Windows cp1252 console crashes on Georgian OCR text
        try:
            print(
                "Tech passport OCR filled=",
                result.get("filled_count"),
                "keys=",
                sorted(k for k, v in extracted.items() if str(v or "").strip()),
            )
            print(
                "Tech passport values=",
                {k: ascii(str(v)) for k, v in extracted.items() if str(v or "").strip()},
            )
            print(
                "Tech passport codes=",
                {
                    side: {k: ascii(str(v)) for k, v in (codes or {}).items()}
                    for side, codes in (result.get("debug_codes") or {}).items()
                },
            )
        except Exception:
            pass
        return {
            "extracted_data": extracted,
            "filled_count": result.get("filled_count", 0),
            "debug_codes": result.get("debug_codes") or {},
            "qr_code_value": result.get("qr_code_value") or "",
            "qr_code_data_url": result.get("qr_code_data_url") or "",
            "is_valid": True,
        }
    except Exception as e:
        print("Tech passport error:", ascii(str(e)))
        return {
            "error": "Tech passport scan failed.",
            "extracted_data": {},
            "filled_count": 0,
            "qr_code_value": "",
            "qr_code_data_url": "",
            "is_valid": False,
        }


ID_FRONT_SIDE_ERROR = "Please upload front side of ID card"
ID_BACK_SIDE_ERROR = "Please upload back side of ID card"


def _image_has_face(image_bytes: bytes, min_confidence: float = 0.35) -> bool:
    """True when Vision detects a person face (typical of ID front photo).

    Default 0.35 matches id_verifier.image_has_face and lib/vision.ts.
    """
    return image_has_face(image_bytes, min_confidence=min_confidence)


def validate_id_side(image_bytes: bytes, side: str) -> dict:
    """
    Capture/upload helper for ID card:
    - front: reject when TD1 MRZ is present (back side photo)
    - back: accept when TD1 MRZ is present (ghost portrait on reverse is normal);
      otherwise reject when a person face is present (front side photo)
    """
    side_norm = (side or "").strip().lower()
    if side_norm not in ("front", "back"):
        return {"ok": False, "error": "side must be front or back", "side": side_norm}

    full_text, _lines, _words = ocr_image(image_bytes)
    hint = _detect_doc_type(full_text)
    has_mrz = bool(hint.get("has_mrz"))

    if side_norm == "front":
        if has_mrz:
            return {
                "ok": False,
                "error": ID_FRONT_SIDE_ERROR,
                "side": side_norm,
                "has_mrz": True,
            }
        return {"ok": True, "side": side_norm, "has_mrz": False}

    # Georgian ID reverse often has a small secondary portrait — MRZ wins.
    if has_mrz:
        return {
            "ok": True,
            "side": side_norm,
            "has_mrz": True,
            "has_face": False,
        }

    has_face = _image_has_face(image_bytes)
    if has_face:
        return {
            "ok": False,
            "error": ID_BACK_SIDE_ERROR,
            "side": side_norm,
            "has_face": True,
            "has_mrz": False,
        }
    return {"ok": True, "side": side_norm, "has_face": False, "has_mrz": False}


@app.post("/check-id-side")
async def check_id_side(
    image: UploadFile = File(...),
    side: str = Form(...),
):
    """
    Capture/upload helper for ID card:
    - front: reject when MRZ strip is detected
    - back: reject when a person face/head is detected
    """
    try:
        image_bytes = await image.read()
        return validate_id_side(image_bytes, side)
    except Exception as e:
        print("check-id-side error:", ascii(str(e)))
        traceback.print_exc()
        return {"ok": False, "error": str(e), "side": (side or "").strip().lower()}


@app.post("/check-car-photo-angle")
async def check_car_photo_angle(
    image: UploadFile = File(...),
    angle: str = Form(...),
):
    """
    Car photo guide helper:
    - all angles: reject ID / passport / license / paper documents
    - front: must look like a frontal vehicle shot
    - other exterior angles: require a car subject
    - engine / front-seat / back-seat / gearbox / vin / truck / odometer-before / odometer-after: require vehicle-detail cues
    - odometer-video / roof: skipped (client enforces video type)
    """
    try:
        image_bytes = await image.read()
        return validate_car_photo_angle(image_bytes, angle)
    except Exception as e:
        print("check-car-photo-angle error:", ascii(str(e)))
        traceback.print_exc()
        angle_norm = (angle or "").strip().lower()
        return {
            "ok": False,
            "error": CAR_FRONT_ERROR if angle_norm in {"front", "car-front"} else CAR_DOCUMENT_ERROR,
            "angle": angle_norm,
        }


@app.post("/check-license-side")
async def check_license_side(
    image: UploadFile = File(...),
    side: str = Form(...),
):
    """
    Capture/upload helper for driver license:
    - front: reject when QR is detected (back side photo)
    - back: reject when QR is missing and image looks like the front
    """
    try:
        image_bytes = await image.read()
        return validate_license_side(image_bytes, side)
    except Exception as e:
        print("check-license-side error:", ascii(str(e)))
        traceback.print_exc()
        return {"ok": False, "error": str(e), "side": (side or "").strip().lower()}


@app.post("/check-tech-passport-side")
async def check_tech_passport_side(
    image: UploadFile = File(...),
    side: str = Form(...),
):
    """
    Capture/upload helper for tech passport only:
    - any side: reject when MRZ is visible
    - front: also reject when a person face/head is visible
    - back: also reject when QR is on the left side
    """
    try:
        image_bytes = await image.read()
        return validate_tech_passport_side(image_bytes, side)
    except Exception as e:
        print("check-tech-passport-side error:", ascii(str(e)))
        traceback.print_exc()
        return {"ok": False, "error": str(e), "side": (side or "").strip().lower()}


@app.post("/check-mrz")
async def check_mrz(image: UploadFile = File(...)):
    """
    Capture helper:
    - ID: has_mrz = TD1 (IDGEO… or TRGEO…)
    - Passport: has_td3 = TD3 (P<…)
    - doc_type: "id" | "passport" | "license" | "unknown"
    """
    try:
        image_bytes = await image.read()
        full_text, _lines, _words = ocr_image(image_bytes)
        return _detect_doc_type(full_text)
    except Exception as e:
        return {
            "has_mrz": False,
            "has_td3": False,
            "doc_type": "unknown",
            "mrz_strip": "",
            "error": str(e),
        }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
