"""
Tech passport (vehicle registration certificate) OCR — separate from ID / license.

Front + back photos → Google Vision OCR → labeled field extraction.
"""
from __future__ import annotations

import base64
import json
import re
import shutil
import subprocess
import tempfile
from io import BytesIO
from pathlib import Path

import id_verifier as idv
from google.cloud import vision
from PIL import Image

ocr_image = idv.ocr_image
ocr_image_ex = idv.ocr_image_ex
_value_after_labels = idv._value_after_labels
_clean_value = idv._clean_value
_is_label_only = idv._is_label_only
_find_dates_in_text = idv._find_dates_in_text
_find_personal_ids = idv._find_personal_ids
_pick_personal_id = idv._pick_personal_id
_georgian_only = idv._georgian_only
_GEO_RE = idv._GEO_RE
_get_vision_client = idv._get_vision_client
image_has_face = idv.image_has_face

_BASE_DIR = Path(__file__).resolve().parent
_DECODE_QR_SCRIPT = _BASE_DIR / "scripts" / "decode-qr.ts"
_TSX_CLI = _BASE_DIR / "node_modules" / "tsx" / "dist" / "cli.mjs"

# Front (1–8)
_FRONT_LABELS: dict[str, list[str]] = {
    "registration_number": [
        "რეგისტრაციის ნომერი",
        "registration number",
        "reg. number",
        "reg number",
        "number plate",
        "license plate",
        "სარეგისტრაციო ნომერი",
    ],
    "production_year": [
        "გამოშვების წელი",
        "production year",
        "year of manufacture",
        "year of production",
        "manufacture year",
        "model year",
    ],
    "registration_date": [
        "რეგისტრაციის თარიღი",
        "registration date",
        "date of registration",
        "first registration",
    ],
    "owner_name": [
        "მფლობელის სახელი",
        "owner's name",
        "owners name",
        "owner name",
        "given name",
        "first name",
    ],
    "owner_surname": [
        "მფლობელის გვარი",
        "owner's surname",
        "owners surname",
        "owner surname",
        "surname",
        "family name",
    ],
    "owner_personal_number": [
        "მფლობელის პირადი ნომერი",
        "owner's personal number",
        "owners personal number",
        "personal number",
        "personal id",
        "პირადი ნომერი",
    ],
    "expiration_date": [
        "გაუქმების თარიღი",
        "expiration date",
        "expiry date",
        "date of expiry",
        "valid until",
        "valid thru",
    ],
    "card_number": [
        "საბუთის ნომერი",
        "card number",
        "document number",
        "certificate number",
        "doc. number",
        "სერია და ნომერი",
    ],
}

# Back (9–15)
_BACK_LABELS: dict[str, list[str]] = {
    "mark": [
        "მარკა",
        "mark",
        "make",
        "manufacturer",
        "brand",
    ],
    "type": [
        "ტიპი",
        "type",
        "vehicle type",
        "body type",
        "category",
    ],
    "model": [
        "მოდელი",
        "model",
        "commercial name",
    ],
    "vin": [
        "v.i.n",
        "vin კოდი",
        "vin code",
        "vin",
        "ვინ კოდი",
        "იდენტიფიკაციის ნომერი",
        "identification number",
        "chassis number",
    ],
    "engine_capacity": [
        "ძრავის მოცულობა",
        "engine capacity",
        "engine displacement",
        "displacement",
        "cylinder capacity",
        "მოცულობა",
    ],
    "fuel_type": [
        "საწვავის ტიპი",
        "fuel type",
        "type of fuel",
        "fuel",
        "საწვავი",
    ],
    "color": [
        "ფერი",
        "color",
        "colour",
        "paint",
    ],
}

_VIN_RE = re.compile(r"\b([A-HJ-NPR-Z0-9]{17})\b", re.I)
_YEAR_RE = re.compile(r"\b((?:19|20)\d{2})\b")
# Georgian plates: CX635CX, AB-123-CD, etc.
_PLATE_RE = re.compile(
    r"\b([A-Z]{2,3}[-\s]?\d{2,4}[-\s]?[A-Z]{2,3}"
    r"|\d{2,3}[-\s]?[A-Z]{2,3}[-\s]?\d{2,3}"
    r"|[A-Z]{2}\d{3}[A-Z]{2}"
    r"|[A-Z]{3}\d{3})\b",
    re.I,
)
_ENGINE_RE = re.compile(
    r"\b(\d{3,4}(?:[.,]\d)?\s*(?:cm3|cm³|cc|სმ3|სმ³)|\d[.,]\d\s*l)\b",
    re.I,
)
_ENGINE_BARE_RE = re.compile(r"\b(\d{3,4})\b")
_YEAR_FULL_RE = re.compile(r"^(?:19|20)\d{2}$")
_CARD_NO_RE = re.compile(r"\b([A-Z]{0,3}\d{6,12}[A-Z0-9]*)\b", re.I)
# Single letter line: "A CX635CX", "E WBA…", "R WHITE", "H -"
_LETTER_LINE_RE = re.compile(
    r"^\s*[(\[]?([A-Za-z])[)\]]?[.)\-:]*\s+(\S.*|\-+|_+|—+)$"
)
# Dotted codes: C.1.1, D.1, P.1, P.3, … (OCR may use commas: C.1,1)
_DOTTED_CODE_RE = re.compile(
    r"(?im)(?:^|\n)\s*[(\[]?([A-Z][.,]\d+(?:[.,]\d+)?)[)\]]?[.)\-:]*\s*([^\n]+)"
)
_FRONT_INLINE_RE = re.compile(
    r"(?im)(?:^|[\n\s])[(\[]?([ABCIH])[)\]]?[.)\-:]*\s+([A-Z0-9\u10D0-\u10FF/\-._][A-Z0-9\u10D0-\u10FF/\-.\s_]{0,40})"
)
_BACK_INLINE_RE = re.compile(
    r"(?im)(?:^|[\n\s])[(\[]?([ER])[)\]]?[.)\-:]*\s+([A-Z0-9\u10D0-\u10FF/\-._][A-Z0-9\u10D0-\u10FF/\-.\s_]{0,60})"
)

_LEGAL_ENTITY_RE = re.compile(
    r"შპს|შ\s*\.?\s*პ\s*\.?\s*ს|"
    r"შეზღუდულ\w*\s+პასუხისმგებლ|"
    r"\bLtd\.?\b|\bLLC\b|\bLLP\b|\bInc\.?\b|\bJSC\b|\bCo\.?\b|"
    r"(?<!\w)სს(?!\w)|ააიპ|სსიპ",
    re.I,
)
_ADDRESS_HINT_RE = re.compile(
    r"გამზ\.?|ქუჩ|ჩიხ|ოფისი|სართ\.?|დას\.|თბ\.|თბილის|"
    r"\bave(?:nue)?\b|\bstreet\b|\boffice\b|ბლოკი|"
    r"Georgia\.?$|\bN\s*\d+",
    re.I,
)

_FUEL_MAP = [
    (re.compile(r"ბენზინ|petrol|gasoline|benzine", re.I), "ბენზინი / Petrol"),
    (re.compile(r"დიზელ|diesel", re.I), "დიზელი / Diesel"),
    (re.compile(r"ელექტრ|electric", re.I), "ელექტრო / Electric"),
    (re.compile(r"ჰიბრიდ|hybrid", re.I), "ჰიბრიდი / Hybrid"),
    (re.compile(r"გაზი|lpg|cng|gas", re.I), "გაზი / Gas"),
]

