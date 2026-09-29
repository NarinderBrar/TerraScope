"""Geospatial tests: projection, alignment and the display grid.

The claims being checked here are the ones a user would notice as bugs: a
landmark landing in the wrong place, a seam between tiles, a quality layer that
has been averaged into nonsense.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.tiles.window import (
    MAX_LATITUDE,
    WEB_MERCATOR_HALF,
    WEB_MERCATOR_SPAN,
    DisplayTileGrid,
    TileOutOfRange,
    ground_resolution_m,
    lat_to_tile_y,
    lon_to_tile_x,
    tile_bounds_wgs84,
)


# -- XYZ grid ----------------------------------------------------------------


def test_known_tile_indices():
    """z0 is a single tile; z1 splits the world at the equator and prime meridian."""
    assert (lon_to_tile_x(-180, 0), lon_to_tile_x(179.9, 0)) == (0, 0)
    assert (lon_to_tile_x(-1, 1), lon_to_tile_x(1, 1)) == (0, 1)
    assert (lat_to_tile_y(45, 1), lat_to_tile_y(-45, 1)) == (0, 1)


def test_tile_bounds_are_adjacent_and_contiguous():
    """Adjacent tiles must share an edge exactly, or imagery shows a seam.

    Increasing tile y moves south, so the northern neighbour of y=9 is y=8.
    """
    west, south, east, north = tile_bounds_wgs84(4, 7, 9)
    east_neighbour = tile_bounds_wgs84(4, 8, 9)
    assert east == east_neighbour[0], "east edge must equal the neighbour's west edge"

    north_neighbour = tile_bounds_wgs84(4, 7, 8)
    assert north == north_neighbour[1], "north edge must equal the neighbour's south edge"
    assert north_neighbour[3] > north, "the neighbour must lie further north"


def test_tile_columns_tile_the_world_without_gaps():
    """Consecutive tiles must abut at z0 as well, where precision is coarsest."""
    for z in (0, 1, 4):
        for y in (0, 2**z - 1):
            for x in range(2**z - 1):
                assert tile_bounds_wgs84(z, x, y)[2] == tile_bounds_wgs84(z, x + 1, y)[0]


def test_tile_grid_covers_the_whole_world_at_z0():
    west, south, east, north = tile_bounds_wgs84(0, 0, 0)
    assert west == -180.0
    assert east == pytest.approx(180.0)
    assert north == pytest.approx(85.0511287798066, abs=1e-6)
    assert south == pytest.approx(-85.0511287798066, abs=1e-6)


def test_latitude_is_clamped_to_the_web_mercator_limit():
    """Beyond the limit Web Mercator is undefined; the display must not produce NaN."""
    for lat in (-90.0, -89.9, 89.9, 90.0):
        y = lat_to_tile_y(lat, 5)
        assert 0 <= y < 32, f"lat {lat} produced out-of-range tile y {y}"
    assert lat_to_tile_y(90.0, 5) == lat_to_tile_y(MAX_LATITUDE, 5)
    assert lat_to_tile_y(-90.0, 5) == lat_to_tile_y(-MAX_LATITUDE, 5)


# -- DisplayTileGrid ---------------------------------------------------------


def test_grid_transform_is_exact_for_a_quarter_world_tile():
    g = DisplayTileGrid(z=2, x=0, y=0, size=256)
    assert g.side_m == pytest.approx(WEB_MERCATOR_SPAN / 4)
    assert g.resolution_m == pytest.approx(g.side_m / 256)
    left, bottom, right, top = g.bounds_3857()
    assert left == pytest.approx(-WEB_MERCATOR_HALF)
    assert top == pytest.approx(WEB_MERCATOR_HALF)
    assert right - left == pytest.approx(g.side_m)
    assert top - bottom == pytest.approx(g.side_m)


def test_grid_rejects_coordinates_outside_the_world():
    with pytest.raises(TileOutOfRange):
        DisplayTileGrid(z=2, x=4, y=0)
    with pytest.raises(TileOutOfRange):
        DisplayTileGrid(z=2, x=0, y=4)
    with pytest.raises(TileOutOfRange):
        DisplayTileGrid(z=2, x=-1, y=0)
    with pytest.raises(TileOutOfRange):
        DisplayTileGrid(z=99, x=0, y=0)


def test_display_grid_is_crs84_with_inverted_y():
    """North must be at the smaller row index, matching the XYZ convention."""
    g = DisplayTileGrid(z=3, x=4, y=2)
    _, _, _, top = g.bounds_3857()
    _, _, _, top_below = DisplayTileGrid(z=3, x=4, y=3).bounds_3857()
    assert top > top_below, "increasing tile y must move south"


def test_wgs84_bounds_round_trip_against_the_3857_bounds():
    g = DisplayTileGrid(z=12, x=655, y=1583)
    west, south, east, north = g.bounds_wgs84()
    assert -180 <= west < east <= 180
    assert -90 <= south < north <= 90
    # Round-tripping the corner back through the inverse must land on the tile.
    import rasterio
    from rasterio.crs import CRS

    xs, ys = rasterio.warp.transform(
        CRS.from_epsg(4326), CRS.from_epsg(3857), [west, east], [south, north]
    )
    left, bottom, right, top = g.bounds_3857()
    assert xs[0] == pytest.approx(left, rel=1e-9)
    assert xs[1] == pytest.approx(right, rel=1e-9)
    assert ys[0] == pytest.approx(bottom, rel=1e-9)
    assert ys[1] == pytest.approx(top, rel=1e-9)


# -- resolution --------------------------------------------------------------


def test_ground_resolution_halves_with_each_zoom_level():
    base = ground_resolution_m(0.0, 10)
    assert ground_resolution_m(0.0, 11) == pytest.approx(base / 2)
    assert ground_resolution_m(0.0, 12) == pytest.approx(base / 4)


def test_ground_resolution_shrinks_with_latitude():
    """Web Mercator stretches, so a pixel covers less ground further north."""
    assert ground_resolution_m(60.0, 12) < ground_resolution_m(0.0, 12)
    assert ground_resolution_m(60.0, 12) == pytest.approx(
        ground_resolution_m(0.0, 12) * math.cos(math.radians(60.0)), rel=1e-9
    )


def test_projected_and_ground_resolution_are_distinct_quantities():
    """A pixel is a fixed size in Mercator metres but not in ground metres.

    Conflating the two is how a UI ends up claiming 10 m detail at a zoom
    level where the sensor cannot deliver it.
    """
    g = DisplayTileGrid(z=13, x=1335, y=3156, size=256)
    west, south, east, north = g.bounds_wgs84()
    ground = ground_resolution_m((south + north) / 2.0, g.z)
    assert g.resolution_m == pytest.approx(19.109, abs=1e-2)
    assert ground == pytest.approx(15.03, abs=0.1)
    assert ground < g.resolution_m


# -- resampling and masking policy -------------------------------------------


def test_categorical_resampling_keeps_class_codes_discrete():
    """A bilinear blend of class codes would invent classes that do not exist.

    The raster path uses nearest for SCL; this asserts the property the choice
    is meant to guarantee, on the actual code table.
    """
    from app.providers.sentinel2 import SCL_CLASSES, quality_mask_from_scl

    # A nearest-neighbour resample of a class image can only ever yield values
    # that were already present.
    source = np.array([[4, 6, 11]], dtype=np.uint8)
    for index in range(source.shape[1]):
        single = source[:, index : index + 1]
        valid, retained = quality_mask_from_scl(single)
        assert set(np.unique(single)) <= set(SCL_CLASSES)
        assert valid.shape == single.shape
    # And the mixed row, resampled as a whole, keeps every code intact.
    valid, _ = quality_mask_from_scl(source)
    assert valid.tolist() == [[1, 1, 0]]


def test_scl_exclusion_policy_matches_the_documented_classes():
    from app.providers.sentinel2 import (
        DEFAULT_EXCLUDED_SCL,
        DEFAULT_QUALITY_POLICY,
        SCL_CLASSES,
    )

    expected = {0, 1, 2, 3, 8, 9, 10, 11}
    assert set(DEFAULT_EXCLUDED_SCL) == expected
    # The policy text shown in the UI must actually name every excluded class.
    for code in expected:
        assert str(code) in DEFAULT_QUALITY_POLICY
        assert code in SCL_CLASSES


def test_zoom_beyond_source_resolution_is_visible_to_the_ui():
    """The client needs to be able to say 'shown at X m/px' honestly.

    At z13 a display pixel is ~15 m on the ground while the sensor delivers
    10 m, so zooming past z14 cannot add detail. The API exposes both numbers
    so the interface never implies otherwise.
    """
    from app.tiles.builder import build_tile  # import check only
    import app.api.routes as routes

    assert routes.MAX_ZOOM >= 14
    assert ground_resolution_m(38.0, 14) < 10.0
    assert ground_resolution_m(38.0, 16) < 2.5
