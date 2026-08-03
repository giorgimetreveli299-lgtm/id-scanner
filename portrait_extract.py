"""
Extract the printed portrait plate from Georgian ID (front) or passport data page.

ID: color photo left of name fields, under title, above «ბარათის № / CARD No».
Passport: color photo left of surname/given names, above the MRZ strip.

Primary: Vision face → expand to ~3:4 plate with OCR edge limits.
Fallback: fixed left-side plate region.
"""
from __future__ import annotations

import base64
import io
import re

from google.cloud import vision
from PIL import Image

import id_verifier as idv

# Printed ID / passport photo is taller than wide
_PHOTO_ASPECT = 3 / 4  # width / height


def _faces_from_vision(image_bytes: bytes) -> list[dict]:
    """
    Each face: {box: (x0,y0,x1,y1), cx, cy, ear_box?} from Vision.
    Prefer landmark ears/forehead/chin so the full head contour is framed.
    """
    client = idv._get_vision_client()
    image = vision.Image(content=image_bytes)
    response = client.face_detection(image=image)
    if response.error.message:
        return []

    T = vision.FaceAnnotation.Landmark.Type
    out: list[dict] = []
    for face in response.face_annotations or []:
        # Prefer fd_bounding_poly (tighter) then bounding_poly
        verts = None
        if face.fd_bounding_poly and face.fd_bounding_poly.vertices:
            verts = face.fd_bounding_poly.vertices
        elif face.bounding_poly and face.bounding_poly.vertices:
            verts = face.bounding_poly.vertices
        if not verts:
            continue
        xs = [int(v.x or 0) for v in verts]
        ys = [int(v.y or 0) for v in verts]
        if not xs or not ys:
            continue
        box = (min(xs), min(ys), max(xs), max(ys))

        lm: dict[int, tuple[float, float]] = {}
        for landmark in face.landmarks or []:
            try:
                key = int(landmark.type_)
            except Exception:
                continue
            pos = landmark.position
            if pos is None:
                continue
            lm[key] = (float(pos.x or 0), float(pos.y or 0))

        left_ear = lm.get(int(T.LEFT_EAR_TRAGION))
        right_ear = lm.get(int(T.RIGHT_EAR_TRAGION))
        chin = lm.get(int(T.CHIN_GNATHION))
        forehead = lm.get(int(T.FOREHEAD_GLABELLA))
        chin_l = lm.get(int(T.CHIN_LEFT_GONION))
        chin_r = lm.get(int(T.CHIN_RIGHT_GONION))

        ear_box = None
        if left_ear and right_ear:
            ex0 = min(left_ear[0], right_ear[0])
            ex1 = max(left_ear[0], right_ear[0])
            if chin_l and chin_r:
                ex0 = min(ex0, chin_l[0], chin_r[0])
                ex1 = max(ex1, chin_l[0], chin_r[0])
            ew = max(1.0, ex1 - ex0)
            # Outward pad so full ear / jaw contour stays inside
            ex0 -= ew * 0.14
            ex1 += ew * 0.14
            if forehead and chin:
                face_h = max(1.0, chin[1] - forehead[1])
                ey0 = forehead[1] - face_h * 0.55  # crown / hair
                ey1 = chin[1] + face_h * 0.38  # neck
            else:
                fh = max(1, box[3] - box[1])
                ey0 = box[1] - fh * 0.28
                ey1 = box[3] + fh * 0.22
            ear_box = (ex0, ey0, ex1, ey1)

        cx = (box[0] + box[2]) / 2.0
        cy = (box[1] + box[3]) / 2.0
        if ear_box:
            cx = (ear_box[0] + ear_box[2]) / 2.0
            cy = (ear_box[1] + ear_box[3]) / 2.0
        out.append({"box": box, "ear_box": ear_box, "cx": cx, "cy": cy})
    return out


def _ocr_full_text(image_bytes: bytes):
    """Document OCR annotation, or None."""
    try:
        client = idv._get_vision_client()
        image = vision.Image(content=image_bytes)
        response = client.document_text_detection(image=image)
        if response.error.message or not response.full_text_annotation:
            return None
        return response.full_text_annotation
    except Exception:
        return None


