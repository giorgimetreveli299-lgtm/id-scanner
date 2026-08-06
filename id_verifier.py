import os
import re
from pathlib import Path

from google.cloud import vision
from google.oauth2 import service_account

_CREDENTIALS_PATH = Path(__file__).resolve().parent / "clientdocsocr.json"
_vision_client = None

_LABEL_MAP = {
    "first_name": ["სახელი", "first name", "given name", "given names"],
    "last_name": ["გვარი", "last name", "surname", "family name"],
    "birth_date": ["დაბადების თარიღი", "date of birth", "birth date"],
    "birth_place": ["დაბადების ადგილი", "place of birth"],
    "citizenship": ["მოქალაქეობა", "citizenship", "nationality", "მოქალ."],
    "gender": ["სქესი", "sex", "gender"],
    "personal_id": [
        "პირადი ნომერი", "პირადი no", "პირადი №", "პირადი #", "პირადი ნომ",
        "personal no", "personal №", "personal number", "personal n",
        "პ/ნ", "პ.ნ",
    ],
    "expiry_date": ["მოქმედების ვადა", "date of expiry", "expiry", "valid until"],
    "issue_date": [
        "გაცემის თარიღი", "გაცემის თარ", "date of issue", "date ofissue", "issue date",
    ],
    "card_number": [
        "ბარათის ნომერი", "ბარათის №", "ბარათის #", "card no", "card number",
        "document no", "doc no", "ბარათის ნომ",
    ],
}

_IGNORE_VALUE = re.compile(
    r"^(სახელი|გვარი|სქესი|მოქალაქეობა|პირადი|დაბადების|მოქმედების|ბარათის|"
    r"first|last|name|sex|citizenship|nationality|personal|date|birth|"
    r"place|expiry|valid|card|identity|georgia|საქართველო|"
    r"signature|authority|issue|document).*$",
    re.IGNORECASE,
)

_GEO_RE = re.compile(r"[\u10D0-\u10FF]")
_LATIN_ONLY = re.compile(r"^[A-Za-z\s\-']+$")
_BACK_SKIP = re.compile(
    r"საქართველო|georgia|identity|card|პირადობ|მოწმობ|signature|authority|"
    r"მინისტრ|ministry|justice|მოქალაქ|citizenship|idge|personal|პირადი",
    re.IGNORECASE,
)

# Georgian personal numbers usually start with 0 or 1
_CARD_STRICT = re.compile(r"(?<![A-Z0-9])(\d{2}[A-Z]{2}\d{5})(?![A-Z0-9])")


def _get_vision_client() -> vision.ImageAnnotatorClient:
    global _vision_client
    if _vision_client is None:
        # Local: JSON key file. Cloud Run: Application Default Credentials (runtime SA).
        creds_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", str(_CREDENTIALS_PATH))
        client_opts = {"api_endpoint": "eu-vision.googleapis.com"}
        if creds_path and Path(creds_path).is_file():
            credentials = service_account.Credentials.from_service_account_file(creds_path)
            _vision_client = vision.ImageAnnotatorClient(
                credentials=credentials,
                client_options=client_opts,
            )
        else:
            _vision_client = vision.ImageAnnotatorClient(client_options=client_opts)
    return _vision_client


def _word_bbox(word) -> tuple[float, float, float, float]:
    """Return (min_x, min_y, max_x, max_y, center_x, center_y) approx as 4-tuple + centers via dict."""
    xs = [v.x for v in word.bounding_box.vertices]
    ys = [v.y for v in word.bounding_box.vertices]
    return min(xs), min(ys), max(xs), max(ys)


def _iter_words(annotation):
    for page in annotation.pages:
        page_w = getattr(page, "width", 0) or 0
        page_h = getattr(page, "height", 0) or 0
        for block in page.blocks:
            for paragraph in block.paragraphs:
                for word in paragraph.words:
                    yield word, page_w, page_h


def _text_rotation(annotation) -> int:
    """
    Counter-clockwise rotation (0/90/180/270) that would make the photographed
    text upright.

    Vision lists bounding-box vertices in reading order, so the first → second
    vertex points along the baseline. A sideways or upside-down capture shows up
    as a baseline pointing down / left instead of right. Wider words weigh more,
    so stray noise cannot outvote real field text.
    """
    votes = {0: 0.0, 90: 0.0, 180: 0.0, 270: 0.0}
    for word, _w, _h in _iter_words(annotation):
        v = word.bounding_box.vertices
        if len(v) < 2:
            continue
        dx = v[1].x - v[0].x
        dy = v[1].y - v[0].y
        length = (dx * dx + dy * dy) ** 0.5
        if length < 1:
            continue
        if abs(dx) >= abs(dy):
            votes[0 if dx > 0 else 180] += length
        else:
            votes[90 if dy > 0 else 270] += length

    total = sum(votes.values())
    if total <= 0:
        return 0
    best = max(votes, key=lambda k: votes[k])
    # Mixed evidence means the photo is probably fine — never rotate on a guess
    return best if votes[best] / total >= 0.6 else 0


def _rotate_point(x: float, y: float, w: float, h: float, rotation: int) -> tuple[float, float]:
    """Map a point into the frame the image would have after rotating it CCW."""
    if rotation == 90:
        return y, max(0.0, w - x)
    if rotation == 180:
        return max(0.0, w - x), max(0.0, h - y)
    if rotation == 270:
        return max(0.0, h - y), x
    return x, y


def ocr_image_ex(image_bytes: bytes) -> tuple[str, list[str], list[dict], int]:
    """OCR image → full_text, lines, words, rotation needed to upright the photo."""
    client = _get_vision_client()
    image = vision.Image(content=image_bytes)
    response = client.document_text_detection(image=image)

    if response.error.message:
        raise RuntimeError(f"Vision API error: {response.error.message}")

    annotation = response.full_text_annotation
    if not annotation or not annotation.text:
        return "", [], [], 0

    full_text = annotation.text.strip()
    lines = [ln.strip() for ln in full_text.splitlines() if ln.strip()]
    rotation = _text_rotation(annotation)

    words: list[dict] = []
    for word, page_w, page_h in _iter_words(annotation):
        text = "".join(s.text for s in word.symbols if getattr(s, "text", None)).strip()
        if not text:
            continue
        x1, y1, x2, y2 = _word_bbox(word)
        if rotation:
            # Field geometry (rightmost column, value under label) is only
            # meaningful in an upright frame, so move the boxes there.
            ax, ay = _rotate_point(x1, y1, page_w, page_h, rotation)
            bx, by = _rotate_point(x2, y2, page_w, page_h, rotation)
            x1, x2 = min(ax, bx), max(ax, bx)
            y1, y2 = min(ay, by), max(ay, by)
        words.append({
            "text": text,
            "x1": x1,
            "y1": y1,
            "x2": x2,
            "y2": y2,
            "cx": (x1 + x2) / 2,
            "cy": (y1 + y2) / 2,
        })
    return full_text, lines, words, rotation


def ocr_image(image_bytes: bytes) -> tuple[str, list[str], list[dict]]:
    """OCR image → full_text, lines, words[{text,x,y,x1,y1,x2,y2}]."""
    full_text, lines, words, _rotation = ocr_image_ex(image_bytes)
    return full_text, lines, words


def _personal_id_from_layout(words: list[dict]) -> str:
    """
    On Georgian ID front, პირადი № / PERSONAL № is the rightmost column;
    the 11-digit value sits under that label.
    """
    if not words:
        return ""

    label_re = re.compile(r"პირადი|personal", re.IGNORECASE)
    label_words = [w for w in words if label_re.search(w["text"])]
    # Also catch "No" / "№" next to პირადი — use the პირადი/PERSONAL word itself
    digit_words = []
    for w in words:
        digits = re.sub(r"\D", "", w["text"])
        soft = _ocr_token_as_digits(w["text"])
        cand = digits if len(digits) >= 9 else soft
        if len(cand) >= 9:
            digit_words.append({**w, "digits": cand})

    # Merge adjacent digit fragments on same row into 11-digit candidates
    digit_words.sort(key=lambda w: (w["cy"], w["cx"]))
    merged: list[dict] = []
    for w in digit_words:
        if merged:
            prev = merged[-1]
            same_row = abs(prev["cy"] - w["cy"]) < max(12, (prev["y2"] - prev["y1"]) * 0.6)
            close = w["x1"] - prev["x2"] < 40
            if same_row and close and len(prev["digits"]) < 11:
                prev["digits"] = prev["digits"] + w["digits"]
                prev["x2"] = w["x2"]
                prev["cx"] = (prev["x1"] + prev["x2"]) / 2
                continue
        merged.append(dict(w))

    candidates = []
    for w in merged:
        d = w["digits"]
        if len(d) >= 11:
            # Prefer contiguous 11 starting with 0/1
            for i in range(len(d) - 10):
                chunk = d[i : i + 11]
                if chunk[0] in "01":
                    candidates.append({**w, "pid": chunk})
                    break
            else:
                candidates.append({**w, "pid": d[:11]})
        elif len(d) == 11:
            candidates.append({**w, "pid": d})

    if not candidates:
        return ""

    # 1) Prefer digit block under/near PERSONAL / პირადი label (same column, below)
    if label_words:
        # Rightmost personal label (the field is on the far right)
        label = max(label_words, key=lambda w: w["cx"])
        best = None
        best_score = -1e18
        for c in candidates:
            # Below label, similar x (right column)
            dy = c["cy"] - label["cy"]
            dx = abs(c["cx"] - label["cx"])
            if dy < -20:
                continue  # above label — unlikely
            score = -dx * 2 - abs(dy) * 0.3 + c["cx"] * 0.01
            if score > best_score:
                best_score = score
                best = c
        if best:
            return best["pid"]

    # 2) Fallback: rightmost 11-digit number on the card
    rightmost = max(candidates, key=lambda c: c["cx"])
    return rightmost["pid"]


def _ocr_token_as_digits(token: str) -> str:
    """Map OCR confusions to digits on a short number-like token only."""
    table = str.maketrans({
        "O": "0", "o": "0", "Q": "0", "D": "0",
        "I": "1", "l": "1", "L": "1", "|": "1",
        "Z": "2", "z": "2",
        "S": "5", "s": "5",
        "B": "8", "G": "6", "g": "6",
    })
    return "".join(ch for ch in token.translate(table) if ch.isdigit())


def _strip_td1_doc_prefix(s: str) -> str:
    """Remove Georgian TD1 doc-type+issuer prefix (IDGEO / TRGEO / soft OCR)."""
    s = (s or "").upper()
    for pref in ("IDGEO", "TRGEO", "IDGE", "TRGE"):
        if s.startswith(pref):
            return s[len(pref) :]
    return s


def _find_td1_line1(cleaned: str) -> tuple[int, str]:
    """
    Locate Georgian-issued TD1 MRZ line-1 prefix.
      IDGEO — citizen identity card
      TRGEO — residence / foreigner ID (same layout as IDGEO)
    Returns (start_index, canonical_prefix) or (-1, "").
    """
    s = cleaned or ""
    s = (
        s.replace("I0GEO", "IDGEO")
        .replace("1DGEO", "IDGEO")
        .replace("ID6EO", "IDGEO")
        .replace("IDGE0", "IDGEO")
        .replace("TRGE0", "TRGEO")
        .replace("T0GEO", "TRGEO")
        .replace("1RGEO", "TRGEO")
    )
    for pref in ("IDGEO", "TRGEO"):
        i = s.find(pref)
        if i >= 0:
            return i, pref
    for soft, full in (("IDGE", "IDGEO"), ("TRGE", "TRGEO")):
        i = s.find(soft)
        if i < 0:
            continue
        fifth = s[i + 4 : i + 5] if i + 4 < len(s) else ""
        if fifth in ("O", "0"):
            return i, full
        if fifth and (fifth.isdigit() or fifth.isalpha()):
            # Missing issuer O: IDGE20… / TRGE25…
            return i, soft
    return -1, ""


