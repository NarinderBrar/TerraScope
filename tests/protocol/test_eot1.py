"""EOT1 protocol tests.

The client parser in TypeScript is a reimplementation of the decoder below.
A tile that this module accepts but the browser rejects -- or worse, one that
both accept with different layouts -- is a silent data-corruption bug, so the
negative cases here matter more than the happy path.
"""

from __future__ import annotations

import json
import struct

import numpy as np
import pytest

from app.protocol.eot1 import (
    MAGIC,
    MAX_HEADER_BYTES,
    MAX_TILE_BYTES,
    BandSpec,
    Eot1Error,
    Eot1Tile,
    MaskSpec,
    decode,
    decode_metadata,
    encode,
)


def reforge(blob: bytes, mutate) -> bytes:
    """Rebuild a tile with a mutated JSON header, preserving realignment.

    Splicing bytes in place would leave the header misaligned and the test
    would pass for the wrong reason.
    """
    header_len = struct.unpack("<I", blob[4:8])[0]
    header = json.loads(blob[8 : 8 + header_len])
    mutate(header)
    raw = json.dumps(header, separators=(",", ":")).encode("utf-8")
    pad = (-len(raw)) % 4
    # The declared length must be rewritten too, or the decoder reads the new
    # (longer) JSON truncated to the old length and reports a parse error
    # instead of the layout error we are actually testing.
    return (
        MAGIC
        + struct.pack("<I", len(raw))
        + raw
        + b"\x00" * pad
        + blob[8 + header_len + ((-header_len) % 4) :]
    )


def make_tile(width: int = 8, height: int = 4) -> Eot1Tile:
    rng = np.random.default_rng(7)
    tile = Eot1Tile(
        width=width,
        height=height,
        grid={"crs": "EPSG:3857", "tileSize": 256, "z": 13, "x": 1335, "y": 3156},
        bounds=(-121.33, 38.09, -121.28, 38.13),
        sources={
            "collection": "sentinel-2-l2a",
            "itemId": "S2B_10SFH_20240627_0_L2A",
            "itemVersion": "05.10",
            "datetime": "2024-06-27T19:03:55Z",
        },
        calibration={"applied": True, "perBand": {"red": {"scale": 1e-4, "offset": -0.1}}},
        attribution="test",
    )
    for name in ("red", "nir"):
        tile.bands.append(BandSpec(name, rng.uniform(0, 0.5, (height, width)).astype(np.float32)))
    tile.masks.append(MaskSpec("red", np.ones((height, width), dtype=np.uint8)))
    tile.masks.append(MaskSpec("quality", np.zeros((height, width), dtype=np.uint8)))
    return tile


# -- round trip --------------------------------------------------------------


def test_round_trip_preserves_values_and_layout():
    tile = make_tile()
    blob = encode(tile)
    decoded = decode(blob)
    assert blob[:4] == MAGIC
    for spec in tile.bands:
        np.testing.assert_array_equal(decoded.bands[spec.name], spec.array)
    for spec in tile.masks:
        np.testing.assert_array_equal(decoded.masks[spec.name], spec.array)
    assert decoded.header["grid"]["z"] == 13
    assert decoded.header["calibrated"] is True


@pytest.mark.parametrize("width", [1, 3, 5, 7, 8, 16, 255, 256])
def test_header_is_four_byte_aligned(width):
    """Misaligned headers force the client to guess, and it will guess wrong."""
    tile = Eot1Tile(width=width, height=width, bounds=(0.0, 0.0, 1.0, 1.0))
    for name in ("red", "green", "blue", "nir"):
        tile.bands.append(BandSpec(name, np.zeros((width, width), dtype=np.float32)))
    tile.masks.append(MaskSpec("quality", np.ones((width, width), dtype=np.uint8)))
    blob = encode(tile)
    header_len = struct.unpack("<I", blob[4:8])[0]
    # The payload must start on a four-byte boundary, which is what lets the
    # client slice float32 planes without a per-band realignment. The declared
    # header length itself is arbitrary.
    payload_start = 8 + header_len + ((-header_len) % 4)
    assert payload_start % 4 == 0
    assert decode_metadata(blob)["payload_start"] == payload_start
    assert decode_metadata(blob)["header"]["width"] == width


def test_nan_survives_the_round_trip():
    tile = make_tile()
    tile.bands[0].array[0, 0] = np.nan
    decoded = decode(encode(tile))
    assert np.isnan(decoded.bands["red"][0, 0])


def test_masks_precede_nothing_and_are_distinct_from_bands():
    """A mask named like a band must not overwrite the band's float data."""
    tile = make_tile()
    decoded = decode(encode(tile))
    assert decoded.bands["red"].dtype == np.float32
    assert decoded.masks["red"].dtype == np.uint8


