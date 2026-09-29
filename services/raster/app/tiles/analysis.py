"""CPU reference for every derived quantity the GPU also computes.

This module is the definition of correctness. The browser runs the same formulas
in WGSL, and a conformance test asserts the two agree to a declared absolute
tolerance on identical calibrated inputs. When these two disagree, at least one
of them is wrong and this file is where the argument gets settled.

Validity rules, taken verbatim from the specification:

    validNDVI  = redValid AND nirValid AND qualityValid
                AND finite(red) AND finite(nir)
                AND abs(nir + red) > epsilon
    NDVI       = (nir - red) / (nir + red)
    deltaNDVI  = NDVI_B - NDVI_A
    validDelta = validNDVI_A AND validNDVI_B

The ``epsilon`` term is not optional. When a pixel sits in deep shadow or dark
water, ``nir + red`` approaches zero while the numerator stays finite, and the
ratio explodes to arbitrary magnitude. Those values are noise, not signal.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

#: Guard on the NDVI denominator.
#:
#: Sentinel-2 L2A reflectance is quantised at ``scale`` = 1e-4, so a sample
#: carries roughly +/-0.5 DN = +/-5e-5 of quantisation uncertainty. Once
#: |nir + red| drops near that scale the ratio's relative error is O(1) and the
#: result is dominated by quantisation rather than by the surface. 1e-3 is
#: ~10 DN: conservative enough to reject only genuinely ill-conditioned
#: pixels, small enough not to discard real dark-but-valid observations.
#:
#: This value is declared in the tile header and echoed by the client, so a
#: consumer can always tell which guard produced a given NDVI.
NDVI_EPSILON = 1e-3


def ndvi(
    red: np.ndarray,
    nir: np.ndarray,
    red_valid: np.ndarray,
    nir_valid: np.ndarray,
    quality_valid: np.ndarray,
    *,
    epsilon: float = NDVI_EPSILON,
) -> tuple[np.ndarray, np.ndarray]:
    """Return ``(ndvi, valid)`` with NaN in every invalid position."""
    red_f = red.astype(np.float32, copy=False)
    nir_f = nir.astype(np.float32, copy=False)

    valid = (
        red_valid.astype(bool)
        & nir_valid.astype(bool)
        & quality_valid.astype(bool)
        & np.isfinite(red_f)
        & np.isfinite(nir_f)
    )
    denom = nir_f + red_f
    valid &= np.abs(denom) > np.float32(epsilon)
    # np.errstate keeps the deliberate division by ~0 from raising; the guard
    # above has already excluded every sample where it would happen.
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(valid, (nir_f - red_f) / denom, np.float32(np.nan)).astype(np.float32)
    return out, valid.astype(np.uint8)


def delta_ndvi(
    ndvi_a: np.ndarray,
    ndvi_b: np.ndarray,
    valid_a: np.ndarray,
    valid_b: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Two-date difference on the common valid mask.

    A pixel invalid in *either* date is invalid here. Silently differencing
    against a masked pixel would invent change exactly where the observation is
    least trustworthy.
    """
    common = valid_a.astype(bool) & valid_b.astype(bool)
    common &= np.isfinite(ndvi_a) & np.isfinite(ndvi_b)
    with np.errstate(invalid="ignore"):
        out = np.where(common, ndvi_b - ndvi_a, np.float32(np.nan)).astype(np.float32)
    return out, common.astype(np.uint8)


@dataclass
class Summary:
    """Aggregate over a valid mask. Fractions, not areas -- see plan section 9."""

    count: int
    valid_count: int
    mean: float | None
    stddev: float | None
    min: float | None
    max: float | None
    histogram: np.ndarray

    @property
    def valid_fraction(self) -> float:
        return self.valid_count / self.count if self.count else 0.0


def summarise(
    values: np.ndarray,
    valid: np.ndarray,
    *,
    vmin: float,
    vmax: float,
    bins: int = 32,
) -> Summary:
    mask = valid.astype(bool) & np.isfinite(values)
    selected = values[mask].astype(np.float64, copy=False)
    total = int(values.size)
    n = int(selected.size)
    if n == 0:
        return Summary(total, 0, None, None, None, None, np.zeros(bins, dtype=np.int64))
    # Out-of-range samples are counted, not discarded: clamping them into the
    # histogram would hide a calibration problem behind a tidy distribution.
    hist, _ = np.histogram(selected, bins=bins, range=(vmin, vmax))
    return Summary(
        count=total,
        valid_count=n,
        mean=float(selected.mean()),
        stddev=float(selected.std(ddof=1)) if n > 1 else 0.0,
        min=float(selected.min()),
        max=float(selected.max()),
        histogram=hist,
    )
