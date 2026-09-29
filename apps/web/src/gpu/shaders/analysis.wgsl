// Vegetation index compute kernels.
//
// This is the GPU half of the CPU/GPU parity contract. The formulas below are
// a line-for-line transcription of `services/raster/app/tiles/analysis.py`,
// and the parity suite asserts the two agree to 1e-5 absolute on the fixture
// the Python suite generates from a real Sentinel-2 tile. If you change one,
// change the other, and re-run the parity test.
//
// Validity rules (identical on both sides):
//
//   validNDVI  = redValid AND nirValid AND qualityValid
//               AND finite(red) AND finite(nir)
//               AND abs(nir + red) > epsilon
//   NDVI       = (nir - red) / (nir + red)
//   deltaNDVI  = NDVI_B - NDVI_A
//   validDelta = validNDVI_A AND validNDVI_B
//
// Arithmetic is float32 throughout, matching the CPU reference. The epsilon
// guard is not optional: without it a pixel in deep shadow produces a value of
// arbitrary magnitude, and those pixels are exactly the ones a vegetation
// index should refuse to speak about.
//
// BINDING BUDGET. The layout below is six storage buffers, not the sixteen an
// earlier draft used. That is not optimisation, it is the difference between
// running and not running: WebGPU guarantees only
// `maxStorageBuffersPerShaderStage >= 8`, so a 16-binding layout is rejected by
// a conformant implementation and this shader would never have executed on real
// hardware. Green and blue are gone because the index never reads them -- the
// render path gets them from an rgba32float texture -- and the per-date masks
// are packed into one buffer with plane offsets. That leaves headroom for the
// third date a three-way compare would need.

const WORKGROUP_SIZE: u32 = 8u;
const LANES_PER_WORD: u32 = 4u;

struct AnalysisUniforms {
  width: u32,
  height: u32,
  /// Denominator guard. Mirrors NDVI_EPSILON on the server.
  epsilon: f32,
  /// Value written where the sample is not analytically valid.
  invalid_value: f32,
  /// Mask words per row: ceil(width / 4). One invocation owns one word.
  words_per_row: u32,
  /// Mask words per plane: words_per_row * height.
  plane_words: u32,
  _pad: vec2<u32>,
};

@group(0) @binding(0) var<uniform> params: AnalysisUniforms;

/// Date A bands, red/nir interleaved so one adjacent pair is one 8-byte load.
@group(0) @binding(1) var<storage, read> bands_a: array<f32>;

/// Six packed mask planes, in order: A.red, A.nir, A.quality, B.red, B.nir,
/// B.quality. Each plane is `plane_words` u32 words of four uint8 lanes.
@group(0) @binding(2) var<storage, read> masks: array<u32>;

/// Date B bands, same interleaving. Bound to a 4-byte placeholder when there is
/// no second date; the kernel never reads it for the NDVI pass.
@group(0) @binding(3) var<storage, read> bands_b: array<f32>;

@group(0) @binding(4) var<storage, read_write> ndvi_out: array<f32>;
@group(0) @binding(5) var<storage, read_write> ndvi_valid_out: array<u32>;
@group(0) @binding(6) var<storage, read_write> delta_out: array<f32>;
@group(0) @binding(7) var<storage, read_write> delta_valid_out: array<u32>;

/// Plane indices into the packed mask buffer.
const PLANE_A_RED: u32 = 0u;
const PLANE_A_NIR: u32 = 1u;
const PLANE_A_QUALITY: u32 = 2u;
const PLANE_B_RED: u32 = 3u;
const PLANE_B_NIR: u32 = 4u;
const PLANE_B_QUALITY: u32 = 5u;

/// Extract validity for one pixel from a packed word.
///
/// Takes the already-loaded word rather than a pointer to the mask array: a
/// runtime-sized storage array cannot be passed by value, and a `ptr` to a
/// single `u32` cannot be indexed as though it were the array.
fn maskBit(word: u32, index: u32) -> bool {
  let lane = (index & (LANES_PER_WORD - 1u)) * 8u;
  return ((word >> lane) & 0xFFu) != 0u;
}

/// Validity for one pixel of one date, reading straight from the packed planes.
fn validFor(base: u32, plane: u32, index: u32) -> bool {
  return maskBit(masks[base + plane * params.plane_words], index);
}

