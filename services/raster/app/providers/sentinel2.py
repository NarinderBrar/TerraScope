"""Provider adapters.

Each adapter turns a raw STAC item into the internal ``SourceScene`` that the
tile pipeline understands. Two rules are load-bearing here:

1. Calibration is read from the item's own ``raster:bands`` metadata and applied
   exactly once, on the raw DN values, after nodata has been masked. Nothing is
   hardcoded. Earth Search has reprocessed the archive in place under new
   processing baselines, and Collection 1 uses a different offset again, so a
   hardcoded constant silently corrupts reflectance.
2. Asset keys are *resolved* from metadata. A scene that does not carry a band
   we need is reported as lacking it, never substituted.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

import numpy as np

from app.catalog.stac import StacError, validate_asset_url

#: Sentinel-2 Level-2A surface reflectance classes (ESA SCL / `scl` asset).
#: Documented in the product specification; verified against the COG at setup.
SCL_CLASSES: dict[int, str] = {
    0: "no_data",
    1: "saturated_or_defective",
    2: "dark_area_pixels",
    3: "cloud_shadow",
    4: "vegetation",
    5: "not_vegetated",
    6: "water",
    7: "unclassified",
    8: "cloud_medium_probability",
    9: "cloud_high_probability",
    10: "thin_cirrus",
    11: "snow_or_ice",
}

#: Policy: everything a spectral index would be meaningless or misleading over is
#: excluded. Surfaced verbatim in the UI so the mask is never implicit.
DEFAULT_EXCLUDED_SCL: frozenset[int] = frozenset({0, 1, 2, 3, 8, 9, 10, 11})

DEFAULT_QUALITY_POLICY = (
    "Scene classification (SCL) masking. Excluded classes: no data (0), "
    "saturated/defective (1), dark area pixels (2), cloud shadow (3), cloud medium "
    "probability (8), cloud high probability (9), thin cirrus (10), snow/ice (11). "
    "Retained: vegetation (4), not-vegetated (5), water (6), unclassified (7)."
)

#: Banal names -> the spectral meaning we actually need for NDVI and false colour.
BAND_ROLE = {
    "blue": "blue",
    "green": "green",
    "red": "red",
    "nir": "nir",
    "nir08": "nir",
    "nir09": "nir",
}
QUALITY_ROLE = "scl"
PROCESSING_BASELINE_ROLE = "processing:baseline"


class UnsupportedScene(StacError):
    """The item exists but cannot satisfy the requested profile."""

    def __init__(self, message: str) -> None:
        super().__init__(message, status=422)


@dataclass(frozen=True)
class BandAsset:
    role: str
    asset_key: str
    href: str
    gsd: float
    scale: float
    offset: float
    nodata: float | None
    dtype: str
    epsg: int | None


@dataclass
class SourceScene:
    collection: str
    item_id: str
    datetime: str
    bbox: list[float]
    geometry: dict[str, Any]
    cloud_cover: float | None
    bands: dict[str, BandAsset] = field(default_factory=dict)
    quality: BandAsset | None = None
    attribution: str = ""
    processing_baseline: str | None = None
    epsg: int | None = None

    def band_for(self, name: str) -> BandAsset:
        try:
            return self.bands[name]
        except KeyError:
            raise UnsupportedScene(
                f"scene {self.item_id} does not provide band {name!r}"
            ) from None

    def require_profile(self, names: Sequence[str]) -> list[BandAsset]:
        return [self.band_for(n) for n in names]


def _asset_calibration(
    asset: Mapping[str, Any], *, allow_identity: bool = False
) -> tuple[float, float, float | None, str]:
    """Read (scale, offset, nodata, dtype) from STAC ``raster:bands``.

    For continuous reflectance, a missing ``raster:bands`` block means we do not
    know how to convert DN to a physical value, and assuming identity would
    silently produce numbers that look right. That is a hard failure.

    Categorical layers (scene classification) are class indices rather than
    measurements, so identity calibration is correct for them; callers opt in
    explicitly via ``allow_identity``.
    """
    bands = asset.get("raster:bands")
    if not isinstance(bands, list) or not bands:
        if not allow_identity:
            raise UnsupportedScene("asset has no raster:bands calibration block")
        return 1.0, 0.0, None, str((asset.get("raster:bands") or [{}])[0].get("data_type", "uint8"))
    rb = bands[0]
    if "scale" not in rb or "offset" not in rb:
        if not allow_identity:
            raise UnsupportedScene(
                "asset lacks explicit scale/offset; refusing to assume identity calibration"
            )
        return 1.0, 0.0, None, str(rb.get("data_type", "uint8"))
    nodata = rb.get("nodata")
    return (
        float(rb["scale"]),
        float(rb["offset"]),
        float(nodata) if nodata is not None else None,
        str(rb.get("data_type", "uint16")),
    )


def _asset_epsg(asset: Mapping[str, Any]) -> int | None:
    epsg = asset.get("proj:epsg")
    return int(epsg) if epsg is not None else None


def _resolve_bands(item: Mapping[str, Any]) -> tuple[dict[str, BandAsset], BandAsset | None, int | None]:
    assets: Mapping[str, Any] = item.get("assets") or {}
    props: Mapping[str, Any] = item.get("properties") or {}
    item_epsg = props.get("proj:epsg")

    # Each item publishes both a COG (``blue``) and a JP2 (``blue-jp2``) variant.
    # Prefer the COG: it is the only one with efficient range reads. Ties within
    # the same tier go to the lexicographically first key for determinism.
    def rank(key: str) -> tuple[int, str]:
        return (1 if key.endswith("-jp2") else 0, key)

    best: dict[str, tuple[tuple[int, str], str, Mapping[str, Any]]] = {}
    for key, asset in assets.items():
        role = BAND_ROLE.get(key)
        if role is not None and (role not in best or rank(key) < best[role][0]):
            best[role] = (rank(key), key, asset)

    found = {
        role: _make_band(role, key, asset, item_epsg) for role, (_, key, asset) in best.items()
    }

    quality: BandAsset | None = None
    for key in sorted((k for k in assets if k.split("-")[0] == QUALITY_ROLE), key=rank):
        quality = _make_band(QUALITY_ROLE, key, assets[key], item_epsg)
        break

    return found, quality, int(item_epsg) if item_epsg is not None else None


def _make_band(
    role: str, key: str, asset: Mapping[str, Any], item_epsg: int | None
) -> BandAsset:
    allow_identity = role == QUALITY_ROLE
    scale, offset, nodata, dtype = _asset_calibration(asset, allow_identity=allow_identity)
    href = validate_asset_url(str(asset["href"]))
    gsd = asset.get("gsd")
    if gsd is None:
        # Derive from proj:transform when gsd is absent (SCL publishes no gsd).
        transform = asset.get("proj:transform")
        if not transform or not transform[0]:
            raise UnsupportedScene(f"asset {key!r} has no gsd and no proj:transform")
        gsd = abs(float(transform[0]))
    return BandAsset(
        role=role,
        asset_key=key,
        href=href,
        gsd=float(gsd),
        scale=scale,
        offset=offset,
        nodata=nodata,
        dtype=dtype,
        epsg=_asset_epsg(asset) or item_epsg,
    )


def parse_scene(item: Mapping[str, Any], collection: str) -> SourceScene:
    """Normalise a STAC item into a ``SourceScene``.

    Raises ``UnsupportedScene`` when required metadata is missing. Callers
    surface that as "this scene cannot be analysed" rather than guessing.
    """
    props: Mapping[str, Any] = item.get("properties") or {}
    item_id = str(item.get("id") or "")
    if not item_id:
        raise UnsupportedScene("item has no id")
    datetime = str(props.get("datetime") or props.get("start_datetime") or "")
    if not datetime:
        raise UnsupportedScene(f"item {item_id} has no acquisition datetime")

    found, quality, epsg = _resolve_bands(item)
    for required in ("red", "nir"):
        if required not in found:
            raise UnsupportedScene(f"item {item_id} lacks a {required!r} band asset")

    cloud = props.get("eo:cloud_cover")
    return SourceScene(
        collection=collection,
        item_id=item_id,
        datetime=datetime,
        bbox=[float(v) for v in (item.get("bbox") or [])],
        geometry=dict(item.get("geometry") or {}),
        cloud_cover=float(cloud) if cloud is not None else None,
        bands=found,
        quality=quality,
        attribution=str(props.get("s2:product_uri") or item_id),
        processing_baseline=str(props.get("s2:processing_baseline") or "") or None,
        epsg=epsg,
    )


# ---------------------------------------------------------------------------
# Radiometry
# ---------------------------------------------------------------------------


#: Plausible range for calibrated surface reflectance, and the policy applied to
#: values outside it.
#:
#: Sentinel-2 L2A applies a -0.1 offset (processing baseline >= 04.00), so dark
#: targets -- deep water, heavy shadow -- can calibrate to slightly *negative*
#: reflectance. That is an artefact of the offset correction being applied to
#: digital numbers near the noise floor, not a measurement. Left in place it
#: makes NDVI unbounded: a red of +0.031 against an NIR of -0.030 has a
#: denominator near the epsilon guard and yields NDVI of -55.
#:
#: The policy is "analytically valid means inside [0, 1]", recorded in every
#: tile header so a consumer can see exactly which samples were excluded and
#: why. It gates *indices*, not rendering: the band values themselves are
#: delivered as measured so natural-colour display can clip rather than show
#: holes. Coverage and analytical validity are separate masks for exactly this
#: reason.
REFLECTANCE_MIN = 0.0
REFLECTANCE_MAX = 1.0

#: Statement surfaced in the UI and the export alongside the SCL policy.
REFLECTANCE_POLICY = (
    "Analytically valid samples are required to have calibrated surface "
    "reflectance inside [0.0, 1.0]. Samples outside that range are excluded "
    "from vegetation indices but remain available for display. This rejects "
    "dark-target artefacts of the -0.1 processing-baseline offset, which "
    "would otherwise make NDVI unbounded."
)


def apply_calibration(
    dn: np.ndarray,
    scale: float,
    offset: float,
    nodata: float | None,
) -> tuple[np.ndarray, np.ndarray]:
    """Convert digital numbers to surface reflectance exactly once.

    Returns ``(reflectance, covered)``. ``covered`` means only "this sample has
    real source data behind it" -- nodata, outside-coverage and non-finite
    samples are cleared and set to NaN.

    Reflectance values are returned *as calibrated*, including values outside
    [0, 1]. The plausibility policy lives in
    :func:`reflectance_analysis_mask` so that display and analysis can be
    filtered differently without re-deriving the values.
    """
    covered = np.ones(dn.shape, dtype=bool)
    if nodata is not None:
        covered &= dn != nodata
    covered &= np.isfinite(dn)
    refl = dn.astype(np.float32) * np.float32(scale) + np.float32(offset)
    covered &= np.isfinite(refl)
    refl = np.where(covered, refl, np.float32(np.nan)).astype(np.float32)
    return refl, covered


def reflectance_analysis_mask(
    refl: np.ndarray,
    *,
    vmin: float = REFLECTANCE_MIN,
    vmax: float = REFLECTANCE_MAX,
) -> np.ndarray:
    """Flag samples whose reflectance is plausible enough to index.

    Separate from coverage so a pixel can be *displayed* while being
    *excluded from analysis*, rather than either silently used or silently
    hidden.
    """
    return (np.isfinite(refl) & (refl >= vmin) & (refl <= vmax)).astype(np.uint8)


def quality_mask_from_scl(
    scl: np.ndarray, excluded: Iterable[int] = DEFAULT_EXCLUDED_SCL
) -> tuple[np.ndarray, np.ndarray]:
    """Turn raw SCL codes into a validity mask.

    Returns ``(valid, scl_kept)`` where ``scl_kept`` marks retained classes.
    Unknown codes are treated as invalid: an unrecognised class means the
    classification scheme changed, and masking is the safe default.
    """
    excluded_set = set(excluded)
    code = scl.astype(np.int32, copy=False)
    known = np.zeros(code.shape, dtype=bool)
    for value in SCL_CLASSES:
        known |= code == value
    retained = known & ~np.isin(code, list(excluded_set))
    valid = retained
    for value in excluded_set:
        if value not in SCL_CLASSES:
            valid = np.zeros(code.shape, dtype=bool)
            break
    return valid, retained.astype(np.uint8)
