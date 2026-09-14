"""Car photo angle checks via Google Vision labels + object localization."""

from __future__ import annotations

import re

from google.cloud import vision

from id_verifier import _get_vision_face_client

CAR_FRONT_ERROR = "Please upload the front of the car"
CAR_PHOTO_GENERIC_ERROR = "Please upload a clear car photo"
CAR_DOCUMENT_ERROR = "Please upload a car photo, not a document"

_CAR_LABELS = {
    "car",
    "vehicle",
    "automobile",
    "motor vehicle",
    "sedan",
    "hatchback",
    "suv",
    "coupe",
    "wagon",
    "van",
    "truck",
    "jeep",
    "crossover",
}

# Close-up / cabin subjects that are still vehicle-related
_DETAIL_LABELS = {
    "engine",
    "auto part",
    "automotive design",
    "motor",
    "vehicle",
    "car",
    "tire",
    "wheel",
    "dashboard",
    "speedometer",
    "odometer",
    "gauge",
    "steering wheel",
    "gear shift",
    "transmission",
    "interior design",
    "car seat",
    "seat belt",
    "console",
    "hood",
}

_REJECT_DOC_LABELS = {
    "document",
    "paper",
    "screenshot",
    "passport",
    "identity document",
    "driver's license",
    "driving licence",
    "id",
    "receipt",
    "menu",
    "poster",
    "book",
    "business card",
    "handwriting",
    "letter",
}

_CAR_OBJECTS = {"car", "vehicle", "truck", "bus", "van", "automobile"}

_EXTERIOR = {"front", "rear", "left", "right"}
_DETAIL = {
    "engine",
    "front-seat",
    "back-seat",
    "interior",
    "gearbox",
    "vin",
    "odometer",
}
_ALL_ANGLES = _EXTERIOR | _DETAIL

_MRZ_RE = re.compile(
    r"(?:IDGEO|TRGEO|P<[A-Z]{3}|I<[A-Z]{3}|<{4,}|[A-Z0-9]<{2,}[A-Z0-9<]{20,})",
    re.I,
)
_DOC_TEXT_CUES = re.compile(
    r"(?:passport|identity\s*card|id\s*card|driver'?s?\s*licen[cs]e|"
    r"მოქალაქის\s*პირადობა|პასპორტი|მართვის\s*მოწმობა|"
    r"ტექპასპორტი|tech\s*passport|registration\s*certificate)",
    re.I,
)


def _error_for_angle(angle: str, *, document: bool = False) -> str:
    if document:
        return CAR_DOCUMENT_ERROR
    if angle == "front":
        return CAR_FRONT_ERROR
    return CAR_PHOTO_GENERIC_ERROR


def _label_map(response) -> dict[str, float]:
    out: dict[str, float] = {}
    for ann in response.label_annotations or []:
        name = (ann.description or "").strip().lower()
        if not name:
            continue
        score = float(ann.score or 0)
        out[name] = max(out.get(name, 0.0), score)
    return out


def _object_boxes(response) -> list[dict]:
    boxes = []
    for obj in response.localized_object_annotations or []:
        name = (obj.name or "").strip().lower()
        score = float(obj.score or 0)
        verts = list(obj.bounding_poly.normalized_vertices or [])
        if len(verts) < 2:
            continue
        xs = [float(v.x or 0) for v in verts]
        ys = [float(v.y or 0) for v in verts]
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        w = max(0.0, max_x - min_x)
        h = max(0.0, max_y - min_y)
        boxes.append(
            {
                "name": name,
                "score": score,
                "area": w * h,
                "aspect": w / h if h > 1e-6 else 99.0,
                "cx": (min_x + max_x) / 2,
                "cy": (min_y + max_y) / 2,
                "w": w,
                "h": h,
            }
        )
    return boxes


def _ocr_text(response) -> str:
    full = response.full_text_annotation
    if full and full.text:
        return str(full.text)
    texts = []
    for ann in response.text_annotations or []:
        if ann.description:
            texts.append(str(ann.description))
            break
    return "\n".join(texts)


def _has_car_signal(labels: dict[str, float], boxes: list[dict]) -> bool:
    if any(lab in _CAR_LABELS and sc >= 0.45 for lab, sc in labels.items()):
        return True
    if any(
        b["name"] in _CAR_OBJECTS and b["score"] >= 0.35 and b["area"] >= 0.08
        for b in boxes
    ):
        return True
    for lab, sc in labels.items():
        if sc < 0.5:
            continue
        if "car" in lab or "vehicle" in lab or "automobile" in lab:
            return True
    return False


def _has_detail_signal(labels: dict[str, float], boxes: list[dict]) -> bool:
    if _has_car_signal(labels, boxes):
        return True
    if any(lab in _DETAIL_LABELS and sc >= 0.40 for lab, sc in labels.items()):
        return True
    for lab, sc in labels.items():
        if sc < 0.45:
            continue
        if any(
            key in lab
            for key in (
                "engine",
                "dashboard",
                "odometer",
                "speedometer",
                "gear",
                "transmission",
                "interior",
                "steering",
                "seat",
                "gauge",
                "motor",
            )
        ):
            return True
    return False


def _best_car_box(boxes: list[dict]) -> dict | None:
    cars = [
        b
        for b in boxes
        if b["name"] in _CAR_OBJECTS and b["score"] >= 0.3 and b["area"] >= 0.06
    ]
    if not cars:
        return None
    return max(cars, key=lambda b: b["area"] * b["score"])


