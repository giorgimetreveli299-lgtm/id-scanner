import os
import re
from pathlib import Path

from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

# ID path — only id_verifier
from id_verifier import extract_id_info, extract_mrz_ids, extract_mrz_strip, ocr_image

# Passport path — only passport_verifier (does not change ID logic)
from passport_verifier import (
    extract_passport_info,
    extract_passport_mrz_strip,
    has_passport_mrz,
)

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


@app.get("/favicon.ico")
async def favicon():
    return Response(status_code=204)


@app.get("/")
async def serve_index():
    # No caching: the scanner UI must always match the running backend
    return FileResponse(
        BASE_DIR / "index.html",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


def _detect_doc_type(full_text: str) -> dict:
    """Classify Georgian ID vs passport from OCR text."""
    blob = (full_text or "").upper().replace(" ", "")
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
    has_td3 = bool(
        passport_strip.startswith("P<")
        or re.search(r"P<[A-Z0-9]{3}", blob)
    )

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

    # TD1 always wins over weak passport cues (ID back must never be blocked)
    doc_type = "unknown"
    if has_mrz:
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
        # Reject only when passport is clear AND this is not an ID (TD1)
        for label, raw in (("front", front_bytes), ("back", back_bytes)):
            text, _lines, _words = ocr_image(raw)
            hint = _detect_doc_type(text)
            if hint["doc_type"] == "passport" and not hint["has_mrz"]:
                return {
                    "error": f"Passport detected on the {label} photo. Use Passport mode.",
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
        if hint["doc_type"] == "id" and not hint["has_td3"]:
            return {
                "error": "ID card detected. Use ID mode instead of Passport.",
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