def _card_no_top_y_from_anno(anno, w: int, h: int) -> int | None:
    """Y of «ბარათის / CARD No» — photo plate sits just above it (ID)."""
    if not anno:
        return None

    label_re = re.compile(r"ბარათ|card\s*n|card\s*№|card\s*#|cardno", re.I)
    candidates: list[int] = []
    for word, _pw, _ph in idv._iter_words(anno):
        text = "".join(s.text for s in word.symbols if getattr(s, "text", None)).strip()
        if not text or not label_re.search(text):
            continue
        x0, y0, x1, y1 = idv._word_bbox(word)
        if (x0 + x1) / 2 > w * 0.58:
            continue
        candidates.append(int(y0))

    if not candidates:
        return None
    return max(0, min(candidates) - int(h * 0.008))


def _id_header_bottom_y_from_anno(anno, w: int, h: int) -> int | None:
    """Bottom of ID title strip («პირადობის მოწმობა» + icons)."""
    if not anno:
        return None

    header_re = re.compile(
        r"პირადობ|მოწმობ|identity|identit|id\s*card|საქართველ",
        re.I,
    )
    bottoms: list[int] = []
    for word, _pw, _ph in idv._iter_words(anno):
        text = "".join(s.text for s in word.symbols if getattr(s, "text", None)).strip()
        if not text or not header_re.search(text):
            continue
        x0, y0, x1, y1 = idv._word_bbox(word)
        if y0 > h * 0.28:
            continue
        bottoms.append(int(y1))

    if not bottoms:
        return None
    # Extra pad so orange icons / title never leak into the crop
    return min(h - 1, max(bottoms) + int(h * 0.02))


def _name_column_left_x_from_anno(anno, w: int, h: int, kind: str) -> int | None:
    """
    Left edge of the name/text column — photo must stay to the left of this.
    """
    if not anno:
        return None

    if kind == "passport":
        label_re = re.compile(
            r"გვარი|სახელი|surname|family\s*name|given\s*name|nationality|"
            r"მოქალაქ|date\s*of\s*birth|დაბადებ|sex|სქესი",
            re.I,
        )
        # Passport names sit mid-page; ignore far-left chrome
        x_min, x_max = w * 0.28, w * 0.85
        y_max = h * 0.72
    else:
        label_re = re.compile(
            r"გვარი|სახელი|surname|family|given\s*name|first\s*name|"
            r"მოქალაქ|nationalit|პირადი|personal",
            re.I,
        )
        x_min, x_max = w * 0.28, w * 0.92
        y_max = h * 0.75

    xs: list[int] = []
    for word, _pw, _ph in idv._iter_words(anno):
        text = "".join(s.text for s in word.symbols if getattr(s, "text", None)).strip()
        if not text or not label_re.search(text):
            continue
        x0, y0, x1, y1 = idv._word_bbox(word)
        cx = (x0 + x1) / 2
        if cx < x_min or cx > x_max or y0 > y_max:
            continue
        xs.append(int(x0))

    if not xs:
        return None
    # Small inset so label glyphs never enter the portrait
    return max(0, min(xs) - int(w * 0.012))


def _passport_header_bottom_y(anno, w: int, h: int) -> int | None:
    """Below passport title / GEO / type line."""
    if not anno:
        return None
    header_re = re.compile(
        r"პასპორტ|passport|georgia|საქართველ|type\s*/?\s*p|geo\b",
        re.I,
    )
    bottoms: list[int] = []
    for word, _pw, _ph in idv._iter_words(anno):
        text = "".join(s.text for s in word.symbols if getattr(s, "text", None)).strip()
        if not text or not header_re.search(text):
            continue
        x0, y0, x1, y1 = idv._word_bbox(word)
        if y0 > h * 0.35:
            continue
        bottoms.append(int(y1))
    if not bottoms:
        return None
    return min(h - 1, max(bottoms) + int(h * 0.01))


