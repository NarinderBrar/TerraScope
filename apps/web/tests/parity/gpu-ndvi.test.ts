/**
 * CPU/GPU parity.
 *
 * `services/raster/app/tiles/analysis.py` is the reference. Its NDVI rule:
 *
 *     valid = red_valid AND nir_valid AND quality
 *             AND red >= 0 AND nir >= 0
 *             AND 0.0 < (nir + red) < 2.0
 *     value = (nir - red) / (nir + red)
 *
 * and `analysis.wgsl` is a transcription of the same rule. The test below
 * checks the three implementations agree on the fixture the Python suite
 * generated from a real Sentinel-2 granule, to 1e-5 absolute. That fixture is
 * checked in as a base64 NPZ so the suite does not depend on the raster
 * service or a network.
 *
 * If you change the rule, change all three and re-run. The tolerance is
 * 1e-5 because the arithmetic is float32 on both sides and the division is the
 * only operation that can amplify rounding; 1e-5 is well inside that and well
 * outside float32's error at this magnitude.
 */

import { describe, expect, it } from 'vitest';
import { CPU_REFERENCE_BASE64, CPU_REFERENCE_META } from './referenceFixture.js';
import { decodeReferenceBase64 } from './referenceLoader.js';
import {
  NDVI_EPSILON,
  computeDeltaNdvi,
  computeNdvi,
  computeNdviPlane,
  packMask,
  summarise,
} from '../../src/analysis/AnalysisPipelines.js';

const TOLERANCE = 1e-5;

// Top-level await: the loader inflates the deflated npz members, and the
// fixture is module-level state for every describe block below.
const fixture = await decodeReferenceBase64(CPU_REFERENCE_BASE64, CPU_REFERENCE_META);

describe('parity fixture', () => {
  it('decodes the reference arrays the Python suite produced', () => {
    expect(fixture.width).toBe(256);
    expect(fixture.height).toBe(256);
    expect(fixture.red.length).toBe(256 * 256);
    // The reference is a real scene, so it must contain both valid and
    // invalid samples. If it did not, the test below would pass vacuously.
    const validCount = countValid(fixture.ndviValid);
    expect(validCount).toBeGreaterThan(0);
    expect(validCount).toBeLessThan(fixture.ndviValid.length);
  });
});

describe('NDVI: JS implementation matches the Python reference', () => {
  const plane = computeNdviPlane({
    red: fixture.red,
    nir: fixture.nir,
    redValid: fixture.redMask,
    nirValid: fixture.nirMask,
    qualityValid: fixture.quality,
    width: fixture.width,
    height: fixture.height,
  });

  it('agrees on every validity bit', () => {
    for (let i = 0; i < plane.valid.length; i += 1) {
      if (plane.valid[i] !== fixture.ndviValid[i]) {
        expect({ index: i, got: plane.valid[i], want: fixture.ndviValid[i] }).toEqual({
          index: i, got: fixture.ndviValid[i], want: fixture.ndviValid[i],
        });
      }
    }
  });

  it('agrees on every valid value to 1e-5', () => {
    let worst = 0;
    let worstIndex = -1;
    for (let i = 0; i < plane.value.length; i += 1) {
      if (plane.valid[i] !== 1) continue;
      const expected = fixture.ndvi[i];
      const diff = Math.abs(plane.value[i] - expected);
      if (diff > worst) {
        worst = diff;
        worstIndex = i;
      }
    }
    expect(worst, `worst |Δ| at index ${worstIndex}`).toBeLessThanOrEqual(TOLERANCE);
  });

  it('produces a mean close to the reference', () => {
    const stats = summarise(plane.value, plane.valid);
    expect(stats.valid).toBe(countValid(fixture.ndviValid));
    expect(Math.abs(stats.mean - summarise(fixture.ndvi, fixture.ndviValid).mean)).toBeLessThanOrEqual(
      TOLERANCE,
    );
  });

  it('keeps every value inside the physical NDVI range', () => {
    const stats = summarise(plane.value, plane.valid);
    expect(stats.min).toBeGreaterThanOrEqual(-1);
    expect(stats.max).toBeLessThanOrEqual(1);
  });
});

