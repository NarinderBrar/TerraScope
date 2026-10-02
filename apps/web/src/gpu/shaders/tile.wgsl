// Tile compositing.
//
// Draws one textured quad per resident tile over a background, choosing
// between natural colour, an index ramp, and a two-date swipe. All three read
// the same uploaded data, so switching layer is a uniform change with no
// re-upload.
//
// Positions arrive relative to the camera origin in float32 (see
// `MapCamera.visibleTiles`), so the vertex stage never sees a
// large-magnitude coordinate -- that is what would otherwise make tiles jitter
// at high zoom.

struct RenderUniforms {
  viewport_width: f32,
  viewport_height: f32,
  /// 0 = natural colour, 1 = NDVI, 2 = NDVI difference, 3 = single band,
  /// 4 = false colour (NIR/red/green), 5 = vegetation focus (green vs gray).
  layer: u32,
  /// 0..1 divider position for the swipe, in viewport x.
  swipe: f32,
  /// Which channel `layer == 3` shows: 0 red, 1 green, 2 blue, 3 nir.
  band_index: u32,
  /// 1 when a second date is loaded; disables the compare paths otherwise.
  has_second: u32,
  /// Display gamma, 1.0 = none. Applied after the sRGB transfer function, so
  /// it brightens the image the way a viewer expects rather than altering the
  /// reflectance before it is encoded.
  gamma: f32,
  /// 1 to split the screen and show date A beside date B.
  ///
  /// Separate from `layer` because the plan lists two-date swipe and NDVI
  /// difference as distinct features. An earlier version folded the split into
  /// `layer == 2` and drew NDVI on both sides, so choosing "difference" gave
  /// you a swipe of two NDVI images and no difference at all.
  swipe_enabled: u32,
  /// Multiplies linear reflectance for display only. Never touches an index.
  ///
  /// This field was originally a pad, and the uniform was declared with a
  /// `gamma` control that no code path read -- so the exposure slider moved and
  /// nothing changed. A uniform nothing reads is worse than no uniform: it looks
  /// like a working feature.
  exposure: f32,
  ndvi_min: f32,
  ndvi_max: f32,
  delta_range: f32,
};

@group(0) @binding(0) var<uniform> params: RenderUniforms;

// One rgba32float texture per date: r = red, g = green, b = blue, a = nir.
// rgba32float is non-filterable in core WebGPU, so every read here is
// textureLoad at an exact texel. That is not a workaround: the pipeline must be
// able to reproduce the CPU read *exactly*, and a filtered sample would
// silently blend across the tile boundary this app has to keep seamless.
@group(0) @binding(1) var source_a: texture_2d<f32>;
@group(0) @binding(2) var source_b: texture_2d<f32>;

// Packed validity masks, four uint8 lanes per u32 word, matching analysis.wgsl.
@group(0) @binding(3) var<storage, read> coverage_a: array<u32>;
@group(0) @binding(4) var<storage, read> index_valid_a: array<u32>;
@group(0) @binding(5) var<storage, read> index_valid_b: array<u32>;
@group(0) @binding(6) var<storage, read> ndvi_a: array<f32>;
@group(0) @binding(7) var<storage, read> ndvi_b: array<f32>;

struct VertexIn {
  /// Top-left of the quad, in device pixels relative to the viewport centre.
  @location(0) position: vec2<f32>,
  /// 0..1 within the tile.
  @location(1) uv: vec2<f32>,
};

struct VertexOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
  /// Viewport-space x in device pixels, for the swipe divider.
  @location(1) screen_x: f32,
};

@vertex
fn vertexMain(in: VertexIn) -> VertexOut {
  var out: VertexOut;
  // Device pixels to normalised device coordinates, y down.
  let ndc = vec2<f32>(
     in.position.x / (params.viewport_width * 0.5),
    -in.position.y / (params.viewport_height * 0.5),
  );
  out.clip = vec4<f32>(ndc, 0.0, 1.0);
  out.uv = in.uv;
  out.screen_x = in.position.x + params.viewport_width * 0.5;
  return out;
}

/// Validity for one pixel from a packed mask, four uint8 lanes per u32 word.
///
/// Takes the loaded word, not a pointer: a runtime-sized storage array cannot
/// be passed by value, and a `ptr` to a single `u32` cannot be indexed as if it
/// were the array. That mistake is a compile error here, which is how the same
/// bug in analysis.wgsl was found.
fn maskBit(word: u32, index: u32) -> bool {
  let lane = (index & 3u) * 8u;
  return ((word >> lane) & 0xFFu) != 0u;
}