def _passport_mrz_top_y(anno, w: int, h: int) -> int | None:
    """Top of TD3 MRZ / P< line — photo ends above it."""
    if not anno:
        return None
    ys: list[int] = []
    for word, _pw, _ph in idv._iter_words(anno):
        text = "".join(s.text for s in word.symbols if getattr(s, "text", None)).strip()
        if not text:
            continue
        x0, y0, x1, y1 = idv._word_bbox(word)
        t = text.upper().replace(" ", "")
        if y0 < h * 0.45:
            continue
        if t.startswith("P<") or re.match(r"^P[O0]<", t) or (t.startswith("P") and "<<" in t):
            ys.append(int(y0))
            continue
        t_clean = re.sub(r"[^A-Z0-9<]", "", t)
        if y0 >= h * 0.62 and len(t_clean) >= 20 and "<" in t_clean:
            ys.append(int(y0))
    if not ys:
        return None
    return max(0, min(ys) - int(h * 0.01))


def _box_area(b: tuple[int, int, int, int]) -> int:
    return max(0, b[2] - b[0]) * max(0, b[3] - b[1])


def _pick_face(
    faces: list[dict], w: int, h: int, kind: str
) -> dict | None:
    if not faces:
        return None
    # Printed portrait is on the left half (ID + Georgian passport)
    thresh = w * (0.52 if kind == "id" else 0.48)
    left = [f for f in faces if f["cx"] < thresh]
    pool = left or faces
    return max(pool, key=lambda f: _box_area(f["box"]))


def _clamp_box(x0: int, y0: int, x1: int, y1: int, w: int, h: int) -> tuple[int, int, int, int]:
    x0 = max(0, min(x0, w - 1))
    y0 = max(0, min(y0, h - 1))
    x1 = max(x0 + 1, min(x1, w))
    y1 = max(y0 + 1, min(y1, h))
    return x0, y0, x1, y1


def _fit_aspect(
    cx: float, cy: float, target_w: float, target_h: float, w: int, h: int
) -> tuple[int, int, int, int]:
    tw = min(target_w, w)
    th = min(target_h, h)
    if tw / max(th, 1) > _PHOTO_ASPECT:
        tw = th * _PHOTO_ASPECT
    else:
        th = tw / _PHOTO_ASPECT
    x0 = int(round(cx - tw / 2))
    y0 = int(round(cy - th / 2))
    x1 = int(round(x0 + tw))
    y1 = int(round(y0 + th))
    if x0 < 0:
        x1 -= x0
        x0 = 0
    if y0 < 0:
        y1 -= y0
        y0 = 0
    if x1 > w:
        x0 -= x1 - w
        x1 = w
    if y1 > h:
        y0 -= y1 - h
        y1 = h
    return _clamp_box(x0, y0, x1, y1, w, h)


def _apply_plate_limits(
    box: tuple[int, int, int, int],
    cx: float,
    w: int,
    h: int,
    top_limit: int | None,
    bottom_limit: int | None,
    right_limit: int | None,
    left_limit: int | None = None,
) -> tuple[int, int, int, int]:
    """Clamp plate to OCR-derived edges; keep ~3:4. Ignore impossible limits."""
    bx0, by0, bx1, by1 = box
    # Drop contradictory OCR bounds so the face crop is never wiped out
    if (
        top_limit is not None
        and bottom_limit is not None
        and bottom_limit - top_limit < 60
    ):
        top_limit = None
        bottom_limit = None
    if left_limit is not None and right_limit is not None and right_limit - left_limit < 40:
        right_limit = None

    if left_limit is not None and bx0 < left_limit:
        bx0 = left_limit
    if top_limit is not None and by0 < top_limit:
        by0 = top_limit
    if bottom_limit is not None and bottom_limit > by0 + 40:
        by1 = min(by1, bottom_limit)
    if right_limit is not None and right_limit > bx0 + 40:
        bx1 = min(bx1, right_limit)

    new_h = by1 - by0
    new_w = bx1 - bx0
    if new_h < 20 or new_w < 16:
        # Limits destroyed the box — return original clamped box
        return _clamp_box(box[0], box[1], box[2], box[3], w, h)

    want_w = new_h * _PHOTO_ASPECT
    if want_w <= new_w:
        bx0 = int(round(cx - want_w / 2))
        bx1 = int(round(bx0 + want_w))
        if left_limit is not None and bx0 < left_limit:
            bx0 = left_limit
            bx1 = int(bx0 + want_w)
        if right_limit is not None and bx1 > right_limit:
            bx1 = right_limit
            bx0 = max(bx0, int(bx1 - want_w))
    else:
        want_h = new_w / _PHOTO_ASPECT
        mid_y = (by0 + by1) / 2
        by0 = int(round(mid_y - want_h / 2))
        by1 = int(round(by0 + want_h))
        if top_limit is not None and by0 < top_limit:
            by0 = top_limit
            by1 = int(by0 + want_h)
        if bottom_limit is not None and by1 > bottom_limit:
            by1 = bottom_limit
            by0 = max(by0, int(by1 - want_h))

    return _clamp_box(bx0, by0, bx1, by1, w, h)


