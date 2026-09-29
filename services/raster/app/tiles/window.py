"""Read a Web Mercator display tile from a Sentinel-2 COG.

The point of this module is selectivity: a 256x256 display tile covers a small
window of a 10980x10980 granule, and GDAL's COG driver turns that into a
handful of HTTP range requests rather than a 222 MB download.

Alignment guarantees the rest of the system relies on:

* The target grid is *exactly* the XYZ grid for the requested z/x/y, so
  adjacent tiles sample the source at the same geolocations and no seam
  appears from resampling.
* Continuous reflectance is resampled bilinearly; the categorical quality
  layer is resampled with nearest so class codes stay discrete.
* Nodata is declared to the warper on both sides, so it is excluded from the
  interpolation kernel rather than averaged into neighbouring valid
  reflectance. Validity degrades at invalid edges instead of being invented.
"""

from __future__ import annotations

import math

from dataclasses import dataclass
from typing import Any

# Must precede rasterio: GDAL latches its configuration on first use.
from app import gdal_config  # noqa: F401  (import order is load-bearing)

import numpy as np
import rasterio
from rasterio import windows
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.io import DatasetReader
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform as warp_transform

from app.providers.sentinel2 import (
    BandAsset,
    SourceScene,
    apply_calibration,
    quality_mask_from_scl,
    reflectance_analysis_mask,
)
from app.tiles.dataset_cache import AssetPool

#: Web Mercator extent of the whole world, in metres.
WEB_MERCATOR_SPAN = 40075016.685578488
WEB_MERCATOR_HALF = WEB_MERCATOR_SPAN / 2.0
DISPLAY_CRS = CRS.from_epsg(3857)
WGS84 = CRS.from_epsg(4326)
MAX_ZOOM = 24
#: Web Mercator cannot represent the poles; clamp to the square-world limit.
MAX_LATITUDE = 85.0511287798066


def lon_to_tile_x(lon: float, z: int) -> int:
    n = 2**z
    return math.floor(((lon + 180.0) / 360.0) * n)


def lat_to_tile_y(lat: float, z: int) -> int:
    clamped = max(-MAX_LATITUDE, min(MAX_LATITUDE, lat))
    rad = math.radians(clamped)
    n = 2**z
    raw = (1.0 - math.asinh(math.tan(rad)) / math.pi) / 2.0 * n
    # At the latitude limit the expression evaluates to exactly 0 or exactly n
    # in double precision, and floor() of either is out of range. Clamping is
    # not cosmetic: it is the difference between a valid tile request and a
    # 400 from the display grid.
    return max(0, min(n - 1, math.floor(raw)))


def tile_bounds_wgs84(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """[west, south, east, north] for an XYZ tile."""
    n = 2**z
    west = x / n * 360.0 - 180.0
    east = (x + 1) / n * 360.0 - 180.0
    north = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * y / n))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * (y + 1) / n))))
    return (west, south, east, north)


def ground_resolution_m(lat: float, z: int) -> float:
    """Metres per output pixel at a latitude. Not the sensor GSD."""
    return (
        156543.03392804097
        * math.cos(math.radians(max(-89.0, min(89.0, lat))))
        / (2**z)
    )


class TileOutOfRange(ValueError):
    """Requested tile is outside the addressable grid."""


@dataclass(frozen=True)
class DisplayTileGrid:
    z: int
    x: int
    y: int
    size: int = 256

    def __post_init__(self) -> None:
        if not 0 <= self.z <= MAX_ZOOM:
            raise TileOutOfRange(f"zoom {self.z} outside [0,{MAX_ZOOM}]")
        n = 2**self.z
        if not 0 <= self.x < n:
            raise TileOutOfRange(f"tile x {self.x} outside [0,{n}) at z{self.z}")
        if not 0 <= self.y < n:
            raise TileOutOfRange(f"tile y {self.y} outside [0,{n}) at z{self.z}")

    @property
    def side_m(self) -> float:
        return WEB_MERCATOR_SPAN / (2**self.z)

    @property
    def resolution_m(self) -> float:
        """Ground resolution of one *output* pixel. Not the sensor's GSD."""
        return self.side_m / self.size

    @property
    def left_m(self) -> float:
        return -WEB_MERCATOR_HALF + self.x * self.side_m

    @property
    def top_m(self) -> float:
        return WEB_MERCATOR_HALF - self.y * self.side_m

    def bounds_3857(self) -> tuple[float, float, float, float]:
        """(left, bottom, right, top) in EPSG:3857 metres."""
        left, top = self.left_m, self.top_m
        return (left, top - self.side_m, left + self.side_m, top)

    def bounds_wgs84(self) -> tuple[float, float, float, float]:
        left, bottom, right, top = self.bounds_3857()
        xs, ys = warp_transform(DISPLAY_CRS, WGS84, [left, right], [bottom, top])
        return (xs[0], ys[0], xs[1], ys[1])

    def to_dict(self) -> dict[str, Any]:
        return {"crs": "EPSG:3857", "tileSize": self.size, "z": self.z, "x": self.x, "y": self.y}