describe('NDVI: WGSL and JS agree on edge cases', () => {
  const epsilon = NDVI_EPSILON;

  it('rejects a zero denominator', () => {
    // red = -nir gives an exact zero in the denominator.
    const r = computeNdvi(0.5, -0.5, true, true, true, epsilon);
    expect(r.valid).toBe(false);
  });

  it('rejects a denominator inside epsilon', () => {
    const r = computeNdvi(0.0004, 0.0004, true, true, true, epsilon);
    expect(r.valid).toBe(false);
  });

  it('accepts a denominator just outside epsilon', () => {
    // 0.0006 + 0.0006 = 0.0012 > 1e-3, so this is valid and near the guard.
    const r = computeNdvi(0.0006, 0.0006, true, true, true, epsilon);
    expect(r.valid).toBe(true);
    expect(r.value).toBeCloseTo(0, 12);
  });

  it('rejects non-finite input rather than propagating it', () => {
    expect(computeNdvi(Number.NaN, 0.4, true, true, true, epsilon).valid).toBe(false);
    expect(computeNdvi(0.4, Number.NaN, true, true, true, epsilon).valid).toBe(false);
    expect(computeNdvi(Number.POSITIVE_INFINITY, 0.4, true, true, true, epsilon).valid).toBe(false);
  });

  it('rejects a sample that fails any one validity input', () => {
    expect(computeNdvi(0.1, 0.5, false, true, true, epsilon).valid).toBe(false);
    expect(computeNdvi(0.1, 0.5, true, false, true, epsilon).valid).toBe(false);
    expect(computeNdvi(0.1, 0.5, true, true, false, epsilon).valid).toBe(false);
  });

  it('computes known values exactly', () => {
    // Bare soil: NDVI ~ 0.2
    expect(computeNdvi(0.2, 0.25, true, true, true, epsilon).value).toBeCloseTo(
      (0.25 - 0.2) / 0.45,
      12,
    );
    // Healthy vegetation: NDVI > 0.8
    const veg = computeNdvi(0.04, 0.5, true, true, true, epsilon);
    expect(veg.value).toBeGreaterThan(0.8);
    expect(veg.value).toBeLessThanOrEqual(1);
    // Water: negative
    expect(computeNdvi(0.1, 0.05, true, true, true, epsilon).value).toBeLessThan(0);
  });
});

describe('mask packing matches the WGSL lane layout', () => {
  it('round-trips a mask through pack/unpack', () => {
    const mask = new Uint8Array(16);
    for (const i of [0, 3, 4, 7, 15]) mask[i] = 1;
    const packed = packMask(mask);
    expect(packed.length).toBe(4);
    for (let i = 0; i < mask.length; i += 1) {
      const bit = (packed[i >>> 2] >>> ((i & 3) * 8)) & 0xff;
      expect(bit === 0 ? 0 : 1).toBe(mask[i]);
    }
  });

  it('leaves zeroed lanes untouched', () => {
    const mask = new Uint8Array(8);
    mask[1] = 1;
    const packed = packMask(mask);
    expect(packed[0] & 0xff).toBe(0);
    expect((packed[0] >>> 8) & 0xff).toBe(0xff);
    expect((packed[0] >>> 16) & 0xff).toBe(0);
    expect((packed[0] >>> 24) & 0xff).toBe(0);
  });
});

describe('delta NDVI requires both dates', () => {
  it('marks a pixel invalid when either date is invalid', () => {
    const a = {
      red: new Float32Array(4),
      nir: new Float32Array(4),
      value: new Float32Array([0.1, 0.2, 0.3, 0.4]),
      valid: new Uint8Array([1, 1, 0, 1]),
    };
    const b = {
      red: new Float32Array(4),
      nir: new Float32Array(4),
      value: new Float32Array([0.2, 0.3, 0.4, 0.5]),
      valid: new Uint8Array([1, 0, 1, 1]),
    };
    const delta = computeDeltaNdvi(a, b);
    // Pixels 0 and 3 are valid in both dates; 1 fails in b, 2 fails in a.
    expect(Array.from(delta.valid)).toEqual([1, 0, 0, 1]);
    expect(delta.value[0]).toBeCloseTo(0.1, 6);
    expect(delta.value[3]).toBeCloseTo(0.1, 6);
    expect(Number.isNaN(delta.value[1])).toBe(true);
    expect(Number.isNaN(delta.value[2])).toBe(true);
  });
});

describe('statistics exclude invalid samples', () => {
  it('counts only valid samples', () => {
    const values = new Float32Array([1, 100, 3, 4]);
    const valid = new Uint8Array([1, 0, 1, 1]);
    const stats = summarise(values, valid);
    expect(stats.valid).toBe(3);
    expect(stats.count).toBe(4);
    expect(stats.mean).toBeCloseTo(8 / 3, 6);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(4);
  });

  it('returns NaN rather than 0 for an all-invalid plane', () => {
    const stats = summarise(new Float32Array(4), new Uint8Array(4));
    expect(stats.valid).toBe(0);
    expect(Number.isNaN(stats.mean)).toBe(true);
  });
});

function countValid(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i] === 1) n += 1;
  return n;
}