# D.2 body type — always Georgian / English when recognized
_TYPE_MAP = [
    (re.compile(r"ჰეტჩ|hatch", re.I), "ჰეტჩბეკი / Hatchback"),
    (re.compile(r"სედან|sedan", re.I), "სედანი / Sedan"),
    (re.compile(r"უნივერსალ|wagon|estate|avant", re.I), "უნივერსალი / Wagon"),
    (re.compile(r"ჯიპი|ჯიპ\b|suv|crossover|off[\s\-]?road", re.I), "ჯიპი / SUV"),
    (re.compile(r"კუპე|coupé|coupe", re.I), "კუპე / Coupe"),
    (re.compile(r"კაბრიო|cabriolet|convertible", re.I), "კაბრიოლეტი / Cabriolet"),
    (re.compile(r"პიკაპ|pick[\s\-]?up", re.I), "პიკაპი / Pickup"),
    (re.compile(r"მინივენ|minivan|mpv", re.I), "მინივენი / Minivan"),
    (re.compile(r"ფურგონ|van\b", re.I), "ფურგონი / Van"),
    (re.compile(r"ავტობუს|bus\b", re.I), "ავტობუსი / Bus"),
    (re.compile(r"მოტოციკლ|motorcycle|moto\b", re.I), "მოტოციკლი / Motorcycle"),
]

# R colour — always Georgian / English when recognized
_COLOR_MAP = [
    (re.compile(r"შავ|black", re.I), "შავი / Black"),
    (re.compile(r"თეთრ|white", re.I), "თეთრი / White"),
    (re.compile(r"წითელ|red\b", re.I), "წითელი / Red"),
    (re.compile(r"ლურჯ|ცისფერ|blue", re.I), "ლურჯი / Blue"),
    (re.compile(r"მწვან|green", re.I), "მწვანე / Green"),
    (
        re.compile(r"ნაცრისფერ|ვერცხლ|გრ[ეე]ი|grey|gray|silver", re.I),
        "ნაცრისფერი / Grey",
    ),
    (re.compile(r"ყავისფერ|brown", re.I), "ყავისფერი / Brown"),
    (re.compile(r"ყვითელ|yellow", re.I), "ყვითელი / Yellow"),
    (re.compile(r"ნარინჯ|orange", re.I), "ნარინჯისფერი / Orange"),
    (re.compile(r"იასამ|იისფერ|violet|purple", re.I), "იისფერი / Purple"),
    (re.compile(r"ოქროსფერ|gold", re.I), "ოქროსფერი / Gold"),
    (re.compile(r"ბეჟ|beige", re.I), "ბეჟი / Beige"),
]

_JUNK_VALUE = re.compile(
    r"^(?:mark|type|model|color|colour|fuel|vin|make|name|surname|"
    r"მარკა|ტიპი|მოდელი|ფერი|საწვავ|ნომერი)$",
    re.I,
)


def _normalize_date(value: str) -> str:
    dates = _find_dates_in_text(value or "")
    return dates[0] if dates else _clean_value(value or "")


def _looks_like_junk(value: str) -> bool:
    v = _clean_value(value or "")
    if not v or len(v) < 1:
        return True
    if _is_label_only(v):
        return True
    if _JUNK_VALUE.match(v):
        return True
    return False


def _field_from_labels(
    lines: list[str],
    labels: list[str],
    *,
    prefer_georgian: bool = False,
) -> str:
    raw = _value_after_labels(lines, labels, prefer_georgian=prefer_georgian)
    if not raw or _looks_like_junk(raw):
        return ""
    return _clean_value(raw)


def _first_match(pattern: re.Pattern, text: str) -> str:
    m = pattern.search(text or "")
    return m.group(1).strip() if m else ""


def _normalize_fuel(value: str) -> str:
    raw = _clean_value(value or "")
    if not raw:
        return ""
    for pat, canon in _FUEL_MAP:
        if pat.search(raw):
            return canon
    return raw


def _format_bilingual_pair(geo: str, lat: str) -> str:
    geo = (geo or "").strip(" /-\\")
    lat = (lat or "").strip(" /-\\")
    if lat:
        lat = " ".join(
            w.capitalize() if w.isupper() or w.islower() else w for w in lat.split()
        )
    if geo and lat:
        return f"{geo} / {lat}"
    return geo or lat


def _normalize_bilingual_mapped(value: str, mapping: list) -> str:
    """Prefer canonical 'ქართული / English'; else keep both sides from OCR."""
    raw = _trim_code_value(value or "")
    raw = raw.replace("\\", "/")
    if not raw or _looks_like_junk(raw):
        return ""
    for pat, canon in mapping:
        if pat.search(raw):
            return canon
    if "/" in raw:
        left, right = [p.strip() for p in raw.split("/", 1)]
        geo = _georgian_only(left) or (_georgian_only(raw) if _GEO_RE.search(left) else "")
        lat = re.sub(r"[^A-Za-z\- ]", " ", right if not _GEO_RE.search(right) else left)
        lat = re.sub(r"\s+", " ", lat).strip()
        pair = _format_bilingual_pair(geo or left if _GEO_RE.search(left) else "", lat)
        if pair:
            return pair
    geo = _georgian_only(raw) or ""
    lat = re.sub(r"[^A-Za-z\- ]", " ", raw)
    lat = re.sub(r"\s+", " ", lat).strip()
    if geo and lat and geo.lower() != lat.lower():
        return _format_bilingual_pair(geo, lat)
    return geo or lat or raw


def _normalize_type(value: str) -> str:
    return _normalize_bilingual_mapped(value, _TYPE_MAP)


def _normalize_color(value: str) -> str:
    return _normalize_bilingual_mapped(value, _COLOR_MAP)


def _normalize_vin(value: str) -> str:
    """ISO VIN: letters I, O, Q are never used — OCR often confuses them with 1/0."""
    raw = re.sub(r"[\s\-]", "", (value or "").upper())
    raw = raw.replace("O", "0").replace("I", "1").replace("Q", "0")
    m = _VIN_RE.search(raw)
    if m:
        return m.group(1).upper()
    # Also allow near-17 OCR blobs after I/O/Q correction
    compact = re.sub(r"[^A-HJ-NPR-Z0-9]", "", raw)
    if len(compact) == 17 and re.fullmatch(r"[A-HJ-NPR-Z0-9]{17}", compact):
        return compact
    if 11 <= len(compact) <= 17 and re.fullmatch(r"[A-HJ-NPR-Z0-9]+", compact):
        return compact
    return _clean_value(value or "").upper().replace("O", "0")


def _normalize_year(value: str) -> str:
    m = _YEAR_RE.search(value or "")
    if m:
        return m.group(1)
    digits = re.sub(r"\D", "", value or "")
    if len(digits) == 4 and digits.startswith(("19", "20")):
        return digits
    return _clean_value(value or "")


def _normalize_engine(value: str, *, from_code: bool = False) -> str:
    raw = _clean_value(value or "")
    if not raw:
        return ""
    m = _ENGINE_RE.search(raw)
    if m:
        return _clean_value(m.group(1))
    m = _ENGINE_BARE_RE.search(raw)
    if m:
        num = m.group(1)
        # Bare "2015" from full-text is usually manufacture year — keep when from P.1
        if _YEAR_FULL_RE.match(num) and not from_code:
            return ""
        return num
    return ""