def _looks_like_document(
    labels: dict[str, float],
    boxes: list[dict],
    text: str,
    *,
    has_vehicle_context: bool,
) -> bool:
    """True when the image is an ID / passport / license / paper doc."""
    if _MRZ_RE.search(text or "") or _DOC_TEXT_CUES.search(text or ""):
        return True

    strong_doc = any(labels.get(name, 0) >= 0.55 for name in _REJECT_DOC_LABELS)
    if strong_doc and not has_vehicle_context:
        return True

    # Identity docs often have a dominant "Person" / face object without a car
    personish = any(
        b["name"] in {"person", "face"} and b["score"] >= 0.4 and b["area"] >= 0.05
        for b in boxes
    )
    docish_label = max(
        labels.get("document", 0),
        labels.get("passport", 0),
        labels.get("identity document", 0),
        labels.get("driver's license", 0),
        labels.get("paper", 0),
    )
    if personish and docish_label >= 0.40 and not has_vehicle_context:
        return True

    # Dense OCR on a flat document (IDs/passports) without vehicle context
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    if len(lines) >= 8 and not has_vehicle_context and docish_label >= 0.35:
        return True

    return False


def validate_car_photo_angle(image_bytes: bytes, angle: str) -> dict:
    """
    Validate a car-photo-guide capture.

    - All angles: reject ID / passport / license / paper documents
    - front: frontal vehicle framing
    - rear / left / right: require a car subject
    - engine / front-seat / back-seat / gearbox / vin / odometer: require vehicle-detail cues
    """
    angle_norm = (angle or "").strip().lower().replace("car-", "")
    # Normalize underscore variants from clients
    angle_norm = angle_norm.replace("_", "-")
    if angle_norm == "interior":
        angle_norm = "front-seat"
    if angle_norm not in _ALL_ANGLES:
        return {"ok": False, "error": "Unknown car photo angle", "angle": angle_norm}

    try:
        client = _get_vision_face_client()
        image = vision.Image(content=image_bytes)
        response = client.annotate_image(
            {
                "image": image,
                "features": [
                    {"type_": vision.Feature.Type.LABEL_DETECTION, "max_results": 25},
                    {
                        "type_": vision.Feature.Type.OBJECT_LOCALIZATION,
                        "max_results": 20,
                    },
                    {"type_": vision.Feature.Type.TEXT_DETECTION, "max_results": 20},
                ],
            }
        )
        if response.error.message:
            print("car photo vision error:", ascii(response.error.message))
            return {
                "ok": False,
                "error": _error_for_angle(angle_norm),
                "angle": angle_norm,
                "api_error": True,
            }

        labels = _label_map(response)
        boxes = _object_boxes(response)
        text = _ocr_text(response)
        has_car = _has_car_signal(labels, boxes)
        has_detail = _has_detail_signal(labels, boxes)
        vehicle_context = has_car or (angle_norm in _DETAIL and has_detail)
        best = _best_car_box(boxes)

        if _looks_like_document(
            labels, boxes, text, has_vehicle_context=vehicle_context
        ):
            return {
                "ok": False,
                "error": CAR_DOCUMENT_ERROR,
                "angle": angle_norm,
                "reason": "document",
            }

        if angle_norm == "front":
            if not has_car:
                return {
                    "ok": False,
                    "error": CAR_FRONT_ERROR,
                    "angle": angle_norm,
                    "reason": "no_car",
                }
            if best:
                if best["aspect"] > 2.45:
                    return {
                        "ok": False,
                        "error": CAR_FRONT_ERROR,
                        "angle": angle_norm,
                        "reason": "looks_like_side",
                        "aspect": round(best["aspect"], 3),
                    }
                if best["area"] < 0.10:
                    return {
                        "ok": False,
                        "error": CAR_FRONT_ERROR,
                        "angle": angle_norm,
                        "reason": "car_too_small",
                        "area": round(best["area"], 3),
                    }
                if best["cx"] < 0.18 or best["cx"] > 0.82:
                    return {
                        "ok": False,
                        "error": CAR_FRONT_ERROR,
                        "angle": angle_norm,
                        "reason": "not_centered",
                    }
            tire = max(
                labels.get("tire", 0),
                labels.get("wheel", 0),
                labels.get("alloy wheel", 0),
            )
            if tire >= 0.75 and (not best or best["area"] < 0.18):
                return {
                    "ok": False,
                    "error": CAR_FRONT_ERROR,
                    "angle": angle_norm,
                    "reason": "tire_closeup",
                }
            return {
                "ok": True,
                "angle": angle_norm,
                "has_car": True,
                "aspect": round(best["aspect"], 3) if best else None,
                "area": round(best["area"], 3) if best else None,
            }

        if angle_norm in _EXTERIOR:
            if not has_car:
                return {
                    "ok": False,
                    "error": CAR_PHOTO_GENERIC_ERROR,
                    "angle": angle_norm,
                    "reason": "no_car",
                }
            return {"ok": True, "angle": angle_norm, "has_car": True}

        # Detail angles: reject plain documents / unrelated junk
        if not has_detail:
            return {
                "ok": False,
                "error": CAR_PHOTO_GENERIC_ERROR,
                "angle": angle_norm,
                "reason": "no_vehicle_detail",
            }
        return {"ok": True, "angle": angle_norm, "has_detail": True}

    except Exception as exc:
        print("car photo validate error:", ascii(str(exc)))
        return {
            "ok": False,
            "error": _error_for_angle(angle_norm),
            "angle": angle_norm,
            "exception": True,
        }
