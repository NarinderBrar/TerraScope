/**
 * Vegetation index kernels, on both sides of the parity contract.
 *
 * `computeNdvi` is the normative definition in JavaScript; `NdviGpu` runs the
 * WGSL transcription of the same formula. The parity test asserts they agree
 * to 1e-5 absolute, which is the tolerance the plan sets. Keep the two in
 * step: if the GPU path changes, `computeNdvi` changes with it or the test
 * says so.
 */

export const NDVI_EPSILON = 1e-3;

export interface NdviPlane {
  red: Float32Array;
  nir: Float32Array;
  /** 1 = analytically valid, 0 = not. */
  valid: Uint8Array;
  value: Float32Array;
}

export interface IndexInputs {
  red: Float32Array;
  nir: Float32Array;
  green?: Float32Array;
  blue?: Float32Array;
  redValid: Uint8Array;
  nirValid: Uint8Array;
  qualityValid: Uint8Array;
  width: number;
  height: number;
  /** Value written where the sample is invalid. NaN by default. */
  invalidValue?: number;
}

/**
 * The single CPU definition.
 *
 * Mirrors `services/raster/app/tiles/analysis.py::compute_ndvi` and
 * `analysis.wgsl::computeNdvi`. The three guards are load-bearing:
 *
 *  1. non-finite input is rejected, because NaN propagates silently and would
 *     poison any reduction that touches it;
 *  2. `|nir + red| <= epsilon` is rejected, because a near-zero denominator
 *     yields a value in [-inf, inf] that is numerically real and physically
 *     meaningless;
 *  3. the denominator guard is applied *after* the finite check, so a NaN sum
 *     cannot sneak past as a valid sample.
 */
export function computeNdvi(
  redValue: number,
  nirValue: number,
  redOk: boolean,
  nirOk: boolean,
  qualityOk: boolean,
  epsilon: number = NDVI_EPSILON,
): { value: number; valid: boolean } {
  let valid = redOk && nirOk && qualityOk;
  if (!Number.isFinite(redValue) || !Number.isFinite(nirValue)) {
    return { value: Number.NaN, valid: false };
  }
  const denom = nirValue + redValue;
  if (Math.abs(denom) <= epsilon) {
    return { value: Number.NaN, valid: false };
  }
  const value = (nirValue - redValue) / denom;
  if (!Number.isFinite(value)) {
    return { value: Number.NaN, valid: false };
  }
  return { value, valid: valid && true };
}

export function computeNdviPlane(inputs: IndexInputs): NdviPlane {
  const { red, nir, redValid, nirValid, qualityValid, width, height } = inputs;
  const pixels = width * height;
  const invalid = inputs.invalidValue ?? Number.NaN;
  const value = new Float32Array(pixels);
  const valid = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const result = computeNdvi(red[i], nir[i], redValid[i] === 1, nirValid[i] === 1, qualityValid[i] === 1);
    if (result.valid) {
      value[i] = result.value;
      valid[i] = 1;
    } else {
      value[i] = invalid;
    }
  }
  return { red, nir, value, valid };
}

export function computeDeltaNdvi(a: NdviPlane, b: NdviPlane, invalidValue = Number.NaN): NdviPlane {
  const pixels = a.value.length;
  const value = new Float32Array(pixels);
  const valid = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    // Both dates must be valid. Differencing against a gap invents change
    // exactly where the observation is least trustworthy.
    if (a.valid[i] === 1 && b.valid[i] === 1) {
      value[i] = b.value[i] - a.value[i];
      valid[i] = 1;
    } else {
      value[i] = invalidValue;
    }
  }
  return { red: a.red, nir: a.nir, value, valid };
}

export interface PlaneStatistics {
  count: number;
  total: number;
  valid: number;
  min: number;
  max: number;
  mean: number;
  stdDev: number;
}

export function summarise(values: Float32Array, validMask: Uint8Array): PlaneStatistics {
  const count = values.length;
  let valid = 0;
  let sum = 0;
  let sumSquares = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i += 1) {
    if (validMask[i] !== 1) continue;
    const v = values[i];
    valid += 1;
    sum += v;
    sumSquares += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (valid === 0) {
    return {
      count,
      total: count,
      valid: 0,
      min: Number.NaN,
      max: Number.NaN,
      mean: Number.NaN,
      stdDev: Number.NaN,
    };
  }
  const mean = sum / valid;
  // Population variance over valid samples only, reported next to the count so
  // a small-sample mean cannot be read as a stable one. The E[x^2] - E[x]^2
  // form is used rather than a second pass because these reductions are
  // checksum-grade, and the subtraction can go slightly negative near a
  // constant field; clamping to 0 keeps stdDev real.
  const variance = Math.max(0, sumSquares / valid - mean * mean);
  return {
    count,
    total: count,
    valid,
    min,
    max,
    mean,
    stdDev: Math.sqrt(variance),
  };
}

/**
 * Pack a uint8 mask into four lanes per u32, matching the WGSL `maskBit`
 * helper. Lane order is little-endian within the word: pixel p lives in byte
 * p & 3 of word p >> 2.
 */
export function packMask(mask: Uint8Array): Uint32Array {
  const words = new Uint32Array(Math.ceil(mask.length / 4));
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === 0) continue;
    words[i >>> 2] |= 0xff << ((i & 3) * 8);
  }
  return words;
}