def _inset_box(
    box: tuple[int, int, int, int], w: int, h: int, frac: float = 0.015
) -> tuple[int, int, int, int]:
    """Slight inset to drop plate border without eating the face."""
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    if bw < 24 or bh < 24:
        return _clamp_box(x0, y0, x1, y1, w, h)
    dx = max(1, int(bw * frac))
    dy = max(1, int(bh * frac))
    return _clamp_box(x0 + dx, y0 + dy, x1 - dx, y1 - dy, w, h)


def _box_centered_on(
    cx: float, cy: float, tw: float, th: float, w: int, h: int
) -> tuple[int, int, int, int]:
    """Place tw×th box on (cx,cy); slide as a whole if it hits image edges (keeps subject centered)."""
    tw = max(8.0, min(float(tw), float(w)))
    th = max(8.0, min(float(th), float(h)))
    x0 = int(round(cx - tw / 2.0))
    y0 = int(round(cy - th / 2.0))
    x1 = int(round(x0 + tw))
    y1 = int(round(y0 + th))
    if x0 < 0:
        x1 -= x0
        x0 = 0
    if y0 < 0:
        y1 -= y0
        y0 = 0
    if x1 > w:
        shift = x1 - w
        x0 -= shift
        x1 = w
    if y1 > h:
        shift = y1 - h
        y0 -= shift
        y1 = h
    return _clamp_box(x0, y0, x1, y1, w, h)


def _face_portrait_box(
    face: dict,
    w: int,
    h: int,
    top_limit: int | None = None,
    bottom_limit: int | None = None,
) -> tuple[int, int, int, int]:
    """
    Centered portrait: full head contour visible (ear→ear, crown→neck).
    Uses landmark ear box when present. No horizontal OCR shove.
    """
    if face.get("ear_box"):
        x0, y0, x1, y1 = face["ear_box"]
        x0, y0, x1, y1 = float(x0), float(y0), float(x1), float(y1)
    else:
        bx0, by0, bx1, by1 = face["box"]
        fw = max(1, bx1 - bx0)
        fh = max(1, by1 - by0)
        # Expand plain Vision box to cover ears / hair / neck
        x0 = bx0 - fw * 0.18
        x1 = bx1 + fw * 0.18
        y0 = by0 - fh * 0.32
        y1 = by1 + fh * 0.28

    cx = face.get("cx", (x0 + x1) / 2.0)
    cy = face.get("cy", (y0 + y1) / 2.0)
    plate_w = max(8.0, x1 - x0)
    plate_h = max(8.0, y1 - y0)

    # Soft vertical OCR caps only (header / MRZ / CARD No) — shrink symmetrically
    if top_limit is not None and cy - plate_h / 2.0 < top_limit:
        plate_h = max(plate_h * 0.85, 2.0 * max(8.0, cy - top_limit))
    if bottom_limit is not None and cy + plate_h / 2.0 > bottom_limit:
        plate_h = max(plate_h * 0.85, 2.0 * max(8.0, bottom_limit - cy))

    return _box_centered_on(cx, cy, plate_w, plate_h, w, h)


