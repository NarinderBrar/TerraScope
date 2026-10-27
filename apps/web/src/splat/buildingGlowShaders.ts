// Work-buffer hooks receive WORLD centers. Convert through the actual model root
// before sampling LangSplat evidence; geometry and alpha remain unchanged.
export const BUILDING_GLOW_GLSL = `
uniform sampler2D buildingGlowMask;
uniform mat4 buildingGlowWorldToModel;
uniform vec3 buildingGlowMin;
uniform vec3 buildingGlowInvSpan;
uniform float buildingGlowPulse;
uniform vec3 buildingGlowGridSize;
uniform vec2 buildingGlowAtlasSize;
uniform float buildingGlowTime;
uniform float buildingGlowKind;
uniform float buildingGlowMetresPerUnit;
uniform float buildingGlowMinZ;
uniform float buildingGlowCutoff;
uniform float buildingGlowActive;
uniform vec3 buildingGlowTint;
uniform float buildingRevealZ;
uniform float buildingRevealFeather;
float buildingSlice(vec2 xy, float z) {
    vec2 tile = vec2(mod(z, 8.0), floor(z / 8.0));
    return texture2D(buildingGlowMask, (tile * buildingGlowGridSize.xy + xy + 0.5) / buildingGlowAtlasSize).r;
}
void modifySplatCenter(inout vec3 center) {}
void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {}
void modifySplatColor(vec3 center, inout vec4 color) {
    vec3 local = (buildingGlowWorldToModel * vec4(center, 1.0)).xyz;
    color.a *= 1.0 - smoothstep(buildingRevealZ - buildingRevealFeather, buildingRevealZ, local.z);
    if (buildingGlowActive < 0.5) return;
    if (local.z < buildingGlowMinZ) return;
    vec3 p = (local - buildingGlowMin) * buildingGlowInvSpan;
    if (any(lessThan(p, vec3(0.0))) || any(greaterThan(p, vec3(1.0)))) return;
    vec3 grid = p * (buildingGlowGridSize - vec3(1.0));
    float z = floor(grid.z);
    float weight = mix(buildingSlice(grid.xy, z), buildingSlice(grid.xy, min(z + 1.0, 63.0)), fract(grid.z));
    float coverage = smoothstep(buildingGlowCutoff, buildingGlowCutoff + 0.12, weight);
    float amount = coverage * buildingGlowPulse;
    vec3 tint = buildingGlowTint;
    if (buildingGlowKind < 0.5) {
        // Keep facades readable throughout the pulse, including its dim phase.
        amount = coverage * mix(0.3, 0.5, clamp((buildingGlowPulse - 0.075) / 0.425, 0.0, 1.0));
        // World-metric facade grid and moving scan band, sampled on the
        // original Gaussians. This is a hologram style, not a triangle mesh.
        vec3 metres = local * buildingGlowMetresPerUnit;
        vec3 spacing = vec3(4.0, 4.0, 3.0);
        vec3 phase = fract(metres / spacing);
        vec3 lineDistance = min(phase, vec3(1.0) - phase) * spacing;
        float gridLine = 1.0 - smoothstep(0.12, 0.32, min(min(lineDistance.x, lineDistance.y), lineDistance.z));
        float scanDistance = abs(fract(metres.z / 24.0 - buildingGlowTime * 0.14) - 0.5) * 24.0;
        float scan = 1.0 - smoothstep(0.0, 1.4, scanDistance);
        tint = mix(buildingGlowTint, vec3(0.4, 0.95, 1.0), max(gridLine * 0.95, scan * 0.85));
    }
    color.rgb = mix(color.rgb, tint, amount * 0.65) + tint * amount * 0.28;
}
`;

export const BUILDING_GLOW_WGSL = `
var buildingGlowMask: texture_2d<f32>;
var buildingGlowMaskSampler: sampler;
uniform buildingGlowWorldToModel: mat4x4f;
uniform buildingGlowMin: vec3f;
uniform buildingGlowInvSpan: vec3f;
uniform buildingGlowPulse: f32;
uniform buildingGlowGridSize: vec3f;
uniform buildingGlowAtlasSize: vec2f;
uniform buildingGlowTime: f32;
uniform buildingGlowKind: f32;
uniform buildingGlowMetresPerUnit: f32;
uniform buildingGlowMinZ: f32;
uniform buildingGlowCutoff: f32;
uniform buildingGlowActive: f32;
uniform buildingGlowTint: vec3f;
uniform buildingRevealZ: f32;
uniform buildingRevealFeather: f32;
fn buildingSlice(xy: vec2f, z: f32) -> f32 {
    let tile = vec2f(z - floor(z / 8.0) * 8.0, floor(z / 8.0));
    return textureSampleLevel(buildingGlowMask, buildingGlowMaskSampler, (tile * uniform.buildingGlowGridSize.xy + xy + 0.5) / uniform.buildingGlowAtlasSize, 0.0).r;
}
fn modifySplatCenter(center: ptr<function, vec3f>) {}
fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {}
fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let local = (uniform.buildingGlowWorldToModel * vec4f(center, 1.0)).xyz;
    (*color).a *= 1.0 - smoothstep(uniform.buildingRevealZ - uniform.buildingRevealFeather, uniform.buildingRevealZ, local.z);
    if (uniform.buildingGlowActive < 0.5) { return; }
    if (local.z < uniform.buildingGlowMinZ) { return; }
    let p = (local - uniform.buildingGlowMin) * uniform.buildingGlowInvSpan;
    if (any(p < vec3f(0.0)) || any(p > vec3f(1.0))) { return; }
    let grid = p * (uniform.buildingGlowGridSize - vec3f(1.0));
    let z = floor(grid.z);
    let weight = mix(buildingSlice(grid.xy, z), buildingSlice(grid.xy, min(z + 1.0, 63.0)), fract(grid.z));
    let coverage = smoothstep(uniform.buildingGlowCutoff, uniform.buildingGlowCutoff + 0.12, weight);
    var amount = coverage * uniform.buildingGlowPulse;
    var tint = uniform.buildingGlowTint;
    if (uniform.buildingGlowKind < 0.5) {
        amount = coverage * mix(0.3, 0.5, clamp((uniform.buildingGlowPulse - 0.075) / 0.425, 0.0, 1.0));
        let metres = local * uniform.buildingGlowMetresPerUnit;
        let spacing = vec3f(4.0, 4.0, 3.0);
        let phase = fract(metres / spacing);
        let lineDistance = min(phase, vec3f(1.0) - phase) * spacing;
        let gridLine = 1.0 - smoothstep(0.12, 0.32, min(min(lineDistance.x, lineDistance.y), lineDistance.z));
        let scanDistance = abs(fract(metres.z / 24.0 - uniform.buildingGlowTime * 0.14) - 0.5) * 24.0;
        let scan = 1.0 - smoothstep(0.0, 1.4, scanDistance);
        tint = mix(uniform.buildingGlowTint, vec3f(0.4, 0.95, 1.0), max(gridLine * 0.95, scan * 0.85));
    }
    (*color) = vec4f(mix((*color).rgb, tint, amount * 0.65) + tint * amount * 0.28, (*color).a);
}
`;
