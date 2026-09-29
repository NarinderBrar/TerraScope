"""FastAPI surface for the raster service.

Two responsibilities only: turn a validated request into a numeric tile, and
turn any failure into a status the client can render. No business rules about
what imagery means live here -- that is the provider adapter's job.
"""

from __future__ import annotations

import os
import time
import base64
import json
import math
from typing import Any
from urllib.parse import urlparse

from fastapi import FastAPI, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
import numpy as np

from app.catalog.stac import StacClient, StacError, HostNotAllowed, validate_id
from app.protocol.eot1 import PROCESSING_VERSION, Eot1Error, encode
from app.providers.sentinel2 import (
    DEFAULT_EXCLUDED_SCL,
    DEFAULT_QUALITY_POLICY,
    QUALITY_ROLE,
    REFLECTANCE_POLICY,
    UnsupportedScene,
    parse_scene,
)
from app.tiles.analysis import NDVI_EPSILON, ndvi
from app.tiles.builder import build_tile
from app.tiles.window import (
    AssetPool, DisplayTileGrid, TileOutOfRange, ground_resolution_m,
    lon_to_tile_x, lat_to_tile_y,
)

COLLECTIONS = os.environ.get("ALLOWED_COLLECTIONS", "sentinel-2-l2a,sentinel-2-c1-l2a").split(",")
PROFILE_BANDS: dict[str, list[str]] = {"rgb": ["red", "green", "blue"], "rednir": ["red", "nir"], "rgbn": ["red", "green", "blue", "nir"]}
MAX_ZOOM = int(os.environ.get("MAX_ZOOM", "18"))
MIN_ZOOM = int(os.environ.get("MIN_ZOOM", "8"))
TILE_SIZE = 256
#: Ceiling on scenes returned in one page, independent of client input.
MAX_RESULTS = 50
MAX_ANALYSIS_PIXELS = 1_000_000

app = FastAPI(title="TerraScope raster service", version="0.1.0")
_stac = StacClient()
_STARTED = time.time()


class SearchBody(BaseModel):
    bbox: list[float] = Field(min_length=4, max_length=4)
    start: str
    end: str
    maxCloudCover: float | None = Field(default=None, ge=0, le=100)
    limit: int = Field(default=20, ge=1, le=MAX_RESULTS)
    collections: list[str] | None = None
    cursor: str | None = Field(default=None, max_length=4096)

    @field_validator("bbox")
    @classmethod
    def _check_bbox(cls, v: list[float]) -> list[float]:
        west, south, east, north = v
        if not (-180 <= west <= 180 and -180 <= east <= 180):
            raise ValueError("bbox longitudes out of range")
        if not (-90 <= south <= 90 and -90 <= north <= 90):
            raise ValueError("bbox latitudes out of range")
        if north <= south:
            raise ValueError("bbox has no northward extent")
        if south >= -85.0511 and north <= 85.0511 and east >= west:
            if (east - west) * (north - south) > 90:
                raise ValueError("bbox area exceeds the per-request limit")
        return v

    @field_validator("start", "end")
    @classmethod
    def _check_date(cls, v: str) -> str:
        # Delegates real parsing to the catalog; this only rejects obviously
        # malformed values before spending an upstream round trip.
        if not v or len(v) > 40 or not v[0].isdigit():
            raise ValueError("date must begin with a year")
        return v


class RegionStatsBody(BaseModel):
    collection: str
    sceneA: str
    sceneB: str | None = None
    bbox: list[float] = Field(min_length=4, max_length=4)
    resolutionM: float = Field(ge=10, le=2000)
    qualityPolicy: str = Field(min_length=1, max_length=512)
    threshold: float = Field(default=0.2, ge=0, le=2)

    @field_validator("bbox")
    @classmethod
    def _stats_bbox(cls, v: list[float]) -> list[float]:
        west, south, east, north = v
        if not (-180 <= west < east <= 180 and -85.0511 <= south < north <= 85.0511):
            raise ValueError("statistics bbox must be ordered and inside the Web Mercator limits")
        return v

