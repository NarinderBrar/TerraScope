"""Numeric correctness for calibration and indices.

These tests are the CPU half of the GPU/CPU parity contract. They use synthetic
arrays with exactly-known answers, so a failure points at the arithmetic rather
than at a slow network read.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.providers.sentinel2 import (
    apply_calibration,
    quality_mask_from_scl,
    reflectance_analysis_mask,
)
from app.tiles.analysis import NDVI_EPSILON, delta_ndvi, ndvi, summarise


# -- calibration -------------------------------------------------------------


def test_calibration_applied_exactly_once():
    """A nonzero offset must be applied one time, not zero and not twice.

    Tolerance is 1e-6, which is float32 round-off at this magnitude. Applying
    the offset twice would be wrong by 0.1 -- five orders of magnitude larger --
    so the test still discriminates sharply.
    """
    dn = np.array([[1000, 5000, 12000]], dtype=np.uint16)
    refl, valid = apply_calibration(dn, scale=1e-4, offset=-0.1, nodata=0)
    assert refl[0, 0] == pytest.approx(1000 * 1e-4 - 0.1, abs=1e-6)
    assert refl[0, 1] == pytest.approx(5000 * 1e-4 - 0.1, abs=1e-6)
    assert refl[0, 2] == pytest.approx(12000 * 1e-4 - 0.1, abs=1e-6)
    assert valid.all()


def test_calibration_without_offset_matches_identity():
    """Pre-04.00 baselines have scale 1 / offset 0."""
    dn = np.array([[0, 1, 4000]], dtype=np.uint16)
    refl, valid = apply_calibration(dn, scale=1.0, offset=0.0, nodata=0)
    assert refl[0, 1] == pytest.approx(1.0)
    assert refl[0, 2] == pytest.approx(4000.0)
    assert not valid[0, 0]


def test_nodata_is_masked_before_calibration():
    """DN 0 is nodata. Calibrating it would yield a plausible -0.1, not an error.

    This is the single most important ordering guarantee in the provider: get
    it backwards and a whole granule edge looks like real dark water.
    """
    dn = np.array([[0]], dtype=np.uint16)
    refl, valid = apply_calibration(dn, scale=1e-4, offset=-0.1, nodata=0)
    assert not valid[0, 0]
    assert np.isnan(refl[0, 0])


def test_nonfinite_source_is_rejected():
    dn = np.array([[np.nan, np.inf]], dtype=np.float64)
    _, valid = apply_calibration(dn, scale=1e-4, offset=0.0, nodata=None)
    assert not valid.any()


def test_reflectance_above_range_is_kept_but_flagged_for_analysis():
    """15-bit Sentinel-2 data can exceed 1.0 after calibration.

    It stays displayable and leaves the analytical set rather than being
    silently clamped.
    """
    dn = np.array([[20000, 3000]], dtype=np.uint16)  # 1.9 and 0.2
    refl, covered = apply_calibration(dn, scale=1e-4, offset=0.0, nodata=0)
    assert covered.all()
    mask = reflectance_analysis_mask(refl)
    assert mask[0, 0] == 0, "1.9 must be excluded from analysis"
    assert mask[0, 1] == 1, "0.2 must be usable"
    assert refl[0, 0] == pytest.approx(2.0), "value must survive for display"


# -- NDVI --------------------------------------------------------------------


def _pair(red_value, nir_value, valid=(1, 1, 1)):
    red = np.full((1, 3), red_value, dtype=np.float32)
    nir = np.full((1, 3), nir_value, dtype=np.float32)
    v = np.array([[valid]], dtype=np.uint8)
    return red, nir, v, v.copy()


def test_ndvi_known_values():
    red, nir, vr, vn = _pair(0.1, 0.5)
    out, valid = ndvi(red, nir, vr, vn, np.ones((1, 3), dtype=np.uint8))
    assert out[0, 0] == pytest.approx((0.5 - 0.1) / 0.6)
    assert valid.all()


def test_ndvi_vegetation_and_soil_endpoints():
    ones = np.ones((1, 1), dtype=np.uint8)
    # Dense vegetation: red 0.05, NIR 0.5 -> strongly positive.
    out, valid = ndvi(
        np.float32([[0.05]]), np.float32([[0.5]]), ones, ones, ones
    )
    assert valid[0, 0] == 1
    assert out[0, 0] > 0.8
    # Bare dry soil: red and NIR are close -> near zero.
    out, _ = ndvi(np.float32([[0.30]]), np.float32([[0.35]]), ones, ones, ones)
    assert abs(float(out[0, 0])) < 0.2
    # Water: NIR is lower than red -> negative.
    out, _ = ndvi(np.float32([[0.10]]), np.float32([[0.02]]), ones, ones, ones)
    assert out[0, 0] < -0.5


def test_ndvi_rejects_zero_denominator():
    """red = -nir is the degenerate case. It must be invalid, not infinite."""
    red = np.float32([[0.5, 0.2, 0.0]])
    nir = np.float32([[-0.5, 0.2, 0.0]])
    ones = np.ones((1, 3), dtype=np.uint8)
    out, valid = ndvi(red, nir, ones, ones, ones)
    assert not valid[0, 0], "exact cancellation must be rejected"
    assert np.isnan(out[0, 0])
    assert valid[0, 1], "a small but above-epsilon denominator is fine"
    assert not valid[0, 2], "zero/zero must be rejected"
    assert np.isnan(out[0, 2])


def test_ndvi_rejects_denominator_below_epsilon():
    red = np.float32([[0.0004, 0.01]])
    nir = np.float32([[-0.0004, 0.01]])
    ones = np.ones((1, 2), dtype=np.uint8)
    out, valid = ndvi(red, nir, ones, ones, ones)
    assert not valid[0, 0], "|denom| below epsilon must be rejected"
    assert np.isnan(out[0, 0])
    assert valid[0, 1]


def test_ndvi_requires_both_bands_and_quality():
    red = np.float32([[0.1, 0.1, 0.1]])
    nir = np.float32([[0.5, 0.5, 0.5]])
    vr = np.uint8([[1, 0, 1]])
    vn = np.uint8([[1, 1, 1]])
    q = np.uint8([[1, 1, 0]])
    _, valid = ndvi(red, nir, vr, vn, q)
    assert valid[0, 0] == 1
    assert valid[0, 1] == 0, "red invalid must invalidate"
    assert valid[0, 2] == 0, "quality mask must invalidate"


def test_ndvi_rejects_nonfinite_inputs():
    red = np.float32([[0.1, np.nan]])
    nir = np.float32([[0.5, 0.5]])
    ones = np.ones((1, 2), dtype=np.uint8)
    out, valid = ndvi(red, nir, ones, ones, ones)
    assert valid[0, 0] == 1
    assert valid[0, 1] == 0
    assert np.isnan(out[0, 1])


def test_ndvi_is_bounded_for_physical_inputs():
    """Non-negative reflectance must produce NDVI inside [-1, 1]."""
    rng = np.random.default_rng(20240627)
    red = rng.uniform(0.0, 0.6, size=(64, 64)).astype(np.float32)
    nir = rng.uniform(0.0, 0.9, size=(64, 64)).astype(np.float32)
    ones = np.ones_like(red, dtype=np.uint8)
    out, valid = ndvi(red, nir, ones, ones, ones)
    assert valid.mean() > 0.9
    assert np.nanmin(out) >= -1.0 - 1e-6
    assert np.nanmax(out) <= 1.0 + 1e-6


# -- difference --------------------------------------------------------------


def test_delta_requires_both_dates_valid():
    a = np.float32([[0.2, 0.2, 0.2]])
    b = np.float32([[0.5, 0.5, 0.5]])
    va = np.uint8([[1, 0, 1]])
    vb = np.uint8([[1, 1, 0]])
    out, valid = delta_ndvi(a, b, va, vb)
    assert valid[0, 0] == 1
    assert out[0, 0] == pytest.approx(0.3)
    assert valid[0, 1] == 0, "invalid in A must invalidate"
    assert valid[0, 2] == 0, "invalid in B must invalidate"


def test_delta_ignores_nonfinite_even_when_flags_agree():
    a = np.float32([[0.2, np.nan]])
    b = np.float32([[0.5, 0.5]])
    ones = np.ones((1, 2), dtype=np.uint8)
    out, valid = delta_ndvi(a, b, ones, ones)
    assert valid[0, 0] == 1
    assert valid[0, 1] == 0


# -- quality policy ----------------------------------------------------------


def test_default_scl_policy_excludes_weather_and_artifacts():
    scl = np.array([[0, 1, 2, 3, 8, 9, 10, 11]], dtype=np.uint8)
    valid, retained = quality_mask_from_scl(scl)
    assert not valid.any(), "all of these must be excluded"
    assert not retained.any()


def test_default_scl_policy_keeps_surface_classes():
    scl = np.array([[4, 5, 6, 7]], dtype=np.uint8)
    valid, _ = quality_mask_from_scl(scl)
    assert valid.all()


def test_unknown_scl_codes_are_treated_as_invalid():
    """An unrecognised class means the scheme changed. Masking is the safe default."""
    scl = np.array([[4, 42]], dtype=np.uint8)
    valid, _ = quality_mask_from_scl(scl)
    assert valid[0, 0] == 1
    assert valid[0, 1] == 0


# -- summaries ---------------------------------------------------------------


def test_summary_reports_fractions_not_areas():
    values = np.array([[0.0, 0.5, 1.0, np.nan]], dtype=np.float32)
    valid = np.uint8([[1, 1, 0, 0]])
    s = summarise(values, valid, vmin=-1.0, vmax=1.0)
    assert s.count == 4
    assert s.valid_count == 2
    assert s.valid_fraction == 0.5
    assert s.mean == pytest.approx(0.25)


def test_summary_handles_all_invalid_without_dividing_by_zero():
    values = np.full((4, 4), np.nan, dtype=np.float32)
    valid = np.zeros((4, 4), dtype=np.uint8)
    s = summarise(values, valid, vmin=-1.0, vmax=1.0)
    assert s.valid_count == 0
    assert s.mean is None
    assert s.histogram.sum() == 0


def test_epsilon_is_a_documented_constant():
    """The guard value is part of the published contract, not an implementation detail."""
    assert NDVI_EPSILON == 1e-3