def _fix_georgian_card_number(raw: str) -> str:
    """
    Georgian ID card number format (always 9 chars):
      positions 1-2: digits
      positions 3-4: letters
      positions 5-9: digits
    Example: 20IF22661
    """
    s = re.sub(r"[^A-Za-z0-9]", "", (raw or "")).upper()
    s = _strip_td1_doc_prefix(s)
    if len(s) < 9:
        return s[:9] if s else ""

    s = s[:9]
    digit_from_letter = {
        "O": "0", "Q": "0", "D": "0", "I": "1", "L": "1",
        "Z": "2", "S": "5", "B": "8", "G": "6",
    }
    letter_from_digit = {"0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G"}

    out = []
    for idx, ch in enumerate(s):
        if idx in (2, 3):
            out.append(letter_from_digit.get(ch, ch) if ch.isdigit() else ch)
        else:
            out.append(digit_from_letter.get(ch, ch) if ch.isalpha() else ch)
    return "".join(out)


def _normalize_card_number(raw: str) -> str:
    """Georgian ID card no: 2 digits + 2 letters + 5 digits (e.g. 00IB12345)."""
    s = re.sub(r"[^A-Za-z0-9]", "", raw).upper()
    s = _strip_td1_doc_prefix(s)

    # Take best 9-char window that looks like card number
    for i in range(max(0, len(s) - 8)):
        window = s[i : i + 9]
        if len(window) < 9:
            continue
        cand = _fix_georgian_card_number(window)
        if re.fullmatch(r"\d{2}[A-Z]{2}\d{5}", cand):
            return cand

    fixed = _fix_georgian_card_number(s)
    if re.fullmatch(r"\d{2}[A-Z]{2}\d{5}", fixed):
        return fixed
    return fixed[:9] if fixed else ""


def _find_card_numbers(text: str) -> list[str]:
    found = []
    compact = re.sub(r"[\s\-_/]", "", text.upper())

    for m in _CARD_STRICT.finditer(compact):
        found.append(_fix_georgian_card_number(m.group(1)))

    # Soft OCR: digits/letters confused
    for m in re.finditer(
        r"(?<![A-Z0-9])([0-9OILZSBG]{2}[A-Z]{2}[0-9OILZSBG]{5})(?![A-Z0-9])",
        compact,
    ):
        norm = _normalize_card_number(m.group(1))
        if re.fullmatch(r"\d{2}[A-Z]{2}\d{5}", norm) and norm not in found:
            found.append(norm)

    for m in re.finditer(r"(?:IDGEO|TRGEO|IDGE|TRGE)([A-Z0-9]{9})", compact):
        norm = _normalize_card_number(m.group(1))
        if re.fullmatch(r"\d{2}[A-Z]{2}\d{5}", norm) and norm not in found:
            found.append(norm)

    return found


def _find_personal_ids(text: str) -> list[str]:
    """Find 11-digit personal numbers. Avoid converting whole document to digits."""
    found = []

    # Exact 11-digit runs
    for m in re.finditer(r"(?<!\d)(\d{11})(?!\d)", text):
        found.append(m.group(1))

    # Spaced / dotted groups totaling 11 digits
    for m in re.finditer(r"(?<!\d)(?:\d[\s.\-]*){10}\d(?!\d)", text):
        digits = re.sub(r"\D", "", m.group(0))
        if len(digits) == 11 and digits not in found:
            found.append(digits)

    # Number-like tokens only (e.g. O1OO1O12345) — not whole page
    for token in re.findall(r"[0-9OILZSBGOilzsbg|.\-]{11,16}", text):
        digits = _ocr_token_as_digits(token)
        if len(digits) == 11 and digits not in found:
            found.append(digits)
        elif len(digits) > 11:
            # take first 11 if token was mostly digits
            if digits[:11] not in found:
                found.append(digits[:11])

    return found


def _pick_personal_id(candidates: list[str]) -> str:
    if not candidates:
        return ""
    # Prefer IDs starting with 0 or 1 (typical GEO), then others
    preferred = [c for c in candidates if c[0] in "01"]
    return (preferred or candidates)[0]


def _georgian_only(value: str) -> str:
    if not value:
        return ""
    if "/" in value:
        parts = [p.strip() for p in value.split("/")]
        geo_parts = [p for p in parts if _GEO_RE.search(p)]
        if geo_parts:
            value = geo_parts[0]
    matches = re.findall(r"[\u10D0-\u10FF]+(?:[\s\-'][\u10D0-\u10FF]+)*", value)
    if matches:
        return max(matches, key=len).strip()
    return ""


def _normalize_mrz_line(line: str) -> str:
    line = line.upper().replace(" ", "")
    # Common OCR noise in MRZ
    line = (
        line.replace("«", "<")
        .replace("‹", "<")
        .replace(">", "<")
        .replace(".", "")
        .replace(",", "")
        .replace("-", "")
        .replace("_", "")
        .replace("/", "")
    )
    return line


def _mrz_card_from_raw(raw9: str) -> str:
    """MRZ document number: DD + LL + DDDDD with position-aware OCR fixes."""
    return _fix_georgian_card_number(raw9)


def _mrz_personal_from_raw(raw: str) -> str:
    """Personal number in MRZ is exactly 11 digits."""
    digits = _ocr_token_as_digits(raw)
    if len(digits) >= 11:
        return digits[:11]
    return digits


def parse_mrz_document_line(line: str) -> dict:
    """
    Georgian-issued TD1 MRZ line 1 (citizen IDGEO or foreigner TRGEO):
      XXGEO + [9 alnum doc] + [1 check SKIP] + [11 digit personal]
    """
    out = {}
    cleaned = _normalize_mrz_line(line)
    start, pref = _find_td1_line1(cleaned)
    if start < 0:
        return out

    # Align cleaned with OCR fixes used by finder
    cleaned = (
        cleaned.replace("I0GEO", "IDGEO")
        .replace("1DGEO", "IDGEO")
        .replace("ID6EO", "IDGEO")
        .replace("IDGE0", "IDGEO")
        .replace("TRGE0", "TRGEO")
        .replace("T0GEO", "TRGEO")
        .replace("1RGEO", "TRGEO")
    )
    # Re-find after normalize (indices stay valid for equal-length fixes)
    start, pref = _find_td1_line1(cleaned)
    if start < 0:
        return out

    skip = len(pref)
    # Soft 4-char prefix: promote to 5-char canonical when 5th is O/0 already consumed
    if pref in ("IDGE", "TRGE"):
        fifth = cleaned[start + 4 : start + 5]
        if fifth in ("O", "0"):
            skip = 5
            pref = "IDGEO" if pref.startswith("ID") else "TRGEO"

    rest = cleaned[start + skip :].replace("<", "")
    if len(rest) < 20:
        return out

    out["card_number"] = _mrz_card_from_raw(rest[:9])
    after_skip = rest[10:]  # skip 10th char (check digit)
    if len(after_skip) < 11:
        return out

    pid = _mrz_personal_from_raw(after_skip[:11])
    if len(pid) == 11:
        out["personal_id"] = pid
    else:
        pid = _mrz_personal_from_raw(after_skip)
        if len(pid) >= 11:
            out["personal_id"] = pid[:11]

    return out


def extract_mrz_ids(text: str) -> dict:
    """Find MRZ line-1 in back-side OCR only and apply the formula."""
    if not text:
        return {}

    # 1) Whole blob (newlines removed) — best when Vision splits the line
    blob = _normalize_mrz_line(text.replace("\n", " "))
    doc = parse_mrz_document_line(blob)
    if doc.get("card_number") and doc.get("personal_id"):
        return doc

    # 2) Each line separately
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    for line in lines:
        doc = parse_mrz_document_line(line)
        if doc.get("card_number") and doc.get("personal_id"):
            return doc

    # 3) Join only MRZ-looking fragments (never mix with front-side text)
    mrz_bits = []
    for l in lines:
        c = _normalize_mrz_line(l)
        if (
            "IDGE" in c
            or "TRGE" in c
            or (c.count("<") >= 2 and re.search(r"\d{6}", c))
        ):
            mrz_bits.append(c)
    if mrz_bits:
        joined = "".join(mrz_bits)
        doc = parse_mrz_document_line(joined)
        if doc.get("card_number") and doc.get("personal_id"):
            return doc

    return {}


def _fix_mrz_line(s: str, length: int = 30) -> str:
    s = re.sub(r"[^A-Z0-9<]", "", (s or "").upper())
    if len(s) > length:
        return s[:length]
    return s + ("<" * (length - len(s)))


def extract_mrz_strip(text: str) -> str:
    """
    Return the full 3-line TD1 MRZ (30 chars each) from back-side OCR.
    Examples:
      IDGEO22IB34231204501015786<<<<
      TRGE025RT25836101991053297<<<<
    """
    if not text:
        return ""

    blob = _normalize_mrz_line(text.replace("\n", " "))
    blob = (
        blob.replace("I0GEO", "IDGEO")
        .replace("1DGEO", "IDGEO")
        .replace("IDGE0", "IDGEO")
        .replace("ID6EO", "IDGEO")
        .replace("TRGE0", "TRGEO")
        .replace("T0GEO", "TRGEO")
        .replace("1RGEO", "TRGEO")
        .replace("I0GE", "IDGE")
        .replace("1DGE", "IDGE")
    )

    lines = [_normalize_mrz_line(l) for l in text.splitlines() if l.strip()]
    lines = [
        l.replace("IDGE0", "IDGEO")
        .replace("I0GEO", "IDGEO")
        .replace("1DGEO", "IDGEO")
        .replace("TRGE0", "TRGEO")
        .replace("T0GEO", "TRGEO")
        for l in lines
    ]

    line1 = ""
    line2 = ""
    line3 = ""

    # --- Line 1: IDGEO/TRGEO + document + personal ---
    for l in lines:
        start, pref = _find_td1_line1(l)
        if start < 0:
            continue
        chunk = l[start:].replace(" ", "")
        if chunk.startswith("IDGE") and not chunk.startswith("IDGEO"):
            fifth = chunk[4:5]
            chunk = ("IDGEO" + chunk[5:]) if fifth in ("O", "0") else ("IDGEO" + chunk[4:])
        elif chunk.startswith("TRGE") and not chunk.startswith("TRGEO"):
            fifth = chunk[4:5]
            chunk = ("TRGEO" + chunk[5:]) if fifth in ("O", "0") else ("TRGEO" + chunk[4:])
        line1 = _fix_mrz_line(chunk, 30)
        break

    if not line1:
        start, pref = _find_td1_line1(blob)
        if start >= 0:
            chunk = blob[start:]
            if pref == "IDGE" or (chunk.startswith("IDGE") and not chunk.startswith("IDGEO")):
                chunk = "IDGEO" + chunk[len(pref) if pref else 4 :]
            elif pref == "TRGE" or (chunk.startswith("TRGE") and not chunk.startswith("TRGEO")):
                chunk = "TRGEO" + chunk[len(pref) if pref else 4 :]
            line1 = _fix_mrz_line(chunk, 30)

    # --- Line 2: birth + sex + expiry + nationality (GEO, BLR, …) ---
    line2_re = re.compile(
        r"(\d{6})(\d)([MF<])(\d{6})(\d)([A-Z]{3})([A-Z0-9<]{0,12})"
    )
    for src in lines + [blob]:
        m = line2_re.search(src)
        if m:
            nat = m.group(6).replace("0", "O")
            if nat == "GFO":
                nat = "GEO"
            fillers = re.sub(r"[^A-Z0-9<]", "", m.group(7))
            body = f"{m.group(1)}{m.group(2)}{m.group(3)}{m.group(4)}{m.group(5)}{nat}{fillers}"
            line2 = _fix_mrz_line(body, 30)
            break

    if not line2:
        m = re.search(r"(\d{6}\d?[MF<]\d{6}\d?[A-Z]{3}[A-Z0-9<]*)", blob)
        if m:
            body = m.group(1).replace("GE0", "GEO")
            line2 = _fix_mrz_line(body, 30)

    # --- Line 3: SURNAME<<GIVEN ---
    for l in lines:
        if "<<" not in l:
            continue
        if "IDGE" in l or "TRGE" in l or re.search(r"\d{6}[MF<]", l):
            continue
        name = re.sub(r"[^A-Z<]", "", l.upper())
        name = re.sub(r"^[IT]R?GE[OA]?", "", name)
        name = re.sub(r"^I?D?GE[OA]?", "", name)
        if re.search(r"[A-Z]{2,}<<[A-Z]{2,}", name):
            line3 = _fix_mrz_line(name, 30)
            break

    if not line3:
        m = re.search(r"([A-Z]{2,}<<[A-Z]{2,}[<A-Z]*)", blob)
        if m:
            line3 = _fix_mrz_line(m.group(1), 30)

    parts = [p for p in (line1, line2, line3) if p]
    if not parts:
        return ""
    return "\n".join(parts)