@app.exception_handler(StacError)
async def _stac_error(_: Request, exc: StacError) -> JSONResponse:
    return JSONResponse({"error": str(exc), "type": type(exc).__name__}, status_code=exc.status)


@app.exception_handler(UnsupportedScene)
async def _unsupported(_: Request, exc: UnsupportedScene) -> JSONResponse:
    return JSONResponse({"error": str(exc), "type": "UnsupportedScene"}, status_code=422)


@app.exception_handler(TileOutOfRange)
async def _tile_range(_: Request, exc: TileOutOfRange) -> JSONResponse:
    return JSONResponse({"error": str(exc), "type": "TileOutOfRange"}, status_code=400)


@app.exception_handler(Eot1Error)
async def _protocol(_: Request, exc: Eot1Error) -> JSONResponse:
    return JSONResponse({"error": str(exc), "type": "Eot1Error"}, status_code=500)


def _normalise(item: dict[str, Any], collection: str) -> dict[str, Any] | None:
    try:
        scene = parse_scene(item, collection)
    except UnsupportedScene:
        return None
    bands = {
        name: {"available": True, "resolutionM": asset.gsd, "asset": asset.asset_key}
        for name, asset in scene.bands.items()
    }


def _encode_cursor(body: dict[str, Any]) -> str:
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(token: str) -> dict[str, Any]:
    try:
        padded = token + "=" * (-len(token) % 4)
        body = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise StacError("invalid search cursor", status=400) from exc
    if not isinstance(body, dict):
        raise StacError("invalid search cursor", status=400)
    allowed = {"collections", "bbox", "datetime", "limit", "sortby", "query", "token"}
    if set(body) - allowed:
        raise StacError("search cursor contains unsupported fields", status=400)
    collections = body.get("collections")
    if not isinstance(collections, list) or not collections or any(c not in COLLECTIONS for c in collections):
        raise StacError("search cursor contains a forbidden collection", status=403)
    limit = body.get("limit", 20)
    if not isinstance(limit, int) or not 1 <= limit <= MAX_RESULTS:
        raise StacError("search cursor has an invalid limit", status=400)
    return body


def _next_cursor(raw: dict[str, Any]) -> str | None:
    for link in raw.get("links", []):
        if not isinstance(link, dict) or link.get("rel") != "next":
            continue
        href = link.get("href")
        method = str(link.get("method", "GET")).upper()
        parsed = urlparse(href) if isinstance(href, str) else None
        expected = urlparse(_stac.base_url)
        if not parsed or parsed.scheme != expected.scheme or parsed.netloc != expected.netloc or parsed.path != f"{expected.path.rstrip('/')}/search":
            continue
        if method != "POST" or not isinstance(link.get("body"), dict):
            continue
        # Decode applies the same allowlist when the token returns. Applying it
        # now avoids emitting a cursor we know cannot be consumed.
        token = _encode_cursor(link["body"])
        _decode_cursor(token)
        return token
    return None
    return {
        "id": scene.item_id,
        "collection": collection,
        "datetime": scene.datetime,
        "bbox": scene.bbox,
        "geometry": scene.geometry,
        "cloudCover": scene.cloud_cover,
        "bands": bands,
        "attribution": scene.attribution,
        "processingVersion": PROCESSING_VERSION,
        "qualityAvailable": scene.quality is not None,
    }


@app.get("/api/health")
def health() -> dict[str, Any]:
    """Readiness without secrets. Never fails the container's health check on
    upstream state -- a cold or rate-limited catalog must not kill the pod."""
    return {
        "status": "ok",
        "uptimeSeconds": round(time.time() - _STARTED, 1),
        "collections": COLLECTIONS,
        "processingVersion": PROCESSING_VERSION,
        # Also as `version`: a tile client needs to know which processing rules
        # produced the numbers on screen, and the service build number is not
        # that value.
        "version": PROCESSING_VERSION,
    }


