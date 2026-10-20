import type { Scene } from '@terrascope/contracts';
import {
  imageryZoomForGlobe,
  lonLatToUnitSphere,
  xyzTileBounds,
  type GlobeCamera,
  type GlobeViewport,
} from './GlobeMath';

export interface GlobeTile {
  z: number;
  x: number;
  y: number;
  bounds: [west: number, south: number, east: number, north: number];
  priority: number;
  key: string;
}

/**
 * Select scene tiles intersecting the camera's visible globe hemisphere.
 * The initial version uses a sampled frustum test; a hierarchical traversal
 * can replace candidate enumeration without changing the tile key contract.
 */
export function visibleGlobeTiles(
  scene: Scene,
  camera: GlobeCamera,
  viewport: GlobeViewport,
  minZoom: number,
  maxZoom: number,
): GlobeTile[] {
  const z = Math.max(minZoom, Math.min(maxZoom, imageryZoomForGlobe(camera, viewport)));
  const bounds = scene.bbox;
  if (bounds.length < 4) return [];
  const [west, south, east, north] = bounds;
  const n = 2 ** z;
  const x0 = Math.max(0, Math.floor((west + 180) / 360 * n));
  const x1 = Math.min(n - 1, Math.floor((east + 180) / 360 * n));
  const toY = (latitude: number): number => {
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, latitude)) * Math.PI / 180;
    return Math.max(0, Math.min(n - 1, Math.floor((1 - Math.asinh(Math.tan(clamped)) / Math.PI) / 2 * n)));
  };
  const y0 = toY(north);
  const y1 = toY(south);
  const basis = cameraBasis(camera);
  const aspect = Math.max(1e-4, viewport.width / Math.max(1, viewport.height));
  const tanHalfY = Math.tan(camera.fovY / 2);
  const visible: GlobeTile[] = [];

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const tileBounds = xyzTileBounds(z, x, y);
      const [tileWest, tileSouth, tileEast, tileNorth] = tileBounds;
      let closestScreenDistance = Infinity;
      let inFrustum = false;

      // Nine samples bound the projected tile well enough for initial request
      // selection. Rendering still relies on depth testing for the horizon.
      for (let iy = 0; iy <= 2; iy += 1) {
        for (let ix = 0; ix <= 2; ix += 1) {
          const lon = tileWest + (tileEast - tileWest) * ix / 2;
          const lat = tileNorth + (tileSouth - tileNorth) * iy / 2;
          const point = lonLatToUnitSphere(lon, lat);
          const normal = normalize(point);
          const toEye = subtract(basis.eye, point);
          if (dot(normal, toEye) <= 0) continue;
          const relative = subtract(point, basis.eye);
          const depth = dot(relative, basis.forward);
          if (depth <= 0) continue;
          const ndcX = dot(relative, basis.right) / (depth * tanHalfY * aspect);
          const ndcY = dot(relative, basis.up) / (depth * tanHalfY);
          const screenDistance = Math.hypot(ndcX, ndcY);
          closestScreenDistance = Math.min(closestScreenDistance, screenDistance);
          if (Math.abs(ndcX) <= 1.25 && Math.abs(ndcY) <= 1.25) inFrustum = true;
        }
      }

      if (!inFrustum) continue;
      visible.push({
        z,
        x,
        y,
        bounds: [tileWest, tileSouth, tileEast, tileNorth],
        priority: 1 / (1 + closestScreenDistance),
        key: `${scene.collection}/${scene.id}/${z}/${x}/${y}`,
      });
    }
  }

  visible.sort((a, b) => b.priority - a.priority);
  return visible;
}

export function parentOf(tile: GlobeTile): GlobeTile | null {
  if (tile.z <= 0) return null;
  const z = tile.z - 1;
  const x = Math.floor(tile.x / 2);
  const y = Math.floor(tile.y / 2);
  const bounds = xyzTileBounds(z, x, y);
  return { z, x, y, bounds: [bounds[0], bounds[1], bounds[2], bounds[3]], priority: tile.priority, key: `${z}/${x}/${y}` };
}

function cameraBasis(camera: GlobeCamera) {
  const direction = normalize(lonLatToUnitSphere(camera.longitude, camera.latitude));
  const eye = { x: direction.x * camera.distance, y: direction.y * camera.distance, z: direction.z * camera.distance };
  const forward = { x: -direction.x, y: -direction.y, z: -direction.z };
  const north = { x: 0, y: 1, z: 0 };
  let right = normalize(cross(forward, north));
  if (Math.hypot(right.x, right.y, right.z) < 1e-5) right = { x: 1, y: 0, z: 0 };
  const up = normalize(cross(right, forward));
  return { eye, forward, right, up };
}

function subtract(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function dot(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(a: { x: number; y: number; z: number }) {
  const length = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / length, y: a.y / length, z: a.z / length };
}