def _subject_content_box(img: Image.Image) -> tuple[int, int, int, int] | None:
    """
    Bounding box of the person vs near-white / flat background inside a crop.
    Used to re-center when the initial plate still has empty margin on one side.
    """
    rgb = img.convert("RGB")
    w, h = rgb.size
    if w < 16 or h < 16:
        return None

    # Downsample for speed
    scale = max(1, max(w, h) // 160)
    sw, sh = max(1, w // scale), max(1, h // scale)
    small = rgb.resize((sw, sh), Image.Resampling.BILINEAR)
    px = small.load()

    # Estimate background from corners
    corners = [
        px[0, 0],
        px[sw - 1, 0],
        px[0, sh - 1],
        px[sw - 1, sh - 1],
    ]
    br = sum(c[0] for c in corners) / 4.0
    bg = sum(c[1] for c in corners) / 4.0
    bb = sum(c[2] for c in corners) / 4.0

    mask = [[False] * sw for _ in range(sh)]
    for y in range(sh):
        for x in range(sw):
            r, g, b = px[x, y]
            # Distance from corner background OR plainly dark/skin vs white
            dist = abs(r - br) + abs(g - bg) + abs(b - bb)
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            if dist > 55 or lum < 210:
                mask[y][x] = True

    # Keep largest connected-ish blob via row/col projection (simple + robust)
    col_hits = [sum(1 for y in range(sh) if mask[y][x]) for x in range(sw)]
    row_hits = [sum(1 for x in range(sw) if mask[y][x]) for y in range(sh)]
    col_thresh = max(2, int(sh * 0.06))
    row_thresh = max(2, int(sw * 0.06))
    cols = [i for i, v in enumerate(col_hits) if v >= col_thresh]
    rows = [i for i, v in enumerate(row_hits) if v >= row_thresh]
    if not cols or not rows:
        return None

    x0 = cols[0] * scale
    x1 = min(w, (cols[-1] + 1) * scale)
    y0 = rows[0] * scale
    y1 = min(h, (rows[-1] + 1) * scale)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    return x0, y0, x1, y1


def _recenter_box_on_subject(
    img: Image.Image, box: tuple[int, int, int, int]
) -> tuple[int, int, int, int]:
    """If crop has empty margin on one side, snap to the subject silhouette."""
    x0, y0, x1, y1 = box
    w, h = img.size
    # Work on a slightly padded region so we can shift
    pad = int(max(x1 - x0, y1 - y0) * 0.15)
    rx0, ry0, rx1, ry1 = _clamp_box(x0 - pad, y0 - pad, x1 + pad, y1 + pad, w, h)
    region = img.crop((rx0, ry0, rx1, ry1))
    sub = _subject_content_box(region)
    if not sub:
        return box
    sx0, sy0, sx1, sy1 = sub
    # Map back to full image
    sx0 += rx0
    sy0 += ry0
    sx1 += rx0
    sy1 += ry0
    sw = sx1 - sx0
    sh = sy1 - sy0
    # Small pad so contour (ears/hair) isn't flush with the edge
    sx0 -= int(sw * 0.06)
    sx1 += int(sw * 0.06)
    sy0 -= int(sh * 0.04)
    sy1 += int(sh * 0.06)
    cx = (sx0 + sx1) / 2.0
    cy = (sy0 + sy1) / 2.0
    # Keep roughly the same output size as the original face crop (don't jump to full plate)
    tw = max(sx1 - sx0, (x1 - x0) * 0.85)
    th = max(sy1 - sy0, (y1 - y0) * 0.85)
    # Prefer subject size when original was too wide (empty side margin)
    if (x1 - x0) > (sx1 - sx0) * 1.25:
        tw = (sx1 - sx0) * 1.08
    if (y1 - y0) > (sy1 - sy0) * 1.35:
        th = (sy1 - sy0) * 1.12
    return _box_centered_on(cx, cy, tw, th, w, h)


def _expand_face_to_photo_plate(
    face: dict,
    w: int,
    h: int,
    kind: str = "id",
    bottom_limit: int | None = None,
    top_limit: int | None = None,
    right_limit: int | None = None,
    left_limit: int | None = None,
) -> tuple[int, int, int, int]:
    # Horizontal OCR limits intentionally unused — they shoved faces off-center
    return _face_portrait_box(
        face,
        w,
        h,
        top_limit=top_limit,
        bottom_limit=bottom_limit,
    )


def _sanitize_limits(
    w: int,
    h: int,
    top_limit: int | None,
    bottom_limit: int | None,
    right_limit: int | None,
    left_limit: int | None,
) -> tuple[int | None, int | None, int | None, int | None]:
    """Drop OCR bounds that would wipe out a left-side photo plate."""
    if top_limit is not None and top_limit > int(h * 0.38):
        top_limit = int(h * 0.18)
    if bottom_limit is not None and bottom_limit < int(h * 0.40):
        bottom_limit = int(h * 0.68)
    if (
        top_limit is not None
        and bottom_limit is not None
        and bottom_limit - top_limit < int(h * 0.28)
    ):
        top_limit = int(h * 0.14)
        bottom_limit = int(h * 0.68)
    if right_limit is not None and right_limit < int(w * 0.22):
        right_limit = int(w * 0.38)
    if left_limit is not None and right_limit is not None and right_limit - left_limit < 50:
        right_limit = max(right_limit, left_limit + int(w * 0.24))
    return top_limit, bottom_limit, right_limit, left_limit


def _fallback_region(
    kind: str,
    w: int,
    h: int,
    bottom_limit: int | None = None,
    top_limit: int | None = None,
    right_limit: int | None = None,
) -> tuple[int, int, int, int]:
    top_limit, bottom_limit, right_limit, _ = _sanitize_limits(
        w, h, top_limit, bottom_limit, right_limit, int(w * 0.02)
    )

    if kind == "passport":
        x0 = int(w * 0.04)
        plate_w = w * 0.26
        y0 = int(top_limit if top_limit is not None else h * 0.16)
        y1 = int(bottom_limit if bottom_limit is not None else h * 0.62)
    else:
        x0 = int(w * 0.04)
        plate_w = w * 0.28
        y0 = int(top_limit if top_limit is not None else h * 0.15)
        y1 = int(bottom_limit if bottom_limit is not None else h * 0.70)

    if y1 <= y0 + 40:
        y0 = int(h * 0.14)
        y1 = int(h * 0.68)

    if right_limit is not None:
        plate_w = min(plate_w, max(int(w * 0.18), right_limit - x0))

    plate_h = y1 - y0
    want_w = plate_h * _PHOTO_ASPECT
    if want_w < plate_w:
        plate_w = want_w
    else:
        plate_h = plate_w / _PHOTO_ASPECT
        y1 = int(y0 + plate_h)
        if (
            bottom_limit is not None
            and y1 > bottom_limit
            and bottom_limit > y0 + 40
        ):
            y1 = bottom_limit
            plate_h = y1 - y0
            plate_w = plate_h * _PHOTO_ASPECT

    x1 = int(x0 + plate_w)
    box = _clamp_box(x0, int(y0), x1, int(y1), w, h)
    cx = (box[0] + box[2]) / 2
    box = _apply_plate_limits(
        box, cx, w, h, top_limit, bottom_limit, right_limit, left_limit=int(w * 0.02)
    )
    bx0, by0, bx1, by1 = box
    if bx1 - bx0 < 24 or by1 - by0 < 24:
        # Limits destroyed the plate — pure geometric left crop
        y0 = int(h * (0.16 if kind == "passport" else 0.15))
        y1 = int(h * (0.62 if kind == "passport" else 0.70))
        pw = min(w * (0.26 if kind == "passport" else 0.28), (y1 - y0) * _PHOTO_ASPECT)
        box = _clamp_box(int(w * 0.04), y0, int(w * 0.04 + pw), y1, w, h)
        return _inset_box(box, w, h, 0.02)

    bh = by1 - by0
    if bh > 40:
        by1 = by0 + int(bh * 0.82)
        box = _apply_plate_limits(
            (bx0, by0, bx1, by1),
            cx,
            w,
            h,
            top_limit,
            bottom_limit,
            right_limit,
            int(w * 0.02),
        )
        bx0, by0, bx1, by1 = box
        if bx1 - bx0 < 24 or by1 - by0 < 24:
            y0 = int(h * 0.15)
            y1 = int(h * 0.68)
            pw = min(w * 0.28, (y1 - y0) * _PHOTO_ASPECT)
            box = _clamp_box(int(w * 0.04), y0, int(w * 0.04 + pw), y1, w, h)
    return _inset_box(box, w, h, 0.02)


def _jpeg_data_url(img: Image.Image, out_h: int = 280) -> str:
    """Resize portrait and pad to ~3:4 so the UI cell shows a centered face."""
    out = img.convert("RGB")
    ow, oh = out.size
    if ow < 1 or oh < 1:
        return ""

    # Pad to portrait aspect with neutral fill (keeps face centered in the cell)
    target_aspect = _PHOTO_ASPECT  # width / height
    cur_aspect = ow / oh
    if abs(cur_aspect - target_aspect) > 0.02:
        if cur_aspect < target_aspect:
            new_w = max(ow, int(round(oh * target_aspect)))
            new_h = oh
        else:
            new_w = ow
            new_h = max(oh, int(round(ow / target_aspect)))
        canvas = Image.new("RGB", (new_w, new_h), (241, 245, 249))
        canvas.paste(out, ((new_w - ow) // 2, (new_h - oh) // 2))
        out = canvas
        ow, oh = out.size

    out_w = max(1, int(round(out_h * (ow / oh))))
    out = out.resize((out_w, out_h), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    out.save(buf, format="JPEG", quality=90, optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


def extract_portrait_data_url(image_bytes: bytes, kind: str = "id") -> str:
    """
    Crop the printed portrait plate → JPEG data URL (vertical ~3:4).
    kind: "id" (front) or "passport".
    """
    if not image_bytes:
        return ""
    try:
        img = Image.open(io.BytesIO(image_bytes))
        img = img.convert("RGB")
    except Exception:
        return ""

    w, h = img.size
    if w < 40 or h < 40:
        return ""

    kind = "passport" if kind == "passport" else "id"
    bottom_limit = None
    top_limit = None
    right_limit = None
    left_limit = int(w * 0.015)

    try:
        anno = _ocr_full_text(image_bytes)
    except Exception:
        anno = None

    if kind == "id":
        top_limit = int(h * 0.14)
        try:
            bottom_limit = _card_no_top_y_from_anno(anno, w, h)
            header_y = _id_header_bottom_y_from_anno(anno, w, h)
            if header_y is not None:
                top_limit = max(top_limit, header_y)
            right_limit = _name_column_left_x_from_anno(anno, w, h, "id")
            if right_limit is None:
                right_limit = int(w * 0.42)
        except Exception:
            right_limit = int(w * 0.42)
    else:
        top_limit = int(h * 0.12)
        bottom_limit = int(h * 0.64)
        right_limit = int(w * 0.38)
        try:
            header_y = _passport_header_bottom_y(anno, w, h)
            if header_y is not None:
                top_limit = max(top_limit, header_y)
            mrz_y = _passport_mrz_top_y(anno, w, h)
            if mrz_y is not None:
                bottom_limit = min(bottom_limit, mrz_y)
            name_x = _name_column_left_x_from_anno(anno, w, h, "passport")
            if name_x is not None:
                right_limit = min(right_limit, name_x)
        except Exception:
            pass

    top_limit, bottom_limit, right_limit, left_limit = _sanitize_limits(
        w, h, top_limit, bottom_limit, right_limit, left_limit
    )

    box = None
    try:
        faces = _faces_from_vision(image_bytes)
        face = _pick_face(faces, w, h, kind)
        if face:
            box = _expand_face_to_photo_plate(
                face,
                w,
                h,
                kind=kind,
                bottom_limit=bottom_limit,
                top_limit=top_limit,
            )
    except Exception:
        box = None

    if not box:
        box = _fallback_region(
            kind,
            w,
            h,
            bottom_limit=bottom_limit,
            top_limit=top_limit,
            right_limit=right_limit,
        )

    x0, y0, x1, y1 = box
    if x1 - x0 < 20 or y1 - y0 < 20:
        box = _fallback_region(kind, w, h)
        x0, y0, x1, y1 = box

    if x1 - x0 < 20 or y1 - y0 < 20:
        return ""

    try:
        # Re-center on the actual head if empty margin remains on one side
        box = _recenter_box_on_subject(img, (x0, y0, x1, y1))
        x0, y0, x1, y1 = box
        if x1 - x0 < 20 or y1 - y0 < 20:
            return ""
        crop = img.crop((x0, y0, x1, y1))
        return _jpeg_data_url(crop)
    except Exception:
        return ""