@app.get("/api/config")
def config() -> dict[str, Any]:
    return {
        "collections": COLLECTIONS,
        "profiles": list(PROFILE_BANDS),
        "bands": ["red", "green", "blue", "nir"],
        "minZoom": MIN_ZOOM,
        "maxZoom": MAX_ZOOM,
        "tileSize": TILE_SIZE,
        "crs": "EPSG:3857",
        "limits": {
            "maxBboxAreaDeg2": 90.0,
            "maxResultsPerPage": MAX_RESULTS,
            "maxDateRangeDays": 366,
            "maxSceneIdLength": 128,
        },
        "qualityPolicy": DEFAULT_QUALITY_POLICY,
        "reflectancePolicy": REFLECTANCE_POLICY,
        "excludedSclClasses": sorted(DEFAULT_EXCLUDED_SCL),
        "ndviEpsilon": NDVI_EPSILON,
        "processingVersion": PROCESSING_VERSION,
    }


@app.post("/api/scenes/search")
def search_scenes(body: SearchBody) -> dict[str, Any]:
    collections = [c for c in (body.collections or COLLECTIONS) if c in COLLECTIONS]
    if not collections:
        return {"error": "no permitted collections requested", "type": "Forbidden"}, 403
    if body.cursor:
        raw = _stac.search_page(_decode_cursor(body.cursor))
    elif body.bbox[0] > body.bbox[2]:
        # STAC bboxes cannot wrap. Query both sides and merge by item identity;
        # this keeps worldwide search usable around ±180 without inventing a
        # 358-degree-wide rectangle.
        parts = [
            (body.bbox[0], body.bbox[1], 180.0, body.bbox[3]),
            (-180.0, body.bbox[1], body.bbox[2], body.bbox[3]),
        ]
        responses = [
            _stac.search(collections=collections, bbox=part, start=body.start, end=body.end, max_cloud_cover=body.maxCloudCover, limit=body.limit)
            for part in parts
        ]
        features = {feature.get("id"): feature for response in responses for feature in response.get("features", []) if feature.get("id")}
        ordered = sorted(features.values(), key=lambda feature: feature.get("properties", {}).get("datetime", ""), reverse=True)
        raw = {"features": ordered[:body.limit], "numberMatched": sum(int(response.get("numberMatched") or 0) for response in responses), "links": []}
    else:
        raw = _stac.search(
            collections=collections,
            bbox=(body.bbox[0], body.bbox[1], body.bbox[2], body.bbox[3]),
            start=body.start,
            end=body.end,
            max_cloud_cover=body.maxCloudCover,
            limit=body.limit,
        )
    scenes: list[dict[str, Any]] = []
    for feature in raw.get("features", []):
        collection = feature.get("collection") or (collections[0] if collections else "")
        normalised = _normalise(feature, collection)
        if normalised is not None:
            scenes.append(normalised)
    return {
        "scenes": scenes,
        "nextCursor": _next_cursor(raw),
        "matched": raw.get("numberMatched"),
    }


@app.get("/api/scenes/{collection}/{scene}")
def scene_detail(collection: str, scene: str) -> dict[str, Any]:
    if collection not in COLLECTIONS:
        return JSONResponse({"error": "collection not permitted", "type": "Forbidden"}, status_code=403)
    item = _stac.get_item(collection, validate_id(scene))
    parsed = parse_scene(item, collection)
    detail = _normalise(item, collection)
    assert detail is not None
    # The quality band lives outside `bands` because it is categorical and
    # resampled differently, but the client still needs its GSD: it is what
    # makes the difference between "10 m imagery" and "20 m cloud mask" visible
    # in the status line rather than a surprise at the pixel level.
    resolution = {name: asset.gsd for name, asset in parsed.bands.items()}
    if parsed.quality is not None:
        resolution[QUALITY_ROLE] = parsed.quality.gsd
    return {
        "scene": detail,
        "qualityPolicy": DEFAULT_QUALITY_POLICY,
        "reflectancePolicy": REFLECTANCE_POLICY,
        "sourceResolutionM": resolution,
        "supportedProfiles": [
            p
            for p, names in PROFILE_BANDS.items()
            if all(n in parsed.bands for n in names)
        ],
    }


