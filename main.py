import json
import os
import re
import traceback
from pathlib import Path

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response

# ID path — only id_verifier
from id_verifier import extract_id_info, extract_mrz_ids, extract_mrz_strip, ocr_image

# Passport path — only passport_verifier (does not change ID logic)
from passport_verifier import (
    extract_passport_info,
    extract_passport_mrz_strip,
    has_passport_mrz,
)

from license_verifier import extract_license_info

BASE_DIR = Path(__file__).resolve().parent

_local_creds = BASE_DIR / "clientdocsocr.json"
if _local_creds.is_file():
    os.environ.setdefault("GOOGLE_APPLICATION_CREDENTIALS", str(_local_creds))

app = FastAPI(title="Georgian ID Scanner")

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
    # No caching: the scanner UI must always match the running backend
    html = (BASE_DIR / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(
        content=html,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


def _detect_doc_type(full_text: str) -> dict:
    """Classify Georgian ID vs passport from OCR text."""
    blob = (full_text or "").upper().replace(" ", "")
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
            r"პირადობ|მოწმობ|IDGEO|TRGEO|ID\s*CARD|IDENTITY\s*CARD|"
            r"ბარათის\s*№|CARD\s*NO|PERSONAL\s*N",
            full_text or "",
            re.I,
        )
    ) or ("IDGE" in blob or "TRGE" in blob)

    passport_label = bool(
        re.search(
            r"პასპორტის?\s|PASSPORT|REMARKS|შენიშვნებ|"
            r"TYPE\s*/?\s*P\b|DOCUMENT\s*TYPE\s*P\b",
            full_text or "",
            re.I,
        )
    )

    # Explicit P<GEO / PPGEO wins; TD1 still wins over weak passport cues.
    doc_type = "unknown"
    if strong_passport:
        doc_type = "passport"
    elif has_mrz:
        doc_type = "id"
    elif has_td3:
        doc_type = "passport"
    elif passport_label and not id_label:
        doc_type = "passport"
    elif id_label and not passport_label:
        doc_type = "id"

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
        # Reject passport MRZ (starts with P / P</PPGEO) uploaded in ID mode
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
            if not hint["has_mrz"] and (
                mrz_starts_with_p or hint["doc_type"] == "passport"
            ):
                return {
                    "error": "Please upload an ID card, not a passport",
                    "error_code": "passport_mrz_in_id",
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
        # Explicit rule requested for passport verification: an MRZ whose first
        # two characters are ID belongs to an identity card, not a passport.
        id_mrz = (hint.get("mrz_strip") or extract_mrz_strip(text) or "")
        id_mrz_first_line = id_mrz.splitlines()[0].replace(" ", "").upper() if id_mrz else ""
        if id_mrz_first_line.startswith("ID"):
            return {
                "error": "Please upload a passport, not an ID card",
                "error_code": "id_mrz_in_passport",
                "extracted_data": {},
                "is_valid": False,
            }
        # doc_type "id" means a TD1 / ID label won classification — reject even
        # if a stray TD3-like cue set has_td3 (ID MRZ is definitive).
        if hint["doc_type"] == "id":
            return {
                "error": "Please upload a passport, not an ID card",
                "error_code": "id_mrz_in_passport",
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


@app.post("/check-mrz")
async def check_mrz(image: UploadFile = File(...)):
    """
    Capture helper:
    - ID front/back: has_mrz = TD1 (IDGEO… or TRGEO…)
    - Passport: has_td3 = TD3 (P<…)
    - doc_type: "id" | "passport" | "unknown"
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
