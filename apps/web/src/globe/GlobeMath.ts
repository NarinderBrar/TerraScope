import { MAX_LATITUDE } from '@terrascope/contracts';

/** Camera angles are geographic degrees; distance is in globe radii. */
export interface GlobeCamera {
  longitude: number;
  latitude: number;
  distance: number;
  fovY: number;
}

export interface GlobeViewport {
  width: number;
  height: number;
}

export interface GlobePoint {
  x: number;
  y: number;
  z: number;
}

export const DEFAULT_GLOBE_CAMERA: GlobeCamera = {
  longitude: -121.3,
  latitude: 38.1,
  distance: 3.2,
  fovY: 42 * Math.PI / 180,
};

const DEG = Math.PI / 180;

/** Unit-sphere position for a geographic coordinate. Y is the north axis. */
export function lonLatToUnitSphere(longitude: number, latitude: number, height = 0): GlobePoint {
  const lat = Math.max(-90, Math.min(90, latitude)) * DEG;
  const lon = longitude * DEG;
  const radius = 1 + height;
  const cosLat = Math.cos(lat);
  return {
    x: radius * cosLat * Math.cos(lon),
    y: radius * Math.sin(lat),
    z: radius * cosLat * Math.sin(lon),
  };
}

/**
 * A camera-relative column-major view-projection matrix for WGSL.
 * Geographic camera state stays in JS doubles; only this compact matrix and
 * local vertex positions are converted to float32 for the GPU.
 */
export function globeViewProjection(camera: GlobeCamera, viewport: GlobeViewport): Float32Array {
  const target = lonLatToUnitSphere(camera.longitude, camera.latitude);
  const viewDir = normalize(target);
  const eye = scale(viewDir, camera.distance);
  const forward = scale(viewDir, -1);
  const worldNorth = { x: 0, y: 1, z: 0 };
  let right = normalize(cross(forward, worldNorth));
  if (length(right) < 1e-5) right = { x: 1, y: 0, z: 0 };
  const up = normalize(cross(right, forward));

  const view = new Float64Array(16);
  view[0] = right.x; view[4] = right.y; view[8] = right.z;
  view[1] = up.x; view[5] = up.y; view[9] = up.z;
  view[2] = -forward.x; view[6] = -forward.y; view[10] = -forward.z;
  view[12] = -dot(right, eye);
  view[13] = -dot(up, eye);
  view[14] = dot(forward, eye);
  view[15] = 1;

  const aspect = Math.max(1e-4, viewport.width / Math.max(1, viewport.height));
  const f = 1 / Math.tan(camera.fovY / 2);
  const near = 0.01;
  const far = 100;
  const projection = new Float64Array(16);
  projection[0] = f / aspect;
  projection[5] = f;
  projection[10] = far / (near - far);
  projection[11] = -1;
  projection[14] = (far * near) / (near - far);

  return new Float32Array(multiply(projection, view));
}

/** Height and longitude/latitude of the Web Mercator XYZ tile edges. */
export function xyzTileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z;
  const lon = (tx: number): number => tx / n * 360 - 180;
  const lat = (ty: number): number => Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) / DEG;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

/** Exact lon/lat at a tile-local UV; V=0 is the northern edge. */
export function xyzUvToLonLat(z: number, x: number, y: number, u: number, v: number): [number, number] {
  const n = 2 ** z;
  const tx = x + u;
  const ty = y + v;
  const longitude = tx / n * 360 - 180;
  const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) / DEG;
  return [longitude, latitude];
}

/** Convert geodetic coordinates to the current Web Mercator tile coordinate. */
export function lonLatToXyz(longitude: number, latitude: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const lon = ((longitude + 180) % 360 + 360) % 360;
  const lat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, latitude)) * DEG;
  return {
    x: Math.floor(lon / 360 * n),
    y: Math.max(0, Math.min(n - 1, Math.floor((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * n))),
  };
}

/**
 * Screen-space scale proxy used to select the initial imagery LOD. The
 * visibility pass will still cull tiles by camera and scene footprint.
 */
export function imageryZoomForGlobe(camera: GlobeCamera, viewport: GlobeViewport): number {
  const pixelsPerRadian = viewport.height / (2 * Math.tan(camera.fovY / 2));
  const angularRadius = Math.asin(Math.min(1, 1 / camera.distance));
  const projectedDiameter = Math.max(1, 2 * angularRadius * pixelsPerRadian);
  return Math.max(0, Math.floor(Math.log2(projectedDiameter / 256) + 1));
}

function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      out[c * 4 + r] = a[r] * b[c * 4]
        + a[4 + r] * b[c * 4 + 1]
        + a[8 + r] * b[c * 4 + 2]
        + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function cross(a: GlobePoint, b: GlobePoint): GlobePoint {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function dot(a: GlobePoint, b: GlobePoint): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function length(a: GlobePoint): number {
  return Math.hypot(a.x, a.y, a.z);
}

function normalize(a: GlobePoint): GlobePoint {
  const l = length(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

function scale(a: GlobePoint, s: number): GlobePoint {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