def parse_mrz(lines: list[str]) -> dict:
    """Parse full MRZ: line1 IDs (formula), line2 dates/sex, line3 Latin names."""
    mrz = {}
    blob = "\n".join(lines)

    # IDs — formula first (source of truth for all GEO IDs)
    ids = extract_mrz_ids(blob)
    if ids.get("card_number"):
        mrz["card_number"] = ids["card_number"]
    if ids.get("personal_id"):
        mrz["personal_id"] = ids["personal_id"]

    # Prefer structured strip when available
    strip = extract_mrz_strip(blob)
    strip_lines = strip.splitlines() if strip else []

    candidates = []
    for raw in list(lines) + strip_lines:
        cleaned = _normalize_mrz_line(raw)
        cleaned = (
            cleaned.replace("IDGE0", "IDGEO")
            .replace("I0GEO", "IDGEO")
            .replace("TRGE0", "TRGEO")
        )
        if (
            "IDGE" in cleaned
            or "TRGE" in cleaned
            or cleaned.count("<") >= 2
            or re.search(r"\d{6}[MF<\d]\d{6}", cleaned)
        ):
            candidates.append(cleaned)

    for line in candidates:
        # Line 2: YYMMDD + check + sex + YYMMDD + check + nationality
        date_sex = re.search(r"(\d{6})(\d)?([MF<])(\d{6})(\d)?([A-Z0-9]{3})?", line)
        if date_sex and not mrz.get("birth_date"):
            b_raw, _c1, sex, e_raw, _c2, nat = date_sex.groups()
            by = "19" + b_raw[:2] if int(b_raw[:2]) > 30 else "20" + b_raw[:2]
            mrz["birth_date"] = f"{b_raw[4:6]}.{b_raw[2:4]}.{by}"
            ey = "20" + e_raw[:2]
            mrz["expiry_date"] = f"{e_raw[4:6]}.{e_raw[2:4]}.{ey}"
            if sex == "M":
                mrz["gender"] = "მმ / M"
            elif sex == "F":
                mrz["gender"] = "მდ / F"
            if nat:
                code = nat.replace("0", "O")
                if code == "GFO":
                    code = "GEO"
                # Nationality (not issuing state) — BLR, GEO, UKR, …
                if re.fullmatch(r"[A-Z]{3}", code):
                    mrz["citizenship_code"] = code

        if "<<" in line and not mrz.get("_mrz_last_name"):
            if re.search(r"\d{6}", line) or "IDGE" in line or "TRGE" in line:
                continue
            name_part = re.sub(r"^[IT]R?GE[OA]?", "", line)
            name_part = re.sub(r"^I?D?GE[OA]?", "", name_part)
            name_part = re.sub(r"[0-9]", "", name_part)
            parts = name_part.split("<<")
            if len(parts) >= 2 and re.search(r"[A-Z]{2,}", parts[0]):
                last = parts[0].replace("<", " ").strip()
                first = parts[1].replace("<", " ").strip()
                if last and not re.search(r"\d", last):
                    mrz["_mrz_last_name"] = last.upper()
                if first and not re.search(r"\d", first):
                    mrz["_mrz_first_name"] = first.upper()

    # Do NOT infer GEO from "TRGEO"/"IDGEO" issuing-state prefix — nationality is line 2
    return mrz


def _title_latin(value: str) -> str:
    """Title-case Latin words: DAVIT → Davit, AMBROLAURI → Ambrolauri."""
    if not value:
        return ""
    parts = re.split(r"(\s+|-)", value.strip())
    out = []
    for p in parts:
        if not p or p.isspace() or p == "-":
            out.append(p)
        else:
            out.append(p[:1].upper() + p[1:].lower())
    return "".join(out)


# Official Georgian passport / ID Latin transliteration (national system)
_KA_TO_LAT = {
    "ა": "a", "ბ": "b", "გ": "g", "დ": "d", "ე": "e", "ვ": "v", "ზ": "z",
    "თ": "t", "ი": "i", "კ": "k", "ლ": "l", "მ": "m", "ნ": "n", "ო": "o",
    "პ": "p", "ჟ": "zh", "რ": "r", "ს": "s", "ტ": "t", "უ": "u", "ფ": "ph",
    "ქ": "k", "ღ": "gh", "ყ": "q", "შ": "sh", "ჩ": "ch", "ც": "ts", "ძ": "dz",
    "წ": "ts", "ჭ": "tch", "ხ": "kh", "ჯ": "j", "ჰ": "h",
}


def transliterate_ka(geo: str) -> str:
    """Convert Georgian text to Latin (national system), then Title Case."""
    if not geo:
        return ""
    buf = []
    for ch in geo:
        if ch in _KA_TO_LAT:
            buf.append(_KA_TO_LAT[ch])
        elif ch.lower() in _KA_TO_LAT:
            buf.append(_KA_TO_LAT[ch.lower()])
        elif ch in " -'":
            buf.append(ch)
        # skip other chars
    return _title_latin("".join(buf))


def _latin_norm(value: str) -> str:
    return re.sub(r"[^A-Z]", "", (value or "").upper())


# Reverse transliteration: Latin form → Georgian letters producing it
_GEO_LETTERS_BY_LATIN: dict[str, tuple[str, ...]] = {}
for _ka, _lat in _KA_TO_LAT.items():
    _GEO_LETTERS_BY_LATIN[_lat] = _GEO_LETTERS_BY_LATIN.get(_lat, ()) + (_ka,)


def _norm_cmp(value: str) -> str:
    return re.sub(r"[\s./\-]", "", (value or "").upper())


def _gender_letter(value: str) -> str:
    v = (value or "").upper()
    raw = value or ""
    if "მდ" in raw or "F" in v or "FEMALE" in v or "მდედრ" in raw:
        return "F"
    if "მმ" in raw or "M" in v or "MALE" in v or "მამრ" in raw:
        return "M"
    return ""


def _latin_from_bilingual(value: str) -> str:
    if not value:
        return ""
    if "/" in value:
        parts = [p.strip() for p in value.split("/")]
        for p in reversed(parts):
            if _LATIN_ONLY.match(p.replace(" ", "")) or re.fullmatch(r"[A-Za-z\s\-']+", p):
                return p.upper()
    if _LATIN_ONLY.match(value.replace(" ", "")):
        return value.upper()
    return ""


def _format_bilingual(geo: str, latin: str = "") -> str:
    """Format as 'ქართული / English'. Prefer provided Latin, else transliterate."""
    geo = (geo or "").strip()
    if geo and "/" in geo:
        # Already bilingual — normalize sides
        parts = [p.strip() for p in geo.split("/", 1)]
        geo_side = _georgian_only(parts[0]) or parts[0]
        lat_side = parts[1] if len(parts) > 1 else ""
        if not _LATIN_ONLY.match(lat_side.replace(" ", "")):
            lat_side = latin or transliterate_ka(geo_side)
        geo, latin = geo_side, lat_side

    geo = _georgian_only(geo) or geo
    latin = (latin or "").strip()
    if not latin and geo and _GEO_RE.search(geo):
        latin = transliterate_ka(geo)
    elif latin:
        # If latin looks like MRZ ALLCAPS, title-case it
        latin = _title_latin(latin)

    if geo and latin:
        return f"{geo} / {latin}"
    return geo or latin


_NON_PLACE_LATIN = re.compile(
    r"ministry|justice|authority|issu|georgia|georgian|identity|card|signature|"
    r"place\s*of\s*birth|date|expiry|personal|sex|citizenship|nationality|"
    r"surname|name|passport|type|document",
    re.IGNORECASE,
)

# «PLACE OF BIRTH» is often damaged by OCR (PACE OF BIRTH / PLACE OFBIRTH).
# Used only to locate the label — values are still validated separately.
_PLACE_LABEL_RE = re.compile(
    r"დაბადებ\w*\s*ადგილ|ადგილ\w*\s*დაბადებ|"
    r"p[l1i]?[a-z]{0,2}ce\s*[o0]?f?\s*b[il1]?rth|"
    r"b[il1]?rth\s*p[l1i]?[a-z]{0,2}ce",
    re.IGNORECASE,
)

# A bare label / nationality word can never be a Latin place value
_LATIN_LABEL_WORD = re.compile(
    r"^(?:the|of|and|for|type|doc|document|birth|date|sex|name|surname|"
    r"georgia|georgian|citizenship|nationality|passport|"
    r"p[l1i]?[a-z]{0,2}ce)$",
    re.IGNORECASE,
)


def _latin_place_candidate(text: str) -> str:
    """Latin place value from a plain or bilingual «ქართული / LATIN» line."""
    t = (text or "").strip()
    if not t or _NON_PLACE_LATIN.search(t):
        return ""
    if "/" in t:
        right = t.split("/", 1)[1].strip()
        if right and _LATIN_ONLY.match(right.replace(" ", "")) and len(right) >= 3:
            return _title_latin(right)
        return ""
    if _LATIN_ONLY.match(t) and len(t) >= 3:
        return _title_latin(t)
    return ""


def _clean_place_latin(place_geo: str, place_lat: str) -> str:
    """Replace a leaked label word («The», «Pace», «Type») with the official Latin."""
    if place_geo and place_geo in _OFFICIAL_LATIN_BY_GEO:
        return _OFFICIAL_LATIN_BY_GEO[place_geo]
    lat = (place_lat or "").strip()
    if not lat:
        return _place_latin_for_geo(place_geo)
    compact = re.sub(r"[\s\-']+", "", lat)
    if _LATIN_LABEL_WORD.match(compact):
        return _place_latin_for_geo(place_geo)
    return lat