# -- encoder guards ----------------------------------------------------------


def test_encoder_rejects_mismatched_band_shape():
    tile = make_tile(width=8, height=4)
    tile.bands.append(BandSpec("bad", np.zeros((3, 3), dtype=np.float32)))
    with pytest.raises(Eot1Error, match="shape"):
        encode(tile)


def test_encoder_rejects_infinite_values():
    tile = make_tile()
    tile.bands[0].array[0, 0] = np.inf
    with pytest.raises(Eot1Error, match="infinite"):
        encode(tile)


def test_encoder_rejects_oversized_tiles_before_allocating():
    tile = Eot1Tile(width=4096, height=4096, bounds=(0, 0, 1, 1))
    tile.bands.append(BandSpec("red", np.zeros((4096, 4096), dtype=np.float32)))
    with pytest.raises(Eot1Error):
        encode(tile)


def test_encoder_rejects_zero_dimensions():
    with pytest.raises(Eot1Error):
        encode(Eot1Tile(width=0, height=0, bounds=(0, 0, 0, 0)))


# -- decoder guards ----------------------------------------------------------


def test_decoder_rejects_bad_magic():
    blob = bytearray(encode(make_tile()))
    blob[0:4] = b"XXXX"
    with pytest.raises(Eot1Error, match="magic"):
        decode_metadata(bytes(blob))


def test_decoder_rejects_truncated_payload():
    blob = encode(make_tile())
    with pytest.raises(Eot1Error, match="outside payload"):
        decode_metadata(blob[:-64])


def test_decoder_rejects_truncated_header():
    blob = encode(make_tile())
    with pytest.raises(Eot1Error, match="truncated"):
        decode_metadata(blob[:10])


def test_decoder_rejects_absurd_header_length():
    blob = bytearray(encode(make_tile()))
    struct.pack_into("<I", blob, 4, MAX_HEADER_BYTES + 1)
    with pytest.raises(Eot1Error, match="header length"):
        decode_metadata(bytes(blob))


def test_decoder_rejects_offset_beyond_payload():
    """The classic malicious-header case: a huge offset with a valid header."""
    blob = encode(make_tile())
    forged = reforge(blob, lambda h: h["bands"][0].update(offset=MAX_TILE_BYTES))
    with pytest.raises(Eot1Error, match="outside payload"):
        decode_metadata(forged)


def test_decoder_rejects_length_that_is_not_a_whole_pixel_count():
    blob = encode(make_tile())
    forged = reforge(blob, lambda h: h["bands"][0].update(length=17))
    with pytest.raises(Eot1Error):
        decode_metadata(forged)


def test_decoder_rejects_wrong_protocol_version():
    forged = reforge(encode(make_tile()), lambda h: h.update(protocol="EOT9"))
    with pytest.raises(Eot1Error, match="protocol"):
        decode_metadata(forged)


def test_decoder_rejects_inconsistent_dimensions():
    forged = reforge(encode(make_tile()), lambda h: h.update(height=h["height"] + 1))
    with pytest.raises(Eot1Error):
        decode_metadata(forged)


def test_decoder_rejects_unparseable_header():
    blob = bytearray(encode(make_tile()))
    blob[8:12] = b"{{{{"
    with pytest.raises(Eot1Error, match="unparseable"):
        decode_metadata(bytes(blob))


def test_a_256x256_rgbn_tile_fits_the_budget():
    """Sanity check the documented size: 1 MiB of float32 before masks."""
    tile = Eot1Tile(width=256, height=256, bounds=(0.0, 0.0, 1.0, 1.0))
    for name in ("red", "green", "blue", "nir"):
        tile.bands.append(BandSpec(name, np.zeros((256, 256), dtype=np.float32)))
    for name in ("coverage:red", "red", "coverage:nir", "nir", "quality"):
        tile.masks.append(MaskSpec(name, np.ones((256, 256), dtype=np.uint8)))
    blob = encode(tile)

    band_bytes = 4 * 256 * 256 * 4
    mask_bytes = 5 * 256 * 256
    assert band_bytes == 1024 * 1024, "four float32 bands must be exactly 1 MiB"
    header = decode_metadata(blob)["header"]
    assert len(blob) == band_bytes + mask_bytes + blob.index(b"\x00", 8) * 0 + (
        8 + struct.unpack("<I", blob[4:8])[0] + ((-struct.unpack("<I", blob[4:8])[0]) % 4)
    )
    assert len(header["bands"]) == 4
    assert len(header["masks"]) == 5
    assert len(blob) < MAX_TILE_BYTES
