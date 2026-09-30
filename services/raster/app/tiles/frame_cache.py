"""Disk cache of encoded timelapse frames.

A frame is the expensive product: five remote COGs read, warped, calibrated
and masked. Its bytes are immutable for a given key -- the key covers every
input that can change a pixel, including the processing version -- so a
replayed or scrubbed timelapse is served from local disk instead of from
S3 across an ocean.

Bounded by file count with oldest-first eviction. Writes go to a temporary
name and are renamed into place, so a reader never sees a half-written frame.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

CACHE_DIR = Path(os.environ.get("FRAME_CACHE_DIR", Path(tempfile.gettempdir()) / "terrascope-frames"))
#: ~500 frames of up to 8 MiB is a few GB at worst; typical frames are smaller.
MAX_FILES = int(os.environ.get("FRAME_CACHE_MAX_FILES", "500"))


def frame_key(parts: dict[str, Any]) -> str:
    raw = json.dumps(parts, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def get(key: str) -> bytes | None:
    path = CACHE_DIR / f"{key}.eot1"
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def put(key: str, blob: bytes) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    final = CACHE_DIR / f"{key}.eot1"
    fd, temp = tempfile.mkstemp(dir=CACHE_DIR, suffix=".part")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(blob)
        os.replace(temp, final)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise
    _evict()


def _evict() -> None:
    entries = sorted(CACHE_DIR.glob("*.eot1"), key=lambda p: p.stat().st_mtime)
    for stale in entries[: max(0, len(entries) - MAX_FILES)]:
        stale.unlink(missing_ok=True)