def _birth_place_latin_from_back(back_lines: list[str], geo_place: str) -> str:
    """Find Latin place name under Georgian place of birth."""
    # Official Latin spelling wins when the Georgian value is a known city
    if geo_place:
        expected = _latin_norm(transliterate_ka(geo_place))
        if expected in _KNOWN_PLACE_BY_LATIN or geo_place in _OFFICIAL_LATIN_BY_GEO:
            return _place_latin_for_geo(geo_place)

    for i, line in enumerate(back_lines):
        if _PLACE_LABEL_RE.search(line):
            # Same line may already carry the value: «... PLACE OF BIRTH თბილისი / TBILISI»
            for j in range(i, min(i + 6, len(back_lines))):
                nxt = back_lines[j].strip()
                if not nxt or (j > i and _is_label_only(nxt)):
                    continue
                if re.search(r"გაცემის|date\s*of\s*issue|authority|ორგანო", nxt, re.I):
                    break
                cand = _latin_place_candidate(nxt)
                if cand:
                    return cand
        geo = _georgian_only(line)
        if geo_place and geo and geo == geo_place:
            cand = _latin_place_candidate(line)
            if cand:
                return cand
            for j in range(i + 1, min(i + 3, len(back_lines))):
                cand = _latin_place_candidate(back_lines[j])
                if cand:
                    return cand
    return ""


_KA_LETTERS = tuple(_KA_TO_LAT.keys())

# Common birth places — Latin (national system) → correct Georgian spelling
_KNOWN_PLACE_BY_LATIN: dict[str, str] = {}
for _place in (
    "თბილისი", "ბათუმი", "ქუთაისი", "რუსთავი", "ზუგდიდი", "გორი", "ფოთი",
    "თელავი", "ახალციხე", "ამბროლაური", "ოზურგეთი", "სენაკი", "ზესტაფონი",
    "მარნეული", "გარდაბანი", "საგარეჯო", "ბოლნისი", "კასპი", "ცხინვალი",
    "სოხუმი", "გაგრა", "ოჩამჩირე", "გალი", "გუდაუთა", "მცხეთა", "დუშეთი",
    "ბორჯომი", "ახალქალაქი", "ნინოწმინდა", "ლანჩხუთი", "ჭიათურა", "ტყიბული",
    "საჩხერე", "ხაშური", "ქარელი", "ხონი", "ხობი", "წყალტუბო", "ვანი", "სამტრედია",
    "აბაშა", "მარტვილი", "ჩხოროწყუ", "წალენჯიხა", "მესტია", "ონი", "ცაგერი",
    "ლენტეხი", "ყვარელი", "ლაგოდეხი", "დედოფლისწყარო", "სიღნაღი", "გურჯაანი",
    "თეთრიწყარო", "წალკა", "დმანისი", "ქედა", "შუახევი", "ხულო", "ჩოხატაური",
    "ქობულეთი", "ხელვაჩაური", "ასპინძა", "ადიგენი", "ახალქალაქი",
    # Countries (foreign birth place on Georgian IDs)
    "ბელარუსი", "უკრაინა", "რუსეთი", "თურქეთი", "სომხეთი", "აზერბაიჯანი",
    "ყაზახეთი", "ისრაელი", "გერმანია", "ამერიკის შეერთებული შტატები",
):
    _KNOWN_PLACE_BY_LATIN[_latin_norm(transliterate_ka(_place))] = _place

# English / alternate Latin spellings on the card (not national transliteration)
_OFFICIAL_LATIN_BY_GEO: dict[str, str] = {}
for _lat, _geo in (
    ("ZESTAPHONI", "ზესტაფონი"),
    ("BELARUS", "ბელარუსი"),
    ("BELARUSSIA", "ბელარუსი"),
    ("UKRAINE", "უკრაინა"),
    ("RUSSIA", "რუსეთი"),
    ("TURKEY", "თურქეთი"),
    ("TURKIYE", "თურქეთი"),
    ("ARMENIA", "სომხეთი"),
    ("AZERBAIJAN", "აზერბაიჯანი"),
    ("KAZAKHSTAN", "ყაზახეთი"),
    ("ISRAEL", "ისრაელი"),
    ("GERMANY", "გერმანია"),
    ("USA", "ამერიკის შეერთებული შტატები"),
    ("UNITEDSTATES", "ამერიკის შეერთებული შტატები"),
    ("UNITEDSTATESOFAMERICA", "ამერიკის შეერთებული შტატები"),
):
    _KNOWN_PLACE_BY_LATIN[_latin_norm(_lat)] = _geo
    # Prefer the first listed Latin form as the official display spelling
    _OFFICIAL_LATIN_BY_GEO.setdefault(_geo, _title_latin(_lat))


def _place_latin_for_geo(place_geo: str) -> str:
    """Official Latin for a known city; otherwise national transliteration."""
    geo = (place_geo or "").strip()
    if not geo:
        return ""
    return _OFFICIAL_LATIN_BY_GEO.get(geo) or _title_latin(transliterate_ka(geo))

# Longest first, so «ახალქალაქი» is not shadowed by a shorter name
_KNOWN_PLACES_GEO = tuple(
    sorted(set(_KNOWN_PLACE_BY_LATIN.values()), key=len, reverse=True)
)


def _known_geo_place(text: str) -> str:
    """
    Official Georgian city standing as its own word in the text.

    The word check matters: «ონი» is a city, but it is also inside «რეგიონი»,
    and «ვანი» sits inside «ივანიშვილი».
    """
    if not text:
        return ""
    for place in _KNOWN_PLACES_GEO:
        pattern = (
            r"(?<![\u10D0-\u10FF])" + re.escape(place) + r"(?![\u10D0-\u10FF])"
        )
        if re.search(pattern, text):
            return place
    return ""


