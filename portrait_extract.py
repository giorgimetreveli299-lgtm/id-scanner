"""
Extract the printed portrait plate from Georgian ID (front) or passport data page.

Target region (ID): the color photo rectangle above «ბარათის № / CARD No»,
below the title strip («პირადობის მოწმობა» + icons).
Primary: Vision face → expand to ID photo aspect (~3:4).
Assist: OCR title / CARD labels as top & bottom edges of the plate.
Fallback: fixed left-side plate region.
"""
from __future__ import annotations

import base64
import io
import re

from google.cloud import vision
from PIL import Image

import id_verifier as idv

# Georgian ID / passport printed photo is taller than wide
_PHOTO_ASPECT = 3 / 4  # width / height


def _faces_from_vision(image_bytes: bytes) -> list[tuple[int, int, int, int]]:
    client = idv._get_vision_client()
    image = vision.Image(content=image_bytes)
    response = client.face_detection(image=image)
    if response.error.message:
        return []
    boxes = []
    for face in response.face_annotations or []:
        verts = face.bounding_poly.vertices
        if not verts:
            continue
        xs = [int(v.x or 0) for v in verts]
        ys = [int(v.y or 0) for v in verts]
        if not xs or not ys:
            continue
        boxes.append((min(xs), min(ys), max(xs), max(ys)))
    return boxes


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
    """
    Y of the top of «ბარათის / CARD No» label — photo plate sits just above it.
    Only look in the left half of the document.
    """
    if not anno:
        return None

    label_re = re.compile(r"ბარათ|card\s*n|card\s*№|card\s*#|cardno", re.I)
    candidates: list[int] = []
    for word, _pw, _ph in idv._iter_words(anno):
        text = "".join(s.text for s in word.symbols if getattr(s, "text", None)).strip()
        if not text or not label_re.search(text):
            continue
        x0, y0, x1, y1 = idv._word_bbox(word)
        cx = (x0 + x1) / 2
        if cx > w * 0.55:
            continue
        candidates.append(int(y0))

    if not candidates:
        blob = (anno.text or "").lower()
        if "ბარათ" not in blob and "card" not in blob:
            return None
        for word, _pw, _ph in idv._iter_words(anno):
            text = "".join(s.text for s in word.symbols if getattr(s, "text", None)).strip().lower()
            if "card" in text or "ბარათ" in text or "№" in text:
                x0, y0, x1, y1 = idv._word_bbox(word)
                if (x0 + x1) / 2 <= w * 0.55:
                    candidates.append(int(y0))

    if not candidates:
        return None
    y = min(candidates)
    return max(0, y - int(h * 0.01))


def _id_header_bottom_y_from_anno(anno, w: int, h: int) -> int | None:
    """
    Bottom of the ID title strip («პირადობის მოწმობა» + orange icons).
    Portrait must start below this so chrome never appears in the crop.
    """
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
        # Title lives in the top band of the card
        if y0 > h * 0.28:
            continue
        bottoms.append(int(y1))

    if not bottoms:
        return None
    # Small pad under the title / icon row
    return min(h - 1, max(bottoms) + int(h * 0.012))


def _box_area(b: tuple[int, int, int, int]) -> int:
    return max(0, b[2] - b[0]) * max(0, b[3] - b[1])


def _pick_face(
    boxes: list[tuple[int, int, int, int]], w: int, h: int
) -> tuple[int, int, int, int] | None:
    if not boxes:
        return None
    left = [b for b in boxes if (b[0] + b[2]) / 2 < w * 0.55]
    pool = left or boxes
    return max(pool, key=_box_area)


def _clamp_box(x0: int, y0: int, x1: int, y1: int, w: int, h: int) -> tuple[int, int, int, int]:
    x0 = max(0, min(x0, w - 1))
    y0 = max(0, min(y0, h - 1))
    x1 = max(x0 + 1, min(x1, w))
    y1 = max(y0 + 1, min(y1, h))
    return x0, y0, x1, y1


def _fit_aspect(
    cx: float, cy: float, target_w: float, target_h: float, w: int, h: int
) -> tuple[int, int, int, int]:
    """Center (cx,cy) box of size target_w×target_h, clipped to image."""
    tw = min(target_w, w)
    th = min(target_h, h)
    # Preserve aspect if clipped
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


def _apply_vertical_limits(
    box: tuple[int, int, int, int],
    cx: float,
    w: int,
    h: int,
    top_limit: int | None,
    bottom_limit: int | None,
) -> tuple[int, int, int, int]:
    """Keep plate between header and CARD No; re-fit ~3:4 width."""
    bx0, by0, bx1, by1 = box
    if top_limit is not None and by0 < top_limit:
        by0 = top_limit
    if bottom_limit is not None and bottom_limit > by0 + 40:
        by1 = min(by1, bottom_limit)
    new_h = by1 - by0
    if new_h < 20:
        return _clamp_box(bx0, by0, bx1, by1, w, h)
    new_w = new_h * _PHOTO_ASPECT
    bx0 = int(round(cx - new_w / 2))
    bx1 = int(round(bx0 + new_w))
    return _clamp_box(bx0, by0, bx1, by1, w, h)


