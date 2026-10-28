import { Vec3 } from 'playcanvas';
import { worldPxToLonLat } from '@terrascope/contracts';
import { EARTH_RADIUS, globePoint } from './navigation3D';
import type { GroundTile, VisibleGroundTile } from '../splat/groundTilePlan';

export interface EarthCameraView {
  position: Vec3; forward: Vec3; right: Vec3; up: Vec3;
  fov: number; aspect: number; height: number;
}
export const EARTH_BASE_SCALE = .98;

/** Bound visible globe depth in the camera's model units, not city-scale metres. */
export function earthClipPlanes(position: Vec3, modelUnitsPerMetre = 1) {
  const distance = position.clone().add(new Vec3(0, EARTH_RADIUS, 0)).length();
  const clearance = Math.max(0, distance - EARTH_RADIUS);
  return {
    near: Math.max(.1, clearance * .25 * modelUnitsPerMetre),
    far: Math.max(1000, (distance + EARTH_RADIUS * 1.05) * modelUnitsPerMetre),
  };
}

export function earthTilePoint(tile: GroundTile, u: number, v: number, anchor: { lon: number; lat: number }): Vec3 {
  const n = 2 ** tile.z;
  const geo = worldPxToLonLat((tile.x + u) * 256 / n, (tile.y + v) * 256 / n, 0);
  const lat = tile.y === 0 && v === 0 ? 90 : tile.y === n - 1 && v === 1 ? -90 : geo.lat;
  return globePoint(geo.lon, lat, anchor);
}

/** A complete nonoverlapping sphere cover, refined only near the visible camera. */
export function planEarthTiles(anchor: { lon: number; lat: number }, view: EarthCameraView, maxTiles = 196): VisibleGroundTile[] {
  if (view.height <= 0 || view.aspect <= 0 || maxTiles < 16) return [];
  const eye = view.position.clone().add(new Vec3(0, EARTH_RADIUS, 0));
  const eyeLength = eye.length();
  const horizon = Math.acos(Math.min(1, EARTH_RADIUS / Math.max(1, eyeLength)));
  const tanY = Math.tan(view.fov * Math.PI / 360), focal = view.height / (2 * tanY);
  const evaluate = (tile: GroundTile): VisibleGroundTile => {
    const points = [earthTilePoint(tile, 0, 0, anchor), earthTilePoint(tile, 1, 0, anchor),
      earthTilePoint(tile, 1, 1, anchor), earthTilePoint(tile, 0, 1, anchor),
      earthTilePoint(tile, .5, 0, anchor), earthTilePoint(tile, .5, 1, anchor),
      earthTilePoint(tile, 0, .5, anchor), earthTilePoint(tile, 1, .5, anchor)];
    const center = earthTilePoint(tile, .5, .5, anchor);
    const radius = Math.max(...points.map(p => p.distance(center)));
    const relative = center.clone().sub(view.position), depth = relative.dot(view.forward);
    const radial = center.clone().add(new Vec3(0, EARTH_RADIUS, 0)).normalize();
    const angle = Math.acos(Math.max(-1, Math.min(1, radial.dot(eye) / Math.max(1, eyeLength))));
    const angularRadius = 2 * Math.asin(Math.min(1, radius / (2 * EARTH_RADIUS)));
    const inView = depth + radius > 0 && angle <= horizon + angularRadius
      && Math.abs(relative.dot(view.right)) <= Math.max(0, depth) * tanY * view.aspect + radius * Math.hypot(1, tanY * view.aspect)
      && Math.abs(relative.dot(view.up)) <= Math.max(0, depth) * tanY + radius * Math.hypot(1, tanY);
    const nearest = Math.max(100, center.distance(view.position) - radius, eyeLength - EARTH_RADIUS);
    return { ...tile, corners: [], error: inView ? 2 * radius * focal / (256 * nearest) : 0 };
  };
  const leaves: VisibleGroundTile[] = [];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) leaves.push(evaluate({ z: 2, x, y }));
  while (leaves.length + 3 <= maxTiles) {
    let index = -1, error = 1.15;
    for (let i = 0; i < leaves.length; i++) if (leaves[i].z < 12 && leaves[i].error > error) {
      index = i; error = leaves[i].error;
    }
    if (index < 0) break;
    const tile = leaves[index];
    leaves.splice(index, 1, ...[[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) =>
      evaluate({ z: tile.z + 1, x: tile.x * 2 + x, y: tile.y * 2 + y })));
  }
  return leaves;
}

/** Outward-facing patches with recessed skirts hide mixed-LOD edge gaps. */
export function earthTileGeometry(tile: GroundTile, anchor: { lon: number; lat: number }, segments = 32) {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (let j = 0; j <= segments; j++) for (let i = 0; i <= segments; i++) {
    const point = earthTilePoint(tile, i / segments, j / segments, anchor);
    positions.push(point.x, point.y, point.z); uvs.push(i / segments, j / segments);
    if (i < segments && j < segments) {
      const a = j * (segments + 1) + i;
      indices.push(a, a + segments + 1, a + 1, a + 1, a + segments + 1, a + segments + 2);
    }
  }
  const edge = [...Array.from({ length: segments }, (_, i) => i),
    ...Array.from({ length: segments }, (_, j) => j * (segments + 1) + segments),
    ...Array.from({ length: segments }, (_, i) => segments * (segments + 1) + segments - i),
    ...Array.from({ length: segments }, (_, j) => (segments - j) * (segments + 1))];
  const depth = Math.max(100, EARTH_RADIUS * (1 - Math.cos(Math.PI * 2 / (2 ** tile.z * segments))));
  const start = positions.length / 3;
  for (const vertex of edge) {
    const p = new Vec3(...positions.slice(vertex * 3, vertex * 3 + 3));
    p.add(new Vec3(0, EARTH_RADIUS, 0)).mulScalar(1 - depth / EARTH_RADIUS).sub(new Vec3(0, EARTH_RADIUS, 0));
    positions.push(p.x, p.y, p.z); uvs.push(uvs[vertex * 2], uvs[vertex * 2 + 1]);
  }
  for (let i = 0; i < edge.length; i++) {
    const j = (i + 1) % edge.length;
    indices.push(edge[i], edge[j], start + i, edge[j], start + j, start + i);
  }
  return { positions, uvs, indices };
}