def _read_pinned(
    vrt: WarpedVRT, grid: DisplayTileGrid, out_dtype: str = "float32", *, bands: tuple[int, ...] = (1,)
) -> np.ndarray | tuple[np.ndarray, ...]:
    """Read the display tile onto the *exact* XYZ grid.

    Two things make this correct rather than merely close:

    * The destination transform is pinned to the tile's own geotransform.
      Without pinning GDAL derives the output resolution from the VRT extent,
      and sample centres can land a fraction of a pixel off the XYZ grid --
      which is exactly how a one-pixel seam appears between adjacent tiles.
    * The read is confined to the intersection with the VRT's extent and
      pasted into a nodata-filled canvas. WarpedVRT forbids boundless reads,
      and doing the intersection ourselves is also what lets the client
      distinguish "outside coverage" from "masked by quality".
    """
    fill = np.float32(0) if vrt.nodata is None else np.float32(vrt.nodata)
    multi = len(bands) > 1
    shape = ((len(bands), grid.size, grid.size) if multi else (grid.size, grid.size))
    out = np.full(shape, fill, dtype=np.float32)

    tile_left, tile_bottom, tile_right, tile_top = grid.bounds_3857()
    res = grid.resolution_m
    v_left, v_bottom, v_right, v_top = vrt.bounds

    ix0, iy0 = max(tile_left, v_left), max(tile_bottom, v_bottom)
    ix1, iy1 = min(tile_right, v_right), min(tile_top, v_top)
    if ix1 <= ix0 or iy1 <= iy0:
        return out

    # Pixel indices of the overlap within the 256x256 output canvas.
    px0 = int(round((ix0 - tile_left) / res))
    py0 = int(round((tile_top - iy1) / res))
    nx = max(1, int(round((ix1 - ix0) / res)))
    ny = max(1, int(round((iy1 - iy0) / res)))
    px1, py1 = min(grid.size, px0 + nx), min(grid.size, py0 + ny)
    if px1 <= px0 or py1 <= py0:
        return out

    # rasterio windows are in *pixel* space, so convert the CRS bounds with the
    # VRT's own transform rather than passing metres through.
    win = windows.from_bounds(ix0, iy0, ix1, iy1, transform=vrt.transform)
    out_shape = (len(bands), py1 - py0, px1 - px0) if multi else (py1 - py0, px1 - px0)
    block = vrt.read(
        list(bands),
        window=win,
        out_shape=out_shape,
        transform=from_origin(ix0, iy1, res, -res),
        out_dtype="float32",
    )
    target = out[:, py0:py1, px0:px1] if multi else out[py0:py1, px0:px1]
    target[...] = block
    return out


@dataclass
class WarpedBand:
    """One band on the display grid, calibrated exactly once.

    ``covered`` is a data-availability fact: this sample has real source data.
    ``analytical`` additionally requires the reflectance to be plausible enough
    to index. They differ wherever the -0.1 processing-baseline offset drives
    dark targets negative.
    """

    values: np.ndarray  # float32 reflectance, NaN where not covered
    covered: np.ndarray  # uint8
    analytical: np.ndarray  # uint8


#: GDAL expresses the synthetic alpha band at full strength as this value.
ALPHA_FULL = 65535.0


