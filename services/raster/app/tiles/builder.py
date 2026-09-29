"""Assemble an EOT1 tile from a scene and a display grid.

This is where provenance is attached. Every tile declares the source item, the
exact scale/offset actually applied, the source resolution, the resampling used
per layer, and the processing version. A consumer that keeps the header keeps
the ability to reproduce and to cite the number.
"""

from __future__ import annotations

import numpy as np

from app.protocol.eot1 import PROCESSING_VERSION, BandSpec, Eot1Tile, MaskSpec
from app.providers.sentinel2 import (
    DEFAULT_QUALITY_POLICY,
    REFLECTANCE_POLICY,
    SourceScene,
)
from app.tiles.analysis import NDVI_EPSILON
from app.tiles.window import DisplayTileGrid, ground_resolution_m, read_bands

ATTRIBUTION = (
    "Contains modified Copernicus Sentinel data 2024, processed by Element 84 "
    "and hosted on the Earth Search AWS Open Data registry."
)


def build_tile(
    scene: SourceScene,
    grid: DisplayTileGrid,
    band_names: list[str],
    *,
    apply_quality_mask: bool = True,
    pool: object | None = None,
) -> Eot1Tile:
    """Read, calibrate, mask and serialise-prepare one display tile."""
    data = read_bands(
        scene,
        grid,
        band_names,
        apply_quality_mask=apply_quality_mask,
        pool=pool,  # type: ignore[arg-type]
    )
    bands: dict[str, np.ndarray] = data["bands"]
    coverage: dict[str, np.ndarray] = data["coverage"]
    analysis: dict[str, np.ndarray] = data["analysis"]
    quality: np.ndarray = data["quality"]

    tile = Eot1Tile(
        width=grid.size,
        height=grid.size,
        grid=grid.to_dict(),
        bounds=grid.bounds_wgs84(),
        calibrated=True,
        sources={
            "collection": scene.collection,
            "itemId": scene.item_id,
            "itemVersion": scene.processing_baseline,
            "datetime": scene.datetime,
            "processingBaseline": scene.processing_baseline,
            "epsg": scene.epsg,
            "sourceResolutionM": {n: scene.bands[n].gsd for n in band_names if n in scene.bands},
            "resampling": {n: "bilinear" for n in band_names},
            "outputResolutionM": ground_resolution_m(
                (grid.bounds_wgs84()[1] + grid.bounds_wgs84()[3]) / 2.0, grid.z
            ),
        },
        calibration={
            "applied": True,
            "appliedOnce": True,
            "ndviEpsilon": NDVI_EPSILON,
            "reflectanceRange": [0.0, 1.0],
            "perBand": {
                n: {
                    "scale": scene.bands[n].scale,
                    "offset": scene.bands[n].offset,
                    "nodata": scene.bands[n].nodata,
                    "asset": scene.bands[n].asset_key,
                }
                for n in band_names
                if n in scene.bands
            },
        },
        attribution=ATTRIBUTION,
        processing_version=PROCESSING_VERSION,
    )
    if scene.quality is not None:
        tile.sources["qualityAsset"] = scene.quality.asset_key
        tile.sources["qualityResolutionM"] = scene.quality.gsd
        # Categorical data is never interpolated; averaging class codes would
        # invent classes that do not exist.
        tile.sources["qualityResampling"] = "nearest"

    for name in band_names:
        tile.bands.append(BandSpec(name, bands[name].astype(np.float32)))
        # Two masks per band, deliberately: 'coverage' drives rendering,
        # '<band>' drives indices. See the reflectance policy note.
        tile.masks.append(MaskSpec(f"coverage:{name}", coverage[name].astype(np.uint8)))
        tile.masks.append(MaskSpec(name, analysis[name].astype(np.uint8)))
    tile.masks.append(MaskSpec("quality", quality.astype(np.uint8)))

    tile.sources["qualityPolicy"] = (
        DEFAULT_QUALITY_POLICY if apply_quality_mask else "no quality mask applied"
    )
    tile.sources["reflectancePolicy"] = REFLECTANCE_POLICY
    return tile