struct NdviResult {
  value: f32,
  valid: bool,
};

/// The single definition of NDVI. Both entry points call this so the two
/// kernels cannot drift apart.
fn computeNdvi(
  redValue: f32,
  nirValue: f32,
  redOk: bool,
  nirOk: bool,
  qualityOk: bool,
  epsilon: f32,
) -> NdviResult {
  var result: NdviResult;
  result.value = 0.0;
  result.valid = redOk && nirOk && qualityOk;

  // NaN fails every comparison, so this also rejects non-finite inputs.
  if (!(redValue == redValue) || !(nirValue == nirValue)) {
    result.valid = false;
    return result;
  }
  let denom = nirValue + redValue;
  if (abs(denom) <= epsilon) {
    result.valid = false;
    return result;
  }
  result.value = (nirValue - redValue) / denom;
  result.valid = result.valid && (result.value == result.value);
  return result;
}

/// NDVI for the primary date, writing the value and its validity.
///
/// One invocation owns four pixels -- exactly one packed mask word -- so every
/// validity word has a single writer. An earlier version dispatched one
/// invocation per pixel and ORed into the shared word, which was a data race:
/// WebGPU does not guarantee invocations are lockstep, so two invocations
/// reading the same word can both read zero and both write, dropping the
/// other's bits. That surfaced as a handful of valid pixels reported invalid,
/// intermittently, which is the worst kind of bug to chase from a screenshot.
///
/// Dispatch is therefore ceil(words_per_row / 8) by ceil(height / 8).
@compute @workgroup_size(WORKGROUP_SIZE, WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.words_per_row || gid.y >= params.height) {
    return; // every invocation is bounds-checked; no workgroup is assumed full
  }
  let word = gid.y * params.words_per_row + gid.x;

  // Accumulate the four lanes in a local, then store the word once.
  var validity = 0u;
  for (var lane = 0u; lane < LANES_PER_WORD; lane += 1u) {
    let x = gid.x * LANES_PER_WORD + lane;
    if (x >= params.width) {
      continue; // the last word of a row whose width is not a multiple of 4
    }
    let index = word * LANES_PER_WORD + lane;
    let r = computeNdvi(
      bands_a[index * 2u],
      bands_a[index * 2u + 1u],
      validFor(word, PLANE_A_RED, index),
      validFor(word, PLANE_A_NIR, index),
      validFor(word, PLANE_A_QUALITY, index),
      params.epsilon,
    );
    if (r.valid) {
      ndvi_out[index] = r.value;
      validity |= 0xFFu << (lane * 8u);
    } else {
      ndvi_out[index] = params.invalid_value;
    }
  }
  ndvi_valid_out[word] = validity;
}

/// Two-date difference on the common valid mask.
///
/// A pixel invalid in either date is invalid here. Differencing against a
/// masked sample would invent change precisely where the observation is least
/// trustworthy.
///
/// Same one-invocation-per-word shape as `main`, for the same reason: the
/// packed output word must have exactly one writer.
@compute @workgroup_size(WORKGROUP_SIZE, WORKGROUP_SIZE)
fn delta(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.words_per_row || gid.y >= params.height) {
    return;
  }
  let word = gid.y * params.words_per_row + gid.x;

  var validity = 0u;
  for (var lane = 0u; lane < LANES_PER_WORD; lane += 1u) {
    let x = gid.x * LANES_PER_WORD + lane;
    if (x >= params.width) {
      continue;
    }
    let index = word * LANES_PER_WORD + lane;
    let a = computeNdvi(
      bands_a[index * 2u],
      bands_a[index * 2u + 1u],
      validFor(word, PLANE_A_RED, index),
      validFor(word, PLANE_A_NIR, index),
      validFor(word, PLANE_A_QUALITY, index),
      params.epsilon,
    );
    let b = computeNdvi(
      bands_b[index * 2u],
      bands_b[index * 2u + 1u],
      validFor(word, PLANE_B_RED, index),
      validFor(word, PLANE_B_NIR, index),
      validFor(word, PLANE_B_QUALITY, index),
      params.epsilon,
    );

    if (a.valid && b.valid) {
      delta_out[index] = b.value - a.value;
      validity |= 0xFFu << (lane * 8u);
    } else {
      delta_out[index] = params.invalid_value;
    }
  }
  delta_valid_out[word] = validity;
}