def read_warped_band(
    asset: BandAsset, grid: DisplayTileGrid, *, pool: AssetPool | None = None
) -> WarpedBand:
    """Read a continuous reflectance band onto the display grid (bilinear).

    Coverage comes from the VRT's synthetic alpha band rather than a second
    nearest-neighbour VRT. One VRT and one read instead of two, and the alpha
    is strictly conservative: any nodata inside an output pixel's interpolation
    kernel suppresses it entirely, so validity degrades at invalid edges
    instead of being interpolated across them.
    """
    own = pool is None
    ctx = pool or AssetPool()
    try:
        src = ctx.open(asset.href)
        with WarpedVRT(
            src,
            crs=DISPLAY_CRS,
            resampling=Resampling.bilinear,
            src_nodata=asset.nodata,
            nodata=asset.nodata,
            add_alpha=True,
        ) as vrt:
            data, alpha = _read_pinned(vrt, grid, bands=(1, 2))

        covered = alpha >= ALPHA_FULL
        covered &= np.isfinite(data)
        if asset.nodata is not None:
            covered &= data != np.float32(asset.nodata)

        # Calibrate only the covered samples; NaN is the out-of-band signal.
        refl = np.full(grid.size * grid.size, np.nan, dtype=np.float32).reshape(grid.size, grid.size)
        if covered.any():
            calibrated, _ = apply_calibration(
                data[covered], asset.scale, asset.offset, None
            )
            refl[covered] = calibrated
        # A sample can be alpha-covered yet calibrate out of physical range
        # (dark targets). It stays displayable and leaves the analytical set.
        analytical = covered & (reflectance_analysis_mask(refl) > 0)
        return WarpedBand(
            values=refl,
            covered=covered.astype(np.uint8),
            analytical=analytical.astype(np.uint8),
        )
    finally:
        if own:
            ctx.close()


def read_quality(
    scene: SourceScene, grid: DisplayTileGrid, *, pool: AssetPool | None = None
) -> tuple[np.ndarray, np.ndarray]:
    """Read SCL onto the display grid with nearest-neighbour resampling.

    A 50/50 blend of "vegetation" and "cloud" is not a class, so categorical
    data is never interpolated. Codes are carried through exactly and only then
    mapped to validity.
    """
    if scene.quality is None:
        raise ValueError(f"scene {scene.item_id} has no quality asset")

    own = pool is None
    ctx = pool or AssetPool()
    try:
        src = ctx.open(scene.quality.href)
        with WarpedVRT(
            src,
            crs=DISPLAY_CRS,
            resampling=Resampling.nearest,
            src_nodata=scene.quality.nodata,
            nodata=scene.quality.nodata,
            add_alpha=False,
        ) as vrt:
            codes = _read_pinned(vrt, grid, out_dtype="float32").astype(np.int32)
        valid, retained = quality_mask_from_scl(codes)
        return valid.astype(np.uint8), retained.astype(np.uint8)
    finally:
        if own:
            ctx.close()


def read_bands(
    scene: SourceScene,
    grid: DisplayTileGrid,
    band_names: list[str],
    *,
    apply_quality_mask: bool = True,
    pool: AssetPool | None = None,
) -> dict[str, Any]:
    """Read every band for a tile, plus the quality layer.

    Returns a dict with:

    ``bands``       name -> float32 reflectance on the display grid
    ``coverage``    name -> uint8, this sample has real source data (for display)
    ``analysis``    name -> uint8, plausible for indices (per band)
    ``quality``     uint8, SCL policy mask, shared across bands
    ``scene``       the SourceScene, for header provenance

    Per-band separation matters: a scene can have usable NIR over an unusable
    red sample, and the client must be able to say which rather than collapsing
    the two into a single boolean.

    Bands are read sequentially and share the process-wide dataset cache.
    Reading them from a thread pool is faster in principle but deadlocks inside
    GDAL's ``/vsicurl`` layer, and the cache already removes the repeated-open
    cost that parallelism was meant to address. The parameter is retained so
    the call site documents the constraint rather than hiding it.
    """
    bands: dict[str, np.ndarray] = {}
    coverage: dict[str, np.ndarray] = {}
    analysis: dict[str, np.ndarray] = {}

    for name in band_names:
        wb = read_warped_band(scene.band_for(name), grid, pool=pool or AssetPool())
        bands[name] = wb.values
        coverage[name] = wb.covered
        analysis[name] = wb.analytical

    quality = np.ones((grid.size, grid.size), dtype=np.uint8)
    if apply_quality_mask:
        if scene.quality is None:
            raise ValueError(
                f"scene {scene.item_id} has no quality asset but a mask was requested"
            )
        quality, _ = read_quality(scene, grid, pool=pool)

    return {
        "bands": bands,
        "coverage": coverage,
        "analysis": analysis,
        "quality": quality,
        "scene": scene,
    }