fn coverageBit(index: u32) -> bool {
  return maskBit(coverage_a[index >> 2u], index);
}

fn indexValidBitA(index: u32) -> bool {
  return maskBit(index_valid_a[index >> 2u], index);
}

fn indexValidBitB(index: u32) -> bool {
  return maskBit(index_valid_b[index >> 2u], index);
}

fn linearToSrgb(value: f32) -> f32 {
  let v = clamp(value, 0.0, 1.0);
  if (v <= 0.0031308) {
    return v * 12.92;
  }
  return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

/// The full reflectance-to-screen path: exposure, then the sRGB transfer
/// function, then display gamma.
///
/// One place, so every reflectance-based layer is adjusted identically. Doing it
/// per-layer is how "the false colour looks different from the natural colour"
/// happens.
fn displayEncode(linear: f32) -> f32 {
  let srgb = linearToSrgb(linear * params.exposure);
  // A gamma of 0 would be a divide by zero; treat it as "no correction" rather
  // than emitting a black tile.
  if (params.gamma <= 0.0) {
    return srgb;
  }
  return pow(srgb, 1.0 / params.gamma);
}

/// Perceptual ramp for NDVI: five piecewise-linear stops, deliberately not a
/// single hue ramp, so the extremes stay separable at a glance.
fn ndviRamp(t: f32) -> vec3<f32> {
  let v = clamp(t, 0.0, 1.0);
  let brown = vec3<f32>(0.37, 0.24, 0.13);
  let tan = vec3<f32>(0.74, 0.68, 0.40);
  let light = vec3<f32>(0.87, 0.88, 0.65);
  let green = vec3<f32>(0.30, 0.62, 0.24);
  let deep = vec3<f32>(0.05, 0.30, 0.10);
  if (v < 0.25) {
    return mix(brown, tan, v / 0.25);
  }
  if (v < 0.5) {
    return mix(tan, light, (v - 0.25) / 0.25);
  }
  if (v < 0.75) {
    return mix(light, green, (v - 0.5) / 0.25);
  }
  return mix(green, deep, (v - 0.75) / 0.25);
}

/// Diverging ramp for change: loss toward brown, gain toward green, neutral
/// grey at zero. Asymmetric gain is intentional -- a little loss is noise, a
/// small gain is the thing worth seeing.
fn deltaRamp(value: f32) -> vec3<f32> {
  let v = clamp(value, -1.0, 1.0);
  let loss = vec3<f32>(0.62, 0.20, 0.12);
  let neutral = vec3<f32>(0.92, 0.92, 0.92);
  let gain = vec3<f32>(0.10, 0.45, 0.20);
  if (v < 0.0) {
    return mix(neutral, loss, clamp(-v * 2.0, 0.0, 1.0));
  }
  return mix(neutral, gain, clamp(v * 2.0, 0.0, 1.0));
}

/// A missing or invalid sample. Distinct from black, so "no data" is never
/// mistaken for "very dark" -- a distinction the whole coverage/index split
/// exists to preserve.
const NO_DATA = vec3<f32>(0.08, 0.09, 0.10);

fn channel(bands: vec4<f32>, index: u32) -> f32 {
  switch index {
    case 0u: { return bands.x; }
    case 1u: { return bands.y; }
    case 2u: { return bands.z; }
    default: { return bands.w; }
  }
}

/// Colour one pixel for one date.
///
/// `layer` selects the imagery; `useSecond` selects the date. The difference
/// layer is not handled here because it needs both dates at once, which is
/// what `difference()` is for.
fn shade(uv: vec2<f32>, layer: u32, useSecond: bool) -> vec3<f32> {
  let dim = vec2<f32>(textureDimensions(source_a, 0));
  let coord = vec2<u32>(clamp(uv * dim, vec2<f32>(0.0), dim - vec2<f32>(1.0)));
  let pixel = coord.y * u32(dim.x) + coord.x;

  switch layer {
    // Natural colour, linear reflectance to sRGB.
    case 0u: {
      if (!coverageBit(pixel)) {
        return NO_DATA;
      }
      var bands: vec4<f32>;
      if (useSecond) {
        bands = textureLoad(source_b, coord, 0);
      } else {
        bands = textureLoad(source_a, coord, 0);
      }
      return vec3<f32>(displayEncode(bands.x), displayEncode(bands.y), displayEncode(bands.z));
    }
    // False colour: NIR as red, so vegetation reads red. The plan calls for
    // NIR/red/green, not a channel permutation, so this is not layer 0 with
    // the channels swapped -- the whole point is the near-infrared band.
    case 4u: {
      if (!coverageBit(pixel)) {
        return NO_DATA;
      }
      var bands: vec4<f32>;
      if (useSecond) {
        bands = textureLoad(source_b, coord, 0);
      } else {
        bands = textureLoad(source_a, coord, 0);
      }
      return vec3<f32>(displayEncode(bands.w), displayEncode(bands.x), displayEncode(bands.y));
    }
    // NDVI. Each date is drawn from its own validity mask, so a pixel that is
    // only observable in A does not inherit B's index.
    case 1u: {
      var valid: bool;
      var value: f32;
      if (useSecond) {
        valid = indexValidBitB(pixel);
        value = ndvi_b[pixel];
      } else {
        valid = indexValidBitA(pixel);
        value = ndvi_a[pixel];
      }
      if (!valid) {
        return NO_DATA;
      }
      return ndviRamp((value - params.ndvi_min) / max(0.01, params.ndvi_max - params.ndvi_min));
    }
    // Vegetation focus: living vegetation in vibrant green, non-living in monochrome gray.
    case 5u: {
      if (!coverageBit(pixel)) {
        return NO_DATA;
      }
      var bands: vec4<f32>;
      var valid: bool;
      var ndviVal: f32;
      if (useSecond) {
        bands = textureLoad(source_b, coord, 0);
        valid = indexValidBitB(pixel);
        ndviVal = ndvi_b[pixel];
      } else {
        bands = textureLoad(source_a, coord, 0);
        valid = indexValidBitA(pixel);
        ndviVal = ndvi_a[pixel];
      }
      let rgb = vec3<f32>(displayEncode(bands.x), displayEncode(bands.y), displayEncode(bands.z));
      let gray = dot(rgb, vec3<f32>(0.299, 0.587, 0.114));
      // Living vegetation threshold (NDVI >= 0.25).
      if (valid && ndviVal >= 0.25) {
        return vec3<f32>(rgb.r * 0.4, min(1.0, rgb.g * 1.35 + 0.05), rgb.b * 0.4);
      }
      return vec3<f32>(gray, gray, gray);
    }
    // Single band.
    default: {
      if (!coverageBit(pixel)) {
        return NO_DATA;
      }
      var bands: vec4<f32>;
      if (useSecond) {
        bands = textureLoad(source_b, coord, 0);
      } else {
        bands = textureLoad(source_a, coord, 0);
      }
      return vec3<f32>(displayEncode(channel(bands, params.band_index) * 0.5));
    }
  }
}

/// Masked two-date difference.
///
/// Both dates must be valid. Differencing against a masked sample invents
/// change precisely where the observation is least trustworthy, so a gap shows
/// as no-data rather than as a colour.
fn difference(uv: vec2<f32>) -> vec3<f32> {
  if (params.has_second == 0u) {
    return NO_DATA;
  }
  let dim = vec2<f32>(textureDimensions(source_a, 0));
  let coord = vec2<u32>(clamp(uv * dim, vec2<f32>(0.0), dim - vec2<f32>(1.0)));
  let pixel = coord.y * u32(dim.x) + coord.x;
  if (!indexValidBitA(pixel) || !indexValidBitB(pixel)) {
    return NO_DATA;
  }
  return deltaRamp((ndvi_b[pixel] - ndvi_a[pixel]) / max(0.01, params.delta_range));
}

@fragment
fn fragmentMain(in: VertexOut) -> @location(0) vec4<f32> {
  let layer = params.layer;

  // Swipe: a screen-space split only. It selects which date is sampled and
  // must not alter any source value, so it costs one branch and nothing else.
  if (params.swipe_enabled == 1u && params.has_second == 1u) {
    let divider = params.swipe * params.viewport_width;
    let useSecond = in.screen_x >= divider;
    // The difference layer is a single image by definition; there is no "side"
    // of it to put on each half, so a swipe falls back to plain NDVI.
    let effective = select(layer, 1u, layer == 2u);
    return vec4<f32>(shade(in.uv, effective, useSecond), 1.0);
  }

  if (layer == 2u) {
    return vec4<f32>(difference(in.uv), 1.0);
  }
  return vec4<f32>(shade(in.uv, layer, false), 1.0);
}
