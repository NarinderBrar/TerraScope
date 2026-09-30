"""Same-pass granule compositing: whole pixels, gaps only, provenance kept."""

import numpy as np
import pytest

from app.protocol.eot1 import BandSpec, Eot1Tile, MaskSpec
from app.tiles.mosaic import fill, uncovered


def granule(item_id: str, covered_cols: slice, red: float, nir: float, quality: int = 1) -> Eot1Tile:
    coverage = np.zeros((2, 4), dtype=np.uint8)
    coverage[:, covered_cols] = 1
    def band(value: float) -> np.ndarray:
        out = np.full((2, 4), np.nan, dtype=np.float32)
        out[coverage == 1] = value
        return out
    return Eot1Tile(
        width=4,
        height=2,
        bands=[BandSpec("red", band(red)), BandSpec("nir", band(nir))],
        masks=[
            MaskSpec("coverage:red", coverage),
            MaskSpec("coverage:nir", coverage.copy()),
            MaskSpec("quality", np.full((2, 4), quality, dtype=np.uint8) * coverage),
        ],
        sources={"itemId": item_id, "datetime": "2026-09-24T06:46:21Z"},
    )


def arrays(tile: Eot1Tile) -> dict[str, np.ndarray]:
    return {**{b.name: b.array for b in tile.bands}, **{m.name: m.array for m in tile.masks}}


def test_fills_only_the_gaps_with_whole_pixels() -> None:
    west = granule("west", slice(0, 2), red=0.1, nir=0.5)
    east = granule("east", slice(1, 4), red=0.2, nir=0.6, quality=0)
    out = arrays(fill(west, east))
    # Column 1 is covered by both: the first granule keeps it, bands and masks.
    np.testing.assert_allclose(out["red"][0], [0.1, 0.1, 0.2, 0.2])
    np.testing.assert_allclose(out["nir"][0], [0.5, 0.5, 0.6, 0.6])
    np.testing.assert_array_equal(out["quality"][0], [1, 1, 0, 0])
    np.testing.assert_array_equal(out["coverage:red"][0], [1, 1, 1, 1])


def test_records_contributing_items_and_keeps_base_provenance() -> None:
    west = granule("west", slice(0, 2), red=0.1, nir=0.5)
    east = granule("east", slice(2, 4), red=0.2, nir=0.6)
    elsewhere = granule("elsewhere", slice(0, 1), red=0.3, nir=0.7)
    merged = fill(fill(west, east), elsewhere)
    assert merged.sources["itemId"] == "west"
    # "elsewhere" only overlapped pixels already covered, so it contributed nothing.
    assert merged.sources["mosaicItems"] == ["west", "east"]
    assert not uncovered(merged).any()


def test_rejects_granules_on_different_grids() -> None:
    west = granule("west", slice(0, 2), red=0.1, nir=0.5)
    odd = granule("odd", slice(0, 2), red=0.1, nir=0.5)
    odd.width = 8
    with pytest.raises(ValueError):
        fill(west, odd)
