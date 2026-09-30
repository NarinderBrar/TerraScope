"""Combine same-pass granules into one frame.

Sentinel-2 products are cut into ~110 km MGRS granules. A view near a granule
edge needs its neighbours from the *same* acquisition -- same satellite, same
sensing time, same processing -- to be complete. Compositing those is not
mixing dates: every output pixel still comes from exactly one granule.

Each granule is read and calibrated on its own (its own scale, offset and
masks), then pixels are filled in priority order: a pixel takes all its bands
and masks from the first granule that actually covers it. Taking whole pixels
rather than per-band values keeps a pixel's red, NIR and quality mask from the
same source, which is what makes its NDVI meaningful.
"""

from __future__ import annotations

import numpy as np

from app.protocol.eot1 import BandSpec, Eot1Tile, MaskSpec

#: The mask that decides whether a granule has data at a pixel. Every band in
#: a granule shares its footprint; red is present in every profile.
COVERAGE_MASK = "coverage:red"


def uncovered(tile: Eot1Tile) -> np.ndarray:
    """Boolean array: pixels this tile has no source data for."""
    for mask in tile.masks:
        if mask.name == COVERAGE_MASK:
            return mask.array == 0
    raise ValueError(f"tile has no {COVERAGE_MASK!r} mask to composite on")


def fill(base: Eot1Tile, extra: Eot1Tile) -> Eot1Tile:
    """Fill ``base``'s uncovered pixels from ``extra``, whole pixels at a time.

    Both tiles must be on the same grid with the same bands and masks. Returns
    a new tile carrying ``base``'s provenance plus the contributing item.
    """
    if (base.width, base.height) != (extra.width, extra.height):
        raise ValueError("mosaic granules are on different grids")
    take = uncovered(base) & ~uncovered(extra)
    extra_bands = {b.name: b.array for b in extra.bands}
    extra_masks = {m.name: m.array for m in extra.masks}
    if set(extra_bands) != {b.name for b in base.bands} or set(extra_masks) != {m.name for m in base.masks}:
        raise ValueError("mosaic granules carry different bands or masks")

    bands = [BandSpec(b.name, np.where(take, extra_bands[b.name], b.array).astype(np.float32)) for b in base.bands]
    masks = [MaskSpec(m.name, np.where(take, extra_masks[m.name], m.array).astype(np.uint8)) for m in base.masks]
    sources = dict(base.sources)
    items = list(sources.get("mosaicItems", [sources.get("itemId")]))
    if take.any():
        items.append(extra.sources.get("itemId"))
    sources["mosaicItems"] = items
    return Eot1Tile(
        width=base.width,
        height=base.height,
        bands=bands,
        masks=masks,
        grid=base.grid,
        bounds=base.bounds,
        calibrated=base.calibrated,
        sources=sources,
        calibration=base.calibration,
        attribution=base.attribution,
        processing_version=base.processing_version,
    )