def _strip_code_noise(value: str) -> str:
    """Remove parenthetical label translations OCR appends after values."""
    raw = (value or "").strip()
    if re.fullmatch(r"[-_—–−.]+", raw):
        return "-"
    # "09/08/2025 (რეგისტრაციის თარიღი / Date of registration)"
    raw = re.sub(r"\s*\([^)]*\)\s*", " ", raw)
    raw = re.sub(
        r"\s+(?:Registration|Date|Personal|Expiration|Manufacture|Owner|number|year|code)\b.*$",
        "",
        raw,
        flags=re.I,
    )
    return _clean_value(raw)


def _owner_name_value(value: str) -> str:
    """Keep Georgian before '/', else Latin side / whole string."""
    raw = _strip_code_noise(value or "")
    if not raw:
        return ""
    # Cut next code bleed: "ფოფხაძე/Popkhadze C.1.2 ..."
    raw = re.split(r"\s+C\.\d+", raw, maxsplit=1, flags=re.I)[0].strip()
    if "/" in raw:
        left, right = [p.strip() for p in raw.split("/", 1)]
        geo = _georgian_only(left)
        if geo:
            return geo
        if left:
            return left
        # Latin only after slash: " / Popkhadze"
        lat = re.sub(r"[^A-Za-z\- ]", "", right).strip()
        return lat or right
    # "გვანცა Gvantsa" — prefer Georgian token
    geo = _georgian_only(raw)
    if geo:
        return geo
    lat = re.sub(r"[^A-Za-z\- ]", "", raw).strip()
    return lat or raw


def _trim_code_value(value: str) -> str:
    raw = (value or "").strip()
    # Preserve dash/dot placeholders for field H
    if re.fullmatch(r"[-_—–−.]+", raw):
        return "-"
    raw = _strip_code_noise(raw)
    if re.fullmatch(r"[-_—–−.]+", raw or ""):
        return "-"
    # Stop before next field code on the same OCR line
    raw = re.split(
        r"\s+(?:[A-Z]|[A-Z]\.\d+(?:\.\d+)?)(?:\s|$)",
        raw,
        maxsplit=1,
        flags=re.I,
    )[0].strip()
    return raw


def _value_after_dotted_code(lines: list[str], index: int, same_line_value: str) -> str:
    """Use same-line value, or the next non-empty line when OCR wrapped the field."""
    val = _trim_code_value(same_line_value)
    if (
        val
        and val != "-"
        and not _looks_like_junk(val)
        and not _as_field_code(val.split()[0] if val else "")
        and not _looks_like_address(val)
    ):
        return val
    if val == "-":
        return "-"
    for j in range(index + 1, min(index + 5, len(lines))):
        nxt = (lines[j] or "").strip()
        if not nxt:
            continue
        # Stop / skip if next line is another code (dots or commas)
        if re.match(
            r"^[(\[]?[A-Z](?:[.,]\d+(?:[.,]\d+)?)?[)\]]?[.)\-:]*\s+\S",
            nxt,
            re.I,
        ):
            break
        if re.match(r"^[(\[]?[A-Z][.,]\d+(?:[.,]\d+)?[)\]]?\s*$", nxt, re.I):
            continue
        if re.match(r"^[(\[]?[A-Z][)\]]?\s*$", nxt, re.I):
            continue
        if _as_field_code(nxt.split()[0] if nxt else ""):
            continue
        cand = _trim_code_value(nxt)
        if (
            cand
            and (cand == "-" or not _looks_like_junk(cand))
            and not _as_field_code(cand.split()[0] if cand else "")
            and not _looks_like_address(cand)
        ):
            return cand
    return val if val and not _as_field_code(val.split()[0] if val else "") else ""


def _vehicle_text_value(value: str) -> str:
    """Clean mark/type/model/color; prefer Georgian before '/'."""
    raw = _trim_code_value(value)
    raw = re.split(r"\s*\\\s*", raw, maxsplit=1)[0].strip()
    if not raw or _looks_like_junk(raw):
        return ""
    if "/" in raw:
        left, right = [p.strip() for p in raw.split("/", 1)]
        geo = _georgian_only(left)
        if geo:
            return geo
        if left and not _looks_like_junk(left):
            return left
        return right
    geo = _georgian_only(raw)
    return geo or raw


def _normalize_model(value: str, mark: str = "") -> str:
    """
    Fix common OCR errors in model codes.
    BMW: 328i is often read as 3281 / 328I / 328l / 328 i (spaces allowed).
    Keep multi-word models (e.g. RANGE ROVER) with spaces.
    """
    raw = _vehicle_text_value(value) or _clean_value(value or "")
    if not raw:
        return ""
    # Collapse repeated spaces but keep intentional gaps between tokens
    raw = re.sub(r"\s+", " ", raw).strip()
    mark_u = (mark or "").upper()
    # 3-digit BMW series + trailing i misread as 1 / I / l (optional space)
    m = re.fullmatch(r"([1-8]\d{2})\s*[1Il]", raw)
    if m and ("BMW" in mark_u or not mark_u):
        return m.group(1) + "i"
    # Already letter but uppercase I (optional space)
    m = re.fullmatch(r"([1-8]\d{2})\s*I", raw)
    if m and ("BMW" in mark_u or not mark_u):
        return m.group(1) + "i"
    return raw


def _as_field_code(token: str) -> str:
    """Normalize an OCR token into a certificate field code, or ''."""
    raw = (token or "").strip()
    if not raw:
        return ""
    raw = raw.replace(",", ".")
    raw = re.sub(r"^[(\[]|[)\]]$", "", raw)
    raw = raw.rstrip(".)-: ")
    # EU subtype "(a)" must not become field A
    if re.fullmatch(r"[a-z]", raw):
        return ""
    up = raw.upper()
    if re.fullmatch(r"[A-Z]\.\d+(?:\.\d+)?", up):
        return up
    # OCR often drops dots: D1 → D.1, P3 → P.3, C11 → ignore (ambiguous)
    m = re.fullmatch(r"([A-Z])(\d)(\d)?", up)
    if m and m.group(1) in {"D", "P", "C"}:
        if m.group(3):
            return f"{m.group(1)}.{m.group(2)}.{m.group(3)}"
        return f"{m.group(1)}.{m.group(2)}"
    if re.fullmatch(r"[A-Z]", up):
        return up
    return ""


def _norm_dotted_key(key: str) -> str:
    return (key or "").upper().replace(",", ".")


def _is_legal_entity(value: str) -> bool:
    """True when owner is an LLC / company (შპს, Ltd, …)."""
    return bool(_LEGAL_ENTITY_RE.search(value or ""))


def _looks_like_address(value: str) -> bool:
    raw = (value or "").strip()
    if not raw:
        return False
    if _is_legal_entity(raw):
        return False
    return bool(_ADDRESS_HINT_RE.search(raw))


def _company_name_value(value: str) -> str:
    """Clean legal-entity owner name; keep 'შპს დიზი / Ltd Dizi' when present."""
    raw = _strip_code_noise(value or "")
    raw = re.sub(r"^(?:C[.,]\d+(?:[.,]\d+)?)\s*", "", raw, flags=re.I).strip()
    raw = re.split(r"\s+C[.,]\d+", raw, maxsplit=1, flags=re.I)[0].strip()
    if not raw:
        return ""
    if "/" in raw:
        left, right = [p.strip() for p in raw.split("/", 1)]
        if left and right:
            return f"{left} / {right}"
        return left or right
    return raw