def _edit_distance(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a or not b:
        return max(len(a), len(b))
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _is_unambiguous_letter(ch: str) -> bool:
    """
    True when the Latin spelling of this letter can come from one Georgian letter
    only. Twins like თ/ტ, ქ/კ, ც/წ share a Latin form, so MRZ Latin
    cannot tell them apart — those are never guessed for *places*.
    """
    return len(_GEO_LETTERS_BY_LATIN.get(_KA_TO_LAT.get(ch, ""), ())) == 1


# Common given names: MRZ Latin → correct Georgian (OCR often swaps ბ/გ, ქ/მ, …)
_KNOWN_GIVEN_BY_LATIN = {
    "BEKA": "ბექა",
    "BEKAN": "ბექანი",
    "GIORGI": "გიორგი",
    "GIVI": "გივი",
    "GIA": "გია",
    "GELA": "გელა",
    "GOCHA": "გოჩა",
    "NINO": "ნინო",
    "NIKA": "ნიკა",
    "NIKOLOZ": "ნიკოლოზი",
    "DAVIT": "დავითი",
    "DAVID": "დავითი",
    "DATO": "დათო",
    "LEVAN": "ლევანი",
    "LUKA": "ლუკა",
    "LASHA": "ლაშა",
    "IRAKLI": "ირაკლი",
    "TAMAR": "თამარი",
    "ANA": "ანა",
    "ANUKI": "ანუკი",
    "MARIAM": "მარიამი",
    "SALOME": "სალომე",
    "SOPIO": "სოფიო",
    "SOPO": "სოფო",
    "KETEVAN": "ქეთევანი",
    "KETI": "ქეთი",
    "EKATERINE": "ეკატერინე",
    "ALEXANDRE": "ალექსანდრე",
    "ALEKSANDRE": "ალექსანდრე",
    "ZURAB": "ზურაბი",
    "VAZHA": "ვაჟა",
    "OTAR": "ოთარი",
    "SHOTA": "შოთა",
    "TEIMURAZ": "თეიმურაზი",
    "KAKHA": "კახა",
    "KAKHABER": "კახაბერი",
    "MERAB": "მერაბი",
    "MAMUKA": "მამუკა",
    "ZVIAD": "ზვიადი",
    "PAATA": "პაატა",
    "REVAZ": "რევაზი",
    "SANDRO": "სანდრო",
    "SABA": "საბა",
    "TORNIKE": "თორნიკე",
    "TSOTNE": "ცოტნე",
    "ELENE": "ელენე",
    "NATIA": "ნათია",
    "MAIA": "მაია",
    "MAKA": "მაკა",
    "OLEGI": "ოლეგი",
    "OLEG": "ოლეგი",
}


def _correct_geo_using_latin(geo: str, latin: str, *, max_edits: int = 1, allow_ambiguous: bool = False) -> str:
    """
    If Latin (MRZ) is correct but Georgian OCR has a few wrong letters,
    repair Georgian so its transliteration matches Latin exactly.

    max_edits=1 keeps place repairs conservative; names may use 2 + ambiguous.
    """
    geo = (_georgian_only(geo) or geo or "").strip()
    latin_n = _latin_norm(latin)
    if not geo or not latin_n:
        return geo

    geo_lat = _latin_norm(transliterate_ka(geo))
    if geo_lat == latin_n:
        return geo

    if _edit_distance(geo_lat, latin_n) > max(2, max_edits):
        return geo

    def letter_ok(ch: str) -> bool:
        return allow_ambiguous or _is_unambiguous_letter(ch)

    # BFS over Georgian letter edits; keep closest to OCR among exact Latin matches
    from collections import deque

    best: list[str] = []
    best_dist = 10**9
    seen = {geo}
    q: deque[tuple[str, int]] = deque([(geo, 0)])
    while q:
        cur, dist = q.popleft()
        if _latin_norm(transliterate_ka(cur)) == latin_n:
            d0 = _edit_distance(cur, geo)
            if d0 < best_dist:
                best_dist = d0
                best = [cur]
            elif d0 == best_dist:
                best.append(cur)
            continue
        if dist >= max_edits:
            continue

        for i, cur_ch in enumerate(cur):
            if cur_ch not in _KA_TO_LAT:
                continue
            for ch in _KA_LETTERS:
                if ch == cur_ch or not letter_ok(ch):
                    continue
                cand = cur[:i] + ch + cur[i + 1 :]
                if cand not in seen:
                    seen.add(cand)
                    q.append((cand, dist + 1))

        if len(cur) >= 2:
            for i in range(len(cur)):
                cand = cur[:i] + cur[i + 1 :]
                if cand and cand not in seen:
                    seen.add(cand)
                    q.append((cand, dist + 1))

        for i in range(len(cur) + 1):
            for ch in _KA_LETTERS:
                if not letter_ok(ch):
                    continue
                cand = cur[:i] + ch + cur[i:]
                if cand not in seen:
                    seen.add(cand)
                    q.append((cand, dist + 1))

    if not best:
        return geo
    # Prefer the OCR-closest form; stable unique
    return sorted(set(best), key=lambda s: (_edit_distance(s, geo), s))[0]


def _latin_to_geo_approx(latin: str) -> str:
    """
    Best-effort reverse of national transliteration (MRZ Latin → Georgian).
    Digraphs first. Ambiguous letters use the more common personal-name form
    (თ/კ/პ/ჩ/ც). Used only when OCR Georgian is missing.
    """
    s = _latin_norm(latin)
    if not s:
        return ""
    # Longest digraphs first
    mapping = (
        ("ZH", "ჟ"),
        ("GH", "ღ"),
        ("SH", "შ"),
        ("CH", "ჩ"),
        ("TS", "ც"),
        ("DZ", "ძ"),
        ("KH", "ხ"),
        ("PH", "ფ"),
        ("TCH", "ჭ"),
        ("A", "ა"),
        ("B", "ბ"),
        ("G", "გ"),
        ("D", "დ"),
        ("E", "ე"),
        ("V", "ვ"),
        ("Z", "ზ"),
        ("T", "თ"),
        ("I", "ი"),
        ("K", "კ"),
        ("L", "ლ"),
        ("M", "მ"),
        ("N", "ნ"),
        ("O", "ო"),
        ("P", "პ"),
        ("R", "რ"),
        ("S", "ს"),
        ("U", "უ"),
        ("Q", "ყ"),
        ("J", "ჯ"),
        ("H", "ჰ"),
        ("F", "ფ"),
        ("W", "ვ"),
        ("Y", "ი"),
        ("X", "ქ"),
    )
    out: list[str] = []
    i = 0
    while i < len(s):
        matched = False
        for lat, geo in mapping:
            if s.startswith(lat, i):
                out.append(geo)
                i += len(lat)
                matched = True
                break
        if not matched:
            i += 1
    geo = "".join(out)
    # Round-trip check: only accept if we recover the same Latin
    if geo and _latin_norm(transliterate_ka(geo)) == s:
        return geo
    return geo  # still return best effort — better than empty for long surnames


def _is_name_junk(value: str) -> bool:
    """Reject OCR labels / nationality leaked into name fields."""
    raw = (value or "").strip()
    if not raw:
        return True
    low = raw.lower().replace(" ", "")
    junk = {
        "georgian", "georgia", "surname", "name", "lastname", "firstname",
        "givenname", "familyname", "nationality", "citizenship", "passport",
        "identity", "card", "სახელი", "გვარი", "მოქალაქეობა", "საქართველო",
    }
    if low in junk:
        return True
    if re.search(r"გვარი|სახელი|მოქალაქ|national|surname|given\s*name", raw, re.I):
        return True
    return False


def _fix_person_geo_name(geo: str, latin_hint: str, *, kind: str = "first") -> str:
    """
    Repair a person name (first/last) using MRZ Latin as source of truth.
    E.g. OCR «გემა» + MRZ BEKA → «ბექა».
    If Georgian OCR is empty, reverse-transliterate from MRZ Latin.
    When MRZ Latin is also missing, preserve the original non-junk input
    (bilingual / Latin-only OCR) instead of returning empty.
    """
    raw = (geo or "").strip()
    geo = (_georgian_only(raw) or "").strip()
    if geo and _is_name_junk(geo):
        geo = ""
    if raw and _is_name_junk(raw):
        raw = ""

    hint = _latin_norm(latin_hint)
    if not hint:
        # No MRZ to rebuild from — keep Georgian extract, else original input
        return geo or raw

    if geo and _latin_norm(transliterate_ka(geo)) == hint:
        return _restore_final_i(geo, latin_hint)

    if kind == "first":
        known = _KNOWN_GIVEN_BY_LATIN.get(hint)
        if known:
            if (
                not geo
                or _edit_distance(geo, known) <= 2
                or _geo_match_score(geo, hint) < 0.75
            ):
                return known

    if geo:
        fixed = _correct_geo_using_latin(
            geo, latin_hint, max_edits=2, allow_ambiguous=True
        )
        if _latin_norm(transliterate_ka(fixed)) == hint:
            return _restore_final_i(fixed, latin_hint)
        return _restore_final_i(geo, latin_hint)

    # No usable Georgian letters — rebuild from MRZ Latin (do not keep raw Latin
    # in the Georgian field when a hint exists; that blocked reverse-translit).
    if kind == "first":
        known = _KNOWN_GIVEN_BY_LATIN.get(hint)
        if known:
            return known
    synthesized = _latin_to_geo_approx(hint)
    return synthesized or ""


def _is_known_geo_city(geo: str) -> bool:
    """True when geo is exactly one of the official city spellings."""
    g = (geo or "").strip()
    return bool(g) and g in _KNOWN_PLACE_BY_LATIN.values()


def _repair_place_geo(geo: str, latin: str) -> str:
    """
    Repair the Georgian birth place.

    Birth-place Latin is plain OCR (not MRZ), so it must not overwrite a real
    official Georgian city (გორი must not become ონი just because Latin read ONI).

    It MAY recover Georgian when:
    - Latin is an exact known city AND Georgian is empty / junk / near that city
    - or Georgian is one letter away from an official city (თბილის → თბილისი)
    """
    # Never keep Latin nationality/labels («Georgian») in the Georgian field
    geo = (_georgian_only(geo) or "").strip()
    if geo and _is_place_junk(geo):
        geo = ""
    latin_n = _latin_norm(latin)
    known_from_latin = _KNOWN_PLACE_BY_LATIN.get(latin_n) if latin_n else None

    if not geo:
        return known_from_latin or ""

    if latin_n and _latin_norm(transliterate_ka(geo)) == latin_n:
        return geo

    if known_from_latin:
        if geo == known_from_latin:
            return geo
        # Official Georgian city wins over a conflicting Latin OCR reading
        if _is_known_geo_city(geo):
            return geo
        # Near-miss OCR of that city, or short/junk Georgian (e.g. «აბვ» + Khobi)
        if _edit_distance(geo, known_from_latin) <= 2 or len(geo) <= 3 or _is_place_junk(geo):
            return known_from_latin
        # Longer unknown text (village names) — keep as read
        return geo

    for city in _KNOWN_PLACES_GEO:
        if len(city) >= 5 and _edit_distance(geo, city) <= 1:
            return city
    return geo


def verify_against_mrz(data: dict, mrz: dict) -> dict:
    """Compare visual/filled fields with MRZ-sourced values."""
    mismatches = []
    checks = {}

    def add(field: str, ok: bool, expected: str = "", actual: str = ""):
        checks[field] = {"ok": ok, "expected": expected, "actual": actual}
        if not ok:
            mismatches.append(field)

    # Need core MRZ fields to run a real check (ID TD1)
    has_core = bool(mrz.get("personal_id") and mrz.get("card_number"))
    if not has_core:
        return {
            "status": "Error",
            "mismatches": ["mrz"],
            "checks": {},
            "message": "Could not read the MRZ",
        }

    if mrz.get("personal_id"):
        a = re.sub(r"\D", "", data.get("personal_id", ""))
        e = mrz["personal_id"]
        add("personal_id", a == e, e, a)
    if mrz.get("card_number"):
        a = re.sub(r"[^A-Z0-9]", "", (data.get("card_number") or "").upper())
        e = mrz["card_number"]
        add("card_number", a == e, e, a)
    if mrz.get("birth_date"):
        a = _norm_cmp(data.get("birth_date", ""))
        e = _norm_cmp(mrz["birth_date"])
        add("birth_date", a == e, mrz["birth_date"], data.get("birth_date", ""))
    if mrz.get("expiry_date"):
        a = _norm_cmp(data.get("expiry_date", ""))
        e = _norm_cmp(mrz["expiry_date"])
        add("expiry_date", a == e, mrz["expiry_date"], data.get("expiry_date", ""))
    if mrz.get("gender"):
        a = _gender_letter(data.get("gender", ""))
        e = _gender_letter(mrz["gender"])
        add("gender", bool(a and e and a == e), mrz["gender"], data.get("gender", ""))

    if mrz.get("_mrz_first_name"):
        latin = _latin_from_bilingual(data.get("first_name", ""))
        e = mrz["_mrz_first_name"].replace(" ", "")
        a = latin.replace(" ", "")
        if a:
            add("first_name", a == e or e.startswith(a) or a.startswith(e), mrz["_mrz_first_name"], latin)
        elif data.get("first_name"):
            add("first_name", True, mrz["_mrz_first_name"], data.get("first_name", ""))

    if mrz.get("_mrz_last_name"):
        latin = _latin_from_bilingual(data.get("last_name", ""))
        e = mrz["_mrz_last_name"].replace(" ", "")
        a = latin.replace(" ", "")
        if a:
            add("last_name", a == e or e.startswith(a) or a.startswith(e), mrz["_mrz_last_name"], latin)
        elif data.get("last_name"):
            add("last_name", True, mrz["_mrz_last_name"], data.get("last_name", ""))

    if mrz.get("citizenship_code"):
        expected = re.sub(r"[^A-Z]", "", mrz["citizenship_code"].upper())[:3]
        actual = _format_citizenship(data.get("citizenship", "")) or re.sub(
            r"[^A-Z]", "", (data.get("citizenship") or "").upper()
        )[:3]
        ok = bool(expected and actual and expected == actual)
        add("citizenship", ok, expected, data.get("citizenship", ""))

    return {
        "status": "Checked" if not mismatches else "Error",
        "mismatches": mismatches,
        "checks": checks,
    }


def _is_label_only(text: str) -> bool:
    t = text.strip()
    if not t or _IGNORE_VALUE.match(t):
        return True
    lower = t.lower()
    label_hits = sum(
        1 for labels in _LABEL_MAP.values() for lab in labels if lab.lower() in lower
    )
    if label_hits and len(t) < 45 and not re.search(r"\d{6,}|[\u10D0-\u10FF]{3,}", t):
        if re.search(r"[:：]\s*\S+", t):
            return False
        tokens = re.split(r"[\s/]+", t)
        if len(tokens) <= 4:
            return True
    return False


def _clean_value(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip(" :：-|/")).strip()


def _value_after_labels(lines: list[str], labels: list[str], prefer_georgian: bool = False) -> str:
    for i, line in enumerate(lines):
        lower = line.lower()
        for lab in labels:
            if lab.lower() not in lower:
                continue

            pattern = re.compile(
                re.escape(lab) + r"\s*(?:/[^:：\n]*)?[:：]?\s*(.+)$",
                re.IGNORECASE,
            )
            m = pattern.search(line)
            if m:
                candidate = _clean_value(m.group(1))
                candidate = re.split(
                    r"\s*/\s*(?:First|Last|Date|Place|Sex|Citizenship|Personal|Card)",
                    candidate,
                    flags=re.I,
                )[0]
                candidate = _clean_value(candidate)
                if prefer_georgian:
                    geo = _georgian_only(candidate)
                    if geo:
                        return geo
                if candidate and not _is_label_only(candidate) and len(candidate) > 1:
                    if not prefer_georgian or _GEO_RE.search(candidate):
                        return candidate

            # Look ahead; if prefer_georgian, skip pure Latin lines
            for j in range(i + 1, min(i + 6, len(lines))):
                nxt = _clean_value(lines[j])
                if not nxt or _is_label_only(nxt):
                    continue
                if prefer_georgian:
                    geo = _georgian_only(nxt)
                    if geo:
                        return geo
                    if _LATIN_ONLY.match(nxt):
                        continue
                    continue
                return nxt
    return ""


def _format_citizenship(value: str = "") -> str:
    """Normalize citizenship to any ICAO 3-letter code (GEO, UKR, RUS, TUR, …)."""
    raw = (value or "").strip()
    if not raw:
        return ""

    aliases = {
        "საქართველო": "GEO",
        "GEORGIA": "GEO",
        "GEORGIAN": "GEO",
        "უკრაინა": "UKR",
        "UKRAINE": "UKR",
        "UKRAINIAN": "UKR",
        "რუსეთი": "RUS",
        "RUSSIA": "RUS",
        "RUSSIAN": "RUS",
        "თურქეთი": "TUR",
        "TURKEY": "TUR",
        "TURKIYE": "TUR",
        "TÜRKIYE": "TUR",
        "TURKISH": "TUR",
        "ბელარუსი": "BLR",
        "BELARUS": "BLR",
        "BELARUSIAN": "BLR",
        "სომხეთი": "ARM",
        "ARMENIA": "ARM",
        "აზერბაიჯანი": "AZE",
        "AZERBAIJAN": "AZE",
        "ყაზახეთი": "KAZ",
        "KAZAKHSTAN": "KAZ",
        "ისრაელი": "ISR",
        "ISRAEL": "ISR",
        "გერმანია": "DEU",
        "GERMANY": "DEU",
        "GERMAN": "DEU",
        "აშშ": "USA",
        "USA": "USA",
        "UNITEDSTATES": "USA",
        "AMERICA": "USA",
    }
    upper = raw.upper()
    for name, code in aliases.items():
        if name.lower() in raw.lower() or name.upper() in upper:
            return code

    letters = re.sub(r"[^A-Z]", "", upper)
    if len(letters) >= 3:
        return letters[:3]
    return raw


def _format_gender_display(value: str = "") -> str:
    """Normalize to მმ / M or მდ / F."""
    gl = _gender_letter(value)
    if gl == "M":
        return "მმ / M"
    if gl == "F":
        return "მდ / F"
    return (value or "").strip()


def _parse_gender(text: str) -> str:
    if re.search(r"(მდედრ|\bმდ\b|მდ\s*/\s*F|\bFEMALE\b|\bF\b)", text, re.IGNORECASE):
        return "მდ / F"
    if re.search(r"(მამრ|\bმმ\b|მ\s*/\s*M|\bMALE\b|\bM\b)", text, re.IGNORECASE):
        return "მმ / M"
    if re.fullmatch(r"\s*[Ff]\s*", text):
        return "მდ / F"
    if re.fullmatch(r"\s*[Mm]\s*", text):
        return "მმ / M"
    return ""


def _split_pair(geo: str, latin: str = "") -> tuple[str, str]:
    """Return (georgian, latin) separately."""
    formatted = _format_bilingual(geo, latin)
    if not formatted:
        return "", ""
    if "/" in formatted:
        left, right = formatted.split("/", 1)
        return left.strip(), _title_latin(right.strip())
    if _GEO_RE.search(formatted):
        return _georgian_only(formatted) or formatted, transliterate_ka(formatted)
    return "", _title_latin(formatted)


def _normalize_display_date(day: str, month: str, year: str) -> str:
    try:
        d, m, y = int(day), int(month), int(year)
        if not (1 <= d <= 31 and 1 <= m <= 12 and 1900 <= y <= 2100):
            return ""
        return f"{d:02d}.{m:02d}.{y}"
    except ValueError:
        return ""


def _soft_date_ocr(text: str) -> str:
    """Fix common OCR letter/digit swaps so dates still match."""
    # Keep separators; map lookalikes only on alnum runs that look numeric
    out = []
    for ch in text:
        if ch in "OoQD":
            out.append("0")
        elif ch in "Il|":
            out.append("1")
        elif ch in "Zz":
            out.append("2")
        elif ch in "Ss":
            out.append("5")
        elif ch in "Bb":
            out.append("8")
        else:
            out.append(ch)
    return "".join(out)


def _find_dates_in_text(text: str) -> list[str]:
    """Extract DD.MM.YYYY-like dates from OCR text."""
    found = []
    variants = [text, _soft_date_ocr(text)]
    patterns = [
        r"(?<!\d)(\d{2})[./\-,\s]+(\d{2})[./\-,\s]+(\d{4})(?!\d)",
        r"(?<!\d)(\d{1,2})[./\-,\s]+(\d{1,2})[./\-,\s]+(\d{4})(?!\d)",
    ]
    for src in variants:
        for pat in patterns:
            for m in re.finditer(pat, src):
                val = _normalize_display_date(m.group(1), m.group(2), m.group(3))
                if val and val not in found:
                    found.append(val)
    return found


def _issue_date_from_words(words: list[dict], exclude: set[str]) -> str:
    """Find date under/near DATE OF ISSUE using Vision word boxes."""
    if not words:
        return ""

    label_hits = []
    for w in words:
        t = w["text"]
        tl = t.lower()
        if (
            "გაცემ" in t
            or "issue" in tl
            or "issl" in tl
            or "issuc" in tl
            or tl in ("iss", "isu")
        ):
            label_hits.append(w)

    # Separate words: DATE + OF + ISSUE
    if not label_hits:
        texts_l = [(w, w["text"].lower()) for w in words]
        for i, (w, tl) in enumerate(texts_l):
            if tl not in ("issue", "issl", "issuc", "isu"):
                continue
            # Prefer if nearby "date" / "of"
            label_hits.append(w)

    if not label_hits:
        return ""

    anchor = min(label_hits, key=lambda w: w["cy"])
    row_h = max(14.0, anchor["y2"] - anchor["y1"])

    # Collect tokens below or on same row as label (issue date sits under label)
    candidates: list[tuple[float, str]] = []
    for w in words:
        if w["cy"] < anchor["cy"] - row_h * 0.4:
            continue
        if w["cy"] > anchor["cy"] + row_h * 8:
            continue
        # Prefer roughly same column / slightly left-right of label block
        if abs(w["cx"] - anchor["cx"]) > 280 and w["cy"] > anchor["cy"] + row_h * 1.2:
            # still allow if clearly a date token
            pass
        dates = _find_dates_in_text(w["text"])
        for d in dates:
            if d not in exclude:
                dist = abs(w["cy"] - anchor["cy"]) + 0.25 * abs(w["cx"] - anchor["cx"])
                candidates.append((dist, d))

    # Merge fragmented date pieces on one row under the label
    row_words = [
        w for w in words
        if anchor["cy"] - row_h * 0.3 <= w["cy"] <= anchor["cy"] + row_h * 5
    ]
    row_words.sort(key=lambda w: (round(w["cy"] / max(8, row_h * 0.55)), w["cx"]))
    # group by row
    rows: list[list[dict]] = []
    for w in row_words:
        if not rows or abs(rows[-1][-1]["cy"] - w["cy"]) > row_h * 0.55:
            rows.append([w])
        else:
            rows[-1].append(w)
    for row in rows:
        joined = " ".join(w["text"] for w in row)
        soft_join = " ".join(_soft_date_ocr(w["text"]) for w in row)
        for blob in (joined, soft_join, re.sub(r"\s+", "", soft_join)):
            for d in _find_dates_in_text(blob):
                if d not in exclude:
                    dist = abs(row[0]["cy"] - anchor["cy"])
                    candidates.append((dist, d))

    if not candidates:
        return ""
    candidates.sort(key=lambda x: x[0])
    return candidates[0][1]


def _issue_date_from_back(
    back_lines: list[str],
    exclude_dates: list[str] | None = None,
    back_text: str = "",
    back_words: list[dict] | None = None,
) -> str:
    """
    On ID back, under Place of birth:
      გაცემის თარიღი / DATE OF ISSUE
      03.06.2025
    """
    exclude = set()
    for d in exclude_dates or []:
        if not d:
            continue
        m = re.search(r"(\d{1,2})[./\-](\d{1,2})[./\-](\d{4})", d)
        if m:
            nd = _normalize_display_date(m.group(1), m.group(2), m.group(3))
            if nd:
                exclude.add(nd)

    # OCR often mangling: DATE OF ISSUE / DATEOFISSUE / DATE 0F ISSUE / ISSLE
    label_re = re.compile(
        r"გაცემის\s*თარ|"
        r"გაცემ|"
        r"date\s*[o0]f\s*iss|"
        r"date\s*of\s*[il1]ss|"
        r"dateof\s*iss|"
        r"date\s*of\s*lss|"
        r"date.{0,6}iss|"
        r"iss\s*ue\b|"
        r"\bissue\b|"
        r"\bissl[ue]\b",
        re.IGNORECASE,
    )

    def pick(dates: list[str]) -> str:
        for d in dates:
            if d not in exclude:
                return d
        return ""

    # 0) Word boxes (most reliable when lines are glued oddly)
    from_words = _issue_date_from_words(back_words or [], exclude)
    if from_words:
        return from_words

    # 1) Label line + following lines
    for i, line in enumerate(back_lines):
        if not label_re.search(line):
            continue
        chunk = "\n".join(back_lines[i : i + 10])
        chosen = pick(_find_dates_in_text(chunk))
        if chosen:
            return chosen

    # 2) Whole back text blob (Vision may glue lines oddly)
    blob = back_text or "\n".join(back_lines)
    for src in (blob, _soft_date_ocr(blob)):
        m = re.search(
            r"(?:გაცემ[^\d]{0,80}|date\s*[o0]?f?\s*[il1]?ss[^\d]{0,80}|dateofiss[^\d]{0,40}|i\d{0,2}ue[^\d]{0,50}|issue[^\d]{0,50})"
            r"(\d{1,2}[\./\-,\s]+\d{1,2}[\./\-,\s]+\d{4}|\d{8})",
            src,
            re.IGNORECASE | re.DOTALL,
        )
        if not m:
            continue
        raw = m.group(1)
        parts = re.match(
            r"(\d{1,2})[\./\-,\s]+(\d{1,2})[\./\-,\s]+(\d{4})|(\d{2})(\d{2})(\d{4})",
            raw,
        )
        if not parts:
            continue
        if parts.group(1):
            val = _normalize_display_date(parts.group(1), parts.group(2), parts.group(3))
        else:
            val = _normalize_display_date(parts.group(4), parts.group(5), parts.group(6))
        if val and val not in exclude:
            return val

    # 3) After place-of-birth block: first date on back that isn't birth/expiry
    place_idx = -1
    for i, line in enumerate(back_lines):
        low = line.lower()
        if "დაბადების ადგილი" in low or "place of birth" in low or "place ofbirth" in low:
            place_idx = i
            break
    scan_from = place_idx + 1 if place_idx >= 0 else 0
    for j in range(scan_from, len(back_lines)):
        low = back_lines[j].lower()
        if "მოქმედების" in low or "expiry" in low or "idge" in low or "<" in back_lines[j]:
            continue
        if re.search(r"authority|ორგანო|signature|ხელმოწერ", low):
            # date is usually before authority; keep scanning this line though
            pass
        chosen = pick(_find_dates_in_text(back_lines[j]))
        if chosen:
            return chosen

    # 4) Any back date not equal to birth/expiry (back usually has only issue date printed)
    return pick(_find_dates_in_text(blob)) or ""


_PLACE_JUNK = re.compile(
    r"დაბადებ|ადგილ|გაცემ|თარიღ|ორგანო|იუსტიც|სამინისტრ|მოწმობ|"
    r"საქართველ|მოქალაქ|პირად|სქეს|სახელ|გვარ|ვადა|ნომერ|ხელმოწერ|"
    # «ტიპი» / «დოკუმენტი» are card labels; no Georgian city contains them
    r"ტიპ|დოკუმენტ"
)

# Latin words that leak into the Georgian place field (nationality / labels)
_PLACE_JUNK_LATIN = re.compile(
    r"^(?:georgia|georgian|citizenship|nationality|passport|identity|"
    r"sex|type|document|birth|place|name|surname|the|of)$",
    re.IGNORECASE,
)


def _is_place_junk(value: str) -> bool:
    raw = (value or "").strip()
    if not raw:
        return True
    compact = re.sub(r"[\s\-']+", "", raw)
    if _PLACE_JUNK_LATIN.match(compact) or _LATIN_LABEL_WORD.match(compact):
        return True
    geo = _georgian_only(raw) or ""
    # Pure Latin that isn't a known place spelling — never a Georgian place value
    if not geo and _LATIN_ONLY.match(compact):
        return True
    return not geo or len(geo) < 3 or bool(_PLACE_JUNK.search(geo))


def _birth_place_from_back(back_lines: list[str]) -> str:
    """
    On the ID back, Place of birth is the first field at the top:
      დაბადების ადგილი / PLACE OF BIRTH
      ამბროლაური
      AMBROLAURI
    Prefer Georgian value under that label. Field titles are never a value.
    If OCR only returns the Latin line, map a known city back to Georgian.
    """
    # 1) Label-based (most reliable)
    labeled = _value_after_labels(
        back_lines,
        ["დაბადების ადგილი", "place of birth", "place ofbirth"],
        prefer_georgian=True,
    )
    if labeled:
        geo = _georgian_only(labeled)
        if geo and not _is_place_junk(geo):
            return geo

    # 2) Label line (OCR-damaged labels included) → city name near it wins
    for i, line in enumerate(back_lines):
        if not _PLACE_LABEL_RE.search(line):
            continue
        window = back_lines[i : min(i + 6, len(back_lines))]
        known = _known_geo_place(" ".join(window))
        if known:
            return known
        for nxt in window[1:]:
            nxt = nxt.strip()
            if not nxt or _is_label_only(nxt):
                continue
            if re.search(r"გაცემის|date of issue|თარიღი|authority|ორგანო", nxt, re.I):
                break
            geo = _georgian_only(nxt)
            if geo and not _is_place_junk(geo):
                return geo
        # OCR often returns only the Latin line under the label
        for nxt in window:
            cand = _latin_place_candidate(nxt)
            if not cand:
                continue
            known = _KNOWN_PLACE_BY_LATIN.get(_latin_norm(cand))
            if known:
                return known

    # 3) Any official city name on the back — safer than the first Georgian line
    known = _known_geo_place("\n".join(back_lines))
    if known:
        return known

    # 4) First Georgian content line on back (skip headers / MRZ)
    for line in back_lines:
        t = line.strip()
        if not t or len(t) < 2:
            continue
        if "<" in t or "IDGE" in t.upper() or "TRGE" in t.upper():
            continue
        if _BACK_SKIP.search(t):
            continue
        if _is_label_only(t):
            continue
        if re.fullmatch(r"[\d\s\./\-]+", t):
            continue
        if re.search(r"გაცემის|issue|authority|ორგანო|იუსტიც", t, re.I):
            continue
        geo = _georgian_only(t)
        if geo and not _is_place_junk(geo):
            return geo

    # 5) Last resort: any Latin place on the back that maps to a known city
    for line in back_lines:
        cand = _latin_place_candidate(line)
        if not cand:
            continue
        known = _KNOWN_PLACE_BY_LATIN.get(_latin_norm(cand))
        if known:
            return known
    return ""


def _ids_near_labels(lines: list[str], full_text: str) -> dict:
    """Highest-confidence personal_id / card_number from labeled visual zone."""
    out = {}

    # Personal number near its label
    pid_val = _value_after_labels(lines, _LABEL_MAP["personal_id"])
    if pid_val:
        pids = _find_personal_ids(pid_val)
        if pids:
            out["personal_id"] = _pick_personal_id(pids)

    if not out.get("personal_id"):
        for i, line in enumerate(lines):
            if not any(lab.lower() in line.lower() for lab in _LABEL_MAP["personal_id"]):
                continue
            chunk = " ".join(lines[i : i + 4])
            pids = _find_personal_ids(chunk)
            if pids:
                out["personal_id"] = _pick_personal_id(pids)
                break

    # Card number near its label
    card_val = _value_after_labels(lines, _LABEL_MAP["card_number"])
    if card_val:
        cards = _find_card_numbers(card_val)
        if cards:
            out["card_number"] = cards[0]
        else:
            norm = _normalize_card_number(card_val)
            if re.fullmatch(r"\d{2}[A-Z]{2}\d{5}", norm):
                out["card_number"] = norm

    if not out.get("card_number"):
        for i, line in enumerate(lines):
            if not any(lab.lower() in line.lower() for lab in _LABEL_MAP["card_number"]):
                continue
            chunk = " ".join(lines[i : i + 4])
            cards = _find_card_numbers(chunk)
            if cards:
                out["card_number"] = cards[0]
                break

    # Front-wide pattern search (visual zone is usually cleaner than MRZ)
    if not out.get("personal_id"):
        pids = _find_personal_ids(full_text)
        if pids:
            out["personal_id"] = _pick_personal_id(pids)

    if not out.get("card_number"):
        cards = _find_card_numbers(full_text)
        strict = [c for c in cards if re.fullmatch(r"\d{2}[A-Z]{2}\d{5}", c)]
        if strict:
            out["card_number"] = strict[0]

    return out


def _restore_final_i(geo: str, latin_hint: str = "") -> str:
    """OCR often drops final Georgian 'ი'; restore when Latin hint ends with I."""
    if not geo or geo.endswith("ი"):
        return geo
    hint = (latin_hint or "").strip()
    if hint and hint[-1:].upper() == "I":
        return geo + "ი"
    return geo


def _merge_geo_continuation(lines: list[str], start_idx: int, base: str) -> str:
    """Join a following short Georgian fragment (cut-off final letter)."""
    name = base
    for j in range(start_idx, min(start_idx + 2, len(lines))):
        nxt = lines[j].strip()
        if re.fullmatch(r"[\u10D0-\u10FF]{1,2}", nxt):
            name += nxt
        else:
            break
    return name


def _geo_match_score(geo: str, latin_hint: str) -> float:
    """How well Georgian transliteration matches MRZ/Latin hint (0..1+)."""
    hint = _latin_norm(latin_hint)
    if not geo or not hint:
        return 0.0
    cand = _latin_norm(transliterate_ka(geo))
    if not cand:
        return 0.0
    if cand == hint:
        return 2.0
    if cand.startswith(hint) or hint.startswith(cand):
        return 1.5
    # shared prefix length
    n = 0
    for a, b in zip(cand, hint):
        if a != b:
            break
        n += 1
    return n / max(len(hint), len(cand))


def _best_geo_for_latin(candidates: list[str], latin_hint: str, used: set[str] | None = None) -> str:
    used = used or set()
    hint = _latin_norm(latin_hint)
    if not hint or not candidates:
        return ""
    best = ""
    best_score = 0.35  # minimum acceptance
    for geo in candidates:
        if geo in used:
            continue
        score = _geo_match_score(geo, hint)
        if score > best_score:
            best_score = score
            best = geo
    return best


def _collect_geo_name_candidates(front_lines: list[str]) -> list[str]:
    skip_places = {
        "თბილისი", "ბათუმი", "ქუთაისი", "რუსთავი", "ზუგდიდი", "გორი",
        "თელავი", "ამბროლაური", "ზესტაფონი", "საქართველო", "სტუდენტი",
    }
    geo_words: list[str] = []
    i = 0
    while i < len(front_lines):
        item = front_lines[i].strip()
        if _is_label_only(item) or re.search(r"\d", item):
            i += 1
            continue
        if not re.fullmatch(r"[\u10D0-\u10FF\s\-']{2,}", item):
            i += 1
            continue
        word = _merge_geo_continuation(front_lines, i + 1, item)
        word = _georgian_only(word) or word
        if (
            word
            and word.lower() not in skip_places
            and len(word) >= 2
            and word not in geo_words
            and not _is_name_junk(word)
        ):
            geo_words.append(word)
        i += 1
    return geo_words


def _georgian_names_from_front(front_lines: list[str], latin_hints: dict | None = None) -> dict:
    data = {}
    latin_hints = latin_hints or {}
    mrz_first = latin_hints.get("_mrz_first_name", "")
    mrz_last = latin_hints.get("_mrz_last_name", "")
    candidates = _collect_geo_name_candidates(front_lines)

    last = _value_after_labels(front_lines, _LABEL_MAP["last_name"], prefer_georgian=True)
    first = _value_after_labels(front_lines, _LABEL_MAP["first_name"], prefer_georgian=True)

    if last:
        last = _georgian_only(last) or last
        for i, line in enumerate(front_lines):
            if any(lab.lower() in line.lower() for lab in _LABEL_MAP["last_name"]):
                for j in range(i + 1, min(i + 5, len(front_lines))):
                    geo_j = _georgian_only(front_lines[j])
                    if geo_j and (geo_j == last or last in front_lines[j] or front_lines[j].strip() == last):
                        last = _merge_geo_continuation(front_lines, j + 1, last)
                        break
                break
        data["last_name"] = last

    if first:
        first = _georgian_only(first) or first
        for i, line in enumerate(front_lines):
            if any(lab.lower() in line.lower() for lab in _LABEL_MAP["first_name"]):
                for j in range(i + 1, min(i + 5, len(front_lines))):
                    geo_j = _georgian_only(front_lines[j])
                    if geo_j and (geo_j == first or first in front_lines[j] or front_lines[j].strip() == first):
                        first = _merge_geo_continuation(front_lines, j + 1, first)
                        break
                break
        data["first_name"] = first

    # If label-based value does not match MRZ Latin, replace by best candidate
    if mrz_last:
        labeled_ok = _geo_match_score(data.get("last_name", ""), mrz_last) >= 0.7
        if not labeled_ok:
            best_last = _best_geo_for_latin(candidates, mrz_last)
            if best_last:
                data["last_name"] = best_last
    if mrz_first:
        labeled_ok = _geo_match_score(data.get("first_name", ""), mrz_first) >= 0.7
        if not labeled_ok:
            used = {data.get("last_name", "")}
            best_first = _best_geo_for_latin(candidates, mrz_first, used)
            if best_first:
                data["first_name"] = best_first

    # Fallback when still empty: pick by MRZ match, else order
    if not data.get("last_name") and candidates:
        data["last_name"] = _best_geo_for_latin(candidates, mrz_last) or candidates[0]
    if not data.get("first_name") and candidates:
        used = {data.get("last_name", "")}
        data["first_name"] = (
            _best_geo_for_latin(candidates, mrz_first, used)
            or next((w for w in candidates if w not in used), "")
        )

    # Final swap fix: if first/last look swapped relative to MRZ
    if mrz_first and mrz_last and data.get("first_name") and data.get("last_name"):
        score_ok = (
            _geo_match_score(data["first_name"], mrz_first)
            + _geo_match_score(data["last_name"], mrz_last)
        )
        score_swapped = (
            _geo_match_score(data["first_name"], mrz_last)
            + _geo_match_score(data["last_name"], mrz_first)
        )
        if score_swapped > score_ok + 0.3:
            data["first_name"], data["last_name"] = data["last_name"], data["first_name"]

    # Do not call _fix_person_geo_name here — extract_id_info runs a single
    # final repair pass so synthesized / corrected names are not re-processed.

    return data


def _parse_visual_fields(full_text: str, lines: list[str], data: dict) -> dict:
    for field, labels in _LABEL_MAP.items():
        if field in ("personal_id", "card_number", "first_name", "last_name"):
            continue  # handled separately with higher priority rules
        if data.get(field):
            continue
        prefer_geo = field == "birth_place"
        value = _value_after_labels(lines, labels, prefer_georgian=prefer_geo)
        if not value:
            continue
        if field == "gender":
            data[field] = _format_gender_display(_parse_gender(value) or value)
        elif field == "citizenship":
            data[field] = _format_citizenship(value)
        elif field in ("birth_date", "expiry_date", "issue_date"):
            date_m = re.search(r"\d{2}[\./]\d{2}[\./]\d{4}", value)
            data[field] = date_m.group(0).replace("/", ".") if date_m else value
        elif field == "birth_place":
            data[field] = _georgian_only(value) or value
        else:
            data[field] = value

    dates = re.findall(r"\b\d{2}[\./]\d{2}[\./]\d{4}\b", full_text)
    if dates:
        if not data.get("birth_date"):
            data["birth_date"] = dates[0]
        if not data.get("expiry_date") and len(dates) >= 2:
            data["expiry_date"] = dates[-1]

    if not data.get("gender"):
        g = _parse_gender(full_text)
        if g:
            data["gender"] = g

    data["citizenship"] = _format_citizenship(data.get("citizenship", ""))
    if data.get("gender"):
        data["gender"] = _format_gender_display(data["gender"])

    return data


def extract_id_info(front_bytes: bytes, back_bytes: bytes) -> dict:
    front_text, front_lines, front_words, front_rot = ocr_image_ex(front_bytes)
    back_text, back_lines, back_words, back_rot = ocr_image_ex(back_bytes)

    combined_lines = front_lines + back_lines
    combined_text = "\n".join([t for t in (front_text, back_text) if t]).strip()

    mrz = parse_mrz(back_lines)

    # IDs: ONLY from back-side MRZ (never combined with front — causes wrong numbers)
    mrz_ids = extract_mrz_ids(back_text)
    if mrz_ids.get("card_number"):
        mrz["card_number"] = mrz_ids["card_number"]
    if mrz_ids.get("personal_id"):
        mrz["personal_id"] = mrz_ids["personal_id"]

    # Dates/sex/names fallback from combined only (never IDs)
    if not mrz.get("birth_date") or not mrz.get("gender"):
        extra = parse_mrz(combined_lines)
        for k in ("birth_date", "expiry_date", "gender", "_mrz_last_name", "_mrz_first_name"):
            if extra.get(k) and not mrz.get(k):
                mrz[k] = extra[k]

    data = {k: v for k, v in mrz.items() if k in ("birth_date", "expiry_date", "gender", "citizenship")}
    mrz_pid = mrz.get("personal_id", "")
    mrz_card = mrz.get("card_number", "")

    data = _parse_visual_fields(combined_text, combined_lines, data)
    data = _parse_visual_fields(front_text, front_lines, data)

    # MRZ formula wins — do not let front OCR overwrite
    if mrz_card and len(re.sub(r"[^A-Z0-9]", "", mrz_card.upper())) == 9:
        data["card_number"] = _fix_georgian_card_number(mrz_card)
    else:
        front_ids = _ids_near_labels(front_lines, front_text)
        back_ids = _ids_near_labels(back_lines, back_text)
        data["card_number"] = _fix_georgian_card_number(
            front_ids.get("card_number") or back_ids.get("card_number") or ""
        )

    if mrz_pid and len(mrz_pid) == 11 and mrz_pid.isdigit():
        data["personal_id"] = mrz_pid
    else:
        layout_pid = _personal_id_from_layout(front_words)
        front_ids = _ids_near_labels(front_lines, front_text)
        data["personal_id"] = (
            layout_pid
            or front_ids.get("personal_id")
            or _pick_personal_id(_find_personal_ids(front_text))
            or ""
        )

    latin_hints = {
        "_mrz_last_name": mrz.get("_mrz_last_name", ""),
        "_mrz_first_name": mrz.get("_mrz_first_name", ""),
    }
    geo_names = _georgian_names_from_front(front_lines, latin_hints)
    if geo_names.get("first_name") and _GEO_RE.search(geo_names["first_name"]):
        data["first_name"] = geo_names["first_name"]
    if geo_names.get("last_name") and _GEO_RE.search(geo_names["last_name"]):
        data["last_name"] = geo_names["last_name"]

    if not data.get("first_name") or not data.get("last_name"):
        extra = _georgian_names_from_front(combined_lines, latin_hints)
        if not data.get("first_name") and extra.get("first_name") and _GEO_RE.search(extra["first_name"]):
            data["first_name"] = extra["first_name"]
        if not data.get("last_name") and extra.get("last_name") and _GEO_RE.search(extra["last_name"]):
            data["last_name"] = extra["last_name"]

    for key, hint_key in (("first_name", "_mrz_first_name"), ("last_name", "_mrz_last_name")):
        kind = "first" if key == "first_name" else "last"
        raw = (data.get(key, "") or "").strip()
        hint = latin_hints.get(hint_key, "")
        if raw or hint:
            # Pass raw so Latin/bilingual fallbacks inside the fixer are preserved
            # when MRZ Latin is missing; fixer still strips to Georgian when possible.
            data[key] = _fix_person_geo_name(raw, hint, kind=kind)
        else:
            data[key] = ""

    back_place = _birth_place_from_back(back_lines)
    if back_place:
        data["birth_place"] = back_place
    elif data.get("birth_place"):
        visual_place = _georgian_only(data["birth_place"]) or data["birth_place"]
        # Visual parsing has no label guard — never show a field title as the place
        data["birth_place"] = "" if _is_place_junk(visual_place) else visual_place

    issue = _issue_date_from_back(
        back_lines,
        exclude_dates=[data.get("birth_date", ""), data.get("expiry_date", ""), mrz.get("birth_date", ""), mrz.get("expiry_date", "")],
        back_text=back_text,
        back_words=back_words,
    )
    if issue:
        data["issue_date"] = issue
    elif data.get("issue_date"):
        dates = _find_dates_in_text(data["issue_date"])
        data["issue_date"] = dates[0] if dates else ""
    else:
        data["issue_date"] = ""

    # Separate Georgian / Latin fields
    first_geo, first_lat = _split_pair(
        data.get("first_name", ""), mrz.get("_mrz_first_name", "")
    )
    last_geo, last_lat = _split_pair(
        data.get("last_name", ""), mrz.get("_mrz_last_name", "")
    )
    raw_place = (data.get("birth_place") or "").strip()
    place_geo = _georgian_only(raw_place) or ""
    if place_geo and _is_place_junk(place_geo):
        place_geo = ""
    # Never leave Latin junk («Georgian») in the Georgian place field
    if not place_geo and raw_place and not _is_place_junk(raw_place) and _GEO_RE.search(raw_place):
        place_geo = raw_place
    place_lat = _birth_place_latin_from_back(back_lines, place_geo)
    # Always repair: empty/junk Georgian can still be recovered from known Latin
    place_geo = _repair_place_geo(place_geo, place_lat)
    place_geo, place_lat = _split_pair(place_geo, place_lat)
    place_lat = _clean_place_latin(place_geo, place_lat)

    data["first_name"] = first_geo
    data["first_name_lat"] = first_lat
    data["last_name"] = last_geo
    data["last_name_lat"] = last_lat
    data["birth_place"] = place_geo
    data["birth_place_lat"] = place_lat

    data["citizenship"] = _format_citizenship(
        mrz.get("citizenship_code") or data.get("citizenship", "")
    ) or (mrz.get("citizenship_code") or "GEO")

    if mrz.get("gender"):
        data["gender"] = _format_gender_display(mrz["gender"])
    elif data.get("gender"):
        data["gender"] = _format_gender_display(_parse_gender(data["gender"]) or data["gender"])
    else:
        data["gender"] = ""

    # MRZ dates/sex win for consistency with Check
    if mrz.get("birth_date"):
        data["birth_date"] = mrz["birth_date"]
    if mrz.get("expiry_date"):
        data["expiry_date"] = mrz["expiry_date"]
    if mrz.get("gender"):
        data["gender"] = _format_gender_display(mrz["gender"])

    mrz_strip = extract_mrz_strip(back_text)

    # Final hard rule: card number is always DDLLDDDDD
    data["card_number"] = _fix_georgian_card_number(data.get("card_number", ""))
    if mrz.get("card_number"):
        mrz["card_number"] = _fix_georgian_card_number(mrz["card_number"])

    # Also rewrite MRZ strip line1 document number (chars 6–14)
    if mrz_strip and data["card_number"]:
        parts = mrz_strip.splitlines()
        if parts:
            line1 = parts[0].ljust(30, "<")[:30]
            if line1.startswith("IDGEO") or line1.startswith("TRGEO"):
                prefix = line1[:5]
                rest = line1[5:]
                parts[0] = (prefix + data["card_number"] + rest[9:])[:30]
                mrz_strip = "\n".join(parts)
            elif line1.startswith("IDGE") or line1.startswith("TRGE"):
                prefix = "IDGEO" if line1.startswith("ID") else "TRGEO"
                rest = line1[4:]
                parts[0] = (prefix + data["card_number"] + rest[9:])[:30]
                mrz_strip = "\n".join(parts)

    # For verification, combine geo+lat temporarily
    verify_data = dict(data)
    if data.get("first_name") or data.get("first_name_lat"):
        verify_data["first_name"] = _format_bilingual(data.get("first_name", ""), data.get("first_name_lat", ""))
    if data.get("last_name") or data.get("last_name_lat"):
        verify_data["last_name"] = _format_bilingual(data.get("last_name", ""), data.get("last_name_lat", ""))

    verification = verify_against_mrz(verify_data, mrz)

    portrait = ""
    try:
        from portrait_extract import extract_portrait_data_url
        portrait = extract_portrait_data_url(
            front_bytes, kind="id", rotation=front_rot
        ) or ""
    except Exception as exc:
        print(f"Portrait extract (ID) failed: {exc}")
        portrait = ""

    return {
        "extracted_data": {
            "first_name": data.get("first_name", ""),
            "first_name_lat": data.get("first_name_lat", ""),
            "last_name": data.get("last_name", ""),
            "last_name_lat": data.get("last_name_lat", ""),
            "birth_date": data.get("birth_date", ""),
            "birth_place": data.get("birth_place", ""),
            "birth_place_lat": data.get("birth_place_lat", ""),
            "citizenship": data.get("citizenship", "") or "GEO",
            "gender": data.get("gender", ""),
            "personal_id": data.get("personal_id", ""),
            "expiry_date": data.get("expiry_date", ""),
            "card_number": data.get("card_number", ""),
            "issue_date": data.get("issue_date", ""),
            "mrz_strip": mrz_strip,
            "portrait": portrait,
        },
        "mrz_fields": {
            "personal_id": mrz.get("personal_id", ""),
            "card_number": mrz.get("card_number", ""),
            "birth_date": mrz.get("birth_date", ""),
            "expiry_date": mrz.get("expiry_date", ""),
            "gender": mrz.get("gender", ""),
            "first_name": mrz.get("_mrz_first_name", ""),
            "last_name": mrz.get("_mrz_last_name", ""),
            "citizenship": mrz.get("citizenship_code", ""),
        },
        "verification": verification,
        "is_valid": verification["status"] == "Checked",
        # Counter-clockwise degrees the UI must apply to show the photo upright
        "orientation": {"front": front_rot, "back": back_rot},
        "raw_text": {
            "front": front_text,
            "back": back_text,
        },
    }
