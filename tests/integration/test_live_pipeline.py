"""Live integration tests.

These hit the public STAC catalog and the AWS Open Data COG endpoints. They are
marked ``network`` so they can be deselected in an offline run:

    pytest -m "not network"      # offline
    pytest -m network            # live

They are the only tests that prove the data path end to end. Everything else
uses synthetic arrays, which is deliberate: a green suite here should mean the
arithmetic is right, not that the network was up.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pytest

from app.catalog.stac import StacClient, StacError, validate_asset_url, validate_id
from app.providers.sentinel2 import UnsupportedScene, parse_scene
from app.protocol.eot1 import decode_metadata
from app.tiles.analysis import NDVI_EPSILON, ndvi
from app.tiles.builder import build_tile
from app.tiles.dataset_cache import DATASETS
from app.tiles.window import DisplayTileGrid, lat_to_tile_y, lon_to_tile_x

from tests.conftest import CA, CLOUD_REFERENCE_SCENE, REFERENCE_DIR, TILE

pytestmark = [pytest.mark.network, pytest.mark.slow]

COLLECTION = "sentinel-2-l2a"


@pytest.fixture(scope="module")
def client() -> StacClient:
    c = StacClient()
    yield c
    c.close()


@pytest.fixture(scope="module")
def scene(client: StacClient):
    """Parse the pinned reference scene, or fall back to a live search.

    The pinned id keeps the test deterministic; the fallback means the suite
    still runs if the catalog reorganises.
    """
    try:
        return parse_scene(client.get_item(COLLECTION, CLOUD_REFERENCE_SCENE), COLLECTION)
    except StacError:
        found = client.search(
            collections=[COLLECTION],
            bbox=CA,
            start="2024-06-01T00:00:00Z",
            end="2024-06-30T23:59:59Z",
            max_cloud_cover=5.0,
            limit=1,
        )
        features = found.get("features", [])
        if not features:
            pytest.skip("no Sentinel-2 scene found for the reference area")
        return parse_scene(features[0], COLLECTION)


# -- catalog -----------------------------------------------------------------


def test_live_search_returns_scenes(client: StacClient):
    found = client.search(
        collections=[COLLECTION],
        bbox=CA,
        start="2024-06-01T00:00:00Z",
        end="2024-06-30T23:59:59Z",
        max_cloud_cover=10.0,
        limit=5,
    )
    features = found.get("features", [])
    assert features, "live search returned nothing for a populated agricultural area"
    for feature in features:
        assert feature["id"]
        assert feature["properties"]["datetime"]
        assert len(feature["bbox"]) == 4


def test_live_scene_exposes_every_required_band(scene):
    for name in ("red", "green", "blue", "nir"):
        assert name in scene.bands, f"{name} missing"
        assert scene.bands[name].scale > 0
    assert scene.quality is not None, "SCL is required for the documented mask policy"
    assert scene.bands["red"].gsd == 10.0


def test_calibration_metadata_is_read_not_assumed(scene):
    """The archive has been reprocessed in place, so the offset is not a constant."""
    band = scene.bands["red"]
    assert band.scale == pytest.approx(1e-4)
    assert band.offset == pytest.approx(-0.1), (
        "Earth Search reprocessed this collection under baseline 05.x; if the "
        "offset has genuinely changed, the provider must read it from metadata "
        "(which it does) -- update this assertion only with a reason."
    )
    assert band.nodata == 0.0


def test_asset_hosts_are_allowlisted(scene):
    for band in scene.bands.values():
        validate_asset_url(band.href)
    validate_asset_url(scene.quality.href)


# -- security posture --------------------------------------------------------


@pytest.mark.parametrize(
    "bad",
    [
        "http://evil.example.com/x.tif",  # not https
        "https://evil.example.com/x.tif",  # not allowlisted
        "https://sentinel-cogs.s3.us-west-2.amazonaws.com.evil.com/x.tif",  # suffix trick
        "file:///etc/passwd",
    ],
)
def test_arbitrary_urls_are_rejected(bad: str):
    with pytest.raises(StacError):
        validate_asset_url(bad)


@pytest.mark.parametrize("bad", ["", "a/b", "../etc", "x" * 200, "id;rm -rf", "a b"])
def test_path_traversal_in_identifiers_is_rejected(bad: str):
    with pytest.raises(StacError):
        validate_id(bad)


# -- tiles -------------------------------------------------------------------


@pytest.fixture(scope="module")
def tile_bytes(scene):
    from app.protocol.eot1 import encode

    z, x, y = TILE
    grid = DisplayTileGrid(z=z, x=x, y=y)
    return encode(build_tile(scene, grid, ["red", "green", "blue", "nir"]))


def test_live_tile_round_trips(tile_bytes: bytes):
    meta = decode_metadata(tile_bytes)
    header = meta["header"]
    assert header["width"] == 256 and header["height"] == 256
    assert header["calibrated"] is True
    assert header["calibration"]["appliedOnce"] is True
    assert header["calibration"]["ndviEpsilon"] == NDVI_EPSILON
    assert {b["name"] for b in header["bands"]} == {"red", "green", "blue", "nir"}
    assert {m["name"] for m in header["masks"]} >= {"red", "nir", "quality"}
    assert "Sentinel" in header["attribution"]
    assert header["sources"]["itemId"]
    assert header["sources"]["datetime"]


def test_tile_declares_its_own_resampling_policy(tile_bytes: bytes):
    """A consumer must be able to see that quality was not interpolated."""
    header = decode_metadata(tile_bytes)["header"]
    assert set(header["sources"]["resampling"].values()) == {"bilinear"}
    assert header["sources"]["qualityResampling"] == "nearest"
    assert header["sources"]["sourceResolutionM"]["red"] == 10.0
    assert header["sources"]["qualityResolutionM"] == 20.0


def test_adjacent_tiles_share_a_consistent_grid(scene):
    """The two alignment claims that matter: exact grid, no resampling seam."""
    from app.protocol.eot1 import encode

    z, x, y = TILE
    left = build_tile(scene, DisplayTileGrid(z=z, x=x, y=y), ["red", "nir"])
    right = build_tile(scene, DisplayTileGrid(z=z, x=x + 1, y=y), ["red", "nir"])
    left_bytes, right_bytes = encode(left), encode(right)

    a = decode_metadata(left_bytes)["header"]
    b = decode_metadata(right_bytes)["header"]
    assert a["grid"]["z"] == b["grid"]["z"]
    # Shared edge must be the same longitude to full precision.
    assert a["bounds"][2] == b["bounds"][0], "adjacent tiles must abut exactly"
    assert a["grid"]["crs"] == b["grid"]["crs"] == "EPSG:3857"

    from app.protocol.eot1 import decode

    da, db = decode(left_bytes), decode(right_bytes)
    # Continuity across the seam: the last column of A and the first of B come
    # from adjacent source locations, so on real data they must be close where
    # both are valid. A gross jump means the grids are misaligned.
    a_col = da.bands["nir"][:, -1]
    b_col = db.bands["nir"][:, 0]
    both = np.isfinite(a_col) & np.isfinite(b_col)
    if both.sum() > 100:
        assert np.nanmax(np.abs(a_col[both] - b_col[both])) < 0.25, (
            "seam between adjacent tiles is too large to be resampling noise"
        )


def test_tile_outside_coverage_is_masked_not_invented(scene):
    """A tile far from the granule must come back empty, not filled with zeros."""
    from app.protocol.eot1 import decode, encode

    # A tile in the middle of the Pacific; this MGRS granule cannot cover it.
    grid = DisplayTileGrid(z=12, x=200, y=1500)
    decoded = decode(encode(build_tile(scene, grid, ["red", "nir"])))
    coverage = decoded.masks["coverage:red"]
    assert coverage.mean() == 0.0, "outside coverage must be entirely masked"
    assert np.isnan(decoded.bands["red"]).all(), "no values may be invented"


def test_gpu_parity_reference_is_written(scene, tile_bytes: bytes):
    """Emit the CPU reference the WebGPU compute path is checked against.

    Written to tests/fixtures so the browser test and the Python test read the
    exact same numbers.
    """
    from app.protocol.eot1 import decode

    decoded = decode(tile_bytes)
    out: dict[str, np.ndarray] = {
        "red": decoded.bands["red"],
        "nir": decoded.bands["nir"],
        "green": decoded.bands["green"],
        "blue": decoded.bands["blue"],
        "coverage:red": decoded.masks["coverage:red"],
        "coverage:nir": decoded.masks["coverage:nir"],
        "red_mask": decoded.masks["red"],
        "nir_mask": decoded.masks["nir"],
        "quality": decoded.masks["quality"],
    }
    index, valid = ndvi(
        decoded.bands["red"],
        decoded.bands["nir"],
        decoded.masks["red"],
        decoded.masks["nir"],
        decoded.masks["quality"],
    )
    out["ndvi"] = index
    out["ndvi_valid"] = valid

    REFERENCE_DIR.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(REFERENCE_DIR / "cpu_reference.npz", **out)
    meta = {
        "epsilon": NDVI_EPSILON,
        "width": decoded.header["width"],
        "height": decoded.header["height"],
        "z": TILE[0],
        "x": TILE[1],
        "y": TILE[2],
        "scene": decoded.header["sources"]["itemId"],
        "datetime": decoded.header["sources"]["datetime"],
    }
    (REFERENCE_DIR / "cpu_reference.json").write_text(json.dumps(meta, indent=2))
    assert np.isfinite(index[valid > 0]).all()
    assert valid.mean() > 0.1, "reference tile should have usable NDVI samples"


def test_unsupported_profile_is_reported_not_substituted(scene):
    with pytest.raises(UnsupportedScene):
        scene.band_for("swir16") if "swir16" not in scene.bands else scene.band_for("thermal")


def test_scene_requiring_a_missing_band_raises(scene):
    with pytest.raises(UnsupportedScene, match="does not provide"):
        scene.band_for("cirrus")