@app.get("/api/tiles/{collection}/{scene}/{z}/{x}/{y}")
def tile(
    collection: str,
    scene: str,
    z: int,
    x: int,
    y: int,
    profile: str = Query(default="rgb", pattern="^(rgb|rednir|rgbn)$"),
    qualityMask: bool = Query(default=True),
) -> Response:
    """Produce one numeric tile.

    Failures are explicit: 403 for a collection we do not serve, 422 when the
    scene cannot satisfy the profile, 502 when the catalog is down. The client
    distinguishes these from "no data here", which is a successful tile with a
    zero coverage mask.
    """
    if collection not in COLLECTIONS:
        raise StacError("collection not permitted", status=403)
    if not MIN_ZOOM <= z <= MAX_ZOOM:
        raise StacError(f"zoom {z} outside supported range [{MIN_ZOOM},{MAX_ZOOM}]", status=400)
    validate_id(scene)

    grid = DisplayTileGrid(z=z, x=x, y=y, size=TILE_SIZE)
    names = PROFILE_BANDS[profile]
    item = _stac.get_item(collection, scene)
    parsed = parse_scene(item, collection)
    missing = [n for n in names if n not in parsed.bands]
    if missing:
        raise UnsupportedScene(f"scene {scene} lacks bands {missing} required by profile {profile}")

    with AssetPool() as pool:
        built = build_tile(parsed, grid, names, apply_quality_mask=qualityMask, pool=pool)
    blob = encode(built)

    return Response(
        content=blob,
        media_type="application/octet-stream",
        headers={
            "Content-Length": str(len(blob)),
            # Keyed on everything that can change a pixel, so a policy or
            # calibration change can never serve a stale tile.
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-EOT-Version": PROCESSING_VERSION,
            "X-Tile-Profile": profile,
            "X-Quality-Mask": "on" if qualityMask else "off",
            "Access-Control-Expose-Headers": "X-EOT-Version, X-Tile-Profile",
        },
    )


@app.get("/api/ground-resolution")
def resolution(lat: float = Query(ge=-90, le=90), z: int = Query(ge=0, le=24)) -> dict[str, Any]:
    """Output pixel size at a latitude. Lets the UI show 'source 10 m, shown at
    X m/px' so zooming in never implies extra detail."""
    return {"groundResolutionM": ground_resolution_m(lat, z), "z": z, "lat": lat}


def _tile_arrays(tile: Any) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray]]:
    return ({entry.name: entry.array for entry in tile.bands}, {entry.name: entry.array for entry in tile.masks})


def _region_mask(grid: DisplayTileGrid, bbox: list[float]) -> np.ndarray:
    west, south, east, north = bbox
    n = 2**grid.z
    columns = grid.x * TILE_SIZE + np.arange(TILE_SIZE, dtype=np.float64) + 0.5
    rows = grid.y * TILE_SIZE + np.arange(TILE_SIZE, dtype=np.float64) + 0.5
    lon = columns / (n * TILE_SIZE) * 360.0 - 180.0
    mercator = math.pi * (1.0 - 2.0 * rows / (n * TILE_SIZE))
    lat = np.degrees(np.arctan(np.sinh(mercator)))
    return (lat[:, None] >= south) & (lat[:, None] <= north) & (lon[None, :] >= west) & (lon[None, :] <= east)