def _owner_bilingual(value: str) -> str:
    """Keep 'ქართული / Latin' when both sides exist on the certificate."""
    raw = _strip_code_noise(value or "")
    if not raw:
        return ""
    # Drop leading/trailing field codes that leaked into the value
    raw = re.sub(r"^(?:C[.,]\d+(?:[.,]\d+)?)\s*", "", raw, flags=re.I).strip()
    raw = re.split(r"\s+C[.,]\d+", raw, maxsplit=1, flags=re.I)[0].strip()
    if _looks_like_address(raw):
        return ""
    if "/" in raw:
        left, right = [p.strip() for p in raw.split("/", 1)]
        geo = _georgian_only(left) or _georgian_only(raw)
        lat = re.sub(r"[^A-Za-z\- ]", "", right).strip() or re.sub(
            r"[^A-Za-z\- ]", "", left
        ).strip()
        if geo and lat and len(lat) >= 2:
            return f"{geo} / {lat}"
        return geo or lat or raw
    geo = _georgian_only(raw)
    lat = re.sub(r"[^A-Za-z\- ]", "", raw).strip()
    if geo and lat and geo.lower() != lat.lower() and len(lat) >= 2:
        return f"{geo} / {lat}"
    return geo or lat or raw


def _code_value_ok(key: str, value: str) -> bool:
    """Reject caption fragments that sit on the same row as a field code."""
    val = (value or "").strip()
    if not val:
        return False
    low = val.lower()
    if low in {
        "vehicle",
        "registration",
        "certificate",
        "georgia",
        "owner",
        "number",
        "date",
        "year",
        "manufacture",
        "personal",
        "expiration",
        "colour",
        "color",
        "mark",
        "type",
        "model",
        "fuel",
    }:
        return False
    # Value must not be another certificate field code
    first = val.split()[0] if val else ""
    if _as_field_code(first) or _norm_dotted_key(first) in {
        "C.1.1",
        "C.1.2",
        "C.1.3",
        "C.1.4",
        "D.1",
        "D.2",
        "D.3",
    }:
        return False
    if key == "A":
        return bool(_PLATE_RE.search(re.sub(r"\s+", "", val))) or (
            5 <= len(re.sub(r"[^A-Za-z0-9]", "", val)) <= 12
        )
    if key == "B":
        return bool(_YEAR_FULL_RE.match(re.sub(r"\D", "", val)[:4] if val else ""))
    if key in {"C", "I", "L"}:
        return bool(_find_dates_in_text(val))
    if key == "H":
        return val == "-" or bool(_find_dates_in_text(val)) or bool(
            re.fullmatch(r"[-_—–−.]+", val)
        )
    if key == "C.1.4":
        digits = re.sub(r"\D", "", val)
        return len(digits) >= 9  # person 11 / company tax id often 9
    if key in {"C.1.1", "C.1.2"}:
        if _looks_like_address(val):
            return False
        compact = re.sub(r"\s+", "", val)
        if _PLATE_RE.search(compact):
            return False
        digits = re.sub(r"\D", "", val)
        if digits and (_YEAR_FULL_RE.match(digits) or len(digits) >= 11):
            return False
        if _find_dates_in_text(val):
            return False
        if _is_legal_entity(val):
            return True
        return bool(_GEO_RE.search(val) or re.search(r"[A-Za-z]{3,}", val))
    if key == "E":
        return bool(_VIN_RE.search(re.sub(r"[\s\-]", "", val.upper()))) or (
            11 <= len(re.sub(r"[\s\-]", "", val)) <= 17
        )
    if key == "P.1":
        return bool(_ENGINE_RE.search(val) or re.search(r"\b\d{3,4}\b", val))
    return not _looks_like_junk(val)


