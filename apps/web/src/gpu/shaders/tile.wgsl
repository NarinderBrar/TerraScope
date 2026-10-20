struct RenderUniforms {
  viewport_width: f32,
  viewport_height: f32,
  layer: u32,
  swipe: f32,
  band_index: u32,
  has_second: u32,
  gamma: f32,
  swipe_enabled: u32,
  exposure: f32,
  ndvi_min: f32,
  ndvi_max: f32,
  delta_range: f32,
};

@group(0) @binding(0) var<uniform> params: RenderUniforms;

@group(0) @binding(1) var source_a: texture_2d<f32>;
@group(0) @binding(2) var source_b: texture_2d<f32>;

@group(0) @binding(3) var<storage, read> coverage_a: array<u32>;
@group(0) @binding(4) var<storage, read> index_valid_a: array<u32>;
@group(0) @binding(5) var<storage, read> index_valid_b: array<u32>;
@group(0) @binding(6) var<storage, read> ndvi_a: array<f32>;
@group(0) @binding(7) var<storage, read> ndvi_b: array<f32>;
@group(0) @binding(8) var<storage, read> coverage_b: array<u32>;

struct VertexIn {
  @location(0) position: vec2<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) flags: vec2<f32>,
};

struct VertexOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) screen_x: f32,
  @location(2) flags: vec2<f32>,
};

@vertex
fn vertexMain(in: VertexIn) -> VertexOut {
  var out: VertexOut;
  let ndc = vec2<f32>(
     in.position.x / (params.viewport_width * 0.5),
    -in.position.y / (params.viewport_height * 0.5),
  );
  out.clip = vec4<f32>(ndc, 0.0, 1.0);
  out.uv = in.uv;
  out.screen_x = in.position.x + params.viewport_width * 0.5;
  out.flags = in.flags;
  return out;
}

fn maskBit(word: u32, index: u32) -> bool {
  let lane = (index & 3u) * 8u;
  return ((word >> lane) & 0xFFu) != 0u;
}

fn coverageBitA(index: u32) -> bool {
  return maskBit(coverage_a[index >> 2u], index);
}

fn coverageBitB(index: u32) -> bool {
  return maskBit(coverage_b[index >> 2u], index);
}

fn coverageBit(index: u32, useSecond: bool) -> bool {
  return select(coverageBitA(index), coverageBitB(index), useSecond);
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

fn displayEncode(linear: f32) -> f32 {
  let srgb = linearToSrgb(linear * params.exposure);
  if (params.gamma <= 0.0) {
    return srgb;
  }
  return pow(srgb, 1.0 / params.gamma);
}

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

const NO_DATA = vec4<f32>(0.0, 0.0, 0.0, 0.0);

fn channel(bands: vec4<f32>, index: u32) -> f32 {
  switch index {
    case 0u: { return bands.x; }
    case 1u: { return bands.y; }
    case 2u: { return bands.z; }
    default: { return bands.w; }
  }
}

fn shade(uv: vec2<f32>, layer: u32, useSecond: bool) -> vec4<f32> {
  let dim = vec2<f32>(textureDimensions(source_a, 0));
  let coord = vec2<u32>(clamp(uv * dim, vec2<f32>(0.0), dim - vec2<f32>(1.0)));
  let pixel = coord.y * u32(dim.x) + coord.x;

  switch layer {
    case 0u: {
      if (!coverageBit(pixel, useSecond)) {
        return NO_DATA;
      }
      var bands: vec4<f32>;
      if (useSecond) {
        bands = textureLoad(source_b, coord, 0);
      } else {
        bands = textureLoad(source_a, coord, 0);
      }
      return vec4<f32>(displayEncode(bands.x), displayEncode(bands.y), displayEncode(bands.z), 1.0);
    }
    case 4u: {
      if (!coverageBit(pixel, useSecond)) {
        return NO_DATA;
      }
      var bands: vec4<f32>;
      if (useSecond) {
        bands = textureLoad(source_b, coord, 0);
      } else {
        bands = textureLoad(source_a, coord, 0);
      }
      return vec4<f32>(displayEncode(bands.w), displayEncode(bands.x), displayEncode(bands.y), 1.0);
    }
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
      return vec4<f32>(ndviRamp((value - params.ndvi_min) / max(0.01, params.ndvi_max - params.ndvi_min)), 1.0);
    }
    case 5u: {
      if (!coverageBit(pixel, useSecond)) {
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
      if (valid && ndviVal >= 0.25) {
        return vec4<f32>(rgb.r * 0.4, min(1.0, rgb.g * 1.35 + 0.05), rgb.b * 0.4, 1.0);
      }
      return vec4<f32>(gray, gray, gray, 1.0);
    }
    default: {
      if (!coverageBit(pixel, useSecond)) {
        return NO_DATA;
      }
      var bands: vec4<f32>;
      if (useSecond) {
        bands = textureLoad(source_b, coord, 0);
      } else {
        bands = textureLoad(source_a, coord, 0);
      }
      let val = displayEncode(channel(bands, params.band_index) * 0.5);
      return vec4<f32>(val, val, val, 1.0);
    }
  }
}

fn difference(uv: vec2<f32>) -> vec4<f32> {
  if (params.has_second == 0u) {
    return NO_DATA;
  }
  let dim = vec2<f32>(textureDimensions(source_a, 0));
  let coord = vec2<u32>(clamp(uv * dim, vec2<f32>(0.0), dim - vec2<f32>(1.0)));
  let pixel = coord.y * u32(dim.x) + coord.x;
  if (!indexValidBitA(pixel) || !indexValidBitB(pixel)) {
    return NO_DATA;
  }
  return vec4<f32>(deltaRamp((ndvi_b[pixel] - ndvi_a[pixel]) / max(0.01, params.delta_range)), 1.0);
}

@fragment
fn fragmentMain(in: VertexOut) -> @location(0) vec4<f32> {
  let layer = params.layer;

  if (params.swipe_enabled == 1u) {
    let divider = params.swipe * params.viewport_width;
    let useSecond = in.screen_x >= divider;
    if (useSecond) {
      if (in.flags.y < 0.5) {
        return NO_DATA;
      }
      let effective = select(layer, 1u, layer == 2u);
      return shade(in.uv, effective, true);
    } else {
      if (in.flags.x < 0.5) {
        return NO_DATA;
      }
      let effective = select(layer, 1u, layer == 2u);
      return shade(in.uv, effective, false);
    }
  }

  if (layer == 2u) {
    if (in.flags.x < 0.5 || in.flags.y < 0.5) {
      return NO_DATA;
    }
    return difference(in.uv);
  }

  if (in.flags.x < 0.5) {
    return NO_DATA;
  }
  return shade(in.uv, layer, false);
}
