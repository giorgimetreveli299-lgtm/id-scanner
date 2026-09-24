"""Shared car-photo sessions for every computer that opens the site.

The counter and the photos live in one private Cloud Storage bucket, so two
PCs cannot receive the same session number and a phone can open the same
session the office computer just created.
"""

from __future__ import annotations

import json
import os
import secrets
from typing import Callable

from google.api_core.exceptions import PreconditionFailed
from google.cloud import storage

BUCKET_NAME = os.environ.get("CAR_SESSION_BUCKET", "dizige-car-sessions")
COUNTER_PATH = "car-sessions/counter.txt"

_client: storage.Client | None = None


class SessionLocked(Exception):
    """The session already has every required photo."""


def _bucket() -> storage.Bucket:
    global _client
    if _client is None:
        _client = storage.Client()
    return _client.bucket(BUCKET_NAME)


def _counter_blob() -> storage.Blob:
    return _bucket().blob(COUNTER_PATH)


def _meta_blob(session_id: int) -> storage.Blob:
    return _bucket().blob(f"car-sessions/{int(session_id)}/meta.json")


def _slot_prefix(session_id: int, slot_id: str) -> str:
    return f"car-sessions/{int(session_id)}/slots/{slot_id}."


def new_session_token() -> str:
    return secrets.token_urlsafe(18)


def _max_stored_session_id() -> int:
    """Highest session folder already in the bucket. Used only if the counter file is missing."""
    highest = 0
    for item in _bucket().list_blobs(prefix="car-sessions/"):
        part = item.name.split("/")
        if len(part) >= 2 and part[1].isdigit():
            highest = max(highest, int(part[1]))
    return highest


def read_last_id() -> int:
    """Last allocated id. A missing counter file continues after sessions already stored."""
    blob = _counter_blob()
    if not blob.exists():
        return _max_stored_session_id()
    blob.reload()
    try:
        return int((blob.download_as_text() or "0").strip() or "0")
    except ValueError:
        return _max_stored_session_id()


def allocate_id() -> int:
    """Atomically take the next id. Safe across computers and server instances."""
    blob = _counter_blob()
    for _ in range(12):
        if not blob.exists():
            nxt = _max_stored_session_id() + 1
            try:
                blob.upload_from_string(
                    str(nxt),
                    content_type="text/plain",
                    if_generation_match=0,
                )
                return nxt
            except PreconditionFailed:
                continue
        blob.reload()
        try:
            current = int((blob.download_as_text() or "0").strip() or "0")
        except ValueError:
            current = _max_stored_session_id()
        nxt = current + 1
        try:
            blob.upload_from_string(
                str(nxt),
                content_type="text/plain",
                if_generation_match=blob.generation,
            )
            return nxt
        except PreconditionFailed:
            continue
    raise RuntimeError("shared session counter is busy")


def read_meta(session_id: int) -> dict | None:
    blob = _meta_blob(session_id)
    if not blob.exists():
        return None
    blob.reload()
    try:
        data = json.loads(blob.download_as_text())
    except (json.JSONDecodeError, UnicodeError):
        return None
    return data if isinstance(data, dict) else None


def mutate_meta(session_id: int, default_meta: dict, fn: Callable[[dict], dict]) -> dict:
    """Read-modify-write session meta. Retries if another computer wrote first."""
    blob = _meta_blob(session_id)
    for _ in range(8):
        if blob.exists():
            blob.reload()
            try:
                current = json.loads(blob.download_as_text())
            except (json.JSONDecodeError, UnicodeError):
                current = dict(default_meta)
            if not isinstance(current, dict):
                current = dict(default_meta)
            generation = blob.generation
        else:
            current = dict(default_meta)
            generation = 0
        updated = fn(dict(current))
        updated["id"] = int(session_id)
        updated["revision"] = int(current.get("revision") or 0) + 1
        try:
            blob.upload_from_string(
                json.dumps(updated, ensure_ascii=False),
                content_type="application/json",
                if_generation_match=generation,
            )
            return updated
        except PreconditionFailed:
            continue
    raise RuntimeError("shared session meta is busy")


def write_slot(session_id: int, slot_id: str, ext: str, raw: bytes, content_type: str) -> str:
    """Replace one slot's file. Returns the stored filename."""
    filename = f"{slot_id}{ext}"
    bucket = _bucket()
    for old in bucket.list_blobs(prefix=_slot_prefix(session_id, slot_id)):
        if old.name != f"car-sessions/{int(session_id)}/slots/{filename}":
            old.delete()
    dest = bucket.blob(f"car-sessions/{int(session_id)}/slots/{filename}")
    dest.upload_from_string(raw, content_type=content_type or "application/octet-stream")
    return filename


def delete_slot(session_id: int, slot_id: str) -> None:
    for old in _bucket().list_blobs(prefix=_slot_prefix(session_id, slot_id)):
        old.delete()


def read_slot(session_id: int, filename: str) -> bytes | None:
    blob = _bucket().blob(f"car-sessions/{int(session_id)}/slots/{filename}")
    if not blob.exists():
        return None
    return blob.download_as_bytes()