def _codes_from_words(
    words: list[dict] | None,
    *,
    dotted_prefixes: tuple[str, ...] = (),
    single_letters: set[str] | None = None,
) -> dict[str, str]:
    """
    Read field codes using Vision word boxes (same row, value to the right).
    Survives column-wise OCR where 'A' and 'CX635CX' land on different text lines.
    """
    if not words:
        return {}
    singles = {s.upper() for s in (single_letters or set())}
    prefixes = tuple(p.upper() for p in dotted_prefixes)

    def _wanted(key: str) -> bool:
        if "." in key:
            if not prefixes:
                return True
            return any(key.startswith(p) for p in prefixes)
        return (not singles) or key in singles

    heights = [max(1, int(w["y2"] - w["y1"])) for w in words]
    heights.sort()
    row_tol = max(10.0, heights[len(heights) // 2] * 0.85)

    ordered = sorted(words, key=lambda w: (float(w["cy"]), float(w["cx"])))
    tokens: list[dict] = []
    i = 0
    while i < len(ordered):
        w = ordered[i]
        t0 = (w.get("text") or "").strip()
        key = _as_field_code(t0)
        used = 1
        if not key and i + 1 < len(ordered):
            w1 = ordered[i + 1]
            if abs(float(w1["cy"]) - float(w["cy"])) <= row_tol and float(w1["cx"]) >= float(w["cx"]) - 2:
                merged = t0 + (w1.get("text") or "")
                key = _as_field_code(merged)
                if key:
                    used = 2
        if not key and i + 2 < len(ordered):
            w1, w2 = ordered[i + 1], ordered[i + 2]
            if (
                abs(float(w1["cy"]) - float(w["cy"])) <= row_tol
                and abs(float(w2["cy"]) - float(w["cy"])) <= row_tol
            ):
                merged = t0 + (w1.get("text") or "") + (w2.get("text") or "")
                key = _as_field_code(merged)
                if key:
                    used = 3
        piece = ordered[i : i + used]
        tokens.append(
            {
                "key": key if key and _wanted(key) else "",
                "text": "".join((p.get("text") or "") for p in piece),
                "cx": float(piece[0]["cx"]),
                "cy": float(piece[0]["cy"]),
                "x2": float(max(p["x2"] for p in piece)),
                "y1": float(min(p["y1"] for p in piece)),
                "y2": float(max(p["y2"] for p in piece)),
            }
        )
        i += used

    codes: dict[str, str] = {}
    for tok in tokens:
        key = tok["key"]
        if not key:
            continue
        # Same visual row, to the RIGHT of the code (do not rely on reading order)
        right = [
            nxt
            for nxt in tokens
            if not nxt["key"]
            and abs(float(nxt["cy"]) - float(tok["cy"])) <= row_tol
            and float(nxt["cx"]) > float(tok["x2"]) - 2
        ]
        right.sort(key=lambda n: float(n["cx"]))
        parts: list[str] = []
        for nxt in right:
            txt = (nxt.get("text") or "").strip()
            if not txt:
                continue
            if txt.startswith("(") and parts:
                break
            parts.append(txt)
            joined = " ".join(parts)
            if key in {"A", "B", "C", "I", "L", "H", "E", "R"} and _code_value_ok(key, joined):
                break
            if key == "C.1.4" and re.search(r"\d{11}", joined):
                break
            if key in {"C.1.1", "C.1.2"} and len(parts) >= 2:
                break
            # Stop if we already have a good value and next looks like English caption
            if parts and not _code_value_ok(key, txt) and _code_value_ok(key, parts[0]):
                parts = parts[:1]
                break
        val = _trim_code_value(" ".join(parts))
        if not val and key == "H":
            # bare H / H . with no word to the right
            val = "-"
        if val and _code_value_ok(key, val) and key not in codes:
            codes[key] = val
        elif key == "H" and key not in codes:
            codes[key] = "-"
    return codes


def _collect_side_codes(
    text: str,
    lines: list[str],
    *,
    dotted_prefixes: tuple[str, ...] = (),
    single_letters: set[str] | None = None,
    inline_re: re.Pattern | None = None,
    words: list[dict] | None = None,
) -> dict[str, str]:
    """Collect letter / dotted certificate codes from OCR text + word boxes."""
    codes: dict[str, str] = {}
    singles = {s.upper() for s in (single_letters or set())}
    prefixes = tuple(p.upper() for p in dotted_prefixes)

    def _prefix_ok(key: str) -> bool:
        if not prefixes:
            return True
        return any(key.startswith(p) for p in prefixes)

    # 1) Line / full-text parsers first (accurate when Vision keeps code+value together)
    for i, line in enumerate(lines or []):
        stripped = (line or "").strip()
        dm = re.match(
            r"^\s*[(\[]?([A-Z][.,]\d+(?:[.,]\d+)?)[)\]]?[.)\-:]*\s*(.*)$",
            stripped,
            re.I,
        )
        if dm:
            key = _norm_dotted_key(dm.group(1))
            if not _prefix_ok(key):
                continue
            val = _value_after_dotted_code(lines, i, dm.group(2))
            if val and _code_value_ok(key, val) and key not in codes:
                codes[key] = val
            continue

        # Back OCR often prints "D,2 სედანი" or "D 3 PASSAT"
        loose = re.match(
            r"^\s*[(\[]?([A-Z])[)\]]?[.,\s]+(\d)(?:[.,\s]+(\d))?[)\]]?[.)\-:]*\s*(.*)$",
            stripped,
            re.I,
        )
        if loose and loose.group(1).upper() in {"C", "D", "P"}:
            a, b, c, rest = loose.group(1), loose.group(2), loose.group(3), loose.group(4)
            key = _norm_dotted_key(f"{a}.{b}.{c}" if c else f"{a}.{b}")
            if _prefix_ok(key):
                val = _value_after_dotted_code(lines, i, rest or "")
                if val and _code_value_ok(key, val) and key not in codes:
                    codes[key] = val
                    continue

        # OCR frequently reads letter I as digit 1: "1 20/02/2025"
        one_as_i = re.match(
            r"^\s*1[)\]]?[.)\-:]*\s+(\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4}\S*)",
            stripped,
        )
        if one_as_i and (not singles or "I" in singles):
            val = _trim_code_value(one_as_i.group(1))
            if val and _find_dates_in_text(val) and "I" not in codes:
                codes["I"] = val
                continue

        m = _LETTER_LINE_RE.match(stripped)
        if not m:
            continue
        letter = m.group(1).upper()
        if letter == "L" and (not singles or "I" in singles):
            # lowercase L / | misread of I when value is a date — handled below
            pass
        if singles and letter not in singles:
            continue
        # Ignore lowercase-only "(a)" style markers already handled by regex ^[A-Za-z]
        if m.group(1).islower():
            continue
        val = _trim_code_value(m.group(2))
        if not val:
            val = _value_after_dotted_code(lines, i, "")
        if not val:
            continue
        if letter == "C" and not _find_dates_in_text(val) and val != "-":
            continue
        # l / | as I when value is clearly a date
        if letter in {"L", "|"} and _find_dates_in_text(val) and (not singles or "I" in singles):
            letter = "I"
        if letter not in codes and _code_value_ok(letter, val):
            codes[letter] = val

    for m in _DOTTED_CODE_RE.finditer(text or ""):
        key = _norm_dotted_key(m.group(1))
        if not _prefix_ok(key):
            continue
        val = _trim_code_value(m.group(2))
        if val and _code_value_ok(key, val) and key not in codes:
            codes[key] = val

    # 2) Spatial fill for missing keys only
    for key, val in _codes_from_words(
        words,
        dotted_prefixes=prefixes,
        single_letters=singles,
    ).items():
        if val and key not in codes:
            codes[key] = val

    if inline_re:
        for m in inline_re.finditer(text or ""):
            letter = m.group(1).upper()
            if singles and letter not in singles:
                continue
            val = _trim_code_value(m.group(2))
            if not val:
                continue
            if letter == "C" and not _find_dates_in_text(val) and val != "-":
                continue
            if letter not in codes:
                codes[letter] = val

    return codes


def _normalize_plate(value: str) -> str:
    raw = _clean_value(value or "").upper()
    # Strip trailing OCR junk from the same line (next letter codes, etc.)
    raw = re.split(r"\s+[A-Z](?:\s|$)", raw, maxsplit=1)[0].strip()
    m = _PLATE_RE.search(raw.replace(" ", ""))
    if not m:
        m = _PLATE_RE.search(raw.replace(" ", "-"))
    if m:
        return re.sub(r"[\s\-]+", "", m.group(1).upper())
    compact = re.sub(r"[^A-Z0-9]", "", raw)
    if 5 <= len(compact) <= 12:
        return compact
    return re.sub(r"\s+", "", raw)


def _normalize_expiry(value: str) -> str:
    """H may be a real date or a dash placeholder."""
    raw = (value or "").strip()
    if not raw:
        return ""
    if re.fullmatch(r"[-_—–−.]+", raw):
        return "-"
    dates = _find_dates_in_text(raw)
    return dates[0] if dates else _strip_code_noise(raw)


def _collect_front_codes(
    text: str,
    lines: list[str],
    words: list[dict] | None = None,
) -> dict[str, str]:
    """
    Front-side certificate codes (user mapping):
      A, B, C, C.1.1, C.1.2, C.1.4, H
    Note: real cards often print registration date as I (not C).
    """
    codes = _collect_side_codes(
        text,
        lines,
        dotted_prefixes=("C.",),
        single_letters={"A", "B", "C", "H", "I", "L"},
        inline_re=None,  # too noisy — spatial + line parsers only
        words=words,
    )
    for m in _DOTTED_CODE_RE.finditer(text or ""):
        key = _norm_dotted_key(m.group(1))
        if not key.startswith("C."):
            continue
        val = _trim_code_value(m.group(2))
        if val and key not in codes:
            codes[key] = val

    # Fallbacks when I was OCR'd as 1 / missing from codes
    if "I" not in codes:
        for line in lines or []:
            m = re.match(
                r"^\s*(?:I|1|l|\|)[)\]]?[.)\-:]*\s+(\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4}\S*)",
                (line or "").strip(),
            )
            if m and _find_dates_in_text(m.group(1)):
                codes["I"] = _trim_code_value(m.group(1))
                break
    if "I" not in codes and words:
        # Spatial: token "1" or "I" with a date word on the same row
        for w in words:
            tok = (w.get("text") or "").strip()
            if tok not in {"1", "I", "i", "l", "|"}:
                continue
            cy, x2 = float(w["cy"]), float(w["x2"])
            for o in words:
                if float(o["cx"]) <= x2 - 2:
                    continue
                if abs(float(o["cy"]) - cy) > 14:
                    continue
                t = (o.get("text") or "").strip()
                if _find_dates_in_text(t):
                    codes["I"] = _trim_code_value(t)
                    break
            if "I" in codes:
                break
    return codes


def _collect_back_codes(
    text: str,
    lines: list[str],
    words: list[dict] | None = None,
) -> dict[str, str]:
    """
    Back-side certificate codes (user mapping):
      D.1 mark, D.2 type, D.3 model, E VIN, P.1 engine, P.3 fuel, R color
    """
    codes = _collect_side_codes(
        text,
        lines,
        dotted_prefixes=("D.", "P."),
        single_letters={"E", "R"},
        inline_re=None,
        words=words,
    )
    for m in _DOTTED_CODE_RE.finditer(text or ""):
        key = _norm_dotted_key(m.group(1))
        if not (key.startswith("D.") or key.startswith("P.")):
            continue
        val = _trim_code_value(m.group(2))
        if val and key not in codes:
            codes[key] = val

    # Inline mid-line codes: "ტიპი D,2 სედანი", "მოდელი D 3 PASSAT", "ფერი R შავი"
    for line in lines or []:
        stripped = (line or "").strip()
        for m in re.finditer(
            r"\b([DP])[.,\s]+(\d)\b[.)\-:]*\s*([^\n]+)",
            stripped,
            re.I,
        ):
            key = _norm_dotted_key(f"{m.group(1)}.{m.group(2)}")
            if not (key.startswith("D.") or key.startswith("P.")):
                continue
            val = _trim_code_value(m.group(3))
            # Keep Georgian + English when OCR uses backslash: "სედანი\SEDAN"
            if "\\" in (m.group(3) or ""):
                parts = [p.strip() for p in re.split(r"\s*\\\s*", m.group(3)) if p.strip()]
                if len(parts) >= 2:
                    val = f"{parts[0]} {parts[1]}"
            if val and _code_value_ok(key, val) and key not in codes:
                codes[key] = val
        rm = re.search(r"\bR\b[.)\-:]*\s+([^\n(]+)", stripped, re.I)
        if rm and "R" not in codes:
            val = _trim_code_value(rm.group(1))
            if "\\" in (rm.group(1) or ""):
                parts = [p.strip() for p in re.split(r"\s*\\\s*", rm.group(1)) if p.strip()]
                if len(parts) >= 2:
                    val = f"{parts[0]} {parts[1]}"
            if val and _code_value_ok("R", val):
                codes["R"] = val
        em = re.search(r"\bE\b[.)\-:]*\s+([A-HJ-NPR-Z0-9]{11,17})", stripped, re.I)
        if em and "E" not in codes:
            codes["E"] = em.group(1).upper()
    return codes


def _parse_back_codes(
    text: str,
    lines: list[str],
    words: list[dict] | None = None,
) -> dict[str, str]:
    """Map back letter/dotted codes onto extracted_data keys."""
    codes = _collect_back_codes(text, lines, words)
    out: dict[str, str] = {}

    if codes.get("D.1"):
        out["mark"] = _vehicle_text_value(codes["D.1"])
    if codes.get("D.2"):
        out["type"] = _normalize_type(codes["D.2"])
    if codes.get("D.3"):
        out["model"] = _normalize_model(codes["D.3"], out.get("mark", ""))
    if codes.get("E"):
        out["vin"] = _normalize_vin(codes["E"])
    if codes.get("P.1"):
        out["engine_capacity"] = _normalize_engine(codes["P.1"], from_code=True)
    if codes.get("P.3"):
        out["fuel_type"] = _normalize_fuel(codes["P.3"])
    if codes.get("R"):
        out["color"] = _normalize_color(codes["R"])

    return out


def _parse_letter_codes(
    text: str,
    lines: list[str],
    words: list[dict] | None = None,
) -> dict[str, str]:
    """Map front letter/dotted codes onto extracted_data keys (user field list)."""
    codes = _collect_front_codes(text, lines, words)
    out: dict[str, str] = {}

    # 1. Registration number ← (A)
    if codes.get("A"):
        out["registration_number"] = _normalize_plate(codes["A"])

    # 2. Production year ← (B)
    if codes.get("B"):
        out["production_year"] = _normalize_year(codes["B"])

    # 3. Registration date ← (C); Georgian prints often use I for the same value
    reg_date_raw = ""
    bare_c = codes.get("C", "")
    if bare_c and _find_dates_in_text(bare_c):
        reg_date_raw = bare_c
    elif codes.get("I") and _find_dates_in_text(codes["I"]):
        reg_date_raw = codes["I"]
    elif codes.get("L") and _find_dates_in_text(codes["L"]):
        reg_date_raw = codes["L"]
    if reg_date_raw:
        out["registration_date"] = _normalize_date(reg_date_raw)

    c11 = (codes.get("C.1.1") or "").strip()
    c12 = (codes.get("C.1.2") or "").strip()
    # OCR sometimes merges into "C.1" with leftover ",1 შპს…"
    if not c11 and codes.get("C.1"):
        raw_c1 = codes["C.1"]
        fixed = re.sub(r"^,?\s*1\s+", "", raw_c1).strip()
        if _is_legal_entity(fixed) or _is_legal_entity(raw_c1):
            c11 = fixed or raw_c1

    # Legal entity (შპს / Ltd / …): company → Owner's Name box, surname always "-"
    company_raw = ""
    if _is_legal_entity(c11):
        company_raw = c11
    elif _is_legal_entity(c12):
        company_raw = c12
    if company_raw:
        out["owner_name"] = _company_name_value(company_raw)
        out["owner_surname"] = "-"
    else:
        # Natural person: C.1.1 surname, C.1.2 given name
        if c11 and not _looks_like_address(c11):
            out["owner_surname"] = _owner_bilingual(c11)
        if c12 and not _looks_like_address(c12):
            out["owner_name"] = _owner_bilingual(c12)

    # 6. Owner's personal / company ID ← (C.1.4)
    if codes.get("C.1.4"):
        pids = _find_personal_ids(codes["C.1.4"])
        if pids:
            out["owner_personal_number"] = _pick_personal_id(pids)
        else:
            digits = re.sub(r"\D", "", codes["C.1.4"])
            if len(digits) in (9, 11):
                out["owner_personal_number"] = digits

    # 7. Expiration date ← (H)
    if "H" in codes:
        out["expiration_date"] = _normalize_expiry(codes["H"])

    return out


def _parse_side(text: str, lines: list[str], label_map: dict[str, list[str]]) -> dict:
    out: dict[str, str] = {}
    for key, labels in label_map.items():
        prefer_geo = key in ("owner_name", "owner_surname", "mark", "type", "model", "color", "fuel_type")
        val = _field_from_labels(lines, labels, prefer_georgian=prefer_geo)
        if val:
            out[key] = val
    return out


def _enrich_front(
    data: dict,
    text: str,
    lines: list[str],
    words: list[dict] | None = None,
) -> dict:
    # Letter / dotted codes on the certificate are authoritative
    coded = _parse_letter_codes(text, lines, words)
    for key, value in coded.items():
        if value:
            data[key] = value

    # Card number only (no letter code) — serial near footer
    if data.get("card_number"):
        data["card_number"] = _clean_value(data["card_number"]).upper()
    if not data.get("card_number"):
        for m in re.finditer(r"\b([A-Z]{2,3}\d{6,10})\b", text or "", re.I):
            cand = m.group(1).upper()
            if re.fullmatch(r"\d{11}", cand):
                continue
            if not _PLATE_RE.fullmatch(cand):
                data["card_number"] = cand
                break

    if data.get("registration_number"):
        data["registration_number"] = _normalize_plate(data["registration_number"])
    if data.get("production_year"):
        data["production_year"] = _normalize_year(data["production_year"])
    if data.get("registration_date"):
        data["registration_date"] = _normalize_date(data["registration_date"])
    if data.get("expiration_date") is not None and data.get("expiration_date") != "":
        data["expiration_date"] = _normalize_expiry(data["expiration_date"])
    if data.get("owner_name"):
        if _is_legal_entity(data["owner_name"]):
            data["owner_name"] = _company_name_value(data["owner_name"])
            data["owner_surname"] = "-"
        else:
            data["owner_name"] = _owner_bilingual(data["owner_name"])
    if data.get("owner_surname") == "-":
        pass
    elif data.get("owner_surname"):
        if _is_legal_entity(data["owner_surname"]):
            # Company landed in surname box — move to name, surname = "-"
            data["owner_name"] = _company_name_value(data["owner_surname"])
            data["owner_surname"] = "-"
        else:
            data["owner_surname"] = _owner_bilingual(data["owner_surname"])

    return data


def _enrich_back(
    data: dict,
    text: str,
    lines: list[str],
    words: list[dict] | None = None,
) -> dict:
    coded = _parse_back_codes(text, lines, words)
    for key, value in coded.items():
        if value:
            data[key] = value

    if data.get("vin"):
        data["vin"] = _normalize_vin(data["vin"])
    if not data.get("vin"):
        vin = _first_match(_VIN_RE, text)
        if vin:
            data["vin"] = vin.upper()

    if data.get("engine_capacity"):
        data["engine_capacity"] = _normalize_engine(
            data["engine_capacity"], from_code=True
        )
    if not data.get("engine_capacity"):
        eng = _first_match(_ENGINE_RE, text)
        if eng:
            data["engine_capacity"] = _normalize_engine(eng)

    if data.get("fuel_type"):
        data["fuel_type"] = _normalize_fuel(data["fuel_type"])
    if data.get("type"):
        data["type"] = _normalize_type(data["type"])
    if data.get("color"):
        data["color"] = _normalize_color(data["color"])

    for key in ("mark", "model"):
        if data.get(key):
            data[key] = _vehicle_text_value(data[key]) or _clean_value(data[key])
    if data.get("model"):
        data["model"] = _normalize_model(data["model"], data.get("mark", ""))

    return data


def _looks_like_front(text: str) -> bool:
    t = text or ""
    return bool(
        re.search(r"(?im)(?:^|\n)\s*[(\[]?[AB][)\]]?[.)\-:]*\s+\S", t)
        or re.search(r"(?i)\bC\.1\.[124]\b", t)
        or re.search(r"(?i)რეგისტრაციის\s+ნომერი|registration\s+number", t)
    )


def _looks_like_back(text: str) -> bool:
    t = text or ""
    return bool(
        re.search(r"(?i)\bD\.[123]\b|\bP\.[13]\b", t)
        or _VIN_RE.search(t)
        or re.search(r"(?i)\bVIN\b|მარკა|ძრავ", t)
    )


# Soft label fill only when dotted codes are missing (type/color often succeed)
_BACK_LABEL_FALLBACK_KEYS = ("type", "color", "fuel_type")


def _crop_xyxy_to_data_url(
    image_bytes: bytes, left: int, top: int, right: int, bottom: int, pad_frac: float = 0.08
) -> str:
    """Crop pixel box → PNG data URL."""
    try:
        img = Image.open(BytesIO(image_bytes)).convert("RGB")
        w, h = img.size
        pad = max(6, int(min(w, h) * pad_frac))
        left = max(0, int(left) - pad)
        top = max(0, int(top) - pad)
        right = min(w, int(right) + pad)
        bottom = min(h, int(bottom) + pad)
        if right - left < 12 or bottom - top < 12:
            return ""
        crop = img.crop((left, top, right, bottom))
        buf = BytesIO()
        crop.save(buf, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return ""


def _crop_to_data_url(image_bytes: bytes, vertices) -> str:
    """Crop barcode bounding poly → PNG data URL."""
    try:
        xs = [int(getattr(v, "x", 0) or 0) for v in vertices]
        ys = [int(getattr(v, "y", 0) or 0) for v in vertices]
        if not xs or not ys:
            return ""
        return _crop_xyxy_to_data_url(image_bytes, min(xs), min(ys), max(xs), max(ys))
    except Exception:
        return ""


def _crop_rel_box_to_data_url(image_bytes: bytes, box: dict | None) -> str:
    """Crop normalized {left,top,width,height} box (0–1) → PNG data URL."""
    if not isinstance(box, dict):
        return ""
    try:
        img = Image.open(BytesIO(image_bytes))
        w, h = img.size
        left = float(box.get("left", 0) or 0) * w
        top = float(box.get("top", 0) or 0) * h
        width = float(box.get("width", 0) or 0) * w
        height = float(box.get("height", 0) or 0) * h
        if width < 8 or height < 8:
            return ""
        return _crop_xyxy_to_data_url(
            image_bytes, left, top, left + width, top + height, pad_frac=0.06
        )
    except Exception:
        return ""


def _decode_qr_vision(image_bytes: bytes) -> tuple[str, str, float | None]:
    """Google Vision barcode detection → (payload, crop_data_url, center_x 0–1)."""
    try:
        client = _get_vision_client()
        image = vision.Image(content=image_bytes)
        response = client.barcode_detection(image=image)
        if response.error.message:
            return "", "", None
        barcodes = list(response.barcodes or [])
        ordered = sorted(
            barcodes,
            key=lambda b: 0 if "QR" in str(getattr(b, "format_", "")).upper() else 1,
        )
        img_w = 0
        try:
            img_w = Image.open(BytesIO(image_bytes)).size[0]
        except Exception:
            img_w = 0
        for bc in ordered:
            val = (getattr(bc, "raw_value", None) or "").strip()
            poly = getattr(bc, "bounding_poly", None)
            verts = getattr(poly, "vertices", None) if poly else None
            center_x = None
            crop = ""
            if verts:
                xs = [int(getattr(v, "x", 0) or 0) for v in verts]
                if xs and img_w > 0:
                    center_x = ((min(xs) + max(xs)) / 2.0) / float(img_w)
                crop = _crop_to_data_url(image_bytes, verts)
            if val or center_x is not None:
                return val, crop, center_x
    except Exception:
        pass
    return "", "", None


def _decode_qr_node(image_bytes: bytes) -> tuple[str, str, float | None]:
    """Fallback: Node jsQR/ZXing → (payload, crop, center_x)."""
    if not _DECODE_QR_SCRIPT.is_file() or not _TSX_CLI.is_file():
        return "", "", None
    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        return "", "", None
    try:
        with tempfile.TemporaryDirectory() as tmp:
            img_path = Path(tmp) / "back.jpg"
            img_path.write_bytes(image_bytes)
            proc = subprocess.run(
                [node, str(_TSX_CLI), str(_DECODE_QR_SCRIPT), str(img_path)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=str(_BASE_DIR),
                timeout=60,
            )
            out = (proc.stdout or "").strip()
            if not out:
                return "", "", None
            data = json.loads(out.splitlines()[-1])
            val = (data.get("value") or "").strip()
            source = str(data.get("source") or "")
            box = data.get("box") if isinstance(data.get("box"), dict) else None
            center_x = None
            # Ignore pure layout guesses — only decoded / plate hits
            if box and source in ("decoded", "plate"):
                try:
                    center_x = float(box.get("left", 0) or 0) + float(box.get("width", 0) or 0) / 2.0
                except (TypeError, ValueError):
                    center_x = None
            crop = _crop_rel_box_to_data_url(image_bytes, box) if (val or center_x is not None) else ""
            if not val and center_x is None:
                return "", "", None
            return val, crop, center_x
    except Exception:
        return "", "", None


def decode_tech_passport_qr(back_bytes: bytes) -> dict:
    """Decode QR from tech-passport back image."""
    value, crop, _cx = _decode_qr_vision(back_bytes)
    if not value:
        value, crop, _cx = _decode_qr_node(back_bytes)
    return {
        "qr_code_value": value or "",
        "qr_code_data_url": crop or "",
    }


TECH_PASSPORT_SIDE_ERROR = "Please upload tech passport"


def _text_looks_like_id_license_or_passport_front(text: str) -> bool:
    """
    Backup when face detection is unavailable: reject clear ID / license / passport
    titles only. Never use personal-number labels (those also appear on tech passport).
    """
    t = text or ""
    if _looks_like_front(t):
        return False
    return bool(
        re.search(
            r"IDENTITY\s+CARD|პირადობის\s+მოწმობა|GEORGIA\s+IDENTITY|"
            r"DRIVING\s+LICEN[CS]E|მართვის\s+მოწმობა|"
            r"(?:^|\n)\s*PASSPORT\b|პასპორტი\b|"
            r"P<[A-Z0-9]{3}|PPGE[O0]",
            t,
            re.I,
        )
    )


def _text_has_mrz_strip(text: str) -> bool:
    """True when OCR looks like an ID/passport MRZ strip."""
    from id_verifier import extract_mrz_ids, extract_mrz_strip
    from passport_verifier import extract_passport_mrz_strip, has_passport_mrz

    raw = text or ""
    if extract_mrz_strip(raw):
        return True
    ids = extract_mrz_ids(raw)
    if ids.get("card_number") or ids.get("personal_id"):
        return True
    passport_strip = extract_passport_mrz_strip(raw)
    if has_passport_mrz(passport_strip):
        return True
    blob = re.sub(r"\s+", "", raw.upper())
    if re.search(r"(?:ID|TR)GE[O0]|ID<<|P<[A-Z0-9]{3}|PPGE[O0]|IDGE\d|TRGE\d", blob):
        return True
    # Typical MRZ filler: long A-Z0-9/< run with «<<<»
    if re.search(r"[A-Z0-9<]{20,}<{2,}", blob):
        return True
    return False


def _qr_is_on_document_left(image_bytes: bytes) -> bool:
    """True when a QR code is detected on the left half (license-style back)."""
    _val, _crop, center_x = _decode_qr_vision(image_bytes)
    if center_x is None:
        _val, _crop, center_x = _decode_qr_node(image_bytes)
    if center_x is None:
        return False
    return center_x <= 0.55


def validate_tech_passport_side(image_bytes: bytes, side: str) -> dict:
    """
    Tech-passport capture/upload checks (only this document type):
    - any side: reject when an MRZ strip is visible
    - front: also reject when a person face/head is visible (ID / license / passport photo)
    - back: also reject when QR sits on the left side (license-style back)
    Personal-number text must not affect the front decision.
    """
    side_norm = (side or "").strip().lower()
    if side_norm not in ("front", "back"):
        return {"ok": False, "error": "side must be front or back", "side": side_norm}

    text = ""
    try:
        text, _lines, _words = ocr_image(image_bytes)
    except Exception:
        text = ""

    # MRZ belongs to ID/passport — never accept on tech passport (front or back)
    if _text_has_mrz_strip(text):
        return {
            "ok": False,
            "error": TECH_PASSPORT_SIDE_ERROR,
            "side": side_norm,
            "has_mrz": True,
        }

    if side_norm == "front":
        has_face = image_has_face(image_bytes)
        if has_face:
            return {
                "ok": False,
                "error": TECH_PASSPORT_SIDE_ERROR,
                "side": side_norm,
                "has_face": True,
                "has_mrz": False,
            }
        if _text_looks_like_id_license_or_passport_front(text):
            return {
                "ok": False,
                "error": TECH_PASSPORT_SIDE_ERROR,
                "side": side_norm,
                "has_face": False,
                "has_mrz": False,
                "wrong_doc": True,
            }
        return {
            "ok": True,
            "side": side_norm,
            "has_face": False,
            "has_mrz": False,
            "wrong_doc": False,
        }

    if _qr_is_on_document_left(image_bytes):
        return {
            "ok": False,
            "error": TECH_PASSPORT_SIDE_ERROR,
            "side": side_norm,
            "has_mrz": False,
            "qr_on_left": True,
        }
    return {
        "ok": True,
        "side": side_norm,
        "has_mrz": False,
        "qr_on_left": False,
    }


def extract_tech_passport_info(front_bytes: bytes, back_bytes: bytes) -> dict:
    """OCR both sides and return extracted_data for the tech-passport UI fields."""
    front_text, front_lines, front_words, _front_rot = ocr_image_ex(front_bytes)
    back_text, back_lines, back_words, _back_rot = ocr_image_ex(back_bytes)

    # Codes only for front — labels pollute plate/year/owner from parenthetical captions
    front = _enrich_front({}, front_text, front_lines, front_words)
    if not front.get("card_number"):
        labeled_card = _field_from_labels(front_lines, _FRONT_LABELS["card_number"])
        if labeled_card and re.search(r"[A-Z]{2,3}\d{5,}", labeled_card, re.I):
            front["card_number"] = _clean_value(labeled_card).upper()

    back = _enrich_back({}, back_text, back_lines, back_words)
    # Only fill a few back gaps from labels when this side actually looks like the back
    if _looks_like_back(back_text):
        labeled_back = _parse_side(back_text, back_lines, _BACK_LABELS)
        for key in _BACK_LABEL_FALLBACK_KEYS:
            if labeled_back.get(key) and not back.get(key):
                back[key] = labeled_back[key]
        back = _enrich_back(back, back_text, back_lines, back_words)

    if not front.get("registration_number") and back_text and _looks_like_front(back_text):
        alt = _enrich_front({}, back_text, back_lines, back_words)
        for k, v in alt.items():
            if v and not front.get(k):
                front[k] = v

    if not back.get("vin") and front_text and _looks_like_back(front_text):
        alt = _enrich_back({}, front_text, front_lines, front_words)
        for k, v in alt.items():
            if v and not back.get(k):
                back[k] = v

    extracted = {**front, **back}
    filled = sum(1 for v in extracted.values() if str(v or "").strip())

    qr = decode_tech_passport_qr(back_bytes)
    # If back had no QR, try front (side swap)
    if not qr.get("qr_code_value") and front_bytes:
        alt_qr = decode_tech_passport_qr(front_bytes)
        if alt_qr.get("qr_code_value"):
            qr = alt_qr

    try:
        dump = {
            "extracted": {k: v for k, v in extracted.items() if str(v or "").strip()},
            "front_codes": _collect_front_codes(front_text, front_lines, front_words),
            "back_codes": _collect_back_codes(back_text, back_lines, back_words),
            "front_lines": front_lines[:50],
            "back_lines": back_lines[:50],
            "qr_code_value": qr.get("qr_code_value") or "",
        }
        Path(__file__).resolve().parent.joinpath("_last_tech_ocr.json").write_text(
            json.dumps(dump, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        pass

    return {
        "ok": True,
        "extracted_data": extracted,
        "filled_count": filled,
        "qr_code_value": qr.get("qr_code_value") or "",
        "qr_code_data_url": qr.get("qr_code_data_url") or "",
        "raw_text": {
            "front": front_text or "",
            "back": back_text or "",
        },
        "debug_codes": {
            "front": _collect_front_codes(front_text, front_lines, front_words),
            "back": _collect_back_codes(back_text, back_lines, back_words),
        },
    }
