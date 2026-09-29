"""EOT1 numeric tile container.

Layout (see packages/contracts/src/types.ts for the normative description):

    [0..4)     magic b'EOT1'
    [4..8)     uint32 LE  length of the JSON header in bytes
    [8..8+n)   UTF-8 JSON header, zero padded to a 4-byte boundary
    payload    planar little-endian float32 arrays in declared order,
               followed by uint8 validity masks

Bands carry calibrated surface reflectance. The protocol is deliberately
independent of display colour: the browser decides how to render numbers.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

import numpy as np

MAGIC = b"EOT1"
HEADER_ALIGN = 4
#: Refuse absurd payloads before allocating anything on the client's behalf.
MAX_TILE_BYTES = 8 * 1024 * 1024
#: Refuse absurd headers before parsing into Python objects.
MAX_HEADER_BYTES = 64 * 1024

PROTOCOL = "EOT1"
PROCESSING_VERSION = "eot-1"


class Eot1Error(ValueError):
    """Raised when a tile cannot be encoded within declared bounds."""


@dataclass(frozen=True)
class BandSpec:
    name: str
    array: np.ndarray  # float32, shape (height, width)


@dataclass(frozen=True)
class MaskSpec:
    name: str
    array: np.ndarray  # uint8, shape (height, width); 1 = valid


@dataclass
class Eot1Tile:
    width: int
    height: int
    bands: list[BandSpec] = field(default_factory=list)
    masks: list[MaskSpec] = field(default_factory=list)
    grid: dict[str, Any] = field(default_factory=dict)
    bounds: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0)
    calibrated: bool = True
    sources: dict[str, Any] = field(default_factory=dict)
    calibration: dict[str, Any] = field(default_factory=dict)
    attribution: str = ""
    processing_version: str = PROCESSING_VERSION


def _align4(n: int) -> int:
    return (n + HEADER_ALIGN - 1) & ~(HEADER_ALIGN - 1)


def encode(tile: Eot1Tile) -> bytes:
    """Serialise a tile to EOT1 bytes.

    Applies calibration metadata but never mutates the caller's arrays: band
    values are assumed to already be calibrated by the provider adapter, and
    ``calibrated`` is declared so the client can detect double application.
    """
    if tile.width <= 0 or tile.height <= 0:
        raise Eot1Error(f"invalid tile size {tile.width}x{tile.height}")
    expected = tile.width * tile.height

    band_layouts: list[dict[str, Any]] = []
    mask_layouts: list[dict[str, Any]] = []
    payloads: list[bytes] = []

    offset = 0
    for band in tile.bands:
        arr = np.ascontiguousarray(band.array, dtype=np.float32)
        if arr.shape != (tile.height, tile.width):
            raise Eot1Error(
                f"band {band.name!r} has shape {arr.shape}, expected "
                f"{(tile.height, tile.width)}"
            )
        # NaN is the intended out-of-band signal and survives to the client.
        # Inf never is: it propagates through every downstream index and there
        # is no legitimate way for a calibrated reflectance to reach it.
        if np.isinf(arr).any():
            raise Eot1Error(f"band {band.name!r} contains infinite values")
        raw = arr.tobytes(order="C")
        band_layouts.append(
            {"name": band.name, "offset": offset, "length": len(raw), "dtype": "float32"}
        )
        payloads.append(raw)
        offset += len(raw)

    for mask in tile.masks:
        arr = np.ascontiguousarray(mask.array, dtype=np.uint8)
        if arr.shape != (tile.height, tile.width):
            raise Eot1Error(f"mask {mask.name!r} has shape {arr.shape}, expected expected shape")
        raw = arr.tobytes(order="C")
        mask_layouts.append(
            {"name": mask.name, "offset": offset, "length": len(raw), "dtype": "uint8"}
        )
        payloads.append(raw)
        offset += len(raw)

    header: dict[str, Any] = {
        "protocol": PROTOCOL,
        "width": tile.width,
        "height": tile.height,
        "bands": band_layouts,
        "masks": mask_layouts,
        "grid": tile.grid,
        "bounds": list(tile.bounds),
        "calibrated": bool(tile.calibrated),
        "sources": tile.sources,
        "calibration": tile.calibration,
        "processingVersion": tile.processing_version,
        "attribution": tile.attribution,
    }

    header_bytes = json.dumps(header, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(header_bytes) > MAX_HEADER_BYTES:
        raise Eot1Error(f"header {len(header_bytes)}B exceeds {MAX_HEADER_BYTES}B cap")

    pad = _align4(len(header_bytes)) - len(header_bytes)
    total = 8 + len(header_bytes) + pad + offset
    if total > MAX_TILE_BYTES:
        raise Eot1Error(f"tile {total}B exceeds {MAX_TILE_BYTES}B cap")

    out = bytearray()
    out += MAGIC
    out += struct.pack("<I", len(header_bytes))
    out += header_bytes
    out += b"\x00" * pad
    for raw in payloads:
        out += raw
    return bytes(out)


@dataclass
class DecodedTile:
    header: dict[str, Any]
    bands: dict[str, np.ndarray]
    masks: dict[str, np.ndarray]


def decode_metadata(blob: bytes) -> dict[str, Any]:
    """Parse and validate the header without materialising band arrays."""
    if len(blob) < 8:
        raise Eot1Error("payload shorter than magic+header length")
    if blob[:4] != MAGIC:
        raise Eot1Error(f"bad magic {blob[:4]!r}")
    (header_len,) = struct.unpack("<I", blob[4:8])
    if header_len > MAX_HEADER_BYTES:
        raise Eot1Error(f"header length {header_len} exceeds cap")
    payload_start = 8 + _align4(header_len)
    if len(blob) < payload_start:
        raise Eot1Error("truncated header")
    try:
        header = json.loads(blob[8 : 8 + header_len].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise Eot1Error(f"unparseable header: {exc}") from exc

    if header.get("protocol") != PROTOCOL:
        raise Eot1Error(f"unsupported protocol {header.get('protocol')!r}")
    width = int(header.get("width", 0))
    height = int(header.get("height", 0))
    if width <= 0 or height <= 0 or width * height != expected_pixels(width, height):
        raise Eot1Error("inconsistent tile dimensions")
    if not 0 < header_len <= MAX_HEADER_BYTES:
        raise Eot1Error("header length out of range")

    payload_len = len(blob) - payload_start
    for layout, dtype_bytes in (
        (header.get("bands", []), 4),
        (header.get("masks", []), 1),
    ):
        for entry in layout:
            off = int(entry.get("offset", -1))
            length = int(entry.get("length", -1))
            if off < 0 or length < 0 or off + length > payload_len:
                raise Eot1Error(
                    f"layout {entry.get('name')!r} [{off},{off + length}) "
                    f"outside payload of {payload_len}B"
                )
            items = length // dtype_bytes
            if items != width * height:
                raise Eot1Error(
                    f"layout {entry.get('name')!r} holds {items} samples, expected {width * height}"
                )
    return {"header": header, "payload_start": payload_start, "payload_len": payload_len}


def expected_pixels(width: int, height: int) -> int:
    return width * height


def decode(blob: bytes) -> DecodedTile:
    """Fully decode a tile. Used by tests and the region-stats path."""
    meta = decode_metadata(blob)
    header = meta["header"]
    start = meta["payload_start"]
    width, height = int(header["width"]), int(header["height"])
    n = width * height

    def read(layout: Sequence[Mapping[str, Any]], dtype: np.dtype) -> np.ndarray:
        out: dict[str, np.ndarray] = {}
        for entry in layout:
            off = int(entry["offset"])
            length = int(entry["length"])
            raw = blob[start + off : start + off + length]
            out[entry["name"]] = np.frombuffer(raw, dtype=dtype, count=n).reshape(height, width)
        return out

    return DecodedTile(
        header=header,
        bands=read(header.get("bands", []), np.dtype("<f4")),
        masks=read(header.get("masks", []), np.dtype("u1")),
    )
