import { lonLatToWorldPx, worldPxToLonLat } from '@terrascope/contracts';
import { geographicToModel, MERCATOR_CIRCUMFERENCE, type SplatGeoreference } from '../data/splatGeoreference';
import { WORLD_IMAGERY_MAX_ZOOM } from '../map/worldImagery';

export type Point3 = readonly [number, number, number];
export interface GroundCameraView {
  /** All vectors are in the registered, Z-up model frame. */
  position: Point3;
  forward: Point3;
  right: Point3;
  up: Point3;
  fov: number;
  aspect: number;
  height: number;
  near: number;
  far: number;
}
export interface GroundTile { z: number; x: number; y: number }
export interface VisibleGroundTile extends GroundTile { corners: Point3[]; error: number }
export const groundTileKey = ({ z, x, y }: GroundTile): string => `${z}/${x}/${y}`;
export function parentGroundTile(tile: GroundTile, levels = 1): GroundTile {
  const z = Math.max(0, tile.z - levels), factor = 2 ** (tile.z - z);
  return { z, x: Math.floor(tile.x / factor), y: Math.floor(tile.y / factor) };
}
export function groundTileCorners(reference: SplatGeoreference, tile: GroundTile): Point3[] {
  return [[tile.x, tile.y], [tile.x + 1, tile.y], [tile.x + 1, tile.y + 1], [tile.x, tile.y + 1]].map(([x, y]) => {
    const geo = worldPxToLonLat(x * 256, y * 256, tile.z);
    const local = geographicToModel(reference, geo.lon, geo.lat);
    return [local[0], local[1], reference.groundZ];
  });
}
const dot = (a: Point3, b: Point3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a: Point3, b: Point3): Point3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addScaled = (a: Point3, b: Point3, scale: number): Point3 => [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
const negate = (v: Point3): Point3 => [-v[0], -v[1], -v[2]];

/** Frustum culled quadtree, refined by projected texel size, with a hard leaf budget.
 * The registration never changes when coverage or level of detail changes.
 */
export function planGroundTiles(reference: SplatGeoreference, view: GroundCameraView, maxTiles = 128): VisibleGroundTile[] {
  if (view.height <= 0 || view.aspect <= 0 || !Number.isFinite(view.far) || maxTiles < 3) return [];
  const tanY = Math.tan(view.fov * Math.PI / 360), tanX = tanY * view.aspect;
  const planes: [Point3, number][] = [
    [view.forward, -view.near],
    [negate(view.forward), view.far],
    [addScaled(view.right, view.forward, tanX), 0],
    [addScaled(negate(view.right), view.forward, tanX), 0],
    [addScaled(view.up, view.forward, tanY), 0],
    [addScaled(negate(view.up), view.forward, tanY), 0],
  ];
  const origin = lonLatToWorldPx(reference.origin, 0);
  const [a, b, c, d] = reference.modelToMercator;
  const cameraPx = origin.px + (a * view.position[0] + b * view.position[1]) * 256 / MERCATOR_CIRCUMFERENCE;
  const cameraPy = origin.py - (c * view.position[0] + d * view.position[1]) * 256 / MERCATOR_CIRCUMFERENCE;
  const focalPixels = view.height / (2 * tanY);
  const evaluate = (tile: GroundTile): VisibleGroundTile | undefined => {
    const corners = groundTileCorners(reference, tile);
    const relative = corners.map((p) => subtract(p, view.position));
    if (planes.some(([normal, offset]) => relative.every((p) => dot(normal, p) + offset < 0))) return;
    const size = 256 / 2 ** tile.z;
    const geo = worldPxToLonLat(Math.max(tile.x * size, Math.min((tile.x + 1) * size, cameraPx)),
      Math.max(tile.y * size, Math.min((tile.y + 1) * size, cameraPy)), 0);
    const closest = geographicToModel(reference, geo.lon, geo.lat);
    const distance = Math.max(view.near, Math.hypot(closest[0] - view.position[0], closest[1] - view.position[1], reference.groundZ - view.position[2]));
    const edge = Math.max(Math.hypot(...subtract(corners[1], corners[0])), Math.hypot(...subtract(corners[3], corners[0])));
    return { ...tile, corners, error: edge * focalPixels / distance };
  };
  const world = Math.floor(cameraPx / 256);
  const leaves = [world - 1, world, world + 1].map((x) => evaluate({ z: 0, x, y: 0 })).filter((t): t is VisibleGroundTile => !!t);
  const blocked = new Set<string>();
  while (true) {
    let candidate: VisibleGroundTile | undefined;
    for (const tile of leaves) if (tile.z < WORLD_IMAGERY_MAX_ZOOM && tile.error > 384 && !blocked.has(groundTileKey(tile))
      && (!candidate || tile.error > candidate.error)) candidate = tile;
    if (!candidate) break;
    const children: VisibleGroundTile[] = [];
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const child = evaluate({ z: candidate.z + 1, x: candidate.x * 2 + dx, y: candidate.y * 2 + dy });
      if (child) children.push(child);
    }
    if (leaves.length - 1 + children.length > maxTiles) { blocked.add(groundTileKey(candidate)); continue; }
    leaves.splice(leaves.indexOf(candidate), 1, ...children);
  }
  return leaves.sort((a, b) => b.error - a.error);
}

/** UVs for a child mesh sampling an already loaded ancestor texture. */
export function groundTileUvs(tile: GroundTile, source: GroundTile): number[] {
  const factor = 2 ** (tile.z - source.z);
  const u = (tile.x - source.x * factor) / factor, v = (tile.y - source.y * factor) / factor, size = 1 / factor;
  return [u, v, u + size, v, u + size, v + size, u, v + size];
}