def _expand_face_to_photo_plate(
    face: tuple[int, int, int, int],
    w: int,
    h: int,
    bottom_limit: int | None = None,
    top_limit: int | None = None,
) -> tuple[int, int, int, int]:
    """
    Expand face bbox to a vertical ID photo plate (head + upper shoulders),
    below the title strip and above CARD No.
    """
    x0, y0, x1, y1 = face
    fw = max(1, x1 - x0)
    fh = max(1, y1 - y0)
    cx = (x0 + x1) / 2

    # Plate width ≈ 1.55× face width; height from aspect
    plate_w = max(fw * 1.55, w * 0.22)
    plate_h = plate_w / _PHOTO_ASPECT
    # Need enough height for forehead + shoulders
    plate_h = max(plate_h, fh * 2.2)
    plate_w = plate_h * _PHOTO_ASPECT

    # Face slightly higher in the plate → less pull into the ID header
    cy = y0 + fh * 0.48
    # Never start more than ~28% of face height above the forehead
    min_top = int(y0 - fh * 0.28)
    if top_limit is not None:
        min_top = max(min_top, top_limit)

    box = _fit_aspect(cx, cy, plate_w, plate_h, w, h)
    bx0, by0, bx1, by1 = box
    if by0 < min_top:
        by0 = min_top
        box = (bx0, by0, bx1, by1)

    return _apply_vertical_limits(box, cx, w, h, top_limit, bottom_limit)


def _fallback_region(
    kind: str,
    w: int,
    h: int,
    bottom_limit: int | None = None,
    top_limit: int | None = None,
) -> tuple[int, int, int, int]:
    """Left-side photo plate without CARD No / header chrome."""
    if kind == "passport":
        x0 = int(w * 0.05)
        plate_w = w * 0.28
        y0 = int(h * 0.18)
        y1 = int(h * 0.68)
    else:
        # ID: photo under header, above CARD No
        x0 = int(w * 0.045)
        plate_w = w * 0.30
        y0 = int(top_limit if top_limit is not None else h * 0.16)
        y1 = int(bottom_limit if bottom_limit else h * 0.72)

    plate_h = y1 - y0
    # Enforce ~3:4
    want_w = plate_h * _PHOTO_ASPECT
    if want_w < plate_w:
        plate_w = want_w
    else:
        plate_h = plate_w / _PHOTO_ASPECT
        y1 = int(y0 + plate_h)
        if bottom_limit and y1 > bottom_limit:
            y1 = bottom_limit
            plate_h = y1 - y0
            plate_w = plate_h * _PHOTO_ASPECT

    x1 = int(x0 + plate_w)
    box = _clamp_box(x0, y0, x1, y1, w, h)
    cx = (box[0] + box[2]) / 2
    return _apply_vertical_limits(box, cx, w, h, top_limit, bottom_limit)


def _jpeg_data_url(img: Image.Image, out_h: int = 280) -> str:
    """Resize keeping aspect; default height ~280px (ID photo style)."""
    out = img.convert("RGB")
    ow, oh = out.size
    if oh > 0:
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

    bottom_limit = None
    top_limit = None
    if kind == "id":
        # Geometric floor so title/icons never leak in even without OCR
        top_limit = int(h * 0.13)
        try:
            anno = _ocr_full_text(image_bytes)
            bottom_limit = _card_no_top_y_from_anno(anno, w, h)
            header_y = _id_header_bottom_y_from_anno(anno, w, h)
            if header_y is not None:
                top_limit = max(top_limit, header_y)
        except Exception:
            bottom_limit = None

    box = None
    # Passport: skip extra Face API call (OCR already ran) — geometric plate only.
    # ID: face + header / CARD No edges when available.
    if kind == "id":
        try:
            faces = _faces_from_vision(image_bytes)
            face = _pick_face(faces, w, h)
            if face:
                box = _expand_face_to_photo_plate(
                    face, w, h, bottom_limit=bottom_limit, top_limit=top_limit
                )
        except Exception:
            box = None

    if not box:
        box = _fallback_region(
            kind, w, h, bottom_limit=bottom_limit, top_limit=top_limit
        )

    x0, y0, x1, y1 = box
    if x1 - x0 < 20 or y1 - y0 < 20:
        return ""

    try:
        crop = img.crop((x0, y0, x1, y1))
        return _jpeg_data_url(crop)
    except Exception:
        return ""
