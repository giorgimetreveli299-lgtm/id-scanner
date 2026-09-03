"""Driver license OCR via Node scan script (lib/vision.ts)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from id_verifier import ocr_image

BASE_DIR = Path(__file__).resolve().parent
SCAN_SCRIPT = BASE_DIR / "scripts" / "scan-license.ts"
VALIDATE_SIDE_SCRIPT = BASE_DIR / "scripts" / "validate-license-side.ts"
TSX_CLI = BASE_DIR / "node_modules" / "tsx" / "dist" / "cli.mjs"

_DISPLAY_KEYS = (
    "surname_geo",
    "givenNames_geo",
    "dateOfBirth",
    "licenseNumber",
    "personalNumber",
)


def _node_tsx_cmd(script: Path) -> list[str]:
    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        raise RuntimeError("node not found - run npm install for driver license scanning")
    if not TSX_CLI.is_file():
        raise RuntimeError("tsx not found - run npm install in the project root")
    return [node, str(TSX_CLI), str(script)]


def _scan_cmd() -> list[str]:
    return _node_tsx_cmd(SCAN_SCRIPT)


def _parse_json_stdout(stdout: str) -> dict:
    """Parse JSON from stdout (ignore npm noise on other lines)."""
    text = (stdout or "").strip()
    if not text:
        raise json.JSONDecodeError("empty stdout", text, 0)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            return json.loads(line)
    raise json.JSONDecodeError("no JSON object in stdout", text, 0)


def _display_filled(display: dict | None) -> int:
    if not display:
        return 0
    return sum(1 for key in _DISPLAY_KEYS if display.get(key))


def _scan_env() -> dict[str, str]:
    env = os.environ.copy()
    env.setdefault("NODE_OPTIONS", "--enable-source-maps")
    env.setdefault("LICENSE_RELAX_SIDES", "1")
    # Node subprocess must emit/read UTF-8 (Georgian field text).
    env.setdefault("PYTHONIOENCODING", "utf-8")
    creds = BASE_DIR / "clientdocsocr.json"
    if creds.is_file():
        env.setdefault("GOOGLE_APPLICATION_CREDENTIALS", str(creds))
    return env


def _run_node_scan(
    front_path: Path,
    back_path: Path,
    *,
    front_text: str | None = None,
    back_text: str | None = None,
) -> dict:
    env = _scan_env()
    if front_text:
        env["LICENSE_FRONT_TEXT"] = front_text
    if back_text:
        env["LICENSE_BACK_TEXT"] = back_text

    proc = subprocess.run(
        _scan_cmd() + [str(front_path), str(back_path)],
        cwd=str(BASE_DIR),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        env=env,
    )

    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()

    if not stdout:
        detail = stderr or f"scan exited with code {proc.returncode}"
        return {"ok": False, "error": detail, "extracted_data": {}, "display": {}}

    try:
        data = _parse_json_stdout(stdout)
    except json.JSONDecodeError:
        detail = stderr or stdout[:500] or "Invalid scan output"
        return {
            "ok": False,
            "error": detail,
            "extracted_data": {},
            "display": {},
        }

    if not data.get("ok"):
        return {
            "ok": False,
            "error": data.get("error") or "License scan failed",
            "extracted_data": data.get("fields") or {},
            "display": data.get("display") or {},
        }

    return {
        "ok": True,
        "extracted_data": data.get("fields") or {},
        "display": data.get("display") or {},
        "qr_code_value": data.get("qrCodeValue"),
        "holder_photo_data_url": data.get("holderPhotoDataUrl"),
        "holder_signature_data_url": data.get("holderSignatureDataUrl"),
        "qr_code_data_url": data.get("qrCodeDataUrl"),
    }


def validate_license_side(image_bytes: bytes, side: str) -> dict:
    """Reject front uploads with QR (back side) and back uploads without QR."""
    side_norm = (side or "").strip().lower()
    if side_norm not in ("front", "back"):
        return {"ok": False, "error": "side must be front or back", "side": side_norm}

    with tempfile.TemporaryDirectory() as tmp:
        image_path = Path(tmp) / "capture.jpg"
        image_path.write_bytes(image_bytes)

        proc = subprocess.run(
            _node_tsx_cmd(VALIDATE_SIDE_SCRIPT) + [side_norm, str(image_path)],
            cwd=str(BASE_DIR),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=90,
            env=_scan_env(),
        )

        stdout = (proc.stdout or "").strip()
        if not stdout:
            detail = (proc.stderr or "").strip() or f"validate exited with code {proc.returncode}"
            return {"ok": False, "error": detail, "side": side_norm}

        try:
            data = _parse_json_stdout(stdout)
        except json.JSONDecodeError:
            detail = (proc.stderr or stdout[:500] or "Invalid validate output").strip()
            return {"ok": False, "error": detail, "side": side_norm}

        data.setdefault("side", side_norm)
        return data


def extract_license_info(front_bytes: bytes, back_bytes: bytes) -> dict:
    """Run license OCR; returns parsed JSON dict."""
    with tempfile.TemporaryDirectory() as tmp:
        td = Path(tmp)
        front = td / "front.jpg"
        back = td / "back.jpg"
        front.write_bytes(front_bytes)
        back.write_bytes(back_bytes)

        primary = _run_node_scan(front, back)
        if primary.get("ok") and _display_filled(primary.get("display")) >= 2:
            return primary

        # Fallback: Python Vision OCR (same path as ID / passport) + Node parse/QR/crops
        try:
            front_text, _, _ = ocr_image(front_bytes)
            back_text, _, _ = ocr_image(back_bytes)
        except Exception as exc:
            if primary.get("ok"):
                return primary
            err = primary.get("error") or str(exc)
            return {
                "ok": False,
                "error": err,
                "extracted_data": primary.get("extracted_data") or {},
                "display": primary.get("display") or {},
            }

        if not front_text and not back_text:
            if primary.get("ok"):
                return primary
            return {
                "ok": False,
                "error": primary.get("error")
                or "Could not read any text from the photos.",
                "extracted_data": primary.get("extracted_data") or {},
                "display": primary.get("display") or {},
            }

        fallback = _run_node_scan(
            front,
            back,
            front_text=front_text or None,
            back_text=back_text or None,
        )
        if fallback.get("ok"):
            return fallback

        if primary.get("ok"):
            return primary

        return {
            "ok": False,
            "error": fallback.get("error") or primary.get("error") or "License scan failed",
            "extracted_data": fallback.get("extracted_data")
            or primary.get("extracted_data")
            or {},
            "display": fallback.get("display") or primary.get("display") or {},
        }