@app.post("/api/analysis/region")
def region_statistics(body: RegionStatsBody) -> dict[str, Any]:
    if body.collection not in COLLECTIONS:
        raise StacError("collection not permitted", status=403)
    validate_id(body.sceneA)
    if body.sceneB:
        validate_id(body.sceneB)
    if body.qualityPolicy != DEFAULT_QUALITY_POLICY:
        raise StacError("unsupported quality policy", status=400)

    west, south, east, north = body.bbox
    centre_lat = (south + north) / 2.0
    zoom = round(math.log2(156543.03392804097 * math.cos(math.radians(centre_lat)) / body.resolutionM))
    zoom = max(MIN_ZOOM, min(MAX_ZOOM, zoom))
    x0, x1 = lon_to_tile_x(west, zoom), lon_to_tile_x(np.nextafter(east, west), zoom)
    y0, y1 = lat_to_tile_y(north, zoom), lat_to_tile_y(south, zoom)
    grids = [DisplayTileGrid(zoom, x, y, TILE_SIZE) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]
    requested_pixels = sum(int(_region_mask(grid, body.bbox).sum()) for grid in grids)
    if requested_pixels > MAX_ANALYSIS_PIXELS:
        suggested = body.resolutionM * math.sqrt(requested_pixels / MAX_ANALYSIS_PIXELS)
        return JSONResponse(
            {"error": "analysis pixel cap exceeded", "type": "AnalysisTooLarge", "pixelCount": requested_pixels, "maxPixels": MAX_ANALYSIS_PIXELS, "suggestedResolutionM": math.ceil(suggested / 10) * 10},
            status_code=413,
        )

    scene_a = parse_scene(_stac.get_item(body.collection, body.sceneA), body.collection)
    scene_b = parse_scene(_stac.get_item(body.collection, body.sceneB), body.collection) if body.sceneB else None
    common_count = 0
    sum_a = sum_b = sum_delta = 0.0
    above = below = 0
    hist = np.zeros(32, dtype=np.int64)
    hist_delta = np.zeros(32, dtype=np.int64)
    with AssetPool() as pool_a, AssetPool() as pool_b:
        for grid in grids:
            region = _region_mask(grid, body.bbox)
            tile_a = build_tile(scene_a, grid, ["red", "nir"], pool=pool_a)
            bands_a, masks_a = _tile_arrays(tile_a)
            index_a, valid_a = ndvi(bands_a["red"], bands_a["nir"], masks_a["red"], masks_a["nir"], masks_a["quality"])
            if scene_b is not None:
                tile_b = build_tile(scene_b, grid, ["red", "nir"], pool=pool_b)
                bands_b, masks_b = _tile_arrays(tile_b)
                index_b, valid_b = ndvi(bands_b["red"], bands_b["nir"], masks_b["red"], masks_b["nir"], masks_b["quality"])
                common = region & valid_a.astype(bool) & valid_b.astype(bool)
                selected_b = index_b[common]
                delta = selected_b - index_a[common]
                sum_b += float(selected_b.astype(np.float64).sum())
                sum_delta += float(delta.astype(np.float64).sum())
                above += int((delta >= body.threshold).sum())
                below += int((delta <= -body.threshold).sum())
                hist_delta += np.histogram(delta, bins=32, range=(-1.0, 1.0))[0]
            else:
                common = region & valid_a.astype(bool)
            selected_a = index_a[common]
            count = int(common.sum())
            common_count += count
            sum_a += float(selected_a.astype(np.float64).sum())
            hist += np.histogram(selected_a, bins=32, range=(-1.0, 1.0))[0]

    mean = lambda value: value / common_count if common_count else None
    request = body.model_dump()
    return {
        "request": request,
        "validCoverageFraction": common_count / requested_pixels if requested_pixels else 0.0,
        "sampleCount": requested_pixels,
        "commonValidCount": common_count,
        "meanNdviA": mean(sum_a), "meanNdviB": mean(sum_b) if scene_b else None,
        "meanDelta": mean(sum_delta) if scene_b else None,
        "fractionAboveThreshold": above / common_count if scene_b and common_count else None,
        "fractionBelowThreshold": below / common_count if scene_b and common_count else None,
        "histogram": {"bins": 32, "min": -1, "max": 1, "counts": hist.tolist()},
        "histogramDelta": {"bins": 32, "min": -1, "max": 1, "counts": hist_delta.tolist()},
        "approximate": True,
        "attribution": scene_a.attribution,
        "processingVersion": PROCESSING_VERSION,
        "analysisZoom": zoom,
        "actualResolutionM": ground_resolution_m(centre_lat, zoom),
    }
