struct Params {
  view_projection: mat4x4<f32>,
  viewport: vec2<f32>,
  swipe: f32,
  layer: u32,
  band_index: u32,
  has_second: u32,
  swipe_enabled: u32,
  ndvi_min: f32,
  ndvi_max: f32,
  delta_range: f32,
  gamma: f32,
  exposure: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source_a: texture_2d<f32>;
@group(0) @binding(2) var source_b: texture_2d<f32>;
@group(0) @binding(3) var masks_a: texture_2d<f32>;
@group(0) @binding(4) var masks_b: texture_2d<f32>;

struct VertexIn {
  @location(0) position: vec3<f32>,
  @location(1) uv: vec2<f32>,
};

struct VertexOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vertexMain(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.clip = params.view_projection * vec4<f32>(input.position, 1.0);
  out.uv = input.uv;
  return out;
}

fn ndvi(bands: vec4<f32>) -> f32 {
  return (bands.w - bands.x) / max(1e-3, bands.w + bands.x);
}

fn ndviRamp(value: f32) -> vec3<f32> {
  let t = clamp((value - params.ndvi_min) / max(0.01, params.ndvi_max - params.ndvi_min), 0.0, 1.0);
  let brown = vec3<f32>(0.37, 0.24, 0.13);
  let tan = vec3<f32>(0.74, 0.68, 0.40);
  let light = vec3<f32>(0.87, 0.88, 0.65);
  let green = vec3<f32>(0.30, 0.62, 0.24);
  let deep = vec3<f32>(0.05, 0.30, 0.10);
  if (t < 0.25) { return mix(brown, tan, t / 0.25); }
  if (t < 0.5) { return mix(tan, light, (t - 0.25) / 0.25); }
  if (t < 0.75) { return mix(light, green, (t - 0.5) / 0.25); }
  return mix(green, deep, (t - 0.75) / 0.25);
}

fn deltaRamp(value: f32) -> vec3<f32> {
  let t = clamp(value / max(0.01, params.delta_range), -1.0, 1.0);
  let neutral = vec3<f32>(0.92, 0.92, 0.92);
  let loss = vec3<f32>(0.62, 0.20, 0.12);
  let gain = vec3<f32>(0.10, 0.45, 0.20);
  if (t < 0.0) { return mix(neutral, loss, -t); }
  return mix(neutral, gain, t);
}

fn linearToSrgb(value: f32) -> f32 {
  let v = clamp(value, 0.0, 1.0);
  if (v <= 0.0031308) { return v * 12.92; }
  return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

fn encode(value: f32) -> f32 {
  let srgb = linearToSrgb(value * params.exposure);
  if (params.gamma <= 0.0) { return srgb; }
  return pow(srgb, 1.0 / params.gamma);
}

@fragment
fn fragmentMain(input: VertexOut) -> @location(0) vec4<f32> {
  let dims = vec2<i32>(textureDimensions(source_a));
  let pixel = clamp(vec2<i32>(input.uv * vec2<f32>(dims)), vec2<i32>(0), dims - vec2<i32>(1));
  let use_b = params.has_second != 0u && params.swipe_enabled != 0u
    && input.clip.x >= params.swipe * params.viewport.x;
  let bands_a = textureLoad(source_a, pixel, 0);
  let bands_b = textureLoad(source_b, pixel, 0);
  let mask_a = textureLoad(masks_a, pixel, 0);
  let mask_b = textureLoad(masks_b, pixel, 0);
  let bands = select(bands_a, bands_b, use_b);
  let mask = select(mask_a, mask_b, use_b);
  if (mask.r < 0.5) { discard; }

  var rgb: vec3<f32>;
  switch params.layer {
    case 1u: {
      if (mask.g < 0.5 || mask.b < 0.5 || mask.a < 0.5) { discard; }
      rgb = ndviRamp(ndvi(bands));
    }
    case 2u: {
      if (params.has_second == 0u || mask_a.g < 0.5 || mask_a.b < 0.5 || mask_a.a < 0.5
        || mask_b.g < 0.5 || mask_b.b < 0.5 || mask_b.a < 0.5) { discard; }
      rgb = deltaRamp(ndvi(bands_b) - ndvi(bands_a));
    }
    case 3u: {
      let natural = vec3<f32>(encode(bands.x), encode(bands.y), encode(bands.z));
      if (mask.g >= 0.5 && mask.b >= 0.5 && mask.a >= 0.5 && ndvi(bands) >= 0.25) {
        rgb = vec3<f32>(natural.r * 0.4, min(1.0, natural.g * 1.35 + 0.05), natural.b * 0.4);
      } else {
        let gray = dot(natural, vec3<f32>(0.299, 0.587, 0.114));
        rgb = vec3<f32>(gray);
      }
    }
    case 4u: { rgb = vec3<f32>(encode(bands[params.band_index] * 0.5)); }
    default: {
      if (params.layer == 5u) { rgb = vec3<f32>(encode(bands.w), encode(bands.x), encode(bands.y)); }
      else { rgb = vec3<f32>(encode(bands.x), encode(bands.y), encode(bands.z)); }
    }
  }
  return vec4<f32>(rgb, 1.0);
}
